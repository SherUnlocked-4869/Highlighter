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
//
// P0-1-T5 (S12): `label` and `description` are i18n keys, not sentences. This
// module runs under Node too (`test/toolbar-*.test.js`) where no locale table is
// loaded, so it cannot call `t()` itself; every renderer resolves the key at the
// point of use (`toolbar/toolbar.js` for the strip, `config/routes/*.js` for the
// settings page). `id`, `icon`, `kind` and `optional` are unaffected.

(function exposeToolbarActionMeta(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.toolbarActionMeta = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const TOOLBAR_ACTION_META = Object.freeze({
    copy: Object.freeze({ id: 'copy', label: 'toolbar.action.copy.label', icon: 'copy', kind: 'local', description: 'toolbar.action.copy.description' }),
    search: Object.freeze({ id: 'search', label: 'toolbar.action.search.label', icon: 'search', kind: 'local', description: 'toolbar.action.search.description' }),
    translate: Object.freeze({ id: 'translate', label: 'toolbar.action.translate.label', icon: 'translate', kind: 'ai', description: 'toolbar.action.translate.description' }),
    explain: Object.freeze({ id: 'explain', label: 'toolbar.action.explain.label', icon: 'lightbulb', kind: 'ai', description: 'toolbar.action.explain.description' }),
    open: Object.freeze({
      id: 'open',
      label: 'toolbar.action.open.label',
      icon: 'box-arrow-up-right',
      kind: 'local',
      description: 'toolbar.action.open.description',
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
