'use strict'

const {
  createSmartSelectSessionClass,
  convertSmartSelectRects
} = require('./smart-select')
const {
  DEFAULT_IMAGE_DPI,
  exportPdfBuffer,
  savePdfBuffer: writePdfBuffer
} = require('../../services/pdf-export')
// P0-7B（§17.6）：目录解析与保存模块同源，避免"自动保存"与此前落点判断不一致。
const { resolveSaveDirectory } = require('../../services/image-file-save')
// §17.5 的 PDF 默认名决定（S9a）：与截图保存共用同一套模板命名。
const { makeCaptureName } = require('../../services/capture-naming')
// Batch 1 (docs/plans/2026-10-25-history-reedit-batch0-contracts.md §4/§9.1 B1.1): the
// compact-window geometry for history re-edit moved out of the pin domain into a shared pure
// function, so the two no longer carry separate copies of the same arithmetic.
const { resolveEditorLayout, scaleFactorFor } = require('../../../shared/editor-layout')
const { captureForeground } = require('../../services/focused-window-capture')
const { createClipboardImageWriter } = require('../../services/clipboard-publish')
// B01: the saved-path notice is the one main-process surface a skipped explicit save can
// use after the overlay is closed. i18n-bootstrap itself is dependency-free.
const { t } = require('../../services/i18n-bootstrap')

const NATIVE_CAPTURE_TIMEOUT_MS = 5000
const ELECTRON_CAPTURE_TIMEOUT_MS = 4000
// P0-2（S9b）：光标查询的兜底预算。provider 自身的查询超时是 350ms，比抓屏慢得多，
// 这里再压一道硬预算，保证截图窗口不会被"取光标"拖住；超时按"不画"处理。
const CURSOR_QUERY_BUDGET_MS = 120
// Height of the info bar above the image when re-editing history (CSS px). The `.document-info`
// block in capture/capture.css must fit the "editing: file name (version N)" line; the editor-UI
// and floating-placement tests derive back from this value whether it is tall enough.
const DOCUMENT_EDITOR_INFO_HEIGHT = 26

// ---------------------------------------------------------------------------
// B03 (docs/review 2026-11-24, "pin and copy in one confirmation"): the output
// plan for the combined action.
//
// The action has exactly two outputs and they can fail independently - the pin
// budget (20) and a clipboard held by another process are both real Windows
// cases. Saying "done" once would hide a half-finished result, so the receipt
// carries one status per output, and a retry re-runs ONLY the outputs that are
// still missing. These functions are pure: the capture handler feeds them real
// attempts, the renderer only renders the receipt.
// ---------------------------------------------------------------------------
const PIN_COPY_OUTPUTS = Object.freeze(['pin', 'copy'])
const PIN_COPY_STATUS_KEYS = Object.freeze({
  'pin,copy': 'pin.copy-once.result-both-ok',
  'pin,missing': 'pin.copy-once.result-pin-only',
  'missing,copy': 'pin.copy-once.result-copy-only',
  'missing,missing': 'pin.copy-once.result-none'
})
const PIN_COPY_HINT_KEYS = Object.freeze({
  PIN_LIMIT: 'pin.copy-once.hint-pin-limit',
  CLIPBOARD_BUSY: 'pin.copy-once.hint-clipboard-busy'
})

function normalizePinCopyOutputs(outputs) {
  const normalized = {}
  for (const id of PIN_COPY_OUTPUTS) {
    const value = outputs ? outputs[id] : null
    normalized[id] = value && value.ok === true
      ? { ok: true }
      : { ok: false, code: (value && typeof value.code === 'string' && value.code) || 'FAILED' }
  }
  return normalized
}

// Which outputs still need an attempt. A fresh call plans both; a retry plans only
// the requested one when it is still missing, so a repeatedly clicked retry can
// never pin twice or copy twice on behalf of one confirmation.
function planPinCopyAttempts(prior, requested = PIN_COPY_OUTPUTS) {
  const base = normalizePinCopyOutputs(prior)
  const wanted = Array.isArray(requested) ? requested : PIN_COPY_OUTPUTS
  return PIN_COPY_OUTPUTS.filter((id) => wanted.includes(id) && !base[id].ok)
}

function summarizePinCopyOutputs({ prior = null, attempted = {} } = {}) {
  const outputs = normalizePinCopyOutputs(prior)
  for (const id of PIN_COPY_OUTPUTS) {
    const value = attempted ? attempted[id] : null
    if (!value) continue
    outputs[id] = value.ok === true
      ? { ok: true }
      : { ok: false, code: (typeof value.code === 'string' && value.code) || 'FAILED' }
  }
  const failed = PIN_COPY_OUTPUTS.filter((id) => !outputs[id].ok)
  const statusKey = PIN_COPY_STATUS_KEYS[PIN_COPY_OUTPUTS.map((id) => (outputs[id].ok ? id : 'missing')).join(',')]
  const hints = []
  for (const id of failed) {
    const hintKey = PIN_COPY_HINT_KEYS[outputs[id].code]
    if (hintKey && !hints.includes(hintKey)) hints.push(hintKey)
  }
  return {
    ok: failed.length === 0,
    outputs,
    failed,
    // What the renderer may offer to retry: always a subset of the failed list, in
    // the fixed pin-then-copy order, so the buttons cannot drift from the report.
    retry: [...failed],
    statusKey,
    hints
  }
}

// ---------------------------------------------------------------------------
// B01 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// "let this capture skip history". A screenshot can produce FOUR kinds of local
// copy - the flat history row, an editable revision (plus its thumbnail), the PNG
// that "copy" auto-saves, and an explicit file the user asked for. The one-shot
// switch has to constrain all of them together, or the same picture is "not kept"
// in one place and still kept in another. This table is the single source of that
// decision: the handlers ask it instead of re-deriving a condition per action, and
// the tests walk the very same table.
//
// It is a PLAN, not a promise: an explicit save that the user cancels still
// creates no file. What matters is that a plan with historyRecords=0 can never be
// turned into a record by a later stage, and a plan with explicitFiles=1 keeps
// the user's file even when history is skipped.
// ---------------------------------------------------------------------------
const CAPTURE_WRITE_ACTIONS = Object.freeze([
  'copy', 'save', 'pin', 'pin-copy', 'pin-reannotate',
  'ocr', 'translate', 'table', 'qr', 'convert',
  'pdf', 'commit', 'continue-edit', 'record-history'
])

function normalizeCaptureWriteAction(action) {
  const value = typeof action === 'string' ? action : ''
  return value === 'continue-edit' ? 'commit' : value
}

function planCaptureWrites(options = {}) {
  const action = normalizeCaptureWriteAction(options.action)
  const skipHistory = options.skipHistory === true
  const keepsHistory = skipHistory !== true && options.historyEnabled !== false
  const plan = {
    action,
    skipHistory,
    historyRecords: 0,
    explicitFiles: 0,
    revisions: 0,
    thumbnail: false,
    autoSaveFile: false
  }
  switch (action) {
    case 'copy':
      plan.historyRecords = keepsHistory ? 1 : 0
      // The auto-save is a second persistent copy of the same pixels; a skipped
      // capture must not leave one behind either.
      plan.autoSaveFile = skipHistory !== true &&
        options.autoSaveOnCopy === true &&
        options.hasSaveDirectory === true
      return plan
    case 'save':
      plan.explicitFiles = 1
      plan.historyRecords = keepsHistory ? 1 : 0
      return plan
    case 'commit':
      plan.historyRecords = keepsHistory ? 1 : 0
      plan.revisions = keepsHistory ? 1 : 0
      plan.thumbnail = keepsHistory
      return plan
    case 'pdf':
      // A PDF is an explicit file with no history row today; the switch changes nothing.
      return plan
    default:
      plan.historyRecords = keepsHistory ? 1 : 0
      return plan
  }
}

// The three Windows formats that make a clipboard publication private. Their
// PRESENCE (the first two) or a DWORD 0 (the third) is what Windows and the native
// sidecar's capture.rs both honour; the sidecar already answers Skip::Private for
// them. Electron's clipboard.writeImage cannot publish them TOGETHER with the
// image, so the actual write needs the native publication path - see
// planClipboardPublish's "pending-native" status and the B01 report.
const CLIPBOARD_HISTORY_EXCLUSION_FORMATS = Object.freeze([
  'ExcludeClipboardContentFromMonitorProcessing',
  'Clipboard Viewer Ignore',
  'CanIncludeInClipboardHistory'
])

function planClipboardPublish(options = {}) {
  if (options.skipHistory !== true) return { private: false, status: 'plain', formats: [] }
  const nativeWriter = options.nativeWriter === true
  return {
    private: nativeWriter,
    // B01 (plan item 05): there is no degraded "normal image" publication any more. When
    // the native writer is absent the only honest answer is "cannot publish privately",
    // and the caller must NOT fall back to Electron's plain write.
    status: nativeWriter ? 'private' : 'unavailable',
    formats: [...CLIPBOARD_HISTORY_EXCLUSION_FORMATS]
  }
}

function createCaptureDomain(deps) {
  const {
    app,
    spawn,
    execFile,
    fs,
    path,
    screen,
    BrowserWindow,
    desktopCapturer,
    nativeImage,
    clipboard,
    dialog,
    performance,
    rootDirectory,
    isWin,
    createLocalWindow,
    getSettings,
    log,
    assertGameModeDisabled,
    getScreenshotDesktop = () => deps.screenshotDesktop,
    listNativeDisplays,
    findNativeDisplay,
    getNativeDisplayBounds,
    readPngSize,
    shouldFilterApp,
    pinDomain,
    createRecordWindow,
    createLongCaptureFromSelection,
    createRecognitionWindow,
    persistHistory,
    saveImageBuffer,
    imageDataToBuffer,
    dataUrlToBuffer,
    bufferToDataUrl,
    performanceMonitor,
    // P0-2（S9b）：可选注入。main.js 已注入；未注入时等价于"永远不画光标"。
    cursorProvider,
    // Batch 1: the editable-document service (sessions, commit, load, result resolution).
    // Passed as a RESOLVER function rather than an instance: the service depends on a
    // historyService that only exists after initializeStore(), while the capture domain is
    // constructed earlier. When it is not injected, every document channel answers with
    // `unavailable` (unit tests can mock it).
    getCaptureDocumentService = () => null,
    // Entry point for broadcasting history:changed after a successful commit (injected by
    // main.js; nothing is broadcast without it).
    mainWindowBroadcast = null,
    // Feature A (plan §4.2/A2): optional resolver for the export-result service. Injected as a
    // function for the same reason as getCaptureDocumentService - the service is built inside
    // initializeStore(), while this domain is constructed earlier. When it is absent the producers
    // keep returning the legacy path/null shape (no result bar, nothing else changes).
    getExportResultService = () => null
  } = deps

  function exportResultService() {
    try {
      return typeof getExportResultService === 'function' ? getExportResultService() : null
    } catch (error) {
      log('Export result service unavailable:', error.message)
      return null
    }
  }

  // Wraps a legacy "path or null" producer into a plan §4.2 receipt. A null (cancelled dialog) stays
  // null so a caller can never mistake a cancel for a successful export; when the service is absent
  // the raw path is returned so an older host keeps working unchanged.
  function registerExportResult(filePath, kind, source, event) {
    if (!filePath) return null
    const service = exportResultService()
    if (!service) return filePath
    const sender = event?.sender
    const ownerId = sender && Number.isInteger(Number(sender.id)) ? `web-contents:${Number(sender.id)}` : null
    return service.register({ filePath, kind, source, ownerId }) || filePath
  }

  function captureDocumentService() {
    try {
      return typeof getCaptureDocumentService === 'function' ? getCaptureDocumentService() : null
    } catch (error) {
      log('Capture document service unavailable:', error.message)
      return null
    }
  }

  // -------------------------------------------------------------------------
  // N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.2):
  // the background OCR index for screenshot history.
  //
  // main.js constructs the domains before the IPC aggregation, and registerAllIpc() is where the
  // indexer is built (it owns the OCR controller and the settings resolver), so the indexer
  // arrives through this attach point instead of a constructor dependency. Until it is attached
  // every persist below keeps its shipped behaviour: a record is written and nothing else happens.
  // -------------------------------------------------------------------------
  let historyOcrIndexer = null

  function attachHistoryOcrIndexer(indexer) {
    historyOcrIndexer = indexer && typeof indexer.enqueue === 'function' ? indexer : null
    return historyOcrIndexer !== null
  }

  function enqueueHistoryOcr(historyItem) {
    if (!historyOcrIndexer || !historyItem || typeof historyItem !== 'object') return false
    try {
      // enqueue() only appends to an idle serial queue; it never waits for OCR.
      return historyOcrIndexer.enqueue(historyItem) !== false
    } catch (error) {
      log('History OCR enqueue failed:', error?.message || String(error))
      return false
    }
  }

  // The one door every history write in this domain goes through: persist, then hand the new
  // record to the indexer. It accepts the promise shape too so a fake/alternate persistHistory
  // cannot make the index silently skip the row.
  function persistHistoryEntry(imageData, meta) {
    const created = persistHistory(imageData, meta)
    if (created && typeof created.then === 'function') {
      return created.then((historyItem) => {
        enqueueHistoryOcr(historyItem)
        return historyItem
      })
    }
    enqueueHistoryOcr(created)
    return created
  }

  // -------------------------------------------------------------------------
  // B01: the one-shot "do not keep this capture" switch.
  //
  // The renderer sends the switch value with EVERY action's meta, because that is
  // exactly the state the user saw when pressing the button. The window also keeps
  // the value it was OPENED with: a pin created with skip hands the flag to its
  // re-annotate editor, so a path that forgets to forward meta cannot silently
  // re-enable history for the same result.
  // -------------------------------------------------------------------------
  function resolveSkipHistory(win, meta) {
    if (meta && typeof meta.skipHistory === 'boolean') return meta.skipHistory === true
    return win != null && win._skipHistory === true
  }

  // U02 / DEV-01: the optional pin re-annotation snapshot travels inside the EXISTING
  // capture:pin / capture:pin-reannotate payload as `meta.pinEditable` (no new IPC
  // channel). It is removed from `meta` here - BEFORE any history write, retry receipt or
  // window field copies it - and handed to the pin domain as a separate argument, so an
  // unredacted base bitmap can never be serialised by a path that only knows `meta`.
  // A skipped ("do not keep") capture never forwards one even if a stale renderer sent it.
  function pullPinEditable(meta, skipHistory) {
    if (!meta || typeof meta !== 'object' || meta.pinEditable === undefined) return null
    const raw = meta.pinEditable
    delete meta.pinEditable
    if (skipHistory === true) return null
    return raw
  }

  function historyEnabledNow() {
    // HistoryService itself refuses to write while the global switch is off; asking here
    // as well keeps the plan honest (a disabled history is 0 records, not "scheduled").
    try {
      return getSettings()?.screenshot?.historyEnabled !== false
    } catch {
      return true
    }
  }

  function capturePlan(action, skipHistory, extra = {}) {
    return planCaptureWrites({
      action,
      skipHistory,
      historyEnabled: historyEnabledNow(),
      ...extra
    })
  }

  // The second half of the race contract: one result = at most one record per kind,
  // even when the renderer repeats the same action before a delayed write runs. The
  // claim lives on the result (the window object), never on a timer, so closing the
  // window cannot resurrect a record that was never scheduled.
  function claimResultWrite(win, kind) {
    if (!win || typeof win !== 'object') return true
    if (!win._resultWriteClaims) win._resultWriteClaims = new Set()
    const key = String(kind || '')
    if (win._resultWriteClaims.has(key)) return false
    win._resultWriteClaims.add(key)
    return true
  }

  // Delayed history writes are the only place a skipped capture could still land
  // after its window is gone, so they all go through ONE scheduler. It refuses a
  // plan with no record and it is idempotent per result + action.
  function scheduleHistoryWrite(win, plan, buffer, meta) {
    if (!plan || plan.historyRecords !== 1) return false
    if (!claimResultWrite(win, `history:${plan.action}`)) return false
    const persistStarted = Date.now()
    setImmediate(() => {
      try {
        persistHistoryEntry(buffer, { ...meta, action: plan.action })
        performanceMonitor.record('capture.history-persist', Date.now() - persistStarted, { action: plan.action })
      } catch (error) {
        log('Capture history persist failed:', error.message)
      }
    })
    return true
  }

  // Auto-save on copy is a second copy of the same pixels; the switch skips it, and a
  // repeated copy must not produce two files either.
  function scheduleAutoSave(win, buffer) {
    if (!claimResultWrite(win, 'auto-save')) return false
    saveImageBuffer(buffer, { fast: true }).catch((error) => log(error.message))
    return true
  }

  // One clipboard publication for both the plain and the skipped copy, so the copy
  // path and "pin and copy" cannot disagree about which formats were attached.
  //
  // B01 (plan item 05): the private publication is the native writer (one OpenClipboard
  // call that sets the exclusion formats BEFORE the pixels). It is awaited - the promise
  // IS the write - and there is deliberately NO fallback to `clipboard.writeImage`: the
  // whole point of the switch is that a plain image never reaches Windows history. A busy
  // clipboard is retried; a missing writer or a marker failure is reported as a failure.
  const PUBLICATION_RETRYABLE = new Set(['CLIPBOARD_BUSY', 'COPY_INTERRUPTED', 'QUIESCING', 'BACKPRESSURE'])
  // The clipboard domain registers its native publisher when it is constructed; the writer
  // resolves it at click time. An injected writer wins, so a test can drive the seam.
  const writeClipboardImage = typeof deps.writeClipboardImage === 'function'
    ? deps.writeClipboardImage
    : createClipboardImageWriter({ log })
  async function writeImageToClipboard(image, { skipHistory = false, retries = 2 } = {}) {
    const nativeWriter = typeof writeClipboardImage === 'function' ? writeClipboardImage : null
    const publication = planClipboardPublish({ skipHistory, nativeWriter: !!nativeWriter })
    if (!publication.private) {
      clipboard.writeImage(image)
      return { ok: true, ...publication, attempts: 0 }
    }
    let last = { ok: false, code: 'PUBLICATION_FAILED' }
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      try {
        const result = await nativeWriter(image, { private: true })
        if (result && result.ok === true) {
          return { ok: true, ...publication, attempts: attempt, receipt: result }
        }
        last = result && typeof result === 'object' ? result : { ok: false, code: 'PUBLICATION_FAILED' }
      } catch (error) {
        last = { ok: false, code: error?.code || 'PUBLICATION_FAILED', message: error?.message }
      }
      if (!PUBLICATION_RETRYABLE.has(String(last.code || '')) || attempt > retries) break
      await new Promise((resolve) => setTimeout(resolve, 60 * attempt))
    }
    log('Private clipboard publication failed:', last.code || 'unknown')
    return {
      ok: false,
      code: last.code || 'PUBLICATION_FAILED',
      attempts: Number(last.attempts) || retries + 1,
      ...publication,
      private: true
    }
  }

  // B01: with history skipped there is no record to re-find the file later, so an
  // explicit save has to say where it landed. A native info box is the one surface
  // guaranteed to still exist after the overlay closes; it is only used for skipped
  // saves, so the shipped save path keeps its exact behaviour.
  function announceSavedPath(filePath) {
    if (!filePath || !dialog || typeof dialog.showMessageBox !== 'function') return false
    try {
      Promise.resolve(dialog.showMessageBox({
        type: 'info',
        noLink: true,
        buttons: [t('common.button.ok')],
        defaultId: 0,
        title: t('capture-skip.save.title'),
        message: t('capture-skip.save.message'),
        detail: String(filePath)
      })).catch(() => {})
      return true
    } catch (error) {
      log('Saved-path notice failed:', error.message)
      return false
    }
  }

  // -------------------------------------------------------------------------
  // B03: the two outputs behind one "pin and copy" confirmation.
  //
  // Each is attempted independently so a partial result can be reported as such:
  // the pin can hit the 20-window budget while the clipboard still gets the image,
  // or the clipboard can be held by another process while the pin is created.
  // -------------------------------------------------------------------------
  function aliveCaptureWindow(win) {
    if (!win) return false
    return !(typeof win.isDestroyed === 'function' && win.isDestroyed())
  }

  // Electron does not throw when another process holds the Windows clipboard: the
  // write is silently dropped. Reading the image back is what turns that into a
  // reportable failure instead of a false "copied".
  async function copyBufferToClipboard(buffer, options = {}) {
    try {
      const image = nativeImage.createFromBuffer(buffer)
      const publication = await writeImageToClipboard(image, options)
      // B01: the private path reports the NATIVE receipt, not a readback - the exclusion
      // markers are what makes the write private, and they are not observable by reading
      // the image back.
      if (!publication.ok) return { ok: false, code: publication.code || 'PUBLICATION_FAILED', publication }
      if (publication.private) {
        return { ok: true, exclusion: publication.status, publication }
      }
      const expected = typeof image?.getSize === 'function' ? image.getSize() : null
      if (!expected || !(expected.width > 0) || !(expected.height > 0)) return { ok: true }
      if (typeof clipboard.readImage !== 'function') return { ok: true }
      const actual = clipboard.readImage()?.getSize?.()
      if (!actual || !(actual.width > 0) || !(actual.height > 0)) return { ok: false, code: 'CLIPBOARD_BUSY' }
      if (actual.width !== expected.width || actual.height !== expected.height) {
        return { ok: false, code: 'CLIPBOARD_BUSY' }
      }
      return { ok: true, exclusion: publication?.exclusion || publication?.status || 'plain' }
    } catch (error) {
      log('Capture clipboard write failed:', error.message)
      return { ok: false, code: 'CLIPBOARD_BUSY' }
    }
  }

  // The pin domain's budget is a state, not an error string: asking it before the
  // attempt lets the receipt carry the actionable PIN_LIMIT hint. A re-annotation
  // reuses its own slot (editingExisting), so it never counts against the budget.
  function pinBudgetReached(event, captureWindow) {
    try {
      if (typeof pinDomain.canPinMore !== 'function') return false
      if (captureWindow?._editingPinWindow) return false
      return !pinDomain.canPinMore()
    } catch (error) {
      log('Pin budget probe failed:', error.message)
      return false
    }
  }

  function attemptPinOutput(event, captureWindow, buffer, meta, skipHistory = false) {
    // U02 / DEV-01: the editable snapshot for this attempt lives on the capture window
    // (transient, same lifetime as the one-shot receipt) so the shipped call shape and its
    // contract tests stay unchanged. It is never read by the history writer.
    const editableSnapshot = captureWindow?._pinEditableSnapshot || null
    if (pinBudgetReached(event, captureWindow)) return { ok: false, code: 'PIN_LIMIT' }
    try {
      const created = editableSnapshot
        ? pinDomain.pinFromCapture(event, buffer, meta, '', { editableSnapshot })
        : pinDomain.pinFromCapture(event, buffer, meta)
      // B01: the pin is the same result as the capture that produced it, so it carries
      // the switch into its re-annotate editor instead of re-enabling history there.
      if (created?.pinWindow) {
        created.pinWindow._skipHistory = skipHistory === true
        // D05 (18): the flag travels in the retained metadata, so a recovered pin keeps it.
        if (created.pinWindow._pinData) created.pinWindow._pinData.meta.skipHistory = skipHistory === true
      }
      return { ok: true }
    } catch (error) {
      log('Capture pin failed:', error?.message || String(error))
      return { ok: false, code: 'PIN_FAILED' }
    }
  }

  function persistPinCopyHistory(buffer, meta) {
    // Defence in depth: the receipt already refuses to schedule a record for a skipped
    // capture, but a future caller must not be able to bypass the switch here either.
    if (meta && meta.skipHistory === true) return false
    const persistStarted = Date.now()
    setImmediate(() => {
      try {
        persistHistoryEntry(buffer, { ...meta, action: 'pin' })
        performanceMonitor.record('capture.history-persist', Date.now() - persistStarted, { action: 'pin-copy' })
      } catch (error) {
        log('Capture history persist failed:', error.message)
      }
    })
    return true
  }

  // One confirmation = one export = at most ONE history record, even when only one
  // of the two outputs landed. The receipt lives on the capture window so a retry
  // can only fill in the missing half.
  async function pinAndCopyOnce(event, captureWindow, buffer, meta, editableSnapshot = null) {
    const skipHistory = resolveSkipHistory(captureWindow, meta)
    if (captureWindow && typeof captureWindow === 'object') captureWindow._pinEditableSnapshot = editableSnapshot
    const attempted = {
      // The snapshot argument is optional: the shipped call shape stays valid when there
      // is nothing editable to carry (old flat pins, private captures, history editors).
      pin: attemptPinOutput(event, captureWindow, buffer, meta, skipHistory),
      copy: await copyBufferToClipboard(buffer, { skipHistory })
    }
    const receipt = summarizePinCopyOutputs({ attempted })
    receipt.recorded = attempted.pin.ok || attempted.copy.ok
    // A skipped capture keeps BOTH outputs but neither local record. "recorded" is the
    // receipt's memory across a retry, so it must stay false for this whole result.
    if (skipHistory) receipt.recorded = false
    if (receipt.recorded) persistPinCopyHistory(buffer, meta)
    receipt.history = skipHistory ? 'skipped' : (receipt.recorded ? 'recorded' : 'none')
    if (aliveCaptureWindow(captureWindow)) captureWindow._pinCopyState = receipt
    return receipt
  }

  function stalePinCopyReceipt() {
    return {
      ok: false,
      stale: true,
      outputs: {},
      failed: [],
      retry: [],
      hints: [],
      recorded: false,
      statusKey: 'pin.copy-once.result-stale'
    }
  }

  async function retryPinCopy(captureWindow, kind, { event, buffer, meta, editableSnapshot = null }) {
    const prior = captureWindow?._pinCopyState
    if (!prior || !prior.outputs) return stalePinCopyReceipt()
    const skipHistory = resolveSkipHistory(captureWindow, meta)
    const targets = planPinCopyAttempts(prior.outputs, [kind])
    if (!targets.length) {
      // That half already succeeded: report the same receipt again instead of
      // repeating the output, which is what makes a double click harmless.
      return { ...prior, reattempted: [] }
    }
    const attempted = {}
    if (captureWindow && typeof captureWindow === 'object') captureWindow._pinEditableSnapshot = editableSnapshot
    if (kind === 'pin') attempted.pin = attemptPinOutput(event, captureWindow, buffer, meta, skipHistory)
    else attempted.copy = await copyBufferToClipboard(buffer, { skipHistory })
    const receipt = summarizePinCopyOutputs({ prior: prior.outputs, attempted })
    // A confirmation that failed both outputs recorded nothing; the first retry that
    // lands may still write the single missing record. The flag is set before the
    // write is scheduled so two rapid retries cannot both schedule one.
    receipt.recorded = prior.recorded === true
    if (skipHistory) receipt.recorded = false
    else if (!receipt.recorded && (receipt.outputs.pin.ok || receipt.outputs.copy.ok)) {
      receipt.recorded = true
      persistPinCopyHistory(buffer, meta)
    }
    receipt.history = skipHistory ? 'skipped' : (receipt.recorded ? 'recorded' : 'none')
    if (aliveCaptureWindow(captureWindow)) captureWindow._pinCopyState = receipt
    return { ...receipt, reattempted: targets }
  }

  // P0-4：可选注入，便于单测 mock；主进程不注入时由 pdf-export 自解析 Electron 依赖，
  // 因此本特性不需要任何 main.js 接线（§2.2 规则 3）。
  const printToPdf = typeof deps.printToPdf === 'function' ? deps.printToPdf : null
  const savePdfBuffer = typeof deps.savePdfBuffer === 'function' ? deps.savePdfBuffer : writePdfBuffer

  const SmartSelectSession = createSmartSelectSessionClass({ spawn, log })
  let currentCaptureWindow = null
  let nativeShutterWindow = null
  let nativeDisplayListPromise = null
  let captureCreateSeq = 0
  // P0-7-T7 精确接续（2026-10-10 真机验收修正）：主进程记的是"上一张实际用掉的最后一个序号"，
  // 而不是"第几次截图"。窗口新建时下发这个值，渲染层每落一个序号就自增，并在完成动作时
  // 通过既有通道的 meta.serialNumber 回报（不新增通道）；这里只接受前进。
  let captureSerialSeq = 1

  // 渲染层回报的序号是本张图"下一个该用的号"，比当前值大才推进 —— 同一张图可能经多条
  // 路径回报（保存/贴图/导出 PDF/关窗），重复回报不会把计数推过头。
  function reportCaptureSerial(meta) {
    // 开关关闭时不推进计数：渲染层每张仍从 1 开始，若此时也记"下一个该用的号"，用户"先关后开"
    // 时首张启用截图就不再从 1 开始（旧实现 captureSerialSeq++ 只在启用时自增）。
    if (getSettings()?.screenshot?.keepSerialAcrossCaptures !== true) return
    const reported = Math.round(Number(meta?.serialNumber))
    if (Number.isFinite(reported) && reported > captureSerialSeq) captureSerialSeq = reported
  }

  async function createSmartSelectSession() {
    if (!isWin) return null
    const executablePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'smart-select', 'SmartSelect.exe')
      : path.join(rootDirectory, 'native', 'smart-select', 'SmartSelect.exe')
    if (!fs.existsSync(executablePath)) {
      log('Smart select helper missing:', executablePath)
      return null
    }
    const session = new SmartSelectSession(executablePath)
    try {
      await session.waitUntilReady()
      return session
    } catch (error) {
      log('Smart select unavailable:', error.message)
      session.dispose()
      return null
    }
  }

  // P0-2（S9b）：只有"截图带光标"开关打开、且 deps 里真的注入了 provider 时才查询。
  // provider 是懒启动的（`query()` 是拉起 SmartSelect.exe 的唯一入口），所以开关关闭时
  // 连 helper 进程都不会被创建 —— 这就是"关 = 零开销"的证明点。
  // 必须 `fresh: true`：provider 默认复用 250ms 内的形状缓存，而截图要的是"此刻"的位置。
  // 任何失败（拒绝 / 超时 / provider 抛错）都降级成 null = 不画光标，绝不影响抓屏。
  function queryCursorSnapshot() {
    if (!cursorProvider || typeof cursorProvider.query !== 'function') return Promise.resolve(null)
    if (getSettings()?.screenshot?.captureCursor !== true) return Promise.resolve(null)
    let timer = null
    const providerPromise = Promise.resolve()
      .then(() => cursorProvider.query({ fresh: true }))
      .then((snapshot) => snapshot || null, () => null)
    const budgetPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CURSOR_QUERY_BUDGET_MS) })
    return Promise.race([providerPromise, budgetPromise]).then((snapshot) => {
      clearTimeout(timer)
      return snapshot || null
    }, () => null)
  }

  // P1 §6.2 (2026-11-26 review): skip the synchronous full-image decode for buffers far
  // too large to be a blank capture. Buffers at or below the limit keep the original pixel probe.
  //
  // The review proposed 32 KiB, but that estimate does not hold with this repo's PNG encoder: a
  // solid-colour 4K frame is ~166 KiB black and ~37 KiB white, so 32 KiB would skip probing
  // exactly the images the probe exists for (a failed native capture returns a black frame).
  // 256 KiB still skips every real screenshot (hundreds of KiB to several MiB) and keeps the
  // blank fallback working for 1080p and 4K. Measured with sharp 0.35.5, the same encoder the
  // capture path uses.
  const BLANK_CAPTURE_DECODE_LIMIT = 256 * 1024

  function canBeBlankCapture(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length <= BLANK_CAPTURE_DECODE_LIMIT
  }

  function isBlankCapture(image) {
    if (!image || image.isEmpty()) return true
    const size = image.getSize()
    const sample = image.resize({
      width: Math.max(1, Math.min(32, size.width)),
      height: Math.max(1, Math.min(32, size.height)),
      quality: 'good'
    }).toBitmap()
    if (!sample.length) return true
    for (let index = 0; index + 2 < sample.length; index += 4) {
      if (sample[index] > 2 || sample[index + 1] > 2 || sample[index + 2] > 2) return false
    }
    return true
  }

  async function getDesktopCapture(display, scaleFactor) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
          height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
        }
      })
      const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
      if (source && !source.thumbnail.isEmpty() && !isBlankCapture(source.thumbnail)) {
        return { imageBuffer: source.thumbnail.toPNG(), sourceId: source.id, scaleFactor }
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('屏幕捕获连续返回空白画面')
  }

  let activeDesktopCapture = null
  async function queueDesktopCapture(display, scaleFactor, isCurrent) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('屏幕捕获超时')), ELECTRON_CAPTURE_TIMEOUT_MS)
    })
    try {
      while (activeDesktopCapture && isCurrent()) await Promise.race([activeDesktopCapture, timeout])
      if (!isCurrent()) throw new Error('截图请求已被替换')
      const task = getDesktopCapture(display, scaleFactor)
      const unlock = () => { activeDesktopCapture = null }
      // A timeout cannot cancel Chromium enumeration. Leave the slot occupied
      // until the underlying call finishes, without retaining its image.
      activeDesktopCapture = task.then(unlock, unlock)
      return await Promise.race([task, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async function getDisplayCapture(display, isCurrent = () => true) {
    const scaleFactor = display.scaleFactor || 1
    let fallbackReason = null
    if (isWin) {
      try {
        fallbackReason = 'native-display-discovery'
        const screenshotDesktop = getScreenshotDesktop()
        if (!nativeDisplayListPromise) nativeDisplayListPromise = listNativeDisplays(screenshotDesktop.parseDisplaysOutput)
        const nativeDisplays = await nativeDisplayListPromise
        const physicalBounds = screen.dipToScreenRect(null, display.bounds)
        const nativeDisplay = findNativeDisplay(
          nativeDisplays,
          physicalBounds,
          Math.max(1, Math.ceil(scaleFactor))
        )
        if (nativeDisplay) {
          fallbackReason = 'native-capture-failed'
          // The capture helper is an external cmd.exe pipeline with no timeout of
          // its own; without this guard a hung spawn would wedge window creation.
          const buffer = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`原生抓屏超时（${NATIVE_CAPTURE_TIMEOUT_MS}ms）`)),
              NATIVE_CAPTURE_TIMEOUT_MS
            )
            screenshotDesktop({ format: 'png', screen: nativeDisplay.id }).then(
              (result) => { clearTimeout(timer); resolve(result) },
              (error) => { clearTimeout(timer); reject(error) }
            )
          })
          const nativeBounds = getNativeDisplayBounds(nativeDisplay)
          // Read the dimensions straight out of the PNG IHDR chunk so a
          // wrong-sized capture fails without decoding a full-screen bitmap.
          const pngSize = readPngSize(buffer)
          if (!pngSize || pngSize.width !== nativeBounds.width || pngSize.height !== nativeBounds.height) {
            fallbackReason = 'native-size-mismatch'
            throw new Error(`原生抓屏尺寸异常：${pngSize ? `${pngSize.width}x${pngSize.height}` : '未知'}`)
          }
          if (canBeBlankCapture(buffer) && isBlankCapture(nativeImage.createFromBuffer(buffer))) {
            fallbackReason = 'native-blank'
            throw new Error('原生抓屏返回空白画面')
          }
          return {
            imageBuffer: buffer,
            sourceId: `native:${nativeDisplay.id}`,
            scaleFactor,
            backend: 'native',
            fallbackReason: null
          }
        }
        fallbackReason = 'native-display-unmatched'
        nativeDisplayListPromise = null
      } catch (error) {
        nativeDisplayListPromise = null
        log('Native capture fallback:', error.message)
      }
    }
    const capture = await queueDesktopCapture(display, scaleFactor, isCurrent)
    return { ...capture, backend: 'electron', fallbackReason }
  }

  let focusedCaptureActive = false
  async function captureFocusedWindow() {
    if (focusedCaptureActive) throw new Error('正在捕获焦点窗口')
    focusedCaptureActive = true
    let fallback
    let timer
    try {
      let windowId = null
      if (isWin) {
        const capture = await captureForeground({
          execFile,
          dirname: app.isPackaged ? process.resourcesPath : rootDirectory,
          packaged: app.isPackaged
        })
        windowId = capture.windowId
        if (capture.protected || !windowId) throw new Error('无法捕获焦点窗口')
        if (capture.imageBuffer) {
          // Same blank short-circuit as the full-display path: only a small PNG can be blank.
          const blank = canBeBlankCapture(capture.imageBuffer) &&
            isBlankCapture(nativeImage.createFromBuffer(capture.imageBuffer))
          if (!blank) {
            log('Focused capture backend:', 'native')
            return capture.imageBuffer
          }
        }
      }
      fallback = desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } })
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('捕获焦点窗口超时')), ELECTRON_CAPTURE_TIMEOUT_MS)
      })
      const sources = await Promise.race([fallback, timeout])
      const source = windowId
        ? sources.find((item) => item.id.startsWith(`window:${windowId}:`))
        : sources.find((item) => !shouldFilterApp(item.name))
      if (!source || source.thumbnail.isEmpty()) throw new Error('无法捕获焦点窗口')
      log('Focused capture backend:', 'electron')
      return source.thumbnail.toPNG()
    } finally {
      clearTimeout(timer)
      // Electron cannot cancel enumeration. Keep it single-flight even after timeout.
      if (fallback) {
        const unlock = () => { focusedCaptureActive = false }
        fallback.then(unlock, unlock)
      } else {
        focusedCaptureActive = false
      }
    }
  }

  // §3.2② (Snow a7673a353): the Ctrl+A second level needs the union of every display in
  // DIP, the same space as `captureBounds`, so the renderer can turn it into stage
  // coordinates by one subtraction. Computed from the live display list at init time (a
  // monitor plugged in while the window is open is the next capture's problem). A single
  // display yields exactly that display's bounds, which is what makes the second level a
  // no-op on single-monitor setups instead of a special case in the renderer.
  function desktopBounds() {
    // Unit-test fakes and platforms with a minimal screen stub only answer
    // getDisplayMatching; "no display list" must degrade to "no second level", not to a
    // noisy log line per capture.
    if (typeof screen?.getAllDisplays !== 'function') return null
    let displays = []
    try {
      displays = screen.getAllDisplays() || []
    } catch (error) {
      log('Display union unavailable:', error.message)
      return null
    }
    if (!displays.length) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const display of displays) {
      const bounds = display?.bounds
      if (!bounds) continue
      left = Math.min(left, bounds.x)
      top = Math.min(top, bounds.y)
      right = Math.max(right, bounds.x + bounds.width)
      bottom = Math.max(bottom, bounds.y + bounds.height)
    }
    if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return null
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  function sendCaptureInit(win) {
    if (
      !win ||
      win.isDestroyed() ||
      !win._captureRendererReady ||
      !win._captureInit ||
      win._captureInitSent
    ) return false
    win._captureInitSent = true
    win.webContents.send('capture:init', win._captureInit)
    return true
  }

  function playNativeShutter(win) {
    if (!isWin || win._captureInit?.settings?.screenshot?.shutterSound === false) return false
    if (nativeShutterWindow) {
      nativeShutterWindow = win
      return true
    }
    const directory = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'shutter-sound')
      : path.join(rootDirectory, 'native', 'shutter-sound', 'bin')
    const executable = path.join(directory, 'HighlighterShutterSound.exe')
    if (!fs.existsSync(executable)) return false
    nativeShutterWindow = win
    try {
      execFile(executable, [], { windowsHide: true, timeout: 1500 }, (error) => {
        const fallbackWindow = nativeShutterWindow
        nativeShutterWindow = null
        // The renderer plays at most once if Windows playback fails after reveal.
        if (error && fallbackWindow && !fallbackWindow.isDestroyed()) fallbackWindow.webContents.send('capture:shown', true)
      })
      return true
    } catch {
      nativeShutterWindow = null
      return false
    }
  }

  function revealCaptureWindow(win) {
    if (!win || win.isDestroyed() || win._captureVisible) return
    clearTimeout(win._renderTimeout)
    win._captureVisible = true
    win.setOpacity(1)
    win.showInactive()
    win.webContents.send('capture:shown', !playNativeShutter(win))
    setImmediate(() => {
      if (win.isDestroyed()) return
      win.focus()
    })
  }

  // The compact editor for history "continue editing" (design §3.2 / §5.3 / §9.1 B1.1).
  //
  // Today that path just starts another region capture: no windowBounds means full screen,
  // alwaysOnTop and a focus grab, and the image gets stretched into pixels. The pin domain
  // already solved this once (`startPinReannotation`), so this reuses the same geometry
  // (shared/editor-layout.js) instead of writing a second version of it.
  //
  // Only three things differ from pin, all of them because a history document has a crop:
  //   1. The window is sized to the SOURCE-PIXEL size of the crop, not to the whole base image.
  //   2. An info row (file name + version) is reserved above the image and counted into the
  //      actionSpace height.
  //   3. What is edited is a committed revision, so opening it must be able to commit back
  //      (session binding + expectedRevisionId).
  async function createDocumentEditorWindow(options = {}) {
    const documentId = String(options.documentId || '')
    if (!documentId) throw new Error('继续编辑需要文档 id')
    const documentService = captureDocumentService()
    const loaded = documentService
      ? documentService.loadDocument(documentId, options.revisionId)
      : { ok: false, code: 'unavailable' }
    if (!loaded || !loaded.ok) {
      throw new Error(loaded?.code === 'deleted' ? '该记录已不存在' : '无法打开该记录的编辑文档')
    }
    // A legacy flat image (no document) takes bitmap-only recovery: the full image becomes the
    // base, with an empty vector list (§6.7).
    const baseImagePath = loaded.baseImagePath || loaded.resultImagePath
    if (!baseImagePath || !fs.existsSync(baseImagePath)) throw new Error('该记录的文件已丢失')
    const imageBuffer = await fs.promises.readFile(baseImagePath)
    const imageSize = readPngSize(imageBuffer)
    if (!imageSize) throw new Error('底图无法解码')
    // Edit area = the crop, in source pixels; a legacy image has no crop, so it is the whole image.
    const crop = loaded.document?.crop || { x: 0, y: 0, w: imageSize.width, h: imageSize.height }
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const layout = resolveEditorLayout({
      imageWidth: crop.w,
      imageHeight: crop.h,
      workArea,
      // The info row: file name + version + dirty marker. Its height comes from
      // capture.css's `.document-info`, and the layout test checks this value is tall enough.
      extraRows: 1,
      extraRowHeight: DOCUMENT_EDITOR_INFO_HEIGHT
    })
    const sessionResult = documentService.beginSession({
      documentId,
      intent: 'update',
      source: loaded.legacy ? 'history' : 'history',
      windowId: null
    })
    if (!sessionResult.ok) throw new Error(sessionResult.code === 'deleted' ? '该记录已不存在' : '无法开始编辑会话')
    let captureWindow = null
    try {
      captureWindow = await createCaptureWindow({
        imageBuffer,
        mode: 'image',
        source: 'history',
        windowBounds: layout.editorBounds,
        imageBounds: layout.imageBounds,
        // The info row sits outside the image, so the window must be transparent or that area
        // would be painted as an opaque background.
        transparent: true,
        sourceScaleFactor: scaleFactorFor({ imageWidth: layout.imageWidth, sourceWidth: crop.w }),
        // Re-edit load payload: document content + session + the commit intents that are allowed.
        // Same shape as pin's `editPin`: it is how the renderer takes the "can commit" branch
        // instead of the "new screenshot" one.
        documentEditor: {
          sessionId: sessionResult.session.sessionId,
          documentId,
          revisionId: loaded.revisionId || '',
          version: loaded.version || 1,
          // A legacy image can only gain new objects on top: its old annotations are pixels (§6.7).
          legacy: loaded.legacy === true,
          storageFormat: loaded.storageFormat || 'legacy-bitmap',
          degraded: loaded.degraded === true,
          document: loaded.document || null,
          crop,
          infoHeight: DOCUMENT_EDITOR_INFO_HEIGHT
        }
      })
    } catch (error) {
      documentService?.endSession(sessionResult.session.sessionId)
      throw error
    }
    if (!captureWindow) {
      documentService?.endSession(sessionResult.session.sessionId)
      return null
    }
    captureWindow._documentEditorSessionId = sessionResult.session.sessionId
    // Hide the launching window while editing and restore focus on close, mirroring pin's
    // editingPinWindow. `hide()` is deliberately not used here: keeping the config window behind
    // is an explicit design requirement (§2.1, "the config window stays behind and is not hidden").
    return captureWindow
  }

  async function createCaptureWindow(options = {}) {
    assertGameModeDisabled()
    const createSeq = ++captureCreateSeq
    const performanceStartedAt = performance.now()
    const mode = options.mode || 'region'
    const requestedBounds = options.windowBounds && {
      x: Math.round(options.windowBounds.x),
      y: Math.round(options.windowBounds.y),
      width: Math.max(1, Math.round(options.windowBounds.width)),
      height: Math.max(1, Math.round(options.windowBounds.height))
    }
    const display = options.display || (requestedBounds
      ? screen.getDisplayMatching(requestedBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    const captureBounds = requestedBounds || display.bounds
    const captureDetails = {
      captureId: createSeq,
      mode,
      width: captureBounds.width,
      height: captureBounds.height
    }
    const performanceTiming = {
      startedAt: performanceStartedAt,
      captureMs: 0,
      smartSelectMs: 0,
      windowLoadMs: 0,
      details: captureDetails
    }
    performanceMonitor.record('capture.started', 0, captureDetails)
    const suppliedImageBuffer = options.imageBuffer
      ? imageDataToBuffer(options.imageBuffer)
      : options.imageDataUrl
        ? dataUrlToBuffer(options.imageDataUrl)
        : null
    const rawCapturePromise = suppliedImageBuffer || options.mode === 'canvas'
      ? Promise.resolve({
          imageBuffer: suppliedImageBuffer || Buffer.alloc(0),
          sourceId: '',
          scaleFactor: Number(options.sourceScaleFactor) || display.scaleFactor || 1,
          backend: suppliedImageBuffer ? 'supplied-image' : 'canvas',
          fallbackReason: null
        })
      : getDisplayCapture(display, () => captureCreateSeq === createSeq)
    const capturePromise = Promise.resolve(rawCapturePromise).then((capture) => {
      performanceTiming.captureMs = Math.round((performance.now() - performanceStartedAt) * 100) / 100
      captureDetails.backend = capture.backend
      captureDetails.fallbackReason = capture.fallbackReason
      captureDetails.scaleFactor = capture.scaleFactor
      performanceMonitor.record('capture.acquired', performanceTiming.captureMs, captureDetails)
      return capture
    })
    // Smart selection can still be initializing when an older capture is superseded.
    capturePromise.catch(() => {})
    // P0-2（S9b 补漏）：只有"真的抓了屏幕"的路径才查光标。mode:'image'（贴图重新标注）与
    // mode:'canvas'（空白画布）的画面不是本次屏幕内容 —— 把此刻的光标贴上去是杂散像素，且它们
    // 的 scaleFactor 是"图像/编辑器比例"而非显示缩放，落点无意义。
    const cursorPromise = suppliedImageBuffer || mode === 'canvas'
      ? Promise.resolve(null)
      : queryCursorSnapshot()
    const smartSelectStartedAt = performance.now()
    const smartSelectPromise = (mode === 'region' ? createSmartSelectSession() : Promise.resolve(null)).then((session) => {
      performanceTiming.smartSelectMs = Math.round((performance.now() - smartSelectStartedAt) * 100) / 100
      return session
    })
    const smartSelectSession = await smartSelectPromise
    if (createSeq !== captureCreateSeq) {
      smartSelectSession?.dispose()
      return null
    }
    if (currentCaptureWindow && !currentCaptureWindow.isDestroyed()) currentCaptureWindow.close()
    const transparent = mode === 'canvas' || !!options.transparent
    const pagePath = path.join(rootDirectory, 'capture', 'capture.html')
    const captureWindow = createLocalWindow(pagePath, {
      role: 'capture-editor',
      x: captureBounds.x,
      y: captureBounds.y,
      width: Math.min(captureBounds.width, 800),
      height: Math.min(captureBounds.height, 600),
      frame: false,
      transparent,
      backgroundColor: transparent ? '#00ffffff' : '#000000',
      fullscreenable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      opacity: 0,
      resizable: false,
      movable: false,
      hasShadow: !transparent,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-capture.js'),
        backgroundThrottling: false,
        // P0-7-T5：快门音由渲染层 play() 触发，截图窗口没有用户手势，
        // 必须放开自动播放策略，否则 play() 会被 Autoplay Policy 拒绝。
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    currentCaptureWindow = captureWindow
    captureWindow._editingPinWindow = options.editingPinWindow || null
    // B01: a pin created with "do not keep this capture" hands the switch to its
    // re-annotate editor, so reopening the same pixels does not silently start
    // writing history again. Any other capture starts with the renderer's default
    // (which follows screenshot.historyEnabled).
    const inheritedSkipHistory = options.skipHistory === true ||
      options.editingPinWindow?._skipHistory === true
    captureWindow._skipHistory = inheritedSkipHistory
    captureWindow._captureVisible = false
    captureWindow._captureInitSent = false
    captureWindow._captureRendererReady = false
    captureWindow._performanceTiming = performanceTiming
    captureWindow._smartSelectContext = smartSelectSession
      ? {
          session: smartSelectSession,
          captureBounds,
          physicalBounds: screen.dipToScreenRect(null, captureBounds)
        }
      : null
    captureWindow.setAlwaysOnTop(true, 'screen-saver')
    captureWindow.setPosition(display.bounds.x, display.bounds.y, false)
    captureWindow.setBounds(captureBounds, false)
    captureWindow.setResizable(false)

    const loadStartedAt = performance.now()
    const loadPromise = captureWindow.loadFile(pagePath).then((result) => {
      performanceTiming.windowLoadMs = Math.round((performance.now() - loadStartedAt) * 100) / 100
      return result
    })
    captureWindow.on('closed', () => {
      performanceMonitor.record('capture.closed', performance.now() - performanceStartedAt, {
        ...captureDetails,
        rendererPid: performanceTiming.rendererPid ?? null
      })
      clearTimeout(captureWindow._renderTimeout)
      captureWindow._smartSelectContext?.session.dispose()
      captureWindow._smartSelectContext = null
      if (currentCaptureWindow === captureWindow) currentCaptureWindow = null
      const pinWindow = captureWindow._pendingPinWindow || captureWindow._editingPinWindow
      if (!pinWindow?._pendingRecognition || pinWindow._pinVisible) setImmediate(() => pinDomain?.bringPinToFront(pinWindow))
    })
    captureWindow._renderTimeout = setTimeout(() => {
      if (captureWindow.isDestroyed() || captureWindow._captureVisible) return
      const init = captureWindow._captureInit
      log('Capture render timeout:', init ? 'renderer-stalled' : 'initializing', JSON.stringify({
        expected: init?.captureBounds || null,
        window: captureWindow.getBounds(),
        content: captureWindow.getContentBounds()
      }))
      captureWindow.close()
    }, 8000)

    try {
      // 中间那项是 loadPromise 的结果（loadFile），本函数不用它，故留空位。
      const [capture, , cursorSnapshot] = await Promise.all([capturePromise, loadPromise, cursorPromise])
      if (captureWindow.isDestroyed()) return null
      const settings = getSettings()
      // P0-7-T7：每次截图都是新窗口，序号默认从 1 开始（显式下发）；
      // screenshot.keepSerialAcrossCaptures 打开时下发"上一张用掉的最后一个序号 + 1"，
      // 由渲染层在动作完成时回报（reportCaptureSerial），因此这里不再自增。
      const serialNumber = settings?.screenshot?.keepSerialAcrossCaptures === true ? captureSerialSeq : 1
      captureWindow._captureInit = {
        imageBuffer: capture.imageBuffer || Buffer.alloc(0),
        mode,
        autoAction: options.autoAction || '',
        source: options.source || 'region',
        displayBounds: display.bounds,
        captureBounds,
        // §3.2②: the Ctrl+A second level expands the selection to this union. Bounds
        // only - the capture image itself still covers just `captureBounds`, so the
        // renderer must not promise cross-display content (see desktopSelectionBounds).
        desktopBounds: desktopBounds(),
        imageBounds: options.imageBounds || null,
        scaleFactor: capture.scaleFactor,
        editPin: !!options.editPin,
        // Batch 1 (§6.5.4): the re-edit load payload. null means this session does not open a
        // document at all (plain screenshot / pin re-annotation / blank canvas), and the renderer
        // then keeps the original "new screenshot" semantics.
        documentEditor: options.documentEditor || null,
        // U02 / DEV-01: a pin re-annotation session carries the document-shaped snapshot
        // restored from the pin window (base image + source-pixel annotations + style).
        // Null for every other mode, including old flat pins.
        pinEditable: options.pinEditable || null,
        smartSelect: !!captureWindow._smartSelectContext,
        cursorPosition: (() => {
          const point = screen.getCursorScreenPoint()
          return { x: point.x - captureBounds.x, y: point.y - captureBounds.y }
        })(),
        // P0-7-T4：快捷保存 / 另存为调用方下发的保存模式；空值时渲染层回落到设置项。
        saveMode: options.saveMode || '',
        // B01: the window's one-shot "do not keep" default. The renderer ORs it with
        // "history is disabled globally" and never writes the value back to settings.
        skipHistory: inheritedSkipHistory,
        serialNumber,
        // P0-2（S9b）：截图带光标的合成载荷。开关关闭 / provider 不可用 / 查询失败都是 null，
        // 渲染层据此"一行都不画"，与旧版逐像素一致。physicalPoint 是**物理像素**，
        // 渲染层贴图前必须按 scaleFactor 换回 DIP（见 shared/cursor-geometry.js 头注释）。
        cursor: cursorSnapshot
          ? {
              png: cursorSnapshot.png,
              dataUrl: cursorSnapshot.dataUrl,
              width: cursorSnapshot.width,
              height: cursorSnapshot.height,
              hotspot: { x: cursorSnapshot.hotspot.x, y: cursorSnapshot.hotspot.y },
              physicalPoint: { x: cursorSnapshot.physicalPoint.x, y: cursorSnapshot.physicalPoint.y }
            }
          : null,
        settings
      }
      sendCaptureInit(captureWindow)
      return captureWindow
    } catch (error) {
      if (!captureWindow.isDestroyed()) captureWindow.close()
      throw error
    }
  }

  function ownsWindow(win) {
    return win != null && win === currentCaptureWindow
  }

  function getCurrentWindow() {
    return currentCaptureWindow
  }

  function isTaskActive() {
    return !!(currentCaptureWindow && !currentCaptureWindow.isDestroyed())
  }

  // Entry point for history "continue editing"; main.js only wires it. Every failure becomes a
  // structured return value, so the renderer no longer appears to do nothing when clicked
  // (design §10 C10 / §11.1, "failures must be visible").
  async function editHistoryDocument(item = {}) {
    if (!item?.filePath || !fs.existsSync(item.filePath)) return { ok: false, code: 'file-missing' }
    // Game mode: assertGameModeDisabled() throws, and the throw becomes a visible status instead
    // of a silent unhandled rejection.
    try {
      assertGameModeDisabled()
    } catch (error) {
      return { ok: false, code: 'game-mode', message: error?.message || String(error) }
    }
    try {
      const captureWindow = await createDocumentEditorWindow({
        documentId: String(item.documentId || item.id || ''),
        revisionId: item.revisionId || ''
      })
      return captureWindow ? { ok: true } : { ok: false, code: 'superseded' }
    } catch (error) {
      log('History document edit failed:', error?.message || String(error))
      return { ok: false, code: error?.code || 'edit-failed', message: error?.message || String(error) }
    }
  }

  function createCaptureController() {
    return {
      ready: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) return
        win._captureRendererReady = true
        sendCaptureInit(win)
      },
      renderReady: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        revealCaptureWindow(win)
        if (win?._captureInit) {
          const timing = win._performanceTiming
          if (timing) {
            timing.rendererPid = event.sender.getOSProcessId?.() || null
            const details = {
              ...timing.details,
              rendererPid: timing.rendererPid,
              captureMs: timing.captureMs,
              smartSelectMs: timing.smartSelectMs,
              windowLoadMs: timing.windowLoadMs
            }
            performanceMonitor.record('capture.interactive', performance.now() - timing.startedAt, details)
            performanceMonitor.snapshot('capture-interactive', details)
            win._performanceTiming = null
          }
          win._captureInit.imageBuffer = null
        }
      },
      renderError: (event, message) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) return
        log('Capture render failed:', message || 'image decode failed')
        win.close()
      },
      close: (event, payload = {}) => {
        // ✕ / Esc 关窗时也带着已落过的序号（P0-7-T7 精确接续）：落过就推进。
        reportCaptureSerial(payload)
        const win = BrowserWindow.fromWebContents(event.sender)
        win?.close()
      },
      // The single commit entry point (batch-0 contract §4 / §12) and the only write path for an
      // editable document. The renderer's payload carries just sessionId + requestId + intent +
      // the frozen snapshot and result image; captureDocumentService generates and validates
      // every document/asset id and path.
      commitDocument: async (event, payload = {}) => {
        const documentService = captureDocumentService()
        if (!documentService) return { ok: false, status: 'failed', code: 'unavailable', retryable: false }
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const skipHistory = resolveSkipHistory(captureWindow, payload)
        // B01: latch the one-shot on the window as well. The renderer sends the switch
        // with every commit, but a commit that arrives without it (a retry after the
        // toggle was re-rendered) must still belong to the same, skipped result.
        if (skipHistory && captureWindow) captureWindow._skipHistory = true
        const result = await documentService.commit(skipHistory ? { ...payload, skipHistory: true } : payload)
        // Broadcast after success (§6.5.5 step 6): a failed notification does not affect the
        // committed revision, and the client can still look the same result up by requestId.
        if (result?.ok && result.status === 'committed' && typeof mainWindowBroadcast === 'function') {
          try {
            mainWindowBroadcast({ documentId: result.documentId, revisionId: result.revisionId, changeType: 'committed' })
          } catch (error) {
            log('Capture commit broadcast failed:', error.message)
          }
        }
        return result
      },
      // Status lookup for a lost confirmation (§4.2): an expired request returns `expired` and is
      // never silently re-executed.
      commitStatus: (_event, payload = {}) => {
        const documentService = captureDocumentService()
        if (!documentService) return { ok: false, status: 'failed', code: 'unavailable' }
        return documentService.commitStatus(payload)
      },
      // Editor document load: fetch the editable content by document id, or an explicit
      // degradation signal (§6.5.7 / §10).
      loadDocument: (_event, payload = {}) => {
        const documentService = captureDocumentService()
        if (!documentService) return { ok: false, code: 'unavailable' }
        const documentId = String(payload?.documentId || '')
        if (!documentId) return { ok: false, code: 'deleted' }
        return documentService.loadDocument(documentId, payload?.revisionId)
      },
      startRegionRecording: async (event, { selectionBounds, serialNumber } = {}) => {
        // 录制/long 都会在算 meta 之前离开截图流程（渲染层提前 return），序号只能随调用载荷回来。
        reportCaptureSerial({ serialNumber })
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        if (!captureWindow || captureWindow !== currentCaptureWindow || captureWindow.isDestroyed()) {
          throw new Error('无效的截图窗口')
        }
        const bounds = {
          x: Number(selectionBounds?.x),
          y: Number(selectionBounds?.y),
          width: Number(selectionBounds?.width),
          height: Number(selectionBounds?.height)
        }
        if (!Object.values(bounds).every(Number.isFinite)) throw new Error('录制区域无效')
        const display = screen.getDisplayMatching(bounds)
        await createRecordWindow({ display, selectionBounds: bounds })
        if (!captureWindow.isDestroyed()) captureWindow.close()
        return true
      },
      startLong: (event, payload = {}) => {
        reportCaptureSerial(payload)
        return createLongCaptureFromSelection(BrowserWindow.fromWebContents(event.sender), payload)
      },
      smartSelect: async (event, point = {}) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        const context = win?._smartSelectContext
        if (!context || win.isDestroyed()) return []
        const localX = Math.max(0, Math.min(context.captureBounds.width, Number(point.x) || 0))
        const localY = Math.max(0, Math.min(context.captureBounds.height, Number(point.y) || 0))
        const physicalX = context.physicalBounds.x + localX * context.physicalBounds.width / context.captureBounds.width
        const physicalY = context.physicalBounds.y + localY * context.physicalBounds.height / context.captureBounds.height
        let rects = await context.session.query(physicalX, physicalY)
        if (!rects.length) rects = context.session.findWindowAt(physicalX, physicalY)
        const candidates = convertSmartSelectRects(rects, context)
        return candidates.length
          ? candidates
          : [{ x: 0, y: 0, w: context.captureBounds.width, h: context.captureBounds.height }]
      },
      copy: async (_event, { imageBuffer, dataUrl, meta } = {}) => {
        // 复制同样消耗已落的序号（Enter 走的就是这条路径）—— 与 save/pin/... 同一回报口径。
        reportCaptureSerial(meta)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        if (!buffer.length) throw new Error('截图图片数据为空')
        const image = nativeImage.createFromBuffer(buffer)
        const captureWindow = BrowserWindow.fromWebContents(_event.sender)
        const skipHistory = resolveSkipHistory(captureWindow, meta)
        // B01 (plan items 05/12): the private publication is awaited and its receipt is
        // reported as-is. The history/auto-save decisions below are computed from the
        // GLOBAL switch and THIS capture's explicit skip separately - a disabled global
        // history must not be mistaken for "the user skipped this copy".
        const publication = await writeImageToClipboard(image, { skipHistory })
        // P0-7B（§17.6）：保存落点可能是记忆目录（screenshot.lastSaveDirectory），
        // 因此"配置了固定目录或已有记忆目录"任一成立即可自动保存。
        const settings = getSettings()
        const plan = capturePlan('copy', skipHistory, {
          autoSaveOnCopy: settings?.screenshot?.autoSaveOnCopy === true,
          hasSaveDirectory: !!resolveSaveDirectory(settings)
        })
        // The history entry keeps its decoded image (saves one re-decode on the click path).
        scheduleHistoryWrite(captureWindow, plan, buffer, { ...meta, image })
        if (plan.autoSaveFile && settings.screenshot.autoSaveOnCopy && resolveSaveDirectory(settings)) {
          scheduleAutoSave(captureWindow, buffer)
        }
        if (!publication.ok) {
          // No plain fallback: the user asked for a private copy and it did not happen.
          return {
            ok: false,
            code: publication.code || 'private-publish-failed',
            clipboard: 'none',
            history: plan.historyRecords === 1 ? 'recorded' : 'skipped',
            exclusion: 'failed'
          }
        }
        return skipHistory || publication.private
          ? {
              ok: true,
              clipboard: 'windows',
              history: plan.historyRecords === 1 ? 'recorded' : 'skipped',
              exclusion: publication.status
            }
          : null
      },
      save: (event, { imageBuffer, dataUrl, meta, fast } = {}) => {
        reportCaptureSerial(meta)
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        const skipHistory = resolveSkipHistory(captureWindow, meta)
        // B01: an explicit save is the user's own file and is ALWAYS written; only the
        // history row is suppressed. The plan is frozen here, before the window closes,
        // so nothing that runs later can change this result's decision.
        const plan = capturePlan('save', skipHistory)
        if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        setImmediate(async () => {
          try {
            if (!buffer.length) throw new Error('截图图片数据为空')
            const filePath = await saveImageBuffer(buffer, { fast: !!fast })
            if (filePath) scheduleHistoryWrite(captureWindow, plan, buffer, meta)
            // B01: with no history row there is nothing to find the file by later, so a
            // skipped explicit save reports the actual path it just wrote.
            if (filePath && skipHistory) announceSavedPath(filePath)
            // A plain screenshot closes its window by design (plan §4.1 keeps the original
            // close-on-save behaviour and must not trap the user in the overlay), so this receipt
            // is not for an in-window bar - it is what the tray's "recent export" reads.
            registerExportResult(filePath, 'png', 'capture-save', event)
          } catch (error) {
            log('Capture save failed:', error.message)
            dialog.showErrorBox('保存截图失败', error.message || String(error))
          }
        })
      },
      pin: async (event, { imageBuffer, dataUrl, meta, copy, retry } = {}) => {
        reportCaptureSerial(meta)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        if (!buffer.length) throw new Error('截图图片数据为空')
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const skipHistory = resolveSkipHistory(captureWindow, meta)
        // U02 / DEV-01: strip the editable snapshot from the meta ONCE, before the retry
        // receipt, the history write or the pin window copies meta anywhere.
        const editableSnapshot = pullPinEditable(meta, skipHistory)
        // B03: a retry never re-attempts an output that already succeeded, and never
        // writes a second history record (see retryPinCopy).
        if (retry === 'pin' || retry === 'copy') {
          return retryPinCopy(captureWindow, retry, { event, buffer, meta: { ...meta, skipHistory }, editableSnapshot })
        }
        // An unknown retry selector is a stale caller, never a new confirmation: firing
        // the legacy pin path here would create a second pin for a request that asked
        // only to repair an earlier one.
        if (retry) return stalePinCopyReceipt()
        const plan = capturePlan(copy === true ? 'pin-copy' : 'pin', skipHistory)
        // The shipped single-output path, unchanged: pin only, one history record,
        // and a failure still throws to the renderer's alert.
        if (copy !== true) {
          const created = pinDomain.pinFromCapture(event, buffer, meta, '', editableSnapshot ? { editableSnapshot } : {})
          if (created?.pinWindow) {
            created.pinWindow._skipHistory = skipHistory
            // D05 (18): the flag travels in the retained metadata, so a recovered pin keeps it.
            if (created.pinWindow._pinData) created.pinWindow._pinData.meta.skipHistory = skipHistory
          }
          scheduleHistoryWrite(captureWindow, plan, buffer, meta)
          return null
        }
        return await pinAndCopyOnce(event, captureWindow, buffer, meta, editableSnapshot)
      },
      pinReannotate: (event, { imageBuffer, dataUrl, meta, action } = {}) => {
        reportCaptureSerial(meta)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        const sender = BrowserWindow.fromWebContents(event.sender)
        const skipHistory = resolveSkipHistory(sender, meta)
        const plan = capturePlan('pin-reannotate', skipHistory)
        // U02 / DEV-01: same in-memory snapshot bridge as capture:pin, still on the
        // existing channel and still stripped before the history write below.
        const editableSnapshot = pullPinEditable(meta, skipHistory)
        const created = editableSnapshot
          ? pinDomain.pinFromCapture(event, buffer, meta, action, { editableSnapshot })
          : pinDomain.pinFromCapture(event, buffer, meta, action)
        const captureWindow = created?.captureWindow
        // B01: this is the same result, so the pin inherits the switch for its editor.
        if (created?.pinWindow) {
          created.pinWindow._skipHistory = skipHistory
          // D05 (18): the flag travels in the retained metadata, so a recovered pin keeps it.
          if (created.pinWindow._pinData) created.pinWindow._pinData.meta.skipHistory = skipHistory
        }
        setImmediate(() => {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        })
        // The history label stays 'pin' (the shipped entry shape); the PLAN still keeps the
        // one-time claim keyed to this action, so a repeated re-annotation cannot add a row.
        scheduleHistoryWrite(sender, { ...plan, action: 'pin' }, buffer, meta)
        return null
      },
      openRecognition: (event, { type, imageBuffer, dataUrl, meta } = {}) => {
        reportCaptureSerial(meta)
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        const skipHistory = resolveSkipHistory(captureWindow, meta)
        // B01: recognition still opens (it is the explicit output); only its history
        // row is suppressed. Its own temporary resources keep the existing owner (the
        // recognition window), so a skipped capture leaves nothing extra behind.
        const plan = capturePlan(type, skipHistory)
        createRecognitionWindow(type, bufferToDataUrl(buffer), { scaleFactor: meta?.scaleFactor })
        setImmediate(() => {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        })
        if (plan.historyRecords !== 1) return { ok: true, history: 'skipped' }
        return persistHistoryEntry(buffer, { ...meta, action: type })
      },
      recordHistory: (event, { imageBuffer, dataUrl, meta } = {}) => {
        reportCaptureSerial(meta)
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const skipHistory = resolveSkipHistory(captureWindow, meta)
        const plan = capturePlan('record-history', skipHistory)
        if (plan.historyRecords !== 1) return { ok: true, history: 'skipped' }
        return persistHistoryEntry(imageBuffer ?? dataUrl, meta)
      },
      exportPdf: async (event, { imageBuffer, dataUrl, meta, mode } = {}) => {
        reportCaptureSerial(meta)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        if (!buffer.length) throw new Error('截图图片数据为空')
        // 以 PNG 头部为准：meta.width/height 属于导出坐标系，PNG 才是真正要打印的像素。
        const pngSize = readPngSize(buffer)
        const pxW = pngSize?.width || Number(meta?.width)
        const pxH = pngSize?.height || Number(meta?.height)
        if (!pxW || !pxH) throw new Error('导出 PDF 需要 PNG 截图数据或有效的图片尺寸')
        const parentWindow = BrowserWindow.fromWebContents(event.sender)
        const pdfBuffer = await exportPdfBuffer(buffer, {
          createPrintWindow: createLocalWindow,
          rootDirectory,
          pxW,
          pxH,
          dataUrl: typeof dataUrl === 'string' && dataUrl.startsWith('data:') ? dataUrl : undefined,
          // 截图是物理像素：96 × scaleFactor 还原 1:1 的 CSS 尺寸，避免 DPI 尺寸偏差（§4.3 风险②）。
          dpi: DEFAULT_IMAGE_DPI * Math.max(1, Number(meta?.scaleFactor) || 1),
          mode,
          printToPdf,
          log
        })
        const savedPdfPath = await savePdfBuffer(pdfBuffer, {
          parentWindow: parentWindow && !parentWindow.isDestroyed() ? parentWindow : null,
          dialog,
          fs,
          // §17.5 交 S9a 决定：PDF 默认名跟随 screenshot.nameTemplate（空模板 = 旧格式，
          // 与截图保存完全同源）。重名仍由保存对话框兜底，与改动前一致。
          makeName: (prefix, ext) => makeCaptureName(prefix, ext, { template: getSettings()?.screenshot?.nameTemplate })
        })
        // Feature A (plan §4.2): register the file that was just written so the result bar can
        // open/copy/reveal it by resultId. A cancelled dialog returns null from savePdfBuffer, and
        // registering null is a no-op -> no bar appears for a cancel.
        return registerExportResult(savedPdfPath, 'pdf', 'capture-pdf', event)
      }
    }
  }

  return {
    createCaptureWindow,
    createDocumentEditorWindow,
    editHistoryDocument,
    // N02: main/ipc/index.js attaches the background OCR indexer here after it builds it.
    attachHistoryOcrIndexer,
    sendCaptureInit,
    revealCaptureWindow,
    createSmartSelectSession,
    convertSmartSelectRects,
    createCaptureController,
    getDisplayCapture,
    captureFocusedWindow,
    ownsWindow,
    getCurrentWindow,
    isTaskActive
  }
}

module.exports = {
  createCaptureDomain,
  // B03 pure contracts (no Electron): the two-output plan behind one confirmation.
  PIN_COPY_OUTPUTS,
  planPinCopyAttempts,
  summarizePinCopyOutputs,
  // B01 pure contracts (no Electron): the one-shot "do not keep this capture" write
  // plan and the clipboard exclusion formats it asks the native publication for.
  CAPTURE_WRITE_ACTIONS,
  CLIPBOARD_HISTORY_EXCLUSION_FORMATS,
  normalizeCaptureWriteAction,
  planCaptureWrites,
  planClipboardPublish
}
