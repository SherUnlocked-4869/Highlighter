// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 history（截图历史）。

let historyQuery = ''
let historySource = ''
let historyRenderVersion = 0
let historySearchTimer = null
let historySelectedIds = new Set()
let historyThumbnailObserver = null

const HISTORY_PAGE_SIZE = 40

async function renderHistory() {
  const renderVersion = ++historyRenderVersion
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
  let history = Array.isArray(firstPage?.items) ? firstPage.items : []
  let nextCursor = firstPage?.nextCursor || ''
  let hasMore = firstPage?.hasMore === true
  const totalCount = Math.max(history.length, Number(firstPage?.totalCount) || 0)
  const thumbnailCache = new Map()
  const visibleIds = new Set(history.map((item) => String(item.id)))
  historySelectedIds = new Set([...historySelectedIds].filter((id) => visibleIds.has(id)))
  const container = document.querySelector('.page')
  container.querySelector('.empty')?.remove()
  const sourceLabels = {
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
  const sourceOptions = sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(sourceLabels[source] ? t(sourceLabels[source]) : source)}</option>`).join('')
  const statsMarkup = `<div class="history-stats card"><div><b>${formatBytes(stats.totalBytes)}</b><span>${t('config.history.stats-space')}</span></div><div><b>${stats.availableCount}</b><span>${t('config.history.stats-available')}</span></div><div class="${stats.missingCount ? 'warning' : ''}"><b>${stats.missingCount}</b><span>${t('config.history.stats-missing')}</span></div><div class="${stats.orphanCount ? 'warning' : ''}"><b>${stats.orphanCount}</b><span>${t('config.history.stats-orphan', { size: formatBytes(stats.orphanBytes) })}</span></div></div>`
  const filtersMarkup = `<div class="history-filters card"><input class="input" id="historySearch" type="search" value="${escapeHtml(historyQuery)}" placeholder="${t('config.history.search-placeholder')}"><select id="historySource"><option value="">${t('config.history.all-sources')}</option>${sourceOptions}</select><span id="historyLoadedCount"></span></div>`
  const batchMarkup = `<div class="history-batch card"><label><input type="checkbox" id="selectAllHistory"> ${t('config.history.select-all')}</label><span id="historySelectedCount">${t('config.history.selected-count', { count: 0 })}</span><button class="button" id="exportSelectedHistory" disabled>${t('config.history.export-selected')}</button><button class="button" id="exportSelectedHistoryPdf" disabled>${t('config.history.export-pdf')}</button><button class="button danger" id="deleteSelectedHistory" disabled>${t('config.history.delete-selected')}</button></div>`
  container.insertAdjacentHTML('beforeend', `${statsMarkup}${filtersMarkup}${batchMarkup}<div id="historyResults"></div><div class="history-load-more"><button class="button" id="loadMoreHistory">${t('config.history.load-more')}</button></div>`)

  const searchInput = document.getElementById('historySearch')
  const sourceSelect = document.getElementById('historySource')
  const selectAll = document.getElementById('selectAllHistory')
  const selectedCount = document.getElementById('historySelectedCount')
  const exportSelected = document.getElementById('exportSelectedHistory')
  const exportSelectedPdf = document.getElementById('exportSelectedHistoryPdf')
  const deleteSelected = document.getElementById('deleteSelectedHistory')
  const loadedCount = document.getElementById('historyLoadedCount')
  const results = document.getElementById('historyResults')
  const loadMore = document.getElementById('loadMoreHistory')
  const updateSelectionControls = () => {
    const count = historySelectedIds.size
    selectedCount.textContent = t('config.history.selected-count', { count })
    exportSelected.disabled = count === 0
    exportSelectedPdf.disabled = count === 0
    deleteSelected.disabled = count === 0
    selectAll.checked = history.length > 0 && count === history.length
    selectAll.indeterminate = count > 0 && count < history.length
  }
  // The CSS plate labels an unusable thumbnail through attr(data-unavailable), so
  // the copy lives in the locale table rather than in config.css.
  const markThumbnailUnavailable = (imageElement) => {
    const plate = imageElement.closest('.history-image')
    if (!plate) return
    plate.dataset.unavailable = t('config.history.thumbnail-unavailable')
    plate.classList.add('unavailable')
  }
  const loadThumbnail = async (imageElement) => {
    const id = imageElement.dataset.historyThumbnail
    if (!id || imageElement.dataset.loaded === 'true') return
    imageElement.dataset.loaded = 'true'
    try {
      const cached = thumbnailCache.get(id)
      const thumbnail = cached || await window.electronAPI.getHistoryThumbnail(id)
      if (thumbnail) thumbnailCache.set(id, thumbnail)
      if (thumbnail && currentRoute === 'history' && renderVersion === historyRenderVersion && imageElement.isConnected) {
        imageElement.src = thumbnail
      } else {
        markThumbnailUnavailable(imageElement)
      }
    } catch {
      markThumbnailUnavailable(imageElement)
    }
  }
  const observeNewThumbnails = (imageScope) => {
    const images = [...(imageScope || results.querySelectorAll('[data-history-thumbnail]'))]
    if (!('IntersectionObserver' in window)) {
      images.forEach(loadThumbnail)
      return
    }
    if (!historyThumbnailObserver) {
      historyThumbnailObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          observer.unobserve(entry.target)
          loadThumbnail(entry.target)
        })
      }, { root: view, rootMargin: '240px' })
    }
    images.forEach((imageElement) => historyThumbnailObserver.observe(imageElement))
  }
  const bindHistoryItems = () => {
    document.querySelectorAll('[data-history-select]').forEach((checkbox) => {
      checkbox.onchange = () => {
        const id = checkbox.dataset.id
        if (checkbox.checked) historySelectedIds.add(id)
        else historySelectedIds.delete(id)
        checkbox.closest('.history-item')?.classList.toggle('selected', checkbox.checked)
        updateSelectionControls()
      }
    })
    document.querySelectorAll('[data-history-action]').forEach((button) => button.onclick = async () => {
      const action = button.dataset.historyAction; const id = button.dataset.id
      if (action === 'edit') await window.electronAPI.editHistory(id)
      if (action === 'open') {
        try {
          const opened = await window.electronAPI.openHistory(id)
          if (!opened) toast(t('config.history.file-missing'))
        } catch (error) { toast(error.message || t('config.history.open-failed')) }
      }
      if (action === 'copy') { const copied = await window.electronAPI.copyHistory(id); toast(copied ? t('config.history.copied') : t('config.history.too-large')) }
      if (action === 'address') {
        try {
          const copied = await window.electronAPI.copyHistoryPath(id)
          toast(copied ? t('config.history.address-copied') : t('config.history.file-missing'))
        } catch (error) { toast(error.message || t('config.history.address-copy-failed')) }
      }
      if (action === 'delete') {
        try { historySelectedIds.delete(id); await window.electronAPI.deleteHistory(id) }
        catch (error) { toast(error.message || t('config.history.delete-failed')) }
      }
    })
  }
  const historyCardMarkup = (item) => {
    const selected = historySelectedIds.has(String(item.id))
    return `<article class="card history-item ${selected ? 'selected' : ''}"><label class="history-select" title="${t('config.history.select-item')}"><input type="checkbox" data-history-select data-id="${escapeHtml(item.id)}" ${selected ? 'checked' : ''}></label><div class="history-image"><img data-history-thumbnail="${escapeHtml(item.id)}" loading="lazy" decoding="async" alt=""></div><div class="history-meta"><span class="history-meta-time">${new Date(item.createdAt).toLocaleString()}</span><span class="history-meta-sub">${escapeHtml(sourceLabels[item.source] ? t(sourceLabels[item.source]) : item.source)} · ${escapeHtml(item.width)}×${escapeHtml(item.height)}</span></div><div class="history-actions">${item.longCapture ? '' : `<button data-history-action="edit" data-id="${escapeHtml(item.id)}">${t('config.history.action-edit')}</button>`}<button data-history-action="open" data-id="${escapeHtml(item.id)}">${t('config.history.action-open')}</button><button data-history-action="copy" data-id="${escapeHtml(item.id)}">${t('config.history.action-copy')}</button><button data-history-action="address" data-id="${escapeHtml(item.id)}">${t('config.history.action-address')}</button><button class="history-delete" data-history-action="delete" data-id="${escapeHtml(item.id)}">${t('config.history.action-delete')}</button></div></article>`
  }
  let renderedHistoryCount = 0
  const renderLoadedItems = ({ append = false } = {}) => {
    if (!history.length) {
      results.innerHTML = '<div class="empty">' + t('config.history.empty') + '</div>'
    } else if (append && renderedHistoryCount > 0) {
      const newItems = history.slice(renderedHistoryCount)
      let grid = results.querySelector('.history-grid')
      if (!grid) {
        results.innerHTML = '<div class="history-grid"></div>'
        grid = results.querySelector('.history-grid')
      }
      grid.insertAdjacentHTML('beforeend', newItems.map(historyCardMarkup).join(''))
      observeNewThumbnails(grid.querySelectorAll('[data-history-thumbnail]:not([data-loaded])'))
    } else {
      results.innerHTML = `<div class="history-grid">${history.map(historyCardMarkup).join('')}</div>`
      observeNewThumbnails()
    }
    renderedHistoryCount = history.length
    loadedCount.textContent = totalCount > history.length ? t('config.history.count-of-total', { loaded: history.length, total: totalCount }) : t('config.history.count-total', { total: totalCount })
    loadMore.hidden = !hasMore
    loadMore.disabled = false
    updateSelectionControls()
    bindHistoryItems()
  }
  sourceSelect.value = historySource
  renderLoadedItems()
  searchInput.oninput = () => {
    historyQuery = searchInput.value
    clearTimeout(historySearchTimer)
    historySearchTimer = setTimeout(() => renderHistory(), 220)
  }
  searchInput.onkeydown = (event) => {
    if (event.key !== 'Enter') return
    clearTimeout(historySearchTimer)
    historyQuery = searchInput.value
    renderHistory()
  }
  sourceSelect.onchange = () => {
    historySource = sourceSelect.value
    renderHistory()
  }
  selectAll.onchange = () => {
    historySelectedIds = selectAll.checked ? new Set(history.map((item) => String(item.id))) : new Set()
    document.querySelectorAll('[data-history-select]').forEach((checkbox) => {
      checkbox.checked = selectAll.checked
      checkbox.closest('.history-item')?.classList.toggle('selected', selectAll.checked)
    })
    updateSelectionControls()
  }
  exportSelected.onclick = async () => {
    let result
    try {
      result = await window.electronAPI.exportHistory([...historySelectedIds])
    } catch (error) {
      toast(error.message || t('config.history.export-failed'))
      return
    }
    if (result.canceled) return
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.exported', { count: result.exportedCount, failures: suffix }))
  }
  // Batch PDF: the main process renders one PDF page per selected capture and asks
  // for the destination itself, so this button follows the same cancel/failure
  // reporting shape as the copy export above.
  exportSelectedPdf.onclick = async () => {
    let result
    try {
      result = await window.electronAPI.exportHistoryPdf([...historySelectedIds])
    } catch (error) {
      toast(error.message || t('config.history.export-pdf-failed'))
      return
    }
    if (result.canceled) return
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.export-pdf-done', { count: result.exportedCount, failures: suffix }))
  }
  deleteSelected.onclick = async () => {
    if (!confirm(t('config.history.confirm-delete-selected', { count: historySelectedIds.size }))) return
    let result
    try {
      result = await window.electronAPI.deleteHistoryMany([...historySelectedIds])
    } catch (error) {
      toast(error.message || t('config.history.delete-failed'))
      return
    }
    historySelectedIds.clear()
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.deleted', { count: result.deletedCount, failures: suffix }))
    renderHistory()
  }
  loadMore.onclick = async () => {
    if (!hasMore || loadMore.disabled) return
    loadMore.disabled = true
    try {
      const page = await window.electronAPI.getHistory({
        query: historyQuery,
        source: historySource,
        cursor: nextCursor,
        limit: HISTORY_PAGE_SIZE
      })
      if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
      history = history.concat(Array.isArray(page?.items) ? page.items : [])
      nextCursor = page?.nextCursor || ''
      hasMore = page?.hasMore === true
      renderLoadedItems({ append: true })
    } catch (error) {
      loadMore.disabled = false
      toast(error.message || t('config.history.load-failed'))
    }
  }
  document.getElementById('cleanupHistory').onclick = async () => {
    if (!stats.missingCount && !stats.orphanCount) { toast(t('config.history.nothing-to-clean')); return }
    if (!confirm(t('config.history.confirm-cleanup', { missing: stats.missingCount, orphans: stats.orphanCount }))) return
    let result
    try {
      result = await window.electronAPI.cleanupHistory()
    } catch (error) {
      toast(error.message || t('config.history.cleanup-failed'))
      return
    }
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.cleaned', { entries: result.removedEntries, files: result.removedFiles, failures: suffix }))
    renderHistory()
  }
  document.getElementById('clearHistory').onclick = async () => {
    if (!confirm(t('config.history.confirm-clear-all'))) return
    try { historySelectedIds.clear(); await window.electronAPI.clearHistory(); renderHistory() }
    catch (error) { toast(error.message || t('config.history.clear-failed')); renderHistory() }
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderHistory'] = () => renderHistory()
