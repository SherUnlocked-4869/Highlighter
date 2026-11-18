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
    for (const block of result.textBlocks) {
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

  window.OcrTextOverlay = { renderBlocks }
})()
