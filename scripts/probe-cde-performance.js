// Real-Electron performance probe for the C/D/E features (plan §10.2 / CDE handoff §7.4).
//
// WHY a probe and not a unit test: the numbers plan §10.2 asks for (4K composite cost, magnifier
// sample-cache peak memory, preview repaint cost) only exist inside a real Chromium canvas. A Node
// stub measures the stub. So this drives the REAL page at real source resolutions and reports
// p50/p95 per operation.
//
// It is a MEASUREMENT tool, not a gate: it prints a JSON report and exits 0 unless the harness
// itself failed.
//
// DESIGN NOTE (learned the hard way, twice): the 4K work is split into ONE executeJavaScript call
// per measurement. A single monolithic page script that builds a 3840x2160 source and then runs
// 15 composite samples takes long enough that (a) Electron's executeJavaScript has no progress
// channel and (b) a host-level timeout silently kills the run with no output at all. Per-step
// calls keep each round-trip short and make a hang localisable to one step.
//
// Usage (from the repo root):
//   env -u ELECTRON_RUN_AS_NODE \
//     TMP=.tmp-perf TEMP=.tmp-perf \
//     node_modules/electron/dist/electron.exe --no-sandbox scripts/probe-cde-performance.js
//
// The window is show:false - this host has a single display and AGENTS.md forbids visible windows
// on the primary display.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const RESULT_PREFIX = 'HIGHLIGHTER_CDE_PERF='

// Sample counts. Each operation gets 15 timed runs plus 3 warmups: enough for a meaningful p95
// (a p95 over 5 samples is just the max) while keeping the whole probe inside ~2-3 minutes on a
// software rasteriser.
const SAMPLES = 15
const WARMUP = 3

// Plan §7.4 C names "4K 图 + 深色卡片（阴影 bleed 48px）" as the worst case; 1080p is the
// typical-case column.
const FOUR_K = { width: 3840, height: 2160 }
const FULL_HD = { width: 1920, height: 1080 }

// Page-side helpers, installed once. Kept as a plain string so it can be sent with a single call.
const SETUP_SCRIPT = `
  window.__perf = (function () {
    const now = () => performance.now()

    function summarize(values) {
      const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
      const round = (v) => Math.round(v * 100) / 100
      if (!sorted.length) return { runs: 0 }
      const pick = (ratio) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))]
      return {
        runs: sorted.length,
        minMs: round(sorted[0]),
        p50Ms: round(pick(0.5)),
        p95Ms: round(pick(0.95)),
        maxMs: round(sorted[sorted.length - 1]),
        meanMs: round(sorted.reduce((s, v) => s + v, 0) / sorted.length)
      }
    }

    function makeCanvas(width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      return canvas
    }

    // A synthetic screenshot: a luminance ramp plus text-like stripes, so no measurement benefits
    // from a uniformly coloured (and trivially compressible) canvas.
    function makeSource(width, height) {
      const canvas = makeCanvas(width, height)
      const g = canvas.getContext('2d')
      const ramp = g.createLinearGradient(0, 0, width, height)
      ramp.addColorStop(0, '#f4f1ea')
      ramp.addColorStop(0.5, '#9aa0b4')
      ramp.addColorStop(1, '#39415a')
      g.fillStyle = ramp
      g.fillRect(0, 0, width, height)
      g.fillStyle = '#14141a'
      for (let row = 0; row * 24 < height; row++) {
        g.fillRect(Math.round(width * 0.02), row * 24 + 8, Math.round(width * 0.5), 7)
      }
      return canvas
    }

    // The crop region drawn 1:1. Rebuilt per iteration on purpose: the real export rebuilds it from
    // the base image every time (§6.3 "never read the previous result PNG"), so reusing one canvas
    // would understate the cost.
    function makeContent(source, crop) {
      const canvas = makeCanvas(crop.w, crop.h)
      const g = canvas.getContext('2d')
      g.imageSmoothingEnabled = false
      g.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
      return canvas
    }

    function measure(fn, samples, warmup) {
      for (let i = 0; i < warmup; i++) fn(i)
      const times = []
      for (let i = 0; i < samples; i++) {
        const start = now()
        fn(i)
        times.push(now() - start)
      }
      return summarize(times)
    }

    return { now, summarize, makeCanvas, makeSource, makeContent, measure, _sources: {} }
  })()
  true
`

async function send(win, expression) {
  return win.webContents.executeJavaScript(expression)
}

async function runProbe() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-capture.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  const pagePath = path.join(__dirname, '..', 'capture', 'capture.html')
  await win.loadFile(pagePath)

  const report = { samplesPerOp: SAMPLES, warmup: WARMUP, results: {}, steps: [] }
  const step = (name) => report.steps.push(name)

  const modules = await send(win, `({
    style: !!(window.captureOutputStyle && window.captureOutputStyle.presetStyle),
    compositor: !!(window.captureOutputCompositor && window.captureOutputCompositor.composeOutputCanvas),
    sampler: !!(window.magnifierSampler && window.magnifierSampler.composeSampleBase),
    geometry: !!(window.magnifierGeometry && window.magnifierGeometry.normalizeMagnifier),
    mask: !!(window.occlusionMask && window.occlusionMask.buildOccluders)
  })`)
  report.modules = modules
  const missing = Object.entries(modules).filter(([, ok]) => !ok).map(([name]) => name)
  if (missing.length) {
    report.error = `shared module(s) did not load: ${missing.join(', ')}`
    win.destroy()
    return report
  }

  await send(win, SETUP_SCRIPT)
  step('setup')

  // ---- build the synthetic sources once ------------------------------------------------------
  await send(win, `(function(){
    __perf._sources.fourK = __perf.makeSource(${FOUR_K.width}, ${FOUR_K.height});
    __perf._sources.fullHd = __perf.makeSource(${FULL_HD.width}, ${FULL_HD.height});
    return true;
  })()`)
  step('sources')

  // ---- C: finished-look composite -------------------------------------------------------------
  // Plan §7.4 C: "4K 图 + 深色卡片（阴影 bleed 48px）的预览重绘与导出耗时".
  // One executeJavaScript per preset keeps every round-trip short; `getImageData(0,0,1,1)` forces
  // the rasteriser to finish, otherwise Chromium may leave the canvas GPU-deferred and the timer
  // would measure command submission only.
  for (const [label, preset, sourceKey, size] of [
    ['4k-card-dark', 'card-dark', 'fourK', FOUR_K],
    ['4k-card-light', 'card-light', 'fourK', FOUR_K],
    ['1080p-card-dark', 'card-dark', 'fullHd', FULL_HD],
    ['1080p-original', 'original', 'fullHd', FULL_HD]
  ]) {
    report.results['compose:' + label] = await send(win, `(function(){
      const style = window.captureOutputStyle;
      const compositor = window.captureOutputCompositor;
      const source = __perf._sources.${sourceKey};
      const crop = { x: 0, y: 0, w: ${size.width}, h: ${size.height} };
      const content = __perf.makeContent(source, crop);
      const styleObj = style.presetStyle('${preset}');
      const plan = style.planOutputComposite({ contentWidth: content.width, contentHeight: content.height, outputStyle: styleObj });
      const stats = __perf.measure(function(){
        const composed = compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: styleObj, createCanvas: __perf.makeCanvas });
        if (composed) composed.getContext('2d').getImageData(0, 0, 1, 1);
      }, ${SAMPLES}, ${WARMUP});
      stats.outputSize = { width: plan.width, height: plan.height };
      stats.megapixels = Math.round((plan.width * plan.height) / 1e4) / 100;
      return stats;
    })()`)
    step('compose:' + label)
  }

  // Geometry only: this is what the panel's size hint and the export's budget check call. It
  // allocates nothing, so it must be orders of magnitude below the composite cost.
  report.results['composeGeometry:4k'] = await send(win, `(function(){
    const style = window.captureOutputStyle;
    const styleObj = style.presetStyle('card-dark');
    return __perf.measure(function(){
      style.resolveOutputGeometry({ contentWidth: ${FOUR_K.width}, contentHeight: ${FOUR_K.height}, outputStyle: styleObj });
    }, 200, 20);
  })()`)
  step('composeGeometry')

  // The preview path at the panel's real scale (fit 4K into the ~240x96 preview canvas). Plan §7.4
  // asks for "预览重绘耗时" - this is that call.
  report.results['composePreview:4k-card-dark'] = await send(win, `(function(){
    const style = window.captureOutputStyle;
    const compositor = window.captureOutputCompositor;
    const source = __perf._sources.fourK;
    const content = __perf.makeContent(source, { x: 0, y: 0, w: ${FOUR_K.width}, h: ${FOUR_K.height} });
    const styleObj = style.presetStyle('card-dark');
    const plan = style.planOutputComposite({ contentWidth: content.width, contentHeight: content.height, outputStyle: styleObj });
    const scale = Math.max(1e-4, Math.min(1, 236 / plan.width, 92 / plan.height));
    const stats = __perf.measure(function(){
      const composed = compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: styleObj, scale: scale, createCanvas: __perf.makeCanvas });
      if (composed) composed.getContext('2d').getImageData(0, 0, 1, 1);
    }, ${SAMPLES}, ${WARMUP});
    stats.scale = Math.round(scale * 10000) / 10000;
    return stats;
  })()`)
  step('composePreview')

  // ---- D: magnifier sample base (cold) -------------------------------------------------------
  // Plan §7.4 D: "4K 图 + 8 个镜头的采样缓存峰值内存、预览重绘耗时".
  // 8 blurs = feature D's per-document maximum, the worst case for the sample base.
  report.results['sampleBaseCold:4k-8blurs'] = await send(win, `(function(){
    const samplerApi = window.magnifierSampler;
    const mask = window.occlusionMask;
    const source = __perf._sources.fourK;
    const crop = { x: 0, y: 0, w: ${FOUR_K.width}, h: ${FOUR_K.height} };
    const blurs = [];
    for (let i = 0; i < 8; i++) {
      blurs.push({ kind: 'rect', rect: { x: 200 + i * 400, y: 300 + (i % 2) * 500, w: 260, h: 180 }, margin: mask.CONSERVATIVE_MARGIN_PX });
    }
    var lastSize = null;
    // Cold builds are expensive (a 4K draw + 8 mask fills); 5 samples is the plan's "冷样本".
    const stats = __perf.measure(function(){
      const built = samplerApi.composeSampleBase({ baseImage: source, crop: crop, occluders: blurs, createCanvas: __perf.makeCanvas });
      lastSize = { width: built.width, height: built.height };
      built.canvas.getContext('2d').getImageData(0, 0, 1, 1);
    }, 5, 1);
    stats.outputSize = lastSize;
    return stats;
  })()`)
  step('sampleBaseCold')

  // ---- D: hot lens sampling (base reused) ----------------------------------------------------
  // Splits into two measurements, because they take different code paths:
  //   move  : same sourceRect, new lensOrigin  -> must be a pure cache hit ("dragging is free")
  //   resize: new sourceRect                   -> real resample from the cached base
  report.results['lensMoveHot:4k'] = await send(win, `(function(){
    const samplerApi = window.magnifierSampler;
    const geom = window.magnifierGeometry;
    const mask = window.occlusionMask;
    const source = __perf._sources.fourK;
    const crop = { x: 0, y: 0, w: ${FOUR_K.width}, h: ${FOUR_K.height} };
    const blurs = [];
    for (let i = 0; i < 8; i++) {
      blurs.push({ kind: 'rect', rect: { x: 200 + i * 400, y: 300 + (i % 2) * 500, w: 260, h: 180 }, margin: mask.CONSERVATIVE_MARGIN_PX });
    }
    const built = samplerApi.composeSampleBase({ baseImage: source, crop: crop, occluders: blurs, createCanvas: __perf.makeCanvas });
    const sampler = samplerApi.createLensSampler({ createCanvas: __perf.makeCanvas });
    sampler.adoptSampleBase({ canvas: built.canvas, fingerprint: 'perf-probe' });
    const base = geom.normalizeMagnifier({
      sourceRect: { x: 400, y: 500, w: 320, h: 200 },
      lensOrigin: { x: 100, y: 100 },
      factor: 2,
      stroke: { color: '#ff3b30', widthPx: 2 },
      connector: 'none'
    });
    // Warm the one cache entry first, so the timed loop measures the hit path only.
    sampler.sample({ baseImageId: '4k', crop: crop, maskFingerprint: 'perf-probe', magnifier: base });
    const stats = __perf.measure(function(i){
      const moved = geom.normalizeMagnifier({
        sourceRect: base.sourceRect,
        lensOrigin: { x: 100 + i * 3, y: 100 + i * 2 },
        factor: base.factor, stroke: base.stroke, connector: base.connector
      });
      sampler.sample({ baseImageId: '4k', crop: crop, maskFingerprint: 'perf-probe', magnifier: moved });
    }, ${SAMPLES}, ${WARMUP});
    stats.cache = sampler.cache.stats();
    sampler.reset();
    return stats;
  })()`)
  step('lensMoveHot')

  report.results['lensResample:4k'] = await send(win, `(function(){
    const samplerApi = window.magnifierSampler;
    const geom = window.magnifierGeometry;
    const mask = window.occlusionMask;
    const source = __perf._sources.fourK;
    const crop = { x: 0, y: 0, w: ${FOUR_K.width}, h: ${FOUR_K.height} };
    const blurs = [];
    for (let i = 0; i < 8; i++) {
      blurs.push({ kind: 'rect', rect: { x: 200 + i * 400, y: 300 + (i % 2) * 500, w: 260, h: 180 }, margin: mask.CONSERVATIVE_MARGIN_PX });
    }
    const built = samplerApi.composeSampleBase({ baseImage: source, crop: crop, occluders: blurs, createCanvas: __perf.makeCanvas });
    const sampler = samplerApi.createLensSampler({ createCanvas: __perf.makeCanvas });
    sampler.adoptSampleBase({ canvas: built.canvas, fingerprint: 'perf-probe' });
    const stats = __perf.measure(function(i){
      const resized = geom.normalizeMagnifier({
        sourceRect: { x: 400 + i * 7, y: 500, w: 320, h: 200 },
        lensOrigin: { x: 100, y: 100 },
        factor: 2,
        stroke: { color: '#ff3b30', widthPx: 2 },
        connector: 'none'
      });
      sampler.sample({ baseImageId: '4k', crop: crop, maskFingerprint: 'perf-probe', magnifier: resized });
    }, ${SAMPLES}, ${WARMUP});
    stats.cache = sampler.cache.stats();
    sampler.reset();
    return stats;
  })()`)
  step('lensResample')

  // ---- D: cache budget under pressure --------------------------------------------------------
  // Fill the cache with real lens canvases until the 32 MiB budget forces evictions, and report the
  // RETAINED bytes. This is the memory figure plan §7.4 D asks for ("采样缓存峰值内存").
  report.results.cacheBudget = await send(win, `(function(){
    const samplerApi = window.magnifierSampler;
    const geom = window.magnifierGeometry;
    const cache = samplerApi.createSampleCache();
    // 4x lenses over a 480x320 source rect = 1920x1280 = ~9.4 MiB per entry, so ~3-4 fit in 32 MiB.
    let made = 0;
    for (let i = 0; i < 10; i++) {
      const canvas = __perf.makeCanvas(1920, 1280);
      canvas.getContext('2d').fillRect(0, 0, 4, 4);
      cache.set('entry-' + i, canvas);
      made += 1;
    }
    const stats = cache.stats();
    return {
      entriesCreated: made,
      retainedEntries: stats.entries,
      retainedBytes: stats.bytes,
      retainedMiB: Math.round(stats.bytes / 1048576 * 100) / 100,
      budgetBytes: stats.budgetBytes,
      budgetMiB: Math.round(stats.budgetBytes / 1048576 * 100) / 100,
      evictions: stats.evictions,
      withinBudget: stats.bytes <= stats.budgetBytes
    };
  })()`)
  step('cacheBudget')

  report.environment = await send(win, `({
    devicePixelRatio: window.devicePixelRatio,
    innerSize: { width: innerWidth, height: innerHeight },
    hardwareConcurrency: navigator.hardwareConcurrency || 0
  })`)
  step('environment')

  win.destroy()
  return report
}

app.whenReady().then(async () => {
  let report
  try {
    report = await runProbe()
  } catch (error) {
    report = { error: String(error && error.stack ? error.stack : error) }
  }
  // Persist first, then print: if the host kills the process on stdout backpressure the file still
  // has the numbers (this happened on the first attempt with a monolithic page script).
  try {
    const target = path.join(__dirname, '..', '.tmp-perf', 'cde-performance.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(report, null, 2))
  } catch (error) {
    // Persisting is a convenience; the stdout line is the contract.
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(report)}\n`)
  app.exit(report && report.error ? 1 : 0)
}, (error) => {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ error: String(error) })}\n`)
  app.exit(1)
})
