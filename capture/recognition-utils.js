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

  function inferColumnCount(rows) {
    const counts = rows.map((row) => row.blocks.length).filter((count) => count >= 2)
    if (!counts.length) return 1
    const frequencies = new Map()
    counts.forEach((count) => frequencies.set(count, (frequencies.get(count) || 0) + 1))
    return [...frequencies.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
  }

  function inferColumnAnchors(rows, columnCount) {
    let referenceRows = rows.filter((row) => row.blocks.length === columnCount)
    if (!referenceRows.length) {
      const nearestCount = Math.min(...rows.map((row) => Math.abs(row.blocks.length - columnCount)))
      referenceRows = rows.filter((row) => Math.abs(row.blocks.length - columnCount) === nearestCount)
    }
    const anchors = []
    for (let column = 0; column < columnCount; column++) {
      anchors.push(median(referenceRows.map((row) => row.blocks[column]?.centerX).filter(Number.isFinite)))
    }
    return anchors.sort((a, b) => a - b)
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
    const columnCount = inferColumnCount(groupedRows)
    if (groupedRows.length < 2 || columnCount < 2) return null

    const anchors = inferColumnAnchors(groupedRows, columnCount)
    const rows = groupedRows.map((row) => {
      const cells = Array.from({ length: columnCount }, () => [])
      for (const block of row.blocks) {
        let column = 0
        let distance = Infinity
        anchors.forEach((anchor, index) => {
          const nextDistance = Math.abs(block.centerX - anchor)
          if (nextDistance < distance) {
            distance = nextDistance
            column = index
          }
        })
        cells[column].push(block)
      }
      return cells.map((cellBlocks) => cellBlocks
        .sort((a, b) => a.left - b.left)
        .map((block) => block.text)
        .join(' '))
    })
    const formats = serializeTable(rows)
    return {
      rows,
      rowCount: rows.length,
      columnCount,
      anchors,
      ...formats
    }
  }

  return { buildTableFromOcr, serializeTable }
})
