// Table recognition → .xlsx workbook (2026-10-18 snow migration §6.2①).
//
// The module is pure (no Electron, no DOM), so the whole OOXML contract can be
// asserted as text: part set, cell typing, escaping and the hard limits that turn
// a corrupt workbook into a rejected one.
const test = require('node:test')
const assert = require('node:assert/strict')
const AdmZip = require('adm-zip')

const {
  CELL_CHARACTER_LIMIT,
  COLUMN_LIMIT,
  DEFAULT_SHEET_NAME,
  ROW_LIMIT,
  SHEET_NAME_LIMIT,
  TEXT_STYLE_INDEX,
  buildWorkbookParts,
  buildXlsxBuffer
} = require('../main/services/table-workbook')

const SHEET = 'xl/worksheets/sheet1.xml'

function sheetXml(rows, options) {
  return buildWorkbookParts(rows, options)[SHEET].toString('utf8')
}

function openWorkbook(buffer) {
  const archive = new AdmZip(buffer)
  const names = archive.getEntries().map((entry) => entry.entryName)
  const read = (name) => archive.readAsText(name)
  return { names, read }
}

test('a workbook ships exactly the six parts Excel needs, with one sheet each', () => {
  const parts = buildWorkbookParts([['a']])
  assert.deepEqual(Object.keys(parts).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml'
  ].sort())
  for (const [name, buffer] of Object.entries(parts)) {
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0, `${name} must be a non-empty Buffer`)
    const xml = buffer.toString('utf8')
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/, `${name} must start with the XML declaration`)
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/, `${name} must carry no raw control characters`)
  }
  // Content types must declare both the workbook and the worksheet part.
  const types = parts['[Content_Types].xml'].toString('utf8')
  assert.match(types, /spreadsheetml\.sheet\.main\+xml/)
  assert.match(types, /spreadsheetml\.worksheet\+xml/)
})

test('cells are inline strings, so no sharedStrings part is referenced', () => {
  const xml = sheetXml([['hello', '世界']])
  assert.match(xml, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">hello<\/t><\/is><\/c>/)
  assert.match(xml, /<c r="B1" t="inlineStr"><is><t xml:space="preserve">世界<\/t><\/is><\/c>/)
  assert.doesNotMatch(xml, /sharedStrings/i)
  // xml:space="preserve" is what keeps leading/trailing spaces alive.
  assert.match(sheetXml([[' a ']]), /<t xml:space="preserve"> a <\/t>/)
})

test('the text number format guards values a spreadsheet would coerce', () => {
  // Leading zero and a 16+ digit run must keep their text style; a plain number
  // keeps the default style so it still behaves like a number.
  const xml = sheetXml([['00123', '12345678901234567890', '42']])
  // The cell attributes are emitted as `r`, `t`, then the style index `s`.
  assert.match(xml, new RegExp(`<c r="A1" t="inlineStr" s="${TEXT_STYLE_INDEX}">`))
  assert.match(xml, new RegExp(`<c r="B1" t="inlineStr" s="${TEXT_STYLE_INDEX}">`))
  assert.match(xml, /<c r="C1" t="inlineStr">/)
  assert.doesNotMatch(xml, new RegExp(`<c r="C1"[^>]*s="${TEXT_STYLE_INDEX}"`))
  // numFmtId 49 is the built-in "@" (text) format.
  assert.match(buildWorkbookParts([['a']])['xl/styles.xml'].toString('utf8'), /numFmtId="49"/)
})

test('XML metacharacters are escaped and empty cells are omitted', () => {
  const xml = sheetXml([['a & b <c> "d"'], ['', null, 'tail']])
  assert.match(xml, /a &amp; b &lt;c&gt; "d"/)
  // Quotation marks stay literal in text nodes.
  assert.match(xml, /"d"/)
  // The empty A2/B2 cells produce no <c> element at all.
  const row2 = /<row r="2">([\s\S]*?)<\/row>/.exec(xml)[1]
  assert.equal((row2.match(/<c /g) || []).length, 1, 'only the non-empty cell is emitted')
  assert.match(row2, /r="C2"/)
})

test('control characters become _xHHHH_ escapes and literal escapes are defused', () => {
  const xml = sheetXml([['a\u0007b'], ['_x0041_']])
  assert.match(xml, /a_x0007_b/)
  // A literal `_x0041_` in the source must not be read back as "A".
  assert.match(xml, /_x005F_x0041_/)
  assert.doesNotMatch(xml, /\u0007/)
})

test('merge ranges are emitted for all three accepted shapes', () => {
  const rows = [['a', 'b'], ['c', 'd']]
  for (const merges of [
    [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }],
    [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
    ['A1:B1']
  ]) {
    const xml = sheetXml(rows, { merges })
    assert.match(xml, /<mergeCells count="1"><mergeCell ref="A1:B1"\/><\/mergeCells>/, JSON.stringify(merges))
  }
  // No merges means no mergeCells element at all.
  assert.doesNotMatch(sheetXml(rows), /mergeCells/)
})

test('sheet names are sanitised and capped at the Excel limit', () => {
  assert.match(buildWorkbookParts([['a']], { sheetName: 'Recognition' })['xl/workbook.xml'].toString('utf8'), /name="Recognition"/)
  // Illegal name characters and over-long names fall back / get truncated.
  const illegal = buildWorkbookParts([['a']], { sheetName: 'a/b:c*d' })['xl/workbook.xml'].toString('utf8')
  assert.doesNotMatch(illegal, /name="a\/b:c\*d"/)
  const longName = 'x'.repeat(SHEET_NAME_LIMIT + 20)
  const truncated = buildWorkbookParts([['a']], { sheetName: longName })['xl/workbook.xml'].toString('utf8')
  assert.equal(truncated.includes(`name="${longName}"`), false)
  // An empty name still yields the documented default.
  assert.match(buildWorkbookParts([['a']], { sheetName: '   ' })['xl/workbook.xml'].toString('utf8'), new RegExp(`name="${DEFAULT_SHEET_NAME}"`))
})

test('cell text is capped without splitting a surrogate pair', () => {
  const xml = sheetXml([['x'.repeat(CELL_CHARACTER_LIMIT + 50)]])
  const text = /<t xml:space="preserve">([\s\S]*?)<\/t>/.exec(xml)[1]
  assert.ok(text.length <= CELL_CHARACTER_LIMIT, `cell text ${text.length} must be capped`)
  // An emoji (a surrogate pair) at the cap boundary is never cut in half.
  const emojiXml = sheetXml([[`${'a'.repeat(CELL_CHARACTER_LIMIT - 1)}\u{1F600}`]])
  const emojiText = /<t xml:space="preserve">([\s\S]*?)<\/t>/.exec(emojiXml)[1]
  assert.equal(emojiText.includes('\uFFFD'), false, 'the astral pair must survive or be dropped whole')
  for (let index = 0; index < emojiText.length; index += 1) {
    const code = emojiText.charCodeAt(index)
    const isHigh = code >= 0xd800 && code <= 0xdbff
    const isLow = code >= 0xdc00 && code <= 0xdfff
    if (isHigh) { assert.ok(emojiText.charCodeAt(index + 1) >= 0xdc00 && emojiText.charCodeAt(index + 1) <= 0xdfff, 'high surrogate must be followed by a low surrogate') }
    assert.equal(isLow && !isHigh, false, 'no orphan low surrogate')
  }
})

test('row and column caps are declared and oversized input does not throw', () => {
  assert.equal(ROW_LIMIT, 1048576)
  assert.equal(COLUMN_LIMIT, 16384)
  // A row wider than the column cap keeps only the first COLUMN_LIMIT cells.
  const wide = sheetXml([Array.from({ length: COLUMN_LIMIT + 5 }, (_value, index) => String(index))])
  assert.equal((wide.match(/<c /g) || []).length, COLUMN_LIMIT)
})

test('non-array input is rejected and non-array rows become one-cell rows', () => {
  assert.throws(() => buildWorkbookParts('nope'), /array of rows/)
  assert.match(sheetXml(['solo']), /<c r="A1" t="inlineStr">/)
  // Nullish cells are skipped, keeping the column position of the survivors.
  assert.match(sheetXml([[null, 'b']]), /<c r="B1"/)
})

test('buildXlsxBuffer zips every part DEFLATED and the archive reopens', () => {
  const buffer = buildXlsxBuffer([['name', 'value'], ['a & b', '00123']], { sheetName: 'Recognition' })
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0)
  // Zip magic.
  assert.equal(buffer.subarray(0, 2).toString('hex'), '504b')
  const { names, read } = openWorkbook(buffer)
  assert.deepEqual(names.sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml'
  ].sort())
  // Every entry is stored DEFLATED (method 8) - what Excel expects.
  for (const entry of new AdmZip(buffer).getEntries()) {
    assert.equal(entry.header.method, 8, `${entry.entryName} must be DEFLATED`)
    assert.ok(entry.header.size > 0, `${entry.entryName} must carry data`)
    assert.ok(entry.header.compressedSize > 0, `${entry.entryName} must be compressed`)
  }
  assert.match(read(SHEET), /name/)
  assert.match(read('xl/workbook.xml'), /name="Recognition"/)
})

test('an empty row list still produces a valid single-sheet workbook', () => {
  const parts = buildWorkbookParts([])
  // An empty sheet keeps an empty (but present) sheetData element.
  assert.match(parts[SHEET].toString('utf8'), /<sheetData><\/sheetData>/)
  const buffer = buildXlsxBuffer([])
  assert.equal(openWorkbook(buffer).names.length, 6)
})
