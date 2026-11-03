'use strict'

// Recording-project persistence (recording workbench R1).
//
// Frozen contract: docs/plans/2026-11-03-recording-r1-r3-contracts.md §6/§7. A
// "project" is the persistent home of one recording:
//
//   <dataRoot>/recordings/<projectId>/
//     project.json     manifest, schemaVersion 1 (shared/recording-project-schema.js)
//     capture.webm     the sealed source, or the file still being appended
//
// Why this is a separate service from RecordingService: the source session owns a
// WRITE to a file for the lifetime of one capture; the project owns the FILE for as
// long as the user keeps the recording. Closing an editor, re-recording, or an
// application restart must not remove the project, and a cleanup path that only knows
// about a session must never delete a project directory. RecordingService therefore
// drops project directories from its session table without deleting them
// (`ownedDirectory === false`), and only this service deletes a project.
//
// Invariants:
//   1. Every manifest write goes through data-root's atomicWriteJson. A crash leaves
//      either the previous or the next complete manifest - never a partial one.
//   2. All manifest mutations for one project are serialised through a per-project
//      queue, so an edit CAS (`updateDraft`) cannot race a checkpoint flush.
//   3. Paths in the manifest are relative file names only (`source.fileName`). The
//      absolute directory is derived here from the project id; callers get it only
//      from the main-process helpers (`createProject`, `projectDirectory`,
//      `sourcePathOf`). The public projections never contain a path.
//   4. Checkpoints are throttled (time AND byte delta). An ACK is NOT a durable
//      checkpoint: `checkpoint()` returns false when the write was coalesced, and
//      `dispose()`/`sealProject()` flush the pending value. This keeps one
//      appendFile per second from becoming one manifest fsync per second.
//   5. A `capturing` manifest found by `listProjects()` means the previous process
//      died mid-recording: it is lazily rewritten to `recoverable`/`interrupted`
//      before the card is returned. Nothing else promotes it by accident.
//   6. `bytes` comes from the filesystem stat, never from a renderer counter.

const { randomUUID } = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { atomicWriteJson } = require('./data-root')
const schema = require('../../shared/recording-project-schema')
const demo = require('../../shared/recording-demo')

// A checkpoint write is coalesced until either this much media was appended or this
// much wall time passed since the last durable write (contract §6). The byte floor is
// the important one on a fast disk: it bounds manifest churn on short chunks.
const CHECKPOINT_MIN_INTERVAL_MS = 1000
const CHECKPOINT_MIN_BYTES = 4 * 1024 * 1024
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200
// R5 contract §2.2/§2.3: the pointer/click event track lives beside project.json inside the
// project directory. It is written once at capture finish and only read by the editor.
const EVENT_TRACK_FILE = 'events.json'
const EVENT_TRACK_SCHEMA_VERSION = 1

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0')
}

// `ScreenRecording_2026-11-03_17-00-00` in local time, matching the frozen manifest
// example. This is a default NAME (user data), not UI copy: it is shown by every
// language and is not translated.
function defaultProjectName(timestamp) {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now())
  return [
    'ScreenRecording',
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  ].join('_')
}

function createRecordingProjectService({
  root,
  fs = fsp,
  path: pathImpl = path,
  now = Date.now,
  atomicWriteJson: writeJson = atomicWriteJson,
  createId = () => randomUUID(),
  // Injectable timers keep the throttled trailing flush deterministic in tests; the
  // default is the platform's real timer.
  timers = { setTimeout, clearTimeout },
  log = () => {}
} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('Recording projects need a data directory')
  if (typeof writeJson !== 'function') throw new Error('Recording projects need an atomic JSON writer')
  return new RecordingProjectService({
    root: pathImpl.resolve(root),
    fs,
    path: pathImpl,
    now,
    atomicWriteJson: writeJson,
    createId,
    timers,
    log
  })
}

class RecordingProjectService {
  constructor({ root, fs, path: pathImpl, now, atomicWriteJson: writeJson, createId, timers, log }) {
    this.root = root
    this.fs = fs
    this.path = pathImpl
    this.now = typeof now === 'function' ? now : () => Number(now) || Date.now()
    this.atomicWriteJson = writeJson
    this.createId = typeof createId === 'function' ? createId : () => randomUUID()
    this.timers = timers && typeof timers.setTimeout === 'function' ? timers : { setTimeout, clearTimeout }
    this.log = typeof log === 'function' ? log : () => {}
    // projectId -> tail of that project's mutation queue (manifest writes only).
    this._queues = new Map()
    // projectId -> throttled checkpoint state (see checkpoint()).
    this._checkpoints = new Map()
  }

  // ---------------- paths ----------------

  _now() {
    const value = Number(this.now())
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : Date.now()
  }

  // Absolute project directory, or '' for an id that cannot name a directory. This is
  // a main-process helper: it is never returned from a public projection.
  projectDirectory(projectId) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return ''
    return this.path.join(this.root, id)
  }

  _projectFile(projectId) {
    return this.path.join(this.projectDirectory(projectId), schema.PROJECT_FILE_NAME)
  }

  _sourcePath(project) {
    return this.path.join(this.projectDirectory(project.id), project.source.fileName)
  }

  // Absolute path of the sealed/unsealed source file, or '' when the project is
  // unknown. The editor window init derives its file URL from this, and no renderer
  // ever names a path itself (contract §8).
  async sourcePathOf(projectId) {
    const project = await this._getProject(projectId)
    return project ? this._sourcePath(project) : ''
  }

  // ---------------- serialisation ----------------

  async _withLock(projectId, task) {
    const key = String(projectId || '')
    const previous = this._queues.get(key) || Promise.resolve()
    const run = previous.then(() => task(), () => task())
    const tail = run.then(() => undefined, () => undefined)
    this._queues.set(key, tail)
    try {
      return await run
    } finally {
      if (this._queues.get(key) === tail) this._queues.delete(key)
    }
  }

  // ---------------- reading ----------------

  async _readRaw(projectId) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return null
    let text
    try {
      text = await this.fs.readFile(this._projectFile(id), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('Recording project read failed:', id, error?.message || error)
      return null
    }
    try {
      const parsed = JSON.parse(text)
      return isPlainObject(parsed) ? parsed : null
    } catch (error) {
      this.log('Recording project manifest is not valid JSON:', id, error?.message || error)
      return null
    }
  }

  _normalized(projectId, raw) {
    const project = schema.normalizeProject(raw)
    // The directory name is the authority for the id; a manifest whose id field was
    // edited by hand cannot point the service at a different project.
    project.id = String(projectId)
    return project
  }

  async _getProject(projectId) {
    const id = String(projectId || '')
    const raw = await this._readRaw(id)
    return raw ? this._normalized(id, raw) : null
  }

  async _writeProject(projectId, project) {
    await this.atomicWriteJson(this._projectFile(projectId), project)
  }

  // ---------------- public API ----------------

  async createProject({ mode = 'display', captureConfig = null, name = '' } = {}) {
    const id = String(this.createId())
    if (!schema.isValidProjectId(id)) throw new Error('Recording project id is not a safe directory name')
    const directory = this.projectDirectory(id)
    const timestamp = this._now()
    const providedName = typeof name === 'string' ? name.trim() : ''
    const project = schema.normalizeProject({
      schemaVersion: schema.SCHEMA_VERSION,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: providedName || defaultProjectName(timestamp),
      mode,
      // `capturing` + `cleanStop:false` is the durable "this capture did not finish"
      // marker that listProjects() turns into recoverable on the next start.
      state: 'capturing',
      captureConfig: captureConfig || {},
      source: { assetId: 'capture', fileName: schema.SOURCE_FILE_NAME },
      media: {},
      captureOutcome: {},
      edit: { revision: 1, keepRanges: [] },
      exports: [],
      recovery: { committedByteOffset: 0, lastChunkSequence: 0, cleanStop: false, errorCode: '' }
    })
    // A project whose manifest write fails must not leave a manifest-less directory
    // behind: listProjects() can never show it (no readable manifest) and no code path
    // would clean it up. Track whether THIS call created the directory so a pre-existing
    // one is never removed by the rollback.
    const existed = await this.fs.stat(directory).then(() => true, () => false)
    await this.fs.mkdir(directory, { recursive: true })
    try {
      await this._writeProject(id, project)
    } catch (error) {
      if (!existed) {
        await this.fs.rm(directory, { recursive: true, force: true }).catch((cleanupError) => {
          this.log('Recording project rollback failed:', id, cleanupError?.message || cleanupError)
        })
      }
      throw error
    }
    return { project, directory }
  }

  // Normalized project, or null when the directory/manifest is missing or damaged.
  async getProject(projectId) {
    const id = String(projectId || '')
    return this._getProject(id)
  }

  // Raw parsed manifest for recovery code that must see what is actually on disk.
  // Never throws: a missing or damaged manifest is null.
  async readProjectFile(projectId) {
    return this._readRaw(String(projectId || ''))
  }

  async listProjects({ offset = 0, limit = DEFAULT_LIST_LIMIT } = {}) {
    const start = Math.max(0, Math.trunc(Number(offset) || 0))
    const size = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(Number(limit) || DEFAULT_LIST_LIMIT)))
    let entries = []
    try {
      entries = await this.fs.readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('Recording project listing failed:', error?.message || error)
      entries = []
    }
    const ids = entries
      .filter((entry) => entry.isDirectory() && schema.isValidProjectId(entry.name))
      .map((entry) => entry.name)
    const projects = (await Promise.all(ids.map((id) => this._loadForList(id))))
      .filter(Boolean)
    // Newest edit first; createdAt/id are stable tie-breakers so pagination cannot
    // repeat or skip a card when two manifests share a timestamp.
    projects.sort((left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
    return {
      items: projects.slice(start, start + size).map((project) => schema.projectSummary(project)),
      total: projects.length,
      offset: start,
      limit: size
    }
  }

  // One list entry. `capturing` means the previous process died without sealing, so
  // the manifest is rewritten to `recoverable` BEFORE the card is returned - the user
  // must see an interrupted recording, not a "busy" one that will never become ready.
  async _loadForList(projectId) {
    const raw = await this._readRaw(projectId)
    if (!raw) return null
    const project = this._normalized(projectId, raw)
    if (project.state !== 'capturing') return project
    return this._withLock(projectId, async () => {
      // Re-read under the lock: a concurrent seal may have completed in the meantime.
      const current = await this._getProject(projectId)
      if (!current) return null
      if (current.state !== 'capturing') return current
      const recovered = {
        ...current,
        state: 'recoverable',
        recovery: {
          ...current.recovery,
          cleanStop: false,
          errorCode: current.recovery.errorCode || 'interrupted'
        }
      }
      await this._writeProject(projectId, recovered)
      return recovered
    })
  }

  // ---------------- checkpoints ----------------

  _checkpointState(projectId) {
    let state = this._checkpoints.get(projectId)
    if (!state) {
      state = {
        dirty: false,
        pendingOffset: 0,
        pendingSequence: 0,
        writtenOffset: 0,
        writtenSequence: 0,
        writtenAt: 0,
        timer: null,
        write: null
      }
      this._checkpoints.set(projectId, state)
    }
    return state
  }

  _scheduleCheckpoint(projectId) {
    const state = this._checkpoints.get(projectId)
    if (!state || state.timer || !state.dirty) return
    const elapsed = this._now() - state.writtenAt
    const wait = Math.max(0, CHECKPOINT_MIN_INTERVAL_MS - elapsed) + 5
    state.timer = this.timers.setTimeout(() => {
      state.timer = null
      this._flushCheckpoint(projectId).catch((error) => {
        this.log('Recording project checkpoint failed:', projectId, error?.message || error)
      })
    }, wait)
    state.timer?.unref?.()
  }

  // Coalesced durable checkpoint. Returns true when this call actually wrote the
  // manifest, false when it only updated the pending values (or nothing changed).
  // The append ACK is separate: the caller may report the chunk committed while this
  // returns false, which is exactly the contract's "ACK is not a checkpoint" rule.
  async checkpoint(projectId, { committedByteOffset = 0, lastChunkSequence = 0 } = {}) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return false
    const state = this._checkpointState(id)
    const offset = Math.max(state.pendingOffset, schema.integer(committedByteOffset, 0))
    const sequence = Math.max(state.pendingSequence, schema.integer(lastChunkSequence, 0))
    state.pendingOffset = offset
    state.pendingSequence = sequence
    if (offset > state.writtenOffset || sequence > state.writtenSequence) state.dirty = true
    if (!state.dirty) return false
    const dueByTime = this._now() - state.writtenAt >= CHECKPOINT_MIN_INTERVAL_MS
    const dueByBytes = offset - state.writtenOffset >= CHECKPOINT_MIN_BYTES
    if (!dueByTime && !dueByBytes) {
      this._scheduleCheckpoint(id)
      return false
    }
    return this._flushCheckpoint(id)
  }

  _flushCheckpoint(projectId) {
    const state = this._checkpoints.get(projectId)
    if (!state) return Promise.resolve(false)
    let settled
    const run = () => {
      if (!state.dirty) return false
      // Manifest writes must be serialised with every other mutation of the same
      // project, otherwise a checkpoint that read the manifest before a draft CAS
      // could write back the stale edit. The dirty flag is re-checked inside the lock
      // because a seal/updateDraft may have drained the pending value while queued.
      return this._withLock(projectId, async () => {
        if (!state.dirty) return false
        const offset = state.pendingOffset
        const sequence = state.pendingSequence
        const project = await this._getProject(projectId)
        if (!project) {
          state.dirty = false
          return false
        }
        const committedByteOffset = Math.max(project.recovery.committedByteOffset, offset)
        const lastChunkSequence = Math.max(project.recovery.lastChunkSequence, sequence)
        if (committedByteOffset === project.recovery.committedByteOffset &&
          lastChunkSequence === project.recovery.lastChunkSequence) {
          state.dirty = state.pendingOffset > state.writtenOffset || state.pendingSequence > state.writtenSequence
          return false
        }
        // A checkpoint is not a user edit: updatedAt is deliberately left alone so a
        // once-per-second flush cannot reshuffle the history list.
        await this._writeProject(projectId, {
          ...project,
          recovery: { ...project.recovery, committedByteOffset, lastChunkSequence }
        })
        state.writtenOffset = committedByteOffset
        state.writtenSequence = lastChunkSequence
        state.writtenAt = this._now()
        state.dirty = state.pendingOffset > state.writtenOffset || state.pendingSequence > state.writtenSequence
        return true
      })
    }
    const previous = state.write || Promise.resolve()
    const next = previous.then(run, run)
    settled = next.then((value) => {
      if (state.write === settled) state.write = null
      return value
    }, (error) => {
      if (state.write === settled) state.write = null
      throw error
    })
    state.write = settled
    return settled
  }

  // Clears the pending timer and returns the buffered values so a manifest write that
  // already carries other changes (seal/markReady/markRecoverable) can fold them in
  // without a second checkpoint write. The dirty flag is NOT cleared here: if that
  // manifest write fails, the pending checkpoint must still reach disk later (dispose
  // or the next flush); `_markCheckpointWritten` clears it after a successful write.
  _drainCheckpoint(projectId) {
    const state = this._checkpoints.get(projectId)
    if (!state) return { committedByteOffset: 0, lastChunkSequence: 0 }
    if (state.timer) {
      this.timers.clearTimeout(state.timer)
      state.timer = null
    }
    return {
      committedByteOffset: state.pendingOffset,
      lastChunkSequence: state.pendingSequence
    }
  }

  _markCheckpointWritten(projectId, recovery) {
    const state = this._checkpoints.get(projectId)
    if (!state) return
    state.writtenOffset = Math.max(state.writtenOffset, recovery.committedByteOffset)
    state.writtenSequence = Math.max(state.writtenSequence, recovery.lastChunkSequence)
    state.writtenAt = this._now()
    state.dirty = state.pendingOffset > state.writtenOffset || state.pendingSequence > state.writtenSequence
  }

  _dropCheckpoint(projectId) {
    const state = this._checkpoints.get(projectId)
    if (!state) return
    if (state.timer) this.timers.clearTimeout(state.timer)
    this._checkpoints.delete(projectId)
  }

  // ---------------- lifecycle ----------------

  // Seals a finished capture. On a successful probe the project becomes `ready` with
  // real media metadata; on a failed probe it becomes `recoverable` with
  // `errorCode:'probe-failed'` and this method does NOT throw - the caller keeps the
  // source and the user sees a recoverable card (upstream plan §6.1).
  async sealProject(projectId, { metadata = null, captureOutcome = null } = {}) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id', project: null }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found', project: null }
      const timestamp = this._now()
      const pending = this._drainCheckpoint(id)
      const bytes = await this.fs.stat(this._sourcePath(project)).then((stat) => stat.size, () => 0)
      const media = schema.mediaFromMetadata(metadata, timestamp)
      const probed = media !== null
      const recovery = {
        committedByteOffset: Math.max(project.recovery.committedByteOffset, pending.committedByteOffset, bytes),
        lastChunkSequence: Math.max(project.recovery.lastChunkSequence, pending.lastChunkSequence),
        // The stop itself was clean even when the probe failed: `cleanStop` records
        // that the writer closed the file, `errorCode` records why it is not ready.
        cleanStop: true,
        errorCode: probed ? '' : 'probe-failed'
      }
      const next = {
        ...project,
        updatedAt: timestamp,
        state: probed ? 'ready' : 'recoverable',
        source: { ...project.source, bytes },
        media: media || project.media,
        edit: schema.normalizeEdit(project.edit, (media || project.media).durationMs),
        captureOutcome: schema.normalizeCaptureOutcome(captureOutcome || project.captureOutcome),
        recovery
      }
      await this._writeProject(id, next)
      this._markCheckpointWritten(id, recovery)
      return probed ? { ok: true, project: next } : { ok: false, code: 'probe-failed', project: next }
    })
  }

  // Compare-and-set edit draft. A stale expectedRevision must never overwrite a newer
  // editor's work; it returns the current revision so the caller can reload (contract
  // §9.3 `record-editor:save-draft`).
  async updateDraft(projectId, { expectedRevision = null, edit = null } = {}) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    const expected = Number(expectedRevision)
    if (!Number.isSafeInteger(expected) || expected < 1) return { ok: false, code: 'invalid-expected-revision' }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found' }
      if (project.edit.revision !== expected) {
        return { ok: false, code: 'revision-conflict', revision: project.edit.revision }
      }
      const incoming = isPlainObject(edit) ? edit : {}
      const nextEdit = schema.normalizeEdit(
        { ...project.edit, ...incoming, revision: project.edit.revision + 1 },
        project.media.durationMs
      )
      const next = { ...project, updatedAt: this._now(), edit: nextEdit }
      await this._writeProject(id, next)
      return { ok: true, revision: nextEdit.revision, project: next }
    })
  }

  async renameProject(projectId, name) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    const cleaned = typeof name === 'string' ? name.trim() : ''
    if (!cleaned || cleaned.length > schema.NAME_MAX_LENGTH) return { ok: false, code: 'invalid-name' }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found' }
      const next = { ...project, name: schema.normalizeName(cleaned), updatedAt: this._now() }
      await this._writeProject(id, next)
      return { ok: true, project: next }
    })
  }

  // Records a finished export. `targetPath` stays in the manifest (main process only)
  // and is stripped from every public projection.
  async appendExport(projectId, entry) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    const normalized = schema.normalizeExportEntry(entry)
    if (!normalized.exportId) return { ok: false, code: 'invalid-export' }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found' }
      const timestamp = this._now()
      if (!normalized.exportedAt) normalized.exportedAt = timestamp
      if (!Number.isSafeInteger(Number(entry?.editRevision)) || Number(entry?.editRevision) < 1) {
        normalized.editRevision = project.edit.revision
      }
      const exports = [...project.exports, normalized].slice(-schema.MAX_EXPORTS)
      const next = { ...project, updatedAt: timestamp, exports }
      await this._writeProject(id, next)
      return { ok: true, project: next }
    })
  }

  async markRecoverable(projectId, errorCode) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found' }
      const pending = this._drainCheckpoint(id)
      const next = {
        ...project,
        updatedAt: this._now(),
        state: 'recoverable',
        recovery: {
          ...project.recovery,
          committedByteOffset: Math.max(project.recovery.committedByteOffset, pending.committedByteOffset),
          lastChunkSequence: Math.max(project.recovery.lastChunkSequence, pending.lastChunkSequence),
          errorCode: schema.normalizeErrorCode(errorCode) || 'interrupted'
        }
      }
      await this._writeProject(id, next)
      this._markCheckpointWritten(id, next.recovery)
      return { ok: true, project: next }
    })
  }

  // Recovery success: a probed (possibly repaired) file becomes the project source and
  // the project joins the history as `ready`. The previous source is left in place for
  // the service's reuse; only deleteProject() removes files.
  async markReady(projectId, { fileName = '', metadata = null } = {}) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found' }
      const sourceFileName = schema.normalizeFileName(fileName, project.source.fileName)
      const timestamp = this._now()
      const pending = this._drainCheckpoint(id)
      const bytes = await this.fs.stat(this.path.join(this.projectDirectory(id), sourceFileName))
        .then((stat) => stat.size, () => 0)
      const media = schema.mediaFromMetadata(metadata, timestamp)
      const recovery = {
        committedByteOffset: Math.max(project.recovery.committedByteOffset, pending.committedByteOffset, bytes),
        lastChunkSequence: Math.max(project.recovery.lastChunkSequence, pending.lastChunkSequence),
        cleanStop: true,
        errorCode: ''
      }
      const next = {
        ...project,
        updatedAt: timestamp,
        state: 'ready',
        source: { ...project.source, fileName: sourceFileName, bytes },
        media: media || project.media,
        recovery
      }
      await this._writeProject(id, next)
      this._markCheckpointWritten(id, recovery)
      return { ok: true, project: next }
    })
  }

  // Physical delete. The CALLER is responsible for the reference check (contract §6:
  // "调用方已完成引用检查"); this method only owns the directory. Deleting an unknown
  // project is `{ ok: true }` so a retried cancel is idempotent.
  async deleteProject(projectId) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    return this._withLock(id, async () => {
      this._dropCheckpoint(id)
      try {
        await this.fs.rm(this.projectDirectory(id), { recursive: true, force: true })
        return { ok: true }
      } catch (error) {
        this.log('Recording project delete failed:', id, error?.message || error)
        return { ok: false, code: 'delete-failed' }
      }
    })
  }

  // ---------------- event track (R5 contract §2) ----------------

  // Writes `<projectDir>/events.json` atomically. The track is bounded/normalised here (the
  // capture side is already bounded, this is the read/write contract of §2.3) and an unknown
  // project is a clean `not-found` - this method NEVER creates a directory and never throws.
  async writeEventTrack(projectId, track) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return { ok: false, code: 'invalid-id' }
    return this._withLock(id, async () => {
      const project = await this._getProject(id)
      if (!project) return { ok: false, code: 'not-found' }
      const normalized = demo.normalizeClickTrack(track)
      const payload = {
        schemaVersion: EVENT_TRACK_SCHEMA_VERSION,
        durationMs: normalized.durationMs,
        sampledAtHz: normalized.sampledAtHz,
        pointer: normalized.pointer,
        clicks: normalized.clicks,
        truncated: normalized.truncated === true
      }
      try {
        await this.atomicWriteJson(this.path.join(this.projectDirectory(id), EVENT_TRACK_FILE), payload)
      } catch (error) {
        this.log('Recording event track write failed:', id, error?.message || error)
        return { ok: false, code: 'write-failed' }
      }
      return { ok: true, track: payload }
    })
  }

  // Reads and normalises events.json. Missing/unreadable/invalid -> null (never throws), which
  // is exactly what the editor's `record-editor:events` channel reports as "no event track".
  async readEventTrack(projectId) {
    const id = String(projectId || '')
    if (!schema.isValidProjectId(id)) return null
    let text
    try {
      text = await this.fs.readFile(this.path.join(this.projectDirectory(id), EVENT_TRACK_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('Recording event track read failed:', id, error?.message || error)
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.log('Recording event track is not valid JSON:', id, error?.message || error)
      return null
    }
    if (!isPlainObject(parsed)) return null
    const normalized = demo.normalizeClickTrack(parsed)
    return {
      schemaVersion: EVENT_TRACK_SCHEMA_VERSION,
      durationMs: normalized.durationMs,
      sampledAtHz: normalized.sampledAtHz,
      pointer: normalized.pointer,
      clicks: normalized.clicks,
      truncated: normalized.truncated === true
    }
  }

  summaryOf(project) {
    return schema.projectSummary(project)
  }

  publicProject(project) {
    return schema.projectPublic(project)
  }

  // Flushes every throttled checkpoint and waits for in-flight manifest mutations.
  // Called on application shutdown (and by data-root quiesce before a migration).
  async dispose() {
    const ids = [...this._checkpoints.keys()]
    for (const id of ids) {
      const state = this._checkpoints.get(id)
      if (state?.timer) {
        this.timers.clearTimeout(state.timer)
        state.timer = null
      }
    }
    await Promise.all(ids.map((id) => this._flushCheckpoint(id).catch((error) => {
      this.log('Recording project checkpoint flush failed:', id, error?.message || error)
      return false
    })))
    await Promise.all([...this._queues.values()].map((tail) => tail.catch(() => undefined)))
    for (const id of ids) this._dropCheckpoint(id)
  }
}

module.exports = {
  CHECKPOINT_MIN_BYTES,
  CHECKPOINT_MIN_INTERVAL_MS,
  RecordingProjectService,
  createRecordingProjectService,
  defaultProjectName
}
