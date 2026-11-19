const { formatSize, formatTime, buildQuery, planQueries, mergeQueryResults, renderHighlighted, extensionBadge, escapeHtml } = window.searchUtils

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
  resultStatus: document.getElementById('resultStatus')
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
  const extension = String(item.extension || '').toLowerCase()
  const cached = state.iconCache.get(extension)
  if (cached) return `<img src="${cached}" alt="">`
  return `<span class="ext-badge" data-ext="${escapeHtml(extension)}">${escapeHtml(extensionBadge(item.extension))}</span>`
}

function rowMarkup(item, index) {
  const nameHtml = renderHighlighted(item.name || '', state.keyword, item.highlightedName)
  const pathHtml = renderHighlighted(item.path || '', state.keyword, item.highlightedPath)
  const tabIndex = index === Math.max(0, state.activeIndex) ? 0 : -1
  return `<div class="result-row${index === state.activeIndex ? ' active' : ''}" role="group" aria-labelledby="result-name-${index}" aria-describedby="result-path-${index}" tabindex="${tabIndex}" data-index="${index}" data-ext="${escapeHtml(String(item.extension || '').toLowerCase())}">` +
    `<span class="file-icon">${iconMarkup(item)}</span>` +
    `<div class="row-main"><div class="row-name" id="result-name-${index}">${nameHtml}</div><div class="row-path" id="result-path-${index}">${pathHtml}</div></div>` +
    `<div class="row-meta"><span class="row-size">${escapeHtml(formatSize(item.size))}</span><span class="row-date">${escapeHtml(formatTime(item.modifiedAt))}</span></div>` +
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
}

async function loadIcons(items) {
  const pendingExtensions = new Map()
  for (const item of items) {
    const extension = String(item.extension || '').toLowerCase()
    if (!extension || state.iconCache.has(extension)) continue
    pendingExtensions.set(extension, item.fullPath)
  }
  for (const [extension, samplePath] of pendingExtensions) {
    if (state.iconCache.has(extension)) continue
    state.iconCache.set(extension, '')
    let dataUrl = null
    try {
      dataUrl = await searchAPI.getFileIcon(samplePath) || null
    } catch {
      dataUrl = null
    }
    state.iconCache.set(extension, dataUrl)
    if (dataUrl) {
      els.list.querySelectorAll(`.result-row[data-ext="${CSS.escape(extension)}"] .ext-badge`).forEach((badge) => {
        const parent = badge.parentElement
        if (!parent || !badge.isConnected) return
        parent.innerHTML = `<img src="${dataUrl}" alt="">`
      })
    }
  }
}

function runSearch({ debounced = false } = {}) {
  clearTimeout(searchTimer)
  searchTimer = null
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
    const merged = mergeQueryResults(fulfilled)
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
    searchAPI.close()
    return
  }
  if (event.target === els.input || event.target === els.sort || event.target === els.matchPath) return
  if (event.key === ' ' && event.target.closest?.('button')) return
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
})
searchAPI.ready()
// W5: only the first init of this renderer applies `restore` (a window that is
// merely reshown gets a fresh init for appearance/settings, and replaying the
// mirror then would clobber newer typing that has not reached the main process).
let restoreApplied = false
searchAPI.onInit((payload) => {
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
