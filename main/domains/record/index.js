'use strict'

const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const {
  calculateFrameBounds,
  calculateRecordControlSize,
  calculateTranscodeProgress,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource
} = require('../../../record/recording-utils')
const {
  sanitizeAnnotationCommand,
  sanitizeAnnotationSnapshot
} = require('../../../record/annotation-utils')
const { normalizeQuality, normalizeCountdown } = require('../../../shared/recording-quality')

const RECORD_MODES = Object.freeze(['display', 'region', 'window'])
const DEFAULT_RECORD_MODE = 'display'
const DEFAULT_STATE = Object.freeze({ status: 'preparing', elapsedMs: 0, microphoneMuted: false, stateVersion: 0 })
const ACTIVE_STATUSES = Object.freeze(['preparing', 'countdown', 'recording', 'paused', 'finalizing'])
const TEXT_LIMIT = 128
const MICROPHONE_DEVICE_ID_LIMIT = 256
// A command's result is only useful until the next few commands land; the cap keeps a long
// recording from growing a request table for every tray click.
const COMMAND_HISTORY_LIMIT = 64
const EDITOR_WINDOW = Object.freeze({ width: 1120, height: 760, minWidth: 820, minHeight: 600 })
const PROJECT_LIST_LIMIT_MAX = 100
const TERMINAL_TASK_STATES = Object.freeze(['succeeded', 'failed', 'cancelled'])
// R4 window recording (docs/plans/2026-11-03-recording-r4-contracts.md §2.1/§2.2). A window source is
// only ever handed to the renderer as an opaque single-use token; the main process keeps the
// mapping to the desktopCapturer source id, which never leaves this process.
const WINDOW_MIN_SIZE_PX = 120
const WINDOW_TOKEN_TTL_MS = 120 * 1000
const WINDOW_TOKEN_LIMIT = 64
const WINDOW_SOURCE_POLL_MS = 2000
// R5 event track (contract §2.1/§2.3): the buffers are bounded inside the pointer-track service;
// these are the same ceilings re-applied when projecting to events.json.
const EVENT_TRACK_SAMPLED_HZ = 20
const EVENT_POINTER_LIMIT = 20000
const EVENT_CLICK_LIMIT = 2000
// Measurement box for a window source thumbnail. Window sources carry no size of their own, so the
// frozen canvas size is measured from the thumbnail Electron returns for this box (a window larger
// than the box is reported clamped; a window that cannot be measured reports 0 and the renderer
// falls back to its own video settings, then to 1280x720 - contract §2.2).
const WINDOW_MEASURE_BOX = Object.freeze({ width: 1920, height: 1080 })

// Lazily-constructed handle for the R1 persistence service (main/services/recording-project-service.js,
// owned by the W1 workstream). A ref, not an instance, because main.js is at a hard line ceiling and
// because an install that never records must never construct the service. `require` is inside get()
// so this module still loads when the persistence file is absent: every call site then degrades to a
// `project-service-unavailable` code instead of failing at startup.
function createRecordingProjectRef({ root, log = () => {} }) {
  let service = null
  return {
    root: typeof root === 'string' ? root : '',
    get() {
      if (service) return service
      const { createRecordingProjectService } = require('../../services/recording-project-service')
      const { atomicWriteJson } = require('../../services/data-root')
      service = createRecordingProjectService({ root, atomicWriteJson, log })
      return service
    },
    peek: () => service,
    reset: () => { service = null }
  }
}

function createRecordDomain(deps) {
  const {
    app,
    desktopCapturer,
    path,
    screen,
    dialog,
    BrowserWindow,
    rootDirectory,
    createLocalWindow,
    getSettings,
    log,
    assertGameModeDisabled,
    assertManagedDataWritable,
    getRecordingService,
    peekRecordingService,
    managedRecordingWriters,
    makeCaptureName,
    VIDEO_CAPTURE_PREFIX,
    performanceMonitor,
    // Feature E (plan §8.1-§8.4): the export task service and the export-result registrar.
    // Both are resolvers for the construction-order reason the other feature services use:
    // they are created inside initializeStore()/lazily, after this domain.
    getRecordingExportService = () => null,
    getExportResultService = () => null,
    // Feature B (plan §5.1/§5.2): the remembered-region write is a DOMAIN-INTERNAL action, which is
    // why it is injected here instead of exposed as a channel. A resolver, because the service is
    // created inside initializeStore() after this domain.
    getRegionPreferences = () => null,
    // R1/R2 (docs/plans/2026-11-03-recording-r1-r3-contracts.md §5/§10): the persistent recording
    // project service. Resolver because the W1 service is created lazily and reset after a data-root
    // migration; `null` here means "persistence unavailable" and every channel degrades to a code.
    getRecordingProjectService = () => null,
    // R2/R3 assembly collaborators (one resolver so main.js stays under its line ceiling):
    //   shell                 opening the material folder (editor "reveal")
    //   updateSettings        remembering the last valid capture configuration
    //   createMainWindow      back-to-workbench navigation
    //   backdropColor         the opaque native colour of the editor window
    //   createRegionSelection the capture overlay the region workbench entry reuses
    //   positionAutomationWindow  automation windows are placed on the secondary display
    getRecordingWorkbench = () => null,
    // R4 test seams (contract §2.2 source-lost polling): the production values are the constants
    // above; a unit test injects short ones instead of patching global timers.
    windowSourcePollMs = WINDOW_SOURCE_POLL_MS,
    windowTokenTtlMs = WINDOW_TOKEN_TTL_MS,
    // R5 §2.1: Electron's utilityProcess handle, injected like the selection hook service receives
    // it. The pointer track host is a separate utility process, never the Electron main process.
    utilityProcess = null,
    // R5 test seam: a test injects a fake track service; production builds it lazily from
    // `utilityProcess` on the first demo-enhanced recording.
    getPointerTrackService = null
  } = deps

  let recordWindow = null
  let recordFrameWindow = null
  // projectId -> editor BrowserWindow. The editor owns a project LEASE: while an editor window is
  // open the project cannot be deleted (contract §4.4: an editing reference blocks immediate delete).
  const editorWindows = new Map()
  // Capture configuration chosen by the workbench for the region flow, plus the mode that selection
  // implies. The capture overlay returns only a rectangle, so the workbench's just-picked parameters
  // travel through this one-shot slot that createRecordWindow() consumes. The timestamp bounds how
  // long a cancelled overlay can leak its config into an unrelated later capture.
  let pendingRegionCapture = null
  const REGION_PENDING_TTL_MS = 5 * 60 * 1000
  // token -> { sourceId, title, appName, width, height, expiresAt, used }. The source id is the
  // secret this registry protects: it never appears in a channel payload.
  const windowSourceTokens = new Map()
  // projectId -> probe metadata kept only in memory (frameRate / audio codec). The manifest keeps
  // width/height/audio-tracks but no frame rate (R1 schema, unchanged in R4), so the editor gets the
  // richer probe result while the recording is still in this process; after a restart the field is
  // 0 and the editor offers only `source` (contract §5).
  const probedMetadataByProject = new Map()
  // R5 event track: lazily created service plus the currently collecting session. The service is one
  // process-wide instance (one hook), used only while a demo-enhanced capture runs.
  let pointerTrackService = null
  let activeEventTrack = null

  let workbench = {}
  try {
    workbench = (typeof getRecordingWorkbench === 'function' ? getRecordingWorkbench() : null) || {}
  } catch (error) {
    log('Recording workbench collaborators unavailable:', error?.message || error)
    workbench = {}
  }

  // Records the region a recording actually started with (plan §5.1: the record-mode last region is
  // updated when a recording successfully STARTS; a cancelled selection must not overwrite it).
  // `selectionBounds` is Electron DIP window bounds - the DIP->pixel conversion is `region-preferences`'
  // job (recordFromDisplaySelection), so it cannot be forgotten here. A missing display descriptor
  // only means "no remembered region yet"; it must never break starting a recording.
  // Builds the display descriptor `region-preferences` needs without assuming Electron's native-rect
  // probe exists: `screen.dipToScreenRect` is the accurate source when available, and `scaleFactor`
  // is the documented fallback (see main/ipc/region-ipc-controller.js describeDisplay).
  function describeDisplayForRegion(display) {
    const bounds = display?.bounds || {}
    const boundsDip = {
      x: Math.round(Number(bounds.x) || 0),
      y: Math.round(Number(bounds.y) || 0),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0))
    }
    const scaleFactor = Number(display?.scaleFactor) || 1
    let pixelSize = null
    if (screen && typeof screen.dipToScreenRect === 'function') {
      try {
        const native = screen.dipToScreenRect(null, bounds)
        const width = Math.round(Number(native?.width) || 0)
        const height = Math.round(Number(native?.height) || 0)
        if (width > 0 && height > 0) pixelSize = { width, height }
      } catch {
        pixelSize = null
      }
    }
    if (!pixelSize) {
      pixelSize = {
        width: Math.max(1, Math.round(boundsDip.width * scaleFactor)),
        height: Math.max(1, Math.round(boundsDip.height * scaleFactor))
      }
    }
    return {
      key: display?.id === undefined || display?.id === null ? `${boundsDip.x}:${boundsDip.y}` : String(display.id),
      boundsDip,
      pixelSize,
      scaleFactor
    }
  }

  function rememberRecordRegion(display, selectionBounds) {    let preferences
    try {
      preferences = typeof getRegionPreferences === 'function' ? getRegionPreferences() : null
    } catch (error) {
      log('Region preferences unavailable:', error?.message || error)
      return
    }
    if (!preferences || typeof preferences.recordFromDisplaySelection !== 'function') return
    try {
      const result = preferences.recordFromDisplaySelection({
        mode: 'record',
        display: display || {},
        selectionBounds
      })
      if (!result?.ok && result?.code !== 'selection-unusable') {
        log('Remembered record region rejected:', result?.code || 'unknown')
      }
    } catch (error) {
      log('Remembered record region failed:', error?.message || error)
    }
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : ''
  }

  // A project name is user-editable and only has control characters stripped, so it can contain
  // characters a file name cannot (or that would silently create a subdirectory in the save
  // dialog's default path). The export dialog suggests this stem; the user still owns the path.
  function safeFileStem(value, fallback = 'Recording') {
    const stem = text(value).replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120)
    return stem || fallback
  }

  // The tray template is a snapshot: main.js rebuilds it from the workbench to show/hide the live
  // pause/finish entries. Only a status-bucket change needs a rebuild (a timer tick does not).
  function refreshTray() {
    const refresh = workbench.refreshTray
    if (typeof refresh !== 'function') return false
    try {
      refresh()
      return true
    } catch (error) {
      log('Recording tray refresh failed:', error?.message || error)
      return false
    }
  }

  function roundedGain(value) {
    const gain = Number(value)
    return Number.isFinite(gain) ? Math.min(4, Math.max(0, gain)) : 1
  }

  function finiteOr(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  // ---------------------------------------------------------------- recording project service

  function projectServiceOrNull() {
    try {
      const service = typeof getRecordingProjectService === 'function' ? getRecordingProjectService() : null
      return service && typeof service.createProject === 'function' ? service : null
    } catch (error) {
      log('Recording project service unavailable:', error?.message || error)
      return null
    }
  }

  function requireProjectService() {
    const service = projectServiceOrNull()
    if (!service) {
      const error = new Error('Recording project service is unavailable')
      error.code = 'project-service-unavailable'
      throw error
    }
    return service
  }

  async function getProject(projectId) {
    const service = projectServiceOrNull()
    const id = text(projectId)
    if (!service || !id) return null
    try {
      return await service.getProject(id)
    } catch (error) {
      log('Recording project read failed:', id, error?.message || error)
      return null
    }
  }

  // The session that currently holds a project's source, if one is attached. The recording service
  // is never forced into existence here: an install that only browses the record list must not spawn
  // the encoder/ffmpeg collaborators.
  function findSessionForProject(projectId) {
    const service = typeof peekRecordingService === 'function' ? peekRecordingService() : null
    const id = text(projectId)
    if (!service || !service.sessions || !id) return null
    for (const session of service.sessions.values()) {
      if (session?.projectId === id) return session
    }
    return null
  }

  // Probe metadata reconstructed from the manifest, so an editor/export session does not have to
  // re-run ffmpeg just to describe a file the probe already described at seal time.
  function probeMetadataFromProject(project) {
    const media = project?.media || {}
    const durationMs = Number(media.durationMs)
    if (!(durationMs > 0)) return null
    const tracks = Number(media.audio?.tracks) || 0
    return {
      durationMs,
      startMs: 0,
      durationSource: 'container',
      video: {
        codec: '',
        width: Number(media.video?.width) || 0,
        height: Number(media.video?.height) || 0,
        frameRate: Number(project?.captureConfig?.frameRate) || 0
      },
      audio: { exists: tracks > 0, codec: tracks > 0 ? text(media.audio?.codec) : '', sampleRate: 0, channels: 0 },
      timebase: 'ms-media-timeline'
    }
  }

  // Attaches a persistent project source to the recording service so exports can acquire it. The
  // session id IS the project id: one project has at most one live source, and the id is already a
  // validated directory name (contract §7). registerPersistedSession is idempotent.
  async function ensureProjectSession(project) {
    const projectService = requireProjectService()
    const projectId = String(project?.id || '')
    if (!projectId) return null
    const directory = projectService.projectDirectory(projectId)
    if (!directory) return null
    const sourcePath = await projectService.sourcePathOf(projectId)
    if (!sourcePath) return null
    const recordingService = getRecordingService()
    const metadata = probedMetadataByProject.get(projectId) || probeMetadataFromProject(project)
    let session = findSessionForProject(projectId)
    if (session && session.state === 'closing') {
      // A previous editor closed while an export still held its lease, so the service left this
      // entry in `closing` until that release. A re-opened editor needs a usable handle now: drop
      // the closing entry (project-owned directories are never deleted here) and re-register.
      if (typeof recordingService.detachSession === 'function') recordingService.detachSession(projectId)
      session = null
    }
    if (!session) {
      session = await managedRecordingWriters.track(() => recordingService.registerPersistedSession({
        id: projectId,
        directory,
        inputPath: sourcePath,
        metadata,
        projectId
      }))
    } else if (!session.metadata && metadata) {
      session.metadata = metadata
    }
    return { session, sourcePath, recordingService, directory }
  }

  // Contract §10 "closing the window only releases resources": once the editor window is gone, the
  // project's persisted session is DETACHED from the RecordingService table (its directory belongs
  // to the project and is never removed here). An export that still holds a lease keeps the entry
  // until its last release, so the file cannot be pulled out from under ffmpeg.
  function releaseProjectSession(projectId) {
    const id = text(projectId)
    if (!id) return false
    // Another window for the same project still holds the lease.
    if (editorWindowForProject(id)) return false
    const service = typeof peekRecordingService === 'function' ? peekRecordingService() : null
    if (!service) return false
    const session = findSessionForProject(id)
    if (!session) return false
    const references = Number(session.references) || 0
    if (references > 0 && typeof service.cleanupSession === 'function') {
      // cleanupSession on a project-owned session transitions it to `closing` and defers the table
      // removal to the last releaseSource(). No directory is deleted.
      Promise.resolve(service.cleanupSession(id)).catch((error) => {
        log('Recording project session release failed:', id, error?.message || error)
      })
      return false
    }
    // A QUEUED export has not acquired its reference yet: detaching now would make its
    // acquireSource() fail when it starts. Leave the entry for the task's terminal event, which
    // calls this function again once nothing is left to read.
    if (projectExportInFlight(id)) return false
    if (typeof service.detachSession === 'function' && service.detachSession(id)) return true
    return false
  }

  function captureOutcomeOf(win, metadata) {
    const audio = win?._recordCaptureConfig?.audio || {}
    const hasAudioTrack = metadata?.audio?.exists === true
    const durationMs = Number(metadata?.durationMs) || 0
    return {
      video: durationMs > 0 && Number(metadata?.video?.width) > 0,
      audio: {
        system: audio.system === true && hasAudioTrack,
        microphone: audio.microphone === true && hasAudioTrack
      },
      warnings: []
    }
  }

  // ---------------------------------------------------------------- shared window/state helpers

  function isTaskActive() {
    return !!(recordWindow && !recordWindow.isDestroyed())
  }

  function ownsControlWindow(win) {
    return win != null && win === recordWindow
  }

  function ownsFrameWindow(win) {
    return win != null && win === recordFrameWindow && win._recordOwner === recordWindow
  }

  function ownsEditorWindow(win) {
    if (!win) return false
    for (const candidate of editorWindows.values()) {
      if (candidate === win) return true
    }
    return false
  }

  function editorWindowForProject(projectId) {
    const win = editorWindows.get(String(projectId || ''))
    return win && !win.isDestroyed() ? win : null
  }

  function closeEditorWindow(projectId) {
    const id = String(projectId || '')
    const win = editorWindows.get(id)
    editorWindows.delete(id)
    if (win && !win.isDestroyed()) win.close()
    return !!win
  }

  function normalizeRecordState(value, previous = DEFAULT_STATE) {
    const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const status = ACTIVE_STATUSES.includes(state.status) ? state.status : previous.status
    return {
      status,
      elapsedMs: Math.max(0, Math.round(finiteOr(state.elapsedMs, previous.elapsedMs))),
      microphoneMuted: state.microphoneMuted === true,
      stateVersion: Math.max(0, Math.round(finiteOr(state.stateVersion, previous.stateVersion)))
    }
  }

  function updateRecordState(win, value) {
    if (!win || win.isDestroyed()) return null
    const previous = win._recordState || DEFAULT_STATE
    const next = normalizeRecordState(value, previous)
    // A late push from an older command must not roll the bar (or the tray) back.
    if (next.stateVersion < previous.stateVersion) return previous
    win._recordState = next
    // The tray shows a pause/finish group only while a capture is live, and the pause entry flips
    // to "resume" when the capture pauses. Rebuild on a status change while either side is live;
    // a plain elapsed-time tick needs no rebuild.
    const wasLive = previous.status === 'recording' || previous.status === 'paused'
    const isLive = next.status === 'recording' || next.status === 'paused'
    if ((wasLive || isLive) && previous.status !== next.status) refreshTray()
    return next
  }

  function activeRecordingState() {
    const control = recordWindow
    if (!control || control.isDestroyed()) return null
    const state = control._recordState || DEFAULT_STATE
    return {
      mode: RECORD_MODES.includes(control._recordMode) ? control._recordMode : DEFAULT_RECORD_MODE,
      status: state.status,
      elapsedMs: state.elapsedMs,
      microphoneMuted: state.microphoneMuted === true
    }
  }

  function issueCommand(control, command, value) {
    if (!control || control.isDestroyed()) return false
    const requestId = crypto.randomUUID()
    const requests = control._recordCommands || (control._recordCommands = new Map())
    requests.set(requestId, { command, value, status: 'pending', at: Date.now() })
    while (requests.size > COMMAND_HISTORY_LIMIT) requests.delete(requests.keys().next().value)
    control.webContents.send('record:command', { requestId, command, value })
    // No state echo here: the cached state is still the PRE-command one. commandResult() pushes
    // the POST-command state instead (contract §9.2), which is what the renderer's version guard
    // can adopt to repair a lost command push.
    return true
  }

  function pauseResumeActive() {
    const control = recordWindow
    if (!control || control.isDestroyed()) return false
    const status = (control._recordState || DEFAULT_STATE).status
    if (status === 'recording') return issueCommand(control, 'pause')
    if (status === 'paused') return issueCommand(control, 'resume')
    return false
  }

  function finishActive() {
    const control = recordWindow
    if (!control || control.isDestroyed()) return false
    const status = (control._recordState || DEFAULT_STATE).status
    // `stop` is idempotent in the renderer's applyCommand; refusing while finalizing keeps the tray
    // from queueing a second stop for a capture that is already being sealed.
    if (status !== 'recording' && status !== 'paused') return false
    return issueCommand(control, 'stop')
  }

  function focusActive() {
    const control = recordWindow
    if (!control || control.isDestroyed()) return false
    try {
      if (typeof control.isMinimized === 'function' && control.isMinimized()) control.restore()
      control.show()
      control.focus()
    } catch (error) {
      log('Recording control focus failed:', error?.message || error)
    }
    return true
  }

  function openRecordingWorkbench() {
    const create = workbench.createMainWindow
    if (typeof create !== 'function') return false
    try {
      create('recording')
      return true
    } catch (error) {
      log('Recording workbench open failed:', error?.message || error)
      return false
    }
  }

  async function cleanupRecordSession(win, service = null, allowBlocked = false) {
    const sessionId = win?._recordSessionId
    if (!sessionId) return false
    const activeService = service || getRecordingService()
    win._recordSessionId = null
    return managedRecordingWriters.track(() => activeService.cleanupSession(sessionId), { allowBlocked })
  }

  function restoreRecordFramePassthrough(frame = recordFrameWindow) {
    if (!frame || frame.isDestroyed()) return false
    frame.setIgnoreMouseEvents(true, { forward: true })
    return true
  }

  // Marks a project whose capture is still `capturing` as recoverable before its window goes away.
  // The project service's listProjects() does the same lazily on the next start; doing it here means
  // the record list is honest immediately (an interrupted capture, not a "busy" one). A project that
  // was already sealed is untouched: its state is `ready`/`recoverable` and must not be downgraded.
  async function abandonProjectCapture(win, reason) {
    const projectId = text(win?._recordProjectId)
    if (win) win._recordProjectId = ''
    if (!projectId) return false
    const service = projectServiceOrNull()
    if (!service) return false
    try {
      const project = await service.getProject(projectId)
      if (!project || project.state !== 'capturing') return false
      await service.markRecoverable(projectId, reason || 'interrupted')
      return true
    } catch (error) {
      log('Recording project abandon failed:', projectId, error?.message || error)
      return false
    }
  }

  async function closeRecordFlow(service = null, allowBlockedCleanup = false) {
    const control = recordWindow
    const frame = recordFrameWindow
    if (recordWindow === control) recordWindow = null
    if (recordFrameWindow === frame) recordFrameWindow = null
    if (control) refreshTray()
    // R4 §2.2: the window-source watch must never outlive the control bar.
    stopWindowSourceWatch(control)
    // R5 §2.2: so must the pointer track (an abandoned/closed take discards it; the finish path
    // already stopped and wrote it before this runs).
    await stopEventTrack().catch((error) => log('Pointer track stop failed:', error?.message || error))
    await abandonProjectCapture(control, 'closed').catch((error) => log('Recording project abandon failed:', error?.message))
    await cleanupRecordSession(control, service, allowBlockedCleanup).catch((error) => log('Recording cleanup failed:', error.message))
    restoreRecordFramePassthrough(frame)
    if (control && !control.isDestroyed()) control.close()
    if (frame && !frame.isDestroyed()) frame.close()
  }

  // ---------------------------------------------------------------- capture target/config

  function displayNameOf(display) {
    const label = text(display?.label)
    if (label) return label.slice(0, TEXT_LIMIT)
    let displays = []
    try {
      displays = screen.getAllDisplays() || []
    } catch {
      displays = []
    }
    const index = displays.findIndex((candidate) => String(candidate?.id) === String(display?.id))
    return `DISPLAY${index >= 0 ? index + 1 : 1}`
  }

  function resolveDisplay(displayId) {
    let displays = []
    try {
      displays = screen.getAllDisplays() || []
    } catch {
      displays = []
    }
    const wanted = text(displayId)
    if (wanted) {
      const found = displays.find((display) => String(display?.id) === wanted)
      if (found) return found
    }
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    } catch {
      return screen.getPrimaryDisplay()
    }
  }

  // Contract §7 captureConfig.target: the frozen description of what was captured. Region mode
  // records the SELECTION rectangle (the user's chosen area), display mode the whole screen.
  function describeCaptureTarget(display, mode, selectionBounds) {
    const descriptor = describeDisplayForRegion(display)
    const scaleFactor = descriptor.scaleFactor
    const boundsDip = mode === 'region'
      ? {
          x: Math.round(Number(selectionBounds?.x) || 0),
          y: Math.round(Number(selectionBounds?.y) || 0),
          width: Math.max(0, Math.round(Number(selectionBounds?.width) || 0)),
          height: Math.max(0, Math.round(Number(selectionBounds?.height) || 0))
        }
      : descriptor.boundsDip
    const pixelSize = mode === 'region'
      ? {
          width: Math.max(1, Math.round(boundsDip.width * scaleFactor)),
          height: Math.max(1, Math.round(boundsDip.height * scaleFactor))
        }
      : descriptor.pixelSize
    return {
      mode,
      displayId: String(display?.id ?? ''),
      displayName: displayNameOf(display),
      boundsDip,
      pixelSize,
      scaleFactor
    }
  }

  // The workbench sends its flat config object; accept both the flat shape (contract §9.1
  // `config`) and the frozen nested captureConfig shape (§7) so the control bar and the workbench
  // cannot disagree about where a value lives.
  function readCapturePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const nested = value.audio && typeof value.audio === 'object' && !Array.isArray(value.audio) ? value.audio : null
    return {
      frameRate: value.frameRate,
      quality: value.quality,
      countdown: value.countdown,
      // R5 §2.2/§5: session-only "demo enhance" switch (never persisted to settings). It travels on
      // the frozen workbench config object; the domain gates event collection on it.
      demoEnhance: value.demoEnhance === true,
      audio: nested
        ? {
            system: nested.system,
            microphone: nested.microphone,
            microphoneDeviceId: nested.microphoneDeviceId,
            systemGain: nested.systemGain,
            microphoneGain: nested.microphoneGain
          }
        : {
            system: value.audioSystem,
            microphone: value.audioMicrophone,
            microphoneDeviceId: value.audioMicrophoneDeviceId,
            systemGain: value.audioSystemGain,
            microphoneGain: value.audioMicrophoneGain
          }
    }
  }

  function pickValue(candidate, fallback) {
    return candidate === undefined || candidate === null || candidate === '' ? fallback : candidate
  }

  // Contract §10.2: workbench override > persisted settings > shipped defaults, normalized on every
  // axis (an out-of-range frame rate, an unknown quality id or a bogus gain can never reach the
  // recorder or the project manifest).
  function resolveCaptureConfig(options = {}) {
    const settings = getSettings() || {}
    const stored = settings.record || {}
    const provided = readCapturePayload(options.capture) || {}
    const audio = provided.audio || {}
    const mode = RECORD_MODES.includes(options.mode)
      ? options.mode
      : (RECORD_MODES.includes(stored.lastMode) ? stored.lastMode : DEFAULT_RECORD_MODE)
    return {
      mode,
      frameRate: normalizeFrameRate(pickValue(provided.frameRate, stored.frameRate)),
      quality: normalizeQuality(pickValue(provided.quality, stored.quality)),
      countdown: normalizeCountdown(pickValue(provided.countdown, stored.countdown)),
      // R5 §2.2: default off; the workbench switch is session-only, so there is no settings
      // fallback to consult.
      demoEnhance: provided.demoEnhance === true,
      audio: {
        system: pickValue(audio.system, stored.audioSystem) !== false,
        microphone: pickValue(audio.microphone, stored.audioMicrophone) === true,
        microphoneDeviceId: text(pickValue(audio.microphoneDeviceId, stored.audioMicrophoneDeviceId)).slice(0, MICROPHONE_DEVICE_ID_LIMIT),
        systemGain: roundedGain(pickValue(audio.systemGain, stored.audioSystemGain)),
        microphoneGain: roundedGain(pickValue(audio.microphoneGain, stored.audioMicrophoneGain))
      }
    }
  }

  function updateSettingsSafe(patch) {
    const update = workbench.updateSettings
    if (typeof update !== 'function') return false
    try {
      update(patch)
      return true
    } catch (error) {
      log('Recording settings update failed:', error?.message || error)
      return false
    }
  }

  // Contract §4.1: remember the last VALID configuration. Written at start, from the values that
  // actually started a capture - never from a control the user moved but never used.
  function rememberCaptureConfig(win) {
    const config = win?._recordCaptureConfig
    if (!config) return false
    return updateSettingsSafe({
      record: {
        lastMode: config.target.mode,
        lastDisplayId: config.target.displayId,
        frameRate: config.frameRate,
        quality: config.quality,
        countdown: config.countdown,
        audioSystem: config.audio.system,
        audioMicrophone: config.audio.microphone,
        audioMicrophoneDeviceId: config.audio.microphoneDeviceId
      }
    })
  }

  async function getDesktopSource(display) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      })
      const source = pickDesktopSource(sources, display.id)
      if (!source) throw new Error('未找到匹配显示器的桌面源')
      return source
    } catch (error) {
      throw new Error(`无法获取桌面录制源：${error.message || error}`)
    }
  }

  function getRecordControlBounds(selectionBounds, workArea) {
    const { width, height } = calculateRecordControlSize(workArea)
    const minX = workArea.x
    const maxX = workArea.x + workArea.width - width
    const minY = workArea.y
    const maxY = workArea.y + workArea.height - height
    const x = Math.max(minX, Math.min(maxX, Math.round(selectionBounds.x + (selectionBounds.width - width) / 2)))
    let y = selectionBounds.y + selectionBounds.height + 12
    if (y > maxY) y = selectionBounds.y - height - 12
    return { x, y: Math.max(minY, Math.min(maxY, Math.round(y))), width, height }
  }

  // ---------------------------------------------------------------- event track (R5 §2)

  // The pointer track service is created lazily (an install that never records never spawns a
  // utility process) and only receives Electron's `utilityProcess` handle through the injected
  // dependency, exactly like the selection hook service receives it.
  function pointerTrackServiceOrNull() {
    if (typeof getPointerTrackService === 'function') {
      try {
        const injected = getPointerTrackService()
        if (injected && typeof injected.start === 'function') return injected
      } catch (error) {
        log('Pointer track service resolver failed:', error?.message || error)
      }
      return null
    }
    if (pointerTrackService) return pointerTrackService
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') return null
    try {
      const pointerTrack = require('../../services/pointer-track-service')
      pointerTrackService = pointerTrack.createPointerTrackService({
        createHost: pointerTrack.createPointerUtilityProcessHostFactory({
          utilityProcess,
          hostPath: pointerTrack.defaultPointerHostPath()
        }),
        log
      })
      return pointerTrackService
    } catch (error) {
      log('Pointer track service unavailable:', error?.message || error)
      return null
    }
  }

  // The captured source-content region in DIP, for normalizing pointer coordinates. Display mode
  // uses the display bounds, region mode the selection rectangle (contract §2.2).
  function eventContentRegion(win) {
    const init = win?._recordInit || {}
    const display = init.display || {}
    const scaleFactor = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1
    const bounds = win?._recordMode === 'region'
      ? (init.selectionBounds || {})
      : (display.boundsDip || init.displayBounds || {})
    return {
      left: Number(bounds.x) || 0,
      top: Number(bounds.y) || 0,
      width: Math.max(0, Number(bounds.width) || 0),
      height: Math.max(0, Number(bounds.height) || 0),
      scaleFactor
    }
  }

  function screenToDipPoint(point, scaleFactor) {
    if (screen && typeof screen.screenToDipPoint === 'function') {
      try {
        const dip = screen.screenToDipPoint({ x: point.x, y: point.y })
        const x = Number(dip?.x)
        const y = Number(dip?.y)
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
      } catch {}
    }
    const scale = Number(scaleFactor) > 0 ? Number(scaleFactor) : 1
    return { x: point.x / scale, y: point.y / scale }
  }

  // Contract §2.3: normalized 0-1 with 3 decimals; a point outside the captured content region is
  // dropped (a mismatched display/scale can otherwise produce plausible-looking garbage).
  function normalizeEventPoint(point, region) {
    if (!(region.width > 0) || !(region.height > 0)) return null
    const dip = screenToDipPoint(point, region.scaleFactor)
    const rawX = (dip.x - region.left) / region.width
    const rawY = (dip.y - region.top) / region.height
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null
    if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) return null
    return {
      x: Math.round(Math.min(1, Math.max(0, rawX)) * 1000) / 1000,
      y: Math.round(Math.min(1, Math.max(0, rawY)) * 1000) / 1000
    }
  }

  function sanitizePausedIntervals(value) {
    if (!Array.isArray(value)) return []
    const intervals = []
    for (const entry of value.slice(0, 1000)) {
      const startWall = Number(entry?.startWall)
      const endWall = Number(entry?.endWall)
      if (!Number.isFinite(startWall) || !Number.isFinite(endWall) || endWall < startWall) continue
      intervals.push({ startWall, endWall })
    }
    intervals.sort((left, right) => left.startWall - right.startWall)
    return intervals
  }

  // Total pause duration that had ELAPSED at `at` (contract §2.2: mediaMs = at - start - paused so
  // far). Overlapping renderer intervals are clamped so a buggy payload cannot over-subtract.
  function pausedMsAt(intervals, at) {
    let total = 0
    let coveredUntil = -Infinity
    for (const interval of intervals) {
      if (interval.startWall > at) break
      const start = Math.max(interval.startWall, coveredUntil)
      if (start >= at) break
      total += Math.min(interval.endWall, at) - start
      coveredUntil = Math.max(coveredUntil, interval.endWall)
    }
    return total
  }

  // Builds the frozen events.json v1 payload (contract §2.3) from raw wall-clock buffers. Returns
  // null when the mapping inputs are unusable (never invent times or coordinates).
  function buildEventTrack(win, rawResults, timing = {}) {
    const results = rawResults && typeof rawResults === 'object' ? rawResults : {}
    const durationMs = Math.max(0, Math.round(Number(timing.durationMs) || 0))
    const mediaStartedAtWall = Number(timing.mediaStartedAtWall)
    if (!Number.isFinite(mediaStartedAtWall) || durationMs <= 0) return null
    const region = eventContentRegion(win)
    if (!(region.width > 0) || !(region.height > 0)) return null
    const pausedIntervals = sanitizePausedIntervals(timing.pausedIntervals)
    const toMediaMs = (at) => Math.round(at - mediaStartedAtWall - pausedMsAt(pausedIntervals, at))
    const pointer = []
    for (const entry of Array.isArray(results.pointer) ? results.pointer : []) {
      const tMs = toMediaMs(Number(entry?.at))
      if (!Number.isFinite(tMs) || tMs < 0 || tMs > durationMs) continue
      const point = normalizeEventPoint(entry, region)
      if (!point) continue
      pointer.push({ tMs, x: point.x, y: point.y })
    }
    pointer.sort((left, right) => left.tMs - right.tMs)
    // Contract §2.3: time-ascending and consecutive identical coordinates deduped.
    const keptPointer = []
    for (const entry of pointer) {
      const previous = keptPointer[keptPointer.length - 1]
      if (previous && previous.x === entry.x && previous.y === entry.y) continue
      keptPointer.push(entry)
    }
    const clicks = []
    for (const entry of Array.isArray(results.clicks) ? results.clicks : []) {
      const button = Number(entry?.button)
      if (button !== 0 && button !== 1 && button !== 2) continue
      const tMs = toMediaMs(Number(entry?.at))
      if (!Number.isFinite(tMs) || tMs < 0 || tMs > durationMs) continue
      const point = normalizeEventPoint(entry, region)
      if (!point) continue
      clicks.push({ tMs, x: point.x, y: point.y, button })
    }
    clicks.sort((left, right) => left.tMs - right.tMs)
    const truncated = results.truncated === true || keptPointer.length > EVENT_POINTER_LIMIT || clicks.length > EVENT_CLICK_LIMIT
    return {
      schemaVersion: 1,
      durationMs,
      sampledAtHz: EVENT_TRACK_SAMPLED_HZ,
      pointer: keptPointer.slice(-EVENT_POINTER_LIMIT),
      clicks: clicks.slice(-EVENT_CLICK_LIMIT),
      truncated
    }
  }

  // Contract §2.2: the switch is opt-in and display/region only. Window recordings have no stable
  // screen bounds for their content, so they never collect (contract §2.2/§7.1).
  function shouldCollectEventTrack(win) {
    const config = win?._recordCaptureConfig || {}
    if (config.demoEnhance !== true) return false
    const mode = config.target?.mode || win?._recordMode
    return mode === 'display' || mode === 'region'
  }

  function startEventTrack(win) {
    stopEventTrack().catch(() => {})
    if (!shouldCollectEventTrack(win)) return false
    const service = pointerTrackServiceOrNull()
    if (!service) {
      log('Pointer track service unavailable; recording continues without an event track')
      return false
    }
    try {
      if (service.start() !== true) return false
    } catch (error) {
      log('Pointer track start failed:', error?.message || error)
      return false
    }
    activeEventTrack = { service }
    return true
  }

  async function stopEventTrack({ discard = true } = {}) {
    const active = activeEventTrack
    activeEventTrack = null
    if (!active) return null
    let results = null
    try {
      results = await active.service.stop()
    } catch (error) {
      log('Pointer track stop failed:', error?.message || error)
      return null
    }
    return discard ? null : { results }
  }

  function writeEventTrack(projectId, track) {
    const service = projectServiceOrNull()
    if (!service || typeof service.writeEventTrack !== 'function') {
      log('Recording event track write unavailable:', projectId)
      return Promise.resolve(false)
    }
    return Promise.resolve(service.writeEventTrack(projectId, track)).then(
      () => true,
      (error) => {
        log('Recording event track write failed:', projectId, error?.message || error)
        return false
      }
    )
  }

  // ---------------------------------------------------------------- window sources (R4 §2)

  // The bottom-centre control bar of a window recording (contract §2.2). Window mode has no
  // selection rectangle to hang the bar under, so it sits at the bottom edge of the cursor display
  // with a 12px margin.
  function getWindowControlBounds(workArea) {
    const { width, height } = calculateRecordControlSize(workArea)
    const maxX = workArea.x + workArea.width - width
    const maxY = workArea.y + workArea.height - height
    const x = Math.round(workArea.x + (workArea.width - width) / 2)
    return {
      x: Math.max(workArea.x, Math.min(maxX, x)),
      y: Math.max(workArea.y, Math.min(maxY, workArea.y + workArea.height - height - 12)),
      width,
      height
    }
  }

  function measureWindowPixels(source) {
    try {
      const thumbnail = source?.thumbnail
      const size = thumbnail && typeof thumbnail.getSize === 'function' ? thumbnail.getSize() : null
      return {
        width: Math.max(0, Math.round(Number(size?.width) || 0)),
        height: Math.max(0, Math.round(Number(size?.height) || 0))
      }
    } catch {
      return { width: 0, height: 0 }
    }
  }

  // The highlighter's own windows must never be offered as recording targets (a window recording its
  // own workbench/editor is a feedback loop). Exact title match, as frozen in §2.1.
  function ownWindowTitles() {
    const titles = new Set()
    try {
      const all = typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []
      for (const win of Array.isArray(all) ? all : []) {
        if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue
        const title = typeof win.getTitle === 'function' ? win.getTitle() : ''
        if (typeof title === 'string' && title.trim()) titles.add(title.trim())
      }
    } catch (error) {
      log('Own window title enumeration failed:', error?.message || error)
    }
    return titles
  }

  function pruneWindowSourceTokens(now = Date.now()) {
    for (const [token, entry] of windowSourceTokens) {
      if (!entry || entry.expiresAt <= now) windowSourceTokens.delete(token)
    }
  }

  // Window sources carry no size of their own; the thumbnail Electron returns for the measure box is
  // the only measurement available (contract §2.1: "from the source thumbnail/info; 0 when it cannot
  // be measured"). An empty thumbnail (minimized/uncapturable window) reports 0 rather than
  // inventing a size.
  async function enumerateWindowSources({ measure = true } = {}) {
    if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') return null
    try {
      return await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: measure
          ? { width: WINDOW_MEASURE_BOX.width, height: WINDOW_MEASURE_BOX.height }
          : { width: 0, height: 0 }
      })
    } catch (error) {
      log('Window source enumeration failed:', error?.message || error)
      return null
    }
  }

  async function listRecordableWindows() {
    const sources = await enumerateWindowSources()
    if (!sources) return { ok: false, code: 'window-enumeration-failed' }
    // Refresh semantics: a token from a previous list is superseded by the new list. Only expired
    // entries are pruned otherwise, so dropping the unused ones here is what keeps the registry at
    // the frozen 64-entry ceiling across repeated refreshes.
    pruneWindowSourceTokens()
    for (const [token, entry] of windowSourceTokens) {
      if (!entry.used) windowSourceTokens.delete(token)
    }
    const ownTitles = ownWindowTitles()
    const seenSources = new Set()
    const windows = []
    for (const source of Array.isArray(sources) ? sources : []) {
      if (windows.length >= WINDOW_TOKEN_LIMIT) break
      const sourceId = typeof source?.id === 'string' ? source.id : ''
      const title = text(source?.name)
      if (!sourceId || !title) continue
      if (seenSources.has(sourceId)) continue
      if (ownTitles.has(title)) continue
      const pixels = measureWindowPixels(source)
      // A measured window smaller than the frozen minimum is not a useful target. An UNMEASURED one
      // (0x0) is kept: "measurement failed" is not "too small" (§2.1).
      if (pixels.width > 0 && pixels.height > 0 && (pixels.width < WINDOW_MIN_SIZE_PX || pixels.height < WINDOW_MIN_SIZE_PX)) continue
      seenSources.add(sourceId)
      const token = crypto.randomUUID()
      windowSourceTokens.set(token, {
        sourceId,
        title,
        appName: text(source?.appName),
        width: pixels.width,
        height: pixels.height,
        expiresAt: Date.now() + Math.max(1, Number(windowTokenTtlMs) || WINDOW_TOKEN_TTL_MS),
        used: false
      })
      windows.push({
        token,
        title,
        appName: text(source?.appName),
        width: pixels.width,
        height: pixels.height
      })
    }
    return { ok: true, windows }
  }

  // Token -> live window source. The token is consumed BEFORE the recording window is created, but
  // marked used only after the window exists (§2.1), so a failed start can be retried.
  async function resolveWindowSource(windowToken) {
    const token = text(windowToken)
    if (!token) {
      const error = new Error('Recording window token is required')
      error.code = 'window-required'
      throw error
    }
    pruneWindowSourceTokens()
    const entry = windowSourceTokens.get(token)
    if (!entry || entry.used) {
      const error = new Error('Recording window source is unavailable')
      error.code = 'window-unavailable'
      throw error
    }
    const sources = await enumerateWindowSources()
    if (!sources) {
      const error = new Error('Recording window source enumeration failed')
      error.code = 'window-unavailable'
      throw error
    }
    const source = (Array.isArray(sources) ? sources : []).find((candidate) => typeof candidate?.id === 'string' && candidate.id === entry.sourceId)
    if (!source) {
      windowSourceTokens.delete(token)
      const error = new Error('Recording window source is gone')
      error.code = 'window-unavailable'
      throw error
    }
    const pixels = measureWindowPixels(source)
    const width = pixels.width || entry.width
    const height = pixels.height || entry.height
    if (width > 0 && height > 0 && (width < WINDOW_MIN_SIZE_PX || height < WINDOW_MIN_SIZE_PX)) {
      windowSourceTokens.delete(token)
      const error = new Error('Recording window is too small')
      error.code = 'window-too-small'
      throw error
    }
    return {
      token,
      source,
      sourceId: entry.sourceId,
      title: text(source?.name) || entry.title,
      // Frozen output canvas size. 0x0 means "could not measure here": the renderer completes the
      // frozen chain with `video.getSettings()`, then 1280x720 (§2.2).
      pixelSize: { width, height }
    }
  }

  function markWindowTokenUsed(token) {
    const entry = windowSourceTokens.get(text(token))
    if (entry) entry.used = true
  }

  function describeWindowCaptureTarget(binding) {
    const width = Math.max(0, Math.round(Number(binding.pixelSize?.width) || 0))
    const height = Math.max(0, Math.round(Number(binding.pixelSize?.height) || 0))
    return {
      mode: 'window',
      // A window is not bound to a display; the control bar's display is reported separately in the
      // init payload. The frozen manifest target keeps the window title as its display name (§2.2).
      displayId: '',
      displayName: binding.title,
      boundsDip: { x: 0, y: 0, width, height },
      pixelSize: { width, height },
      scaleFactor: 1
    }
  }

  // Contract §2.2 target-loss detection: while the window-mode control window is alive, re-enumerate
  // window sources every 2s. A vanished bound source pushes `record:source-lost` exactly once and
  // stops the watch; the renderer then finishes (recording/paused) or returns to ready.
  function stopWindowSourceWatch(control) {
    const timer = control?._recordSourceWatch
    if (!timer) return false
    clearInterval(timer)
    control._recordSourceWatch = null
    return true
  }

  function startWindowSourceWatch(control, binding) {
    if (!control || !binding?.sourceId) return false
    stopWindowSourceWatch(control)
    const interval = Math.max(1, Number(windowSourcePollMs) || WINDOW_SOURCE_POLL_MS)
    let inFlight = false
    const timer = setInterval(async () => {
      if (!control || (typeof control.isDestroyed === 'function' && control.isDestroyed())) {
        stopWindowSourceWatch(control)
        return
      }
      if (inFlight) return
      inFlight = true
      try {
        const sources = await enumerateWindowSources({ measure: false })
        if (!sources) return
        const alive = (Array.isArray(sources) ? sources : []).some((source) => source?.id === binding.sourceId)
        if (alive) return
        stopWindowSourceWatch(control)
        if (!control.isDestroyed()) control.webContents.send('record:source-lost', { reason: 'closed' })
        log('Recording window source closed:', binding.title || binding.sourceId)
      } finally {
        inFlight = false
      }
    }, interval)
    timer.unref?.()
    control._recordSourceWatch = timer
    return true
  }

  // ---------------------------------------------------------------- control bar window

  async function createRecordWindow(options = {}) {
    assertGameModeDisabled()
    // Repeat-entry arbitration (contract §10.1): a second "start recording" while a control window
    // is alive focuses that window instead of silently destroying the capture in progress.
    if (recordWindow && !recordWindow.isDestroyed()) {
      focusActive()
      return recordWindow
    }
    await closeRecordFlow()
    const pending = pendingRegionCapture
    pendingRegionCapture = null
    // A stale slot (the user cancelled the region overlay) must not turn a later capture into the
    // workbench's last region configuration.
    const pendingRegion = pending && Date.now() - pending.at < REGION_PENDING_TTL_MS ? pending : null
    const providedCapture = options.capture || pendingRegion?.capture || null
    const config = resolveCaptureConfig({
      ...options,
      mode: options.mode || pendingRegion?.mode,
      capture: providedCapture
    })
    const requestedBounds = options.selectionBounds && {
      x: Math.round(Number(options.selectionBounds.x)),
      y: Math.round(Number(options.selectionBounds.y)),
      width: Math.round(Number(options.selectionBounds.width)),
      height: Math.round(Number(options.selectionBounds.height))
    }
    const windowMode = config.mode === 'window'
    // R4 §2.2: resolve the opaque token BEFORE any window exists. A failure here is an error code
    // the workbench surfaces (window-required / window-unavailable / window-too-small); the token is
    // marked used only after the control window was created successfully.
    const windowBinding = windowMode ? await resolveWindowSource(options.windowToken) : null
    // Window mode has no selection rectangle and is not bound to a display: the control bar sits at
    // the bottom of the display under the cursor and `selectionBounds` only feeds its positioning.
    const display = windowMode
      ? resolveDisplay(options.displayId)
      : (options.display || (requestedBounds ? screen.getDisplayMatching(requestedBounds) : resolveDisplay(options.displayId)))
    const selectionBounds = windowMode
      ? {
          x: Math.round(display.workArea.x),
          y: Math.round(display.workArea.y),
          width: Math.round(display.workArea.width),
          height: Math.round(display.workArea.height)
        }
      : normalizeSelectionBounds(requestedBounds || display.bounds, display.bounds)
    const source = windowMode ? null : await getDesktopSource(display)
    const target = windowMode
      ? describeWindowCaptureTarget(windowBinding)
      : describeCaptureTarget(display, config.mode, selectionBounds)
    const displayDescriptor = { id: String(display.id), name: displayNameOf(display), ...describeDisplayForRegion(display) }
    const frameRate = config.frameRate
    const frameBounds = windowMode ? null : calculateFrameBounds(selectionBounds, 2)
    const controlBounds = windowMode ? getWindowControlBounds(display.workArea) : getRecordControlBounds(selectionBounds, display.workArea)

    const framePagePath = path.join(rootDirectory, 'record', 'frame.html')
    const controlPagePath = path.join(rootDirectory, 'record', 'record.html')
    // Window mode deliberately creates NO frame annotation window: a screen-space annotation layer
    // over a window source would be misaligned the moment the window moves or scales (§2.2).
    const frameWindow = windowMode ? null : createLocalWindow(framePagePath, {
      role: 'record-frame',
      ...frameBounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-record-frame.js'),
        backgroundThrottling: false
      }
    })
    const controlWindow = createLocalWindow(controlPagePath, {
      role: 'record-control',
      ...controlBounds,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-record.js'),
        backgroundThrottling: false
      }
    })
    recordFrameWindow = frameWindow
    recordWindow = controlWindow
    if (frameWindow) frameWindow._recordOwner = controlWindow
    controlWindow._recordControlBounds = controlBounds
    controlWindow._recordFrameState = 'idle'
    controlWindow._recordAnnotationCommand = sanitizeAnnotationCommand({})
    controlWindow._recordMode = config.mode
    controlWindow._recordWindowBinding = windowBinding
    controlWindow._recordProjectId = ''
    controlWindow._recordSessionId = ''
    controlWindow._recordState = { ...DEFAULT_STATE }
    controlWindow._recordCommands = new Map()
    controlWindow._recordCaptureConfig = {
      target,
      frameRate,
      quality: config.quality,
      countdown: config.countdown,
      audio: { ...config.audio },
      // R5 §2.2: the session-only demo switch (never written to the manifest/settings). Consumed by
      // the record:start-session gate that starts the pointer track.
      demoEnhance: config.demoEnhance === true
    }
    controlWindow._recordInit = {
      // R2 contract shape (contracts §9.2). `sessionId`/`projectId` are filled in later: the
      // control bar is created BEFORE a capture session exists.
      sessionId: '',
      projectId: '',
      mode: config.mode,
      display: displayDescriptor,
      selectionBounds,
      frameRate,
      quality: config.quality,
      countdownSeconds: config.countdown,
      audio: { ...config.audio },
      // R4 §2.2 window-mode increments: the renderer must not offer annotation (no frame layer) and
      // freezes its output canvas to the measured window pixels.
      ...(windowMode
        ? {
            annotation: false,
            window: {
              title: windowBinding.title,
              pixelSize: { width: windowBinding.pixelSize.width, height: windowBinding.pixelSize.height }
            }
          }
        : {}),
      // E2E-only synthetic capture source (contract §13.5). Only the main-process environment can
      // set this; no renderer-writable field can turn it on.
      fakeCapture: process.env.HIGHLIGHTER_E2E_FAKE_CAPTURE === '1',
      // Legacy flat keys (P0-3-T2) kept so an older recorder build keeps working unchanged. In
      // window mode the desktop source id is intentionally absent: a window source id must never
      // reach a renderer (§2.1), and the bound source is served by the display-media handler.
      sourceId: source ? source.id : '',
      displayBounds: display.bounds,
      audioSystem: config.audio.system,
      audioMicrophone: config.audio.microphone,
      audioSystemGain: config.audio.systemGain,
      audioMicrophoneGain: config.audio.microphoneGain
    }

    // P0-3-T2: the renderer acquires the desktop through getDisplayMedia, which Electron
    // only grants from this handler. Window mode serves the BOUND window source (§2.2); display and
    // region mode keep pinning the display with pickDesktopSource. The system-audio track is offered
    // only when the renderer actually asked for audio, which is what keeps the "system sound off"
    // contract (settings-defaults.js:71) honest. System audio is the system MIX, also for windows.
    const recordSession = controlWindow.webContents.session
    recordSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        // 只服务录制窗自己的主帧：该 handler 注册在**共享默认 session** 上，若不校验来源，
        // 任何渲染进程（含将来新增的窗口）调用 getDisplayMedia 都能拿到屏幕 + loopback 音频。
        if (request.frame && request.frame !== controlWindow.webContents.mainFrame) return callback({})
        if (!request.videoRequested) return callback({})
        let video = null
        if (windowMode) {
          video = windowBinding.source
        } else {
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          video = pickDesktopSource(sources, display.id)
        }
        if (!video) return callback({})
        const audio = request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined
        callback(audio ? { video, audio } : { video })
      } catch (error) {
        log('Display media request failed:', error.message)
        callback({})
      }
    })

    for (const win of [frameWindow, controlWindow]) {
      if (!win) continue
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setContentProtection(true)
    }
    if (frameWindow) restoreRecordFramePassthrough(frameWindow)
    controlWindow.on('closed', () => {
      // 注销共享 session 上的 display-media handler：否则窗口关闭后它仍存活并指向旧 display。
      try { recordSession.setDisplayMediaRequestHandler(null) } catch (error) { log('Display media handler cleanup failed:', error.message) }
      stopWindowSourceWatch(controlWindow)
      // R5 §2.2: a closed control bar can never finish, so its event track host must not outlive it.
      stopEventTrack().catch((error) => log('Pointer track stop failed:', error?.message || error))
      cleanupRecordSession(controlWindow).catch((error) => log('Recording cleanup failed:', error.message))
      abandonProjectCapture(controlWindow, 'closed').catch((error) => log('Recording project abandon failed:', error.message))
      if (recordWindow === controlWindow) recordWindow = null
      if (recordFrameWindow?._recordOwner === controlWindow) {
        const ownedFrame = recordFrameWindow
        recordFrameWindow = null
        if (!ownedFrame.isDestroyed()) ownedFrame.close()
      }
    })
    if (frameWindow) {
      frameWindow.on('closed', () => {
        if (recordFrameWindow === frameWindow) recordFrameWindow = null
      })
    }
    await Promise.all([
      frameWindow ? frameWindow.loadFile(framePagePath) : Promise.resolve(),
      controlWindow.loadFile(controlPagePath)
    ])
    if (frameWindow) frameWindow.showInactive()
    controlWindow.show()
    if (windowMode) {
      // The window source token is single-use from here on: the recording window exists (§2.1).
      markWindowTokenUsed(windowBinding.token)
      startWindowSourceWatch(controlWindow, windowBinding)
    }
    log('Recording window created:', {
      mode: config.mode,
      displayId: windowMode ? '' : target.displayId,
      windowTitle: windowMode ? windowBinding.title : '',
      frameRate,
      quality: config.quality,
      countdown: config.countdown
    })
    return controlWindow
  }

  function requireRecordSender(event) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== recordWindow || win.isDestroyed()) throw new Error('无效的录制窗口')
    return win
  }

  function requireRecordFrameSender(event) {
    const frame = BrowserWindow.fromWebContents(event.sender)
    if (!frame || frame !== recordFrameWindow || frame.isDestroyed() || frame._recordOwner !== recordWindow) {
      throw new Error('无效的录制标注窗口')
    }
    return frame
  }

  function requireEditorSender(event) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || !ownsEditorWindow(win)) throw new Error('Invalid recording editor window')
    return win
  }

  function requireEditorProject(win, projectId) {
    const id = text(projectId)
    if (!id || win._recordProjectId !== id) throw new Error('Recording project does not belong to this editor')
    return id
  }

  function sendRecordAnnotationCommand(control, payload = {}) {
    const frame = recordFrameWindow
    if (!control || control !== recordWindow || control.isDestroyed() || !frame || frame.isDestroyed() || frame._recordOwner !== control) return false
    const sanitized = sanitizeAnnotationCommand({ ...control._recordAnnotationCommand, ...payload })
    const enabled = ['recording', 'paused'].includes(control._recordFrameState)
    const message = { ...sanitized, enabled, tool: enabled ? sanitized.tool : 'pointer' }
    control._recordAnnotationCommand = { ...sanitized, action: '' }
    frame.setIgnoreMouseEvents(message.tool === 'pointer', { forward: true })
    frame.webContents.send('record-frame:command', message)
    return message
  }

  function requireRecordSession(win, sessionId) {
    if (!sessionId || win._recordSessionId !== sessionId) throw new Error('录制会话不匹配')
    return sessionId
  }

  // ---------------------------------------------------------------- export plumbing

  // Feature A integration (plan §4.2): the same receipt shape the capture/recognition result
  // bars consume, so the recorder reuses main/services/export-result-service.js unchanged.
  function exportResultRegistrar() {
    try {
      const service = typeof getExportResultService === 'function' ? getExportResultService() : null
      if (!service || typeof service.register !== 'function') return null
      return (payload) => service.register(payload)
    } catch (error) {
      log('Export result service unavailable:', error?.message || error)
      return null
    }
  }

  // Feature E (plan §8.3): the owner id for an export task is the sending WebContents id, the
  // same derivation main/ipc/export-action-controller.js uses for feature A receipts. It is
  // stable for the window's contents, cannot be chosen by a renderer, and the result bar's
  // `export:perform-action` check compares exactly this string.
  function exportOwnerId(sender) {
    const contentsId = Number(sender?.id)
    if (!Number.isInteger(contentsId) || contentsId <= 0) return ''
    return `web-contents:${contentsId}`
  }

  function requireExportService() {
    const service = typeof getRecordingExportService === 'function' ? getRecordingExportService() : null
    if (!service || typeof service.submit !== 'function') throw new Error('录屏导出服务不可用')
    return service
  }

  function optionalExportService() {
    try {
      const service = typeof getRecordingExportService === 'function' ? getRecordingExportService() : null
      return service && typeof service.submit === 'function' ? service : null
    } catch (error) {
      log('Recording export service unavailable:', error?.message || error)
      return null
    }
  }

  function exportExtension(format) {
    return format === 'gif' ? 'gif' : (format === 'webm' ? 'webm' : 'mp4')
  }

  // `defaultName` may or may not already carry an extension (the legacy channel passes a capture
  // name, the editor passes the project's display name), so the suggested file always ends with the
  // format's own extension instead of inheriting whatever the name happened to have.
  function withExportExtension(name, extension) {
    const stem = text(name).replace(/\.[^.]*$/, '') || 'Recording'
    return `${stem}.${extension}`
  }

  // The save dialog is main-process owned (plan §8.3: "the renderer does not submit source or
  // target paths"). The target is frozen by the export service right after this resolves.
  // `alwaysOnTop:false` is for the editor window, which is a normal window and must not be
  // promoted to the screen-saver layer to survive its own dialog.
  async function chooseExportTarget(win, { format, defaultName, defaultDirectory, alwaysOnTop = true }) {
    const extension = exportExtension(format)
    const directory = defaultDirectory || app.getPath('videos')
    let result
    if (alwaysOnTop) win.setAlwaysOnTop(false)
    try {
      result = await dialog.showSaveDialog(win, {
        // R4 §4.4: WebM joins the two legacy formats; its title/filter copy follows the same
        // main-process dialog convention as the existing GIF/MP4 branches.
        title: format === 'gif' ? '保存 GIF 录屏' : (format === 'webm' ? '保存 WebM 录屏' : '保存 MP4 录屏'),
        defaultPath: path.join(directory, withExportExtension(defaultName, extension)),
        filters: format === 'gif'
          ? [{ name: 'GIF 动图', extensions: ['gif'] }]
          : (format === 'webm'
            ? [{ name: 'WebM 视频', extensions: ['webm'] }]
            : [{ name: 'MP4 视频', extensions: ['mp4'] }])
      })
    } finally {
      if (alwaysOnTop && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
    }
    if (result.canceled || !result.filePath) return null
    return path.resolve(result.filePath)
  }

  function recordProjectExport(projectId, task, format, targetPath, editRevision) {
    const service = projectServiceOrNull()
    if (!service || typeof service.appendExport !== 'function') return
    const fileName = text(task?.receipt?.fileName) || path.basename(String(targetPath || ''))
    service.appendExport(projectId, {
      exportId: task?.taskId || '',
      format,
      fileName,
      exportedAt: Date.now(),
      editRevision,
      // Main-process only; the persistence projection drops it (contract §7).
      targetPath
    }).catch((error) => log('Recording export record failed:', projectId, error?.message || error))
  }

  // ---------------------------------------------------------------- editor window

  function editorBackdropColor() {
    const resolve = workbench.backdropColor
    if (typeof resolve !== 'function') return '#1e1e1e'
    try {
      return resolve() || '#1e1e1e'
    } catch (error) {
      log('Recording editor backdrop unavailable:', error?.message || error)
      return '#1e1e1e'
    }
  }

  function positionEditorWindow(win) {
    try {
      if (typeof win.center === 'function') win.center()
    } catch {}
    const position = workbench.positionAutomationWindow
    if (typeof position !== 'function') return false
    try {
      return position(win) === true
    } catch (error) {
      log('Recording editor positioning failed:', error?.message || error)
      return false
    }
  }

  async function editorInitPayload(project) {
    const service = requireProjectService()
    const sourcePath = await service.sourcePathOf(project.id)
    if (!sourcePath) return null
    const media = project.media || {}
    // R4 §6: the editor needs the source frame rate to offer fps options. The manifest does not keep
    // it (R1 schema unchanged), so the in-process probe stash is the only source; 0 means unknown and
    // the editor offers `source` only.
    const probed = probedMetadataByProject.get(project.id) || null
    return {
      project: service.publicProject(project),
      // The ONLY path form a renderer may receive (contract §9.3): a derived file URL.
      sourceUrl: pathToFileURL(sourcePath).href,
      metadata: {
        durationMs: Math.max(0, Math.round(Number(media.durationMs) || 0)),
        video: {
          width: Math.max(0, Math.round(Number(media.video?.width) || 0)),
          height: Math.max(0, Math.round(Number(media.video?.height) || 0)),
          frameRate: Math.max(0, Math.round(Number(probed?.video?.frameRate) || 0))
        },
        audio: {
          tracks: Math.max(0, Math.round(Number(media.audio?.tracks) || 0)),
          codec: text(media.audio?.codec) || text(probed?.audio?.codec)
        }
      },
      recovery: {
        state: project.state === 'ready' ? 'ready' : 'recoverable',
        errorCode: text(project.recovery?.errorCode)
      }
    }
  }

  // Recovery attempt (contract §10): re-probe the sealed source; a usable file joins the records
  // as `ready`, an unusable one is marked recoverable and the editor still opens read-only.
  async function attemptProjectRecovery(project) {
    const service = requireProjectService()
    let attached
    try {
      attached = await ensureProjectSession(project)
    } catch (error) {
      log('Recording recovery attach failed:', project.id, error?.message || error)
      return null
    }
    if (!attached) return null
    let probed
    try {
      probed = await attached.recordingService.probeSession(project.id, { force: true })
    } catch (error) {
      log('Recording recovery probe failed:', project.id, error?.message || error)
      probed = { ok: false, code: 'probe-failed' }
    }
    if (!probed?.ok) {
      await service.markRecoverable(project.id, probed?.code || 'probe-failed').catch(() => {})
      return null
    }
    if (probed.metadata) probedMetadataByProject.set(project.id, probed.metadata)
    const marked = await service.markReady(project.id, {
      fileName: project.source?.fileName || '',
      metadata: probed.metadata
    }).catch((error) => {
      log('Recording recovery markReady failed:', project.id, error?.message || error)
      return null
    })
    return marked?.ok ? marked.project : null
  }

  function createEditorWindow(project, initPayload) {
    const projectId = String(project.id)
    const editorPagePath = path.join(rootDirectory, 'record', 'editor.html')
    let win
    try {
      win = createLocalWindow(editorPagePath, {
        role: 'record-editor',
        ...EDITOR_WINDOW,
        show: false,
        frame: false,
        resizable: true,
        maximizable: true,
        backgroundColor: editorBackdropColor(),
        webPreferences: {
          preload: path.join(rootDirectory, 'preload-record-editor.js'),
          backgroundThrottling: false
        }
      })
    } catch (error) {
      log('Recording editor window creation failed:', error?.message || error)
      return { ok: false, code: 'window-create-failed' }
    }
    editorWindows.set(projectId, win)
    win._recordProjectId = projectId
    win._recordEditorInit = initPayload
    win.on('closed', () => {
      if (editorWindows.get(projectId) === win) editorWindows.delete(projectId)
      // D1 (contract §10 "closing the window only releases resources"): the editor's project lease
      // is released here, so opening many records does not grow the RecordingService table forever.
      releaseProjectSession(projectId)
    })
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      positionEditorWindow(win)
      win.show()
      win.focus()
    })
    win.loadFile(editorPagePath)
    return { ok: true }
  }

  // Contract §10 openEditor(): reuse/focus, `capturing` is busy, `recoverable` gets one recovery
  // attempt, and the source is attached to the recording service so an export can acquire it.
  async function openEditor(projectId) {
    const id = text(projectId)
    if (!id) return { ok: false, code: 'not-found' }
    const existing = editorWindowForProject(id)
    if (existing) {
      try {
        existing.show()
        existing.focus()
      } catch (error) {
        log('Recording editor focus failed:', error?.message || error)
      }
      return { ok: true }
    }
    if (!projectServiceOrNull()) return { ok: false, code: 'project-service-unavailable' }
    let project = await getProject(id)
    if (!project) return { ok: false, code: 'not-found' }
    if (project.state === 'capturing') return { ok: false, code: 'project-busy' }
    if (project.state !== 'ready' && project.state !== 'recoverable') return { ok: false, code: 'not-editable' }
    if (project.state === 'recoverable') project = (await attemptProjectRecovery(project)) || project
    const initPayload = await editorInitPayload(project).catch((error) => {
      log('Recording editor init failed:', id, error?.message || error)
      return null
    })
    if (!initPayload) return { ok: false, code: 'source-unavailable' }
    // Attach the source so an export submitted from this window can acquire it immediately.
    await ensureProjectSession(project).catch((error) => log('Recording project attach failed:', id, error?.message || error))
    return createEditorWindow(project, initPayload)
  }

  // ---------------------------------------------------------------- workbench

  function listWorkbenchDisplays() {
    let displays = []
    let primary = null
    try {
      displays = screen.getAllDisplays() || []
    } catch {
      displays = []
    }
    try {
      primary = screen.getPrimaryDisplay()
    } catch {
      primary = null
    }
    return displays.map((display, index) => {
      const descriptor = describeDisplayForRegion(display)
      const width = descriptor.pixelSize.width
      const height = descriptor.pixelSize.height
      return {
        id: String(display?.id ?? ''),
        name: displayNameOf(display),
        width,
        height,
        scaleFactor: Number(display?.scaleFactor) || 1,
        primary: primary?.id === display?.id,
        // Flat, translation-free label (numbers + the multiplication sign). The workbench may
        // render its own i18n label from the fields above; this one is for compact lists.
        label: `${index + 1} · ${width}×${height}`
      }
    })
  }

  function workbenchConfig() {
    const settings = getSettings() || {}
    const record = settings.record || {}
    return {
      mode: RECORD_MODES.includes(record.lastMode) ? record.lastMode : DEFAULT_RECORD_MODE,
      displayId: text(record.lastDisplayId),
      frameRate: normalizeFrameRate(record.frameRate),
      quality: normalizeQuality(record.quality),
      countdown: normalizeCountdown(record.countdown),
      audioSystem: record.audioSystem !== false,
      audioMicrophone: record.audioMicrophone === true,
      audioMicrophoneDeviceId: text(record.audioMicrophoneDeviceId),
      saveDirectory: text(record.saveDirectory)
    }
  }

  function recentProjects(limit = 8) {
    const service = projectServiceOrNull()
    if (!service) return []
    return service.listProjects({ offset: 0, limit })
      .then((listed) => (Array.isArray(listed?.items) ? listed.items : []))
      .catch((error) => {
        log('Recording project listing failed:', error?.message || error)
        return []
      })
  }

  function projectExportInFlight(projectId) {
    const exportService = optionalExportService()
    if (!exportService || typeof exportService.list !== 'function') return false
    const session = findSessionForProject(projectId)
    if (!session) return false
    try {
      return exportService.list().some((task) => task?.sessionId === session.id && !TERMINAL_TASK_STATES.includes(task?.state))
    } catch (error) {
      log('Recording export listing failed:', error?.message || error)
      return false
    }
  }

  // ---------------------------------------------------------------- domain controllers

  function createRecordingController() {
    const control = {
      ready: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win === recordWindow && win?._recordInit) event.sender.send('record:init', win._recordInit)
      },
      frameReady: (event) => {
        const frame = requireRecordFrameSender(event)
        sendRecordAnnotationCommand(frame._recordOwner)
      },
      frameSnapshot: (event, snapshot = {}) => {
        const frame = requireRecordFrameSender(event)
        const controlWindow = frame._recordOwner
        const bounds = controlWindow._recordInit.selectionBounds
        const clean = sanitizeAnnotationSnapshot(snapshot, { width: bounds.width, height: bounds.height })
        controlWindow.webContents.send('record:annotation-snapshot', clean)
      },
      performance: (event, metrics = {}) => {
        requireRecordSender(event)
        const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(metrics.durationMs) || 0))
        const targetFrameRate = normalizeFrameRate(metrics.targetFrameRate)
        const callbacks = Math.max(0, Math.min(100000000, Math.round(Number(metrics.callbacks) || 0)))
        const renderedFrames = Math.max(0, Math.min(callbacks, Math.round(Number(metrics.renderedFrames) || 0)))
        const skippedCallbacks = Math.max(0, Math.min(callbacks, Math.round(Number(metrics.skippedCallbacks) || 0)))
        const scheduler = metrics.scheduler === 'video-frame' ? 'video-frame' : 'timer'
        performanceMonitor.record('record.compositor', durationMs, {
          targetFrameRate,
          callbacks,
          renderedFrames,
          skippedCallbacks,
          scheduler,
          effectiveFrameRate: durationMs > 0 ? Math.round(renderedFrames * 100000 / durationMs) / 100 : 0
        })
        performanceMonitor.snapshot('record-compositor', { targetFrameRate, scheduler })
      },
      setAnnotationCommand: (event, command = {}) => {
        const controlWindow = requireRecordSender(event)
        return sendRecordAnnotationCommand(controlWindow, command)
      },
      // Contract §10.4: create the persistent project first, then write the session's chunks
      // straight into the project directory. A project is the durable owner of the source; the
      // session is only the writer handle.
      startSession: async (event) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        const service = getRecordingService()
        await cleanupRecordSession(win, service)
        managedRecordingWriters.assertOpen()
        const projectService = requireProjectService()
        const captureConfig = win._recordCaptureConfig || { target: {}, frameRate: 24, quality: 'standard', countdown: 3, audio: {} }
        const projectName = String(makeCaptureName(VIDEO_CAPTURE_PREFIX) || 'Recording').replace(/\.[^.]+$/, '')
        const created = await projectService.createProject({
          mode: captureConfig.target?.mode || DEFAULT_RECORD_MODE,
          captureConfig,
          name: projectName
        })
        let session
        try {
          session = await managedRecordingWriters.track(() => service.startSession({
            directory: created.directory,
            projectId: created.project.id
          }))
        } catch (error) {
          // Nothing was recorded: do not leave a half-created project behind.
          await projectService.deleteProject(created.project.id).catch(() => {})
          win._recordProjectId = ''
          throw error
        }
        win._recordSessionId = session.id
        win._recordProjectId = created.project.id
        // Plan §5.1: the record-mode last region is updated when a recording successfully STARTS, so
        // a cancelled selection never overwrites it. `selectionBounds` on the window's init payload is
        // Electron DIP; recordFromDisplaySelection owns the DIP->pixel conversion.
        const init = win._recordInit || {}
        if (init.selectionBounds) {
          rememberRecordRegion(init.display, init.selectionBounds)
          rememberCaptureConfig(win)
        }
        // R5 §2.2: collection is opt-in, display/region only, and independent from the recorder (a
        // failed track never affects the capture). Events collected before MediaRecorder.start()
        // map to negative media time at finish and are dropped there.
        win._recordStartedAtWall = Date.now()
        startEventTrack(win)
        return { id: session.id, projectId: created.project.id }
      },
      // Contract §10.5: the ACK is the chunk's ordering result; the durable checkpoint is written
      // separately and never blocks the ACK.
      //
      // The sequence is MANDATORY on this channel (contract §9.2/§12: it is what makes replay and
      // gap detection possible). It is forwarded UNCOERCED so the service rejects an invalid value
      // instead of the domain silently disabling gap detection by downgrading it to the legacy
      // unsequenced append. A gap/invalid sequence is an ORDERING result, so it RESOLVES with a
      // code: Electron drops custom properties on a rejected invoke, and the renderer's localized
      // gap notice is driven by the ACK's `lastChunkSequence`/`code`, not by a thrown error.
      appendChunk: async (event, { sessionId, arrayBuffer, sequence } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const service = getRecordingService()
        const chunk = Buffer.from(arrayBuffer || [])
        const chunkSequence = sequence === undefined ? null : sequence
        // The legacy unsequenced append of the SERVICE stays available to its other callers, but the
        // control-bar channel requires a sequence: accepting a chunk without one would disable gap
        // detection for the whole take without any signal.
        if (chunkSequence === null) {
          const session = typeof service.peekSession === 'function' ? service.peekSession(sessionId) : null
          return {
            committedBytes: Number(session?.bytesWritten) || 0,
            sequence: null,
            lastChunkSequence: Number(session?.lastChunkSequence) || 0,
            code: 'invalid-sequence',
            expected: (Number(session?.lastChunkSequence) || 0) + 1,
            received: null
          }
        }
        let ack
        try {
          ack = await managedRecordingWriters.track(service.appendChunk(sessionId, chunk, { sequence: chunkSequence }))
        } catch (error) {
          if (error?.code === 'sequence-gap' || error?.code === 'invalid-sequence') {
            const session = typeof service.peekSession === 'function' ? service.peekSession(sessionId) : null
            const numericSequence = Number(chunkSequence)
            const lastAccepted = Number(session?.lastChunkSequence) || 0
            return {
              committedBytes: Number(session?.bytesWritten) || 0,
              sequence: Number.isSafeInteger(numericSequence) ? numericSequence : null,
              lastChunkSequence: lastAccepted,
              code: error.code,
              // The gap error carries the expected next sequence; an invalid value has no such field,
              // so the next expected sequence is derived from the session state for both codes.
              expected: Number.isSafeInteger(Number(error.expected)) ? Number(error.expected) : lastAccepted + 1,
              received: error.received === undefined ? (sequence === undefined ? null : sequence) : error.received
            }
          }
          // A write failure is a real failure: keep rejecting so the renderer's chunk-failure path
          // (pause + visible error) still runs.
          throw error
        }
        const committedBytes = Number(ack?.committedBytes) || chunk.length
        const lastChunkSequence = Number(ack?.lastChunkSequence) || 0
        const projectId = text(win._recordProjectId)
        const projectService = projectId ? projectServiceOrNull() : null
        if (projectService && typeof projectService.checkpoint === 'function') {
          // Throttled inside the project service; a lost checkpoint only costs recovery precision,
          // so a failure is logged and never fails the recording.
          projectService.checkpoint(projectId, { committedByteOffset: committedBytes, lastChunkSequence })
            .catch((error) => log('Recording checkpoint failed:', projectId, error?.message || error))
        }
        return { committedBytes, sequence: Number(chunkSequence), lastChunkSequence }
      },
      // Contract §10.6: finish the session -> probe -> seal the project -> open the editor ->
      // close the control bar. The project (not the session) owns the source afterwards, so the
      // session is DETACHED rather than cleaned (a cleanup would only drop it from the table for a
      // project-owned directory, but detaching makes the ownership transfer explicit).
      finishSession: async (event, { sessionId, mediaStartedAtWall, pausedIntervals } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const service = getRecordingService()
        const projectId = text(win._recordProjectId)
        const projectService = projectId ? projectServiceOrNull() : null
        let descriptor
        try {
          descriptor = await managedRecordingWriters.track(service.finishSession(sessionId))
        } catch (error) {
          log('Recording finish failed:', error?.message || String(error))
          return { ok: false, code: error?.code || 'finish-failed' }
        }
        if (!projectId || !projectService) {
          // Legacy/no-persistence fallback: the sealed session stays readable for the legacy
          // channels, but there is no project to hand to an editor.
          await stopEventTrack()
          return { ok: true, projectId: '', legacy: true, bytesWritten: Number(descriptor?.bytesWritten) || 0 }
        }
        let probed = { ok: false, code: 'probe-failed' }
        try {
          probed = await managedRecordingWriters.track(service.probeSession(sessionId), { allowBlocked: true })
        } catch (error) {
          log('Recording probe threw:', error?.message || String(error))
        }
        if (!probed?.ok) log('record probe failed:', probed?.code || 'probe-failed')
        // Keep the richer probe result (frameRate / audio codec) for this process: the R1 manifest
        // stores only size/audio-track-count, and the editor needs the frame rate to offer the fps
        // options (R4 §5). After a restart the field is 0 and only `source` is offered.
        if (probed?.ok && probed.metadata) probedMetadataByProject.set(projectId, probed.metadata)
        const sealed = await projectService.sealProject(projectId, {
          metadata: probed?.ok ? probed.metadata : null,
          captureOutcome: captureOutcomeOf(win, probed?.ok ? probed.metadata : null)
        }).catch((error) => {
          log('Recording seal failed:', projectId, error?.message || error)
          return { ok: false, code: 'seal-failed' }
        })
        if (!sealed?.ok && sealed?.code !== 'probe-failed') {
          // The manifest itself could not be written. The sealed session is still on disk and
          // finishSession is idempotent, so the bar can retry or abandon.
          return { ok: false, code: sealed?.code || 'seal-failed' }
        }
        if (typeof service.detachSession === 'function') service.detachSession(sessionId)
        else service.cleanupSession(sessionId).catch(() => {})
        win._recordSessionId = ''
        win._recordProjectId = ''
        // R5 §2.2: map the wall-clock pointer track to media time and persist events.json. The
        // renderer supplies the MediaRecorder start wall clock and the pause intervals; the probed
        // duration is the only authority for the upper bound. A missing/failed track is log-only and
        // never fails the recording.
        const trackTiming = {
          mediaStartedAtWall: Number.isFinite(Number(mediaStartedAtWall))
            ? Number(mediaStartedAtWall)
            : Number(win._recordStartedAtWall),
          pausedIntervals,
          durationMs: probed?.ok ? Number(probed.metadata?.durationMs) || 0 : 0
        }
        const collected = await stopEventTrack({ discard: false })
        if (collected) {
          const track = buildEventTrack(win, collected.results, trackTiming)
          if (track) await writeEventTrack(projectId, track)
          else log('Recording event track skipped: unusable timing or content region')
        }
        const opened = await openEditor(projectId).catch((error) => {
          log('Recording editor open failed:', projectId, error?.message || error)
          return { ok: false, code: 'editor-failed' }
        })
        if (!opened?.ok) log('Recording editor did not open:', projectId, opened?.code || 'unknown')
        // Close the bar AFTER this invoke's reply is queued: closing it inline would destroy the
        // sender before the renderer could observe the success.
        setImmediate(() => {
          closeRecordFlow(null, true).catch((error) => log('Recording close failed:', error?.message || error))
        })
        return { ok: true, projectId, recovered: sealed?.ok !== true }
      },
      saveMp4: async (event, { sessionId, durationMs } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const settings = getSettings()
        const directory = settings.record.saveDirectory || app.getPath('videos')
        let result
        win.setAlwaysOnTop(false)
        try {
          result = await dialog.showSaveDialog(win, {
            title: '保存 MP4 录屏',
            defaultPath: path.join(directory, makeCaptureName(VIDEO_CAPTURE_PREFIX).replace('.png', '.mp4')),
            filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
          })
        } finally {
          if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
        }
        if (result.canceled || !result.filePath) return ''
        assertManagedDataWritable()
        const duration = Math.max(1, Number(durationMs) || 1)
        const service = getRecordingService()
        const outputPath = await managedRecordingWriters.track(service.transcode(sessionId, result.filePath, (elapsedMicroseconds) => {
          if (win.isDestroyed()) return
          const percent = calculateTranscodeProgress(elapsedMicroseconds, duration)
          win.webContents.send('record:save-progress', percent)
        }, { audio: !!(settings.record.audioSystem || settings.record.audioMicrophone) }))
        if (!win.isDestroyed()) win.webContents.send('record:save-progress', 100)
        // Feature E (plan §8.3): the legacy channel keeps its `'' | path` return so every
        // existing caller stays correct, but it no longer deletes the source. The recording
        // session (and its window) stay alive; closing the preview is what cleans up.
        return outputPath
      },
      // Feature E2: probe the sealed source for the preview UI. Returns the real duration,
      // dimensions and audio-track presence; `crossCheckMs` is the renderer's own estimate and
      // can only make the probe REFUSE (plan §8.1), never override the file.
      probeSession: async (event, { sessionId, durationMs } = {}) => {
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const service = getRecordingService()
        let result
        try {
          result = await managedRecordingWriters.track(
            service.probeSession(sessionId, { crossCheckMs: Number(durationMs) || null }),
            { allowBlocked: true }
          )
        } catch (error) {
          log('record probe threw:', error?.message || String(error))
          throw error
        }
        if (!result?.ok) {
          // The trim panel is this channel's only caller and a failure disables the entire
          // trim/export feature while "Save MP4" keeps working (it never probes). Record the reason
          // so a field report of "00:00.0, export unavailable" can be diagnosed from app.log -
          // previously the code was returned to the renderer and never logged anywhere.
          log('record probe failed:', result?.code || 'probe-failed', JSON.stringify(result?.detail || null))
          return { ok: false, code: result?.code || 'probe-failed' }
        }
        const metadata = result.metadata
        return {
          ok: true,
          metadata: {
            durationMs: metadata.durationMs,
            startMs: metadata.startMs,
            durationSource: metadata.durationSource,
            timebase: metadata.timebase,
            video: metadata.video,
            audio: metadata.audio
          }
        }
      },
      exportRecording: async (event, payload = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        const source = payload && typeof payload === 'object' ? payload : {}
        const { sessionId, requestId, request } = source
        requireRecordSession(win, sessionId)
        const service = requireExportService()
        const ownerId = exportOwnerId(event.sender)
        if (!ownerId) return { status: 'failed', code: 'invalid-owner' }
        // One in-flight export per window is enforced by the service's queue limits, but the
        // UI also disables re-submission; both are needed because a renderer bug must not be
        // able to flood the encoder.
        const settings = getSettings()
        const directory = settings.record.saveDirectory || app.getPath('videos')
        const format = request?.format === 'gif' ? 'gif' : 'mp4'
        const targetPath = await chooseExportTarget(win, {
          format,
          defaultName: makeCaptureName(VIDEO_CAPTURE_PREFIX),
          defaultDirectory: directory
        })
        // Cancelled save dialog: no task is created at all (plan §8.3).
        if (!targetPath) return { status: 'cancelled' }
        assertManagedDataWritable()
        const submitted = await service.submit({
          sessionId,
          requestId,
          request,
          ownerId,
          targetPath,
          onEvent: (task) => {
            // Push to the SAME window that started the task; a destroyed window stops receiving
            // (there is nothing left to render and the export continues in the main process).
            if (win.isDestroyed()) return
            win.webContents.send('record:export-progress', task)
          }
        })
        if (!submitted?.ok) return { status: 'failed', code: submitted?.code || 'export-failed' }
        return { status: 'accepted', task: submitted.task }
      },
      exportStatus: (event, payload = {}) => {
        const win = requireRecordSender(event)
        const source = payload && typeof payload === 'object' ? payload : {}
        const service = requireExportService()
        const ownerId = exportOwnerId(event.sender)
        if (!ownerId) return { ok: false, code: 'invalid-owner' }
        if (source.sessionId) requireRecordSession(win, source.sessionId)
        return service.status({
          taskId: source.taskId,
          sessionId: source.sessionId,
          requestId: source.requestId,
          ownerId
        })
      },
      cancelExport: async (event, payload = {}) => {
        const win = requireRecordSender(event)
        const source = payload && typeof payload === 'object' ? payload : {}
        const service = requireExportService()
        const ownerId = exportOwnerId(event.sender)
        if (!ownerId) return { ok: false, code: 'invalid-owner' }
        if (source.sessionId) requireRecordSession(win, source.sessionId)
        return service.cancel({ taskId: source.taskId, ownerId })
      },
      // Feature E1: closing the preview ends the SOURCE session. An export that still holds a
      // reference keeps the file alive; the last release removes the directory (plan §8.3).
      closePreview: async (event, { sessionId } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        win._recordSessionId = null
        const service = getRecordingService()
        await managedRecordingWriters.track(service.cleanupSession(sessionId))
        return true
      },
      cancelSession: async (event, { sessionId } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        win._recordSessionId = ''
        // R5 §2.2: an abandoned take discards its event track (the project is deleted below).
        await stopEventTrack()
        const projectId = text(win._recordProjectId)
        win._recordProjectId = ''
        const service = getRecordingService()
        await managedRecordingWriters.track(service.cleanupSession(sessionId))
        if (projectId) {
          const projectService = projectServiceOrNull()
          if (projectService) {
            // "Abandon this take": the project (its directory and partial source) is deleted, not
            // left as a recoverable record the user explicitly discarded.
            await projectService.deleteProject(projectId).catch((error) => {
              log('Recording project delete failed:', projectId, error?.message || error)
            })
          }
        }
        // Contract §9.2: `{ ok: true }` (the renderer awaits the invoke; a bare boolean was the
        // pre-R2 shape and is not part of the frozen contract).
        return { ok: true }
      },
      setFrameState: (event, state = 'idle') => {
        const controlWindow = requireRecordSender(event)
        const frame = recordFrameWindow
        if (!frame || frame.isDestroyed()) return false
        controlWindow._recordFrameState = ['recording', 'paused'].includes(state) ? state : 'idle'
        sendRecordAnnotationCommand(controlWindow)
        if (state === 'hidden') {
          restoreRecordFramePassthrough(frame)
          frame.hide()
        } else {
          frame.showInactive()
          frame.webContents.send('record-frame:state', ['recording', 'paused'].includes(state) ? state : 'idle')
        }
        return true
      },
      resizePreview: (event) => {
        const win = requireRecordSender(event)
        const display = screen.getDisplayMatching(win._recordInit.selectionBounds)
        const width = Math.min(760, display.workArea.width)
        const height = Math.min(560, display.workArea.height)
        win.setBounds({
          x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
          y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
          width,
          height
        }, false)
        return true
      },
      restart: async (event, { sessionId } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        if (sessionId) requireRecordSession(win, sessionId)
        await stopEventTrack()
        await abandonProjectCapture(win, 'restarted')
        await cleanupRecordSession(win, getRecordingService())
        win.setBounds(win._recordControlBounds, false)
        if (recordFrameWindow && !recordFrameWindow.isDestroyed()) {
          win._recordFrameState = 'idle'
          const resetVersion = Number(win._recordAnnotationCommand?.resetVersion || 0) + 1
          sendRecordAnnotationCommand(win, { action: 'reset', resetVersion })
          restoreRecordFramePassthrough(recordFrameWindow)
          recordFrameWindow.showInactive()
          recordFrameWindow.webContents.send('record-frame:state', 'idle')
        }
        return true
      },
      close: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win !== recordWindow) return
        closeRecordFlow().catch((error) => log('Recording close failed:', error.message))
      },
      // R2 (contracts §9.2): the pull fallback for a lost `record:state-changed` push.
      getState: (event) => {
        const win = requireRecordSender(event)
        return { ...(win._recordState || DEFAULT_STATE) }
      },
      // R2 (contracts §9.2): the renderer's authoritative state report. Ownership is checked
      // softly: a finalizing session may already have cleared the window's session handle, and a
      // stale push must never surface as an IPC error in the renderer.
      state: (event, payload = {}) => {
        const win = requireRecordSender(event)
        const sessionId = text(payload.sessionId)
        if (sessionId && win._recordSessionId && sessionId !== win._recordSessionId) return win._recordState || DEFAULT_STATE
        return updateRecordState(win, payload) || DEFAULT_STATE
      },
      // R2 (contracts §9.2): closes the loop for a tray/shortcut command. A failed command is
      // logged so a field report of "the tray pause did nothing" is diagnosable.
      commandResult: (event, payload = {}) => {
        const win = requireRecordSender(event)
        const requestId = text(payload.requestId)
        const requests = win._recordCommands
        if (requestId && requests && requests.has(requestId)) {
          const request = requests.get(requestId)
          request.status = payload.ok === true ? 'ok' : 'failed'
          request.code = text(payload.code)
          request.finishedAt = Date.now()
        }
        if (payload.state) updateRecordState(win, payload.state)
        // Push the POST-command cached state (contract §9.2): the renderer's version guard adopts
        // a newer version and ignores a stale/equal one, so this repairs a lost command/state push
        // without ever rolling the bar back.
        if (win._recordState && !win.isDestroyed()) win.webContents.send('record:state-changed', win._recordState)
        if (payload.ok !== true) log('Recording command refused:', text(payload.code) || 'unknown')
        return true
      },

      // ------------------------------------------------------------ workbench (main window)
      workbenchState: async () => {
        const recent = await recentProjects(8)
        return {
          config: workbenchConfig(),
          displays: listWorkbenchDisplays(),
          active: activeRecordingState(),
          recent
        }
      },
      // R4 §2.1: the recordable-window list. Tokens are opaque, single-use and short-lived; the
      // desktopCapturer source id never appears in the payload.
      workbenchWindows: async () => listRecordableWindows(),
      workbenchStart: async (_event, payload = {}) => {
        assertGameModeDisabled()
        assertManagedDataWritable()
        // Contract §10.1: a second entry never replaces the capture in progress.
        if (isTaskActive()) {
          focusActive()
          return { ok: true, focused: true }
        }
        const requestedMode = payload && typeof payload === 'object' ? payload.mode : ''
        const config = payload && typeof payload === 'object' ? payload.config : null
        const mode = RECORD_MODES.includes(requestedMode) ? requestedMode : workbenchConfig().mode
        const payloadCapture = readCapturePayload(config)
        if (mode === 'window') {
          // R4 §2.1 start-time validation codes. A missing token is the workbench's own guard
          // (the Start button is disabled), the other two come from the main-process registry.
          const windowToken = text(payload?.windowToken)
          if (!windowToken) return { ok: false, code: 'window-required' }
          try {
            await createRecordWindow({
              mode: 'window',
              windowToken,
              displayId: text(payload?.displayId),
              capture: payloadCapture
            })
          } catch (error) {
            const code = error?.code === 'window-unavailable' || error?.code === 'window-too-small'
              ? error.code
              : 'start-failed'
            log('Recording window start failed:', code, error?.message || error)
            return { ok: false, code }
          }
          return { ok: true }
        }
        if (mode === 'region') {
          const openSelection = workbench.createRegionSelection
          if (typeof openSelection !== 'function') return { ok: false, code: 'region-unavailable' }
          // The overlay returns only a rectangle; the workbench's just-picked parameters travel
          // through the one-shot slot createRecordWindow() consumes, together with the region mode
          // (the overlay itself calls createRecordWindow without a mode).
          pendingRegionCapture = { capture: payloadCapture, mode: 'region', at: Date.now() }
          try {
            await openSelection({ mode: 'region', source: 'recording-workbench' })
          } catch (error) {
            pendingRegionCapture = null
            log('Recording region selection failed:', error?.message || error)
            return { ok: false, code: 'selection-failed' }
          }
          return { ok: true }
        }
        try {
          await createRecordWindow({ display: resolveDisplay(payload?.displayId), mode, capture: payloadCapture })
        } catch (error) {
          log('Recording start failed:', error?.message || error)
          return { ok: false, code: 'start-failed' }
        }
        return { ok: true }
      },
      workbenchFocus: () => {
        // Contract §9.1: bring the control bar forward while a capture is running.
        const focused = focusActive()
        return { ok: focused }
      },
      projectList: async (_event, payload = {}) => {
        const service = projectServiceOrNull()
        if (!service) return { items: [], total: 0, offset: 0, limit: 0, code: 'project-service-unavailable' }
        const offset = Math.max(0, Math.trunc(Number(payload?.offset) || 0))
        const limit = Math.min(PROJECT_LIST_LIMIT_MAX, Math.max(1, Math.trunc(Number(payload?.limit) || 20)))
        const listed = await service.listProjects({ offset, limit }).catch((error) => {
          log('Recording project listing failed:', error?.message || error)
          return null
        })
        if (!listed) return { items: [], total: 0, offset, limit, code: 'list-failed' }
        return {
          items: Array.isArray(listed.items) ? listed.items : [],
          total: Number(listed.total) || 0,
          offset: Number(listed.offset) || offset,
          limit: Number(listed.limit) || limit
        }
      },
      projectOpen: async (_event, { projectId } = {}) => {
        const project = await getProject(projectId)
        if (!project) return { ok: false, code: 'not-found' }
        // Contract §9.1: a capture still in progress is busy; a recoverable project MAY open.
        if (project.state === 'capturing') return { ok: false, code: 'project-busy' }
        return openEditor(project.id)
      },
      projectRename: async (_event, { projectId, name } = {}) => {
        const service = projectServiceOrNull()
        if (!service) return { ok: false, code: 'project-service-unavailable' }
        const result = await service.renameProject(text(projectId), name).catch((error) => {
          log('Recording project rename failed:', error?.message || error)
          return { ok: false, code: 'rename-failed' }
        })
        if (!result?.ok) return { ok: false, code: result?.code || 'rename-failed' }
        return { ok: true, project: service.summaryOf(result.project) }
      },
      projectDelete: async (_event, { projectId } = {}) => {
        const service = projectServiceOrNull()
        if (!service) return { ok: false, code: 'project-service-unavailable' }
        const project = await getProject(projectId)
        if (!project) return { ok: false, code: 'not-found' }
        if (project.state === 'capturing') return { ok: false, code: 'busy' }
        // Contract §4.4: an open editor is an editing lease and a running export still reads the
        // source, so neither may be pulled out from under the user.
        if (editorWindowForProject(project.id)) return { ok: false, code: 'busy' }
        if (projectExportInFlight(project.id)) return { ok: false, code: 'busy' }
        const session = findSessionForProject(project.id)
        if (session) {
          await managedRecordingWriters.track(() => getRecordingService().cleanupSession(session.id), { allowBlocked: true })
            .catch((error) => log('Recording session release failed:', error?.message || error))
        }
        const deleted = await service.deleteProject(project.id).catch((error) => {
          log('Recording project delete failed:', project.id, error?.message || error)
          return { ok: false, code: 'delete-failed' }
        })
        // The in-process probe stash dies with the project (no manifest to describe any more).
        if (deleted?.ok) probedMetadataByProject.delete(project.id)
        return deleted?.ok ? { ok: true } : { ok: false, code: deleted?.code || 'delete-failed' }
      },
      projectReveal: async (_event, { projectId } = {}) => {
        const service = projectServiceOrNull()
        if (!service) return { ok: false, code: 'project-service-unavailable' }
        // Main-process owned path: the renderer names a project id, never a directory.
        const sourcePath = await service.sourcePathOf(text(projectId)).catch(() => '')
        if (!sourcePath) return { ok: false, code: 'not-found' }
        if (typeof workbench.shell?.showItemInFolder !== 'function') return { ok: false, code: 'unavailable' }
        workbench.shell.showItemInFolder(sourcePath)
        return { ok: true }
      },

      // ------------------------------------------------------------ editor (record-editor window)
      editorReady: (event) => {
        const win = requireEditorSender(event)
        if (win._recordEditorInit) event.sender.send('record-editor:init', win._recordEditorInit)
      },
      editorClose: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed() || !ownsEditorWindow(win)) return
        win.close()
      },
      editorWindow: (event, payload = {}) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed() || !ownsEditorWindow(win)) return false
        const action = text(payload?.action)
        if (action === 'minimize') win.minimize()
        else if (action === 'close') win.close()
        return true
      },
      // Contract §9.3: compare-and-set draft write. A stale expectedRevision never overwrites a
      // newer editor's work; the rejection carries the current project so the editor can reload.
      editorSaveDraft: async (event, { projectId, expectedRevision, edit } = {}) => {
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, projectId)
        const service = requireProjectService()
        const result = await service.updateDraft(id, {
          expectedRevision: Number(expectedRevision),
          edit: sanitizeDraftEdit(edit)
        }).catch((error) => {
          log('Recording draft save failed:', id, error?.message || error)
          return { ok: false, code: 'save-failed' }
        })
        if (result?.ok) return { ok: true, revision: result.revision }
        if (result?.code === 'revision-conflict') {
          const current = await getProject(id)
          return {
            ok: false,
            code: 'revision-conflict',
            revision: Number(result.revision) || Number(current?.edit?.revision) || 0,
            project: current ? service.publicProject(current) : null
          }
        }
        return { ok: false, code: result?.code || 'save-failed' }
      },
      // Contract §9.3: the ONE export entry point. The target path comes from a main-process save
      // dialog and the request carries a range/format only - no path can be smuggled in.
      editorExport: async (event, payload = {}) => {
        assertManagedDataWritable()
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, payload.projectId)
        const requestId = text(payload.requestId).slice(0, 128)
        if (!requestId) return { status: 'failed', code: 'invalid-request' }
        const request = payload.request && typeof payload.request === 'object' && !Array.isArray(payload.request) ? payload.request : {}
        // R4 §4.1: WebM is the third export format; the editor no longer maps it to MP4.
        const format = request.format === 'gif' ? 'gif' : (request.format === 'mp4' ? 'mp4' : (request.format === 'webm' ? 'webm' : ''))
        if (!format) return { status: 'failed', code: 'unsupported-format' }
        const service = projectServiceOrNull()
        if (!service) return { status: 'failed', code: 'project-service-unavailable' }
        const project = await getProject(id)
        if (!project) return { status: 'failed', code: 'not-found' }
        // Contract §4.3/§11: a recoverable project must not export - there is no verified duration
        // to honour, and a fake success would be worse than a visible error.
        if (project.state !== 'ready') return { status: 'failed', code: 'not-ready' }
        const exportService = requireExportService()
        const ownerId = exportOwnerId(event.sender)
        if (!ownerId) return { status: 'failed', code: 'invalid-owner' }
        const attached = await ensureProjectSession(project).catch((error) => {
          log('Recording project attach failed:', id, error?.message || error)
          return null
        })
        if (!attached) return { status: 'failed', code: 'source-unavailable' }
        const settings = getSettings()
        const targetPath = await chooseExportTarget(win, {
          format,
          defaultName: safeFileStem(project.name) || 'Recording',
          defaultDirectory: settings.record.saveDirectory || app.getPath('videos'),
          alwaysOnTop: false
        })
        if (!targetPath) return { status: 'cancelled' }
        assertManagedDataWritable()
        const editRevision = Math.max(1, Math.round(Number(project.edit?.revision) || 1))
        // R4 §4.1/§5 + R5 §3.2: forward the frozen request keys VERBATIM - the export service owns
        // normalization and validation (`range` vs `segments` ambiguity, segment limits, resolution
        // and fps rules, demo style/zoom/click mapping). The domain only chooses the format and
        // freezes the target, so dropping segments/video/demo here would silently export the whole
        // source at source quality with no demo rendering.
        const forwardedRequest = { format }
        if (Array.isArray(request.segments)) forwardedRequest.segments = request.segments
        if (request.range && typeof request.range === 'object' && !Array.isArray(request.range)) forwardedRequest.range = request.range
        if (request.gif && typeof request.gif === 'object' && !Array.isArray(request.gif)) forwardedRequest.gif = request.gif
        if (request.video && typeof request.video === 'object' && !Array.isArray(request.video)) forwardedRequest.video = request.video
        // R5 §3.2: the demo look/camera plan (style + source-time zooms + clicks for ripples).
        if (request.demo && typeof request.demo === 'object' && !Array.isArray(request.demo)) forwardedRequest.demo = request.demo
        const submitted = await exportService.submit({
          sessionId: attached.session.id,
          requestId,
          request: forwardedRequest,
          ownerId,
          targetPath,
          onEvent: (task) => {
            if (!win.isDestroyed()) win.webContents.send('record:export-progress', task)
            if (task?.state === 'succeeded') recordProjectExport(id, task, format, targetPath, editRevision)
            // A terminal task is the last reader of the source: if the editor window was closed
            // while it ran, this is when the deferred session detach can finally happen.
            if (TERMINAL_TASK_STATES.includes(task?.state)) releaseProjectSession(id)
          }
        })
        if (!submitted?.ok) return { status: 'failed', code: submitted?.code || 'export-failed' }
        return { status: 'accepted', task: submitted.task }
      },
      // Contract §9.3: task lookup by (taskId | requestId | projectId), owner-scoped so one
      // editor window cannot read another window's export.
      editorExportStatus: async (event, payload = {}) => {
        const win = requireEditorSender(event)
        const exportService = requireExportService()
        const ownerId = exportOwnerId(event.sender)
        if (!ownerId) return { ok: false, code: 'invalid-owner' }
        let sessionId = ''
        const projectId = text(payload?.projectId)
        if (projectId) {
          const id = requireEditorProject(win, projectId)
          sessionId = findSessionForProject(id)?.id || ''
        }
        return exportService.status({
          taskId: text(payload?.taskId),
          sessionId,
          requestId: text(payload?.requestId),
          ownerId
        })
      },
      editorCancelExport: async (event, payload = {}) => {
        requireEditorSender(event)
        const exportService = requireExportService()
        const ownerId = exportOwnerId(event.sender)
        if (!ownerId) return { ok: false, code: 'invalid-owner' }
        return exportService.cancel({ taskId: text(payload?.taskId), ownerId })
      },
      editorRename: async (event, { projectId, name } = {}) => {
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, projectId)
        const service = requireProjectService()
        const result = await service.renameProject(id, name).catch((error) => {
          log('Recording rename failed:', id, error?.message || error)
          return { ok: false, code: 'rename-failed' }
        })
        if (!result?.ok) return { ok: false, code: result?.code || 'rename-failed' }
        return { ok: true, project: service.summaryOf(result.project) }
      },
      // Contract §9.3: create a NEW take with the same capture configuration; the old project is
      // untouched (its source stays in the records).
      editorRerecord: async (event, { projectId } = {}) => {
        assertGameModeDisabled()
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, projectId)
        const project = await getProject(id)
        if (!project) return { ok: false, code: 'not-found' }
        const capture = project.captureConfig || {}
        const target = capture.target || {}
        closeEditorWindow(id)
        try {
          if (project.mode === 'region' && Number(target.boundsDip?.width) > 0) {
            await createRecordWindow({
              display: resolveDisplay(target.displayId),
              mode: 'region',
              selectionBounds: target.boundsDip,
              capture
            })
          } else {
            await createRecordWindow({ display: resolveDisplay(target.displayId), mode: 'display', capture })
          }
        } catch (error) {
          log('Recording re-record failed:', id, error?.message || error)
          return { ok: false, code: 'create-failed' }
        }
        return { ok: true }
      },
      editorReveal: async (event, { projectId } = {}) => {
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, projectId)
        const service = requireProjectService()
        const sourcePath = await service.sourcePathOf(id).catch(() => '')
        if (!sourcePath) return { ok: false, code: 'not-found' }
        if (typeof workbench.shell?.showItemInFolder !== 'function') return { ok: false, code: 'unavailable' }
        workbench.shell.showItemInFolder(sourcePath)
        return { ok: true }
      },
      // Contract §11: closing the editor only closes the window (the draft is already saved by the
      // renderer's debounce/flush); the workbench is brought back in front.
      editorBack: (event) => {
        const win = requireEditorSender(event)
        const projectId = text(win._recordProjectId)
        if (projectId) closeEditorWindow(projectId)
        openRecordingWorkbench()
        return { ok: true }
      },
      // Additive (approved 2026-11-03): re-probe the source and re-derive the file URL. Serves the
      // recovery banner's "retry" and the draft revision-conflict reload.
      editorReload: async (event, { projectId } = {}) => {
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, projectId)
        const service = requireProjectService()
        let project = await getProject(id)
        if (!project) return { ok: false, code: 'not-found' }
        if (project.state === 'capturing') return { ok: false, code: 'project-busy' }
        if (project.state === 'recoverable') project = (await attemptProjectRecovery(project)) || project
        const payload = await editorInitPayload(project).catch((error) => {
          log('Recording editor reload failed:', id, error?.message || error)
          return null
        })
        if (!payload) return { ok: false, code: 'source-unavailable' }
        win._recordEditorInit = payload
        return { ok: true, ...payload }
      },
      // R5 §2.2: the editor's event track (zoom suggestions / click ripples). Data only - the
      // read goes through the project service, so no path is ever derived in the renderer. A
      // missing reader (an older persistence service) answers `track: null`, which the editor
      // already treats as "no event track, manual zoom only" (§4.2/§7.1).
      editorEvents: async (event, { projectId } = {}) => {
        const win = requireEditorSender(event)
        const id = requireEditorProject(win, projectId)
        const service = projectServiceOrNull()
        if (!service) return { ok: false, code: 'project-service-unavailable' }
        // Contract §2.2: an unknown project answers a code; a known project without a track answers
        // `track: null` (window-mode take, demoEnhance off, or the atomic write failed).
        const project = await getProject(id)
        if (!project) return { ok: false, code: 'not-found' }
        if (typeof service.readEventTrack !== 'function') return { ok: true, track: null }
        const track = await Promise.resolve(service.readEventTrack(id)).catch((error) => {
          log('Recording event track read failed:', id, error?.message || error)
          return null
        })
        return { ok: true, track: track && typeof track === 'object' ? track : null }
      }
    }
    return control
  }

  // Shape-only sanitising for a draft write: the schema/draft normalizer owns the real rules, but
  // the main process must never accept an arbitrary object tree from a renderer and persist it.
  function sanitizeDraftEdit(value) {
    const edit = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const sanitized = {}
    if (Array.isArray(edit.keepRanges)) {
      sanitized.keepRanges = edit.keepRanges.slice(0, 64).map((range) => ({
        id: text(range?.id).slice(0, 64),
        startMs: Math.max(0, Math.round(Number(range?.startMs) || 0)),
        endMs: Math.max(0, Math.round(Number(range?.endMs) || 0))
      }))
    }
    if (edit.format === 'mp4' || edit.format === 'gif' || edit.format === 'webm') sanitized.format = edit.format
    if (edit.gif && typeof edit.gif === 'object' && !Array.isArray(edit.gif)) {
      sanitized.gif = {
        edge: Math.max(0, Math.round(Number(edit.gif.edge) || 0)),
        fps: Math.max(0, Math.round(Number(edit.gif.fps) || 0))
      }
    }
    // R5 §4.1: the demo look and the SOURCE-TIME zoom segments live in the draft
    // (`edit.style` / `edit.zoomSegments`). The project schema normalizes both through
    // shared/recording-demo.js (style defaults, zoom limits/overlap/easing), so the domain only
    // bounds the accepted shape - dropping them here makes a webm/demo edit revert on reload.
    if (edit.style && typeof edit.style === 'object' && !Array.isArray(edit.style)) {
      sanitized.style = edit.style
    }
    if (Array.isArray(edit.zoomSegments)) {
      // The schema clamps to the frozen 8-segment maximum; the slice keeps a runaway renderer from
      // pushing an unbounded array over IPC into a CAS manifest write.
      sanitized.zoomSegments = edit.zoomSegments.slice(0, 8)
    }
    return sanitized
  }

  // Quick "record a region now" entry (contract §4.1 shortcut entries): opens the capture overlay
  // with the persisted capture configuration. The overlay calls createRecordWindow() itself once a
  // rectangle is confirmed, so nothing is recorded until the user picks an area.
  //
  // Repeat-entry arbitration (contract §10.1): while a capture is already active the quick entry
  // must NOT open a selection overlay - createRecordWindow() would discard the picked rectangle
  // because the active control bar wins. Focus the running bar and answer like workbenchStart does.
  function startRegionRecording() {
    if (isTaskActive()) {
      focusActive()
      return Promise.resolve({ ok: true, focused: true })
    }
    const openSelection = workbench.createRegionSelection
    if (typeof openSelection !== 'function') return Promise.resolve({ ok: false, code: 'region-unavailable' })
    try {
      return Promise.resolve(openSelection({ mode: 'region', source: 'record-quick-region' }))
        .then(() => ({ ok: true }), (error) => {
          log('Recording region selection failed:', error?.message || error)
          return { ok: false, code: 'selection-failed' }
        })
    } catch (error) {
      log('Recording region selection failed:', error?.message || error)
      return Promise.resolve({ ok: false, code: 'selection-failed' })
    }
  }

  async function disposeRecordingResources() {
    // Feature E (plan §8.4): cancel and reap export tasks FIRST. A running ffmpeg holds a
    // source reference, so removing the session directory before the child exits would leave
    // an encoder writing into a deleted path; disposing the export service cancels the tasks
    // and waits (bounded) for the children to be gone.
    const exportService = typeof getRecordingExportService === 'function' ? getRecordingExportService() : null
    if (exportService && typeof exportService.dispose === 'function') {
      await exportService.dispose().catch((error) => log('Recording export shutdown failed:', error?.message || error))
    }
    // R5 §2.2: the event track host is a utility process; stop it (discard) and dispose the service
    // so no child or timer outlives the app.
    await stopEventTrack().catch((error) => log('Pointer track stop failed:', error?.message || error))
    if (pointerTrackService && typeof pointerTrackService.dispose === 'function') {
      try { pointerTrackService.dispose() } catch (error) { log('Pointer track dispose failed:', error?.message || error) }
    }
    pointerTrackService = null
    const activeService = typeof peekRecordingService === 'function'
      ? peekRecordingService()
      : null
    await closeRecordFlow(activeService, true)
    for (const projectId of [...editorWindows.keys()]) closeEditorWindow(projectId)
    // Flush every throttled project checkpoint BEFORE the sessions are released: a manifest
    // write after `dispose()` would point at a source the session no longer tracks.
    const projectService = projectServiceOrNull()
    if (projectService && typeof projectService.dispose === 'function') {
      await projectService.dispose().catch((error) => log('Recording project shutdown failed:', error?.message || error))
    }
    if (activeService) await activeService.dispose()
  }

  // `timeoutMs` is the exit path's bounded wait (plan R1 "exit safety", contract §10): app quit
  // needs the checkpoint flush and the ffmpeg reaping, but a wedged child must not hang the app.
  // A timed-out call resolves `{ timedOut: true }` while the cleanup keeps running in the
  // background; the migration path calls this WITHOUT a timeout and awaits it fully.
  function shutdown({ timeoutMs = 0 } = {}) {
    const run = disposeRecordingResources()
    const cap = Math.max(0, Math.round(Number(timeoutMs) || 0))
    if (!cap) return run
    run.catch((error) => log('Recording shutdown failed:', error?.message || error))
    return Promise.race([
      run.then(() => ({ ok: true, timedOut: false })),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), cap)
        timer.unref?.()
      })
    ])
  }

  return {
    isTaskActive,
    ownsControlWindow,
    ownsFrameWindow,
    ownsEditorWindow,
    createRecordWindow,
    cleanupRecordSession,
    closeRecordFlow,
    restoreRecordFramePassthrough,
    createRecordingController,
    openEditor,
    openRecordingWorkbench,
    startRegionRecording,
    getActiveState: () => activeRecordingState(),
    pauseResumeActive,
    finishActive,
    focusActive,
    shutdown
  }
}

module.exports = {
  createRecordDomain,
  createRecordingProjectRef
}
