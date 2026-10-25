'use strict'

// Result bar for a file this process just exported (feature A, plan §4.1/§4.3 A3).
//
// Both the capture/editor window and the recognition result window show the same three actions
// after an export succeeds: open the file, copy its full path, or reveal it in the file manager.
// The renderer never learns the path — it only holds the `resultId` the main process returned — so
// this module is purely presentational plus one `exportAction(resultId, action)` round trip.
//
// Contract notes (plan §4.2):
//   * The "address" action always copies the FULL path; "open folder" is the only action that
//     locates the file.
//   * A cancelled save returns no receipt, so no bar appears (a cancel must never look like
//     success).
//   * Each action reports its own outcome, so "the file was saved but opening failed" is not
//     misreported as a total failure.
//   * The bar is dismissible and never steals focus (the export must not pull the window forward).
//
// This file is deliberately dependency-free (no Electron, no DOM at load time) so it can be
// required by a node test as well as loaded by a window's <script> tag. The DOM surface is created
// lazily on first `show()`, and every element id is prefixed `exportResult` so it cannot collide
// with a window's own markup.

const ACTION_LABELS = Object.freeze({
  open: 'capture.export-result.open',
  'copy-path': 'capture.export-result.copy-path',
  reveal: 'capture.export-result.reveal'
})
const ACTION_ORDER = Object.freeze(['open', 'copy-path', 'reveal'])

function createExportResultBar({
  document: documentRef = null,
  getAction = null,
  translate = (key) => key,
  autoHideMs = 0,
  setTimeoutFn = typeof setTimeout === 'function' ? setTimeout : null,
  clearTimeoutFn = typeof clearTimeout === 'function' ? clearTimeout : null,
  log = () => {}
} = {}) {
  if (typeof getAction !== 'function') throw new TypeError('Export result bar requires an exportAction API')
  const doc = documentRef
  let root = null
  let titleEl = null
  let buttonsEl = null
  let statusEl = null
  let currentReceipt = null
  let hideTimer = null
  let disposing = false
  // One in-flight action at a time: two clicks would race two shell invocations and the second
  // would report a status the user did not ask for.
  let busy = false

  function ensureMounted() {
    if (root && root.isConnected !== false) return root
    if (!doc || typeof doc.createElement !== 'function') return null
    root = doc.createElement('div')
    root.id = 'exportResultBar'
    root.className = 'export-result-bar hidden'
    // A status region rather than an alert: the outcome is announced to a screen reader without
    // interrupting the user's next action.
    root.setAttribute('role', 'status')
    root.setAttribute('aria-live', 'polite')
    titleEl = doc.createElement('span')
    titleEl.className = 'export-result-name'
    buttonsEl = doc.createElement('span')
    buttonsEl.className = 'export-result-actions'
    statusEl = doc.createElement('span')
    statusEl.className = 'export-result-status hidden'
    const closeButton = doc.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'export-result-close'
    closeButton.textContent = '\u00d7'
    closeButton.addEventListener('click', () => hide())
    for (const action of ACTION_ORDER) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.dataset.exportAction = action
      button.textContent = translate(ACTION_LABELS[action])
      button.addEventListener('click', () => runAction(action))
      buttonsEl.appendChild(button)
    }
    root.append(titleEl, buttonsEl, statusEl, closeButton)
    const host = doc.body || doc.documentElement
    if (!host) return null
    host.appendChild(root)
    return root
  }

  // Re-resolves the button labels. A language switch reaches every window through the i18n
  // broadcast; without this the bar would keep the old language until the next export.
  function retranslate() {
    if (!root) return
    if (buttonsEl) {
      for (const button of buttonsEl.children || []) {
        const action = button?.dataset?.exportAction
        if (action && ACTION_LABELS[action]) button.textContent = translate(ACTION_LABELS[action])
      }
    }
  }

  function setStatus(key, isError) {
    if (!statusEl) return
    statusEl.textContent = key ? translate(key) : ''
    statusEl.classList.toggle('hidden', !key)
    statusEl.classList.toggle('error', isError === true)
  }

  function clearHideTimer() {
    if (hideTimer === null) return
    try {
      clearTimeoutFn?.(hideTimer)
    } catch {}
    hideTimer = null
  }

  function hide() {
    clearHideTimer()
    currentReceipt = null
    busy = false
    if (!root) return
    root.classList.add('hidden')
    if (statusEl) setStatus('', false)
  }

  // `receipt` is main/ipc/export-ipc's `{ status:'saved', resultId, fileName, kind }`, or null for
  // a cancelled/failed export. A null receipt hides the bar and shows nothing: there is no file to
  // act on, and inventing an error here would double-report the failure the caller already saw.
  function show(receipt) {
    if (disposing) return false
    if (!receipt || receipt.status !== 'saved' || typeof receipt.resultId !== 'string' || !receipt.resultId) {
      hide()
      return false
    }
    if (!ensureMounted()) return false
    clearHideTimer()
    busy = false
    currentReceipt = receipt
    titleEl.textContent = translate('capture.export-result.saved', { fileName: String(receipt.fileName || '') })
    setStatus('', false)
    root.classList.remove('hidden')
    if (autoHideMs > 0 && typeof setTimeoutFn === 'function') {
      hideTimer = setTimeoutFn(() => hide(), autoHideMs)
      // A pending auto-hide must not keep a window alive during teardown.
      hideTimer?.unref?.()
    }
    return true
  }

  async function runAction(action) {
    if (!currentReceipt || busy) return { status: 'failed', code: 'busy' }
    if (!ACTION_ORDER.includes(action)) return { status: 'failed', code: 'unknown-action' }
    busy = true
    setStatus('capture.export-result.pending', false)
    let result
    try {
      result = await getAction(currentReceipt.resultId, action)
    } catch (error) {
      log('Export result action failed:', action, error?.message || error)
      result = { status: 'failed', code: 'open-failed' }
    } finally {
      busy = false
    }
    if (result?.status === 'done') {
      // A successful open/reveal moves the user to another application, so the bar has done its
      // job; a copied path stays visible long enough to confirm what was copied.
      if (action === 'copy-path') setStatus('capture.export-result.copied', false)
      else hide()
      return result
    }
    // Every failure keeps the file (it was saved) and names what failed, per plan §3.2: a failed
    // external action after a successful write is a partial failure, not a total one.
    setStatus(FAILURE_KEYS[result?.code] || 'capture.export-result.action-failed', true)
    return result || { status: 'failed', code: 'open-failed' }
  }

  function dispose() {
    disposing = true
    clearHideTimer()
    currentReceipt = null
    if (root?.parentNode) root.parentNode.removeChild(root)
    root = null
    titleEl = null
    buttonsEl = null
    statusEl = null
  }

  return {
    show,
    hide,
    dispose,
    retranslate,
    // Test/debug surface.
    getReceipt: () => (currentReceipt ? { ...currentReceipt } : null),
    isVisible: () => !!root && !root.classList.contains('hidden'),
    runAction
  }
}

// Failure code -> locale key. The main process returns stable codes (export-result-service.js
// §perform); the wording lives in the locale tables so both windows stay translated.
const FAILURE_KEYS = Object.freeze({
  'open-failed': 'capture.export-result.open-failed',
  'file-missing': 'capture.export-result.file-missing',
  'result-expired': 'capture.export-result.expired',
  'invalid-owner': 'capture.export-result.expired',
  'unknown-action': 'capture.export-result.action-failed'
})

// Browser global for the capture window's <script> tag, and CommonJS exports for the node test.
// The window loads this file directly (CSP `script-src 'self'`, no bundler), where `module` does not
// exist - so the two surfaces are guarded rather than assumed. A capture window that throws here
// would fail its whole render (test/capture-brush-render.test.js asserts the page logs no errors).
if (typeof globalThis === 'object' && globalThis) {
  globalThis.exportResultBar = { ACTION_LABELS, ACTION_ORDER, FAILURE_KEYS, createExportResultBar }
}

// Every locale key this file resolves at runtime. capture-i18n.test.js feeds this list into its
// "no dead key / no missing golden entry" check, so the bar cannot ship copy that the locale
// tables do not carry (and a removed key cannot linger in the tables unnoticed).
const LOCALE_KEYS = Object.freeze([
  ...Object.values(ACTION_LABELS),
  ...Object.values(FAILURE_KEYS),
  'capture.export-result.saved',
  'capture.export-result.copied',
  'capture.export-result.pending'
])

if (typeof module === 'object' && module.exports) {
  module.exports = {
    ACTION_LABELS,
    ACTION_ORDER,
    createExportResultBar,
    FAILURE_KEYS,
    LOCALE_KEYS
  }
}
