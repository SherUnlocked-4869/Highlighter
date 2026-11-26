const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { atomicWriteJson } = require('./data-root')

const SCHEMA_VERSION = 1
const DEFAULT_MAX_ENTRIES = 20
const CONVERSATION_FILE = /^[A-Za-z0-9._-]+\.json$/
// A conversation's own id names its file, so every round rewrites that one file.
const CONVERSATION_KEY = /^[A-Za-z0-9_-]{8,64}$/

// Persists finished selection-assistant conversations as one JSON file each.
//
// Deliberately Electron-free: it takes the directory and a settings reader, so
// node:test covers the retention and deletion rules without an app. Content is
// never logged — a transcript is the user's own text, which is exactly why
// saving it is opt-in.
class ConversationStore {
  constructor({
    directory,
    getSettings,
    maxEntries = DEFAULT_MAX_ENTRIES,
    fileSystem = fs,
    writeJson = atomicWriteJson,
    log = () => {}
  } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new TypeError('ConversationStore requires an absolute directory')
    }
    if (typeof getSettings !== 'function') throw new TypeError('ConversationStore requires getSettings')
    this.directory = directory
    this.getSettings = getSettings
    this.maxEntries = maxEntries
    this.fs = fileSystem
    this.writeJson = writeJson
    this.log = log
    this.quiescing = false
    this.pendingWrites = new Set()
    // F07 (report section 3.7): `filePath -> savedAt` for every conversation on disk. The tray
    // rebuild asks "is there anything saved?" on every selection-window blur, and that used to
    // parse every JSON file in the directory. The index is built once, then kept current by
    // save()/remove(); content is still read only where it is actually needed (latest()).
    this.index = null
  }

  isEnabled() {
    return this.getSettings()?.selectionToolbar?.conversation?.persist === true
  }

  readSavedAt(filePath) {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(filePath, 'utf8'))
      return Number.isFinite(parsed?.savedAt) ? parsed.savedAt : null
    } catch {
      return null
    }
  }

  // One readdir per query (cheap) keeps the index honest about out-of-band changes - a
  // hand-edited file, another instance, a deletion - while the expensive part (reading and
  // parsing every JSON file) only happens for files the index has not seen yet.
  fileIndex() {
    const index = this.index || (this.index = new Map())
    let names = []
    try {
      names = this.fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && CONVERSATION_FILE.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      index.clear()
      return index
    }
    const present = new Set()
    for (const name of names) {
      const filePath = path.join(this.directory, name)
      present.add(filePath)
      if (index.has(filePath)) continue
      const savedAt = this.readSavedAt(filePath)
      if (savedAt !== null) index.set(filePath, savedAt)
    }
    for (const filePath of [...index.keys()]) {
      if (!present.has(filePath)) index.delete(filePath)
    }
    return index
  }

  // Newest first, from the in-memory index only.
  savedEntries() {
    return [...this.fileIndex().entries()]
      .map(([filePath, savedAt]) => ({ filePath, savedAt }))
      .sort((left, right) => right.savedAt - left.savedAt)
  }

  // Perf: answers "is a conversation stored?" without reading any file content.
  hasSaved() {
    return this.fileIndex().size > 0
  }

  entries() {
    const saved = []
    for (const entry of this.savedEntries()) {
      try {
        const parsed = JSON.parse(this.fs.readFileSync(entry.filePath, 'utf8'))
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.savedAt)) {
          saved.push({ filePath: entry.filePath, snapshot: parsed })
        } else {
          this.index?.delete(entry.filePath)
        }
      } catch {
        // A half-written or hand-edited file is simply not a conversation.
        this.index?.delete(entry.filePath)
      }
    }
    return saved
  }

  latest() {
    // Only the newest file's content is needed; the index supplies the ordering.
    for (const entry of this.savedEntries()) {
      try {
        const parsed = JSON.parse(this.fs.readFileSync(entry.filePath, 'utf8'))
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.savedAt)) return parsed
        this.index?.delete(entry.filePath)
      } catch {
        this.index?.delete(entry.filePath)
      }
    }
    return null
  }

  // Writes the snapshot and then enforces the retention cap. Deliberately does
  // not reject: a failed save must not break the conversation already on screen.
  async save(snapshot) {
    if (this.quiescing) return false
    if (!this.isEnabled()) return false
    const savedAt = Number.isFinite(snapshot?.savedAt) ? snapshot.savedAt : Date.now()
    const value = { ...snapshot, savedAt, schemaVersion: SCHEMA_VERSION }
    const key = CONVERSATION_KEY.test(String(snapshot?.id ?? ''))
      ? snapshot.id
      : `${savedAt}-${this.randomSuffix()}`
    const filePath = path.join(this.directory, `${key}.json`)
    try {
      const pending = this.writeJson(filePath, value, fsp)
      this.pendingWrites.add(pending)
      try { await pending } finally { this.pendingWrites.delete(pending) }
    } catch (error) {
      this.log('Failed to save selection conversation:', error.message || String(error))
      return false
    }
    // Keep the warm index current instead of invalidating it: the tray asks immediately after.
    if (this.index) this.index.set(filePath, savedAt)
    this.trim()
    return true
  }

  trim() {
    if (this.quiescing) return 0
    const kept = this.entries()
    for (const entry of kept.slice(this.maxEntries)) {
      this.remove(entry.filePath)
    }
    return kept.slice(0, this.maxEntries).length
  }

  clear() {
    if (this.quiescing) return 0
    let removed = 0
    for (const entry of this.entries()) {
      if (this.remove(entry.filePath)) removed += 1
    }
    return removed
  }

  remove(filePath) {
    try {
      this.fs.rmSync(filePath, { force: true })
      this.index?.delete(filePath)
      return true
    } catch (error) {
      this.log('Failed to delete saved conversation:', error.message || String(error))
      return false
    }
  }

  randomSuffix() {
    return Math.random().toString(36).slice(2, 8)
  }
  async quiesce() { this.quiescing = true; await Promise.allSettled([...this.pendingWrites]) }
  resume() { this.quiescing = false }
}

module.exports = { ConversationStore, DEFAULT_MAX_ENTRIES, SCHEMA_VERSION }
