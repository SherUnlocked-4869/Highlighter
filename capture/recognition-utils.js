(function exposeRecognitionUtils(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.HighlighterRecognition = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function median(values) {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }

  function normalizeBlock(block, minConfidence) {
    const text = String(block?.text || '').trim()
    const score = Number(block?.text_score ?? block?.textScore ?? 0)
    const points = block?.box_points || block?.boxPoints
    if (!text || !Array.isArray(points) || points.length < 4 || score < minConfidence) return null
    const xs = points.map((point) => Number(point.x)).filter(Number.isFinite)
    const ys = points.map((point) => Number(point.y)).filter(Number.isFinite)
    if (xs.length < 4 || ys.length < 4) return null
    const left = Math.min(...xs)
    const right = Math.max(...xs)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    if (right <= left || bottom <= top) return null
    return {
      text,
      score,
      left,
      right,
      top,
      bottom,
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
      width: right - left,
      height: bottom - top
    }
  }

  function groupRows(blocks) {
    const rows = []
    for (const block of [...blocks].sort((a, b) => a.centerY - b.centerY || a.left - b.left)) {
      let bestRow = null
      let bestScore = -Infinity
      for (const row of rows) {
        const overlap = Math.max(0, Math.min(block.bottom, row.bottom) - Math.max(block.top, row.top))
        const overlapRatio = overlap / Math.max(1, Math.min(block.height, row.height))
        const centerDistance = Math.abs(block.centerY - row.centerY)
        const closeEnough = centerDistance <= Math.max(block.height, row.height) * 0.55
        if (overlapRatio < 0.3 && !closeEnough) continue
        const score = overlapRatio - centerDistance / Math.max(1, block.height + row.height)
        if (score > bestScore) {
          bestScore = score
          bestRow = row
        }
      }
      if (!bestRow) {
        rows.push({ blocks: [block], top: block.top, bottom: block.bottom, centerY: block.centerY, height: block.height })
        continue
      }
      bestRow.blocks.push(block)
      bestRow.top = Math.min(bestRow.top, block.top)
      bestRow.bottom = Math.max(bestRow.bottom, block.bottom)
      bestRow.height = bestRow.bottom - bestRow.top
      bestRow.centerY = median(bestRow.blocks.map((item) => item.centerY))
    }
    return rows
      .sort((a, b) => a.centerY - b.centerY)
      .map((row) => ({ ...row, blocks: row.blocks.sort((a, b) => a.left - b.left) }))
  }

  // ---------- Column inference (U04, review report section 4.4 item 6) ----------
  //
  // The previous implementation guessed the column count from the mode of the
  // per-row cell counts and derived each anchor from the median center of
  // `row.blocks[index]`. That has two failure modes the review report names: a
  // sparse table (rows with 1-3 cells, columns missing on some rows) is
  // under-counted (the mode only sees one row with two or more cells), and one
  // row with a different leading cell count shifts every anchor after it,
  // because anchors are built by array index instead of by x position.
  //
  // Projecting every cell's x interval onto the x axis recovers the column bands
  // from the cells themselves:
  //   - two intervals share a band when they overlap by at least half of the
  //     smaller one (a jittered cell in the same column does, neighbouring
  //     columns do not),
  //   - a band stores the intersection of its members as its core, so one wide
  //     header cell can join a band but cannot chain two neighbouring columns
  //     into one,
  //   - a cell that substantially covers more than one band is a merged cell and
  //     is reported through `merges` instead of creating a band of its own.
  const COLUMN_OVERLAP_RATIO = 0.5

  function bandOverlap(interval, band) {
    return Math.min(band.coreRight, interval.right) - Math.max(band.coreLeft, interval.left)
  }

  function buildColumnBands(blocks) {
    const intervals = blocks
      .map((block) => ({ block, left: block.left, right: block.right }))
      // Narrow first on an equal left edge: a full-width header must not claim a
      // brand-new band before the narrow cells that define the real columns have
      // joined the band they belong to.
      .sort((left, right) => left.left - right.left || (left.right - left.left) - (right.right - right.left))
    const bands = []
    for (const interval of intervals) {
      const width = interval.right - interval.left
      let bestBand = null
      let bestRatio = 0
      for (const band of bands) {
        const overlap = bandOverlap(interval, band)
        if (overlap <= 0) continue
        const smaller = Math.min(width, band.coreRight - band.coreLeft)
        if (smaller <= 0) continue
        const ratio = overlap / smaller
        if (ratio >= COLUMN_OVERLAP_RATIO && ratio > bestRatio) {
          bestBand = band
          bestRatio = ratio
        }
      }
      if (!bestBand) {
        bands.push({
          coreLeft: interval.left,
          coreRight: interval.right,
          left: interval.left,
          right: interval.right,
          blocks: [interval.block]
        })
        continue
      }
      bestBand.blocks.push(interval.block)
      bestBand.left = Math.min(bestBand.left, interval.left)
      bestBand.right = Math.max(bestBand.right, interval.right)
      bestBand.coreLeft = Math.max(bestBand.coreLeft, interval.left)
      bestBand.coreRight = Math.min(bestBand.coreRight, interval.right)
    }
    return bands.sort((left, right) => left.coreLeft - right.coreLeft || left.coreRight - right.coreRight)
  }

  function bandAnchor(band) {
    return (band.coreLeft + band.coreRight) / 2
  }

  // Assigns a cell to the band it overlaps the most. A cell that misses every
  // band core (OCR jitter exactly between two columns) falls back to the nearest
  // anchor so it still renders instead of being dropped.
  function bandIndexFor(block, bands) {
    let index = -1
    let bestOverlap = 0
    bands.forEach((band, candidate) => {
      const overlap = bandOverlap(block, band)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        index = candidate
      }
    })
    if (index >= 0) return index
    let nearest = 0
    let distance = Infinity
    bands.forEach((band, candidate) => {
      const next = Math.abs(block.centerX - bandAnchor(band))
      if (next < distance) {
        distance = next
        nearest = candidate
      }
    })
    return nearest
  }

  // Inclusive column range covered by one cell.
  //
  // Every cell of a band contains that band's final core (the core is the
  // intersection of all its members), so a cell that also overlaps another band's
  // core by at least half of it really does span that column: that is a merged
  // cell. `first` is the leftmost covered band — a merged cell's text belongs in
  // the first column it covers — and the range becomes `mergeCells` in the
  // workbook writer.
  function spanBands(block, bands) {
    const covered = []
    bands.forEach((band, index) => {
      const overlap = bandOverlap(block, band)
      if (overlap <= 0) return
      const bandWidth = Math.max(1, band.coreRight - band.coreLeft)
      if (overlap / bandWidth >= COLUMN_OVERLAP_RATIO) covered.push(index)
    })
    if (covered.length) return { first: covered[0], last: covered[covered.length - 1] }
    // OCR jitter left the cell between two cores: keep it in the nearest column
    // instead of dropping it (or widening the table with a phantom column).
    const nearest = bandIndexFor(block, bands)
    return { first: nearest, last: nearest }
  }

  function rangesOverlap(left, right, range) {
    return left <= range.endColumn && right >= range.startColumn
  }

  function csvCell(value) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ')
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  function markdownCell(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  }

  function serializeTable(rows) {
    const tsv = rows.map((row) => row.map((cell) => String(cell ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
    const markdown = rows.length
      ? [
          `| ${rows[0].map(markdownCell).join(' | ')} |`,
          `| ${rows[0].map(() => '---').join(' | ')} |`,
          ...rows.slice(1).map((row) => `| ${row.map(markdownCell).join(' | ')} |`)
        ].join('\n')
      : ''
    return { tsv, csv, markdown }
  }

  function buildTableFromOcr(result, options = {}) {
    const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.3
    const blocks = (result?.textBlocks || result?.text_blocks || [])
      .map((block) => normalizeBlock(block, minConfidence))
      .filter(Boolean)
    const groupedRows = groupRows(blocks)
    if (groupedRows.length < 2) return null
    const bands = buildColumnBands(blocks)
    const columnCount = bands.length
    if (columnCount < 2) return null

    const anchors = bands.map(bandAnchor)
    // `merges` uses the 0-based `{ s: { r, c }, e: { r, c } }` shape that
    // main/services/table-workbook.js already writes as SpreadsheetML
    // `mergeCells`; the recognition renderer forwards `tableModel.merges` to
    // `recognition:export-excel`.
    const merges = []
    const rows = groupedRows.map((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, () => [])
      const spans = []
      for (const block of row.blocks) {
        const { first, last } = spanBands(block, bands)
        cells[first].push(block)
        if (last > first) spans.push({ startColumn: first, endColumn: last })
      }
      // Widest span first: if two spans in one row somehow overlap, the wider one
      // wins so the emitted mergeCells never overlap (Excel/WPS reject those).
      spans.sort((left, right) => left.startColumn - right.startColumn || right.endColumn - left.endColumn)
      const accepted = []
      for (const span of spans) {
        // A normal cell already claims the span's first column in this row, so the
        // row cannot be merged without losing that cell's own position.
        if (cells[span.startColumn].length > 1) continue
        if (accepted.some((range) => rangesOverlap(span.startColumn, span.endColumn, range))) continue
        accepted.push(span)
        merges.push({ s: { r: rowIndex, c: span.startColumn }, e: { r: rowIndex, c: span.endColumn } })
      }
      return cells.map((cellBlocks) => cellBlocks
        .sort((left, right) => left.left - right.left)
        .map((block) => block.text)
        .join(' '))
    })
    const formats = serializeTable(rows)
    return {
      rows,
      rowCount: rows.length,
      columnCount,
      anchors,
      // The core of each projected band: the stable x range every cell of that
      // column shares. Exposed so callers/tests can verify the anchor placement
      // against the cells instead of guessing from centers.
      columnBounds: bands.map((band) => ({ left: band.coreLeft, right: band.coreRight })),
      merges,
      ...formats
    }
  }

  return { buildTableFromOcr, serializeTable }
})
