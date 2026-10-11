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
  const headerActions = '<div class="page-head-actions"><button class="button" id="cleanupHistory">清理失效项</button><button class="button danger" id="clearHistory">清空全部</button></div>'
  view.innerHTML = `<div class="page">${pageHeader('截图历史', '搜索、筛选和批量管理截图。', headerActions)}<div class="empty">正在加载…</div></div>`
  const [firstPage, sources, stats] = await Promise.all([
    window.electronAPI.getHistory({
      query: historyQuery,
      source: historySource,
      limit: HISTORY_PAGE_SIZE
    }),
    window.electronAPI.getHistorySources(),
    window.electronAPI.getHistoryStats()
  ])
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
    capture: '区域截图',
    region: '区域截图',
    'long-capture': '长截图',
    'focused-window': '焦点窗口',
    file: '本地图片',
    history: '历史编辑',
    'quick-save': '快速保存',
    'save-as': '另存为'
  }
  const sourceOptions = sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(sourceLabels[source] || source)}</option>`).join('')
  const statsMarkup = `<div class="history-stats card"><div><b>${formatBytes(stats.totalBytes)}</b><span>占用空间</span></div><div><b>${stats.availableCount}</b><span>有效记录</span></div><div class="${stats.missingCount ? 'warning' : ''}"><b>${stats.missingCount}</b><span>失效记录</span></div><div class="${stats.orphanCount ? 'warning' : ''}"><b>${stats.orphanCount}</b><span>孤立文件 · ${formatBytes(stats.orphanBytes)}</span></div></div>`
  const filtersMarkup = `<div class="history-filters card"><input class="input" id="historySearch" type="search" value="${escapeHtml(historyQuery)}" placeholder="搜索来源、操作或文件名"><select id="historySource"><option value="">全部来源</option>${sourceOptions}</select><span id="historyLoadedCount"></span></div>`
  const batchMarkup = `<div class="history-batch card"><label><input type="checkbox" id="selectAllHistory"> 全选已加载项</label><span id="historySelectedCount">已选择 0 项</span><button class="button" id="exportSelectedHistory" disabled>导出选中项</button><button class="button danger" id="deleteSelectedHistory" disabled>删除选中项</button></div>`
  container.insertAdjacentHTML('beforeend', `${statsMarkup}${filtersMarkup}${batchMarkup}<div id="historyResults"></div><div class="history-load-more"><button class="button" id="loadMoreHistory">加载更多</button></div>`)

  const searchInput = document.getElementById('historySearch')
  const sourceSelect = document.getElementById('historySource')
  const selectAll = document.getElementById('selectAllHistory')
  const selectedCount = document.getElementById('historySelectedCount')
  const exportSelected = document.getElementById('exportSelectedHistory')
  const deleteSelected = document.getElementById('deleteSelectedHistory')
  const loadedCount = document.getElementById('historyLoadedCount')
  const results = document.getElementById('historyResults')
  const loadMore = document.getElementById('loadMoreHistory')
  const updateSelectionControls = () => {
    const count = historySelectedIds.size
    selectedCount.textContent = `已选择 ${count} 项`
    exportSelected.disabled = count === 0
    deleteSelected.disabled = count === 0
    selectAll.checked = history.length > 0 && count === history.length
    selectAll.indeterminate = count > 0 && count < history.length
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
        imageElement.closest('.history-image')?.classList.add('unavailable')
      }
    } catch {
      imageElement.closest('.history-image')?.classList.add('unavailable')
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
          if (!opened) toast('截图文件不存在')
        } catch (error) { toast(error.message || '无法使用默认应用打开截图') }
      }
      if (action === 'copy') { const copied = await window.electronAPI.copyHistory(id); toast(copied ? '截图已复制' : '图片过大，请从保存位置使用') }
      if (action === 'address') {
        try {
          const copied = await window.electronAPI.copyHistoryPath(id)
          toast(copied ? '图片地址已复制' : '截图文件不存在')
        } catch (error) { toast(error.message || '无法复制图片地址') }
      }
      if (action === 'delete') {
        try { historySelectedIds.delete(id); await window.electronAPI.deleteHistory(id) }
        catch (error) { toast(error.message || '图片文件删除失败') }
      }
    })
  }
  const historyCardMarkup = (item) => {
    const selected = historySelectedIds.has(String(item.id))
    return `<article class="card history-item ${selected ? 'selected' : ''}"><label class="history-select" title="选择此项"><input type="checkbox" data-history-select data-id="${escapeHtml(item.id)}" ${selected ? 'checked' : ''}></label><div class="history-image"><img data-history-thumbnail="${escapeHtml(item.id)}" loading="lazy" decoding="async" alt=""></div><div class="history-meta"><span class="history-meta-time">${new Date(item.createdAt).toLocaleString()}</span><span class="history-meta-sub">${escapeHtml(sourceLabels[item.source] || item.source)} · ${escapeHtml(item.width)}×${escapeHtml(item.height)}</span></div><div class="history-actions">${item.longCapture ? '' : `<button data-history-action="edit" data-id="${escapeHtml(item.id)}">编辑</button>`}<button data-history-action="open" data-id="${escapeHtml(item.id)}">打开</button><button data-history-action="copy" data-id="${escapeHtml(item.id)}">复制</button><button data-history-action="address" data-id="${escapeHtml(item.id)}">地址</button><button class="history-delete" data-history-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div></article>`
  }
  let renderedHistoryCount = 0
  const renderLoadedItems = ({ append = false } = {}) => {
    if (!history.length) {
      results.innerHTML = '<div class="empty">没有符合条件的截图历史</div>'
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
    loadedCount.textContent = totalCount > history.length ? `${history.length}/${totalCount} 项` : `${totalCount} 项`
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
    const result = await window.electronAPI.exportHistory([...historySelectedIds])
    if (result.canceled) return
    const suffix = result.failures?.length ? `，${result.failures.length} 项失败` : ''
    toast(`已导出 ${result.exportedCount} 项${suffix}`)
  }
  deleteSelected.onclick = async () => {
    if (!confirm(`确定删除选中的 ${historySelectedIds.size} 项截图及对应文件？`)) return
    const result = await window.electronAPI.deleteHistoryMany([...historySelectedIds])
    historySelectedIds.clear()
    const suffix = result.failures?.length ? `，${result.failures.length} 项失败` : ''
    toast(`已删除 ${result.deletedCount} 项${suffix}`)
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
      toast(error.message || '加载截图历史失败')
    }
  }
  document.getElementById('cleanupHistory').onclick = async () => {
    if (!stats.missingCount && !stats.orphanCount) { toast('没有需要清理的项目'); return }
    if (!confirm(`将移除 ${stats.missingCount} 条失效记录，并删除 ${stats.orphanCount} 个未被引用的 Highlighter 文件，是否继续？`)) return
    const result = await window.electronAPI.cleanupHistory()
    const suffix = result.failures?.length ? `，${result.failures.length} 项失败` : ''
    toast(`已清理 ${result.removedEntries} 条记录和 ${result.removedFiles} 个文件${suffix}`)
    renderHistory()
  }
  document.getElementById('clearHistory').onclick = async () => {
    if (!confirm('确定清空全部截图历史并删除对应图片文件？')) return
    try { historySelectedIds.clear(); await window.electronAPI.clearHistory(); renderHistory() }
    catch (error) { toast(error.message || '部分图片文件删除失败'); renderHistory() }
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderHistory'] = () => renderHistory()
