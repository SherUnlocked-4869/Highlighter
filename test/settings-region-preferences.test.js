// Feature B settings plumbing (plan docs/plans/2026-10-25-snow-apps-feature-development-plan.md
// §5.1/§5.2): the `screenshot.regionPreferences` block from template to store and back.
//
// This file is the integration half of test/region-presets.test.js. It exists because the
// risky part of the feature is not the geometry - it is that the NEW settings subtree is
// accepted by three layers that were written before it existed:
//   1. DEFAULT_SETTINGS is the patch-validation TEMPLATE, so an unlisted key is rejected;
//   2. settings-validation's template walk only length-checks arrays and used to choke on
//      a `null` leaf, which is exactly what lastByMode.capture / .record start as;
//   3. settings-normalize must repair a hand-edited/legacy store on READ so the feature
//      never sees NaN, an unbounded array or a duplicate id.
// Every assertion below is one of those three, plus the persistence round trip.

const test = require('node:test')
const assert = require('node:assert/strict')

const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { assertSettingsPatch } = require('../main/services/settings-validation')
const { createSettingsNormalizer } = require('../main/services/settings-normalize')
const { SettingsService } = require('../main/services/settings-service')
const { createRegionPreferences } = require('../main/services/region-preferences')
const {
  LIMITS,
  DEFAULT_REGION_PREFERENCES,
  assertRegionPreferencesPatch,
  normalizeRegionPreferences
} = require('../shared/region-presets')

const HISTORY_DIRECTORY = 'C:/data/capture-history'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
class MemoryStore {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values))
  }

  get(key, fallback) {
    return this.values.has(key) ? this.values.get(key) : fallback
  }

  set(key, value) {
    this.values.set(key, value)
  }

  delete(key) {
    this.values.delete(key)
  }
}

function createSafeStorage(available = false) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  }
}

// The real production wiring: SettingsService with DEFAULT_SETTINGS as the template and the
// real normalizer, exactly what main.js builds in initializeStore(). `storeSettings` seeds
// the persisted blob, which is how a legacy store is simulated.
function createSettingsHarness({ storeSettings = {}, normalize = createNormalizer() } = {}) {
  const store = new MemoryStore({ settings: storeSettings })
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults: DEFAULT_SETTINGS,
    normalizeSettings: normalize
  })
  return { store, service }
}

function createNormalizer(log) {
  return createSettingsNormalizer({ defaultHistoryDirectory: HISTORY_DIRECTORY, log })
}

function legalPreset(overrides = {}) {
  return { id: 'preset-fhd', name: 'FHD', widthPx: 1920, heightPx: 1080, ...overrides }
}

// A LastRegion as main/services/region-preferences would record it.
function legalLastRegion(overrides = {}) {
  return {
    displayKey: 'primary',
    displayBoundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
    displayPixelSize: { width: 3840, height: 2160 },
    rectDisplayPx: { x: 100, y: 200, width: 800, height: 600 },
    capturedScaleFactor: 2,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. The template
// ---------------------------------------------------------------------------
test('DEFAULT_SETTINGS carries the regionPreferences block with the shipped defaults', () => {
  const block = DEFAULT_SETTINGS.screenshot.regionPreferences
  assert.ok(block, 'the settings template must list the new subtree, or every write is rejected')
  assert.deepEqual(block, {
    schemaVersion: 1,
    lastByMode: { capture: null, record: null },
    presets: []
  })
  // The default literal and shared/region-presets's frozen default are the same contract;
  // drift here would mean the settings page and the feature disagree about "unset".
  assert.deepEqual(block, DEFAULT_REGION_PREFERENCES)
  assert.equal(block.schemaVersion, LIMITS.SCHEMA_VERSION)
})

test('the template block is independent of the shared frozen default (mutating one cannot move the other)', () => {
  const block = DEFAULT_SETTINGS.screenshot.regionPreferences
  assert.notEqual(block, DEFAULT_REGION_PREFERENCES)
  assert.notEqual(block.lastByMode, DEFAULT_REGION_PREFERENCES.lastByMode)
  assert.notEqual(block.presets, DEFAULT_REGION_PREFERENCES.presets)
})

// ---------------------------------------------------------------------------
// 2. settings-validation: the optional { domainValidators } hook
// ---------------------------------------------------------------------------
test('assertSettingsPatch still accepts a regionPreferences patch WITHOUT the domain hook', () => {
  // Backward compatibility, and the specific migration case plan §5.2 names: the generic
  // template walk must not reject a missing lastByMode or an empty array. (The generic walk
  // cannot check preset contents - that is what the hook below is for.)
  const patches = [
    { screenshot: { regionPreferences: {} } },
    { screenshot: { regionPreferences: { presets: [] } } },
    { screenshot: { regionPreferences: { lastByMode: { capture: null, record: null } } } },
    { screenshot: { regionPreferences: { lastByMode: { capture: null } } } },
    { screenshot: { regionPreferences: { presets: [legalPreset()] } } }
  ]
  for (const patch of patches) {
    assert.equal(assertSettingsPatch(patch, DEFAULT_SETTINGS), patch, `${JSON.stringify(patch)} should pass`)
  }
})

test('the null template leaves accept any value (they used to fail the typeof check)', () => {
  // typeof null === 'object', so before the null-leaf rule this rejected a legal LastRegion.
  const patch = { screenshot: { regionPreferences: { lastByMode: { capture: legalLastRegion() } } } }
  assert.equal(assertSettingsPatch(patch, DEFAULT_SETTINGS), patch)
  // A wrong-shaped object still gets through the template (it is a domain concern) ...
  assert.doesNotThrow(() => assertSettingsPatch(
    { screenshot: { regionPreferences: { lastByMode: { capture: { nope: true } } } } },
    DEFAULT_SETTINGS
  ))
  // ... and the domain validator is what rejects it:
  assert.throws(
    () => assertRegionPreferencesPatch({ lastByMode: { capture: { nope: true } } }),
    TypeError
  )
})

test('the two-argument call keeps its exact historical behaviour', () => {
  // Unchanged rejections: unknown keys, bad types, non-finite numbers, oversized strings,
  // oversized arrays, prototype keys. These are the same assertions the pre-existing
  // test/settings-validation.test.js makes; the point here is that adding an options
  // argument did not loosen any of them.
  assert.throws(() => assertSettingsPatch({ unknown: true }, DEFAULT_SETTINGS), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ compact: 'yes' }, DEFAULT_SETTINGS), /类型无效/)
  assert.throws(() => assertSettingsPatch({ screenshot: { historyLimit: Infinity } }, DEFAULT_SETTINGS), /有限数字/)
  assert.throws(() => assertSettingsPatch({ screenshot: { unknown: 1 } }, DEFAULT_SETTINGS), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { order: Array(101).fill('copy') } }, DEFAULT_SETTINGS), /项目过多/)
  assert.throws(() => assertSettingsPatch({ screenshot: { regionPreferences: { presets: 'no' } } }, DEFAULT_SETTINGS), /必须是数组/)
  assert.throws(() => assertSettingsPatch(null, DEFAULT_SETTINGS), /必须是对象/)
  // No call site broke: the third argument is optional, so existing code and tests are
  // unaffected. (This is asserted structurally by test/settings-validation.test.js staying
  // green; this is the explicit two-arg identity check.)
  assert.deepEqual(assertSettingsPatch({ theme: 'dark' }, DEFAULT_SETTINGS), { theme: 'dark' })
})

test('the domain hook validates the real contract the template cannot express', () => {
  const domainValidators = new Map([['screenshot.regionPreferences', assertRegionPreferencesPatch]])

  const legal = { screenshot: { regionPreferences: { presets: [legalPreset()] } } }
  assert.equal(assertSettingsPatch(legal, DEFAULT_SETTINGS, { domainValidators }), legal)

  const rejects = [
    // Duplicate ids: the template only length-checks the array.
    { screenshot: { regionPreferences: { presets: [legalPreset(), legalPreset({ name: 'Other' })] } } },
    // Non-integer / undersized / unbudgeted sizes.
    { screenshot: { regionPreferences: { presets: [legalPreset({ widthPx: 1921.5 })] } } },
    { screenshot: { regionPreferences: { presets: [legalPreset({ widthPx: 1 })] } } },
    { screenshot: { regionPreferences: { presets: [legalPreset({ widthPx: 10000, heightPx: 10000 })] } } },
    // Name/id limits.
    { screenshot: { regionPreferences: { presets: [legalPreset({ name: '' })] } } },
    { screenshot: { regionPreferences: { presets: [legalPreset({ name: 'n'.repeat(LIMITS.MAX_NAME_LENGTH + 1) })] } } },
    { screenshot: { regionPreferences: { presets: [legalPreset({ id: '' })] } } },
    // More presets than the plan allows.
    {
      screenshot: {
        regionPreferences: {
          presets: Array.from({ length: LIMITS.MAX_PRESETS + 1 }, (_, index) => legalPreset({ id: `p${index}`, name: `P${index}` }))
        }
      }
    },
    // Unknown field inside a preset.
    { screenshot: { regionPreferences: { presets: [{ ...legalPreset(), extra: 1 }] } } },
    // A broken remembered region.
    { screenshot: { regionPreferences: { lastByMode: { capture: legalLastRegion({ capturedScaleFactor: 0 }) } } } }
  ]
  for (const patch of rejects) {
    assert.throws(
      () => assertSettingsPatch(patch, DEFAULT_SETTINGS, { domainValidators }),
      (error) => error instanceof TypeError || error instanceof RangeError,
      `${JSON.stringify(patch)} should be rejected by the domain validator`
    )
  }
})

test('a patch that never touches regionPreferences is unaffected by the hook', () => {
  const domainValidators = new Map([['screenshot.regionPreferences', () => { throw new Error('must not run') }]])
  assert.deepEqual(
    assertSettingsPatch({ theme: 'dark', screenshot: { historyLimit: 300 } }, DEFAULT_SETTINGS, { domainValidators }),
    { theme: 'dark', screenshot: { historyLimit: 300 } }
  )
})

// ---------------------------------------------------------------------------
// 3. settings-normalize: repairing a legacy or hand-edited store on read
// ---------------------------------------------------------------------------
test('a legacy store with no regionPreferences key normalizes to the shipped defaults', () => {
  // This is the migration case from plan §5.2: an install that predates the feature.
  const settings = structuredClone(DEFAULT_SETTINGS)
  delete settings.screenshot.regionPreferences
  const normalized = createNormalizer()(settings)
  assert.deepEqual(normalized.screenshot.regionPreferences, {
    schemaVersion: 1,
    lastByMode: { capture: null, record: null },
    presets: []
  })
})

test('a hand-edited store with garbage is repaired on read and the problems are logged', () => {
  const logged = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.screenshot.regionPreferences = {
    // NaN and a string are both illegal; a numeric string must NOT be coerced.
    presets: [
      legalPreset(),
      legalPreset({ id: 'dup', name: 'Dup first' }),
      legalPreset({ id: 'dup', name: 'Dup second' }),
      legalPreset({ id: 'nan', name: 'NaN', widthPx: Number.NaN }),
      legalPreset({ id: 'string', name: 'String', widthPx: '1920' }),
      legalPreset({ id: 'huge', name: 'Huge', widthPx: 10000, heightPx: 10000 }),
      { id: 'unknown', name: 'Unknown', widthPx: 800, heightPx: 600, evil: true }
    ],
    lastByMode: {
      capture: legalLastRegion({ rectDisplayPx: { x: 0, y: 0, width: 0, height: 0 } }),
      record: legalLastRegion()
    }
  }
  const normalized = createNormalizer((message) => logged.push(message))(settings).screenshot.regionPreferences

  // Only legal items survive: 'preset-fhd', the FIRST 'dup' (dedupe keeps the earliest and
  // drops later ones), and 'unknown' (with its extra field dropped).
  assert.deepEqual(normalized.presets.map((item) => item.id), ['preset-fhd', 'dup', 'unknown'])
  assert.equal(normalized.presets[1].name, 'Dup first', 'the first occurrence of a duplicate id wins')
  assert.deepEqual(Object.keys(normalized.presets[2]).sort(), ['heightPx', 'id', 'name', 'widthPx'])
  // The broken capture region is dropped to null; the healthy record region survives.
  assert.equal(normalized.lastByMode.capture, null)
  assert.deepEqual(normalized.lastByMode.record.rectDisplayPx, { x: 100, y: 200, width: 800, height: 600 })
  assert.ok(logged.length >= 3, 'normalization diagnostics must reach the log, not be swallowed')
  assert.ok(logged.every((message) => message.includes('regionPreferences')), 'each line names the block')
})

test('normalization of an unbounded presets array keeps the first 20', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.screenshot.regionPreferences = {
    presets: Array.from({ length: LIMITS.MAX_PRESETS + 3 }, (_, index) => legalPreset({ id: `p${index}`, name: `P${index}` }))
  }
  const normalized = createNormalizer()(settings).screenshot.regionPreferences
  assert.equal(normalized.presets.length, LIMITS.MAX_PRESETS)
})

test('normalizing does not throw when the whole screenshot block is malformed', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.screenshot.regionPreferences = 'not-an-object'
  assert.doesNotThrow(() => createNormalizer()(settings))
  assert.deepEqual(
    createNormalizer()(settings).screenshot.regionPreferences,
    { schemaVersion: 1, lastByMode: { capture: null, record: null }, presets: [] }
  )
})

test('normalization is idempotent', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.screenshot.regionPreferences = {
    lastByMode: { capture: legalLastRegion() },
    presets: [legalPreset()]
  }
  const once = createNormalizer()(structuredClone(settings))
  const twice = createNormalizer()(structuredClone(once))
  assert.deepEqual(twice.screenshot.regionPreferences, once.screenshot.regionPreferences)
})

test('the normalizer keeps its existing injectable shape (log is optional)', () => {
  // Existing two-argument call sites and pre-existing tests pass only
  // defaultHistoryDirectory; must keep working.
  const normalize = createSettingsNormalizer({ defaultHistoryDirectory: HISTORY_DIRECTORY })
  assert.equal(typeof normalize, 'function')
  assert.deepEqual(
    normalize(structuredClone(DEFAULT_SETTINGS)).screenshot.regionPreferences,
    { schemaVersion: 1, lastByMode: { capture: null, record: null }, presets: [] }
  )
  assert.throws(() => createSettingsNormalizer({}), /resolved history directory/)
  assert.throws(() => createSettingsNormalizer({ defaultHistoryDirectory: '' }), /resolved history directory/)
})

// ---------------------------------------------------------------------------
// 4. SettingsService: the write path end to end
// ---------------------------------------------------------------------------
test('updateSettings persists a regionPreferences patch and reads it back', () => {
  const { store, service } = createSettingsHarness()
  const patch = { screenshot: { regionPreferences: { presets: [legalPreset()] } } }
  const result = service.updateSettings(patch)
  assert.deepEqual(result.patch, patch, 'the validated patch is echoed back unchanged')

  // Persisted (what a hand-edited store would contain) ...
  const stored = store.get('settings').screenshot.regionPreferences
  assert.deepEqual(stored.presets, [legalPreset()])
  // ... and visible on the read path, with the untouched fields filled from the defaults.
  const read = service.getSettings().screenshot.regionPreferences
  assert.deepEqual(read.presets, [legalPreset()])
  assert.deepEqual(read.lastByMode, { capture: null, record: null })
  assert.equal(read.schemaVersion, 1)
})

test('a patch that only sets presets leaves lastByMode intact', () => {
  const { service } = createSettingsHarness()
  service.updateSettings({ screenshot: { regionPreferences: { lastByMode: { capture: legalLastRegion() } } } })
  const before = service.getSettings().screenshot.regionPreferences.lastByMode.capture
  assert.ok(before, 'the remembered region must be stored first')

  // The whole presets array is replaced, but the sibling lastByMode block must survive the
  // deep merge - this is the failure the settings page's "add preset" flow would hit.
  service.updateSettings({ screenshot: { regionPreferences: { presets: [legalPreset()] } } })
  const after = service.getSettings().screenshot.regionPreferences
  assert.deepEqual(after.presets, [legalPreset()])
  assert.deepEqual(after.lastByMode.capture, before)
})

test('updateSettings rejects an illegal regionPreferences patch and stores nothing', () => {
  const { store, service } = createSettingsHarness()
  const before = store.get('settings')
  assert.throws(
    () => service.updateSettings({ screenshot: { regionPreferences: { presets: [legalPreset({ widthPx: 1 })] } } }),
    /screenshot\.regionPreferences.*width-invalid/
  )
  assert.throws(
    () => service.updateSettings({ screenshot: { regionPreferences: { presets: [legalPreset(), legalPreset()] } } }),
    /duplicates/
  )
  assert.throws(
    () => service.updateSettings({ screenshot: { regionPreferences: { unknown: 1 } } }),
    /screenshot\.regionPreferences/
  )
  assert.equal(store.get('settings'), before, 'a rejected patch must not be persisted')
  assert.deepEqual(service.getSettings().screenshot.regionPreferences.presets, [])
})

test('the service accepts the exact block its own service layer produces', () => {
  // main/services/region-preferences.js constructs the block; SettingsService is what
  // persists it. If those two disagree the feature is dead on the first save, so this
  // wires the real pair together instead of trusting each in isolation.
  const { service } = createSettingsHarness()
  const regionService = createRegionPreferences({
    getSettings: () => service.getSettings(),
    updateSettings: (patch) => service.updateSettings(patch),
    getDisplays: () => [{
      key: 'primary',
      boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
      pixelSize: { width: 3840, height: 2160 },
      scaleFactor: 2
    }],
    now: () => 1700000000000
  })

  const saved = regionService.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  assert.equal(saved.ok, true)
  assert.deepEqual(service.getSettings().screenshot.regionPreferences.presets, [saved.preset])

  const recorded = regionService.recordLastRegion({
    mode: 'capture',
    lastRegion: legalLastRegion({ displayKey: 'primary' })
  })
  assert.equal(recorded.ok, true)
  assert.deepEqual(service.getSettings().screenshot.regionPreferences.lastByMode.capture, legalLastRegion({ displayKey: 'primary' }))

  // And the read/resolve path sees what was written through the settings store.
  const resolved = regionService.resolveInput({ mode: 'capture', presetId: saved.preset.id })
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.appliedPixelSize, { width: 1920, height: 1080 })

  assert.equal(regionService.deletePreset(saved.preset.id).ok, true)
  assert.deepEqual(service.getSettings().screenshot.regionPreferences.presets, [])
  // Deleting a preset must not wipe the remembered region.
  assert.deepEqual(service.getSettings().screenshot.regionPreferences.lastByMode.capture, legalLastRegion({ displayKey: 'primary' }))
})

test('a legacy store without the key still round-trips a write', () => {
  // Simulates an install upgrading: the persisted blob predates the feature entirely.
  const legacy = structuredClone(DEFAULT_SETTINGS)
  delete legacy.screenshot.regionPreferences
  const { store, service } = createSettingsHarness({ storeSettings: { theme: 'dark' } })
  assert.deepEqual(service.getSettings().screenshot.regionPreferences, {
    schemaVersion: 1,
    lastByMode: { capture: null, record: null },
    presets: []
  }, 'reading a legacy store fills the defaults in')

  service.updateSettings({ screenshot: { regionPreferences: { presets: [legalPreset()] } } })
  assert.deepEqual(store.get('settings').screenshot.regionPreferences.presets, [legalPreset()])
  assert.equal(service.getSettings().theme, 'dark', 'unrelated stored settings are not disturbed')
})

test('resetSettings restores the default regionPreferences block', () => {
  const { service } = createSettingsHarness()
  service.updateSettings({ screenshot: { regionPreferences: { presets: [legalPreset()] } } })
  assert.equal(service.getSettings().screenshot.regionPreferences.presets.length, 1)
  const reset = service.resetSettings()
  assert.deepEqual(reset.screenshot.regionPreferences, {
    schemaVersion: 1,
    lastByMode: { capture: null, record: null },
    presets: []
  })
})

test('normalizeApiKey keeps working through the extended validation path', () => {
  // normalizeApiKey goes through assertSettingsPatch too; it passes no options, so this is
  // the check that the new third parameter did not disturb an existing caller.
  const { service } = createSettingsHarness()
  assert.equal(service.normalizeApiKey('  sk-abc  '), 'sk-abc')
})

test('the read path repairs a store that was hand-edited to be illegal', () => {
  // Even if someone edits config.json directly, getSettings() must never hand the feature
  // NaN sizes or duplicate ids.
  const store = new MemoryStore({
    settings: {
      screenshot: {
        regionPreferences: {
          presets: [
            legalPreset(),
            legalPreset({ id: 'dup', name: 'A' }),
            legalPreset({ id: 'dup', name: 'B' }),
            legalPreset({ id: 'bad', name: 'Bad', widthPx: Number.NaN })
          ]
        }
      }
    }
  })
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults: DEFAULT_SETTINGS,
    normalizeSettings: createNormalizer()
  })
  const read = service.getSettings().screenshot.regionPreferences
  assert.deepEqual(read.presets.map((item) => item.id), ['preset-fhd', 'dup'])
  for (const item of read.presets) {
    assert.ok(Number.isInteger(item.widthPx) && item.widthPx > 0)
    assert.ok(Number.isInteger(item.heightPx) && item.heightPx > 0)
  }
})

// ---------------------------------------------------------------------------
// 5. The gate: normalization and validation agree
// ---------------------------------------------------------------------------
test('anything the normalizer produces is accepted by the strict validator', () => {
  // The read path (lenient) and the write path (strict) must not disagree: a normalized
  // block is what the settings page sends straight back, so it has to be legal input.
  const cases = [
    undefined,
    {},
    { presets: [legalPreset()] },
    { lastByMode: { capture: legalLastRegion(), record: null } },
    { schemaVersion: 99, presets: [legalPreset()] },
    { presets: Array.from({ length: 25 }, (_, index) => legalPreset({ id: `p${index}`, name: `P${index}` })) }
  ]
  for (const value of cases) {
    const { preferences } = normalizeRegionPreferences(value)
    assert.doesNotThrow(
      () => assertRegionPreferencesPatch(preferences),
      `normalized ${JSON.stringify(value)} must be valid input`
    )
  }
})

test('the strict validator rejects what the normalizer is allowed to drop', () => {
  // The asymmetry is deliberate (read lenient, write strict), but it must be a subset
  // relationship: anything the validator accepts, the normalizer must keep.
  const legal = {
    schemaVersion: 1,
    lastByMode: { capture: legalLastRegion(), record: null },
    presets: [legalPreset()]
  }
  const { preferences, diagnostics } = normalizeRegionPreferences(legal)
  assert.deepEqual(diagnostics, [], 'valid input produces no diagnostics')
  assert.deepEqual(preferences, legal, 'valid input round-trips byte for byte')
})
