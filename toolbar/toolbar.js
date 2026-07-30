window.toolbarAPI.onSelection(({ actions }) => {
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
    const builtinClass = ['copy', 'search', 'translate', 'explain'].includes(action.id) ? action.id : 'custom'
    button.className = `btn btn-${builtinClass}`
    button.title = action.label
    button.textContent = `${action.icon || '✦'} ${action.label}`
    button.onclick = () => window.toolbarAPI.action(action.id)
    toolbar.append(button)
  })
})
