// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 settings-*（界面/功能/热键/系统设置）。

function renderGeneralSettings() {
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-general'), t('config.settings-general.description'))}<div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.setting.language')}</b></div><select id="interfaceLanguage"><option value="zh-CN">${t('common.language.zh')}</option><option value="en-US">${t('common.language.en')}</option><option value="zh-TW">${t('common.language.zh-hant')}</option></select></div><div class="form-row"><div class="form-label"><b>${t('config.settings-general.zoom')}</b><small>${t('config.settings-general.zoom-hint')}</small></div><span>${t('config.settings-general.zoom-auto')}</span></div><div class="form-row"><div class="form-label"><b>${t('config.settings-general.selection-mask')}</b></div><input id="selectionMask" type="text" value="${escapeHtml(settings.screenshot.selectionMask)}"></div><div class="form-row"><div class="form-label"><b>${t('config.settings-general.double-click-copy')}</b></div>${switchMarkup(settings.screenshot.doubleClickCopy, 'doubleClickCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-general.show-color-picker')}</b></div>${switchMarkup(settings.screenshot.showColorPicker, 'showColorPicker', 'screenshot')}</div></div><button class="button primary" id="saveGeneral" style="margin-top:16px">${t('config.settings-general.save')}</button></div>`
  // P0-1-T3: the interface language applies immediately (the settings effect
  // broadcasts it to every window); the row rides the frozen `language` key.
  const interfaceLanguage = document.getElementById('interfaceLanguage')
  interfaceLanguage.value = settings.language || 'zh-CN'
  interfaceLanguage.onchange = () => updateSettings({ language: interfaceLanguage.value }, t('config.settings-general.language-updated'))
  bindSwitches(); document.getElementById('saveGeneral').onclick = () => updateSettings({ screenshot: { selectionMask: document.getElementById('selectionMask').value.trim() } })
}

function renderFunctionSettings() {
  const supportedFrameRates = [5, 16, 24, 30, 60]
  const selectedFrameRate = supportedFrameRates.includes(Number(settings.record.frameRate)) ? Number(settings.record.frameRate) : 24
  const outputSettings = `<section class="section"><h2 class="section-title">${t('config.function-settings.output-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.function-settings.auto-save-on-copy')}</b></div>${switchMarkup(settings.screenshot.autoSaveOnCopy, 'autoSaveOnCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.fast-save')}</b></div>${switchMarkup(settings.screenshot.fastSave, 'fastSave', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.shutter-sound')}</b><small>${t('config.function-settings.shutter-sound-hint')}</small></div>${switchMarkup(settings.screenshot.shutterSound, 'shutterSound', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.capture-cursor')}</b><small>${t('config.function-settings.capture-cursor-hint')}</small></div>${switchMarkup(settings.screenshot.captureCursor === true, 'captureCursor', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.long-capture-direction')}</b></div><select id="longCaptureDirection"><option value="vertical">${t('config.function-settings.vertical')}</option><option value="horizontal">${t('config.function-settings.horizontal')}</option></select></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.save-directory')}</b></div><input id="saveDirectory" type="text" value="${escapeHtml(settings.screenshot.saveDirectory || '')}"><button class="button" id="chooseSaveDirectory">${t('config.function-settings.choose')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.name-template')}</b><small>${t('config.function-settings.name-template-hint')}</small></div><input id="nameTemplate" type="text" value="${escapeHtml(settings.screenshot.nameTemplate || '')}" placeholder="${t('config.function-settings.name-template-placeholder')}"></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.keep-serial')}</b><small>${t('config.function-settings.keep-serial-hint')}</small></div>${switchMarkup(settings.screenshot.keepSerialAcrossCaptures, 'keepSerialAcrossCaptures', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.history-enabled')}</b></div>${switchMarkup(settings.screenshot.historyEnabled, 'historyEnabled', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.history-limit')}</b></div><input id="historyLimit" type="number" min="10" max="1000" value="${settings.screenshot.historyLimit}"></div></div></section>`
  const pinSettings = `<section class="section"><h2 class="section-title">${t('config.function-settings.pin-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.function-settings.pin-click-through')}</b><small>${t('config.function-settings.pin-click-through-hint')}</small></div>${switchMarkup(settings.pinned.clickThrough, 'clickThrough', 'pinned')}</div></div></section>`
  const ocrSettings = `<section class="section"><h2 class="section-title">${t('config.function-settings.ocr-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-model')}</b><small>${t('config.function-settings.ocr-model-hint')}</small></div><select id="ocrModel"><option value="ppocr-v4-ch">${t('config.function-settings.ocr-model-option')}</option></select></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-status')}</b><small id="ocrStatusDetail">${t('config.function-settings.ocr-status-checking')}</small></div><span id="ocrStatus">${t('config.function-settings.ocr-status-checking-label')}</span></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-detect-angle')}</b><small>${t('config.function-settings.ocr-detect-angle-hint')}</small></div>${switchMarkup(settings.ocr.detectAngle, 'detectAngle', 'ocr')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-min-confidence')}</b><small>${t('config.function-settings.ocr-min-confidence-hint')}</small></div><input id="ocrMinConfidence" type="number" min="0" max="1" step="0.05" value="${settings.ocr.minConfidence}"></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ocr-after-action')}</b></div><select id="ocrAfterAction"><option value="none">${t('config.function-settings.ocr-after-show')}</option><option value="copy">${t('config.function-settings.ocr-after-copy')}</option><option value="copy-and-close">${t('config.function-settings.ocr-after-copy-close')}</option></select></div></div></section>`
  const aiSettings = `<section class="section"><h2 class="section-title">${t('config.function-settings.ai-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ai-provider-model')}</b><small>${t('config.function-settings.ai-provider-model-hint')}</small></div><button class="button" id="openModelSettings">${t('config.function-settings.ai-configure-models')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ai-max-tokens')}</b></div><input id="maxTokens" type="number" value="${settings.ai.maxTokens}"></div><div class="form-row"><div class="form-label"><b>Temperature</b></div><input id="temperature" type="number" min="0" max="2" step="0.1" value="${settings.ai.temperature}"></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ai-target-language')}</b></div><select id="targetLanguage"><option value="中文">${t('config.language.zh')}</option><option value="英文">${t('config.language.en')}</option><option value="日文">${t('config.language.ja')}</option><option value="韩文">${t('config.language.ko')}</option><option value="繁体中文">${t('config.language.zh-hant')}</option></select></div></div></section>`
  const recordSettings = `<section class="section"><h2 class="section-title">${t('config.function-settings.record-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-frame-rate')}</b><small>${t('config.function-settings.record-frame-rate-hint')}</small></div><select id="frameRate">${supportedFrameRates.map((value) => `<option value="${value}">${value} FPS</option>`).join('')}</select></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-audio-system')}</b><small>${t('config.function-settings.record-audio-system-hint')}</small></div>${switchMarkup(settings.record.audioSystem !== false, 'audioSystem', 'record')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-microphone')}</b><small>${t('config.function-settings.record-microphone-hint')}</small></div>${switchMarkup(settings.record.audioMicrophone === true, 'audioMicrophone', 'record')}</div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.record-directory')}</b></div><input id="recordDirectory" type="text" value="${escapeHtml(settings.record.saveDirectory || '')}"><button class="button" id="chooseRecordDirectory">${t('config.function-settings.choose')}</button></div></div></section>`
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-function'), t('config.function-settings.description'))}${outputSettings}${pinSettings}${ocrSettings}${aiSettings}${recordSettings}<button class="button primary" id="saveFunctions">${t('config.function-settings.save')}</button></div>`
  document.getElementById('ocrModel').value = settings.ocr.modelProfile
  document.getElementById('ocrAfterAction').value = settings.ocr.afterAction
  document.getElementById('longCaptureDirection').value = settings.screenshot.longCaptureDirection || 'vertical'
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
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage
  document.getElementById('frameRate').value = String(selectedFrameRate)
  bindSwitches()
  document.getElementById('openModelSettings').onclick = () => navigate('models')
  document.getElementById('chooseSaveDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('saveDirectory').value = directory }
  document.getElementById('chooseRecordDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('recordDirectory').value = directory }
  document.getElementById('saveFunctions').onclick = () => updateSettings({ screenshot: { saveDirectory: document.getElementById('saveDirectory').value.trim(), nameTemplate: document.getElementById('nameTemplate').value.trim(), historyLimit: Number(document.getElementById('historyLimit').value), longCaptureDirection: document.getElementById('longCaptureDirection').value }, ocr: { modelProfile: document.getElementById('ocrModel').value, minConfidence: Math.max(0, Math.min(1, Number(document.getElementById('ocrMinConfidence').value))), afterAction: document.getElementById('ocrAfterAction').value }, ai: { maxTokens: Number(document.getElementById('maxTokens').value), temperature: Number(document.getElementById('temperature').value), targetLanguage: document.getElementById('targetLanguage').value }, record: { frameRate: Number(document.getElementById('frameRate').value), saveDirectory: document.getElementById('recordDirectory').value.trim() } })
}

function renderHotkeySettings() {
  const all = Object.values(functionGroups).flat()
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-hotkeys'), t('config.settings-hotkeys.description'))}<div class="function-list">${all.map(([name, label, icon]) => `<div class="function-row"><span class="icon">${iconMarkup(icon)}</span><span class="label">${t(label)}</span>${shortcutButton(name, settings.shortcuts[name] || '')}</div>`).join('')}</div></div>`
  bindShortcutRecorders()
}

async function renderSystemSettings() {
  const dataRoot = await window.electronAPI.getDataRoot()
  if (currentRoute !== 'settings-system') return
  const historyDirectory = settings.screenshot.historyDirectory
  const commonSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.common-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.auto-start')}</b></div>${switchMarkup(settings.system.autoStart, 'autoStart', 'system')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.enable-tray')}</b></div>${switchMarkup(settings.system.enableTray, 'enableTray', 'system')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.game-mode')}</b><small>${t('config.settings-system.game-mode-hint')}</small></div>${switchMarkup(settings.system.gameMode, 'gameMode', 'system')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.run-log')}</b></div>${switchMarkup(settings.system.runLog, 'runLog', 'system')}</div></div></section>`
  const dataSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.data-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.data-root')}</b><small>${t('config.settings-system.data-root-hint')}</small></div><input id="dataRoot" type="text" readonly value="${escapeHtml(dataRoot.path)}"><button class="button" id="openDataRoot">${t('config.settings-system.open')}</button><button class="button" id="changeDataRoot">${t('config.settings-system.change')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.save-directory')}</b><small>${settings.screenshot.saveDirectory ? t('config.settings-system.save-directory-custom') : t('config.settings-system.save-directory-default')}</small></div><button class="button" id="openSave">${t('config.settings-system.open')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.history-directory')}</b><small>${t('config.settings-system.history-directory-hint')}</small></div><input id="historyDirectory" type="text" required value="${escapeHtml(historyDirectory)}"><button class="button" id="chooseHistoryDirectory">${t('config.settings-system.choose')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.clear-history')}</b><small>${t('config.settings-system.clear-history-hint')}</small></div><button class="button danger" id="clearData">${t('config.settings-system.clear')}</button></div></div></section>`
  const diagnosticsSettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.diagnostics-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.preview-diagnostics')}</b><small>${t('config.settings-system.preview-diagnostics-hint')}</small></div><button class="button" id="previewDiagnostics">${t('config.settings-system.preview')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.export-diagnostics')}</b><small>${t('config.settings-system.export-diagnostics-hint')}</small></div><button class="button primary" id="exportDiagnostics">${t('config.settings-system.export-zip')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.include-crash-dumps')}</b><small>${t('config.settings-system.include-crash-dumps-hint')}</small></div><input id="includeCrashDumps" type="checkbox"></div><pre id="diagnosticsPreview" class="diagnostics-preview" hidden></pre></div></section>`
  // The proxy bridge card. Every value it writes is a `proxy.*` field, and the
  // patch validator only accepts keys listed in DEFAULT_SETTINGS.
  const proxyDirectoryRow = (id, label, hint, value, button) => `<div class="form-row"><div class="form-label"><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</div><input id="${id}" type="text" value="${escapeHtml(value || '')}">${button ? `<button class="button" id="${button}">${t('config.settings-system.choose')}</button>` : ''}</div>`
  const proxySettings = `<section class="section"><h2 class="section-title">${t('config.settings-system.proxy-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-status')}</b><small id="proxyStatusDetail">${t('config.settings-system.proxy-status-checking')}</small></div><span id="proxyStatus">${t('config.settings-system.proxy-status-checking')}</span><button class="button" id="toggleProxy">${t('config.settings-system.proxy-start')}</button></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-auto-start')}</b></div>${switchMarkup(settings.proxy.autoStart === true, 'autoStart', 'proxy')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-port')}</b></div><input id="proxyPort" type="number" min="1" max="65535" value="${Number(settings.proxy.port) || 8080}"></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-host')}</b><small>${t('config.settings-system.proxy-host-hint')}</small></div><select id="proxyHost"><option value="127.0.0.1">127.0.0.1</option><option value="0.0.0.0">0.0.0.0</option></select></div>${proxyDirectoryRow('proxyRepoDirectory', t('config.settings-system.proxy-repo-directory'), t('config.settings-system.proxy-repo-directory-hint'), settings.proxy.repoDirectory, 'chooseProxyRepo')}${proxyDirectoryRow('proxyScriptPath', t('config.settings-system.proxy-script-path'), t('config.settings-system.proxy-script-path-hint'), settings.proxy.scriptPath, '')}<div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-python-path')}</b><small>${t('config.settings-system.proxy-python-path-hint')}</small></div><input id="proxyPythonPath" type="text" value="${escapeHtml(settings.proxy.pythonPath || '')}"></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-api-base')}</b><small>${t('config.settings-system.proxy-api-base-hint')}</small></div><input id="proxyApiBase" type="text" value="${escapeHtml(settings.proxy.apiBase || '')}"></div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-keep-running')}</b><small>${t('config.settings-system.proxy-keep-running-hint')}</small></div>${switchMarkup(settings.proxy.keepRunningOnExit === true, 'keepRunningOnExit', 'proxy')}</div><div class="form-row"><div class="form-label"><b>${t('config.settings-system.proxy-copy-config')}</b><small>${t('config.settings-system.proxy-copy-config-hint')}</small></div><button class="button" id="copyProxyConfig">${t('config.settings-system.proxy-copy')}</button></div></div></section>`
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.settings-system'), t('config.settings-system.description'))}${commonSettings}${proxySettings}${dataSettings}${diagnosticsSettings}<button class="button danger" id="resetSettings">${t('config.settings-system.reset')}</button></div>`
  bindSwitches()
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
  document.getElementById('openSave').onclick = () => window.electronAPI.openSaveDirectory()
  const historyDirectoryInput = document.getElementById('historyDirectory')
  const saveHistoryDirectory = () => {
    const directory = historyDirectoryInput.value.trim()
    if (!directory) {
      historyDirectoryInput.value = settings.screenshot.historyDirectory
      toast(t('config.settings-system.history-directory-required'))
      return null
    }
    return updateSettings({ screenshot: { historyDirectory: directory } }, t('config.settings-system.history-directory-updated'))
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
      port: Math.max(1, Math.min(65535, Number(document.getElementById('proxyPort').value) || 8080)),
      host: proxyHostSelect.value,
      repoDirectory: document.getElementById('proxyRepoDirectory').value.trim(),
      scriptPath: document.getElementById('proxyScriptPath').value.trim(),
      pythonPath: document.getElementById('proxyPythonPath').value.trim(),
      apiBase: document.getElementById('proxyApiBase').value.trim()
    }
  }, t('config.settings-system.proxy-updated'))
  window.electronAPI.getProxyStatus().then(renderProxyStatus).catch(() => {})
  if (window.__proxyStatusUnsubscribe) window.__proxyStatusUnsubscribe()
  window.__proxyStatusUnsubscribe = window.electronAPI.onProxyStatus(renderProxyStatus)
  document.getElementById('proxyPort').onchange = saveProxySettings
  document.getElementById('proxyPythonPath').onchange = saveProxySettings
  document.getElementById('proxyApiBase').onchange = saveProxySettings
  document.getElementById('proxyRepoDirectory').onchange = saveProxySettings
  document.getElementById('proxyScriptPath').onchange = saveProxySettings
  proxyHostSelect.onchange = saveProxySettings
  document.getElementById('chooseProxyRepo').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    document.getElementById('proxyRepoDirectory').value = directory
    await saveProxySettings()
  }
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

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderGeneralSettings'] = () => renderGeneralSettings()
window.configRoutes['renderFunctionSettings'] = () => renderFunctionSettings()
window.configRoutes['renderHotkeySettings'] = () => renderHotkeySettings()
window.configRoutes['renderSystemSettings'] = () => renderSystemSettings()
