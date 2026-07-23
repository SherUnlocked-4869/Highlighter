const {
  createAnnotation,
  updateAnnotation,
  sanitizeAnnotationCommand,
  undoAnnotationSnapshot,
  clearAnnotationSnapshot,
  drawAnnotationSnapshot
} = window.annotationUtils

const stage = document.getElementById('annotationStage')
const context = stage.getContext('2d')

let command = { enabled: false, tool: 'pointer', color: '#ff3b30', width: 4, action: '', resetVersion: 0 }
let snapshot = clearAnnotationSnapshot()
let nextId = 1
let publishRequest = 0
let dpr = window.devicePixelRatio || 1

function sourceSize() {
  return { width: Math.max(1, stage.clientWidth), height: Math.max(1, stage.clientHeight) }
}

function render() {
  context.clearRect(0, 0, stage.width, stage.height)
  drawAnnotationSnapshot(context, snapshot, sourceSize())
}

function resizeStage() {
  dpr = window.devicePixelRatio || 1
  stage.width = Math.max(1, Math.round(stage.clientWidth * dpr))
  stage.height = Math.max(1, Math.round(stage.clientHeight * dpr))
  render()
}

function submitSnapshot() {
  publishRequest = 0
  window.recordFrameAPI.submitSnapshot(snapshot)
}

function scheduleSnapshot() {
  if (!publishRequest) publishRequest = requestAnimationFrame(submitSnapshot)
}

function pointFromEvent(event) {
  const rect = stage.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
  }
}

function cancelActive() {
  if (!snapshot.active) return
  snapshot = { annotations: snapshot.annotations, active: null }
  render()
  scheduleSnapshot()
}

function resetAnnotations() {
  snapshot = clearAnnotationSnapshot()
  nextId = 1
  render()
  scheduleSnapshot()
}

function applyCommand(payload = {}) {
  const next = { ...sanitizeAnnotationCommand(payload), enabled: !!payload.enabled }
  if (next.resetVersion !== command.resetVersion || next.action === 'reset') resetAnnotations()
  else if (next.action === 'undo') {
    snapshot = undoAnnotationSnapshot(snapshot)
    render()
    scheduleSnapshot()
  } else if (next.action === 'clear') resetAnnotations()
  command = next
  if (!command.enabled || command.tool === 'pointer') cancelActive()
}

stage.addEventListener('pointerdown', (event) => {
  if (!command.enabled || command.tool === 'pointer' || event.button !== 0) return
  event.preventDefault()
  stage.setPointerCapture(event.pointerId)
  snapshot = {
    annotations: snapshot.annotations,
    active: createAnnotation(command.tool, pointFromEvent(event), command, nextId++)
  }
  render()
  scheduleSnapshot()
})

stage.addEventListener('pointermove', (event) => {
  if (!snapshot.active) return
  event.preventDefault()
  snapshot = {
    annotations: snapshot.annotations,
    active: updateAnnotation(snapshot.active, pointFromEvent(event))
  }
  render()
  scheduleSnapshot()
})

stage.addEventListener('pointerup', (event) => {
  if (!snapshot.active) return
  event.preventDefault()
  const completed = updateAnnotation(snapshot.active, pointFromEvent(event))
  snapshot = { annotations: [...snapshot.annotations, completed], active: null }
  render()
  scheduleSnapshot()
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
})

stage.addEventListener('pointercancel', (event) => {
  cancelActive()
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
})

window.recordFrameAPI.onState((state) => {
  document.body.dataset.state = ['recording', 'paused'].includes(state) ? state : 'idle'
  if (!['recording', 'paused'].includes(state)) applyCommand({ ...command, enabled: false, tool: 'pointer' })
})
window.recordFrameAPI.onCommand(applyCommand)

addEventListener('resize', resizeStage)
addEventListener('beforeunload', () => {
  if (publishRequest) cancelAnimationFrame(publishRequest)
})

resizeStage()
window.recordFrameAPI.ready()
