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
    idle: status.lastCheckedAt ? t('config.about.update-idle-current') : t('config.about.update-idle'),
    checking: t('config.about.update-checking'),
    available: t('config.about.update-available', { version: status.version || '' }).trim(),
    downloading: t('config.about.update-downloading', { percent: Math.round(status.progress?.percent || 0) }),
    downloaded: t('config.about.update-downloaded', { version: status.version || '' }).trim(),
    installing: t('config.about.update-installing'),
    error: status.error?.message || t('config.about.update-failed')
  }
  return labels[status.status] || t('config.about.update-unknown')
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
  const installTypeLabels = { nsis: 'config.about.install-nsis', portable: 'config.about.install-portable', unpacked: 'config.about.install-unpacked', development: 'config.about.install-development' }
  const busy = ['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(status.status)
  let primaryAction = 'check'
  let primaryLabel = t('config.about.check-update')
  if (status.portable || status.installType !== 'nsis') {
    primaryAction = 'open'
    primaryLabel = t('config.about.open-download-page')
  } else if (status.status === 'available') {
    primaryAction = 'download'
    primaryLabel = t('config.about.download-update')
  } else if (status.status === 'downloaded') {
    primaryAction = 'install'
    primaryLabel = t('config.about.install-update')
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
    ? '<small class="section-note">' + t('config.about.portable-note') + '</small>'
    : status.installType !== 'nsis'
      ? '<small class="section-note">' + t('config.about.unsupported-note') + '</small>'
      : ''
  view.innerHTML = `<div class="page"><div class="card about"><div class="about-logo"><span>High</span>lighter</div><h2>${t('config.about.tagline')}</h2><p>${t('config.about.version-line', { version: escapeHtml(info.version), platform: escapeHtml(info.platform), installType: escapeHtml(installTypeLabels[info.installType] ? t(installTypeLabels[info.installType]) : info.installType) })}</p><p>${t('config.about.intro')}</p><button class="button" id="openProjectHome">${t('config.about.project-home')}</button></div><section class="card update-card"><div class="update-head"><div><h2>${t('config.about.update-section')}</h2><p>${escapeHtml(updateStatusPresentation(status))}</p></div><label>${t('config.about.update-channel')}<select id="updateChannel" ${busy ? 'disabled' : ''}><option value="stable" ${status.channel === 'stable' ? 'selected' : ''}>${t('config.about.channel-stable')}</option><option value="beta" ${status.channel === 'beta' ? 'selected' : ''}>${t('config.about.channel-beta')}</option></select></label></div>${status.channel === 'beta' ? '<div class="update-guidance warning">' + t('config.about.beta-warning') + '</div>' : ''}${releaseDetails}${progress}${releaseNotes}${guidance}${portabilityNote}<div class="update-actions"><button class="button primary" id="primaryUpdateAction" data-action="${primaryAction}" ${busy ? 'disabled' : ''}>${primaryLabel}</button><button class="button" id="openUpdateDownloads">${t('config.about.release-page')}</button></div></section></div>`
  document.getElementById('openProjectHome').onclick = () => window.electronAPI.openExternal('https://github.com/SherUnlocked-4869/Highlighter')
  document.getElementById('openUpdateDownloads').onclick = () => window.electronAPI.openUpdateDownloadPage()
  document.getElementById('updateChannel').onchange = async (event) => {
    try {
      await updateSettings({ system: { updateChannel: event.target.value } }, '')
      await renderAbout()
    } catch (error) { toast(error.message || t('config.about.channel-switch-failed')) }
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
    } catch (error) { toast(error.message || t('config.about.update-failed')) }
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderAbout'] = () => renderAbout()
