const { formatSize, formatTime, buildQuery, planQueries, mergeQueryResults, renderHighlighted, extensionBadge, escapeHtml } = window.searchUtils

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
  count: document.getElementById('countText')
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
  ready: false,
  iconCache: new Map(),
  iconPending: new Set()
}

const SEARCH_DEBOUNCE_MS = 60

function debounce(fn, delay) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

const runSearchDebounced = debounce(() => runSearch(), SEARCH_DEBOUNCE_MS)

function applyAppearance(payload) {
  document.documentElement.style.setProperty('--primary', payload.mainColor || '#1677ff')
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

function renderSortOptions() {
  const options = window.searchUtils.SORT_OPTIONS
  els.sort.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
  els.sort.value = state.settings.sortMode
}

function renderTabs() {
  els.tabs.innerHTML = state.categories.map((category) => (
    `<button class="category-tab${category.id === state.activeCategoryId ? ' active' : ''}" data-id="${escapeHtml(category.id)}">${escapeHtml(category.label)}</button>`
  )).join('')
}

function getActiveCategory() {
  return state.categories.find((category) => category.id === state.activeCategoryId) || state.categories[0] || { id: 'all', label: '全部', rule: '' }
}

function renderStatus(status) {
  if (!status) return
  state.ready = status.phase === 'ready'
  els.status.classList.toggle('is-error', status.phase === 'error')
  let text = status.message || '正在检测 Everything...'
  if (status.phase === 'ready') {
    text = `Everything 已就绪${status.version ? ` · v${status.version}` : ''}`
    if (Number(status.probeTotal) === 0) {
      text += ' · 索引暂无内容（可能需要以管理员身份运行 Everything 或安装 Everything 服务）'
    }
  }
  els.status.textContent = text
  els.status.title = text
}

function updateEmptyState(message) {
  if (message) {
    els.empty.innerHTML = `<span class="empty-error">${escapeHtml(message)}</span>`
    els.empty.hidden = false
    return
  }
  if (!state.keyword.trim()) {
    els.empty.textContent = '输入关键字开始搜索'
    els.empty.hidden = false
    return
  }
  if (state.searching) {
    els.empty.textContent = '正在搜索...'
    els.empty.hidden = false
    return
  }
  if (!state.results.length) {
    els.empty.textContent = '没有找到结果'
    els.empty.hidden = false
    return
  }
  els.empty.hidden = true
}

function updateCount() {
  if (!state.total && !state.results.length) {
    els.count.textContent = ''
    return
  }
  els.count.textContent = `已加载 ${state.results.length} / 共 ${state.total} 条结果`
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
  return `<div class="result-row${index === state.activeIndex ? ' active' : ''}" data-index="${index}" data-ext="${escapeHtml(String(item.extension || '').toLowerCase())}">` +
    `<span class="file-icon">${iconMarkup(item)}</span>` +
    `<div class="row-main"><div class="row-name">${nameHtml}</div><div class="row-path">${pathHtml}</div></div>` +
    `<div class="row-meta"><span class="row-size">${escapeHtml(formatSize(item.size))}</span><span class="row-date">${escapeHtml(formatTime(item.modifiedAt))}</span></div>` +
    `<div class="row-actions">` +
    `<button data-act="reveal" data-path="${escapeHtml(item.fullPath)}">打开所在目录</button>` +
    `<button data-act="copy" data-path="${escapeHtml(item.fullPath)}">复制路径</button>` +
    `</div></div>`
}

function renderResults({ append = false } = {}) {
  const slice = state.results.slice(append ? state.visibleCount - state.settings.pageSize : 0, state.visibleCount)
  const html = slice.map((item, offset) => {
    const index = (append ? state.visibleCount - state.settings.pageSize : 0) + offset
    return rowMarkup(item, index)
  }).join('')
  if (append) els.list.insertAdjacentHTML('beforeend', html)
  else els.list.innerHTML = html || ''
  updateEmptyState()
  updateCount()
  loadIcons()
}

function setActiveIndex(index, { scroll = true } = {}) {
  const clamped = Math.max(0, Math.min(index, state.visibleCount - 1))
  if (state.visibleCount > 0 && clamped === state.activeIndex && !scroll) return
  state.activeIndex = clamped
  els.list.querySelectorAll('.result-row').forEach((row) => {
    row.classList.toggle('active', Number(row.dataset.index) === state.activeIndex)
  })
  if (scroll) {
    const activeRow = els.list.querySelector('.result-row.active')
    activeRow?.scrollIntoView({ block: 'nearest' })
  }
}

async function loadIcons() {
  const pendingExtensions = new Map()
  for (const item of state.results.slice(0, state.visibleCount)) {
    const extension = String(item.extension || '').toLowerCase()
    if (!extension || state.iconCache.has(extension) || state.iconPending.has(extension)) continue
    pendingExtensions.set(extension, item.fullPath)
  }
  for (const [extension, samplePath] of pendingExtensions) {
    state.iconPending.add(extension)
    state.iconCache.set(extension, '')
    let dataUrl = null
    try {
      dataUrl = await searchAPI.getFileIcon(samplePath) || null
    } catch {
      dataUrl = null
    } finally {
      state.iconPending.delete(extension)
    }
    state.iconCache.set(extension, dataUrl)
    if (dataUrl) {
      els.list.querySelectorAll(`.result-row[data-ext="${extension}"] .ext-badge`).forEach((badge) => {
        const parent = badge.parentElement
        if (!parent || !badge.isConnected) return
        parent.innerHTML = `<img src="${dataUrl}" alt="">`
      })
    }
  }
}

function runSearch() {
  const keyword = els.input.value
  state.keyword = keyword
  state.seq += 1
  const seq = state.seq
  state.activeIndex = -1
  if (!keyword.trim()) {
    state.searching = false
    state.results = []
    state.total = 0
    state.visibleCount = 0
    renderResults()
    return
  }
  state.searching = true
  updateEmptyState()
  const category = getActiveCategory()
  const queries = planQueries(keyword, !!state.settings.matchPath).map((plan) => ({
    search: buildQuery(plan.keyword, category.rule),
    matchPath: plan.matchPath
  }))
  Promise.allSettled(queries.map((query) => searchAPI.query({
    search: query.search,
    matchPath: query.matchPath,
    maxResults: state.settings.maxResults,
    sortMode: state.settings.sortMode
  }))).then((settled) => {
    if (seq !== state.seq) return
    state.searching = false
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value)
    if (!fulfilled.length) {
      const failed = settled.find((entry) => entry.status === 'rejected')
      state.results = []
      state.total = 0
      state.visibleCount = 0
      updateEmptyState(errorMessage(failed?.reason))
      updateCount()
      return
    }
    const merged = mergeQueryResults(fulfilled)
    state.results = merged.items
    state.total = merged.total
    state.visibleCount = Math.min(state.results.length, state.settings.pageSize)
    updateEmptyState()
    renderResults()
  })
}

function errorMessage(error) {
  return String(error?.message || error || '查询失败').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function extendResults() {
  if (state.visibleCount >= state.results.length) return
  state.visibleCount = Math.min(state.visibleCount + state.settings.pageSize, state.results.length)
  renderResults({ append: true })
}

function activateRow(index, { reveal = false } = {}) {
  const item = state.results[index]
  if (!item) return
  if (reveal) searchAPI.revealPath(item.fullPath).catch(() => {})
  else searchAPI.openPath(item.fullPath).catch(() => {})
}

els.input.addEventListener('input', () => {
  els.clear.hidden = !els.input.value
  runSearchDebounced()
})

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    setActiveIndex(state.activeIndex + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    setActiveIndex(state.activeIndex - 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const index = state.activeIndex >= 0 ? state.activeIndex : (state.visibleCount > 0 ? 0 : -1)
    if (index >= 0) {
      setActiveIndex(index)
      activateRow(index, { reveal: event.ctrlKey })
    }
  } else if (event.key === 'Escape') {
    event.preventDefault()
    searchAPI.close()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    const currentIndex = state.categories.findIndex((category) => category.id === state.activeCategoryId)
    const nextIndex = (currentIndex + (event.shiftKey ? -1 : 1) + state.categories.length) % state.categories.length
    state.activeCategoryId = state.categories[nextIndex]?.id || 'all'
    renderTabs()
    runSearch()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    searchAPI.close()
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

els.list.addEventListener('click', (event) => {
  const actionButton = event.target.closest('.row-actions button')
  if (actionButton) {
    event.stopPropagation()
    const path = actionButton.dataset.path
    if (actionButton.dataset.act === 'reveal') searchAPI.revealPath(path).catch(() => {})
    else searchAPI.copyPath(path).catch(() => {})
    return
  }
  const row = event.target.closest('.result-row')
  if (row) setActiveIndex(Number(row.dataset.index))
})

els.list.addEventListener('dblclick', (event) => {
  const row = event.target.closest('.result-row')
  if (!row) return
  activateRow(Number(row.dataset.index))
})

els.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.category-tab')
  if (!tab || tab.dataset.id === state.activeCategoryId) return
  state.activeCategoryId = tab.dataset.id
  renderTabs()
  runSearch()
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
  runSearch()
})

els.sort.addEventListener('change', () => {
  state.settings.sortMode = els.sort.value
  searchAPI.savePrefs({ search: { sortMode: els.sort.value } }).catch(() => {})
  runSearch()
})

searchAPI.ready()
searchAPI.onInit((payload) => {
  applyAppearance(payload)
  applySettings(payload.search || {})
  els.input.focus()
  searchAPI.ensureReady().then(renderStatus).catch(() => searchAPI.getStatus().then(renderStatus).catch(() => {}))
})
searchAPI.onStatusChanged(renderStatus)
searchAPI.onSettingsChanged((payload) => {
  applySettings(payload.search || {})
  applyAppearance(payload)
})
