// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 appearance（外观配色）。

function renderAppearance() {
  view.innerHTML = `<div class="page">${pageHeader('外观配色', '自定义主题、主色、圆角、紧凑布局、皮肤图片与 CSS。')}<section class="section"><h2 class="section-title">主题</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>主题</b><small>跟随系统、浅色或深色</small></div><select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div><div class="form-row"><div class="form-label"><b>主色</b><small>按钮、选中状态和截图框颜色</small></div><input id="mainColor" type="color" value="${settings.mainColor}"></div><div class="form-row"><div class="form-label"><b>圆角</b></div><input id="borderRadius" type="range" min="0" max="20" value="${settings.borderRadius}"></div><div class="form-row"><div class="form-label"><b>紧凑布局</b></div>${switchMarkup(settings.compact, 'compact')}</div></div></section><section class="section"><h2 class="section-title">皮肤</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>皮肤图片路径</b><small>支持 PNG、JPG、WebP 等本地图片</small></div><input id="skinPath" type="text" value="${escapeHtml(settings.skinPath || '')}" placeholder="D:\\Pictures\\skin.jpg"></div><div class="form-row"><div class="form-label"><b>皮肤透明度</b></div><input id="skinOpacity" type="range" min="0" max="100" value="${settings.skinOpacity || 0}"></div><div class="form-row" style="align-items:flex-start;padding:14px 0"><div class="form-label"><b>自定义 CSS</b><small>覆盖主界面样式</small></div><textarea id="customCss" class="textarea" style="min-height:130px">${escapeHtml(settings.customCss || '')}</textarea></div></div></section><button class="button primary" id="saveAppearance">保存外观</button></div>`
  document.getElementById('theme').value = settings.theme
  bindSwitches()
  document.getElementById('saveAppearance').onclick = () => updateSettings({ theme: document.getElementById('theme').value, mainColor: document.getElementById('mainColor').value, borderRadius: Number(document.getElementById('borderRadius').value), skinPath: document.getElementById('skinPath').value.trim(), skinOpacity: Number(document.getElementById('skinOpacity').value), customCss: document.getElementById('customCss').value })
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderAppearance'] = () => renderAppearance()
