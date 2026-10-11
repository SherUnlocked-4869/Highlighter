// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 selection-toolbar 的取值/校验 helper 与“功能与顺序”标记（D2-3：巨型路由再分解）。

function selectionToolbarCustomKey(id) {
  return `custom:${id}`
}

function selectionToolbarActionInfo(toolbar, action) {
  const builtin = selectionToolbarBuiltinMeta[action]
  if (builtin) return { ...builtin, enabled: toolbar.buttons[action] !== false, custom: false }
  const id = action.startsWith('custom:') ? action.slice(7) : ''
  const custom = toolbar.customActions.find((item) => item.id === id)
  if (!custom) return null
  return {
    label: custom.name,
    icon: 'stars',
    description: `自定义 AI 功能 · ${custom.prompt}`,
    enabled: custom.enabled !== false,
    custom: true,
    id
  }
}

function selectionToolbarOrderMarkup(toolbar) {
  const optionalActions = Object.keys(selectionToolbarBuiltinMeta).filter((action) => selectionToolbarBuiltinMeta[action].optional && !toolbar.order.includes(action))
  const actions = [...toolbar.order, ...optionalActions]
  return actions.map((action, index) => {
    const info = selectionToolbarActionInfo(toolbar, action)
    if (!info) return ''
    const inOrder = toolbar.order.includes(action)
    const enabled = info.custom ? info.enabled : (info.optional ? inOrder : info.enabled)
    const toggle = info.custom
      ? `<div class="switch ${info.enabled ? 'on' : ''}" data-custom-toolbar-toggle="${escapeHtml(info.id)}"></div>`
      : `<div class="switch ${enabled ? 'on' : ''}" data-toolbar-button="${action}"></div>`
    const movable = info.custom || inOrder
    return `<div class="toolbar-order-row" draggable="true" data-toolbar-order="${escapeHtml(action)}"><span class="toolbar-drag" title="拖动排序">⋮⋮</span><span class="toolbar-order-icon">${toolbarIconMarkup(info.icon)}</span><div class="form-label"><b>${escapeHtml(info.label)}</b><small>${escapeHtml(info.description)}</small></div>${toggle}<div class="toolbar-order-actions"><button class="button icon-button" data-move-toolbar="${escapeHtml(action)}" data-direction="-1" ${index === 0 || !movable ? 'disabled' : ''} title="上移">↑</button><button class="button icon-button" data-move-toolbar="${escapeHtml(action)}" data-direction="1" ${index === actions.length - 1 || !movable ? 'disabled' : ''} title="下移">↓</button></div></div>`
  }).join('')
}

function selectionToolbarCustomMarkup(toolbar) {
  if (!toolbar.customActions.length) return '<div class="empty compact-empty">暂无自定义功能，点击“添加功能”创建。</div>'
  return toolbar.customActions.map((item) => `<article class="custom-toolbar-card" data-custom-toolbar="${escapeHtml(item.id)}"><div class="custom-toolbar-head"><label>功能名称<input type="text" maxlength="16" data-custom-name value="${escapeHtml(item.name)}" placeholder="例如：优化"></label><label>思考强度<select data-custom-thinking title="请求 AI 时的思考深度"><option value="off">关</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></label><button class="button danger" data-delete-custom-toolbar="${escapeHtml(item.id)}">删除</button></div><label>提示词<textarea class="textarea prompt-editor custom-prompt" maxlength="6000" data-custom-prompt placeholder="例如：优化这段话，使表达更清晰自然。">${escapeHtml(item.prompt)}</textarea></label><small>执行时，划词内容会作为用户文本与这条提示词一起发送给 AI。</small></article>`).join('')
}

function readSelectionToolbarEditor(toolbar) {
  const translatePrompt = document.getElementById('translatePrompt')?.value.trim() || ''
  const explainPrompt = document.getElementById('explainPrompt')?.value.trim() || ''
  if (!translatePrompt || !explainPrompt) {
    toast('翻译和解释提示词不能为空')
    return null
  }
  const customActions = toolbar.customActions.map((item) => {
    const card = document.querySelector(`[data-custom-toolbar="${item.id}"]`)
    if (!card) return item
    const next = {
      ...item,
      name: card.querySelector('[data-custom-name]').value.trim(),
      prompt: card.querySelector('[data-custom-prompt]').value.trim()
    }
    const thinkingSelect = card.querySelector('[data-custom-thinking]')
    if (thinkingSelect) next.thinking = thinkingSelect.value
    return next
  })
  if (customActions.some((item) => !item.name || !item.prompt)) {
    toast('自定义功能名称和提示词不能为空')
    return null
  }
  return {
    prompts: { translate: translatePrompt, explain: explainPrompt },
    customActions,
    searchEngine: document.getElementById('searchEngine')?.value || toolbar.searchEngine
  }
}

async function moveSelectionToolbarAction(action, targetIndex) {
  const toolbar = settings.selectionToolbar
  const editor = readSelectionToolbarEditor(toolbar)
  if (!editor) return
  const order = [...toolbar.order]
  const sourceIndex = order.indexOf(action)
  if (sourceIndex < 0) return
  const boundedTarget = Math.max(0, Math.min(order.length - 1, targetIndex))
  if (sourceIndex === boundedTarget) return
  order.splice(sourceIndex, 1)
  order.splice(boundedTarget, 0, action)
  await updateSettings({ selectionToolbar: { ...editor, order } }, '')
  renderSelectionToolbarSettings()
}

function createSelectionToolbarActionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '')
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
