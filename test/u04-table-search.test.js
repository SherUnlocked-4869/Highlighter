'use strict'

// U04b: review report section 4.4 items 6 and 7 — OCR table column clustering
// (1D horizontal interval projection + merged cells) and local-search icon
// caching / merged-query ordering.
//
// The OCR and search modules are plain Node modules, so both halves are exercised
// behaviourally against their public functions. The two pieces that cannot run in
// a plain Node process (the renderer wiring and the Rust sidecar) are covered by
// source-level contract assertions plus, for Rust, the `cargo test` unit tests
// named below.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')

const { buildTableFromOcr } = require('../capture/recognition-utils')
const { buildWorkbookParts, buildXlsxBuffer } = require('../main/services/table-workbook')
const {
  mergeQueryResults,
  iconCacheKey,
  isFolderItem,
  usesPathIcon,
  PATH_ICON_EXTENSIONS
} = require('../search/search-utils')
const { createFileIconLookup } = require('../main/services/file-icon-lookup')

const ROOT = path.join(__dirname, '..')
const SHEET = 'xl/worksheets/sheet1.xml'

// --- OCR fixture helpers -----------------------------------------------------

// A PaddleOCR text block: `box_points` is the four-corner box the recognizer
// returns, and every table heuristic reads its axis-aligned bounds.
function ocrBlock(text, left, top, right, bottom, score = 0.95) {
  return {
    text,
    text_score: score,
    box_points: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom }
    ]
  }
}

// Three columns at x = 0-10 / 50-70 / 100-120; the rows deliberately miss
// columns (1-3 cells per row) and do not start with the same column, which is
// exactly the sparse layout the old mode-of-row-counts clustering under-counted.
function sparseTableFixture() {
  return {
    textBlocks: [
      ocrBlock('A1', 0, 0, 10, 10),
      ocrBlock('C1', 100, 0, 120, 10),
      ocrBlock('B2', 50, 20, 70, 30),
      ocrBlock('C2', 100, 20, 120, 30),
      ocrBlock('A3', 0, 40, 10, 50),
      ocrBlock('B3', 50, 40, 70, 50),
      ocrBlock('C3', 100, 40, 120, 50),
      ocrBlock('A4', 0, 60, 10, 70)
    ]
  }
}

// A full-width header over three columns plus a cell spanning the last two
// columns: both must become `merges` instead of inventing or losing columns.
function mergedTableFixture() {
  return {
    textBlocks: [
      ocrBlock('Quarterly report', 0, 0, 120, 10),
      ocrBlock('A', 0, 20, 10, 30),
      ocrBlock('B + C', 50, 20, 120, 30),
      ocrBlock('1', 0, 40, 10, 50),
      ocrBlock('2', 50, 40, 70, 50),
      ocrBlock('3', 100, 40, 120, 50)
    ]
  }
}

function sheetXml(rows, options) {
  return buildWorkbookParts(rows, options)[SHEET].toString('utf8')
}

// --- 6. OCR table column clustering -----------------------------------------

test('U04 sparse table columns come from x-interval projection, not row block counts', () => {
  const table = buildTableFromOcr(sparseTableFixture())
  assert.ok(table, 'a sparse multi-column table must still be recognized')
  // The old algorithm saw one row with two cells and reported two columns.
  assert.equal(table.columnCount, 3)
  assert.equal(table.rowCount, 4)
  // Anchors are the projected band centers, not medians of `row.blocks[index]`.
  assert.deepEqual(table.anchors, [5, 60, 110])
  assert.deepEqual(table.columnBounds, [
    { left: 0, right: 10 },
    { left: 50, right: 70 },
    { left: 100, right: 120 }
  ])
  // Missing cells are empty columns of the right row — not a shifted cell index.
  assert.deepEqual(table.rows, [
    ['A1', '', 'C1'],
    ['', 'B2', 'C2'],
    ['A3', 'B3', 'C3'],
    ['A4', '', '']
  ])
  assert.deepEqual(table.merges, [])
  assert.equal(table.tsv, 'A1\t\tC1\n\tB2\tC2\nA3\tB3\tC3\nA4\t\t')
})

test('U04 merged cells keep their text in the first column and emit {s,e} merges', () => {
  const table = buildTableFromOcr(mergedTableFixture())
  assert.ok(table)
  assert.equal(table.columnCount, 3)
  assert.deepEqual(table.rows, [
    ['Quarterly report', '', ''],
    ['A', 'B + C', ''],
    ['1', '2', '3']
  ])
  // The workbook writer already accepts this exact shape (see
  // main/services/table-workbook.js normalizeMerge), and the recognition
  // renderer forwards `tableResult.merges` to recognition:export-excel.
  assert.deepEqual(table.merges, [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 1, c: 1 }, e: { r: 1, c: 2 } }
  ])
})

test('U04 column bands tolerate per-row x jitter without splitting or shifting a column', () => {
  const table = buildTableFromOcr({
    textBlocks: [
      ocrBlock('A0', 0, 0, 10, 10),
      ocrBlock('B0', 50, 0, 60, 10),
      ocrBlock('C0', 100, 0, 110, 10),
      // Row 1 is missing its middle cell and both remaining boxes are jittered.
      ocrBlock('A1', 3, 20, 13, 30),
      ocrBlock('C1', 97, 20, 107, 30),
      // Row 2 is jittered the other way.
      ocrBlock('A2', -2, 40, 8, 50),
      ocrBlock('B2', 53, 40, 63, 50),
      ocrBlock('C2', 100, 40, 110, 50)
    ]
  })
  assert.ok(table)
  assert.equal(table.columnCount, 3, 'jittered cells of one column must not create extra columns')
  assert.deepEqual(table.rows, [
    ['A0', 'B0', 'C0'],
    ['A1', '', 'C1'],
    ['A2', 'B2', 'C2']
  ])
  assert.deepEqual(table.merges, [])
})

test('U04 single-column or empty results fail closed while a real table keeps its rows', () => {
  assert.equal(buildTableFromOcr({ textBlocks: [] }), null)
  // One column cannot be exported as a table; the caller shows the "no stable
  // table" error instead of writing a degenerate one-column sheet.
  assert.equal(buildTableFromOcr({
    textBlocks: [ocrBlock('only', 0, 0, 10, 10), ocrBlock('column', 0, 20, 10, 30)]
  }), null)
  // A single row is not a table either.
  assert.equal(buildTableFromOcr({
    textBlocks: [ocrBlock('a', 0, 0, 10, 10), ocrBlock('b', 50, 0, 60, 10)]
  }), null)

  const twoByTwo = buildTableFromOcr({
    textBlocks: [
      ocrBlock('A', 0, 0, 10, 10),
      ocrBlock('B', 50, 0, 60, 10),
      ocrBlock('1', 0, 20, 10, 30),
      ocrBlock('2', 50, 20, 60, 30)
    ]
  })
  assert.equal(twoByTwo.columnCount, 2)
  assert.deepEqual(twoByTwo.rows, [['A', 'B'], ['1', '2']])
})

test('U04 low-confidence and empty OCR blocks are dropped before rows are clustered', () => {
  const result = {
    textBlocks: [
      ocrBlock('A', 0, 0, 10, 10),
      ocrBlock('B', 50, 0, 60, 10),
      // This whole row is unusable: one low-confidence block and one empty one.
      ocrBlock('noise', 0, 20, 10, 30, 0.1),
      ocrBlock('   ', 50, 20, 60, 30),
      ocrBlock('1', 0, 40, 10, 50),
      ocrBlock('2', 50, 40, 60, 50)
    ]
  }
  const table = buildTableFromOcr(result)
  assert.ok(table)
  assert.equal(table.rowCount, 2, 'the unusable row disappears entirely')
  assert.deepEqual(table.rows, [['A', 'B'], ['1', '2']])

  // The threshold stays configurable: lowering it keeps the row.
  const permissive = buildTableFromOcr(result, { minConfidence: 0.05 })
  assert.equal(permissive.rowCount, 3)
})

test('U04 OCR merges are written as SpreadsheetML mergeCells that Excel/WPS accept', () => {
  const table = buildTableFromOcr(mergedTableFixture())
  const parts = buildWorkbookParts(table.rows, { merges: table.merges, sheetName: 'U04' })
  const xml = parts[SHEET].toString('utf8')
  assert.match(xml, /<mergeCells count="2"><mergeCell ref="A1:C1"\/><mergeCell ref="B2:C2"\/><\/mergeCells>/)
  assert.match(xml, /<dimension ref="A1:C3"\/>/)
  // Covered cells are empty (the merge owns the range), the start cell keeps text.
  assert.match(xml, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">Quarterly report<\/t><\/is><\/c>/)
  assert.doesNotMatch(xml, /<c r="B1"/)
  assert.doesNotMatch(xml, /<c r="C1"/)

  // The .xlsx buffer round-trips: the merge part survives the zip.
  const reopened = new AdmZip(buildXlsxBuffer(table.rows, { merges: table.merges })).readAsText(SHEET)
  assert.match(reopened, /<mergeCell ref="A1:C1"\/>/)
})

test('U04 overlapping merge ranges are dropped so the workbook cannot need repair', () => {
  const rows = [['a', 'b', 'c', 'd'], ['1', '2', '3', '4']]
  const overlapping = sheetXml(rows, {
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
      { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }
    ]
  })
  assert.match(overlapping, /<mergeCells count="1"><mergeCell ref="A1:C1"\/><\/mergeCells>/)

  // Ranges on different rows do not overlap and both survive.
  const stacked = sheetXml(rows, {
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } }
    ]
  })
  assert.match(stacked, /<mergeCells count="2"><mergeCell ref="A1:B1"\/><mergeCell ref="A2:B2"\/><\/mergeCells>/)
})

// --- 7. Local-search merged ordering ----------------------------------------

function searchItem(name, fullPath, size, modifiedAt, extra = {}) {
  return {
    name,
    fullPath,
    extension: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '',
    size,
    modifiedAt,
    ...extra
  }
}

// Two query batches, each already sorted by Everything for the requested mode.
// The same `tool.exe` name appears in both (different folders), and one item is
// returned by both queries: the merge must dedupe and then re-sort globally.
function mergedBatches() {
  const items = {
    A: searchItem('tool.exe', 'C:\\apps\\tool.exe', 100, 500),
    B: searchItem('tool.exe', 'D:\\backup\\tool.exe', 300, 100),
    C: searchItem('alpha', 'C:\\docs\\alpha', 0, 300, { isFolder: true }),
    D: searchItem('zeta.exe', 'C:\\apps\\zeta.exe', 200, 400),
    E: searchItem('beta.exe', 'D:\\apps\\beta.exe', 300, 300),
    F: searchItem('gamma.exe', 'C:\\apps\\gamma.exe', 50, 100)
  }
  return {
    items,
    batches: [
      { total: 3, items: [items.A, items.C, items.E] },
      { total: 4, items: [items.D, items.F, items.B, items.A] }
    ]
  }
}

test('U04 mergeQueryResults re-sorts the merged batches for every supported sortMode', () => {
  const { items, batches } = mergedBatches()
  const expected = {
    'name-asc': [items.C, items.E, items.F, items.A, items.B, items.D],
    'name-desc': [items.D, items.A, items.B, items.F, items.E, items.C],
    'path-asc': [items.F, items.A, items.D, items.C, items.E, items.B],
    'path-desc': [items.B, items.E, items.C, items.D, items.A, items.F],
    'size-asc': [items.C, items.F, items.A, items.D, items.E, items.B],
    'size-desc': [items.E, items.B, items.D, items.A, items.F, items.C],
    'modified-asc': [items.F, items.B, items.C, items.E, items.D, items.A],
    'modified-desc': [items.A, items.D, items.C, items.E, items.F, items.B]
  }
  for (const [sortMode, order] of Object.entries(expected)) {
    const merged = mergeQueryResults(batches, sortMode)
    assert.deepEqual(
      merged.items.map((item) => item.fullPath),
      order.map((item) => item.fullPath),
      `merged order for ${sortMode}`
    )
    assert.equal(merged.items.length, 6, 'the duplicate path is merged once')
    assert.equal(merged.total, 4, 'total stays the largest batch total')
  }

  // No sortMode keeps the sidecar default (modified-desc), matching the renderer.
  assert.deepEqual(
    mergeQueryResults(batches).items.map((item) => item.fullPath),
    expected['modified-desc'].map((item) => item.fullPath)
  )

  // With matchPath off there is a single query: Everything already ordered it, so
  // the merge must not reshuffle the batch with the simpler client comparator.
  const single = mergeQueryResults([{ total: 2, items: [items.C, items.A] }], 'name-asc')
  assert.deepEqual(single.items.map((item) => item.fullPath), [items.C.fullPath, items.A.fullPath])
})

test('U04 icon cache keys use the full path for exe/lnk/ico and the extension elsewhere', () => {
  assert.deepEqual([...PATH_ICON_EXTENSIONS].sort(), ['exe', 'ico', 'lnk'])
  assert.equal(usesPathIcon('EXE'), true)
  assert.equal(usesPathIcon('.lnk'), true)
  assert.equal(usesPathIcon('ico'), true)
  assert.equal(usesPathIcon('txt'), false)

  // Same file name, different folders: separate cache entries, so the icons no
  // longer overwrite each other.
  const firstExe = iconCacheKey({ name: 'tool.exe', extension: 'exe', fullPath: 'C:\\apps\\tool.exe' })
  const secondExe = iconCacheKey({ name: 'tool.exe', extension: 'exe', fullPath: 'D:\\backup\\tool.exe' })
  assert.notEqual(firstExe, secondExe)
  assert.equal(firstExe, 'path:c:\\apps\\tool.exe')
  // Windows paths are case-insensitive: the same file must hit the same entry.
  assert.equal(iconCacheKey({ extension: 'exe', fullPath: 'c:\\APPS\\Tool.EXE' }), firstExe)

  assert.equal(iconCacheKey({ extension: 'lnk', fullPath: 'C:\\a\\shortcut.lnk' }), 'path:c:\\a\\shortcut.lnk')
  assert.equal(iconCacheKey({ extension: 'ico', fullPath: 'C:\\a\\app.ico' }), 'path:c:\\a\\app.ico')

  // Document types keep the cheap per-extension icon.
  assert.equal(
    iconCacheKey({ extension: 'txt', fullPath: 'C:\\a\\notes.txt' }),
    iconCacheKey({ extension: 'txt', fullPath: 'D:\\b\\other.txt' })
  )
  // A folder renders the folder glyph, so it never requests an icon.
  assert.equal(iconCacheKey({ isFolder: true, extension: '', fullPath: 'C:\\docs' }), '')
  assert.equal(isFolderItem({ isFolder: true }), true)
  assert.equal(isFolderItem({ isFolder: 'true' }), false)
  // Extensionless non-folder files still fall back to the "?" badge.
  assert.equal(iconCacheKey({ extension: '', fullPath: 'C:\\docs\\LICENSE' }), '')
  assert.equal(iconCacheKey(null), '')
})

test('U04 the main-process icon lookup caches executables per path and documents per type', async () => {
  const calls = []
  const lookup = createFileIconLookup({
    app: {
      getFileIcon: async (file) => {
        calls.push(file)
        return { isEmpty: () => false, toDataURL: () => `data:icon:${file}` }
      }
    },
    log: () => {}
  })

  const chrome = await lookup('C:\\tools\\chrome.exe')
  assert.equal(chrome, 'data:icon:C:\\tools\\chrome.exe')
  // The second executable must not receive the first one's icon.
  const notepad = await lookup('D:\\tools\\notepad.exe')
  assert.equal(notepad, 'data:icon:D:\\tools\\notepad.exe')
  assert.notEqual(chrome, notepad)
  assert.deepEqual(calls, ['C:\\tools\\chrome.exe', 'D:\\tools\\notepad.exe'])

  // Cached by full path, case-insensitively.
  await lookup('c:\\TOOLS\\chrome.exe')
  assert.equal(calls.length, 2, 'a repeated executable path is served from the cache')

  // Shortcuts and icon files follow the same per-path rule.
  await lookup('C:\\menus\\shortcut.lnk')
  await lookup('D:\\menus\\shortcut.lnk')
  await lookup('C:\\app\\icon.ico')
  await lookup('D:\\app\\icon.ico')
  assert.equal(calls.length, 6)

  // Document types keep one icon per extension (the cheap path).
  await lookup('C:\\docs\\first.txt')
  await lookup('D:\\docs\\second.txt')
  assert.equal(calls.length, 7, 'a second .txt path reuses the extension icon')

  // Invalid input never reaches Electron.
  assert.equal(await lookup('relative.txt'), null)
  assert.equal(await lookup(''), null)
  assert.equal(calls.length, 7)
})

test('U04 the search renderer sorts merged results by sortMode and keys icons by path', () => {
  const script = fs.readFileSync(path.join(ROOT, 'search', 'search.js'), 'utf8')

  // Dual-query merge is re-sorted with the user's persisted sortMode.
  assert.match(script, /mergeQueryResults\(fulfilled, state\.settings\.sortMode\)/)
  // Executable-style icons are requested by full path and patched by cache key.
  assert.match(script, /const cacheKey = iconCacheKey\(item\)/)
  assert.match(script, /pendingKeys\.set\(cacheKey, item\.fullPath\)/)
  assert.match(script, /searchAPI\.getFileIcon\(samplePath\)/)
  assert.match(script, /data-icon-key="\$\{escapeHtml\(iconCacheKey\(item\)\)\}"/)
  assert.match(script, /row\.dataset\.iconKey !== cacheKey/)
  // The old per-extension pending map is gone.
  assert.doesNotMatch(script, /pendingExtensions/)

  // Folder results render the SVG glyph instead of the "?" extension badge, and
  // hide Everything's U64_MAX directory size instead of printing an absurd number.
  assert.match(script, /const FOLDER_ICON_MARKUP = '<svg/)
  assert.match(script, /if \(isFolderItem\(item\)\) return FOLDER_ICON_MARKUP/)
  assert.match(script, /data-folder="\$\{isFolderItem\(item\) \? 'true' : 'false'\}"/)
  assert.match(script, /formatSize\(isFolderItem\(item\) \? 0 : item\.size\)/)

  const utils = fs.readFileSync(path.join(ROOT, 'search', 'search-utils.js'), 'utf8')
  for (const name of ['isFolderItem', 'iconCacheKey', 'compareSearchItems', 'PATH_ICON_EXTENSIONS']) {
    assert.match(utils, new RegExp(`function ${name}\\(|const ${name} `), `${name} stays exported from search-utils`)
  }
})

test('U04 the Everything sidecar requests file attributes and reports isFolder', () => {
  const source = fs.readFileSync(path.join(ROOT, 'native', 'everything-search', 'src', 'main.rs'), 'utf8')

  assert.match(source, /const REQ_ATTRIBUTES: u32 = 0x0000_0100;/)
  const orderBlock = /const REQUEST_FLAGS_ORDER: \[\(u32, &str\); 8\] = \[([\s\S]*?)\n\];/.exec(source)
  assert.ok(orderBlock, 'the canonical request-flag order must list 8 fields')
  const order = [...orderBlock[1].matchAll(/\(\s*(REQ_[A-Z_]+),\s*"([a-zA-Z]+)"\s*\)/g)]
    .map((match) => ({ flag: match[1], key: match[2] }))
  assert.deepEqual(order.map((entry) => entry.flag), [
    'REQ_FILE_NAME',
    'REQ_PATH',
    'REQ_EXTENSION',
    'REQ_SIZE',
    'REQ_DATE_MODIFIED',
    'REQ_ATTRIBUTES',
    'REQ_HIGHLIGHTED_NAME',
    'REQ_HIGHLIGHTED_PATH'
  ])
  assert.equal(order[5].key, 'attributes')
  // The attribute dword is a u32 and must not be decoded as a UTF-16 string.
  assert.match(source, /REQ_ATTRIBUTES => read_u32\(data, &mut cursor\)/)
  assert.match(source, /fn read_u32\(data: &\[u8\], cursor: &mut usize\) -> Option<u32>/)
  // The user query asks for it; the reply is mapped to the renderer's flag.
  const requestFlags = /fn query_request_flags\(\) -> u32 \{([\s\S]*?)\n\}/.exec(source)
  assert.ok(requestFlags, 'query_request_flags() exists')
  assert.match(requestFlags[1], /REQ_ATTRIBUTES/)
  assert.match(source, /let request_flags = query_request_flags\(\);/)
  assert.match(source, /FILE_ATTRIBUTE_DIRECTORY/)
  assert.match(source, /"isFolder"\.to_string\(\)/)
  assert.match(source, /items\[0\]\.get\("attributes"\)\.is_none\(\)|the raw attribute dword stays an internal IPC detail/)

  // The Rust unit tests that prove the reply layout are part of cargo test.
  assert.match(source, /fn u04_query_requests_file_attributes_for_folder_detection\(\)/)
  assert.match(source, /fn u04_parse_reply_marks_directories_from_file_attributes\(\)/)

  // The tracked sidecar binary is rebuilt, not the stale pre-U04 build.
  const binary = path.join(ROOT, 'native', 'everything-search', 'bin', 'HighlighterEverything.exe')
  const stats = fs.statSync(binary)
  assert.ok(stats.size > 100_000, 'the tracked EXE must be a real, rebuilt binary')
})

// `isFolder` arrives from the sidecar as a JSON boolean; the renderer must not
// guess folders from an empty extension (extensionless files exist).
test('U04 folder detection trusts the sidecar flag instead of the empty extension', () => {
  assert.equal(isFolderItem({ extension: '', fullPath: 'C:\\docs' }), false)
  assert.equal(isFolderItem({ extension: '', fullPath: 'C:\\docs', isFolder: true }), true)
})
