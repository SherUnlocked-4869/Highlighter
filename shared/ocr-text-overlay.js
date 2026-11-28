'use strict'

;(function () {
  function fitOverlayText(element, height, initialSize, vertical) {
    const applySize = (size) => {
      element.style.fontSize = `${size}px`
      const lineHeight = vertical ? Math.max(8, size * 1.08) : Math.min(height, Math.max(8, size * 1.18))
      element.style.lineHeight = `${lineHeight}px`
    }
    let lower = 7
    let upper = Math.max(lower, initialSize)
    for (let attempt = 0; attempt < 8; attempt++) {
      const size = (lower + upper) / 2
      applySize(size)
      if (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1) lower = size
      else upper = size
    }
    applySize(lower)
  }

  function renderBlocks(host, result, { width, height, translated, minConfidence = .3, t }) {
    host.replaceChildren()
    if (!result || !Array.isArray(result.textBlocks) || !width || !height) return 0
    const scaleX = width / Math.max(1, result.imageWidth || 1)
    const scaleY = height / Math.max(1, result.imageHeight || 1)
    let visibleCount = 0
    for (let blockIndex = 0; blockIndex < result.textBlocks.length; blockIndex++) {
      const block = result.textBlocks[blockIndex]
      if (!block?.text || !Array.isArray(block.box_points) || block.box_points.length < 4 ||
          Number(block.text_score) < minConfidence) continue
      const points = block.box_points.map((point) => ({ x: Number(point?.x) * scaleX, y: Number(point?.y) * scaleY }))
      if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue
      const edgeX = points[1].x - points[0].x
      const edgeY = points[1].y - points[0].y
      const blockWidth = Math.hypot(edgeX, edgeY)
      const blockHeight = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y)
      if (blockWidth < 2 || blockHeight < 2) continue
      const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length
      const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length
      const angle = Math.atan2(edgeY, edgeX) * 180 / Math.PI
      const vertical = blockHeight > blockWidth * 1.5
      const element = document.createElement('div')
      element.className = `ocr-text-block${vertical ? ' vertical' : ''}${translated ? ' translation' : ''}`
      element.textContent = block.text
      // P2-04: keep the source array index on the rendered node so the offscreen export can
      // pair its measured layout with the exact block the plan will iterate.
      element.dataset.blockIndex = String(blockIndex)
      element.title = translated && block.sourceText
        ? t('capture.ocr.tooltip-source', { text: block.sourceText })
        : t('capture.ocr.tooltip-confidence', { value: Math.round(Number(block.text_score) * 100) })
      element.style.left = `${centerX - blockWidth / 2}px`
      element.style.top = `${centerY - blockHeight / 2}px`
      element.style.width = `${blockWidth}px`
      element.style.height = `${blockHeight}px`
      element.style.transform = `rotate(${Math.abs(angle) < 3 ? 0 : angle}deg)`
      element.addEventListener('pointerdown', (event) => event.stopPropagation())
      host.appendChild(element)
      const initialSize = Math.max(9, Math.min(36, (vertical ? blockWidth : blockHeight) * .72))
      if (translated) fitOverlayText(element, blockHeight, initialSize, vertical)
      else {
        element.style.fontSize = `${initialSize}px`
        element.style.lineHeight = `${Math.max(10, blockHeight)}px`
      }
      visibleCount++
    }
    return visibleCount
  }

  // -------------------------------------------------------------------------
  // P2-04: read the LIVE overlay layout back out of the rendered DOM.
  //
  // The export layer used to draw every block as one centred fillText, so a vertical-rl
  // OCR block or a wrapped translation changed direction, line count and font size in the
  // exported picture. The rendered overlay is the only source of truth for what the user
  // sees, so instead of re-deriving a layout this measures it once, right before the
  // offscreen compose:
  //   * each block's chip rectangle and rotation come from its layout box;
  //   * per character the browser's own Range boxes give the wrap line (horizontal) or
  //     vertical-rl column and the glyph position inside it;
  //   * characters clipped away by the chip's overflow are dropped, so the export matches
  //     the visible pixels rather than the invisible overflow.
  // Everything is bounded (blocks / glyphs / line text) and nothing in the DOM is changed
  // after the synchronous measurement returns.
  // -------------------------------------------------------------------------
  const MAX_LAYOUT_BLOCKS = 200
  const MAX_LAYOUT_GLYPHS = 4096
  const MAX_LAYOUT_LINES = 512
  const MAX_LAYOUT_TEXT = 512
  const LAYOUT_ANGLE_PATTERN = /rotate\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/

  // The accumulated 2D rotation of the host's ancestors (the pin rotates #rotor by 90/180/
  // 270 degrees; the capture overlay is untransformed). Glyph boxes are measured with the
  // block's own transform disabled, so removing this rotation gives chip-local coordinates.
  function containerRotation(element) {
    let total = 0
    let node = element
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      const transform = typeof getComputedStyle === 'function' ? getComputedStyle(node).transform : ''
      if (transform && transform !== 'none') {
        const matrix = /^matrix\(([^)]+)\)$/.exec(transform)
        if (matrix) {
          const parts = matrix[1].split(',').map(Number)
          if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            total += Math.atan2(parts[1], parts[0]) * 180 / Math.PI
          }
        }
      }
      node = node.parentElement
    }
    return ((Math.round(total) % 360) + 360) % 360
  }

  // Rotate a chip-local offset by -degrees (the measurement frame -> the chip frame).
  function unrotateOffset(x, y, degrees) {
    const normalized = ((degrees % 360) + 360) % 360
    if (normalized === 0) return { x, y }
    if (normalized === 90) return { x: y, y: -x }
    if (normalized === 180) return { x: -x, y: -y }
    if (normalized === 270) return { x: -y, y: x }
    const radians = -normalized * Math.PI / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    return { x: x * cos - y * sin, y: x * sin + y * cos }
  }

  function swapForQuarterTurn(rotation) {
    return rotation === 90 || rotation === 270
  }

  function readBlockAngle(element, computed) {
    const inline = typeof element.style.transform === 'string' ? LAYOUT_ANGLE_PATTERN.exec(element.style.transform) : null
    if (inline) {
      const parsed = Number(inline[1])
      return Number.isFinite(parsed) ? parsed : 0
    }
    const transform = computed && typeof computed.transform === 'string' ? computed.transform : ''
    const matrix = /^matrix\(([^)]+)\)$/.exec(transform)
    if (!matrix) return 0
    const parts = matrix[1].split(',').map(Number)
    if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return 0
    return Math.atan2(parts[1], parts[0]) * 180 / Math.PI
  }

  function firstTextNode(element) {
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) return node
    }
    return null
  }

  function measureElement(element, host, rotation, glyphBudget, angle) {
    const vertical = element.classList.contains('vertical')
    const computed = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null
    const fontSize = computed ? Number.parseFloat(computed.fontSize) : 0
    if (!(fontSize > 0)) return null
    const fontFamily = computed && computed.fontFamily ? computed.fontFamily : 'system-ui, sans-serif'
    const width = element.offsetWidth
    const height = element.offsetHeight
    if (!(width > 0) || !(height > 0)) return null
    let centerX
    let centerY
    if (element.offsetParent === host) {
      centerX = element.offsetLeft + width / 2
      centerY = element.offsetTop + height / 2
    } else {
      const hostBox = host.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      centerX = box.left + box.width / 2 - hostBox.left
      centerY = box.top + box.height / 2 - hostBox.top
    }
    const blockBox = element.getBoundingClientRect()
    const blockCenterX = blockBox.left + blockBox.width / 2
    const blockCenterY = blockBox.top + blockBox.height / 2
    const quarter = swapForQuarterTurn(rotation)
    const textNode = firstTextNode(element)
    const text = textNode ? String(textNode.nodeValue || '') : ''
    const glyphs = []
    const range = typeof document.createRange === 'function' ? document.createRange() : null
    if (range && text) {
      let index = 0
      while (index < text.length && glyphs.length < MAX_LAYOUT_TEXT && glyphs.length < glyphBudget) {
        const code = text.codePointAt(index)
        const size = code > 0xffff ? 2 : 1
        const character = text.slice(index, index + size)
        range.setStart(textNode, index)
        range.setEnd(textNode, index + size)
        const boxes = typeof range.getClientRects === 'function' ? range.getClientRects() : []
        const box = boxes && boxes.length > 0 ? boxes[0] : null
        index += size
        if (!box || !(box.width > 0) || !(box.height > 0)) continue
        const offset = unrotateOffset(
          box.left + box.width / 2 - blockCenterX,
          box.top + box.height / 2 - blockCenterY,
          rotation
        )
        const glyphWidth = quarter ? box.height : box.width
        const glyphHeight = quarter ? box.width : box.height
        // Drop characters the chip's `overflow:hidden` hides: the export paints the visible
        // overlay, not the clipped away overflow.
        if (offset.x + glyphWidth / 2 <= -width / 2 || offset.x - glyphWidth / 2 >= width / 2) continue
        if (offset.y + glyphHeight / 2 <= -height / 2 || offset.y - glyphHeight / 2 >= height / 2) continue
        glyphs.push({ text: character, x: offset.x, y: offset.y, width: glyphWidth, height: glyphHeight })
      }
    }
    if (glyphs.length === 0) {
      return { layout: { blockIndex: 0, width, height, centerX, centerY, angle, vertical, fontSize, fontFamily, lines: [] }, glyphCount: 0 }
    }
    // Group consecutive glyphs into the browser's line boxes: horizontal text groups by y,
    // vertical-rl text by x (each group is one column, right to left in DOM order).
    const tolerance = Math.max(1, fontSize * 0.45)
    const lines = []
    let current = null
    for (const glyph of glyphs) {
      const axis = vertical ? glyph.x : glyph.y
      if (!current || Math.abs(axis - current.axis) > tolerance) {
        current = { axis, glyphs: [] }
        lines.push(current)
      }
      current.glyphs.push(glyph)
      if (lines.length > MAX_LAYOUT_LINES) break
    }
    const layoutLines = []
    for (const line of lines) {
      const count = line.glyphs.length
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const glyph of line.glyphs) {
        minX = Math.min(minX, glyph.x - glyph.width / 2)
        maxX = Math.max(maxX, glyph.x + glyph.width / 2)
        minY = Math.min(minY, glyph.y - glyph.height / 2)
        maxY = Math.max(maxY, glyph.y + glyph.height / 2)
      }
      if (count === 0 || !(maxX > minX) || !(maxY > minY)) continue
      layoutLines.push({
        text: line.glyphs.map((glyph) => glyph.text).join('').slice(0, MAX_LAYOUT_TEXT),
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        width: maxX - minX,
        height: maxY - minY,
        glyphs: line.glyphs
      })
    }
    return {
      layout: {
        blockIndex: Number.isInteger(Number(element.dataset.blockIndex)) ? Number(element.dataset.blockIndex) : 0,
        width,
        height,
        centerX,
        centerY,
        angle,
        vertical,
        fontSize,
        fontFamily,
        lines: layoutLines
      },
      glyphCount: glyphs.length
    }
  }

  // Measures every rendered block of `host` (the #pinOcrOverlay / .ocr-overlay element) and
  // returns a bounded serialisable layout array. Callers fall back to the deterministic
  // painter when this returns an empty array.
  function measureLayout(host) {
    if (!host || !host.children) return []
    const rotation = containerRotation(host)
    const elements = []
    for (let index = 0; index < host.children.length && index < MAX_LAYOUT_BLOCKS; index += 1) {
      elements.push(host.children[index])
    }
    // Measure without the per-block CSS rotation; restoring happens before the browser can
    // paint again (synchronous task), so the visible overlay never flickers.
    const saved = elements.map((element) => ({
      element,
      transform: element.style.transform,
      // The inline transform is about to be cleared for measurement: read the chip's own
      // rotation first so the painter knows the angle the DOM rendered it at.
      angle: readBlockAngle(element, typeof getComputedStyle === 'function' ? getComputedStyle(element) : null)
    }))
    const layouts = []
    try {
      for (const entry of saved) entry.element.style.transform = 'none'
      let glyphBudget = MAX_LAYOUT_GLYPHS
      for (const entry of saved) {
        if (glyphBudget <= 0) break
        const measured = measureElement(entry.element, host, rotation, glyphBudget, entry.angle)
        if (!measured) continue
        const index = Number(entry.element.dataset.blockIndex)
        measured.layout.blockIndex = Number.isInteger(index) && index >= 0
          ? index
          : layouts.length
        glyphBudget -= measured.glyphCount
        layouts.push(measured.layout)
      }
    } finally {
      for (const entry of saved) entry.element.style.transform = entry.transform
    }
    return layouts
  }

  window.OcrTextOverlay = { renderBlocks, measureLayout, MAX_LAYOUT_GLYPHS, MAX_LAYOUT_BLOCKS }
})()
