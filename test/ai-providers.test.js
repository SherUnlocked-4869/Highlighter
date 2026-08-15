const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createDefaultProviders,
  migrateAiSettings,
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
  assert.deepEqual(providers[1].models, [{
    id: 'gpt-5.6-terra',
    name: 'gpt-5.6-terra',
    capabilities: { tasks: ['chat', 'translation', 'explain'], reasoning: 'openai-responses' }
  }])
})

test('schema migration keeps an explicit assignment when providers share a model id', () => {
  const migration = migrateAiSettings({
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a.example/v1', models: [{ id: 'shared', name: 'Shared A' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b.example/v1', models: [{ id: 'shared', name: 'Shared B' }] }
    ],
    ai: {
      providerId: 'a',
      model: 'shared',
      assignments: [{ feature: 'chat', providerId: 'b', model: 'shared' }]
    }
  })
  assert.equal(migration.changed, true)
  assert.equal(migration.settings.ai.schemaVersion, 2)
  assert.equal(migration.settings.ai.assignments.find((item) => item.feature === 'chat').providerId, 'b')
  assert.equal(Object.hasOwn(migration.settings.ai, 'providerId'), false)
  assert.equal(Object.hasOwn(migration.settings.ai, 'model'), false)
  assert.equal(normalizeAiSettings(migration.settings).ai.assignments.find((item) => item.feature === 'chat').providerId, 'b')
})

test('schema migration uses the legacy provider id only when no chat assignment exists', () => {
  const migration = migrateAiSettings({
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a.example/v1', models: [{ id: 'shared', name: 'Shared A' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b.example/v1', models: [{ id: 'shared', name: 'Shared B' }] }
    ],
    ai: { providerId: 'b', model: 'shared' }
  })
  assert.equal(migration.settings.ai.assignments.find((item) => item.feature === 'chat').providerId, 'b')
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

test('model-less providers never receive a fabricated DeepSeek assignment', () => {
  const providers = normalizeAiProviders([
    { id: 'custom', name: 'Custom', baseUrl: 'https://custom.example/v1', models: [] }
  ])
  const assignments = normalizeAiAssignments([], providers)
  assert.deepEqual(assignments, [])
  assert.equal(resolveAiAssignment({ providers, ai: { assignments } }, 'chat'), null)
})

test('invalid explicit assignments do not silently route to another model', () => {
  const providers = normalizeAiProviders([
    { id: 'custom', name: 'Custom', baseUrl: 'https://custom.example/v1', models: [{ id: 'valid', name: 'Valid' }] }
  ])
  const assignments = normalizeAiAssignments([
    { feature: 'toolbar:translate', providerId: 'custom', model: 'removed' }
  ], providers)
  assert.equal(assignments.some((item) => item.feature === 'toolbar:translate'), false)
  assert.equal(resolveAiAssignment({ providers, ai: { assignments: [{ feature: 'toolbar:translate', providerId: 'custom', model: 'removed' }] } }, 'toolbar:translate'), null)
})

test('disabled or endpoint-less providers cannot be resolved for requests', () => {
  const model = [{ id: 'm1', name: 'M1' }]
  const assignment = [{ feature: 'chat', providerId: 'custom', model: 'm1' }]
  assert.equal(resolveAiAssignment({
    providers: [{ id: 'custom', name: 'Custom', baseUrl: 'https://custom.example/v1', enabled: false, models: model }],
    ai: { assignments: assignment }
  }, 'chat'), null)
  assert.equal(resolveAiAssignment({
    providers: [{ id: 'custom', name: 'Custom', baseUrl: '', enabled: true, models: model }],
    ai: { assignments: assignment }
  }, 'chat'), null)
})

test('default assignments prefer an enabled provider over disabled DeepSeek', () => {
  const settings = normalizeAiSettings({
    providers: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', enabled: false, models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] },
      { id: 'custom', name: 'Custom', baseUrl: 'https://custom.example/v1', enabled: true, models: [{ id: 'm1', name: 'M1' }] }
    ],
    ai: { assignments: [] }
  })
  assert.equal(settings.ai.assignments.find((item) => item.feature === 'chat').providerId, 'custom')
})

test('translation-only models cannot resolve for explain features', () => {
  const settings = normalizeAiSettings({
    providers: [{
      id: 'mt',
      name: 'MT',
      baseUrl: 'https://mt.example/v1',
      models: [{ id: 'tencent/Hunyuan-MT-7B', name: 'Hunyuan MT' }]
    }],
    ai: {
      assignments: [
        { feature: 'toolbar:translate', providerId: 'mt', model: 'tencent/Hunyuan-MT-7B' },
        { feature: 'toolbar:explain', providerId: 'mt', model: 'tencent/Hunyuan-MT-7B' }
      ]
    }
  })
  assert.equal(resolveAiAssignment(settings, 'toolbar:translate')?.model, 'tencent/Hunyuan-MT-7B')
  assert.equal(resolveAiAssignment(settings, 'toolbar:explain'), null)
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
    protocol: 'openai-chat', enabled: true, builtin: false, models: [{
      id: 'a-fast', name: 'A Fast', capabilities: { tasks: ['chat', 'translation', 'explain'], reasoning: 'none' }
    }]
  })
  assert.equal(resolveToolbarAiProvider(settings, 'translate').model, 'b-smart')
  assert.equal(resolveToolbarAiProvider(settings, 'custom:polish').model, 'b-smart')
  assert.equal(resolveToolbarAiProvider(settings, 'custom:unknown').model, 'a-fast')
})
