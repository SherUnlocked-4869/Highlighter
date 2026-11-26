'use strict'

const fs = require('node:fs')
// The preview classifiers run before `createSearchDomain` is called and are also
// exercised directly by the unit test, so they use the module's own path helper
// rather than the injected one.
const path = require('node:path')
const { windowBackdropColor, trackWindowBackdrop } = require('../../services/window-backdrop')
const { createIdleReclaimer } = require('../../services/idle-reclaimer')

// N04 (review report section 5.4): Space opens an in-window Quick Look for the
// selected result, and a result row can be dragged out as a real native file.
// Both operations are served by the search window's own IPC surface. The
// security allowlist (`main/services/ipc-security.js`) is outside this ticket's
// write scope, so instead of adding channels both reuse the existing
// `search:file-icon` invoke and are selected by `payload.action`:
//   { path }                            -> shell icon (unchanged)
//   { path, action: 'preview' }         -> Quick Look payload (main-process read)
//   { path, action: 'drag' }            -> webContents.startDrag
// The renderer never reads a file itself and never receives bytes it could
// re-read: every read happens here, on the path the result list already owns.
const PREVIEW_TEXT_MAX_BYTES = 512 * 1024
const PREVIEW_IMAGE_MAX_BYTES = 24 * 1024 * 1024
// The text body cap matches the byte cap for single-byte files; it is a separate
// constant only so a future reduction cannot silently exceed the read limit.
const PREVIEW_MAX_CHARACTERS = PREVIEW_TEXT_MAX_BYTES
const PREVIEW_MARKDOWN_MAX_CHARACTERS = 192 * 1024

const PREVIEW_IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['svg', 'image/svg+xml'],
  ['avif', 'image/avif']
])
const PREVIEW_MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'mdown', 'mkd'])
const PREVIEW_JSON_EXTENSIONS = new Set(['json', 'webmanifest'])
const PREVIEW_CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'xaml',
  'py', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env',
  'lua', 'kt', 'kts', 'swift', 'dart', 'r', 'pl', 'scala', 'gradle', 'm', 'mm'
])
const PREVIEW_HASH_COMMENT_EXTENSIONS = new Set([
  'py', 'rb', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'yaml', 'yml', 'toml',
  'ini', 'conf', 'cfg', 'properties', 'env', 'r', 'pl', 'makefile', 'gradle'
])
const PREVIEW_TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'rst', 'nfo', 'srt', 'vtt', 'ics',
  'desktop', 'gitignore', 'gitattributes', 'editorconfig'
])
const PREVIEW_TEXT_BASENAMES = new Set([
  'readme', 'license', 'licence', 'changelog', 'authors', 'notice',
  'makefile', 'dockerfile', 'procfile', '.gitignore', '.gitattributes', '.editorconfig', '.env'
])

// A 32x32 warm-accent square. Used only when the per-file shell icon cannot be
// resolved, so `startDrag` always receives a NativeImage on Windows.
const DRAG_ICON_FALLBACK_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMAISk2rkgBg3E/Ornb6kEhAQEBAQEBAQEBAQEBAQSAcefIZQpgdXuUYAAAAASUVORK5CYII='
// The drag icon travels back from the renderer (which already holds the
// file-icon-lookup result in its cache); only a bounded image data URL is
// accepted and anything else falls back to the bundled placeholder.
const DRAG_ICON_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|bmp|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const DRAG_ICON_MAX_CHARACTERS = 256 * 1024

function resolvePreviewLimit(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function previewExtension(value) {
  const extension = path.extname(String(value || '')).toLowerCase()
  return extension.startsWith('.') ? extension.slice(1) : ''
}

// N04: the Quick Look body is chosen from the extension alone. Unknown types are
// still previewable as file information (name/path/size/modified), never as text,
// so an arbitrary binary is never decoded into the renderer.
function classifyPreviewKind(value) {
  const extension = previewExtension(value)
  if (PREVIEW_IMAGE_TYPES.has(extension)) return 'image'
  if (PREVIEW_JSON_EXTENSIONS.has(extension)) return 'json'
  if (PREVIEW_MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (PREVIEW_CODE_EXTENSIONS.has(extension)) return 'code'
  if (PREVIEW_TEXT_EXTENSIONS.has(extension)) return 'text'
  const basename = path.basename(String(value || '')).toLowerCase()
  if (PREVIEW_TEXT_BASENAMES.has(basename)) return 'text'
  if (basename.includes('.')) {
    const stem = basename.slice(0, basename.lastIndexOf('.'))
    if (PREVIEW_TEXT_BASENAMES.has(stem)) return 'text'
  }
  return 'info'
}

function previewUsesHashComments(value) {
  if (PREVIEW_HASH_COMMENT_EXTENSIONS.has(previewExtension(value))) return true
  return ['makefile', 'dockerfile', '.env'].includes(path.basename(String(value || '')).toLowerCase())
}

// N04: JSON gets re-serialized with two-space indentation when it parses; an
// invalid document is shown verbatim instead of hiding the file's content.
function formatPreviewJson(source) {
  const text = String(source ?? '')
  try {
    return { formatted: true, text: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { formatted: false, text }
  }
}

function escapePreviewHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character])
}

// N04: a deliberately tiny Markdown subset (headings, lists, quotes, rules,
// fenced code, emphasis). Every input line is HTML-escaped first, so the only
// tags in the answer are the ones this function writes itself - a Markdown file
// in the search results must never be able to inject markup into the window.
function renderInlineMarkdown(text) {
  let html = escapePreviewHtml(text)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return html
}

function renderMarkdownPreview(source) {
  const normalized = String(source ?? '').replace(/\r\n?/g, '\n')
  const characters = normalized.slice(0, PREVIEW_MARKDOWN_MAX_CHARACTERS)
  const output = []
  let paragraph = []
  let fenceLanguage = null
  let codeLines = []
  let listTag = ''
  const flushParagraph = () => {
    if (!paragraph.length) return
    output.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!listTag) return
    output.push(`</${listTag}>`)
    listTag = ''
  }
  for (const line of characters.split('\n')) {
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      if (fenceLanguage === null) {
        flushParagraph()
        closeList()
        fenceLanguage = fence[1].trim()
        codeLines = []
      } else {
        output.push(`<pre class="preview-code-block"><code>${escapePreviewHtml(codeLines.join('\n'))}</code></pre>`)
        fenceLanguage = null
        codeLines = []
      }
      continue
    }
    if (fenceLanguage !== null) {
      codeLines.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      closeList()
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      closeList()
      const level = Math.min(6, heading[1].length + 1)
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      closeList()
      output.push('<hr>')
      continue
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      closeList()
      output.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`)
      continue
    }
    const unordered = /^\s{0,3}[-*+]\s+(.*)$/.exec(line)
    if (unordered) {
      flushParagraph()
      if (listTag !== 'ul') {
        closeList()
        output.push('<ul>')
        listTag = 'ul'
      }
      output.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`)
      continue
    }
    const ordered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (listTag !== 'ol') {
        closeList()
        output.push('<ol>')
        listTag = 'ol'
      }
      output.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`)
      continue
    }
    paragraph.push(line.trim())
  }
  if (fenceLanguage !== null) {
    output.push(`<pre class="preview-code-block"><code>${escapePreviewHtml(codeLines.join('\n'))}</code></pre>`)
  }
  flushParagraph()
  closeList()
  return { html: output.join(''), truncated: normalized.length > PREVIEW_MARKDOWN_MAX_CHARACTERS }
}

// N04: no highlighter dependency. A single linear pass marks comments, strings
// and numbers; everything else stays plain monospace text. The pass is written as
// a manual scanner rather than a regex precisely so an unterminated block comment
// in a 512 KB file cannot make the match backtrack quadratically.
function tokenMarkup(className, text) {
  return `<span class="${className}">${escapePreviewHtml(text)}</span>`
}

function highlightCodePreview(source, { hashComments = false } = {}) {
  const text = String(source ?? '')
  const output = []
  let plainStart = 0
  let index = 0
  const flushPlain = (end) => {
    if (end <= plainStart) return
    output.push(escapePreviewHtml(text.slice(plainStart, end)))
    plainStart = end
  }
  while (index < text.length) {
    const character = text[index]
    const next = text[index + 1]
    if ((character === '/' && next === '/') || (character === '#' && hashComments)) {
      const lineEnd = text.indexOf('\n', index)
      const end = lineEnd === -1 ? text.length : lineEnd
      flushPlain(index)
      output.push(tokenMarkup('preview-token-comment', text.slice(index, end)))
      index = end
      plainStart = end
      continue
    }
    if (character === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2)
      const end = close === -1 ? text.length : close + 2
      flushPlain(index)
      output.push(tokenMarkup('preview-token-comment', text.slice(index, end)))
      index = end
      plainStart = end
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      let cursor = index + 1
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (text[cursor] === character) {
          cursor += 1
          break
        }
        cursor += 1
      }
      flushPlain(index)
      output.push(tokenMarkup('preview-token-string', text.slice(index, cursor)))
      index = cursor
      plainStart = cursor
      continue
    }
    if (character >= '0' && character <= '9' && (index === 0 || !/[\w$]/.test(text[index - 1]))) {
      let cursor = index + 1
      while (cursor < text.length && /[\w.]/.test(text[cursor])) cursor += 1
      flushPlain(index)
      output.push(tokenMarkup('preview-token-number', text.slice(index, cursor)))
      index = cursor
      plainStart = cursor
      continue
    }
    index += 1
  }
  flushPlain(text.length)
  return output.join('')
}

// N04: UTF-8 text only. A BOM is dropped; Notepad-style UTF-16 LE/BE text is
// decoded as well; a NUL byte otherwise marks the file as binary and the Quick
// Look falls back to the metadata card instead of mojibake.
function decodePreviewText(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || !buffer.length) return { binary: false, text: '' }
  const sliceFrom = (start) => (typeof buffer.subarray === 'function' ? buffer.subarray(start) : buffer.slice(start))
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { binary: false, text: sliceFrom(2).toString('utf16le') }
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const body = sliceFrom(2)
    const even = body.length - (body.length % 2)
    const swapped = Buffer.alloc(even)
    for (let index = 0; index < even; index += 2) {
      swapped[index] = body[index + 1]
      swapped[index + 1] = body[index]
    }
    return { binary: false, text: swapped.toString('utf16le') }
  }
  let start = 0
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) start = 3
  const slice = sliceFrom(start)
  if (slice.includes(0)) return { binary: true, text: '' }
  return { binary: false, text: slice.toString('utf8') }
}

// W5 (M2 step): the search window is hidden most of its life, so once it has been
// hidden for a minute it gives its renderer process back and is rebuilt on demand.
// `windowReleaseMs: 0` restores the old "hide and keep warm" behaviour.
const SEARCH_WINDOW_RELEASE_MS = 60000
// The retained query mirror is deliberately small and validated: it is restored
// into a fresh window, never written to settings.
const RESTORABLE_KEYWORD_MAX_LENGTH = 2048
// Keep in sync with search/search-utils.js SORT_OPTIONS (the renderer owns the
// labels; the main process only needs the persisted values).
const RESTORABLE_SORT_MODES = new Set([
  'modified-desc',
  'modified-asc',
  'name-asc',
  'name-desc',
  'path-asc',
  'path-desc',
  'size-asc',
  'size-desc'
])

function createSearchDomain(deps) {
  const {
    path,
    rootDirectory,
    screen,
    clipboard,
    nativeTheme,
    shell,
    BrowserWindow,
    createLocalWindow,
    getSettings,
    log,
    assertGameModeDisabled,
    isGameModeEnabled,
    getEverythingService,
    positionAutomationWindow,
    getSearchFileIcon,
    windowReleaseMs = SEARCH_WINDOW_RELEASE_MS,
    setTimer,
    clearTimer,
    now,
    // N04: optional seams used only by the unit test. Production passes neither:
    // the drag icon falls back to a lazy require('electron') and the Quick Look
    // limits fall back to the module defaults above.
    previewLimits = null,
    nativeImage = null
  } = deps

  let searchWindow = null
  // W5: the last state the renderer reported. Retained across a reclaim (that is
  // what makes the rebuilt window usable) but never persisted to settings.
  let lastSearchState = null
  const releaseTimeoutMs = Number.isFinite(Number(windowReleaseMs))
    ? Math.max(0, Number(windowReleaseMs))
    : SEARCH_WINDOW_RELEASE_MS
  const previewTextLimitBytes = resolvePreviewLimit(previewLimits?.textBytes, PREVIEW_TEXT_MAX_BYTES)
  const previewImageLimitBytes = resolvePreviewLimit(previewLimits?.imageBytes, PREVIEW_IMAGE_MAX_BYTES)
  const injectedNativeImage = nativeImage && typeof nativeImage.createFromDataURL === 'function' ? nativeImage : null

  function reclaimSearchWindow() {
    const win = searchWindow
    searchWindow = null
    if (!win || win.isDestroyed()) return false
    let destroyed = false
    try {
      win.destroy()
      destroyed = true
    } catch (error) {
      log('Search window reclaim failed:', error.message)
    }
    // The idle reclaimer already logs reclaim-fired/reclaim-skipped; this line
    // says what the domain did with the window (or why it could not).
    log('Search window reclaimed:', { destroyed, releaseMs: releaseTimeoutMs })
    return destroyed
  }

  const windowReclaimer = createIdleReclaimer({
    name: 'search-window',
    timeoutMs: releaseTimeoutMs,
    shouldReclaim: () => searchWindow != null && !searchWindow.isDestroyed() && !searchWindow.isVisible(),
    onReclaim: () => reclaimSearchWindow(),
    setTimer,
    clearTimer,
    now,
    log
  })

  function getRestorableCategoryIds(searchSettings) {
    const categories = Array.isArray(searchSettings?.categories) ? searchSettings.categories : []
    const ids = new Set(categories
      .filter((category) => category && typeof category.id === 'string' && category.id)
      .map((category) => category.id))
    if (!ids.size) ids.add('all')
    return ids
  }

  // Per-field validation: an out-of-range/unknown field is ignored instead of
  // throwing, and the previously retained value stays. Invalid payloads must not
  // be able to crash the main process through a renderer message.
  function sanitizeSearchState(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const searchSettings = (getSettings() || {}).search || {}
    const categoryIds = getRestorableCategoryIds(searchSettings)
    const next = {
      keyword: '',
      categoryId: categoryIds.has('all') ? 'all' : [...categoryIds][0],
      sortMode: RESTORABLE_SORT_MODES.has(searchSettings.sortMode) ? searchSettings.sortMode : 'modified-desc',
      matchPath: searchSettings.matchPath !== false,
      ...(lastSearchState || {})
    }
    let accepted = false
    if (typeof payload.keyword === 'string' && payload.keyword.length <= RESTORABLE_KEYWORD_MAX_LENGTH) {
      next.keyword = payload.keyword
      accepted = true
    }
    if (typeof payload.categoryId === 'string' && categoryIds.has(payload.categoryId)) {
      next.categoryId = payload.categoryId
      accepted = true
    }
    if (typeof payload.sortMode === 'string' && RESTORABLE_SORT_MODES.has(payload.sortMode)) {
      next.sortMode = payload.sortMode
      accepted = true
    }
    if (typeof payload.matchPath === 'boolean') {
      next.matchPath = payload.matchPath
      accepted = true
    }
    return accepted ? next : null
  }

  function hideAndScheduleRelease() {
    const win = searchWindow
    if (!win || win.isDestroyed()) return false
    if (win.isVisible()) win.hide()
    // Arming twice replaces the previous timer, so a repeated hide cannot stack
    // timers (and therefore cannot destroy the window twice).
    windowReclaimer.arm()
    return true
  }

  function ownsWindow(win) {
    return win != null && win === searchWindow
  }

  function getCurrentWindow() {
    return searchWindow
  }

  function getSearchWindowInitPayload() {
    const settings = getSettings()
    return {
      mainColor: settings.mainColor || '#e5a44c',
      dark: settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors),
      search: settings.search,
      // W5: a rebuilt window gets the query/category/sort back; `null` on a fresh
      // launch keeps the renderer's existing behaviour byte-for-byte.
      restore: lastSearchState ? { ...lastSearchState } : null
    }
  }

  function positionSearchWindow(win) {
    try {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const [width, height] = win.getSize()
      const area = display.workArea
      win.setPosition(
        Math.round(area.x + Math.max(0, (area.width - width) / 2)),
        Math.round(area.y + Math.max(0, (area.height - height) / 3)),
        false
      )
    } catch (error) {
      log('Search window positioning failed:', error.message)
    }
    positionAutomationWindow(win)
  }

  function showSearchWindow() {
    if (isGameModeEnabled()) return false
    // Any visible/open path cancels a pending release.
    windowReclaimer.disarm('search-window-shown')
    const win = searchWindow
    if (!win || win.isDestroyed()) return false
    win.webContents.send('search:init', getSearchWindowInitPayload())
    if (!win.isVisible()) win.show()
    win.focus()
    return true
  }

  function createSearchWindow() {
    assertGameModeDisabled()
    if (searchWindow && !searchWindow.isDestroyed()) {
      if (searchWindow.isVisible()) {
        hideAndScheduleRelease()
        return searchWindow
      }
      showSearchWindow()
      return searchWindow
    }
    const pagePath = path.join(rootDirectory, 'search', 'search.html')
    const win = createLocalWindow(pagePath, {
      role: 'search',
      width: 840,
      height: 620,
      minWidth: 620,
      minHeight: 420,
      frame: false,
      show: false,
      title: 'Highlighter 本地搜索',
      // The search shell cuts its own rounded corners, so the cut-outs show this
      // native colour: the shared --bg token, like every other window.
      backgroundColor: windowBackdropColor(getSettings(), nativeTheme),
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-search.js')
      }
    })
    searchWindow = trackWindowBackdrop(win)
    // A rebuilt window is created after a reclaim, so this payload carries the
    // retained query state (`restore`) for the renderer to apply.
    win._searchInit = getSearchWindowInitPayload()
    positionSearchWindow(win)
    win.loadFile(pagePath)
    win.on('blur', () => {
      if (searchWindow === win) hideAndScheduleRelease()
    })
    win.on('closed', () => {
      if (searchWindow === win) searchWindow = null
      windowReclaimer.disarm('search-window-closed')
    })
    return win
  }

  function hideSearchWindow() {
    return hideAndScheduleRelease()
  }

  function notifyStatusChanged(status) {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.webContents.send('search:status-changed', status)
    }
  }

  function notifySettingsChanged() {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.webContents.send('search:settings-changed', getSearchWindowInitPayload())
    }
  }

  async function openSearchTarget(target, { reveal = false } = {}) {
    const value = String(target || '').trim()
    if (!value || value.includes('\0') || !path.isAbsolute(value)) {
      throw new Error('无效的文件路径')
    }
    if (reveal) {
      shell.showItemInFolder(value)
      return { ok: true }
    }
    const result = await shell.openPath(value)
    if (result) throw new Error(result)
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // N04: Quick Look payloads. Every read happens here; the renderer only names a
  // result path it already displays, and invalid input is answered with
  // `{ ok: false }` instead of an exception so a stale selection cannot surface
  // an IPC error in the window.
  // -------------------------------------------------------------------------

  function normalizePreviewPath(target) {
    const value = String(target || '').trim()
    if (!value || value.includes('\0') || !path.isAbsolute(value)) return ''
    return value
  }

  function previewMetadata(filePath, stats) {
    return {
      name: path.basename(filePath),
      path: filePath,
      extension: previewExtension(filePath),
      size: Math.max(0, Number(stats?.size) || 0),
      modifiedAt: Number(stats?.mtimeMs) || 0
    }
  }

  async function readImagePreview(filePath, stats, metadata) {
    if (stats.size > previewImageLimitBytes) {
      return { ok: true, kind: 'info', reason: 'image-too-large', limitBytes: previewImageLimitBytes, ...metadata }
    }
    let buffer
    try {
      buffer = await fs.promises.readFile(filePath)
    } catch {
      return { ok: false, reason: 'unreadable', ...metadata }
    }
    if (!buffer.length) return { ok: true, kind: 'info', reason: 'empty', ...metadata }
    const mime = PREVIEW_IMAGE_TYPES.get(metadata.extension) || 'image/png'
    return { ok: true, kind: 'image', mime, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, ...metadata }
  }

  async function readTextPreview(filePath, stats, metadata, kind) {
    const truncatedFile = stats.size > previewTextLimitBytes
    let buffer
    if (truncatedFile) {
      // Only the preview window's share of an oversized file is read from disk;
      // Quick Look never pulls a multi-GB log into the main process.
      try {
        const handle = await fs.promises.open(filePath, 'r')
        try {
          const chunk = Buffer.alloc(previewTextLimitBytes)
          const { bytesRead } = await handle.read(chunk, 0, previewTextLimitBytes, 0)
          buffer = chunk.subarray(0, bytesRead)
        } finally {
          await handle.close()
        }
      } catch {
        return { ok: false, reason: 'unreadable', ...metadata }
      }
    } else {
      try {
        buffer = await fs.promises.readFile(filePath)
      } catch {
        return { ok: false, reason: 'unreadable', ...metadata }
      }
    }
    const decoded = decodePreviewText(buffer)
    if (decoded.binary) return { ok: true, kind: 'info', reason: 'binary', ...metadata }
    const normalized = decoded.text.replace(/\r\n?/g, '\n')
    if (!normalized.trim()) return { ok: true, kind: 'info', reason: 'empty', ...metadata }
    const capped = normalized.slice(0, PREVIEW_MAX_CHARACTERS)
    const truncated = truncatedFile || normalized.length > capped.length
    const base = { ok: true, truncated, limitBytes: previewTextLimitBytes, ...metadata }
    if (kind === 'json') {
      const formatted = formatPreviewJson(capped)
      const text = formatted.text.slice(0, PREVIEW_MAX_CHARACTERS)
      return { ...base, kind: 'json', formatted: formatted.formatted, text, truncated: truncated || formatted.text.length > text.length }
    }
    if (kind === 'markdown') {
      const rendered = renderMarkdownPreview(capped)
      return { ...base, kind: 'markdown', html: rendered.html, text: capped, truncated: truncated || rendered.truncated }
    }
    if (kind === 'code') {
      return { ...base, kind: 'code', html: highlightCodePreview(capped, { hashComments: previewUsesHashComments(filePath) }), text: capped }
    }
    return { ...base, kind: 'text', text: capped }
  }

  async function buildSearchPreview(target) {
    const filePath = normalizePreviewPath(target)
    if (!filePath) return { ok: false, reason: 'invalid-path' }
    let stats
    try {
      stats = await fs.promises.stat(filePath)
    } catch {
      return { ok: false, reason: 'missing', path: filePath }
    }
    const metadata = previewMetadata(filePath, stats)
    if (stats.isDirectory()) return { ok: true, kind: 'info', reason: 'directory', ...metadata }
    if (!stats.isFile()) return { ok: true, kind: 'info', reason: 'unsupported', ...metadata }
    const kind = classifyPreviewKind(filePath)
    if (kind === 'image') return readImagePreview(filePath, stats, metadata)
    if (kind === 'info') return { ok: true, kind: 'info', reason: 'unsupported', ...metadata }
    return readTextPreview(filePath, stats, metadata, kind)
  }

  // -------------------------------------------------------------------------
  // N04: native file drag. The renderer cancels the HTML5 drag and asks for
  // this, exactly like the documented Electron `startDrag` pattern; the main
  // process owns the path validation (real file, never a folder) and the icon.
  // The whole call is synchronous on purpose: `webContents.startDrag` has to run
  // inside the same IPC turn that the `dragstart` handler kicked off, so only a
  // single `statSync` is done here and the icon arrives already resolved.
  // -------------------------------------------------------------------------

  function resolveNativeImage() {
    if (injectedNativeImage) return injectedNativeImage
    try {
      const electron = require('electron')
      return electron && electron.nativeImage && typeof electron.nativeImage.createFromDataURL === 'function'
        ? electron.nativeImage
        : null
    } catch {
      return null
    }
  }

  function normalizeDragIcon(value) {
    if (typeof value !== 'string' || value.length > DRAG_ICON_MAX_CHARACTERS) return ''
    return DRAG_ICON_DATA_URL_PATTERN.test(value) ? value : ''
  }

  function dragIconFromDataUrl(dataUrl) {
    const api = resolveNativeImage()
    if (!api) return null
    try {
      let icon = api.createFromDataURL(dataUrl || DRAG_ICON_FALLBACK_DATA_URL)
      if (!icon || (typeof icon.isEmpty === 'function' && icon.isEmpty())) {
        icon = api.createFromDataURL(DRAG_ICON_FALLBACK_DATA_URL)
      }
      if (!icon) return null
      // The lookup returns the 16px shell icon; a 32px drag image matches what
      // Explorer and chat clients expect under the cursor.
      if (typeof icon.getSize === 'function' && typeof icon.resize === 'function') {
        const size = icon.getSize()
        if (size && Number(size.width) < 32) icon = icon.resize({ width: 32, height: 32, quality: 'best' })
      }
      return icon
    } catch {
      return null
    }
  }

  function startSearchFileDrag(event, payload) {
    try {
      const filePath = normalizePreviewPath(payload?.path)
      if (!filePath) return { ok: false }
      let stats
      try {
        stats = fs.statSync(filePath)
      } catch {
        return { ok: false }
      }
      if (!stats.isFile()) return { ok: false }
      const contents = event && event.sender
      if (!contents || typeof contents.startDrag !== 'function') return { ok: false }
      const icon = dragIconFromDataUrl(normalizeDragIcon(payload?.icon))
      contents.startDrag(icon ? { file: path.resolve(filePath), icon } : { file: path.resolve(filePath) })
      return { ok: true }
    } catch (error) {
      // Dragging out is a best-effort gesture: a failed start must stay silent
      // in the window (the result is still selectable/openable).
      log('Search drag start failed:', error.message)
      return { ok: false }
    }
  }

  function createSearchController() {
    return {
      ready: (event) => {
        const win = event.sender && BrowserWindow.fromWebContents(event.sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return
        // The payload is rebuilt on every ready so a window recreated after a
        // reclaim receives the retained `restore` state rather than a stale copy.
        windowReclaimer.disarm('search-window-ready')
        event.sender.send('search:init', getSearchWindowInitPayload())
        if (!win.isVisible()) win.show()
        win.focus()
      },
      close: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return
        hideAndScheduleRelease()
      },
      // W5: the renderer mirrors the query/category/sort through the preload, and
      // the domain retains it for the next rebuild. Only the search window may
      // write it; invalid fields are dropped without throwing.
      saveState: (event, payload) => {
        const sender = event && event.sender
        if (!sender) return false
        const win = BrowserWindow.fromWebContents(sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return false
        const next = sanitizeSearchState(payload)
        if (!next) return false
        lastSearchState = next
        return true
      },
      query: (_event, payload) => {
        const search = String(payload?.search ?? '')
        if (search.length > 2048) throw new Error('查询内容过长')
        return getEverythingService().query({
          search,
          maxResults: payload?.maxResults,
          sortMode: payload?.sortMode,
          matchPath: payload?.matchPath
        })
      },
      getStatus: () => getEverythingService().refreshStatus(),
      ensureReady: () => getEverythingService().ensureReady(),
      openPath: (_event, payload) => openSearchTarget(payload?.path),
      revealPath: (_event, payload) => openSearchTarget(payload?.path, { reveal: true }),
      copyPath: (_event, payload) => {
        const value = String(payload?.path || '')
        if (!value || value.includes('\0')) throw new Error('无效的文件路径')
        clipboard.writeText(value)
        return { ok: true }
      },
      // N04: the `search:file-icon` invoke doubles as the Quick Look read and the
      // native drag starter (see the note at the top of this file). An absent
      // `action` keeps the original shell-icon behaviour byte-for-byte.
      getFileIcon: (event, payload) => {
        const action = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.action : ''
        if (action === 'preview') return buildSearchPreview(payload?.path)
        if (action === 'drag') return startSearchFileDrag(event, payload)
        return getSearchFileIcon(payload?.path)
      }
    }
  }

  return {
    ownsWindow,
    getCurrentWindow,
    getLastSearchState: () => (lastSearchState ? { ...lastSearchState } : null),
    getSearchWindowInitPayload,
    createSearchWindow,
    showSearchWindow,
    hideSearchWindow,
    notifyStatusChanged,
    notifySettingsChanged,
    openSearchTarget,
    createSearchController
  }
}

module.exports = {
  createSearchDomain,
  // N04: exported so the Quick Look classifiers/renderers and the drag icon
  // fallback can be asserted behaviourally without an Electron process.
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MAX_CHARACTERS,
  PREVIEW_MARKDOWN_MAX_CHARACTERS,
  DRAG_ICON_FALLBACK_DATA_URL,
  classifyPreviewKind,
  previewUsesHashComments,
  formatPreviewJson,
  decodePreviewText,
  renderMarkdownPreview,
  highlightCodePreview
}
