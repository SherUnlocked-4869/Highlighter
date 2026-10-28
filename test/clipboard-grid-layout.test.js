'use strict'

// Unit tests for clipboard/clipboard-layout.js (the grid layout pure functions).
//
// The renderer's virtual window, keyboard model, spacer height and the
// 150-item trim anchor all read their geometry from this module, so a bug here
// would surface as overlapping rows or a jump to the top of the list. Every
// invariant is pinned here instead, including the degenerate text-only case
// that has to stay pixel-identical to the pre-grid 64px list.

const test = require('node:test')
const assert = require('node:assert/strict')

const layoutApi = require('../clipboard/clipboard-layout.js')

const { layout, rowAt, topOf, clamp, computeColumns, MAX_COLS, SOURCE_EDGE } = layoutApi

const METRICS = { rowH: 64, cellH: 92, gap: 8, cols: 4 }

const images = (count) => Array.from({ length: count }, () => ({ kind: 'image' }))
const texts = (count) => Array.from({ length: count }, () => ({ kind: 'text' }))
const kinds = (list) => list.map((kind) => ({ kind }))

// Expected gap between two adjacent rows: a gap is only present where at least
// one side is an image grid block.
const gapBetween = (cur, next, gap) => (cur.type === 'images' || next.type === 'images' ? gap : 0)

// Deterministic LCG (numerical recipes constants). Math.random() would make a
// failure impossible to reproduce from the report alone.
function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const FIXTURES = [
  { name: 'empty', items: [] },
  { name: 'single text', items: texts(1) },
  { name: 'single image', items: images(1) },
  { name: 'text only', items: texts(7) },
  { name: 'images only, one full row', items: images(4) },
  { name: 'images only, partial row', items: images(2) },
  { name: 'images only, exact multiple', items: images(12) },
  { name: 'images only, partial last row', items: images(11) },
  { name: 'image then text', items: kinds(['image', 'text']) },
  { name: 'text then image', items: kinds(['text', 'image']) },
  { name: 'image, text, image', items: kinds(['image', 'text', 'image']) },
  { name: 'text block, image block, text block', items: kinds(['text', 'text', 'image', 'image', 'image', 'text']) },
  { name: 'alternating', items: kinds(['image', 'text', 'image', 'text', 'image']) },
  { name: 'grid wider than cols', items: kinds(['image', 'image', 'image', 'image', 'image', 'image', 'image']) },
  // V2 file list: files is a text-shaped record, so it must not become a cell.
  { name: 'files only', items: kinds(['files', 'files', 'files']) },
  { name: 'files mixed with text and images', items: kinds(['text', 'files', 'image', 'files', 'text', 'image', 'image', 'files']) }
]

// --- 1. coverage: itemRow/itemCol is a permutation of [0, n) -----------------

test('group 1: itemRow/itemCol cover every item exactly once', () => {
  for (const fixture of FIXTURES) {
    for (const cols of [1, 2, 3, 4, 6]) {
      const model = layout(fixture.items, { ...METRICS, cols })
      const n = fixture.items.length

      assert.equal(model.itemRow.length, n, `${fixture.name} cols=${cols}: itemRow length`)
      assert.equal(model.itemCol.length, n, `${fixture.name} cols=${cols}: itemCol length`)

      const rowsSeen = new Set(model.itemRow)
      const pairs = new Set(model.itemRow.map((row, index) => `${row}:${model.itemCol[index]}`))

      assert.equal(pairs.size, n, `${fixture.name} cols=${cols}: row/col pairs must be unique`)
      assert.deepEqual([...rowsSeen].sort((a, b) => a - b), model.rows.map((_, index) => index),
        `${fixture.name} cols=${cols}: every row must own at least one item`)
      // A cell can only hold one item, and every item must land inside a row
      // that actually lists it.
      for (let i = 0; i < n; i += 1) {
        assert.ok(model.itemRow[i] >= 0 && model.itemRow[i] < model.rows.length,
          `${fixture.name} cols=${cols}: item ${i} row out of range`)
        assert.ok(model.rows[model.itemRow[i]].items.includes(i),
          `${fixture.name} cols=${cols}: row does not list item ${i}`)
      }
    }
  }
})

// --- 2. monotonicity and the gap rule ---------------------------------------

test('group 2: adjacent rows are monotonic and separated by exactly gapBetween', () => {
  for (const fixture of FIXTURES) {
    for (const cols of [1, 2, 3, 4, 6]) {
      const m = { ...METRICS, cols }
      const model = layout(fixture.items, m)
      let cursor = 0
      for (let r = 0; r < model.rows.length; r += 1) {
        const row = model.rows[r]
        assert.equal(row.y, cursor, `${fixture.name} cols=${cols}: row ${r} is not packed after row ${r - 1}`)
        assert.ok(row.h > 0, `${fixture.name} cols=${cols}: row ${r} needs a positive height`)
        cursor = row.y + row.h
        if (r + 1 < model.rows.length) {
          const next = model.rows[r + 1]
          assert.equal(next.y, row.y + row.h + gapBetween(row, next, m.gap),
            `${fixture.name} cols=${cols}: gap between row ${r} (${row.type}) and row ${r + 1} (${next.type})`)
          cursor += gapBetween(row, next, m.gap)
        }
      }
    }
  }
})

test('group 2b: consecutive image blocks pitch by cellH + gap, not cellH + 2 * gap', () => {
  // The trailing gap of one grid block already separates it from the next one.
  // Design doc §3.4 states the all-image 4-column pitch as "92 + 8 = 100", and
  // the grid would grow by an extra 8px per row if both sides added a gap.
  const m = { ...METRICS, cols: 4 }
  const model = layout(images(10), m)
  assert.equal(model.rows.length, 3)
  assert.deepEqual(model.rows.map((row) => row.y), [0, 100, 200])
  assert.equal(model.height, 292)
  for (let r = 1; r < model.rows.length; r += 1) {
    assert.equal(model.rows[r].y - (model.rows[r - 1].y + model.rows[r - 1].h), m.gap,
      `image row ${r} pitch`)
  }
})

test('group 2c: a zero gap still packs rows back to back', () => {
  for (const gap of [0, 1, 12]) {
    for (const fixture of FIXTURES) {
      const m = { ...METRICS, gap }
      const model = layout(fixture.items, m)
      for (let r = 1; r < model.rows.length; r += 1) {
        const expected = model.rows[r - 1].y + model.rows[r - 1].h + gapBetween(model.rows[r - 1], model.rows[r], gap)
        assert.equal(model.rows[r].y, expected, `gap=${gap} ${fixture.name} row ${r}`)
      }
    }
  }
})

// --- 3. degenerate text-only geometry (the zero-regression proof) -----------

test('group 3: a text-only history keeps the legacy 64px geometry exactly', () => {
  // This is the proof that text users see no change at all: previously the
  // renderer computed row tops as index * rowHeight with rowHeight = 64.
  for (const rowH of [64, 52, 80]) {
    const m = { ...METRICS, rowH }
    for (const count of [0, 1, 2, 5, 37, 150]) {
      const model = layout(texts(count), m)
      assert.equal(model.rows.length, count, `rowH=${rowH} count=${count}: one row per text item`)
      for (let i = 0; i < count; i += 1) {
        assert.equal(model.rows[i].y, i * rowH, `rowH=${rowH} count=${count}: row ${i} top`)
        assert.equal(model.rows[i].h, rowH, `rowH=${rowH} count=${count}: row ${i} height`)
        assert.equal(model.rows[i].type, 'row', `rowH=${rowH} count=${count}: row ${i} type`)
        assert.equal(model.itemRow[i], i)
        assert.equal(model.itemCol[i], 0)
      }
      assert.equal(model.height, count * rowH, `rowH=${rowH} count=${count}: total height`)
    }
  }
})

test('group 3b: a text-only height never grows by a trailing gap', () => {
  // The trailing `y += gap` after a grid block is conditional; if it ever
  // became unconditional the flat list would gain one gap of phantom scroll.
  const m = { ...METRICS, gap: 13, cellH: 92, cols: 4 }
  for (const count of [1, 2, 3, 150]) {
    assert.equal(layout(texts(count), m).height, count * m.rowH, `count=${count}`)
  }
})

// --- 4. grouping ------------------------------------------------------------

test('group 4: images only share rows with images, text rows hold one cell', () => {
  for (const fixture of FIXTURES) {
    for (const cols of [1, 2, 3, 4, 6]) {
      const model = layout(fixture.items, { ...METRICS, cols })
      for (const row of model.rows) {
        assert.ok(row.type === 'row' || row.type === 'images', `unknown row type ${row.type}`)
        assert.ok(row.h > 0)
        if (row.type === 'images') {
          assert.ok(row.h === METRICS.cellH, 'an images row always uses cellH')
          assert.ok(row.items.length <= cols, `images row holds ${row.items.length} > cols ${cols}`)
          assert.ok(row.items.length >= 1)
          // Every cell must be an image, in order, with a contiguous column
          // index starting at 0 (the CSS grid places them by column).
          row.items.forEach((index, cell) => {
            assert.equal(fixture.items[index].kind, 'image', `${fixture.name}: cell ${cell} is not an image`)
            assert.equal(model.itemRow[index], model.rows.indexOf(row))
            assert.equal(model.itemCol[index], cell, `${fixture.name}: column ${cell} is not contiguous`)
          })
        } else {
          assert.equal(row.items.length, 1, `${fixture.name}: a text row holds exactly one item`)
          const index = row.items[0]
          assert.notEqual(fixture.items[index].kind, 'image', `${fixture.name}: image must not sit in a text row`)
          assert.equal(model.itemRow[index], model.rows.indexOf(row))
          assert.equal(model.itemCol[index], 0)
        }
      }
      // Every images row is maximal: it stopped either because cols was
      // reached or because the next item is not an image. A row that is both
      // short and followed by another image would mean items were dropped.
      for (let r = 0; r < model.rows.length; r += 1) {
        const row = model.rows[r]
        if (row.type !== 'images') continue
        const last = row.items[row.items.length - 1]
        if (last + 1 >= fixture.items.length) continue
        assert.ok(row.items.length === cols || fixture.items[last + 1].kind !== 'image',
          `${fixture.name}: row ${r} stopped at ${row.items.length}/${cols} cells with another image following`)
      }
    }
  }
})

// --- 4b. files records are text rows (V2 file list) -------------------------

test('group 4b: files records lay out as text rows and never as grid cells', () => {
  // V2 (docs/plans/2026-10-27-clipboard-file-list-design.md §3.7): a copied file
  // list is a text-shaped record - the layout only special-cases `image`, and
  // this pins that it stays that way. A files record must sit on its own text
  // row with the legacy row geometry, even when it is surrounded by images.
  const m = { ...METRICS, cols: 4 }
  const mixed = kinds(['files', 'image', 'files', 'image', 'image', 'files', 'text', 'files', 'files'])
  const model = layout(mixed, m)

  mixed.forEach((item, index) => {
    if (item.kind !== 'files') return
    const row = model.rows[model.itemRow[index]]
    assert.equal(row.type, 'row', `file ${index} sits on a text row`)
    assert.deepEqual(row.items, [index], `file ${index} holds exactly one cell`)
    assert.equal(model.itemCol[index], 0, `file ${index} starts at column 0`)
    assert.equal(row.h, m.rowH, `file ${index} uses the text row height`)
  })

  // The whole geometry is unchanged: a file record occupies exactly the space a
  // text/url record would, so mixing files into a history must not move a single
  // existing row (and therefore must not change the image grid positions either).
  const asText = kinds(['text', 'image', 'text', 'image', 'image', 'text', 'url', 'text', 'text'])
  assert.deepEqual(layout(mixed, m), layout(asText, m))
})

// --- 5. no trailing whitespace, no overlap ----------------------------------

test('group 5: height is exactly the last row bottom and rows never overlap', () => {
  for (const fixture of FIXTURES) {
    for (const cols of [1, 2, 3, 4, 6]) {
      const model = layout(fixture.items, { ...METRICS, cols })
      if (model.rows.length === 0) {
        assert.equal(model.height, 0, `${fixture.name}: empty model height`)
        continue
      }
      const last = model.rows[model.rows.length - 1]
      assert.equal(model.height, last.y + last.h, `${fixture.name} cols=${cols}: height !== last row bottom`)
      for (let a = 0; a < model.rows.length; a += 1) {
        for (let b = a + 1; b < model.rows.length; b += 1) {
          const first = model.rows[a]
          const second = model.rows[b]
          const overlaps = first.y < second.y + second.h && second.y < first.y + first.h
          assert.equal(overlaps, false, `${fixture.name} cols=${cols}: rows ${a} and ${b} overlap`)
        }
      }
    }
  }
})

test('group 5b: an empty input yields no rows, no cells and zero height', () => {
  for (const cols of [1, 4, 12]) {
    const model = layout([], { ...METRICS, cols })
    assert.deepEqual(model.rows, [])
    assert.deepEqual(model.itemRow, [])
    assert.deepEqual(model.itemCol, [])
    assert.equal(model.height, 0)
    assert.equal(rowAt(model, 0), 0)
    assert.equal(rowAt(model, 500), 0)
  }
})

// --- 6. randomised self-consistency ----------------------------------------

// Reduces a model to the two structural invariants so the random sweep can
// reuse exactly the same expectations as groups 2 and 5.
function assertSelfConsistent(model, m, label) {
  let cursor = 0
  for (let r = 0; r < model.rows.length; r += 1) {
    const row = model.rows[r]
    assert.equal(row.y, cursor, `${label}: row ${r} not packed`)
    cursor = row.y + row.h
    if (r + 1 < model.rows.length) {
      const next = model.rows[r + 1]
      assert.equal(next.y, row.y + row.h + gapBetween(row, next, m.gap),
        `${label}: gap between rows ${r} and ${r + 1}`)
      cursor += gapBetween(row, next, m.gap)
    }
    assert.ok(row.h > 0, `${label}: row ${r} height`)
    if (row.type === 'images') assert.ok(row.items.length <= m.cols, `${label}: row ${r} overfull`)
    else assert.equal(row.items.length, 1, `${label}: text row ${r} cell count`)
  }
  assert.equal(model.height, model.rows.length ? cursor : 0, `${label}: height`)
  if (model.rows.length) {
    const last = model.rows[model.rows.length - 1]
    assert.equal(model.height, last.y + last.h, `${label}: height !== last bottom`)
  }
  for (let a = 1; a < model.rows.length; a += 1) {
    assert.ok(model.rows[a].y >= model.rows[a - 1].y + model.rows[a - 1].h, `${label}: rows ${a - 1}/${a} overlap`)
  }
}

test('group 6: 200 seeded random models satisfy every structural invariant', () => {
  const random = createRandom(0x5eed1234)
  const samples = []
  for (let sample = 0; sample < 200; sample += 1) {
    const length = Math.floor(random() * 151) // 0..150
    const cols = 1 + Math.floor(random() * 6) // 1..6
    const items = []
    for (let i = 0; i < length; i += 1) {
      items.push({ kind: random() < 0.5 ? 'image' : (random() < 0.5 ? 'text' : 'url') })
    }
    const m = { ...METRICS, cols }
    const model = layout(items, m)
    const label = `sample ${sample} (n=${length}, cols=${cols})`
    assert.equal(model.itemRow.length, items.length, `${label}: itemRow length`)
    assert.equal(model.itemCol.length, items.length, `${label}: itemCol length`)
    assert.equal(new Set(model.itemRow.map((row, index) => `${row}:${model.itemCol[index]}`)).size, items.length,
      `${label}: item row/col pairs must be unique`)
    assertSelfConsistent(model, m, label)
    samples.push({ model, items, m })
  }
  assert.equal(samples.length, 200)
  // Sanity: the sweep must actually have produced both row types, otherwise the
  // random source is broken and every assertion above is vacuous.
  assert.ok(samples.some(({ model }) => model.rows.some((row) => row.type === 'images')))
  assert.ok(samples.some(({ model }) => model.rows.some((row) => row.type === 'row')))
  assert.ok(samples.some(({ model }) => model.rows.length === 0), 'the sweep must include an empty model')
})

// --- 7. rowAt ---------------------------------------------------------------

test('group 7: rowAt maps inside-row y to that row', () => {
  const random = createRandom(0xc0ffee)
  for (let sample = 0; sample < 60; sample += 1) {
    const length = Math.floor(random() * 60)
    const cols = 1 + Math.floor(random() * 6)
    const items = Array.from({ length }, () => ({ kind: random() < 0.5 ? 'image' : 'text' }))
    const m = { ...METRICS, cols }
    const model = layout(items, m)
    for (let r = 0; r < model.rows.length; r += 1) {
      const row = model.rows[r]
      // Points strictly inside the row band: top, middle, just before the bottom.
      for (const y of [row.y, row.y + row.h / 2, row.y + row.h - 1e-6]) {
        const got = rowAt(model, y)
        assert.ok(got >= 0 && got < model.rows.length, `sample ${sample}: rowAt out of range`)
        assert.ok(model.rows[got].y <= y, `sample ${sample}: row ${got} starts below y=${y}`)
        assert.ok(got + 1 === model.rows.length || model.rows[got + 1].y > y,
          `sample ${sample}: row ${got + 1} already starts at or above y=${y}`)
        if (y >= row.y && y < row.y + row.h && got !== model.rows.length - 1) {
          assert.ok(model.rows[got].y <= row.y, `sample ${sample}: y=${y} inside row ${r} but got ${got}`)
        }
      }
    }
  }
})

test('group 7b: rowAt returns the defining row for arbitrary y, including gaps', () => {
  // Gap positions sit between two rows: rowAt then names the first row whose
  // bottom is below y (the row that is partially visible), so the invariant to
  // check is "one past the last row fully above y", not "row starts at or
  // above y". This is what the virtual window needs: the top row of the
  // viewport must be the row that is still partly on screen.
  const random = createRandom(0xbadf00d)
  for (let sample = 0; sample < 60; sample += 1) {
    const length = Math.floor(random() * 80)
    const cols = 1 + Math.floor(random() * 6)
    const items = Array.from({ length }, () => ({ kind: random() < 0.5 ? 'image' : 'text' }))
    const m = { ...METRICS, cols }
    const model = layout(items, m)
    const probes = [0, 0.5, 1, m.gap, m.rowH, m.cellH, model.height, model.height + 500, 1e9]
    for (const row of model.rows) {
      probes.push(row.y - 1, row.y + row.h, row.y + row.h + m.gap / 2)
    }
    for (const y of probes) {
      const got = rowAt(model, y)
      assert.ok(got >= 0 && got < Math.max(1, model.rows.length), `sample ${sample}: rowAt(${y}) out of range`)
      if (!model.rows.length) { assert.equal(got, 0); continue }
      assert.ok(got === 0 || model.rows[got - 1].y + model.rows[got - 1].h <= y,
        `sample ${sample}: row ${got - 1} is not fully above y=${y}`)
      assert.ok(got === model.rows.length - 1 || model.rows[got + 1].y > y,
        `sample ${sample}: row ${got + 1} already starts at or above y=${y}`)
    }
  }
})

test('group 7c: rowAt boundaries', () => {
  const model = layout(kinds(['text', 'image', 'image', 'image', 'image', 'image', 'text']), { ...METRICS, cols: 4 })
  assert.ok(model.rows.length > 1)
  assert.equal(rowAt(model, -1), 0)
  assert.equal(rowAt(model, -1e9), 0)
  assert.equal(rowAt(model, 0), 0)
  assert.equal(rowAt(model, 1e9), model.rows.length - 1)
  assert.equal(rowAt(model, model.height), model.rows.length - 1)
  assert.equal(rowAt(layout([], METRICS), -1), 0)
  assert.equal(rowAt(layout([], METRICS), 1e9), 0)
  // A single-row model always reports row 0.
  const single = layout(texts(1), METRICS)
  assert.equal(rowAt(single, 0), 0)
  assert.equal(rowAt(single, 1e9), 0)
})

// --- 8. computeColumns ------------------------------------------------------

// Mirrors the CSS media queries the renderer reads --cell-h from.
const cellHFor = (dpr) => (dpr >= 2.5 ? 64 : dpr >= 2.25 ? 80 : 92)
const DPRS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]
const WIDTHS = [380, 420, 480, 520, 560, 640, 720, 840, 960, 1080, 1200]

// Panel border 2 + scrollbar gutter 9, as the renderer measures it.
const contentWidth = (panelWidth) => panelWidth - 2 - 9

function columnsFor(panelWidth, dpr) {
  const m = { cellH: cellHFor(dpr), gap: 8, padX: 10, target: 110, min: 72, dpr }
  return { cols: computeColumns(contentWidth(panelWidth), m), m }
}

const tileOf = (panelWidth, m, count) => {
  const avail = Math.max(1, contentWidth(panelWidth) - 2 * m.padX)
  return (avail - (count - 1) * m.gap) / count
}

test('group 8: column count stays within bounds across every DPR and width', () => {
  for (const panelWidth of WIDTHS) {
    for (const dpr of DPRS) {
      const { cols, m } = columnsFor(panelWidth, dpr)
      const label = `panel=${panelWidth} dpr=${dpr}`
      assert.ok(Number.isInteger(cols), `${label}: cols must be an integer, got ${cols}`)
      assert.ok(cols >= 1, `${label}: cols must be at least 1`)
      assert.ok(cols <= MAX_COLS, `${label}: cols ${cols} exceeds MAX_COLS ${MAX_COLS}`)
    }
  }
})

test('group 8b: every column count honours a stop condition', () => {
  // Sharpness, column ceiling or minimum tile width -- one of the three must
  // explain why the loop stopped; otherwise the tile is being upscaled beyond
  // the native thumbnail budget for no reason.
  for (const panelWidth of WIDTHS) {
    for (const dpr of DPRS) {
      const { cols, m } = columnsFor(panelWidth, dpr)
      const label = `panel=${panelWidth} dpr=${dpr} cols=${cols}`
      const deviceEdge = Math.max(tileOf(panelWidth, m, cols), m.cellH) * m.dpr
      assert.ok(
        deviceEdge <= SOURCE_EDGE || cols === MAX_COLS || tileOf(panelWidth, m, cols + 1) < m.min,
        `${label}: stopped with device edge ${deviceEdge.toFixed(2)} > ${SOURCE_EDGE}, ` +
        `below MAX_COLS, and room for another tile (${tileOf(panelWidth, m, cols + 1).toFixed(2)} >= ${m.min})`
      )
    }
  }
})

test('group 8c: the default 480px panel resolves to 4 columns, 5 at DPR 2.5+', () => {
  const expected = { 1: 4, 1.25: 4, 1.5: 4, 1.75: 4, 2: 4, 2.25: 4, 2.5: 5, 3: 5 }
  for (const [dpr, cols] of Object.entries(expected)) {
    assert.equal(columnsFor(480, Number(dpr)).cols, cols, `dpr=${dpr}`)
  }
})

test('group 8d: a tiny width never returns zero or a negative count', () => {
  for (const dpr of DPRS) {
    for (const width of [0, 1, 40, -5, -1e9]) {
      const m = { cellH: cellHFor(dpr), gap: 8, padX: 10, target: 110, min: 72, dpr }
      const cols = computeColumns(width, m)
      assert.equal(cols, 1, `width=${width} dpr=${dpr}`)
    }
  }
})

test('group 8e: computeColumns agrees with the columns layout actually uses', () => {
  // The renderer reads the column count once and feeds it to layout; a
  // mismatch here would leave the last grid row short by a cell.
  const { cols, m } = columnsFor(480, 2)
  assert.equal(cols, 4)
  const model = layout(images(9), { ...METRICS, cols, cellH: m.cellH })
  assert.equal(model.rows.length, 3)
  assert.deepEqual(model.rows.map((row) => row.items.length), [4, 4, 1])
  assert.equal(topOf(model, 8), model.rows[2].y)
  assert.equal(topOf(model, 0), 0)
})

// --- helpers ----------------------------------------------------------------

test('topOf returns the row top edge of the item', () => {
  const m = { ...METRICS, cols: 3 }
  const model = layout(kinds(['text', 'image', 'image', 'image', 'image', 'text']), m)
  model.itemRow.forEach((rowIndex, index) => {
    assert.equal(topOf(model, index), model.rows[rowIndex].y, `item ${index}`)
  })
  // Out-of-range indexes must not throw: the renderer calls it before the list
  // has been laid out once.
  assert.equal(topOf({ rows: [], itemRow: [] }, 0), 0)
  assert.equal(topOf({ rows: [], itemRow: [] }, 99), 0)
})

test('clamp bounds the value on both sides', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(11, 0, 10), 10)
  assert.equal(clamp(0, 0, 0), 0)
  assert.equal(clamp(1e9, 0, 10), 10)
  // The virtual window computes scrollTop - inner, which can be negative.
  assert.equal(clamp(-500, 0, 1200), 0)
})

test('layout does not mutate its input', () => {
  const items = kinds(['text', 'image', 'image', 'image', 'image', 'image', 'text', 'image'])
  const snapshot = JSON.parse(JSON.stringify(items))
  const metrics = { ...METRICS, cols: 3 }
  const metricsSnapshot = { ...metrics }
  const model = layout(items, metrics)
  assert.deepEqual(items, snapshot, 'layout must not touch the item list')
  assert.deepEqual(metrics, metricsSnapshot, 'layout must not touch the metrics')
  // The returned rows must not alias the input either: writing a row back into
  // the model must never reach the item objects.
  model.rows.forEach((row) => { row.items.push(-1) })
  assert.deepEqual(items, snapshot, 'mutating the model must not reach the items')
})

test('the exported surface is exactly the documented API', () => {
  assert.deepEqual(Object.keys(layoutApi).sort(), [
    'MAX_COLS', 'SOURCE_EDGE', 'clamp', 'computeColumns', 'layout', 'rowAt', 'topOf'
  ])
  assert.equal(MAX_COLS, 12)
  assert.equal(SOURCE_EDGE, 240)
})
