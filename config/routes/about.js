// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 about（关于与软件更新）。

let shortcutStatuses = {}
let latestUpdateStatus = null
let aboutInfo = null
let aboutRenderVersion = 0

function formatUpdateBytes(value) {
  const bytes = Number(value) || 0
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function updateStatusPresentation(status) {
  const labels = {
    idle: status.lastCheckedAt ? '已是最新版本' : '尚未检查更新',
    checking: '正在检查更新…',
    available: `发现新版本 ${status.version || ''}`.trim(),
    downloading: `正在下载 ${Math.round(status.progress?.percent || 0)}%`,
    downloaded: `版本 ${status.version || ''} 已准备安装`.trim(),
    installing: '正在退出并安装更新…',
    error: status.error?.message || '更新操作失败'
  }
  return labels[status.status] || '更新状态未知'
}

async function renderAbout(snapshot = null) {
  const renderVersion = ++aboutRenderVersion
  const [info, status] = await Promise.all([
    aboutInfo || window.electronAPI.getAppInfo(),
    snapshot || latestUpdateStatus || window.electronAPI.getUpdateStatus()
  ])
  if (renderVersion !== aboutRenderVersion || currentRoute !== 'about') return
  aboutInfo = info
  latestUpdateStatus = status
  const installTypeLabels = { nsis: '安装版', portable: '便携版', unpacked: '解压测试版', development: '开发环境' }
  const busy = ['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(status.status)
  let primaryAction = 'check'
  let primaryLabel = '检查更新'
  if (status.portable || status.installType !== 'nsis') {
    primaryAction = 'open'
    primaryLabel = '打开下载页'
  } else if (status.status === 'available') {
    primaryAction = 'download'
    primaryLabel = '下载更新'
  } else if (status.status === 'downloaded') {
    primaryAction = 'install'
    primaryLabel = '退出并安装'
  }
  const releaseDetails = status.version
    ? `<div class="update-release"><b>${escapeHtml(status.version)}</b>${status.releaseDate ? `<span>${escapeHtml(new Date(status.releaseDate).toLocaleDateString())}</span>` : ''}${status.size ? `<span>${escapeHtml(formatUpdateBytes(status.size))}</span>` : ''}</div>`
    : ''
  const releaseNotes = status.releaseNotes
    ? `<div class="update-notes">${escapeHtml(status.releaseNotes).replace(/\n/g, '<br>')}</div>`
    : ''
  const progress = status.status === 'downloading'
    ? `<progress class="update-progress" max="100" value="${Math.max(0, Math.min(100, Number(status.progress?.percent) || 0))}"></progress>`
    : ''
  const guidance = status.installBlocked
    ? `<div class="update-guidance warning">${escapeHtml(status.installBlocked)}</div>`
    : status.error?.action
      ? `<div class="update-guidance">${escapeHtml(status.error.action)}</div>`
      : ''
  const portabilityNote = status.portable
    ? '<small class="section-note">便携版不会在应用内替换自身，请从发布页下载新版本。</small>'
    : status.installType !== 'nsis'
      ? '<small class="section-note">当前运行方式不支持应用内更新，请使用正式安装版。</small>'
      : ''
  view.innerHTML = `<div class="page"><div class="card about"><div class="about-logo"><span>High</span>lighter</div><h2>桌面截图与划词效率工具</h2><p>版本 ${escapeHtml(info.version)} · ${escapeHtml(info.platform)} · ${escapeHtml(installTypeLabels[info.installType] || info.installType)}</p><p>集截图标注、长截图、文字与表格识别、二维码扫描、贴图、历史管理、翻译、AI 对话、录屏、全屏画布、热键和个性化设置于一体。</p><button class="button" id="openProjectHome">项目主页</button></div><section class="card update-card"><div class="update-head"><div><h2>软件更新</h2><p>${escapeHtml(updateStatusPresentation(status))}</p></div><label>更新通道<select id="updateChannel" ${busy ? 'disabled' : ''}><option value="stable" ${status.channel === 'stable' ? 'selected' : ''}>稳定版</option><option value="beta" ${status.channel === 'beta' ? 'selected' : ''}>测试版</option></select></label></div>${status.channel === 'beta' ? '<div class="update-guidance warning">测试版可能包含尚未完成验证的改动；切回稳定版不会自动降级。</div>' : ''}${releaseDetails}${progress}${releaseNotes}${guidance}${portabilityNote}<div class="update-actions"><button class="button primary" id="primaryUpdateAction" data-action="${primaryAction}" ${busy ? 'disabled' : ''}>${primaryLabel}</button><button class="button" id="openUpdateDownloads">发布页</button></div></section></div>`
  document.getElementById('openProjectHome').onclick = () => window.electronAPI.openExternal('https://github.com/SherUnlocked-4869/Highlighter')
  document.getElementById('openUpdateDownloads').onclick = () => window.electronAPI.openUpdateDownloadPage()
  document.getElementById('updateChannel').onchange = async (event) => {
    try {
      await updateSettings({ system: { updateChannel: event.target.value } }, '')
      await renderAbout()
    } catch (error) { toast(error.message || '无法切换更新通道') }
  }
  document.getElementById('primaryUpdateAction').onclick = async (event) => {
    const actions = {
      check: () => window.electronAPI.checkForUpdates(),
      download: () => window.electronAPI.downloadUpdate(),
      install: () => window.electronAPI.installUpdate(),
      open: () => window.electronAPI.openUpdateDownloadPage()
    }
    try {
      const nextStatus = await actions[event.currentTarget.dataset.action]()
      if (nextStatus?.status) latestUpdateStatus = nextStatus
      await renderAbout(nextStatus?.status ? nextStatus : null)
    } catch (error) { toast(error.message || '更新操作失败') }
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderAbout'] = () => renderAbout()
