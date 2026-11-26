const { formatSize, formatTime, buildQuery, planQueries, mergeQueryResults, renderHighlighted, extensionBadge, escapeHtml, iconCacheKey, isFolderItem } = window.searchUtils

// P0-1-T5 (S12): `shared/i18n.js` is a classic script, so its `t`, `setLanguage`
// and `applyTranslations` bindings are already visible here. They must NOT be
// re-declared (the runtime's top-level `const`s share this script's global
// lexical scope, so destructuring them from `window` throws).

const els = {
  input: document.getElementById('searchInput'),
  clear: document.getElementById('clearInput'),
  close: document.getElementById('closeWindow'),
  tabs: document.getElementById('categoryTabs'),
  list: document.getElementById('resultList'),
  empty: document.getElementById('emptyState'),
  status: document.getElementById('statusText'),
  matchPath: document.getElementById('matchPathToggle'),
  sort: document.getElementById('sortSelect'),
  count: document.getElementById('countText'),
  resultStatus: document.getElementById('resultStatus'),
  // N04 (review report section 5.4): the Space Quick Look overlay.
  quickLook: document.getElementById('quickLook'),
  quickLookIcon: document.getElementById('quickLookIcon'),
  quickLookTitle: document.getElementById('quickLookTitle'),
  quickLookPath: document.getElementById('quickLookPath'),
  quickLookMeta: document.getElementById('quickLookMeta'),
  quickLookBody: document.getElementById('quickLookBody'),
  quickLookClose: document.getElementById('quickLookClose')
}

const state = {
  settings: { maxResults: 600, pageSize: 30, sortMode: 'modified-desc', matchPath: true },
  categories: [],
  activeCategoryId: 'all',
  keyword: '',
  results: [],
  total: 0,
  visibleCount: 0,
  activeIndex: -1,
  seq: 0,
  searching: false,
  searchError: null,
  ready: false,
  iconCache: new Map()
}

const SEARCH_DEBOUNCE_MS = 60

// N04 (review report section 5.4): Space opens an in-window Quick Look for the
// active result. The overlay is read-only and never takes focus, so the search
// box keeps receiving keystrokes; arrow keys move the selection and the preview
// follows it. The file is read by the main process - the renderer only sends the
// path of a result it already displays.
const quickLook = {
  open: false,
  token: 0,
  item: null,
  payload: null
}

// U04 (review report section 4.4 item 7): a folder result has an empty extension, which
// used to render as the "?" extension badge. The Everything sidecar requests the
// file attributes and reports `isFolder`, so folders get a folder glyph instead of
// an icon request (their shell icon is the same for every directory anyway).
const FOLDER_ICON_MARKUP = '<svg class="folder-icon" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--primary-text);opacity:.85" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l1.7 1.8h7.3a2 2 0 0 1 2 2v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>'

// W5 (M2): mirror the user's query state to the main process. The search window
// is destroyed after being hidden for a minute and rebuilt on demand, so the
// main process replays this snapshot into the new window. The 300ms debounce
// keeps typing from spamming IPC and still lands long before the reclaim timer.
const SAVE_STATE_DEBOUNCE_MS = 300

function debounce(fn, delay) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

let searchTimer = null

function currentSearchState() {
  return {
    keyword: els.input.value,
    categoryId: state.activeCategoryId,
    sortMode: state.settings.sortMode,
    matchPath: !!state.settings.matchPath
  }
}

function saveSearchState() {
  try {
    searchAPI.saveState(currentSearchState())
  } catch {
    // A closing window must not surface an IPC error in the renderer.
  }
}

const saveSearchStateDebounced = debounce(saveSearchState, SAVE_STATE_DEBOUNCE_MS)

function applyAppearance(payload) {
  document.documentElement.style.setProperty('--primary', payload.mainColor || '#e5a44c')
  document.body.classList.toggle('dark', !!payload.dark)
}

function applySettings(searchSettings) {
  state.settings = { ...state.settings, ...searchSettings }
  state.categories = Array.isArray(state.settings.categories) && state.settings.categories.length
    ? state.settings.categories
    : window.searchUtils.DEFAULT_CATEGORIES.map((category) => ({ ...category }))
  if (!state.categories.some((category) => category.id === state.activeCategoryId)) {
    state.activeCategoryId = state.categories[0]?.id || 'all'
  }
  state.settings.sortMode = state.settings.sortMode || 'modified-desc'
  els.matchPath.checked = !!state.settings.matchPath
  renderSortOptions()
  renderTabs()
}

// W5: a rebuilt window starts from `restore` instead of the empty shell. Every
// field is re-validated against the settings that were just loaded, and an
// absent restore is a no-op (fresh launch behaviour is unchanged).
function applyRestore(restore) {
  if (!restore || typeof restore !== 'object') return
  if (typeof restore.keyword === 'string' && restore.keyword.length <= 2048) {
    els.input.value = restore.keyword
    els.clear.hidden = !restore.keyword
    state.keyword = restore.keyword
  }
  if (typeof restore.categoryId === 'string' && state.categories.some((category) => category.id === restore.categoryId)) {
    state.activeCategoryId = restore.categoryId
  }
  if (typeof restore.sortMode === 'string' && window.searchUtils.SORT_OPTIONS.some(([value]) => value === restore.sortMode)) {
    state.settings.sortMode = restore.sortMode
  }
  if (typeof restore.matchPath === 'boolean') {
    state.settings.matchPath = restore.matchPath
    els.matchPath.checked = restore.matchPath
  }
  renderTabs()
  renderSortOptions()
  if (restore.keyword) runSearch()
}

function renderSortOptions() {
  const options = window.searchUtils.SORT_OPTIONS
  // P0-1-T5 (S12): the label half of each pair is an i18n key.
  els.sort.innerHTML = options.map(([value, label]) => `<option value="${value}">${escapeHtml(t(label))}</option>`).join('')
  els.sort.value = state.settings.sortMode
}

function renderTabs() {
  const focusedId = els.tabs.contains(document.activeElement) ? document.activeElement.dataset.id : null
  els.tabs.innerHTML = state.categories.map((category) => (
    `<button class="category-tab" type="button" data-id="${escapeHtml(category.id)}">${escapeHtml(t(category.label))}</button>`
  )).join('')
  updateCategorySelection()
  if (focusedId !== null) {
    const focused = [...els.tabs.children].find((tab) => tab.dataset.id === focusedId) || els.tabs.querySelector('.active')
    focused?.focus()
  }
}

function updateCategorySelection() {
  for (const tab of els.tabs.children) {
    const selected = tab.dataset.id === state.activeCategoryId
    tab.classList.toggle('active', selected)
    tab.setAttribute('aria-pressed', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
}

function getActiveCategory() {
  // A user-defined category keeps its own free-text label; `t()` returns an
  // unknown key verbatim, so both kinds resolve through the same call.
  return state.categories.find((category) => category.id === state.activeCategoryId)
    || state.categories[0]
    || { id: 'all', label: 'search.category.fallback', rule: '' }
}

// P0-1-T2/T5: the last status payload is retained so a language switch can
// re-render the footer line in place. `status.message` arrives already resolved
// in the main-process language (main/services/everything-service.js), so
// re-running renderStatus() only helps because the payload also carries the key
// (`messageKey`) it was resolved from; the shared runtime resolves that key
// against the language the window just switched to.
let lastStatus = null

function renderStatus(status) {
  if (status) lastStatus = status
  const current = lastStatus
  if (!current) return
  state.ready = current.phase === 'ready'
  els.status.classList.toggle('is-error', current.phase === 'error')
  let text = (typeof current.messageKey === 'string' && current.messageKey)
    ? t(current.messageKey)
    : (current.message || t('search.status.detecting'))
  if (current.phase === 'ready') {
    text = current.version
      ? t('search.status.ready-version', { version: current.version })
      : t('search.status.ready')
    if (Number(current.probeTotal) === 0) {
      text += t('search.status.index-empty')
    }
  }
  els.status.textContent = text
  els.status.title = text
}

function updateEmptyState() {
  let message = ''
  if (!state.keyword.trim()) message = t('search.empty.prompt')
  else if (state.searching) message = t('search.empty.searching')
  else if (state.searchError) message = errorMessage(state.searchError)
  else if (!state.results.length) message = t('search.empty.no-results')
  if (els.empty.textContent !== message) els.empty.textContent = message
  els.empty.classList.toggle('is-error', Boolean(state.searchError))
}

function updateCount() {
  const text = state.total || state.results.length
    ? t('search.count.loaded', { loaded: state.results.length, total: state.total })
    : ''
  if (els.count.textContent !== text) els.count.textContent = text
}

function iconMarkup(item) {
  if (isFolderItem(item)) return FOLDER_ICON_MARKUP
  const extension = String(item.extension || '').toLowerCase()
  const cacheKey = iconCacheKey(item)
  const cached = cacheKey ? state.iconCache.get(cacheKey) : ''
  if (cached) return `<img src="${cached}" alt="">`
  return `<span class="ext-badge" data-ext="${escapeHtml(extension)}">${escapeHtml(extensionBadge(item.extension))}</span>`
}

// U04: path-keyed icons can be much more numerous than one-per-extension ones, so
// the renderer keeps the same bound the main-process lookup uses and evicts the
// oldest entry (re-requesting an evicted icon only costs one IPC round trip).
const ICON_CACHE_LIMIT = 256

function rememberIcon(cacheKey, dataUrl) {
  state.iconCache.set(cacheKey, dataUrl)
  while (state.iconCache.size > ICON_CACHE_LIMIT) {
    state.iconCache.delete(state.iconCache.keys().next().value)
  }
}

function rowMarkup(item, index) {
  const nameHtml = renderHighlighted(item.name || '', state.keyword, item.highlightedName)
  const pathHtml = renderHighlighted(item.path || '', state.keyword, item.highlightedPath)
  const tabIndex = index === Math.max(0, state.activeIndex) ? 0 : -1
  // U04: Everything reports U64_MAX as the size of a directory; a folder row shows
  // no size instead of an absurd "16777216.0 TB".
  // `data-icon-key` is the cache key the (possibly asynchronous) icon lands under,
  // so a result row can be patched without re-rendering the whole list.
  return `<div class="result-row${index === state.activeIndex ? ' active' : ''}" role="group" aria-labelledby="result-name-${index}" aria-describedby="result-path-${index}" tabindex="${tabIndex}" data-index="${index}" data-ext="${escapeHtml(String(item.extension || '').toLowerCase())}" data-icon-key="${escapeHtml(iconCacheKey(item))}" data-folder="${isFolderItem(item) ? 'true' : 'false'}" draggable="${isFolderItem(item) ? 'false' : 'true'}">` +
    `<span class="file-icon">${iconMarkup(item)}</span>` +
    `<div class="row-main"><div class="row-name" id="result-name-${index}">${nameHtml}</div><div class="row-path" id="result-path-${index}">${pathHtml}</div></div>` +
    `<div class="row-meta"><span class="row-size">${escapeHtml(formatSize(isFolderItem(item) ? 0 : item.size))}</span><span class="row-date">${escapeHtml(formatTime(item.modifiedAt))}</span></div>` +
    `<div class="row-actions">` +
    `<button type="button" data-act="reveal" tabindex="${tabIndex}">${escapeHtml(t('search.action.reveal'))}</button>` +
    `<button type="button" data-act="copy" tabindex="${tabIndex}">${escapeHtml(t('search.action.copy-path'))}</button>` +
    `</div></div>`
}

function renderResults(startIndex = 0) {
  const items = state.results.slice(startIndex, state.visibleCount)
  const html = items.map((item, offset) => rowMarkup(item, startIndex + offset)).join('')
  if (startIndex > 0) els.list.insertAdjacentHTML('beforeend', html)
  else if (html) els.list.innerHTML = html
  else els.list.replaceChildren()
  els.list.setAttribute('aria-busy', String(state.searching))
  updateEmptyState()
  updateCount()
  const announcement = !state.searching && state.keyword.trim() ? els.count.textContent || els.empty.textContent : ''
  if (els.resultStatus.textContent !== announcement) els.resultStatus.textContent = announcement
  void loadIcons(items)
}

function setActiveIndex(index, { scroll = true, focus = false } = {}) {
  if (!state.visibleCount) return
  const clamped = Math.max(0, Math.min(index, state.visibleCount - 1))
  const row = els.list.children[clamped]
  if (clamped !== state.activeIndex) {
    const previous = els.list.children[Math.max(0, state.activeIndex)]
    previous.classList.remove('active')
    previous.tabIndex = -1
    for (const button of previous.querySelectorAll('button')) button.tabIndex = -1
    state.activeIndex = clamped
    row.classList.add('active')
    row.tabIndex = 0
    for (const button of row.querySelectorAll('button')) button.tabIndex = 0
  }
  if (focus) row.focus({ preventScroll: true })
  if (scroll) row.scrollIntoView({ block: 'nearest' })
  // N04: ↑/↓ retargets the open preview without closing it.
  if (quickLook.open) syncQuickLook()
}

// ---------------------------------------------------------------------------
// N04: Space Quick Look
// ---------------------------------------------------------------------------

function quickLookItem() {
  return state.activeIndex >= 0 ? state.results[state.activeIndex] || null : null
}

function quickLookInfoMarkup(payload, item) {
  const rows = [
    [t('search.preview.name'), payload.name || item.name || ''],
    [t('search.preview.path'), payload.path || item.fullPath || item.path || ''],
    [t('search.preview.size'), formatSize(payload.size) || '—'],
    [t('search.preview.modified'), formatTime(payload.modifiedAt || item.modifiedAt) || '—']
  ]
  return `<dl class="quick-look-info" aria-label="${escapeHtml(t('search.preview.info-title'))}">${rows.map(([label, value]) => (
    `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
  )).join('')}</dl>`
}

function quickLookReasonText(payload) {
  switch (payload.reason) {
    case 'directory': return t('search.preview.directory')
    case 'binary': return t('search.preview.binary')
    case 'empty': return t('search.preview.empty')
    case 'unsupported': return t('search.preview.unsupported')
    case 'image-too-large': return t('search.preview.image-too-large', { size: formatSize(payload.limitBytes) })
    default: return t('search.preview.unavailable')
  }
}

function appendQuickLookNote(body, text, className = 'quick-look-note') {
  const note = document.createElement('div')
  note.className = className
  note.textContent = text
  body.append(note)
}

function appendQuickLookTruncated(body, payload) {
  if (!payload || payload.truncated !== true || !payload.limitBytes) return
  appendQuickLookNote(body, t('search.preview.truncated', { size: formatSize(payload.limitBytes) }), 'quick-look-truncated')
}

function appendQuickLookPre(body, { html = '', text = '' }) {
  const pre = document.createElement('pre')
  pre.className = 'quick-look-pre'
  const code = document.createElement('code')
  // `html` is produced and escaped by the main-process renderers; `text` goes
  // through textContent so a plain file can never inject markup.
  if (html) code.innerHTML = html
  else code.textContent = text
  pre.append(code)
  body.append(pre)
}

function paintQuickLook(item, payload) {
  quickLook.item = item
  quickLook.payload = payload
  const body = els.quickLookBody
  els.quickLookTitle.textContent = payload?.name || item.name || item.fullPath || ''
  els.quickLookPath.textContent = payload?.path || item.fullPath || item.path || ''
  els.quickLookIcon.innerHTML = iconMarkup(item)
  const meta = []
  if (payload && payload.size > 0 && payload.reason !== 'directory') meta.push(formatSize(payload.size))
  const modified = formatTime(payload?.modifiedAt || item.modifiedAt)
  if (modified) meta.push(modified)
  els.quickLookMeta.textContent = meta.join(' · ')
  body.replaceChildren()
  body.dataset.kind = payload?.kind || 'info'
  if (!payload || payload.ok === false) {
    body.dataset.state = 'failed'
    appendQuickLookNote(body, t('search.preview.unavailable'))
    return
  }
  body.dataset.state = 'ready'
  if (payload.kind === 'image' && payload.dataUrl) {
    body.dataset.state = 'image'
    const image = document.createElement('img')
    image.className = 'quick-look-image'
    image.alt = ''
    image.addEventListener('error', () => {
      if (!quickLook.open || quickLook.payload !== payload) return
      body.dataset.state = 'failed'
      body.dataset.kind = 'info'
      body.replaceChildren()
      appendQuickLookNote(body, t('search.preview.unavailable'))
    })
    image.src = payload.dataUrl
    body.append(image)
    return
  }
  if (payload.kind === 'markdown') {
    const article = document.createElement('div')
    article.className = 'quick-look-markdown'
    article.innerHTML = payload.html || ''
    body.append(article)
    appendQuickLookTruncated(body, payload)
    return
  }
  if (payload.kind === 'code') {
    appendQuickLookPre(body, { html: payload.html || '' })
    appendQuickLookTruncated(body, payload)
    return
  }
  if (payload.kind === 'json') {
    appendQuickLookPre(body, { text: payload.text || '' })
    // N04: a file named .json that does not parse is still worth reading; say so
    // instead of rendering a formatter failure.
    if (payload.formatted === false) appendQuickLookNote(body, t('search.preview.json-invalid'), 'quick-look-truncated')
    appendQuickLookTruncated(body, payload)
    return
  }
  if (payload.kind === 'text') {
    appendQuickLookPre(body, { text: payload.text || '' })
    appendQuickLookTruncated(body, payload)
    return
  }
  // Folders, binaries, unsupported types and empty files: the metadata card is
  // the preview.
  appendQuickLookNote(body, quickLookReasonText(payload))
  const info = document.createElement('div')
  info.innerHTML = quickLookInfoMarkup(payload, item)
  body.append(info)
}

function requestQuickLook(item) {
  const token = ++quickLook.token
  quickLook.item = item
  quickLook.payload = null
  els.quickLookTitle.textContent = item.name || item.fullPath || ''
  els.quickLookPath.textContent = item.fullPath || item.path || ''
  els.quickLookIcon.innerHTML = iconMarkup(item)
  els.quickLookMeta.textContent = ''
  const body = els.quickLookBody
  body.replaceChildren()
  body.dataset.state = 'loading'
  body.dataset.kind = 'info'
  appendQuickLookNote(body, t('search.preview.loading'))
  let request
  try {
    request = searchAPI.previewFile(item.fullPath)
  } catch (error) {
    request = Promise.reject(error)
  }
  Promise.resolve(request).then((payload) => {
    if (!quickLook.open || token !== quickLook.token) return
    paintQuickLook(item, payload)
  }).catch(() => {
    if (!quickLook.open || token !== quickLook.token) return
    paintQuickLook(item, { ok: false })
  })
}

function openQuickLook(item) {
  if (!item || !item.fullPath) return false
  quickLook.open = true
  els.quickLook.hidden = false
  requestQuickLook(item)
  return true
}

function closeQuickLook({ restoreFocus = false } = {}) {
  quickLook.open = false
  quickLook.token += 1
  quickLook.item = null
  quickLook.payload = null
  els.quickLook.hidden = true
  els.quickLookBody.replaceChildren()
  els.quickLookBody.dataset.state = 'idle'
  els.quickLookBody.dataset.kind = ''
  els.quickLookMeta.textContent = ''
  els.quickLookTitle.textContent = ''
  els.quickLookPath.textContent = ''
  els.quickLookIcon.replaceChildren()
  if (restoreFocus) els.input.focus()
}

// Keeps the open preview pointed at the current selection. Called from
// setActiveIndex and after a re-render that may not have changed the selection.
function syncQuickLook() {
  if (!quickLook.open) return
  const item = quickLookItem()
  if (!item) {
    closeQuickLook({ restoreFocus: false })
    return
  }
  if (quickLook.item === item) return
  requestQuickLook(item)
}

async function loadIcons(items) {
  // U04 (review report section 4.4 item 7): the cache key comes from search-utils
  // (`iconCacheKey`). Executables/shortcuts/icons are keyed by full path so two
  // files with the same name in different folders no longer overwrite each
  // other's icon; document types keep the cheaper per-extension icon.
  const pendingKeys = new Map()
  for (const item of items) {
    const cacheKey = iconCacheKey(item)
    if (!cacheKey || state.iconCache.has(cacheKey)) continue
    if (!pendingKeys.has(cacheKey)) pendingKeys.set(cacheKey, item.fullPath)
  }
  for (const [cacheKey, samplePath] of pendingKeys) {
    if (state.iconCache.has(cacheKey)) continue
    // Reserve the key so the same icon is requested once even if the list is
    // rendered again while the request is in flight (`''` means "not loaded").
    state.iconCache.set(cacheKey, '')
    let dataUrl = null
    try {
      dataUrl = await searchAPI.getFileIcon(samplePath) || null
    } catch {
      dataUrl = null
    }
    rememberIcon(cacheKey, dataUrl)
    if (!dataUrl) continue
    for (const row of els.list.children) {
      if (row.dataset.iconKey !== cacheKey) continue
      const icon = row.querySelector('.file-icon')
      if (!icon || !icon.isConnected) continue
      icon.innerHTML = `<img src="${dataUrl}" alt="">`
    }
  }
}

function runSearch({ debounced = false } = {}) {
  clearTimeout(searchTimer)
  searchTimer = null
  // N04: a new query retires the row the Quick Look was showing.
  if (quickLook.open) closeQuickLook()
  const keyword = els.input.value
  const seq = ++state.seq
  state.keyword = keyword
  state.activeIndex = -1
  state.searchError = null
  state.results = []
  state.total = 0
  state.visibleCount = 0
  state.searching = Boolean(keyword.trim())
  renderResults()
  if (!state.searching) return
  if (debounced) {
    searchTimer = setTimeout(() => {
      searchTimer = null
      void requestSearch(keyword, seq)
    }, SEARCH_DEBOUNCE_MS)
  } else {
    void requestSearch(keyword, seq)
  }
}

async function requestSearch(keyword, seq) {
  const category = getActiveCategory()
  const queries = planQueries(keyword, !!state.settings.matchPath).map((plan) => ({
    search: buildQuery(plan.keyword, category.rule),
    matchPath: plan.matchPath
  }))
  const settled = await Promise.allSettled(queries.map((query) => searchAPI.query({
    search: query.search,
    matchPath: query.matchPath,
    maxResults: state.settings.maxResults,
    sortMode: state.settings.sortMode
  })))
  if (seq !== state.seq) return
  state.searching = false
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value)
  if (fulfilled.length) {
    // U04 (review report section 4.4 item 7): the two match-path batches arrive sorted
    // individually; the merged list is re-sorted with the user's sortMode so the
    // order does not break at the batch boundary.
    const merged = mergeQueryResults(fulfilled, state.settings.sortMode)
    state.results = merged.items
    state.total = merged.total
    state.visibleCount = Math.min(state.results.length, state.settings.pageSize)
  } else {
    state.searchError = settled.find((entry) => entry.status === 'rejected')?.reason || t('search.error.query-failed')
  }
  renderResults()
}

function errorMessage(error) {
  return String(error?.message || error || t('search.error.query-failed')).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function extendResults() {
  if (state.visibleCount >= state.results.length) return
  const startIndex = state.visibleCount
  state.visibleCount = Math.min(startIndex + state.settings.pageSize, state.results.length)
  renderResults(startIndex)
}

function moveResultSelection(event, currentIndex = state.activeIndex) {
  const offset = event.key === 'ArrowDown' ? 1 : -1
  const index = Math.max(0, currentIndex + offset)
  if (index >= state.visibleCount) extendResults()
  if (index >= state.visibleCount || index === currentIndex) return
  event.preventDefault()
  setActiveIndex(index, { focus: event.target !== els.input })
}

function activateRow(index, { reveal = false } = {}) {
  const item = state.results[index]
  if (!item) return
  if (reveal) searchAPI.revealPath(item.fullPath).catch(() => {})
  else searchAPI.openPath(item.fullPath).catch(() => {})
}

els.input.addEventListener('input', () => {
  els.clear.hidden = !els.input.value
  runSearch({ debounced: true })
  saveSearchStateDebounced()
})

els.input.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    moveResultSelection(event)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const index = state.activeIndex >= 0 ? state.activeIndex : (state.visibleCount > 0 ? 0 : -1)
    if (index >= 0) {
      setActiveIndex(index)
      activateRow(index, { reveal: event.ctrlKey })
    }
  }
})

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    // N04: the preview is the innermost layer, so Escape closes it first.
    if (quickLook.open) {
      closeQuickLook()
      return
    }
    searchAPI.close()
    return
  }
  if (event.key === ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    // Buttons, selects and the footer checkbox keep their native Space action
    // (clicking the focused control); the search box and a focused result row
    // toggle the preview instead.
    if (event.target.closest?.('button, select, input:not(#searchInput)')) return
    if (quickLook.open) {
      event.preventDefault()
      closeQuickLook()
      return
    }
    const item = quickLookItem()
    // With no selected result, Space must stay a normal space in the query.
    if (!item) return
    event.preventDefault()
    openQuickLook(item)
    return
  }
  if (event.target === els.input || event.target === els.sort || event.target === els.matchPath) return
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    els.input.focus()
  }
})

els.list.addEventListener('scroll', () => {
  const nearBottom = els.list.scrollTop + els.list.clientHeight >= els.list.scrollHeight - 120
  if (nearBottom) extendResults()
})

els.list.addEventListener('focusin', (event) => {
  const row = event.target.closest('.result-row')
  if (row) setActiveIndex(Number(row.dataset.index), { scroll: false })
})

els.list.addEventListener('keydown', (event) => {
  if (!event.target.matches('.result-row') || event.isComposing || event.keyCode === 229) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') moveResultSelection(event, Number(event.target.dataset.index))
  else if (event.key === 'Enter') {
    event.preventDefault()
    activateRow(Number(event.target.dataset.index), { reveal: event.ctrlKey })
  }
})

els.list.addEventListener('click', (event) => {
  const row = event.target.closest('.result-row')
  if (!row) return
  const index = Number(row.dataset.index)
  const actionButton = event.target.closest('.row-actions button')
  if (actionButton) {
    const item = state.results[index]
    if (!item) return
    if (actionButton.dataset.act === 'reveal') activateRow(index, { reveal: true })
    else searchAPI.copyPath(item.fullPath).catch(() => {})
    return
  }
  setActiveIndex(index)
})

els.list.addEventListener('dblclick', (event) => {
  if (event.target.closest('.row-actions')) return
  const row = event.target.closest('.result-row')
  if (!row) return
  activateRow(Number(row.dataset.index))
})

// N04 (review report section 5.4): dragging a result out is a native operation.
// Exactly like the documented Electron pattern, the renderer cancels Chromium's
// HTML5 drag and asks the main process to start the real one with the file's own
// icon. Folders are not draggable (their rows render draggable="false"), and a
// drag that cannot start fails silently - the row stays fully usable.
els.list.addEventListener('dragstart', (event) => {
  event.preventDefault()
  const row = event.target.closest?.('.result-row')
  if (!row) return
  const item = state.results[Number(row.dataset.index)]
  if (!item || isFolderItem(item) || !item.fullPath) return
  // The row icon is already the file-icon-lookup result; handing it back keeps
  // the main-process startDrag call synchronous (an empty value = placeholder).
  const cacheKey = iconCacheKey(item)
  const icon = cacheKey ? state.iconCache.get(cacheKey) || '' : ''
  try {
    searchAPI.startDrag(item.fullPath, icon).catch(() => {})
  } catch {
    // No native drag is a no-op, never an error in the window.
  }
})

els.quickLookClose.addEventListener('click', () => closeQuickLook({ restoreFocus: true }))

els.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.category-tab')
  if (!tab || tab.dataset.id === state.activeCategoryId) return
  state.activeCategoryId = tab.dataset.id
  updateCategorySelection()
  saveSearchState()
  runSearch()
})

els.tabs.addEventListener('keydown', (event) => {
  const tab = event.target.closest('.category-tab')
  if (!tab || event.isComposing || event.keyCode === 229) return
  const tabs = [...els.tabs.children]
  const index = tabs.indexOf(tab)
  let next
  switch (event.key) {
    case 'ArrowLeft': next = tabs[(index - 1 + tabs.length) % tabs.length]; break
    case 'ArrowRight': next = tabs[(index + 1) % tabs.length]; break
    case 'Home': next = tabs[0]; break
    case 'End': next = tabs.at(-1); break
    default: return
  }
  event.preventDefault()
  next.focus()
  next.click()
})

els.clear.addEventListener('click', () => {
  els.input.value = ''
  els.clear.hidden = true
  els.input.focus()
  runSearch()
})

els.close.addEventListener('click', () => searchAPI.close())

els.matchPath.addEventListener('change', () => {
  state.settings.matchPath = els.matchPath.checked
  searchAPI.savePrefs({ search: { matchPath: els.matchPath.checked } }).catch(() => {})
  saveSearchState()
  runSearch()
})

els.sort.addEventListener('change', () => {
  state.settings.sortMode = els.sort.value
  searchAPI.savePrefs({ search: { sortMode: els.sort.value } }).catch(() => {})
  saveSearchState()
  runSearch()
})

// A hide can happen before the debounce fires (blur closes the window), so flush
// the mirror on blur as well; the reclaim itself is at least a minute away.
window.addEventListener('blur', saveSearchState)

// P0-1-T2/T5: the initial pass translates the markup; the broadcast subscription
// re-renders everything the script owns (tabs, sort options, result rows, the
// empty state and the status line) in the newly selected language. The status
// line has a `data-i18n` marker, so applyTranslations() rewrites it to the static
// "detecting" copy and renderStatus() has to run after it to restore the real
// state — re-resolved from the retained key.
applyTranslations()
window.searchAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
  renderStatus()
  renderTabs()
  renderSortOptions()
  renderResults()
  // N04: the overlay's metadata card and reason line are language-bound; repaint
  // it in place so an open preview follows the switch like the rest of the window.
  if (quickLook.open && quickLook.item && quickLook.payload) paintQuickLook(quickLook.item, quickLook.payload)
})
searchAPI.ready()
// W5: only the first init of this renderer applies `restore` (a window that is
// merely reshown gets a fresh init for appearance/settings, and replaying the
// mirror then would clobber newer typing that has not reached the main process).
let restoreApplied = false
searchAPI.onInit((payload) => {
  // N04: the window is hidden on blur and rebuilt later; a preview from the
  // previous visible session must not survive the show.
  closeQuickLook()
  applyAppearance(payload)
  applySettings(payload.search || {})
  if (!restoreApplied) {
    restoreApplied = true
    applyRestore(payload.restore)
  }
  els.input.focus()
  searchAPI.ensureReady().then(renderStatus).catch(() => searchAPI.getStatus().then(renderStatus).catch(() => {}))
})
searchAPI.onStatusChanged(renderStatus)
searchAPI.onSettingsChanged((payload) => {
  applySettings(payload.search || {})
  applyAppearance(payload)
})
