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
const { resolveSelectionAnchor } = require('./anchor')
// P0-1-T5：`TOOLBAR_ACTION_META` 的 label/description 已改为 i18n 键，而窗口宽度是按
// **渲染后的文本**估的（`getToolbarWidth` 量的是字符数）。所以测量前必须先把键解析成当前语言，
// 否则每个按钮都会按 20+ 字符的键命中 126px 上限，工具条明显偏宽。
const { t } = require('../../services/i18n-bootstrap')

function resolveToolbarLabel(action) {
  return typeof action === 'object' && action ? { ...action, label: t(action.label) } : action
}

const TOOLBAR_H = 40
const TOOLBAR_STREAM_IDLE_TIMEOUT_MS = 30000
const ACTION_WINDOW_SIZE_SAVE_DELAY_MS = 180

// U04 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §4.4): the
// C++ clipboard fallback injects Ctrl+C. A terminal resolves that shortcut as
// SIGINT, so highlighting text there used to interrupt the running command. These
// program names are always sent to the native clipboard filter (EXCLUDE_LIST);
// engine.cc keeps the same list compiled in as a hard safety net. Keep the two
// lists in sync. Integrated terminals inside an editor share the editor's process
// name and are intentionally not listed (protecting them would disable the whole
// editor's fallback).
const TERMINAL_CLIPBOARD_COPY_PROTECTION = Object.freeze([
  'windowsterminal.exe',
  'openconsole.exe',
  'conhost.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'mintty.exe',
  'wezterm-gui.exe',
  'alacritty.exe',
  'kitty.exe',
  'hyper.exe',
  'tabby.exe',
  'fluentterminal.exe',
  'terminus.exe',
  'conemu.exe',
  'conemu64.exe'
])

// main.js shouldFilterApp() drops Highlighter's own selection events after the C++
// fallback already injected a copy. Mirror its ASCII program-name substrings into
// the native protection list so our own surfaces never receive that shortcut.
// (The CJK display name cannot reach the native list as an unchanged matching rule
// without breaking the i18n gate on this file; the executable name is ASCII.)
const SELF_CLIPBOARD_COPY_PROTECTION = Object.freeze(['highlighter', 'huacizhushou'])

// The always-on part of the native clipboard-copy protection list.
const DEFAULT_CLIPBOARD_COPY_PROTECTION = Object.freeze([
  ...TERMINAL_CLIPBOARD_COPY_PROTECTION,
  ...SELF_CLIPBOARD_COPY_PROTECTION
])

// Mirrors the native ProcessStringArrayToList normalization: bounded, lowercase,
// deduplicated UTF-8 program names.
function normalizeProgramNameList(value, limit = 128) {
  if (!Array.isArray(value)) return []
  const names = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim().toLowerCase().slice(0, 128)
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= limit) break
  }
  return names
}

// The application blacklist that must reach the native clipboard fallback: the
// always-on terminal/self protection plus the user's clipboard exclusion list (the
// only user-facing app blacklist the product has). Serialized to the hook host
// through the existing start/update-options channel; no new native ABI is involved.
function resolveClipboardCopyProtection(settings) {
  const userBlacklist = normalizeProgramNameList(settings?.clipboard?.excludedApps)
  return [...new Set([...DEFAULT_CLIPBOARD_COPY_PROTECTION, ...userBlacklist])]
}

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
    // Only used to drive the window manager's idle reclaimer from node:test; the
    // production callers rely on the manager defaults (120s, real timers).
    actionWindowReleaseMs,
    setTimer,
    clearTimer,
    now,
    log
  } = deps

  const TOOLBAR_W = getToolbarWidth(getVisibleToolbarActionDefinitions(DEFAULT_SELECTION_TOOLBAR).map(resolveToolbarLabel))

  // Overridable so node:test can observe the handlers and power-event forwarding
  // without spawning the real utility-process host.
  const createHookService = deps.createHookService || ((options) => new SelectionHookService(options))

  let windowManager = null
  let hookService = null
  let unbindHookLifecycle = null
  let hookSuspendedForSettings = false
  const powerListeners = []
  // U04 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §4.4): a
  // round belongs to the window that owns it, not to the domain. The old single
  // `processing` lock made a pinned result window that thinks for a long time block
  // every new selection/local action, and a second window could not even cancel the
  // first. One live controller per window keeps the per-window serialization while
  // two windows stream independently.
  const streamControllers = new Map()
  let lastStreamController = null
  let streamSeq = 0
  // U04: last protection list handed to the hook host. A runtime blacklist change
  // has no settings effect of its own (settings-effects is outside this domain), so
  // the next selection re-sends the list when it actually changed.
  let lastClipboardCopyProtection = null
  const actionConversations = new Map()
  // M2/W7: the snapshot of a conversation whose unpinned window was reclaimed
  // while hidden. Keyed by the window it came from so two hidden windows cannot
  // overwrite each other; the tray restores the newest one.
  const reclaimedConversations = new Map()
  let conversationStore = null
  const selectionEventDiagnostics = new Set()
  const displayListeners = []
  // Set while game mode keeps the toolbar hidden; applied on the next show.
  let toolbarRecyclePending = false

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

  function newestReclaimedConversation() {
    let newest = null
    for (const snapshot of reclaimedConversations.values()) {
      if (!newest || (Number(snapshot?.savedAt) || 0) >= (Number(newest?.savedAt) || 0)) newest = snapshot
    }
    return newest
  }

  function clearReclaimedConversations(reason) {
    if (!reclaimedConversations.size) return false
    reclaimedConversations.clear()
    log('Selection reclaimed conversation dropped:', reason)
    return true
  }

  // Called by the window manager BEFORE it destroys an idle hidden window. The
  // snapshot is exactly what `prepareRestoredConversation` consumes, so the tray
  // can rebuild the thread later; returning false keeps the window alive (never
  // lose a conversation to a failed snapshot).
  function onActionWindowReclaim(win) {
    const conversation = actionConversations.get(win)
    if (!conversation) return true
    let snapshot
    try {
      snapshot = conversation.serialize()
    } catch (error) {
      log('Selection conversation snapshot failed; keeping the window:', error?.message || String(error))
      return false
    }
    actionConversations.delete(win)
    reclaimedConversations.set(win, snapshot)
    createTrayIcon()
    return true
  }

  function isActionWindowReclaimable(win) {
    // An in-flight round owns the surface even though blur already hid the window:
    // the round now finishes in the background and writes the conversation store,
    // so the window must not be destroyed underneath it.
    if (liveStreamController(win)) return false
    return true
  }

  function hasConversation() {
    return !!windowManager?.getActionWindow()
      || reclaimedConversations.size > 0
      // F07: the tray rebuild asks this on every blur; the store answers from its memory index
      // instead of parsing the whole conversation directory. Stores without the fast path (test
      // fakes) still answer through latest().
      || (typeof conversationStore?.hasSaved === 'function'
        ? conversationStore.hasSaved()
        : !!conversationStore?.latest())
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
    // The opt-in persisted thread is preferred when it exists; otherwise the
    // snapshot captured while the idle window was reclaimed is the only copy.
    const snapshot = conversationStore?.latest() || newestReclaimedConversation()
    if (!snapshot) return false
    const win = getOrCreateActionWindow()
    if (!restoreConversation(win, snapshot)) return false
    clearReclaimedConversations('restored')
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
    actionWindowReleaseMs,
    isActionWindowReclaimable: (win) => isActionWindowReclaimable(win),
    onActionWindowReclaim: (win) => onActionWindowReclaim(win),
    setTimer,
    clearTimer,
    now,
    onActionWindowClosed: (win, { wasPinned }) => {
      if (wasPinned) getPinDomain().releasePinnedSlot()
      actionConversations.delete(win)
      cancelStreamForWindow(win, 'window-closed')
      createTrayIcon()
    },
    onActionWindowBlur: (win) => {
      // U04: hiding an unpinned result window (blur) no longer aborts its round.
      // The stream keeps writing into the hidden renderer and commits to the
      // ConversationStore when it finishes; only a destroyed window or game mode
      // interrupts a round now. The tray entry below is what lets the user bring
      // the conversation back.
      createTrayIcon()
    },
    onToolbarVisibilityChange: (visible) => postToolbarVisibility(visible),
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

  function needsSelectionHook() {
    const settings = getSettings()
    return settings.selectionToolbar.enabled !== false || settings.clipboard?.enabled === true || deps.clipboardNeedsSelectionHook?.() === true
  }

  // F02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §3.2):
  // the hook host stops forwarding key/wheel/click events while the toolbar is off
  // screen. This private, volatile channel mirrors the window state into it; the
  // native ObserveInput counter (clipboard guardrail/lease logic) is untouched and
  // keeps counting in the C++ hook thread either way. A lost message degrades to
  // "host still suppresses" - never to the old storm - and host lifecycle events
  // re-send the current state below.
  function postToolbarVisibility(visible) {
    const host = hookService?.host
    if (!host || typeof host.postMessage !== 'function') return false
    try {
      host.postMessage({ type: 'toolbar-visibility', visible: visible === true })
      return true
    } catch (error) {
      log('Selection toolbar visibility sync failed:', error?.message || String(error))
      return false
    }
  }

  function resyncToolbarVisibility() {
    return postToolbarVisibility(windowManager ? windowManager.isToolbarVisible() : false)
  }

  function sameProgramList(left, right) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => entry === right[index])
  }

  // The hook host owns the native clipboard filter. The start options below carry
  // the initial list; a selection arriving after the user edited the blacklist
  // refreshes it, so the native fallback never keeps injecting Ctrl+C for an app the
  // user just excluded (or vice versa). One comparison per selection, no IPC unless
  // the list changed.
  function syncClipboardCopyProtection() {
    const next = resolveClipboardCopyProtection(getSettings())
    if (sameProgramList(next, lastClipboardCopyProtection)) return false
    if (!hookService || typeof hookService.updateStartOptions !== 'function') {
      // No host yet: initSelectionHook() will pick the current list up from settings.
      lastClipboardCopyProtection = next
      return false
    }
    try {
      hookService.updateStartOptions({ clipboardExcludedApps: next }, 'clipboard-protection-change')
    } catch (error) {
      log('Selection clipboard protection sync failed:', error?.message || String(error))
      return false
    }
    lastClipboardCopyProtection = next
    return true
  }

  function initSelectionHook(reason = 'startup') {
    if (!needsSelectionHook()) return false
    if (!hookService) {
      const clipboardCopyProtection = resolveClipboardCopyProtection(getSettings())
      lastClipboardCopyProtection = clipboardCopyProtection
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
          enableClipboard: getSettings().selectionToolbar.clipboardFallback,
          clipboardCoordinationRequired: getSettings().clipboard?.enabled === true,
          // U04: the host mirrors this list into the native clipboard filter so a
          // blacklisted application / terminal never gets a synthesized Ctrl+C.
          clipboardExcludedApps: clipboardCopyProtection
        },
        log
      })
      // A replacement host starts with the toolbar hidden; re-send the real state
      // whenever one becomes ready so a restart cannot silently freeze the input gate.
      if (typeof hookService.onLifecycle === 'function') {
        unbindHookLifecycle = hookService.onLifecycle(() => resyncToolbarVisibility())
      }
    }
    hookSuspendedForSettings = false
    if (getSettings().selectionToolbar.enabled !== false) registerSelectionDisplayEvents()
    if (isGameModeEnabled()) return hookService.suspend('game-mode')
    return hookService.start(reason)
  }

  function applySelectionEnabled() {
    if (getSettings().selectionToolbar.enabled === false) {
      toolbarRecyclePending = false
      disposeSelectionDisplayEvents()
      windowManager.recycleToolbarWindow('toolbar-disabled')
    } else {
      registerSelectionDisplayEvents()
    }
    // Clipboard history uses the same host to authenticate its native lease.
    if (needsSelectionHook()) {
      if (!hookService || hookSuspendedForSettings) initSelectionHook('selection-required')
    } else if (hookService && !hookSuspendedForSettings) {
      hookSuspendedForSettings = true
      hookService.suspend('toolbar-disabled')
    }
  }

  function registerSelectionPowerEvents() {
    if (powerListeners.length) return
    const bindings = [
      ['suspend', () => hookService?.notePowerEvent('sleep', 'system-suspend')],
      ['lock-screen', () => hookService?.notePowerEvent('sleep', 'lock-screen')],
      ['resume', () => {
        if (!isGameModeEnabled() && needsSelectionHook()) hookService?.notePowerEvent('wake', 'system-resume')
      }],
      ['unlock-screen', () => {
        if (!isGameModeEnabled() && needsSelectionHook()) hookService?.notePowerEvent('wake', 'unlock-screen')
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
    disposeSelectionDisplayEvents()
    windowManager.recycleToolbarWindow('dispose')
    if (typeof unbindHookLifecycle === 'function') unbindHookLifecycle()
    unbindHookLifecycle = null
    hookService?.dispose()
    hookService = null
  }

  // The toolbar window is pre-created at startup when enabled and reused while active.
  // A window that long can lose its compositor surface without Electron
  // reporting anything wrong (2026-10-07: WS_VISIBLE, TOPMOST, uncloaked,
  // renderer painting, nothing on screen), so the events that can invalidate a
  // surface recycle the cached window instead of trusting it. Registered from
  // initSelectionHook so main.js stays assembly-only.
  function registerSelectionDisplayEvents() {
    if (displayListeners.length || typeof screen?.on !== 'function') return false
    const bindings = [
      ['display-added', () => recycleToolbarWindow('display-added')],
      ['display-removed', () => recycleToolbarWindow('display-removed')],
      ['display-metrics-changed', () => recycleToolbarWindow('display-metrics-changed')]
    ]
    for (const [eventName, listener] of bindings) {
      screen.on(eventName, listener)
      displayListeners.push([eventName, listener])
    }
    return true
  }

  function disposeSelectionDisplayEvents() {
    const listeners = displayListeners.splice(0)
    if (typeof screen?.removeListener !== 'function') return listeners.length > 0
    for (const [eventName, listener] of listeners) screen.removeListener(eventName, listener)
    return listeners.length > 0
  }

  // Game mode keeps the toolbar hidden, so a recycle request is remembered and
  // applied on the next real show rather than destroying a window mid-hide.
  function recycleToolbarWindow(reason) {
    if (isGameModeEnabled()) {
      toolbarRecyclePending = true
      return false
    }
    toolbarRecyclePending = false
    return windowManager.recycleToolbarWindow(reason)
  }

  function handleChildProcessGone(details = {}) {
    if (details?.type !== 'GPU') return false
    return recycleToolbarWindow(`gpu-process-gone:${details.reason || 'unknown'}`)
  }

  function getToolbarPresentationReport() {
    return typeof windowManager.getToolbarPresentationReport === 'function'
      ? windowManager.getToolbarPresentationReport()
      : null
  }

  function getRefPointAndOrientation(data) {
    return resolveSelectionAnchor(data, {
      cursorPoint: screen.getCursorScreenPoint(),
      isWin,
      toDip: (point) => screen.screenToDipPoint(point)
    })
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

  function logSelectionDiagnosticOnce(reason, data = {}, details = {}) {
    if (selectionEventDiagnostics.has(reason)) return
    selectionEventDiagnostics.add(reason)
    const programName = path.basename(String(data.programName || '')).slice(0, 128)
    const textLength = typeof data.text === 'string' ? data.text.length : 0
    log('Selection event diagnostic:', { reason, programName, textLength, ...details })
  }

  function handleTextSelection(data) {
    if (isGameModeEnabled()) { logSelectionDiagnosticOnce('game-mode', data); return }
    syncClipboardCopyProtection()
    if (!data?.text) { logSelectionDiagnosticOnce('missing-text', data); return }
    if (shouldFilterApp(data.programName)) { logSelectionDiagnosticOnce('filtered-app', data); return }
    const text = data.text.trim()
    if (!text) { logSelectionDiagnosticOnce('empty-text', data); return }
    if (text.length > 10000) { logSelectionDiagnosticOnce('text-too-long', data); return }
    const actions = getVisibleToolbarActionDefinitions(getSettings().selectionToolbar)
    if (!actions.length) { logSelectionDiagnosticOnce('no-actions', data); hideToolbar(); return }
    const toolbarWidth = getToolbarWidth(actions.map(resolveToolbarLabel))
    const result = getRefPointAndOrientation(data)
    const position = calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)
    if (toolbarRecyclePending) {
      toolbarRecyclePending = false
      windowManager.recycleToolbarWindow('pending-after-game-mode')
    }
    windowManager.showToolbarSelection({ text, actions, position, width: toolbarWidth })
    // The window can be shown and still never reach the screen (2026-10-07), so
    // the report is recorded: the fields below are what a future occurrence
    // needs to tell "not triggered" from "triggered, window never presented".
    const presentation = getToolbarPresentationReport()
    logSelectionDiagnosticOnce('shown', data, {
      posLevel: Number(data.posLevel) || 0,
      anchorSource: result.source,
      refPoint: result.refPoint,
      displayId: screen.getDisplayNearestPoint(result.refPoint).id,
      toolbarPosition: position,
      toolbarPresentationOk: presentation ? presentation.ok : null,
      toolbarVisible: presentation ? presentation.visible : null,
      toolbarSize: presentation ? presentation.actualSize : null,
      toolbarRequestedSize: presentation ? presentation.requestedSize : null,
      toolbarAgeMs: presentation ? presentation.ageMs : null,
      toolbarRecycled: presentation ? presentation.rebuilt === true : null
    })
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

  // The single per-window registration point: a controller leaves the map exactly
  // once (ToolbarStreamSession.finish is idempotent), which is the per-window
  // serialization the old global `processing` flag used to provide for the domain.
  function finishStreamController(controller) {
    if (!controller || streamControllers.get(controller.win) !== controller) return false
    streamControllers.delete(controller.win)
    if (lastStreamController === controller) {
      lastStreamController = [...streamControllers.values()].at(-1) || null
    }
    // A hidden window whose round outlived its idle timer was skipped by the
    // reclaimer (a skipped fire is not retried). Finishing the round is the moment
    // it becomes reclaimable again, so re-arm the timer for the hidden window.
    const win = controller.win
    try {
      if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()
        && win._isPinned !== true && typeof win.isVisible === 'function' && !win.isVisible()) {
        windowManager.armActionWindowReclaim(win)
      }
    } catch (error) {
      log('Selection action window reclaim re-arm failed:', error?.message || String(error))
    }
    return true
  }

  function liveStreamController(win) {
    const controller = streamControllers.get(win)
    return controller && controller.finished !== true ? controller : null
  }

  function createToolbarStreamController(win, streamId) {
    // One live round per window: a second create for the same window replaces and
    // cancels the previous one instead of orphaning a controller outside the map
    // (the old global slot could not even cancel the replaced stream).
    const previous = liveStreamController(win)
    if (previous) cancelToolbarStream(previous, 'replaced')
    const controller = new ToolbarStreamSession({
      win,
      timeoutMs: TOOLBAR_STREAM_IDLE_TIMEOUT_MS,
      onFinish: (finishedController) => finishStreamController(finishedController)
    })
    if (streamId === undefined) controller.streamId = nextToolbarStreamId()
    else controller.streamId = streamId
    streamControllers.set(win, controller)
    lastStreamController = controller
    armToolbarStreamTimeout(controller)
    return controller
  }

  // A restored conversation needs an id but no controller: nothing is streaming,
  // so arming an idle timer would cancel a round that never started.
  function nextToolbarStreamId() {
    streamSeq += 1
    return streamSeq
  }

  // Signals arrive from a renderer; route them to the round of THAT window instead
  // of the single historically-current one.
  function controllerForSender(sender) {
    for (const controller of streamControllers.values()) {
      if (controller.matchesSender(sender)) return controller
    }
    return null
  }

  function isCurrentToolbarStreamSender(event) {
    return !!controllerForSender(event?.sender)
  }

  function isStaleToolbarStreamSignal(event, streamId) {
    if (streamId === undefined || streamId === null) return false
    return controllerForSender(event?.sender)?.streamId !== streamId
  }

  function isWindowStreaming(win) {
    return !!liveStreamController(win)
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

  // A streaming (usually pinned) window cannot host a second round: start the new
  // Q&A in a fresh result window, which is what "a pinned window can think while a
  // new selection is answered" means. Otherwise reuse the warm window as before.
  function getOrCreateRoundWindow() {
    const win = windowManager.getOrCreateActionWindow()
    if (!isWindowStreaming(win)) return win
    return windowManager.createActionWindow()
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
    // A new round starts a new thread: a snapshot left by a reclaimed window must
    // never be offered afterwards as if it were this round's history.
    clearReclaimedConversations('new-round')
    const win = getOrCreateRoundWindow()
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
    let cancelled = false
    for (const controller of [...streamControllers.values()]) {
      cancelled = cancelToolbarStream(controller, reason) || cancelled
    }
    return cancelled
  }

  // Preserved semantics: cancel only the round that belongs to this window. Two
  // windows can stream at once, so "the" current controller no longer exists.
  function cancelStreamForWindow(win, reason) {
    const controller = liveStreamController(win)
    return controller ? cancelToolbarStream(controller, reason) : false
  }

  // Mirrors applyGameModeState's selection half: game mode suspends the hook,
  // drops the toolbar and cancels every in-flight round; leaving it restarts the
  // hook only when it had been started.
  function applyGameMode(gameMode) {
    if (gameMode) {
      hookService?.suspend('game-mode')
      hideToolbar()
      cancelActiveStream('game-mode')
      return
    }
    if (hookService && needsSelectionHook()) hookService.start('game-mode-disabled')
  }

  function createIpcController() {
    return {
      BrowserWindow,
      clipboard,
      shell,
      log,
      getSettings,
      isProcessing: () => isProcessing(),
      hideToolbar,
      openToolbarAiAction,
      getPinDomain,
      streams: {
        // Kept for the pinned contract tests and the tray paths: the most recently
        // started live round, not the only one any more.
        getCurrent: () => lastStreamController,
        isCurrentSender: isCurrentToolbarStreamSender,
        isStaleSignal: isStaleToolbarStreamSignal,
        cancel: (controller, reason) => cancelToolbarStream(controller, reason),
        cancelForSender: (event, reason) => {
          const controller = controllerForSender(event?.sender)
          return controller ? cancelToolbarStream(controller, reason) : false
        },
        isWindowStreaming,
        create: (win, streamId) => createToolbarStreamController(win, streamId)
      },
      conversations: {
        get: (win) => actionConversations.get(win),
        queueMessage: (win, channel, payload) => queueActionMessage(win, channel, payload),
        save: saveConversation
      }
    }
  }

  function isProcessing() {
    return streamControllers.size > 0
  }

  return {
    ensureConversationStore,
    syncConversationStore,
    quiesceConversations: () => conversationStore?.quiesce(),
    resumeConversations: () => conversationStore?.resume(),
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
    applySelectionEnabled,
    registerSelectionPowerEvents,
    registerSelectionDisplayEvents,
    disposeSelectionDisplayEvents,
    handleChildProcessGone,
    recycleToolbarWindow,
    getToolbarPresentationReport,
    disposeSelectionHook,
    hookService: () => hookService,
    isProcessing,
    cancelActiveStream,
    cancelStreamForWindow,
    applyGameMode,
    openToolbarAiAction,
    createIpcController
  }
}

module.exports = {
  createSelectionDomain,
  TERMINAL_CLIPBOARD_COPY_PROTECTION,
  SELF_CLIPBOARD_COPY_PROTECTION,
  DEFAULT_CLIPBOARD_COPY_PROTECTION,
  normalizeProgramNameList,
  resolveClipboardCopyProtection
}
