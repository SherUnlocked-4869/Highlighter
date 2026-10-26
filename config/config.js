// S14 / D2-2 (Wave 8.5): settings-window shell. The render functions were split
// into config/routes/*.js; this file keeps the DOM references, the settings state,
// navigation plus the renderRoute() dispatch, and the boot wiring.
// Classic scripts share one global scope, so the top-level functions and consts
// declared by the route files are visible here.
const view = document.getElementById('view')
const pageTitle = document.getElementById('pageTitle')
const statusRail = document.getElementById('statusRail')
const toastElement = document.getElementById('toast')

// Classic top-level statements run in <script> order, and every route file loads
// before this one with its own `window.configRoutes = window.configRoutes || {}`
// fallback; repeating it here is idempotent and never overwrites.
window.configRoutes = window.configRoutes || {}

let settings = null
let currentRoute = 'home'

// M2/W6b: the main process may destroy this hidden window's renderer after five
// minutes. It only does that for a SAFE route with no draft, so every
// draft-capable editor has to report itself here. A report that never arrives
// leaves the previous (clean) state in place, and the reclaim route list itself
// excludes every page that owns an editor.
const configDirtyReasons = new Set()
// Reasons that die with the route: their DOM draft is discarded on navigation.
const ROUTE_DRAFT_REASONS = { 'local-search': ['local-search-categories'], models: ['models-provider-editor'] }
function reportWindowState() {
  try {
    window.electronAPI?.reportWindowState?.({
      route: currentRoute,
      dirty: configDirtyReasons.size > 0,
      dirtyReason: [...configDirtyReasons].join(',')
    })
  } catch { /* no preload (plain node checks): nothing to report */ }
}
// Reason-scoped on purpose: one editor turning clean must not mask another one
// that is still dirty.
function setConfigDirty(reason, dirty) {
  if (typeof reason !== 'string' || !reason) return false
  const before = configDirtyReasons.size
  if (dirty === true) configDirtyReasons.add(reason)
  else configDirtyReasons.delete(reason)
  const changed = before !== configDirtyReasons.size
  if (changed) reportWindowState()
  return changed
}
window.setConfigDirty = setConfigDirty

// P0-1-T3 (S1, batch C): the titles are locale KEYS, resolved on every navigation
// so a language switch takes effect without a reload.
const routeTitles = {
  home: 'config.route.home', translation: 'config.route.translation', chat: 'config.route.chat', history: 'config.route.history',
  'settings-general': 'config.route.settings-general',
  'settings-function': 'config.route.settings-function',
  models: 'config.route.models',
  'selection-toolbar': 'config.route.selection-toolbar',
  'local-search': 'config.route.local-search',
  'clipboard-history': 'clipboard.title',
  usage: 'config.route.usage',
  'settings-system': 'config.route.settings-system', about: 'config.route.about'
}

// Route -> dispatch table. The key is the route (config.html's data-route), `key`
// is the entry each route file registers on window.configRoutes; the shell only
// calls that key and knows nothing about the render implementations.
// fallbackMessage keeps the two per-route error prompts renderRoute() carried
// before the split; both are locale keys now.
const routes = {
  home: { key: 'renderHome' },
  translation: { key: 'renderTranslation' },
  chat: { key: 'renderChat' },
  history: { key: 'renderHistory' },
  'settings-general': { key: 'renderGeneralSettings' },
  models: { key: 'bootstrapModels' },
  'settings-function': { key: 'renderFunctionSettings' },
  'selection-toolbar': { key: 'renderSelectionToolbarSettings' },
  'local-search': { key: 'renderLocalSearch' },
  'clipboard-history': { key: 'renderClipboardSettings' },
  usage: { key: 'renderUsage' },
  'settings-system': { key: 'renderSystemSettings', fallbackMessage: 'config.error.read-data-root' },
  about: { key: 'renderAbout', fallbackMessage: 'config.error.read-update-status' }
}

// Registration contract: Object.keys(routes) must line up with the keys registered
// on window.configRoutes, otherwise renderRoute() silently no-ops on a route.
// test/config-routes.test.js diffs the two lists.
const CONFIG_ROUTE_KEYS = Object.keys(routes)
window.configRouteKeys = CONFIG_ROUTE_KEYS

function navigate(route) {
  for (const reason of ROUTE_DRAFT_REASONS[currentRoute] || []) setConfigDirty(reason, false)
  if (currentRoute === 'history' && route !== 'history') {
    historyThumbnailObserver?.disconnect()
    historyThumbnailObserver = null
  }
  // The usage page owns an auto-refresh timer plus focus/visibility listeners and
  // one IPC subscription; leaving the route must drop all three or a background
  // scan keeps waking the disk behind an unrelated page.
  if (currentRoute === 'usage' && route !== 'usage') {
    if (typeof usageDeactivate === 'function') usageDeactivate()
  }
  if (route === 'models' && currentRoute !== 'models') {
    modelsTab = 'providers'
    modelsExpandedProviderIds = new Set()
  }
  currentRoute = route || 'home'
  reportWindowState()
  const titleKey = routeTitles[currentRoute]
  pageTitle.textContent = titleKey ? t(titleKey) : 'Highlighter'
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.route === currentRoute))
  void refreshStatusRail()
  renderRoute()
}

// renderRoute() only reads entry.key; each route file registers itself through
// `window.configRoutes[<key>] = ...`, so the two spellings have to match exactly.
// test/config-routes.test.js diffs both lists.
function renderRoute() {
  const entry = routes[currentRoute]
  const render = entry && window.configRoutes[entry.key]
  if (!render) return false
  // Same shape as before the split: only settings-system / about are async and
  // need a catch; the remaining routes stay synchronous (the history route
  // swallows its own async errors).
  if (entry.fallbackMessage) {
    void Promise.resolve(render()).catch((error) => toast(error.message || t(entry.fallbackMessage)))
  } else {
    render()
  }
  return true
}

document.querySelectorAll('.nav-item').forEach((button) => button.onclick = () => navigate(button.dataset.route))
document.getElementById('minimize').onclick = () => window.electronAPI.windowMinimize()
document.getElementById('close').onclick = () => window.electronAPI.windowClose()
window.electronAPI.onNavigate(navigate)
window.electronAPI.onGameModeChanged((enabled) => {
  if (!settings) return
  settings = { ...settings, system: { ...settings.system, gameMode: enabled } }
  void refreshShortcutStatuses()
    .then(() => {
      if (['home', 'settings-system'].includes(currentRoute)) renderRoute()
    })
    .catch(() => {})
})
// B1.4 (history re-edit): a write used to rebuild the whole history page, which
// reset pagination to page one, dropped the scroll offset and threw away the
// thumbnail cache. The route now patches the list in place; entering the route
// still goes through the full render (routes/history.js renderHistory).
window.electronAPI.onHistoryChanged(() => { if (currentRoute === 'history') refreshHistoryOnChange() })
window.electronAPI.onUpdateStatus((status) => {
  latestUpdateStatus = status
  // P3: the update card lives on the General settings page. Refresh only that
  // card so download-progress pushes never rebuild the rest of the form.
  if (currentRoute === 'settings-general') void refreshGeneralUpdateCard(status).catch(() => {})
})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)

// P0-1-T3: the static shell carries data-i18n attributes, so it is translated once
// the markup is parsed; the renderers resolve their own strings through t() as
// they build markup.
applyTranslations()

// Language hot switch (P0-1-T2 broadcasts `i18n:language` to every window).
// Re-rendering the current route rebuilds the strings the renderers resolved at
// build time; the local settings copy is kept in step so a route that reads
// settings.language renders the new value even when the broadcast beats the
// settings:update reply.
window.electronAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  if (!settings) {
    applyTranslations()
    return
  }
  settings = { ...settings, language }
  // applyTranslations() rewrites the whole shell, #pageTitle included (it carries
  // data-i18n="config.route.home"), so the current route is re-entered afterwards:
  // that restores its title, the nav highlight and the freshly translated body.
  applyTranslations()
  navigate(currentRoute)
})

async function init() {
  settings = await window.electronAPI.getSettings()
  // The stored `language` is authoritative (settings-normalize.js repairs it);
  // setLanguage mirrors it into localStorage for the windows without settings.
  if (settings.language) setLanguage(settings.language)
  else restoreStoredLanguage()
  applyTranslations()
  await refreshShortcutStatuses()
  applyAppearance()
  navigate('home')
}
init()
