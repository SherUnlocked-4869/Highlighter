const systemThemeMedia = matchMedia('(prefers-color-scheme: dark)')
let configuredTheme = 'system'
let configuredMainColor = '#1677ff'

function applyAppearance(appearance = {}) {
  configuredTheme = ['light', 'dark'].includes(appearance.theme) ? appearance.theme : 'system'
  const resolvedTheme = configuredTheme === 'system'
    ? (systemThemeMedia.matches ? 'dark' : 'light')
    : configuredTheme
  configuredMainColor = /^#[0-9a-f]{6}$/i.test(appearance.mainColor || '')
    ? appearance.mainColor
    : '#1677ff'
  document.body.classList.toggle('dark', resolvedTheme === 'dark')
  document.documentElement.style.setProperty('--primary', configuredMainColor)
}

systemThemeMedia.addEventListener('change', () => {
  if (configuredTheme === 'system') applyAppearance({ theme: 'system', mainColor: configuredMainColor })
})

window.toolbarAPI.onAppearance(applyAppearance)

window.toolbarAPI.onSelection(({ actions, appearance }) => {
  applyAppearance(appearance)
  const toolbar = document.getElementById('toolbar')
  toolbar.replaceChildren()
  actions.forEach((action, index) => {
    if (!action || !action.id || !action.label) return
    if (index) {
      const separator = document.createElement('span')
      separator.className = 'sep'
      toolbar.append(separator)
    }
    const button = document.createElement('button')
    const builtinClass = ['copy', 'search', 'translate', 'explain', 'open'].includes(action.id) ? action.id : 'custom'
    button.className = `btn btn-${builtinClass}`
    button.title = action.label
    button.textContent = `${action.icon || '✦'} ${action.label}`
    button.onclick = () => window.toolbarAPI.action(action.id)
    toolbar.append(button)
  })
})
