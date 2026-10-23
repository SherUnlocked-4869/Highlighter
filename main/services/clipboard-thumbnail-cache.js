'use strict'
// Bounded LRU for thumbnail bytes. Deliberately plain Node: no Electron and no
// DOM, so `node --test` can require it directly. This file is inside the
// coverage include list (`main/services/**`), so it has to stay exercised.
//
// Two independent limits (bytes and entries) are enforced on every write and
// eviction always drops the least recently used entry. `entries` is a Map, so
// iteration order is insertion order; a cache hit re-inserts the key to move it
// to the back, which is what makes the ordering "recency" rather than "age".
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 128

function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function createThumbnailCache({ maxBytes, maxEntries } = {}) {
  const bytesLimit = positive(maxBytes, DEFAULT_MAX_BYTES)
  const entriesLimit = positive(maxEntries, DEFAULT_MAX_ENTRIES)
  const entries = new Map()
  let bytes = 0

  function drop(id) {
    const entry = entries.get(id)
    if (!entry) return false
    entries.delete(id)
    bytes -= entry.bytes.length
    return true
  }

  function evict() {
    while (entries.size > 0 && (entries.size > entriesLimit || bytes > bytesLimit)) {
      drop(entries.keys().next().value)
    }
  }

  return {
    get(id) {
      const entry = entries.get(id)
      if (!entry) return undefined
      entries.delete(id)
      entries.set(id, entry)
      return entry
    },
    set(id, value) {
      const mime = value?.mime
      const body = value?.bytes
      if (typeof mime !== 'string' || !mime) throw new TypeError('thumbnail cache requires a mime type')
      if (!Buffer.isBuffer(body)) throw new TypeError('thumbnail cache requires Buffer bytes')
      drop(id)
      entries.set(id, { mime, bytes: body })
      bytes += body.length
      evict()
      return entries.get(id)
    },
    delete(id) { return drop(id) },
    clear() { entries.clear(); bytes = 0 },
    size() { return { entries: entries.size, bytes } }
  }
}

module.exports = { createThumbnailCache, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES }
