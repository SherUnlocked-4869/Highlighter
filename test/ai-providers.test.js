const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createDefaultProviders,
  normalizeAiAssignments,
  normalizeAiProviders,
  normalizeAiSettings,
  resolveAiAssignment,
  resolveToolbarAiProvider
} = require('../main/services/ai-providers')

test('defaults create one built-in DeepSeek provider with the legacy model', () => {
  const providers = createDefaultProviders()
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'deepseek')
  assert.equal(providers[0].baseUrl, 'https://api.deepseek.com')
  assert.deepEqual(providers[0].models, [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }])
})

test('provider normalization migrates the legacy API key and custom model into DeepSeek', () => {
  const providers = normalizeAiProviders([], {
    legacyApiKey: 'sk-legacy',
    legacyModel: 'custom-deepseek-model'
  })
  assert.equal(providers[0].apiKey, 'sk-legacy')
  assert.ok(providers[0].models.some((model) => model.id === 'custom-deepseek-model'))
})

test('provider normalization keeps multiple providers and sanitizes model catalogs', () => {
  const providers = normalizeAiProviders([
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-a', protocol: 'openai-chat', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] },
    { id: 'jbb', name: 'jbb', baseUrl: 'https://jbbt.pages.dev/v1', apiKey: 'sk-b', protocol: 'openai-responses', models: [{ id: 'gpt-5.6-terra', name: '' }, { id: 'gpt-5.6-terra', name: 'dup' }, { id: '', name: 'empty' }] }
  ])
  assert.equal(providers.length, 2)
  assert.equal(providers[1].protocol, 'openai-responses')
  assert.deepEqual(providers[1].models, [{ id: 'gpt-5.6-terra', name: 'gpt-5.6-terra' }])
})

test('assignments normalize per feature and fall back to the first provider model', () => {
  const providers = normalizeAiProviders([
    { id: 'jbb', name: 'jbb', baseUrl: 'https://example.com/v1', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }
  ])
  const assignments = normalizeAiAssignments([
    { feature: 'chat', providerId: 'jbb', model: 'm2' },
    { feature: 'chat', providerId: 'jbb', model: 'm1' }
  ], providers)
  assert.equal(assignments.find((item) => item.feature === 'chat').model, 'm2')
  assert.equal(assignments.find((item) => item.feature === 'toolbar:translate').providerId, 'jbb')
  assert.equal(assignments.find((item) => item.feature === 'toolbar:translate').model, 'm1')
})

test('resolver returns the assigned provider and model for each feature', () => {
  const settings = normalizeAiSettings({
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'sk-a', models: [{ id: 'a-fast', name: 'A Fast' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'sk-b', models: [{ id: 'b-smart', name: 'B Smart' }] }
    ],
    ai: {
      model: 'a-fast',
      assignments: [
        { feature: 'chat', providerId: 'a', model: 'a-fast' },
        { feature: 'toolbar:translate', providerId: 'b', model: 'b-smart' },
        { feature: 'custom:polish', providerId: 'b', model: 'b-smart' }
      ]
    }
  })

  assert.deepEqual(resolveAiAssignment(settings, 'chat'), {
    id: 'a', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'sk-a', model: 'a-fast',
    protocol: 'openai-chat', enabled: true, builtin: false, models: [{ id: 'a-fast', name: 'A Fast' }]
  })
  assert.equal(resolveToolbarAiProvider(settings, 'translate').model, 'b-smart')
  assert.equal(resolveToolbarAiProvider(settings, 'custom:polish').model, 'b-smart')
  assert.equal(resolveToolbarAiProvider(settings, 'custom:unknown').model, 'a-fast')
})
