// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 local-search（本地搜索）。

function renderLocalSearch() {
  const draft = (settings.search.categories || []).map((category) => ({ ...category }))
  view.innerHTML = `<div class="page">${pageHeader('本地搜索', '使用 Everything 快速搜索本地文件，按 Ctrl+Enter 打开文件所在目录。')}
    <section class="section"><h2 class="section-title">搜索</h2><div class="card form-card">
      <div class="form-row"><div class="form-label"><b>运行状态</b><small id="searchStatusDetail">正在检测 Everything</small></div><span id="searchStatus">检查中</span></div>
      <div class="form-row"><div class="form-label"><b>打开搜索窗口</b><small>也可在“热键设置”中自定义快捷键</small></div><button class="button" id="openSearchWindow">打开</button></div>
      <div class="form-row"><div class="form-label"><b>匹配路径</b><small>普通关键字同时匹配文件名与完整路径</small></div>${switchMarkup(settings.search.matchPath, 'matchPath', 'search')}</div>
      <div class="form-row"><div class="form-label"><b>单次结果上限</b><small>每次查询最多返回的结果数量（100 - 2000）</small></div><input id="searchMaxResults" type="number" min="100" max="2000" step="50" value="${settings.search.maxResults}"></div>
      <div class="form-row"><div class="form-label"><b>自动启动内置 Everything</b><small>未检测到运行中的 Everything 时，自动启动随应用分发的便携版</small></div>${switchMarkup(settings.search.useBundledEverything !== false, 'useBundledEverything', 'search')}</div>
    </div></section>
    <section class="section"><h2 class="section-title">搜索分类</h2><div class="card form-card" id="categoryEditor"></div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="button" id="addCategory">添加分类</button><button class="button" id="resetCategories">恢复默认分类</button><button class="button primary" id="saveCategories">保存分类</button></div>
    </section>
    <button class="button primary" id="saveSearch" style="margin-top:16px">保存</button></div>`

  const renderCategoryEditor = () => {
    const editor = document.getElementById('categoryEditor')
    editor.innerHTML = draft.map((category, index) => `<div class="form-row" data-index="${index}"><div class="form-label"><b>${index === 0 ? '分类' : ''}</b></div><input class="category-label" type="text" placeholder="名称" value="${escapeHtml(category.label)}"><input class="category-rule" type="text" placeholder="规则，如 ext:pdf 或 folder:" value="${escapeHtml(category.rule)}"><button class="button danger category-delete" data-index="${index}">删除</button></div>`).join('') || '<div class="form-row">暂无分类</div>'
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
      toast('至少保留一个分类')
      return
    }
    await updateSettings({ search: { categories: cleaned } }, '分类已保存')
    draft.splice(0, draft.length, ...cleaned.map((category) => ({ ...category })))
    renderCategoryEditor()
  }

  document.getElementById('saveSearch').onclick = () => updateSettings({ search: { maxResults: Math.max(100, Math.min(2000, Number(document.getElementById('searchMaxResults').value) || 600)) } })
  document.getElementById('openSearchWindow').onclick = () => window.electronAPI.executeFunction('localSearch')
  document.getElementById('addCategory').onclick = () => {
    draft.push({ id: `custom-${Date.now()}`, label: '新分类', rule: 'ext:' })
    renderCategoryEditor()
  }
  document.getElementById('resetCategories').onclick = async () => {
    await updateSettings({ search: { categories: SEARCH_DEFAULT_CATEGORIES.map((category) => ({ ...category })) } }, '已恢复默认分类')
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
      statusLabel.textContent = '未运行'
      statusDetail.textContent = status?.available ? '未检测到运行中的 Everything，打开搜索窗口时将自动启动内置便携版' : '本地组件缺失，请重新安装应用'
      return
    }
    if (status.ipcAvailable === false) {
      statusLabel.textContent = '运行中'
      statusDetail.textContent = '检测到 Everything，但无法与之通信（可能权限不一致，请以相同权限运行）'
      return
    }
    statusLabel.textContent = status.phase === 'ready' ? '已就绪' : (status.phase === 'error' ? '异常' : (status.phase === 'waiting' ? '启动中' : '检测中'))
    statusDetail.textContent = status.version ? `Everything v${status.version}${Number(status.probeTotal) === 0 ? ' · 索引暂无内容' : ''}` : 'Everything 运行中'
  }).catch(() => {
    const statusLabel = document.getElementById('searchStatus')
    if (statusLabel) statusLabel.textContent = '检查失败'
  })
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderLocalSearch'] = () => renderLocalSearch()
