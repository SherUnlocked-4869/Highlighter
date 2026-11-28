'use strict'

// ---------------------------------------------------------------------------
// N05 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.5):
// pixel-aligned onion skin modes.
//
// The pin window owns these states completely - the main process is not involved
// and no global shortcut is registered. The pure transition function lives outside
// the DOM bootstrap so node:test can drive it behaviourally (test/n05-...), while
// the renderer below only applies its result to body classes and a toast.
//
// Modes:
//   * difference - `mix-blend-mode: difference` on the picture (the report's
//     specified blend), the classic onion-skin compare against the UI behind;
//   * flash      - the picture alternates once per second, so the eye can compare
//     the pinned design with the live UI in the alternate half-cycle;
//   * both only make sense while the pin is click-through AND semi-transparent:
//     that is the state that lets the user interact with the app underneath.
// A request while unavailable changes nothing and explains itself with a toast.
// `prefers-reduced-motion` never gets an animated mode: a flash request degrades to
// the static difference mode and says so.
// ---------------------------------------------------------------------------
const ONION_MODES = Object.freeze({ OFF: 'off', DIFFERENCE: 'difference', FLASH: 'flash' })
const ONION_ACTIONS = Object.freeze({
  TOGGLE_DIFFERENCE: 'toggle-difference',
  TOGGLE_FLASH: 'toggle-flash',
  OFF: 'off',
  REVALIDATE: 'revalidate'
})
// A pin at 100% opacity hides the app completely, so there is nothing to align.
const ONION_MIN_TRANSPARENCY = 0.001

function resolveOnionMode(options = {}) {
  const source = options && typeof options === 'object' ? options : {}
  const mode = Object.values(ONION_MODES).includes(source.mode) ? source.mode : ONION_MODES.OFF
  const action = typeof source.action === 'string' ? source.action : ''
  const clickThrough = source.clickThrough === true
  const opacity = Number(source.opacity)
  const available = clickThrough && Number.isFinite(opacity) && opacity <= 1 - ONION_MIN_TRANSPARENCY
  const reducedMotion = source.reducedMotion === true

  // The state was re-checked after an external change (click-through exit, opacity
  // back to 100%): an active mode has to leave, an inactive one simply stays off.
  if (action === ONION_ACTIONS.REVALIDATE) {
    if (available) return { mode, changed: false, available, reducedMotionApplied: false, toastKey: '' }
    return {
      mode: ONION_MODES.OFF,
      changed: mode !== ONION_MODES.OFF,
      available: false,
      reducedMotionApplied: false,
      toastKey: mode === ONION_MODES.OFF ? '' : 'pin.onion.unavailable'
    }
  }
  if (action === ONION_ACTIONS.OFF) {
    return {
      mode: ONION_MODES.OFF,
      changed: mode !== ONION_MODES.OFF,
      available,
      reducedMotionApplied: false,
      toastKey: mode === ONION_MODES.OFF ? '' : 'pin.onion.off'
    }
  }
  if (!available) {
    // Explicit request outside the supported state: keep whatever was active and
    // tell the user which two switches are missing.
    return { mode, changed: false, available: false, reducedMotionApplied: false, toastKey: 'pin.onion.unavailable' }
  }
  const requested = action === ONION_ACTIONS.TOGGLE_FLASH
    ? ONION_MODES.FLASH
    : action === ONION_ACTIONS.TOGGLE_DIFFERENCE
      ? ONION_MODES.DIFFERENCE
      : ''
  if (!requested) return { mode, changed: false, available, reducedMotionApplied: false, toastKey: '' }
  // The same shortcut again is "back to normal", never a second mode on top.
  if (mode === requested) {
    return { mode: ONION_MODES.OFF, changed: true, available, reducedMotionApplied: false, toastKey: 'pin.onion.off' }
  }
  if (requested === ONION_MODES.FLASH && reducedMotion) {
    // The flash request was downgraded, so that same shortcut is the one that turns
    // the fallback back off ("again returns to normal"), not a no-op.
    const next = mode === ONION_MODES.DIFFERENCE ? ONION_MODES.OFF : ONION_MODES.DIFFERENCE
    return {
      mode: next,
      changed: next !== mode,
      available,
      reducedMotionApplied: next === ONION_MODES.DIFFERENCE,
      toastKey: next === ONION_MODES.OFF ? 'pin.onion.off' : 'pin.onion.reduced-motion'
    }
  }
  return {
    mode: requested,
    changed: true,
    available,
    reducedMotionApplied: false,
    toastKey: requested === ONION_MODES.FLASH ? 'pin.onion.flash-on' : 'pin.onion.difference-on'
  }
}

// Everything below is DOM + window.pinAPI wiring; a node require of this file only
// receives the pure exports above (the renderer scripts are classic scripts, so the
// guard keeps the browser path unchanged).
function startPinRenderer() {
  const image = document.getElementById('image')
  const pixelImage = document.getElementById('pixelImage')
  const zoomBadge = document.getElementById('zoomBadge')
  const opacityBadge = document.getElementById('opacityBadge')
  const clickThroughTag = document.getElementById('clickThroughTag')
  const toast = document.getElementById('pinToast')
  const namingOverlay = document.getElementById('pinWorkspaceNaming')
  const namingInput = document.getElementById('pinWorkspaceNameInput')
  const namingConfirm = document.getElementById('pinWorkspaceNameConfirm')
  const namingCancel = document.getElementById('pinWorkspaceNameCancel')
  const ocrOverlay = document.getElementById('pinOcrOverlay')
  const recognitionStatus = document.getElementById('pinRecognitionStatus')
  const recognitionTools = document.getElementById('pinRecognitionTools')
  const toggleSource = document.getElementById('pinToggleSource')
  const copyText = document.getElementById('pinCopyText')
  const plainText = document.getElementById('pinPlainText')
  const recognizedText = document.getElementById('pinRecognizedText')
  let activeSurface = pixelImage
  let sourceImage = null
  let settings = {}
  let pendingImageUrl = null
  let activeImageUrl = null
  let initialFramePending = false
  let clickThrough = false
  let pressed = false
  let moving = false
  let pointerId = null
  let pressPoint = null
  let moveFrame = 0
  let zoomTimer = 0
  let opacityTimer = 0
  let recognition = null
  let showSource = false
  let recognitionFrame = 0
  let opacityRatio = 1
  let onionMode = ONION_MODES.OFF
  let toastTimer = 0
  let lastToast = null
  const TOAST_VISIBLE_MS = 2600
  const WORKSPACE_NAME_MAX = 64

  function renderRecognition() {
    if (recognitionFrame) cancelAnimationFrame(recognitionFrame)
    recognitionFrame = 0
    const { action, phase, result } = recognition || {}
    const translating = action === 'translate' && phase === 'result'
    const statusKey = {
      recognizing: 'capture.loading.ocr',
      translating: 'pin.recognition.translating',
      empty: 'pin.recognition.empty',
      failed: 'pin.recognition.failed',
      'translation-failed': 'pin.recognition.translation-failed'
    }[phase]
    recognitionStatus.textContent = statusKey ? t(statusKey) : ''
    recognitionStatus.hidden = !statusKey
    recognitionStatus.dataset.waiting = String(phase === 'recognizing' || phase === 'translating')
    recognitionTools.hidden = !result
    toggleSource.hidden = !translating
    toggleSource.textContent = t(showSource ? 'capture.ocr.show-translation' : 'capture.ocr.show-source')
    const displayed = translating && showSource ? {
      ...result,
      text: result.textBlocks.map((block) => block.sourceText).join('\n'),
      textBlocks: result.textBlocks.map((block) => ({ ...block, text: block.sourceText }))
    } : result
    recognizedText.value = displayed?.text || ''
    if (!displayed) {
      ocrOverlay.replaceChildren()
      recognizedText.hidden = true
      return
    }
    const width = activeSurface.offsetWidth
    const height = activeSurface.offsetHeight
    ocrOverlay.style.height = `${height}px`
    window.OcrTextOverlay.renderBlocks(ocrOverlay, displayed, {
      width, height, translated: translating && !showSource, minConfidence: 0, t
    })
  }

  function queueRecognitionLayout() {
    if (recognition?.result && !recognitionFrame) recognitionFrame = requestAnimationFrame(renderRecognition)
  }

  function setRecognition(next) {
    recognition = next
    recognizedText.hidden = true
    showSource = false
    renderRecognition()
  }

  // -------------------------------------------------------------------------
  // DEV-02 (plan 2026-11-28): offscreen "export the current view".
  //
  // The main process used to hide the transient chrome with an injected style sheet and
  // then ask Electron to photograph the live window: a prepare failure could paint
  // controls into the shot and the hide/restore pair could flicker on screen. Now main
  // only asks THIS renderer for the view; the renderer composes it into an offscreen
  // canvas (geometry in pin/pin-view-export.js) and sends the bounded PNG back. The
  // visible page is never touched, so no flicker is possible and no controls are in the
  // pixels.
  // -------------------------------------------------------------------------
  const viewExportApi = window.pinViewExport || null
  let viewExportBusy = false

  function currentViewExportOcr() {
    if (!recognition || !recognition.result) return { visible: false }
    const translating = recognition.action === 'translate' && recognition.phase === 'result'
    const displayed = translating && showSource ? {
      ...recognition.result,
      text: recognition.result.textBlocks.map((block) => block.sourceText).join('\n'),
      textBlocks: recognition.result.textBlocks.map((block) => ({ ...block, text: block.sourceText }))
    } : recognition.result
    const overlay = document.getElementById('pinOcrOverlay')
    return {
      visible: !!overlay && overlay.childElementCount > 0 && Array.isArray(displayed?.textBlocks),
      translated: translating && !showSource,
      blocks: displayed?.textBlocks || [],
      imageWidth: displayed?.imageWidth,
      imageHeight: displayed?.imageHeight
    }
  }

  function canvasPngBytes(canvas) {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob !== 'function') {
        resolve(null)
        return
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(null)
          return
        }
        blob.arrayBuffer().then(resolve, () => resolve(null))
      }, 'image/png')
    })
  }

  function respondViewExport(payload) {
    try {
      return window.pinAPI.viewExportResult({
        type: 'view-export-result',
        ...payload
      }) === true
    } catch {
      return false
    }
  }

  async function composeViewExport(requestId) {
    if (viewExportBusy) {
      respondViewExport({ requestId, ok: false, code: 'busy' })
      return
    }
    if (!viewExportApi) {
      respondViewExport({ requestId, ok: false, code: 'unavailable' })
      return
    }
    viewExportBusy = true
    let canvas = null
    try {
      const surface = activeSurface
      const surfaceSize = surface === image
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : { width: pixelImage.width, height: pixelImage.height }
      const scroller = document.scrollingElement || document.documentElement
      const plan = viewExportApi.planViewExport({
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1
        },
        surface: surfaceSize,
        rotation: Number(document.body.dataset.rotation) || 0,
        longCapture: settings.longCapture === true,
        scrollTop: scroller ? Number(scroller.scrollTop) || 0 : 0,
        ocr: currentViewExportOcr()
      })
      if (!plan.ok) {
        respondViewExport({ requestId, ok: false, code: plan.code || 'empty-image' })
        return
      }
      canvas = document.createElement('canvas')
      canvas.width = plan.width
      canvas.height = plan.height
      const context = canvas.getContext('2d')
      if (!context) {
        respondViewExport({ requestId, ok: false, code: 'canvas-unavailable' })
        return
      }
      if (!viewExportApi.drawViewExport(context, plan, { picture: surface })) {
        respondViewExport({ requestId, ok: false, code: 'empty-image' })
        return
      }
      const png = await canvasPngBytes(canvas)
      if (!png || !png.byteLength) {
        respondViewExport({ requestId, ok: false, code: 'encode-failed' })
        return
      }
      if (png.byteLength > viewExportApi.MAX_EXPORT_PNG_BYTES) {
        respondViewExport({ requestId, ok: false, code: 'png-too-large' })
        return
      }
      respondViewExport({
        requestId,
        ok: true,
        png,
        width: plan.width,
        height: plan.height,
        ocrOverlay: plan.ocrOverlay === true
      })
    } catch (_error) {
      respondViewExport({ requestId, ok: false, code: 'failed' })
    } finally {
      viewExportBusy = false
      if (canvas) {
        // Drop the backing store as soon as the bytes have been copied out.
        canvas.width = 1
        canvas.height = 1
      }
    }
  }

  if (typeof window.pinAPI.onViewExportRequest === 'function') {
    window.pinAPI.onViewExportRequest((request) => {
      const requestId = request && typeof request.requestId === 'string' ? request.requestId : ''
      if (requestId) void composeViewExport(requestId)
    })
  }

  // -------------------------------------------------------------------------
  // N05: transient toast + workspace snapshot naming overlay.
  // -------------------------------------------------------------------------
  function showToast(key, params = null) {
    if (!toast) return
    const message = t(key, params || undefined)
    if (!message) return
    toast.textContent = message
    toast.hidden = false
    lastToast = { key, params }
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.hidden = true
      lastToast = null
    }, TOAST_VISIBLE_MS)
  }

  function renderToastLanguage() {
    if (!toast || toast.hidden || !lastToast) return
    toast.textContent = t(lastToast.key, lastToast.params || undefined)
  }

  function namingOpen() {
    return !!(namingOverlay && !namingOverlay.hidden)
  }

  function openWorkspaceNaming() {
    if (!namingOverlay || !namingInput) return false
    namingInput.value = ''
    namingOverlay.hidden = false
    namingInput.focus()
    return true
  }

  function closeWorkspaceNaming() {
    if (!namingOverlay) return false
    namingOverlay.hidden = true
    if (namingInput && typeof namingInput.blur === 'function') namingInput.blur()
    return true
  }

  function submitWorkspaceName() {
    if (!namingInput) return false
    const name = namingInput.value.replace(/\s+/g, ' ').trim().slice(0, WORKSPACE_NAME_MAX)
    if (!name) {
      showToast('pin.workspace.toast-name-required')
      namingInput.focus()
      return false
    }
    closeWorkspaceNaming()
    if (typeof window.pinAPI.workspaceCommand === 'function') {
      window.pinAPI.workspaceCommand({ type: 'workspace-save', name })
    }
    return true
  }

  if (namingConfirm) namingConfirm.addEventListener('click', submitWorkspaceName)
  if (namingCancel) namingCancel.addEventListener('click', closeWorkspaceNaming)
  if (namingInput) {
    namingInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        submitWorkspaceName()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeWorkspaceNaming()
      }
    })
  }

  // Main -> renderer receipts for the workspace commands. The window may be closed
  // by a successful restore (the requester is one of the replaced pins), so only the
  // cases that leave this window alive need copy; the rest are harmless no-ops.
  function handleWorkspaceResult(result) {
    if (!result || typeof result !== 'object') return
    const code = typeof result.code === 'string' ? result.code : ''
    if (result.action === 'save') {
      if (result.status === 'saved') showToast('pin.workspace.toast-saved', { name: result.name })
      else if (code === 'NAME_REQUIRED') showToast('pin.workspace.toast-name-required')
      else if (code === 'BUSY') showToast('pin.workspace.toast-busy')
      else showToast('pin.workspace.toast-save-failed')
      return
    }
    if (result.action === 'delete') {
      if (result.status === 'deleted') showToast('pin.workspace.toast-deleted', { name: result.name })
      else if (code === 'NOT_FOUND') showToast('pin.workspace.toast-not-found')
      else showToast('pin.workspace.toast-delete-failed')
      return
    }
    if (result.action === 'restore') {
      if (result.status === 'failed' || result.status === 'restored') {
        if (code === 'ALL_IMAGES_MISSING') showToast('pin.workspace.toast-all-missing')
        else if (code === 'NOT_FOUND') showToast('pin.workspace.toast-not-found')
        else if (code === 'BUSY') showToast('pin.workspace.toast-busy')
        else if (result.status === 'failed') showToast('pin.workspace.toast-restore-failed')
      }
      return
    }
    if (result.action === 'resume' && result.status === 'resumed') showToast('pin.workspace.toast-resumed')
  }

  // -------------------------------------------------------------------------
  // N05: onion skin mode application.
  // -------------------------------------------------------------------------
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch {
      return false
    }
  }

  function applyOnionMode(nextMode) {
    onionMode = Object.values(ONION_MODES).includes(nextMode) ? nextMode : ONION_MODES.OFF
    document.body.classList.toggle('onion-difference', onionMode === ONION_MODES.DIFFERENCE)
    document.body.classList.toggle('onion-flash', onionMode === ONION_MODES.FLASH)
  }

  function onionSnapshot() {
    return { mode: onionMode, clickThrough, opacity: opacityRatio, reducedMotion: prefersReducedMotion() }
  }

  function handleOnionAction(action) {
    const result = resolveOnionMode({ ...onionSnapshot(), action })
    if (result.mode !== onionMode) applyOnionMode(result.mode)
    if (result.toastKey) showToast(result.toastKey)
  }

  // Click-through / transparency can be changed by the context menu, the wheel or a
  // settings-driven receipt: an active mode must not outlive the state it needs.
  function revalidateOnionMode() {
    if (onionMode === ONION_MODES.OFF) return
    const result = resolveOnionMode({ ...onionSnapshot(), action: ONION_ACTIONS.REVALIDATE })
    if (result.changed) applyOnionMode(result.mode)
    if (result.toastKey) showToast(result.toastKey)
  }

  function setNativePixelMode(zoom) {
    pixelImage.classList.toggle('pixel-native', Math.abs(Number(zoom) - 1) < 0.001)
  }

  toggleSource.onclick = () => {
    showSource = !showSource
    renderRecognition()
  }
  copyText.onclick = async () => {
    try {
      await navigator.clipboard.writeText(recognizedText.value)
      if (recognition?.result) {
        copyText.textContent = t('capture.action.copied')
        setTimeout(() => { copyText.textContent = t('capture.ocr.copy-all') }, 800)
      }
    } catch {
      recognizedText.hidden = false
      recognizedText.select()
    }
  }
  plainText.onclick = () => {
    recognizedText.hidden = !recognizedText.hidden
    if (!recognizedText.hidden) recognizedText.focus()
  }
  document.getElementById('pinHideResult').onclick = () => setRecognition(null)

  // The main process is the single writer of this state; the renderer only mirrors
  // it (init payload, update payload, and the pin:click-through-changed receipt).
  function applyClickThrough(enabled) {
    clickThrough = enabled === true
    clickThroughTag.classList.toggle('show', clickThrough)
    document.body.classList.toggle('click-through', clickThrough)
    revalidateOnionMode()
  }

  function showSurface(target) {
    activeSurface = target
    image.classList.toggle('hidden', target !== image)
    pixelImage.classList.toggle('hidden', target !== pixelImage)
  }

  function releasePendingImage() {
    if (sourceImage) {
      sourceImage.onload = null
      sourceImage.onerror = null
      sourceImage.removeAttribute('src')
      sourceImage = null
    }
    image.onload = null
    image.onerror = null
    if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl)
    pendingImageUrl = null
  }

  function finishImage(url, target) {
    if (pendingImageUrl !== url) return
    if (activeImageUrl) URL.revokeObjectURL(activeImageUrl)
    activeImageUrl = target === image ? url : null
    if (activeImageUrl) pendingImageUrl = null
    releasePendingImage()
    if (target === image) {
      pixelImage.width = 1
      pixelImage.height = 1
    } else {
      image.removeAttribute('src')
    }
    showSurface(target)
    if (initialFramePending) {
      initialFramePending = false
      window.pinAPI.renderReady()
    }
  }

  function failImage(url) {
    if (pendingImageUrl !== url) return
    releasePendingImage()
    if (initialFramePending) window.pinAPI.close()
  }

  function showImageSurface(url) {
    image.onload = () => {
      finishImage(url, image)
    }
    image.onerror = () => failImage(url)
    image.src = url
  }

  // Rotation is a pure CSS transform: the pinned image is never re-encoded, so a
  // rotated pin still copies/saves/recognises the original pixels. The main process
  // owns the angle (it has to resize the window to the rotated bounding box), and
  // pin.css turns the `data-rotation` attribute into the matching transform.
  function applyRotation(value) {
    const degrees = Number(value)
    const snapped = Number.isFinite(degrees) ? ((Math.round(degrees / 90) * 90 % 360) + 360) % 360 : 0
    document.body.dataset.rotation = String(snapped)
  }

  // settings.pinned.zoomStep arrives in the pin payload (one wheel notch = 1 + step
  // instead of the old hardcoded 1.1). Mirrors the main-process clamp: a store
  // written before the key existed, or a non-numeric value, falls back to 10%.
  function wheelZoomFactor(zoomStep, zoomIn) {
    const step = Number(zoomStep)
    const bounded = Number.isFinite(step) && step >= 0.05 && step <= 0.5 ? step : 0.1
    return zoomIn ? 1 + bounded : 1 / (1 + bounded)
  }

  function applyPinData({ imageBuffer, imageMime, ...data }, initial = false) {
    releasePendingImage()
    initialFramePending ||= initial
    const url = URL.createObjectURL(new Blob([imageBuffer], { type: imageMime }))
    pendingImageUrl = url
    settings = data
    if (Number.isFinite(Number(data.opacity))) opacityRatio = Number(data.opacity)
    document.body.classList.toggle('long-capture', !!data.longCapture)
    if (typeof data.clickThrough === 'boolean') applyClickThrough(data.clickThrough)
    if (data.rotation !== undefined) applyRotation(data.rotation)
    // The badge is only shown while a change is in flight, but its text has to be
    // right before the first receipt: a pin created at 50% must not flash "100%".
    if (Number.isFinite(Number(data.opacity))) {
      opacityBadge.textContent = `${Math.round(Number(data.opacity) * 100)}%`
    }
    setNativePixelMode(data.zoom)
    if (data.longCapture) {
      showImageSurface(url)
      return
    }
    const nextImage = new Image()
    sourceImage = nextImage
    nextImage.onload = () => {
      if (sourceImage !== nextImage) return
      const pixels = nextImage.naturalWidth * nextImage.naturalHeight
      if (nextImage.naturalWidth > 16384 || nextImage.naturalHeight > 16384 || pixels > 64000000) {
        showImageSurface(url)
        return
      }
      pixelImage.width = nextImage.naturalWidth
      pixelImage.height = nextImage.naturalHeight
      const context = pixelImage.getContext('2d', { alpha: true })
      context.clearRect(0, 0, pixelImage.width, pixelImage.height)
      context.imageSmoothingEnabled = false
      context.drawImage(nextImage, 0, 0)
      finishImage(url, pixelImage)
    }
    nextImage.onerror = () => failImage(url)
    nextImage.src = url
  }

  addEventListener('pagehide', () => {
    releasePendingImage()
    if (activeImageUrl) URL.revokeObjectURL(activeImageUrl)
    activeImageUrl = null
  })
  // The window-security probe boots every renderer by calling its marker global; N05 wrapped the
  // renderer in startPinRenderer(), so applyPinData has to stay reachable from window.
  window.applyPinData = applyPinData
  window.pinAPI.onInit((data) => applyPinData(data, true))
  window.pinAPI.onUpdate((data) => {
    setRecognition(null)
    applyPinData(data)
  })
  window.pinAPI.onRecognition(setRecognition)
  window.pinAPI.onClickThroughChanged((enabled) => applyClickThrough(enabled))
  window.pinAPI.onRotationChanged((rotation) => {
    applyRotation(rotation)
    queueRecognitionLayout()
  })
  window.pinAPI.onWorkspaceNameRequest(() => openWorkspaceNaming())
  window.pinAPI.onWorkspaceResult(handleWorkspaceResult)
  addEventListener('resize', queueRecognitionLayout)
  // A click-through pin receives forwarded mouse *moves* only (clicks and the wheel
  // are dropped), so hovering the reserved badge is the in-window way back — the
  // global shortcut and the tray item are the guaranteed fallback. mouseenter is
  // the renderer-side hit test: it fires only for the element under the pointer.
  clickThroughTag.addEventListener('mouseenter', () => {
    if (clickThrough) window.pinAPI.setClickThrough(false)
  })
  addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const rect = activeSurface.getBoundingClientRect()
    window.pinAPI.contextMenu({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  })

  function beginMove(event) {
    if (event.button !== 0) return
    if (clickThrough) return
    pressed = true
    moving = false
    pointerId = event.pointerId
    pressPoint = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(pointerId)
  }

  function updateMove(event) {
    if (!pressed || event.pointerId !== pointerId) return
    if (!moving && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > 6) {
      moving = true
      document.body.classList.add('dragging')
      window.pinAPI.beginMove()
    }
    if (moving && !moveFrame) {
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0
        window.pinAPI.move()
      })
    }
  }

  function finishMove(event) {
    // A07: pass the modifier of the release so the main process can snap (or skip on Alt).
    if (!pressed || event.pointerId !== pointerId) return
    pressed = false
    if (moving) window.pinAPI.endMove(event?.altKey === true)
    moving = false
    document.body.classList.remove('dragging')
    try { event.currentTarget.releasePointerCapture(pointerId) } catch {}
    pointerId = null
    pressPoint = null
  }

  for (const surface of [image, pixelImage]) {
    surface.addEventListener('pointerdown', beginMove)
    surface.addEventListener('pointermove', updateMove)
    surface.addEventListener('pointerup', finishMove)
    surface.addEventListener('pointercancel', finishMove)
    surface.addEventListener('dblclick', (event) => {
      event.preventDefault()
      window.pinAPI.close()
    })
  }

  // The wheel has two jobs: plain wheel zooms (settings.pinned.zoomStep per notch),
  // Ctrl+wheel changes opacity. Neither branch may call preventDefault before it has
  // decided to handle the event: a long capture is scrollable and keeps its wheel.
  // A click-through pin never receives this event at all:
  // setIgnoreMouseEvents(true, { forward: true }) forwards mouse moves only, never
  // the wheel, so opacity on a click-through pin stays reachable through the context
  // menu's 25/50/75/100 radio items and by leaving click-through first (corner badge
  // hover / the global cancel shortcut). That limitation is documented instead of
  // faked: a synthetic wheel cannot be delivered to a window that ignores the mouse.
  addEventListener('wheel', (event) => {
    if (clickThrough || event.target === recognizedText) return
    if (event.ctrlKey) {
      event.preventDefault()
      window.pinAPI.adjustOpacity(event.deltaY < 0 ? 1 : -1)
      return
    }
    if (settings.longCapture || !settings.zoomWithMouse) return
    event.preventDefault()
    window.pinAPI.resize(wheelZoomFactor(settings.zoomStep, event.deltaY < 0))
  }, { passive: false })
  window.pinAPI.onZoomChanged((zoom) => {
    setNativePixelMode(Number(zoom) / 100)
    zoomBadge.textContent = `${zoom}%`
    zoomBadge.classList.add('show')
    clearTimeout(zoomTimer)
    zoomTimer = setTimeout(() => zoomBadge.classList.remove('show'), 550)
  })
  // Main-process receipt for the Ctrl+wheel opacity change (and the context-menu
  // radio items, which take the same path): the badge mirrors the authoritative
  // percentage instead of re-deriving it from a local step.
  window.pinAPI.onOpacityChanged((percent) => {
    const value = Number(percent)
    if (Number.isFinite(value)) opacityRatio = value / 100
    opacityBadge.textContent = `${percent}%`
    opacityBadge.classList.add('show')
    clearTimeout(opacityTimer)
    opacityTimer = setTimeout(() => opacityBadge.classList.remove('show'), 550)
    revalidateOnionMode()
  })
  addEventListener('keydown', (event) => {
    // A held shortcut must not repeat a snapshot command or flip the onion mode
    // twice in a row.
    if (event.repeat) return
    // The naming overlay owns the keyboard while it is open: Escape cancels it
    // instead of closing the pin, and no shortcut fires while the user is typing.
    if (namingOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeWorkspaceNaming()
      }
      return
    }
    if (event.key === 'Escape' && !recognizedText.hidden) {
      recognizedText.hidden = true
      return
    }
    if (event.key === 'Escape') window.pinAPI.close()
    // N05: pin-window-local shortcuts only - the pin domain registers no global
    // shortcut, so these can never fight the user's system-wide bindings. D/F drive
    // the onion modes, S/R/H the workspace snapshots (see the delivery report for
    // why resume is the tray/global "show hidden pins" entry instead).
    const shortcut = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    if (shortcut) {
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      if (key === 'd') {
        event.preventDefault()
        handleOnionAction(ONION_ACTIONS.TOGGLE_DIFFERENCE)
        return
      }
      if (key === 'f') {
        event.preventDefault()
        handleOnionAction(ONION_ACTIONS.TOGGLE_FLASH)
        return
      }
      if (key === 's') {
        event.preventDefault()
        openWorkspaceNaming()
        return
      }
      if (key === 'r') {
        event.preventDefault()
        if (typeof window.pinAPI.workspaceCommand === 'function') {
          window.pinAPI.workspaceCommand({ type: 'workspace-restore-latest' })
        }
        return
      }
      if (key === 'h') {
        event.preventDefault()
        if (typeof window.pinAPI.workspaceCommand === 'function') {
          window.pinAPI.workspaceCommand({ type: 'workspace-suspend' })
        }
        return
      }
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'c' &&
      event.target !== recognizedText && window.getSelection()?.isCollapsed !== false) window.pinAPI.copy()
  })
  // P0-1-T2/T5: the click-through tag is static markup, so it is translated once
  // at load and re-translated when the main process broadcasts a language change.
  applyTranslations()
  window.pinAPI.onInterfaceLanguage((language) => {
    setLanguage(language)
    applyTranslations()
    renderToastLanguage()
    if (recognition) renderRecognition()
  })
  window.pinAPI.ready()
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ONION_MODES, ONION_ACTIONS, resolveOnionMode }
}
if (typeof document !== 'undefined') startPinRenderer()
