const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { createSecureWindow } = require('../main/services/window-security')

const resultPrefix = 'HIGHLIGHTER_ACTION_SECURITY_PROBE='
const userDataPath = process.env.HIGHLIGHTER_ACTION_SECURITY_USER_DATA
if (userDataPath) app.setPath('userData', userDataPath)

let probeFinished = false

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(check, description, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check()
    if (result) return result
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function runProbe() {
  const openedUrls = []
  const streamSignals = []
  const blocked = []
  ipcMain.handle('shell:open-external', (_event, url) => {
    openedUrls.push(url)
    return true
  })
  ipcMain.on('stream:cancel', (_event, streamId) => streamSignals.push({ channel: 'cancel', streamId }))
  ipcMain.on('stream:finish', (_event, streamId) => streamSignals.push({ channel: 'finish', streamId }))
  ipcMain.on('window:toggle-pin', () => {})

  const pagePath = path.join(__dirname, '..', 'action', 'action.html')
  const win = createSecureWindow({
    BrowserWindow,
    pagePath,
    options: {
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload-action.js') }
    },
    onBlocked: (entry) => blocked.push(entry)
  })
  await win.loadFile(pagePath)

  const bridge = await win.webContents.executeJavaScript(`({
    actionKeys: Object.keys(window.actionAPI || {}).sort(),
    broadApiType: typeof window.electronAPI,
    requireType: typeof window.require,
    domPurifyType: typeof window.DOMPurify
  })`)
  const preferences = win.webContents.getLastWebPreferences()

  win.webContents.send('action:start', {
    type: 'explain',
    label: '安全测试',
    icon: '✦',
    text: 'source',
    streamId: 7,
    appearance: { theme: 'dark', mainColor: '#336699' }
  })
  win.webContents.send('stream:data', {
    content: '<img src=x onerror="window.__actionXss = true"> [bad](javascript:alert(1)) [good](https://example.com/safe?q=1&ok=2)'
  })
  win.webContents.send('stream:done')

  const rendered = await waitFor(
    () => win.webContents.executeJavaScript(`(() => {
      const result = document.getElementById('result')
      const link = result.querySelector('a')
      if (!link) return null
      return {
        html: result.innerHTML,
        text: result.textContent,
        links: [...result.querySelectorAll('a')].map((item) => ({
          href: item.href,
          rel: item.rel,
          target: item.target
        })),
        imageCount: result.querySelectorAll('img').length,
        scriptCount: result.querySelectorAll('script').length,
        xssExecuted: window.__actionXss === true
      }
    })()`),
    'sanitized action result'
  )

  await win.webContents.executeJavaScript(`document.querySelector('#result a').click()`)
  await waitFor(() => Promise.resolve(openedUrls.length > 0), 'main-process external link handoff')

  const childWindowResult = await win.webContents.executeJavaScript(`window.open('https://blocked.example/new') === null`)
  await waitFor(() => Promise.resolve(blocked.some((entry) => entry.reason === 'blocked-window-open')), 'blocked child window')

  await win.webContents.executeJavaScript(`window.location.href = 'https://blocked.example/navigation'`)
  await waitFor(() => Promise.resolve(blocked.some((entry) => entry.reason === 'blocked-navigation')), 'blocked navigation')
  const finalUrl = win.webContents.getURL()

  win.destroy()
  return {
    bridge,
    preferences: {
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      sandbox: preferences.sandbox,
      webSecurity: preferences.webSecurity,
      webviewTag: preferences.webviewTag
    },
    rendered,
    openedUrls,
    streamSignals,
    childWindowResult,
    blocked,
    finalUrl
  }
}

const probeTimeout = setTimeout(() => {
  if (probeFinished) return
  console.error('Action security probe timed out')
  app.exit(1)
}, 30000)

app.on('window-all-closed', () => {})
app.whenReady()
  .then(runProbe)
  .then((result) => {
    probeFinished = true
    clearTimeout(probeTimeout)
    console.log(`${resultPrefix}${JSON.stringify(result)}`)
    app.quit()
  })
  .catch((error) => {
    probeFinished = true
    clearTimeout(probeTimeout)
    console.error(error?.stack || error)
    app.exit(1)
  })
