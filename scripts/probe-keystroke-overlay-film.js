'use strict'

// P2-05 evidence probe: prove with the REAL encoder that the shortcut-capsule overlay composited
// by the production export graph keeps everything the editor previews, and that the one retained
// material cap (MAX_LABELS=64 distinct labels) is surfaced by the plan instead of silently
// dropping capsules.
//
//   node scripts/probe-keystroke-overlay-film.js [--out .tmp-overlay/evidence]
//
// This is an evidence probe, not a test: `npm test` only runs test/*.test.js, so nothing here is
// part of the regular suite. It builds its own fixtures with ffmpeg-static and writes a JSON
// verdict under a `.tmp*/` directory, then removes every temporary file it created.
//
// Acceptance material from docs/reviews/2026-11-28-review-optimization-follow-up-delivery-review.md
// (P2-05):
//   1. `repeat-300` - 300 presses of the SAME shortcut over a 30 s fixture. The old export capped
//      the plan at 240 windows, so the rendered tail was empty. The probe runs the real encode and
//      samples the capsule band at the last frame (tail capsule #300 at 29.9 s): the film may only
//      pass when that frame is dark (capsule visible).
//   2. `many-labels-78` - 78 DISTINCT labels over a 12 s fixture. Only the first 64 distinct labels
//      fit the ffmpeg input/material budget, so the production plan must report the exact dropped
//      count and source-time range, and the rendered film must show a kept label but stay empty at
//      the dropped labels' time.
//
// Production code used (no parallel reimplementation of the overlay rules):
//   * shared/recording-export-options.normalizeExportRequest  - the plan the main process exports
//   * shared/recording-export-options.buildExportArgs         - the real ffmpeg argv + graph
//   * main/services/recording-export-service.buildKeystrokeAssets - the real capsule PNG material
//     (the same method the shipped service calls before encoding)
//
// Output: one JSON object on stdout (prefixed HIGHLIGHTER_KEYSTROKE_OVERLAY_FILM=) and the same
// JSON written to `<out>/keystroke-overlay-film-evidence.json`. Exit code 0 = every check passed.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const ffmpegPath = (() => {
  try {
    return require(path.join(root, 'node_modules', 'ffmpeg-static'))
  } catch {
    return ''
  }
})()

const options = require(path.join(root, 'shared', 'recording-export-options'))
const { createRecordingExportService } = require(path.join(root, 'main', 'services', 'recording-export-service'))

// Capsule band geometry for a 640x360 film, matching test/recording-export.test.js: the pill is
// bottom-centred at (W-w)/2, H-h-margin with margin = max(6, round(H*0.05)) = 18 and height >= 24,
// so the sampled rows sit inside the pill while the flat 0xf5f2ea source is a light background.
const SAMPLE_WIDTH = 640
const SAMPLE_HEIGHT = 360
const DARK_MAX = 120
const LIGHT_MIN = 190

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

// `--out` may only point at a `.tmp*/` directory inside the checkout: this probe produces
// throw-away media, and the evidence JSON must stay in a gitignored scratch root.
function resolveOutDir(argument) {
  const fallback = path.join(root, '.tmp-overlay', 'evidence')
  const candidate = path.resolve(root, argument || fallback)
  const relative = path.relative(root, candidate)
  const segments = relative.split(path.sep)
  const within = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
  if (!within || !/^\.tmp[^\\/]*$/.test(segments[0])) {
    throw new Error('--out must be a directory under a .tmp*/ scratch root inside the repository')
  }
  return { outDir: candidate, relative }
}

function runOrThrow(label, args, options) {
  const result = spawnSync(ffmpegPath, args, { windowsHide: true, timeout: 180000, encoding: 'utf8', ...options })
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim().split(/\r?\n/).slice(-4).join(' | ')
    throw new Error(`${label} failed (exit ${result.status}): ${detail}`)
  }
  return result
}

// Flat light source clip: any capsule pill is unambiguous against it. 10 fps keeps the encode
// cheap while still landing one output frame inside every capsule window of the materials below.
function buildFixture(filePath, seconds) {
  runOrThrow('fixture generation', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0xf5f2ea:size=640x360:rate=10:duration=${seconds}`,
    '-c:v', 'libvpx', '-b:v', '300k', '-an', filePath
  ])
  const bytes = fs.statSync(filePath).size
  if (!(bytes > 0)) throw new Error('fixture generation produced an empty file')
  return bytes
}

// Builds the exact production material + argv for one capsule plan and runs the real encoder.
// `request.keystrokes.items` is the SOURCE-time sequence (what the editor sends); everything after
// that is the shipped main-process path: normalizeExportRequest -> buildKeystrokeAssets ->
// buildExportArgs -> ffmpeg.
async function renderFilm({ scratch, service, name, fixturePath, fixtureSeconds, request }) {
  const metadata = {
    durationMs: fixtureSeconds * 1000,
    video: { width: 640, height: 360, frameRate: 10 },
    audio: { exists: false }
  }
  const normalized = options.normalizeExportRequest(request, metadata)
  if (normalized.ok !== true) throw new Error(`${name}: normalizeExportRequest refused the request (${normalized.code})`)
  const inputPath = fixturePath
  const outputPath = path.join(scratch, `${name}.mp4`)
  const task = { request: normalized.value, tempPath: path.join(scratch, `${name}.part.mp4`) }
  const assets = await service.buildKeystrokeAssets(task)
  let built
  try {
    const rendered = options.buildExportArgs({
      ...normalized.value,
      inputPath,
      outputPath,
      keystrokeAssets: assets
    })
    if (rendered.expected.keystrokesRendered !== true) throw new Error(`${name}: argv does not report a capsule overlay`)
    built = rendered
    runOrThrow(`${name}: encode`, built.args)
    if (!fs.existsSync(outputPath)) throw new Error(`${name}: the encoder reported success without an output file`)
  } finally {
    // The shipped service owns exactly this cleanup path for its raster assets.
    await service.cleanupKeystrokeAssets(task)
  }
  const graph = built.args[built.args.indexOf('-filter_complex') + 1]
  return {
    normalized: normalized.value,
    plan: normalized.value.keystrokes,
    args: built.args,
    expected: built.expected,
    graph,
    outputPath,
    assets,
    outputBytes: fs.statSync(outputPath).size
  }
}

// Samples the capsule band of ONE decoded output frame. `-ss` before `-i` returns the first frame
// at/after the timestamp, so the reported frame is the requested one rounded up at the output fps.
function sampleCapsuleBand(filmPath, seekSeconds, fps) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(seekSeconds), '-i', filmPath,
    '-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ], { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`frame sampling could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`frame sampling failed (exit ${result.status}): ${String(result.stderr || '').trim()}`)
  const frame = result.stdout
  const expectedBytes = SAMPLE_WIDTH * SAMPLE_HEIGHT * 3
  if (!Buffer.isBuffer(frame) || frame.length < expectedBytes) {
    throw new Error(`frame sampling returned ${frame ? frame.length : 0} bytes, expected ${expectedBytes}`)
  }
  let total = 0
  let count = 0
  for (let y = SAMPLE_HEIGHT - 42; y < SAMPLE_HEIGHT - 18; y += 2) {
    for (let x = SAMPLE_WIDTH / 2 - 20; x < SAMPLE_WIDTH / 2 + 20; x += 2) {
      const offset = (y * SAMPLE_WIDTH + x) * 3
      total += 0.2126 * frame[offset] + 0.7152 * frame[offset + 1] + 0.0722 * frame[offset + 2]
      count += 1
    }
  }
  const luminance = total / Math.max(1, count)
  const frameSeconds = Math.ceil(seekSeconds * fps - 1e-9) / fps
  return {
    seekSeconds,
    frameSeconds,
    luminance: Math.round(luminance * 100) / 100,
    capsuleVisible: luminance < DARK_MAX
  }
}

function check(list, name, ok, actual, expected) {
  list.push({ name, ok: ok === true, actual, expected })
  return ok === true
}

async function main() {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('ffmpeg-static is not installed; cannot run the real encoder probe')
  const { outDir, relative } = resolveOutDir(readArgument('--out', undefined))
  fs.mkdirSync(outDir, { recursive: true })
  const scratch = path.join(outDir, `.scratch-${process.pid}-${Date.now()}`)
  fs.mkdirSync(scratch, { recursive: true })

  const report = {
    ok: false,
    probe: 'keystroke-overlay-film',
    generatedAt: new Date().toISOString(),
    gitHead: (() => {
      try {
        return spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
      } catch {
        return ''
      }
    })(),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    ffmpeg: ffmpegPath,
    ffmpegVersion: spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n')[0],
    out: relative || outDir,
    fixture: { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, fps: 10, background: '#f5f2ea' },
    scenarios: [],
    evidencePath: path.join(outDir, 'keystroke-overlay-film-evidence.json'),
    tempCleaned: false,
    error: null
  }

  const service = createRecordingExportService({ getRecordingService: () => null, log: () => {} })
  try {
    // ------------------------------------------------------------------
    // Material 1: 300 presses of ONE shortcut over 30 s. Capsules are 100 ms apart, so each
    // visible window is clipped to its successor ([t, t+100)) and the last one is
    // [29900, 30000): output frame 29.9 s is the tail capsule the old 240-window cap dropped.
    // ------------------------------------------------------------------
    const repeat = { name: 'repeat-300', checks: [], ok: false }
    report.scenarios.push(repeat)
    const repeatFixturePath = path.join(scratch, 'source-30s.webm')
    const repeatFixtureBytes = buildFixture(repeatFixturePath, 30)
    const repeatItems = Array.from({ length: 300 }, (_value, index) => ({ tMs: index * 100, combo: 'Ctrl+S' }))
    const repeatFilm = await renderFilm({
      scratch,
      service,
      name: 'repeat-300',
      fixturePath: repeatFixturePath,
      fixtureSeconds: 30,
      request: {
        format: 'mp4',
        segments: [{ startMs: 0, endMs: 30000 }],
        video: { resolution: 'source', quality: 'standard', fps: 'source' },
        keystrokes: { enabled: true, items: repeatItems }
      }
    })
    const repeatPlan = repeatFilm.plan
    const repeatGraph = repeatFilm.graph
    const repeatLabelInputs = repeatFilm.args.filter((value) => (
      repeatFilm.assets.labels.some((label) => label.path === value)
    )).length
    repeat.fixtureBytes = repeatFixtureBytes
    repeat.plan = {
      count: repeatPlan.items.length,
      truncated: repeatPlan.truncated,
      total: repeatPlan.total,
      dropped: repeatPlan.dropped,
      tail: repeatPlan.items.at(-1) || null
    }
    repeat.material = {
      labelInputs: repeatLabelInputs,
      overlayNodes: (repeatGraph.match(/overlay=/g) || []).length,
      splitNodes: (repeatGraph.match(/split=/g) || []).length,
      tailEnable: repeatGraph.includes('gte(t,29.900000)') && repeatGraph.includes('lt(t,30.000000)'),
      graphChars: repeatGraph.length
    }
    repeat.film = { outputBytes: repeatFilm.outputBytes, durationMs: repeatFilm.expected.durationMs, samples: [] }
    repeat.film.samples.push({ label: 'start', ...sampleCapsuleBand(repeatFilm.outputPath, 0.15, 10) })
    repeat.film.samples.push({ label: 'middle', ...sampleCapsuleBand(repeatFilm.outputPath, 15.05, 10) })
    repeat.film.samples.push({ label: 'tail', ...sampleCapsuleBand(repeatFilm.outputPath, 29.85, 10) })
    const repeatTailSample = repeat.film.samples.find((sample) => sample.label === 'tail')
    repeat.tailSample = repeatTailSample
    check(repeat.checks, 'plan keeps all 300 capsules', repeatPlan.items.length === 300, repeatPlan.items.length, 300)
    check(repeat.checks, 'plan is not truncated', repeatPlan.truncated === false, repeatPlan.truncated, false)
    check(repeat.checks, 'plan tail is capsule #300', Boolean(repeatPlan.items.at(-1) && repeatPlan.items.at(-1).tMs === 29900), repeatPlan.items.at(-1) || null, { tMs: 29900 })
    check(repeat.checks, 'material uses ONE label input', repeatLabelInputs === 1, repeatLabelInputs, 1)
    check(repeat.checks, 'material uses ONE overlay node', repeat.material.overlayNodes === 1, repeat.material.overlayNodes, 1)
    check(repeat.checks, 'material has the tail window', repeat.material.tailEnable === true, repeat.material.tailEnable, true)
    check(repeat.checks, 'start capsule rendered', repeat.film.samples[0].capsuleVisible === true, repeat.film.samples[0].luminance, `<${DARK_MAX}`)
    check(repeat.checks, 'middle capsule rendered', repeat.film.samples[1].capsuleVisible === true, repeat.film.samples[1].luminance, `<${DARK_MAX}`)
    check(repeat.checks, 'TAIL capsule rendered (frame 29.9 s)', repeatTailSample.capsuleVisible === true, repeatTailSample.luminance, `<${DARK_MAX}`)
    repeat.ok = repeat.checks.every((entry) => entry.ok)
    fs.rmSync(repeatFixturePath, { force: true })
    fs.rmSync(repeatFilm.outputPath, { force: true })

    // ------------------------------------------------------------------
    // Material 2: 78 DISTINCT labels over 12 s (154 ms apart). The retained MAX_LABELS=64 cap may
    // keep only the first 64 labels; the plan must disclose the 14 dropped labels and their exact
    // source range (9856..11858 ms), the film must show a kept label at 5.0 s and stay EMPTY where
    // the dropped labels would have been (10.0 s, 11.9 s).
    // ------------------------------------------------------------------
    const many = { name: 'many-labels-78', checks: [], ok: false }
    report.scenarios.push(many)
    const manyFixturePath = path.join(scratch, 'source-12s.webm')
    const manyFixtureBytes = buildFixture(manyFixturePath, 12)
    const combos = []
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') combos.push('Ctrl+' + letter)
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') combos.push('Alt+' + letter)
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') combos.push('Shift+' + letter)
    const manyItems = combos.map((combo, index) => ({ tMs: index * 154, combo }))
    const manyFilm = await renderFilm({
      scratch,
      service,
      name: 'many-labels-78',
      fixturePath: manyFixturePath,
      fixtureSeconds: 12,
      request: {
        format: 'mp4',
        segments: [{ startMs: 0, endMs: 12000 }],
        video: { resolution: 'source', quality: 'standard', fps: 'source' },
        keystrokes: { enabled: true, items: manyItems }
      }
    })
    const manyPlan = manyFilm.plan
    const manyGraph = manyFilm.graph
    const manyLabelInputs = manyFilm.args.filter((value) => (
      manyFilm.assets.labels.some((label) => label.path === value)
    )).length
    const droppedCombos = new Set(manyPlan.items.map((item) => item.combo))
    const droppedLabelCombo = combos[64]
    many.fixtureBytes = manyFixtureBytes
    many.plan = {
      count: manyPlan.items.length,
      truncated: manyPlan.truncated,
      total: manyPlan.total,
      dropped: manyPlan.dropped,
      keptLabels: manyFilm.assets.labels.length,
      firstDroppedLabel: droppedLabelCombo,
      firstDroppedLabelInAssets: manyFilm.assets.labels.some((label) => label.combo === droppedLabelCombo)
    }
    many.material = {
      labelInputs: manyLabelInputs,
      overlayNodes: (manyGraph.match(/overlay=/g) || []).length,
      graphChars: manyGraph.length
    }
    many.film = { outputBytes: manyFilm.outputBytes, durationMs: manyFilm.expected.durationMs, samples: [] }
    many.film.samples.push({ label: 'kept-label-5.0s', ...sampleCapsuleBand(manyFilm.outputPath, 5.0, 10) })
    many.film.samples.push({ label: 'dropped-label-10.0s', ...sampleCapsuleBand(manyFilm.outputPath, 10.0, 10) })
    many.film.samples.push({ label: 'dropped-label-tail-11.9s', ...sampleCapsuleBand(manyFilm.outputPath, 11.9, 10) })
    const keptSample = many.film.samples[0]
    const droppedSample = many.film.samples[1]
    const droppedTailSample = many.film.samples[2]
    check(many.checks, 'plan keeps exactly 64 distinct labels', manyPlan.items.length === 64, manyPlan.items.length, 64)
    check(many.checks, 'plan is explicitly truncated', manyPlan.truncated === true, manyPlan.truncated, true)
    check(many.checks, 'plan reports 78/78 total', Boolean(manyPlan.total && manyPlan.total.windows === 78 && manyPlan.total.labels === 78), manyPlan.total || null, { windows: 78, labels: 78 })
    check(many.checks, 'plan reports the exact dropped range', Boolean(
      manyPlan.dropped && manyPlan.dropped.items === 14 && manyPlan.dropped.labels === 14 &&
      manyPlan.dropped.firstSourceMs === 9856 && manyPlan.dropped.lastSourceMs === 11858
    ), manyPlan.dropped || null, { items: 14, labels: 14, firstSourceMs: 9856, lastSourceMs: 11858 })
    check(many.checks, 'material builds one input per kept label', manyLabelInputs === 64, manyLabelInputs, 64)
    check(many.checks, 'material builds one overlay per kept label', many.material.overlayNodes === 64, many.material.overlayNodes, 64)
    check(many.checks, 'dropped label has no raster asset', manyFilm.assets.labels.some((label) => label.combo === droppedLabelCombo) === false, manyFilm.assets.labels.length, 64)
    check(many.checks, 'kept label rendered at 5.0 s', keptSample.luminance < DARK_MAX, keptSample.luminance, `<${DARK_MAX}`)
    check(many.checks, 'dropped label NOT rendered at 10.0 s', droppedSample.luminance > LIGHT_MIN, droppedSample.luminance, `>${LIGHT_MIN}`)
    check(many.checks, 'dropped label NOT rendered at 11.9 s', droppedTailSample.luminance > LIGHT_MIN, droppedTailSample.luminance, `>${LIGHT_MIN}`)
    many.ok = many.checks.every((entry) => entry.ok)
    fs.rmSync(manyFixturePath, { force: true })
    fs.rmSync(manyFilm.outputPath, { force: true })

    report.ok = repeat.ok === true && many.ok === true
  } catch (error) {
    // Keep the evidence trail on failure too: the JSON still names the scenario/check that broke.
    report.ok = false
    report.error = String(error && error.stack ? error.stack : error)
    for (const scenario of report.scenarios) {
      if (scenario.ok !== true) scenario.error = report.error
    }
  } finally {
    // Remove every temporary file this probe created (fixtures, films, capsule PNGs). The
    // evidence JSON written below is the only surviving artifact.
    fs.rmSync(scratch, { recursive: true, force: true })
    report.tempCleaned = !fs.existsSync(scratch)
    if (typeof service.dispose === 'function') await service.dispose()
    fs.writeFileSync(report.evidencePath, JSON.stringify(report, null, 2))
  }

  const json = JSON.stringify(report)
  process.stdout.write(`HIGHLIGHTER_KEYSTROKE_OVERLAY_FILM=${json}\n`)
  for (const scenario of report.scenarios) {
    for (const entry of scenario.checks) {
      process.stdout.write(`[${scenario.name}] ${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${JSON.stringify(entry.actual)} (expected ${JSON.stringify(entry.expected)})\n`)
    }
  }
  process.stdout.write(`evidence: ${report.evidencePath}\n`)
  process.exitCode = report.ok ? 0 : 1
}

main().catch((error) => {
  const failure = {
    ok: false,
    probe: 'keystroke-overlay-film',
    generatedAt: new Date().toISOString(),
    error: String(error && error.stack ? error.stack : error)
  }
  // Best effort: an early failure (bad --out, missing ffmpeg) still leaves a JSON trail next to
  // the evidence when the output directory is usable.
  try {
    const { outDir } = resolveOutDir(readArgument('--out', undefined))
    fs.mkdirSync(outDir, { recursive: true })
    failure.evidencePath = path.join(outDir, 'keystroke-overlay-film-evidence.json')
    fs.writeFileSync(failure.evidencePath, JSON.stringify(failure, null, 2))
  } catch {
    // The guard itself refused the path; stdout is the only output.
  }
  process.stdout.write(`HIGHLIGHTER_KEYSTROKE_OVERLAY_FILM=${JSON.stringify(failure)}\n`)
  process.exitCode = 1
})
