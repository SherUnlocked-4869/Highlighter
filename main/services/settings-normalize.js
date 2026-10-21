'use strict'

const { normalizeSelectionToolbar, normalizeToolbarThinking } = require('../../toolbar/toolbar-utils')
const { normalizeAiSettings } = require('./ai-providers')
const { resolveMainColor } = require('./appearance-migration')
const { normalizeClipboardSettings } = require('./clipboard-settings')

// P0 settings frozen in Wave 0 (2026-10-10). They are normalized here so a
// hand-edited or legacy store cannot hand an unsupported language, a
// non-boolean toggle, or a non-finite gain to the features that read them.
const SUPPORTED_LANGUAGES = new Set(['zh-CN', 'en-US', 'zh-TW'])
const DEFAULT_LANGUAGE = 'zh-CN'
const DEFAULT_AUDIO_GAIN = 1
// A3 (2026-10-14 plan): the capture palette stores any #rrggbb colour; anything
// else (hand-edited store, legacy value) falls back to the shipped default.
const DEFAULT_ANNOTATION_COLOR = '#ff3b30'
const HEX_COLOR = /^#[0-9a-f]{6}$/i
// Index-Translate proxy bridge: a hand-edited store must not be able to hand the
// service a port that cannot bind or an interface that is not loopback.
const DEFAULT_PROXY_PORT = 8080
const PROXY_HOSTS = new Set(['127.0.0.1', '0.0.0.0'])
const DEFAULT_PROXY_HOST = '127.0.0.1'
// Fields the script-based bridge used to persist. Removed from the template when
// the relay moved in-process; deleted on read so old stores stop carrying them.
const LEGACY_PROXY_KEYS = Object.freeze(['repoDirectory', 'scriptPath', 'pythonPath', 'keepRunningOnExit', 'mode'])
// Dead settings (2026-10-18 snow migration §0.3 #5): these keys were rendered or
// documented but had no consumer anywhere in the codebase, so the settings page
// promised behaviour that never happened. They are gone from the template; the
// delete pass stops a store written by an older build from carrying them forever
// (electron-store keeps whatever was written, and the template check only runs on
// the patch, never on the read).
//   screenshot.saveFormat      - saves were always PNG; the key was never read
//   ocr.modelWriteToMemory     - the sidecar always memory-maps its models
//   record.captureCursor       - see RECORD_CURSOR_NOTE below
//   fixedContent.autoResize    - pins always kept their pixel size
//   fixedContent.autoOcr       - pins never auto-recognised
//
// RECORD_CURSOR_NOTE: `record.captureCursor` is not "implemented" by a switch -
// Chromium's getDisplayMedia capturer decides whether the cursor is composited,
// and its `cursor` constraint is only a hint the browser may ignore. Exposing a
// toggle that may silently do nothing is worse than not exposing it, so the key
// is removed (the setting had no consumer before either, so no behaviour
// regresses for an existing user).
const LEGACY_DEAD_KEYS = Object.freeze({
  screenshot: Object.freeze(['saveFormat']),
  ocr: Object.freeze(['modelWriteToMemory']),
  record: Object.freeze(['captureCursor']),
  fixedContent: Object.freeze(['autoResize', 'autoOcr'])
})

function dropLegacyDeadKeys(settings) {
  for (const [group, keys] of Object.entries(LEGACY_DEAD_KEYS)) {
    const block = settings[group]
    if (!block || typeof block !== 'object') continue
    for (const key of keys) {
      if (Object.hasOwn(block, key)) delete block[key]
    }
  }
}

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.has(value) ? value : DEFAULT_LANGUAGE
}

function normalizeHexColor(value, fallback) {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : fallback
}

function normalizeToggle(value) {
  return value === true
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeGain(value) {
  return Number.isFinite(value) ? value : DEFAULT_AUDIO_GAIN
}

// P1 (2026-10-18 snow migration §9.1): the pinned-image wheel step. A hand-edited
// store could carry 0 (a wheel tick would then resize nothing) or 5 (one tick
// would blow the image past the screen), so it is clamped into the range the
// settings page offers and falls back to the historic 10% step.
const DEFAULT_PIN_ZOOM_STEP = 0.1
const MIN_PIN_ZOOM_STEP = 0.05
const MAX_PIN_ZOOM_STEP = 0.5

function normalizePinZoomStep(value) {
  const step = Number(value)
  if (!Number.isFinite(step) || step <= 0) return DEFAULT_PIN_ZOOM_STEP
  return Math.min(MAX_PIN_ZOOM_STEP, Math.max(MIN_PIN_ZOOM_STEP, Math.round(step * 100) / 100))
}

function normalizePort(value) {
  // Ports 1..65535 only. A value that cannot bind would surface as an opaque
  // EADDRINUSE at toggle time, so it falls back to the shipped default here.
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PROXY_PORT
}

function normalizeFrozenSettings(settings) {
  settings.clipboard = normalizeClipboardSettings(settings.clipboard)
  // Opt-in usage statistics: a hand-edited store could carry a truthy string, so
  // the toggle is coerced to a strict boolean like the other feature switches.
  settings.usage = { ...(settings.usage || {}) }
  settings.usage.enabled = normalizeToggle(settings.usage.enabled)
  settings.language = normalizeLanguage(settings.language)
  settings.pinned = { ...(settings.pinned || {}) }
  settings.record = settings.record || {}
  settings.shortcuts = settings.shortcuts || {}
  settings.pinned.clickThrough = normalizeToggle(settings.pinned.clickThrough)
  settings.pinned.zoomStep = normalizePinZoomStep(settings.pinned.zoomStep)
  settings.screenshot.captureCursor = normalizeToggle(settings.screenshot.captureCursor)
  settings.screenshot.shutterSound = normalizeToggle(settings.screenshot.shutterSound)
  settings.screenshot.keepSerialAcrossCaptures = normalizeToggle(settings.screenshot.keepSerialAcrossCaptures)
  settings.screenshot.nameTemplate = normalizeText(settings.screenshot.nameTemplate)
  settings.screenshot.lastSaveDirectory = normalizeText(settings.screenshot.lastSaveDirectory)
  settings.screenshot.annotationColor = normalizeHexColor(settings.screenshot.annotationColor, DEFAULT_ANNOTATION_COLOR)
  settings.record.audioSystem = normalizeToggle(settings.record.audioSystem)
  settings.record.audioMicrophone = normalizeToggle(settings.record.audioMicrophone)
  settings.record.audioSystemGain = normalizeGain(settings.record.audioSystemGain)
  settings.record.audioMicrophoneGain = normalizeGain(settings.record.audioMicrophoneGain)
  settings.shortcuts.screenshotQuickSave = normalizeText(settings.shortcuts.screenshotQuickSave)
  settings.shortcuts.screenshotSaveAs = normalizeText(settings.shortcuts.screenshotSaveAs)
  settings.shortcuts.togglePinClickThrough = normalizeText(settings.shortcuts.togglePinClickThrough)
  settings.shortcuts.toggleTranslationProxy = normalizeText(settings.shortcuts.toggleTranslationProxy)
  settings.proxy = { ...(settings.proxy || {}) }
  settings.proxy.autoStart = normalizeToggle(settings.proxy.autoStart)
  settings.proxy.port = normalizePort(settings.proxy.port)
  settings.proxy.host = PROXY_HOSTS.has(settings.proxy.host) ? settings.proxy.host : DEFAULT_PROXY_HOST
  settings.proxy.apiBase = normalizeText(settings.proxy.apiBase)
  // The bridge used to be an external Python script. Its path fields are gone
  // from the settings template; drop them so a store carried over from that
  // build does not keep dead keys around forever.
  for (const legacyKey of LEGACY_PROXY_KEYS) delete settings.proxy[legacyKey]
}

// Runtime settings normalization that used to live in the assembly layer
// (main.js normalizeSettings). The resolved history directory is injected so
// this module stays free of Electron/path state and is directly unit-testable.
function createSettingsNormalizer({ defaultHistoryDirectory }) {
  if (typeof defaultHistoryDirectory !== 'string' || !defaultHistoryDirectory) {
    throw new TypeError('Settings normalization requires a resolved history directory')
  }

  return function normalizeSettings(settings) {
    const normalized = normalizeAiSettings(settings)
    normalized.selectionToolbar = normalizeSelectionToolbar(normalized.selectionToolbar)
    normalized.toolbarThinking = normalizeToolbarThinking(normalized.toolbarThinking)
    const legacyDirectory = normalized.fixedContent?.autoSaveDirectory
    normalized.screenshot.historyDirectory = String(normalized.screenshot.historyDirectory || legacyDirectory || defaultHistoryDirectory).trim()
    if (!normalized.screenshot.historyDirectory) normalized.screenshot.historyDirectory = defaultHistoryDirectory
    normalized.system.updateChannel = normalized.system.updateChannel === 'beta' ? 'beta' : 'stable'
    normalized.system.gameMode = normalized.system.gameMode === true
    normalized.mainColor = resolveMainColor(normalized.mainColor)
    if (normalized.fixedContent && Object.hasOwn(normalized.fixedContent, 'autoSaveDirectory')) delete normalized.fixedContent.autoSaveDirectory
    dropLegacyDeadKeys(normalized)
    normalizeFrozenSettings(normalized)
    return normalized
  }
}

module.exports = { createSettingsNormalizer }
