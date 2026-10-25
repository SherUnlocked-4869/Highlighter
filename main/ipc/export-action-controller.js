// Export result actions controller (feature A, plan §4.2/§4.3 task A2).
//
// Sits between `export:perform-action` and `main/services/export-result-service.js`. Its whole
// job is to answer one question for the service: *which registered result may this sender act
// on?* The service can compare owner ids but cannot authenticate a sender, so the id has to come
// from the transport identity here, never from the renderer payload.
//
// Owner id = the sending WebContents id. It is:
//   * stable for the lifetime of the window (a renderer cannot choose or change it),
//   * not the BrowserWindow id, because a window can reload its contents while keeping the same
//     registration, and it is the *content* that registered the result,
//   * revoked on `destroyed` (plan §4.2: a destroyed window loses its IPC capability), so a
//     closed window's results stop being actionable through channels the window no longer has.
//
// The payload is validated here as well: only `resultId` and a known action name survive. Nothing
// else the renderer sends is forwarded, so a future renderer bug cannot smuggle a path, an owner
// or a shell argument through this channel.

const ACTIONS = Object.freeze(['open', 'copy-path', 'reveal'])
const MAX_RESULT_ID_LENGTH = 128

function createExportActionResultController({ service, BrowserWindow, log = () => {} } = {}) {
  if (!service || typeof service.perform !== 'function') {
    throw new TypeError('Export action controller requires the export result service')
  }
  if (typeof BrowserWindow?.fromWebContents !== 'function') {
    throw new TypeError('Export action controller requires BrowserWindow.fromWebContents')
  }

  // The owner id for one sender, or '' when the sender cannot be attributed to a live window.
  // An unattributable sender is never allowed to act: the empty scope fails closed inside the
  // service (`ownerScope('')` -> '', `ownerMayAct` -> false), but returning '' here keeps the
  // reason visible to the caller.
  function ownerIdFor(sender) {
    if (!sender) return ''
    const contentsId = Number(sender.id)
    if (!Number.isInteger(contentsId) || contentsId <= 0) return ''
    const win = BrowserWindow.fromWebContents(sender)
    if (!win) return ''
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return ''
    return `web-contents:${contentsId}`
  }

  async function performAction(event, payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {}
    const resultId = typeof source.resultId === 'string' ? source.resultId.trim() : ''
    const action = typeof source.action === 'string' ? source.action.trim() : ''
    if (!resultId || resultId.length > MAX_RESULT_ID_LENGTH) {
      return { status: 'failed', code: 'result-expired' }
    }
    if (!ACTIONS.includes(action)) return { status: 'failed', code: 'unknown-action' }
    const ownerId = ownerIdFor(event?.sender)
    if (!ownerId) {
      log('Export action rejected: sender is not a live registered window')
      return { status: 'failed', code: 'invalid-owner' }
    }
    return service.perform({ resultId, action, ownerId })
  }

  // Wires the window-destroyed revocation. Returns a disposer so a host that tears the controller
  // down (tests, window replacement) can stop listening. `sender.once` is used rather than
  // `win.on('closed')` because the registration is owned by the contents: a reload destroys the
  // contents and must revoke too.
  function trackWindow(win) {
    const contents = win?.webContents
    if (!contents || typeof contents.once !== 'function') return () => {}
    const ownerId = ownerIdFor(contents)
    if (!ownerId) return () => {}
    const onDestroyed = () => {
      try {
        service.revokeOwner(ownerId)
      } catch (error) {
        log('Export result revoke failed:', error?.message || error)
      }
    }
    contents.once('destroyed', onDestroyed)
    return () => {
      if (typeof contents.removeListener === 'function') contents.removeListener('destroyed', onDestroyed)
    }
  }

  return { performAction, ownerIdFor, trackWindow }
}

module.exports = {
  ACTIONS,
  createExportActionResultController,
  MAX_RESULT_ID_LENGTH
}
