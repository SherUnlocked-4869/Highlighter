// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 history（截图历史）。

let historyQuery = ''
let historySource = ''
let historyRenderVersion = 0
let historySearchTimer = null
let historySelectedIds = new Set()
let historyThumbnailObserver = null

// B1.4 (history re-edit): `history:changed` used to rebuild the whole page, which
// threw away the scroll offset, the pages the user had loaded and the thumbnail
// cache. The list is now patched by document id instead, so these have to outlive
// a single render: the thumbnail cache is keyed by (documentId, revisionId)
// (plan §6.5.1) and `historyListState` describes the list currently on screen.
let historyThumbnailCache = new Map()
let historyListState = null
let historyRenderInFlight = false
let historyRefreshTimer = null
let historyRefreshRunning = false
let historyRefreshPending = false

const HISTORY_PAGE_SIZE = 40
// Mirror of HistoryService's MAX_HISTORY_PAGE_SIZE (main/services/history-service.js):
// an in-place refresh refetches exactly the pages the user already loaded, and the
// largest page the service accepts keeps the round-trip count down.
const HISTORY_MAX_PAGE_SIZE = 100
const HISTORY_THUMBNAIL_CACHE_LIMIT = 120
// One user action can push several history:changed events (batch delete); coalesce
// the burst so a refresh reads the list once and restores the scroll once.
const HISTORY_REFRESH_DELAY = 60

const HISTORY_SOURCE_LABELS = {
  // `region` is what the capture domain stores for a plain screenshot; `capture`
  // is the fallback HistoryService gives legacy rows with no source.
  capture: 'config.history.source.region',
  region: 'config.history.source.region',
  'long-capture': 'config.history.source.long-capture',
  'focused-window': 'config.history.source.focused-window',
  file: 'config.history.source.file',
  history: 'config.history.source.history',
  'quick-save': 'config.history.source.quick-save',
  'save-as': 'config.history.source.save-as'
}

// Plan §6.5.1 compatibility window: `item.id === item.documentId`, but both reads
// go through these helpers, so a record without the new fields still renders and
// still caches instead of collapsing every card onto one "undefined" key.
function historyDocumentId(item) {
  return String(item?.documentId ?? item?.id ?? '')
}

function historyRevisionId(item) {
  return String(item?.revisionId ?? '')
}

// The version starts at 1 and legacy rows have no field at all: `Math.trunc(Number(x)) || 1`
// keeps "version 1" noise off the card and falls back for junk values.
function historyVersion(item) {
  const version = Math.trunc(Number(item?.version)) || 1
  return version > 1 ? version : 1
}

// Cache key for a thumbnail. The `history:thumbnail` IPC still takes a bare id, so
// the request keeps using documentId while the cache uses (documentId, revisionId)
// — a new revision must not be served the previous version's image.
function historyThumbnailKey(item) {
  return `${historyDocumentId(item)}::${historyRevisionId(item)}`
}

function historySourceLabel(source) {
  const key = HISTORY_SOURCE_LABELS[source]
  return key ? t(key) : String(source ?? '')
}

// Everything the card actually shows. A card whose signature is unchanged is kept
// as-is on refresh (so its loaded thumbnail survives); only changed cards are
// re-created. Selection is deliberately excluded — it must not invalidate a card.
function historyCardSignature(item) {
  return [
    historyDocumentId(item),
    historyRevisionId(item),
    String(item?.id ?? ''),
    String(item?.createdAt ?? ''),
    String(item?.source ?? ''),
    String(item?.width ?? ''),
    String(item?.height ?? ''),
    String(historyVersion(item)),
    item?.longCapture ? '1' : '0'
  ].join('|')
}

function historyCardMarkup(item) {
  const documentId = historyDocumentId(item)
  const id = escapeHtml(documentId)
  const version = historyVersion(item)
  const selected = historySelectedIds.has(documentId)
  const versionBadge = version > 1 ? `<span class="history-version">${escapeHtml(t('config.history.version-badge', { version }))}</span>` : ''
  // Plan §6.5.1 S8: long captures have no editor yet. Hiding the button alone read
  // as a missing row, so the reason now lives on the thumbnail plate (locale key).
  const imageTitle = item?.longCapture ? ` title="${escapeHtml(t('config.history.long-capture-no-edit'))}"` : ''
  const editButton = item?.longCapture ? '' : `<button data-history-action="edit" data-id="${id}">${t('config.history.action-edit')}</button>`
  return `<article class="card history-item ${selected ? 'selected' : ''}" data-history-document="${id}" data-history-signature="${escapeHtml(historyCardSignature(item))}"><label class="history-select" title="${t('config.history.select-item')}"><input type="checkbox" data-history-select data-id="${id}" ${selected ? 'checked' : ''}></label><div class="history-image"${imageTitle}><img data-history-thumbnail="${id}" data-history-thumbnail-key="${escapeHtml(historyThumbnailKey(item))}" loading="lazy" decoding="async" alt=""></div><div class="history-meta"><span class="history-meta-time">${new Date(item.createdAt).toLocaleString()}</span><span class="history-meta-sub">${escapeHtml(historySourceLabel(item.source))} · ${escapeHtml(item.width)}×${escapeHtml(item.height)}</span>${versionBadge}</div><div class="history-actions">${editButton}<button data-history-action="open" data-id="${id}">${t('config.history.action-open')}</button><button data-history-action="copy" data-id="${id}">${t('config.history.action-copy')}</button><button data-history-action="address" data-id="${id}">${t('config.history.action-address')}</button><button class="history-delete" data-history-action="delete" data-id="${id}">${t('config.history.action-delete')}</button></div></article>`
}

function historyCreateCard(item) {
  const template = document.createElement('template')
  template.innerHTML = historyCardMarkup(item)
  return template.content.firstElementChild
}

// The CSS plate labels an unusable thumbnail through attr(data-unavailable), so
// the copy lives in the locale table rather than in config.css.
function historyMarkThumbnailUnavailable(imageElement) {
  const plate = imageElement.closest('.history-image')
  if (!plate) return
  plate.dataset.unavailable = t('config.history.thumbnail-unavailable')
  plate.classList.add('unavailable')
}

function historyCacheThumbnail(cacheKey, thumbnail) {
  historyThumbnailCache.delete(cacheKey)
  historyThumbnailCache.set(cacheKey, thumbnail)
  while (historyThumbnailCache.size > HISTORY_THUMBNAIL_CACHE_LIMIT) {
    const oldest = historyThumbnailCache.keys().next()
    if (oldest.done) break
    historyThumbnailCache.delete(oldest.value)
  }
}

async function historyLoadThumbnail(imageElement) {
  const documentId = imageElement.dataset.historyThumbnail
  if (!documentId || imageElement.dataset.loaded === 'true') return
  const renderVersion = historyRenderVersion
  const cacheKey = imageElement.dataset.historyThumbnailKey || documentId
  imageElement.dataset.loaded = 'true'
  try {
    const cached = historyThumbnailCache.get(cacheKey)
    const thumbnail = cached || await window.electronAPI.getHistoryThumbnail(documentId)
    if (thumbnail) historyCacheThumbnail(cacheKey, thumbnail)
    if (thumbnail && currentRoute === 'history' && renderVersion === historyRenderVersion && imageElement.isConnected) {
      imageElement.src = thumbnail
    } else {
      historyMarkThumbnailUnavailable(imageElement)
    }
  } catch {
    historyMarkThumbnailUnavailable(imageElement)
  }
}

function historyObserveThumbnailElements(elements) {
  const images = [...(elements || [])]
  if (!images.length) return
  if (!('IntersectionObserver' in window)) {
    images.forEach((imageElement) => { void historyLoadThumbnail(imageElement) })
    return
  }
  if (!historyThumbnailObserver) {
    historyThumbnailObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        observer.unobserve(entry.target)
        void historyLoadThumbnail(entry.target)
      })
    }, { root: view, rootMargin: '240px' })
  }
  images.forEach((imageElement) => historyThumbnailObserver.observe(imageElement))
}

function historyObserveThumbnailsIn(scope) {
  if (!scope) return
  historyObserveThumbnailElements(scope.querySelectorAll('[data-history-thumbnail]:not([data-loaded])'))
}

function historyUpdateLoadedCount(state) {
  if (!state?.loadedCount) return
  state.loadedCount.textContent = state.totalCount > state.items.length
    ? t('config.history.count-of-total', { loaded: state.items.length, total: state.totalCount })
    : t('config.history.count-total', { total: state.totalCount })
}

function historyUpdateSelectionControls(state) {
  if (!state?.selectedCount) return
  const count = historySelectedIds.size
  state.selectedCount.textContent = t('config.history.selected-count', { count })
  state.exportSelected.disabled = count === 0
  state.exportSelectedPdf.disabled = count === 0
  state.deleteSelected.disabled = count === 0
  state.selectAll.checked = state.items.length > 0 && count === state.items.length
  state.selectAll.indeterminate = count > 0 && count < state.items.length
}

function historyBindCard(state, card) {
  for (const checkbox of card.querySelectorAll('[data-history-select]')) {
    checkbox.onchange = () => {
      const id = checkbox.dataset.id
      if (checkbox.checked) historySelectedIds.add(id)
      else historySelectedIds.delete(id)
      checkbox.closest('.history-item')?.classList.toggle('selected', checkbox.checked)
      historyUpdateSelectionControls(state)
    }
  }
  for (const button of card.querySelectorAll('[data-history-action]')) {
    button.onclick = () => { void historyRunItemAction(button) }
  }
}

function historyBindItems(state) {
  if (!state?.results) return
  for (const card of state.results.querySelectorAll('[data-history-document]')) historyBindCard(state, card)
}

// B1.4: the edit entry used to fire and forget — a game-mode rejection or a deleted
// file made the click completely silent. It now wraps the call in try/catch, checks
// the return value and locks the button (loading copy) for the duration, so a second
// click cannot open a second editor.
async function historyEditItem(button) {
  if (!button || button.disabled) return
  const id = button.dataset.id
  const label = button.textContent
  button.disabled = true
  button.dataset.loading = 'true'
  button.textContent = t('config.history.action-edit-loading')
  try {
    const opened = await window.electronAPI.editHistory(id)
    if (opened === false) toast(t('config.history.edit-failed'))
  } catch (error) {
    toast(errorMessage(error) || t('config.history.edit-failed'))
  } finally {
    // A refresh may already have replaced this button along with its card; a
    // detached node needs no restoring.
    if (button.isConnected) {
      button.disabled = false
      button.textContent = label
      delete button.dataset.loading
    }
  }
}

async function historyRunItemAction(button) {
  const action = button.dataset.historyAction
  const id = button.dataset.id
  if (action === 'edit') { await historyEditItem(button); return }
  if (action === 'open') {
    try {
      const opened = await window.electronAPI.openHistory(id)
      if (!opened) toast(t('config.history.file-missing'))
    } catch (error) { toast(errorMessage(error) || t('config.history.open-failed')) }
    return
  }
  if (action === 'copy') {
    try {
      const copied = await window.electronAPI.copyHistory(id)
      toast(copied ? t('config.history.copied') : t('config.history.too-large'))
    } catch (error) { toast(errorMessage(error) || t('config.history.too-large')) }
    return
  }
  if (action === 'address') {
    try {
      const copied = await window.electronAPI.copyHistoryPath(id)
      toast(copied ? t('config.history.address-copied') : t('config.history.file-missing'))
    } catch (error) { toast(errorMessage(error) || t('config.history.address-copy-failed')) }
    return
  }
  if (action === 'delete') {
    try { historySelectedIds.delete(id); await window.electronAPI.deleteHistory(id) } catch (error) { toast(errorMessage(error) || t('config.history.delete-failed')) }
  }
}

// ---------------------------------------------------------------------------
// In-place refresh (B1.4)
// ---------------------------------------------------------------------------

// `#view` is the scroller (config.css `#view{flex:1;overflow:auto}`), so the offset
// has to be handed over explicitly across a patch — same shape as the usage
// dashboard (routes/usage.js usageCaptureViewState / usageRestoreViewState).
function historyRestoreScroll(scrollTop) {
  const applyScroll = () => { if (scrollTop > 0 && view.scrollTop !== scrollTop) view.scrollTop = scrollTop }
  // The patched grid has no geometry yet on the line after the swap, so a single
  // assignment can be clamped by the previous scrollHeight; re-apply next frame.
  applyScroll()
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyScroll)
}

// Selection survives a refresh. Only ids whose document disappeared from the list
// are dropped: a selection must not be clipped just because a row moved pages, and
// a document that is merely updated keeps its checkbox ticked.
function historySelectionAfterRefresh(selectedIds, previousIds, nextIds) {
  const next = new Set(nextIds)
  const gone = new Set([...previousIds].filter((id) => !next.has(id)))
  if (!gone.size) return selectedIds
  return new Set([...selectedIds].filter((id) => !gone.has(id)))
}

// Refetches exactly the pages the user already loaded (never more): an in-place
// refresh must not roll the list back to page one.
async function historyLoadLoadedPages(targetCount) {
  const items = []
  let cursor = ''
  let hasMore = true
  let totalCount = 0
  while (hasMore) {
    const page = await window.electronAPI.getHistory({
      query: historyQuery,
      source: historySource,
      limit: Math.max(1, Math.min(HISTORY_MAX_PAGE_SIZE, targetCount - items.length)),
      ...(cursor ? { cursor } : {})
    })
    const pageItems = Array.isArray(page?.items) ? page.items : []
    items.push(...pageItems)
    totalCount = Math.max(items.length, Number(page?.totalCount) || 0)
    hasMore = page?.hasMore === true
    cursor = page?.nextCursor || ''
    if (!hasMore || !cursor || items.length >= targetCount || !pageItems.length) break
  }
  return { items, hasMore, totalCount, nextCursor: cursor }
}

// Swaps card bodies in place, keyed by document id. Untouched cards keep their
// element (and therefore their loaded thumbnail); only changed ones are re-created.
function historyPatchCards(state, items) {
  let grid = state.results.querySelector('.history-grid')
  if (!grid) {
    state.results.innerHTML = '<div class="history-grid"></div>'
    grid = state.results.querySelector('.history-grid')
  }
  const existing = new Map()
  for (const card of grid.querySelectorAll('[data-history-document]')) existing.set(card.dataset.historyDocument, card)
  const ordered = []
  for (const item of items) {
    const documentId = historyDocumentId(item)
    if (!documentId) continue
    const card = existing.get(documentId) || null
    let next = card
    if (!card || card.dataset.historySignature !== historyCardSignature(item)) {
      next = historyCreateCard(item)
      if (card) card.replaceWith(next)
      historyBindCard(state, next)
      historyObserveThumbnailsIn(next)
    }
    existing.delete(documentId)
    ordered.push(next)
  }
  // A document deleted elsewhere leaves together with the card it owned.
  for (const stale of existing.values()) stale.remove()
  // Keep DOM order equal to list order: an updated document keeps its place, while
  // a new one (save-copy, next capture) can land at the head without a rebuild.
  let reference = null
  for (const card of ordered) {
    const expected = reference ? reference.nextElementSibling : grid.firstElementChild
    if (expected !== card) grid.insertBefore(card, reference ? reference.nextElementSibling : grid.firstElementChild)
    reference = card
  }
  // Selection is not part of the signature (it must not invalidate a thumbnail), so
  // it is synchronised explicitly after the patch.
  for (const card of ordered) {
    const selected = historySelectedIds.has(card.dataset.historyDocument)
    card.classList.toggle('selected', selected)
    const checkbox = card.querySelector('[data-history-select]')
    if (checkbox) checkbox.checked = selected
  }
}

// Only `history:list` is refetched: stats, filters and the batch bar stay exactly as
// the full render built them, and the scroll offset is restored afterwards.
async function refreshHistoryList() {
  const state = historyListState
  if (!state?.results || !state.results.isConnected) return false
  const refreshVersion = historyRenderVersion
  const previousIds = new Set(state.items.map((item) => historyDocumentId(item)))
  const targetCount = Math.max(HISTORY_PAGE_SIZE, state.items.length)
  let page
  try {
    page = await historyLoadLoadedPages(targetCount)
  } catch {
    // Keep the cards already on screen; the next push retries.
    return false
  }
  // A full render (route re-entry, filter change) superseded this refresh.
  if (currentRoute !== 'history' || refreshVersion !== historyRenderVersion || historyListState !== state) return false
  // Read the offset after the fetch, right before the DOM mutation: the user may
  // have scrolled while the list was loading, and the patch must not rewind them.
  const scrollTop = view.scrollTop || 0
  const nextIds = new Set(page.items.map((item) => historyDocumentId(item)))
  historySelectedIds = historySelectionAfterRefresh(historySelectedIds, previousIds, nextIds)
  state.items = page.items
  state.renderedCount = page.items.length
  state.nextCursor = page.nextCursor
  state.hasMore = page.hasMore
  state.totalCount = page.totalCount
  if (!page.items.length) state.results.innerHTML = '<div class="empty">' + t('config.history.empty') + '</div>'
  else historyPatchCards(state, page.items)
  historyUpdateLoadedCount(state)
  state.loadMore.hidden = !state.hasMore
  state.loadMore.disabled = false
  historyUpdateSelectionControls(state)
  historyRestoreScroll(scrollTop)
  return true
}

// `history:changed` entry point. Deliberately not `renderHistory()`: entering the
// route or changing a filter still goes through the full render it always did.
function refreshHistoryOnChange() {
  if (currentRoute !== 'history') return
  // A search debounce already queued a full render for the query being typed.
  if (historySearchTimer) return
  if (historyRenderInFlight) {
    historyRefreshPending = true
    return
  }
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer)
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null
    void refreshHistoryInPlace()
  }, HISTORY_REFRESH_DELAY)
}

async function refreshHistoryInPlace() {
  if (currentRoute !== 'history') return
  if (historyRefreshRunning) {
    historyRefreshPending = true
    return
  }
  // Nothing rendered to patch (first load failed, or the route is being entered):
  // fall back to the full render so the page still converges.
  if (!historyListState) {
    await renderHistory()
    return
  }
  historyRefreshRunning = true
  try {
    await refreshHistoryList()
  } finally {
    historyRefreshRunning = false
    if (historyRefreshPending) {
      historyRefreshPending = false
      refreshHistoryOnChange()
    }
  }
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------

async function renderHistory() {
  const renderVersion = ++historyRenderVersion
  // While the page is being rebuilt there is nothing to patch, so a push arriving
  // mid-render is folded into one refresh once it completes.
  historyListState = null
  historyRenderInFlight = true
  try {
    await renderHistoryPage(renderVersion)
  } finally {
    historyRenderInFlight = false
    if (historyRefreshPending) {
      historyRefreshPending = false
      refreshHistoryOnChange()
    }
  }
}

async function renderHistoryPage(renderVersion) {
  historyThumbnailObserver?.disconnect()
  historyThumbnailObserver = null
  const headerActions = '<div class="page-head-actions"><button class="button" id="cleanupHistory">' + t('config.history.cleanup-invalid') + '</button><button class="button danger" id="clearHistory">' + t('config.history.clear-all') + '</button></div>'
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.history'), t('config.history.description'), headerActions)}<div class="empty">${t('config.history.loading')}</div></div>`
  let firstPage
  let sources
  let stats
  try {
    const [page, sourceList, statistics] = await Promise.all([
      window.electronAPI.getHistory({
        query: historyQuery,
        source: historySource,
        limit: HISTORY_PAGE_SIZE
      }),
      window.electronAPI.getHistorySources(),
      window.electronAPI.getHistoryStats()
    ])
    firstPage = page
    sources = sourceList
    stats = statistics
  } catch (error) {
    if (currentRoute === 'history' && renderVersion === historyRenderVersion) {
      view.innerHTML = `<div class="page">${pageHeader(t('config.route.history'), t('config.history.description'), headerActions)}<div class="empty">${t('config.history.load-failed')}</div></div>`
      toast(error?.message || t('config.history.load-failed'))
    }
    return
  }
  if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
  // The rendered list. `refreshHistoryList()` mutates this object in place, so the
  // handlers bound below (load more / select all / export) always read fresh rows.
  const state = {
    version: renderVersion,
    items: Array.isArray(firstPage?.items) ? firstPage.items : [],
    renderedCount: 0,
    nextCursor: firstPage?.nextCursor || '',
    hasMore: firstPage?.hasMore === true,
    totalCount: 0,
    results: null,
    loadedCount: null,
    loadMore: null,
    selectAll: null,
    selectedCount: null,
    exportSelected: null,
    exportSelectedPdf: null,
    deleteSelected: null
  }
  state.totalCount = Math.max(state.items.length, Number(firstPage?.totalCount) || 0)
  const visibleIds = new Set(state.items.map((item) => historyDocumentId(item)))
  historySelectedIds = new Set([...historySelectedIds].filter((id) => visibleIds.has(id)))
  const container = document.querySelector('.page')
  container.querySelector('.empty')?.remove()
  const sourceOptions = sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(historySourceLabel(source))}</option>`).join('')
  const statsMarkup = `<div class="history-stats card"><div><b>${formatBytes(stats.totalBytes)}</b><span>${t('config.history.stats-space')}</span></div><div><b>${stats.availableCount}</b><span>${t('config.history.stats-available')}</span></div><div class="${stats.missingCount ? 'warning' : ''}"><b>${stats.missingCount}</b><span>${t('config.history.stats-missing')}</span></div><div class="${stats.orphanCount ? 'warning' : ''}"><b>${stats.orphanCount}</b><span>${t('config.history.stats-orphan', { size: formatBytes(stats.orphanBytes) })}</span></div></div>`
  const filtersMarkup = `<div class="history-filters card"><input class="input" id="historySearch" type="search" value="${escapeHtml(historyQuery)}" placeholder="${t('config.history.search-placeholder')}"><select id="historySource"><option value="">${t('config.history.all-sources')}</option>${sourceOptions}</select><span id="historyLoadedCount"></span></div>`
  const batchMarkup = `<div class="history-batch card"><label><input type="checkbox" id="selectAllHistory"> ${t('config.history.select-all')}</label><span id="historySelectedCount">${t('config.history.selected-count', { count: 0 })}</span><button class="button" id="exportSelectedHistory" disabled>${t('config.history.export-selected')}</button><button class="button" id="exportSelectedHistoryPdf" disabled>${t('config.history.export-pdf')}</button><button class="button danger" id="deleteSelectedHistory" disabled>${t('config.history.delete-selected')}</button></div>`
  container.insertAdjacentHTML('beforeend', `${statsMarkup}${filtersMarkup}${batchMarkup}<div id="historyResults"></div><div class="history-load-more"><button class="button" id="loadMoreHistory">${t('config.history.load-more')}</button></div>`)

  const searchInput = document.getElementById('historySearch')
  const sourceSelect = document.getElementById('historySource')
  state.selectAll = document.getElementById('selectAllHistory')
  state.selectedCount = document.getElementById('historySelectedCount')
  state.exportSelected = document.getElementById('exportSelectedHistory')
  state.exportSelectedPdf = document.getElementById('exportSelectedHistoryPdf')
  state.deleteSelected = document.getElementById('deleteSelectedHistory')
  state.loadedCount = document.getElementById('historyLoadedCount')
  state.results = document.getElementById('historyResults')
  state.loadMore = document.getElementById('loadMoreHistory')
  // Published only once the markup exists: a refresh started earlier would
  // otherwise patch a half-built page.
  historyListState = state
  const renderLoadedItems = ({ append = false } = {}) => {
    if (!state.items.length) {
      state.results.innerHTML = '<div class="empty">' + t('config.history.empty') + '</div>'
    } else if (append && state.renderedCount > 0) {
      const newItems = state.items.slice(state.renderedCount)
      let grid = state.results.querySelector('.history-grid')
      if (!grid) {
        state.results.innerHTML = '<div class="history-grid"></div>'
        grid = state.results.querySelector('.history-grid')
      }
      grid.insertAdjacentHTML('beforeend', newItems.map(historyCardMarkup).join(''))
      historyObserveThumbnailsIn(grid)
    } else {
      state.results.innerHTML = `<div class="history-grid">${state.items.map(historyCardMarkup).join('')}</div>`
      historyObserveThumbnailsIn(state.results)
    }
    state.renderedCount = state.items.length
    historyUpdateLoadedCount(state)
    state.loadMore.hidden = !state.hasMore
    state.loadMore.disabled = false
    historyUpdateSelectionControls(state)
    historyBindItems(state)
  }
  sourceSelect.value = historySource
  renderLoadedItems()
  searchInput.oninput = () => {
    historyQuery = searchInput.value
    clearTimeout(historySearchTimer)
    historySearchTimer = setTimeout(() => { historySearchTimer = null; renderHistory() }, 220)
  }
  searchInput.onkeydown = (event) => {
    if (event.key !== 'Enter') return
    clearTimeout(historySearchTimer)
    historySearchTimer = null
    historyQuery = searchInput.value
    renderHistory()
  }
  sourceSelect.onchange = () => {
    historySource = sourceSelect.value
    renderHistory()
  }
  state.selectAll.onchange = () => {
    historySelectedIds = state.selectAll.checked ? new Set(state.items.map((item) => historyDocumentId(item))) : new Set()
    for (const checkbox of state.results.querySelectorAll('[data-history-select]')) {
      checkbox.checked = state.selectAll.checked
      checkbox.closest('.history-item')?.classList.toggle('selected', state.selectAll.checked)
    }
    historyUpdateSelectionControls(state)
  }
  state.exportSelected.onclick = async () => {
    let result
    try {
      result = await window.electronAPI.exportHistory([...historySelectedIds])
    } catch (error) {
      toast(errorMessage(error) || t('config.history.export-failed'))
      return
    }
    if (result.canceled) return
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.exported', { count: result.exportedCount, failures: suffix }))
  }
  // Batch PDF: the main process renders one PDF page per selected capture and asks
  // for the destination itself, so this button follows the same cancel/failure
  // reporting shape as the copy export above.
  state.exportSelectedPdf.onclick = async () => {
    let result
    try {
      result = await window.electronAPI.exportHistoryPdf([...historySelectedIds])
    } catch (error) {
      toast(errorMessage(error) || t('config.history.export-pdf-failed'))
      return
    }
    if (result.canceled) return
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.export-pdf-done', { count: result.exportedCount, failures: suffix }))
  }
  state.deleteSelected.onclick = async () => {
    if (!confirm(t('config.history.confirm-delete-selected', { count: historySelectedIds.size }))) return
    let result
    try {
      result = await window.electronAPI.deleteHistoryMany([...historySelectedIds])
    } catch (error) {
      toast(errorMessage(error) || t('config.history.delete-failed'))
      return
    }
    historySelectedIds.clear()
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.deleted', { count: result.deletedCount, failures: suffix }))
    renderHistory()
  }
  state.loadMore.onclick = async () => {
    if (!state.hasMore || state.loadMore.disabled) return
    state.loadMore.disabled = true
    try {
      const page = await window.electronAPI.getHistory({
        query: historyQuery,
        source: historySource,
        cursor: state.nextCursor,
        limit: HISTORY_PAGE_SIZE
      })
      if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
      state.items = state.items.concat(Array.isArray(page?.items) ? page.items : [])
      state.nextCursor = page?.nextCursor || ''
      state.hasMore = page?.hasMore === true
      state.totalCount = Math.max(state.items.length, Number(page?.totalCount) || state.totalCount)
      renderLoadedItems({ append: true })
    } catch (error) {
      state.loadMore.disabled = false
      toast(errorMessage(error) || t('config.history.load-failed'))
    }
  }
  document.getElementById('cleanupHistory').onclick = async () => {
    if (!stats.missingCount && !stats.orphanCount) { toast(t('config.history.nothing-to-clean')); return }
    if (!confirm(t('config.history.confirm-cleanup', { missing: stats.missingCount, orphans: stats.orphanCount }))) return
    let result
    try {
      result = await window.electronAPI.cleanupHistory()
    } catch (error) {
      toast(errorMessage(error) || t('config.history.cleanup-failed'))
      return
    }
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.cleaned', { entries: result.removedEntries, files: result.removedFiles, failures: suffix }))
    renderHistory()
  }
  document.getElementById('clearHistory').onclick = async () => {
    if (!confirm(t('config.history.confirm-clear-all'))) return
    try { historySelectedIds.clear(); await window.electronAPI.clearHistory(); renderHistory() }
    catch (error) { toast(errorMessage(error) || t('config.history.clear-failed')); renderHistory() }
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderHistory'] = () => renderHistory()
