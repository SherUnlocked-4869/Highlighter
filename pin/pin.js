const image = document.getElementById('image')
const pixelImage = document.getElementById('pixelImage')
const zoomBadge = document.getElementById('zoomBadge')
let activeSurface = pixelImage
let sourceImage = null
let settings = {}
let pressed = false
let moving = false
let pointerId = null
let pressPoint = null
let moveFrame = 0
let zoomTimer = 0

function setNativePixelMode(zoom) {
  pixelImage.classList.toggle('pixel-native', Math.abs(Number(zoom) - 1) < 0.001)
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

function applyPinData(data, initial = false) {
  settings = data
  document.body.classList.toggle('long-capture', !!data.longCapture)
  document.getElementById('opacity').value = Math.round((data.opacity || 1) * 100)
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
document.getElementById('opacity').oninput = (event) => window.pinAPI.setOpacity(Number(event.target.value) / 100)
addEventListener('contextmenu', (event) => {
  event.preventDefault()
  const rect = activeSurface.getBoundingClientRect()
  window.pinAPI.contextMenu({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
})

function beginMove(event) {
  if (event.button !== 0) return
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

addEventListener('wheel', (event) => {
  if (settings.longCapture || !settings.zoomWithMouse || event.target.closest('.opacity')) return
  event.preventDefault()
  window.pinAPI.resize(event.deltaY < 0 ? 1.1 : 1 / 1.1)
}, { passive: false })
window.pinAPI.onZoomChanged((zoom) => {
  setNativePixelMode(Number(zoom) / 100)
  zoomBadge.textContent = `${zoom}%`
  zoomBadge.classList.add('show')
  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => zoomBadge.classList.remove('show'), 550)
})
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.pinAPI.close()
  if (event.ctrlKey && event.key.toLowerCase() === 'c') window.pinAPI.copy()
})
window.pinAPI.ready()
