// Feature B (plan docs/plans/2026-10-25-snow-apps-feature-development-plan.md §5):
// shared/region-presets.js + main/services/region-preferences.js.
//
// The coordinate story this file pins down is the part that is easy to get wrong twice:
//   * a preset is an OUTPUT PIXEL size (positionless, reusable across monitors);
//   * a LastRegion is a position+size on ONE display, stored in that display's physical
//     pixels, with the DIP bounds/pixel size it was captured on so a DPI change can be
//     detected instead of silently resizing the region.
// Every conversion in the module goes through one per-axis map (displayScale ->
// rectDisplayPxToDip / rectDipToDisplayPx); the assertions below are what keeps a second
// formula from creeping in.

const test = require('node:test')
const assert = require('node:assert/strict')

const regionPresets = require('../shared/region-presets')
const {
  LIMITS,
  REGION_MODES,
  REGION_PREFERENCES_PATH,
  DEFAULT_REGION_PREFERENCES,
  createDefaultRegionPreferences,
  normalizeRegionPreferences,
  validateLastRegion,
  assertRegionPreferencesPatch,
  displayPixelBounds,
  rectDisplayPxToDip,
  rectDipToDisplayPx,
  resolvePresetRect,
  resolveLastRegion,
  createLastRegionFromSelection
} = regionPresets

const { createRegionPreferences } = require('../main/services/region-preferences')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// 1920x1080 DIP at 2x: the pixel space is 3840x2160. Same numbers the product's
// "150%/200% DPI" acceptance case uses (plan §5.3).
const PRIMARY_2X = Object.freeze({
  key: 'primary',
  boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
  pixelSize: { width: 3840, height: 2160 },
  scaleFactor: 2
})
const PRIMARY_1X = Object.freeze({
  key: 'primary',
  boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
  pixelSize: { width: 1920, height: 1080 },
  scaleFactor: 1
})
// A secondary monitor to the LEFT of the primary: Electron reports negative x, so the
// whole display lives in negative pixel space. This is why rectDisplayPx.x/y may be any
// signed integer rather than a non-negative one.
const LEFT_1X = Object.freeze({
  key: 'left',
  boundsDip: { x: -1600, y: 0, width: 1600, height: 900 },
  pixelSize: { width: 1600, height: 900 },
  scaleFactor: 1
})

function lastRegion(overrides = {}) {
  return {
    displayKey: PRIMARY_2X.key,
    displayBoundsDip: { ...PRIMARY_2X.boundsDip },
    displayPixelSize: { ...PRIMARY_2X.pixelSize },
    rectDisplayPx: { x: 100, y: 200, width: 800, height: 600 },
    capturedScaleFactor: PRIMARY_2X.scaleFactor,
    ...overrides
  }
}

function preset(overrides = {}) {
  return { id: 'preset-fhd', name: 'FHD', widthPx: 1920, heightPx: 1080, ...overrides }
}

function diagnosticsOf(result) {
  return result.diagnostics.map((item) => item.code)
}

function createHarness({ settings = {}, displays = [PRIMARY_2X], now = () => 1700000000000 } = {}) {
  const state = { settings, writes: [] }
  const service = createRegionPreferences({
    getSettings: () => state.settings,
    updateSettings: (patch) => {
      state.writes.push(patch)
      // Mirrors settings-service's deep merge closely enough for this file: the
      // screenshot block is merged one level down, which is the level regionPreferences
      // is written at (the whole block is always replaced).
      state.settings = {
        ...state.settings,
        screenshot: { ...(state.settings.screenshot || {}), ...patch.screenshot }
      }
    },
    getDisplays: () => displays,
    now
  })
  return { service, state }
}

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------
test('the resource guardrails match plan §3.3 (20 presets, 40-character names)', () => {
  assert.equal(LIMITS.MAX_PRESETS, 20)
  assert.equal(LIMITS.MAX_NAME_LENGTH, 40)
  assert.equal(LIMITS.MIN_EDGE_PX, 16)
  assert.equal(LIMITS.MAX_EDGE_PX, 10000)
  assert.equal(LIMITS.MAX_TOTAL_PIXELS, 80000000)
  assert.equal(LIMITS.SCHEMA_VERSION, 1)
  assert.deepEqual([...REGION_MODES], ['capture', 'record'])
  assert.equal(REGION_PREFERENCES_PATH, 'screenshot.regionPreferences')
})

test('the shipped default preferences are the documented shape and a fresh copy each call', () => {
  assert.deepEqual(DEFAULT_REGION_PREFERENCES, {
    schemaVersion: 1,
    lastByMode: { capture: null, record: null },
    presets: []
  })
  const first = createDefaultRegionPreferences()
  const second = createDefaultRegionPreferences()
  assert.deepEqual(first, DEFAULT_REGION_PREFERENCES)
  assert.notEqual(first, second, 'each caller needs a mutable copy')
  assert.notEqual(first.lastByMode, DEFAULT_REGION_PREFERENCES.lastByMode)
  assert.notEqual(first.presets, DEFAULT_REGION_PREFERENCES.presets)
  // The frozen default must not be reachable as a mutable singleton.
  assert.throws(() => { DEFAULT_REGION_PREFERENCES.presets.push(preset()) }, TypeError)
})

// ---------------------------------------------------------------------------
// normalizeRegionPreferences - the migration path (plan §5.2)
// ---------------------------------------------------------------------------
test('a missing regionPreferences block is the legal migration case, not an error', () => {
  // This is exactly what the plan says the template validator used to mis-reject: an
  // older store simply has no such key, and an empty presets array is valid.
  for (const input of [undefined, null, {}]) {
    const result = normalizeRegionPreferences(input)
    assert.deepEqual(result.preferences, createDefaultRegionPreferences(), `input ${JSON.stringify(input)}`)
    assert.deepEqual(result.diagnostics, [], 'a missing block is not a diagnostic')
  }
})

test('a missing lastByMode and a missing presets array normalize to the defaults', () => {
  const onlySchema = normalizeRegionPreferences({ schemaVersion: 1 })
  assert.deepEqual(onlySchema.preferences, createDefaultRegionPreferences())
  assert.deepEqual(onlySchema.diagnostics, [])

  const onlyPresets = normalizeRegionPreferences({ presets: [preset()] })
  assert.deepEqual(onlyPresets.preferences.lastByMode, { capture: null, record: null })
  assert.equal(onlyPresets.preferences.presets.length, 1)

  // An explicitly null lastByMode is equivalent to absent, not an error.
  const explicitNull = normalizeRegionPreferences({ lastByMode: null, presets: [] })
  assert.deepEqual(explicitNull.preferences, createDefaultRegionPreferences())
  assert.deepEqual(explicitNull.diagnostics, [])
})

test('normalization never throws on garbage input, it drops and reports', () => {
  for (const input of [42, 'nope', [], true, { lastByMode: 'no' }, { presets: 'no' }]) {
    const result = normalizeRegionPreferences(input)
    assert.ok(result.preferences, `input ${JSON.stringify(input)} should still produce preferences`)
    assert.ok(Array.isArray(result.diagnostics))
    assert.ok(result.diagnostics.length >= 1, `input ${JSON.stringify(input)} should be diagnosed`)
  }
  // A dropped block still yields a usable default rather than a hole.
  assert.deepEqual(normalizeRegionPreferences('nope').preferences, createDefaultRegionPreferences())
  assert.deepEqual(diagnosticsOf(normalizeRegionPreferences({ lastByMode: 'no' })), ['invalid-last-by-mode'])
  assert.deepEqual(diagnosticsOf(normalizeRegionPreferences({ presets: 'no' })), ['invalid-presets'])
})

test('a preset with an unknown field is kept with the known fields only', () => {
  const result = normalizeRegionPreferences({
    presets: [{ ...preset(), shortcut: 'Ctrl+1', favorite: true }]
  })
  assert.deepEqual(result.preferences.presets, [preset()])
  assert.deepEqual(Object.keys(result.preferences.presets[0]).sort(), ['heightPx', 'id', 'name', 'widthPx'])
})

test('preset names are trimmed and bounded to MAX_NAME_LENGTH', () => {
  const trimmed = normalizeRegionPreferences({ presets: [preset({ name: '  4K UHD  ' })] })
  assert.equal(trimmed.preferences.presets[0].name, '4K UHD')

  const exactLimit = 'a'.repeat(LIMITS.MAX_NAME_LENGTH)
  assert.equal(
    normalizeRegionPreferences({ presets: [preset({ name: exactLimit })] }).preferences.presets.length,
    1,
    'a name at the limit is legal'
  )
  for (const name of ['', '   ', 'a'.repeat(LIMITS.MAX_NAME_LENGTH + 1), 42, null, undefined]) {
    const result = normalizeRegionPreferences({ presets: [preset({ name })] })
    assert.equal(result.preferences.presets.length, 0, `name ${JSON.stringify(name)} must be dropped`)
    assert.deepEqual(diagnosticsOf(result), ['invalid-preset'])
  }
})

test('preset ids must be non-empty, bounded strings and are deduplicated keeping the first', () => {
  for (const id of ['', '   ', 'a'.repeat(65), 42, null, undefined]) {
    assert.equal(
      normalizeRegionPreferences({ presets: [preset({ id })] }).preferences.presets.length,
      0,
      `id ${JSON.stringify(id)} must be dropped`
    )
  }
  const duplicate = normalizeRegionPreferences({
    presets: [
      preset({ id: 'dup', name: 'First' }),
      preset({ id: 'dup', name: 'Second' })
    ]
  })
  assert.deepEqual(duplicate.preferences.presets.map((item) => item.name), ['First'], 'later duplicates are dropped')
  assert.deepEqual(diagnosticsOf(duplicate), ['duplicate-preset-id'])
})

test('preset sizes must be integers inside MIN/MAX_EDGE_PX', () => {
  const illegal = [
    { widthPx: 1920.5, heightPx: 1080 },
    { widthPx: 1920, heightPx: 1080.5 },
    { widthPx: Number.NaN, heightPx: 1080 },
    { widthPx: 1920, heightPx: Number.POSITIVE_INFINITY },
    { widthPx: 1920, heightPx: Number.NEGATIVE_INFINITY },
    { widthPx: LIMITS.MIN_EDGE_PX - 1, heightPx: 1080 },
    { widthPx: 1920, heightPx: LIMITS.MAX_EDGE_PX + 1 },
    { widthPx: -1920, heightPx: 1080 },
    { widthPx: '1920', heightPx: 1080 },
    { widthPx: null, heightPx: 1080 }
  ]
  for (const sizes of illegal) {
    const result = normalizeRegionPreferences({ presets: [preset(sizes)] })
    assert.equal(result.preferences.presets.length, 0, `sizes ${JSON.stringify(sizes)} must be dropped`)
    assert.deepEqual(diagnosticsOf(result), ['invalid-preset'])
  }
  // The inclusive edges are legal.
  const edges = normalizeRegionPreferences({
    presets: [preset({ id: 'min', widthPx: LIMITS.MIN_EDGE_PX, heightPx: LIMITS.MIN_EDGE_PX })]
  })
  assert.equal(edges.preferences.presets.length, 1)
})

test('a preset whose pixel count exceeds the budget is dropped', () => {
  const overBudget = normalizeRegionPreferences({
    presets: [preset({ widthPx: LIMITS.MAX_EDGE_PX, heightPx: LIMITS.MAX_EDGE_PX })]
  })
  assert.equal(overBudget.preferences.presets.length, 0)
  assert.deepEqual(diagnosticsOf(overBudget), ['invalid-preset'])

  // 8000 x 10000 = exactly the budget: allowed. 10000 x 10000 is not (and is covered
  // above); this pins the boundary so a future limit change cannot silently shift it.
  const exactlyBudget = normalizeRegionPreferences({
    presets: [preset({ widthPx: 8000, heightPx: 10000 })]
  })
  assert.equal(exactlyBudget.preferences.presets.length, 1)
})

test('more than MAX_PRESETS leaves the first 20 in insertion order, one diagnostic each', () => {
  const presets = Array.from({ length: LIMITS.MAX_PRESETS + 5 }, (_, index) => (
    preset({ id: `p-${index}`, name: `Preset ${index}`, widthPx: 100 + index, heightPx: 100 })
  ))
  const result = normalizeRegionPreferences({ presets })
  assert.equal(result.preferences.presets.length, LIMITS.MAX_PRESETS)
  assert.deepEqual(
    result.preferences.presets.map((item) => item.id),
    presets.slice(0, LIMITS.MAX_PRESETS).map((item) => item.id),
    'insertion order is preserved; the excess is dropped from the tail'
  )
  const dropped = result.diagnostics.filter((item) => item.code === 'preset-limit-exceeded')
  assert.equal(dropped.length, 5, 'one diagnostic per dropped item')
  assert.deepEqual(dropped.map((item) => item.path), [
    `presets[${LIMITS.MAX_PRESETS}]`,
    `presets[${LIMITS.MAX_PRESETS + 1}]`,
    `presets[${LIMITS.MAX_PRESETS + 2}]`,
    `presets[${LIMITS.MAX_PRESETS + 3}]`,
    `presets[${LIMITS.MAX_PRESETS + 4}]`
  ])
})

test('dropped items do not consume a preset slot', () => {
  // Five illegal items first, then 20 legal ones: the cap is on KEPT presets, so all 20
  // legal ones must survive.
  const presets = [
    ...Array.from({ length: 5 }, (_, index) => preset({ id: `bad-${index}`, name: '' })),
    ...Array.from({ length: LIMITS.MAX_PRESETS }, (_, index) => preset({ id: `good-${index}`, name: `Good ${index}` }))
  ]
  const result = normalizeRegionPreferences({ presets })
  assert.equal(result.preferences.presets.length, LIMITS.MAX_PRESETS)
  assert.ok(result.preferences.presets.every((item) => item.id.startsWith('good-')))
})

test('an unsupported schemaVersion is diagnosed but the recognised fields survive', () => {
  const result = normalizeRegionPreferences({ schemaVersion: 99, presets: [preset()] })
  assert.equal(result.preferences.schemaVersion, LIMITS.SCHEMA_VERSION)
  assert.equal(result.preferences.presets.length, 1, 'a future store is read as best it can be')
  assert.deepEqual(diagnosticsOf(result), ['unsupported-schema-version'])
})

test('normalization accepts negative rect x/y (a secondary display left of the primary)', () => {
  const result = normalizeRegionPreferences({
    lastByMode: {
      capture: lastRegion({
        displayKey: LEFT_1X.key,
        displayBoundsDip: { x: -1600, y: 0, width: 1600, height: 900 },
        displayPixelSize: { width: 1600, height: 900 },
        rectDisplayPx: { x: -1500, y: 300, width: 640, height: 480 },
        capturedScaleFactor: 1
      })
    }
  })
  assert.deepEqual(result.preferences.lastByMode.capture.rectDisplayPx, { x: -1500, y: 300, width: 640, height: 480 })
  assert.deepEqual(result.diagnostics, [], 'negative coordinates are legal, not a diagnostic')
})

test('an invalid last region is dropped to null with a diagnostic, per mode independently', () => {
  const result = normalizeRegionPreferences({
    lastByMode: {
      capture: lastRegion({ rectDisplayPx: { x: 0, y: 0, width: 0, height: 0 } }),
      record: lastRegion()
    }
  })
  assert.equal(result.preferences.lastByMode.capture, null)
  assert.ok(result.preferences.lastByMode.record, 'a broken capture region must not take the record region with it')
  assert.deepEqual(result.diagnostics.map((item) => item.path), ['lastByMode.capture'])
})

// ---------------------------------------------------------------------------
// validateLastRegion
// ---------------------------------------------------------------------------
test('a well-formed LastRegion validates and only known fields come back', () => {
  const result = validateLastRegion({ ...lastRegion(), injected: 'drop me' })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.value).sort(), [
    'capturedScaleFactor',
    'displayBoundsDip',
    'displayKey',
    'displayPixelSize',
    'rectDisplayPx'
  ])
})

test('validateLastRegion rejects every field-level violation with a code', () => {
  const cases = [
    [null, 'not-an-object'],
    ['nope', 'not-an-object'],
    [lastRegion({ displayKey: '' }), 'display-key-invalid'],
    [lastRegion({ displayKey: '   ' }), 'display-key-invalid'],
    [lastRegion({ displayKey: 'a'.repeat(129) }), 'display-key-invalid'],
    [lastRegion({ displayBoundsDip: { x: 0, y: 0, width: 1920 } }), 'display-bounds-invalid'],
    [lastRegion({ displayBoundsDip: { x: 0, y: 0, width: '1920', height: 1080 } }), 'display-bounds-invalid'],
    [lastRegion({ displayPixelSize: { width: 0, height: 1080 } }), 'display-pixel-size-invalid'],
    [lastRegion({ displayPixelSize: { width: 1920.5, height: 1080 } }), 'display-pixel-size-invalid'],
    [lastRegion({ displayPixelSize: { width: -1920, height: 1080 } }), 'display-pixel-size-invalid'],
    [lastRegion({ rectDisplayPx: { x: 0, y: 0, width: 0, height: 100 } }), 'rect-invalid'],
    [lastRegion({ rectDisplayPx: { x: 0, y: 0, width: 100 } }), 'rect-invalid'],
    [lastRegion({ rectDisplayPx: { x: 0.5, y: 0, width: 100, height: 100 } }), 'rect-invalid'],
    [lastRegion({ capturedScaleFactor: 0 }), 'scale-factor-invalid'],
    [lastRegion({ capturedScaleFactor: 0.4 }), 'scale-factor-invalid'],
    [lastRegion({ capturedScaleFactor: 8.5 }), 'scale-factor-invalid'],
    [lastRegion({ capturedScaleFactor: Number.NaN }), 'scale-factor-invalid']
  ]
  for (const [value, code] of cases) {
    const result = validateLastRegion(value)
    assert.equal(result.ok, false, `${JSON.stringify(value)} should be rejected`)
    assert.equal(result.code, code, `${JSON.stringify(value)} should fail with ${code}`)
  }
})

test('a numeric display id is accepted as its string form (Electron reports display.id as a number)', () => {
  const result = validateLastRegion(lastRegion({ displayKey: 2528732444 }))
  assert.equal(result.ok, true)
  assert.equal(result.value.displayKey, '2528732444')
})

// ---------------------------------------------------------------------------
// Round trip: selection -> LastRegion -> validation
// ---------------------------------------------------------------------------
test('createLastRegionFromSelection round-trips through validateLastRegion', () => {
  const created = createLastRegionFromSelection({
    selection: { x: 640, y: 360, width: 1280, height: 720 },
    display: PRIMARY_2X
  })
  const validated = validateLastRegion(created)
  assert.equal(validated.ok, true)
  assert.deepEqual(validated.value, created)
  assert.deepEqual(created.rectDisplayPx, { x: 640, y: 360, width: 1280, height: 720 })
  assert.deepEqual(created.displayPixelSize, { width: 3840, height: 2160 })
  assert.equal(created.capturedScaleFactor, 2)
})

test('createLastRegionFromSelection rounds to integers and refuses unusable geometry', () => {
  const rounded = createLastRegionFromSelection({
    selection: { x: 10.4, y: 20.6, width: 100.5, height: 50.4 },
    display: PRIMARY_1X
  })
  assert.deepEqual(rounded.rectDisplayPx, { x: 10, y: 21, width: 101, height: 50 })

  // Everything below must produce null rather than a corrupt record: the caller then
  // simply skips recording instead of poisoning the store.
  const refused = [
    { selection: { x: 0, y: 0, width: 0, height: 100 }, display: PRIMARY_1X },
    { selection: { x: 0, y: 0, width: 100, height: 0.2 }, display: PRIMARY_1X },
    { selection: { x: 0, y: 0, width: Number.NaN, height: 100 }, display: PRIMARY_1X },
    { selection: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }, display: PRIMARY_1X },
    { selection: { x: 0, y: 0, width: -100, height: 100 }, display: PRIMARY_1X },
    { selection: null, display: PRIMARY_1X },
    { selection: { x: 0, y: 0, width: 100, height: 100 }, display: null },
    { selection: { x: 0, y: 0, width: 100, height: 100 }, display: { key: 'x' } },
    { selection: { x: 0, y: 0, width: 100, height: 100 }, display: PRIMARY_1X, space: 'nonsense' }
  ]
  for (const input of refused) {
    assert.equal(createLastRegionFromSelection(input), null, `${JSON.stringify(input)} must be refused`)
  }
})

test('createLastRegionFromSelection converts DIP selections when asked (capture sends DIP bounds)', () => {
  // main/domains/capture/index.js computes selectionBounds in DIP, so a caller wiring the
  // real capture path passes space:'dip' and gets physical pixels back.
  const created = createLastRegionFromSelection({
    selection: { x: 100, y: 200, width: 400, height: 300 },
    display: PRIMARY_2X,
    space: 'dip'
  })
  assert.deepEqual(created.rectDisplayPx, { x: 200, y: 400, width: 800, height: 600 })
  // And the default space is display pixels, so the same numbers mean twice the area.
  const asPixels = createLastRegionFromSelection({
    selection: { x: 100, y: 200, width: 400, height: 300 },
    display: PRIMARY_2X
  })
  assert.deepEqual(asPixels.rectDisplayPx, { x: 100, y: 200, width: 400, height: 300 })
})

// ---------------------------------------------------------------------------
// The single per-axis mapping
// ---------------------------------------------------------------------------
test('px <-> DIP conversion is per axis and round-trips (mixed/rotated DPI)', () => {
  assert.deepEqual(rectDisplayPxToDip({
    rect: { x: 960, y: 540, width: 1920, height: 1080 },
    display: PRIMARY_2X
  }), { x: 480, y: 270, width: 960, height: 540 })
  assert.deepEqual(rectDipToDisplayPx({
    rect: { x: 480, y: 270, width: 960, height: 540 },
    display: PRIMARY_2X
  }), { x: 960, y: 540, width: 1920, height: 1080 })

  // 90-degree rotation: pixel width/height swap against the DIP box, so each axis must be
  // scaled by its own ratio rather than by one shared scale factor.
  const rotated = {
    key: 'rotated',
    boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
    pixelSize: { width: 2160, height: 3840 },
    scaleFactor: 2
  }
  assert.deepEqual(rectDipToDisplayPx({ rect: { x: 100, y: 100, width: 200, height: 200 }, display: rotated }), {
    x: 113, y: 356, width: 225, height: 711
  })
  assert.deepEqual(displayPixelBounds(rotated), { x: 0, y: 0, width: 2160, height: 3840 })
})

test('displayPixelBounds maps a negative DIP origin into negative pixel space', () => {
  // The left-hand monitor at 2x: its DIP origin is -1600, its pixel origin -3200.
  const left2x = {
    key: 'left',
    boundsDip: { x: -1600, y: 0, width: 1600, height: 900 },
    pixelSize: { width: 3200, height: 1800 },
    scaleFactor: 2
  }
  assert.deepEqual(displayPixelBounds(left2x), { x: -3200, y: 0, width: 3200, height: 1800 })
})

test('conversions refuse unusable geometry rather than returning NaN', () => {
  assert.equal(rectDisplayPxToDip({ rect: { x: 0, y: 0, width: 10, height: 10 }, display: null }), null)
  assert.equal(rectDisplayPxToDip({ rect: null, display: PRIMARY_1X }), null)
  assert.equal(rectDipToDisplayPx({ rect: { x: 0, y: 0, width: 10, height: 10 }, display: { boundsDip: { x: 0, y: 0, width: 0, height: 0 } } }), null)
})

// ---------------------------------------------------------------------------
// resolvePresetRect
// ---------------------------------------------------------------------------
test('an exactly fitting preset is centred with no adjustment', () => {
  const result = resolvePresetRect({
    preset: preset({ widthPx: 1920, heightPx: 1080 }),
    displayPixelSize: { width: 1920, height: 1080 },
    displayBoundsDip: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rectDisplayPx, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(result.rectDip, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(result.adjusted, [], 'nothing was changed, so nothing is reported')
  assert.deepEqual(result.appliedPixelSize, { width: 1920, height: 1080 })
})

test('a smaller preset is centred in the display', () => {
  const result = resolvePresetRect({
    preset: preset({ widthPx: 800, heightPx: 600 }),
    displayPixelSize: { width: 1920, height: 1080 },
    displayBoundsDip: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  assert.deepEqual(result.rectDisplayPx, { x: 560, y: 240, width: 800, height: 600 })
  assert.deepEqual(result.adjusted, [])
})

test('centring honours a non-zero display origin (secondary monitor, negative x)', () => {
  const result = resolvePresetRect({
    preset: preset({ widthPx: 800, heightPx: 600 }),
    displayPixelSize: { width: 1600, height: 900 },
    displayBoundsDip: { x: -1600, y: 0, width: 1600, height: 900 }
  })
  // Centre of a DIP box starting at -1600 and 1600 wide: -1600 + (1600 - 800) / 2 = -1200.
  assert.deepEqual(result.rectDisplayPx, { x: -1200, y: 150, width: 800, height: 600 })
  assert.deepEqual(result.adjusted, [])
})

test('an oversized preset is clamped to the screen and says so with the real size', () => {
  const result = resolvePresetRect({
    preset: preset({ widthPx: 4000, heightPx: 3000 }),
    displayPixelSize: { width: 1920, height: 1080 },
    displayBoundsDip: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rectDisplayPx, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(result.appliedPixelSize, { width: 1920, height: 1080 })
  assert.deepEqual(result.adjusted, [{
    code: 'clamped-to-screen',
    requestedPixelSize: { width: 4000, height: 3000 },
    appliedPixelSize: { width: 1920, height: 1080 }
  }], 'the caller can tell the user the real size instead of claiming the preset was honoured')
})

test('clamping is per axis: only the overflowing dimension is adjusted', () => {
  const result = resolvePresetRect({
    preset: preset({ widthPx: 800, heightPx: 4000 }),
    displayPixelSize: { width: 1920, height: 1080 },
    displayBoundsDip: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  assert.deepEqual(result.appliedPixelSize, { width: 800, height: 1080 })
  assert.equal(result.adjusted.length, 1)
  assert.equal(result.adjusted[0].code, 'clamped-to-screen')
})

test('resolvePresetRect reports invalid input instead of guessing', () => {
  assert.equal(resolvePresetRect({}).ok, false)
  assert.equal(resolvePresetRect({ preset: null }).code, 'invalid-preset')
  assert.equal(resolvePresetRect({
    preset: preset(),
    displayPixelSize: { width: 0, height: 1080 },
    displayBoundsDip: { x: 0, y: 0, width: 1920, height: 1080 }
  }).code, 'invalid-display')
  assert.equal(resolvePresetRect({ preset: preset(), displayPixelSize: { width: 1920, height: 1080 } }).code, 'invalid-display')
})

// ---------------------------------------------------------------------------
// resolveLastRegion
// ---------------------------------------------------------------------------
test('an exact displayKey match resolves the stored region unchanged', () => {
  const stored = lastRegion()
  const result = resolveLastRegion({ lastRegion: stored, displays: [PRIMARY_2X] })
  assert.equal(result.ok, true)
  assert.equal(result.displayKey, 'primary')
  assert.deepEqual(result.rectDisplayPx, stored.rectDisplayPx)
  assert.deepEqual(result.adjusted, [])
})

test('a renamed display still matches by identical DIP bounds (ids are not stable across reboots)', () => {
  const stored = lastRegion()
  const renamed = { ...PRIMARY_2X, key: 'DISPLAY2-after-reboot' }
  const result = resolveLastRegion({ lastRegion: stored, displays: [renamed] })
  assert.equal(result.ok, true)
  assert.equal(result.displayKey, 'DISPLAY2-after-reboot')
  assert.deepEqual(result.rectDisplayPx, stored.rectDisplayPx)
})

test('key match wins over a bounds match on a different display', () => {
  const stored = lastRegion()
  // The second entry has the same bounds but a different key; the key match must win.
  const decoy = { ...PRIMARY_2X, key: 'decoy', boundsDip: { x: 0, y: 0, width: 3000, height: 2000 } }
  const result = resolveLastRegion({ lastRegion: stored, displays: [decoy, PRIMARY_2X] })
  assert.equal(result.displayKey, 'primary')
})

test('a changed display layout returns ok:false + display-changed (centre on the current screen)', () => {
  const result = resolveLastRegion({
    lastRegion: lastRegion(),
    displays: [{ key: 'different', boundsDip: { x: 0, y: 0, width: 2560, height: 1440 }, pixelSize: { width: 2560, height: 1440 }, scaleFactor: 1 }]
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'display-changed')
  assert.equal(result.rectDisplayPx, null)
  assert.equal(resolveLastRegion({ lastRegion: lastRegion(), displays: [] }).code, 'display-changed')
  assert.equal(resolveLastRegion({ lastRegion: null, displays: [PRIMARY_2X] }).ok, false)
})

test('a region that is now partly outside is clipped and reports rect-outside-display', () => {
  // Stored at the far right/bottom of the old 3840x2160 pixel area, then the display got
  // smaller: the rect no longer fits.
  const stored = lastRegion({ rectDisplayPx: { x: 3400, y: 2000, width: 1000, height: 400 } })
  const smaller = { ...PRIMARY_2X, boundsDip: { x: 0, y: 0, width: 1920, height: 1080 }, pixelSize: { width: 1920, height: 1080 }, scaleFactor: 1 }
  const result = resolveLastRegion({ lastRegion: stored, displays: [{ ...smaller, key: 'primary' }] })
  assert.equal(result.ok, true)
  assert.equal(result.adjusted.some((item) => item.code === 'rect-outside-display'), true)
  // The returned rect is inside the current display.
  assert.ok(result.rectDisplayPx.x >= 0 && result.rectDisplayPx.y >= 0)
  assert.ok(result.rectDisplayPx.x + result.rectDisplayPx.width <= 1920)
  assert.ok(result.rectDisplayPx.y + result.rectDisplayPx.height <= 1080)
})

test('a region entirely outside the current display is display-changed, not a clipped sliver', () => {
  const stored = lastRegion({ rectDisplayPx: { x: 9000, y: 9000, width: 100, height: 100 } })
  const result = resolveLastRegion({ lastRegion: stored, displays: [{ ...PRIMARY_2X, key: 'primary' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'display-changed')
})

test('a DPI change is reported and the region keeps its physical size', () => {
  // Stored on a 2x screen (3840x2160 pixels) then opened on the same screen at 1x
  // (1920x1080): the same PHYSICAL area is now half as many pixels, and the user must be
  // told the screen changed instead of the region silently shrinking.
  const stored = lastRegion({ rectDisplayPx: { x: 960, y: 540, width: 1920, height: 1080 } })
  const result = resolveLastRegion({ lastRegion: stored, displays: [PRIMARY_1X] })
  assert.equal(result.ok, true)
  assert.equal(result.adjusted.some((item) => item.code === 'display-pixel-size-changed'), true)
  assert.deepEqual(result.rectDisplayPx, { x: 480, y: 270, width: 960, height: 540 })
  assert.deepEqual(result.rectDip, { x: 480, y: 270, width: 960, height: 540 })
})

// ---------------------------------------------------------------------------
// assertRegionPreferencesPatch - the strict write-path entry point
// ---------------------------------------------------------------------------
test('assertRegionPreferencesPatch accepts legal preferences and returns them unchanged', () => {
  const legal = {
    schemaVersion: 1,
    lastByMode: { capture: lastRegion(), record: null },
    presets: [preset(), preset({ id: 'preset-hd', name: 'HD', widthPx: 1280, heightPx: 720 })]
  }
  assert.equal(assertRegionPreferencesPatch(legal), legal, 'the same object comes back for the merge')
  assert.deepEqual(assertRegionPreferencesPatch({}), {}, 'a patch that sets nothing is legal')
  assert.deepEqual(assertRegionPreferencesPatch({ presets: [] }), { presets: [] })
})

test('assertRegionPreferencesPatch rejects illegal input instead of coercing it', () => {
  const rejects = [
    [null, TypeError],
    ['text', TypeError],
    [[], TypeError],
    [{ unknown: 1 }, TypeError],
    [{ presets: 'no' }, TypeError],
    [{ presets: Array.from({ length: LIMITS.MAX_PRESETS + 1 }, (_, index) => preset({ id: `p${index}`, name: `N${index}` })) }, RangeError],
    [{ presets: [preset({ widthPx: 1920.5 })] }, TypeError],
    [{ presets: [preset({ id: '' })] }, TypeError],
    [{ presets: [preset({ name: '' })] }, TypeError],
    [{ presets: [preset(), preset()] }, TypeError],
    [{ presets: [{ ...preset(), extra: true }] }, TypeError],
    [{ lastByMode: [] }, TypeError],
    [{ lastByMode: { capture: 'no' } }, TypeError],
    [{ lastByMode: { cam: null } }, TypeError],
    [{ lastByMode: { capture: { ...lastRegion(), extra: 1 } } }, TypeError],
    [{ schemaVersion: 2 }, RangeError]
  ]
  for (const [value, errorClass] of rejects) {
    assert.throws(
      () => assertRegionPreferencesPatch(value),
      errorClass,
      `expected ${errorClass.name} for ${JSON.stringify(value)}`
    )
  }
})

test('assertRegionPreferencesPatch error messages name the offending path', () => {
  assert.throws(
    () => assertRegionPreferencesPatch({ presets: [preset({ widthPx: 1 })] }),
    /screenshot\.regionPreferences\.presets\[0\].*width-invalid/
  )
  assert.throws(
    () => assertRegionPreferencesPatch({ lastByMode: { capture: lastRegion({ capturedScaleFactor: 0 }) } }),
    /screenshot\.regionPreferences\.lastByMode\.capture.*scale-factor-invalid/
  )
})

// ---------------------------------------------------------------------------
// main/services/region-preferences.js
// ---------------------------------------------------------------------------
test('the service refuses to build without its collaborators', () => {
  assert.throws(() => createRegionPreferences({}), /getSettings/)
  assert.throws(() => createRegionPreferences({ getSettings: () => ({}) }), /updateSettings/)
})

test('read() returns the normalized defaults when nothing was ever stored', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  assert.deepEqual(service.read(), createDefaultRegionPreferences())
})

test('read() survives a hand-edited store and logs each problem once', () => {
  const logged = []
  const state = {
    settings: {
      screenshot: {
        regionPreferences: {
          presets: [preset(), preset({ widthPx: Number.NaN })],
          lastByMode: { capture: { nope: true } }
        }
      }
    },
    writes: []
  }
  const service = createRegionPreferences({
    getSettings: () => state.settings,
    updateSettings: (patch) => { state.writes.push(patch) },
    getDisplays: () => [PRIMARY_2X],
    log: (message) => logged.push(message)
  })
  const first = service.read()
  assert.equal(first.presets.length, 1)
  assert.equal(first.lastByMode.capture, null)
  assert.equal(logged.length, 2, 'one diagnostic per problem')
  service.read()
  service.read()
  assert.equal(logged.length, 2, 'the same diagnostic must not be logged on every read')
})

test('savePreset appends a new preset and persists the whole block', () => {
  const { service, state } = createHarness({ settings: { screenshot: {} } })
  const result = service.savePreset({ name: '  FHD  ', widthPx: 1920, heightPx: 1080 })
  assert.equal(result.ok, true)
  assert.equal(result.preset.name, 'FHD', 'the name is trimmed')
  assert.equal(result.preset.widthPx, 1920)
  assert.ok(result.preset.id, 'an id is allocated')
  assert.equal(state.writes.length, 1)
  assert.deepEqual(state.writes[0], { screenshot: { regionPreferences: state.settings.screenshot.regionPreferences } })
  assert.deepEqual(service.read().presets, [result.preset])
})

test('savePreset with an existing id updates that preset in place', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  const created = service.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  const updated = service.savePreset({ id: created.preset.id, name: 'FHD wide', widthPx: 1920, heightPx: 1200 })
  assert.equal(updated.ok, true)
  assert.equal(updated.preset.id, created.preset.id, 'the id is reused, not reallocated')
  assert.equal(updated.preset.name, 'FHD wide')
  assert.equal(updated.preset.heightPx, 1200)
  assert.equal(service.read().presets.length, 1, 'an update must not append')
})

test('savePreset reports duplicate-name, invalid-preset and limit-reached', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  service.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  assert.equal(service.savePreset({ name: 'fhd', widthPx: 800, heightPx: 600 }).code, 'duplicate-name', 'case-insensitive')

  for (const input of [
    { name: '', widthPx: 1920, heightPx: 1080 },
    { name: 'x'.repeat(LIMITS.MAX_NAME_LENGTH + 1), widthPx: 1920, heightPx: 1080 },
    { name: 'ok', widthPx: 1920.5, heightPx: 1080 },
    { name: 'ok', widthPx: LIMITS.MIN_EDGE_PX - 1, heightPx: 1080 },
    { name: 'ok', widthPx: LIMITS.MAX_EDGE_PX, heightPx: LIMITS.MAX_EDGE_PX },
    { name: 'ok', widthPx: '1920', heightPx: 1080 }
  ]) {
    const result = service.savePreset(input)
    assert.equal(result.ok, false, `${JSON.stringify(input)} should be rejected`)
    assert.equal(result.code, 'invalid-preset')
    assert.ok(result.message.length > 0)
  }

  // Fill to the cap, then one more.
  const filler = createHarness({ settings: { screenshot: {} } })
  for (let index = 0; index < LIMITS.MAX_PRESETS; index += 1) {
    const saved = filler.service.savePreset({ name: `P${index}`, widthPx: 100 + index, heightPx: 100 })
    assert.equal(saved.ok, true, `preset ${index} should save`)
  }
  assert.equal(filler.service.read().presets.length, LIMITS.MAX_PRESETS)
  assert.equal(filler.service.savePreset({ name: 'one too many', widthPx: 400, heightPx: 400 }).code, 'limit-reached')
})

test('savePreset can still UPDATE an existing preset once the cap is reached', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  for (let index = 0; index < LIMITS.MAX_PRESETS; index += 1) {
    service.savePreset({ name: `P${index}`, widthPx: 100 + index, heightPx: 100 })
  }
  const target = service.read().presets[0]
  const updated = service.savePreset({ id: target.id, name: 'renamed', widthPx: 640, heightPx: 480 })
  assert.equal(updated.ok, true, 'the cap is on the number of presets, not on editing one')
  assert.equal(service.read().presets.length, LIMITS.MAX_PRESETS)
})

test('deletePreset removes a preset and reports not-found for an unknown id', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  const created = service.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  assert.deepEqual(service.deletePreset(created.preset.id), { ok: true, preferences: createDefaultRegionPreferences() })
  assert.deepEqual(service.read().presets, [])
  assert.equal(service.deletePreset(created.preset.id).code, 'not-found')
  assert.equal(service.deletePreset('').code, 'not-found')
  assert.equal(service.deletePreset(undefined).code, 'not-found')
})

test('recordLastRegion keeps capture and record completely independent', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  const captureRegion = lastRegion({ rectDisplayPx: { x: 0, y: 0, width: 800, height: 600 } })
  const recordRegion = lastRegion({ rectDisplayPx: { x: 100, y: 100, width: 1280, height: 720 } })

  assert.equal(service.recordLastRegion({ mode: 'capture', lastRegion: captureRegion }).ok, true)
  assert.deepEqual(service.read().lastByMode.record, null, 'recording capture must not touch record')

  assert.equal(service.recordLastRegion({ mode: 'record', lastRegion: recordRegion }).ok, true)
  const read = service.read()
  assert.deepEqual(read.lastByMode.capture.rectDisplayPx, captureRegion.rectDisplayPx)
  assert.deepEqual(read.lastByMode.record.rectDisplayPx, recordRegion.rectDisplayPx)

  // Overwriting one mode leaves the other untouched.
  const nextCapture = lastRegion({ rectDisplayPx: { x: 40, y: 40, width: 400, height: 300 } })
  const result = service.recordLastRegion({ mode: 'capture', lastRegion: nextCapture })
  assert.deepEqual(result.lastByMode.capture.rectDisplayPx, nextCapture.rectDisplayPx)
  assert.deepEqual(result.lastByMode.record.rectDisplayPx, recordRegion.rectDisplayPx)
})

test('recordLastRegion refuses an invalid region or mode', () => {
  const { service, state } = createHarness({ settings: { screenshot: {} } })
  assert.equal(service.recordLastRegion({ mode: 'video', lastRegion: lastRegion() }).code, 'invalid-mode')
  assert.equal(service.recordLastRegion({ mode: 'capture', lastRegion: null }).code, 'invalid-last-region')
  assert.equal(service.recordLastRegion({ mode: 'capture', lastRegion: { displayKey: 'x' } }).code, 'invalid-last-region')
  assert.equal(state.writes.length, 0, 'a refused record must not write')
})

test('resolveInput resolves a preset against the current display', () => {
  const { service } = createHarness({ settings: { screenshot: {} }, displays: [PRIMARY_2X] })
  const created = service.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  const result = service.resolveInput({ mode: 'capture', presetId: created.preset.id })
  assert.equal(result.ok, true)
  assert.equal(result.displayKey, 'primary')
  // 1920x1080 output pixels on a 2x screen = a 960x540 DIP window, centred.
  assert.deepEqual(result.rectDisplayPx, { x: 960, y: 540, width: 1920, height: 1080 })
  assert.deepEqual(result.rectDip, { x: 480, y: 270, width: 960, height: 540 })
  assert.deepEqual(result.appliedPixelSize, { width: 1920, height: 1080 })
  assert.deepEqual(result.adjusted, [])
})

test('resolveInput propagates clamped-to-screen for an oversized preset', () => {
  const { service } = createHarness({ settings: { screenshot: {} }, displays: [PRIMARY_1X] })
  const created = service.savePreset({ name: '4K', widthPx: 3840, heightPx: 2160 })
  const result = service.resolveInput({ mode: 'capture', presetId: created.preset.id })
  assert.equal(result.ok, true)
  assert.deepEqual(result.appliedPixelSize, { width: 1920, height: 1080 })
  assert.equal(result.adjusted[0].code, 'clamped-to-screen')
})

test('resolveInput with last:true uses the region recorded for that mode', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  const region = lastRegion({ rectDisplayPx: { x: 200, y: 300, width: 640, height: 480 } })
  service.recordLastRegion({ mode: 'record', lastRegion: region })

  assert.equal(service.resolveInput({ mode: 'capture', last: true }).code, 'no-last-region')
  const result = service.resolveInput({ mode: 'record', last: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rectDisplayPx, { x: 200, y: 300, width: 640, height: 480 })
  assert.deepEqual(result.adjusted, [])
})

test('resolveInput reports display-changed when the remembered region cannot be placed', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  service.recordLastRegion({ mode: 'capture', lastRegion: lastRegion() })
  // Same service, but the display list no longer contains the remembered display.
  const changed = createRegionPreferences({
    getSettings: () => ({ screenshot: { regionPreferences: service.read() } }),
    updateSettings: () => {},
    getDisplays: () => [{ key: 'new', boundsDip: { x: 0, y: 0, width: 2560, height: 1440 }, pixelSize: { width: 2560, height: 1440 }, scaleFactor: 1 }]
  })
  const result = changed.resolveInput({ mode: 'capture', last: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'display-changed')
})

test('resolveInput validates its own input instead of resolving something arbitrary', () => {
  const { service } = createHarness({ settings: { screenshot: {} } })
  // mode is checked first: without a mode there is nothing to resolve against.
  assert.equal(service.resolveInput({}).code, 'invalid-mode')
  assert.equal(service.resolveInput({ mode: 'other', last: true }).code, 'invalid-mode')
  assert.equal(service.resolveInput({ mode: 'capture', presetId: 'missing' }).code, 'not-found')
  assert.equal(service.resolveInput({ mode: 'capture' }).code, 'invalid-input')
  assert.equal(service.resolveInput({ mode: 'capture', last: false }).code, 'invalid-input')
})

test('resolveInput can use the injected resolveDisplay provider when no list exists', () => {
  const region = lastRegion({ rectDisplayPx: { x: 50, y: 60, width: 400, height: 300 } })
  const calls = []
  const service = createRegionPreferences({
    getSettings: () => ({ screenshot: { regionPreferences: { lastByMode: { capture: region, record: null }, presets: [] } } }),
    updateSettings: () => {},
    resolveDisplay: (rect) => {
      calls.push(rect)
      return { ...PRIMARY_2X, key: 'primary' }
    }
  })
  const result = service.resolveInput({ mode: 'capture', last: true })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [region.rectDisplayPx], 'the stored rect is what identifies the display')
  assert.deepEqual(result.rectDisplayPx, region.rectDisplayPx)
})

test('resolveInput reports display-unavailable when neither provider is injected', () => {
  const service = createRegionPreferences({
    getSettings: () => ({ screenshot: {} }),
    updateSettings: () => {}
  })
  assert.equal(service.resolveInput({ mode: 'capture', last: true }).code, 'no-last-region')
  const withPreset = createRegionPreferences({
    getSettings: () => ({
      screenshot: { regionPreferences: { presets: [preset()] } }
    }),
    updateSettings: () => {}
  })
  assert.equal(withPreset.resolveInput({ mode: 'capture', presetId: preset().id }).code, 'display-unavailable')
})

test('reset() restores the shipped defaults and persists them', () => {
  const { service, state } = createHarness({ settings: { screenshot: {} } })
  service.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  service.recordLastRegion({ mode: 'capture', lastRegion: lastRegion() })
  const reset = service.reset()
  assert.deepEqual(reset, createDefaultRegionPreferences())
  assert.deepEqual(service.read(), createDefaultRegionPreferences())
  assert.deepEqual(state.writes.at(-1), { screenshot: { regionPreferences: createDefaultRegionPreferences() } })
})

test('dependency injection: an injected domain module is the only domain implementation used', () => {
  const calls = []
  const stub = {
    normalizeRegionPreferences: (value) => { calls.push('normalize'); return { preferences: createDefaultRegionPreferences(), diagnostics: [] } },
    validateLastRegion: (value) => { calls.push('validate'); return regionPresets.validateLastRegion(value) },
    assertRegionPreferencesPatch: (value) => { calls.push('assert'); return regionPresets.assertRegionPreferencesPatch(value) },
    createDefaultRegionPreferences: () => { calls.push('defaults'); return createDefaultRegionPreferences() },
    resolvePresetRect: (input) => { calls.push('resolvePreset'); return regionPresets.resolvePresetRect(input) },
    resolveLastRegion: (input) => { calls.push('resolveLast'); return regionPresets.resolveLastRegion(input) }
  }
  const service = createRegionPreferences({
    getSettings: () => ({ screenshot: {} }),
    updateSettings: () => {},
    getDisplays: () => [PRIMARY_1X],
    normalize: stub
  })
  service.read()
  service.recordLastRegion({ mode: 'capture', lastRegion: lastRegion() })
  service.reset()
  // read(); record = validate + read() + assert; reset = defaults + assert. Every domain
  // operation goes through the injected module - nothing reaches for the shared default.
  assert.deepEqual(calls, ['normalize', 'validate', 'normalize', 'assert', 'defaults', 'assert'])
})

test('the service never writes a block that the strict validator would reject', () => {
  // Every write in this file goes through checkPatch -> assertRegionPreferencesPatch. A
  // settings-service integration (test/settings-region-preferences.test.js) runs the same
  // object through the real template + domain validator; this is the service-side half.
  const { service, state } = createHarness({ settings: { screenshot: {} } })
  service.savePreset({ name: 'FHD', widthPx: 1920, heightPx: 1080 })
  service.recordLastRegion({ mode: 'capture', lastRegion: lastRegion() })
  service.deletePreset(service.read().presets[0].id)
  assert.equal(state.writes.length, 3)
  for (const patch of state.writes) {
    assert.doesNotThrow(() => assertRegionPreferencesPatch(patch.screenshot.regionPreferences))
  }
})
