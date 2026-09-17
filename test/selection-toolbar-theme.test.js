const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const settingsEffects = fs.readFileSync(path.join(root, 'main/domains/settings-effects/index.js'), 'utf8')
const manager = fs.readFileSync(path.join(root, 'main', 'services', 'selection-window-manager.js'), 'utf8')
const actionPreload = fs.readFileSync(path.join(root, 'preload-action.js'), 'utf8')
const actionScript = fs.readFileSync(path.join(root, 'action', 'action.js'), 'utf8')
const actionHtml = fs.readFileSync(path.join(root, 'action', 'action.html'), 'utf8')
const actionCss = fs.readFileSync(path.join(root, 'action', 'action.css'), 'utf8')
const toolbarPreload = fs.readFileSync(path.join(root, 'preload-toolbar.js'), 'utf8')
const toolbarHtml = fs.readFileSync(path.join(root, 'toolbar', 'toolbar.html'), 'utf8')
const toolbarScript = fs.readFileSync(path.join(root, 'toolbar', 'toolbar.js'), 'utf8')
const tokensCss = fs.readFileSync(path.join(root, 'shared', 'tokens.css'), 'utf8')

test('selection result windows receive and apply the configured appearance', () => {
  assert.match(manager, /getAppearance\(settings = this\.getSettings\(\)\)[\s\S]*this\.nativeTheme\.shouldUseDarkColors/)
  assert.match(manager, /backgroundColor: appearance\.resolvedTheme === 'dark'/)
  assert.match(main, /appearance: getActionAppearance\(\)/)
  assert.match(settingsEffects, /broadcastActionAppearance\(settings\)/)
  assert.match(main, /settingsEffects\.applyUpdate/)
  assert.match(actionPreload, /onActionAppearance:[\s\S]*action:appearance/)
  assert.match(actionScript, /function applyAppearance\(appearance = \{\}\)/)
  assert.match(actionScript, /applyAppearance\(data\.appearance\)/)
  assert.match(actionScript, /onActionAppearance\(applyAppearance\)/)
})

test('selection result palette follows the shared light/dark tokens', () => {
  // This window used to carry its own :root/body.dark palette, which shadowed
  // shared/tokens.css and let it drift from the main window. It now consumes the
  // shared tokens, so assert the consumption rather than duplicated hex values.
  assert.match(actionHtml, /action\.css/)
  assert.match(actionHtml, /shared\/tokens\.css/)
  assert.doesNotMatch(actionCss, /:root\s*\{[^}]*--bg:\s*#/, 'no private palette')
  assert.doesNotMatch(actionCss, /body\.dark\s*\{/, 'theme switching lives in tokens.css')
  assert.match(actionCss, /background: var\(--bg\)/)
  assert.match(actionCss, /color: var\(--primary-text\)/)
  assert.match(actionCss, /\.result code \{[^}]*color: var\(--inline-code\)/)
  assert.match(actionCss, /\.result pre code \{[^}]*color: var\(--text\)/)
  assert.doesNotMatch(actionCss, /background: #1a1a2e/)
  // The shared sheet must actually define the tokens this file relies on.
  assert.match(tokensCss, /--inline-code:/)
  assert.match(tokensCss, /body\.dark \{/)
})

test('selection toolbar receives configured and system appearance updates', () => {
  assert.match(manager, /this\.toolbarWindow\.webContents\.send\('toolbar:appearance', appearance\)/)
  assert.match(main, /appearance: getActionAppearance\(\)/)
  assert.match(main, /nativeTheme\.on\('updated',[\s\S]*broadcastActionAppearance\(\)/)
  assert.match(toolbarPreload, /onAppearance:[\s\S]*toolbar:appearance/)
  assert.match(toolbarScript, /function applyAppearance\(appearance = \{\}\)/)
  assert.match(toolbarScript, /toolbarAPI\.onAppearance\(applyAppearance\)/)
  assert.match(toolbarScript, /applyAppearance\(appearance\)/)
})

test('selection toolbar uses the main interface palette and one text color', () => {
  // The toolbar previously declared its own light/dark palette inline. It now
  // links the shared tokens, so the palette cannot diverge from the main window.
  assert.match(toolbarHtml, /shared\/tokens\.css/)
  assert.doesNotMatch(toolbarHtml, /:root\s*\{[^}]*--bg:\s*#/, 'no private palette')
  assert.doesNotMatch(toolbarHtml, /body\.dark\s*\{/, 'theme switching lives in tokens.css')
  assert.match(toolbarHtml, /\.toolbar \{[\s\S]*background: var\(--surface\)/)
  assert.match(toolbarHtml, /\.toolbar \.btn \{[\s\S]*color: var\(--text\)/)
  assert.doesNotMatch(toolbarHtml, /\.btn-(?:copy|search|translate|explain|custom)\s*\{[^}]*color:/)
})
