'use strict'

function createRecognitionDomain(deps) {
  const {
    path,
    rootDirectory,
    BrowserWindow,
    clipboard,
    createLocalWindow,
    getSettings,
    dataUrlToBuffer,
    recognizeWithPerformance,
    buildTableFromOcr
  } = deps

  const recognitionWindows = new Set()

  function ownsWindow(win) {
    return recognitionWindows.has(win)
  }

  function createRecognitionWindow(type, dataUrl, options = {}) {
    if (!['table', 'qr'].includes(type)) throw new Error('不支持的识别类型')
    if (!dataUrl) throw new Error('识别图片数据为空')
    const isTable = type === 'table'
    const settings = getSettings()
    const pagePath = path.join(rootDirectory, 'recognition', 'recognition.html')
    const win = createLocalWindow(pagePath, {
      width: isTable ? 820 : 640,
      height: isTable ? 620 : 420,
      minWidth: isTable ? 600 : 480,
      minHeight: isTable ? 440 : 320,
      frame: false,
      show: false,
      backgroundColor: '#18181b',
      title: isTable ? 'Highlighter 表格识别' : 'Highlighter 二维码识别',
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-recognition.js')
      }
    })
    recognitionWindows.add(win)
    win._recognitionInit = {
      type,
      dataUrl,
      scaleFactor: Number(options.scaleFactor) || 1,
      mainColor: settings.mainColor || '#e5a44c'
    }
    win.loadFile(pagePath)
    win.on('closed', () => recognitionWindows.delete(win))
    return win
  }

  function createRecognitionController() {
    return {
      recognitionReady: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || !recognitionWindows.has(win) || !win._recognitionInit) return
        event.sender.send('recognition:init', win._recognitionInit)
        win.show()
        win.focus()
      },
      recognitionTable: async (event, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || !recognitionWindows.has(win)) throw new Error('无效的表格识别窗口')
        if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
        const dataUrl = payload?.dataUrl
        if (!dataUrl) throw new Error('表格图片数据为空')
        const settings = getSettings()
        const ocrResult = await recognizeWithPerformance(dataUrlToBuffer(dataUrl), {
          scaleFactor: payload?.scaleFactor,
          detectAngle: settings.ocr.detectAngle,
          minConfidence: settings.ocr.minConfidence
        }, 'table')
        const table = buildTableFromOcr(ocrResult, { minConfidence: settings.ocr.minConfidence })
        if (!table) throw new Error('未识别到稳定的表格结构，请扩大选区并确保至少包含两行两列')
        return table
      },
      recognitionCopy: (event, value) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || !recognitionWindows.has(win)) throw new Error('无效的识别结果窗口')
        clipboard.writeText(String(value || ''))
        return true
      },
      recognitionClose: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win && recognitionWindows.has(win) && !win.isDestroyed()) win.close()
      }
    }
  }

  return {
    ownsWindow,
    createRecognitionWindow,
    createRecognitionController
  }
}

module.exports = {
  createRecognitionDomain
}
