// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 home（快捷功能）。

const functionGroups = {
  screenshot: [
    ['screenshot', '截图', 'icons/screenshot.svg', '自由框选、智能标注与导出'],
    ['screenshotDelay', '延迟截图', 'icons/timer.svg', '倒计时后开始区域截图'],
    ['screenshotFixed', '固定到屏幕', '../capture/icons/pin.svg', '截图完成后直接贴到桌面'],
    ['screenshotOcr', '文本识别', '../capture/icons/ocr.svg', '截图后提取中文、英文等文字'],
    ['screenshotTable', '表格识别', '../capture/icons/table.svg', '恢复截图中的行列并复制到 Excel'],
    ['screenshotQr', '二维码识别', '../capture/icons/qr.svg', '扫描二维码内容或打开其中的链接'],
    ['screenshotOcrTranslate', '文本识别翻译', '../capture/icons/translate.svg', 'OCR 后调用翻译服务'],
    ['screenshotCopy', '复制到剪贴板', '../capture/icons/copy.svg', '完成选区后立即复制'],
    ['screenshotLong', '长截图', '../capture/icons/long-capture.svg', '框选滚动区域并自动拼接'],
    ['screenshotFullScreen', '截取全屏', 'icons/fullscreen.svg', '捕获鼠标所在显示器'],
    ['screenshotFocusedWindow', '当前焦点窗口', 'icons/focus.svg', '捕获当前活动窗口']
  ],
  ai: [
    ['chat', '打开 AI 对话', 'icons/robot.svg', '使用配置的 AI 模型进行多轮对话'],
    ['chatSelectText', '对话框填入选中文本', 'icons/text-style-one.svg', '保留现有划词助手工作流'],
    ['explainClipboard', '解释剪贴板文本', 'icons/robot.svg', '只读剪贴板并送入解释窗口，不写回剪贴板']
  ],
  translation: [
    ['translation', '打开翻译工具', '../capture/icons/translate.svg', '支持自动检测与中英互译'],
    ['translationSelectText', '翻译选中的文本', 'icons/translation.svg', '划词后快速翻译']
  ],
  video: [
    ['videoRecord', '视频录制', '../capture/icons/record.svg', '录制屏幕并导出 MP4 视频']
  ],
  search: [
    ['localSearch', '本地搜索', 'icons/search.svg', '使用 Everything 全盘搜索本地文件']
  ],
  other: [
    ['fixedContent', '固定本地图片', '../capture/icons/pin.svg', '选择图片并固定到桌面'],
    ['fullScreenDraw', '全屏画布', 'icons/draw.svg', '在白色全屏画布中绘制'],
    ['toggleFixedContentVisibility', '显示/隐藏所有贴图', 'icons/preview.svg', '批量控制桌面贴图'],
    ['openImageSaveFolder', '打开图片目录', 'icons/folder-open.svg', '打开默认截图保存位置'],
    ['openCaptureHistory', '打开截图历史', 'icons/history.svg', '回顾、复制和重新编辑截图'],
    ['screenshotQuickSave', '快速保存', '../capture/icons/save.svg', '完成选区后直接保存到上次的目录'],
    ['screenshotSaveAs', '另存为', '../capture/icons/save.svg', '完成选区后弹出保存对话框'],
    ['togglePinClickThrough', '取消全部穿透', '../capture/icons/pin.svg', '立即让所有贴图退出点击穿透状态']
  ]
}

let homeTab = 'screenshot'

function renderHome() {
  const tabs = [['screenshot', '截图'], ['ai', 'AI 对话'], ['translation', '翻译'], ['video', '视频录制'], ['other', '其它']]
  const rows = functionGroups[homeTab].map(([name, label, icon, description]) => {
    const shortcut = settings.shortcuts[name] || ''
    return `<div class="function-row" data-function="${name}"><span class="icon">${iconMarkup(icon)}</span><span class="label">${label}<small class="desc">${description}</small></span>${shortcutButton(name, shortcut)}</div>`
  }).join('')
  view.innerHTML = `<div class="page">${pageHeader('快捷功能', '统一管理截图、AI、翻译、录屏和桌面工具。')}<div class="tabs">${tabs.map(([key, label]) => `<button data-home-tab="${key}" class="${homeTab === key ? 'active' : ''}">${label}</button>`).join('')}</div><section class="section"><h2 class="section-title">${tabs.find(([key]) => key === homeTab)[1]}</h2><div class="function-list">${rows}</div></section></div>`
  document.querySelectorAll('[data-home-tab]').forEach((button) => button.onclick = () => { homeTab = button.dataset.homeTab; renderHome() })
  document.querySelectorAll('[data-function]').forEach((row) => row.onclick = async (event) => {
    if (event.target.closest('[data-shortcut]')) return
    let name = row.dataset.function
    if (name === 'chatSelectText') name = 'chat'
    if (name === 'translationSelectText') name = 'translation'
    try {
      if (name === 'screenshotDelay') {
        const seconds = Number(prompt('延迟秒数', '3') || 0)
        await window.electronAPI.executeFunction(name, { seconds })
        toast(`将在 ${seconds} 秒后截图`)
      } else await window.electronAPI.executeFunction(name)
    } catch (error) { toast(error.message || String(error)) }
  })
  bindShortcutRecorders()
}

function bindShortcutRecorders() {
  const keys = window.shortcutKeys
  document.querySelectorAll('[data-shortcut]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation()
      const shortcutName = button.dataset.shortcut
      const restoreLabel = () => { button.textContent = settings.shortcuts[shortcutName] || '未设置' }
      button.textContent = '请按组合键…'
      button.classList.remove('set')
      const handler = async (keyEvent) => {
        keyEvent.preventDefault(); keyEvent.stopPropagation()
        // While an input method composes, the browser reports Process /
        // Unidentified for the physical key. Recording that value is how the
        // invalid "Process" accelerator was written before, so keep waiting for
        // a usable key instead of closing the recorder.
        if (keys.isIgnoredRecordingEvent(keyEvent)) return
        if (keyEvent.key === 'Escape') { restoreLabel(); cleanup(); return }
        if (keys.isModifierOnlyKey(keyEvent.key)) return
        const accelerator = keys.acceleratorFromKeyboardEvent(keyEvent)
        if (!accelerator || !keys.isRecordableShortcut(accelerator)) {
          cleanup()
          restoreLabel()
          toast(keys.describeShortcutRejection(accelerator || keyEvent.key))
          return
        }
        const shortcuts = { ...settings.shortcuts, [shortcutName]: accelerator }
        try {
          await updateSettings({ shortcuts }, '')
        } catch (error) {
          cleanup()
          restoreLabel()
          toast(errorMessage(error))
          return
        }
        const presentation = shortcutPresentation(shortcutName, accelerator)
        cleanup()
        renderRoute()
        toast(presentation.message || '快捷键已更新')
      }
      const cleanup = () => window.removeEventListener('keydown', handler, true)
      window.addEventListener('keydown', handler, true)
    }
    button.oncontextmenu = async (event) => {
      event.preventDefault(); event.stopPropagation()
      const shortcuts = { ...settings.shortcuts, [button.dataset.shortcut]: '' }
      await updateSettings({ shortcuts }, '快捷键已清除'); renderRoute()
    }
  })
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderHome'] = () => renderHome()
