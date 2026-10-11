// S14 / D2-2（Wave 8.5）：设置页主壳。render 函数按路由拆到 config/routes/*.js，
// 本文件只保留 DOM 引用、设置状态、导航与 renderRoute() 分派、启动接线。
// 经典脚本共享全局作用域：路由文件里的顶层 function/const 在这里调用时可见。
const view = document.getElementById('view')
const pageTitle = document.getElementById('pageTitle')
const statusRail = document.getElementById('statusRail')
const toastElement = document.getElementById('toast')

// 经典脚本的顶层语句按 <script> 顺序执行，而各路由文件先于本文件加载并各自带上
// `window.configRoutes = window.configRoutes || {}` 兜底；这里再确认一次，幂等且不覆盖。
window.configRoutes = window.configRoutes || {}

let settings = null
let currentRoute = 'home'

const routeTitles = {
  home: '快捷功能', translation: '翻译', chat: 'AI 对话', history: '截图历史',
  appearance: '外观配色', plugins: '插件', 'settings-general': '界面设置',
  'settings-function': '功能设置', 'settings-hotkeys': '热键设置',
  models: '模型',
  'selection-toolbar': '划词工具',
  'local-search': '本地搜索',
  'settings-system': '系统设置', about: '关于'
}

// 路由 -> 分派表。键是路由（config.html 的 data-route），`key` 是各路由文件登记到
// window.configRoutes 的入口名；主壳只按 key 调用，不认识任何 render 函数的实现。
// fallbackMessage 保留拆分前 renderRoute() 里那两条路由各自的错误提示。
const routes = {
  home: { key: 'renderHome' },
  translation: { key: 'renderTranslation' },
  chat: { key: 'renderChat' },
  history: { key: 'renderHistory' },
  appearance: { key: 'renderAppearance' },
  plugins: { key: 'renderPlugins' },
  'settings-general': { key: 'renderGeneralSettings' },
  models: { key: 'bootstrapModels' },
  'settings-function': { key: 'renderFunctionSettings' },
  'selection-toolbar': { key: 'renderSelectionToolbarSettings' },
  'local-search': { key: 'renderLocalSearch' },
  'settings-hotkeys': { key: 'renderHotkeySettings' },
  'settings-system': { key: 'renderSystemSettings', fallbackMessage: '无法读取软件数据目录' },
  about: { key: 'renderAbout', fallbackMessage: '无法读取更新状态' }
}

// 注册面契约：Object.keys(routes) 必须与 window.configRoutes 的登记键逐一对上，
// 否则 renderRoute() 会在某个路由上静默 no-op。契约测试直接核对这两份清单。
const CONFIG_ROUTE_KEYS = Object.keys(routes)
window.configRouteKeys = CONFIG_ROUTE_KEYS

function navigate(route) {
  if (currentRoute === 'history' && route !== 'history') {
    historyThumbnailObserver?.disconnect()
    historyThumbnailObserver = null
  }
  if (route === 'models' && currentRoute !== 'models') {
    modelsTab = 'providers'
    modelsExpandedProviderIds = new Set()
  }
  currentRoute = route || 'home'
  pageTitle.textContent = routeTitles[currentRoute] || 'Highlighter'
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.route === currentRoute))
  void refreshStatusRail()
  renderRoute()
}

// renderRoute() 只读 entry.key，路由文件里各自 `window.configRoutes[<key>] = ...` 登记，
// 所以这里的 key 与登记键必须逐字一致；test/config-routes.test.js 会把两份清单对拍。
function renderRoute() {
  const entry = routes[currentRoute]
  const render = entry && window.configRoutes[entry.key]
  if (!render) return false
  // 与拆分前一致：只有 settings-system / about 是 async 且需要 catch，
  // 其余路由保持同步调用（历史路由内部自己吞掉异步错误）。
  if (entry.fallbackMessage) {
    void Promise.resolve(render()).catch((error) => toast(error.message || entry.fallbackMessage))
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
      if (['home', 'settings-hotkeys', 'settings-system'].includes(currentRoute)) renderRoute()
    })
    .catch(() => {})
})
window.electronAPI.onHistoryChanged(() => { if (currentRoute === 'history') renderHistory() })
window.electronAPI.onUpdateStatus((status) => {
  latestUpdateStatus = status
  if (currentRoute === 'about') void renderAbout(status).catch((error) => toast(error.message || '无法刷新更新状态'))
})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)

async function init() {
  settings = await window.electronAPI.getSettings()
  await refreshShortcutStatuses()
  applyAppearance()
  navigate('home')
}
init()
