// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 local-search（本地搜索）。

function renderLocalSearch() {
  const draft = (settings.search.categories || []).map((category) => ({ ...category }))
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.local-search'), t('config.local-search.description'))}
    <section class="section"><h2 class="section-title">${t('config.local-search.search-section')}</h2><div class="card form-card">
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.status')}</b><small id="searchStatusDetail">${t('config.local-search.status-detecting')}</small></div><span id="searchStatus">${t('config.local-search.status-checking')}</span></div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.open-window')}</b><small>${t('config.local-search.open-window-hint')}</small></div><button class="button" id="openSearchWindow">${t('config.local-search.open')}</button></div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.match-path')}</b><small>${t('config.local-search.match-path-hint')}</small></div>${switchMarkup(settings.search.matchPath, 'matchPath', 'search')}</div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.max-results')}</b><small>${t('config.local-search.max-results-hint')}</small></div><input id="searchMaxResults" type="number" min="100" max="2000" step="50" value="${settings.search.maxResults}"></div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.auto-start')}</b><small>${t('config.local-search.auto-start-hint')}</small></div>${switchMarkup(settings.search.useBundledEverything !== false, 'useBundledEverything', 'search')}</div>
    </div></section>
    <section class="section"><h2 class="section-title">${t('config.local-search.categories-section')}</h2><div class="card form-card" id="categoryEditor"></div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="button" id="addCategory">${t('config.local-search.add-category')}</button><button class="button" id="resetCategories">${t('config.local-search.reset-categories')}</button><button class="button primary" id="saveCategories">${t('config.local-search.save-categories')}</button></div>
    </section>
    <button class="button primary" id="saveSearch" style="margin-top:16px">${t('config.local-search.save')}</button></div>`

  const renderCategoryEditor = () => {
    const editor = document.getElementById('categoryEditor')
    editor.innerHTML = draft.map((category, index) => `<div class="form-row" data-index="${index}"><div class="form-label"><b>${index === 0 ? t('config.local-search.category') : ''}</b></div><input class="category-label" type="text" placeholder="${t('config.local-search.category-name')}" value="${escapeHtml(t(category.label))}"><input class="category-rule" type="text" placeholder="${t('config.local-search.category-rule')}" value="${escapeHtml(category.rule)}"><button class="button danger category-delete" data-index="${index}">${t('config.local-search.delete-category')}</button></div>`).join('') || '<div class="form-row">' + t('config.local-search.no-categories') + '</div>'
    editor.querySelectorAll('.category-delete').forEach((button) => {
      button.onclick = () => {
        draft.splice(Number(button.dataset.index), 1)
        renderCategoryEditor()
      }
    })
    editor.querySelectorAll('input').forEach((input) => {
      input.onchange = () => {
        const row = input.closest('.form-row')
        const index = Number(row?.dataset.index)
        if (!Number.isInteger(index) || !draft[index]) return
        if (input.classList.contains('category-label')) draft[index].label = input.value.trim()
        else draft[index].rule = input.value.trim()
      }
    })
  }
  renderCategoryEditor()

  const saveCategories = async () => {
    const cleaned = draft
      .map((category, index) => ({ id: category.id || `custom-${index}`, label: String(category.label || '').trim(), rule: String(category.rule || '').trim() }))
      .filter((category) => category.label && category.rule !== undefined)
    if (!cleaned.length) {
      toast(t('config.local-search.keep-one-category'))
      return
    }
    await updateSettings({ search: { categories: cleaned } }, t('config.local-search.categories-saved'))
    draft.splice(0, draft.length, ...cleaned.map((category) => ({ ...category })))
    renderCategoryEditor()
  }

  document.getElementById('saveSearch').onclick = () => updateSettings({ search: { maxResults: Math.max(100, Math.min(2000, Number(document.getElementById('searchMaxResults').value) || 600)) } })
  document.getElementById('openSearchWindow').onclick = () => window.electronAPI.executeFunction('localSearch')
  document.getElementById('addCategory').onclick = () => {
    draft.push({ id: `custom-${Date.now()}`, label: t('config.local-search.new-category'), rule: 'ext:' })
    renderCategoryEditor()
  }
  document.getElementById('resetCategories').onclick = async () => {
    await updateSettings({ search: { categories: SEARCH_DEFAULT_CATEGORIES.map((category) => ({ ...category })) } }, t('config.local-search.categories-restored'))
    draft.splice(0, draft.length, ...SEARCH_DEFAULT_CATEGORIES.map((category) => ({ ...category })))
    renderCategoryEditor()
  }
  document.getElementById('saveCategories').onclick = () => saveCategories()

  bindSwitches()
  window.electronAPI.getSearchStatus().then((status) => {
    const statusLabel = document.getElementById('searchStatus')
    const statusDetail = document.getElementById('searchStatusDetail')
    if (!statusLabel || !statusDetail) return
    if (!status?.running) {
      statusLabel.textContent = t('config.local-search.status-not-running')
      statusDetail.textContent = status?.available ? t('config.local-search.detail-not-detected') : t('config.local-search.detail-missing')
      return
    }
    if (status.ipcAvailable === false) {
      statusLabel.textContent = t('config.local-search.status-running')
      statusDetail.textContent = t('config.local-search.detail-ipc-unavailable')
      return
    }
    statusLabel.textContent = status.phase === 'ready' ? t('config.local-search.status-ready') : (status.phase === 'error' ? t('config.local-search.status-error') : (status.phase === 'waiting' ? t('config.local-search.status-starting') : t('config.local-search.status-detecting-short')))
    statusDetail.textContent = status.version ? `${t('config.local-search.version', { version: status.version })}${Number(status.probeTotal) === 0 ? t('config.local-search.index-empty') : ''}` : t('config.local-search.everything-running')
  }).catch(() => {
    const statusLabel = document.getElementById('searchStatus')
    if (statusLabel) statusLabel.textContent = t('config.local-search.check-failed')
  })
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderLocalSearch'] = () => renderLocalSearch()
