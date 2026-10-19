const image = document.getElementById('image')
const pixelImage = document.getElementById('pixelImage')
const zoomBadge = document.getElementById('zoomBadge')
const opacityBadge = document.getElementById('opacityBadge')
const clickThroughTag = document.getElementById('clickThroughTag')
let activeSurface = pixelImage
let sourceImage = null
let settings = {}
let clickThrough = false
let pressed = false
let moving = false
let pointerId = null
let pressPoint = null
let moveFrame = 0
let zoomTimer = 0
let opacityTimer = 0

function setNativePixelMode(zoom) {
  pixelImage.classList.toggle('pixel-native', Math.abs(Number(zoom) - 1) < 0.001)
}

// The main process is the single writer of this state; the renderer only mirrors
// it (init payload, update payload, and the pin:click-through-changed receipt).
function applyClickThrough(enabled) {
  clickThrough = enabled === true
  clickThroughTag.classList.toggle('show', clickThrough)
  document.body.classList.toggle('click-through', clickThrough)
}

function showSurface(target) {
  activeSurface = target
  image.classList.toggle('hidden', target !== image)
  pixelImage.classList.toggle('hidden', target !== pixelImage)
}

function showImageSurface(dataUrl, initial) {
  image.onload = () => {
    image.onload = null
    if (initial) window.pinAPI.renderReady()
  }
  image.src = dataUrl
  showSurface(image)
}

// Rotation is a pure CSS transform: the pinned dataUrl is never re-encoded, so a
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

function applyPinData(data, initial = false) {
  settings = data
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
    sourceImage = null
    showImageSurface(data.dataUrl, initial)
    return
  }
  const nextImage = new Image()
  sourceImage = nextImage
  nextImage.onload = () => {
    if (sourceImage !== nextImage) return
    const pixels = nextImage.naturalWidth * nextImage.naturalHeight
    if (nextImage.naturalWidth > 16384 || nextImage.naturalHeight > 16384 || pixels > 64000000) {
      showImageSurface(data.dataUrl, initial)
      return
    }
    pixelImage.width = nextImage.naturalWidth
    pixelImage.height = nextImage.naturalHeight
    const context = pixelImage.getContext('2d', { alpha: true })
    context.clearRect(0, 0, pixelImage.width, pixelImage.height)
    context.imageSmoothingEnabled = false
    context.drawImage(nextImage, 0, 0)
    showSurface(pixelImage)
    if (initial) window.pinAPI.renderReady()
  }
  nextImage.src = data.dataUrl
}

window.pinAPI.onInit((data) => applyPinData(data, true))
window.pinAPI.onUpdate((data) => applyPinData(data))
window.pinAPI.onClickThroughChanged((enabled) => applyClickThrough(enabled))
window.pinAPI.onRotationChanged((rotation) => applyRotation(rotation))
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
  if (!pressed || event.pointerId !== pointerId) return
  pressed = false
  if (moving) window.pinAPI.endMove()
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
  if (clickThrough) return
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
  opacityBadge.textContent = `${percent}%`
  opacityBadge.classList.add('show')
  clearTimeout(opacityTimer)
  opacityTimer = setTimeout(() => opacityBadge.classList.remove('show'), 550)
})
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.pinAPI.close()
  if (event.ctrlKey && event.key.toLowerCase() === 'c') window.pinAPI.copy()
})
// P0-1-T2/T5: the click-through tag is static markup, so it is translated once
// at load and re-translated when the main process broadcasts a language change.
applyTranslations()
window.pinAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
})
window.pinAPI.ready()
