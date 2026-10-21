// AI usage page: pure number/date formatting helpers.
//
// Two consumers, so this file follows the same UMD shape as
// shared/cursor-geometry.js:
//   * renderer: config/config.html loads it with a plain <script> before
//     config/routes/usage.js (the window CSP has `connect-src 'none'`, so no
//     module loader is available);
//   * node:test: test/usage-format.test.js `require()`s it directly.
//
// No DOM access, no Intl locale-data dependency: token units are embedded on
// purpose so the tests are deterministic and a missing locale table can never
// make the formatter throw. The tokens the page renders are integers >= 0
// (storage clamps them), so every token formatter treats negative / non-finite
// input as 0 instead of painting "-1 tokens" from a corrupt bucket.
//
// Compact-format contract (plan §2.8):
//   en-US 1.5B / 195.2M / 999.9K, trailing ".0" trimmed, 999.95K rounds to 1M;
//   zh-CN/zh-TW use 万/亿 (萬/億) and the same one-decimal + promote boundary.

;(function exposeUsageFormat(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.usageFormat = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const EN_SCALES = [
    { value: 1e12, suffix: 'T' },
    { value: 1e9, suffix: 'B' },
    { value: 1e6, suffix: 'M' },
    { value: 1e3, suffix: 'K' }
  ]

  function chineseScales(language) {
    const traditional = String(language || '').toLowerCase() === 'zh-tw'
    return [
      { value: 1e8, suffix: traditional ? '億' : '亿' },
      { value: 1e4, suffix: traditional ? '萬' : '万' }
    ]
  }

  // Token counts are counters: a negative or non-finite value cannot be real,
  // so it renders as 0 rather than propagating broken arithmetic into the page.
  function normalizeToken(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 0
  }

  function roundToOneDecimal(value) {
    return Math.round(value * 10) / 10
  }

  // One decimal at most, with trailing zeros removed: 2.0 -> "2", 1.5 -> "1.5".
  function trimFixed(value) {
    const fixed = Number(value).toFixed(1)
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
  }

  function formatWithScales(number, scales) {
    if (number <= 0) return '0'
    let chosen = -1
    for (let index = 0; index < scales.length; index += 1) {
      if (number >= scales[index].value) {
        chosen = index
        break
      }
    }
    // Below the smallest unit: keep an integer, but a value that rounds up to
    // the unit boundary (999.6 -> 1000) promotes instead of printing "1000".
    if (chosen === -1) {
      const smallest = scales[scales.length - 1]
      const rounded = Math.round(number)
      if (rounded >= smallest.value) return `1${smallest.suffix}`
      return String(rounded)
    }
    const ratio = chosen > 0 ? scales[chosen - 1].value / scales[chosen].value : Infinity
    let scaled = roundToOneDecimal(number / scales[chosen].value)
    // 999.95K is 999.95 * 1000: one decimal rounds it to 1000K, which has to
    // become 1M. Same boundary for 万 -> 亿 (ratio 1e4 instead of 1e3).
    while (scaled >= ratio && chosen > 0) {
      chosen -= 1
      scaled = roundToOneDecimal(number / scales[chosen].value)
    }
    // The largest unit has no parent (ratio is Infinity), so an absurdly large
    // value simply prints as e.g. "1000T" instead of looping forever.
    return `${trimFixed(scaled)}${scales[chosen].suffix}`
  }

  function formatCompactToken(value, language = 'en-US') {
    const number = normalizeToken(value)
    const scales = isChineseLanguage(language) ? chineseScales(language) : EN_SCALES
    return formatWithScales(number, scales)
  }

  function groupThousands(text) {
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  // Full value for tooltips / titles: every significant digit, comma grouped.
  function formatFullToken(value) {
    const number = normalizeToken(value)
    return groupThousands(String(Math.round(number)))
  }

  // Share percentages arrive pre-computed from the query layer (0..100). The
  // page also uses the return value as a CSS width, so keep the "%" and a
  // single decimal. Trailing ".0" is trimmed: 50% instead of 50.0%.
  function formatSharePct(value, digits = 1) {
    const number = Number(value)
    if (!Number.isFinite(number)) return '0%'
    const clamped = Math.min(100, Math.max(0, number))
    const precision = Number.isInteger(digits) && digits >= 0 && digits <= 2 ? digits : 1
    let text = clamped.toFixed(precision)
    if (precision > 0) text = text.replace(/\.0+$/, '')
    return `${text}%`
  }

  function isChineseLanguage(language) {
    return /^zh(-|$)/i.test(String(language || ''))
  }

  // The IPC contract uses 'YYYY-MM-DD' day keys for every range boundary. Keep
  // the helper tolerant: anything that is not a day key becomes '' so callers
  // can render a neutral label instead of "Invalid Date".
  function toDayKey(value) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : ''
    }
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return ''
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // Day-key arithmetic goes through the local Date constructor, so a DST day
  // still yields the expected calendar day (the engine hands the page day keys,
  // not timestamps).
  function addDays(value, offset) {
    const key = toDayKey(value)
    const days = Math.trunc(Number(offset))
    if (!key || !Number.isFinite(days)) return ''
    const [year, month, day] = key.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    date.setDate(date.getDate() + days)
    return toDayKey(date)
  }

  function formatRangeLabel(period, from, to) {
    const start = toDayKey(from)
    const end = toDayKey(to)
    if (!start && !end) return ''
    if (!start) return end
    if (!end) return start
    if (start === end) return start
    if (period === 'day') return end
    return `${start} – ${end}`
  }

  // Tooltip builder: the caller supplies already-localized labels (from t()),
  // the helper owns the layout and the full grouped values. Returns plain text
  // so it can be dropped into a title attribute or split on "\n" for a custom
  // tooltip; no HTML is produced here on purpose.
  function formatTooltip(input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const lines = []
    if (typeof source.title === 'string' && source.title.trim()) lines.push(source.title.trim())
    const rows = Array.isArray(source.rows) ? source.rows : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const label = typeof row.label === 'string' ? row.label.trim() : ''
      if (!label) continue
      lines.push(`${label}: ${formatFullToken(row.value)}`)
    }
    return lines.join('\n')
  }

  return {
    formatCompactToken,
    formatFullToken,
    formatSharePct,
    formatRangeLabel,
    formatTooltip,
    toDayKey,
    addDays,
    isChineseLanguage
  }
})
