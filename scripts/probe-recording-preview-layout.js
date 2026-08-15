const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')

const resultPrefix = 'HIGHLIGHTER_RECORDING_LAYOUT_PROBE='

app.commandLine.appendSwitch('force-device-scale-factor', '1.5')

async function runProbe() {
  const videoPaths = JSON.parse(process.env.HIGHLIGHTER_RECORDING_LAYOUT_VIDEOS || '[]')
  if (videoPaths.length !== 2) throw new Error('Recording layout probe requires two video fixtures')
  const videoUrls = videoPaths.map((value) => pathToFileURL(value).href)
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-record.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'record', 'record.html'))
  const result = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('controlView').hidden = true
    document.getElementById('previewView').hidden = false
    const videoUrls = ${JSON.stringify(videoUrls)}

    async function inspect(url, label) {
      const preview = document.getElementById('preview')
      preview.src = url
      preview.load()
      await new Promise((resolve, reject) => {
        if (preview.readyState >= 1) return resolve()
        preview.addEventListener('loadedmetadata', resolve, { once: true })
        preview.addEventListener('error', () => reject(new Error('Preview metadata failed')), { once: true })
      })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const stage = document.querySelector('.video-stage').getBoundingClientRect()
      const video = preview.getBoundingClientRect()
      const save = document.getElementById('saveMp4').getBoundingClientRect()
      const footer = document.querySelector('.preview-actions').getBoundingClientRect()
      const hit = document.elementFromPoint(save.x + save.width / 2, save.y + save.height / 2)
      return {
        source: label,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        bodyScrollHeight: document.body.scrollHeight,
        stage: { top: stage.top, bottom: stage.bottom },
        video: { top: video.top, bottom: video.bottom },
        footer: { top: footer.top, bottom: footer.bottom },
        save: { top: save.top, bottom: save.bottom },
        saveHitTarget: hit?.id || ''
      }
    }

    return {
      landscape: await inspect(videoUrls[0], '4:3'),
      square: await inspect(videoUrls[1], '1:1')
    }
  })()`)

  console.log(`${resultPrefix}${JSON.stringify(result)}`)
  win.destroy()
}

app.whenReady()
  .then(runProbe)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
