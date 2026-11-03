'use strict'

// Recording capture-quality profiles (recording workbench, R2).
//
// The user-facing language is 标准 / 高清 / 极清; the encoder numbers are an internal
// detail and must be calibrated by measurement (plan §4.1, R0). Keeping the mapping in
// one shared module means the main process (validation, init payload), the recorder
// renderer (MediaRecorder bitrate) and the workbench (labels) cannot drift apart.
//
// Loaded three ways, exactly like the other shared modules:
//   * `require('../shared/recording-quality')` from node / main / tests;
//   * a classic <script> in a window (CSP forbids modules fetched over the network);
//   * the renderer reads the global the UMD footer installs.
//
// No i18n text lives here: the module returns levels/ids, the windows resolve labels.

;(function initRecordingQuality(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordingQuality = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  // Order is the UI order (ascending quality) and doubles as the allow-list.
  const QUALITY_LEVELS = Object.freeze(['standard', 'high', 'ultra'])
  const DEFAULT_QUALITY = 'standard'

  // Bitrates are UPPER BOUNDS handed to MediaRecorder.videoBitsPerSecond. VP9 is
  // preferred by the recorder when the platform supports it, so a lower number can
  // still produce a good file; these are the numbers the UI's three tiers promise.
  const QUALITY_BITS_PER_SECOND = Object.freeze({
    standard: 4_000_000,
    high: 8_000_000,
    ultra: 16_000_000
  })

  // 0 / 3 / 5 seconds. 0 means "start immediately" (no countdown overlay), which is
  // why it is a legal option and not an absent value.
  const COUNTDOWN_OPTIONS = Object.freeze([0, 3, 5])
  const DEFAULT_COUNTDOWN = 3

  function normalizeQuality(value) {
    const candidate = typeof value === 'string' ? value.trim() : ''
    return QUALITY_LEVELS.includes(candidate) ? candidate : DEFAULT_QUALITY
  }

  function qualityBitsPerSecond(value) {
    return QUALITY_BITS_PER_SECOND[normalizeQuality(value)]
  }

  function normalizeCountdown(value) {
    const seconds = Number(value)
    return COUNTDOWN_OPTIONS.includes(seconds) ? seconds : DEFAULT_COUNTDOWN
  }

  return {
    QUALITY_LEVELS,
    DEFAULT_QUALITY,
    QUALITY_BITS_PER_SECOND,
    COUNTDOWN_OPTIONS,
    DEFAULT_COUNTDOWN,
    normalizeQuality,
    qualityBitsPerSecond,
    normalizeCountdown
  }
})
