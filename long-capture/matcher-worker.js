importScripts('matcher.js')

let previous = null
let width = 0
let height = 0
let axis = 'vertical'
let position = 0
let maxPosition = 0
let pending = null

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'reset') {
    previous = pending = null
    position = maxPosition = 0
    return
  }
  if (message.type === 'commit') {
    if (pending?.id === message.id) {
      ({ frame: previous, width, height, axis, position, maxPosition } = pending)
      pending = null
    }
    return
  }
  if (message.type !== 'frame') return

  // A retry supersedes a proposal that failed to reach the strip store.
  pending = null
  const current = LongCaptureMatcher.toGrayscale(new Uint8ClampedArray(message.rgba))
  if (!previous) {
    pending = { id: message.id, frame: current, width: message.width, height: message.height,
      axis: message.axis, position: 0, maxPosition: 0 }
    self.postMessage({ id: message.id, status: 'initialized' })
    return
  }
  if (width !== message.width || height !== message.height || axis !== message.axis) {
    self.postMessage({ id: message.id, status: 'size-changed' })
    return
  }

  const result = LongCaptureMatcher.findBestShift(previous, current, width, height, axis)
  if (result.status === 'matched') {
    // Track the viewport within the stitched extent (as in Snow Shot). A
    // reverse scroll first traverses existing pixels; only overflow is new.
    const candidate = position + result.shift
    const extension = candidate < 0 ? candidate : Math.max(0, candidate - maxPosition)
    const nextPosition = Math.max(0, candidate)
    pending = { id: message.id, frame: current, width, height, axis, position: nextPosition,
      maxPosition: Math.max(maxPosition, candidate) + Math.max(0, -candidate) }
    result.extension = extension
  }
  self.postMessage({ id: message.id, ...result })
}
