'use strict'

// Recording-project manifest schema (recording workbench R1).
//
// Frozen contract: docs/plans/2026-11-03-recording-r1-r3-contracts.md §7. One module
// owns the manifest shape and the two public projections so the persistence service,
// the IPC layer and the renderers cannot drift apart on field names or on what may
// leave the main process.
//
// This module is PURE on purpose: no fs, no clock, no paths, no Electron. Callers
// pass values in and get normalized values (or projections) out. The persistence
// service is the only place that touches disk and the only place that resolves the
// absolute project directory; everything here talks about a project directory only
// through relative file names.
//
// Loaded two ways, exactly like the other shared modules:
//   * `require('../shared/recording-project-schema')` from node / main / tests;
//   * a classic <script> in a window (CSP forbids module loading over the network).
//
// Invariants enforced by the projections:
//   1. ProjectSummary / ProjectPublic NEVER contain an absolute path, a project
//      directory, or an export targetPath. `source.fileName` is a single relative
//      file name and is not even projected - only mediaKind/mimeType/bytes are.
//   2. `schemaVersion` is always 1. A future shape change MUST bump it and add a
//      migration; silently accepting a newer version here would corrupt the manifest
//      on the next write.
//   3. Times are integer milliseconds on the real media timeline. `keepRanges` are
//      half-open [startMs, endMs). An empty keepRanges array means "the whole source".

;(function initRecordingProjectSchema(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordingProjectSchema = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const SCHEMA_VERSION = 1
  const PROJECT_FILE_NAME = 'project.json'
  const SOURCE_FILE_NAME = 'capture.webm'
  const DEFAULT_SOURCE_MIME = 'video/webm'
  const DEFAULT_PROJECT_NAME = 'Recording'
  const NAME_MAX_LENGTH = 120
  const ERROR_CODE_MAX_LENGTH = 64
  const MAX_EXPORTS = 100
  const MAX_MICROPHONE_DEVICE_ID_LENGTH = 256
  const DEFAULT_GIF_EDGE = 1280
  const DEFAULT_GIF_FPS = 15
  const GIF_FRAME_RATES = Object.freeze([10, 15, 20])
  const GIF_EDGE_MIN = 16
  const GIF_EDGE_MAX = 1280
  const DEFAULT_TIME_BASE = 1000

  // Lifecycle from the upstream plan §5.2: capturing -> ready/recoverable ->
  // deleting -> deleted. Only capturing/ready/recoverable are produced by R1.
  const PROJECT_STATES = Object.freeze(['capturing', 'ready', 'recoverable', 'deleting', 'deleted'])
  // States in which an editor may still open the project (capturing is busy).
  const EDITABLE_STATES = Object.freeze(['ready', 'recoverable'])
  const PROJECT_MODES = Object.freeze(['display', 'region'])
  const EXPORT_FORMATS = Object.freeze(['mp4', 'gif'])
  // Mirrors QUALITY_LEVELS in shared/recording-quality.js (frozen contract §4).
  // Duplicated instead of required so this module stays a dependency-free classic
  // script; a mismatch would be caught by the contract test that reads both files.
  const QUALITY_LEVELS = Object.freeze(['standard', 'high', 'ultra'])
  const COUNTDOWN_OPTIONS = Object.freeze([0, 3, 5])
  const DEFAULT_QUALITY = 'standard'
  const DEFAULT_COUNTDOWN = 3
  const DEFAULT_FRAME_RATE = 30

  // A project id names a directory. Keep it to one safe segment so a caller can never
  // turn an id into a path escape; the service validates again at the fs boundary.
  const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
  // A media file name is a single relative file name inside the project directory.
  const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function numberOr(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  // Non-negative integer milliseconds / byte counts. Never negative, never fractional:
  // a manifest with 1.5 bytes or -1 ms is a bug, not a rounding opportunity.
  function integer(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
    const number = Math.round(numberOr(value, fallback))
    return Math.min(Math.max(number, 0), max)
  }

  function positiveInteger(value, fallback) {
    const number = integer(value, fallback)
    return number >= 1 ? number : fallback
  }

  function booleanOr(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback
  }

  function text(value, maxLength = NAME_MAX_LENGTH) {
    if (typeof value !== 'string') return ''
    return value.replace(CONTROL_CHARACTERS, '').trim().slice(0, maxLength)
  }

  function finiteNumberOr(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function normalizeMode(value) {
    return PROJECT_MODES.includes(value) ? value : 'display'
  }

  function normalizeState(value) {
    // An unreadable state is never promoted to `ready` (that would make a broken
    // project look exportable); `recoverable` is the safe "needs attention" default.
    return PROJECT_STATES.includes(value) ? value : 'recoverable'
  }

  function normalizeQuality(value) {
    return QUALITY_LEVELS.includes(value) ? value : DEFAULT_QUALITY
  }

  function normalizeCountdown(value) {
    return COUNTDOWN_OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_COUNTDOWN
  }

  function normalizeFrameRate(value) {
    const frameRate = Math.round(numberOr(value, DEFAULT_FRAME_RATE))
    return frameRate >= 1 && frameRate <= 240 ? frameRate : DEFAULT_FRAME_RATE
  }

  function normalizeGain(value) {
    const gain = finiteNumberOr(value, 1)
    return Math.round(Math.min(Math.max(gain, 0), 8) * 1000) / 1000
  }

  function normalizeMicrophoneDeviceId(value) {
    return text(value, MAX_MICROPHONE_DEVICE_ID_LENGTH)
  }

  function normalizeName(value) {
    const name = text(value, NAME_MAX_LENGTH)
    return name || DEFAULT_PROJECT_NAME
  }

  // Returns '' for anything that is not a plain single-segment relative file name.
  // Absolute paths, drive letters, separators, dot segments and control characters
  // are all rejected rather than repaired into a different path.
  function normalizeFileName(value, fallback = SOURCE_FILE_NAME) {
    const candidate = typeof value === 'string' ? value.trim() : ''
    return FILE_NAME_PATTERN.test(candidate) ? candidate : fallback
  }

  // A user-visible EXPORT file name (chosen in a save dialog) is display data, not an
  // input path - the main process keeps the real path in `targetPath`. Spaces and
  // non-ASCII names are legitimate here; only separators (which would make it look
  // like a path) and control characters are removed.
  function normalizeDisplayFileName(value, fallback = '') {
    if (typeof value !== 'string') return fallback
    const cleaned = value.replace(CONTROL_CHARACTERS, '').trim().slice(0, 255)
    if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.includes('/') || cleaned.includes('\\')) {
      return fallback
    }
    return cleaned
  }

  function isValidProjectId(value) {
    return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
  }

  function normalizeErrorCode(value) {
    const code = text(value, ERROR_CODE_MAX_LENGTH)
    return code.replace(/[^A-Za-z0-9._-]/g, '')
  }

  function normalizeBounds(value) {
    const bounds = isPlainObject(value) ? value : {}
    return {
      x: Math.round(numberOr(bounds.x, 0)),
      y: Math.round(numberOr(bounds.y, 0)),
      width: Math.round(Math.max(numberOr(bounds.width, 0), 0)),
      height: Math.round(Math.max(numberOr(bounds.height, 0), 0))
    }
  }

  function normalizePixelSize(value) {
    const size = isPlainObject(value) ? value : {}
    return {
      width: Math.round(Math.max(numberOr(size.width, 0), 0)),
      height: Math.round(Math.max(numberOr(size.height, 0), 0))
    }
  }

  function normalizeCaptureTarget(value) {
    const target = isPlainObject(value) ? value : {}
    return {
      mode: normalizeMode(target.mode),
      displayId: text(target.displayId, 128),
      displayName: text(target.displayName, 128),
      boundsDip: normalizeBounds(target.boundsDip),
      pixelSize: normalizePixelSize(target.pixelSize),
      scaleFactor: Math.round(Math.min(Math.max(numberOr(target.scaleFactor, 1), 0.5), 8) * 1000) / 1000
    }
  }

  function normalizeCaptureAudio(value) {
    const audio = isPlainObject(value) ? value : {}
    return {
      system: booleanOr(audio.system, false),
      microphone: booleanOr(audio.microphone, false),
      microphoneDeviceId: normalizeMicrophoneDeviceId(audio.microphoneDeviceId),
      systemGain: normalizeGain(audio.systemGain),
      microphoneGain: normalizeGain(audio.microphoneGain)
    }
  }

  function normalizeCaptureConfig(value) {
    const config = isPlainObject(value) ? value : {}
    return {
      target: normalizeCaptureTarget(config.target),
      frameRate: normalizeFrameRate(config.frameRate),
      quality: normalizeQuality(config.quality),
      countdown: normalizeCountdown(config.countdown),
      audio: normalizeCaptureAudio(config.audio)
    }
  }

  function normalizeSource(value, fallbackFileName = SOURCE_FILE_NAME) {
    const source = isPlainObject(value) ? value : {}
    return {
      assetId: text(source.assetId, 64) || 'capture',
      fileName: normalizeFileName(source.fileName, fallbackFileName),
      mediaKind: text(source.mediaKind, 32) || 'video',
      mimeType: text(source.mimeType, 64) || DEFAULT_SOURCE_MIME,
      bytes: integer(source.bytes, 0)
    }
  }

  function normalizeMedia(value) {
    const media = isPlainObject(value) ? value : {}
    const video = isPlainObject(media.video) ? media.video : {}
    const audio = isPlainObject(media.audio) ? media.audio : {}
    return {
      durationMs: integer(media.durationMs, 0),
      video: normalizePixelSize(video),
      audio: {
        tracks: integer(audio.tracks, 0, 64),
        codec: text(audio.codec, 32)
      },
      timebase: positiveInteger(media.timebase, DEFAULT_TIME_BASE),
      probedAt: integer(media.probedAt, 0)
    }
  }

  // Converts the MediaProbe metadata shape (main/services/recording-probe.js) into
  // the manifest's media block. Probe failures must pass `null`; a metadata object
  // without a positive duration is NOT a successful probe.
  function mediaFromMetadata(metadata, probedAt = 0) {
    if (!isPlainObject(metadata) || !(numberOr(metadata.durationMs, 0) > 0)) return null
    const video = isPlainObject(metadata.video) ? metadata.video : {}
    const audio = isPlainObject(metadata.audio) ? metadata.audio : {}
    const hasAudio = audio.exists === true || audio.tracks === 1 || audio.tracks === true
    return normalizeMedia({
      durationMs: Math.round(numberOr(metadata.durationMs, 0)),
      video: { width: video.width, height: video.height },
      audio: { tracks: hasAudio ? 1 : 0, codec: hasAudio ? audio.codec : '' },
      timebase: DEFAULT_TIME_BASE,
      probedAt
    })
  }

  function normalizeCaptureOutcome(value) {
    const outcome = isPlainObject(value) ? value : {}
    const audio = isPlainObject(outcome.audio) ? outcome.audio : {}
    const warnings = Array.isArray(outcome.warnings)
      ? outcome.warnings.map((warning) => text(warning, 200)).filter(Boolean).slice(0, 20)
      : []
    return {
      video: booleanOr(outcome.video, false),
      audio: {
        system: booleanOr(audio.system, false),
        microphone: booleanOr(audio.microphone, false)
      },
      warnings
    }
  }

  function normalizeAudioGainSegments(value) {
    if (!Array.isArray(value)) return []
    return value
      .map((entry, index) => {
        const segment = isPlainObject(entry) ? entry : {}
        return {
          id: text(segment.id, 64) || `gain-${index + 1}`,
          startMs: integer(segment.startMs, 0),
          endMs: integer(segment.endMs, 0),
          gain: normalizeGain(segment.gain)
        }
      })
      .filter((segment) => segment.startMs < segment.endMs)
  }

  // `keepRanges` are half-open [startMs, endMs). This normalizer is deliberately
  // conservative: it DROPS entries it cannot prove legal instead of clamping them
  // into a different selection. Array order is sorted by start time.
  //   * empty input (or no legal entry) => [] meaning the whole recording;
  //   * each entry needs 0 <= startMs < endMs;
  //   * with a known duration, endMs must not exceed it;
  //   * sorted, non-overlapping. Multi-segment editing is not in R1, but keeping the
  //     shape legal means a future version can add it without a schema break.
  function normalizeKeepRanges(value, durationMs = 0) {
    if (!Array.isArray(value)) return []
    const duration = integer(durationMs, 0)
    const ranges = []
    for (const entry of value) {
      const range = isPlainObject(entry) ? entry : {}
      const startMs = integer(range.startMs, 0)
      const endMs = integer(range.endMs, 0)
      if (!(startMs < endMs)) continue
      if (duration > 0 && endMs > duration) continue
      ranges.push({
        id: text(range.id, 64) || `keep-${ranges.length + 1}`,
        startMs,
        endMs
      })
    }
    ranges.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const kept = []
    for (const range of ranges) {
      const previous = kept[kept.length - 1]
      if (previous && range.startMs < previous.endMs) continue
      kept.push(range)
    }
    return kept
  }

  function normalizeGifOptions(value) {
    const gif = isPlainObject(value) ? value : {}
    const edge = Math.round(numberOr(gif.edge, DEFAULT_GIF_EDGE))
    const fps = Number(gif.fps)
    return {
      edge: edge >= GIF_EDGE_MIN && edge <= GIF_EDGE_MAX ? edge : DEFAULT_GIF_EDGE,
      fps: GIF_FRAME_RATES.includes(fps) ? fps : DEFAULT_GIF_FPS
    }
  }

  function normalizeEdit(value, durationMs = 0) {
    const edit = isPlainObject(value) ? value : {}
    return {
      revision: positiveInteger(edit.revision, 1),
      keepRanges: normalizeKeepRanges(edit.keepRanges, durationMs),
      format: EXPORT_FORMATS.includes(edit.format) ? edit.format : 'mp4',
      gif: normalizeGifOptions(edit.gif),
      // Reserved for later batches (upstream plan §5.3); normalized to legal empty
      // arrays now so a manifest written by a newer batch is never dropped whole.
      style: isPlainObject(edit.style) ? JSON.parse(JSON.stringify(edit.style)) : null,
      zoomSegments: Array.isArray(edit.zoomSegments) ? JSON.parse(JSON.stringify(edit.zoomSegments)) : [],
      audioGainSegments: normalizeAudioGainSegments(edit.audioGainSegments)
    }
  }

  function normalizeExportEntry(value) {
    const entry = isPlainObject(value) ? value : {}
    const format = EXPORT_FORMATS.includes(entry.format) ? entry.format : 'mp4'
    return {
      exportId: text(entry.exportId, 128).replace(/[^A-Za-z0-9._-]/g, ''),
      format,
      fileName: normalizeDisplayFileName(entry.fileName, ''),
      exportedAt: integer(entry.exportedAt, 0),
      editRevision: positiveInteger(entry.editRevision, 1),
      // Internal-only: the persistence service keeps the real target for reveal /
      // result handling; every public projection drops it.
      targetPath: typeof entry.targetPath === 'string' ? entry.targetPath.slice(0, 4096) : ''
    }
  }

  function normalizeRecovery(value) {
    const recovery = isPlainObject(value) ? value : {}
    return {
      committedByteOffset: integer(recovery.committedByteOffset, 0),
      lastChunkSequence: integer(recovery.lastChunkSequence, 0),
      cleanStop: booleanOr(recovery.cleanStop, false),
      errorCode: normalizeErrorCode(recovery.errorCode)
    }
  }

  // Full manifest normalization. Tolerant by design: a manifest written by an older
  // build or partially corrupted still becomes a usable project instead of throwing,
  // because `listProjects()` has to show the user a recoverable card. Structurally
  // graph-breaking values (an id that escapes its directory) are replaced with safe
  // defaults - the service always pins `id` back to the directory name it read from.
  function normalizeProject(value) {
    const project = isPlainObject(value) ? value : {}
    const media = normalizeMedia(project.media)
    const exports = Array.isArray(project.exports)
      ? project.exports
        .map(normalizeExportEntry)
        .filter((entry) => entry.exportId)
        .slice(-MAX_EXPORTS)
      : []
    return {
      schemaVersion: SCHEMA_VERSION,
      id: isValidProjectId(project.id) ? project.id : '',
      createdAt: integer(project.createdAt, 0),
      updatedAt: integer(project.updatedAt, 0),
      name: normalizeName(project.name),
      mode: normalizeMode(project.mode),
      state: normalizeState(project.state),
      captureConfig: normalizeCaptureConfig(project.captureConfig),
      source: normalizeSource(project.source),
      media,
      captureOutcome: normalizeCaptureOutcome(project.captureOutcome),
      edit: normalizeEdit(project.edit, media.durationMs),
      exports,
      recovery: normalizeRecovery(project.recovery)
    }
  }

  function validateKeepRanges(ranges, durationMs, errors) {
    let previousEnd = -1
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs)) {
        errors.push('invalid-keep-range-time')
        continue
      }
      if (!(range.startMs >= 0 && range.startMs < range.endMs)) errors.push('invalid-keep-range')
      if (durationMs > 0 && range.endMs > durationMs) errors.push('keep-range-out-of-bounds')
      if (range.startMs < previousEnd) errors.push('overlapping-keep-ranges')
      previousEnd = range.endMs
    }
  }

  // Structural validation of a manifest as it is ON DISK (not the normalized form).
  // Returns { ok, errors } so a caller can decide whether to repair or refuse; the
  // service repairs through normalizeProject, while tests and recovery screens can
  // report exactly what is wrong.
  function validateProject(value) {
    const errors = []
    if (!isPlainObject(value)) return { ok: false, errors: ['not-an-object'] }
    if (value.schemaVersion !== SCHEMA_VERSION) errors.push('unsupported-schema-version')
    if (!isValidProjectId(value.id)) errors.push('invalid-id')
    for (const field of ['createdAt', 'updatedAt']) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) errors.push(`invalid-${field}`)
    }
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > NAME_MAX_LENGTH) {
      errors.push('invalid-name')
    }
    if (!PROJECT_MODES.includes(value.mode)) errors.push('invalid-mode')
    if (!PROJECT_STATES.includes(value.state)) errors.push('invalid-state')
    const source = value.source
    if (!isPlainObject(source) || !FILE_NAME_PATTERN.test(String(source.fileName || ''))) {
      errors.push('invalid-source-file-name')
    }
    const media = isPlainObject(value.media) ? value.media : {}
    const durationMs = Number(media.durationMs)
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) errors.push('invalid-media-duration')
    if (!Array.isArray(value.exports)) {
      errors.push('invalid-exports')
    } else {
      for (const entry of value.exports) {
        if (!isPlainObject(entry) || !text(entry.exportId, 128)) errors.push('invalid-export-entry')
        else if (!EXPORT_FORMATS.includes(entry.format)) errors.push('invalid-export-format')
      }
    }
    const edit = isPlainObject(value.edit) ? value.edit : {}
    if (!Number.isSafeInteger(edit.revision) || edit.revision < 1) errors.push('invalid-edit-revision')
    if (!Array.isArray(edit.keepRanges)) errors.push('invalid-keep-ranges')
    else validateKeepRanges(edit.keepRanges, Number.isSafeInteger(durationMs) ? durationMs : 0, errors)
    const recovery = isPlainObject(value.recovery) ? value.recovery : {}
    if (!Number.isSafeInteger(recovery.committedByteOffset) || recovery.committedByteOffset < 0) {
      errors.push('invalid-committed-offset')
    }
    if (!Number.isSafeInteger(recovery.lastChunkSequence) || recovery.lastChunkSequence < 0) {
      errors.push('invalid-last-chunk-sequence')
    }
    if (typeof recovery.cleanStop !== 'boolean') errors.push('invalid-clean-stop')
    return { ok: errors.length === 0, errors }
  }

  function projectHasAudio(project) {
    const normalized = normalizeProject(project)
    return normalized.media.audio.tracks > 0 ||
      normalized.captureOutcome.audio.system ||
      normalized.captureOutcome.audio.microphone
  }

  // ProjectSummary: the ONLY shape the history/workbench list sees. Path-free.
  function projectSummary(project) {
    const normalized = normalizeProject(project)
    const exports = normalized.exports
    const lastExport = exports.length
      ? {
          format: exports[exports.length - 1].format,
          fileName: exports[exports.length - 1].fileName,
          exportedAt: exports[exports.length - 1].exportedAt
        }
      : null
    return {
      id: normalized.id,
      name: normalized.name,
      mode: normalized.mode,
      state: normalized.state,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      durationMs: normalized.media.durationMs,
      width: normalized.media.video.width,
      height: normalized.media.video.height,
      bytes: normalized.source.bytes,
      frameRate: normalized.captureConfig.frameRate,
      quality: normalized.captureConfig.quality,
      hasAudio: projectHasAudio(normalized),
      audio: {
        system: normalized.captureOutcome.audio.system,
        microphone: normalized.captureOutcome.audio.microphone
      },
      exportCount: exports.length,
      lastExport,
      // R1 does not generate thumbnails; the flag keeps the renderer from asking.
      thumbnail: false
    }
  }

  // ProjectPublic: what the editor may see. Still path-free - `source.fileName` and
  // export `targetPath` are dropped, because the main process is the only owner of
  // the on-disk location and hands the editor a derived file URL separately.
  function projectPublic(project) {
    const normalized = normalizeProject(project)
    const summary = projectSummary(normalized)
    return {
      ...summary,
      schemaVersion: normalized.schemaVersion,
      captureConfig: normalized.captureConfig,
      source: {
        mediaKind: normalized.source.mediaKind,
        mimeType: normalized.source.mimeType,
        bytes: normalized.source.bytes
      },
      media: normalized.media,
      captureOutcome: normalized.captureOutcome,
      edit: normalized.edit,
      exports: normalized.exports.map((entry) => ({
        exportId: entry.exportId,
        format: entry.format,
        fileName: entry.fileName,
        exportedAt: entry.exportedAt,
        editRevision: entry.editRevision
      })),
      recovery: {
        cleanStop: normalized.recovery.cleanStop,
        errorCode: normalized.recovery.errorCode
      }
    }
  }

  return {
    COUNTDOWN_OPTIONS,
    DEFAULT_COUNTDOWN,
    DEFAULT_FRAME_RATE,
    DEFAULT_GIF_EDGE,
    DEFAULT_GIF_FPS,
    DEFAULT_PROJECT_NAME,
    DEFAULT_QUALITY,
    DEFAULT_SOURCE_MIME,
    DEFAULT_TIME_BASE,
    EDITABLE_STATES,
    EXPORT_FORMATS,
    FILE_NAME_PATTERN,
    GIF_EDGE_MAX,
    GIF_EDGE_MIN,
    GIF_FRAME_RATES,
    MAX_EXPORTS,
    NAME_MAX_LENGTH,
    PROJECT_FILE_NAME,
    PROJECT_ID_PATTERN,
    PROJECT_MODES,
    PROJECT_STATES,
    QUALITY_LEVELS,
    SCHEMA_VERSION,
    SOURCE_FILE_NAME,
    integer,
    isValidProjectId,
    mediaFromMetadata,
    normalizeCaptureConfig,
    normalizeCaptureOutcome,
    normalizeDisplayFileName,
    normalizeEdit,
    normalizeErrorCode,
    normalizeExportEntry,
    normalizeFileName,
    normalizeGifOptions,
    normalizeKeepRanges,
    normalizeMedia,
    normalizeName,
    normalizeProject,
    normalizeRecovery,
    normalizeSource,
    projectHasAudio,
    projectPublic,
    projectSummary,
    text,
    validateProject
  }
})
