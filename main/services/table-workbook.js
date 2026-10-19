'use strict'

// Table-recognition → Excel workbook writer (analysis plan §6.2①).
//
// Hand-written SpreadsheetML zipped by adm-zip (already a production dependency:
// main/services/diagnostics-service.js). No exceljs/sheetjs on purpose: the whole
// surface we need is a handful of static XML parts, so a spreadsheet library would
// add bundle size and supply-chain risk without adding capability.
//
// The workbook stores every cell as an inline string (`t="inlineStr"`, never
// sharedStrings), which keeps the parts independent and lets one sheet be built in
// a single pass. Cells that a spreadsheet would silently coerce — values with
// leading zeros and digit runs beyond Excel's 15-digit precision — additionally
// carry the built-in text number format (numFmtId="49") so they keep displaying
// as typed instead of turning into 1.10E+12.
//
// Everything here is pure Node 18+/Electron 43 compatible: no Electron import, so
// the module is unit-testable and safe to require from the pure smoke script.

const AdmZip = require('adm-zip')

const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const DOCUMENT_RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

// OOXML hard limits: one worksheet can hold at most 1,048,576 rows × 16,384
// columns and one string cell at most 32,767 characters.
const ROW_LIMIT = 1048576
const COLUMN_LIMIT = 16384
const CELL_CHARACTER_LIMIT = 32767
// Excel rejects sheet names longer than 31 characters.
const SHEET_NAME_LIMIT = 31
const DEFAULT_SHEET_NAME = 'Sheet1'

// Index into xl/styles.xml cellXfs: 0 = default "General", 1 = built-in text format.
const DEFAULT_STYLE_INDEX = 0
const TEXT_STYLE_INDEX = 1

// Characters XML 1.0 forbids even after entity escaping; SpreadsheetML encodes
// them as `_xHHHH_` escape sequences instead (Snow's tableWorkbook does the same).
const INVALID_XML_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g
// A literal `_xHHHH_` in the source text must not be mistaken for an escape
// sequence by a reader, so its leading underscore is itself escaped.
const LITERAL_ESCAPE_SEQUENCE = /_x[0-9A-Fa-f]{4}_/g
const LEADING_ZERO_NUMBER = /^0\d+$/
const LONG_DIGIT_RUN = /^\d{16,}$/
const INVALID_SHEET_NAME_CHARACTER = /[\\/?*[\]:]/g

function columnName(columnIndex) {
  let name = ''
  let value = columnIndex + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function cellReference(rowIndex, columnIndex) {
  return `${columnName(columnIndex)}${rowIndex + 1}`
}

// Escapes the five XML text characters. Apostrophes and quotes stay literal in
// text nodes; attributes go through escapeXmlAttribute instead.
function escapeXmlText(value) {
  return String(value).replace(/[&<>]/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    return '&gt;'
  })
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Caps the cell at the Excel character limit without splitting a surrogate pair.
// The limit is measured in UTF-16 code units (what the reader enforces), so an
// astral character costs two. Lone surrogates cannot be encoded in XML, so they
// become U+FFFD.
function limitCellCharacters(text) {
  const output = []
  let units = 0
  for (const character of text) {
    const code = character.codePointAt(0)
    const width = character.length
    if (units + width > CELL_CHARACTER_LIMIT) break
    output.push(code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : character)
    units += width
  }
  return output.join('')
}

// Turns control characters into SpreadsheetML `_xHHHH_` escapes. Order matters:
// literal escape-looking text is neutralised first, then real control characters
// are encoded, so the sequences we emit are never re-escaped.
//
// A literal `_x0041_` is written as `_x005F_x0041_`: `_x005F_` decodes to the
// leading underscore and the remainder is left as plain text, which is exactly
// how Excel itself escapes the two-character prefix (MS-OI29500 §2.1.2).
function encodeControlCharacters(text) {
  return text
    .replace(LITERAL_ESCAPE_SEQUENCE, (match) => `_x005F_${match.slice(1)}`)
    .replace(INVALID_XML_CHARACTER, (character) => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
}

function prepareCellText(value) {
  return escapeXmlText(encodeControlCharacters(limitCellCharacters(String(value ?? ''))))
}

// Spreadsheets coerce digit-like strings on open/paste. Writing them as inline
// strings already preserves the text, and the text number format keeps a copy of
// the cell from being reinterpreted as a number later.
function prefersTextFormat(value) {
  const text = String(value ?? '').trim()
  return LEADING_ZERO_NUMBER.test(text) || LONG_DIGIT_RUN.test(text)
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('A table workbook requires an array of rows')
  return rows.slice(0, ROW_LIMIT).map((row) => {
    const cells = Array.isArray(row) ? row : [row]
    return cells.slice(0, COLUMN_LIMIT)
  })
}

function normalizeSheetName(value) {
  const name = String(value ?? '')
    .replace(INVALID_SHEET_NAME_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
  if (!name) return DEFAULT_SHEET_NAME
  return name.slice(0, SHEET_NAME_LIMIT).trim() || DEFAULT_SHEET_NAME
}

function parseColumnName(value) {
  const text = String(value || '').toUpperCase()
  if (!/^[A-Z]{1,3}$/.test(text)) return -1
  let index = 0
  for (const character of text) index = index * 26 + (character.charCodeAt(0) - 64)
  return index - 1
}

function isValidRange(range) {
  const { startRow, startColumn, endRow, endColumn } = range
  return Number.isInteger(startRow) && Number.isInteger(startColumn) &&
    Number.isInteger(endRow) && Number.isInteger(endColumn) &&
    startRow >= 0 && startColumn >= 0 &&
    endRow >= startRow && endColumn >= startColumn &&
    endRow < ROW_LIMIT && endColumn < COLUMN_LIMIT
}

// Accepts either a 0-based `{ startRow, startColumn, endRow, endColumn }` object,
// a `{ s: { r, c }, e: { r, c } }` object, or an A1 range string ('A1:B2').
function normalizeMerge(entry) {
  if (typeof entry === 'string') {
    const match = /^([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})(\d+)$/.exec(entry.trim())
    if (!match) return null
    return {
      startRow: Number(match[2]) - 1,
      startColumn: parseColumnName(match[1]),
      endRow: Number(match[4]) - 1,
      endColumn: parseColumnName(match[3])
    }
  }
  if (!entry || typeof entry !== 'object') return null
  if (entry.s && entry.e) {
    return {
      startRow: Number(entry.s.r),
      startColumn: Number(entry.s.c),
      endRow: Number(entry.e.r),
      endColumn: Number(entry.e.c)
    }
  }
  return {
    startRow: Number(entry.startRow),
    startColumn: Number(entry.startColumn),
    endRow: Number(entry.endRow),
    endColumn: Number(entry.endColumn)
  }
}

function normalizeMerges(merges) {
  if (!Array.isArray(merges)) return []
  const output = []
  const seen = new Set()
  for (const entry of merges) {
    const range = normalizeMerge(entry)
    // A one-cell "merge" is not a merge; Excel drops those silently rather than
    // reporting them, so the writer filters them out too.
    if (!range || !isValidRange(range)) continue
    if (range.startRow === range.endRow && range.startColumn === range.endColumn) continue
    const reference = `${cellReference(range.startRow, range.startColumn)}:${cellReference(range.endRow, range.endColumn)}`
    if (seen.has(reference)) continue
    seen.add(reference)
    output.push({ ...range, reference })
  }
  return output
}

function buildSheetData(normalizedRows) {
  const rows = []
  let maxRow = 0
  let maxColumn = 0
  normalizedRows.forEach((cells, rowIndex) => {
    const rendered = []
    cells.forEach((value, columnIndex) => {
      const text = prepareCellText(value)
      if (!text) return
      const reference = cellReference(rowIndex, columnIndex)
      const style = prefersTextFormat(value) ? ` s="${TEXT_STYLE_INDEX}"` : ''
      rendered.push(`<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`)
      if (rowIndex + 1 > maxRow) maxRow = rowIndex + 1
      if (columnIndex + 1 > maxColumn) maxColumn = columnIndex + 1
    })
    if (rendered.length) rows.push(`<row r="${rowIndex + 1}">${rendered.join('')}</row>`)
  })
  return { rows, maxRow, maxColumn }
}

function buildDimension(maxRow, maxColumn, merges) {
  let row = maxRow
  let column = maxColumn
  for (const merge of merges) {
    if (merge.endRow + 1 > row) row = merge.endRow + 1
    if (merge.endColumn + 1 > column) column = merge.endColumn + 1
  }
  return row > 0 && column > 0 ? `A1:${cellReference(row - 1, column - 1)}` : 'A1'
}

function buildWorksheetXml(rows, options = {}) {
  const normalizedRows = normalizeRows(rows)
  const merges = normalizeMerges(options.merges)
  const sheet = buildSheetData(normalizedRows)
  const dimension = buildDimension(sheet.maxRow, sheet.maxColumn, merges)
  const mergeCells = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((merge) => `<mergeCell ref="${merge.reference}"/>`).join('')}</mergeCells>`
    : ''
  return [
    XML_HEADER,
    `<worksheet xmlns="${SPREADSHEET_NAMESPACE}">`,
    `<dimension ref="${dimension}"/>`,
    `<sheetData>${sheet.rows.join('')}</sheetData>`,
    mergeCells,
    '</worksheet>'
  ].filter(Boolean).join('\n')
}

function buildContentTypesXml() {
  return [
    XML_HEADER,
    `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '</Types>'
  ].join('\n')
}

function buildRootRelationshipsXml() {
  return [
    XML_HEADER,
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`,
    `<Relationship Id="rId1" Type="${DOCUMENT_RELATIONSHIP_NAMESPACE}/officeDocument" Target="xl/workbook.xml"/>`,
    '</Relationships>'
  ].join('\n')
}

function buildWorkbookXml(sheetName) {
  const name = escapeXmlAttribute(normalizeSheetName(sheetName))
  return [
    XML_HEADER,
    `<workbook xmlns="${SPREADSHEET_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIP_NAMESPACE}">`,
    `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>`,
    '</workbook>'
  ].join('\n')
}

function buildWorkbookRelationshipsXml() {
  return [
    XML_HEADER,
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`,
    `<Relationship Id="rId1" Type="${DOCUMENT_RELATIONSHIP_NAMESPACE}/worksheet" Target="worksheets/sheet1.xml"/>`,
    `<Relationship Id="rId2" Type="${DOCUMENT_RELATIONSHIP_NAMESPACE}/styles" Target="styles.xml"/>`,
    '</Relationships>'
  ].join('\n')
}

function buildStylesXml() {
  // Two cell formats: "General" (index 0) and built-in text (numFmtId 49,
  // index 1). The rgb colour avoids a dependency on a theme part.
  return [
    XML_HEADER,
    `<styleSheet xmlns="${SPREADSHEET_NAMESPACE}">`,
    '<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>'
  ].join('\n')
}

/**
 * Build the six OOXML parts of a single-sheet workbook.
 *
 * @param {Array<Array<unknown>|unknown>} rows row-major cell values; non-array
 *   rows are treated as one-cell rows. Nullish/empty cells are omitted.
 * @param {{ sheetName?: string, merges?: Array<object|string> }} [options]
 *   `merges` accepts 0-based `{ startRow, startColumn, endRow, endColumn }`,
 *   `{ s: { r, c }, e: { r, c } }` or A1 strings ('A1:B2').
 * @returns {Record<string, Buffer>} part name → UTF-8 Buffer
 */
function buildWorkbookParts(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('A table workbook requires an array of rows')
  const { sheetName, merges } = options || {}
  return {
    '[Content_Types].xml': Buffer.from(buildContentTypesXml(), 'utf8'),
    '_rels/.rels': Buffer.from(buildRootRelationshipsXml(), 'utf8'),
    'xl/workbook.xml': Buffer.from(buildWorkbookXml(sheetName), 'utf8'),
    'xl/_rels/workbook.xml.rels': Buffer.from(buildWorkbookRelationshipsXml(), 'utf8'),
    'xl/styles.xml': Buffer.from(buildStylesXml(), 'utf8'),
    'xl/worksheets/sheet1.xml': Buffer.from(buildWorksheetXml(rows, { merges }), 'utf8')
  }
}

/**
 * Convenience wrapper: build the parts and zip them into a .xlsx Buffer.
 * adm-zip stores every non-empty part DEFLATED (see its ZipEntry.setData), which
 * is what Excel/WPS/LibreOffice expect for a normal workbook.
 *
 * @param {Array<Array<unknown>|unknown>} rows
 * @param {{ sheetName?: string, merges?: Array<object|string> }} [options]
 * @returns {Buffer}
 */
function buildXlsxBuffer(rows, options = {}) {
  const parts = buildWorkbookParts(rows, options)
  const archive = new AdmZip()
  for (const [name, data] of Object.entries(parts)) archive.addFile(name, data)
  return archive.toBuffer()
}

module.exports = {
  CELL_CHARACTER_LIMIT,
  COLUMN_LIMIT,
  DEFAULT_SHEET_NAME,
  DEFAULT_STYLE_INDEX,
  ROW_LIMIT,
  SHEET_NAME_LIMIT,
  TEXT_STYLE_INDEX,
  buildWorkbookParts,
  buildXlsxBuffer
}
