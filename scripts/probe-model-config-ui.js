const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const resultPrefix = 'HIGHLIGHTER_MODEL_CONFIG_PROBE='
const providers = [
  {
    id: 'provider-a',
    name: 'Provider A',
    baseUrl: 'https://a.example/v1',
    hasApiKey: true,
    protocol: 'openai-chat',
    enabled: true,
    builtin: false,
    models: [{ id: 'a-old', name: 'A Old', capabilities: { tasks: ['chat', 'translation', 'explain'], reasoning: 'none' } }]
  },
  {
    id: 'provider-b',
    name: 'Provider B',
    baseUrl: 'https://b.example/v1',
    hasApiKey: true,
    protocol: 'openai-chat',
    enabled: true,
    builtin: false,
    models: [{ id: 'b-new', name: 'B New', capabilities: { tasks: ['chat', 'translation', 'explain'], reasoning: 'none' } }]
  }
]

let settings = {
  theme: 'system',
  mainColor: '#e5a44c',
  borderRadius: 8,
  compact: false,
  skinPath: '',
  skinOpacity: 18,
  customCss: '',
  shortcuts: {},
  providers,
  ai: {
    schemaVersion: 2,
    assignments: ['chat', 'translation', 'ocr-translate', 'toolbar:translate', 'toolbar:explain']
      .map((feature) => ({ feature, providerId: 'provider-a', model: 'a-old' }))
  },
  selectionToolbar: { customActions: [] }
}
const updates = []

function merge(target, patch) {
  const output = { ...(target || {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(output[key], value)
      : value
  }
  return output
}

async function runProbe() {
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:update', (_event, patch) => {
    updates.push(patch)
    settings = merge(settings, patch)
    return settings
  })
  ipcMain.handle('shortcuts:status', () => ({}))
  // Stands in for coding-plan:create-provider: the real handler lives in
  // main/ipc/coding-plan-ipc.js and is covered by its own unit tests.
  ipcMain.handle('coding-plan:create-provider', (_event, input) => {
    const provider = {
      id: 'provider-cp',
      presetId: input.presetId,
      name: input.displayName || 'Open Code Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      hasApiKey: true,
      protocol: 'openai-chat',
      enabled: true,
      builtin: false,
      modelsVerified: true,
      models: [{ id: 'kimi-k3', name: 'Kimi K3', capabilities: { tasks: ['chat', 'translation', 'explain'], reasoning: 'none' } }]
    }
    settings = { ...settings, providers: [...settings.providers, provider] }
    return { ok: true, provider, verified: true, warning: '', modelsCount: 1 }
  })

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', 'config', 'config.html'))
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (document.querySelector('.function-row')) { clearInterval(timer); resolve() }
      else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('Config home did not initialize')) }
    }, 20)
  })`)
  win.webContents.send('app:navigate', 'models')
  const result = await win.webContents.executeJavaScript(`(async () => {
    async function waitFor(selector) {
      const started = Date.now()
      while (!document.querySelector(selector)) {
        if (Date.now() - started > 5000) throw new Error('Missing selector: ' + selector)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return document.querySelector(selector)
    }
    async function waitUntil(predicate, label) {
      const started = Date.now()
      while (!predicate()) {
        if (Date.now() - started > 5000) throw new Error('Timed out waiting for ' + label)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    await waitFor('#saveProviderSettings')
    document.querySelector('[data-models-tab="features"]').click()
    await waitFor('#saveFeatureAssignments')
    const row = document.querySelector('[data-feature="toolbar:translate"]')
    const provider = row.querySelector('[data-feature-provider]')
    const model = row.querySelector('[data-feature-model]')
    provider.value = 'provider-b'
    provider.dispatchEvent(new Event('change', { bubbles: true }))
    const afterChange = {
      provider: provider.value,
      model: model.value,
      options: [...model.options].map((option) => option.value),
      buttonText: document.getElementById('saveFeatureAssignments').textContent
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    document.getElementById('saveFeatureAssignments').click()
    await waitUntil(() => document.getElementById('saveFeatureAssignments')?.textContent === '保存功能模型', 'feature save')

    document.querySelector('[data-models-tab="providers"]').click()
    await waitFor('#addCodingPlanProvider')
    document.getElementById('addCodingPlanProvider').click()
    await waitFor('.coding-plan-card')
    const presetNames = [...document.querySelectorAll('.coding-plan-card b')].map((item) => item.textContent)
    document.querySelector('.coding-plan-card').click()
    await waitFor('[data-coding-plan-key]')
    const baseUrlEcho = document.querySelector('.coding-plan-form .coding-plan-readonly').textContent
    document.querySelector('[data-coding-plan-key]').value = 'sk-probe-key'
    document.querySelector('[data-coding-plan-name]').value = 'Probe Plan'
    document.querySelector('[data-coding-plan-save]').click()
    await waitFor('.coding-plan-assignment')
    const featureCount = document.querySelectorAll('[data-coding-plan-feature]').length
    document.querySelector('[data-coding-plan-apply]').click()
    await waitUntil(() => !document.querySelector('.coding-plan-assignment'), 'assignment guide close')
    await new Promise((resolve) => setTimeout(resolve, 100))
    return {
      ...afterChange,
      codingPlan: {
        presetNames,
        baseUrlEcho,
        featureCount,
        badge: document.querySelector('[data-provider-editor="provider-cp"] .provider-tag.coding-plan')?.textContent || ''
      }
    }
  })()`)
  console.log(`${resultPrefix}${JSON.stringify({ ...result, updates })}`)
  win.destroy()
}

app.whenReady()
  .then(runProbe)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
