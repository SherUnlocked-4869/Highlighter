// B06: the same capability table the main process checks before composing.
const { capabilities: outputCapabilities } = window.longCaptureLimits

const video = document.getElementById('source')
const preview = document.getElementById('preview')
const previewContext = preview.getContext('2d')
const statusElement = document.getElementById('status')
const sizeElement = document.getElementById('size')
const stripsElement = document.getElementById('strips')
const confidenceElement = document.getElementById('confidence')
const emptyPreview = document.getElementById('emptyPreview')
const toggleButton = document.getElementById('toggle')
const adjustSelectionButton = document.getElementById('adjustSelection')
const adjustSelectionLabel = document.getElementById('adjustSelectionLabel')
const trimStartInput = document.getElementById('trimStart')
const trimEndInput = document.getElementById('trimEnd')
const directionButtons = [...document.querySelectorAll('[data-axis]')]
const actionButtons = [...document.querySelectorAll('.actions button')]
const WORKER_TIMEOUT_MS = 5000
const MIN_FRAME_PERIOD_MS = Math.ceil(1000 / 12) // Match the stream's maximum frame rate.
const MAX_FRAME_PERIOD_MS = 1000
const FRAME_COST_HEADROOM = 1.25

// P0-1-T5 (S12): `shared/i18n.js` is a classic script, so its `t`, `setLanguage`
// and `applyTranslations` bindings are already visible here. They must NOT be
// re-declared (the runtime's top-level `const`s share this script's global
// lexical scope, so destructuring them from `window` throws).

let initData = null
let stream = null
let worker = null
let workerError = null
let axis = 'vertical'
let capturing = false
let busy = false
let selectionEditing = false
let timer = null
let averageFrameCost = 0
let requestId = 0
let total = { width: 0, height: 0, strips: 0, trimStart: 0, trimEnd: 0 }
const workerRequests = new Map()
const cropCanvas = document.createElement('canvas')
const cropContext = cropCanvas.getContext('2d', { willReadFrequently: true })
const analysisCanvas = document.createElement('canvas')
const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true })

// U02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 4.2-1): the preview
// is a scaled FOOTPRINT of the strip list, never a running rescale of the previous canvas.
// The old code multiplied the whole preview by 1000/oldHeight once it passed 1200px, so a
// long capture was resampled a dozen times (blurred top half) and the vertical mapping became
// non-linear, which desynced the percentage trim line from the real cut. Each strip is now
// resampled exactly once into a thumbnail; the preview is composed from those at one uniform
// scale, so pixel y / preview height always equals raw y / raw height (up to 1px rounding).
const PREVIEW_THUMB_EDGE = 160
// Chromium refuses canvas dimensions above 32767 and huge canvases are pointless at this size;
// a very long capture keeps the same linear mapping by shrinking the thumbnail edge instead.
const PREVIEW_MAX_EDGE = 16384
let previewSegments = []
let previewScale = 0
let previewCrossLength = 0

function rejectWorkerRequests(error) {
  for (const request of workerRequests.values()) {
    clearTimeout(request.timeout)
    request.reject(error)
  }
  workerRequests.clear()
}

function failWorker(message) {
  const error = new Error(message || t('long-capture.error.matcher-unavailable'))
  workerError = error
  rejectWorkerRequests(error)
  setCapturing(false)
  toggleButton.disabled = true
  setStatus(error.message)
  updateControls()
}

// P0-1-T5 (S12) hot-switch: `#status` carries a static `data-i18n` marker so the
// first frame is translated by applyTranslations(), but the live status is
// written by this script. Keeping it as state (a key + params, or a raw
// diagnostic) instead of a finished sentence is what lets the broadcast handler
// re-render it after applyTranslations() has clobbered the element back to the
// static "preparing" copy. The confidence readout is stored too, so the
// re-render keeps it (it is language-neutral, but it belongs to the same status).
let statusState = { key: 'long-capture.status.preparing' }
let statusConfidence = null

function renderStatusText() {
  statusElement.textContent = Object.hasOwn(statusState, 'raw')
    ? statusState.raw
    : t(statusState.key, statusState.params)
  if (Number.isFinite(statusConfidence)) confidenceElement.textContent = `${Math.round(statusConfidence * 100)}%`
}

// Translatable status: store the key (+ interpolation params) so a language
// switch re-renders it, instead of freezing the sentence of the moment.
function setStatusKey(key, params, confidence) {
  statusState = { key, params }
  statusConfidence = confidence
  renderStatusText()
}

// Raw diagnostic (worker/API error text): decision D6 keeps these verbatim, so
// they are not re-translated — only kept on screen across a language switch.
function setStatus(message, confidence) {
  statusState = { raw: message }
  statusConfidence = confidence
  renderStatusText()
}

function updateControls() {
  document.body.classList.toggle('capturing', capturing)
  toggleButton.textContent = t(capturing
    ? 'long-capture.action.pause'
    : (total.strips ? 'long-capture.action.resume' : 'long-capture.action.start'))
  directionButtons.forEach((button) => { button.disabled = capturing || busy || total.strips > 0 })
  adjustSelectionButton.disabled = capturing || busy
  adjustSelectionButton.classList.toggle('active', selectionEditing)
  adjustSelectionLabel.textContent = t(selectionEditing ? 'long-capture.selection.done' : 'long-capture.selection.short')
  trimStartInput.disabled = !total.strips || capturing || busy
  trimEndInput.disabled = !total.strips || capturing || busy
  // B06: copy/pin are disabled (with the reason in the tooltip) as soon as the composed size
  // passes the edge or pixel ceiling, so the user learns it while framing the capture rather
  // than after a long composition.
  const output = outputCapabilities(total)
  actionButtons.forEach((button) => {
    const blocked = (button.id === 'copy' || button.id === 'pin') && !output[button.id === 'copy' ? 'copy' : 'pin']
    button.disabled = !total.strips || busy || blocked
    if (blocked) {
      button.title = t('long-capture.tip.save-only', { edge: output.edge, maxEdge: output.limits.maxEdge, maxPixels: output.limits.maxPixels })
      button.setAttribute('aria-disabled', 'true')
    } else {
      button.removeAttribute('aria-disabled')
      const key = button.dataset.i18nTitle || button.getAttribute('data-i18n-title')
      if (key) button.title = t(key)
    }
  })
}

function updateTrimPreview() {
  // The preview is a linear thumbnail of the whole untrimmed extent (see appendPreview), so a
  // percentage clip here really lands on the same raw pixel the main-process trim cuts. The
  // old canvas was rescaled non-linearly, which is why this line used to drift.
  const rawLength = (axis === 'vertical' ? total.height : total.width) + (total.trimStart || 0) + (total.trimEnd || 0)
  if (!rawLength) { preview.style.clipPath = ''; return }
  const start = Math.min(49.5, (total.trimStart || 0) / rawLength * 100)
  const end = Math.min(49.5, (total.trimEnd || 0) / rawLength * 100)
  preview.style.clipPath = axis === 'vertical'
    ? `inset(${start}% 0 ${end}% 0)`
    : `inset(0 ${end}% 0 ${start}%)`
}

function workerFrame(rgba, width, height) {
  return new Promise((resolve, reject) => {
    if (workerError) {
      reject(workerError)
      return
    }
    if (!worker) {
      reject(new Error(t('long-capture.error.matcher-not-ready')))
      return
    }
    const id = ++requestId
    const timeout = setTimeout(() => {
      workerRequests.delete(id)
      reject(new Error(t('long-capture.error.match-timeout')))
    }, WORKER_TIMEOUT_MS)
    workerRequests.set(id, { reject, resolve, timeout })
    try {
      worker.postMessage({ type: 'frame', id, rgba: rgba.buffer, width, height, axis }, [rgba.buffer])
    } catch (error) {
      clearTimeout(timeout)
      workerRequests.delete(id)
      reject(error)
    }
  })
}

function getCropRect() {
  const display = initData.displayBounds
  const selection = initData.selectionBounds
  const scaleX = video.videoWidth / display.width
  const scaleY = video.videoHeight / display.height
  return {
    x: Math.max(0, Math.round((selection.x - display.x) * scaleX)),
    y: Math.max(0, Math.round((selection.y - display.y) * scaleY)),
    width: Math.max(1, Math.round(selection.width * scaleX)),
    height: Math.max(1, Math.round(selection.height * scaleY))
  }
}

function drawCurrentFrame() {
  const crop = getCropRect()
  crop.width = Math.min(crop.width, video.videoWidth - crop.x)
  crop.height = Math.min(crop.height, video.videoHeight - crop.y)
  if (crop.width <= 0 || crop.height <= 0 || (total.strips &&
    (cropCanvas.width !== crop.width || cropCanvas.height !== crop.height))) {
    throw new Error(t('long-capture.error.frame-size-changed'))
  }
  if (cropCanvas.width !== crop.width) cropCanvas.width = crop.width
  if (cropCanvas.height !== crop.height) cropCanvas.height = crop.height
  cropContext.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
  const analysisWidth = axis === 'vertical' ? Math.min(96, crop.width) : crop.width
  const analysisHeight = axis === 'horizontal' ? Math.min(96, crop.height) : crop.height
  if (analysisCanvas.width !== analysisWidth) analysisCanvas.width = analysisWidth
  if (analysisCanvas.height !== analysisHeight) analysisCanvas.height = analysisHeight
  analysisContext.drawImage(cropCanvas, 0, 0, analysisCanvas.width, analysisCanvas.height)
  return analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height)
}

// U02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 4.2-2): a frame that
// scrolled by `shift` pixels exposes that much new content at the leading/trailing edge, but
// the edge rows may belong to a fixed top/bottom (or left/right) bar. `sticky` comes from
// matcher.detectStickyBands via the worker result; this helper turns it into the source rect
// that contains ONLY the scrolled content, falling back to the shipped full-edge cut when the
// bands are absent or would not leave room for the whole increment.
function normalizeStickyBand(value, length) {
  const amount = Math.max(0, Math.round(Number(value) || 0))
  return Math.min(amount, Math.max(0, length - 1))
}

function stripCutRect(shift, initialized, sticky) {
  if (initialized) return { x: 0, y: 0, width: cropCanvas.width, height: cropCanvas.height }
  const horizontal = axis === 'horizontal'
  const length = horizontal ? cropCanvas.width : cropCanvas.height
  const cross = horizontal ? cropCanvas.height : cropCanvas.width
  const wanted = Math.min(length - 1, Math.abs(Number(shift) || 0))
  if (!wanted) return { x: 0, y: 0, width: cropCanvas.width, height: cropCanvas.height }
  const start = normalizeStickyBand(sticky?.start, length)
  const end = normalizeStickyBand(sticky?.end, length)
  // Only subtract the bands when the remaining content range can still supply the whole
  // increment. A pathological band pair must never shorten the strip: the stitched extent
  // and the matcher's position bookkeeping assume the strip is the full new-content length.
  const useSticky = start + end > 0 && length - 1 - start - end >= wanted
  const leading = Number(shift) < 0
  const sourceAlong = leading
    ? (useSticky ? start : 0)
    : (useSticky ? length - end - wanted : length - wanted)
  if (horizontal) return { x: sourceAlong, y: 0, width: wanted, height: cross }
  return { x: 0, y: sourceAlong, width: cross, height: wanted }
}

function makeStripCanvas(shift, initialized, sticky) {
  const rect = stripCutRect(shift, initialized, sticky)
  const strip = document.createElement('canvas')
  strip.width = rect.width
  strip.height = rect.height
  strip.getContext('2d').drawImage(cropCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  return strip
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t('long-capture.error.strip-encode-failed'))), 'image/png'))
}

// Uniform preview scale for the stitched extent: the cross axis is thumbnailed to
// PREVIEW_THUMB_EDGE px until the along axis would outgrow PREVIEW_MAX_EDGE, at which point
// both axes shrink together so the mapping stays linear in both directions.
function previewScaleFor(rawLength, crossLength) {
  const cross = Math.max(1, Number(crossLength) || 0)
  const length = Math.max(0, Number(rawLength) || 0)
  if (!length) return 0
  return Math.min(PREVIEW_THUMB_EDGE / cross, PREVIEW_MAX_EDGE / length)
}

function createPreviewThumb(strip, scale) {
  const thumb = document.createElement('canvas')
  thumb.width = Math.max(1, Math.round(strip.width * scale))
  thumb.height = Math.max(1, Math.round(strip.height * scale))
  thumb.getContext('2d').drawImage(strip, 0, 0, strip.width, strip.height, 0, 0, thumb.width, thumb.height)
  return thumb
}

// Re-thumbnails an already cached thumbnail. Only the PREVIEW_MAX_EDGE cap path reaches this,
// so the normal capture keeps the "each strip is resampled exactly once" property.
function rescalePreviewThumb(segment, scale) {
  const thumb = document.createElement('canvas')
  thumb.width = Math.max(1, Math.round(segment.rawWidth * scale))
  thumb.height = Math.max(1, Math.round(segment.rawHeight * scale))
  thumb.getContext('2d').drawImage(segment.canvas, 0, 0, segment.canvas.width, segment.canvas.height, 0, 0, thumb.width, thumb.height)
  return thumb
}

function renderPreview() {
  if (!previewSegments.length || !previewScale) return
  const rawLength = previewSegments.reduce((sum, segment) => sum + segment.along, 0)
  const crossSize = Math.max(1, Math.round(previewCrossLength * previewScale))
  const alongSize = Math.max(1, Math.round(rawLength * previewScale))
  // Assigning the dimensions always resets the bitmap, so the loop below is a full redraw
  // from the cached thumbnails - the preview itself is never used as a source.
  if (axis === 'vertical') {
    preview.width = crossSize
    preview.height = alongSize
  } else {
    preview.width = alongSize
    preview.height = crossSize
  }
  let offset = 0
  for (const segment of previewSegments) {
    // Snapping both slot boundaries keeps the mapping linear; per-strip rounding would drift.
    const start = Math.round(offset * previewScale)
    const end = Math.round((offset + segment.along) * previewScale)
    const length = Math.max(1, end - start)
    if (axis === 'vertical') {
      previewContext.drawImage(segment.canvas, 0, 0, segment.canvas.width, segment.canvas.height, 0, start, crossSize, length)
    } else {
      previewContext.drawImage(segment.canvas, 0, 0, segment.canvas.width, segment.canvas.height, start, 0, length, crossSize)
    }
    offset += segment.along
  }
}

function appendPreview(strip, position, firstStrip) {
  const rawWidth = Math.max(1, strip.width)
  const rawHeight = Math.max(1, strip.height)
  if (firstStrip) {
    previewSegments = []
    previewScale = 0
    previewCrossLength = axis === 'vertical' ? rawWidth : rawHeight
  }
  const along = axis === 'vertical' ? rawHeight : rawWidth
  const cross = axis === 'vertical' ? rawWidth : rawHeight
  if (!previewCrossLength) previewCrossLength = cross
  const rawLength = previewSegments.reduce((sum, segment) => sum + segment.along, 0) + along
  const scale = previewScaleFor(rawLength, previewCrossLength)
  if (!scale) return
  if (!previewScale || Math.abs(scale - previewScale) > 1e-9) {
    previewSegments = previewSegments.map((segment) => ({ ...segment, canvas: rescalePreviewThumb(segment, scale) }))
    previewScale = scale
  }
  const segment = { canvas: createPreviewThumb(strip, scale), along, cross, rawWidth, rawHeight }
  if (position === 'prepend') previewSegments.unshift(segment)
  else previewSegments.push(segment)
  renderPreview()
  emptyPreview.hidden = true
}

async function uploadStrip(strip, position, frameId) {
  const blob = await canvasBlob(strip)
  const arrayBuffer = await blob.arrayBuffer()
  const next = await window.longCaptureAPI.addStrip(arrayBuffer, {
    width: strip.width,
    height: strip.height,
    position,
    axis
  })
  // Only advance the matching reference after the main process stores the strip.
  worker.postMessage({ type: 'commit', id: frameId })
  const firstStrip = !total.strips
  total = next
  appendPreview(strip, position, firstStrip)
  sizeElement.textContent = `${total.width} × ${total.height}`
  stripsElement.textContent = t('long-capture.status.strips', { count: total.strips })
  const outputLength = axis === 'vertical' ? total.height : total.width
  trimStartInput.max = String(Math.max(0, outputLength + (total.trimStart || 0) + (total.trimEnd || 0) - 1))
  trimEndInput.max = trimStartInput.max
  updateTrimPreview()
  updateControls()
}

function scheduleFrame(delay) {
  if (!capturing || busy || timer !== null) return
  timer = setTimeout(() => {
    timer = null
    captureFrame()
  }, delay)
}

async function captureFrame() {
  if (busy || !capturing) return
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    scheduleFrame(MIN_FRAME_PERIOD_MS)
    return
  }
  busy = true
  const started = performance.now()
  try {
    const imageData = drawCurrentFrame()
    const result = await workerFrame(imageData.data, imageData.width, imageData.height)
    let statusKey
    if (result.status === 'initialized') {
      await uploadStrip(makeStripCanvas(0, true), 'append', result.id)
      statusKey = 'long-capture.status.initial-recorded'
    } else if (result.status === 'matched') {
      if (result.extension) {
        const strip = makeStripCanvas(result.extension, false, result.sticky)
        await uploadStrip(strip, result.extension > 0 ? 'append' : 'prepend', result.id)
        statusKey = 'long-capture.status.matched'
      } else {
        worker.postMessage({ type: 'commit', id: result.id })
        statusKey = 'long-capture.status.already-captured'
      }
    } else if (result.status === 'still') {
      statusKey = 'long-capture.status.waiting-scroll'
    } else if (result.status === 'size-changed') {
      throw new Error(t('long-capture.error.frame-size-changed'))
    } else {
      statusKey = 'long-capture.status.no-match'
    }
    if (capturing) setStatusKey(statusKey, undefined, result.status === 'initialized' ? 1 : result.confidence)
  } catch (error) {
    setCapturing(false)
    setStatus(error.message || String(error))
  } finally {
    busy = false
    updateControls()
    // One frame at a time, including matching and writing. Leave headroom for
    // the UI and recover gradually after a slow frame (Snow Shot cadence).
    const cost = performance.now() - started
    averageFrameCost = averageFrameCost ? averageFrameCost * 0.75 + cost * 0.25 : cost
    const period = Math.min(MAX_FRAME_PERIOD_MS,
      Math.max(MIN_FRAME_PERIOD_MS, Math.max(cost, averageFrameCost) * FRAME_COST_HEADROOM))
    scheduleFrame(Math.max(0, period - cost))
  }
}

function setCapturing(active) {
  capturing = !!active
  clearTimeout(timer)
  timer = null
  window.longCaptureAPI.setOverlayActive(capturing)
  if (capturing) {
    averageFrameCost = 0
    setStatusKey(total.strips ? 'long-capture.status.capturing-continue' : 'long-capture.status.capturing-initial')
    scheduleFrame(0)
  } else setStatusKey('long-capture.status.paused')
  updateControls()
}

async function toggleSelectionEditing() {
  if (busy) return
  if (capturing) setCapturing(false)
  try {
    selectionEditing = !selectionEditing
    await window.longCaptureAPI.setSelectionEditing(selectionEditing, axis, total.strips > 0)
    setStatusKey(selectionEditing
      ? (total.strips ? 'long-capture.status.drag-along-axis' : 'long-capture.status.move-or-resize')
      : 'long-capture.status.selection-updated')
  } catch (error) {
    selectionEditing = false
    setStatus(error.message || String(error))
  }
  updateControls()
}

async function applyTrim() {
  if (!total.strips || capturing || busy) return
  busy = true
  updateControls()
  try {
    total = await window.longCaptureAPI.setTrim(trimStartInput.value, trimEndInput.value)
    trimStartInput.value = String(total.trimStart || 0)
    trimEndInput.value = String(total.trimEnd || 0)
    sizeElement.textContent = `${total.width} × ${total.height}`
    updateTrimPreview()
    setStatusKey('long-capture.status.trim-updated')
  } catch (error) {
    trimStartInput.value = String(total.trimStart || 0)
    trimEndInput.value = String(total.trimEnd || 0)
    setStatus(error.message || String(error))
  } finally {
    busy = false
    updateControls()
  }
}

async function finish(action, fast = false) {
  if (!total.strips || busy) return
  if (selectionEditing) await toggleSelectionEditing()
  setCapturing(false)
  busy = true
  updateControls()
  setStatusKey(action === 'copy'
    ? 'long-capture.status.copying'
    : (action === 'pin' ? 'long-capture.status.pinning' : 'long-capture.status.generating'))
  try {
    const result = await window.longCaptureAPI.finish(action, fast)
    if (result?.canceled) setStatusKey('long-capture.status.save-canceled')
    else if (result?.code === 'long-capture-too-large') {
      // B06: the main process refused before composing. Point the user at the one action that
      // still works instead of leaving a generic error in the status line.
      setStatusKey('long-capture.status.save-only', { width: result.width, height: result.height })
      const saveButton = document.getElementById('save')
      if (saveButton && !saveButton.disabled) saveButton.focus({ preventScroll: true })
      busy = false
      updateControls()
      return
    } else if (result?.savedPath) {
      setStatusKey('long-capture.status.saved', { path: result.savedPath })
    }
  } catch (error) {
    busy = false
    setStatus(error.message || String(error))
    updateControls()
  }
}

async function initialize(data) {
  initData = data
  axis = data.settings?.screenshot?.longCaptureDirection === 'horizontal' ? 'horizontal' : 'vertical'
  directionButtons.forEach((button) => button.classList.toggle('active', button.dataset.axis === axis))
  document.documentElement.style.setProperty('--primary', data.settings?.mainColor || '#e5a44c')
  worker = new Worker('matcher-worker.js')
  worker.onmessage = (event) => {
    const request = workerRequests.get(event.data.id)
    if (!request) return
    workerRequests.delete(event.data.id)
    clearTimeout(request.timeout)
    request.resolve(event.data)
  }
  worker.onerror = (event) => {
    event.preventDefault()
    failWorker(event.message || t('long-capture.error.matcher-start-failed'))
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: data.sourceId, minFrameRate: 8, maxFrameRate: 12 } }
    })
    video.srcObject = stream
    await video.play()
    if (workerError) setStatus(workerError.message)
    else setStatusKey('long-capture.status.ready')
  } catch (error) {
    setStatusKey('long-capture.status.capture-failed', { detail: error.message })
    toggleButton.disabled = true
  }
  updateControls()
}

directionButtons.forEach((button) => button.onclick = () => {
  if (capturing || busy || total.strips) return
  axis = button.dataset.axis
  directionButtons.forEach((item) => item.classList.toggle('active', item === button))
  worker?.postMessage({ type: 'reset' })
})
toggleButton.onclick = async () => {
  if (!capturing && (busy || workerError || !stream)) return
  if (selectionEditing) await toggleSelectionEditing()
  setCapturing(!capturing)
}
adjustSelectionButton.onclick = toggleSelectionEditing
trimStartInput.onchange = applyTrim
trimEndInput.onchange = applyTrim
document.getElementById('copy').onclick = () => finish('copy')
document.getElementById('save').onclick = () => finish('save')
document.getElementById('fastSave').onclick = () => finish('save', true)
document.getElementById('pin').onclick = () => finish('pin')
document.getElementById('close').onclick = () => window.longCaptureAPI.close()
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.longCaptureAPI.close()
  if (event.code === 'Space') { event.preventDefault(); toggleButton.click() }
  if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); finish('save') }
  if (event.key === 'Enter') finish('copy')
})
addEventListener('beforeunload', () => {
  capturing = false
  clearTimeout(timer)
  rejectWorkerRequests(new Error(t('long-capture.error.window-closed')))
  stream?.getTracks().forEach((track) => track.stop())
  worker?.terminate()
})

// P0-1-T2/T5: the initial pass translates the markup; the broadcast subscription
// re-renders the dynamic labels (status, strip count, buttons) in the new language.
// The strip counter is parameterised, so it is rendered by the script rather than
// by a data-i18n attribute; `#status` keeps its data-i18n marker on purpose —
// applyTranslations() restores the static copy first and renderStatusText() then
// puts the live status back, re-resolved from the stored key.
applyTranslations()
renderStatusText()
stripsElement.textContent = t('long-capture.status.strips', { count: total.strips })
window.longCaptureAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
  renderStatusText()
  stripsElement.textContent = t('long-capture.status.strips', { count: total.strips })
  updateControls()
})
window.longCaptureAPI.onInit(initialize)
window.longCaptureAPI.onSelectionUpdated((bounds) => {
  if (!initData || !bounds) return
  initData.selectionBounds = bounds
  setStatusKey('long-capture.status.selection-area-updated')
})
window.longCaptureAPI.ready()
