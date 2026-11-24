'use strict'

// D03: salvage the decodable part of an interrupted recording.
//
// The recorder already keeps a durable project, chunk checkpoints and a recovery editor. When a
// capture process is killed (or the tail is truncated) the source can still hold a decodable
// prefix while the probe refuses the file as a whole. Re-probing the same bytes repeats the same
// failure, so this module gives the recovery card a different operation:
//
//   1. copy the sealed source into a TEMP DIRECTORY ON THE SAME VOLUME (copyFile). The original
//      is never opened for writing by this module, so a failed salvage cannot damage it.
//   2. run FFmpeg's remuxer (stream copy, no decode) on the COPY: `-fflags +genpts` rebuilds
//      timestamps, `-t` bounds the recovered span and `-fs` caps the output size. The output is
//      written to a `.part` file in the same temp directory.
//   3. verify the part with the SAME media probe the rest of the app uses (duration, video and
//      audio tracks). Only a probe-verified file is published to the working directory.
//   4. always remove the temp directory. AbortSignal kills the child and removes the temp files,
//      so a cancelled attempt leaves no FFmpeg process and no half-written media behind.
//
// Idempotency: a publish-verified asset is reused on the next call without spawning FFmpeg again,
// and concurrent calls for the same source share one in-flight job.
//
// Failure is structured, never a thrown error: `{ ok:false, reason:{ code, detail }, attempted }`
// where `attempted` records the limits, byte counts, the remux invocation(s) and the probe result.
// The domain layer turns that into a user-visible reason + "what was tried" without leaking paths.

const fsp = require('node:fs/promises')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// The suggested span (review D03: "limit time and disk quota"). A saved partial recording is
// still useful when only the first 90 seconds survive; a caller can inject a different ceiling.
const DEFAULT_MAX_DURATION_MS = 90 * 1000
// Stream copy does not grow the media, so the default quota is the source plus headroom, with a
// hard ceiling that keeps one corrupt long take from filling the volume.
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 180 * 1000
// Waiting forever for a killed child to flush its pipe would turn a cancel into a hang. After the
// kill we wait this long for 'close', then finish anyway and let the cleanup retry take over.
const DEFAULT_KILL_GRACE_MS = 500
const MIN_FREE_BYTES = 64 * 1024 * 1024
// The remuxer can legitimately overshoot the requested span by a frame or two. A probe duration
// beyond this tolerance means the limit was not honoured and the result is not trustworthy.
const PROBE_DURATION_TOLERANCE_MS = 2000
const MAX_STDERR_BYTES = 64 * 1024
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTAINER_BY_EXTENSION = Object.freeze({
  '.webm': { extension: '.webm', format: 'webm' },
  '.mp4': { extension: '.mp4', format: 'mp4' },
  '.m4v': { extension: '.mp4', format: 'mp4' },
  '.mov': { extension: '.mov', format: 'mov' },
  '.mkv': { extension: '.mkv', format: 'matroska' }
})

function integerOr(value, fallback) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function mediaTypeFor(sourcePath) {
  const extension = String(path.extname(String(sourcePath || '')) || '').toLowerCase()
  return CONTAINER_BY_EXTENSION[extension] || CONTAINER_BY_EXTENSION['.webm']
}

// Windows paths compare case-insensitively; the guard that keeps the salvage from ever writing
// over its own source must agree with the filesystem, not with string equality.
function samePath(left, right) {
  const a = path.resolve(String(left || ''))
  const b = path.resolve(String(right || ''))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

// `capture.webm` -> `capture.salvaged.webm`. The name is a single relative file name (the project
// schema's FILE_NAME_PATTERN) and can never address the original source.
function salvageAssetName(sourceFileName) {
  const raw = typeof sourceFileName === 'string' ? sourceFileName.trim() : ''
  const info = mediaTypeFor(raw)
  const extension = path.extname(raw)
  const base = path.basename(raw, extension)
    // Strip a previous salvage suffix before sanitising so repeated attempts keep one asset name
    // instead of `capture_salvaged.salvaged.webm`.
    .replace(/\.salvaged$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 96) || 'capture'
  return `${base}.salvaged${info.extension}`
}

function secondsText(durationMs) {
  return (Math.max(0, Math.round(Number(durationMs) || 0)) / 1000).toFixed(3)
}

// Exported so the tests can assert the exact remux contract (stream copy, timestamp repair,
// duration ceiling, output-size quota) without running FFmpeg.
function buildRemuxArgs({ inputPath, outputPath, maxDurationMs, maxOutputBytes, sourcePath }) {
  const info = mediaTypeFor(sourcePath)
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    // Rebuild presentation timestamps: a killed writer often leaves the last cluster without a
    // duration/see the first one without a keyframe. This is a demuxer flag and costs no decode.
    '-fflags', '+genpts',
    // A damaged container header may hide the stream list; a larger analysis window gives the
    // demuxer a chance to find it before the remux starts.
    '-analyzeduration', '50M',
    '-probesize', '50M',
    '-i', inputPath,
    // Keep the first video and first audio track only. Missing tracks are tolerated (`?`) so a
    // silent recording still salvages.
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    // Output-side limits: the recovered span and the disk quota. Both are enforced again after
    // the child exits, because a forged/failed child must not be able to bypass them.
    '-t', secondsText(maxDurationMs),
    '-fs', String(maxOutputBytes),
    '-f', info.format,
    outputPath
  ]
}

function normalizeProbeMetadata(metadata) {
  const source = metadata && typeof metadata === 'object' ? metadata : {}
  const video = source.video && typeof source.video === 'object' ? source.video : {}
  const audio = source.audio && typeof source.audio === 'object' ? source.audio : {}
  const audioExists = audio.exists === true || Number(audio.tracks) > 0
  return {
    durationMs: Math.max(0, Math.round(Number(source.durationMs) || 0)),
    startMs: Math.max(0, Math.round(Number(source.startMs) || 0)),
    durationSource: 'salvage-remux',
    container: typeof source.container === 'string' ? source.container : '',
    video: {
      codec: typeof video.codec === 'string' ? video.codec : '',
      width: Math.max(0, Math.round(Number(video.width) || 0)),
      height: Math.max(0, Math.round(Number(video.height) || 0)),
      frameRate: Math.max(0, Number(video.frameRate) || 0)
    },
    audio: audioExists
      ? {
          exists: true,
          codec: typeof audio.codec === 'string' ? audio.codec : '',
          sampleRate: Math.max(0, Math.round(Number(audio.sampleRate) || 0)),
          channels: Math.max(0, Math.round(Number(audio.channels) || 0))
        }
      : { exists: false, codec: '', sampleRate: 0, channels: 0 },
    timebase: 'ms-media-timeline'
  }
}

function stderrTail(text) {
  const value = String(text || '')
  return value.length > 2000 ? value.slice(-2000) : value
}

function isDiskFullError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || error)
  return code === 'ENOSPC' || code === 'EDQUOT' || /no space left|not enough space|disk full/i.test(message)
}

class RecordingSalvage {
  constructor({
    ffmpegPath = null,
    getFfmpegPath = null,
    spawnProcess = spawn,
    probe = null,
    fs = fsp,
    path: pathImpl = path,
    log = () => {},
    now = Date.now,
    createId = () => randomUUID(),
    getFreeBytes = null
  } = {}) {
    this.ffmpegPath = ffmpegPath
    this.getFfmpegPath = getFfmpegPath
    this.spawnProcess = spawnProcess
    this.probe = probe
    this.fs = fs
    this.path = pathImpl
    this.log = typeof log === 'function' ? log : () => {}
    this.now = typeof now === 'function' ? now : Date.now
    this.createId = typeof createId === 'function' ? createId : () => randomUUID()
    this.getFreeBytes = typeof getFreeBytes === 'function' ? getFreeBytes : null
    // One in-flight job per source path: a double-click on the recovery card must not spawn two
    // FFmpeg processes that race for the same output name.
    this._inflight = new Map()
  }

  resolveFfmpegPath(override) {
    const candidate = override || (typeof this.getFfmpegPath === 'function'
      ? this.getFfmpegPath()
      : (typeof this.ffmpegPath === 'function' ? this.ffmpegPath() : this.ffmpegPath))
    return typeof candidate === 'string' && candidate ? candidate : ''
  }

  // Resolves a free-byte count for a directory; Infinity means "do not block on the check" so a
  // platform without statfs still salvages.
  async freeBytes(directory) {
    if (this.getFreeBytes) {
      try {
        const value = Number(await this.getFreeBytes(directory))
        return Number.isFinite(value) && value >= 0 ? value : Infinity
      } catch {
        return Infinity
      }
    }
    const statfs = this.fs.statfs ? this.fs.statfs.bind(this.fs) : null
    if (!statfs) return Infinity
    try {
      const stats = await statfs(directory)
      const available = Number(stats?.bavail ?? stats?.bfree) * Number(stats?.bsize)
      return Number.isFinite(available) && available >= 0 ? available : Infinity
    } catch {
      return Infinity
    }
  }

  async probeAsset(probe, filePath) {
    const fn = typeof probe === 'function' ? probe : probe?.probe?.bind(probe)
    if (typeof fn !== 'function') return { ok: false, code: 'probe-unavailable' }
    try {
      const result = await fn(filePath)
      if (!result?.ok) return { ok: false, code: result?.code || 'probe-failed', detail: result?.detail }
      return { ok: true, metadata: normalizeProbeMetadata(result.metadata) }
    } catch (error) {
      this.log('Recording salvage probe failed:', filePath, error?.message || error)
      return { ok: false, code: 'probe-failed', detail: error?.message || String(error) }
    }
  }

  // A previously published asset is reused only when the probe still accepts it. The same limits
  // are re-applied, so a shorter quota on a later call cannot silently accept a longer asset.
  async verifyExisting(assetPath, probe, maxDurationMs, attempted) {
    let stat
    try {
      stat = await this.fs.stat(assetPath)
    } catch {
      return { ok: false, code: 'asset-missing' }
    }
    if (!stat.isFile() || stat.size <= 0) return { ok: false, code: 'asset-empty' }
    attempted.outputBytes = stat.size
    attempted.probe = { ran: true, ok: false, code: '', durationMs: 0, hasAudio: false }
    const probed = await this.probeAsset(probe, assetPath)
    attempted.probe = {
      ran: true,
      ok: probed.ok === true,
      code: probed.ok ? '' : probed.code,
      durationMs: probed.metadata?.durationMs || 0,
      hasAudio: probed.metadata?.audio?.exists === true
    }
    if (!probed.ok) return { ok: false, code: probed.code }
    const durationMs = probed.metadata.durationMs
    if (!(durationMs > 0)) return { ok: false, code: 'duration-unavailable' }
    if (durationMs > maxDurationMs + PROBE_DURATION_TOLERANCE_MS) {
      return { ok: false, code: 'duration-exceeds-limit' }
    }
    return { ok: true, metadata: probed.metadata }
  }

  // Runs one child and never rejects. Resolves:
  //   { code, signal, stdout, stderr, timedOut, aborted, spawnFailed }
  runRemux({ executable, args, timeoutMs, signal, killGraceMs, spawnProcess }) {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let child = null
      let settled = false
      let timedOut = false
      let aborted = false
      let killTimer = null
      const finish = (extra = {}) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        if (killTimer) clearTimeout(killTimer)
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        resolve({
          code: null,
          signal: null,
          stdout,
          stderr,
          timedOut,
          aborted,
          spawnFailed: false,
          ...extra
        })
      }
      const killChild = () => {
        try { child?.kill('SIGKILL') } catch {}
      }
      const afterKill = () => {
        killChild()
        if (killTimer) return
        killTimer = setTimeout(() => finish(), Math.max(10, killGraceMs))
      }
      const onAbort = () => {
        if (aborted || settled) return
        aborted = true
        afterKill()
      }
      const timeoutTimer = setTimeout(() => {
        if (settled) return
        timedOut = true
        afterKill()
      }, Math.max(1, timeoutMs))
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      // The signal may already have fired while the caller was between its own check and this
      // call; in that case do not spawn a process only to kill it immediately.
      if (aborted) {
        finish({ aborted: true })
        return
      }
      try {
        child = spawnProcess(executable, args, {
          windowsHide: true,
          // The remuxer only ever writes its output file; stdout is not used, but keeping the
          // pipes separate matches the probe/export children and makes a fake spawn simple.
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        finish({ spawnFailed: true, stderr: String(error?.message || error) })
        return
      }
      if (!child || typeof child.on !== 'function') {
        finish({ spawnFailed: true, stderr: 'spawn did not return a child process' })
        return
      }
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < MAX_STDERR_BYTES) stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += String(chunk)
      })
      child.on('error', (error) => {
        finish({ spawnFailed: true, stderr: `${stderr}${error?.message || error}` })
      })
      child.on('close', (code, closeSignal) => {
        finish({ code, signal: closeSignal })
      })
    })
  }

  async removeTempDirectory(directory) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.fs.rm(directory, { recursive: true, force: true })
        return true
      } catch (error) {
        if (attempt === 3) {
          this.log('Recording salvage temp cleanup failed:', directory, error?.message || error)
          return false
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 40 * (attempt + 1))
        })
      }
    }
    return false
  }

  // Public entry point (the D03 signature).
  async salvage({
    sourcePath,
    workingDirectory = '',
    ffmpegPath = null,
    spawnProcess = null,
    probe = null,
    limits = {},
    signal = null,
    onProgress = null,
    assetFileName = ''
  } = {}) {
    const source = typeof sourcePath === 'string' && sourcePath.trim() ? path.resolve(sourcePath) : ''
    const directory = workingDirectory
      ? path.resolve(String(workingDirectory))
      : (source ? path.dirname(source) : '')
    const key = source && directory ? `${source}\u0000${directory}` : ''
    if (key && this._inflight.has(key)) return this._inflight.get(key)
    const job = this._runSalvage({
      sourcePath: source,
      workingDirectory: directory,
      ffmpegPath,
      spawnProcess: spawnProcess || this.spawnProcess,
      probe: probe || this.probe,
      limits: limits && typeof limits === 'object' ? limits : {},
      signal,
      onProgress: typeof onProgress === 'function' ? onProgress : () => {},
      assetFileName
    })
    if (key) {
      this._inflight.set(key, job)
      job.finally(() => {
        if (this._inflight.get(key) === job) this._inflight.delete(key)
      }).catch(() => {})
    }
    return job
  }

  async _runSalvage({
    sourcePath,
    workingDirectory,
    ffmpegPath,
    spawnProcess,
    probe,
    limits,
    signal,
    onProgress,
    assetFileName
  }) {
    const attempted = {
      sourceBytes: 0,
      copyBytes: 0,
      outputBytes: 0,
      freeBytes: null,
      limits: {},
      remux: { ran: false, attempts: [] },
      probe: { ran: false, ok: false, code: '', durationMs: 0, hasAudio: false }
    }
    let tempDirectory = ''
    let published = false

    const fail = (code, detail = '') => ({
      ok: false,
      assetPath: '',
      metadata: null,
      attempted,
      reason: { code, detail: String(detail || '') }
    })
    const done = (assetPath, metadata, reused) => ({
      ok: true,
      assetPath,
      metadata,
      attempted,
      reason: '',
      reused: reused === true
    })
    // A progress listener belongs to the UI; a throwing callback must never turn a valid salvage
    // into a failure (or leave the temp directory behind).
    const report = (payload) => {
      try { onProgress(payload) } catch {}
    }

    try {
      if (!sourcePath) return fail('invalid-source')
      if (!workingDirectory) return fail('invalid-working-directory')
      let sourceStat
      try {
        sourceStat = await this.fs.stat(sourcePath)
      } catch (error) {
        return fail('source-missing', error?.message || '')
      }
      if (!sourceStat.isFile()) return fail('source-unreadable')
      attempted.sourceBytes = sourceStat.size
      if (!(sourceStat.size > 0)) return fail('source-empty')

      let directoryStat
      try {
        directoryStat = await this.fs.stat(workingDirectory)
      } catch {
        directoryStat = null
      }
      if (!directoryStat?.isDirectory()) return fail('working-directory-missing')

      const probeFn = probe
      if (!probeFn || (typeof probeFn !== 'function' && typeof probeFn.probe !== 'function')) {
        return fail('probe-unavailable')
      }

      const maxDurationMs = integerOr(limits.maxDurationMs, DEFAULT_MAX_DURATION_MS)
      const derivedMaxOutput = Math.min(
        DEFAULT_MAX_OUTPUT_BYTES,
        Math.max(sourceStat.size + MIN_FREE_BYTES, MIN_FREE_BYTES)
      )
      const maxOutputBytes = integerOr(limits.maxOutputBytes, derivedMaxOutput)
      const timeoutMs = integerOr(limits.timeoutMs, DEFAULT_TIMEOUT_MS)
      const killGraceMs = integerOr(limits.killGraceMs, DEFAULT_KILL_GRACE_MS)
      attempted.limits = { maxDurationMs, maxOutputBytes, timeoutMs }

      const sourceInfo = mediaTypeFor(sourcePath)
      const requestedName = typeof assetFileName === 'string' ? assetFileName.trim() : ''
      const fileName = FILE_NAME_PATTERN.test(requestedName) ? requestedName : salvageAssetName(path.basename(sourcePath))
      const assetPath = path.join(workingDirectory, fileName)
      // The recovery asset is a SIBLING, never the original. A project that already points at
      // `capture.salvaged.webm` and became recoverable again would otherwise derive the same name
      // and the cleanup below would delete the only copy of the media.
      if (samePath(assetPath, sourcePath)) return fail('asset-name-conflict')

      if (signal?.aborted) return fail('cancelled')

      // Idempotency: a previously published, probe-verified asset is the answer. Only an asset
      // that no longer verifies is removed; the source is never touched.
      const existing = await this.verifyExisting(assetPath, probeFn, maxDurationMs, attempted)
      if (existing.ok) {
        attempted.reused = true
        return done(assetPath, existing.metadata, true)
      }
      try {
        await this.fs.unlink(assetPath)
      } catch (error) {
        if (error?.code && error.code !== 'ENOENT') {
          return fail('asset-unwritable', error.message || '')
        }
      }

      // Disk budget: the copy and the remuxed output coexist in the same temp directory, so the
      // volume needs room for both. A caller can inject a quota (and a free-byte reader) to test
      // the disk-full path without filling a real disk.
      const neededBytes = sourceStat.size + Math.min(maxOutputBytes, sourceStat.size + MIN_FREE_BYTES)
      const sourceFree = await this.freeBytes(path.dirname(sourcePath))
      const targetFree = workingDirectory === path.dirname(sourcePath)
        ? sourceFree
        : await this.freeBytes(workingDirectory)
      const freeBytes = Math.min(sourceFree, targetFree)
      attempted.freeBytes = Number.isFinite(freeBytes) ? freeBytes : null
      if (Number.isFinite(freeBytes) && freeBytes < neededBytes) {
        return fail('disk-full', `need ${neededBytes} bytes, ${Math.round(freeBytes)} available`)
      }

      // Temp directory on the SOURCE volume: the copy must not cross a volume boundary, because a
      // copy failure there would have already spent the disk budget before FFmpeg starts.
      const tempBase = path.dirname(sourcePath)
      tempDirectory = path.join(tempBase, `.salvage-${this.createId()}`)
      try {
        await this.fs.mkdir(tempDirectory, { recursive: false })
      } catch (error) {
        // A read-only source directory can still salvage into the project directory as long as
        // the caller placed it on the same volume; try there before giving up.
        tempDirectory = path.join(workingDirectory, `.salvage-${this.createId()}`)
        try {
          await this.fs.mkdir(tempDirectory, { recursive: false })
        } catch (secondError) {
          return fail('temp-create-failed', secondError?.message || error?.message || '')
        }
      }
      report({ stage: 'temp-created', tempDirectory })

      const copyPath = path.join(tempDirectory, `source${sourceInfo.extension}`)
      try {
        await this.fs.copyFile(sourcePath, copyPath)
      } catch (error) {
        return fail(isDiskFullError(error) ? 'disk-full' : 'copy-failed', error?.message || '')
      }
      const copyStat = await this.fs.stat(copyPath).catch(() => null)
      attempted.copyBytes = Number(copyStat?.size) || 0
      if (!(attempted.copyBytes > 0)) return fail('copy-empty')
      if (attempted.copyBytes !== sourceStat.size) return fail('copy-incomplete')
      if (signal?.aborted) return fail('cancelled')

      const executable = this.resolveFfmpegPath(ffmpegPath)
      if (!executable) return fail('ffmpeg-unavailable')

      const outputPath = path.join(tempDirectory, `output${sourceInfo.extension}`)
      const args = buildRemuxArgs({
        inputPath: copyPath,
        outputPath,
        maxDurationMs,
        maxOutputBytes,
        sourcePath
      })
      report({ stage: 'remux-start', maxDurationMs, maxOutputBytes })
      const remux = await this.runRemux({
        executable,
        args,
        timeoutMs,
        signal,
        killGraceMs,
        spawnProcess
      })
      attempted.remux.ran = true
      attempted.remux.attempts.push({
        exitCode: remux.code,
        signal: remux.signal,
        timedOut: remux.timedOut,
        aborted: remux.aborted,
        spawnFailed: remux.spawnFailed === true,
        stderr: stderrTail(remux.stderr)
      })
      if (remux.aborted || signal?.aborted) return fail('cancelled')
      if (remux.timedOut) return fail('timeout')
      if (remux.spawnFailed) return fail('spawn-failed', stderrTail(remux.stderr))
      if (remux.code !== 0) {
        return fail(
          isDiskFullError({ message: remux.stderr }) ? 'disk-full' : 'ffmpeg-failed',
          stderrTail(remux.stderr)
        )
      }

      const outputStat = await this.fs.stat(outputPath).catch(() => null)
      attempted.outputBytes = Number(outputStat?.size) || 0
      if (!(attempted.outputBytes > 0)) return fail('output-empty')
      if (attempted.outputBytes > maxOutputBytes) return fail('output-too-large')

      report({ stage: 'probe', outputBytes: attempted.outputBytes })
      const probed = await this.probeAsset(probeFn, outputPath)
      attempted.probe = {
        ran: true,
        ok: probed.ok === true,
        code: probed.ok ? '' : probed.code,
        durationMs: probed.metadata?.durationMs || 0,
        hasAudio: probed.metadata?.audio?.exists === true
      }
      if (!probed.ok) return fail('probe-failed', probed.code)
      const durationMs = probed.metadata.durationMs
      if (!(durationMs > 0)) return fail('duration-unavailable')
      if (durationMs > maxDurationMs + PROBE_DURATION_TOLERANCE_MS) {
        return fail('duration-exceeds-limit', `${durationMs} > ${maxDurationMs}`)
      }
      if (signal?.aborted) return fail('cancelled')

      // Publish only after the probe accepted the part file. A previous asset was already removed
      // above, so the rename replaces nothing the user can still open.
      try {
        await this.fs.rename(outputPath, assetPath)
      } catch (error) {
        if (error?.code === 'EXDEV' || error?.code === 'EPERM' || error?.code === 'EEXIST') {
          try {
            await this.fs.copyFile(outputPath, assetPath)
            await this.fs.unlink(outputPath)
          } catch (publishError) {
            return fail('asset-publish-failed', publishError?.message || error?.message || '')
          }
        } else {
          return fail('asset-publish-failed', error?.message || '')
        }
      }
      published = true
      const publishedStat = await this.fs.stat(assetPath).catch(() => null)
      if (!(Number(publishedStat?.size) > 0)) return fail('asset-publish-failed')
      attempted.outputBytes = Number(publishedStat.size) || attempted.outputBytes
      report({ stage: 'done', durationMs })
      return done(assetPath, probed.metadata, false)
    } catch (error) {
      this.log('Recording salvage failed:', sourcePath, error?.message || error)
      return fail('salvage-internal', error?.message || String(error))
    } finally {
      if (tempDirectory) await this.removeTempDirectory(tempDirectory)
      if (published) this.log('Recording salvage published:', path.basename(sourcePath || ''))
    }
  }
}

function createRecordingSalvage(options) {
  return new RecordingSalvage(options)
}

// Convenience form of the frozen D03 signature. The instance form is preferred by the domain so
// the probe/spawn/Fs collaborators are created once, but a caller with only per-call options can
// use this directly.
function salvage(options = {}) {
  return new RecordingSalvage(options).salvage(options)
}

module.exports = {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MIN_FREE_BYTES,
  PROBE_DURATION_TOLERANCE_MS,
  RecordingSalvage,
  buildRemuxArgs,
  createRecordingSalvage,
  normalizeProbeMetadata,
  salvage,
  salvageAssetName
}
