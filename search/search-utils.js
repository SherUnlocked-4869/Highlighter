(function exposeSearchUtils(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.searchUtils = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // P0-1-T5 (S12): `label` holds an i18n key, not a sentence — this module also
  // runs under Node (test/search-utils.test.js) where no locale table is loaded.
  // `search.js` resolves the key with `t()`. `rule` and `id` are the data/API
  // contract and never change.
  const DEFAULT_CATEGORIES = Object.freeze([
    { id: 'all', label: 'search.category.all', rule: '' },
    { id: 'folder', label: 'search.category.folder', rule: 'folder:' },
    { id: 'excel', label: 'EXCEL', rule: 'ext:xls;xlsx;xlsm;csv' },
    { id: 'word', label: 'WORD', rule: 'ext:doc;docx;rtf' },
    { id: 'ppt', label: 'PPT', rule: 'ext:ppt;pptx' },
    { id: 'pdf', label: 'PDF', rule: 'ext:pdf' },
    { id: 'image', label: 'search.category.image', rule: 'ext:jpg;jpeg;png;gif;webp;bmp;svg;ico' },
    { id: 'video', label: 'search.category.video', rule: 'ext:mp4;mkv;avi;mov;wmv;flv;webm' },
    { id: 'audio', label: 'search.category.audio', rule: 'ext:mp3;wav;flac;aac;ogg;m4a' },
    { id: 'archive', label: 'search.category.archive', rule: 'ext:zip;rar;7z;tar;gz;iso' }
  ])

  // Same convention: the first element is the persisted value, the second is an
  // i18n key resolved by the renderer.
  const SORT_OPTIONS = Object.freeze([
    ['modified-desc', 'search.sort.modified-desc'],
    ['modified-asc', 'search.sort.modified-asc'],
    ['name-asc', 'search.sort.name-asc'],
    ['name-desc', 'search.sort.name-desc'],
    ['path-asc', 'search.sort.path-asc'],
    ['path-desc', 'search.sort.path-desc'],
    ['size-asc', 'search.sort.size-asc'],
    ['size-desc', 'search.sort.size-desc']
  ])

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char])
  }

  // Bare extension lists (e.g. "xls, xlsx") are normalized to Everything's
  // "ext:" syntax; rules that already carry an operator are passed through.
  function normalizeCategoryRule(rule) {
    const text = String(rule || '').trim()
    if (!text) return ''
    if (text.includes(':') || text.includes(' ') || text.includes('*')) return text
    const extensions = text.split(/[;,，；、\s]+/).filter(Boolean).map((item) => item.replace(/^\./, ''))
    return extensions.length ? `ext:${extensions.join(';')}` : ''
  }

  function buildQuery(keyword, rule) {
    return [String(keyword || '').trim(), normalizeCategoryRule(rule)].filter(Boolean).join(' ')
  }

  // With "match path" enabled a plain keyword is searched both in file names
  // and in full paths (two queries, merged); keywords that already contain a
  // path separator only need the path-matching query.
  function planQueries(keyword, matchPathEnabled) {
    const text = String(keyword || '').trim()
    if (!text) return []
    const hasSeparator = /[\\/]/.test(text)
    if (matchPathEnabled && !hasSeparator) {
      return [
        { keyword: text, matchPath: false },
        { keyword: text, matchPath: true }
      ]
    }
    return [{ keyword: text, matchPath: matchPathEnabled && hasSeparator }]
  }

  function mergeQueryResults(results) {
    const fulfilled = (results || []).filter((result) => result && Array.isArray(result.items))
    if (!fulfilled.length) return { total: 0, items: [] }
    const seen = new Set()
    const items = []
    for (const result of fulfilled) {
      for (const item of result.items) {
        const key = String(item?.fullPath || '').toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        items.push(item)
      }
    }
    const total = fulfilled.reduce((sum, result) => Math.max(sum, Number(result.total) || 0), 0)
    return { total, items }
  }

  // Everything surrounds matched terms with marker characters: 1.5 uses "*",
  // the SDK protocol documents 0x1F. An odd marker count means the marker is
  // part of the file name and highlighting should fall back to keyword matching.
  function splitHighlight(text) {
    const value = String(text ?? '')
    for (const marker of ['\x1F', '*']) {
      if (!value.includes(marker)) continue
      const parts = value.split(marker)
      if ((parts.length - 1) % 2 !== 0) return null
      const segments = []
      for (let index = 0; index < parts.length; index += 1) {
        if (parts[index]) segments.push({ text: parts[index], match: index % 2 === 1 })
      }
      return segments.length ? segments : null
    }
    return null
  }

  function naiveHighlight(text, keyword) {
    const value = String(text ?? '')
    const terms = [...new Set(
      String(keyword || '')
        .split(/[\s|]+/)
        .map((term) => term.replace(/^["']|["']$/g, '').trim())
        .filter((term) => term.length > 0 && !term.includes(':') && !term.includes('*') && !/^[\\/]+$/.test(term))
    )].sort((left, right) => right.length - left.length)
    if (!terms.length || !value) return null
    const lowerValue = value.toLowerCase()
    const marks = new Array(value.length).fill(false)
    for (const term of terms) {
      const lowerTerm = term.toLowerCase()
      let cursor = lowerValue.indexOf(lowerTerm)
      while (cursor >= 0) {
        for (let offset = 0; offset < lowerTerm.length; offset += 1) marks[cursor + offset] = true
        cursor = lowerValue.indexOf(lowerTerm, cursor + lowerTerm.length)
      }
    }
    const segments = []
    let current = ''
    let currentMatch = marks[0] === true
    for (let index = 0; index < value.length; index += 1) {
      if (marks[index] === currentMatch) {
        current += value[index]
      } else {
        if (current) segments.push({ text: current, match: currentMatch })
        current = value[index]
        currentMatch = marks[index]
      }
    }
    if (current) segments.push({ text: current, match: currentMatch })
    return segments.length ? segments : null
  }

  function renderHighlighted(text, keyword, highlightedText) {
    const segments = splitHighlight(highlightedText) || naiveHighlight(text, keyword)
    if (!segments) return escapeHtml(text)
    return segments
      .map((segment) => (segment.match ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)))
      .join('')
  }

  function formatSize(bytes) {
    const size = Number(bytes)
    if (!Number.isFinite(size) || size <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = size
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    const rounded = unitIndex === 0 ? String(value) : value.toFixed(1)
    return `${rounded} ${units[unitIndex]}`
  }

  function formatTime(epochMs) {
    const time = Number(epochMs)
    if (!Number.isFinite(time) || time <= 0) return ''
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function extensionBadge(extension) {
    const text = String(extension || '').replace(/[^a-z0-9]/gi, '').toUpperCase()
    return text ? text.slice(0, 4) : '?'
  }

  return {
    DEFAULT_CATEGORIES,
    SORT_OPTIONS,
    escapeHtml,
    normalizeCategoryRule,
    buildQuery,
    planQueries,
    mergeQueryResults,
    splitHighlight,
    naiveHighlight,
    renderHighlighted,
    formatSize,
    formatTime,
    extensionBadge
  }
})
