const test = require('node:test')
const assert = require('node:assert/strict')

const { createSettingsNormalizer } = require('../main/services/settings-normalize')
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { DEFAULT_CLIPBOARD, nativeRules } = require('../main/services/clipboard-settings')
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
    settings.pinned.clickThrough = 1
  }))
  assert.equal(normalized.screenshot.captureCursor, false)
  assert.equal(normalized.screenshot.shutterSound, true)
  assert.equal(normalized.screenshot.keepSerialAcrossCaptures, false)
  assert.equal(normalized.record.audioSystem, true)
  assert.equal(normalized.record.audioMicrophone, false)
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

test('the annotation colour is normalised to a lower-case #rrggbb or the default (A3)', () => {
  // A3（D3）：capture 端要能存任意自定义色，所以这里只归一"形状"而不是白名单。
  const custom = normalizeWith(makeSettings((settings) => { settings.screenshot.annotationColor = '#0A0B0C' }))
  const padded = normalizeWith(makeSettings((settings) => { settings.screenshot.annotationColor = '  #1Ab2C3  ' }))
  const broken = normalizeWith(makeSettings((settings) => { settings.screenshot.annotationColor = 'red' }))
  const missing = normalizeWith(makeSettings((settings) => { delete settings.screenshot.annotationColor }))
  assert.equal(custom.screenshot.annotationColor, '#0a0b0c')
  assert.equal(padded.screenshot.annotationColor, '#1ab2c3')
  assert.equal(broken.screenshot.annotationColor, '#ff3b30')
  assert.equal(missing.screenshot.annotationColor, '#ff3b30')
  assert.equal(DEFAULT_SETTINGS.screenshot.annotationColor, '#ff3b30')
})

// Feature C (plan §6.2): the finished-look preset is the ONLY style preference that persists.
// Anything the read path cannot resolve - a hand-edited store, a removed preset, a non-string -
// has to fall back to "original" (effects off) instead of reaching the capture window as an id
// that resolves to nothing.
test('the outputStylePreset collapses to a known preset id, defaulting to original (feature C)', () => {
  const { PRESET_IDS } = require('../shared/capture-output-style')
  const kept = normalizeWith(makeSettings((settings) => { settings.screenshot.outputStylePreset = 'card-dark' }))
  const light = normalizeWith(makeSettings((settings) => { settings.screenshot.outputStylePreset = 'card-light' }))
  const unknown = normalizeWith(makeSettings((settings) => { settings.screenshot.outputStylePreset = 'card-neon' }))
  const wrongType = normalizeWith(makeSettings((settings) => { settings.screenshot.outputStylePreset = 42 }))
  const missing = normalizeWith(makeSettings((settings) => { delete settings.screenshot.outputStylePreset }))
  const blank = normalizeWith(makeSettings((settings) => { settings.screenshot.outputStylePreset = '' }))
  assert.deepEqual(PRESET_IDS, ['original', 'card-light', 'card-dark'])
  assert.equal(kept.screenshot.outputStylePreset, 'card-dark')
  assert.equal(light.screenshot.outputStylePreset, 'card-light')
  for (const [label, normalized] of [['unknown', unknown], ['wrong type', wrongType], ['missing', missing], ['blank', blank]]) {
    assert.equal(normalized.screenshot.outputStylePreset, 'original', `${label} must fall back to original`)
  }
  assert.equal(DEFAULT_SETTINGS.screenshot.outputStylePreset, 'original')
})

test('a legacy store without the new domains still normalizes', () => {
  const normalized = normalizeWith(makeSettings((settings) => {
    delete settings.pinned
    delete settings.record
    delete settings.shortcuts
  }))
  assert.deepEqual(normalized.pinned, { clickThrough: false, zoomStep: 0.1 })
  assert.equal(normalized.record.audioSystem, false)
  assert.equal(normalized.record.audioSystemGain, 1)
  assert.equal(normalized.shortcuts.screenshotSaveAs, '')
})

// V2 file list (docs/plans/2026-10-27-clipboard-file-list-design.md §3.6). The
// captureFiles switch is newer than the installed stores: a stored clipboard
// block that predates it must be back-filled from the defaults instead of
// failing the assertion and resetting the whole block (which would disable
// recording and throw away the user's limits and exclusions).
test('a legacy clipboard block without captureFiles keeps the user choices', () => {
  const legacy = makeSettings((settings) => {
    // Exactly the block an older build wrote: no captureFiles key.
    settings.clipboard = {
      enabled: true,
      paused: false,
      captureText: true,
      captureImages: false,
      historyLimit: 900,
      retentionDays: 7,
      maxPayloadMiB: 128,
      maxDiskMiB: 256,
      maxThumbnailMiB: 32,
      releaseAfterMs: 300000,
      excludedApps: ['keepass.exe'],
      // A key the current build does not know. It used to survive the read path
      // and would then be forwarded to the native rules (which reject unknown
      // fields), so normalization has to drop it.
      legacyField: 'stale'
    }
  })
  const { clipboard } = normalizeWith(legacy)
  assert.equal(clipboard.captureFiles, true, 'the new switch is back-filled from the defaults')
  assert.equal(clipboard.enabled, true, 'the missing key does not reset the block')
  assert.equal(clipboard.paused, false)
  assert.equal(clipboard.captureText, true)
  assert.equal(clipboard.captureImages, false, 'a disabled capture kind survives')
  assert.equal(clipboard.historyLimit, 900)
  assert.equal(clipboard.retentionDays, 7)
  assert.equal(clipboard.maxPayloadMiB, 128)
  assert.equal(clipboard.maxDiskMiB, 256)
  assert.equal(clipboard.maxThumbnailMiB, 32)
  assert.equal(clipboard.releaseAfterMs, 300000)
  assert.deepEqual(clipboard.excludedApps, ['keepass.exe'])
  assert.equal(Object.hasOwn(clipboard, 'legacyField'), false, 'unknown keys never reach the native rules')
})

test('nativeRules passes captureFiles through and strips the JS-only fields', () => {
  const rules = nativeRules({ ...DEFAULT_CLIPBOARD, enabled: true, paused: true, releaseAfterMs: 0, captureFiles: false })
  assert.equal(rules.captureFiles, false, 'the capture switch is part of the native rule set')
  assert.equal(rules.captureText, true)
  assert.equal(rules.captureImages, true)
  assert.deepEqual(rules.excludedApps, [])
  for (const key of ['enabled', 'paused', 'releaseAfterMs']) {
    assert.equal(Object.hasOwn(rules, key), false, `${key} stays in the JS layer`)
  }
  // The shipped default is on, so existing users get file capture without opting in.
  assert.equal(DEFAULT_CLIPBOARD.captureFiles, true)
})
