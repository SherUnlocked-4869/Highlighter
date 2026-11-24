(function initCaptureColorPicker(globalScope) {
  // B02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): pixel sampling of
  // the FROZEN screenshot. Deliberately separate from the annotation colour palette: this
  // module never changes a stroke colour, it reads one pixel and formats it for display/copy.
  //
  // Every coordinate here is a client CSS point (the same space pointer events and the
  // stage's `selection` live in). The mapping is proportional - imageWidth / bounds.w - so a
  // 150%/200% Windows scale factor is the caller's `bounds` width, not a magic multiplier.
  //
  // Kept as pure helpers (like capture/keyboard-focus.js) so the mapping and formatting can
  // be tested in plain Node without launching a capture window.

  const CONTRAST_CROSSOVER = 0.179

  function finiteNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  // Client CSS point -> integer source pixel. The rect covers [x, x+w) x [y, y+h), so the
  // right/bottom edges and anything past them are outside while still clamping to the
  // nearest pixel (the caller can show the clamped value but knows the pointer left the image).
  function sourcePointFromClient(options = {}) {
    const { clientX, clientY, bounds, imageWidth, imageHeight } = options || {}
    const left = finiteNumber(bounds?.x)
    const top = finiteNumber(bounds?.y)
    const width = finiteNumber(bounds?.w ?? bounds?.width)
    const height = finiteNumber(bounds?.h ?? bounds?.height)
    const sourceWidth = finiteNumber(imageWidth)
    const sourceHeight = finiteNumber(imageHeight)
    const x = finiteNumber(clientX)
    const y = finiteNumber(clientY)
    if (left === null || top === null || width === null || height === null) {
      return { x: 0, y: 0, inside: false }
    }
    if (sourceWidth === null || sourceHeight === null || !(sourceWidth >= 1) || !(sourceHeight >= 1)) {
      return { x: 0, y: 0, inside: false }
    }
    if (x === null || y === null || !(width > 0) || !(height > 0)) {
      return { x: 0, y: 0, inside: false }
    }
    const inside = x >= left && x < left + width && y >= top && y < top + height
    const pixelWidth = Math.max(1, Math.round(sourceWidth))
    const pixelHeight = Math.max(1, Math.round(sourceHeight))
    const sourceX = clamp(Math.floor(((x - left) * pixelWidth) / width), 0, pixelWidth - 1)
    const sourceY = clamp(Math.floor(((y - top) * pixelHeight) / height), 0, pixelHeight - 1)
    return { x: sourceX, y: sourceY, inside }
  }

  // '#rgb' / '#rrggbb' (the leading # is optional). Anything else is null rather than a
  // silently wrong colour - callers use this to verify a copied value.
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null
    let value = hex.trim()
    if (value.startsWith('#')) value = value.slice(1)
    if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null
    if (value.length === 3) value = value.split('').map((digit) => digit + digit).join('')
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    }
  }

  function colorByte(value) {
    const number = finiteNumber(value)
    if (number === null) return 0
    return clamp(Math.round(number), 0, 255)
  }

  function hexComponent(value) {
    return value.toString(16).padStart(2, '0')
  }

  // WCAG relative luminance. 0.179 is the crossover where black and white text have the
  // same contrast ratio, so the label stays readable on every sampled colour.
  function relativeLuminance(r, g, b) {
    const channel = (value) => {
      const srgb = value / 255
      return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  // The one shape both the badge and the clipboard use. `cssHex` is the same lowercase
  // #rrggbb the CSS clipboard consumers expect; `textColor` is for the badge label only.
  function formatColorSample(sample = {}) {
    const r = colorByte(sample?.r)
    const g = colorByte(sample?.g)
    const b = colorByte(sample?.b)
    const hex = '#' + hexComponent(r) + hexComponent(g) + hexComponent(b)
    return {
      hex,
      rgb: 'rgb(' + r + ', ' + g + ', ' + b + ')',
      cssHex: hex,
      textColor: relativeLuminance(r, g, b) > CONTRAST_CROSSOVER ? '#000' : '#fff'
    }
  }

  const api = { sourcePointFromClient, formatColorSample, hexToRgb }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (globalScope) globalScope.captureColorPicker = api
})(typeof window !== 'undefined' ? window : null)
