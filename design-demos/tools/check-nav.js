// Focused check: after navigating, exactly one nav item may be active, and the
// status rail must reflect the route it is showing.
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '../..')
const SETTINGS = {
  theme: 'light', mainColor: '#e5a44c', borderRadius: 9, compact: false,
  providers: [{ id: 'deepseek', name: 'DeepSeek', enabled: true, hasApiKey: true, builtin: true,
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
  ai: { assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-chat' }] },
  shortcuts: { screenshot: 'Alt+A' },
  ocr: { modelProfile: 'ppocr-v4-ch' },
  screenshot: {}, record: {}, search: {}, system: {}, plugins: {}
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const stubPath = path.join(app.getPath('temp'), 'hl-nav-stub.js')
  fs.writeFileSync(stubPath, `
    const s = ${JSON.stringify(SETTINGS)}
    window.electronAPI = new Proxy({
      getSettings: async () => s, resetSettings: async () => s,
      getShortcutStatuses: async () => ({}),
      getSearchStatus: async () => ({ running: true, available: true, ipcAvailable: true, phase: 'ready' }),
      getOcrStatus: async () => ({ available: true, phase: 'ready' }),
      updateSettings: async (p) => Object.assign(s, p || {})
    }, { get(t, p) { return p in t ? t[p] : () => Promise.resolve(undefined) }, has: () => true })
  `)

  const win = new BrowserWindow({ show: false, width: 1180, height: 760,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, preload: stubPath } })
  await win.loadFile(path.join(ROOT, 'config/config.html'))
  await new Promise((r) => setTimeout(r, 900))

  // Freeze transitions: a hidden window renders frames slowly enough that a
  // 0.13s transition can still be in flight when we read computed styles.
  await win.webContents.executeJavaScript(
    `(() => { const s = document.createElement('style'); s.textContent = '*{transition:none !important;animation:none !important}'; document.head.appendChild(s); return 'frozen' })()`)
  await new Promise((r) => setTimeout(r, 200))

  const routes = ['home', 'settings-hotkeys', 'models', 'settings-function', 'history', 'appearance', 'settings-system', 'about']
  const lines = []
  for (const route of routes) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.nav-item[data-route="${route}"]').click()`)
    await new Promise((r) => setTimeout(r, 500))
    const out = await win.webContents.executeJavaScript(`(() => {
      const active = [...document.querySelectorAll('.nav-item.active')].map(b => b.dataset.route)
      const painted = []
      for (const b of document.querySelectorAll('.nav-item')) {
        const bg = getComputedStyle(b).backgroundColor
        if (bg && !bg.startsWith('rgba(0, 0, 0, 0)')) painted.push(b.dataset.route)
      }
      const rail = document.getElementById('statusRail')
      return {
        active, painted,
        title: document.getElementById('pageTitle').textContent,
        railVisible: rail ? !rail.hidden : null,
        railCells: rail ? rail.querySelectorAll('.cell').length : 0
      }
    })()`)
    const ok = out.active.length === 1 && out.active[0] === route
    const paintOk = out.painted.length === 1 && out.painted[0] === route
    lines.push(`${ok && paintOk ? 'ok  ' : 'FAIL'} ${route.padEnd(18)} title=${String(out.title).padEnd(8)} active=${JSON.stringify(out.active)} painted=${JSON.stringify(out.painted)} rail=${out.railVisible}/${out.railCells}`)
  }
  fs.writeFileSync(path.join(ROOT, 'design-demos/shots/surfaces/NAV.txt'), lines.join('\n'))
  console.log(lines.join('\n'))
  win.destroy()
  app.quit()
})
