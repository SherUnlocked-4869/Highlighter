'use strict'

const path = require('node:path')

function captureForeground({ execFile, dirname, packaged }) {
  const helper = path.join(dirname, 'native', 'focused-window', ...(packaged ? [] : ['bin']), 'HighlighterFocusedWindow.exe')
  return new Promise((resolve) => {
    execFile(helper, [], { windowsHide: true, timeout: 4000, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0)
      const newline = bytes.indexOf(10)
      const header = newline >= 0 && bytes.subarray(0, newline).toString('ascii').trim()
      const match = header && /^(-?\d+) (window|protected)$/.exec(header)
      resolve({
        windowId: match && match[1] !== '0' ? match[1] : null,
        protected: match?.[2] === 'protected',
        imageBuffer: !error && match && bytes.length > newline + 1 ? bytes.subarray(newline + 1) : null
      })
    })
  })
}

module.exports = { captureForeground }
