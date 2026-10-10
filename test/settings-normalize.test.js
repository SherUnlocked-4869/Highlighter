const test = require('node:test')
const assert = require('node:assert/strict')

const { createSettingsNormalizer } = require('../main/services/settings-normalize')
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { normalizeSelectionToolbar, normalizeToolbarThinking } = require('../toolbar/toolbar-utils')
const { NIGHTSHIFT_AMBER } = require('../main/services/appearance-migration')

const HISTORY_DIRECTORY = 'C:/data/capture-history'

function makeSettings(mutate = () => {}) {
  const settings = structuredClone(DEFAULT_SETTINGS)
  mutate(settings)
  return settings
}

function normalizeWith(settings) {
  return createSettingsNormalizer({ defaultHistoryDirectory: HISTORY_DIRECTORY })(settings)
}

test('the settings normalizer refuses to build without a resolved history directory', () => {
  assert.throws(() => createSettingsNormalizer({ defaultHistoryDirectory: '' }), /resolved history directory/)
  assert.throws(() => createSettingsNormalizer({}), /resolved history directory/)
})

test('a blank history directory falls back to the injected default', () => {
  const normalized = normalizeWith(makeSettings((settings) => { settings.screenshot.historyDirectory = '' }))
  assert.equal(normalized.screenshot.historyDirectory, HISTORY_DIRECTORY)
})

test('the legacy fixedContent.autoSaveDirectory is consumed and removed', () => {
  const normalized = normalizeWith(makeSettings((settings) => {
    settings.screenshot.historyDirectory = ''
    settings.fixedContent.autoSaveDirectory = 'D:/legacy-history'
  }))
  assert.equal(normalized.screenshot.historyDirectory, 'D:/legacy-history')
  assert.equal(Object.hasOwn(normalized.fixedContent, 'autoSaveDirectory'), false)
})

test('an explicit history directory is trimmed and kept', () => {
  const normalized = normalizeWith(makeSettings((settings) => { settings.screenshot.historyDirectory = '  D:/pics  ' }))
  assert.equal(normalized.screenshot.historyDirectory, 'D:/pics')
})

test('updateChannel collapses to stable unless it is beta', () => {
  const nightly = normalizeWith(makeSettings((settings) => { settings.system.updateChannel = 'nightly' }))
  const beta = normalizeWith(makeSettings((settings) => { settings.system.updateChannel = 'beta' }))
  assert.equal(nightly.system.updateChannel, 'stable')
  assert.equal(beta.system.updateChannel, 'beta')
})

test('gameMode is coerced to a strict boolean', () => {
  const enabled = normalizeWith(makeSettings((settings) => { settings.system.gameMode = true }))
  const truthy = normalizeWith(makeSettings((settings) => { settings.system.gameMode = 1 }))
  const other = normalizeWith(makeSettings((settings) => { settings.system.gameMode = 'yes' }))
  assert.equal(enabled.system.gameMode, true)
  assert.equal(truthy.system.gameMode, false)
  assert.equal(other.system.gameMode, false)
})

test('legacy accents resolve to the Nightshift amber', () => {
  assert.equal(normalizeWith(makeSettings((settings) => { settings.mainColor = '#1677ff' })).mainColor, NIGHTSHIFT_AMBER)
  assert.equal(normalizeWith(makeSettings((settings) => { settings.mainColor = 'not-a-colour' })).mainColor, NIGHTSHIFT_AMBER)
  assert.equal(normalizeWith(makeSettings((settings) => { settings.mainColor = '#123456' })).mainColor, '#123456')
})

test('toolbar settings are normalized through the shared helpers', () => {
  const normalized = normalizeWith(makeSettings((settings) => {
    settings.selectionToolbar = {}
    settings.toolbarThinking = {}
  }))
  assert.deepEqual(normalized.selectionToolbar, normalizeSelectionToolbar({}))
  assert.deepEqual(normalized.toolbarThinking, normalizeToolbarThinking({}))
})

test('the injected directory is reused across calls', () => {
  const normalize = createSettingsNormalizer({ defaultHistoryDirectory: 'D:/one' })
  const first = normalize(makeSettings((settings) => { settings.screenshot.historyDirectory = '' }))
  const second = normalize(makeSettings((settings) => { settings.screenshot.historyDirectory = '' }))
  assert.equal(first.screenshot.historyDirectory, 'D:/one')
  assert.equal(second.screenshot.historyDirectory, 'D:/one')
})

test('supported languages survive; unsupported ones fall back to zh-CN', () => {
  const traditional = normalizeWith(makeSettings((settings) => { settings.language = 'zh-TW' }))
  const english = normalizeWith(makeSettings((settings) => { settings.language = 'en-US' }))
  const unsupported = normalizeWith(makeSettings((settings) => { settings.language = 'fr' }))
  const missing = normalizeWith(makeSettings((settings) => { settings.language = undefined }))
  assert.equal(traditional.language, 'zh-TW')
  assert.equal(english.language, 'en-US')
  assert.equal(unsupported.language, 'zh-CN')
  assert.equal(missing.language, 'zh-CN')
})

test('the Wave 0 toggles are coerced to strict booleans', () => {
  const normalized = normalizeWith(makeSettings((settings) => {
    settings.screenshot.captureCursor = 'yes'
    settings.screenshot.shutterSound = true
    settings.screenshot.keepSerialAcrossCaptures = 1
    settings.record.audioSystem = true
    settings.record.audioMicrophone = 'on'
    settings.record.captureCursor = 0
    settings.pinned.clickThrough = 1
  }))
  assert.equal(normalized.screenshot.captureCursor, false)
  assert.equal(normalized.screenshot.shutterSound, true)
  assert.equal(normalized.screenshot.keepSerialAcrossCaptures, false)
  assert.equal(normalized.record.audioSystem, true)
  assert.equal(normalized.record.audioMicrophone, false)
  assert.equal(normalized.record.captureCursor, false)
  assert.equal(normalized.pinned.clickThrough, false)
})

test('audio gains fall back to unity when they are not finite numbers', () => {
  const broken = normalizeWith(makeSettings((settings) => {
    settings.record.audioSystemGain = Number.NaN
    settings.record.audioMicrophoneGain = '2'
  }))
  const kept = normalizeWith(makeSettings((settings) => { settings.record.audioSystemGain = 0.5 }))
  assert.equal(broken.record.audioSystemGain, 1)
  assert.equal(broken.record.audioMicrophoneGain, 1)
  assert.equal(kept.record.audioSystemGain, 0.5)
})

test('template, directory, and shortcut strings are trimmed', () => {
  const normalized = normalizeWith(makeSettings((settings) => {
    settings.screenshot.nameTemplate = '  {date}-{time}  '
    settings.screenshot.lastSaveDirectory = '  D:/shots  '
    settings.shortcuts.screenshotQuickSave = '  Ctrl+1  '
    settings.shortcuts.screenshotSaveAs = ''
    settings.shortcuts.togglePinClickThrough = '   '
  }))
  assert.equal(normalized.screenshot.nameTemplate, '{date}-{time}')
  assert.equal(normalized.screenshot.lastSaveDirectory, 'D:/shots')
  assert.equal(normalized.shortcuts.screenshotQuickSave, 'Ctrl+1')
  assert.equal(normalized.shortcuts.screenshotSaveAs, '')
  assert.equal(normalized.shortcuts.togglePinClickThrough, '')
})

test('a legacy store without the new domains still normalizes', () => {
  const normalized = normalizeWith(makeSettings((settings) => {
    delete settings.pinned
    delete settings.record
    delete settings.shortcuts
  }))
  assert.deepEqual(normalized.pinned, { clickThrough: false })
  assert.equal(normalized.record.audioSystem, false)
  assert.equal(normalized.record.audioSystemGain, 1)
  assert.equal(normalized.shortcuts.screenshotSaveAs, '')
})
