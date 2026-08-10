const fs = require('node:fs')
const path = require('node:path')
const { app, crashReporter, dialog } = require('electron')

const resultPrefix = 'HIGHLIGHTER_DIAGNOSTICS_RUNTIME_PROBE='
const userDataPath = process.env.HIGHLIGHTER_DIAGNOSTICS_USER_DATA
const outputPath = process.env.HIGHLIGHTER_DIAGNOSTICS_OUTPUT
if (!userDataPath || !outputPath) throw new Error('Diagnostics runtime probe paths are required')

fs.mkdirSync(userDataPath, { recursive: true })
app.setPath('userData', userDataPath)
app.setPath('sessionData', path.join(userDataPath, 'session-data'))
app.setLoginItemSettings = () => {}
dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath })

const shortcutNames = [
  'screenshot', 'screenshotDelay', 'screenshotFixed', 'screenshotOcr', 'screenshotTable', 'screenshotQr',
  'screenshotOcrTranslate', 'screenshotCopy', 'screenshotFullScreen', 'screenshotFocusedWindow', 'screenshotLong',
  'translationSelectText', 'chatSelectText', 'videoRecord', 'fullScreenDraw', 'toggleFixedContentVisibility',
  'showOrHideMainWindow', 'openCaptureHistory'
]
fs.writeFileSync(path.join(userDataPath, 'config.json'), JSON.stringify({
  settings: {
    system: { autoStart: false, runLog: true, enableTray: false },
    plugins: { ocr: false, translation: true, ai: true, video: true },
    selectionToolbar: { enabled: false },
    shortcuts: Object.fromEntries(shortcutNames.map((name) => [name, '']))
  }
}))

let finished = false
let running = false
const timeout = setTimeout(() => {
  if (finished) return
  console.error('Diagnostics runtime probe timed out')
  app.exit(1)
}, 30000)

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    if (running || !win.webContents.getURL().endsWith('/config/config.html')) return
    running = true
    try {
      const renderer = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = async (check, description) => {
          const startedAt = Date.now()
          while (Date.now() - startedAt < 15000) {
            const value = check()
            if (value) return value
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          throw new Error('Timed out waiting for ' + description)
        }
        let lastRouteClickAt = 0
        const previewButton = await waitFor(() => {
          const button = document.getElementById('previewDiagnostics')
          if (button) return button
          if (Date.now() - lastRouteClickAt >= 200) {
            lastRouteClickAt = Date.now()
            document.querySelector('[data-route="settings-system"]').click()
          }
          return null
        }, 'diagnostics settings')
        previewButton.click()
        const previewElement = await waitFor(() => {
          const element = document.getElementById('diagnosticsPreview')
          return element && !element.hidden && !previewButton.disabled ? element : null
        }, 'diagnostics preview')
        const preview = JSON.parse(previewElement.textContent)
        const exportButton = document.getElementById('exportDiagnostics')
        exportButton.click()
        await waitFor(() => !exportButton.disabled && exportButton.textContent === '导出 ZIP', 'diagnostics export')
        return {
          apiKeys: Object.keys(window.electronAPI).filter((key) => key.includes('Diagnostics')).sort(),
          preview,
          exportCompleted: true
        }
      })()`)
      finished = true
      clearTimeout(timeout)
      console.log(`${resultPrefix}${JSON.stringify({
        crashUploadEnabled: crashReporter.getUploadToServer(),
        renderer
      })}`)
      app.quit()
    } catch (error) {
      finished = true
      clearTimeout(timeout)
      console.error(error?.stack || error)
      app.exit(1)
    }
  })
})

require('../main')
