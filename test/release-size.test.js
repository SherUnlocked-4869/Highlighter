const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MAX_GROWTH_RATIO,
  compareReports,
  duplicateGroups,
  extensionOf,
  flattenAsarHeader,
  groupBy,
  normalizeEntries,
  summarizeAsar,
  topLevelOf
} = require('../scripts/lib/release-size')

const MiB = 1024 * 1024

test('C06: entries are normalised and grouped by the real component', () => {
  const entries = normalizeEntries([
    { path: 'resources\\app.asar', size: 10 },
    { path: './resources/app.asar.unpacked/native/ocr/model.bin', size: 20 },
    { path: 'Highlighter.exe', size: 30 },
    { path: '', size: 99 }
  ])
  assert.equal(entries.length, 3)
  assert.equal(topLevelOf('resources/app.asar'), 'resources')
  assert.equal(topLevelOf('resources/elevate.exe'), 'resources')
  // The unpacked side of the app tree is reported one level deeper: that is where the
  // component attribution lives.
  assert.equal(topLevelOf('resources/app.asar.unpacked/native/ocr/model.bin'), 'resources/app.asar.unpacked')
  const groups = groupBy(entries, (entry) => topLevelOf(entry.path))
  assert.deepEqual(groups.map((group) => [group.id, group.bytes, group.files]), [
    ['Highlighter.exe', 30, 1],
    ['resources/app.asar.unpacked', 20, 1],
    ['resources', 10, 1]
  ])
  assert.equal(extensionOf('native/model.bin'), '.bin')
  assert.equal(extensionOf('LICENSE'), '(none)')
})

test('C06: duplicate content is measured by recoverable bytes, not by file count', () => {
  const entries = normalizeEntries([
    { path: 'a/model.onnx', size: 100, hash: 'h1' },
    { path: 'b/model.onnx', size: 100, hash: 'h1' },
    { path: 'c/other.bin', size: 50, hash: 'h2' },
    { path: 'empty', size: 0, hash: '' }
  ])
  const duplicates = duplicateGroups(entries)
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].count, 2)
  assert.equal(duplicates[0].duplicatedBytes, 100)
  assert.deepEqual(duplicates[0].paths, ['a/model.onnx', 'b/model.onnx'])
})

test('C06: the asar header flattens packed and unpacked entries', () => {
  const header = {
    files: {
      'app.js': { size: 10, offset: '0' },
      'node_modules': { files: {
        'dep/index.js': { size: 20, offset: '10' },
        'sharp/build/Release/sharp.node': { size: 30, unpacked: true }
      } },
      'assets': { files: { 'icon.png': { size: 5, offset: '30' } } }
    }
  }
  const flat = flattenAsarHeader(header)
  assert.equal(flat.length, 4)
  const summary = summarizeAsar(header)
  assert.equal(summary.packedBytes, 35)
  assert.equal(summary.unpackedBytes, 30)
  assert.equal(summary.unpackedFiles, 1)
  assert.equal(summary.topLevel.find((group) => group.id === 'node_modules').bytes, 20)
})

test('C06: the 5% gate compares totals and attributes the component that grew', () => {
  const baseline = {
    totalBytes: 100 * MiB,
    topLevel: [
      { id: 'resources', bytes: 60 * MiB },
      { id: 'Highlighter.exe', bytes: 40 * MiB }
    ]
  }
  const atLimit = compareReports({
    totalBytes: 105 * MiB,
    topLevel: [
      { id: 'resources', bytes: 63 * MiB },
      { id: 'Highlighter.exe', bytes: 42 * MiB }
    ]
  }, baseline)
  assert.equal(MAX_GROWTH_RATIO, 0.05)
  assert.equal(atLimit.totalGrowthRatio, 0.05)
  // Each component grew by exactly 5%; the total is exactly at the gate.
  assert.equal(atLimit.ok, true)

  const over = compareReports({
    totalBytes: 120 * MiB,
    topLevel: [
      { id: 'resources', bytes: 80 * MiB },
      { id: 'Highlighter.exe', bytes: 40 * MiB }
    ]
  }, baseline)
  assert.equal(over.ok, false)
  assert.equal(over.overGate, true)
  assert.equal(over.components.find((component) => component.id === 'resources').needsAttribution, true)
  assert.equal(over.components.find((component) => component.id === 'Highlighter.exe').needsAttribution, false)
})

test('C06: a new component always needs attribution and a shrink cannot hide growth', () => {
  const baseline = { totalBytes: 100, topLevel: [{ id: 'resources', bytes: 100 }] }
  const withNewComponent = compareReports({
    totalBytes: 101,
    topLevel: [{ id: 'resources', bytes: 100 }, { id: 'native-ocr', bytes: 1 }]
  }, baseline)
  assert.equal(withNewComponent.components.find((component) => component.id === 'native-ocr').needsAttribution, true)
  assert.equal(withNewComponent.ok, false)

  // resources shrank 50% while a different component grew 30%: the total still decides.
  const shifted = compareReports({
    totalBytes: 130,
    topLevel: [{ id: 'resources', bytes: 50 }, { id: 'ffmpeg', bytes: 80 }]
  }, { totalBytes: 100, topLevel: [{ id: 'resources', bytes: 100 }] })
  assert.equal(shifted.overGate, true)
  assert.equal(shifted.ok, false)
})
