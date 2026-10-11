// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 plugins（插件）。

function renderPlugins() {
  const plugins = [
    ['ocr', 'OCR', '文本识别', '截图文字提取、二维码扫描、图片转文本的基础能力。'],
    ['translation', '译', '翻译', '文本翻译、截图识别翻译和划词翻译。'],
    ['ai', 'AI', 'AI 对话', '多轮对话、AI 翻译以及后续视觉理解扩展。'],
    ['video', 'REC', '视频录制', '区域录制、暂停预览并导出 MP4。']
  ]
  view.innerHTML = `<div class="page">${pageHeader('插件', '按需启用功能模块，保持应用轻量。')}<div class="grid">${plugins.map(([key, icon, title, description]) => `<div class="card plugin-card"><div class="plugin-icon">${icon}</div><div class="plugin-info"><h3>${title}</h3><p>${description}</p></div>${switchMarkup(settings.plugins[key], key, 'plugins')}</div>`).join('')}</div></div>`
  bindSwitches()
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderPlugins'] = () => renderPlugins()
