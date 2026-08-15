const test = require('node:test')
const assert = require('node:assert/strict')
const { createToolbarActionStream } = require('../main/services/ai-feature-router')
const { normalizeAiSettings } = require('../main/services/ai-providers')

function createSettings() {
  return normalizeAiSettings({
    providers: [
      { id: 'translator', name: 'Translator', baseUrl: 'https://translate.example/v1', apiKey: 'sk-t', models: [{ id: 'translate-model', name: 'Translate' }] },
      { id: 'explainer', name: 'Explainer', baseUrl: 'https://explain.example/v1', apiKey: 'sk-e', models: [{ id: 'explain-model', name: 'Explain' }] }
    ],
    ai: {
      assignments: [
        { feature: 'toolbar:translate', providerId: 'translator', model: 'translate-model' },
        { feature: 'toolbar:explain', providerId: 'explainer', model: 'explain-model' }
      ]
    }
  })
}

test('toolbar translation and explanation route to their assigned providers', async () => {
  const calls = []
  const clients = {
    createTranslateStream: async (provider, text, prompt, options) => {
      calls.push({ method: 'translate', provider, text, prompt, options })
      return 'translate-stream'
    },
    createExplainStream: async (provider, text, prompt, options) => {
      calls.push({ method: 'explain', provider, text, prompt, options })
      return 'explain-stream'
    },
    createCustomStream: async () => 'custom-stream'
  }
  const signal = new AbortController().signal
  const settings = createSettings()
  assert.equal(await createToolbarActionStream({
    settings,
    action: { id: 'translate', label: '翻译', prompt: 'translate prompt' },
    text: 'hello',
    requestOptions: { signal },
    clients
  }), 'translate-stream')
  assert.equal(await createToolbarActionStream({
    settings,
    action: { id: 'explain', label: '解释', prompt: 'explain prompt' },
    text: 'concept',
    requestOptions: { signal },
    clients
  }), 'explain-stream')

  assert.deepEqual(calls.map((call) => ({
    method: call.method,
    providerId: call.provider.id,
    baseUrl: call.provider.baseUrl,
    model: call.provider.model,
    prompt: call.prompt
  })), [
    { method: 'translate', providerId: 'translator', baseUrl: 'https://translate.example/v1', model: 'translate-model', prompt: 'translate prompt' },
    { method: 'explain', providerId: 'explainer', baseUrl: 'https://explain.example/v1', model: 'explain-model', prompt: 'explain prompt' }
  ])
  assert.equal(calls[0].options.signal, signal)
  assert.equal(calls[1].options.signal, signal)
})

test('toolbar routing rejects missing assignments instead of picking another provider', async () => {
  const settings = createSettings()
  settings.ai.assignments = settings.ai.assignments.filter((assignment) => assignment.feature !== 'toolbar:explain')
  await assert.rejects(() => createToolbarActionStream({
    settings,
    action: { id: 'explain', label: '解释', prompt: 'explain' },
    text: 'concept',
    clients: {}
  }), /未配置可用/)
})
