// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 selection-toolbar（划词工具）渲染与事件绑定。

let draggedSelectionToolbarAction = ''

function renderSelectionToolbarSettings() {
  const toolbar = settings.selectionToolbar
  const customLimitReached = toolbar.customActions.length >= 12
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.selection-toolbar'), t('config.selection-toolbar.description'))}<section class="section"><h2 class="section-title">${t('config.selection-toolbar.toolbar-section')}</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.selection-toolbar.enable-toolbar')}</b><small>${t('config.selection-toolbar.enable-toolbar-hint')}</small></div>${switchMarkup(toolbar.enabled, 'enabled', 'selectionToolbar')}</div><div class="form-row"><div class="form-label"><b>${t('config.selection-toolbar.clipboard-fallback')}</b><small>${t('config.selection-toolbar.clipboard-fallback-hint')}</small></div>${switchMarkup(toolbar.clipboardFallback, 'clipboardFallback', 'selectionToolbar')}</div></div></section><section class="section"><h2 class="section-title">${t('config.selection-toolbar.order-section')} <small>${t('config.selection-toolbar.order-hint')}</small></h2><div class="card toolbar-order-list" id="toolbarOrderList">${selectionToolbarOrderMarkup(toolbar)}</div></section><section class="section"><h2 class="section-title">${t('config.selection-toolbar.builtin-section')}</h2><div class="card prompt-settings"><div class="prompt-setting"><label for="translatePrompt"><b>${t('config.selection-toolbar.translate-prompt')}</b><small>${t('config.selection-toolbar.translate-prompt-hint')}</small></label><textarea class="textarea prompt-editor" id="translatePrompt" maxlength="6000">${escapeHtml(toolbar.prompts.translate)}</textarea></div><div class="prompt-setting"><label for="explainPrompt"><b>${t('config.selection-toolbar.explain-prompt')}</b><small>${t('config.selection-toolbar.explain-prompt-hint')}</small></label><textarea class="textarea prompt-editor" id="explainPrompt" maxlength="6000">${escapeHtml(toolbar.prompts.explain)}</textarea></div><div class="form-row search-setting"><div class="form-label"><b>${t('config.selection-toolbar.translate-thinking')}</b><small>${t('config.selection-toolbar.translate-thinking-hint')}</small></div><select id="translateThinking"><option value="off">${t('config.selection-toolbar.thinking-off')}</option><option value="low">${t('config.selection-toolbar.thinking-low')}</option><option value="high">${t('config.selection-toolbar.thinking-high')}</option><option value="max">${t('config.selection-toolbar.thinking-max')}</option></select></div><div class="form-row search-setting"><div class="form-label"><b>${t('config.selection-toolbar.translate-source')}</b><small>${t('config.selection-toolbar.translate-source-hint')}</small></div><select id="translateSourceLanguage"><option value="auto">${t('config.selection-toolbar.source-auto')}</option><option value="中文">${t('config.language.zh')}</option><option value="日文">${t('config.language.ja')}</option><option value="英文">${t('config.language.en')}</option><option value="韩文">${t('config.language.ko')}</option></select></div><div class="form-row search-setting"><div class="form-label"><b>${t('config.selection-toolbar.translate-target')}</b><small>${t('config.selection-toolbar.translate-target-hint')}</small></div><select id="translateTargetLanguage"><option value="中文">${t('config.language.zh')}</option><option value="日文">${t('config.language.ja')}</option><option value="英文">${t('config.language.en')}</option></select></div><div class="form-row search-setting"><div class="form-label"><b>${t('config.selection-toolbar.explain-thinking')}</b><small>${t('config.selection-toolbar.explain-thinking-hint')}</small></div><select id="explainThinking"><option value="off">${t('config.selection-toolbar.thinking-off')}</option><option value="low">${t('config.selection-toolbar.thinking-low')}</option><option value="high">${t('config.selection-toolbar.thinking-high')}</option><option value="max">${t('config.selection-toolbar.thinking-max')}</option></select></div><div class="form-row search-setting"><div class="form-label"><b>${t('config.selection-toolbar.search-engine')}</b><small>${t('config.selection-toolbar.search-engine-hint')}</small></div><select id="searchEngine"><option value="bing">Bing</option><option value="baidu">${t('config.selection-toolbar.search-engine-baidu')}</option><option value="google">Google</option></select></div></div></section><section class="section"><h2 class="section-title">${t('config.selection-toolbar.conversation-section')}</h2><div class="card prompt-settings"><div class="form-row"><div class="form-label"><b>${t('config.selection-toolbar.conversation-enabled')}</b><small>${t('config.selection-toolbar.conversation-enabled-hint')}</small></div><div class="switch ${toolbar.conversation.enabled ? 'on' : ''}" id="conversationEnabled"></div></div><div class="form-row search-setting"><div class="form-label"><b>${t('config.selection-toolbar.conversation-turns')}</b><small>${t('config.selection-toolbar.conversation-turns-hint')}</small></div><select id="conversationTurns"><option value="3">${t('config.selection-toolbar.conversation-turns-option', { count: 3 })}</option><option value="5">${t('config.selection-toolbar.conversation-turns-option', { count: 5 })}</option><option value="10">${t('config.selection-toolbar.conversation-turns-option', { count: 10 })}</option><option value="20">${t('config.selection-toolbar.conversation-turns-option', { count: 20 })}</option></select></div><div class="form-row"><div class="form-label"><b>${t('config.selection-toolbar.conversation-persist')}</b><small>${t('config.selection-toolbar.conversation-persist-hint')}</small></div><div class="switch ${toolbar.conversation.persist ? 'on' : ''}" id="conversationPersist"></div></div></div></section><section class="section"><h2 class="section-title">${t('config.selection-toolbar.custom-section')} <button class="button" id="addCustomToolbar" ${customLimitReached ? 'disabled' : ''}>${t('config.selection-toolbar.add-custom')}</button></h2><div class="card custom-toolbar-list">${selectionToolbarCustomMarkup(toolbar)}</div>${customLimitReached ? '<small class="section-note">' + t('config.selection-toolbar.custom-limit') + '</small>' : ''}</section><button class="button primary" id="saveSelectionToolbar">${t('config.selection-toolbar.save')}</button></div>`
  document.getElementById('searchEngine').value = toolbar.searchEngine || 'bing'
  const toolbarThinking = settings.toolbarThinking || {}
  const translateThinking = document.getElementById('translateThinking')
  const explainThinking = document.getElementById('explainThinking')
  translateThinking.value = ['off', 'low', 'high', 'max'].includes(toolbarThinking.translate) ? toolbarThinking.translate : 'off'
  explainThinking.value = ['off', 'low', 'high', 'max'].includes(toolbarThinking.explain) ? toolbarThinking.explain : 'high'
  translateThinking.onchange = () => updateSettings({ toolbarThinking: { translate: translateThinking.value } }, t('config.selection-toolbar.translate-thinking-updated'))
  explainThinking.onchange = () => updateSettings({ toolbarThinking: { explain: explainThinking.value } }, t('config.selection-toolbar.explain-thinking-updated'))
  const translateLanguages = toolbar.translateLanguages || {}
  const translateSourceLanguage = document.getElementById('translateSourceLanguage')
  const translateTargetLanguage = document.getElementById('translateTargetLanguage')
  translateSourceLanguage.value = ['auto', '中文', '日文', '英文', '韩文'].includes(translateLanguages.source) ? translateLanguages.source : 'auto'
  translateTargetLanguage.value = ['中文', '日文', '英文'].includes(translateLanguages.target) ? translateLanguages.target : '中文'
  translateSourceLanguage.onchange = () => updateSettings({ selectionToolbar: { translateLanguages: { source: translateSourceLanguage.value } } }, t('config.selection-toolbar.translate-source-updated'))
  translateTargetLanguage.onchange = () => updateSettings({ selectionToolbar: { translateLanguages: { target: translateTargetLanguage.value } } }, t('config.selection-toolbar.translate-target-updated'))
  const conversationTurns = document.getElementById('conversationTurns')
  const conversationEnabled = document.getElementById('conversationEnabled')
  conversationTurns.value = String(toolbar.conversation.maxFollowUpTurns)
  conversationTurns.disabled = toolbar.conversation.enabled !== true
  // conversation 是嵌套对象，而 bindSwitches() 只会发 { [group]: { [key]: value } } 这一层，
  // 用 data-switch 会发出 { selectionToolbar: { conversation: false } }，被设置校验当成类型错误拒掉，
  // 所以这个开关必须手写 handler。
  conversationEnabled.onclick = async () => {
    const value = !conversationEnabled.classList.contains('on')
    await updateSettings({ selectionToolbar: { conversation: { enabled: value } } }, t('config.selection-toolbar.conversation-enabled-updated'))
    renderSelectionToolbarSettings()
  }
  conversationTurns.onchange = () => updateSettings({ selectionToolbar: { conversation: { maxFollowUpTurns: Number(conversationTurns.value) } } }, t('config.selection-toolbar.conversation-turns-updated'))
  const conversationPersist = document.getElementById('conversationPersist')
  // Same nested-object reason as the switch above: this cannot use bindSwitches.
  // The main process reacts to the setting by trimming or deleting the store.
  conversationPersist.onclick = async () => {
    const value = !conversationPersist.classList.contains('on')
    await updateSettings(
      { selectionToolbar: { conversation: { persist: value } } },
      value ? t('config.selection-toolbar.persist-enabled') : t('config.selection-toolbar.persist-disabled')
    )
    renderSelectionToolbarSettings()
  }
  toolbar.customActions.forEach((item) => {
    const select = document.querySelector(`[data-custom-toolbar="${item.id}"] [data-custom-thinking]`)
    if (select) select.value = ['off', 'low', 'high', 'max'].includes(item.thinking) ? item.thinking : 'high'
  })
  bindSwitches()

  document.querySelectorAll('[data-toolbar-button]').forEach((element) => {
    element.onclick = async () => {
      const key = element.dataset.toolbarButton
      const value = !element.classList.contains('on')
      if (selectionToolbarBuiltinMeta[key]?.optional) {
        const order = settings.selectionToolbar.order.filter((action) => action !== key)
        if (value) order.push(key)
        await updateSettings({ selectionToolbar: { order } }, '')
        renderSelectionToolbarSettings()
        return
      }
      await updateSettings({ selectionToolbar: { buttons: { [key]: value } } }, '')
      element.classList.toggle('on', value)
    }
  })
  document.querySelectorAll('[data-custom-toolbar-toggle]').forEach((element) => {
    element.onclick = async () => {
      const id = element.dataset.customToolbarToggle
      const editor = readSelectionToolbarEditor(toolbar)
      if (!editor) return
      const customActions = editor.customActions.map((item) => item.id === id ? { ...item, enabled: !element.classList.contains('on') } : item)
      toolbar.customActions = customActions
      await updateSettings({ selectionToolbar: { ...editor, customActions } }, '')
      element.classList.toggle('on', settings.selectionToolbar.customActions.find((item) => item.id === id)?.enabled !== false)
    }
  })
  document.querySelectorAll('[data-move-toolbar]').forEach((button) => {
    button.onclick = () => {
      const index = settings.selectionToolbar.order.indexOf(button.dataset.moveToolbar)
      void moveSelectionToolbarAction(button.dataset.moveToolbar, index + Number(button.dataset.direction))
    }
  })
  document.querySelectorAll('[data-toolbar-order]').forEach((row) => {
    row.ondragstart = () => {
      draggedSelectionToolbarAction = row.dataset.toolbarOrder
      row.classList.add('dragging')
    }
    row.ondragend = () => {
      draggedSelectionToolbarAction = ''
      row.classList.remove('dragging')
    }
    row.ondragover = (event) => {
      event.preventDefault()
      row.classList.add('drag-over')
    }
    row.ondragleave = () => row.classList.remove('drag-over')
    row.ondrop = (event) => {
      event.preventDefault()
      row.classList.remove('drag-over')
      const targetIndex = settings.selectionToolbar.order.indexOf(row.dataset.toolbarOrder)
      if (draggedSelectionToolbarAction) void moveSelectionToolbarAction(draggedSelectionToolbarAction, targetIndex)
    }
  })
  document.getElementById('addCustomToolbar').onclick = async () => {
    const editor = readSelectionToolbarEditor(toolbar)
    if (!editor) return
    const id = createSelectionToolbarActionId()
    const customActions = [...editor.customActions, {
      id,
      name: t('config.selection-toolbar.new-custom-name'),
      prompt: t('config.selection-toolbar.new-custom-prompt'),
      enabled: true,
      thinking: 'high'
    }]
    const order = [...toolbar.order, selectionToolbarCustomKey(id)]
    await updateSettings({ selectionToolbar: { ...editor, customActions, order } }, '')
    renderSelectionToolbarSettings()
    document.querySelector(`[data-custom-toolbar="${id}"] [data-custom-name]`)?.focus()
  }
  document.querySelectorAll('[data-delete-custom-toolbar]').forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.deleteCustomToolbar
      const item = toolbar.customActions.find((candidate) => candidate.id === id)
      if (!item || !confirm(t('config.selection-toolbar.confirm-delete-custom', { name: item.name }))) return
      const editor = readSelectionToolbarEditor(toolbar)
      if (!editor) return
      const customActions = editor.customActions.filter((candidate) => candidate.id !== id)
      const order = toolbar.order.filter((action) => action !== selectionToolbarCustomKey(id))
      await updateSettings({ selectionToolbar: { ...editor, customActions, order } }, '')
      renderSelectionToolbarSettings()
      toast(t('config.selection-toolbar.custom-deleted'))
    }
  })
  document.getElementById('saveSelectionToolbar').onclick = async () => {
    const editor = readSelectionToolbarEditor(toolbar)
    if (!editor) return
    await updateSettings({
      selectionToolbar: {
        ...editor,
        order: toolbar.order,
      }
    }, t('config.selection-toolbar.saved'))
    renderSelectionToolbarSettings()
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderSelectionToolbarSettings'] = () => renderSelectionToolbarSettings()
