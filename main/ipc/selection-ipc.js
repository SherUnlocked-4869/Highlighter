'use strict'

const {
  buildOpenUrl,
  buildSearchUrl,
  getToolbarActionDefinition,
  getVisibleToolbarActions,
  isAiToolbarAction,
  isLocalToolbarAction
} = require('../../toolbar/toolbar-utils')
const {
  boundConversationCopyText,
  streamConversationTurn
} = require('../services/action-conversation')

// The selection surface's sender-owned channels. Only what the toolbar and the
// action window actually send lives here: `window:minimize` / `window:close`
// are sent by the main page's preload and stay with the main window (design D26).
function registerSelectionIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Selection IPC requires ipcMain and controller')

  const {
    BrowserWindow,
    clipboard,
    shell,
    log,
    getSettings,
    isProcessing,
    hideToolbar,
    openToolbarAiAction,
    getPinDomain,
    streams,
    conversations
  } = controller

  ipcMain.on('toolbar:action', async (_event, { action, text } = {}) => {
    if (isProcessing() || !text) return
    const toolbarConfig = getSettings().selectionToolbar
    const visibleActions = getVisibleToolbarActions(toolbarConfig)
    if (!visibleActions.includes(action)) return
    const actionDefinition = getToolbarActionDefinition(toolbarConfig, action)
    if (!actionDefinition) return
    if (isLocalToolbarAction(action)) {
      hideToolbar()
      if (action === 'copy') clipboard.writeText(text)
      else if (action === 'open') {
        const target = buildOpenUrl(text)
        if (!target) return
        try { await shell.openExternal(target) } catch (error) { log('Toolbar open failed:', error.message) }
      } else {
        const url = buildSearchUrl(getSettings().selectionToolbar.searchEngine, text)
        try { await shell.openExternal(url) } catch (error) { log('Toolbar search failed:', error.message) }
      }
      return
    }
    if (!isAiToolbarAction(action, toolbarConfig)) return
    hideToolbar()
    await openToolbarAiAction(action, text)
  })

  ipcMain.on('window:toggle-pin', (event, shouldPin) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const pinDomain = getPinDomain()
    if (shouldPin && !pinDomain.canPinMore()) return event.sender.send('window:pin-denied', { max: pinDomain.MAX_PINNED })
    if (shouldPin && !win._isPinned) {
      if (!pinDomain.acquirePinnedSlot()) {
        event.sender.send('window:pin-denied', { max: pinDomain.MAX_PINNED })
        return
      }
      win._isPinned = true
      win.setAlwaysOnTop(true, 'floating')
    }
    if (!shouldPin && win._isPinned) {
      win._isPinned = false
      pinDomain.releasePinnedSlot()
      win.setAlwaysOnTop(false)
    }
  })

  ipcMain.on('stream:cancel', (event, streamId) => {
    if (!streams.isCurrentSender(event)) return
    if (streams.isStaleSignal(event, streamId)) return
    streams.cancel(streams.getCurrent(), 'user-cancelled')
  })

  ipcMain.on('stream:finish', (event, streamId) => {
    if (!streams.isCurrentSender(event)) return
    if (streams.isStaleSignal(event, streamId)) return
    streams.cancel(streams.getCurrent(), 'renderer-finished')
  })

  ipcMain.on('chat:ask', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const conversation = win ? conversations.get(win) : null
    if (!conversation) return
    if (Number(payload?.streamId) !== conversation.streamId) return
    const turn = conversation.beginTurn(payload?.question, { replaceLast: payload?.replaceLast === true })
    if (!turn.ok) {
      conversations.queueMessage(win, 'stream:error', { error: turn.reason, rejected: true })
      return
    }
    conversations.queueMessage(win, 'chat:turn', turn.turnPayload)
    const streamController = streams.create(win, conversation.streamId)
    streamConversationTurn({
      conversation,
      win,
      controller: streamController,
      queueMessage: (channel, data) => conversations.queueMessage(win, channel, data),
      onRoundCommitted: conversations.save
    }).catch((error) => {
      if (!streamController.cancelled && !win.isDestroyed()) {
        conversations.queueMessage(win, 'stream:error', { error: error.message || '请求失败' })
      }
    })
  })

  ipcMain.handle('chat:copy', (_event, text) => {
    const value = boundConversationCopyText(text)
    if (!value) return false
    clipboard.writeText(value)
    return true // never logged: the transcript is private content
  })
}

module.exports = {
  registerSelectionIpc
}
