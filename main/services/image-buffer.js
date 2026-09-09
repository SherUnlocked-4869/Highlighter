// Shared PNG data-URL <-> Buffer conversion.
//
// The main process and HistoryService previously each carried their own copy
// of this regex and prefix, which had to stay in sync by convention.

const DATA_URL_PREFIX = 'data:image/png;base64,'
const DATA_URL_PATTERN = /^data:image\/[^;]+;base64,/

function imageDataToBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value.replace(DATA_URL_PATTERN, ''), 'base64')
  return Buffer.alloc(0)
}

function dataUrlToBuffer(dataUrl) {
  return imageDataToBuffer(dataUrl)
}

function bufferToDataUrl(value) {
  return `${DATA_URL_PREFIX}${imageDataToBuffer(value).toString('base64')}`
}

module.exports = {
  DATA_URL_PATTERN,
  DATA_URL_PREFIX,
  bufferToDataUrl,
  dataUrlToBuffer,
  imageDataToBuffer
}
