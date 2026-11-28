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
  //   * per GRAPHEME CLUSTER (P2-06) the browser's own Range boxes give the wrap line
  //     (horizontal) or vertical-rl column and the glyph position inside it;
  //   * clusters clipped away by the chip's overflow are dropped, so the export matches
  //     the visible pixels rather than the invisible overflow.
  // Everything is bounded (blocks / ATTEMPTED measurements / line text) and nothing in the
  // DOM is changed after the synchronous measurement returns.
  // -------------------------------------------------------------------------
  const MAX_LAYOUT_BLOCKS = 200
  // P2-07: the measurement budgets count ATTEMPTED grapheme measurements (one
  // Range.getClientRects per attempt), not retained glyphs. A narrow chip clips almost
  // every glyph away, so charging only the retained glyphs let one 3000-character block
  // issue 3000 synchronous layout reads.
  //   MAX_LAYOUT_TEXT   - per-block attempt cap
  //   MAX_LAYOUT_GLYPHS - global attempt cap across the whole overlay
  const MAX_LAYOUT_GLYPHS = 4096
  const MAX_LAYOUT_LINES = 512
  const MAX_LAYOUT_TEXT = 512
  // P2-06: cap one grapheme cluster's UTF-16 length so a pathological combining/ZWJ run
  // cannot serialise an unbounded glyph text. Normal ZWJ emoji are at most 15 units, so a
  // real cluster is never split; longer runs are chunked at a code-point boundary.
  const MAX_GRAPHEME_UNITS = 32
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

  // ---------------------------------------------------------------------------
  // P2-02 (re-review): vertical glyph orientation.
  //
  // A vertical-rl block renders with the CSS default `text-orientation: mixed` (pin.css): characters
  // from vertical scripts stay UPRIGHT, characters from horizontal-only scripts are laid out SIDEWAYS
  // (rotated 90° clockwise) as one shaped run in reading order. The measured layout knows every
  // grapheme's centre and box, but the old painter drew every grapheme upright, so a Latin letter in
  // a vertical translation exported 90° from the screen (the re-review's single `I`: screen ink
  // 21.6x2.4 CSS px, PNG 2.4x21.6). The painter now rotates exactly the graphemes the browser sets
  // sideways, keeping the browser's column order and measured centres; upright scripts (CJK, kana,
  // Hangul, emoji, ...) keep the old per-cluster fillText.
  //
  // The decision is the Unicode Vertical_Orientation property (UAX #50), whose DEFAULT is Rotated:
  // the table below lists the property's upright ranges (Unicode 18.0.0 VerticalOrientation.txt,
  // characters assigned `U` or `Tu`; `Tu` is a transformed-upright glyph, painted upright at the
  // position the browser measured). `Tr` (transformed rotated) stays rotated, the closest the canvas
  // painter can reproduce. A character outside every range is rotated, matching the default.
  // This is a Unicode property, not a font property, so the same code point classifies identically
  // for every installed font and every DPR.
  // ---------------------------------------------------------------------------
  const VERTICAL_UPRIGHT_RANGES = [
    0xA7, 0xA7, 0xA9, 0xA9, 0xAE, 0xAE, 0xB1, 0xB1,
    0xBC, 0xBE, 0xD7, 0xD7, 0xF7, 0xF7, 0x2EA, 0x2EB,
    0x1100, 0x11FF, 0x1401, 0x167F, 0x18B0, 0x18FF, 0x2016, 0x2016,
    0x2020, 0x2021, 0x2030, 0x2031, 0x203B, 0x203C, 0x2042, 0x2042,
    0x2047, 0x2049, 0x2051, 0x2051, 0x2065, 0x2065, 0x20DD, 0x20E0,
    0x20E2, 0x20E4, 0x2100, 0x2101, 0x2103, 0x2109, 0x210F, 0x210F,
    0x2113, 0x2114, 0x2116, 0x2117, 0x211E, 0x2123, 0x2125, 0x2125,
    0x2127, 0x2127, 0x2129, 0x2129, 0x212E, 0x212E, 0x2135, 0x213F,
    0x2145, 0x214A, 0x214C, 0x214D, 0x214F, 0x2189, 0x218C, 0x218F,
    0x221E, 0x221E, 0x2234, 0x2235, 0x2300, 0x2307, 0x230C, 0x231F,
    0x2324, 0x2328, 0x232B, 0x232B, 0x237D, 0x239A, 0x23BE, 0x23CD,
    0x23CF, 0x23CF, 0x23D1, 0x23DB, 0x23E2, 0x2422, 0x2424, 0x24FF,
    0x25A0, 0x2619, 0x2620, 0x2767, 0x2776, 0x2793, 0x2B12, 0x2B2F,
    0x2B50, 0x2B59, 0x2B97, 0x2B97, 0x2BB8, 0x2BD1, 0x2BD3, 0x2BEB,
    0x2BF0, 0x2BFF, 0x2E50, 0x2E51, 0x2E80, 0x3007, 0x3012, 0x3013,
    0x3020, 0x302F, 0x3031, 0x309F, 0x30A1, 0x30FB, 0x30FD, 0xA4CF,
    0xA960, 0xA97F, 0xAC00, 0xD7FF, 0xE000, 0xFAFF, 0xFE10, 0xFE1F,
    0xFE30, 0xFE48, 0xFE50, 0xFE57, 0xFE5F, 0xFE62, 0xFE67, 0xFE6F,
    0xFF01, 0xFF07, 0xFF0A, 0xFF0C, 0xFF0E, 0xFF19, 0xFF1F, 0xFF3A,
    0xFF3C, 0xFF3C, 0xFF3E, 0xFF3E, 0xFF40, 0xFF5A, 0xFFE0, 0xFFE2,
    0xFFE4, 0xFFE7, 0xFFF0, 0xFFF8, 0xFFFC, 0xFFFD, 0x10980, 0x1099F,
    0x11580, 0x115FF, 0x11A00, 0x11ABF, 0x13000, 0x1467F, 0x16FE0, 0x191DF,
    0x1AFF0, 0x1B2FF, 0x1CEC0, 0x1CEDC, 0x1CEE0, 0x1CEF0, 0x1CEFE, 0x1CFCF,
    0x1D000, 0x1D1FF, 0x1D250, 0x1D281, 0x1D2E0, 0x1D37F, 0x1D800, 0x1DAAF,
    0x1F000, 0x1F7FF, 0x1F900, 0x1FAFF, 0x20000, 0x2FFFD, 0x30000, 0x3FFFD,
    0xF0000, 0xFFFFD, 0x100000, 0x10FFFD
  ]

  // @return true when the code point is Vertical_Orientation=Upright (U or Tu).
  function verticalUpright(codePoint) {
    let low = 0
    let high = (VERTICAL_UPRIGHT_RANGES.length / 2) - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const start = VERTICAL_UPRIGHT_RANGES[middle * 2]
      const end = VERTICAL_UPRIGHT_RANGES[middle * 2 + 1]
      if (codePoint < start) high = middle - 1
      else if (codePoint > end) low = middle + 1
      else return true
    }
    return false
  }

  // @return true when the browser sets this grapheme sideways in a vertical-rl `mixed` block, i.e.
  // the measured painter must rotate the upright glyph 90° clockwise around its measured centre.
  // The cluster's first code point decides (a grapheme cluster is base + combining marks / ZWJ
  // sequences; the base carries the orientation of the whole cluster).
  function verticalTextIsSideways(text) {
    const value = String(text || '')
    if (!value) return false
    const first = value.codePointAt(0)
    return !verticalUpright(first)
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

  // P2-06: iterate GRAPHEME CLUSTERS, not code points. Intl.Segmenter does the real
  // UAX #29 work; the bounded fallback keeps combining marks, variation selectors, emoji
  // modifiers and ZWJ sequences attached to their base when the platform has no segmenter.
  let cachedGraphemeSegmenter
  function createGraphemeSegmenter() {
    if (cachedGraphemeSegmenter !== undefined) return cachedGraphemeSegmenter
    cachedGraphemeSegmenter = null
    try {
      if (typeof Intl === 'object' && Intl && typeof Intl.Segmenter === 'function') {
        cachedGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      }
    } catch (_error) {
      cachedGraphemeSegmenter = null
    }
    return cachedGraphemeSegmenter
  }

  function isClusterExtension(code) {
    return (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xe0100 && code <= 0xe01ef) ||
      (code >= 0x1f3fb && code <= 0x1f3ff) ||
      (code >= 0xe0020 && code <= 0xe007f) ||
      code === 0x20e3
  }

  // Bounded fallback segmenter: a cluster never grows past MAX_GRAPHEME_UNITS while the
  // loop keeps running, so a hostile run of combining marks cannot stall the measurement.
  function nextFallbackCluster(text, index) {
    let end = index
    const first = text.codePointAt(end)
    const firstSize = first > 0xffff ? 2 : 1
    end += firstSize
    // CRLF is one cluster.
    if (first === 0x0d && text.charCodeAt(end) === 0x0a) return { end: end + 1 }
    // A regional-indicator pair is one flag cluster.
    if (first >= 0x1f1e6 && first <= 0x1f1ff) {
      const next = text.codePointAt(end)
      if (next >= 0x1f1e6 && next <= 0x1f1ff) end += next > 0xffff ? 2 : 1
    }
    while (end < text.length && end - index < MAX_GRAPHEME_UNITS) {
      const code = text.codePointAt(end)
      const unitSize = code > 0xffff ? 2 : 1
      if (code === 0x200d) {
        // Zero-width joiner: keep it and the following base with this cluster.
        end += unitSize
        if (end < text.length) {
          const joined = text.codePointAt(end)
          end += joined > 0xffff ? 2 : 1
        }
        continue
      }
      if (!isClusterExtension(code)) break
      end += unitSize
    }
    // Keep the promise the serialised payload relies on: one glyph text never exceeds
    // MAX_GRAPHEME_UNITS units, so the export's bounded slice never cuts a normal cluster.
    if (end - index > MAX_GRAPHEME_UNITS) {
      end = index + MAX_GRAPHEME_UNITS
      const last = text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    return { end }
  }

  // Collects at most `limit` clusters (the DOM-read budget): segmenting stops there, so the
  // work is bounded by the budget even for a 3000-character block.
  function collectGraphemes(text, limit) {
    const clusters = []
    if (!text || limit <= 0) return clusters
    const segmenter = createGraphemeSegmenter()
    if (segmenter) {
      try {
        for (const part of segmenter.segment(text)) {
          let offset = 0
          while (offset < part.segment.length && clusters.length < limit) {
            let end = Math.min(offset + MAX_GRAPHEME_UNITS, part.segment.length)
            if (end < part.segment.length) {
              const last = part.segment.charCodeAt(end - 1)
              if (last >= 0xd800 && last <= 0xdbff) end -= 1
            }
            clusters.push({ text: part.segment.slice(offset, end), start: part.index + offset, end: part.index + end })
            offset = end
          }
          if (clusters.length >= limit) return clusters
        }
        return clusters
      } catch (_error) {
        // Fall through to the deterministic bounded fallback below.
      }
    }
    let index = 0
    while (index < text.length && clusters.length < limit) {
      const cluster = nextFallbackCluster(text, index)
      clusters.push({ text: text.slice(index, cluster.end), start: index, end: cluster.end })
      index = cluster.end
    }
    return clusters
  }

  // A grapheme may report several client rects (base + marks, emoji fallback runs): the
  // union is one glyph box.
  function unionClientRects(boxes) {
    if (!boxes || typeof boxes.length !== 'number' || boxes.length === 0) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index]
      if (!box) continue
      const boxLeft = Number(box.left)
      const boxTop = Number(box.top)
      const boxRight = Number.isFinite(Number(box.right)) ? Number(box.right) : boxLeft + Number(box.width)
      const boxBottom = Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : boxTop + Number(box.height)
      if (!Number.isFinite(boxLeft) || !Number.isFinite(boxTop) || !Number.isFinite(boxRight) || !Number.isFinite(boxBottom)) continue
      if (!(boxRight > boxLeft) || !(boxBottom > boxTop)) continue
      left = Math.min(left, boxLeft)
      top = Math.min(top, boxTop)
      right = Math.max(right, boxRight)
      bottom = Math.max(bottom, boxBottom)
    }
    if (!(right > left) || !(bottom > top)) return null
    return { left, top, width: right - left, height: bottom - top }
  }

  function measureElement(element, host, rotation, attemptBudget, angle) {
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
    const budget = Math.max(0, Math.floor(attemptBudget))
    const clusters = collectGraphemes(text, budget)
    const glyphs = []
    const range = typeof document.createRange === 'function' ? document.createRange() : null
    let attempts = 0
    if (range) {
      for (const cluster of clusters) {
        attempts += 1
        range.setStart(textNode, cluster.start)
        range.setEnd(textNode, cluster.end)
        const box = unionClientRects(typeof range.getClientRects === 'function' ? range.getClientRects() : [])
        if (!box) continue
        const offset = unrotateOffset(
          box.left + box.width / 2 - blockCenterX,
          box.top + box.height / 2 - blockCenterY,
          rotation
        )
        const glyphWidth = quarter ? box.height : box.width
        const glyphHeight = quarter ? box.width : box.height
        // Drop clusters the chip's `overflow:hidden` hides: the export paints the visible
        // overlay, not the clipped away overflow.
        if (offset.x + glyphWidth / 2 <= -width / 2 || offset.x - glyphWidth / 2 >= width / 2) continue
        if (offset.y + glyphHeight / 2 <= -height / 2 || offset.y - glyphHeight / 2 >= height / 2) continue
        glyphs.push({
          text: cluster.text,
          x: offset.x,
          y: offset.y,
          width: glyphWidth,
          height: glyphHeight,
          startIndex: cluster.start,
          endIndex: cluster.end,
          // P2-02: the measured painter must know whether the browser laid this grapheme out
          // sideways (horizontal scripts in vertical-rl mixed) or upright (CJK/kana/Hangul/emoji).
          sideways: vertical ? verticalTextIsSideways(cluster.text) : false
        })
      }
    }
    // P2-07: the caller charges `attempts` (one Range.getClientRects each) against the
    // per-block and global DOM-read budgets, whether or not the cluster survived clipping.
    const measuredEnd = clusters.length > 0 ? clusters[clusters.length - 1].end : 0
    let complete = measuredEnd >= text.length
    // Group consecutive glyphs into the browser's line boxes: horizontal text groups by y,
    // vertical-rl text by x (each group is one column, right to left in DOM order). A DOM
    // index gap keeps a clipped-away middle from being re-joined into one painted run.
    const tolerance = Math.max(1, fontSize * 0.45)
    const grouped = []
    let current = null
    let previousEnd = -1
    for (const glyph of glyphs) {
      const axis = vertical ? glyph.x : glyph.y
      if (!current || Math.abs(axis - current.axis) > tolerance || glyph.startIndex !== previousEnd) {
        if (grouped.length >= MAX_LAYOUT_LINES) {
          complete = false
          break
        }
        current = { axis, glyphs: [] }
        grouped.push(current)
      }
      current.glyphs.push(glyph)
      previousEnd = glyph.endIndex
    }
    const layoutLines = []
    for (const line of grouped) {
      const kept = []
      let lineText = ''
      for (const glyph of line.glyphs) {
        if (!vertical) {
          // Horizontal lines are painted as ONE shaped run, so the retained glyphs have to
          // match the line text exactly; cap both at the bounded line length.
          if (lineText.length + glyph.text.length > MAX_LAYOUT_TEXT) break
          kept.push(glyph)
          lineText += glyph.text
          continue
        }
        kept.push(glyph)
        if (lineText.length + glyph.text.length <= MAX_LAYOUT_TEXT) lineText += glyph.text
      }
      if (kept.length === 0) continue
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const glyph of kept) {
        minX = Math.min(minX, glyph.x - glyph.width / 2)
        maxX = Math.max(maxX, glyph.x + glyph.width / 2)
        minY = Math.min(minY, glyph.y - glyph.height / 2)
        maxY = Math.max(maxY, glyph.y + glyph.height / 2)
      }
      if (!(maxX > minX) || !(maxY > minY)) continue
      layoutLines.push({
        text: lineText,
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        width: maxX - minX,
        height: maxY - minY,
        glyphs: kept.map((glyph) => ({
          text: glyph.text,
          x: glyph.x,
          y: glyph.y,
          width: glyph.width,
          height: glyph.height,
          sideways: glyph.sideways === true
        }))
      })
    }
    return {
      layout: {
        blockIndex: 0,
        width,
        height,
        centerX,
        centerY,
        angle,
        vertical,
        fontSize,
        fontFamily,
        lines: layoutLines,
        // P2-07: serialised so the export/review can tell a fully measured block from one
        // the attempts budget cut short (its visible prefix is still exported).
        attempts,
        complete
      },
      attempts,
      complete,
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
      // P2-07: the global budget is consumed by ATTEMPTED measurements, so a clipped block
      // can never spend thousands of synchronous layout reads on a handful of visible glyphs.
      let remainingAttempts = MAX_LAYOUT_GLYPHS
      for (const entry of saved) {
        if (remainingAttempts <= 0) break
        const attemptBudget = Math.min(MAX_LAYOUT_TEXT, remainingAttempts)
        const measured = measureElement(entry.element, host, rotation, attemptBudget, entry.angle)
        if (!measured) continue
        remainingAttempts -= measured.attempts
        const index = Number(entry.element.dataset.blockIndex)
        measured.layout.blockIndex = Number.isInteger(index) && index >= 0
          ? index
          : layouts.length
        layouts.push(measured.layout)
      }
    } finally {
      for (const entry of saved) entry.element.style.transform = entry.transform
    }
    return layouts
  }

  window.OcrTextOverlay = {
    renderBlocks,
    measureLayout,
    verticalTextIsSideways,
    MAX_LAYOUT_GLYPHS,
    MAX_LAYOUT_BLOCKS,
    MAX_LAYOUT_TEXT
  }
})()
