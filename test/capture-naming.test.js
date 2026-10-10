// P0-7-T8: unit tests for the capture naming module. The module has no test
// before this file, and it is the single place where the forward generator and
// the ownership matcher that HistoryService trusts are defined — so the cases
// below assert the same-source property (plan R9) as explicitly as possible.
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CAPTURE_PREFIX,
  LONG_CAPTURE_PREFIX,
  VIDEO_CAPTURE_PREFIX,
  DEFAULT_APP_LABEL,
  TEMPLATE_VARIABLES,
  OWNED_CAPTURE_FILE,
  renderNameTemplate,
  sanitizeFileName,
  ensureUniqueName,
  makeCaptureName
} = require('../main/services/capture-naming')

// 2026-10-10T12:00:00Z is 2026-10-10 20:00:00 in China Standard Time (UTC+8).
const NOON_UTC = Date.UTC(2026, 9, 10, 12, 0, 0)
const LEGACY_NAME = 'Highlighter_2026-10-10_20-00-00-000.png'

test('the legacy format is unchanged and still owned by the history library', () => {
  assert.equal(makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC }), LEGACY_NAME)
  assert.match(makeCaptureName(), /^Highlighter_\d{4}-\d{2}-\d{2}_[\d-]+\.png$/)
  assert.match(makeCaptureName(), OWNED_CAPTURE_FILE)
})

test('every existing single-argument call site still gets a .png name', () => {
  // history-service.js:109, long-capture/index.js:225,229, record/index.js:299
  assert.match(makeCaptureName(), /\.png$/)
  assert.match(makeCaptureName(LONG_CAPTURE_PREFIX), /^Highlighter_Long_/)
  assert.match(makeCaptureName(LONG_CAPTURE_PREFIX), OWNED_CAPTURE_FILE)
  assert.match(makeCaptureName(VIDEO_CAPTURE_PREFIX), /^Highlighter_Video_/)
  assert.match(makeCaptureName(VIDEO_CAPTURE_PREFIX).replace('.png', '.mp4'), /\.mp4$/)
})

test('makeCaptureName(prefix, ext) serves the P0-4-T6 pdf interface', () => {
  assert.equal(makeCaptureName(CAPTURE_PREFIX, 'pdf', { now: NOON_UTC }), 'Highlighter_2026-10-10_20-00-00-000.pdf')
  assert.equal(makeCaptureName(CAPTURE_PREFIX, '.PDF', { now: NOON_UTC }), 'Highlighter_2026-10-10_20-00-00-000.pdf')
  // An extension that cannot be a file extension falls back to png.
  assert.equal(makeCaptureName(CAPTURE_PREFIX, 'p/d*f', { now: NOON_UTC }), LEGACY_NAME)
  assert.equal(makeCaptureName(CAPTURE_PREFIX, '', { now: NOON_UTC }), LEGACY_NAME)
})

test('an empty or blank template keeps the legacy name (frozen default)', () => {
  assert.equal(makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: '' }), LEGACY_NAME)
  assert.equal(makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: '   ' }), LEGACY_NAME)
  assert.equal(makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: '{unknown}' }), LEGACY_NAME)
})

test('a non-empty template names the file and the result is still owned (R9)', () => {
  const name = makeCaptureName(CAPTURE_PREFIX, 'png', {
    now: NOON_UTC,
    template: '{app}-{date}_{time}',
    app: DEFAULT_APP_LABEL
  })
  assert.equal(name, 'Highlighter_2026-10-10_20-00-00-000_Highlighter-2026-10-10_20-00-00-000.png')
  assert.match(name, OWNED_CAPTURE_FILE, 'the ownership matcher and the generator must stay same-source')
})

test('the date/time/datetime/app variables render deterministically', () => {
  assert.equal(renderNameTemplate('{date}', { now: NOON_UTC }), '2026-10-10')
  assert.equal(renderNameTemplate('{time}', { now: NOON_UTC }), '20-00-00-000')
  assert.equal(renderNameTemplate('{datetime}', { now: NOON_UTC }), '2026-10-10_20-00-00-000')
  assert.equal(renderNameTemplate('{app}', { now: NOON_UTC, app: 'MyApp' }), 'MyApp')
  assert.equal(renderNameTemplate('{app}', { now: NOON_UTC }), DEFAULT_APP_LABEL)
  // The advertised variable list is the implemented one.
  assert.deepEqual([...TEMPLATE_VARIABLES], ['app', 'date', 'time', 'datetime'])
  for (const variable of TEMPLATE_VARIABLES) {
    assert.notEqual(renderNameTemplate(`{${variable}}`, { now: NOON_UTC, app: 'A' }), '')
  }
})

test('renderNameTemplate drops unknown tokens and keeps literal text', () => {
  assert.equal(renderNameTemplate('{title}-{date}', { now: NOON_UTC }), '-2026-10-10')
  assert.equal(renderNameTemplate('shot {nope} {date}', { now: NOON_UTC }), 'shot  2026-10-10')
  assert.equal(renderNameTemplate('', { now: NOON_UTC }), '')
  assert.equal(renderNameTemplate(null, { now: NOON_UTC }), '')
})

test('template output is sanitized: illegal characters and reserved names', () => {
  const name = makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: 'a/b:c*?"<>|', app: 'x' })
  assert.doesNotMatch(name.split('_').at(-1), /[\\/:*?"<>|]/, 'no Windows-reserved character survives')
  assert.match(name, OWNED_CAPTURE_FILE)

  const reserved = makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: 'CON', app: 'x' })
  assert.match(reserved, /__CON\.png$/)
  assert.match(reserved, OWNED_CAPTURE_FILE)
  for (const device of ['PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
    assert.match(
      makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: device }),
      new RegExp(`__${device}\\.png$`)
    )
  }
})

test('a long template label stays inside the ownership matcher', () => {
  const name = makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: 'x'.repeat(500), app: 'x' })
  assert.match(name, OWNED_CAPTURE_FILE)
  assert.ok(name.length < 200, `label is capped, got ${name.length}`)
})

test('video names never gain a template label (they are outside the matcher)', () => {
  const name = makeCaptureName(VIDEO_CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: '{app}label' })
  assert.equal(name, 'Highlighter_Video_2026-10-10_20-00-00-000.png')
  assert.doesNotMatch(name, OWNED_CAPTURE_FILE)
  // Other extensions are outside the matcher by design and keep the label.
  const pdf = makeCaptureName(CAPTURE_PREFIX, 'pdf', { now: NOON_UTC, template: '{app}', app: 'Highlighter' })
  assert.match(pdf, /_Highlighter\.pdf$/)
})

test('sanitizeFileName makes one Windows-safe component', () => {
  assert.equal(sanitizeFileName('  report  '), 'report')
  assert.equal(sanitizeFileName('a/b\\c'), 'a-b-c')
  assert.equal(sanitizeFileName('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h')
  assert.equal(sanitizeFileName('trailing...  '), 'trailing')
  assert.equal(sanitizeFileName('.hidden'), 'hidden')
  assert.equal(sanitizeFileName('con'), '_con')
  assert.equal(sanitizeFileName('CON.png'), '_CON.png')
  assert.equal(sanitizeFileName('control\u0000chars'), 'controlchars')
  assert.equal(sanitizeFileName('', { fallback: 'fallback' }), 'fallback')
  assert.equal(sanitizeFileName('...', { fallback: 'fallback' }), 'fallback')
  assert.equal(sanitizeFileName('x'.repeat(300), { maxLength: 20 }).length, 20)
  assert.equal(sanitizeFileName('x'.repeat(300), { maxLength: 20, fallback: 'f' }).length, 20)
  assert.ok(sanitizeFileName('x'.repeat(300)).length <= 120, 'default cap bounds a component')
})

test('ensureUniqueName de-duplicates instead of overwriting', () => {
  assert.equal(ensureUniqueName('a.png'), 'a.png')
  assert.equal(ensureUniqueName('a.png', { isTaken: (name) => name === 'a.png' }), 'a-1.png')
  const taken = new Set(['a.png', 'a-1.png', 'a-2.png'])
  assert.equal(ensureUniqueName('a.png', { isTaken: (name) => taken.has(name) }), 'a-3.png')
  assert.equal(ensureUniqueName('report', { isTaken: (name) => name === 'report' }), 'report-1')
  assert.throws(() => ensureUniqueName('a.png', { isTaken: () => true, maxAttempts: 2 }), /不重名/)
  assert.throws(() => ensureUniqueName('', {}), TypeError)
  assert.throws(() => ensureUniqueName('a.png', { isTaken: 'nope' }), TypeError)
})

test('makeCaptureName consults the injected existence probe (no silent overwrite)', () => {
  const first = makeCaptureName(CAPTURE_PREFIX, 'png', { now: NOON_UTC, template: 'shot' })
  const taken = new Set([first])
  const second = makeCaptureName(CAPTURE_PREFIX, 'png', {
    now: NOON_UTC,
    template: 'shot',
    isTaken: (name) => taken.has(name)
  })
  assert.notEqual(second, first)
  assert.equal(second, 'Highlighter_2026-10-10_20-00-00-000_shot-1.png')
  assert.match(second, OWNED_CAPTURE_FILE)
})

test('an unusable prefix falls back instead of emitting an unowned file', () => {
  const name = makeCaptureName('..', 'png', { now: NOON_UTC, template: 'x' })
  assert.equal(name, 'Highlighter_2026-10-10_20-00-00-000_x.png')
  assert.match(name, OWNED_CAPTURE_FILE)
})
