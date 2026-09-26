const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { createSecureIpcMain } = require('../main/services/ipc-security')
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
  const chatAsks = []
  const copyRequests = []
  const blocked = []
  let actionWindow = null
  const secureIpcMain = createSecureIpcMain({
    ipcMain,
    BrowserWindow,
    rootDirectory: path.join(__dirname, '..'),
    authorizeRole: (role, win) => role === 'action' && win === actionWindow
  })
  secureIpcMain.handle('shell:open-external', (_event, url) => {
    openedUrls.push(url)
    return true
  })
  secureIpcMain.handle('chat:copy', (_event, text) => {
    copyRequests.push(typeof text === 'string' ? text.length : null)
    return true
  })
  secureIpcMain.on('stream:cancel', (_event, streamId) => streamSignals.push({ channel: 'cancel', streamId }))
  secureIpcMain.on('stream:finish', (_event, streamId) => streamSignals.push({ channel: 'finish', streamId }))
  secureIpcMain.on('window:toggle-pin', () => {})
  secureIpcMain.on('chat:ask', (event, payload) => {
    chatAsks.push(payload)
    if (payload?.streamId !== 7) return
    event.sender.send('chat:turn', { streamId: payload.streamId, question: payload.question, omittedPairs: 2 })
    event.sender.send('stream:data', {
      content: '<img src=x onerror="window.__actionXssFollowUp = true"> [bad](javascript:alert(2)) [good](https://example.com/follow?x=1&y=2)'
    })
    event.sender.send('stream:done')
  })

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
  actionWindow = win
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
    appearance: { theme: 'dark', mainColor: '#336699' },
    followUp: { enabled: true, disabledReason: '', maxTurns: 10, questionMaxLength: 2000 }
  })
  win.webContents.send('stream:data', {
    content: '<img src=x onerror="window.__actionXss = true"> [bad](javascript:alert(1)) [good](https://example.com/safe?q=1&ok=2)'
  })
  win.webContents.send('stream:done')

  const rendered = await waitFor(
    () => win.webContents.executeJavaScript(`(() => {
      const answer = document.querySelector('#transcript .turn-assistant .answer')
      if (!answer) return null
      const link = answer.querySelector('a')
      if (!link) return null
      return {
        html: answer.innerHTML,
        text: answer.textContent,
        links: [...answer.querySelectorAll('a')].map((item) => ({
          href: item.href,
          rel: item.rel,
          target: item.target
        })),
        imageCount: answer.querySelectorAll('img').length,
        scriptCount: answer.querySelectorAll('script').length,
        xssExecuted: window.__actionXss === true
      }
    })()`),
    'sanitized action result'
  )

  await win.webContents.executeJavaScript(`document.querySelector('#transcript .turn-assistant .answer a').click()`)
  await waitFor(() => Promise.resolve(openedUrls.length > 0), 'main-process external link handoff')

  const followUpAsked = await win.webContents.executeJavaScript(`window.actionAPI.askQuestion(7, '追问 <b>内容</b>')`)
  const retryAsked = await win.webContents.executeJavaScript(`window.actionAPI.askQuestion(7, '再生成一次', true)`)
  const retryRefused = await win.webContents.executeJavaScript(`window.actionAPI.askQuestion(7, '', true)`)
  const followUp = await waitFor(
    () => win.webContents.executeJavaScript(`(() => {
      const transcript = document.getElementById('transcript')
      const answers = transcript.querySelectorAll('.turn-assistant .answer')
      if (answers.length < 2) return null
      const answer = answers[1]
      const link = answer.querySelector('a')
      if (!link) return null
      return {
        html: answer.innerHTML,
        text: answer.textContent,
        links: [...answer.querySelectorAll('a')].map((item) => ({
          href: item.href,
          rel: item.rel,
          target: item.target
        })),
        imageCount: answer.querySelectorAll('img').length,
        scriptCount: answer.querySelectorAll('script').length,
        xssExecuted: window.__actionXssFollowUp === true,
        questionText: transcript.querySelector('.turn-user .bubble')?.textContent || '',
        questionMarkup: transcript.querySelector('.turn-user .bubble')?.innerHTML || '',
        noticeText: answers[1].closest('.turn-assistant')?.querySelector('.turn-notice')?.textContent || '',
        firstRoundNotice: answers[0].closest('.turn-assistant')?.querySelector('.turn-notice')?.textContent || ''
      }
    })()`),
    'sanitized follow-up answer'
  )

  const childWindowResult = await win.webContents.executeJavaScript(`window.open('https://blocked.example/new') === null`)
  await waitFor(() => Promise.resolve(blocked.some((entry) => entry.reason === 'blocked-window-open')), 'blocked child window')

  // The renderer-side clamp is the only thing that can keep an oversized
  // transcript from reaching the main process, so assert what arrives there.
  const copyOversized = await win.webContents.executeJavaScript(`window.actionAPI.copyConversation('x'.repeat(70000))`)
  const copyEmpty = await win.webContents.executeJavaScript(`window.actionAPI.copyConversation('')`)
  const copyNonString = await win.webContents.executeJavaScript(`window.actionAPI.copyConversation(42)`)

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
    followUpAsked,
    retryAsked,
    retryRefused,
    followUp,
    openedUrls,
    streamSignals,
    chatAsks,
    copyRequests,
    copyOversized,
    copyEmpty,
    copyNonString,
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
