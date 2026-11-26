// H02 - mosaic brush patch ledger (pure functions, UMD like capture/annotation-geometry.js).
//
// Background (2026-11-26 full review, section 2.2): the capture window used a `new WeakMap()`
// keyed by the annotation OBJECT plus a plain `mosaicPatchBytes` counter. Drag / nudge /
// resize / style edits all replace `annotations[i]` with a fresh object every frame, so the
// WeakMap dropped the old key while the counter never deducted its bytes - a dozen drag frames
// exhausted the 16 MiB budget for good and every mosaic stroke fell back to allocating two
// offscreen canvases per frame. The active stroke was not cached at all (it has no id yet).
//
// This module carries the ledger half of the minimal-change fix:
//   · entries are keyed by a stable identity (committed annotations by `item.id`, the gesture
//     being painted by a session-unique negative draft id), so covering the same identity
//     deducts the old entry's bytes exactly;
//   · Map insertion order is the LRU order (oldest first); a get hit moves the entry to the
//     tail, and an over-budget insert evicts (and deducts) from the oldest end;
//   · a single patch larger than the whole budget is not cached at all - the caller still
//     draws it, only slower, so output is always correct.
// Pixel output, the mosaic grid phase and the fingerprint algorithm deliberately stay in
// capture.js unchanged; this module never touches the DOM.
;(function exposeMosaicPatchCache(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.mosaicPatchCache = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // Same 16 MiB ceiling capture.js shipped with (plan section 5.2); capture.js builds its
  // ledger with this constant so there is one source of truth.
  const MOSAIC_PATCH_BUDGET = 16 * 1024 * 1024

  // Bytes an offscreen patch costs = its backing store as RGBA. Unknown / degenerate canvases
  // cost 0 so a broken entry can never make the ledger negative; whether 0 means "do not
  // cache" is the caller's decision.
  function patchBytesOf(patch) {
    const canvas = patch && typeof patch === 'object' ? patch.canvas : null
    const width = Math.max(0, Math.floor(Number(canvas && canvas.width) || 0))
    const height = Math.max(0, Math.floor(Number(canvas && canvas.height) || 0))
    return width * height * 4
  }

  // Ledger key: accepts a number/string key directly or an annotation object (its id). 0,
  // non-finite numbers, empty strings and objects without an id are not identities - the
  // caller skips caching for them (e.g. the instant before a draft id is assigned).
  function cacheKeyOf(value) {
    if (value && typeof value === 'object') value = value.id
    if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? value : null
    if (typeof value === 'string') return value ? value : null
    return null
  }

  function normalizeBudget(value) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
    return MOSAIC_PATCH_BUDGET
  }

  // A bounded LRU ledger. Deliberately tiny API:
  //   get(keyOrItem)                     -> entry | null (a hit refreshes LRU order)
  //   put(keyOrItem, fingerprint, patch) -> boolean (same identity: deduct the old bytes first)
  //   delete(keyOrItem)                  -> boolean (deduct that entry's bytes)
  //   rename(from, to)                   -> boolean (gesture commit: draft identity -> item.id)
  //   clear()                            -> drop everything (new capture / undo / stage resize)
  //   keys()                             -> current identities, oldest -> newest
  //   bytes / size / budget              -> read-only snapshots
  function createMosaicPatchCache(options) {
    const settings = options && typeof options === 'object' ? options : {}
    const budget = normalizeBudget(settings.budget)
    const entries = new Map()
    let totalBytes = 0

    function detach(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      totalBytes -= entry.bytes
      // Pure defence: no host quirk may leave the ledger negative (that would break every
      // later budget comparison).
      if (!Number.isFinite(totalBytes) || totalBytes < 0) totalBytes = 0
      return entry
    }

    function evictOverBudget() {
      while (totalBytes > budget) {
        const oldest = entries.keys().next()
        if (oldest.done) { totalBytes = 0; return }
        detach(oldest.value)
      }
    }

    function attach(key, entry) {
      entries.set(key, entry)
      totalBytes += entry.bytes
      evictOverBudget()
    }

    function get(value) {
      const key = cacheKeyOf(value)
      if (key === null) return null
      const entry = entries.get(key)
      if (!entry) return null
      // LRU: a hit moves the entry to the tail (Map iteration order is insertion order).
      entries.delete(key)
      entries.set(key, entry)
      return entry
    }

    // Covering an identity deducts the previous entry before the new patch is accounted; an
    // over-budget total then evicts from the oldest end. A single patch larger than the whole
    // budget is not accounted (the caller still draws the patch it just built).
    function put(value, fingerprint, patch) {
      const key = cacheKeyOf(value)
      if (key === null) return false
      const bytes = patchBytesOf(patch)
      if (!(bytes > 0)) return false
      detach(key)
      if (bytes > budget) return false
      attach(key, { fingerprint: String(fingerprint), patch, bytes })
      return entries.has(key)
    }

    function remove(value) {
      const key = cacheKeyOf(value)
      if (key === null) return false
      return detach(key) !== null
    }

    // Gesture commit: swap the negative draft identity for the committed item.id. The entry is
    // MOVED (not deleted and rebuilt), so one gesture allocates one pair of offscreen canvases.
    function rename(from, to) {
      const fromKey = cacheKeyOf(from)
      const toKey = cacheKeyOf(to)
      if (fromKey === null || toKey === null) return false
      if (fromKey === toKey) return entries.has(fromKey)
      const entry = detach(fromKey)
      if (!entry) return false
      detach(toKey)
      attach(toKey, entry)
      return entries.has(toKey)
    }

    return {
      get,
      put,
      delete: remove,
      rename,
      clear() {
        entries.clear()
        totalBytes = 0
      },
      keys() {
        return Array.from(entries.keys())
      },
      get bytes() { return totalBytes },
      get size() { return entries.size },
      get budget() { return budget }
    }
  }

  return { MOSAIC_PATCH_BUDGET, patchBytesOf, cacheKeyOf, createMosaicPatchCache }
})
