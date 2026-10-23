'use strict'
// The 150-record trim re-anchors the scroll position. This is kept separate from
// the renderer harness because it needs a 151-item mixed history driven through
// two list pages, and the interesting case is narrow: the trim cuts INTO the
// row at the top of the viewport, so that row's first cell disappears while
// later cells of the same row survive.
const test = require('node:test')
const assert = require('node:assert/strict')
const layout = require('../clipboard/clipboard-layout.js')

// Re-implements the renderer's anchor choice in isolation. Kept in lockstep with
// clipboard.js trimHistory() by the assertions below; if the product rule
// changes, this test must be updated deliberately rather than silently.
function pickAnchor(model, items, removed) {
  const topRow = model.rows[0]
  for (const index of topRow.items) {
    if (index >= removed) return { id: items[index].id, rowIndex: 0 }
  }
  const nextRow = model.rows[1]
  if (nextRow && nextRow.items.length) return { id: items[nextRow.items[0]].id, rowIndex: 1 }
  return { id: null, rowIndex: -1 }
}

const metrics = { rowH: 64, cellH: 92, gap: 8, cols: 4 }

test('trimming into the top image row anchors on a surviving cell, not the removed one', () => {
  // One full image row (4 cells) then text records: trimming 2 records removes
  // cells 0 and 1 of the row, so cells 2 and 3 survive and must become the anchor.
  const items = []
  for (let index = 0; index < 6; index++) items.push({ id: `img${index}`, kind: 'image' })
  for (let index = 0; index < 150; index++) items.push({ id: `txt${index}`, kind: 'text' })
  const model = layout.layout(items, metrics)
  assert.deepEqual(Array.from(model.rows[0].items), [0, 1, 2, 3])
  const removed = 2
  const anchor = pickAnchor(model, items, removed)
  assert.equal(anchor.id, 'img2', 'the first surviving cell of the top row is the anchor')
  // The old rule always took items[topRow.items[0]] = img0, which no longer
  // exists after the splice, so the scroll position collapsed to the very top.
  assert.notEqual(anchor.id, 'img0')
})

test('trimming a whole top row anchors on the following row', () => {
  const items = []
  for (let index = 0; index < 4; index++) items.push({ id: `img${index}`, kind: 'image' })
  for (let index = 0; index < 150; index++) items.push({ id: `txt${index}`, kind: 'text' })
  const model = layout.layout(items, metrics)
  const anchor = pickAnchor(model, items, 4)
  assert.equal(anchor.id, 'txt0', 'the next row becomes the anchor when the top row is fully cut')
})

test('an anchor that survives keeps a sane row offset after the rebuild', () => {
  const items = []
  for (let index = 0; index < 6; index++) items.push({ id: `img${index}`, kind: 'image' })
  for (let index = 0; index < 150; index++) items.push({ id: `txt${index}`, kind: 'text' })
  const model = layout.layout(items, metrics)
  const anchor = pickAnchor(model, items, 2)
  const remaining = items.slice(2)
  const rebuilt = layout.layout(remaining, metrics)
  const at = remaining.findIndex((item) => item.id === anchor.id)
  assert.ok(at >= 0, 'the anchor still exists in the rebuilt list')
  const row = rebuilt.rows[rebuilt.itemRow[at]]
  assert.ok(Number.isFinite(row.y), 'the anchor has a real content offset after the rebuild')
  assert.equal(row.type, 'images', 'the anchor stayed in an image row')
})

test('the product code still implements the anchor rule this file models', () => {
  // Guards against the test drifting away from the renderer: if trimHistory is
  // rewritten, this fails instead of quietly testing a rule nobody uses.
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'clipboard', 'clipboard.js'), 'utf8')
  const body = source.slice(source.indexOf('function trimHistory'), source.indexOf('function rebuildAndRender'))
  assert.ok(body, 'trimHistory exists in the renderer')
  assert.match(body, /for \(const index of topRow\.items\)/, 'anchors by scanning the top row for a surviving cell')
  assert.match(body, /index >= removed/, 'skips cells the trim removes')
  assert.match(body, /nextRow\.items\[0\]/, 'falls back to the following row')
  assert.doesNotMatch(body, /const anchorId = topRow && topRow\.items\.length \? items\[topRow\.items\[0\]\]/, 'the old first-cell rule is gone')
})
