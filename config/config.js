const view = document.getElementById('view')
const pageTitle = document.getElementById('pageTitle')
const toastElement = document.getElementById('toast')

let settings = null
let currentRoute = 'home'
let homeTab = 'screenshot'
let chatMessages = []
let draggedSelectionToolbarAction = ''
let historyQuery = ''
let historySource = ''
let historyRenderVersion = 0
let historySearchTimer = null
let historySelectedIds = new Set()
let historyThumbnailObserver = null
let shortcutStatuses = {}

const HISTORY_PAGE_SIZE = 40

const selectionToolbarBuiltinMeta = {
  copy: { label: '复制', icon: '⧉', description: '复制划词内容到系统剪贴板' },
  search: { label: '搜索', icon: '⌕', description: '使用默认浏览器搜索划词内容' },
  translate: { label: '翻译', icon: '译', description: '使用下方自定义提示词翻译划词内容' },
  explain: { label: '解释', icon: '?', description: '使用下方自定义提示词解释划词内容' },
  open: { label: '跳转', icon: '↗', description: '在默认浏览器中打开划词内容，内容将直接作为网址跳转', optional: true }
}

const routeTitles = {
  home: '快捷功能', translation: '翻译', chat: 'AI 对话', history: '截图历史',
  appearance: '外观配色', plugins: '插件', 'settings-general': '界面设置',
  'settings-function': '功能设置', 'settings-hotkeys': '热键设置',
  'selection-toolbar': '划词工具',
  'settings-system': '系统设置', about: '关于'
}

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
    ['chat', '打开 AI 对话', 'icons/robot.svg', '使用 DeepSeek 进行多轮对话'],
    ['chatSelectText', '对话框填入选中文本', 'icons/text-style-one.svg', '保留现有划词助手工作流']
  ],
  translation: [
    ['translation', '打开翻译工具', '../capture/icons/translate.svg', '支持自动检测与中英互译'],
    ['translationSelectText', '翻译选中的文本', 'icons/translation.svg', '划词后快速翻译']
  ],
  video: [
    ['videoRecord', '视频录制', '../capture/icons/record.svg', '录制屏幕并导出 MP4 视频']
  ],
  other: [
    ['fixedContent', '固定本地图片', '../capture/icons/pin.svg', '选择图片并固定到桌面'],
    ['fullScreenDraw', '全屏画布', 'icons/draw.svg', '在白色全屏画布中绘制'],
    ['toggleFixedContentVisibility', '显示/隐藏所有贴图', 'icons/preview.svg', '批量控制桌面贴图'],
    ['openImageSaveFolder', '打开图片目录', 'icons/folder-open.svg', '打开默认截图保存位置'],
    ['openCaptureHistory', '打开截图历史', 'icons/history.svg', '回顾、复制和重新编辑截图']
  ]
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function iconMarkup(iconPath) {
  return `<span class="svg-icon" style="--icon:url('${escapeHtml(iconPath)}')" aria-hidden="true"></span>`
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
  if (patch.shortcuts) await refreshShortcutStatuses()
  applyAppearance()
  if (message) toast(message)
  return settings
}

async function refreshShortcutStatuses() {
  shortcutStatuses = await window.electronAPI.getShortcutStatuses()
}

function shortcutPresentation(name, accelerator) {
  if (!accelerator) {
    return { className: '', text: '未设置', title: '点击录入快捷键' }
  }
  const status = shortcutStatuses[name]
  if (!status || status.registered) {
    return { className: 'set', text: accelerator, title: '快捷键已启用' }
  }
  let message = '快捷键未能注册'
  if (status.reason === 'duplicate') {
    const conflicts = (status.conflictWith || [])
      .map((owner) => Object.values(functionGroups).flat().find(([itemName]) => itemName === owner)?.[1] || owner)
      .join('、')
    message = conflicts ? `与“${conflicts}”重复` : '与其他应用内快捷键重复'
  } else if (status.reason === 'unavailable') {
    message = '已被系统或其他应用占用'
  } else if (status.reason === 'invalid') {
    message = '快捷键格式无效'
  }
  return {
    className: 'set unavailable',
    text: `${accelerator} ⚠`,
    title: message,
    message
  }
}

function shortcutButton(name, accelerator) {
  const presentation = shortcutPresentation(name, accelerator)
  return `<button class="shortcut ${presentation.className}" data-shortcut="${name}" title="${escapeHtml(presentation.title)}">${escapeHtml(presentation.text)}</button>`
}

function pageHeader(title, description, extra = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${description || ''}</p></div>${extra}</div>`
}

function navigate(route) {
  if (currentRoute === 'history' && route !== 'history') {
    historyThumbnailObserver?.disconnect()
    historyThumbnailObserver = null
  }
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
  else if (currentRoute === 'selection-toolbar') renderSelectionToolbarSettings()
  else if (currentRoute === 'settings-hotkeys') renderHotkeySettings()
  else if (currentRoute === 'settings-system') void renderSystemSettings().catch((error) => toast(error.message || '无法读取软件数据目录'))
  else renderAbout()
}

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
        const shortcutName = button.dataset.shortcut
        const shortcuts = { ...settings.shortcuts, [shortcutName]: accelerator }
        await updateSettings({ shortcuts }, '')
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

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index++) {
    size /= 1024
    unit = units[index]
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`
}

async function renderHistory() {
  const renderVersion = ++historyRenderVersion
  historyThumbnailObserver?.disconnect()
  historyThumbnailObserver = null
  const headerActions = '<div class="page-head-actions"><button class="button" id="cleanupHistory">清理失效项</button><button class="button danger" id="clearHistory">清空全部</button></div>'
  view.innerHTML = `<div class="page">${pageHeader('截图历史', '搜索、筛选和批量管理截图。', headerActions)}<div class="empty">正在加载…</div></div>`
  const [firstPage, sources, stats] = await Promise.all([
    window.electronAPI.getHistory({
      query: historyQuery,
      source: historySource,
      limit: HISTORY_PAGE_SIZE
    }),
    window.electronAPI.getHistorySources(),
    window.electronAPI.getHistoryStats()
  ])
  if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
  let history = Array.isArray(firstPage?.items) ? firstPage.items : []
  let nextCursor = firstPage?.nextCursor || ''
  let hasMore = firstPage?.hasMore === true
  const totalCount = Math.max(history.length, Number(firstPage?.totalCount) || 0)
  const thumbnailCache = new Map()
  const visibleIds = new Set(history.map((item) => String(item.id)))
  historySelectedIds = new Set([...historySelectedIds].filter((id) => visibleIds.has(id)))
  const container = document.querySelector('.page')
  container.querySelector('.empty')?.remove()
  const sourceLabels = {
    capture: '区域截图',
    'long-capture': '长截图',
    'focused-window': '焦点窗口',
    file: '本地图片',
    history: '历史编辑'
  }
  const sourceOptions = sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(sourceLabels[source] || source)}</option>`).join('')
  const statsMarkup = `<div class="history-stats card"><div><b>${formatBytes(stats.totalBytes)}</b><span>占用空间</span></div><div><b>${stats.availableCount}</b><span>有效记录</span></div><div class="${stats.missingCount ? 'warning' : ''}"><b>${stats.missingCount}</b><span>失效记录</span></div><div class="${stats.orphanCount ? 'warning' : ''}"><b>${stats.orphanCount}</b><span>孤立文件 · ${formatBytes(stats.orphanBytes)}</span></div></div>`
  const filtersMarkup = `<div class="history-filters card"><input class="input" id="historySearch" type="search" value="${escapeHtml(historyQuery)}" placeholder="搜索来源、操作或文件名"><select id="historySource"><option value="">全部来源</option>${sourceOptions}</select><span id="historyLoadedCount"></span></div>`
  const batchMarkup = `<div class="history-batch card"><label><input type="checkbox" id="selectAllHistory"> 全选已加载项</label><span id="historySelectedCount">已选择 0 项</span><button class="button" id="exportSelectedHistory" disabled>导出选中项</button><button class="button danger" id="deleteSelectedHistory" disabled>删除选中项</button></div>`
  container.insertAdjacentHTML('beforeend', `${statsMarkup}${filtersMarkup}${batchMarkup}<div id="historyResults"></div><div class="history-load-more"><button class="button" id="loadMoreHistory">加载更多</button></div>`)

  const searchInput = document.getElementById('historySearch')
  const sourceSelect = document.getElementById('historySource')
  const selectAll = document.getElementById('selectAllHistory')
  const selectedCount = document.getElementById('historySelectedCount')
  const exportSelected = document.getElementById('exportSelectedHistory')
  const deleteSelected = document.getElementById('deleteSelectedHistory')
  const loadedCount = document.getElementById('historyLoadedCount')
  const results = document.getElementById('historyResults')
  const loadMore = document.getElementById('loadMoreHistory')
  const updateSelectionControls = () => {
    const count = historySelectedIds.size
    selectedCount.textContent = `已选择 ${count} 项`
    exportSelected.disabled = count === 0
    deleteSelected.disabled = count === 0
    selectAll.checked = history.length > 0 && count === history.length
    selectAll.indeterminate = count > 0 && count < history.length
  }
  const loadThumbnail = async (imageElement) => {
    const id = imageElement.dataset.historyThumbnail
    if (!id || imageElement.dataset.loaded === 'true') return
    imageElement.dataset.loaded = 'true'
    try {
      const cached = thumbnailCache.get(id)
      const thumbnail = cached || await window.electronAPI.getHistoryThumbnail(id)
      if (thumbnail) thumbnailCache.set(id, thumbnail)
      if (thumbnail && currentRoute === 'history' && renderVersion === historyRenderVersion && imageElement.isConnected) {
        imageElement.src = thumbnail
      } else {
        imageElement.closest('.history-image')?.classList.add('unavailable')
      }
    } catch {
      imageElement.closest('.history-image')?.classList.add('unavailable')
    }
  }
  const observeThumbnails = () => {
    historyThumbnailObserver?.disconnect()
    const images = [...results.querySelectorAll('[data-history-thumbnail]')]
    if (!('IntersectionObserver' in window)) {
      images.forEach(loadThumbnail)
      return
    }
    historyThumbnailObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        observer.unobserve(entry.target)
        loadThumbnail(entry.target)
      })
    }, { root: view, rootMargin: '240px' })
    images.forEach((imageElement) => historyThumbnailObserver.observe(imageElement))
  }
  const bindHistoryItems = () => {
    document.querySelectorAll('[data-history-select]').forEach((checkbox) => {
      checkbox.onchange = () => {
        const id = checkbox.dataset.id
        if (checkbox.checked) historySelectedIds.add(id)
        else historySelectedIds.delete(id)
        checkbox.closest('.history-item')?.classList.toggle('selected', checkbox.checked)
        updateSelectionControls()
      }
    })
    document.querySelectorAll('[data-history-action]').forEach((button) => button.onclick = async () => {
      const action = button.dataset.historyAction; const id = button.dataset.id
      if (action === 'edit') await window.electronAPI.editHistory(id)
      if (action === 'copy') { const copied = await window.electronAPI.copyHistory(id); toast(copied ? '截图已复制' : '图片过大，请从保存位置使用') }
      if (action === 'reveal') await window.electronAPI.revealHistory(id)
      if (action === 'delete') {
        try { historySelectedIds.delete(id); await window.electronAPI.deleteHistory(id) }
        catch (error) { toast(error.message || '图片文件删除失败') }
      }
    })
  }
  const renderLoadedItems = () => {
    const itemsMarkup = history.length
      ? `<div class="history-grid">${history.map((item) => {
          const selected = historySelectedIds.has(String(item.id))
          return `<article class="card history-item ${selected ? 'selected' : ''}"><label class="history-select" title="选择此项"><input type="checkbox" data-history-select data-id="${escapeHtml(item.id)}" ${selected ? 'checked' : ''}></label><div class="history-image"><img data-history-thumbnail="${escapeHtml(item.id)}" alt=""></div><div class="history-meta">${new Date(item.createdAt).toLocaleString()} · ${escapeHtml(sourceLabels[item.source] || item.source)} · ${escapeHtml(item.width)}×${escapeHtml(item.height)}</div><div class="history-actions">${item.longCapture ? '' : `<button data-history-action="edit" data-id="${escapeHtml(item.id)}">编辑</button>`}<button data-history-action="copy" data-id="${escapeHtml(item.id)}">复制</button><button data-history-action="reveal" data-id="${escapeHtml(item.id)}">定位</button><button data-history-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div></article>`
        }).join('')}</div>`
      : '<div class="empty">没有符合条件的截图历史</div>'
    results.innerHTML = itemsMarkup
    loadedCount.textContent = totalCount > history.length ? `${history.length}/${totalCount} 项` : `${totalCount} 项`
    loadMore.hidden = !hasMore
    loadMore.disabled = false
    updateSelectionControls()
    bindHistoryItems()
    observeThumbnails()
  }
  sourceSelect.value = historySource
  renderLoadedItems()
  searchInput.oninput = () => {
    historyQuery = searchInput.value
    clearTimeout(historySearchTimer)
    historySearchTimer = setTimeout(() => renderHistory(), 220)
  }
  searchInput.onkeydown = (event) => {
    if (event.key !== 'Enter') return
    clearTimeout(historySearchTimer)
    historyQuery = searchInput.value
    renderHistory()
  }
  sourceSelect.onchange = () => {
    historySource = sourceSelect.value
    renderHistory()
  }
  selectAll.onchange = () => {
    historySelectedIds = selectAll.checked ? new Set(history.map((item) => String(item.id))) : new Set()
    document.querySelectorAll('[data-history-select]').forEach((checkbox) => {
      checkbox.checked = selectAll.checked
      checkbox.closest('.history-item')?.classList.toggle('selected', selectAll.checked)
    })
    updateSelectionControls()
  }
  exportSelected.onclick = async () => {
    const result = await window.electronAPI.exportHistory([...historySelectedIds])
    if (result.canceled) return
    const suffix = result.failures?.length ? `，${result.failures.length} 项失败` : ''
    toast(`已导出 ${result.exportedCount} 项${suffix}`)
  }
  deleteSelected.onclick = async () => {
    if (!confirm(`确定删除选中的 ${historySelectedIds.size} 项截图及对应文件？`)) return
    const result = await window.electronAPI.deleteHistoryMany([...historySelectedIds])
    historySelectedIds.clear()
    const suffix = result.failures?.length ? `，${result.failures.length} 项失败` : ''
    toast(`已删除 ${result.deletedCount} 项${suffix}`)
    renderHistory()
  }
  loadMore.onclick = async () => {
    if (!hasMore || loadMore.disabled) return
    loadMore.disabled = true
    try {
      const page = await window.electronAPI.getHistory({
        query: historyQuery,
        source: historySource,
        cursor: nextCursor,
        limit: HISTORY_PAGE_SIZE
      })
      if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
      history = history.concat(Array.isArray(page?.items) ? page.items : [])
      nextCursor = page?.nextCursor || ''
      hasMore = page?.hasMore === true
      renderLoadedItems()
    } catch (error) {
      loadMore.disabled = false
      toast(error.message || '加载截图历史失败')
    }
  }
  document.getElementById('cleanupHistory').onclick = async () => {
    if (!stats.missingCount && !stats.orphanCount) { toast('没有需要清理的项目'); return }
    if (!confirm(`将移除 ${stats.missingCount} 条失效记录，并删除 ${stats.orphanCount} 个未被引用的 Highlighter 文件，是否继续？`)) return
    const result = await window.electronAPI.cleanupHistory()
    const suffix = result.failures?.length ? `，${result.failures.length} 项失败` : ''
    toast(`已清理 ${result.removedEntries} 条记录和 ${result.removedFiles} 个文件${suffix}`)
    renderHistory()
  }
  document.getElementById('clearHistory').onclick = async () => {
    if (!confirm('确定清空全部截图历史并删除对应图片文件？')) return
    try { historySelectedIds.clear(); await window.electronAPI.clearHistory(); renderHistory() }
    catch (error) { toast(error.message || '部分图片文件删除失败'); renderHistory() }
  }
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
function selectionToolbarCustomKey(id) {
  return `custom:${id}`
}

function selectionToolbarActionInfo(toolbar, action) {
  const builtin = selectionToolbarBuiltinMeta[action]
  if (builtin) return { ...builtin, enabled: toolbar.buttons[action] !== false, custom: false }
  const id = action.startsWith('custom:') ? action.slice(7) : ''
  const custom = toolbar.customActions.find((item) => item.id === id)
  if (!custom) return null
  return {
    label: custom.name,
    icon: '✦',
    description: `自定义 AI 功能 · ${custom.prompt}`,
    enabled: custom.enabled !== false,
    custom: true,
    id
  }
}

function selectionToolbarOrderMarkup(toolbar) {
  const optionalActions = Object.keys(selectionToolbarBuiltinMeta).filter((action) => selectionToolbarBuiltinMeta[action].optional && !toolbar.order.includes(action))
  const actions = [...toolbar.order, ...optionalActions]
  return actions.map((action, index) => {
    const info = selectionToolbarActionInfo(toolbar, action)
    if (!info) return ''
    const inOrder = toolbar.order.includes(action)
    const enabled = info.custom ? info.enabled : (info.optional ? inOrder : info.enabled)
    const toggle = info.custom
      ? `<div class="switch ${info.enabled ? 'on' : ''}" data-custom-toolbar-toggle="${escapeHtml(info.id)}"></div>`
      : `<div class="switch ${enabled ? 'on' : ''}" data-toolbar-button="${action}"></div>`
    const movable = info.custom || inOrder
    return `<div class="toolbar-order-row" draggable="true" data-toolbar-order="${escapeHtml(action)}"><span class="toolbar-drag" title="拖动排序">⋮⋮</span><span class="toolbar-order-icon">${escapeHtml(info.icon)}</span><div class="form-label"><b>${escapeHtml(info.label)}</b><small>${escapeHtml(info.description)}</small></div>${toggle}<div class="toolbar-order-actions"><button class="button icon-button" data-move-toolbar="${escapeHtml(action)}" data-direction="-1" ${index === 0 || !movable ? 'disabled' : ''} title="上移">↑</button><button class="button icon-button" data-move-toolbar="${escapeHtml(action)}" data-direction="1" ${index === actions.length - 1 || !movable ? 'disabled' : ''} title="下移">↓</button></div></div>`
  }).join('')
}

function selectionToolbarCustomMarkup(toolbar) {
  if (!toolbar.customActions.length) return '<div class="empty compact-empty">暂无自定义功能，点击“添加功能”创建。</div>'
  return toolbar.customActions.map((item) => `<article class="custom-toolbar-card" data-custom-toolbar="${escapeHtml(item.id)}"><div class="custom-toolbar-head"><label>功能名称<input type="text" maxlength="16" data-custom-name value="${escapeHtml(item.name)}" placeholder="例如：优化"></label><label>思考强度<select data-custom-thinking title="请求 AI 时的思考深度"><option value="off">关</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></label><button class="button danger" data-delete-custom-toolbar="${escapeHtml(item.id)}">删除</button></div><label>提示词<textarea class="textarea prompt-editor custom-prompt" maxlength="6000" data-custom-prompt placeholder="例如：优化这段话，使表达更清晰自然。">${escapeHtml(item.prompt)}</textarea></label><small>执行时，划词内容会作为用户文本与这条提示词一起发送给 AI。</small></article>`).join('')
}

function readSelectionToolbarEditor(toolbar) {
  const translatePrompt = document.getElementById('translatePrompt')?.value.trim() || ''
  const explainPrompt = document.getElementById('explainPrompt')?.value.trim() || ''
  if (!translatePrompt || !explainPrompt) {
    toast('翻译和解释提示词不能为空')
    return null
  }
  const customActions = toolbar.customActions.map((item) => {
    const card = document.querySelector(`[data-custom-toolbar="${item.id}"]`)
    if (!card) return item
    const next = {
      ...item,
      name: card.querySelector('[data-custom-name]').value.trim(),
      prompt: card.querySelector('[data-custom-prompt]').value.trim()
    }
    const thinkingSelect = card.querySelector('[data-custom-thinking]')
    if (thinkingSelect) next.thinking = thinkingSelect.value
    return next
  })
  if (customActions.some((item) => !item.name || !item.prompt)) {
    toast('自定义功能名称和提示词不能为空')
    return null
  }
  return {
    prompts: { translate: translatePrompt, explain: explainPrompt },
    customActions,
    searchEngine: document.getElementById('searchEngine')?.value || toolbar.searchEngine
  }
}

async function moveSelectionToolbarAction(action, targetIndex) {
  const toolbar = settings.selectionToolbar
  const editor = readSelectionToolbarEditor(toolbar)
  if (!editor) return
  const order = [...toolbar.order]
  const sourceIndex = order.indexOf(action)
  if (sourceIndex < 0) return
  const boundedTarget = Math.max(0, Math.min(order.length - 1, targetIndex))
  if (sourceIndex === boundedTarget) return
  order.splice(sourceIndex, 1)
  order.splice(boundedTarget, 0, action)
  await updateSettings({ selectionToolbar: { ...editor, order } }, '')
  renderSelectionToolbarSettings()
}

function createSelectionToolbarActionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '')
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function renderSelectionToolbarSettings() {
  const toolbar = settings.selectionToolbar
  const customLimitReached = toolbar.customActions.length >= 12
  view.innerHTML = `<div class="page">${pageHeader('划词工具', '自定义工具栏顺序、内置提示词和你自己的 AI 功能。')}<section class="section"><h2 class="section-title">工具栏</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>启用划词工具栏</b><small>选中文本后显示已启用的快捷操作</small></div>${switchMarkup(toolbar.enabled, 'enabled', 'selectionToolbar')}</div></div></section><section class="section"><h2 class="section-title">功能与顺序 <small>拖动项目或使用箭头调整</small></h2><div class="card toolbar-order-list" id="toolbarOrderList">${selectionToolbarOrderMarkup(toolbar)}</div></section><section class="section"><h2 class="section-title">内置功能设置</h2><div class="card prompt-settings"><div class="prompt-setting"><label for="translatePrompt"><b>翻译提示词</b><small>用于划词工具栏的“翻译”功能</small></label><textarea class="textarea prompt-editor" id="translatePrompt" maxlength="6000">${escapeHtml(toolbar.prompts.translate)}</textarea></div><div class="prompt-setting"><label for="explainPrompt"><b>解释提示词</b><small>用于划词工具栏的“解释”功能</small></label><textarea class="textarea prompt-editor" id="explainPrompt" maxlength="6000">${escapeHtml(toolbar.prompts.explain)}</textarea></div><div class="form-row search-setting"><div class="form-label"><b>翻译思考强度</b><small>“翻译”功能请求 AI 时的思考深度，关闭时响应更快</small></div><select id="translateThinking"><option value="off">关</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></div><div class="form-row search-setting"><div class="form-label"><b>解释思考强度</b><small>“解释”功能请求 AI 时的思考深度，强度越高分析越深入</small></div><select id="explainThinking"><option value="off">关</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></div><div class="form-row search-setting"><div class="form-label"><b>搜索引擎</b><small>“搜索”功能使用系统默认浏览器打开</small></div><select id="searchEngine"><option value="bing">Bing</option><option value="baidu">百度</option><option value="google">Google</option></select></div></div></section><section class="section"><h2 class="section-title">自定义 AI 功能 <button class="button" id="addCustomToolbar" ${customLimitReached ? 'disabled' : ''}>＋ 添加功能</button></h2><div class="card custom-toolbar-list">${selectionToolbarCustomMarkup(toolbar)}</div>${customLimitReached ? '<small class="section-note">最多可创建 12 个自定义功能。</small>' : ''}</section><button class="button primary" id="saveSelectionToolbar">保存划词工具设置</button></div>`
  document.getElementById('searchEngine').value = toolbar.searchEngine || 'bing'
  const toolbarThinking = settings.toolbarThinking || {}
  const translateThinking = document.getElementById('translateThinking')
  const explainThinking = document.getElementById('explainThinking')
  translateThinking.value = ['off', 'low', 'high', 'max'].includes(toolbarThinking.translate) ? toolbarThinking.translate : 'off'
  explainThinking.value = ['off', 'low', 'high', 'max'].includes(toolbarThinking.explain) ? toolbarThinking.explain : 'high'
  translateThinking.onchange = () => updateSettings({ toolbarThinking: { translate: translateThinking.value } }, '翻译思考强度已更新')
  explainThinking.onchange = () => updateSettings({ toolbarThinking: { explain: explainThinking.value } }, '解释思考强度已更新')
  toolbar.customActions.forEach((item) => {
    const select = document.querySelector(`[data-custom-toolbar="${item.id}"] [data-custom-thinking]`)
    if (select) select.value = ['off', 'low', 'high', 'max'].includes(item.thinking) ? item.thinking : 'high'
  })
  bindSwitches()

  document.querySelectorAll('[data-toolbar-button]').forEach((element) => {
    element.onclick = async () => {
      const key = element.dataset.toolbarButton
      const value = !element.classList.contains('on')
      if (selectionToolbarBuiltinMeta[key]?.optional) {
        const order = settings.selectionToolbar.order.filter((action) => action !== key)
        if (value) order.push(key)
        await updateSettings({ selectionToolbar: { order } }, '')
        renderSelectionToolbarSettings()
        return
      }
      await updateSettings({ selectionToolbar: { buttons: { [key]: value } } }, '')
      element.classList.toggle('on', value)
    }
  })
  document.querySelectorAll('[data-custom-toolbar-toggle]').forEach((element) => {
    element.onclick = async () => {
      const id = element.dataset.customToolbarToggle
      const editor = readSelectionToolbarEditor(toolbar)
      if (!editor) return
      const customActions = editor.customActions.map((item) => item.id === id ? { ...item, enabled: !element.classList.contains('on') } : item)
      toolbar.customActions = customActions
      await updateSettings({ selectionToolbar: { ...editor, customActions } }, '')
      element.classList.toggle('on', settings.selectionToolbar.customActions.find((item) => item.id === id)?.enabled !== false)
    }
  })
  document.querySelectorAll('[data-move-toolbar]').forEach((button) => {
    button.onclick = () => {
      const index = settings.selectionToolbar.order.indexOf(button.dataset.moveToolbar)
      void moveSelectionToolbarAction(button.dataset.moveToolbar, index + Number(button.dataset.direction))
    }
  })
  document.querySelectorAll('[data-toolbar-order]').forEach((row) => {
    row.ondragstart = () => {
      draggedSelectionToolbarAction = row.dataset.toolbarOrder
      row.classList.add('dragging')
    }
    row.ondragend = () => {
      draggedSelectionToolbarAction = ''
      row.classList.remove('dragging')
    }
    row.ondragover = (event) => {
      event.preventDefault()
      row.classList.add('drag-over')
    }
    row.ondragleave = () => row.classList.remove('drag-over')
    row.ondrop = (event) => {
      event.preventDefault()
      row.classList.remove('drag-over')
      const targetIndex = settings.selectionToolbar.order.indexOf(row.dataset.toolbarOrder)
      if (draggedSelectionToolbarAction) void moveSelectionToolbarAction(draggedSelectionToolbarAction, targetIndex)
    }
  })
  document.getElementById('addCustomToolbar').onclick = async () => {
    const editor = readSelectionToolbarEditor(toolbar)
    if (!editor) return
    const id = createSelectionToolbarActionId()
    const customActions = [...editor.customActions, {
      id,
      name: '新功能',
      prompt: '请根据要求处理这段文字。',
      enabled: true,
      thinking: 'high'
    }]
    const order = [...toolbar.order, selectionToolbarCustomKey(id)]
    await updateSettings({ selectionToolbar: { ...editor, customActions, order } }, '')
    renderSelectionToolbarSettings()
    document.querySelector(`[data-custom-toolbar="${id}"] [data-custom-name]`)?.focus()
  }
  document.querySelectorAll('[data-delete-custom-toolbar]').forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.deleteCustomToolbar
      const item = toolbar.customActions.find((candidate) => candidate.id === id)
      if (!item || !confirm(`确定删除自定义功能“${item.name}”？`)) return
      const editor = readSelectionToolbarEditor(toolbar)
      if (!editor) return
      const customActions = editor.customActions.filter((candidate) => candidate.id !== id)
      const order = toolbar.order.filter((action) => action !== selectionToolbarCustomKey(id))
      await updateSettings({ selectionToolbar: { ...editor, customActions, order } }, '')
      renderSelectionToolbarSettings()
      toast('自定义功能已删除')
    }
  })
  document.getElementById('saveSelectionToolbar').onclick = async () => {
    const editor = readSelectionToolbarEditor(toolbar)
    if (!editor) return
    await updateSettings({
      selectionToolbar: {
        ...editor,
        order: toolbar.order,
      }
    }, '划词工具设置已保存')
    renderSelectionToolbarSettings()
  }
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
    ['video', 'REC', '视频录制', '区域录制、暂停预览并导出 MP4。']
  ]
  view.innerHTML = `<div class="page">${pageHeader('插件', '按需启用功能模块，保持应用轻量。')}<div class="grid">${plugins.map(([key, icon, title, description]) => `<div class="card plugin-card"><div class="plugin-icon">${icon}</div><div class="plugin-info"><h3>${title}</h3><p>${description}</p></div>${switchMarkup(settings.plugins[key], key, 'plugins')}</div>`).join('')}</div></div>`
  bindSwitches()
}

function renderGeneralSettings() {
  view.innerHTML = `<div class="page">${pageHeader('界面设置', '控制主界面和截图界面的常用视觉行为。')}<div class="card form-card"><div class="form-row"><div class="form-label"><b>界面缩放</b><small>使用系统 DPI 与窗口缩放</small></div><span>自动</span></div><div class="form-row"><div class="form-label"><b>截图选区遮罩</b></div><input id="selectionMask" type="text" value="${escapeHtml(settings.screenshot.selectionMask)}"></div><div class="form-row"><div class="form-label"><b>双击复制截图</b></div>${switchMarkup(settings.screenshot.doubleClickCopy, 'doubleClickCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>显示取色器入口</b></div>${switchMarkup(settings.screenshot.showColorPicker, 'showColorPicker', 'screenshot')}</div></div><button class="button primary" id="saveGeneral" style="margin-top:16px">保存</button></div>`
  bindSwitches(); document.getElementById('saveGeneral').onclick = () => updateSettings({ screenshot: { selectionMask: document.getElementById('selectionMask').value.trim() } })
}

function renderFunctionSettings() {
  const supportedFrameRates = [5, 16, 24, 30, 60]
  const selectedFrameRate = supportedFrameRates.includes(Number(settings.record.frameRate)) ? Number(settings.record.frameRate) : 24
  const outputSettings = `<section class="section"><h2 class="section-title">截图与输出</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>复制后自动保存</b></div>${switchMarkup(settings.screenshot.autoSaveOnCopy, 'autoSaveOnCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>一键快速保存</b></div>${switchMarkup(settings.screenshot.fastSave, 'fastSave', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>长截图默认方向</b></div><select id="longCaptureDirection"><option value="vertical">纵向</option><option value="horizontal">横向</option></select></div><div class="form-row"><div class="form-label"><b>保存目录</b></div><input id="saveDirectory" type="text" value="${escapeHtml(settings.screenshot.saveDirectory || '')}"><button class="button" id="chooseSaveDirectory">选择</button></div><div class="form-row"><div class="form-label"><b>记录截图历史</b></div>${switchMarkup(settings.screenshot.historyEnabled, 'historyEnabled', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>历史数量上限</b></div><input id="historyLimit" type="number" min="10" max="1000" value="${settings.screenshot.historyLimit}"></div></div></section>`
  const ocrSettings = `<section class="section"><h2 class="section-title">文本识别</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>识别模型</b><small>本地 PaddleOCR v4，支持简体中文与英文</small></div><select id="ocrModel"><option value="ppocr-v4-ch">PaddleOCR v4 中英移动版</option></select></div><div class="form-row"><div class="form-label"><b>运行状态</b><small id="ocrStatusDetail">正在检查本地组件</small></div><span id="ocrStatus">检查中</span></div><div class="form-row"><div class="form-label"><b>文字方向检测</b><small>旋转文字较多时开启，普通截图关闭更快</small></div>${switchMarkup(settings.ocr.detectAngle, 'detectAngle', 'ocr')}</div><div class="form-row"><div class="form-label"><b>最低置信度</b><small>低于该分值的文本块不显示</small></div><input id="ocrMinConfidence" type="number" min="0" max="1" step="0.05" value="${settings.ocr.minConfidence}"></div><div class="form-row"><div class="form-label"><b>识别后操作</b></div><select id="ocrAfterAction"><option value="none">显示识别结果</option><option value="copy">复制全部文本</option><option value="copy-and-close">复制文本并关闭截图</option></select></div></div></section>`
  const aiSettings = `<section class="section"><h2 class="section-title">AI 与翻译</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>DeepSeek API Key</b><small>通过系统安全存储加密保存在本机</small></div><input id="apiKey" type="password" value="${escapeHtml(settings.apiKey || '')}" placeholder="sk-..."><button class="button" id="testApi">测试</button></div><div class="form-row"><div class="form-label"><b>模型</b></div><input id="aiModel" type="text" value="${escapeHtml(settings.ai.model)}"></div><div class="form-row"><div class="form-label"><b>最大 Token</b></div><input id="maxTokens" type="number" value="${settings.ai.maxTokens}"></div><div class="form-row"><div class="form-label"><b>Temperature</b></div><input id="temperature" type="number" min="0" max="2" step="0.1" value="${settings.ai.temperature}"></div><div class="form-row"><div class="form-label"><b>默认翻译目标语言</b></div><select id="targetLanguage"><option>中文</option><option>英文</option><option>日文</option><option>韩文</option><option>繁体中文</option></select></div></div></section>`
  const recordSettings = `<section class="section"><h2 class="section-title">视频录制</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>帧率</b><small>录制仅包含画面，保存为 MP4</small></div><select id="frameRate">${supportedFrameRates.map((value) => `<option value="${value}">${value} FPS</option>`).join('')}</select></div><div class="form-row"><div class="form-label"><b>视频保存目录</b></div><input id="recordDirectory" type="text" value="${escapeHtml(settings.record.saveDirectory || '')}"><button class="button" id="chooseRecordDirectory">选择</button></div></div></section>`
  view.innerHTML = `<div class="page">${pageHeader('功能设置', '配置截图、OCR、固定到屏幕、AI、翻译、录屏与输出。')}${outputSettings}${ocrSettings}${aiSettings}${recordSettings}<button class="button primary" id="saveFunctions">保存功能设置</button></div>`
  document.getElementById('ocrModel').value = settings.ocr.modelProfile
  document.getElementById('ocrAfterAction').value = settings.ocr.afterAction
  document.getElementById('longCaptureDirection').value = settings.screenshot.longCaptureDirection || 'vertical'
  window.electronAPI.getOcrStatus().then((status) => {
    const statusLabel = document.getElementById('ocrStatus')
    const statusDetail = document.getElementById('ocrStatusDetail')
    if (!statusLabel || !statusDetail) return
    statusLabel.textContent = status.available ? (status.ready ? '已就绪' : '可用') : '不可用'
    statusDetail.textContent = status.available ? '三个本地模型文件已安装' : `缺少：${status.missingFiles.join('、') || 'OCR 组件'}`
  }).catch(() => {
    const statusLabel = document.getElementById('ocrStatus')
    if (statusLabel) statusLabel.textContent = '检查失败'
  })
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage
  document.getElementById('frameRate').value = String(selectedFrameRate)
  bindSwitches()
  document.getElementById('chooseSaveDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('saveDirectory').value = directory }
  document.getElementById('chooseRecordDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('recordDirectory').value = directory }
  document.getElementById('testApi').onclick = async () => { const button = document.getElementById('testApi'); button.disabled = true; button.textContent = '测试中'; try { const ok = await window.electronAPI.testConnection(document.getElementById('apiKey').value.trim()); toast(ok ? '连接成功' : '连接失败') } catch { toast('连接失败') } finally { button.disabled = false; button.textContent = '测试' } }
  document.getElementById('saveFunctions').onclick = () => updateSettings({ apiKey: document.getElementById('apiKey').value.trim(), screenshot: { saveDirectory: document.getElementById('saveDirectory').value.trim(), historyLimit: Number(document.getElementById('historyLimit').value), longCaptureDirection: document.getElementById('longCaptureDirection').value }, ocr: { modelProfile: document.getElementById('ocrModel').value, minConfidence: Math.max(0, Math.min(1, Number(document.getElementById('ocrMinConfidence').value))), afterAction: document.getElementById('ocrAfterAction').value }, ai: { model: document.getElementById('aiModel').value.trim(), maxTokens: Number(document.getElementById('maxTokens').value), temperature: Number(document.getElementById('temperature').value), targetLanguage: document.getElementById('targetLanguage').value }, record: { frameRate: Number(document.getElementById('frameRate').value), saveDirectory: document.getElementById('recordDirectory').value.trim() } })
}

function renderHotkeySettings() {
  const all = Object.values(functionGroups).flat()
  view.innerHTML = `<div class="page">${pageHeader('热键设置', '点击右侧按键框后录入组合键；右键可清除。红色警告表示快捷键冲突或不可用。')}<div class="function-list">${all.map(([name, label, icon]) => `<div class="function-row"><span class="icon">${iconMarkup(icon)}</span><span class="label">${label}</span>${shortcutButton(name, settings.shortcuts[name] || '')}</div>`).join('')}</div></div>`
  bindShortcutRecorders()
}

async function renderSystemSettings() {
  const dataRoot = await window.electronAPI.getDataRoot()
  if (currentRoute !== 'settings-system') return
  const historyDirectory = settings.screenshot.historyDirectory
  const commonSettings = `<section class="section"><h2 class="section-title">常用</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>开机自动启动</b></div>${switchMarkup(settings.system.autoStart, 'autoStart', 'system')}</div><div class="form-row"><div class="form-label"><b>启用系统托盘</b></div>${switchMarkup(settings.system.enableTray, 'enableTray', 'system')}</div><div class="form-row"><div class="form-label"><b>运行日志</b></div>${switchMarkup(settings.system.runLog, 'runLog', 'system')}</div></div></section>`
  const dataSettings = `<section class="section"><h2 class="section-title">软件数据</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>软件数据目录</b><small>存放应用配置、运行日志、缓存及默认截图历史；更改时迁移配置、日志和目录内的截图历史，缓存将重新创建</small></div><input id="dataRoot" type="text" readonly value="${escapeHtml(dataRoot.path)}"><button class="button" id="openDataRoot">打开</button><button class="button" id="changeDataRoot">更改</button></div><div class="form-row"><div class="form-label"><b>截图导出目录</b><small>${settings.screenshot.saveDirectory ? '当前使用自定义目录' : '未自定义时使用系统“图片”目录'}</small></div><button class="button" id="openSave">打开</button></div><div class="form-row"><div class="form-label"><b>截图历史存储目录</b><small>用于保存截图历史中的图片，不能为空</small></div><input id="historyDirectory" type="text" required value="${escapeHtml(historyDirectory)}"><button class="button" id="chooseHistoryDirectory">选择</button></div><div class="form-row"><div class="form-label"><b>清除截图历史</b><small>同时删除截图历史目录中的对应图片文件</small></div><button class="button danger" id="clearData">清除</button></div></div></section>`
  const diagnosticsSettings = `<section class="section"><h2 class="section-title">本地诊断</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>预览诊断信息</b><small>仅展示版本、系统、显示器、组件、退出记录和日志文件摘要；不会上传任何数据</small></div><button class="button" id="previewDiagnostics">预览</button></div><div class="form-row"><div class="form-label"><b>导出诊断包</b><small>默认排除配置、凭据、AI/划词内容、截图、OCR、历史和录屏文件</small></div><button class="button primary" id="exportDiagnostics">导出 ZIP</button></div><div class="form-row"><div class="form-label"><b>包含崩溃转储</b><small>转储可能含进程内存片段，仅在明确需要排查崩溃时勾选</small></div><input id="includeCrashDumps" type="checkbox"></div><pre id="diagnosticsPreview" class="diagnostics-preview" hidden></pre></div></section>`
  view.innerHTML = `<div class="page">${pageHeader('系统设置', '控制自启动、托盘、日志、诊断和数据存储位置。')}${commonSettings}${dataSettings}${diagnosticsSettings}<button class="button danger" id="resetSettings">恢复默认设置</button></div>`
  bindSwitches()
  document.getElementById('previewDiagnostics').onclick = async () => {
    const button = document.getElementById('previewDiagnostics')
    button.disabled = true
    button.textContent = '读取中'
    try {
      const diagnostics = await window.electronAPI.previewDiagnostics()
      const preview = document.getElementById('diagnosticsPreview')
      if (!preview) return
      preview.textContent = JSON.stringify(diagnostics, null, 2)
      preview.hidden = false
    } catch (error) {
      toast(error.message || '无法生成诊断预览')
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = '预览'
      }
    }
  }
  document.getElementById('exportDiagnostics').onclick = async () => {
    const includeCrashDumps = document.getElementById('includeCrashDumps').checked
    if (includeCrashDumps && !confirm('崩溃转储可能包含进程内存片段。确认将本机转储加入诊断包？')) return
    const button = document.getElementById('exportDiagnostics')
    button.disabled = true
    button.textContent = '导出中'
    try {
      const result = await window.electronAPI.exportDiagnostics(includeCrashDumps)
      if (!result.canceled) toast(`诊断包已导出：${result.outputPath}`)
    } catch (error) {
      toast(error.message || '诊断包导出失败')
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = '导出 ZIP'
      }
    }
  }
  document.getElementById('openDataRoot').onclick = () => window.electronAPI.openDataRoot().catch((error) => toast(error.message || '无法打开软件数据目录'))
  document.getElementById('changeDataRoot').onclick = async () => {
    const button = document.getElementById('changeDataRoot')
    button.disabled = true
    button.textContent = '更改中'
    let restarting = false
    try {
      const result = await window.electronAPI.changeDataRoot()
      if (result?.restarting) {
        restarting = true
        toast('数据目录迁移完成，正在重启')
      }
    } catch (error) {
      toast(error.message || '数据目录迁移失败')
    } finally {
      if (!restarting) {
        button.disabled = false
        button.textContent = '更改'
      }
    }
  }
  document.getElementById('openSave').onclick = () => window.electronAPI.openSaveDirectory()
  const historyDirectoryInput = document.getElementById('historyDirectory')
  const saveHistoryDirectory = () => {
    const directory = historyDirectoryInput.value.trim()
    if (!directory) {
      historyDirectoryInput.value = settings.screenshot.historyDirectory
      toast('截图历史存储目录不能为空')
      return null
    }
    return updateSettings({ screenshot: { historyDirectory: directory } }, '截图历史存储目录已更新')
  }
  historyDirectoryInput.onchange = saveHistoryDirectory
  historyDirectoryInput.onkeydown = (event) => { if (event.key === 'Enter') historyDirectoryInput.blur() }
  document.getElementById('chooseHistoryDirectory').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    historyDirectoryInput.value = directory
    await saveHistoryDirectory()
  }
  document.getElementById('clearData').onclick = async () => {
    if (!confirm('确定清空截图历史并删除对应图片文件？')) return
    try { await window.electronAPI.clearHistory(); toast('截图历史和图片文件已清空') }
    catch (error) { toast(error.message || '部分图片文件删除失败') }
  }
  document.getElementById('resetSettings').onclick = async () => { if (confirm('确定恢复默认设置？')) { settings = await window.electronAPI.resetSettings(); await refreshShortcutStatuses(); applyAppearance(); renderRoute(); toast('已恢复默认设置') } }
}

async function renderAbout() {
  const info = await window.electronAPI.getAppInfo()
  view.innerHTML = `<div class="page"><div class="card about"><div class="about-logo"><span>High</span>lighter</div><h2>桌面截图与划词效率工具</h2><p>版本 ${escapeHtml(info.version)} · ${escapeHtml(info.platform)}</p><p>集截图标注、长截图、文字与表格识别、二维码扫描、贴图、历史管理、翻译、AI 对话、录屏、全屏画布、热键和个性化设置于一体。</p><button class="button" id="openProjectHome">项目主页</button></div></div>`
  document.getElementById('openProjectHome').onclick = () => window.electronAPI.openExternal('https://github.com/SherUnlocked-4869/Highlighter')
}

document.querySelectorAll('.nav-item').forEach((button) => button.onclick = () => navigate(button.dataset.route))
document.getElementById('minimize').onclick = () => window.electronAPI.windowMinimize()
document.getElementById('close').onclick = () => window.electronAPI.windowClose()
window.electronAPI.onNavigate(navigate)
window.electronAPI.onHistoryChanged(() => { if (currentRoute === 'history') renderHistory() })
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)

async function init() {
  settings = await window.electronAPI.getSettings()
  await refreshShortcutStatuses()
  applyAppearance()
  navigate('home')
}
init()
