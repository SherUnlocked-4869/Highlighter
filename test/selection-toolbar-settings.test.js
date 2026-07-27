const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
const script = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')

test('config app exposes the selection toolbar route and controls', () => {
  assert.match(html, /data-route="selection-toolbar"/)
  assert.match(script, /function renderSelectionToolbarSettings\(/)
  assert.match(script, /id="searchEngine"/)
  assert.match(script, /id="translatePrompt"/)
  assert.match(script, /id="explainPrompt"/)
  assert.match(script, /id="addCustomToolbar"/)
  assert.match(script, /data-custom-name/)
  assert.match(script, /data-custom-prompt/)
  assert.match(script, /data-delete-custom-toolbar/)
  assert.match(script, /data-move-toolbar/)
  assert.match(script, /draggable="true"/)
  assert.match(script, /ondrop/)
  for (const action of ['copy', 'search', 'translate', 'explain']) {
    assert.match(script, new RegExp(`${action}: \\{ label:`))
  }
})

test('main process normalizes toolbar settings and routes configured custom prompts', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const deepseek = fs.readFileSync(path.join(__dirname, '..', 'deepseek.js'), 'utf8')
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar', 'toolbar.html'), 'utf8')
  const action = fs.readFileSync(path.join(__dirname, '..', 'action', 'action.js'), 'utf8')

  assert.match(main, /normalized\.selectionToolbar = normalizeSelectionToolbar/)
  assert.match(main, /getVisibleToolbarActionDefinitions/)
  assert.match(main, /getToolbarActionDefinition\(toolbarConfig, action\)/)
  assert.match(main, /createTranslateStream\(apiKey, text, action\.prompt, requestOptions\)/)
  assert.match(main, /createExplainStream\(apiKey, text, action\.prompt, requestOptions\)/)
  assert.match(main, /createCustomStream\(apiKey, text, action\.prompt, requestOptions\)/)
  assert.match(main, /label: actionDefinition\.label/)
  assert.match(deepseek, /role: 'system', content: prompt/)
  assert.match(toolbar, /action\.label/)
  assert.match(toolbar, /toolbarAPI\.action\(action\.id\)/)
  assert.match(action, /const label = data\.label \|\| '解释'/)
})
