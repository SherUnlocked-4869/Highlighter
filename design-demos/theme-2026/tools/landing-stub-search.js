// Preload stub for the local-search window in the showcase capture.
//
// search.js needs an onInit payload to paint anything: without it the window
// stays on its empty state and the screenshot shows a blank list. The payload
// shape mirrors design-demos/tools/capture-electron.js (which is the established
// stub for this window), and the results are the same fixture rows so the two
// harnesses describe the same screen.
const { contextBridge } = require('electron')

const handlers = {}
const on = (name) => (fn) => {
  ;(handlers[name] = handlers[name] || []).push(fn)
  return () => {
    const at = (handlers[name] || []).indexOf(fn)
    if (at >= 0) handlers[name].splice(at, 1)
  }
}

const APPEARANCE = {
  language: 'zh-CN', dark: false, mainColor: '#e5a44c', theme: 'light',
}

const NOW = Date.now()
const RESULTS = {
  total: 5,
  items: [
    { name: 'Highlighter-架构说明.md', path: 'D:\\Projects\\Highlighter\\docs', fullPath: 'D:\\Projects\\Highlighter\\docs\\Highlighter-架构说明.md', extension: 'md', size: 43008, modifiedAt: NOW - 3600e3 },
    { name: 'capture-domain.test.js', path: 'D:\\Projects\\Highlighter\\test', fullPath: 'D:\\Projects\\Highlighter\\test\\capture-domain.test.js', extension: 'js', size: 18432, modifiedAt: NOW - 86400e3 },
    { name: '产品评审纪要.docx', path: 'D:\\Docs\\工作', fullPath: 'D:\\Docs\\工作\\产品评审纪要.docx', extension: 'docx', size: 129024, modifiedAt: NOW - 172800e3 },
    { name: 'screenshot-2026-03-12.png', path: 'D:\\Pictures\\Screenshots', fullPath: 'D:\\Pictures\\Screenshots\\screenshot-2026-03-12.png', extension: 'png', size: 1468006, modifiedAt: NOW - 259200e3 },
    { name: 'release-notes-0.9.md', path: 'D:\\Projects\\Highlighter', fullPath: 'D:\\Projects\\Highlighter\\release-notes-0.9.md', extension: 'md', size: 6144, modifiedAt: NOW - 432000e3 },
  ],
}

const api = {
  onInit: on('init'),
  onStatusChanged: on('status'),
  onSettingsChanged: on('settings'),
  ready() {
    setTimeout(() => {
      ;(handlers.init || []).forEach((fn) => {
        try {
          fn(Object.assign({}, APPEARANCE, {
            search: { categories: [], sortMode: 'modified-desc', pageSize: 60, maxResults: 200 },
          }))
        } catch (e) { console.error(e) }
      })
      // Type a query so the list has rows: an idle listbox screenshots as an
      // empty panel and proves nothing about the theme. The input id comes from
      // search/search.html (searchInput) — guessing 'query' left the window on its
      // empty state through the first showcase run.
      //
      // The handler debounces (runSearchDebounced), so a single set + immediate
      // capture still shows the empty state. Poll the result list instead of
      // guessing a delay: that is the actual postcondition we want in the shot.
      setTimeout(() => {
        const input = document.getElementById('searchInput')
        if (!input) return
        input.focus()
        input.value = 'doc'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const started = Date.now()
        const wait = () => {
          const rows = document.querySelectorAll('#resultList > *').length
          if (rows > 0 || Date.now() - started > 3000) {
            document.documentElement.setAttribute('data-showcase-ready', String(rows))
            return
          }
          setTimeout(wait, 100)
        }
        wait()
      }, 250)
    }, 80)
  },
  query: async () => RESULTS,
  getFileIcon: async () => null,
  revealPath: async () => {},
  openPath: async () => {},
  ensureReady: async () => ({ available: true, phase: 'ready' }),
  getStatus: async () => ({ available: true, phase: 'ready' }),
  close() {},
  hide() {},
}

contextBridge.exposeInMainWorld('searchAPI', api)
