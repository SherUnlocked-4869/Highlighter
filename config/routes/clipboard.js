'use strict'
async function renderClipboardSettings() {
  const value = settings.clipboard
  const boolFields = [['enabled', 'clipboard.enabled'], ['paused', 'clipboard.pause'], ['captureText', 'clipboard.capture-text'], ['captureImages', 'clipboard.capture-images'], ['captureFiles', 'clipboard.capture-files']]
  const numbers = [['historyLimit', 'clipboard.history-limit', 100, 5000], ['retentionDays', 'clipboard.retention-days', 1, 365], ['maxPayloadMiB', 'clipboard.max-payload', 64, 1024], ['maxDiskMiB', 'clipboard.max-disk', 128, 2048], ['maxThumbnailMiB', 'clipboard.max-thumbnails', 16, 256]]
  view.innerHTML = `<div class="page">${pageHeader(t('clipboard.title'), t('clipboard.description'))}<p>${t('clipboard.privacy')}</p><div class="card form-card">${boolFields.map(([key, label]) => `<div class="form-row"><label for="clipboard-${key}" class="form-label">${t(label)}</label><input id="clipboard-${key}" type="checkbox" ${value[key] ? 'checked' : ''}></div>`).join('')}${numbers.map(([key, label, min, max]) => `<div class="form-row"><label for="clipboard-${key}" class="form-label">${t(label)}</label><input id="clipboard-${key}" type="number" min="${min}" max="${max}" value="${value[key]}"></div>`).join('')}<div class="form-row"><label for="clipboard-release" class="form-label">${t('clipboard.release')}</label><select id="clipboard-release"><option value="0">${t('clipboard.immediate')}</option><option value="60000">${t('clipboard.one-minute')}</option><option value="300000">${t('clipboard.five-minutes')}</option></select></div><div class="form-row"><label for="clipboard-excluded" class="form-label"><b>${t('clipboard.excluded')}</b><small>${t('clipboard.excluded-hint')}</small></label><textarea class="textarea" id="clipboard-excluded"></textarea></div></div><div class="section"><button class="button primary" id="clipboard-save">${t('clipboard.save')}</button> <button class="button" id="clipboard-open" ${value.enabled ? '' : 'disabled'}>${t('clipboard.open')}</button></div><div class="card form-card"><p id="clipboard-status"></p><button class="button" id="clipboard-refresh">${t('clipboard.refresh')}</button> <button class="button danger" id="clipboard-clear" ${value.enabled ? '' : 'disabled'}>${t('clipboard.clear-ordinary')}</button> <button class="button danger" id="clipboard-clear-all" ${value.enabled ? '' : 'disabled'}>${t('clipboard.clear-all')}</button></div></div>`
  document.getElementById('clipboard-release').value = String(value.releaseAfterMs)
  document.getElementById('clipboard-excluded').value = value.excludedApps.join('\n')
  const readStatus = async () => {
    const snapshot = await window.electronAPI.getClipboardStatus()
    const label = document.getElementById('clipboard-status')
    if (!label || currentRoute !== 'clipboard-history') return
    const s = snapshot?.result
    label.textContent = s ? `${t(`clipboard.phase.${s.phase}`)} · ${s.itemCount} · ${(s.actualDiskBytes / 1048576).toFixed(1)} MiB${s.messageKey ? ` · ${s.messageKey}` : ''}` : t('clipboard.failed')
    if (!value.enabled) label.textContent = t('clipboard.manage-enabled')
  }
  document.getElementById('clipboard-save').onclick = async () => {
    const patch = {}
    for (const [key] of boolFields) patch[key] = document.getElementById(`clipboard-${key}`).checked
    for (const [key] of numbers) patch[key] = Number(document.getElementById(`clipboard-${key}`).value)
    patch.releaseAfterMs = Number(document.getElementById('clipboard-release').value)
    patch.excludedApps = document.getElementById('clipboard-excluded').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (numbers.some(([key]) => patch[key] < value[key]) && !confirm(t('clipboard.lower-limits'))) return
    try { await updateSettings({ clipboard: patch }, t('clipboard.saved')); await renderClipboardSettings() } catch (error) { toast(errorMessage(error)) }
  }
  document.getElementById('clipboard-open').onclick = () => window.electronAPI.executeFunction('openClipboardHistory')
  document.getElementById('clipboard-refresh').onclick = () => readStatus().catch(() => toast(t('clipboard.failed')))
  for (const [button, scope] of [['clipboard-clear', 'ordinary'], ['clipboard-clear-all', 'all']]) document.getElementById(button).onclick = async () => {
    try {
      const prepared = await window.electronAPI.prepareClipboardClear(scope)
      if (!prepared.ok) throw new Error(prepared.error.code)
      if (prepared.result.token) {
        const cleared = await window.electronAPI.commitClipboardClear(prepared.result.token, crypto.randomUUID())
        if (!cleared.ok) throw new Error(cleared.error.code)
      }
      await readStatus()
    } catch (error) { toast(errorMessage(error)) }
  }
  await readStatus()
}
window.configRoutes['renderClipboardSettings'] = renderClipboardSettings
