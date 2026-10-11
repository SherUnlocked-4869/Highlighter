// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 selection-toolbar（划词工具）渲染与事件绑定。

let draggedSelectionToolbarAction = ''

function renderSelectionToolbarSettings() {
  const toolbar = settings.selectionToolbar
  const customLimitReached = toolbar.customActions.length >= 12
  view.innerHTML = `<div class="page">${pageHeader('划词工具', '自定义工具栏顺序、内置提示词和你自己的 AI 功能。')}<section class="section"><h2 class="section-title">工具栏</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>启用划词工具栏</b><small>选中文本后显示已启用的快捷操作</small></div>${switchMarkup(toolbar.enabled, 'enabled', 'selectionToolbar')}</div><div class="form-row"><div class="form-label"><b>剪贴板兼容模式</b><small>仅在无法直接读取选区的应用中启用；可能与远程剪贴板软件冲突</small></div>${switchMarkup(toolbar.clipboardFallback, 'clipboardFallback', 'selectionToolbar')}</div></div></section><section class="section"><h2 class="section-title">功能与顺序 <small>拖动项目或使用箭头调整</small></h2><div class="card toolbar-order-list" id="toolbarOrderList">${selectionToolbarOrderMarkup(toolbar)}</div></section><section class="section"><h2 class="section-title">内置功能设置</h2><div class="card prompt-settings"><div class="prompt-setting"><label for="translatePrompt"><b>翻译提示词</b><small>用于划词工具栏的“翻译”功能</small></label><textarea class="textarea prompt-editor" id="translatePrompt" maxlength="6000">${escapeHtml(toolbar.prompts.translate)}</textarea></div><div class="prompt-setting"><label for="explainPrompt"><b>解释提示词</b><small>用于划词工具栏的“解释”功能</small></label><textarea class="textarea prompt-editor" id="explainPrompt" maxlength="6000">${escapeHtml(toolbar.prompts.explain)}</textarea></div><div class="form-row search-setting"><div class="form-label"><b>翻译思考强度</b><small>“翻译”功能请求 AI 时的思考深度，关闭时响应更快</small></div><select id="translateThinking"><option value="off">关</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></div><div class="form-row search-setting"><div class="form-label"><b>翻译原语言</b><small>“翻译”功能的源语言，自动识别适合大多数场景</small></div><select id="translateSourceLanguage"><option value="auto">自动识别</option><option value="中文">中文</option><option value="日文">日文</option><option value="英文">英文</option><option value="韩文">韩文</option></select></div><div class="form-row search-setting"><div class="form-label"><b>翻译目标语言</b><small>“翻译”功能的结果输出语言</small></div><select id="translateTargetLanguage"><option value="中文">中文</option><option value="日文">日文</option><option value="英文">英文</option></select></div><div class="form-row search-setting"><div class="form-label"><b>解释思考强度</b><small>“解释”功能请求 AI 时的思考深度，强度越高分析越深入</small></div><select id="explainThinking"><option value="off">关</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></div><div class="form-row search-setting"><div class="form-label"><b>搜索引擎</b><small>“搜索”功能使用系统默认浏览器打开</small></div><select id="searchEngine"><option value="bing">Bing</option><option value="baidu">百度</option><option value="google">Google</option></select></div></div></section><section class="section"><h2 class="section-title">划词追问</h2><div class="card prompt-settings"><div class="form-row"><div class="form-label"><b>追问开关</b><small>在结果窗口底部显示输入区，可就该结果继续提问；关闭后只影响追问，翻译与解释本身不受影响</small></div><div class="switch ${toolbar.conversation.enabled ? 'on' : ''}" id="conversationEnabled"></div></div><div class="form-row search-setting"><div class="form-label"><b>追问轮数</b><small>单次会话最多追问几轮，超出后需重新划词</small></div><select id="conversationTurns"><option value="3">3 轮</option><option value="5">5 轮</option><option value="10">10 轮</option><option value="20">20 轮</option></select></div><div class="form-row"><div class="form-label"><b>保存对话到本地</b><small>把已完成的划词对话存到本机，重启后仍可从托盘打开；关闭时会删除已保存的内容</small></div><div class="switch ${toolbar.conversation.persist ? 'on' : ''}" id="conversationPersist"></div></div></div></section><section class="section"><h2 class="section-title">自定义 AI 功能 <button class="button" id="addCustomToolbar" ${customLimitReached ? 'disabled' : ''}>＋ 添加功能</button></h2><div class="card custom-toolbar-list">${selectionToolbarCustomMarkup(toolbar)}</div>${customLimitReached ? '<small class="section-note">最多可创建 12 个自定义功能。</small>' : ''}</section><button class="button primary" id="saveSelectionToolbar">保存划词工具设置</button></div>`
  document.getElementById('searchEngine').value = toolbar.searchEngine || 'bing'
  const toolbarThinking = settings.toolbarThinking || {}
  const translateThinking = document.getElementById('translateThinking')
  const explainThinking = document.getElementById('explainThinking')
  translateThinking.value = ['off', 'low', 'high', 'max'].includes(toolbarThinking.translate) ? toolbarThinking.translate : 'off'
  explainThinking.value = ['off', 'low', 'high', 'max'].includes(toolbarThinking.explain) ? toolbarThinking.explain : 'high'
  translateThinking.onchange = () => updateSettings({ toolbarThinking: { translate: translateThinking.value } }, '翻译思考强度已更新')
  explainThinking.onchange = () => updateSettings({ toolbarThinking: { explain: explainThinking.value } }, '解释思考强度已更新')
  const translateLanguages = toolbar.translateLanguages || {}
  const translateSourceLanguage = document.getElementById('translateSourceLanguage')
  const translateTargetLanguage = document.getElementById('translateTargetLanguage')
  translateSourceLanguage.value = ['auto', '中文', '日文', '英文', '韩文'].includes(translateLanguages.source) ? translateLanguages.source : 'auto'
  translateTargetLanguage.value = ['中文', '日文', '英文'].includes(translateLanguages.target) ? translateLanguages.target : '中文'
  translateSourceLanguage.onchange = () => updateSettings({ selectionToolbar: { translateLanguages: { source: translateSourceLanguage.value } } }, '翻译原语言已更新')
  translateTargetLanguage.onchange = () => updateSettings({ selectionToolbar: { translateLanguages: { target: translateTargetLanguage.value } } }, '翻译目标语言已更新')
  const conversationTurns = document.getElementById('conversationTurns')
  const conversationEnabled = document.getElementById('conversationEnabled')
  conversationTurns.value = String(toolbar.conversation.maxFollowUpTurns)
  conversationTurns.disabled = toolbar.conversation.enabled !== true
  // conversation 是嵌套对象，而 bindSwitches() 只会发 { [group]: { [key]: value } } 这一层，
  // 用 data-switch 会发出 { selectionToolbar: { conversation: false } }，被设置校验当成类型错误拒掉，
  // 所以这个开关必须手写 handler。
  conversationEnabled.onclick = async () => {
    const value = !conversationEnabled.classList.contains('on')
    await updateSettings({ selectionToolbar: { conversation: { enabled: value } } }, '追问开关已更新')
    renderSelectionToolbarSettings()
  }
  conversationTurns.onchange = () => updateSettings({ selectionToolbar: { conversation: { maxFollowUpTurns: Number(conversationTurns.value) } } }, '追问轮数已更新')
  const conversationPersist = document.getElementById('conversationPersist')
  // Same nested-object reason as the switch above: this cannot use bindSwitches.
  // The main process reacts to the setting by trimming or deleting the store.
  conversationPersist.onclick = async () => {
    const value = !conversationPersist.classList.contains('on')
    await updateSettings(
      { selectionToolbar: { conversation: { persist: value } } },
      value ? '已开启本地保存' : '已关闭本地保存，已删除保存的对话'
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
      name: '新功能',
      prompt: '请根据要求处理这段文字。',
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
      if (!item || !confirm(`确定删除自定义功能“${item.name}”？`)) return
      const editor = readSelectionToolbarEditor(toolbar)
      if (!editor) return
      const customActions = editor.customActions.filter((candidate) => candidate.id !== id)
      const order = toolbar.order.filter((action) => action !== selectionToolbarCustomKey(id))
      await updateSettings({ selectionToolbar: { ...editor, customActions, order } }, '')
      renderSelectionToolbarSettings()
      toast('自定义功能已删除')
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
    }, '划词工具设置已保存')
    renderSelectionToolbarSettings()
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderSelectionToolbarSettings'] = () => renderSelectionToolbarSettings()
