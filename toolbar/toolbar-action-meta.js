// Single source of truth for selection-toolbar action metadata.
//
// The main process needs id/kind for routing; the settings page needs
// label/description for rendering. Those were duplicated, so a rename in one
// place silently drifted from the other. UMD so the sandboxed renderer can
// load it without a bundler.
//
// `icon` is a Bootstrap Icons asset name, not a display glyph: each renderer
// resolves it against its own icon folder (toolbar.js -> toolbar/icons,
// config.js -> ../toolbar/icons) and paints it as a CSS mask. Shipping the
// name instead of the path is what lets both windows share one definition.

(function exposeToolbarActionMeta(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.toolbarActionMeta = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const TOOLBAR_ACTION_META = Object.freeze({
    copy: Object.freeze({ id: 'copy', label: '复制', icon: 'copy', kind: 'local', description: '复制划词内容到系统剪贴板' }),
    search: Object.freeze({ id: 'search', label: '搜索', icon: 'search', kind: 'local', description: '使用默认浏览器搜索划词内容' }),
    translate: Object.freeze({ id: 'translate', label: '翻译', icon: 'translate', kind: 'ai', description: '使用下方自定义提示词翻译划词内容' }),
    explain: Object.freeze({ id: 'explain', label: '解释', icon: 'lightbulb', kind: 'ai', description: '使用下方自定义提示词解释划词内容' }),
    open: Object.freeze({
      id: 'open',
      label: '跳转',
      icon: 'box-arrow-up-right',
      kind: 'local',
      description: '在默认浏览器中打开划词内容，内容将直接作为网址跳转',
      optional: true
    })
  })

  const BUILTIN_TOOLBAR_ACTIONS = Object.freeze(
    Object.fromEntries(Object.entries(TOOLBAR_ACTION_META)
      .filter(([, action]) => !action.optional)
      .map(([key, action]) => [key, Object.freeze({ id: action.id, label: action.label, icon: action.icon, kind: action.kind })]))
  )

  const OPTIONAL_TOOLBAR_ACTIONS = Object.freeze(
    Object.fromEntries(Object.entries(TOOLBAR_ACTION_META)
      .filter(([, action]) => action.optional)
      .map(([key, action]) => [key, Object.freeze({ id: action.id, label: action.label, icon: action.icon, kind: action.kind })]))
  )

  return { BUILTIN_TOOLBAR_ACTIONS, OPTIONAL_TOOLBAR_ACTIONS, TOOLBAR_ACTION_META }
})
