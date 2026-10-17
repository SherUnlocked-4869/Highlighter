'use strict'
// Reuse the empty history window without querying history or stealing focus.
function createPasteFeedback({ getWindow, screen, expire }) {
  let timer = null; let bounds = null; let minimum = null; let active = false
  function clear(restore = true) {
    clearTimeout(timer); timer = null
    const win = getWindow()
    if (restore && bounds && win && !win.isDestroyed()) {
      win.setFocusable(true); win.setMinimumSize(...minimum); win.setBounds(bounds)
    }
    bounds = null; minimum = null; active = false
  }
  function show(data) {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    clear()
    bounds = win.getBounds(); minimum = win.getMinimumSize(); active = true
    const area = screen.getDisplayMatching(bounds).workArea
    const width = Math.min(bounds.width, area.width); const height = Math.min(148, area.height)
    win.setFocusable(false); win.setMinimumSize(1, 1)
    win.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) })
    win.webContents.send('clipboard:paste-result', data)
    win.showInactive()
    timer = setTimeout(() => { if (active && getWindow() === win) expire() }, 4000)
    timer.unref?.()
  }
  return { show, clear, get active() { return active } }
}
module.exports = { createPasteFeedback }
