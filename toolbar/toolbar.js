const systemThemeMedia = matchMedia('(prefers-color-scheme: dark)')
let configuredTheme = 'system'
let configuredMainColor = '#e5a44c'

function applyAppearance(appearance = {}) {
  configuredTheme = ['light', 'dark'].includes(appearance.theme) ? appearance.theme : 'system'
  const resolvedTheme = configuredTheme === 'system'
    ? (systemThemeMedia.matches ? 'dark' : 'light')
    : configuredTheme
  configuredMainColor = /^#[0-9a-f]{6}$/i.test(appearance.mainColor || '')
    ? appearance.mainColor
    : '#e5a44c'
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
  const led = document.createElement('i')
  led.className = 'led'
  led.setAttribute('aria-hidden', 'true')
  toolbar.append(led)
  actions.forEach((action, index) => {
    if (!action || !action.id || !action.label) return
    if (index) {
      const separator = document.createElement('span')
      separator.className = 'sep'
      toolbar.append(separator)
    }
    const button = document.createElement('button')
    const builtinClass = ['copy', 'search', 'translate', 'explain', 'open'].includes(action.id) ? action.id : 'custom'
    // Solid accent reserved for the primary local action (copy). AI and other
    // actions stay on the surface ladder so the strip keeps one accent.
    const primaryClass = action.id === 'copy' ? ' pri' : ''
    button.className = `btn btn-${builtinClass}${primaryClass}`
    button.title = action.label
    button.textContent = `${action.icon || '✦'} ${action.label}`
    button.onclick = () => window.toolbarAPI.action(action.id)
    toolbar.append(button)
  })
})
