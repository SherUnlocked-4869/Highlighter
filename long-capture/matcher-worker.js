importScripts('matcher.js')

let previous = null
let width = 0
let height = 0
let axis = 'vertical'

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'reset') {
    previous = null
    width = 0
    height = 0
    return
  }
  if (message.type !== 'frame') return

  const current = LongCaptureMatcher.toGrayscale(new Uint8ClampedArray(message.rgba))
  if (!previous || width !== message.width || height !== message.height || axis !== message.axis) {
    previous = current
    width = message.width
    height = message.height
    axis = message.axis
    self.postMessage({ id: message.id, status: 'initialized' })
    return
  }

  const result = LongCaptureMatcher.findBestShift(previous, current, width, height, axis)
  if (result.status === 'matched') previous = current
  self.postMessage({ id: message.id, ...result })
}
