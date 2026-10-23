// Clipboard history panel: pure layout helpers for the mixed text/image list.
//
// Two consumers, so this file follows the same UMD shape as
// shared/usage-format.js and capture/selection-utils.js:
//   * renderer: clipboard/clipboard.html loads it with a plain <script> before
//     clipboard/clipboard.js (the window CSP has `default-src 'none'`, so there
//     is no module loader);
//   * node:test: test/clipboard-grid-layout.test.js `require()`s it directly.
//
// No DOM access, no i18n, no require: every function here is a deterministic
// function of its arguments, which is what lets the renderer's scroll math and
// keyboard model be pinned by unit tests instead of screenshots.
//
// Model shape: layout(items, m) returns
//   rows    : [{ type: 'row'|'images', y, h, items: [index, ...] }]
//   itemRow : item index -> row index
//   itemCol : item index -> cell index inside that row
//   height  : total content height in DIP
// where m = { rowH, cellH, gap, cols }. Rows are returned in ascending y order
// and their [y, y + h) bands never overlap.
//
// Vertical gap rule (the single source of truth for this file): a gap sits
// between two rows when at least one of them is an image grid row, so that a
// pure text history keeps the exact legacy geometry (y = i * rowH). Consecutive
// image blocks therefore pitch by cellH + gap, not cellH + 2 * gap: the gap
// after a grid block already covers the following block. Both sides check this,
// which is why the leading edge is guarded on the previous row being a text row.

;(function exposeClipboardLayout(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.clipboardLayout = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // Hard ceiling for the grid column count: a guard against a corrupted width
  // (0, NaN, an absurd oversized window) producing a huge row of cells.
  const MAX_COLS = 12

  // Native thumbnails are downscaled so their long edge is at most 240 px
  // (native/clipboard/src/images.rs). A tile rendered wider than the source
  // pixel budget is upscaled and soft, so the column count must not push the
  // tile's device-pixel long edge past this edge.
  const SOURCE_EDGE = 240

  // Absolute tolerance for the edge comparison below: tile widths are floats
  // produced by a division, so an exact equality must not decide the branch.
  const EDGE_EPSILON = 1e-9

  function layout(items, m) {
    const rows = [], itemRow = [], itemCol = []
    let y = 0, i = 0
    while (i < items.length) {
      if (items[i].kind === 'image') {
        // Leading gap only after a text row: a grid block that follows another
        // grid block is already separated by that block's trailing gap below,
        // and adding a second one would make the pitch cellH + 2 * gap.
        if (rows.length && rows[rows.length - 1].type === 'row') y += m.gap
        const cells = []
        while (i < items.length && items[i].kind === 'image' && cells.length < m.cols) {
          itemRow[i] = rows.length; itemCol[i] = cells.length; cells.push(i); i++
        }
        rows.push({ type: 'images', y, h: m.cellH, items: cells })
        y += m.cellH
        // Trailing gap only when another row follows. Without the condition a
        // text-only history would gain m.gap of phantom height, and every
        // scroll offset computed for the flat list would drift by that much.
        if (i < items.length) y += m.gap
      } else {
        itemRow[i] = rows.length; itemCol[i] = 0
        rows.push({ type: 'row', y, h: m.rowH, items: [i] })
        y += m.rowH; i++
      }
    }
    return { rows, itemRow, itemCol, height: y }
  }

  // Row containing y, or the first row below y when y falls in an inter-row
  // gap. Equivalently: one past the last row whose bottom edge is at or above
  // y, clamped to the last row. Negative / non-finite input maps to the first
  // row because scrollTop is clamped by the browser anyway; an empty model
  // reports row 0 so callers never index with -1.
  function rowAt(model, y) {
    const rows = (model && model.rows) || []
    if (!rows.length) return 0
    if (!(y > 0)) return 0
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].y + rows[mid].h <= y) lo = mid + 1
      else hi = mid
    }
    return Math.min(lo, rows.length - 1)
  }

  // Content-space top edge of the row that owns the given item.
  function topOf(model, index) {
    if (!model || !model.rows || !model.itemRow) return 0
    const row = model.rows[model.itemRow[index]]
    return row ? row.y : 0
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v))
  }

  // Column count for the image grid at a given content width.
  //   width: content width in DIP (panel width minus border and scrollbar gutter)
  //   m: { cellH, gap, padX, target, min, dpr }
  // Start from the column count that lands closest to `target` tile width,
  // then keep adding a column while the tile is still wider than the native
  // thumbnail's device-pixel budget, the next tile stays at or above `min`,
  // and the ceiling has not been reached. Three stop conditions, in order:
  // sharpness, minimum tile width, MAX_COLS.
  function computeColumns(width, m) {
    const avail = Math.max(1, width - 2 * m.padX)
    const tile = (count) => (avail - (count - 1) * m.gap) / count
    let count = Math.max(1, Math.min(MAX_COLS, Math.round((avail + m.gap) / (m.target + m.gap))))
    while (count < MAX_COLS && Math.max(tile(count), m.cellH) * m.dpr > SOURCE_EDGE + EDGE_EPSILON && tile(count + 1) >= m.min) count++
    return count
  }

  return {
    MAX_COLS,
    SOURCE_EDGE,
    layout,
    rowAt,
    topOf,
    clamp,
    computeColumns
  }
})
