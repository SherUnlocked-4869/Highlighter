// Capture file naming convention, shared by the main process (writers) and
// HistoryService (which must recognize files it owns).
//
// The forward generator and the reverse matcher previously lived in different
// files and were kept in sync only by convention.

const CAPTURE_PREFIX = 'Highlighter'
const LONG_CAPTURE_PREFIX = 'Highlighter_Long'
const VIDEO_CAPTURE_PREFIX = 'Highlighter_Video'

// Matches only still captures; video exports deliberately fall outside it.
const OWNED_CAPTURE_FILE = /^Highlighter(?:_Long)?_\d{4}-\d{2}-\d{2}_[\d-]+\.png$/i
const OWNED_THUMBNAIL_FILE = /^\d{10,}-[a-z0-9]+-thumb\.png$/i

function makeCaptureName(prefix = CAPTURE_PREFIX) {
  // 使用中国时区(UTC+8)的墙钟时间命名,便于直接按本地时间识别截图
  const stamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${prefix}_${stamp}.png`
}

module.exports = {
  CAPTURE_PREFIX,
  LONG_CAPTURE_PREFIX,
  VIDEO_CAPTURE_PREFIX,
  OWNED_CAPTURE_FILE,
  OWNED_THUMBNAIL_FILE,
  makeCaptureName
}
