// S14 / D2-2 (Wave 8.5): the settings window shell (config/config.js) is split per
// route; this file owns the three settings routes:
//   settings-general  -> appearance, interface language, startup/tray, feature modules
//   settings-function -> capture/output, text recognition and recording/pin tabs
//   settings-system   -> app data, translation proxy, diagnostics and reset
// Settings save on change: there is no per-page save button any more.

// --- Software update (moved here from the about page in P3) -----------------
// The General page is a synchronous route, so it renders a placeholder card and
// refreshGeneralUpdateCard() fills it once the status IPC round trip returns.
let latestUpdateStatus = null

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

function updateCardInnerMarkup(status) {
  const busy = ['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(status.status)
  // autoDownload is off (main/services/update-service.js), so 'available' and
  // 'downloaded' advance only when the user clicks; disabling the primary button
  // in those states made the in-app update unreachable. Only in-flight states may
  // disable it (the channel select keeps the broader `busy`).
  const primaryBusy = ['checking', 'downloading', 'installing'].includes(status.status)
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
  const autoCheckRow = `<div class="form-row update-auto-check"><div class="form-label"><b>${t('config.about.auto-check-updates')}</b><small>${t('config.about.auto-check-updates-hint')}</small></div><button type="button" class="switch ${status.autoCheckEnabled === true ? 'on' : ''}" role="switch" aria-checked="${status.autoCheckEnabled === true}" data-switch="autoCheckUpdates" data-group="system"></button></div>`
  return `<div class="card update-card"><div class="update-head"><div><h2>${t('config.about.update-section')}</h2><p>${escapeHtml(updateStatusPresentation(status))}</p></div><label>${t('config.about.update-channel')}<select id="updateChannel" ${busy ? 'disabled' : ''}><option value="stable" ${status.channel === 'stable' ? 'selected' : ''}>${t('config.about.channel-stable')}</option><option value="beta" ${status.channel === 'beta' ? 'selected' : ''}>${t('config.about.channel-beta')}</option></select></label></div>${autoCheckRow}${status.channel === 'beta' ? '<div class="update-guidance warning">' + t('config.about.beta-warning') + '</div>' : ''}${releaseDetails}${progress}${releaseNotes}${guidance}${portabilityNote}<div class="update-actions"><button class="button primary" id="primaryUpdateAction" data-action="${primaryAction}" ${primaryBusy ? 'disabled' : ''}>${primaryLabel}</button><button class="button" id="openUpdateDownloads">${t('config.about.release-page')}</button></div></div>`
}

function bindGeneralUpdateCard() {
  const channel = document.getElementById('updateChannel')
  if (channel) {
    channel.onchange = async (event) => {
      try {
        await updateSettings({ system: { updateChannel: event.target.value } }, '')
        await refreshGeneralUpdateCard()
      } catch (error) { toast(error.message || t('config.about.channel-switch-failed')) }
    }
  }
  const downloads = document.getElementById('openUpdateDownloads')
  if (downloads) downloads.onclick = () => window.electronAPI.openUpdateDownloadPage()
  const primary = document.getElementById('primaryUpdateAction')
  if (primary) {
    primary.onclick = async (event) => {
      const actions = {
        check: () => window.electronAPI.checkForUpdates(),
        download: () => window.electronAPI.downloadUpdate(),
        install: () => window.electronAPI.installUpdate(),
        open: () => window.electronAPI.openUpdateDownloadPage()
      }
      try {
        const nextStatus = await actions[event.currentTarget.dataset.action]()
        if (nextStatus?.status) latestUpdateStatus = nextStatus
        await refreshGeneralUpdateCard(nextStatus?.status ? nextStatus : null)
      } catch (error) { toast(error.message || t('config.about.update-failed')) }
    }
  }
}

async function refreshGeneralUpdateCard(snapshot = null) {
  if (currentRoute !== 'settings-general') return
  const status = snapshot || latestUpdateStatus || await window.electronAPI.getUpdateStatus().catch(() => null)
  if (!status) return
  latestUpdateStatus = status
  const container = document.getElementById('updateCard')
  if (!container) return
  container.innerHTML = updateCardInnerMarkup(status)
  bindGeneralUpdateCard()
  // The card is re-rendered after every status push, so its switch is rebound here; the
  // generic binder (shared.js) turns the click into updateSettings({ system: { ... } }).
  bindSwitches()
}

function settingsFieldLabel(id, labelKey, hintKey) {
  const hint = hintKey ? `<small id="${id}Hint">${t(hintKey)}</small>` : ''
  return `<div class="form-label"><label for="${id}"><b>${t(labelKey)}</b></label>${hint}</div>`
}

function renderGeneralSettings() {
  const moduleRows = [
    ['ocr', 'config.plugin.ocr-title', 'config.plugin.ocr-description'],
    ['translation', 'config.plugin.translation-title', 'config.plugin.translation-description'],
    ['ai', 'config.plugin.ai-title', 'config.plugin.ai-description'],
    ['video', 'config.plugin.video-title', 'config.plugin.video-description']
  ]
  const appearanceSettings = `<section class="section"><h2 class="section-title">${t('config.general.appearance-section')}</h2><div class="card form-card">
    <div class="form-row">${settingsFieldLabel('theme', 'config.appearance.theme', 'config.appearance.theme-hint')}<select id="theme" aria-describedby="themeHint"><option value="system">${t('config.appearance.theme-system')}</option><option value="light">${t('config.appearance.theme-light')}</option><option value="dark">${t('config.appearance.theme-dark')}</option></select></div>
    <div class="form-row">${settingsFieldLabel('mainColor', 'config.appearance.main-color', 'config.appearance.main-color-hint')}<input id="mainColor" aria-describedby="mainColorHint" type="color" value="${settings.mainColor}"></div>
    <div class="form-row">${settingsFieldLabel('borderRadius', 'config.appearance.border-radius')}<input id="borderRadius" type="range" min="0" max="20" value="${settings.borderRadius}"></div>
    <div class="form-row"><div class="form-label"><b>${t('config.appearance.compact')}</b></div>${switchMarkup(settings.compact, 'compact')}</div>
    <div class="form-row">${settingsFieldLabel('skinPath', 'config.appearance.skin-path', 'config.appearance.skin-path-hint')}<input id="skinPath" aria-describedby="skinPathHint" type="text" value="${escapeHtml(settings.skinPath || '')}" placeholder="D:\\Pictures\\skin.jpg"></div>
    <div class="form-row">${settingsFieldLabel('skinOpacity', 'config.appearance.skin-opacity')}<input id="skinOpacity" type="range" min="0" max="100" value="${settings.skinOpacity || 0}"></div>
    <div class="form-row" style="align-items:flex-start;padding:14px 0">${settingsFieldLabel('customCss', 'config.appearance.custom-css', 'config.appearance.custom-css-hint')}<textarea id="customCss" aria-describedby="customCssHint" class="textarea" style="min-height:130px">${escapeHtml(settings.customCss || '')}</textarea></div>
  </div></section>`
  const interfaceSettings = `<section class="section"><h2 class="section-title">${t('config.general.interface-section')}</h2><div class="card form-card">
    <div class="form-row">${settingsFieldLabel('interfaceLanguage', 'config.setting.language')}<select id="interfaceLanguage"><option value="zh-CN">${t('common.language.zh')}</option><option value="en-US">${t('common.language.en')}</option><option value="zh-TW">${t('common.language.zh-hant')}</option></select></div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-general.zoom')}</b><small>${t('config.settings-general.zoom-hint')}</small></div><span>${t('config.settings-general.zoom-auto')}</span></div>
  </div></section>`
  const startupSettings = `<section class="section"><h2 class="section-title">${t('config.general.startup-section')}</h2><div class="card form-card">
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.auto-start')}</b></div>${switchMarkup(settings.system.autoStart, 'autoStart', 'system')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.enable-tray')}</b></div>${switchMarkup(settings.system.enableTray, 'enableTray', 'system')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.game-mode')}</b><small>${t('config.settings-system.game-mode-hint')}</small></div>${switchMarkup(settings.system.gameMode, 'gameMode', 'system')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.run-log')}</b></div>${switchMarkup(settings.system.runLog, 'runLog', 'system')}</div>
  </div></section>`
  const moduleSettings = `<section class="section"><h2 class="section-title">${t('config.general.modules-section')} <small>${t('config.plugins.description')}</small></h2><div class="card form-card">
    ${moduleRows.map(([key, title, description]) => `<div class="form-row"><div class="form-label"><b>${t(title)}</b><small>${t(description)}</small></div>${switchMarkup(settings.plugins[key], key, 'plugins')}</div>`).join('')}
  </div></section>`
  const updateSection = `<section class="section"><h2 class="section-title">${t('config.about.update-section')}</h2><div id="updateCard"><div class="card update-card"><div class="update-head"><div><p>${t('config.about.update-checking')}</p></div></div></div></div></section>`
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-general'), t('config.settings-general.description'))}${appearanceSettings}${interfaceSettings}${startupSettings}${moduleSettings}${updateSection}</div>`

  const theme = document.getElementById('theme')
  theme.value = settings.theme
  theme.onchange = () => updateSettings({ theme: theme.value })
  const mainColor = document.getElementById('mainColor')
  mainColor.onchange = () => updateSettings({ mainColor: mainColor.value })
  const borderRadius = document.getElementById('borderRadius')
  borderRadius.onchange = () => updateSettings({ borderRadius: Number(borderRadius.value) })
  const skinPath = document.getElementById('skinPath')
  skinPath.onchange = () => updateSettings({ skinPath: skinPath.value.trim() })
  const skinOpacity = document.getElementById('skinOpacity')
  skinOpacity.onchange = () => updateSettings({ skinOpacity: Number(skinOpacity.value) })
  const customCss = document.getElementById('customCss')
  customCss.onchange = () => updateSettings({ customCss: customCss.value })
  // P0-1-T3: the interface language applies immediately (the settings effect
  // broadcasts it to every window); the row rides the frozen `language` key.
  const interfaceLanguage = document.getElementById('interfaceLanguage')
  interfaceLanguage.value = settings.language || 'zh-CN'
  interfaceLanguage.onchange = () => updateSettings({ language: interfaceLanguage.value }, t('config.settings-general.language-updated'))
  bindSwitches()
  void refreshGeneralUpdateCard()
}

// settings-function keeps its tab in module state so leaving the route and
// coming back restores the tab the user was on.
let functionTab = 'capture'

function bindFunctionCaptureTab() {
  const longCaptureDirection = document.getElementById('longCaptureDirection')
  longCaptureDirection.value = settings.screenshot.longCaptureDirection || 'vertical'
  longCaptureDirection.onchange = () => updateSettings({ screenshot: { longCaptureDirection: longCaptureDirection.value } })
  const saveDirectory = document.getElementById('saveDirectory')
  saveDirectory.onchange = () => updateSettings({ screenshot: { saveDirectory: saveDirectory.value.trim() } })
  document.getElementById('chooseSaveDirectory').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    saveDirectory.value = directory
    await updateSettings({ screenshot: { saveDirectory: directory } })
  }
  document.getElementById('nameTemplate').onchange = () => updateSettings({ screenshot: { nameTemplate: document.getElementById('nameTemplate').value.trim() } })
  const historyLimit = document.getElementById('historyLimit')
  historyLimit.onchange = () => updateSettings({ screenshot: { historyLimit: Number(historyLimit.value) } })
  const historyDirectory = document.getElementById('historyDirectory')
  const saveHistoryDirectory = () => {
    const directory = historyDirectory.value.trim()
    if (!directory) {
      historyDirectory.value = settings.screenshot.historyDirectory
      toast(t('config.settings-system.history-directory-required'))
      return null
    }
    return updateSettings({ screenshot: { historyDirectory: directory } }, t('config.settings-system.history-directory-updated'))
  }
  historyDirectory.onchange = saveHistoryDirectory
  historyDirectory.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) historyDirectory.blur()
  }
  document.getElementById('chooseHistoryDirectory').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    historyDirectory.value = directory
    await saveHistoryDirectory()
  }
  const selectionMask = document.getElementById('selectionMask')
  selectionMask.onchange = () => updateSettings({ screenshot: { selectionMask: selectionMask.value.trim() } })
  bindSwitches()
}

function bindFunctionOcrTab() {
  const ocrModel = document.getElementById('ocrModel')
  ocrModel.value = settings.ocr.modelProfile
  ocrModel.onchange = () => updateSettings({ ocr: { modelProfile: ocrModel.value } })
  const minConfidence = document.getElementById('ocrMinConfidence')
  minConfidence.onchange = () => updateSettings({ ocr: { minConfidence: Math.max(0, Math.min(1, Number(minConfidence.value))) } })
  const afterAction = document.getElementById('ocrAfterAction')
  afterAction.value = settings.ocr.afterAction
  afterAction.onchange = () => updateSettings({ ocr: { afterAction: afterAction.value } })
  window.electronAPI.getOcrStatus().then((status) => {
    const statusLabel = document.getElementById('ocrStatus')
    const statusDetail = document.getElementById('ocrStatusDetail')
    if (!statusLabel || !statusDetail) return
    statusLabel.textContent = status.available ? (status.ready ? t('config.function-settings.ocr-ready') : t('config.function-settings.ocr-available')) : t('config.function-settings.ocr-unavailable')
    statusDetail.textContent = status.available ? t('config.function-settings.ocr-models-installed') : t('config.function-settings.ocr-missing', { files: status.missingFiles.join(t('config.common.list-separator')) || t('config.function-settings.ocr-component') })
  }).catch(() => {
    const statusLabel = document.getElementById('ocrStatus')
    if (statusLabel) statusLabel.textContent = t('config.function-settings.ocr-check-failed')
  })
  const enableOcrModule = document.getElementById('enableOcrModule')
  if (enableOcrModule) {
    enableOcrModule.onclick = async () => {
      await updateSettings({ plugins: { ocr: true } })
      if (currentRoute !== 'settings-function') return
      renderFunctionSettings()
    }
  }
  bindSwitches()
}

// Recording settings are the DEFAULTS a new capture starts from; the per-capture
// choices (mode, target, temporary audio/quality overrides) live in the recording
// workbench (config/routes/recording.js). Keeping the split explicit is what stops
// this page from growing a second, divergent recording form.
const RECORD_QUALITY_LABEL_KEYS = {
  standard: 'config.function-settings.record-quality-standard',
  high: 'config.function-settings.record-quality-high',
  ultra: 'config.function-settings.record-quality-ultra'
}

function recordDefaultCountdownLabel(seconds) {
  const value = Number(seconds)
  if (value === 0) return t('config.function-settings.record-countdown-off')
  return t('config.function-settings.record-countdown-seconds', { seconds: value })
}

function writeRecordingDefault(patch) {
  // The record defaults are validated by the main process; a rejected key (for
  // example while a newer build has not landed the default yet) must surface as a
  // toast instead of an unhandled rejection.
  return updateSettings({ record: patch }).catch((error) => toast(errorMessage(error) || t('config.function-settings.record-settings-failed')))
}

async function populateRecordMicrophoneDevices(select) {
  const fallback = `<option value="">${t('config.function-settings.record-microphone-default')}</option>`
  const saved = typeof settings.record.audioMicrophoneDeviceId === 'string' ? settings.record.audioMicrophoneDeviceId : ''
  let options = ''
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.() || []
    const seen = new Set()
    let index = 0
    for (const device of devices) {
      if (!device || device.kind !== 'audioinput') continue
      const id = typeof device.deviceId === 'string' ? device.deviceId : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      index += 1
      const label = typeof device.label === 'string' && device.label
        ? device.label
        : `${t('config.function-settings.record-microphone-device')} ${index}`
      options += `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`
    }
    if (saved && !seen.has(saved)) options += `<option value="${escapeHtml(saved)}">${escapeHtml(saved)}</option>`
  } catch {
    // Device enumeration can be unavailable without media permission; the saved
    // id still has to be selectable so the row does not silently drop it.
    if (saved) options = `<option value="${escapeHtml(saved)}">${escapeHtml(saved)}</option>`
  }
  if (!select.isConnected) return
  select.innerHTML = fallback + options
  select.value = saved
}

function bindFunctionRecordTab() {
  const frameRate = document.getElementById('frameRate')
  frameRate.onchange = () => writeRecordingDefault({ frameRate: Number(frameRate.value) })
  const recordQuality = document.getElementById('recordQuality')
  if (recordQuality) recordQuality.onchange = () => writeRecordingDefault({ quality: recordQuality.value })
  const recordCountdown = document.getElementById('recordCountdown')
  if (recordCountdown) recordCountdown.onchange = () => writeRecordingDefault({ countdown: Number(recordCountdown.value) })
  const recordMicDevice = document.getElementById('recordMicDevice')
  if (recordMicDevice) {
    recordMicDevice.onchange = () => writeRecordingDefault({ audioMicrophoneDeviceId: recordMicDevice.value })
    void populateRecordMicrophoneDevices(recordMicDevice)
  }
  const recordDirectory = document.getElementById('recordDirectory')
  recordDirectory.onchange = () => writeRecordingDefault({ saveDirectory: recordDirectory.value.trim() })
  document.getElementById('chooseRecordDirectory').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    recordDirectory.value = directory
    await writeRecordingDefault({ saveDirectory: directory })
  }
  const openRecordingData = document.getElementById('openRecordingData')
  if (openRecordingData) {
    openRecordingData.onclick = () => window.electronAPI.openDataRoot().catch((error) => toast(errorMessage(error) || t('config.function-settings.record-open-data-failed')))
  }
  // P1 (2026-10-18 snow migration §9.1): the wheel step is stored as a fraction,
  // while the row offers whole percent values; main-side normalization clamps it
  // into 5%..50%, so a hand-edited store cannot make one notch resize by nothing.
  const pinZoomStep = document.getElementById('pinZoomStep')
  if (pinZoomStep) pinZoomStep.onchange = () => updateSettings({ pinned: { zoomStep: Number(pinZoomStep.value) / 100 } })
  bindSwitches()
}

function renderFunctionSettings() {
  const supportedFrameRates = [5, 16, 24, 30, 60]
  const selectedFrameRate = supportedFrameRates.includes(Number(settings.record.frameRate)) ? Number(settings.record.frameRate) : 24
  // Quality/countdown/device defaults were frozen with the recording workbench
  // (contract §3); a store written before that still renders the frozen default.
  const selectedRecordQuality = Object.hasOwn(RECORD_QUALITY_LABEL_KEYS, settings.record.quality) ? settings.record.quality : 'standard'
  const selectedRecordCountdown = [0, 3, 5].includes(Number(settings.record.countdown)) ? Number(settings.record.countdown) : 3
  const tabs = [
    ['capture', 'config.function-settings.output-section'],
    ['ocr', 'config.function-settings.ocr-section'],
    ['record', 'config.function-tabs.record']
  ]
  const tabsMarkup = `<div class="tabs">${tabs.map(([tab, label]) => `<button aria-pressed="${functionTab === tab}" data-function-tab="${tab}">${t(label)}</button>`).join('')}</div>`
  const captureSettings = `<div class="card form-card">
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.auto-save-on-copy')}</b></div>${switchMarkup(settings.screenshot.autoSaveOnCopy, 'autoSaveOnCopy', 'screenshot')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.fast-save')}</b></div>${switchMarkup(settings.screenshot.fastSave, 'fastSave', 'screenshot')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.shutter-sound')}</b><small>${t('config.function-settings.shutter-sound-hint')}</small></div>${switchMarkup(settings.screenshot.shutterSound, 'shutterSound', 'screenshot')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.capture-cursor')}</b><small>${t('config.function-settings.capture-cursor-hint')}</small></div>${switchMarkup(settings.screenshot.captureCursor === true, 'captureCursor', 'screenshot')}</div>
    <div class="form-row">${settingsFieldLabel('longCaptureDirection', 'config.function-settings.long-capture-direction')}<select id="longCaptureDirection"><option value="vertical">${t('config.function-settings.vertical')}</option><option value="horizontal">${t('config.function-settings.horizontal')}</option></select></div>
    <div class="form-row"><label class="form-label" for="saveDirectory"><b>${t('config.function-settings.save-directory')}</b></label><div class="action-group field-actions"><input id="saveDirectory" type="text" value="${escapeHtml(settings.screenshot.saveDirectory || '')}"><button class="button" id="chooseSaveDirectory">${t('config.function-settings.choose')}</button></div></div>
    <div class="form-row">${settingsFieldLabel('nameTemplate', 'config.function-settings.name-template', 'config.function-settings.name-template-hint')}<input id="nameTemplate" type="text" value="${escapeHtml(settings.screenshot.nameTemplate || '')}" placeholder="${t('config.function-settings.name-template-placeholder')}" aria-describedby="nameTemplateHint"></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.keep-serial')}</b><small>${t('config.function-settings.keep-serial-hint')}</small></div>${switchMarkup(settings.screenshot.keepSerialAcrossCaptures, 'keepSerialAcrossCaptures', 'screenshot')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.history-enabled')}</b></div>${switchMarkup(settings.screenshot.historyEnabled, 'historyEnabled', 'screenshot')}</div>
    <div class="form-row">${settingsFieldLabel('historyLimit', 'config.function-settings.history-limit')}<input id="historyLimit" type="number" min="10" max="1000" value="${settings.screenshot.historyLimit}"></div>
    <div class="form-row">${settingsFieldLabel('historyDirectory', 'config.settings-system.history-directory', 'config.settings-system.history-directory-hint')}<div class="action-group field-actions"><input id="historyDirectory" aria-describedby="historyDirectoryHint" type="text" required value="${escapeHtml(settings.screenshot.historyDirectory)}"><button class="button" id="chooseHistoryDirectory">${t('config.settings-system.choose')}</button></div></div>
    <div class="form-row">${settingsFieldLabel('selectionMask', 'config.settings-general.selection-mask')}<input id="selectionMask" type="text" value="${escapeHtml(settings.screenshot.selectionMask)}"></div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-general.double-click-copy')}</b></div>${switchMarkup(settings.screenshot.doubleClickCopy, 'doubleClickCopy', 'screenshot')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-general.show-color-picker')}</b></div>${switchMarkup(settings.screenshot.showColorPicker, 'showColorPicker', 'screenshot')}</div>
  </div>`
  const ocrModuleOff = settings.plugins.ocr === false
    ? `<div class="card form-card" style="margin-bottom:16px"><div class="form-row"><div class="form-label"><b>${t('config.function-tabs.ocr-module-off')}</b></div><button class="button primary" id="enableOcrModule">${t('config.function-tabs.enable-module')}</button></div></div>`
    : ''
  const ocrSettings = `${ocrModuleOff}<div class="card form-card">
    <div class="form-row">${settingsFieldLabel('ocrModel', 'config.function-settings.ocr-model', 'config.function-settings.ocr-model-hint')}<select id="ocrModel" aria-describedby="ocrModelHint"><option value="ppocr-v4-ch">${t('config.function-settings.ocr-model-option')}</option></select></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-status')}</b><small id="ocrStatusDetail">${t('config.function-settings.ocr-status-checking')}</small></div><span id="ocrStatus">${t('config.function-settings.ocr-status-checking-label')}</span></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-detect-angle')}</b><small>${t('config.function-settings.ocr-detect-angle-hint')}</small></div>${switchMarkup(settings.ocr.detectAngle, 'detectAngle', 'ocr')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-hot-start')}</b><small>${t('config.function-settings.ocr-hot-start-hint')}</small></div>${switchMarkup(settings.ocr.hotStart === true, 'hotStart', 'ocr')}</div>
    <div class="form-row">${settingsFieldLabel('ocrMinConfidence', 'config.function-settings.ocr-min-confidence', 'config.function-settings.ocr-min-confidence-hint')}<input id="ocrMinConfidence" aria-describedby="ocrMinConfidenceHint" type="number" min="0" max="1" step="0.05" value="${settings.ocr.minConfidence}"></div>
    <div class="form-row">${settingsFieldLabel('ocrAfterAction', 'config.function-settings.ocr-after-action')}<select id="ocrAfterAction"><option value="none">${t('config.function-settings.ocr-after-show')}</option><option value="copy">${t('config.function-settings.ocr-after-copy')}</option><option value="copy-and-close">${t('config.function-settings.ocr-after-copy-close')}</option></select></div>
  </div>`
  // Two cards: the DEFAULTS the workbench starts from, then storage/data. Every
  // per-capture choice (mode, target, temporary overrides, per-recording device)
  // lives in the recording workbench instead of being duplicated here.
  const recordSettings = `<div class="card form-card">
    <div class="form-row">${settingsFieldLabel('frameRate', 'config.function-settings.record-frame-rate', 'config.function-settings.record-frame-rate-hint')}<select id="frameRate" aria-describedby="frameRateHint">${supportedFrameRates.map((value) => `<option value="${value}">${value} FPS</option>`).join('')}</select></div>
    <div class="form-row">${settingsFieldLabel('recordQuality', 'config.function-settings.record-quality', 'config.function-settings.record-quality-hint')}<select id="recordQuality" aria-describedby="recordQualityHint">${Object.entries(RECORD_QUALITY_LABEL_KEYS).map(([value, labelKey]) => `<option value="${value}" ${selectedRecordQuality === value ? 'selected' : ''}>${t(labelKey)}</option>`).join('')}</select></div>
    <div class="form-row">${settingsFieldLabel('recordCountdown', 'config.function-settings.record-countdown', 'config.function-settings.record-countdown-hint')}<select id="recordCountdown" aria-describedby="recordCountdownHint">${[0, 3, 5].map((value) => `<option value="${value}" ${selectedRecordCountdown === value ? 'selected' : ''}>${recordDefaultCountdownLabel(value)}</option>`).join('')}</select></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-audio-system')}</b><small>${t('config.function-settings.record-audio-system-hint')}</small></div>${switchMarkup(settings.record.audioSystem !== false, 'audioSystem', 'record')}</div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-microphone')}</b><small>${t('config.function-settings.record-microphone-hint')}</small></div>${switchMarkup(settings.record.audioMicrophone === true, 'audioMicrophone', 'record')}</div>
    <div class="form-row">${settingsFieldLabel('recordMicDevice', 'config.function-settings.record-microphone-device', 'config.function-settings.record-microphone-device-hint')}<select id="recordMicDevice" aria-describedby="recordMicDeviceHint"><option value="">${t('config.function-settings.record-microphone-default')}</option></select></div>
  </div>
  <div class="card form-card" style="margin-top:14px">
    <div class="form-row">${settingsFieldLabel('recordDirectory', 'config.function-settings.record-directory', 'config.function-settings.record-directory-hint')}<div class="action-group field-actions"><input id="recordDirectory" aria-describedby="recordDirectoryHint" type="text" value="${escapeHtml(settings.record.saveDirectory || '')}"><button class="button" id="chooseRecordDirectory">${t('config.function-settings.choose')}</button></div></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-storage-section')}</b></div><button class="button" id="openRecordingData">${t('config.function-settings.record-open-data')}</button></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.pin-click-through')}</b><small>${t('config.function-settings.pin-click-through-hint')}</small></div>${switchMarkup(settings.pinned.clickThrough, 'clickThrough', 'pinned')}</div>
    <div class="form-row">${settingsFieldLabel('pinZoomStep', 'config.function-settings.pin-zoom-step', 'config.function-settings.pin-zoom-step-hint')}<select id="pinZoomStep" aria-describedby="pinZoomStepHint">${[5, 10, 15, 20, 25, 50].map((percent) => `<option value="${percent}" ${Math.round((Number(settings.pinned.zoomStep) || 0.1) * 100) === percent ? 'selected' : ''}>${t('config.function-settings.pin-zoom-step-value', { percent })}</option>`).join('')}</select></div>
    <div class="form-row"><div class="form-label"><b>${t('config.function-settings.pin-opacity')}</b><small>${t('config.function-settings.pin-opacity-hint')}</small></div></div>
  </div>
  <small class="section-note">${t('config.function-settings.record-defaults-hint')}</small>`
  const tabContent = functionTab === 'ocr' ? ocrSettings : (functionTab === 'record' ? recordSettings : captureSettings)
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-function'), t('config.function-settings.description'))}${tabsMarkup}${tabContent}</div>`

  document.querySelectorAll('[data-function-tab]').forEach((button) => {
    button.onclick = () => {
      const nextTab = button.dataset.functionTab
      if (nextTab === functionTab) return
      functionTab = nextTab
      renderFunctionSettings()
      document.querySelector(`[data-function-tab="${nextTab}"]`)?.focus({ preventScroll: true })
    }
  })
  if (functionTab === 'ocr') {
    bindFunctionOcrTab()
  } else if (functionTab === 'record') {
    document.getElementById('frameRate').value = String(selectedFrameRate)
    bindFunctionRecordTab()
  } else {
    bindFunctionCaptureTab()
  }
}

// D04: the local backup block on the "system and data" page. The package
// format and the rollback live in main/services/data-root-backup.js; this page
// only chooses modules and directories, shows the manifest before anything is
// restored, and maps structured failure codes to localized copy. The dialogs
// reuse the existing dialog:choose-directory channel.
const SYSTEM_BACKUP_MODULES = ['history', 'clipboard', 'recordings', 'conversations', 'usage', 'settings']
const SYSTEM_BACKUP_DEFAULT_MODULES = ['history', 'clipboard', 'recordings', 'settings']
const SYSTEM_BACKUP_ERROR_KEYS = {
  'not-backup': 'config.settings-system.backup-error-not-backup',
  incomplete: 'config.settings-system.backup-error-incomplete',
  'corrupt-manifest': 'config.settings-system.backup-error-corrupt',
  'future-schema': 'config.settings-system.backup-error-future',
  'unsupported-schema': 'config.settings-system.backup-error-unsupported',
  'checksum-mismatch': 'config.settings-system.backup-error-checksum',
  'missing-file': 'config.settings-system.backup-error-corrupt',
  'target-not-empty': 'config.settings-system.backup-error-target-not-empty',
  'migration-required': 'config.settings-system.backup-error-migration-required',
  'unsupported-version': 'config.settings-system.backup-error-unsupported-version',
  'permission-denied': 'config.settings-system.backup-error-permission',
  'copy-failed': 'config.settings-system.backup-error-copy-failed',
  'publish-failed': 'config.settings-system.backup-error-restore-failed',
  'restore-failed': 'config.settings-system.backup-error-restore-failed',
  'verification-failed': 'config.settings-system.backup-error-verification-failed',
  'migration-failed': 'config.settings-system.backup-error-migration-failed',
  'unsupported-link': 'config.settings-system.backup-error-unsupported-link',
  'not-incomplete': 'config.settings-system.backup-error-not-incomplete',
  'invalid-request': 'config.settings-system.backup-error-invalid-request',
  'invalid-target': 'config.settings-system.backup-error-invalid-target',
  'io-error': 'config.settings-system.backup-error-io-error',
  'backup-failed': 'config.settings-system.backup-error-backup-failed',
  'quiesce-failed': 'config.settings-system.backup-error-quiesce-failed'
}

function formatBackupBytes(value) {
  const bytes = Number(value) || 0
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function systemBackupApi() {
  const api = window.electronAPI
  if (!api || typeof api.backupCreate !== 'function' || typeof api.backupInspect !== 'function' || typeof api.backupRestore !== 'function') return null
  return api
}

function backupErrorMessage(result, fallbackKey) {
  const fallback = fallbackKey || 'config.settings-system.backup-error-io-error'
  if (!result) return t(fallback)
  if (result.code === 'insufficient-space' && Number.isFinite(Number(result.requiredBytes))) {
    return `${t('config.settings-system.backup-error-no-space')} ${t('config.settings-system.backup-error-no-space-detail', {
      required: formatBackupBytes(result.requiredBytes),
      free: formatBackupBytes(result.freeBytes)
    })}`
  }
  const key = SYSTEM_BACKUP_ERROR_KEYS[result.code]
  return key ? t(key) : (result.message || t(fallback))
}

function systemBackupModuleMarkup() {
  return SYSTEM_BACKUP_MODULES.map((id) => {
    const checked = SYSTEM_BACKUP_DEFAULT_MODULES.includes(id) ? ' checked' : ''
    return `<label class="backup-module"><input type="checkbox" data-backup-module value="${id}"${checked}> ${t(`config.settings-system.backup-module-${id}`)}</label>`
  }).join('')
}

function backupPreviewMarkup(result) {
  if (!result || result.ok !== true) return ''
  const checksum = String(result.checksum || '')
  const sensitiveModules = Array.isArray(result.sensitiveModules) ? result.sensitiveModules : []
  const moduleRows = (result.moduleOrder || []).map((id) => {
    const entry = result.modules?.[id]
    if (!entry) return ''
    // D04 (06): the badge is per module, so an old package whose SETTINGS module secretly
    // carried the history list is marked where the user can see which module is sensitive.
    const badge = sensitiveModules.includes(id)
      ? ` <span class="rec-badge" data-testid="backup-module-sensitive-${id}">${t('config.settings-system.backup-module-sensitive')}</span>`
      : ''
    return `<div class="form-row"><div class="form-label"><b>${t(`config.settings-system.backup-module-${id}`)}</b>${badge}</div><span>${t('config.settings-system.backup-module-line', {
      files: entry.fileCount,
      size: formatBackupBytes(entry.bytes)
    })}</span></div>`
  }).join('')
  const externalCount = Number(result.externalRefCount) || 0
  const externalRows = (result.externalRefs || []).slice(0, 5)
    .map((ref) => `<small>${escapeHtml(ref.path)}</small>`).join('<br>')
  const externalValue = externalCount
    ? `${t('config.settings-system.backup-external-refs-value', { count: externalCount })}<br>${externalRows}`
    : t('config.settings-system.backup-external-refs-none')
  const missing = (result.warnings || []).filter((warning) => warning && warning.code === 'external-ref-unavailable').length
  const sensitiveMarkup = result.containsSensitive
    ? `<div class="update-guidance warning">${t('config.settings-system.backup-sensitive')} · ${t('config.settings-system.backup-sensitive-hint')}</div>`
    : `<small class="section-note">${t('config.settings-system.backup-not-sensitive')}</small>`
  const missingMarkup = missing
    ? `<div class="update-guidance warning">${t('config.settings-system.backup-external-missing')}</div>`
    : ''
  // D04 (06): an old package can carry the history list inside settings, and a history
  // module can arrive without any trusted index. Both are stated before the user restores.
  const warningCodes = new Set((result.warnings || []).map((warning) => warning && warning.code))
  const legacyHistoryMarkup = warningCodes.has('settings-carries-history')
    ? `<div class="update-guidance warning" data-testid="backup-settings-carries-history">${t('config.settings-system.backup-settings-carries-history')}</div>`
    : ''
  const historyIndexMarkup = result.historyIndex && result.historyIndex.available === false
    ? `<div class="update-guidance warning" data-testid="backup-history-index-missing">${t('config.settings-system.backup-history-index-missing')}</div>`
    : ''
  return `<div class="backup-preview"><h3>${t('config.settings-system.backup-preview-title')}</h3>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-version')}</b></div><span>${escapeHtml(String(result.version || ''))}</span></div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-format-version')}</b></div><span>${escapeHtml(String(result.formatVersion || ''))}</span></div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-size')}</b></div><span>${formatBackupBytes(result.totalBytes)}</span></div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-files')}</b></div><span>${Number(result.totalFiles) || 0}</span></div>
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-checksum')}</b></div><code title="${escapeHtml(checksum)}">${escapeHtml(checksum.slice(0, 16))}</code></div>
    ${moduleRows}
    <div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-external-refs')}</b></div><span>${externalValue}</span></div>
    ${sensitiveMarkup}${missingMarkup}${legacyHistoryMarkup}${historyIndexMarkup}</div>`
}

function bindSystemBackupControls() {
  const targetInput = document.getElementById('backupTargetDirectory')
  const sourceInput = document.getElementById('backupSourceDirectory')
  const externalHistoryInput = document.getElementById('backupExternalHistory')
  const createButton = document.getElementById('createBackup')
  const previewButton = document.getElementById('previewBackup')
  const restoreButton = document.getElementById('restoreBackup')
  const deleteButton = document.getElementById('deleteIncompleteBackup')
  const summary = document.getElementById('backupSummary')
  if (!targetInput || !sourceInput || !externalHistoryInput || !createButton || !previewButton || !restoreButton || !summary) return

  const api = systemBackupApi()
  const showSummary = (result) => { summary.innerHTML = backupPreviewMarkup(result) }
  const showFailure = (result, fallbackKey, suffixKey) => {
    summary.innerHTML = ''
    deleteButton.hidden = !(result && result.code === 'incomplete' && api && typeof api.backupDelete === 'function')
    const suffix = suffixKey ? ` ${t(suffixKey)}` : ''
    toast(`${backupErrorMessage(result, fallbackKey)}${suffix}`)
  }
  const busy = (button, active, labelKey) => {
    if (!button.isConnected) return
    button.disabled = active
    if (labelKey) button.textContent = t(labelKey)
  }

  document.getElementById('chooseBackupTarget').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (directory) targetInput.value = directory
  }
  document.getElementById('chooseBackupExternalHistory').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (directory) externalHistoryInput.value = directory
  }
  document.getElementById('clearBackupExternalHistory').onclick = () => {
    externalHistoryInput.value = ''
  }
  document.getElementById('chooseBackupSource').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    sourceInput.value = directory
    if (!api) return
    try {
      const result = await api.backupInspect(directory)
      if (!result || result.ok !== true) { showFailure(result, 'config.settings-system.backup-preview-failed'); return }
      showSummary(result)
      deleteButton.hidden = true
    } catch (error) {
      toast(error.message || t('config.settings-system.backup-preview-failed'))
    }
  }

  createButton.onclick = async () => {
    if (!api) { toast(t('config.settings-system.backup-unavailable')); return }
    const externalHistory = externalHistoryInput.value.trim()
    const modules = [...document.querySelectorAll('[data-backup-module]')].filter((input) => input.checked)
      .map((input) => (input.value === 'history' && externalHistory ? { id: 'history', directory: externalHistory } : input.value))
    if (!modules.length) { toast(t('config.settings-system.backup-select-module')); return }
    if (!targetInput.value.trim()) { toast(t('config.settings-system.backup-choose-target')); return }
    busy(createButton, true, 'config.settings-system.backup-creating')
    try {
      const result = await api.backupCreate({ modules, targetDirectory: targetInput.value.trim() })
      if (!result || result.ok !== true) { showFailure(result, 'config.settings-system.backup-create-failed'); return }
      sourceInput.value = result.directory || ''
      showSummary(result)
      deleteButton.hidden = true
      toast(t('config.settings-system.backup-created', { path: result.directory || '' }))
    } catch (error) {
      toast(error.message || t('config.settings-system.backup-create-failed'))
    } finally {
      busy(createButton, false, 'config.settings-system.backup-create')
    }
  }

  previewButton.onclick = async () => {
    if (!api) { toast(t('config.settings-system.backup-unavailable')); return }
    const directory = sourceInput.value.trim()
    if (!directory) { toast(t('config.settings-system.backup-choose-source')); return }
    busy(previewButton, true, 'config.settings-system.backup-inspecting')
    try {
      const result = await api.backupInspect(directory)
      if (!result || result.ok !== true) { showFailure(result, 'config.settings-system.backup-preview-failed'); return }
      showSummary(result)
      deleteButton.hidden = true
    } catch (error) {
      toast(error.message || t('config.settings-system.backup-preview-failed'))
    } finally {
      busy(previewButton, false, 'config.settings-system.backup-preview')
    }
  }

  restoreButton.onclick = async () => {
    if (!api) { toast(t('config.settings-system.backup-unavailable')); return }
    const directory = sourceInput.value.trim()
    if (!directory) { toast(t('config.settings-system.backup-choose-source')); return }
    let inspected
    try {
      inspected = await api.backupInspect(directory)
    } catch (error) {
      toast(error.message || t('config.settings-system.backup-preview-failed')); return
    }
    if (!inspected || inspected.ok !== true) { showFailure(inspected, 'config.settings-system.backup-preview-failed'); return }
    showSummary(inspected)
    if (!confirm(t('config.settings-system.backup-confirm-restore'))) return
    const targetDirectory = await window.electronAPI.chooseDirectory()
    if (!targetDirectory) return
    busy(restoreButton, true, 'config.settings-system.backup-restoring')
    try {
      const result = await api.backupRestore({ backupDirectory: directory, targetRoot: targetDirectory })
      if (!result || result.ok !== true) {
        showFailure(result, 'config.settings-system.backup-restore-failed', 'config.settings-system.backup-restore-safe')
        return
      }
      toast(t('config.settings-system.backup-restored'))
    } catch (error) {
      toast(`${error.message || t('config.settings-system.backup-restore-failed')} ${t('config.settings-system.backup-restore-safe')}`)
    } finally {
      busy(restoreButton, false, 'config.settings-system.backup-restore')
    }
  }

  deleteButton.onclick = async () => {
    if (!api || typeof api.backupDelete !== 'function') { toast(t('config.settings-system.backup-unavailable')); return }
    const directory = sourceInput.value.trim()
    if (!directory) { toast(t('config.settings-system.backup-choose-source')); return }
    if (!confirm(t('config.settings-system.backup-delete-confirm'))) return
    try {
      const result = await api.backupDelete(directory)
      if (!result || result.ok !== true) { toast(backupErrorMessage(result, 'config.settings-system.backup-delete-failed')); return }
      summary.innerHTML = ''
      deleteButton.hidden = true
      toast(t('config.settings-system.backup-deleted'))
    } catch (error) {
      toast(error.message || t('config.settings-system.backup-delete-failed'))
    }
  }
}

async function renderSystemSettings() {
  const dataRoot = await window.electronAPI.getDataRoot()
  if (currentRoute !== 'settings-system') return
  const dataSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.data-section')}</h2><div class="card form-card"><div class="form-row"><label class="form-label" for="dataRoot"><b>${t('config.settings-system.data-root')}</b><small>${t('config.settings-system.data-root-hint')}</small></label><div class="action-group field-actions"><input id="dataRoot" type="text" readonly value="${escapeHtml(dataRoot.path)}"><button class="button subtle" id="openDataRoot">${t('config.settings-system.open')}</button><button class="button" id="changeDataRoot">${t('config.settings-system.change')}</button></div></div></div></section>`
  const backupSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.backup-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-modules')}</b><small>${t('config.settings-system.backup-modules-hint')}</small></div><div class="backup-modules" style="display:flex;flex-wrap:wrap;gap:10px 16px">${systemBackupModuleMarkup()}</div></div><div class="form-row">${settingsFieldLabel('backupTargetDirectory', 'config.settings-system.backup-target', 'config.settings-system.backup-target-hint')}<div class="action-group field-actions"><input id="backupTargetDirectory" type="text" readonly value=""><button class="button" id="chooseBackupTarget">${t('config.settings-system.choose')}</button></div></div><div class="form-row">${settingsFieldLabel('backupSourceDirectory', 'config.settings-system.backup-source', 'config.settings-system.backup-source-hint')}<div class="action-group field-actions"><input id="backupSourceDirectory" type="text" readonly value=""><button class="button" id="chooseBackupSource">${t('config.settings-system.choose')}</button></div></div><div class="form-row">${settingsFieldLabel('backupExternalHistory', 'config.settings-system.backup-external-history', 'config.settings-system.backup-external-history-hint')}<div class="action-group field-actions"><input id="backupExternalHistory" type="text" readonly value=""><button class="button" id="chooseBackupExternalHistory">${t('config.settings-system.choose')}</button><button class="button subtle" id="clearBackupExternalHistory">${t('config.settings-system.backup-clear')}</button></div></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.backup-key-hint')}</b></div><div class="action-group"><button class="button primary" id="createBackup">${t('config.settings-system.backup-create')}</button><button class="button" id="previewBackup">${t('config.settings-system.backup-preview')}</button><button class="button" id="restoreBackup">${t('config.settings-system.backup-restore')}</button><button class="button danger" id="deleteIncompleteBackup" hidden>${t('config.settings-system.backup-delete-incomplete')}</button></div></div><div id="backupSummary" class="backup-summary"></div></div></section>`
  const diagnosticsSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.diagnostics-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.preview-diagnostics')}</b><small>${t('config.settings-system.preview-diagnostics-hint')}</small></div><button class="button" id="previewDiagnostics">${t('config.settings-system.preview')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.export-diagnostics')}</b><small>${t('config.settings-system.export-diagnostics-hint')}</small></div><button class="button primary" id="exportDiagnostics">${t('config.settings-system.export-zip')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.include-crash-dumps')}</b><small>${t('config.settings-system.include-crash-dumps-hint')}</small></div><input id="includeCrashDumps" type="checkbox"></div><pre id="diagnosticsPreview" class="diagnostics-preview" hidden></pre></div></section>`
  // The proxy bridge card. Every value it writes is a `proxy.*` field, and the
  // patch validator only accepts keys listed in DEFAULT_SETTINGS. The relay runs
  // inside the main process, so there is no interpreter/script path to configure.
  const proxySettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.proxy-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-status')}</b><small id="proxyStatusDetail">${t('config.settings-system.proxy-status-checking')}</small></div><span id="proxyStatus">${t('config.settings-system.proxy-status-checking')}</span><button class="button" id="toggleProxy">${t('config.settings-system.proxy-start')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-auto-start')}</b></div>${switchMarkup(settings.proxy.autoStart === true, 'autoStart', 'proxy')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-port')}</b><small>${t('config.settings-system.proxy-port-hint')}</small></div><input id="proxyPort" type="number" min="1" max="65535" value="${Number(settings.proxy.port) || 8080}"></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-host')}</b><small>${t('config.settings-system.proxy-host-hint')}</small></div><select id="proxyHost"><option value="127.0.0.1">127.0.0.1</option><option value="0.0.0.0">0.0.0.0</option></select></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-api-base')}</b><small>${t('config.settings-system.proxy-api-base-hint')}</small></div><input id="proxyApiBase" type="text" value="${escapeHtml(settings.proxy.apiBase || '')}" placeholder="https://index-translate.bilibili.com/v1"></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-copy-config')}</b><small>${t('config.settings-system.proxy-copy-config-hint')}</small></div><button class="button" id="copyProxyConfig">${t('config.settings-system.proxy-copy')}</button></div></div></section>`
  const dangerSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.danger-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.clear-history')}</b><small>${t('config.settings-system.clear-history-hint')}</small></div><button class="button danger" id="clearData">${t('config.settings-system.clear')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.reset')}</b><small>${t('config.settings-system.reset-hint')}</small></div><button class="button danger" id="resetSettings">${t('config.settings-system.reset')}</button></div></div></section>`
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-system'), t('config.settings-system.description'))}${dataSettings}${backupSettings}${proxySettings}${diagnosticsSettings}${dangerSettings}</div>`
  bindSwitches()
  bindSystemBackupControls()
  document.getElementById('previewDiagnostics').onclick = async () => {
    const button = document.getElementById('previewDiagnostics')
    button.disabled = true
    button.textContent = t('config.settings-system.reading')
    try {
      const diagnostics = await window.electronAPI.previewDiagnostics()
      const preview = document.getElementById('diagnosticsPreview')
      if (!preview) return
      preview.textContent = JSON.stringify(diagnostics, null, 2)
      preview.hidden = false
    } catch (error) {
      toast(error.message || t('config.settings-system.diagnostics-preview-failed'))
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = t('config.settings-system.preview')
      }
    }
  }
  document.getElementById('exportDiagnostics').onclick = async () => {
    const includeCrashDumps = document.getElementById('includeCrashDumps').checked
    if (includeCrashDumps && !confirm(t('config.settings-system.confirm-include-crash-dumps'))) return
    const button = document.getElementById('exportDiagnostics')
    button.disabled = true
    button.textContent = t('config.settings-system.exporting')
    try {
      const result = await window.electronAPI.exportDiagnostics(includeCrashDumps)
      if (!result.canceled) toast(t('config.settings-system.diagnostics-exported', { path: result.outputPath }))
    } catch (error) {
      toast(error.message || t('config.settings-system.diagnostics-export-failed'))
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = t('config.settings-system.export-zip')
      }
    }
  }
  document.getElementById('openDataRoot').onclick = () => window.electronAPI.openDataRoot().catch((error) => toast(error.message || t('config.settings-system.open-data-root-failed')))
  document.getElementById('changeDataRoot').onclick = async () => {
    const button = document.getElementById('changeDataRoot')
    button.disabled = true
    button.textContent = t('config.settings-system.changing')
    let restarting = false
    try {
      const result = await window.electronAPI.changeDataRoot()
      if (result?.restarting) {
        restarting = true
        toast(t('config.settings-system.data-root-migrated'))
      }
    } catch (error) {
      toast(error.message || t('config.settings-system.data-root-migration-failed'))
    } finally {
      if (!restarting) {
        button.disabled = false
        button.textContent = t('config.settings-system.change')
      }
    }
  }
  document.getElementById('clearData').onclick = async () => {
    if (!confirm(t('config.settings-system.confirm-clear-history'))) return
    try { await window.electronAPI.clearHistory(); toast(t('config.settings-system.history-cleared')) }
    catch (error) { toast(error.message || t('config.settings-system.clear-history-failed')) }
  }
  document.getElementById('resetSettings').onclick = async () => { if (confirm(t('config.settings-system.confirm-reset'))) { settings = await window.electronAPI.resetSettings(); await refreshShortcutStatuses(); applyAppearance(); renderRoute(); toast(t('config.settings-system.reset-done')) } }

  // --- Index-Translate proxy bridge -----------------------------------------
  // The main process owns the lifecycle; this card only reads the status the
  // bridge controller pushes (onProxyStatus) and writes `proxy.*` fields.
  const proxyHostSelect = document.getElementById('proxyHost')
  proxyHostSelect.value = settings.proxy.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
  const proxyStatusLabel = document.getElementById('proxyStatus')
  const proxyStatusDetail = document.getElementById('proxyStatusDetail')
  const proxyToggle = document.getElementById('toggleProxy')
  const renderProxyStatus = (status) => {
    if (!status || !proxyStatusLabel || !proxyStatusLabel.isConnected) return
    const state = status.busy
      ? 'busy'
      : (status.running ? (status.adopted ? 'running-adopted' : 'running') : (status.state === 'error' ? 'error' : 'idle'))
    proxyStatusLabel.textContent = t(`config.settings-system.proxy-status-${state}`)
    proxyStatusDetail.textContent = status.lastError || t('config.settings-system.proxy-endpoint', { url: status.endpoint })
    if (!proxyToggle.isConnected) return
    proxyToggle.textContent = status.running ? t('config.settings-system.proxy-stop') : t('config.settings-system.proxy-start')
  }
  const saveProxySettings = () => updateSettings({
    proxy: {
      // Port and host changes apply on the next start; apiBase is read per request.
      port: Math.max(1, Math.min(65535, Number(document.getElementById('proxyPort').value) || 8080)),
      host: proxyHostSelect.value,
      apiBase: document.getElementById('proxyApiBase').value.trim()
    }
  }, t('config.settings-system.proxy-updated'))
  window.electronAPI.getProxyStatus().then(renderProxyStatus).catch(() => {})
  if (window.__proxyStatusUnsubscribe) window.__proxyStatusUnsubscribe()
  window.__proxyStatusUnsubscribe = window.electronAPI.onProxyStatus(renderProxyStatus)
  document.getElementById('proxyPort').onchange = saveProxySettings
  document.getElementById('proxyApiBase').onchange = saveProxySettings
  proxyHostSelect.onchange = saveProxySettings
  proxyToggle.onclick = async () => {
    proxyToggle.disabled = true
    try {
      await window.electronAPI.executeFunction('toggleTranslationProxy')
      renderProxyStatus(await window.electronAPI.getProxyStatus())
    } catch (error) {
      toast(errorMessage(error) || t('config.settings-system.proxy-toggle-failed'))
    } finally {
      if (proxyToggle.isConnected) proxyToggle.disabled = false
    }
  }
  document.getElementById('copyProxyConfig').onclick = async () => {
    try {
      const status = await window.electronAPI.getProxyStatus()
      await navigator.clipboard.writeText(t('config.settings-system.proxy-copy-template', { url: status.endpoint }))
      toast(t('config.settings-system.proxy-config-copied'))
    } catch {
      toast(t('config.settings-system.proxy-copy-failed'))
    }
  }
}

// D2-2 (S14): register the route entries on the shell dispatch table. config.html
// loads this file before config.js; the arrow functions keep the lookup lazy, so
// registration itself never resolves the render identifiers.
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderGeneralSettings'] = () => renderGeneralSettings()
window.configRoutes['renderFunctionSettings'] = () => renderFunctionSettings()
window.configRoutes['renderSystemSettings'] = () => renderSystemSettings()
