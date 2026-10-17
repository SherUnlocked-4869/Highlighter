// S14 / D2-2 (Wave 8.5): this file owns the about route. Since the P3 cleanup the
// software-update card lives on the General settings page (Settings > General >
// Software update); about stays a pure information page and only links there.

let shortcutStatuses = {}
let aboutInfo = null
let aboutRenderVersion = 0

async function renderAbout() {
  const renderVersion = ++aboutRenderVersion
  const info = aboutInfo || await window.electronAPI.getAppInfo()
  if (renderVersion !== aboutRenderVersion || currentRoute !== 'about') return
  aboutInfo = info
  const installTypeLabels = { nsis: 'config.about.install-nsis', portable: 'config.about.install-portable', unpacked: 'config.about.install-unpacked', development: 'config.about.install-development' }
  view.innerHTML = `<div class="page"><div class="card about"><div class="about-logo"><span>High</span>lighter</div><h2>${t('config.about.tagline')}</h2><p>${t('config.about.version-line', { version: escapeHtml(info.version), platform: escapeHtml(info.platform), installType: escapeHtml(installTypeLabels[info.installType] ? t(installTypeLabels[info.installType]) : info.installType) })}</p><p>${t('config.about.intro')}</p><button class="button" id="openProjectHome">${t('config.about.project-home')}</button><div style="margin-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><small>${t('config.about.update-moved')}</small><button class="button" id="openUpdateSettings">${t('config.about.update-section')}</button></div></div></div>`
  document.getElementById('openProjectHome').onclick = () => window.electronAPI.openExternal('https://github.com/SherUnlocked-4869/Highlighter')
  document.getElementById('openUpdateSettings').onclick = () => navigate('settings-general')
}

// D2-2 (S14): register the route entry on the shell dispatch table. config.html
// loads this file before config.js; the arrow function keeps the lookup lazy.
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderAbout'] = () => renderAbout()
