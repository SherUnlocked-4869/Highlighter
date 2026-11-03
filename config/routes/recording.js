// W4 (recording workbench): the main window's `recording` route.
//
// Scope (docs/plans/2026-11-03-recording-r1-r3-contracts.md §8/§9.1): the
// workbench and the recording records list live INSIDE the ordinary settings
// window, so no new window, preload or navigation is introduced. The renderer is
// only allowed to read the frozen `record:workbench-*` / `record:project-*`
// channels; the main process owns every source path, output path and encoder
// detail. Project summaries are path-free by contract, so nothing here builds or
// displays a filesystem path.
//
// Degradation rule: this route must never take the settings window down. While
// the main-process half is missing (it lands in a parallel stream) every call
// fails with a visible inline state + retry, and every action is guarded by a
// `typeof` check instead of throwing an unhandled rejection.
//
// i18n: all copy comes from shared/locales/recording.js through t(); this file
// stays CJK-free because config/** is inside the check-i18n CJK scan.

const RECORDING_RECORDS_PAGE_SIZE = 20
const RECORDING_BANNER_POLL_MS = 2000
const RECORDING_FRAME_RATES = Object.freeze([30, 60])
const RECORDING_LEGACY_FRAME_RATES = Object.freeze([5, 16, 24])
const RECORDING_QUALITY_FALLBACK = Object.freeze(['standard', 'high', 'ultra'])
const RECORDING_COUNTDOWN_FALLBACK = Object.freeze([0, 3, 5])

// Frozen label maps. Key literals are written out in full (never concatenated)
// because test/i18n-contract.test.js resolves every key-shaped literal against
// the tables this window loads.
const RECORDING_QUALITY_LABEL_KEYS = Object.freeze({
  standard: 'recording.workbench.quality-standard',
  high: 'recording.workbench.quality-high',
  ultra: 'recording.workbench.quality-ultra'
})
const RECORDING_MODE_LABEL_KEYS = Object.freeze({
  display: 'recording.records.mode-display',
  region: 'recording.records.mode-region'
})
const RECORDING_STATE_LABEL_KEYS = Object.freeze({
  ready: 'recording.records.state-ready',
  capturing: 'recording.records.state-capturing',
  recoverable: 'recording.records.state-recoverable',
  deleting: 'recording.records.state-deleting'
})
const RECORDING_STATUS_LABEL_KEYS = Object.freeze({
  preparing: 'recording.workbench.status-preparing',
  countdown: 'recording.workbench.status-countdown',
  recording: 'recording.workbench.status-recording',
  paused: 'recording.workbench.status-paused',
  finalizing: 'recording.workbench.status-finalizing'
})
const RECORDING_ERROR_LABEL_KEYS = Object.freeze({
  busy: 'recording.workbench.start-busy',
  'project-busy': 'recording.records.project-busy',
  'display-unavailable': 'recording.workbench.display-missing',
  'not-found': 'recording.records.open-not-found'
})

// --- route state -------------------------------------------------------------
let recordingWorkbenchState = null
let recordingWorkbenchError = false
let recordingWorkbenchChoices = null
let recordingWorkbenchDevices = []
let recordingWorkbenchDeviceError = false
let recordingWorkbenchTab = 'recent'
let recordingWorkbenchFilter = 'all'
let recordingWorkbenchAll = { items: [], total: 0, offset: 0, limit: RECORDING_RECORDS_PAGE_SIZE, loaded: false, loading: false, error: false }
let recordingWorkbenchBusy = false
let recordingWorkbenchPolling = false
let recordingWorkbenchPollTimer = null

// --- pure helpers ------------------------------------------------------------

function recordingQualityApi() {
  const api = window.recordingQuality
  return api && typeof api === 'object' ? api : null
}

function recordingQualityLevels() {
  const api = recordingQualityApi()
  return api && Array.isArray(api.QUALITY_LEVELS) && api.QUALITY_LEVELS.length ? api.QUALITY_LEVELS.slice() : RECORDING_QUALITY_FALLBACK.slice()
}

function recordingCountdownOptions() {
  const api = recordingQualityApi()
  return api && Array.isArray(api.COUNTDOWN_OPTIONS) && api.COUNTDOWN_OPTIONS.length ? api.COUNTDOWN_OPTIONS.slice() : RECORDING_COUNTDOWN_FALLBACK.slice()
}

function normalizeRecordingQuality(value) {
  const levels = recordingQualityLevels()
  const candidate = typeof value === 'string' ? value.trim() : ''
  return levels.includes(candidate) ? candidate : levels[0]
}

function normalizeRecordingCountdown(value) {
  const options = recordingCountdownOptions()
  const seconds = Number(value)
  return options.includes(seconds) ? seconds : (options.includes(3) ? 3 : options[0])
}

function normalizeRecordingFrameRate(value) {
  const frameRate = Number(value)
  if (RECORDING_FRAME_RATES.includes(frameRate) || RECORDING_LEGACY_FRAME_RATES.includes(frameRate)) return frameRate
  return RECORDING_FRAME_RATES[0]
}

// Media duration as a media-player style clock. Pause time never reaches this
// value: the main process reports media time, not wall clock.
function formatRecordingDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

// Stable, locale-independent stamp: the settings window renders this itself, so
// it must not depend on the host locale of whatever machine runs it.
function formatRecordingDate(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function recordingDisplayResolution(display) {
  const width = Number(display && display.width) || 0
  const height = Number(display && display.height) || 0
  if (width > 0 && height > 0) return `${width}\u00d7${height}`
  return display && typeof display.label === 'string' ? display.label : ''
}

function recordingProjectResolution(project) {
  const width = Number(project && project.width) || 0
  const height = Number(project && project.height) || 0
  if (width > 0 && height > 0) return `${width}\u00d7${height}`
  return ''
}

function recordingAudioLabel(project) {
  const audio = project && project.audio && typeof project.audio === 'object' ? project.audio : {}
  const system = audio.system === true
  const microphone = audio.microphone === true
  if (system && microphone) return t('recording.records.audio-both')
  if (system) return t('recording.records.audio-system')
  if (microphone) return t('recording.records.audio-microphone')
  return t('recording.records.audio-none')
}

function recordingStateLabel(state) {
  return t(RECORDING_STATE_LABEL_KEYS[state] || 'recording.records.state-unknown')
}

function recordingModeLabel(mode) {
  return RECORDING_MODE_LABEL_KEYS[mode] ? t(RECORDING_MODE_LABEL_KEYS[mode]) : ''
}

function recordingStatusLabel(status) {
  return RECORDING_STATUS_LABEL_KEYS[status] ? t(RECORDING_STATUS_LABEL_KEYS[status]) : String(status || '')
}

// An explicit target, never a guess. A saved id that is no longer attached is
// reported as missing; only a single-display machine may bind implicitly, because
// there the one display is the only possible target and the UI still shows it.
function resolveRecordingDisplay(displays, displayId) {
  const list = Array.isArray(displays) ? displays : []
  const wanted = typeof displayId === 'string' ? displayId : ''
  if (wanted && list.some((display) => display && display.id === wanted)) return { displayId: wanted, missing: false }
  if (list.length === 1 && list[0] && typeof list[0].id === 'string' && list[0].id) return { displayId: list[0].id, missing: false }
  return { displayId: '', missing: Boolean(wanted) }
}

function createRecordingChoices(state) {
  const config = state && typeof state.config === 'object' && state.config ? state.config : {}
  const displays = state && Array.isArray(state.displays) ? state.displays : []
  const resolved = resolveRecordingDisplay(displays, config.displayId)
  return {
    mode: config.mode === 'region' ? 'region' : 'display',
    displayId: resolved.displayId,
    displayMissing: resolved.missing,
    frameRate: normalizeRecordingFrameRate(config.frameRate),
    quality: normalizeRecordingQuality(config.quality),
    countdown: normalizeRecordingCountdown(config.countdown),
    audioSystem: config.audioSystem !== false,
    audioMicrophone: config.audioMicrophone === true,
    audioMicrophoneDeviceId: typeof config.audioMicrophoneDeviceId === 'string' ? config.audioMicrophoneDeviceId : '',
    saveDirectory: typeof config.saveDirectory === 'string' ? config.saveDirectory : ''
  }
}

function buildRecordingStartPayload(choices) {
  const mode = choices && choices.mode === 'region' ? 'region' : 'display'
  const displayId = mode === 'display' && typeof choices.displayId === 'string' ? choices.displayId : ''
  const config = {
    mode,
    displayId,
    frameRate: normalizeRecordingFrameRate(choices && choices.frameRate),
    quality: normalizeRecordingQuality(choices && choices.quality),
    countdown: normalizeRecordingCountdown(choices && choices.countdown),
    audioSystem: choices ? choices.audioSystem !== false : true,
    audioMicrophone: choices ? choices.audioMicrophone === true : false,
    audioMicrophoneDeviceId: choices && typeof choices.audioMicrophoneDeviceId === 'string' ? choices.audioMicrophoneDeviceId : '',
    saveDirectory: choices && typeof choices.saveDirectory === 'string' ? choices.saveDirectory : ''
  }
  const payload = { mode, config }
  if (displayId) payload.displayId = displayId
  return payload
}

function recordingStartBlocker(choices, state) {
  if (state && state.active && typeof state.active === 'object') return 'active'
  if (!choices) return 'missing'
  if (choices.mode === 'display' && !choices.displayId) return 'display-required'
  return ''
}

function recordingMicrophoneDevices() {
  return Array.isArray(recordingWorkbenchDevices) ? recordingWorkbenchDevices : []
}

function recordingAudioWarningKey(choices) {
  if (!choices || choices.audioMicrophone !== true) return ''
  if (recordingWorkbenchDeviceError) return 'recording.workbench.audio-unavailable'
  const devices = recordingMicrophoneDevices()
  if (!devices.length) return 'recording.workbench.audio-unavailable'
  const selected = typeof choices.audioMicrophoneDeviceId === 'string' ? choices.audioMicrophoneDeviceId : ''
  if (selected && !devices.some((device) => device.id === selected)) return 'recording.workbench.audio-device-missing'
  return ''
}

function recordingErrorText(code, fallbackKey) {
  const key = typeof code === 'string' ? RECORDING_ERROR_LABEL_KEYS[code] : ''
  return t(key || fallbackKey || 'recording.workbench.start-failed')
}

function recordingChannelAvailable(name) {
  const api = window.electronAPI
  return Boolean(api && typeof api === 'object' && typeof api[name] === 'function')
}

function recordingVisibleProjects() {
  const source = recordingWorkbenchTab === 'all'
    ? recordingWorkbenchAll.items
    : (recordingWorkbenchState && Array.isArray(recordingWorkbenchState.recent) ? recordingWorkbenchState.recent : [])
  const filter = recordingWorkbenchFilter
  return source.filter((project) => project && typeof project.id === 'string' && project.id && (filter === 'all' || project.mode === filter))
}

function findRecordingProject(projectId) {
  if (typeof projectId !== 'string' || !projectId) return null
  const lists = []
  if (recordingWorkbenchState && Array.isArray(recordingWorkbenchState.recent)) lists.push(recordingWorkbenchState.recent)
  lists.push(recordingWorkbenchAll.items)
  for (const list of lists) {
    const found = list.find((project) => project && project.id === projectId)
    if (found) return found
  }
  return null
}

function replaceRecordingProject(projectId, project) {
  const apply = (list) => list.map((entry) => (entry && entry.id === projectId ? project : entry))
  if (recordingWorkbenchState && Array.isArray(recordingWorkbenchState.recent)) recordingWorkbenchState.recent = apply(recordingWorkbenchState.recent)
  recordingWorkbenchAll.items = apply(recordingWorkbenchAll.items)
}

function removeRecordingProject(projectId) {
  const apply = (list) => list.filter((entry) => !entry || entry.id !== projectId)
  if (recordingWorkbenchState && Array.isArray(recordingWorkbenchState.recent)) recordingWorkbenchState.recent = apply(recordingWorkbenchState.recent)
  recordingWorkbenchAll.items = apply(recordingWorkbenchAll.items)
  recordingWorkbenchAll.total = Math.max(0, recordingWorkbenchAll.total - 1)
  if (currentRoute === 'recording') renderRecordingRecordsHost()
}

// --- markup ------------------------------------------------------------------

function recordingSwitchMarkup(value, name, testId, label) {
  const on = value === true
  return `<button type="button" class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${escapeHtml(label)}" data-recording-switch="${name}" data-testid="${testId}"></button>`
}

function recordingErrorMarkup() {
  if (!recordingWorkbenchError) return ''
  return `<div class="rec-error" data-testid="workbench-error"><div class="rec-error-body"><b>${t('recording.workbench.load-failed')}</b><small>${t('recording.workbench.load-failed-hint')}</small></div><button type="button" class="button" data-recording-retry data-testid="workbench-retry">${t('recording.workbench.retry')}</button></div>`
}

function recordingActiveBannerMarkup(active) {
  if (!active || typeof active !== 'object') return ''
  const status = recordingStatusLabel(active.status)
  const elapsed = formatRecordingDuration(active.elapsedMs)
  const muted = active.microphoneMuted === true ? `<span class="rec-live-muted">${t('recording.workbench.audio-microphone')} MUTE</span>` : ''
  return `<div class="rec-live-banner" data-testid="active-banner"><span class="rec-live-dot" aria-hidden="true"></span><b>${t('recording.workbench.active-recording')}</b><span class="rec-live-status">${escapeHtml(status)} \u00b7 ${escapeHtml(elapsed)}</span>${muted}<button type="button" class="button" data-recording-focus data-testid="active-focus">${t('recording.workbench.active-focus')}</button></div>`
}

function recordingStartButtonMarkup(choices) {
  const blocker = recordingStartBlocker(choices, recordingWorkbenchState)
  const disabled = recordingWorkbenchBusy || Boolean(blocker) || recordingWorkbenchError || !recordingWorkbenchState
  const label = recordingWorkbenchBusy
    ? t('recording.workbench.starting')
    : (choices && choices.mode === 'region' ? t('recording.workbench.start-region') : t('recording.workbench.start-display'))
  let title = ''
  if (blocker === 'active') title = t('recording.workbench.start-busy')
  else if (blocker === 'display-required') title = t('recording.workbench.display-missing')
  return `<button type="button" class="button primary rec-start" id="recordingStartButton" data-recording-start data-testid="start-recording" title="${escapeHtml(title)}" ${disabled ? 'disabled' : ''}>${label}</button>`
}

function recordingModeSectionMarkup(choices) {
  const card = (mode, icon, titleKey, hintKey, testId) => {
    const active = choices.mode === mode
    return `<button type="button" class="rec-mode-card${active ? ' active' : ''}" data-recording-mode="${mode}" data-testid="${testId}" aria-pressed="${active ? 'true' : 'false'}"><span class="rec-mode-icon">${iconMarkup(icon)}</span><span class="rec-mode-body"><b>${t(titleKey)}</b><small>${t(hintKey)}</small></span></button>`
  }
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.modes-section')}</h2><div class="rec-mode-cards">${card('region', '../capture/icons/select.svg', 'recording.workbench.mode-region', 'recording.workbench.mode-region-hint', 'mode-region')}${card('display', 'icons/fullscreen.svg', 'recording.workbench.mode-display', 'recording.workbench.mode-display-hint', 'mode-display')}</div></section>`
}

function recordingTargetSectionMarkup(choices) {
  const displays = recordingWorkbenchState && Array.isArray(recordingWorkbenchState.displays) ? recordingWorkbenchState.displays : []
  const intro = choices.mode === 'region'
    ? t('recording.workbench.target-region-note')
    : t('recording.workbench.target-display-note')
  const empty = choices.mode === 'display' && !displays.length
    ? `<div class="rec-note">${t('recording.workbench.displays-empty')}</div>`
    : ''
  const missing = choices.mode === 'display' && choices.displayMissing ? `<div class="rec-warning" data-testid="display-warning">${t('recording.workbench.display-missing')}</div>` : ''
  const options = choices.mode === 'display' && displays.length
    ? `<div class="rec-display-list">${displays.map((display) => recordingDisplayOptionMarkup(display, choices)).join('')}</div>`
    : ''
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.target-section')}</h2><div class="card rec-target-card"><p class="rec-note">${intro}</p>${empty}${options}${missing}</div></section>`
}

function recordingDisplayOptionMarkup(display, choices) {
  if (!display || typeof display.id !== 'string' || !display.id) return ''
  const selected = choices.displayId === display.id
  const name = typeof display.name === 'string' && display.name ? display.name : display.id
  const resolution = recordingDisplayResolution(display)
  const scale = Number(display.scaleFactor) > 0 && Number(display.scaleFactor) !== 1 ? ` \u00b7 ${display.scaleFactor}x` : ''
  const primary = display.primary === true ? `<span class="rec-badge">${t('recording.workbench.display-primary')}</span>` : ''
  const stateBadge = selected ? `<span class="rec-badge accent">${t('recording.workbench.display-selected')}</span>` : ''
  return `<button type="button" class="rec-display${selected ? ' active' : ''}" data-recording-display="${escapeHtml(display.id)}" data-display-id="${escapeHtml(display.id)}" data-testid="display-option" aria-pressed="${selected ? 'true' : 'false'}"><span class="rec-display-name">${escapeHtml(name)}</span>${primary}${stateBadge}<small class="rec-display-meta">${escapeHtml(resolution + scale)}</small></button>`
}

function recordingMicrophoneOptionMarkup(choices) {
  const options = [`<option value="">${t('recording.workbench.audio-device-default')}</option>`]
  const selectedId = typeof choices.audioMicrophoneDeviceId === 'string' ? choices.audioMicrophoneDeviceId : ''
  let matched = !selectedId
  for (const device of recordingMicrophoneDevices()) {
    const selected = device.id === selectedId
    if (selected) matched = true
    options.push(`<option value="${escapeHtml(device.id)}"${selected ? ' selected' : ''}>${escapeHtml(device.label)}</option>`)
  }
  if (!matched) options.push(`<option value="${escapeHtml(selectedId)}" selected>${t('recording.workbench.audio-device-missing-short')}</option>`)
  return options.join('')
}

function recordingAudioSectionMarkup(choices) {
  const warningKey = recordingAudioWarningKey(choices)
  const warning = warningKey
    ? `<div class="rec-warning" data-testid="audio-warning"><span>${t(warningKey)}</span><div class="rec-warning-actions"><button type="button" class="button" data-recording-device-refresh>${t('recording.workbench.audio-device-refresh')}</button><button type="button" class="button" data-recording-continue-without>${t('recording.workbench.audio-continue-without')}</button></div></div>`
    : ''
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.audio-section')}<small>${t('recording.workbench.audio-hint')}</small></h2><div class="card form-card">
    <div class="form-row"><div class="form-label"><b>${t('recording.workbench.audio-system')}</b><small>${t('recording.workbench.audio-system-hint')}</small></div>${recordingSwitchMarkup(choices.audioSystem, 'audioSystem', 'audio-system', t('recording.workbench.audio-system'))}</div>
    <div class="form-row"><div class="form-label"><b>${t('recording.workbench.audio-microphone')}</b><small>${t('recording.workbench.audio-microphone-hint')}</small></div>${recordingSwitchMarkup(choices.audioMicrophone, 'audioMicrophone', 'audio-microphone', t('recording.workbench.audio-microphone'))}</div>
    <div class="form-row"><div class="form-label"><b>${t('recording.workbench.audio-device')}</b></div><select data-recording-device data-testid="microphone-device">${recordingMicrophoneOptionMarkup(choices)}</select></div>
  </div>${warning}</section>`
}

function recordingParamsSectionMarkup(choices) {
  const frameRateOption = (value) => `<option value="${value}" data-testid="frame-rate-${value}"${choices.frameRate === value ? ' selected' : ''}>${t('recording.workbench.fps', { value })}</option>`
  const qualityOptions = recordingQualityLevels().map((level) => `<option value="${escapeHtml(level)}" data-testid="quality-${escapeHtml(level)}"${choices.quality === level ? ' selected' : ''}>${t(RECORDING_QUALITY_LABEL_KEYS[level])}</option>`).join('')
  const countdownOptions = recordingCountdownOptions().map((seconds) => {
    const label = seconds === 0 ? t('recording.workbench.countdown-off') : t('recording.workbench.countdown-seconds', { seconds })
    return `<option value="${seconds}" data-testid="countdown-${seconds}"${choices.countdown === seconds ? ' selected' : ''}>${label}</option>`
  }).join('')
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.params-section')}</h2><div class="card form-card rec-params">
    <label class="rec-field"><b>${t('recording.workbench.frame-rate')}</b><select data-recording-frame-rate data-testid="frame-rate-select">${RECORDING_FRAME_RATES.map(frameRateOption).join('')}<optgroup label="${t('recording.workbench.frame-rate-advanced')}">${RECORDING_LEGACY_FRAME_RATES.map(frameRateOption).join('')}</optgroup></select><small>${t('recording.workbench.frame-rate-hint')}</small></label>
    <label class="rec-field"><b>${t('recording.workbench.quality')}</b><select data-recording-quality data-testid="quality-select">${qualityOptions}</select></label>
    <label class="rec-field"><b>${t('recording.workbench.countdown')}</b><select data-recording-countdown data-testid="countdown-select">${countdownOptions}</select><small>${t('recording.workbench.countdown-hint')}</small></label>
  </div></section>`
}

function recordingStorageSectionMarkup(choices) {
  const text = choices.saveDirectory
    ? t('recording.workbench.storage-configured', { directory: choices.saveDirectory })
    : t('recording.workbench.storage-default')
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.storage-section')}</h2><div class="card rec-target-card"><p class="rec-note">${escapeHtml(text)}</p></div></section>`
}

function recordingProjectCardMarkup(project) {
  const id = escapeHtml(project.id)
  const state = typeof project.state === 'string' ? project.state : ''
  const modeLabel = recordingModeLabel(project.mode)
  const resolution = recordingProjectResolution(project) || t('recording.records.no-resolution')
  const detail = t('recording.records.detail', { mode: modeLabel, resolution, duration: formatRecordingDuration(project.durationMs), size: formatBytes(project.bytes) })
  const capturing = state === 'capturing'
  const disabled = capturing ? ' disabled' : ''
  const disabledTitle = capturing ? ` title="${t('recording.records.busy-hint')}"` : ''
  const recoverable = state === 'recoverable' ? `<p class="rec-card-hint">${t('recording.records.recoverable-hint')}</p>` : ''
  const lastExport = project.lastExport && typeof project.lastExport.fileName === 'string' && project.lastExport.fileName
    ? `<div class="rec-card-export">${t('recording.records.exported', { fileName: project.lastExport.fileName })}</div>`
    : ''
  const action = (name, testId, label, className = 'button') => `<button type="button" class="${className}" data-recording-action="${name}" data-project-id="${id}" data-testid="${testId}"${name === 'edit' || name === 'play' ? disabled + disabledTitle : ''}>${label}</button>`
  return `<article class="card rec-card" data-testid="record-card" data-project-id="${id}" data-project-state="${escapeHtml(state)}">
    <div class="rec-card-head"><b class="rec-card-name">${escapeHtml(project.name || project.id)}</b><span class="rec-state state-${escapeHtml(state)}">${recordingStateLabel(state)}</span></div>
    <div class="rec-card-meta"><span>${escapeHtml(formatRecordingDate(project.createdAt))}</span><span>${escapeHtml(recordingAudioLabel(project))}</span></div>
    <div class="rec-card-detail">${escapeHtml(detail)}</div>
    ${recoverable}${lastExport}
    <div class="rec-card-actions">${action('edit', 'card-edit', t('recording.records.action-edit'))}${action('play', 'card-play', t('recording.records.action-play'))}${action('rename', 'card-rename', t('recording.records.action-rename'))}${action('reveal', 'card-reveal', t('recording.records.action-reveal'))}${action('delete', 'card-delete', t('recording.records.action-delete'), 'button danger rec-delete')}</div>
  </article>`
}

function recordingRecordsMarkup() {
  const loading = recordingWorkbenchTab === 'all'
    ? recordingWorkbenchAll.loading && !recordingWorkbenchAll.loaded
    : !recordingWorkbenchState && !recordingWorkbenchError
  if (loading) return `<div class="rec-records-state" data-testid="records-loading">${t('recording.records.loading')}</div>`
  if (recordingWorkbenchTab === 'all' && recordingWorkbenchAll.error) {
    return `<div class="rec-error" data-testid="records-error"><div class="rec-error-body"><b>${t('recording.records.load-failed')}</b><small>${t('recording.workbench.load-failed-hint')}</small></div><button type="button" class="button" data-recording-retry-records>${t('recording.workbench.retry')}</button></div>`
  }
  const items = recordingVisibleProjects()
  if (!items.length) return `<div class="empty" data-testid="records-empty">${t('recording.records.empty')}<p>${t('recording.records.empty-hint')}</p></div>`
  const totalLine = recordingWorkbenchTab === 'all' ? `<div class="rec-records-total">${t('recording.records.total', { total: recordingWorkbenchAll.total })}</div>` : ''
  const loadMore = recordingWorkbenchTab === 'all' && recordingWorkbenchAll.items.length < recordingWorkbenchAll.total
    ? `<div class="rec-records-more"><button type="button" class="button" data-recording-load-more data-testid="records-load-more">${t('recording.records.load-more')}</button></div>`
    : ''
  return `<div class="rec-records-grid">${items.map(recordingProjectCardMarkup).join('')}</div>${totalLine}${loadMore}`
}

function recordingRecordsSectionMarkup() {
  const tab = (key, testId, label) => `<button type="button" class="${recordingWorkbenchTab === key ? 'active' : ''}" data-recording-tab="${key}" data-testid="${testId}">${label}</button>`
  const filters = [['all', 'recording.records.filter-all'], ['display', 'recording.records.filter-display'], ['region', 'recording.records.filter-region']]
    .map(([value, key]) => `<option value="${value}"${recordingWorkbenchFilter === value ? ' selected' : ''}>${t(key)}</option>`).join('')
  return `<section class="section" id="recordingRecordsSection"><h2 class="section-title">${t('recording.workbench.records-section')}<small>${t('recording.workbench.hint')}</small></h2><div class="rec-records-toolbar"><div class="tabs">${tab('recent', 'records-tab-recent', t('recording.records.tab-recent'))}${tab('all', 'records-tab-all', t('recording.records.tab-all'))}</div><label class="rec-filter"><span>${t('recording.records.filter-label')}</span><select data-recording-filter data-testid="records-filter">${filters}</select></label></div><div id="recordingRecordsHost">${recordingRecordsMarkup()}</div></section>`
}

function recordingWorkbenchMarkup(choices) {
  return `<div class="page recording-workbench" data-testid="recording-workbench" data-workbench-mode="${escapeHtml(choices.mode)}">${pageHeader(t('recording.workbench.title'), t('recording.workbench.description'), recordingStartButtonMarkup(choices))}<div id="recordingActiveBanner">${recordingActiveBannerMarkup(recordingWorkbenchState && recordingWorkbenchState.active)}</div>${recordingErrorMarkup()}${recordingModeSectionMarkup(choices)}${recordingTargetSectionMarkup(choices)}${recordingAudioSectionMarkup(choices)}${recordingParamsSectionMarkup(choices)}${recordingStorageSectionMarkup(choices)}${recordingRecordsSectionMarkup()}</div>`
}

// --- live-region updates -----------------------------------------------------

function updateRecordingStartButton() {
  const button = document.getElementById('recordingStartButton')
  if (!button) return
  const choices = recordingWorkbenchChoices
  const blocker = recordingStartBlocker(choices, recordingWorkbenchState)
  const disabled = recordingWorkbenchBusy || Boolean(blocker) || recordingWorkbenchError || !recordingWorkbenchState
  button.disabled = disabled
  button.textContent = recordingWorkbenchBusy
    ? t('recording.workbench.starting')
    : (choices && choices.mode === 'region' ? t('recording.workbench.start-region') : t('recording.workbench.start-display'))
}

function bindRecordingBanner() {
  document.querySelectorAll('[data-recording-focus]').forEach((button) => {
    button.onclick = () => { void focusActiveRecording() }
  })
}

function renderRecordingRecordsHost() {
  const host = document.getElementById('recordingRecordsHost')
  if (!host) return
  host.innerHTML = recordingRecordsMarkup()
  bindRecordingRecordsHost()
}

function updateRecordingLiveRegions() {
  const bannerHost = document.getElementById('recordingActiveBanner')
  if (bannerHost) {
    bannerHost.innerHTML = recordingActiveBannerMarkup(recordingWorkbenchState && recordingWorkbenchState.active)
    bindRecordingBanner()
  }
  updateRecordingStartButton()
  renderRecordingRecordsHost()
}

// --- binding -----------------------------------------------------------------

function bindRecordingRecordsHost() {
  document.querySelectorAll('[data-recording-action]').forEach((button) => {
    button.onclick = () => { void runRecordingProjectAction(button.dataset.recordingAction, button.dataset.projectId) }
  })
  document.querySelectorAll('[data-recording-load-more]').forEach((button) => {
    button.onclick = () => { void loadRecordingProjectPage({ offset: recordingWorkbenchAll.items.length }) }
  })
  document.querySelectorAll('[data-recording-retry-records]').forEach((button) => {
    button.onclick = () => { void loadRecordingProjectPage({ offset: 0 }) }
  })
}

function bindRecordingWorkbench() {
  document.querySelectorAll('[data-recording-mode]').forEach((button) => {
    button.onclick = () => selectRecordingMode(button.dataset.recordingMode)
  })
  document.querySelectorAll('[data-recording-display]').forEach((button) => {
    button.onclick = () => selectRecordingDisplay(button.dataset.recordingDisplay)
  })
  document.querySelectorAll('[data-recording-switch]').forEach((button) => {
    button.onclick = () => toggleRecordingSwitch(button.dataset.recordingSwitch)
  })
  const device = document.querySelector('[data-recording-device]')
  if (device) {
    device.onchange = () => {
      if (!recordingWorkbenchChoices) return
      recordingWorkbenchChoices.audioMicrophoneDeviceId = device.value
      renderRecordingSections()
    }
  }
  const frameRate = document.querySelector('[data-recording-frame-rate]')
  if (frameRate) {
    frameRate.onchange = () => {
      if (!recordingWorkbenchChoices) return
      recordingWorkbenchChoices.frameRate = normalizeRecordingFrameRate(frameRate.value)
    }
  }
  const quality = document.querySelector('[data-recording-quality]')
  if (quality) {
    quality.onchange = () => {
      if (!recordingWorkbenchChoices) return
      recordingWorkbenchChoices.quality = normalizeRecordingQuality(quality.value)
    }
  }
  const countdown = document.querySelector('[data-recording-countdown]')
  if (countdown) {
    countdown.onchange = () => {
      if (!recordingWorkbenchChoices) return
      recordingWorkbenchChoices.countdown = normalizeRecordingCountdown(countdown.value)
    }
  }
  const start = document.querySelector('[data-recording-start]')
  if (start) start.onclick = () => { void startRecordingFromWorkbench() }
  const retry = document.querySelector('[data-recording-retry]')
  if (retry) retry.onclick = () => retryRecordingWorkbench()
  const refreshDevices = document.querySelector('[data-recording-device-refresh]')
  if (refreshDevices) refreshDevices.onclick = () => { void refreshRecordingMicrophoneDevices() }
  const continueWithout = document.querySelector('[data-recording-continue-without]')
  if (continueWithout) {
    continueWithout.onclick = () => {
      if (!recordingWorkbenchChoices) return
      recordingWorkbenchChoices.audioMicrophone = false
      recordingWorkbenchChoices.audioMicrophoneDeviceId = ''
      renderRecordingSections()
    }
  }
  document.querySelectorAll('[data-recording-tab]').forEach((button) => {
    button.onclick = () => switchRecordingTab(button.dataset.recordingTab)
  })
  const filter = document.querySelector('[data-recording-filter]')
  if (filter) {
    filter.onchange = () => {
      recordingWorkbenchFilter = filter.value === 'region' || filter.value === 'display' ? filter.value : 'all'
      renderRecordingRecordsHost()
    }
  }
  bindRecordingBanner()
  bindRecordingRecordsHost()
}

// --- render ------------------------------------------------------------------

function renderRecordingSections() {
  if (!recordingWorkbenchChoices) recordingWorkbenchChoices = createRecordingChoices(recordingWorkbenchState)
  view.innerHTML = recordingWorkbenchMarkup(recordingWorkbenchChoices)
  bindRecordingWorkbench()
}

function renderRecording() {
  if (currentRoute !== 'recording') return
  recordingWorkbenchChoices = createRecordingChoices(recordingWorkbenchState)
  // A fresh route entry invalidates the paged all-records list: projects finished
  // while the route was closed must appear, and the first paint must not replay a
  // stale page from the previous visit.
  recordingWorkbenchAll = { items: [], total: 0, offset: 0, limit: RECORDING_RECORDS_PAGE_SIZE, loaded: false, loading: false, error: false }
  renderRecordingSections()
  void initialiseRecordingWorkbench()
  if (recordingWorkbenchTab === 'all') void loadRecordingProjectPage({ offset: 0 })
}

function retryRecordingWorkbench() {
  recordingWorkbenchError = false
  renderRecordingSections()
  void initialiseRecordingWorkbench()
}

function selectRecordingMode(mode) {
  if (!recordingWorkbenchChoices) return
  const next = mode === 'region' ? 'region' : 'display'
  if (recordingWorkbenchChoices.mode === next) return
  recordingWorkbenchChoices.mode = next
  renderRecordingSections()
}

function selectRecordingDisplay(displayId) {
  if (!recordingWorkbenchChoices || typeof displayId !== 'string' || !displayId) return
  recordingWorkbenchChoices.displayId = displayId
  recordingWorkbenchChoices.displayMissing = false
  renderRecordingSections()
}

function toggleRecordingSwitch(name) {
  if (!recordingWorkbenchChoices) return
  if (name !== 'audioSystem' && name !== 'audioMicrophone') return
  recordingWorkbenchChoices[name] = recordingWorkbenchChoices[name] !== true
  renderRecordingSections()
}

function switchRecordingTab(tab) {
  const next = tab === 'all' ? 'all' : 'recent'
  if (recordingWorkbenchTab === next) return
  recordingWorkbenchTab = next
  renderRecordingSections()
  if (next === 'all' && !recordingWorkbenchAll.loaded && !recordingWorkbenchAll.loading) void loadRecordingProjectPage({ offset: 0 })
}

// --- main-process calls ------------------------------------------------------

async function pollRecordingWorkbench() {
  if (recordingWorkbenchPolling) return
  recordingWorkbenchPolling = true
  try {
    if (!recordingChannelAvailable('workbenchState')) throw new Error('workbench-state-unavailable')
    const state = await window.electronAPI.workbenchState()
    if (!state || typeof state !== 'object') throw new Error('workbench-state-invalid')
    const firstLoad = !recordingWorkbenchState
    recordingWorkbenchState = state
    recordingWorkbenchError = false
    // The first successful read is authoritative for the remembered choices
    // (mode/display/quality/countdown/audio). Rebuilding on later polls would
    // overwrite what the user just picked in the form.
    if (firstLoad) recordingWorkbenchChoices = createRecordingChoices(state)
    else if (!recordingWorkbenchChoices) recordingWorkbenchChoices = createRecordingChoices(state)
    if (currentRoute !== 'recording') return
    if (firstLoad) renderRecordingSections()
    else updateRecordingLiveRegions()
  } catch {
    recordingWorkbenchError = true
    recordingWorkbenchState = null
    if (currentRoute === 'recording') renderRecordingSections()
  } finally {
    recordingWorkbenchPolling = false
  }
}

async function refreshRecordingMicrophoneDevices() {
  const devices = []
  let failed = false
  try {
    const media = navigator.mediaDevices
    if (!media || typeof media.enumerateDevices !== 'function') throw new Error('media-devices-unavailable')
    const listed = await media.enumerateDevices()
    const seen = new Set()
    let index = 0
    for (const device of Array.isArray(listed) ? listed : []) {
      if (!device || device.kind !== 'audioinput') continue
      const id = typeof device.deviceId === 'string' ? device.deviceId : ''
      if (!id || id === 'default' || id === 'communications' || seen.has(id)) continue
      seen.add(id)
      index += 1
      const label = typeof device.label === 'string' && device.label
        ? device.label
        : t('recording.workbench.audio-device-unnamed', { index })
      devices.push({ id, label })
    }
  } catch {
    failed = true
  }
  recordingWorkbenchDevices = devices
  recordingWorkbenchDeviceError = failed
  if (currentRoute === 'recording') renderRecordingSections()
}

async function initialiseRecordingWorkbench() {
  await pollRecordingWorkbench()
  await refreshRecordingMicrophoneDevices()
  startRecordingWorkbenchPolling()
}

async function loadRecordingProjectPage({ offset = 0 } = {}) {
  if (recordingWorkbenchAll.loading) return
  recordingWorkbenchAll.loading = true
  if (currentRoute === 'recording') renderRecordingRecordsHost()
  try {
    if (!recordingChannelAvailable('projectList')) throw new Error('project-list-unavailable')
    const result = await window.electronAPI.projectList({ offset, limit: RECORDING_RECORDS_PAGE_SIZE })
    const items = result && Array.isArray(result.items) ? result.items : []
    recordingWorkbenchAll.items = offset === 0 ? items.slice() : recordingWorkbenchAll.items.concat(items)
    recordingWorkbenchAll.total = Number(result && result.total) || recordingWorkbenchAll.items.length
    recordingWorkbenchAll.offset = Number(result && result.offset) || offset
    recordingWorkbenchAll.limit = Number(result && result.limit) || RECORDING_RECORDS_PAGE_SIZE
    recordingWorkbenchAll.loaded = true
    recordingWorkbenchAll.error = false
  } catch {
    recordingWorkbenchAll.error = true
  } finally {
    recordingWorkbenchAll.loading = false
    if (currentRoute === 'recording') renderRecordingRecordsHost()
  }
}

async function startRecordingFromWorkbench() {
  const choices = recordingWorkbenchChoices
  if (recordingWorkbenchBusy || !choices) return
  const blocker = recordingStartBlocker(choices, recordingWorkbenchState)
  if (blocker === 'active') {
    toast(t('recording.workbench.start-busy'))
    return
  }
  if (blocker === 'display-required') {
    toast(t('recording.workbench.display-missing'))
    return
  }
  if (recordingWorkbenchError || !recordingChannelAvailable('workbenchStart')) {
    toast(t('recording.workbench.load-failed-hint'))
    return
  }
  recordingWorkbenchBusy = true
  updateRecordingStartButton()
  try {
    const result = await window.electronAPI.workbenchStart(buildRecordingStartPayload(choices))
    if (result && result.ok === false) {
      toast(recordingErrorText(result.code, 'recording.workbench.start-failed'))
      return
    }
    if (result && result.focused === true) toast(t('recording.workbench.started-focused'))
    else toast(choices.mode === 'region' ? t('recording.workbench.started-region') : t('recording.workbench.started-display'))
    await pollRecordingWorkbench()
  } catch {
    // The main process reports machine-readable codes only; its own message text is
    // not translated for this window, so the renderer shows the localized copy.
    toast(t('recording.workbench.start-failed'))
  } finally {
    recordingWorkbenchBusy = false
    if (currentRoute === 'recording') updateRecordingStartButton()
  }
}

async function focusActiveRecording() {
  if (!recordingChannelAvailable('workbenchFocus')) {
    toast(t('recording.workbench.active-focus-failed'))
    return
  }
  try {
    const result = await window.electronAPI.workbenchFocus()
    if (result && result.ok === false) toast(t('recording.workbench.active-focus-failed'))
  } catch {
    toast(t('recording.workbench.active-focus-failed'))
  }
}

async function runRecordingProjectAction(action, projectId) {
  if (typeof action !== 'string' || typeof projectId !== 'string' || !projectId) return
  const project = findRecordingProject(projectId)
  if (action === 'edit' || action === 'play') {
    if (!recordingChannelAvailable('projectOpen')) {
      toast(t('recording.records.open-failed'))
      return
    }
    try {
      const result = await window.electronAPI.projectOpen(projectId)
      if (result && result.ok === false) toast(recordingErrorText(result.code, 'recording.records.open-failed'))
    } catch {
      toast(t('recording.records.open-failed'))
    }
    return
  }
  if (action === 'rename') {
    if (!recordingChannelAvailable('projectRename')) {
      toast(t('recording.records.rename-failed'))
      return
    }
    const currentName = project && typeof project.name === 'string' ? project.name : ''
    const input = typeof window.prompt === 'function' ? window.prompt(t('recording.records.rename-prompt'), currentName) : null
    if (input === null || input === undefined) return
    const name = String(input).trim()
    if (!name || name === currentName) return
    try {
      const result = await window.electronAPI.projectRename(projectId, name)
      if (result && result.ok === false) {
        toast(recordingErrorText(result.code, 'recording.records.rename-failed'))
        return
      }
      if (result && result.project) {
        replaceRecordingProject(projectId, result.project)
        renderRecordingRecordsHost()
      }
      await pollRecordingWorkbench()
      toast(t('recording.records.renamed'))
    } catch {
      toast(t('recording.records.rename-failed'))
    }
    return
  }
  if (action === 'reveal') {
    if (!recordingChannelAvailable('projectReveal')) {
      toast(t('recording.records.reveal-failed'))
      return
    }
    try {
      const result = await window.electronAPI.projectReveal(projectId)
      if (result && result.ok === false) toast(t('recording.records.reveal-failed'))
    } catch {
      toast(t('recording.records.reveal-failed'))
    }
    return
  }
  if (action === 'delete') {
    if (!recordingChannelAvailable('projectDelete')) {
      toast(t('recording.records.delete-failed'))
      return
    }
    const name = project && typeof project.name === 'string' && project.name ? project.name : ''
    const confirmed = typeof window.confirm === 'function' ? window.confirm(t('recording.records.delete-confirm', { name })) : false
    if (!confirmed) return
    try {
      const result = await window.electronAPI.projectDelete(projectId)
      if (result && result.ok === false) {
        if (result.code === 'busy') toast(t('recording.records.delete-busy'))
        else if (result.code === 'not-found') {
          removeRecordingProject(projectId)
          toast(t('recording.records.delete-not-found'))
        } else toast(t('recording.records.delete-failed'))
        return
      }
      removeRecordingProject(projectId)
      await pollRecordingWorkbench()
      toast(t('recording.records.deleted'))
    } catch {
      toast(t('recording.records.delete-failed'))
    }
  }
}

// --- polling lifecycle -------------------------------------------------------

function startRecordingWorkbenchPolling() {
  stopRecordingWorkbenchPolling()
  recordingWorkbenchPollTimer = setInterval(() => {
    if (currentRoute !== 'recording') {
      stopRecordingWorkbenchPolling()
      return
    }
    // A hidden window has no banner to keep fresh; skipping the read also keeps the
    // main process from working for a page nobody is looking at.
    if (document.hidden === true) return
    void pollRecordingWorkbench()
  }, RECORDING_BANNER_POLL_MS)
}

function stopRecordingWorkbenchPolling() {
  if (recordingWorkbenchPollTimer === null) return
  clearInterval(recordingWorkbenchPollTimer)
  recordingWorkbenchPollTimer = null
}

// Called by the shell's navigate() when the route is left: the conversation with
// the main process stops with it instead of waking a hidden window every 2s.
function recordingDeactivate() {
  stopRecordingWorkbenchPolling()
}

// D2-2 (S14): register with the shell dispatch table (config.html loads this file
// before config.js, same as every other route).
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderRecording'] = () => renderRecording()
