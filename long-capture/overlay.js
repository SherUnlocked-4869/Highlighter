const selection = document.getElementById('selection')
const selectionLabel = selection.querySelector('span')

// P0-1-T5 (S12): `shared/i18n.js` is a classic script, so its `t`, `setLanguage`
// and `applyTranslations` bindings are already visible here. They must NOT be
// re-declared (the runtime's top-level `const`s share this script's global
// lexical scope, so destructuring them from `window` throws).

let displayBounds = null
let bounds = null
let editing = false
let lockedAxis = ''
let dragState = null

// The label is state-dependent, so it is rendered from the current state rather
// than only from the markup.
function renderSelectionLabel() {
  selectionLabel.textContent = t(editing
    ? (lockedAxis ? 'long-capture.overlay.move-along-axis' : 'long-capture.overlay.adjust-selection')
    : 'long-capture.header.title')
}

function localBounds() {
  return {
    x: bounds.x - displayBounds.x,
    y: bounds.y - displayBounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

function renderBounds() {
  if (!bounds || !displayBounds) return
  const local = localBounds()
  selection.style.left = `${local.x - 2}px`
  selection.style.top = `${local.y - 2}px`
  selection.style.width = `${local.width + 4}px`
  selection.style.height = `${local.height + 4}px`
}

function clampBounds(next) {
  const minimum = 80
  next.width = Math.max(minimum, Math.min(displayBounds.width, next.width))
  next.height = Math.max(minimum, Math.min(displayBounds.height, next.height))
  next.x = Math.max(displayBounds.x, Math.min(displayBounds.x + displayBounds.width - next.width, next.x))
  next.y = Math.max(displayBounds.y, Math.min(displayBounds.y + displayBounds.height - next.height, next.y))
  return next
}

window.longOverlayAPI.onInit((data) => {
  displayBounds = data.displayBounds
  bounds = { ...data.selectionBounds }
  renderBounds()
})
window.longOverlayAPI.onActiveChanged((active) => selection.classList.toggle('active', active))
window.longOverlayAPI.onEditingChanged((data = {}) => {
  editing = !!data.enabled
  lockedAxis = data.lockedAxis || ''
  document.body.classList.toggle('editing', editing)
  document.body.classList.toggle('axis-locked', !!lockedAxis)
  renderSelectionLabel()
})

selection.addEventListener('pointerdown', (event) => {
  if (!editing || !bounds) return
  event.preventDefault()
  const handle = event.target.dataset.handle || 'move'
  dragState = { handle, x: event.clientX, y: event.clientY, bounds: { ...bounds }, pointerId: event.pointerId }
  selection.setPointerCapture(event.pointerId)
})

selection.addEventListener('pointermove', (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  const dx = event.clientX - dragState.x
  const dy = event.clientY - dragState.y
  const start = dragState.bounds
  const next = { ...start }
  if (dragState.handle === 'move') {
    next.x += lockedAxis === 'vertical' ? 0 : dx
    next.y += lockedAxis === 'horizontal' ? 0 : dy
  } else if (!lockedAxis) {
    if (dragState.handle.includes('w')) { next.x += dx; next.width -= dx }
    if (dragState.handle.includes('e')) next.width += dx
    if (dragState.handle.includes('n')) { next.y += dy; next.height -= dy }
    if (dragState.handle.includes('s')) next.height += dy
  }
  bounds = clampBounds(next)
  renderBounds()
})

function finishDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  try { selection.releasePointerCapture(event.pointerId) } catch {}
  dragState = null
  window.longOverlayAPI.updateBounds(bounds)
}

selection.addEventListener('pointerup', finishDrag)
selection.addEventListener('pointercancel', finishDrag)

// P0-1-T2/T5: translate the markup now and re-render the dynamic label on a switch.
applyTranslations()
renderSelectionLabel()
window.longOverlayAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
  renderSelectionLabel()
})
window.longOverlayAPI.ready()
