// Preload stub for the selection toolbar and the clipboard panel.
//
// Both are frameless floating surfaces whose styling lives in the HTML/CSS of
// their own window (toolbar.html's inline <style>, clipboard/clipboard.css), and
// the product deliberately keeps them dark regardless of the app theme. A theme
// direction still has to carry them: they consume --primary, --radius, the type
// stack and the accent. This stub gives each window just enough to paint.
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
  language: 'zh-CN', dark: false, mainColor: '#e5a44c',
  theme: 'light', generation: 'landing-preview',
}

// ── selection toolbar ────────────────────────────────────────────────────────
// toolbar.js touches exactly four members (verified by grepping the renderer:
// toolbarAPI.action / onAppearance / onInterfaceLanguage / onSelection). Every
// one must exist before the first paint or the strip stays empty: the renderer
// died on `onInterfaceLanguage is not a function` and rendered nothing at all.
const toolbarApi = {
  onAppearance: on('appearance'),
  onSelection: on('selection'),
  onInterfaceLanguage: on('interfaceLanguage'),
  action() {},
  // toolbar.js NEVER calls ready(): the real main process pushes the selection as
  // soon as it knows the window is up, so there is no handshake on this side
  // (grepped the renderer — only onAppearance / onSelection / action /
  // onInterfaceLanguage exist). Fire the payload on a timer instead of waiting for
  // a ready() that never comes; the first version sat in ready() and the strip
  // stayed empty forever.
  _kick: setTimeout(() => {
    ;(handlers.appearance || []).forEach((fn) => { try { fn(APPEARANCE) } catch (e) { console.error(e) } })
    ;(handlers.selection || []).forEach((fn) => {
      try {
        fn({
          appearance: APPEARANCE,
          text: 'Ship a calmer capture tool for Windows — fewer chrome, more focus.',
          // Labels are i18n KEYS in the real payload (toolbar-action-meta.js); the
          // renderer runs them through t(). Handing it display text would print it
          // verbatim, which happens to work but stops matching production.
          actions: [
            { id: 'copy', label: 'toolbar.action.copy.label', icon: 'copy' },
            { id: 'search', label: 'toolbar.action.search.label', icon: 'search' },
            { id: 'translate', label: 'toolbar.action.translate.label', icon: 'translate' },
            { id: 'explain', label: 'toolbar.action.explain.label', icon: 'lightbulb' },
            { id: 'open', label: 'toolbar.action.open.label', icon: 'box-arrow-up-right' },
          ],
        })
      } catch (e) { console.error(e) }
    })
  }, 220),
    // The selection path is driven by _kick above; ready() is a no-op here because
  // toolbar.js never calls it. The clipboard panel (which DOES call ready()) has
  // its own handshake in clipboardApi.ready below.
  ready() {},
  resize() {},
  copy() {},
  search() {},
  translate() {},
  explain() {},
  open() {},
  dismiss() {},
  action() {},
}

// ── clipboard panel ──────────────────────────────────────────────────────────
const NOW = Date.now()
const STATUS = {
  enabled: true, userPaused: false, available: true, phase: 'running', pausedReasons: [],
  datasetId: 'landing', revision: 12, itemCount: 42, pinnedCount: 3,
  payloadBytes: 1048576, actualDiskBytes: 12976128, pendingGcBytes: 0,
}
const ITEMS = [
  { id: 'r1', kind: 'text', isPinned: true, previewText: '把这段关于暗色模式对比度的评审意见整理成一页要点，明早发给设计组。', sourceDisplayName: '微信', lastCopiedAt: NOW - 3 * 60e3, lastUsedAt: NOW - 2 * 60e3, byteLength: 114 },
  { id: 'r2', kind: 'url', isPinned: false, previewText: 'https://github.com/highlighter-app/highlighter/pull/1287', sourceDisplayName: 'Google Chrome', lastCopiedAt: NOW - 8 * 60e3, lastUsedAt: NOW - 6 * 60e3, byteLength: 62 },
  { id: 'r3', kind: 'text', isPinned: false, previewText: 'npm run verify:all 通过后再合并 #1287，避免夜间回归。', sourceDisplayName: 'Visual Studio Code', lastCopiedAt: NOW - 20 * 60e3, lastUsedAt: NOW - 18 * 60e3, byteLength: 78 },
  { id: 'r4', kind: 'text', isPinned: false, previewText: '小鹿：周五的评审改到 14:30，会议室 3F-北。', sourceDisplayName: '微信', lastCopiedAt: NOW - 35 * 60e3, lastUsedAt: NOW - 35 * 60e3, byteLength: 69 },
]

const clipboardApi = {
  onInit: on('init'),
  onStatus: on('status'),
  onHistory: on('history'),
  onHidden: on('hidden'),
  onPasteResult: on('pasteResult'),
  onLanguage: on('language'),
  ready() {
    setTimeout(() => {
      ;(handlers.init || []).forEach((fn) => { try { fn(Object.assign({}, APPEARANCE, { status: STATUS })) } catch (e) { console.error(e) } })
    }, 60)
  },
  interactive() {},
  close() {},
  list: async () => ({ ok: true, result: { items: ITEMS, cursor: null } }),
  status: async () => ({ ok: true, result: STATUS }),
  detail: async (id) => ({ ok: true, result: { kind: 'text', truncated: false, text: (ITEMS.find((i) => i.id === id) || {}).previewText || '' } }),
  previews: async (ids) => ({ ok: true, result: ids.map((id) => ({ id, url: null })) }),
  setPaused: async () => ({ ok: true, result: STATUS }),
  copy: async () => ({ ok: true, result: {} }),
  paste: async () => ({ ok: true, result: { copied: true, outcome: 'copiedOnly' } }),
  setPinned: async () => ({ ok: true, result: {} }),
  delete: async () => ({ ok: true, result: {} }),
  prepareClear: async () => ({ ok: true, result: { canceled: true } }),
  commitClear: async () => ({ ok: true, result: {} }),
}

contextBridge.exposeInMainWorld('toolbarAPI', toolbarApi)
contextBridge.exposeInMainWorld('clipboardAPI', clipboardApi)
