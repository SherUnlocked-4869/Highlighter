'use strict'

const { normalizeSelectionToolbar, normalizeToolbarThinking } = require('../../toolbar/toolbar-utils')
const { normalizeAiSettings } = require('./ai-providers')
const { resolveMainColor } = require('./appearance-migration')

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

function normalizeFrozenSettings(settings) {
  settings.language = normalizeLanguage(settings.language)
  settings.pinned = { ...(settings.pinned || {}) }
  settings.record = settings.record || {}
  settings.shortcuts = settings.shortcuts || {}
  settings.pinned.clickThrough = normalizeToggle(settings.pinned.clickThrough)
  settings.screenshot.captureCursor = normalizeToggle(settings.screenshot.captureCursor)
  settings.screenshot.shutterSound = normalizeToggle(settings.screenshot.shutterSound)
  settings.screenshot.keepSerialAcrossCaptures = normalizeToggle(settings.screenshot.keepSerialAcrossCaptures)
  settings.screenshot.nameTemplate = normalizeText(settings.screenshot.nameTemplate)
  settings.screenshot.lastSaveDirectory = normalizeText(settings.screenshot.lastSaveDirectory)
  settings.screenshot.annotationColor = normalizeHexColor(settings.screenshot.annotationColor, DEFAULT_ANNOTATION_COLOR)
  settings.record.audioSystem = normalizeToggle(settings.record.audioSystem)
  settings.record.audioMicrophone = normalizeToggle(settings.record.audioMicrophone)
  settings.record.captureCursor = normalizeToggle(settings.record.captureCursor)
  settings.record.audioSystemGain = normalizeGain(settings.record.audioSystemGain)
  settings.record.audioMicrophoneGain = normalizeGain(settings.record.audioMicrophoneGain)
  settings.shortcuts.screenshotQuickSave = normalizeText(settings.shortcuts.screenshotQuickSave)
  settings.shortcuts.screenshotSaveAs = normalizeText(settings.shortcuts.screenshotSaveAs)
  settings.shortcuts.togglePinClickThrough = normalizeText(settings.shortcuts.togglePinClickThrough)
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
    normalizeFrozenSettings(normalized)
    return normalized
  }
}

module.exports = { createSettingsNormalizer }
