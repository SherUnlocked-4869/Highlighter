// Clipboard history panel: pure helpers for the on-demand image preview and
// the search-hit snippet.
//
// Two consumers, same UMD shape as clipboard-layout.js and
// shared/usage-format.js:
//   * renderer: clipboard/clipboard.html loads it with a plain <script> before
//     clipboard/clipboard.js (the window CSP has `default-src 'none'`, so there
//     is no module loader);
//   * node:test: test/clipboard-preview.test.js `require()`s it directly.
//
// No DOM access, no i18n, no require: the scaling limit and the snippet cut are
// deterministic functions of their arguments, which is what lets the renderer's
// preview geometry and its "the hit never falls outside the visible fragment"
// promise be pinned by unit tests instead of screenshots.

;(function exposeClipboardPreview(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.clipboardPreview = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // Characters (code points) kept on each side of the hit. The review's A05
  // calls for "48 characters around the hit"; code points, not UTF-16 units, so
  // a fragment can never end halfway through an emoji or another surrogate pair.
  const DEFAULT_RADIUS = 48

  // The overlay only has a 240 px native thumbnail to work with
  // (native/clipboard/src/images.rs). Two CSS pixels per source pixel is the
  // documented ceiling: enough to fill the panel, small enough that the preview
  // never pretends to be the original image (and never asks the main process to
  // decode one).
  const MAX_PREVIEW_SCALE = 2

  function codePoints(value) {
    return Array.from(typeof value === 'string' ? value : '')
  }

  function folded(value) {
    return value.toLowerCase()
  }

  // Location of the first case-insensitive occurrence, in CODE POINT indices.
  // The renderer slices with Array.from too, so a returned range can be used to
  // cut the text without splitting a surrogate pair.
  function findMatch(text, query) {
    if (typeof text !== 'string' || !text) return null
    const needle = typeof query === 'string' ? query.trim() : ''
    if (!needle) return null
    // Fast path: when lower-casing preserves both lengths, the UTF-16 offset of
    // indexOf is a valid offset into the original string. Converting only the
    // prefix to code points keeps the returned range surrogate-safe.
    const lowerText = text.toLowerCase()
    const lowerNeedle = needle.toLowerCase()
    if (lowerText.length === text.length && lowerNeedle.length === needle.length) {
      const at = lowerText.indexOf(lowerNeedle)
      if (at < 0) return null
      const start = codePoints(text.slice(0, at)).length
      return { start, end: start + codePoints(needle).length }
    }
    // Slow path: a lower-case expansion (for example Turkish İ) changed the
    // offsets, so indexOf cannot be mapped back. Compare code point by code
    // point; the original indices are kept.
    const chars = codePoints(text)
    const wanted = codePoints(needle)
    if (wanted.length > chars.length) return null
    for (let start = 0; start + wanted.length <= chars.length; start++) {
      let matched = true
      for (let offset = 0; offset < wanted.length; offset++) {
        if (folded(chars[start + offset]) !== folded(wanted[offset])) { matched = false; break }
      }
      if (matched) return { start, end: start + wanted.length }
    }
    return null
  }

  // A row is one line: a newline would either wrap or be collapsed by CSS in a
  // way that depends on the platform, so collapse runs of whitespace explicitly.
  function oneLine(value) {
    return value.replace(/\s+/g, ' ')
  }

  // The fragment shown in a text row: up to `radius` code points before and
  // after the hit, the hit itself and flags saying which edges were cut. The
  // renderer draws the ellipses, so the strings stay data.
  //
  // Returns null when the query is empty or does not occur literally in the
  // text (an FTS tokenization/diacritic match can land here); the caller then
  // keeps the record's existing preview text, which is the pre-A05 behaviour.
  function snippetAround(text, query, options = {}) {
    const match = findMatch(text, query)
    if (!match) return null
    const chars = codePoints(text)
    const radius = Number.isInteger(options.radius) && options.radius >= 0 ? options.radius : DEFAULT_RADIUS
    const from = Math.max(0, match.start - radius)
    const to = Math.min(chars.length, match.end + radius)
    const prefix = from > 0
    const suffix = to < chars.length
    let before = oneLine(chars.slice(from, match.start).join(''))
    let after = oneLine(chars.slice(match.end, to).join(''))
    // A cut start must not paint a leading space after the ellipsis; the same
    // for a cut end. Text that runs to the real edge keeps its whitespace.
    if (prefix) before = before.replace(/^\s+/, '')
    if (suffix) after = after.replace(/\s+$/, '')
    return {
      before,
      match: oneLine(chars.slice(match.start, match.end).join('')),
      after,
      prefix,
      suffix,
      start: match.start,
      end: match.end,
      length: chars.length
    }
  }

  // Scaled preview box. Returns null for a record/box that cannot be measured
  // (missing width, a not-yet-laid-out overlay), so the caller can leave the
  // image at its CSS max instead of dividing by zero.
  //
  //   width/height: source image size (native metadata or naturalWidth)
  //   box: { width, height } available DIP
  //   options.maxScale: ceiling for magnification (default MAX_PREVIEW_SCALE)
  function fitPreview(width, height, box, options = {}) {
    const sourceWidth = Number(width)
    const sourceHeight = Number(height)
    const boxWidth = Number(box && box.width)
    const boxHeight = Number(box && box.height)
    const requestedScale = Number(options.maxScale)
    const maxScale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : MAX_PREVIEW_SCALE
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return null
    if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight) || boxWidth <= 0 || boxHeight <= 0) return null
    const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight, maxScale)
    // Floor, then clamp: the pair must never overflow its box by a rounding
    // pixel, which is what would put a scrollbar inside the overlay.
    return {
      width: Math.max(1, Math.min(Math.floor(sourceWidth * scale), Math.floor(boxWidth))),
      height: Math.max(1, Math.min(Math.floor(sourceHeight * scale), Math.floor(boxHeight))),
      scale
    }
  }

  return {
    DEFAULT_RADIUS,
    MAX_PREVIEW_SCALE,
    findMatch,
    snippetAround,
    fitPreview
  }
})
