// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 local-search（本地搜索）。

function renderLocalSearch() {
  window.setConfigDirty?.('local-search-categories', false)
  const draft = (settings.search.categories || []).map((category) => ({ ...category }))
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.local-search'), t('config.local-search.description'))}
    <section class="section"><h2 class="section-title">${t('config.local-search.search-section')}</h2><div class="card form-card">
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.status')}</b><small id="searchStatusDetail">${t('config.local-search.status-detecting')}</small></div><span id="searchStatus">${t('config.local-search.status-checking')}</span></div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.open-window')}</b><small>${t('config.local-search.open-window-hint')}</small></div><button class="button" id="openSearchWindow">${t('config.local-search.open')}</button></div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.match-path')}</b><small>${t('config.local-search.match-path-hint')}</small></div>${switchMarkup(settings.search.matchPath, 'matchPath', 'search')}</div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.max-results')}</b><small>${t('config.local-search.max-results-hint')}</small></div><input id="searchMaxResults" type="number" min="100" max="2000" step="50" value="${settings.search.maxResults}"></div>
      <div class="form-row"><div class="form-label"><b>${t('config.local-search.auto-start')}</b><small>${t('config.local-search.auto-start-hint')}</small></div>${switchMarkup(settings.search.useBundledEverything !== false, 'useBundledEverything', 'search')}</div>
    </div></section>
    <section class="section search-categories" aria-labelledby="searchCategoriesTitle">
      <h2 class="section-title" id="searchCategoriesTitle">${t('config.local-search.categories-section')}</h2>
      <div class="card form-card" id="categoryEditor"></div>
      <div class="category-actions">
        <button type="button" class="button" id="addCategory">${t('config.local-search.add-category')}</button>
        <div class="category-commit-actions">
          <button type="button" class="button subtle" id="resetCategories">${t('config.local-search.reset-categories')}</button>
          <button type="button" class="button primary" id="saveCategories">${t('config.local-search.save-categories')}</button>
        </div>
      </div>
    </section>
  </div>`

  const nameLabel = t('config.local-search.category-name')
  const ruleLabel = t('config.local-search.category-rule-label')
  const ruleHint = t('config.local-search.category-rule')
  const renderCategoryEditor = () => {
    const editor = document.getElementById('categoryEditor')
    editor.innerHTML = draft.length ? `<div class="category-columns" aria-hidden="true"><span>${nameLabel}</span><span>${ruleLabel}</span></div>${draft.map((category, index) => `
      <div class="form-row category-row" data-index="${index}">
        <label class="category-field"><span>${nameLabel}</span><input class="category-label" type="text" value="${escapeHtml(t(category.label))}"></label>
        <label class="category-field"><span>${ruleLabel}</span><input class="category-rule" type="text" placeholder="${escapeHtml(ruleHint)}" value="${escapeHtml(category.rule)}"></label>
        <button type="button" class="button subtle danger category-delete" data-index="${index}">${t('config.local-search.delete-category')}</button>
      </div>`).join('')}` : `<p class="category-empty">${t('config.local-search.no-categories')}</p>`
    editor.querySelectorAll('.category-delete').forEach((button) => {
      button.onclick = () => {
        draft.splice(Number(button.dataset.index), 1)
        window.setConfigDirty?.('local-search-categories', true)
        renderCategoryEditor()
      }
    })
    editor.querySelectorAll('input').forEach((input) => {
      input.oninput = () => window.setConfigDirty?.('local-search-categories', true)
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
    window.setConfigDirty?.('local-search-categories', false)
  }

  // P2: the result limit saves as soon as the field is committed (blur or Enter);
  // the category editor above keeps its draft plus explicit save button.
  const maxResultsInput = document.getElementById('searchMaxResults')
  maxResultsInput.onchange = () => {
    const clamped = Math.max(100, Math.min(2000, Number(maxResultsInput.value) || 600))
    maxResultsInput.value = String(clamped)
    updateSettings({ search: { maxResults: clamped } })
  }
  document.getElementById('openSearchWindow').onclick = () => window.electronAPI.executeFunction('localSearch')
  document.getElementById('addCategory').onclick = () => {
    draft.push({ id: `custom-${Date.now()}`, label: t('config.local-search.new-category'), rule: 'ext:' })
    window.setConfigDirty?.('local-search-categories', true)
    renderCategoryEditor()
  }
  document.getElementById('resetCategories').onclick = async () => {
    await updateSettings({ search: { categories: SEARCH_DEFAULT_CATEGORIES.map((category) => ({ ...category })) } }, t('config.local-search.categories-restored'))
    draft.splice(0, draft.length, ...SEARCH_DEFAULT_CATEGORIES.map((category) => ({ ...category })))
    renderCategoryEditor()
    window.setConfigDirty?.('local-search-categories', false)
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
