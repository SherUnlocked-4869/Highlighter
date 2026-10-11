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
    description: t('config.selection-toolbar.custom-description', { prompt: custom.prompt }),
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
    return `<div class="toolbar-order-row" draggable="true" data-toolbar-order="${escapeHtml(action)}"><span class="toolbar-drag" title="${t('config.selection-toolbar.drag-sort')}">⋮⋮</span><span class="toolbar-order-icon">${toolbarIconMarkup(info.icon)}</span><div class="form-label"><b>${escapeHtml(info.label)}</b><small>${escapeHtml(info.description)}</small></div>${toggle}<div class="toolbar-order-actions"><button class="button icon-button" data-move-toolbar="${escapeHtml(action)}" data-direction="-1" ${index === 0 || !movable ? 'disabled' : ''} title="${t('config.selection-toolbar.move-up')}">↑</button><button class="button icon-button" data-move-toolbar="${escapeHtml(action)}" data-direction="1" ${index === actions.length - 1 || !movable ? 'disabled' : ''} title="${t('config.selection-toolbar.move-down')}">↓</button></div></div>`
  }).join('')
}

function selectionToolbarCustomMarkup(toolbar) {
  if (!toolbar.customActions.length) return '<div class="empty compact-empty">' + t('config.selection-toolbar.empty-custom') + '</div>'
  return toolbar.customActions.map((item) => `<article class="custom-toolbar-card" data-custom-toolbar="${escapeHtml(item.id)}"><div class="custom-toolbar-head"><label>${t('config.selection-toolbar.custom-name')}<input type="text" maxlength="16" data-custom-name value="${escapeHtml(item.name)}" placeholder="${t('config.selection-toolbar.custom-name-placeholder')}"></label><label>${t('config.selection-toolbar.custom-thinking')}<select data-custom-thinking title="${t('config.selection-toolbar.custom-thinking-title')}"><option value="off">${t('config.selection-toolbar.thinking-off')}</option><option value="low">${t('config.selection-toolbar.thinking-low')}</option><option value="high">${t('config.selection-toolbar.thinking-high')}</option><option value="max">${t('config.selection-toolbar.thinking-max')}</option></select></label><button class="button danger" data-delete-custom-toolbar="${escapeHtml(item.id)}">${t('config.selection-toolbar.delete')}</button></div><label>${t('config.selection-toolbar.custom-prompt')}<textarea class="textarea prompt-editor custom-prompt" maxlength="6000" data-custom-prompt placeholder="${t('config.selection-toolbar.custom-prompt-placeholder')}">${escapeHtml(item.prompt)}</textarea></label><small>${t('config.selection-toolbar.custom-execution-hint')}</small></article>`).join('')
}

function readSelectionToolbarEditor(toolbar) {
  const translatePrompt = document.getElementById('translatePrompt')?.value.trim() || ''
  const explainPrompt = document.getElementById('explainPrompt')?.value.trim() || ''
  if (!translatePrompt || !explainPrompt) {
    toast(t('config.selection-toolbar.prompts-required'))
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
    toast(t('config.selection-toolbar.custom-required'))
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
