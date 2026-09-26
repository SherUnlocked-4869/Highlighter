'use strict'

const path = require('node:path')

const {
  ACTION_WINDOW_MIN_HEIGHT,
  ACTION_WINDOW_MIN_WIDTH,
  DEFAULT_SELECTION_TOOLBAR,
  getToolbarActionDefinition,
  getToolbarActionThinking,
  getToolbarWidth,
  getVisibleToolbarActionDefinitions,
  getVisibleToolbarActions
} = require('../../../toolbar/toolbar-utils')
const { resolveToolbarAiProvider } = require('../../services/ai-providers')
const {
  ActionConversation,
  prepareRestoredConversation,
  reportCancelledTurn,
  resolveFollowUpSupport,
  streamConversationTurn
} = require('../../services/action-conversation')
const { ConversationStore } = require('../../services/conversation-store')
const { SelectionHookService } = require('../../services/selection-hook-service')
const { SelectionWindowManager } = require('../../services/selection-window-manager')
const { ToolbarStreamSession } = require('../../services/toolbar-stream-session')

const TOOLBAR_H = 40
const TOOLBAR_STREAM_IDLE_TIMEOUT_MS = 30000
const ACTION_WINDOW_SIZE_SAVE_DELAY_MS = 180

// The selection surface: the toolbar window, the action (answer) window, the
// selection hook that feeds them, and the stream/conversation plumbing between
// the action renderer and the AI service. Windows, settings and logging arrive
// injected so the whole domain is drivable from node:test.
function createSelectionDomain(deps) {
  const {
    BrowserWindow,
    clipboard,
    screen,
    shell,
    nativeTheme,
    powerMonitor,
    utilityProcess,
    createLocalWindow,
    rootDirectory,
    isWin,
    getSettings,
    updateSettings,
    createTrayIcon,
    createMainWindow,
    getPinDomain,
    isGameModeEnabled,
    shouldFilterApp,
    conversationsDirectory,
    log
  } = deps

  const TOOLBAR_W = getToolbarWidth(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR))

  // Overridable so node:test can observe the handlers and power-event forwarding
  // without spawning the real utility-process host.
  const createHookService = deps.createHookService || ((options) => new SelectionHookService(options))

  let windowManager = null
  let hookService = null
  const powerListeners = []
  let currentStreamController = null
  let streamSeq = 0
  const actionConversations = new Map()
  let conversationStore = null
  let processing = false
  const selectionEventDiagnostics = new Set()

  function ensureConversationStore() {
    conversationStore ||= new ConversationStore({ directory: conversationsDirectory, getSettings, log })
    return conversationStore
  }

  // Opt-in persistence (design D19/D20): turning the switch off deletes what was
  // already written, and the cap is enforced on every start as well as on write.
  function syncConversationStore() {
    if (!conversationStore) return
    if (conversationStore.isEnabled()) conversationStore.trim()
    else conversationStore.clear()
  }

  function hasConversation() {
    return !!windowManager?.getActionWindow() || !!conversationStore?.latest()
  }

  // Brings back the newest saved conversation. Nothing streams, so the transcript
  // is replayed over the same channels a live round uses and the renderer needs no
  // changes: it ends up in the ordinary "round finished, composer ready" state.
  function restoreConversation(win, snapshot) {
    const settings = getSettings()
    const prepared = prepareRestoredConversation({
      snapshot,
      action: getToolbarActionDefinition(settings.selectionToolbar, snapshot.actionId),
      provider: resolveToolbarAiProvider(settings, snapshot.actionId),
      translateLanguages: settings.selectionToolbar.translateLanguages,
      thinking: getToolbarActionThinking(settings.selectionToolbar, settings.toolbarThinking, snapshot.actionId),
      support: resolveFollowUpSupport(
        resolveToolbarAiProvider(settings, snapshot.actionId),
        { conversation: settings.selectionToolbar.conversation }
      ),
      streamId: nextToolbarStreamId()
    })
    if (!prepared) return false
    const { conversation, replay } = prepared
    actionConversations.set(win, conversation)
    queueActionMessage(win, 'action:start', {
      type: conversation.action.id,
      label: conversation.action.label,
      icon: conversation.action.icon,
      text: conversation.text,
      streamId: conversation.streamId,
      appearance: getActionAppearance(),
      followUp: conversation.followUpConfig()
    })
    for (const { channel, payload } of replay) queueActionMessage(win, channel, payload)
    return true
  }

  function showOrRestoreConversation() {
    if (windowManager.showActionWindow()) return true
    const snapshot = conversationStore?.latest()
    if (!snapshot) return false
    const win = getOrCreateActionWindow()
    if (!restoreConversation(win, snapshot)) return false
    win.show()
    win.focus()
    return true
  }

  windowManager = new SelectionWindowManager({
    createWindow: createLocalWindow,
    rootDirectory,
    isWindows: isWin,
    nativeTheme,
    getSettings,
    updateSettings,
    toolbarWidth: TOOLBAR_W,
    toolbarHeight: TOOLBAR_H,
    actionMinWidth: ACTION_WINDOW_MIN_WIDTH,
    actionMinHeight: ACTION_WINDOW_MIN_HEIGHT,
    sizeSaveDelayMs: ACTION_WINDOW_SIZE_SAVE_DELAY_MS,
    onActionWindowClosed: (win, { wasPinned }) => {
      if (wasPinned) getPinDomain().releasePinnedSlot()
      actionConversations.delete(win)
      if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-closed')
      createTrayIcon()
    },
    onActionWindowBlur: (win) => {
      if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-hidden')
      createTrayIcon()
    },
    log
  })

  function createToolbarWindow() {
    return windowManager.createToolbarWindow()
  }

  function getOrCreateActionWindow() {
    return windowManager.getOrCreateActionWindow()
  }

  function getActionWindow() {
    return windowManager.getActionWindow()
  }

  function queueActionMessage(win, channel, payload) {
    windowManager.queueActionMessage(win, channel, payload)
  }

  function getActionAppearance(settings = getSettings()) {
    return windowManager.getAppearance(settings)
  }

  function broadcastActionAppearance(settings = getSettings()) {
    windowManager.broadcastAppearance(settings)
  }

  function ownsToolbarWindow(win) {
    return windowManager.ownsToolbarWindow(win)
  }

  function ownsActionWindow(win) {
    return windowManager.ownsActionWindow(win)
  }

  function handleRendererGone(win, details) {
    return windowManager.handleRendererGone(win, details)
  }

  function initSelectionHook() {
    if (!hookService) {
      hookService = createHookService({
        createHost: SelectionHookService.createUtilityProcessHostFactory({
          utilityProcess,
          hostPath: SelectionHookService.defaultHostPath()
        }),
        handlers: {
          textSelection: handleTextSelection,
          mouseDown: (data) => {
            const toolbarWindow = windowManager.getToolbarWindow()
            if (!toolbarWindow || !toolbarWindow.isVisible()) return
            const bounds = toolbarWindow.getBounds()
            let point = { x: data.x, y: data.y }
            if (isWin) point = screen.screenToDipPoint(point)
            const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
            if (!inside) hideToolbar()
          },
          keyDown: hideToolbar,
          mouseWheel: hideToolbar,
          status: (status) => log('Selection hook status:', status)
        },
        startOptions: {
          debug: false,
          enableClipboard: getSettings().selectionToolbar.clipboardFallback
        },
        log
      })
    }
    if (isGameModeEnabled()) return hookService.suspend('game-mode')
    return hookService.start('startup')
  }

  function registerSelectionPowerEvents() {
    if (powerListeners.length) return
    const bindings = [
      ['suspend', () => hookService?.notePowerEvent('sleep', 'system-suspend')],
      ['lock-screen', () => hookService?.notePowerEvent('sleep', 'lock-screen')],
      ['resume', () => {
        if (!isGameModeEnabled()) hookService?.notePowerEvent('wake', 'system-resume')
      }],
      ['unlock-screen', () => {
        if (!isGameModeEnabled()) hookService?.notePowerEvent('wake', 'unlock-screen')
      }]
    ]
    for (const [eventName, listener] of bindings) {
      powerMonitor.on(eventName, listener)
      powerListeners.push([eventName, listener])
    }
  }

  function disposeSelectionHook() {
    for (const [eventName, listener] of powerListeners.splice(0)) {
      powerMonitor.removeListener(eventName, listener)
    }
    hookService?.dispose()
    hookService = null
  }

  function validCoord(point) {
    return point && point.x > -90000 && point.x < 90000 && point.y > -90000 && point.y < 90000
  }

  function getRefPointAndOrientation(data) {
    const cursor = screen.getCursorScreenPoint()
    let refX = cursor.x
    let refY = cursor.y
    let orientation = 'bottomMiddle'
    const level = data.posLevel || 0
    if (level === 1) {
      if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y + 16 }
    } else if (level === 2) {
      if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
      if (validCoord(data.startBottom) && validCoord(data.endBottom)) {
        const delta = data.endBottom.y - data.startBottom.y
        orientation = delta > 10 ? 'bottomLeft' : delta < -10 ? 'topRight' : 'bottomRight'
      }
    } else if (level > 2) {
      if (validCoord(data.endBottom)) { refX = data.endBottom.x; refY = data.endBottom.y + 4 }
      else if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
      if (validCoord(data.startBottom) && validCoord(data.endBottom)) {
        const delta = data.endBottom.y - data.startBottom.y
        orientation = delta > 0 ? 'bottomLeft' : delta < 0 ? 'topRight' : 'bottomRight'
      }
    }
    if (isWin) {
      const point = screen.screenToDipPoint({ x: refX, y: refY })
      refX = point.x
      refY = point.y
    }
    return { refPoint: { x: refX, y: refY }, orientation }
  }

  function calculateToolbarPosition(refPoint, orientation, toolbarWidth = TOOLBAR_W) {
    let x = refPoint.x - toolbarWidth / 2
    let y = refPoint.y
    if (orientation === 'topRight') { x = refPoint.x; y = refPoint.y - TOOLBAR_H }
    if (orientation === 'bottomLeft') x = refPoint.x - toolbarWidth
    if (orientation === 'bottomRight') x = refPoint.x
    const workArea = screen.getDisplayNearestPoint(refPoint).workArea
    x = Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - toolbarWidth)))
    y = Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - TOOLBAR_H)))
    return { x, y }
  }

  function logSelectionDiagnosticOnce(reason, data = {}) {
    if (selectionEventDiagnostics.has(reason)) return
    selectionEventDiagnostics.add(reason)
    const programName = path.basename(String(data.programName || '')).slice(0, 128)
    const textLength = typeof data.text === 'string' ? data.text.length : 0
    log('Selection event diagnostic:', { reason, programName, textLength })
  }

  function handleTextSelection(data) {
    if (isGameModeEnabled()) { logSelectionDiagnosticOnce('game-mode', data); return }
    if (processing) { logSelectionDiagnosticOnce('busy', data); return }
    if (!data?.text) { logSelectionDiagnosticOnce('missing-text', data); return }
    if (shouldFilterApp(data.programName)) { logSelectionDiagnosticOnce('filtered-app', data); return }
    const text = data.text.trim()
    if (!text) { logSelectionDiagnosticOnce('empty-text', data); return }
    if (text.length > 10000) { logSelectionDiagnosticOnce('text-too-long', data); return }
    const actions = getVisibleToolbarActionDefinitions(getSettings().selectionToolbar)
    if (!actions.length) { logSelectionDiagnosticOnce('no-actions', data); hideToolbar(); return }
    const toolbarWidth = getToolbarWidth(actions)
    const result = getRefPointAndOrientation(data)
    const position = calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)
    windowManager.showToolbarSelection({ text, actions, position, width: toolbarWidth })
    logSelectionDiagnosticOnce('shown', data)
  }

  function hideToolbar() {
    windowManager.hideToolbar()
  }

  function finishToolbarStream(controller) {
    return controller?.finish() || false
  }

  function cancelToolbarStream(controller, reason = 'cancelled', { notify = false } = {}) {
    return controller?.cancel(reason, { notify }) || false
  }

  function armToolbarStreamTimeout(controller) {
    controller?.armTimeout()
  }

  function createToolbarStreamController(win, streamId) {
    const controller = new ToolbarStreamSession({
      win,
      timeoutMs: TOOLBAR_STREAM_IDLE_TIMEOUT_MS,
      onFinish: (finishedController) => {
        if (currentStreamController !== finishedController) return
        currentStreamController = null
        processing = false
      }
    })
    if (streamId === undefined) controller.streamId = nextToolbarStreamId()
    else controller.streamId = streamId
    currentStreamController = controller
    processing = true
    armToolbarStreamTimeout(controller)
    return controller
  }

  // A restored conversation needs an id but no controller: nothing is streaming,
  // so arming an idle timer would cancel a round that never started.
  function nextToolbarStreamId() {
    streamSeq += 1
    return streamSeq
  }

  function isCurrentToolbarStreamSender(event) {
    return !!currentStreamController?.matchesSender(event.sender)
  }

  function isStaleToolbarStreamSignal(event, streamId) {
    if (streamId === undefined || streamId === null) return false
    return currentStreamController?.streamId !== streamId
  }

  function saveConversation(conversation) {
    if (!conversationStore || !conversation) return false
    return conversationStore.save(conversation.serialize())
  }

  async function streamToWindow(win, action, text, controller, conversation) {
    const { createToolbarActionStream } = require('../../services/ai-feature-router')
    const currentSettings = getSettings()
    const requestOptions = { signal: controller.signal }
    requestOptions.thinking = getToolbarActionThinking(currentSettings.selectionToolbar, currentSettings.toolbarThinking, action.id)
    let content = ''
    try {
      const stream = await createToolbarActionStream({ settings: currentSettings, action, text, requestOptions })
      armToolbarStreamTimeout(controller)
      for await (const chunk of stream) {
        if (controller.cancelled || win.isDestroyed()) break
        armToolbarStreamTimeout(controller)
        const delta = chunk.choices?.[0]?.delta
        if (delta?.reasoning_content) queueActionMessage(win, 'stream:reasoning', { content: delta.reasoning_content })
        if (delta?.content) {
          content += delta.content
          queueActionMessage(win, 'stream:data', { content: delta.content })
        }
      }
      if (!controller.cancelled && !win.isDestroyed()) {
        conversation?.commitFirstResult(content)
        saveConversation(conversation)
        queueActionMessage(win, 'stream:done')
      }
    } catch (error) {
      if (!controller.cancelled && !win.isDestroyed()) {
        queueActionMessage(win, 'stream:error', { error: error.message || '请求失败' })
      }
    } finally {
      reportCancelledTurn({ controller, win, queueMessage: (channel, data) => queueActionMessage(win, channel, data) })
      finishToolbarStream(controller)
    }
  }

  async function openToolbarAiAction(action, text) {
    const toolbarConfig = getSettings().selectionToolbar
    const actionDefinition = getToolbarActionDefinition(toolbarConfig, action)
    if (!actionDefinition) return false
    const aiRuntime = resolveToolbarAiProvider(getSettings(), action)
    if (!aiRuntime?.apiKey) {
      createMainWindow('models')
      return false
    }
    const win = getOrCreateActionWindow()
    const controller = createToolbarStreamController(win)
    const conversation = new ActionConversation({
      streamId: controller.streamId,
      action: actionDefinition,
      text,
      provider: aiRuntime,
      translateLanguages: toolbarConfig.translateLanguages,
      conversationConfig: toolbarConfig.conversation,
      thinking: getToolbarActionThinking(toolbarConfig, getSettings().toolbarThinking, actionDefinition.id),
      support: resolveFollowUpSupport(aiRuntime, { conversation: toolbarConfig.conversation })
    })
    actionConversations.set(win, conversation)
    windowManager.positionActionWindow(win, screen)
    queueActionMessage(win, 'action:start', {
      type: actionDefinition.id,
      label: actionDefinition.label,
      icon: actionDefinition.icon,
      text,
      streamId: controller.streamId,
      appearance: getActionAppearance(),
      followUp: conversation.followUpConfig()
    })
    streamToWindow(win, actionDefinition, text, controller, conversation)
    win.show()
    win.focus()
    return true
  }

  function cancelActiveStream(reason) {
    return currentStreamController ? cancelToolbarStream(currentStreamController, reason) : false
  }

  function cancelStreamForWindow(win, reason) {
    if (currentStreamController?.win !== win) return false
    return cancelToolbarStream(currentStreamController, reason)
  }

  // Mirrors applyGameModeState's selection half: game mode suspends the hook,
  // drops the toolbar and cancels an in-flight round; leaving it restarts the
  // hook only when it had been started.
  function applyGameMode(gameMode) {
    if (gameMode) {
      hookService?.suspend('game-mode')
      hideToolbar()
      if (currentStreamController) cancelToolbarStream(currentStreamController, 'game-mode')
      return
    }
    if (hookService) hookService.start('game-mode-disabled')
  }

  function createIpcController() {
    return {
      BrowserWindow,
      clipboard,
      shell,
      log,
      getSettings,
      isProcessing: () => processing,
      hideToolbar,
      openToolbarAiAction,
      getPinDomain,
      streams: {
        getCurrent: () => currentStreamController,
        isCurrentSender: isCurrentToolbarStreamSender,
        isStaleSignal: isStaleToolbarStreamSignal,
        cancel: (controller, reason) => cancelToolbarStream(controller, reason),
        create: (win, streamId) => createToolbarStreamController(win, streamId)
      },
      conversations: {
        get: (win) => actionConversations.get(win),
        queueMessage: (win, channel, payload) => queueActionMessage(win, channel, payload),
        save: saveConversation
      }
    }
  }

  return {
    ensureConversationStore,
    syncConversationStore,
    hasConversation,
    restoreConversation,
    showOrRestoreConversation,
    createToolbarWindow,
    getOrCreateActionWindow,
    getActionWindow,
    queueActionMessage,
    getActionAppearance,
    broadcastActionAppearance,
    ownsToolbarWindow,
    ownsActionWindow,
    handleRendererGone,
    hideToolbar,
    handleTextSelection,
    initSelectionHook,
    registerSelectionPowerEvents,
    disposeSelectionHook,
    hookService: () => hookService,
    isProcessing: () => processing,
    cancelActiveStream,
    cancelStreamForWindow,
    applyGameMode,
    openToolbarAiAction,
    createIpcController
  }
}

module.exports = {
  createSelectionDomain
}
