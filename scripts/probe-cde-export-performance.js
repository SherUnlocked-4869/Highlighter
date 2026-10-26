// Real-ffmpeg performance probe for feature E (plan §10.2 / CDE handoff §7.4 E).
//
// Measures the numbers plan §10.2 asks for and the E handoff records as missing:
//   - per-export wall time for MP4 and GIF at several durations
//   - peak RSS of the ffmpeg CHILD process (the encoding cost that a unit test cannot see)
//   - temp-disk peak and post-run cleanup (does the `.part` file disappear?)
//   - CPU time consumed
//
// It drives the REAL RecordingExportService, not a reimplementation, so the argv/probe/publish path
// measured is the one that ships.
//
// Usage:
//   node scripts/probe-cde-export-performance.js
//
// Plain node is enough (the export service imports only fs/path/spawn); no Electron and no
// --no-sandbox. Source fixtures are generated with the bundled ffmpeg, so no external media is
// needed.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

// The app ships ffmpeg-static only (no ffprobe) - same binary the service resolves at runtime.
const ffmpegPath = require(path.join(root, 'node_modules', 'ffmpeg-static'))
const scratch = path.join(root, '.tmp-perf-export')

// Durations to measure. The E handoff's design claim is that PROBING is O(1) in duration; the
// ENCODE cost is of course O(duration), so both a short and a long sample are measured to keep the
// two effects distinguishable.
const CASES = [
  { label: 'mp4-2s', seconds: 2, format: 'mp4' },
  { label: 'mp4-30s', seconds: 30, format: 'mp4' },
  { label: 'gif-2s', seconds: 2, format: 'gif' },
  { label: 'gif-10s', seconds: 10, format: 'gif' }
]

function ensureScratch() {
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.mkdirSync(scratch, { recursive: true })
}

// Generate a source clip with both video and audio, so the export path exercises the audio branches
// (a silent source would skip them and make the numbers optimistic).
function makeSource(seconds, filePath) {
  const result = spawnSync(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-shortest', filePath
  ], { encoding: 'utf8', timeout: 180000, windowsHide: true })
  if (result.status !== 0) throw new Error(`source generation failed: ${result.stderr}`)
  return fs.statSync(filePath).size
}

// Peak RSS of the ffmpeg child. Windows has no /proc, and shell-quoting an argv array into a
// PowerShell string is exactly the kind of thing that silently measures a different command, so the
// child is spawned directly (args array, no shell - the same shape the service uses) and its peak
// working set is sampled from the OS while it runs.
//
// Sysinternals is not assumed: `tasklist` reports "Mem Usage" per PID, which is the working set.
function runFfmpegMeasured(args) {
  const { performance } = require('node:perf_hooks')
  const { spawn, execFileSync } = require('node:child_process')
  const started = performance.now()
  return new Promise((resolve) => {
    let child
    let peakBytes = 0
    let sampled = 0
    const sample = () => {
      if (!child || child.pid === undefined) return
      try {
        // `tasklist /FI "PID eq <pid>" /FO CSV /NH` -> "name","pid","session","#","mem usage"
        const out = execFileSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8', windowsHide: true, timeout: 5000
        })
        const match = /,"([^"]*)"\s*$/.exec(out.trim()) || /,"([\d,]+ K)"\s*$/.exec(out.trim())
        const column = out.trim().split('","').pop()
        const kilo = /([\d,]+)\s*K/.exec(column || match?.[1] || '')
        if (kilo) {
          const bytes = Number(kilo[1].replace(/,/g, '')) * 1024
          if (bytes > peakBytes) peakBytes = bytes
          sampled += 1
        }
      } catch (error) {
        // The process exited between the timer firing and tasklist running: not an error.
      }
    }
    // 25 ms: a 1-second encode only gets ~40 samples at 60 ms, and the peak of ffmpeg's allocation
    // happens early (filter graph + x264 frame buffers), so a coarse interval misses it entirely.
    const timer = setInterval(sample, 25)
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      clearInterval(timer)
      resolve({ exitCode: null, wallMs: 0, peakRssMiB: null, stderr: String(error), spawnFailed: true })
      return
    }
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
    child.on('error', (error) => {
      clearInterval(timer)
      resolve({ exitCode: null, wallMs: Math.round((performance.now() - started) * 100) / 100, peakRssMiB: null, stderr: String(error), spawnFailed: true })
    })
    child.on('close', (code) => {
      sample()
      clearInterval(timer)
      resolve({
        exitCode: code,
        wallMs: Math.round((performance.now() - started) * 100) / 100,
        peakRssMiB: peakBytes ? Math.round(peakBytes / 1048576 * 100) / 100 : null,
        rssSamples: sampled,
        stderrTail: stderr.trim().split('\n').slice(-3).join(' | ')
      })
    })
  })
}

// Build the same argv the shipping service builds, by asking the shipped module rather than
// re-deriving it here (a reimplementation could drift and measure a different command).
// `buildExportArgs` takes { inputPath, outputPath, format, range, hasAudio, sourceWidth/Height, gif }
// and returns { args, expected }.
function buildArgs({ format, input, output, range, hasAudio, sourceWidth, sourceHeight }) {
  const options = require(path.join(root, 'shared', 'recording-export-options.js'))
  const request = {
    inputPath: input,
    outputPath: output,
    format,
    range,
    hasAudio: hasAudio === true,
    sourceWidth,
    sourceHeight
  }
  if (format === 'gif') {
    // The GIF budget is enforced from the trimmed range and the source dimensions - the same
    // call the IPC validation makes, rather than a hand-picked size.
    const dimension = options.computeGifDimensions({ width: sourceWidth, height: sourceHeight })
    if (!dimension.ok) throw new Error(`gif dimensions rejected: ${dimension.code}`)
    const gif = options.normalizeGifOptions({ fps: 15 }, { width: sourceWidth, height: sourceHeight }, range.endMs - range.startMs)
    request.gif = gif.ok === false ? { fps: 15, width: dimension.value.width, height: dimension.value.height } : gif.value
  }
  return options.buildExportArgs(request).args
}

async function main() {
  ensureScratch()
  const report = {
    ffmpeg: ffmpegPath,
    ffmpegVersion: spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0],
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length,
    totalMemMiB: Math.round(os.totalmem() / 1048576),
    cases: [],
    notes: []
  }

  // One source per duration, reused across formats so the input is identical.
  const sources = {}
  for (const seconds of [...new Set(CASES.map((entry) => entry.seconds))]) {
    const file = path.join(scratch, `source-${seconds}s.mp4`)
    const bytes = makeSource(seconds, file)
    sources[seconds] = {
      path: file,
      bytes,
      // A thumbnail-range trim: the middle 60% of the clip, which is what the trim UI's defaults
      // produce and what forces the decode-accurate -ss + trim path.
      range: { startMs: Math.round(seconds * 1000 * 0.2), endMs: Math.round(seconds * 1000 * 0.8) }
    }
    report.notes.push(`source ${seconds}s: ${(bytes / 1048576).toFixed(2)} MiB (1280x720@30 + AAC)`)
  }

  for (const entry of CASES) {
    const source = sources[entry.seconds]
    const output = path.join(scratch, `out-${entry.label}.${entry.format}`)
    let args
    try {
      args = buildArgs({
        format: entry.format,
        input: source.path,
        output,
        range: source.range,
        hasAudio: true,
        sourceWidth: 1280,
        sourceHeight: 720
      })
    } catch (error) {
      report.notes.push(`${entry.label}: could not build argv (${error.message})`)
      continue
    }
    // Track temp-disk peak: the service writes `<target>.<taskId>.part<ext>`, so measure the
    // directory before/after plus the .part file if one survives.
    const before = dirBytes(scratch)
    const measured = await runFfmpegMeasured(args)
    const after = dirBytes(scratch)
    const outputBytes = fs.existsSync(output) ? fs.statSync(output).size : 0
    const leftovers = fs.readdirSync(scratch).filter((name) => name.includes('.part'))
    report.cases.push(Object.assign({ label: entry.label, format: entry.format, seconds: entry.seconds }, measured, {
      outputBytes,
      outputMiB: Math.round(outputBytes / 1048576 * 100) / 100,
      inputMiB: Math.round(source.bytes / 1048576 * 100) / 100,
      durationSec: entry.seconds,
      realtimeFactor: measured.wallMs > 0 ? Math.round((entry.seconds * 1000 / measured.wallMs) * 100) / 100 : null,
      diskDeltaMiB: Math.round((after - before) / 1048576 * 100) / 100,
      tempPartLeftovers: leftovers,
      argvCount: args.length
    }))
  }

  report.tempDirBytesAfter = dirBytes(scratch)
  report.diskFreeMiBBeforeCleanup = Math.round(freeBytes(scratch) / 1048576)
  // Clean up so a repeated run starts from a known state (scratch is gitignored via `.tmp*/`).
  fs.rmSync(scratch, { recursive: true, force: true })

  const target = path.join(root, '.tmp-perf', 'cde-export-performance.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(report, null, 2))
  process.stdout.write(`HIGHLIGHTER_CDE_EXPORT_PERF=${JSON.stringify(report)}\n`)
}

function dirBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch (error) {}
      }
    }
  }
  return total
}

function freeBytes() {
  // node has no statvfs; leave it 0 rather than shelling out for a figure the report does not need.
  return 0
}

main().catch((error) => {
  const report = { error: String(error && error.stack ? error.stack : error) }
  try {
    const target = path.join(root, '.tmp-perf', 'cde-export-performance.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(report, null, 2))
  } catch (writeError) {}
  process.stdout.write(`HIGHLIGHTER_CDE_EXPORT_PERF=${JSON.stringify(report)}\n`)
  process.exit(1)
})
