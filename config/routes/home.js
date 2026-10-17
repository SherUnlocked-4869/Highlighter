// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 home（快捷功能）。

const functionGroups = {
  screenshot: [
    ['screenshot', 'config.function.screenshot', 'icons/screenshot.svg', 'config.function.screenshot-description'],
    ['screenshotDelay', 'config.function.screenshot-delay', 'icons/timer.svg', 'config.function.screenshot-delay-description'],
    ['screenshotFixed', 'config.function.screenshot-fixed', '../capture/icons/pin.svg', 'config.function.screenshot-fixed-description'],
    ['screenshotOcr', 'config.function.screenshot-ocr', '../capture/icons/ocr.svg', 'config.function.screenshot-ocr-description'],
    ['screenshotTable', 'config.function.screenshot-table', '../capture/icons/table.svg', 'config.function.screenshot-table-description'],
    ['screenshotQr', 'config.function.screenshot-qr', '../capture/icons/qr.svg', 'config.function.screenshot-qr-description'],
    ['screenshotOcrTranslate', 'config.function.screenshot-ocr-translate', '../capture/icons/translate.svg', 'config.function.screenshot-ocr-translate-description'],
    ['screenshotCopy', 'config.function.screenshot-copy', '../capture/icons/copy.svg', 'config.function.screenshot-copy-description'],
    ['screenshotLong', 'config.function.screenshot-long', '../capture/icons/long-capture.svg', 'config.function.screenshot-long-description'],
    ['screenshotFullScreen', 'config.function.screenshot-full-screen', 'icons/fullscreen.svg', 'config.function.screenshot-full-screen-description'],
    ['screenshotFocusedWindow', 'config.function.screenshot-focused-window', 'icons/focus.svg', 'config.function.screenshot-focused-window-description']
  ],
  ai: [
    ['chat', 'config.function.chat', 'icons/robot.svg', 'config.function.chat-description'],
    ['chatSelectText', 'config.function.chat-select-text', 'icons/text-style-one.svg', 'config.function.chat-select-text-description'],
    ['explainClipboard', 'config.function.explain-clipboard', 'icons/robot.svg', 'config.function.explain-clipboard-description']
  ],
  translation: [
    ['translation', 'config.function.translation', '../capture/icons/translate.svg', 'config.function.translation-description'],
    ['translationSelectText', 'config.function.translation-select-text', 'icons/translation.svg', 'config.function.translation-select-text-description']
  ],
  video: [
    ['videoRecord', 'config.function.video-record', '../capture/icons/record.svg', 'config.function.video-record-description']
  ],
  search: [
    ['localSearch', 'config.function.local-search', 'icons/search.svg', 'config.function.local-search-description']
  ],
  other: [
    ['fixedContent', 'config.function.fixed-content', '../capture/icons/pin.svg', 'config.function.fixed-content-description'],
    ['fullScreenDraw', 'config.function.full-screen-draw', 'icons/draw.svg', 'config.function.full-screen-draw-description'],
    ['toggleFixedContentVisibility', 'config.function.toggle-fixed-content-visibility', 'icons/preview.svg', 'config.function.toggle-fixed-content-visibility-description'],
    ['openImageSaveFolder', 'config.function.open-image-save-folder', 'icons/folder-open.svg', 'config.function.open-image-save-folder-description'],
    ['openCaptureHistory', 'config.function.open-capture-history', 'icons/history.svg', 'config.function.open-capture-history-description'],
    ['screenshotQuickSave', 'config.function.screenshot-quick-save', '../capture/icons/save.svg', 'config.function.screenshot-quick-save-description'],
    ['screenshotSaveAs', 'config.function.screenshot-save-as', '../capture/icons/save.svg', 'config.function.screenshot-save-as-description'],
    ['togglePinClickThrough', 'config.function.toggle-pin-click-through', '../capture/icons/pin.svg', 'config.function.toggle-pin-click-through-description'],
    ['toggleTranslationProxy', 'config.function.toggle-translation-proxy', 'icons/lightning.svg', 'config.function.toggle-translation-proxy-description']
  ]
}

let homeTab = 'screenshot'

function renderHome() {
  const tabs = [['screenshot', 'config.group.screenshot'], ['ai', 'config.group.ai'], ['translation', 'config.group.translation'], ['video', 'config.group.video'], ['other', 'config.group.other']]
  const rows = functionGroups[homeTab].map(([name, label, icon, description]) => {
    const shortcut = settings.shortcuts[name] || ''
    return `<div class="function-row" data-function="${name}"><span class="icon">${iconMarkup(icon)}</span><span class="label">${t(label)}<small class="desc">${t(description)}</small></span>${shortcutButton(name, shortcut)}</div>`
  }).join('')
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.home'), t('config.home.description'))}<div class="tabs">${tabs.map(([key, label]) => `<button data-home-tab="${key}" class="${homeTab === key ? 'active' : ''}">${t(label)}</button>`).join('')}</div><section class="section"><h2 class="section-title">${t(tabs.find(([key]) => key === homeTab)[1])}</h2><div class="function-list">${rows}</div></section></div>`
  document.querySelectorAll('[data-home-tab]').forEach((button) => button.onclick = () => { homeTab = button.dataset.homeTab; renderHome() })
  document.querySelectorAll('[data-function]').forEach((row) => row.onclick = async (event) => {
    if (event.target.closest('[data-shortcut]')) return
    let name = row.dataset.function
    if (name === 'chatSelectText') name = 'chat'
    if (name === 'translationSelectText') name = 'translation'
    try {
      if (name === 'screenshotDelay') {
        const seconds = Number(prompt(t('config.home.delay-prompt'), '3') || 0)
        await window.electronAPI.executeFunction(name, { seconds })
        toast(t('config.home.delay-toast', { seconds }))
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
      const restoreLabel = () => { button.textContent = settings.shortcuts[shortcutName] || t('config.shortcut.unset') }
      button.textContent = t('config.shortcut.recording')
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
        toast(presentation.message || t('config.shortcut.updated'))
      }
      const cleanup = () => window.removeEventListener('keydown', handler, true)
      window.addEventListener('keydown', handler, true)
    }
    button.oncontextmenu = async (event) => {
      event.preventDefault(); event.stopPropagation()
      const shortcuts = { ...settings.shortcuts, [button.dataset.shortcut]: '' }
      await updateSettings({ shortcuts }, t('config.shortcut.cleared')); renderRoute()
    }
  })
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderHome'] = () => renderHome()
