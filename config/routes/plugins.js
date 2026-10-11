// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 plugins（插件）。

function renderPlugins() {
  const plugins = [
    ['ocr', 'OCR', 'config.plugin.ocr-title', 'config.plugin.ocr-description'],
    ['translation', '译', 'config.plugin.translation-title', 'config.plugin.translation-description'],
    ['ai', 'AI', 'config.plugin.ai-title', 'config.plugin.ai-description'],
    ['video', 'REC', 'config.plugin.video-title', 'config.plugin.video-description']
  ]
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.plugins'), t('config.plugins.description'))}<div class="grid">${plugins.map(([key, icon, title, description]) => `<div class="card plugin-card"><div class="plugin-icon">${icon}</div><div class="plugin-info"><h3>${t(title)}</h3><p>${t(description)}</p></div>${switchMarkup(settings.plugins[key], key, 'plugins')}</div>`).join('')}</div></div>`
  bindSwitches()
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderPlugins'] = () => renderPlugins()
