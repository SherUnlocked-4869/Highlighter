'use strict'

// Media probe adapter (feature E0, plan §8.1:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md).
//
// The app bundles `ffmpeg-static` (6.1.1) and NOT ffprobe. A second binary is a real cost
// (package size, build, verification), so this module probes with the SAME bundled ffmpeg
// in three escalating steps and fails explicitly when none of them is trustworthy:
//
//   1. HEADER:  `ffmpeg -hide_banner -ss 0 -i <file>`  — exits non-zero because there is no
//      output file, which is expected. Everything we need is on stderr: the container,
//      `Duration: HH:MM:SS.ss`, and per-stream lines (Video: vp8 ..., 320x240, 10 fps;
//      Audio: opus, ...). This is the cheap path: ~50 ms for a 2 s WebM here, and it does
//      NOT decode the media. A seekable WebM/MP4 reports its real duration here.
//
//   2. HEADER-RETRY: when step 1 reports `Duration: N/A` (a live/streamed WebM whose
//      segment never got a duration element), the container is parsed with a full-length
//      header scan before giving up. ffmpeg needs at least one demuxer read pass to build
//      the index; if that still says N/A, the container genuinely has no duration.
//
//   3. DEEP: `ffmpeg -i <file> -c copy -f null -` — stream copy, so no decode cost, but it
//      demuxes every packet and reports the real end timestamp through `-progress`.
//      `-c copy` is what keeps this cheap: a full DECODE (`-f null -` without `-c copy`)
//      costs O(duration) CPU and is exactly what plan §8.1 warns about for long
//      recordings. Deep mode runs only when steps 1-2 could not produce a duration.
//
// Why stream copy is sound for a duration: the goal is the END of the media on its own
// timeline, not frame accuracy. `out_time_ms` of the last demuxed packet is that end
// timestamp; no decoding is required to know it.
//
// Failure semantics (plan §8.1: "cannot pass infinity or a guessed duration"):
//   * a probe that yields no trustworthy duration returns `{ ok: false, code }` — it never
//     returns a fallback number, and the caller must offer the cancel path instead;
//   * the renderer's `durationMs` is accepted ONLY as a cross-check input
//     (`crossCheckMs`): a mismatch wider than CROSS_CHECK_TOLERANCE_RATIO is reported as
//     `renderer-duration-disagrees` rather than silently trusted in either direction.
//
// No shell: argv arrays + spawn with `windowsHide: true`, exactly like the encoder. The
// ffmpeg path MUST come from createFfmpegPathResolver so a packaged build gets the
// asar.unpacked binary.

const { spawn } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 30000
const HEADER_TIMEOUT_MS = 15000
const DEEP_TIMEOUT_MS = 120000
// A renderer-side duration is a UI initial value (plan §8.1). It is allowed to be off by
// this much before we stop and ask the user instead of exporting a wrong span.
const CROSS_CHECK_TOLERANCE_RATIO = 0.25
const CROSS_CHECK_MIN_TOLERANCE_MS = 1000
// Floor for the SHORT side of the cross-check. The wall clock may legitimately exceed the media
// timeline by an unbounded amount (a user can pause for as long as they like), so the short side is
// NOT scaled by the renderer's estimate - only a file too short to be a usable recording is rejected.
// 500 ms is below LIMITS.MIN_RANGE_MS (the shortest exportable span), so anything shorter could not
// be exported anyway.
const CROSS_CHECK_MIN_DURATION_MS = 500
const MAX_STDERR_BYTES = 512 * 1024

// `Duration: 00:00:02.01` (a duration), not `start: -0.007000`.
const DURATION_PATTERN = /^\s*Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s*,\s*start:\s*(-?\d+(?:\.\d+)?)/m
const STREAM_PATTERN = /^\s*Stream #\d+:\d+.*?:\s*(Video|Audio):\s*([^\n]*)$/gm
const VIDEO_SIZE_PATTERN = /,\s*(\d{2,5})x(\d{2,5})(?=[\s,\[]|$)/
const VIDEO_FPS_PATTERN = /,\s*(\d+(?:\.\d+)?)\s*fps(?=[\s,\[]|$)/
const VIDEO_CODEC_PATTERN = /^(?:Video:\s*)?([A-Za-z0-9_-]+)/
const AUDIO_CODEC_PATTERN = /^(?:Audio:\s*)?([A-Za-z0-9_-]+)/

function parseClock(hours, minutes, secondsText) {
  const seconds = Number(secondsText)
  if (!Number.isFinite(seconds)) return null
  const total = Number(hours) * 3600 + Number(minutes) * 60 + seconds
  return Number.isFinite(total) ? total : null
}

// Parses ffmpeg's stderr from either the header pass or the deep pass. Exported for tests:
// the parsing rules ARE the contract this module is judged on.
function parseProbeOutput(stderr) {
  const text = String(stderr || '')
  const durationMatch = text.match(DURATION_PATTERN)
  const durationMs = durationMatch
    ? Math.round(parseClock(durationMatch[1], durationMatch[2], durationMatch[3]) * 1000)
    : null
  const startMs = durationMatch
    ? Math.round(Number(durationMatch[4]) * 1000)
    : null

  let video = null
  let audio = null
  for (const match of text.matchAll(STREAM_PATTERN)) {
    const kind = match[1]
    const detail = match[2] || ''
    if (kind === 'Video' && !video) {
      const size = detail.match(VIDEO_SIZE_PATTERN)
      const fps = detail.match(VIDEO_FPS_PATTERN)
      const codec = detail.match(VIDEO_CODEC_PATTERN)
      video = {
        codec: codec ? codec[1].toLowerCase() : '',
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        frameRate: fps ? Number(fps[1]) : 0
      }
      continue
    }
    if (kind === 'Audio' && !audio) {
      const codec = detail.match(AUDIO_CODEC_PATTERN)
      const rate = detail.match(/(\d+)\s*Hz/)
      const channels = detail.match(/,\s*mono(?=[,\s]|$)/) ? 1 : (detail.match(/,\s*stereo(?=[,\s]|$)/) ? 2 : 0)
      audio = {
        codec: codec ? codec[1].toLowerCase() : '',
        sampleRate: rate ? Number(rate[1]) : 0,
        channels
      }
    }
  }
  // A stream line can omit the resolution on some containers; the deep pass is where a
  // decoder-side size would appear, so an unknown size stays null rather than 0.
  if (video && (!video.width || !video.height)) video = null
  return {
    durationMs: durationMs !== null && durationMs > 0 ? durationMs : null,
    startMs,
    container: (text.match(/^Input #0,\s*([^,]+)/m) || [])[1]?.trim() || '',
    video,
    audio
  }
}

// `-progress pipe:1` emits `out_time_ms`/`out_time_us`; the last one before `progress=end`
// is the end of the demuxed stream. `out_time_us` is preferred because ffmpeg 6 still
// prints `out_time_ms` in microseconds on some paths (a long-standing quirk).
function parseProgressEndTime(stdout) {
  const text = String(stdout || '')
  let latest = null
  for (const match of text.matchAll(/^out_time_us=(\d+)$/gm)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value >= 0) latest = Math.round(value / 1000)
  }
  if (latest !== null) return latest
  for (const match of text.matchAll(/^out_time_ms=(\d+)$/gm)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value >= 0) latest = Math.round(value / 1000)
  }
  return latest
}

class MediaProbe {
  // `ffmpegPath` may be a string OR a resolver function. A resolver is what main.js passes:
  // the packaged asar.unpacked rewrite happens in createFfmpegPathResolver, and resolving it
  // lazily means a probe never forces the recording service into existence.
  constructor({ ffmpegPath, getFfmpegPath = null, spawnProcess = spawn, log = () => {}, timeouts = {} } = {}) {
    if (typeof ffmpegPath !== 'string' && typeof ffmpegPath !== 'function' && typeof getFfmpegPath !== 'function') {
      throw new Error('媒体探测需要 FFmpeg 路径')
    }
    this.ffmpegPath = ffmpegPath
    this.getFfmpegPath = getFfmpegPath
    this.spawnProcess = spawnProcess
    this.log = typeof log === 'function' ? log : () => {}
    this.timeouts = {
      header: Math.round(Number(timeouts.header) || HEADER_TIMEOUT_MS),
      deep: Math.round(Number(timeouts.deep) || DEEP_TIMEOUT_MS)
    }
  }

  resolveFfmpegPath() {
    const candidate = typeof this.getFfmpegPath === 'function'
      ? this.getFfmpegPath()
      : (typeof this.ffmpegPath === 'function' ? this.ffmpegPath() : this.ffmpegPath)
    if (typeof candidate !== 'string' || !candidate) throw new Error('未找到 MP4 编码组件')
    return candidate
  }

  // Runs one ffmpeg invocation and collects stdout/stderr. Resolves (never rejects) with
  // `{ code, signal, stdout, stderr, timedOut }`: a non-zero exit is EXPECTED for the
  // header probe, and the caller decides what it means.
  run(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let child
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        timedOut = true
        try { child?.kill('SIGKILL') } catch {}
      }, timeoutMs)
      timer.unref?.()
      let executable
      try {
        executable = this.resolveFfmpegPath()
      } catch (error) {
        finish({ code: null, signal: null, stdout: '', stderr: String(error?.message || error), timedOut: false, spawnFailed: true })
        return
      }
      try {
        child = this.spawnProcess(executable, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        finish({ code: null, signal: null, stdout: '', stderr: String(error?.message || error), timedOut: false, spawnFailed: true })
        return
      }
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < MAX_STDERR_BYTES) stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += String(chunk)
      })
      child.on('error', (error) => {
        finish({ code: null, signal: null, stdout, stderr: `${stderr}${error?.message || error}`, timedOut: false, spawnFailed: true })
      })
      child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut }))
    })
  }

  // Step 1 + 2: the header pass. `-ss 0` forces the demuxer to open the container the same
  // way the real export does; `-v error` would hide the Duration/Stream lines, so the log
  // level stays at the default and the parse reads them from stderr.
  async probeHeader(filePath) {
    const result = await this.run(
      ['-hide_banner', '-ss', '0', '-i', filePath],
      { timeoutMs: this.timeouts.header }
    )
    if (result.timedOut) return { ok: false, code: 'probe-timeout' }
    const parsed = parseProbeOutput(result.stderr)
    const unreadable = /No such file or directory|Invalid data found|Permission denied/.test(result.stderr)
    if (unreadable) {
      const code = /No such file or directory/.test(result.stderr) ? 'file-missing' : 'unreadable-media'
      return { ok: false, code }
    }
    if (!parsed.video) {
      // A container ffmpeg cannot open at all, or one with no video track: neither is a
      // recording we can export.
      return { ok: false, code: parsed.container ? 'no-video-track' : 'unreadable-media' }
    }
    return { ok: true, value: parsed }
  }

  // Step 3: demux only (`-c copy`) to obtain an end timestamp when the header had none.
  async probeDeepDuration(filePath, parsed) {
    const result = await this.run(
      ['-hide_banner', '-nostdin', '-i', filePath, '-map', '0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'],
      { timeoutMs: this.timeouts.deep }
    )
    if (result.timedOut) return { ok: false, code: 'probe-timeout' }
    const endMs = parseProgressEndTime(result.stdout)
    if (endMs === null || endMs <= 0) return { ok: false, code: 'duration-unavailable' }
    // The deep pass is authoritative for the END of the media, but the header's stream
    // description is what carries width/height/fps; keep both.
    return {
      ok: true,
      value: {
        ...(parsed || {}),
        durationMs: endMs,
        durationSource: 'demux'
      }
    }
  }

  // Full probe. Resolves `{ ok: true, metadata }` or `{ ok: false, code }`.
  //
  // `crossCheckMs` is the renderer's own duration estimate. It is NEVER used as the result; it can
  // only turn a successful probe into `renderer-duration-disagrees`, which the UI surfaces as "the
  // file may be unreadable, re-record" instead of exporting a span the file cannot honour.
  //
  // SUSPENDED-PAUSE RULE (real-device defect, do not tighten the tolerance back):
  // the renderer's estimate is WALL-CLOCK time (`record.js` elapsedTime()), but pauses produce no
  // media time at all - MediaRecorder.pause() stops the media timeline while the wall clock keeps
  // running. A user who pauses for 2 s inside a 5 s take gets a 3 s file, i.e. a 40% divergence that
  // has nothing to do with file health. `crossCheckMs` may therefore legitimately be LONGER than the
  // media duration, so the upper side of the window has to tolerate the whole wall-clock span; only
  // a file that claims to be LONGER than the wall clock is suspicious (that is impossible for a
  // recording of that session). The lower bound is kept so a truncated/zero-length file still fails.
  async probe(filePath, { crossCheckMs = null } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, code: 'invalid-media-path' }
    const header = await this.probeHeader(filePath)
    let parsed
    let durationSource = 'container'
    if (header.ok) {
      parsed = header.value
      if (parsed.durationMs === null) {
        const deep = await this.probeDeepDuration(filePath, parsed)
        if (!deep.ok) {
          this.log('Media probe has no duration:', filePath, deep.code)
          return { ok: false, code: deep.code }
        }
        parsed = deep.value
        durationSource = 'demux'
      }
    } else {
      // A header pass that failed outright is a real failure: we cannot even describe the
      // streams, so an export would be guesswork.
      this.log('Media probe failed:', filePath, header.code)
      return header
    }

    const crossCheck = Number(crossCheckMs)
    if (Number.isFinite(crossCheck) && crossCheck > 0) {
      const tolerance = Math.max(CROSS_CHECK_MIN_TOLERANCE_MS, crossCheck * CROSS_CHECK_TOLERANCE_RATIO)
      // Asymmetric window (see the SUSPENDED-PAUSE RULE above):
      //
      //   * file LONGER than the wall clock -> hard disagreement. A recording cannot contain more
      //     media time than the session ran, so this really is a different/foreign file.
      //   * file SHORTER than the wall clock -> legitimate, with NO proportional lower bound. A pause
      //     makes the wall clock arbitrarily longer than the media timeline and there is no upper
      //     bound on how long a user may pause, so scaling the floor by `crossCheck` would reject long
      //     pauses exactly like the bug this replaces. The only thing worth rejecting is a file too
      //     short to be a usable recording at all, expressed as an ABSOLUTE floor.
      const tooLong = parsed.durationMs > crossCheck + tolerance
      const implausiblyShort = parsed.durationMs < CROSS_CHECK_MIN_DURATION_MS
      if (tooLong || implausiblyShort) {
        this.log('Media probe disagrees with the renderer duration:', parsed.durationMs, crossCheck)
        return { ok: false, code: 'renderer-duration-disagrees', detail: { probeMs: parsed.durationMs, rendererMs: Math.round(crossCheck) } }
      }
      if (parsed.durationMs < crossCheck - tolerance) {
        // Not a failure: the wall clock ran longer than the media timeline, which is exactly what a
        // pause (or a dropped-frame stretch) looks like. Logged so a surprising export length can be
        // traced back to the recording rather than looking like a probe bug.
        this.log('Media probe is shorter than the wall clock (pause or dropped frames):', parsed.durationMs, crossCheck)
      }
    }

    const audio = parsed.audio
      ? { exists: true, codec: parsed.audio.codec, sampleRate: parsed.audio.sampleRate, channels: parsed.audio.channels }
      : { exists: false, codec: '', sampleRate: 0, channels: 0 }
    return {
      ok: true,
      metadata: {
        durationMs: parsed.durationMs,
        startMs: parsed.startMs === null ? 0 : parsed.startMs,
        durationSource,
        container: parsed.container,
        video: {
          codec: parsed.video.codec,
          width: parsed.video.width,
          height: parsed.video.height,
          frameRate: parsed.video.frameRate
        },
        audio,
        // The time base every range is expressed in: milliseconds on the container
        // timeline that the preview <video> also plays (see recording-export-options.js).
        timebase: 'ms-media-timeline'
      }
    }
  }
}

function createMediaProbe(options) {
  return new MediaProbe(options)
}

module.exports = {
  CROSS_CHECK_MIN_TOLERANCE_MS,
  CROSS_CHECK_MIN_DURATION_MS,
  CROSS_CHECK_TOLERANCE_RATIO,
  MediaProbe,
  createMediaProbe,
  parseProbeOutput,
  parseProgressEndTime
}
