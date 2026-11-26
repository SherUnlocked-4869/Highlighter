// N01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.1):
// the local sensitive-data rule library behind the capture window's smart redaction.
//
// This module is deliberately pure and dependency-free:
//   * it never touches the DOM, the OCR service, IPC or the network;
//   * the renderer loads it as a classic script (window.sensitivePatterns) and node
//     can require() it for behaviour tests;
//   * every rule is declared as `{ id, labelKey, pattern }`, and detection answers
//     ranges + categories so the caller can map OCR text blocks to redaction boxes
//     without re-implementing any matching logic.
//
// False-positive control is a first-class contract here, not an afterthought:
//   * short numbers, module versions and ordinary words must never match;
//   * a Chinese ID number only matches when its ISO 7064 check digit AND birth date
//     are valid;
//   * a bank card only matches when its Luhn checksum passes and it has 16-19 digits;
//   * an IPv4 address only matches when its octets are valid AND it is in the
//     RFC 1918 ranges (a public address is not a disclosure of the local network);
//   * later rules never re-report a range an earlier, more specific rule already
//     matched (email wins over a phone-looking run inside the address, etc.).
;(function exposeSensitivePatterns(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.sensitivePatterns = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  'use strict'

  const CATEGORIES = Object.freeze({
    CREDENTIAL: 'credential',
    CONTACT: 'contact',
    IDENTITY: 'identity',
    NETWORK: 'network',
    FINANCE: 'finance',
    URL: 'url'
  })

  // Rule order doubles as overlap priority: the first rule that claims a range wins.
  // Specific credential/key shapes come before the broader contact shapes, and the
  // identity rule comes before the bank-card rule so an 18-digit ID number is never
  // reported twice (a Chinese ID is also a 18-digit run and may coincidentally pass
  // a generic Luhn check).
  const RULES = Object.freeze([
    Object.freeze({
      id: 'openai-api-key',
      labelKey: 'capture-redact.rule-api-key',
      category: CATEGORIES.CREDENTIAL,
      // sk-... (OpenAI style) including the prefixed `sk-proj-` / `sk-ant-` shapes.
      // The bare branch forbids inner hyphens, so prose such as
      // `sk-learn-python-tutorial` cannot match as if it were a key.
      pattern: /\bsk-(?:(?:proj|ant|live|test)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})\b/g
    }),
    Object.freeze({
      id: 'github-token',
      labelKey: 'capture-redact.rule-github-token',
      category: CATEGORIES.CREDENTIAL,
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
    }),
    Object.freeze({
      id: 'aws-access-key',
      labelKey: 'capture-redact.rule-aws-key',
      category: CATEGORIES.CREDENTIAL,
      pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
    }),
    Object.freeze({
      id: 'bearer-token',
      labelKey: 'capture-redact.rule-bearer-token',
      category: CATEGORIES.CREDENTIAL,
      pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi
    }),
    Object.freeze({
      id: 'jwt',
      labelKey: 'capture-redact.rule-jwt',
      category: CATEGORIES.CREDENTIAL,
      // A JWT is three base64url segments; the header always starts with `eyJ`
      // (base64 of `{"`), which keeps this from matching ordinary dotted words.
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
    }),
    Object.freeze({
      id: 'url-token-query',
      labelKey: 'capture-redact.rule-url-token',
      category: CATEGORIES.URL,
      // Only URLs whose query carries a credential-ish parameter; `?page=2` and
      // other ordinary query strings must not match.
      pattern: /\bhttps?:\/\/[^\s<>"']+[?&](?:access[_-]?token|refresh[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|signature|sig|auth|session(?:[_-]?id)?|credential)=[^\s&#"'<>]+/gi
    }),
    Object.freeze({
      id: 'email',
      labelKey: 'capture-redact.rule-email',
      category: CATEGORIES.CONTACT,
      // At least one dot in the domain and a 2+ letter TLD, so `user@host` (a
      // username@machine token) is not treated as an email address.
      pattern: /(?<![\w.+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w.-])/g
    }),
    Object.freeze({
      id: 'phone-cn',
      labelKey: 'capture-redact.rule-phone',
      category: CATEGORIES.CONTACT,
      // Mainland China mobile numbers: 11 digits starting 1[3-9]. The lookarounds
      // keep a digit run inside a longer number/identifier from matching.
      pattern: /(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])/g
    }),
    Object.freeze({
      id: 'id-card-cn',
      labelKey: 'capture-redact.rule-id-card',
      category: CATEGORIES.IDENTITY,
      // 17 digits + digit/X; the validator below enforces the ISO 7064 check digit
      // and a real birth date, so version strings / order numbers cannot match.
      pattern: /(?<![\dA-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g,
      validate: (value) => validateChinaId(value)
    }),
    Object.freeze({
      id: 'intranet-ipv4',
      labelKey: 'capture-redact.rule-intranet-ip',
      category: CATEGORIES.NETWORK,
      // Any well-formed IPv4 candidate; the validator keeps only RFC 1918 ranges
      // (10/8, 172.16/12, 192.168/16) with octets in 0-255.
      pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
      validate: (value) => isIntranetIpv4(value)
    }),
    Object.freeze({
      id: 'bank-card',
      labelKey: 'capture-redact.rule-bank-card',
      category: CATEGORIES.FINANCE,
      // 16-19 digits, optionally grouped with single spaces or hyphens. The Luhn
      // gate is what keeps arbitrary long order numbers out of the result.
      pattern: /(?<![\dA-Za-z])(?:\d{4}[ -]?){3}\d{4,7}(?![\dA-Za-z])/g,
      validate: (value) => validateBankCard(value)
    })
  ])

  const RULE_BY_ID = Object.freeze(RULES.reduce((map, rule) => {
    map[rule.id] = rule
    return map
  }, {}))

  const DEFAULT_BOX_PADDING = 2
  const MIN_BOX_SIZE = 1

  function finiteNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function roundToHundredths(value) {
    return Math.round(value * 100) / 100
  }

  function uniqueStrings(values) {
    const seen = new Set()
    const result = []
    for (const value of values) {
      const text = String(value || '')
      if (!text || seen.has(text)) continue
      seen.add(text)
      result.push(text)
    }
    return result
  }

  // ---------- validators ----------

  // Luhn is the industry checksum for payment card numbers. It is deliberately used
  // as a REQUIRED gate: a real card always passes it, while a random 16-19 digit
  // order/trace number passes only ~10% of the time.
  function validateLuhn(digits) {
    const text = String(digits || '').replace(/[^0-9]/g, '')
    if (text.length < 2) return false
    let sum = 0
    let doubled = false
    for (let index = text.length - 1; index >= 0; index -= 1) {
      let digit = text.charCodeAt(index) - 48
      if (digit < 0 || digit > 9) return false
      if (doubled) {
        digit *= 2
        if (digit > 9) digit -= 9
      }
      sum += digit
      doubled = !doubled
    }
    return sum % 10 === 0
  }

  function isAllSameDigit(digits) {
    return /^(\d)\1+$/.test(digits)
  }

  function validateBankCard(value) {
    const digits = String(value || '').replace(/[ -]/g, '')
    if (!/^\d{16,19}$/.test(digits)) return false
    // `0000...` and `1111...` placeholders pass a naive checksum but are not cards.
    if (isAllSameDigit(digits)) return false
    return validateLuhn(digits)
  }

  const CHINA_ID_WEIGHTS = Object.freeze([7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2])
  const CHINA_ID_CHECK_CODES = '10X98765432'

  function isValidCalendarDate(year, month, day) {
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return false
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  }

  // Mainland China resident ID number (GB 11643-1999): 6-digit region, 8-digit
  // birth date, 3-digit sequence and an ISO 7064 MOD 11-2 check character.
  function validateChinaId(value) {
    const text = String(value || '').trim()
    if (!/^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(text)) return false
    const year = Number(text.slice(6, 10))
    const month = Number(text.slice(10, 12))
    const day = Number(text.slice(12, 14))
    if (!isValidCalendarDate(year, month, day)) return false
    let sum = 0
    for (let index = 0; index < 17; index += 1) {
      sum += (text.charCodeAt(index) - 48) * CHINA_ID_WEIGHTS[index]
    }
    return CHINA_ID_CHECK_CODES[sum % 11] === text.slice(17).toUpperCase()
  }

  function isIntranetIpv4(value) {
    const parts = String(value || '').split('.')
    if (parts.length !== 4) return false
    const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
    const [first, second] = octets
    if (first === 10) return true
    if (first === 172) return second >= 16 && second <= 31
    return first === 192 && second === 168
  }

  // ---------- detection ----------

  function rangesOverlap(accepted, start, end) {
    for (const match of accepted) {
      if (start < match.end && end > match.start) return true
    }
    return false
  }

  function matchesOfRule(rule, text) {
    if (!rule || !(rule.pattern instanceof RegExp) || !rule.pattern.global) return []
    const matches = []
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0]
      const start = Number(match.index)
      if (!value || !Number.isFinite(start)) continue
      if (typeof rule.validate === 'function' && !rule.validate(value)) continue
      matches.push({ start, end: start + value.length, value })
    }
    return matches
  }

  /**
   * Find every sensitive range in `text`.
   *
   * Returns `[{ ruleId, labelKey, category, value, start, end }]` sorted by start.
   * Ranges never overlap: the first rule (in RULES order) that claims a range wins,
   * so more specific shapes shadow broader ones.
   */
  function detectSensitiveText(text) {
    const source = typeof text === 'string' ? text : ''
    if (!source) return []
    const accepted = []
    for (const rule of RULES) {
      for (const match of matchesOfRule(rule, source)) {
        if (rangesOverlap(accepted, match.start, match.end)) continue
        accepted.push({
          ruleId: rule.id,
          labelKey: rule.labelKey,
          category: rule.category,
          value: match.value,
          start: match.start,
          end: match.end
        })
      }
    }
    accepted.sort((left, right) => left.start - right.start)
    return accepted
  }

  function hasSensitiveText(text) {
    return detectSensitiveText(text).length > 0
  }

  // ---------- OCR text block -> redaction geometry ----------

  function normalizedRect(rect) {
    if (!rect || typeof rect !== 'object') return null
    const x = finiteNumber(rect.x)
    const y = finiteNumber(rect.y)
    const w = finiteNumber(rect.w ?? rect.width)
    const h = finiteNumber(rect.h ?? rect.height)
    if (x === null || y === null || w === null || h === null) return null
    if (!(w > 0) || !(h > 0)) return null
    return { x, y, w, h }
  }

  function normalizedBoxPoints(points) {
    if (!Array.isArray(points)) return []
    const normalized = []
    for (const point of points) {
      const x = finiteNumber(point?.x)
      const y = finiteNumber(point?.y)
      if (x === null || y === null) continue
      normalized.push({ x, y })
    }
    return normalized
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  /**
   * Map OCR text blocks that contain sensitive data to viewport-CSS rectangles.
   *
   * Inputs are pure data:
   *   blocks      - the OCR sidecar's `textBlocks` (`{ text, box_points, text_score }`);
   *   imageWidth  - the pixel width of the image handed to OCR (the encoded crop);
   *   imageHeight - likewise;
   *   rect        - the viewport-CSS rectangle that image was cropped from;
   *   padding     - outward padding in viewport CSS px (default 2).
   *
   * A hit redacts the WHOLE text block, never only the matched substring: OCR boxes
   * are line-level, and a partially covered credential would leak the rest of it.
   * Blocks that map to the same rounded rectangle are reported once.
   *
   * Returns `[{ x, y, w, h, ruleIds, labelKeys, categories }]` in `rect`'s space.
   */
  function buildRedactionBoxes(options = {}) {
    const blocks = Array.isArray(options.blocks) ? options.blocks : []
    const rect = normalizedRect(options.rect)
    const imageWidth = finiteNumber(options.imageWidth)
    const imageHeight = finiteNumber(options.imageHeight)
    const padding = clamp(finiteNumber(options.padding) ?? DEFAULT_BOX_PADDING, 0, 64)
    if (!blocks.length || !rect || !(imageWidth > 0) || !(imageHeight > 0)) return []
    const scaleX = rect.w / imageWidth
    const scaleY = rect.h / imageHeight
    const right = rect.x + rect.w
    const bottom = rect.y + rect.h
    const boxes = []
    const seen = new Set()
    for (const block of blocks) {
      const text = typeof block?.text === 'string' ? block.text : ''
      if (!text) continue
      const matches = detectSensitiveText(text)
      if (!matches.length) continue
      const points = normalizedBoxPoints(block?.box_points)
      if (points.length < 4) continue
      let minX = points[0].x
      let maxX = points[0].x
      let minY = points[0].y
      let maxY = points[0].y
      for (const point of points) {
        if (point.x < minX) minX = point.x
        if (point.x > maxX) maxX = point.x
        if (point.y < minY) minY = point.y
        if (point.y > maxY) maxY = point.y
      }
      const left = clamp(rect.x + minX * scaleX - padding, rect.x, right)
      const top = clamp(rect.y + minY * scaleY - padding, rect.y, bottom)
      const boxRight = clamp(rect.x + maxX * scaleX + padding, rect.x, right)
      const boxBottom = clamp(rect.y + maxY * scaleY + padding, rect.y, bottom)
      const x = roundToHundredths(left)
      const y = roundToHundredths(top)
      const w = roundToHundredths(boxRight - left)
      const h = roundToHundredths(boxBottom - top)
      if (!(w >= MIN_BOX_SIZE) || !(h >= MIN_BOX_SIZE)) continue
      const key = `${x}|${y}|${w}|${h}`
      if (seen.has(key)) continue
      seen.add(key)
      boxes.push({
        x,
        y,
        w,
        h,
        ruleIds: uniqueStrings(matches.map((match) => match.ruleId)),
        labelKeys: uniqueStrings(matches.map((match) => match.labelKey)),
        categories: uniqueStrings(matches.map((match) => match.category))
      })
    }
    return boxes
  }

  return {
    CATEGORIES,
    RULES,
    RULE_BY_ID,
    DEFAULT_BOX_PADDING,
    detectSensitiveText,
    hasSensitiveText,
    buildRedactionBoxes,
    validateLuhn,
    validateBankCard,
    validateChinaId,
    isIntranetIpv4
  }
})
