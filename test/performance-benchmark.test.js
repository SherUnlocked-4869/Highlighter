const test = require('node:test')
const assert = require('node:assert/strict')
const {
  benchmarkMatcher,
  benchmarkRecordingPacing,
  percentile,
  summarizeSamples
} = require('../scripts/benchmark-performance')

test('performance sample summaries use deterministic median and p95 values', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3)
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5)
  assert.deepEqual(summarizeSamples([3.456, 1.234, 2.345]), {
    runs: 3,
    minMs: 1.23,
    medianMs: 2.35,
    p95Ms: 3.46,
    maxMs: 3.46,
    samplesMs: [3.46, 1.23, 2.35]
  })
})

test('long-capture benchmark verifies the expected shift as well as timing it', () => {
  const result = benchmarkMatcher({
    width: 32,
    height: 180,
    axis: 'vertical',
    shift: 36,
    runs: 1
  })

  assert.equal(result.status, 'matched')
  assert.equal(result.detectedShift, 36)
  assert.equal(result.runs, 1)
  assert.ok(result.p95Ms >= 0)
})

test('recording pacing benchmark reports avoided full-frame draws', () => {
  assert.deepEqual(
    benchmarkRecordingPacing({ displayFrameRate: 144, targetFrameRate: 24, durationSeconds: 1 }),
    {
      displayFrameRate: 144,
      targetFrameRate: 24,
      durationSeconds: 1,
      previousFullFrameDraws: 144,
      pacedFullFrameDraws: 24,
      skippedCallbacks: 120,
      drawReductionPercent: 83.33
    }
  )
})

test('corpus benchmark replays recorded frame pairs and reports shift mismatches', async (t) => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { benchmarkCorpus, readCorpusCase } = require('../scripts/benchmark-performance')
  const matcher = require('../long-capture/matcher')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-corpus-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const width = 32
  const height = 120
  const shift = 24
  // Build a real vertical scroll pair so the expected shift is known.
  const base = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) base[y * width + x] = (y * 7 + x * 3) % 251
  }
  const next = new Uint8Array(width * height)
  for (let y = 0; y < height - shift; y++) {
    next.set(base.subarray((y + shift) * width, (y + shift) * width + width), y * width)
  }

  const caseDir = path.join(root, 'scroll-text')
  fs.mkdirSync(caseDir, { recursive: true })
  fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({
    width, height, axis: 'vertical', shifts: [shift]
  }))
  fs.writeFileSync(path.join(caseDir, 'frame-000.rgba'), Buffer.from(base))
  fs.writeFileSync(path.join(caseDir, 'frame-001.rgba'), Buffer.from(next))

  const parsed = readCorpusCase(caseDir)
  assert.equal(parsed.width, width)
  assert.equal(parsed.frames.length, 2)

  const result = benchmarkCorpus(root, 1)
  assert.equal(result.cases.length, 1)
  const entry = result.cases[0]
  assert.equal(entry.pairs, 1)
  assert.equal(entry.shiftMismatches, 0)
  assert.equal(entry.detectedShifts[0], matcher.findBestShift(base, next, width, height, 'vertical').shift)
})

test('corpus benchmark reports unusable cases instead of throwing', async (t) => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { benchmarkCorpus, readCorpusCase } = require('../scripts/benchmark-performance')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-corpus-bad-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const caseDir = path.join(root, 'broken')
  fs.mkdirSync(caseDir, { recursive: true })
  fs.writeFileSync(path.join(caseDir, 'case.json'), '{not json')
  assert.match(readCorpusCase(caseDir).error, /无法解析/)

  fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ width: 4, height: 4, axis: 'vertical' }))
  assert.match(readCorpusCase(caseDir).error, /至少需要/)

  const result = benchmarkCorpus(root, 1)
  assert.ok(result.cases[0].error)

  assert.match(benchmarkCorpus(path.join(root, 'missing')).error, /语料目录不存在/)
  const emptyRoot = path.join(root, 'empty')
  fs.mkdirSync(emptyRoot)
  assert.match(benchmarkCorpus(emptyRoot).error, /没有子用例/)
})
