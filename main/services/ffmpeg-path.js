'use strict'

// Resolves the ffmpeg-static binary, rewriting to app.asar.unpacked when running
// from a packaged asar. Extracted from main.js so the packaged/unpacked rewrite
// and the missing-binary failure are unit-testable without booting Electron.
function createFfmpegPathResolver({
  loadCandidate = () => require('ffmpeg-static'),
  log = () => {},
  isPackaged = () => false
} = {}) {
  if (typeof loadCandidate !== 'function') throw new TypeError('FFmpeg resolution requires a candidate loader')
  if (typeof log !== 'function') throw new TypeError('FFmpeg resolution requires a logger')
  if (typeof isPackaged !== 'function') throw new TypeError('FFmpeg resolution requires an isPackaged probe')

  return function resolveFfmpegPath() {
    let candidate = ''
    try {
      candidate = loadCandidate()
    } catch (error) {
      log('Unable to resolve FFmpeg:', error)
    }
    if (!candidate || typeof candidate !== 'string') throw new Error('未找到 MP4 编码组件')
    return isPackaged() ? candidate.replace('app.asar', 'app.asar.unpacked') : candidate
  }
}

module.exports = { createFfmpegPathResolver }
