'use strict'

// B05 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the
// settings page explains what survives at capacity instead of printing one
// record count. Occupancy and skip totals come from the status snapshot the
// main process already polls (native SQLite aggregates); this file only formats
// them. Lowering the limit is previewed locally so dragging the slider never
// costs an IPC round trip.

const CLIPBOARD_CAPACITY_MIB = 1048576
const CLIPBOARD_CAPACITY_MIN = 100
const CLIPBOARD_CAPACITY_MAX = 5000

// Mirrors previewEviction() in main/services/clipboard-capacity.js. The settings
// window cannot require main-process code (CSP, contextIsolation), so the one
// rule that has to run while the slider moves lives here too; the capacity test
// compares both implementations over the whole input range.
function clipboardPreviewEviction(ordinaryCount, pinnedCount, historyLimit) {
  const ordinary = Number.isSafeInteger(ordinaryCount) && ordinaryCount > 0 ? ordinaryCount : 0
  const pinned = Number.isSafeInteger(pinnedCount) && pinnedCount > 0 ? pinnedCount : 0
  const limit = Number.isSafeInteger(historyLimit) && historyLimit > 0 ? historyLimit : 0
  const evicted = Math.max(0, ordinary - limit)
  return {
    ordinaryCount: ordinary,
    pinnedCount: pinned,
    newLimit: limit,
    evictedOrdinary: evicted,
    keptOrdinary: ordinary - evicted,
    pinnedKept: pinned,
    pinnedNeverEvicted: true,
    estimated: true,
    batchSize: 50
  }
}

function clipboardCapacityMiB(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '0.0 MiB'
  return `${(value / CLIPBOARD_CAPACITY_MIB).toFixed(1)} MiB`
}

function clipboardCapacityPercent(ratio) {
  const value = Number(ratio)
  if (!Number.isFinite(value) || value <= 0) return '0%'
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`
}

function clipboardCapacityEstimateTag(metric) {
  return metric?.estimated === true ? t('clipboard.capacity.estimated') : t('clipboard.capacity.exact')
}

function clipboardCapacityReason(reason) {
  const key = typeof reason?.messageKey === 'string' ? reason.messageKey : 'clipboard.skip.unknown'
  const label = t(key)
  return label === key ? t('clipboard.skip.unknown') : label
}

// Tiles are deliberately limited to the numbers the status can actually
// support: pins are counted exactly, original bytes are a total (the status has
// no per-scope byte split), and thumbnails/extras are the disk-payload
// difference, marked estimated in both the value and its tag.
function clipboardCapacityMarkup(snapshot) {
  const capacity = snapshot?.capacity
  if (!capacity) return `<p class="section-note">${t('clipboard.capacity.unavailable')}</p>`
  const counts = capacity.counts
  const budgets = capacity.budgets
  const bytes = capacity.bytes
  const skip = capacity.skip
  const tiles = [
    [counts.ordinary.value + ' / ' + budgets.records.limit.value, t('clipboard.capacity.ordinary'), `${t('clipboard.capacity.remaining', { count: budgets.records.remaining.value })} · ${clipboardCapacityEstimateTag(budgets.records.used)}`],
    [String(counts.pinned.value), t('clipboard.capacity.pinned'), `${t('clipboard.capacity.pinned-kept')} · ${clipboardCapacityEstimateTag(counts.pinned)}`],
    [`${clipboardCapacityMiB(bytes.payload.value)} / ${clipboardCapacityMiB(budgets.payload.limit.value)}`, t('clipboard.capacity.payload'), `${clipboardCapacityPercent(budgets.payload.ratio.value)} · ${clipboardCapacityEstimateTag(budgets.payload.used)}`],
    [`≈ ${clipboardCapacityMiB(bytes.thumbnails.value)} / ${clipboardCapacityMiB(budgets.thumbnails.limit.value)}`, t('clipboard.capacity.thumbnails'), `${clipboardCapacityPercent(budgets.thumbnails.ratio.value)} · ${clipboardCapacityEstimateTag(budgets.thumbnails.used)}`]
  ]
  const tilesMarkup = tiles.map(([value, label, note]) => `<div><b>${escapeHtml(value)}</b><span>${escapeHtml(label)} · ${escapeHtml(note)}</span></div>`).join('')
  const skipRows = skip.reasons.length
    ? skip.reasons.map((reason) => `<div class="form-row"><span class="form-label">${escapeHtml(clipboardCapacityReason(reason))}</span><span>× ${reason.count}</span></div>`).join('')
    : `<p class="section-note">${t('clipboard.capacity.skip-none')}</p>`
  const last = skip.last
    ? `<p class="section-note">${escapeHtml(t('clipboard.capacity.skip-last', { reason: clipboardCapacityReason(last), count: last.count }))}</p>`
    : ''
  const squeeze = capacity.pinned.squeeze.possible
    ? `<p class="section-note">${t('clipboard.capacity.pinned-squeeze')}</p>`
    : ''
  return `<div class="history-stats">${tilesMarkup}</div>
    <p class="section-note">${t('clipboard.capacity.bytes-shared')} ${escapeHtml(t('clipboard.capacity.headroom', { free: clipboardCapacityMiB(budgets.payload.remaining.value), disk: clipboardCapacityMiB(budgets.disk.remaining.value) }))}</p>
    <div class="form-row"><span class="form-label">${t('clipboard.capacity.disk')}</span><span>≈ ${escapeHtml(`${clipboardCapacityMiB(bytes.disk.value)} / ${clipboardCapacityMiB(budgets.disk.limit.value)} (${clipboardCapacityPercent(budgets.disk.ratio.value)}) · ${clipboardCapacityEstimateTag(bytes.disk)}`)}</span></div>
    ${squeeze}
    <div class="form-row" style="align-items:flex-start"><div class="form-label"><b>${t('clipboard.capacity.skip-title')}</b><small>${t('clipboard.capacity.skip-since')}</small></div><div style="flex:1;min-width:0">${skipRows}${last}</div></div>`
}

async function renderClipboardSettings() {
  const value = settings.clipboard
  const boolFields = [['enabled', 'clipboard.enabled'], ['paused', 'clipboard.pause'], ['captureText', 'clipboard.capture-text'], ['captureImages', 'clipboard.capture-images'], ['captureFiles', 'clipboard.capture-files']]
  const numbers = [['historyLimit', 'clipboard.history-limit', 100, 5000], ['retentionDays', 'clipboard.retention-days', 1, 365], ['maxPayloadMiB', 'clipboard.max-payload', 64, 1024], ['maxDiskMiB', 'clipboard.max-disk', 128, 2048], ['maxThumbnailMiB', 'clipboard.max-thumbnails', 16, 256]]
  const disabled = value.enabled ? '' : 'disabled'
  view.innerHTML = `<div class="page">${pageHeader(t('clipboard.title'), t('clipboard.description'))}
    <p class="section-note">${t('clipboard.privacy')}</p>
    <div class="card form-card">
      ${boolFields.map(([key, label]) => `<label class="form-row clipboard-switch-row"><span class="form-label">${t(label)}</span><span class="clipboard-switch"><input id="clipboard-${key}" type="checkbox" role="switch" ${value[key] ? 'checked' : ''}><span class="switch" aria-hidden="true"></span></span></label>`).join('')}
      ${numbers.map(([key, label, min, max]) => `<div class="form-row"><label for="clipboard-${key}" class="form-label">${t(label)}</label><input id="clipboard-${key}" type="number" min="${min}" max="${max}" value="${value[key]}"></div>`).join('')}
      <div class="form-row"><label for="clipboard-release" class="form-label">${t('clipboard.release')}</label><select id="clipboard-release"><option value="0">${t('clipboard.immediate')}</option><option value="60000">${t('clipboard.one-minute')}</option><option value="300000">${t('clipboard.five-minutes')}</option></select></div>
      <div class="form-row"><label for="clipboard-excluded" class="form-label"><b>${t('clipboard.excluded')}</b><small>${t('clipboard.excluded-hint')}</small></label><textarea class="textarea" id="clipboard-excluded"></textarea></div>
    </div>
    <div class="section action-group action-group-end route-save"><button class="button primary" id="clipboard-save">${t('clipboard.save')}</button></div>
    <div class="card form-card clipboard-management"><p id="clipboard-status" role="status"></p>
      <div class="action-group"><button class="button" id="clipboard-open" ${disabled}>${t('clipboard.open')}</button><button class="button subtle" id="clipboard-refresh">${t('clipboard.refresh')}</button></div>
      <div class="action-group clipboard-danger"><button class="button subtle danger" id="clipboard-clear" ${disabled}>${t('clipboard.clear-ordinary')}</button><button class="button danger" id="clipboard-clear-all" ${disabled}>${t('clipboard.clear-all')}</button></div>
    </div>
    <div class="card form-card" id="clipboard-capacity-card">
      <p class="section-note"><b>${t('clipboard.capacity.title')}</b> · ${t('clipboard.capacity.hint')}</p>
      <div id="clipboard-capacity-body"><p class="section-note">${t('clipboard.capacity.loading')}</p></div>
      <div class="form-row" id="clipboard-limit-preview-row">
        <label for="clipboard-limit-preview" class="form-label"><b>${t('clipboard.capacity.preview-title')}</b><small>${t('clipboard.capacity.preview-estimate')}</small></label>
        <input id="clipboard-limit-preview" type="range" min="${CLIPBOARD_CAPACITY_MIN}" max="${CLIPBOARD_CAPACITY_MAX}" step="1" value="${value.historyLimit}" aria-describedby="clipboard-limit-preview-text">
      </div>
      <p class="section-note" id="clipboard-limit-preview-text"></p>
    </div></div>`
  document.getElementById('clipboard-release').value = String(value.releaseAfterMs)
  document.getElementById('clipboard-excluded').value = value.excludedApps.join('\n')
  let capacityCounts = null
  const updatePreviewText = () => {
    const preview = document.getElementById('clipboard-limit-preview')
    const text = document.getElementById('clipboard-limit-preview-text')
    if (!preview || !text) return
    if (!capacityCounts) {
      preview.disabled = true
      text.textContent = t('clipboard.capacity.preview-unavailable')
      return
    }
    preview.disabled = false
    const result = clipboardPreviewEviction(capacityCounts.ordinary, capacityCounts.pinned, Number(preview.value))
    text.textContent = result.evictedOrdinary > 0
      ? t('clipboard.capacity.preview-evict', { limit: result.newLimit, count: result.evictedOrdinary, pinned: result.pinnedKept })
      : t('clipboard.capacity.preview-none', { limit: result.newLimit, pinned: result.pinnedKept })
  }
  const limitField = document.getElementById('clipboard-historyLimit')
  const previewField = document.getElementById('clipboard-limit-preview')
  if (limitField && previewField) {
    // The slider is only a preview, but it edits the same field the save path
    // reads, so dragging it and saving cannot disagree.
    previewField.oninput = () => { limitField.value = previewField.value; updatePreviewText() }
    limitField.oninput = () => {
      const next = Number(limitField.value)
      if (Number.isFinite(next)) previewField.value = String(Math.max(CLIPBOARD_CAPACITY_MIN, Math.min(CLIPBOARD_CAPACITY_MAX, Math.round(next))))
      updatePreviewText()
    }
  }
  const readStatus = async () => {
    const snapshot = await window.electronAPI.getClipboardStatus()
    const label = document.getElementById('clipboard-status')
    if (!label || currentRoute !== 'clipboard-history') return
    const s = snapshot?.result
    label.textContent = s ? `${t(`clipboard.phase.${s.phase}`)} · ${s.itemCount} · ${(s.actualDiskBytes / 1048576).toFixed(1)} MiB${s.messageKey ? ` · ${s.messageKey}` : ''}` : t('clipboard.failed')
    if (!value.enabled) label.textContent = t('clipboard.manage-enabled')
    capacityCounts = value.enabled && s?.capacity ? { ordinary: s.capacity.counts.ordinary.value, pinned: s.capacity.counts.pinned.value } : null
    const body = document.getElementById('clipboard-capacity-body')
    if (body) body.innerHTML = value.enabled ? clipboardCapacityMarkup(s) : `<p class="section-note">${t('clipboard.capacity.disabled')}</p>`
    updatePreviewText()
  }
  document.getElementById('clipboard-save').onclick = async () => {
    const patch = {}
    for (const [key] of boolFields) patch[key] = document.getElementById(`clipboard-${key}`).checked
    for (const [key] of numbers) patch[key] = Number(document.getElementById(`clipboard-${key}`).value)
    patch.releaseAfterMs = Number(document.getElementById('clipboard-release').value)
    patch.excludedApps = document.getElementById('clipboard-excluded').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (numbers.some(([key]) => patch[key] < value[key]) && !confirm(t('clipboard.lower-limits'))) return
    try {
      await updateSettings({ clipboard: patch }, t('clipboard.saved'))
      if (currentRoute === 'clipboard-history') {
        await renderClipboardSettings()
        document.getElementById('clipboard-save')?.focus({ preventScroll: true })
      }
    } catch (error) { toast(errorMessage(error)) }
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

// CommonJS export is for test/clipboard-capacity-*.test.js. In the settings
// window this file is a classic script, so both guards are no-ops there.
if (typeof module !== 'undefined' && module.exports) module.exports = { clipboardPreviewEviction, clipboardCapacityMarkup }
if (typeof window !== 'undefined') window.configRoutes['renderClipboardSettings'] = renderClipboardSettings
