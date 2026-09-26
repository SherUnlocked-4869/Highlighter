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
  }

  isEnabled() {
    return this.getSettings()?.selectionToolbar?.conversation?.persist === true
  }

  entries() {
    let names = []
    try {
      names = this.fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && CONVERSATION_FILE.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const saved = []
    for (const name of names) {
      const filePath = path.join(this.directory, name)
      try {
        const parsed = JSON.parse(this.fs.readFileSync(filePath, 'utf8'))
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.savedAt)) {
          saved.push({ filePath, snapshot: parsed })
        }
      } catch {
        // A half-written or hand-edited file is simply not a conversation.
      }
    }
    return saved.sort((left, right) => right.snapshot.savedAt - left.snapshot.savedAt)
  }

  latest() {
    return this.entries()[0]?.snapshot || null
  }

  // Writes the snapshot and then enforces the retention cap. Deliberately does
  // not reject: a failed save must not break the conversation already on screen.
  async save(snapshot) {
    if (!this.isEnabled()) return false
    const savedAt = Number.isFinite(snapshot?.savedAt) ? snapshot.savedAt : Date.now()
    const value = { ...snapshot, savedAt, schemaVersion: SCHEMA_VERSION }
    const key = CONVERSATION_KEY.test(String(snapshot?.id ?? ''))
      ? snapshot.id
      : `${savedAt}-${this.randomSuffix()}`
    try {
      await this.writeJson(path.join(this.directory, `${key}.json`), value, fsp)
    } catch (error) {
      this.log('Failed to save selection conversation:', error.message || String(error))
      return false
    }
    this.trim()
    return true
  }

  trim() {
    const kept = this.entries()
    for (const entry of kept.slice(this.maxEntries)) {
      this.remove(entry.filePath)
    }
    return kept.slice(0, this.maxEntries).length
  }

  clear() {
    let removed = 0
    for (const entry of this.entries()) {
      if (this.remove(entry.filePath)) removed += 1
    }
    return removed
  }

  remove(filePath) {
    try {
      this.fs.rmSync(filePath, { force: true })
      return true
    } catch (error) {
      this.log('Failed to delete saved conversation:', error.message || String(error))
      return false
    }
  }

  randomSuffix() {
    return Math.random().toString(36).slice(2, 8)
  }
}

module.exports = { ConversationStore, DEFAULT_MAX_ENTRIES, SCHEMA_VERSION }
