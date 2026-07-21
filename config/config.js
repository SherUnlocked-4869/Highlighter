const view = document.getElementById('view')
const pageTitle = document.getElementById('pageTitle')
const toastElement = document.getElementById('toast')

let settings = null
let currentRoute = 'home'
let homeTab = 'screenshot'
let chatMessages = []

const routeTitles = {
  home: '快捷功能', translation: '翻译', chat: 'AI 对话', history: '截图历史',
  appearance: '外观配色', plugins: '插件', 'settings-general': '界面设置',
  'settings-function': '功能设置', 'settings-hotkeys': '热键设置',
  'settings-system': '系统设置', about: '关于'
}

const functionGroups = {
  screenshot: [
    ['screenshot', '截图', '⌗', '自由框选、智能标注与导出'],
    ['screenshotDelay', '延迟截图', '◴', '倒计时后开始区域截图'],
    ['screenshotFixed', '固定到屏幕', '📌', '截图完成后直接贴到桌面'],
    ['screenshotOcr', '文本识别', 'OCR', '截图后提取中文、英文等文字'],
    ['screenshotOcrTranslate', '文本识别翻译', '译', 'OCR 后调用翻译服务'],
    ['screenshotCopy', '复制到剪贴板', '▣', '完成选区后立即复制'],
    ['screenshotFullScreen', '截取全屏', '▤', '捕获鼠标所在显示器'],
    ['screenshotFocusedWindow', '当前焦点窗口', '▰', '捕获当前活动窗口']
  ],
  ai: [
    ['chat', '打开 AI 对话', 'AI', '使用 DeepSeek 进行多轮对话'],
    ['chatSelectText', '对话框填入选中文本', '▧', '保留现有划词助手工作流']
  ],
  translation: [
    ['translation', '打开翻译工具', '文', '支持自动检测与中英互译'],
    ['translationSelectText', '翻译选中的文本', '⇄', '划词后快速翻译']
  ],
  video: [
    ['videoRecord', '视频录制', '●', '录制屏幕为 WebM 视频']
  ],
  other: [
    ['fixedContent', '固定本地图片', '📌', '选择图片并固定到桌面'],
    ['fullScreenDraw', '全屏画布', '✎', '在白色全屏画布中绘制'],
    ['toggleFixedContentVisibility', '显示/隐藏所有贴图', '◉', '批量控制桌面贴图'],
    ['openImageSaveFolder', '打开图片目录', '▱', '打开默认截图保存位置'],
    ['openCaptureHistory', '打开截图历史', '◫', '回顾、复制和重新编辑截图']
  ]
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function toast(message) {
  toastElement.textContent = message
  toastElement.classList.add('show')
  clearTimeout(toastElement._timer)
  toastElement._timer = setTimeout(() => toastElement.classList.remove('show'), 1800)
}

function applyAppearance() {
  if (!settings) return
  const theme = settings.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : settings.theme
  document.body.classList.toggle('dark', theme === 'dark')
  document.body.classList.toggle('compact', !!settings.compact)
  document.documentElement.style.setProperty('--primary', settings.mainColor || '#1677ff')
  document.documentElement.style.setProperty('--radius', `${Number(settings.borderRadius) || 8}px`)
  document.documentElement.style.setProperty('--skin', settings.skinPath ? `url("file:///${String(settings.skinPath).replace(/\\/g, '/')}")` : 'none')
  document.documentElement.style.setProperty('--skin-opacity', String((Number(settings.skinOpacity) || 0) / 100))
  let customStyle = document.getElementById('customStyle')
  if (!customStyle) { customStyle = document.createElement('style'); customStyle.id = 'customStyle'; document.head.appendChild(customStyle) }
  customStyle.textContent = settings.customCss || ''
}

async function updateSettings(patch, message = '设置已保存') {
  settings = await window.electronAPI.updateSettings(patch)
  applyAppearance()
  if (message) toast(message)
  return settings
}

function pageHeader(title, description, extra = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${description || ''}</p></div>${extra}</div>`
}

function navigate(route) {
  currentRoute = route || 'home'
  pageTitle.textContent = routeTitles[currentRoute] || 'Highlighter'
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.route === currentRoute))
  renderRoute()
}

function renderRoute() {
  if (currentRoute === 'home') renderHome()
  else if (currentRoute === 'translation') renderTranslation()
  else if (currentRoute === 'chat') renderChat()
  else if (currentRoute === 'history') renderHistory()
  else if (currentRoute === 'appearance') renderAppearance()
  else if (currentRoute === 'plugins') renderPlugins()
  else if (currentRoute === 'settings-general') renderGeneralSettings()
  else if (currentRoute === 'settings-function') renderFunctionSettings()
  else if (currentRoute === 'settings-hotkeys') renderHotkeySettings()
  else if (currentRoute === 'settings-system') renderSystemSettings()
  else renderAbout()
}

function renderHome() {
  const tabs = [['screenshot', '截图'], ['ai', 'AI 对话'], ['translation', '翻译'], ['video', '视频录制'], ['other', '其它']]
  const rows = functionGroups[homeTab].map(([name, label, icon, description]) => {
    const shortcut = settings.shortcuts[name] || ''
    return `<div class="function-row" data-function="${name}"><span class="icon">${icon}</span><span class="label">${label}<small class="desc">${description}</small></span><button class="shortcut ${shortcut ? 'set' : ''}" data-shortcut="${name}">${escapeHtml(shortcut || '未设置')}</button></div>`
  }).join('')
  view.innerHTML = `<div class="page">${pageHeader('快捷功能', '参考 Snow Shot 的分组方式，统一管理截图、AI、翻译、录屏和桌面工具。')}<div class="tabs">${tabs.map(([key, label]) => `<button data-home-tab="${key}" class="${homeTab === key ? 'active' : ''}">${label}</button>`).join('')}</div><section class="section"><h2 class="section-title">${tabs.find(([key]) => key === homeTab)[1]}</h2><div class="function-list">${rows}</div></section></div>`
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
  document.querySelectorAll('[data-shortcut]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation()
      button.textContent = '请按组合键…'
      button.classList.remove('set')
      const handler = async (keyEvent) => {
        keyEvent.preventDefault(); keyEvent.stopPropagation()
        if (keyEvent.key === 'Escape') { button.textContent = settings.shortcuts[button.dataset.shortcut] || '未设置'; cleanup(); return }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(keyEvent.key)) return
        const parts = []
        if (keyEvent.ctrlKey) parts.push('Ctrl')
        if (keyEvent.altKey) parts.push('Alt')
        if (keyEvent.shiftKey) parts.push('Shift')
        if (keyEvent.metaKey) parts.push('Super')
        let key = keyEvent.key.length === 1 ? keyEvent.key.toUpperCase() : keyEvent.key
        if (key === ' ') key = 'Space'
        parts.push(key)
        const accelerator = parts.join('+')
        const shortcuts = { ...settings.shortcuts, [button.dataset.shortcut]: accelerator }
        await updateSettings({ shortcuts }, '')
        button.textContent = accelerator; button.classList.add('set'); toast('快捷键已更新'); cleanup()
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

function renderTranslation() {
  view.innerHTML = `<div class="page">${pageHeader('翻译', '支持自动检测源语言和自定义目标语言；可与划词助手、截图 OCR 配合。')}<div class="translation-layout"><section class="card text-panel"><div class="panel-tools"><select id="sourceLanguage"><option value="auto">自动检测</option><option value="中文">中文</option><option value="英文">英文</option><option value="日文">日文</option><option value="韩文">韩文</option></select><button class="button" id="swapLanguage">⇄</button></div><textarea class="textarea" id="sourceText" placeholder="输入或粘贴要翻译的文本"></textarea><div class="panel-actions"><button class="button" id="clearSource">清空</button><button class="button primary" id="translateNow">翻译</button></div></section><section class="card text-panel"><div class="panel-tools"><select id="targetLanguage"><option>中文</option><option>英文</option><option>日文</option><option>韩文</option><option>繁体中文</option></select></div><textarea class="textarea" id="translatedText" readonly placeholder="翻译结果"></textarea><div class="panel-actions"><button class="button" id="copyTranslation">复制结果</button></div></section></div></div>`
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage || '中文'
  document.getElementById('translateNow').onclick = async () => {
    const source = document.getElementById('sourceText').value.trim(); if (!source) return
    const button = document.getElementById('translateNow'); button.disabled = true; button.textContent = '翻译中…'
    try { document.getElementById('translatedText').value = await window.electronAPI.translateText(source, document.getElementById('sourceLanguage').value, document.getElementById('targetLanguage').value) }
    catch (error) { toast(error.message || String(error)) }
    finally { button.disabled = false; button.textContent = '翻译' }
  }
  document.getElementById('clearSource').onclick = () => { document.getElementById('sourceText').value = ''; document.getElementById('translatedText').value = '' }
  document.getElementById('copyTranslation').onclick = async () => { await navigator.clipboard.writeText(document.getElementById('translatedText').value); toast('译文已复制') }
  document.getElementById('swapLanguage').onclick = () => { const source = document.getElementById('sourceText'), target = document.getElementById('translatedText'); if (target.value) { const old = source.value; source.value = target.value; target.value = old } }
}

function renderChat() {
  view.innerHTML = `<div class="page"><div class="card chat-wrap"><div class="chat-messages" id="chatMessages">${chatMessages.length ? chatMessages.map((message) => `<div class="message ${message.role}">${escapeHtml(message.content)}</div>`).join('') : '<div class="empty">输入问题开始对话。支持配置自定义 DeepSeek API Key、模型、Temperature 与 Token 上限。</div>'}</div><div class="chat-input"><textarea class="input" id="chatInput" placeholder="输入消息，Ctrl+Enter 发送"></textarea><button class="button primary" id="sendChat">发送</button></div></div></div>`
  const send = async () => {
    const input = document.getElementById('chatInput'); const content = input.value.trim(); if (!content) return
    chatMessages.push({ role: 'user', content }); input.value = ''; renderChat()
    const messages = chatMessages.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }))
    try { const answer = await window.electronAPI.requestAi(messages); chatMessages.push({ role: 'assistant', content: answer }) }
    catch (error) { chatMessages.push({ role: 'assistant', content: `请求失败：${error.message || error}` }) }
    renderChat(); const box = document.getElementById('chatMessages'); box.scrollTop = box.scrollHeight
  }
  document.getElementById('sendChat').onclick = send
  document.getElementById('chatInput').onkeydown = (event) => { if (event.ctrlKey && event.key === 'Enter') send() }
  const box = document.getElementById('chatMessages'); box.scrollTop = box.scrollHeight
}

async function renderHistory() {
  view.innerHTML = `<div class="page">${pageHeader('截图历史', '自动保存截图结果，可继续编辑、复制、定位文件或清理。', '<button class="button danger" id="clearHistory">清空历史</button>')}<div class="empty">正在加载…</div></div>`
  const history = await window.electronAPI.getHistory()
  const container = document.querySelector('.page')
  container.querySelector('.empty')?.remove()
  container.insertAdjacentHTML('beforeend', history.length ? `<div class="history-grid">${history.map((item) => `<article class="card history-item"><div class="history-image"><img src="${item.thumbnail}"></div><div class="history-meta">${new Date(item.createdAt).toLocaleString()} · ${escapeHtml(item.source)} · ${item.width}×${item.height}</div><div class="history-actions"><button data-history-action="edit" data-id="${item.id}">编辑</button><button data-history-action="copy" data-id="${item.id}">复制</button><button data-history-action="reveal" data-id="${item.id}">定位</button><button data-history-action="delete" data-id="${item.id}">删除</button></div></article>`).join('')}</div>` : '<div class="empty">暂无截图历史</div>')
  document.querySelectorAll('[data-history-action]').forEach((button) => button.onclick = async () => {
    const action = button.dataset.historyAction; const id = button.dataset.id
    if (action === 'edit') await window.electronAPI.editHistory(id)
    if (action === 'copy') { await window.electronAPI.copyHistory(id); toast('截图已复制') }
    if (action === 'reveal') await window.electronAPI.revealHistory(id)
    if (action === 'delete') { await window.electronAPI.deleteHistory(id); renderHistory() }
  })
  document.getElementById('clearHistory').onclick = async () => { if (confirm('确定清空全部截图历史？')) { await window.electronAPI.clearHistory(); renderHistory() } }
}

function switchMarkup(value, key, group) {
  return `<div class="switch ${value ? 'on' : ''}" data-switch="${key}" data-group="${group || ''}"></div>`
}

function bindSwitches() {
  document.querySelectorAll('[data-switch]').forEach((element) => element.onclick = async () => {
    const key = element.dataset.switch; const group = element.dataset.group; const value = !element.classList.contains('on')
    if (group) await updateSettings({ [group]: { [key]: value } })
    else await updateSettings({ [key]: value })
    element.classList.toggle('on', value)
  })
}

function renderAppearance() {
  view.innerHTML = `<div class="page">${pageHeader('外观配色', '自定义主题、主色、圆角、紧凑布局、皮肤图片与 CSS。')}<section class="section"><h2 class="section-title">主题</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>主题</b><small>跟随系统、浅色或深色</small></div><select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div><div class="form-row"><div class="form-label"><b>主色</b><small>按钮、选中状态和截图框颜色</small></div><input id="mainColor" type="color" value="${settings.mainColor}"></div><div class="form-row"><div class="form-label"><b>圆角</b></div><input id="borderRadius" type="range" min="0" max="20" value="${settings.borderRadius}"></div><div class="form-row"><div class="form-label"><b>紧凑布局</b></div>${switchMarkup(settings.compact, 'compact')}</div></div></section><section class="section"><h2 class="section-title">皮肤</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>皮肤图片路径</b><small>支持 PNG、JPG、WebP 等本地图片</small></div><input id="skinPath" type="text" value="${escapeHtml(settings.skinPath || '')}" placeholder="D:\\Pictures\\skin.jpg"></div><div class="form-row"><div class="form-label"><b>皮肤透明度</b></div><input id="skinOpacity" type="range" min="0" max="100" value="${settings.skinOpacity || 0}"></div><div class="form-row" style="align-items:flex-start;padding:14px 0"><div class="form-label"><b>自定义 CSS</b><small>覆盖主界面样式</small></div><textarea id="customCss" class="textarea" style="min-height:130px">${escapeHtml(settings.customCss || '')}</textarea></div></div></section><button class="button primary" id="saveAppearance">保存外观</button></div>`
  document.getElementById('theme').value = settings.theme
  bindSwitches()
  document.getElementById('saveAppearance').onclick = () => updateSettings({ theme: document.getElementById('theme').value, mainColor: document.getElementById('mainColor').value, borderRadius: Number(document.getElementById('borderRadius').value), skinPath: document.getElementById('skinPath').value.trim(), skinOpacity: Number(document.getElementById('skinOpacity').value), customCss: document.getElementById('customCss').value })
}

function renderPlugins() {
  const plugins = [
    ['ocr', 'OCR', '文本识别', '截图文字提取、二维码扫描、图片转文本的基础能力。'],
    ['translation', '译', '翻译', '文本翻译、截图识别翻译和划词翻译。'],
    ['ai', 'AI', 'AI 对话', '多轮对话、AI 翻译以及后续视觉理解扩展。'],
    ['video', 'REC', '视频录制', '通过桌面采集与 MediaRecorder 录制 WebM。']
  ]
  view.innerHTML = `<div class="page">${pageHeader('插件', '按需启用功能模块，保持应用轻量。')}<div class="grid">${plugins.map(([key, icon, title, description]) => `<div class="card plugin-card"><div class="plugin-icon">${icon}</div><div class="plugin-info"><h3>${title}</h3><p>${description}</p></div>${switchMarkup(settings.plugins[key], key, 'plugins')}</div>`).join('')}</div></div>`
  bindSwitches()
}

function renderGeneralSettings() {
  view.innerHTML = `<div class="page">${pageHeader('界面设置', '控制主界面和截图界面的常用视觉行为。')}<div class="card form-card"><div class="form-row"><div class="form-label"><b>界面缩放</b><small>使用系统 DPI 与窗口缩放</small></div><span>自动</span></div><div class="form-row"><div class="form-label"><b>截图选区遮罩</b></div><input id="selectionMask" type="text" value="${escapeHtml(settings.screenshot.selectionMask)}"></div><div class="form-row"><div class="form-label"><b>双击复制截图</b></div>${switchMarkup(settings.screenshot.doubleClickCopy, 'doubleClickCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>显示取色器入口</b></div>${switchMarkup(settings.screenshot.showColorPicker, 'showColorPicker', 'screenshot')}</div></div><button class="button primary" id="saveGeneral" style="margin-top:16px">保存</button></div>`
  bindSwitches(); document.getElementById('saveGeneral').onclick = () => updateSettings({ screenshot: { selectionMask: document.getElementById('selectionMask').value.trim() } })
}

function renderFunctionSettings() {
  view.innerHTML = `<div class="page">${pageHeader('功能设置', '配置截图、OCR、固定到屏幕、AI、翻译、录屏与输出。')}<section class="section"><h2 class="section-title">截图与输出</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>复制后自动保存</b></div>${switchMarkup(settings.screenshot.autoSaveOnCopy, 'autoSaveOnCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>一键快速保存</b></div>${switchMarkup(settings.screenshot.fastSave, 'fastSave', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>保存目录</b></div><input id="saveDirectory" type="text" value="${escapeHtml(settings.screenshot.saveDirectory || '')}"><button class="button" id="chooseSaveDirectory">选择</button></div><div class="form-row"><div class="form-label"><b>记录截图历史</b></div>${switchMarkup(settings.screenshot.historyEnabled, 'historyEnabled', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>历史数量上限</b></div><input id="historyLimit" type="number" min="10" max="1000" value="${settings.screenshot.historyLimit}"></div></div></section><section class="section"><h2 class="section-title">文本识别</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>识别语言</b><small>Tesseract 语言代码，首次使用会下载模型</small></div><select id="ocrLanguage"><option value="chi_sim+eng">简中 + 英文</option><option value="chi_tra+eng">繁中 + 英文</option><option value="eng">英文</option><option value="jpn+eng">日文 + 英文</option><option value="kor+eng">韩文 + 英文</option></select></div></div></section><section class="section"><h2 class="section-title">AI 与翻译</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>DeepSeek API Key</b><small>仅保存在本机 electron-store</small></div><input id="apiKey" type="password" value="${escapeHtml(settings.apiKey || '')}" placeholder="sk-..."><button class="button" id="testApi">测试</button></div><div class="form-row"><div class="form-label"><b>模型</b></div><input id="aiModel" type="text" value="${escapeHtml(settings.ai.model)}"></div><div class="form-row"><div class="form-label"><b>最大 Token</b></div><input id="maxTokens" type="number" value="${settings.ai.maxTokens}"></div><div class="form-row"><div class="form-label"><b>Temperature</b></div><input id="temperature" type="number" min="0" max="2" step="0.1" value="${settings.ai.temperature}"></div><div class="form-row"><div class="form-label"><b>默认翻译目标语言</b></div><select id="targetLanguage"><option>中文</option><option>英文</option><option>日文</option><option>韩文</option><option>繁体中文</option></select></div></div></section><section class="section"><h2 class="section-title">视频录制</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>帧率</b></div><select id="frameRate"><option>15</option><option>24</option><option>30</option><option>60</option></select></div><div class="form-row"><div class="form-label"><b>录制麦克风</b></div>${switchMarkup(settings.record.includeMicrophone, 'includeMicrophone', 'record')}</div><div class="form-row"><div class="form-label"><b>视频保存目录</b></div><input id="recordDirectory" type="text" value="${escapeHtml(settings.record.saveDirectory || '')}"><button class="button" id="chooseRecordDirectory">选择</button></div></div></section><button class="button primary" id="saveFunctions">保存功能设置</button></div>`
  document.getElementById('ocrLanguage').value = settings.screenshot.ocrLanguage
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage
  document.getElementById('frameRate').value = String(settings.record.frameRate)
  bindSwitches()
  document.getElementById('chooseSaveDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('saveDirectory').value = directory }
  document.getElementById('chooseRecordDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('recordDirectory').value = directory }
  document.getElementById('testApi').onclick = async () => { const button = document.getElementById('testApi'); button.disabled = true; button.textContent = '测试中'; try { const ok = await window.electronAPI.testConnection(document.getElementById('apiKey').value.trim()); toast(ok ? '连接成功' : '连接失败') } catch { toast('连接失败') } finally { button.disabled = false; button.textContent = '测试' } }
  document.getElementById('saveFunctions').onclick = () => updateSettings({ apiKey: document.getElementById('apiKey').value.trim(), screenshot: { saveDirectory: document.getElementById('saveDirectory').value.trim(), historyLimit: Number(document.getElementById('historyLimit').value), ocrLanguage: document.getElementById('ocrLanguage').value }, ai: { model: document.getElementById('aiModel').value.trim(), maxTokens: Number(document.getElementById('maxTokens').value), temperature: Number(document.getElementById('temperature').value), targetLanguage: document.getElementById('targetLanguage').value }, record: { frameRate: Number(document.getElementById('frameRate').value), saveDirectory: document.getElementById('recordDirectory').value.trim() } })
}

function renderHotkeySettings() {
  const all = Object.values(functionGroups).flat()
  view.innerHTML = `<div class="page">${pageHeader('热键设置', '点击右侧按键框后录入组合键；右键可清除。')}<div class="function-list">${all.map(([name, label, icon]) => `<div class="function-row"><span class="icon">${icon}</span><span class="label">${label}</span><button class="shortcut ${settings.shortcuts[name] ? 'set' : ''}" data-shortcut="${name}">${escapeHtml(settings.shortcuts[name] || '未设置')}</button></div>`).join('')}</div></div>`
  bindShortcutRecorders()
}

function renderSystemSettings() {
  view.innerHTML = `<div class="page">${pageHeader('系统设置', '控制自启动、托盘、日志和数据目录。')}<section class="section"><h2 class="section-title">常用</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>开机自动启动</b></div>${switchMarkup(settings.system.autoStart, 'autoStart', 'system')}</div><div class="form-row"><div class="form-label"><b>启用系统托盘</b></div>${switchMarkup(settings.system.enableTray, 'enableTray', 'system')}</div><div class="form-row"><div class="form-label"><b>运行日志</b></div>${switchMarkup(settings.system.runLog, 'runLog', 'system')}</div></div></section><section class="section"><h2 class="section-title">软件数据</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>数据目录</b><small>配置、日志与截图历史</small></div><button class="button" id="openData">打开</button></div><div class="form-row"><div class="form-label"><b>图片保存目录</b></div><button class="button" id="openSave">打开</button></div><div class="form-row"><div class="form-label"><b>清除截图历史</b><small>不会删除手动保存到其它目录的图片</small></div><button class="button danger" id="clearData">清除</button></div></div></section><button class="button danger" id="resetSettings">恢复默认设置</button></div>`
  bindSwitches(); document.getElementById('openData').onclick = () => window.electronAPI.openDataDirectory(); document.getElementById('openSave').onclick = () => window.electronAPI.openSaveDirectory(); document.getElementById('clearData').onclick = async () => { if (confirm('确定清空截图历史？')) { await window.electronAPI.clearHistory(); toast('截图历史已清空') } }; document.getElementById('resetSettings').onclick = async () => { if (confirm('确定恢复默认设置？')) { settings = await window.electronAPI.resetSettings(); applyAppearance(); renderRoute(); toast('已恢复默认设置') } }
}

async function renderAbout() {
  const info = await window.electronAPI.getAppInfo()
  view.innerHTML = `<div class="page"><div class="card about"><div class="about-logo"><span>High</span>lighter</div><h2>桌面截图与划词效率工具</h2><p>版本 ${escapeHtml(info.version)} · ${escapeHtml(info.platform)}</p><p>本次升级参考 Snow Shot 的功能组织与界面设计，保留原有划词翻译/解释能力，并新增截图标注、OCR、贴图、历史、翻译、AI 对话、录屏、全屏画布、插件开关、热键和个性化设置。</p><button class="button" id="openSnowDocs">Snow Shot 使用文档</button></div></div>`
  document.getElementById('openSnowDocs').onclick = () => window.electronAPI.openExternal('https://snowshot.top/guide/index.html')
}

document.querySelectorAll('.nav-item').forEach((button) => button.onclick = () => navigate(button.dataset.route))
document.getElementById('minimize').onclick = () => window.electronAPI.windowMinimize()
document.getElementById('close').onclick = () => window.electronAPI.windowClose()
window.electronAPI.onNavigate(navigate)
window.electronAPI.onHistoryChanged(() => { if (currentRoute === 'history') renderHistory() })
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)

async function init() {
  settings = await window.electronAPI.getSettings()
  applyAppearance()
  navigate('home')
}
init()
