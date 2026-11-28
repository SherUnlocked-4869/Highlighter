// W4/R4 (recording workbench): the main window's `recording` route.
//
// Scope (docs/plans/2026-11-03-recording-r1-r3-contracts.md §8/§9.1, extended by
// docs/plans/2026-11-03-recording-r4-contracts.md §2.3): the workbench and the
// recording records list live INSIDE the ordinary settings window, so no new
// window, preload or navigation is introduced. The renderer is only allowed to
// read the frozen `record:workbench-*` / `record:project-*` channels; the main
// process owns every source path/output path/encoder detail. Project summaries are
// path-free by contract, so nothing here builds or displays a filesystem path.
//
// R4 adds the window-capture picker. A window row is a single-use opaque token
// (`record:workbench-windows`), never a desktopCapturer source id; the token is
// handed back verbatim on start and the main process re-validates/consumes it.
//
// Degradation rule: this route must never take the settings window down. While a
// main-process half is missing every call fails with a visible inline state +
// retry, and every action is guarded by a `typeof` check instead of throwing an
// unhandled rejection.
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
  region: 'recording.records.mode-region',
  window: 'recording.records.mode-window'
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
  'not-found': 'recording.records.open-not-found',
  // R4 window-capture start validation (contract §2.1).
  'window-required': 'recording.workbench.window-required',
  'window-unavailable': 'recording.workbench.window-unavailable',
  'window-too-small': 'recording.workbench.window-too-small'
})

// --- route state -------------------------------------------------------------
let recordingWorkbenchState = null
let recordingWorkbenchError = false
let recordingWorkbenchChoices = null
let recordingWorkbenchDevices = []
let recordingWorkbenchDeviceError = false
// R4 window targets. The token list is short-lived (single use, 120s TTL on the
// main process) and is only fetched on demand: entering window mode or pressing
// refresh, never on a timer.
let recordingWorkbenchWindows = []
let recordingWorkbenchWindowsLoading = false
let recordingWorkbenchWindowsError = false
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

// A window row only ever carries an opaque token, never a source id. The list is
// normalized defensively (dedupe, string token required) because it crosses IPC.
function normalizeRecordingWindows(value) {
  const list = Array.isArray(value) ? value : []
  const seen = new Set()
  const windows = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const token = typeof entry.token === 'string' ? entry.token : ''
    if (!token || seen.has(token)) continue
    seen.add(token)
    windows.push({
      token,
      title: typeof entry.title === 'string' && entry.title ? entry.title : t('recording.workbench.window-untitled'),
      appName: typeof entry.appName === 'string' ? entry.appName : '',
      width: Math.max(0, Math.round(Number(entry.width) || 0)),
      height: Math.max(0, Math.round(Number(entry.height) || 0))
    })
  }
  return windows
}

function recordingWindowSizeText(entry) {
  const width = Number(entry && entry.width) || 0
  const height = Number(entry && entry.height) || 0
  // A window whose size could not be measured shows its title only (contract §2.3).
  if (width <= 0 || height <= 0) return ''
  return `${width}\u00d7${height}`
}

function selectedRecordingWindow(choices) {
  if (!choices || typeof choices.windowToken !== 'string' || !choices.windowToken) return null
  return recordingWorkbenchWindows.find((entry) => entry.token === choices.windowToken) || null
}

function createRecordingChoices(state) {
  const config = state && typeof state.config === 'object' && state.config ? state.config : {}
  const displays = state && Array.isArray(state.displays) ? state.displays : []
  const resolved = resolveRecordingDisplay(displays, config.displayId)
  const mode = config.mode === 'region' ? 'region' : (config.mode === 'window' ? 'window' : 'display')
  return {
    mode,
    displayId: resolved.displayId,
    displayMissing: resolved.missing,
    // The window token is never remembered from settings: a token is single-use and
    // expires after 120s, so a stale one would only produce window-unavailable.
    windowToken: '',
    frameRate: normalizeRecordingFrameRate(config.frameRate),
    quality: normalizeRecordingQuality(config.quality),
    countdown: normalizeRecordingCountdown(config.countdown),
    audioSystem: config.audioSystem !== false,
    audioMicrophone: config.audioMicrophone === true,
    audioMicrophoneDeviceId: typeof config.audioMicrophoneDeviceId === 'string' ? config.audioMicrophoneDeviceId : '',
    saveDirectory: typeof config.saveDirectory === 'string' ? config.saveDirectory : '',
    // R5 (contract §5): a session-only opt-in. It is deliberately NOT read from
    // settings or the workbench state, so every route visit starts with the mouse
    // event track off and only the current recording can turn it on.
    demoEnhance: false,
    // DEV-04 section 4.1: the global shortcut-capture opt-in is a second,
    // independent session-only switch. It is never persisted and every visit
    // starts closed, exactly like demoEnhance.
    demoKeystrokes: false
  }
}

function buildRecordingStartPayload(choices) {
  const mode = choices && choices.mode === 'window'
    ? 'window'
    : (choices && choices.mode === 'region' ? 'region' : 'display')
  const displayId = mode === 'display' && choices && typeof choices.displayId === 'string' ? choices.displayId : ''
  const windowToken = mode === 'window' && choices && typeof choices.windowToken === 'string' ? choices.windowToken : ''
  const config = {
    mode,
    displayId,
    frameRate: normalizeRecordingFrameRate(choices && choices.frameRate),
    quality: normalizeRecordingQuality(choices && choices.quality),
    countdown: normalizeRecordingCountdown(choices && choices.countdown),
    audioSystem: choices ? choices.audioSystem !== false : true,
    audioMicrophone: choices ? choices.audioMicrophone === true : false,
    audioMicrophoneDeviceId: choices && typeof choices.audioMicrophoneDeviceId === 'string' ? choices.audioMicrophoneDeviceId : '',
    saveDirectory: choices && typeof choices.saveDirectory === 'string' ? choices.saveDirectory : '',
    // R5 §5: sent for every mode; the main process only starts the pointer event
    // track for display/region (window captures have no reliable content bounds).
    demoEnhance: choices ? choices.demoEnhance === true : false,
    // DEV-04 section 4.1: the global keyboard channel starts only when this
    // per-recording opt-in is true; the value is never persisted.
    demoKeystrokes: choices ? choices.demoKeystrokes === true : false
  }
  const payload = { mode, config }
  if (displayId) payload.displayId = displayId
  // Contract §2.1: the renderer hands the token back verbatim; never a source id.
  if (windowToken) payload.windowToken = windowToken
  return payload
}

// P2-01: the global shortcut-capture opt-in is a one-shot "this recording only"
// switch. A start that actually creates a recording consumes it, so the next take
// from the same page begins opted out; a failed start keeps the user's choice so
// the retry does not silently lose it. demoEnhance has a different privacy scope
// and its own tested contract, so it is never part of this decision.
function choicesAfterRecordingStart(choices, result) {
  if (!choices || typeof choices !== 'object') return choices
  if (result && result.ok === false) return choices
  return { ...choices, demoKeystrokes: false }
}

function recordingStartBlocker(choices, state) {
  if (state && state.active && typeof state.active === 'object') return 'active'
  if (!choices) return 'missing'
  if (choices.mode === 'window') return choices.windowToken ? '' : 'window-required'
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

// --- B04: per-take audio preflight -------------------------------------------
//
// Two halves, on purpose:
//   * the summary beside Start is static data (mode, the system mix, the chosen
//     microphone) plus the window-mode warning, so it never touches a device;
//   * the microphone check is a click-driven, cancellable five-second sample. It
//     proves the Windows permission and the level before a take, which is what the
//     user can actually fix in Windows. The two-lane check (system mix + mic) lives
//     on the recording bar, because main's display-media handler only serves
//     loopback audio to that window's main frame.
// No device is opened until the check button is pressed: the state machine from
// shared/audio-preflight.js refuses noteOpen() before begin(), and begin() is only
// reachable from here.

// The shared module is not part of this page's <script> list (config.html is owned
// by another stream), so it is fetched once on first use, like record.js loads
// audio-mixer.js. A missing module degrades to "cannot check" instead of throwing.
let audioPreflightModule = null
let audioPreflightModulePromise = null
let recordingPreflight = null
let recordingPreflightOpen = false
let recordingPreflightAppliedKey = ''
let recordingPreflightUnavailable = false
let recordingPreflightMicStream = null
let recordingPreflightContext = null
let recordingPreflightAnalyser = null
let recordingPreflightSamples = null
let recordingPreflightTimer = 0
// B04 (plan item 13): every check is a RUN. The ledger releases the previous run's devices
// when a re-check starts, and stops a device that arrives after the deadline instead of
// holding it. The token makes a stale permission callback clean up only its own run.
let recordingPreflightResources = null
let recordingPreflightRun = 0

const RECORDING_PREFLIGHT_PROMPT_KEYS = Object.freeze({
  'microphone-denied': 'recording.preflight.prompt-microphone-denied',
  'microphone-missing': 'recording.preflight.prompt-microphone-missing',
  'microphone-busy': 'recording.preflight.prompt-microphone-busy',
  'microphone-lost': 'recording.preflight.prompt-microphone-lost',
  'microphone-silent': 'recording.preflight.prompt-microphone-silent',
  'microphone-failed': 'recording.preflight.prompt-microphone-failed'
})
const RECORDING_PREFLIGHT_ACTION_KEYS = Object.freeze({
  'open-microphone-settings': 'recording.preflight.action-open-settings',
  'record-system-only': 'recording.preflight.action-system-only',
  'record-silent': 'recording.preflight.action-silent'
})
const RECORDING_PREFLIGHT_LEVEL_KEYS = Object.freeze({
  good: 'recording.preflight.level-good',
  low: 'recording.preflight.level-low',
  silent: 'recording.preflight.level-silent'
})
// The exact deep link Windows' microphone privacy page is addressed by. Shown as
// text because the shell channel this window has validates HTTP(S) only; the
// button tries anyway and falls back to the documented path.
const WINDOWS_MICROPHONE_SETTINGS_URI = 'ms-settings:privacy-microphone'

function loadAudioPreflight() {
  if (audioPreflightModule) return Promise.resolve(audioPreflightModule)
  if (audioPreflightModulePromise) return audioPreflightModulePromise
  audioPreflightModulePromise = new Promise((resolve) => {
    if (window.audioPreflight) {
      resolve(window.audioPreflight)
      return
    }
    if (typeof document.createElement !== 'function' || !document.head) {
      resolve(null)
      return
    }
    const script = document.createElement('script')
    script.src = '../shared/audio-preflight.js'
    script.onload = () => resolve(window.audioPreflight || null)
    script.onerror = () => resolve(null)
    document.head.appendChild(script)
  }).then((api) => {
    audioPreflightModule = api
    return api
  })
  return audioPreflightModulePromise
}

function recordingPreflightStatus() {
  return recordingPreflight ? recordingPreflight.status() : null
}

function recordingPreflightConstraints(choices) {
  // Mirrors record/audio-mixer.js#microphoneConstraints so the check asks for the
  // same input the take will ask for; an explicit device is 'exact' on purpose.
  const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
  const deviceId = choices && typeof choices.audioMicrophoneDeviceId === 'string' ? choices.audioMicrophoneDeviceId.trim() : ''
  if (deviceId) constraints.deviceId = { exact: deviceId }
  return constraints
}

function recordingPreflightLevelPercent(status) {
  const entry = status && status.lanes ? status.lanes.microphone : null
  if (!entry || !audioPreflightModule) return 0
  return audioPreflightModule.levelPercent(entry.peak)
}

function recordingPreflightPromptKey(status) {
  if (!status || !status.promptCode) return ''
  return RECORDING_PREFLIGHT_PROMPT_KEYS[status.promptCode] || ''
}

function recordingPreflightActions(status) {
  // A chosen action is applied to this take's start parameters: the prompt is
  // resolved, so its buttons go away instead of inviting the same click again.
  if (recordingPreflightAppliedKey) return []
  if (!status || !Array.isArray(status.actions)) return []
  return status.actions.filter((action) => Object.hasOwn(RECORDING_PREFLIGHT_ACTION_KEYS, action))
}

function recordingPreflightStatusText(status) {
  if (recordingPreflightUnavailable) return t('recording.preflight.unavailable')
  if (recordingPreflightAppliedKey) return t(recordingPreflightAppliedKey)
  const promptKey = recordingPreflightPromptKey(status)
  if (promptKey) return t(promptKey)
  if (status && status.active) return t('recording.preflight.checking')
  const entry = status && status.lanes ? status.lanes.microphone : null
  if (entry && entry.sampled > 0) return t(RECORDING_PREFLIGHT_LEVEL_KEYS[entry.level] || 'recording.preflight.level-waiting')
  return ''
}

function recordingPreflightMarkup() {
  if (!recordingPreflightOpen && !recordingPreflightUnavailable) return ''
  const status = recordingPreflightStatus()
  const actions = recordingPreflightActions(status)
  const actionButtons = actions.map((action) => `<button type="button" class="button" data-recording-preflight-action="${escapeHtml(action)}" data-testid="preflight-action-${escapeHtml(action)}">${t(RECORDING_PREFLIGHT_ACTION_KEYS[action])}</button>`).join('')
  const statusText = recordingPreflightStatusText(status)
  const percent = recordingPreflightLevelPercent(status)
  const level = status && status.lanes && status.lanes.microphone ? status.lanes.microphone.level : 'silent'
  const levelText = status && status.active
    ? t('recording.preflight.checking')
    : t(RECORDING_PREFLIGHT_LEVEL_KEYS[level] || 'recording.preflight.level-waiting')
  const settingsHint = actions.includes('open-microphone-settings')
    ? `<p class="rec-note" data-testid="preflight-settings-hint">${t('recording.preflight.settings-hint')}</p>`
    : ''
  return `<section class="section" id="recordingPreflightSection"><div class="card rec-target-card" data-testid="preflight-panel">
    <div class="rec-records-toolbar"><b>${t('recording.preflight.check-microphone')}</b><span class="rec-badge" id="recordingPreflightLevelText" data-testid="preflight-level-text">${escapeHtml(levelText)}</span></div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
      <span aria-hidden="true" style="flex:1 1 auto;height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden"><i id="recordingPreflightBar" data-testid="preflight-level-bar" data-level="${escapeHtml(level)}" style="display:block;width:${percent}%;height:100%;background:var(--primary)"></i></span>
      <button type="button" class="button" data-recording-preflight-retry data-testid="preflight-retry">${status && status.active ? t('recording.preflight.stop') : t('recording.preflight.retry')}</button>
    </div>
    ${statusText ? `<p class="rec-note" data-testid="preflight-status">${escapeHtml(statusText)}</p>` : ''}
    ${actionButtons ? `<div class="rec-warning-actions" data-testid="preflight-actions">${actionButtons}</div>` : ''}
    ${settingsHint}
  </div></section>`
}

// An unplugged device ends its track while the sample runs: report "lost" with its
// actions instead of silently measuring zeros.
function watchRecordingPreflightTrack(stream) {
  const track = stream?.getAudioTracks?.()[0]
  if (!track || typeof track.addEventListener !== 'function') return
  track.addEventListener('ended', () => {
    if (!recordingPreflight || !recordingPreflight.isActive()) return
    recordingPreflight.failLane('microphone', { name: 'DeviceLost' })
    if (currentRoute === 'recording') renderRecordingSections()
  })
}

function releaseRecordingPreflight() {
  // B04 (13): one owner per device. When the ledger exists it stops every adopted stream
  // (including one a stale run registered late), so the local refs are only cleared here.
  if (!recordingPreflightResources) {
    for (const track of recordingPreflightMicStream?.getTracks?.() || []) {
      try { track.stop() } catch {}
    }
    const context = recordingPreflightContext
    if (context && typeof context.close === 'function') {
      try {
        const closing = context.close()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch {}
    }
  } else {
    recordingPreflightResources.release()
  }
  recordingPreflightMicStream = null
  recordingPreflightAnalyser = null
  recordingPreflightSamples = null
  recordingPreflightContext = null
}

function stopRecordingPreflight(outcome = 'done') {
  // Ending the run invalidates any authorization callback still in flight.
  recordingPreflightRun += 1
  const wasActive = Boolean(recordingPreflight && recordingPreflight.isActive())
  if (recordingPreflightTimer) {
    clearTimeout(recordingPreflightTimer)
    recordingPreflightTimer = 0
  }
  if (wasActive) recordingPreflight.finish(outcome)
  releaseRecordingPreflight()
  if (wasActive) recordingPreflight.markReleased(Date.now())
  if (currentRoute === 'recording') renderRecordingSections()
}

// Route exit / a fresh visit: no stream and no timer may outlive the page.
function cancelRecordingPreflight() {
  recordingPreflightOpen = false
  recordingPreflightAppliedKey = ''
  recordingPreflightRun += 1
  if (recordingPreflightTimer) {
    clearTimeout(recordingPreflightTimer)
    recordingPreflightTimer = 0
  }
  if (recordingPreflight && recordingPreflight.isActive()) recordingPreflight.finish('cancelled')
  releaseRecordingPreflight()
  if (recordingPreflight && recordingPreflight.status().endedAt) recordingPreflight.markReleased(Date.now())
}

function recordingPreflightTick() {
  recordingPreflightTimer = 0
  if (!recordingPreflight || !recordingPreflight.isActive()) return
  // The route-leave hook is shared with the polling lifecycle, so the sample owns
  // its own exit: leaving the page ends the run and releases the device on the next
  // tick (well inside the one-second release budget).
  if (currentRoute !== 'recording') {
    stopRecordingPreflight('cancelled')
    return
  }
  if (recordingPreflight.expired()) {
    stopRecordingPreflight('done')
    return
  }
  if (recordingPreflightAnalyser && recordingPreflightSamples) {
    try {
      recordingPreflightAnalyser.getFloatTimeDomainData(recordingPreflightSamples)
      recordingPreflight.sample('microphone', audioPreflightModule.peakOfFloat(recordingPreflightSamples))
    } catch {
      // A closed context ends the samples, not the run: the five-second budget and a
      // failed device still report through the state machine.
    }
  }
  const status = recordingPreflightStatus()
  const bar = document.getElementById('recordingPreflightBar')
  if (bar && bar.style) {
    bar.style.width = `${recordingPreflightLevelPercent(status)}%`
    const entry = status && status.lanes ? status.lanes.microphone : null
    if (bar.setAttribute && entry) bar.setAttribute('data-level', entry.level)
  }
  const text = document.getElementById('recordingPreflightLevelText')
  if (text) {
    const entry = status && status.lanes ? status.lanes.microphone : null
    text.textContent = entry && entry.sampled > 0
      ? t(RECORDING_PREFLIGHT_LEVEL_KEYS[entry.level] || 'recording.preflight.level-waiting')
      : t('recording.preflight.level-waiting')
  }
  recordingPreflightTimer = setTimeout(recordingPreflightTick, Math.max(50, Math.min(150, recordingPreflight.remaining())))
}

async function runRecordingMicrophonePreflight() {
  const choices = recordingWorkbenchChoices
  if (!choices) return
  if (recordingPreflight && recordingPreflight.isActive()) {
    stopRecordingPreflight('cancelled')
    return
  }
  // The workbench checks the microphone lane only; with the lane off there is
  // nothing to measure and nothing may be opened.
  if (choices.audioMicrophone !== true) {
    recordingPreflightOpen = false
    recordingPreflight = null
    if (currentRoute === 'recording') renderRecordingSections()
    return
  }
  const api = await loadAudioPreflight()
  if (!api) {
    recordingPreflightUnavailable = true
    recordingPreflightOpen = true
    if (currentRoute === 'recording') renderRecordingSections()
    return
  }
  recordingPreflightUnavailable = false
  recordingPreflight = api.createPreflight({ capabilities: { openSettings: true } })
  recordingPreflightAppliedKey = ''
  recordingPreflightOpen = true
  // Both sources off is not an error: there is nothing to check this take.
  if (!recordingPreflight.begin({ microphone: choices.audioMicrophone === true })) {
    if (currentRoute === 'recording') renderRecordingSections()
    return
  }
  // B04 (13): one run, one five-second deadline that starts at the click. The tick is armed
  // BEFORE the permission prompt, so an unanswered prompt still ends the check in budget.
  if (typeof api.createPreflightResources === 'function') {
    if (!recordingPreflightResources) recordingPreflightResources = api.createPreflightResources()
  }
  const runToken = recordingPreflightResources ? recordingPreflightResources.begin() : 0
  recordingPreflightRun += 1
  const runGeneration = recordingPreflightRun
  const stillCurrent = () => runGeneration === recordingPreflightRun &&
    (!recordingPreflightResources || recordingPreflightResources.isCurrent(runToken))
  recordingPreflightTimer = setTimeout(recordingPreflightTick, 0)
  let stream = null
  try {
    const media = navigator.mediaDevices
    if (!media || typeof media.getUserMedia !== 'function') {
      throw Object.assign(new Error('media devices unavailable'), { name: 'NotReadableError' })
    }
    // The only device-open of this flow, and noteOpen() refuses before begin().
    if (recordingPreflight.noteOpen('microphone')) {
      stream = await media.getUserMedia({ audio: recordingPreflightConstraints(choices), video: false })
    }
  } catch (error) {
    recordingPreflight.failLane('microphone', error)
  }
  // A stream granted after the deadline (or after a cancel/re-check) is stopped at once:
  // a check nobody is watching must not keep the device. adoptStream() refuses a stream
  // that belongs to an outdated run (and stops it), so this check also covers the run
  // that ended while the permission prompt was open.
  if (stream) {
    const adopted = recordingPreflightResources ? recordingPreflightResources.adoptStream(runToken, stream) : true
    const usable = stillCurrent() && Boolean(recordingPreflight) && recordingPreflight.isActive()
    if (!adopted || !usable) {
      for (const track of stream.getTracks?.() || []) {
        try { track.stop() } catch {}
      }
      stream = null
    }
  }
  // Cancelled (or the route left) while the permission prompt was open: release
  // whatever arrived and never start a meter for a run nobody is watching.
  if (!stillCurrent() || !recordingPreflight || !recordingPreflight.isActive() || currentRoute !== 'recording') {
    if (stream && !recordingPreflightResources) recordingPreflightMicStream = stream
    releaseRecordingPreflight()
    if (currentRoute === 'recording') renderRecordingSections()
    return
  }
  if (!stream) {
    stopRecordingPreflight('done')
    return
  }
  recordingPreflightMicStream = stream
  watchRecordingPreflightTrack(stream)
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (typeof AudioContextClass === 'function') {
      const context = new AudioContextClass()
      if (recordingPreflightResources) recordingPreflightResources.adoptContext(runToken, context)
      recordingPreflightContext = context
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0
      context.createMediaStreamSource(stream).connect(analyser)
      recordingPreflightAnalyser = analyser
      recordingPreflightSamples = new Float32Array(1024)
    }
  } catch {
    recordingPreflightAnalyser = null
    recordingPreflightSamples = null
  }
  if (!recordingPreflightAnalyser) {
    // No WebAudio: the device still proved its permission, so release it now.
    stopRecordingPreflight('done')
    return
  }
  recordingPreflight.startSampling()
  renderRecordingSections()
  // The tick was armed at the start of the run; sampling now reads the analyser it set up.
}

async function openWindowsMicrophoneSettings() {
  let opened = false
  try {
    const api = window.electronAPI
    if (api && typeof api.openExternal === 'function') {
      await api.openExternal(WINDOWS_MICROPHONE_SETTINGS_URI)
      opened = true
    }
  } catch {
    opened = false
  }
  // The shell channel behind openExternal accepts HTTP(S) only, so the deep link can
  // be refused; the manual path is printed next to the button in both cases.
  if (!opened) toast(t('recording.preflight.settings-failed'))
}

function applyRecordingPreflightAction(action) {
  if (typeof action !== 'string' || !action) return
  if (action === 'open-microphone-settings') {
    void openWindowsMicrophoneSettings()
    return
  }
  const choices = recordingWorkbenchChoices
  if (!choices) return
  if (action === 'record-system-only') {
    choices.audioMicrophone = false
    choices.audioMicrophoneDeviceId = ''
    recordingPreflightAppliedKey = 'recording.preflight.applied-system-only'
  } else if (action === 'record-silent') {
    choices.audioSystem = false
    choices.audioMicrophone = false
    choices.audioMicrophoneDeviceId = ''
    recordingPreflightAppliedKey = 'recording.preflight.applied-silent'
  } else return
  recordingPreflightOpen = true
  stopRecordingPreflight('cancelled')
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

// The per-take summary beside Start: what will be captured, from where, and with
// which lanes. Static data only - reading it never opens a device.
function recordingSummarySourceText(choices) {
  const modeLabel = recordingModeLabel(choices.mode)
  if (choices.mode === 'window') {
    const entry = selectedRecordingWindow(choices)
    if (!entry) return modeLabel
    return [modeLabel, entry.title, recordingWindowSizeText(entry)].filter(Boolean).join(' \u00b7 ')
  }
  const displays = recordingWorkbenchState && Array.isArray(recordingWorkbenchState.displays) ? recordingWorkbenchState.displays : []
  const display = displays.find((entry) => entry && entry.id === choices.displayId) || null
  if (!display) return modeLabel
  const name = typeof display.name === 'string' && display.name ? display.name : display.id
  const resolution = recordingDisplayResolution(display)
  return [modeLabel, name, resolution].filter(Boolean).join(' \u00b7 ')
}

function recordingSummaryMicrophoneText(choices) {
  if (choices.audioMicrophone !== true) return t('recording.preflight.microphone-off')
  const selected = typeof choices.audioMicrophoneDeviceId === 'string' ? choices.audioMicrophoneDeviceId : ''
  if (!selected) return t('recording.preflight.microphone-default')
  const device = recordingMicrophoneDevices().find((entry) => entry && entry.id === selected)
  return device ? device.label : t('recording.workbench.audio-device-missing-short')
}

function recordingSummaryMarkup(choices) {
  const row = (labelKey, value, testId) => `<span data-testid="${testId}"><b>${t(labelKey)}</b> ${escapeHtml(value)}</span>`
  const systemOn = choices.audioSystem === true
  const systemText = systemOn ? t('recording.preflight.system-on') : t('recording.preflight.system-off')
  // Window mode says the mix also contains other apps; display/region say it is the
  // Windows system mix. Neither line may ever read "this window only".
  const systemNote = systemOn
    ? (choices.mode === 'window'
        ? `<em data-testid="preflight-window-note" style="color:var(--yellow)">${t('recording.preflight.system-window-note')}</em>`
        : `<em data-testid="preflight-system-note">${t('recording.preflight.system-mix-note')}</em>`)
    : ''
  return `<div data-testid="recording-audio-summary" style="display:grid;gap:3px;margin-bottom:8px;font-size:12px;color:var(--muted);text-align:right">
    ${row('recording.preflight.source', recordingSummarySourceText(choices), 'preflight-source')}
    <span data-testid="preflight-system"><b>${t('recording.preflight.system')}</b> ${escapeHtml(systemText)}${systemNote ? ` ${systemNote}` : ''}</span>
    ${row('recording.preflight.microphone', recordingSummaryMicrophoneText(choices), 'preflight-microphone')}
    <span style="font-size:11px" data-testid="preflight-bar-hint">${t('recording.preflight.bar-hint')}</span>
  </div>`
}

function recordingStartBlockMarkup(choices) {
  // The check entry sits next to Start, exactly where the summary says which lanes
  // the take will have. It is disabled (with the reason in its title) while the
  // microphone is off, because there is no lane to measure.
  const micOn = choices.audioMicrophone === true
  const title = micOn ? t('recording.preflight.check-microphone') : t('recording.preflight.microphone-off-hint')
  const check = `<button type="button" class="button" data-recording-preflight data-testid="preflight-check" title="${escapeHtml(title)}"${micOn ? '' : ' disabled'}>${t('recording.preflight.check-microphone')}</button>`
  return `<div data-testid="recording-start-block">${recordingSummaryMarkup(choices)}<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${check}${recordingStartButtonMarkup(choices)}</div></div>`
}

function recordingStartButtonMarkup(choices) {
  const blocker = recordingStartBlocker(choices, recordingWorkbenchState)
  const disabled = recordingWorkbenchBusy || Boolean(blocker) || recordingWorkbenchError || !recordingWorkbenchState
  const label = recordingWorkbenchBusy
    ? t('recording.workbench.starting')
    : (choices && choices.mode === 'region'
        ? t('recording.workbench.start-region')
        : (choices && choices.mode === 'window' ? t('recording.workbench.start-window') : t('recording.workbench.start-display')))
  let title = ''
  if (blocker === 'active') title = t('recording.workbench.start-busy')
  else if (blocker === 'display-required') title = t('recording.workbench.display-missing')
  else if (blocker === 'window-required') title = t('recording.workbench.window-required')
  return `<button type="button" class="button primary rec-start" id="recordingStartButton" data-recording-start data-testid="start-recording" title="${escapeHtml(title)}" ${disabled ? 'disabled' : ''}>${label}</button>`
}

function recordingModeSectionMarkup(choices) {
  const card = (mode, icon, titleKey, hintKey, testId) => {
    const active = choices.mode === mode
    return `<button type="button" class="rec-mode-card${active ? ' active' : ''}" data-recording-mode="${mode}" data-testid="${testId}" aria-pressed="${active ? 'true' : 'false'}"><span class="rec-mode-icon">${iconMarkup(icon)}</span><span class="rec-mode-body"><b>${t(titleKey)}</b><small>${t(hintKey)}</small></span></button>`
  }
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.modes-section')}</h2><div class="rec-mode-options">${card('region', '../capture/icons/select.svg', 'recording.workbench.mode-region', 'recording.workbench.mode-region-hint', 'mode-region')}${card('display', 'icons/fullscreen.svg', 'recording.workbench.mode-display', 'recording.workbench.mode-display-hint', 'mode-display')}${card('window', 'icons/layout.svg', 'recording.workbench.mode-window', 'recording.workbench.mode-window-hint', 'mode-window')}</div></section>`
}

function recordingTargetSectionMarkup(choices) {
  const displays = recordingWorkbenchState && Array.isArray(recordingWorkbenchState.displays) ? recordingWorkbenchState.displays : []
  const title = `<h2 class="section-title">${t('recording.workbench.target-section')}</h2>`
  if (choices.mode === 'window') {
    return `<section class="section">${title}<div class="card rec-target-card">${recordingWindowTargetMarkup(choices)}</div></section>`
  }
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
  return `<section class="section">${title}<div class="card rec-target-card"><p class="rec-note">${intro}</p>${empty}${options}${missing}</div></section>`
}

// R4 window picker (contract §2.3): manual refresh only, explicit selection, and a
// degraded state for each failure mode. Rows carry the opaque token, never a
// desktopCapturer source id.
function recordingWindowTargetMarkup(choices) {
  const toolbar = `<div class="rec-records-toolbar"><small class="rec-note">${t('recording.workbench.window-refresh-hint')}</small><button type="button" class="button" data-recording-window-refresh data-testid="window-refresh">${t('recording.workbench.window-refresh')}</button></div>`
  let body = ''
  if (recordingWorkbenchWindowsLoading) {
    body = `<div class="rec-records-state" data-testid="window-loading">${t('recording.workbench.window-loading')}</div>`
  } else if (recordingWorkbenchWindowsError) {
    body = `<div class="rec-error" data-testid="window-error"><div class="rec-error-body"><b>${t('recording.workbench.window-error')}</b><small>${t('recording.workbench.window-refresh-hint')}</small></div><button type="button" class="button" data-recording-window-retry data-testid="window-retry">${t('recording.workbench.retry')}</button></div>`
  } else if (!recordingWorkbenchWindows.length) {
    body = `<div class="empty" data-testid="window-empty">${t('recording.workbench.window-empty')}</div>`
  } else {
    body = `<div class="rec-display-list">${recordingWorkbenchWindows.map((entry) => recordingWindowOptionMarkup(entry, choices)).join('')}</div>`
  }
  return `<p class="rec-note">${t('recording.workbench.target-window-note')}</p>${toolbar}${body}`
}

function recordingWindowOptionMarkup(entry, choices) {
  const token = entry && typeof entry.token === 'string' ? entry.token : ''
  if (!token) return ''
  const selected = choices.windowToken === token
  const size = recordingWindowSizeText(entry)
  const appName = entry.appName && entry.appName !== entry.title ? entry.appName : ''
  const meta = [size, appName].filter(Boolean).join(' \u00b7 ')
  const metaMarkup = meta ? `<small class="rec-display-meta">${escapeHtml(meta)}</small>` : ''
  const badge = selected ? `<span class="rec-badge accent">${t('recording.workbench.display-selected')}</span>` : ''
  return `<button type="button" class="rec-display${selected ? ' active' : ''}" data-recording-window="${escapeHtml(token)}" data-window-token="${escapeHtml(token)}" data-testid="window-option" aria-pressed="${selected ? 'true' : 'false'}" title="${escapeHtml(entry.title)}"><span class="rec-display-name">${escapeHtml(entry.title)}</span>${badge}${metaMarkup}</button>`
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
  // R5 (contract §5): per-recording "presenter enhancements" opt-in. The copy is
  // deliberately explicit about scope (mouse events only, no keyboard content) and
  // about it applying to this recording only — the value is never persisted.
  const demoEnhance = `<div class="card form-card" style="margin-top:14px"><div class="form-row"><div class="form-label"><b>${t('recording.workbench.demo-enhance')}</b><small>${t('recording.workbench.demo-enhance-hint')}</small></div>${recordingSwitchMarkup(choices.demoEnhance, 'demoEnhance', 'demo-enhance', t('recording.workbench.demo-enhance'))}</div></div>`
  // DEV-04 section 2: a separate opt-in for the global shortcut channel. It is
  // deliberately independent from demoEnhance: mouse events and keyboard chords
  // have different privacy scopes, so a user may want one without the other.
  const demoKeystrokes = `<div class="card form-card" style="margin-top:14px"><div class="form-row"><div class="form-label"><b>${t('recording.workbench.demo-keystrokes')}</b><small>${t('recording.workbench.demo-keystrokes-hint')}</small></div>${recordingSwitchMarkup(choices.demoKeystrokes, 'demoKeystrokes', 'demo-keystrokes', t('recording.workbench.demo-keystrokes'))}</div></div>`
  return `<section class="section"><h2 class="section-title">${t('recording.workbench.params-section')}</h2><div class="card form-card rec-params">
    <label class="rec-field"><b>${t('recording.workbench.frame-rate')}</b><select data-recording-frame-rate data-testid="frame-rate-select">${RECORDING_FRAME_RATES.map(frameRateOption).join('')}<optgroup label="${t('recording.workbench.frame-rate-advanced')}">${RECORDING_LEGACY_FRAME_RATES.map(frameRateOption).join('')}</optgroup></select><small>${t('recording.workbench.frame-rate-hint')}</small></label>
    <label class="rec-field"><b>${t('recording.workbench.quality')}</b><select data-recording-quality data-testid="quality-select">${qualityOptions}</select></label>
    <label class="rec-field"><b>${t('recording.workbench.countdown')}</b><select data-recording-countdown data-testid="countdown-select">${countdownOptions}</select><small>${t('recording.workbench.countdown-hint')}</small></label>
  </div>${demoEnhance}${demoKeystrokes}</section>`
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
  const filters = [
    ['all', 'recording.records.filter-all', 'records-filter-all'],
    ['display', 'recording.records.filter-display', 'records-filter-display'],
    ['region', 'recording.records.filter-region', 'records-filter-region'],
    ['window', 'recording.records.filter-window', 'records-filter-window']
  ].map(([value, key, testId]) => `<option value="${value}" data-testid="${testId}"${recordingWorkbenchFilter === value ? ' selected' : ''}>${t(key)}</option>`).join('')
  return `<section class="section" id="recordingRecordsSection"><h2 class="section-title">${t('recording.workbench.records-section')}<small>${t('recording.workbench.hint')}</small></h2><div class="rec-records-toolbar"><div class="tabs">${tab('recent', 'records-tab-recent', t('recording.records.tab-recent'))}${tab('all', 'records-tab-all', t('recording.records.tab-all'))}</div><label class="rec-filter"><span>${t('recording.records.filter-label')}</span><select data-recording-filter data-testid="records-filter">${filters}</select></label></div><div id="recordingRecordsHost">${recordingRecordsMarkup()}</div></section>`
}

function recordingWorkbenchMarkup(choices) {
  return `<div class="page recording-workbench" data-testid="recording-workbench" data-workbench-mode="${escapeHtml(choices.mode)}">${pageHeader(t('recording.workbench.title'), t('recording.workbench.description'), recordingStartBlockMarkup(choices))}<div id="recordingActiveBanner">${recordingActiveBannerMarkup(recordingWorkbenchState && recordingWorkbenchState.active)}</div>${recordingErrorMarkup()}${recordingPreflightMarkup()}${recordingModeSectionMarkup(choices)}${recordingTargetSectionMarkup(choices)}${recordingAudioSectionMarkup(choices)}${recordingParamsSectionMarkup(choices)}${recordingStorageSectionMarkup(choices)}${recordingRecordsSectionMarkup()}</div>`
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
    : (choices && choices.mode === 'region'
        ? t('recording.workbench.start-region')
        : (choices && choices.mode === 'window' ? t('recording.workbench.start-window') : t('recording.workbench.start-display')))
}

// Repaint one switch from the current choices without rebuilding the page (a full
// render would lose the scroll position right after a start). recordingSwitchMarkup
// only ever emits "switch" or "switch on", so writing the class attribute mirrors a
// fresh render exactly.
function syncRecordingSwitch(name) {
  const on = Boolean(recordingWorkbenchChoices && recordingWorkbenchChoices[name] === true)
  document.querySelectorAll(`[data-recording-switch="${name}"]`).forEach((button) => {
    button.setAttribute('aria-checked', on ? 'true' : 'false')
    button.setAttribute('class', on ? 'switch on' : 'switch')
  })
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
  document.querySelectorAll('[data-recording-window]').forEach((button) => {
    button.onclick = () => selectRecordingWindow(button.dataset.recordingWindow)
  })
  const windowRefresh = document.querySelector('[data-recording-window-refresh]')
  if (windowRefresh) windowRefresh.onclick = () => { void refreshRecordingWindows() }
  const windowRetry = document.querySelector('[data-recording-window-retry]')
  if (windowRetry) windowRetry.onclick = () => { void refreshRecordingWindows() }
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
  const preflightCheck = document.querySelector('[data-recording-preflight]')
  if (preflightCheck) preflightCheck.onclick = () => { void runRecordingMicrophonePreflight() }
  const preflightRetry = document.querySelector('[data-recording-preflight-retry]')
  if (preflightRetry) preflightRetry.onclick = () => { void runRecordingMicrophonePreflight() }
  document.querySelectorAll('[data-recording-preflight-action]').forEach((button) => {
    button.onclick = () => applyRecordingPreflightAction(button.dataset.recordingPreflightAction)
  })
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
      const value = filter.value
      recordingWorkbenchFilter = value === 'region' || value === 'display' || value === 'window' ? value : 'all'
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
  // A fresh visit starts with no check panel and no device held from the last one.
  cancelRecordingPreflight()
  recordingPreflight = null
  recordingPreflightUnavailable = false
  recordingWorkbenchChoices = createRecordingChoices(recordingWorkbenchState)
  // A fresh route entry invalidates the paged all-records list: projects finished
  // while the route was closed must appear, and the first paint must not replay a
  // stale page from the previous visit.
  recordingWorkbenchAll = { items: [], total: 0, offset: 0, limit: RECORDING_RECORDS_PAGE_SIZE, loaded: false, loading: false, error: false }
  renderRecordingSections()
  void initialiseRecordingWorkbench()
  if (recordingWorkbenchTab === 'all') void loadRecordingProjectPage({ offset: 0 })
  // Window tokens expire after 120s: entering the workbench in window mode always
  // fetches a fresh list instead of reusing tokens from the previous visit.
  if (recordingWorkbenchChoices.mode === 'window') void refreshRecordingWindows()
}

function retryRecordingWorkbench() {
  recordingWorkbenchError = false
  renderRecordingSections()
  void initialiseRecordingWorkbench()
}

function selectRecordingMode(mode) {
  if (!recordingWorkbenchChoices) return
  const next = mode === 'region' ? 'region' : (mode === 'window' ? 'window' : 'display')
  if (recordingWorkbenchChoices.mode === next) return
  recordingWorkbenchChoices.mode = next
  // The target pickers are mutually exclusive (contract §2.3): leaving a mode drops
  // its selection so a hidden display id or a stale/single-use window token can never
  // leak into the next start payload.
  if (next !== 'display') {
    recordingWorkbenchChoices.displayId = ''
    recordingWorkbenchChoices.displayMissing = false
  }
  if (next !== 'window') recordingWorkbenchChoices.windowToken = ''
  renderRecordingSections()
  // Entering window mode fetches the list once; there is no background refresh timer.
  if (next === 'window') void refreshRecordingWindows()
}

function selectRecordingWindow(token) {
  if (!recordingWorkbenchChoices || typeof token !== 'string' || !token) return
  if (!recordingWorkbenchWindows.some((entry) => entry.token === token)) return
  recordingWorkbenchChoices.windowToken = token
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
  if (name !== 'audioSystem' && name !== 'audioMicrophone' && name !== 'demoEnhance' && name !== 'demoKeystrokes') return
  recordingWorkbenchChoices[name] = recordingWorkbenchChoices[name] !== true
  if (name === 'audioSystem' || name === 'audioMicrophone') {
    // The summary is what the check was about: drop the stale result and stop a
    // running sample instead of leaving a lane open for a request that changed.
    recordingPreflightAppliedKey = ''
    if (recordingPreflight && recordingPreflight.isActive()) stopRecordingPreflight('cancelled')
  }
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
    if (firstLoad) {
      renderRecordingSections()
      // A persisted window mode only becomes known after this first read; the list
      // itself is still fetched on demand (never on the poll timer).
      if (recordingWorkbenchChoices.mode === 'window' && !recordingWorkbenchWindowsLoading) void refreshRecordingWindows()
    } else updateRecordingLiveRegions()
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

async function refreshRecordingWindows() {
  if (recordingWorkbenchWindowsLoading) return
  recordingWorkbenchWindowsLoading = true
  recordingWorkbenchWindowsError = false
  if (currentRoute === 'recording') renderRecordingSections()
  try {
    if (!recordingChannelAvailable('workbenchWindows')) throw new Error('workbench-windows-unavailable')
    const result = await window.electronAPI.workbenchWindows()
    if (!result || result.ok === false) throw new Error('workbench-windows-failed')
    recordingWorkbenchWindows = normalizeRecordingWindows(result.windows)
    // Tokens are single-use and expire: a refresh that no longer lists the selected
    // window must drop the selection instead of starting a dead target.
    if (recordingWorkbenchChoices && recordingWorkbenchChoices.windowToken && !selectedRecordingWindow(recordingWorkbenchChoices)) {
      recordingWorkbenchChoices.windowToken = ''
    }
  } catch {
    recordingWorkbenchWindowsError = true
    recordingWorkbenchWindows = []
    if (recordingWorkbenchChoices) recordingWorkbenchChoices.windowToken = ''
  } finally {
    recordingWorkbenchWindowsLoading = false
    if (currentRoute === 'recording') renderRecordingSections()
  }
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
  if (blocker === 'window-required') {
    toast(t('recording.workbench.window-required'))
    return
  }
  if (recordingWorkbenchError || !recordingChannelAvailable('workbenchStart')) {
    toast(t('recording.workbench.load-failed-hint'))
    return
  }
  // The recording window needs the microphone: never hold it from the workbench.
  cancelRecordingPreflight()
  recordingWorkbenchBusy = true
  updateRecordingStartButton()
  try {
    const result = await window.electronAPI.workbenchStart(buildRecordingStartPayload(choices))
    if (result && result.ok === false) {
      const code = typeof result.code === 'string' ? result.code : ''
      toast(recordingErrorText(code, 'recording.workbench.start-failed'))
      // A rejected window token is consumed/expired on the main process; refetch the
      // list so the user can pick a target again instead of retrying a dead token.
      if (code === 'window-required' || code === 'window-unavailable' || code === 'window-too-small') {
        void refreshRecordingWindows()
      }
      return
    }
    if (result && result.focused === true) toast(t('recording.workbench.started-focused'))
    else if (choices.mode === 'window') toast(t('recording.workbench.started-window'))
    else toast(choices.mode === 'region' ? t('recording.workbench.started-region') : t('recording.workbench.started-display'))
    // P2-01: this take really exists, so the one-shot shortcut opt-in it was
    // started with is consumed for the next one. The payload above was already
    // built from `choices`, and the helper returns a new object, so the take in
    // flight is untouched; only the live switch is repainted here.
    recordingWorkbenchChoices = choicesAfterRecordingStart(recordingWorkbenchChoices, result)
    syncRecordingSwitch('demoKeystrokes')
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
  // U05: a preflight that is still waiting for microphone/system-audio permission keeps the
  // capture streams open for seconds after the user left the page. Its own 5 s deadline is the
  // backstop; this cancels immediately when the route is left.
  cancelRecordingPreflight()
}

// D2-2 (S14): register with the shell dispatch table (config.html loads this file
// before config.js, same as every other route).
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderRecording'] = () => renderRecording()
