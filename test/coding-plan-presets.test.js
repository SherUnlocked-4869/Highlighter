const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CODING_PLAN_PRESETS,
  HEADER_PLACEHOLDERS,
  MAX_HEADER_COUNT,
  defaultModelsForProvider,
  filterPresetModels,
  getCodingPlanPreset,
  listCodingPlanPresets,
  resolvePresetHeaders,
  resolveRuntimeHeaders,
  sanitizeProviderHeaders,
  storageHeadersForPreset
} = require('../shared/coding-plan-presets')

test('the preset catalog is unique, https-only, and complete', () => {
  const ids = CODING_PLAN_PRESETS.map((preset) => preset.id)
  assert.deepEqual(ids, [...new Set(ids)])
  assert.deepEqual(ids, ['opencode-go', 'glm-coding-plan', 'minimax-coding-plan'])
  for (const preset of CODING_PLAN_PRESETS) {
    assert.match(preset.baseUrl, /^https:\/\//)
    assert.ok(preset.name && preset.tagline && preset.docsUrl)
    assert.equal(preset.protocol, 'openai-chat')
    assert.ok(preset.fallbackModels.length > 0, `${preset.id} has a fallback catalog`)
  }
  assert.equal(getCodingPlanPreset('opencode-go').name, 'Open Code Go')
  assert.equal(getCodingPlanPreset('nope'), null)
  assert.equal(getCodingPlanPreset(''), null)
  assert.equal(listCodingPlanPresets(), CODING_PLAN_PRESETS)
})

test('fallback catalogs never list endpoint-only models and never carry credentials', () => {
  for (const preset of CODING_PLAN_PRESETS) {
    const blocked = new Set([...preset.anthropicOnlyModels, ...preset.responsesOnlyModels])
    for (const model of preset.fallbackModels) {
      assert.equal(blocked.has(model.id), false, `${preset.id} fallback lists blocked model ${model.id}`)
    }
    for (const key of Object.keys(preset.defaultHeaders)) {
      assert.notEqual(key.toLowerCase(), 'authorization')
    }
  }
})

test('header templates only reference the known placeholders', () => {
  for (const preset of CODING_PLAN_PRESETS) {
    for (const value of Object.values(preset.defaultHeaders)) {
      for (const match of String(value).matchAll(/\$\{([^}]+)\}/g)) {
        assert.ok(HEADER_PLACEHOLDERS.includes(match[1]), `unknown placeholder ${match[1]}`)
      }
    }
  }
})

test('preset headers resolve appVersion and sessionId, and storage keeps the session placeholder', () => {
  const preset = getCodingPlanPreset('opencode-go')
  assert.deepEqual(resolvePresetHeaders(preset, { appVersion: '2.2.8', sessionId: 'sess-1' }), {
    'User-Agent': 'highlighter/2.2.8',
    'x-opencode-session': 'sess-1'
  })
  const stored = storageHeadersForPreset(preset, { appVersion: '2.2.8' })
  assert.equal(stored['User-Agent'], 'highlighter/2.2.8')
  assert.equal(stored['x-opencode-session'], '${sessionId}')
  assert.deepEqual(resolveRuntimeHeaders(stored, { sessionId: 'sess-2' })['x-opencode-session'], 'sess-2')
})

test('sanitizeProviderHeaders drops credentials, objects, blanks, and enforces the caps', () => {
  assert.deepEqual(sanitizeProviderHeaders({
    Authorization: 'Bearer secret',
    'X-Empty': '',
    'X-Object': { nested: true },
    'X-Ok': 'v'
  }), { 'X-Ok': 'v' })
  assert.deepEqual(sanitizeProviderHeaders(null), {})
  assert.deepEqual(sanitizeProviderHeaders(['a']), {})
  const many = Object.fromEntries(Array.from({ length: MAX_HEADER_COUNT + 5 }, (_item, index) => [`X-${index}`, 'v']))
  assert.equal(Object.keys(sanitizeProviderHeaders(many)).length, MAX_HEADER_COUNT)
  assert.equal(sanitizeProviderHeaders({ [`K`.repeat(200)]: 'v' })['K'.repeat(64)], 'v')
})

test('filterPresetModels removes both endpoint-only groups, dedupes, and keeps unknown models', () => {
  const preset = getCodingPlanPreset('opencode-go')
  const models = filterPresetModels([
    { id: 'kimi-k3', name: 'Kimi K3' },
    { id: 'minimax-m3', name: 'MiniMax M3' },
    { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
    { id: 'grok-4.7', name: 'Grok 4.7' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'brand-new-model', name: '' },
    { id: 'kimi-k3', name: 'Kimi K3 dup' },
    { id: '', name: 'blank' }
  ], preset)
  assert.deepEqual(models.map((model) => model.id), ['kimi-k3', 'brand-new-model'])
  assert.equal(models[1].name, 'brand-new-model')
  assert.deepEqual(filterPresetModels([{ id: 'minimax-m3' }], getCodingPlanPreset('minimax-coding-plan')).map((m) => m.id), ['minimax-m3'])
})

test('defaultModelsForProvider prefers the preset fallback and still knows the built-ins', () => {
  assert.deepEqual(
    defaultModelsForProvider({ id: 'provider-abc', presetId: 'glm-coding-plan' }).map((model) => model.id),
    ['glm-5.3', 'glm-5.3-flash']
  )
  assert.equal(defaultModelsForProvider({ id: 'deepseek', baseUrl: '' })[0].id, 'deepseek-v4-flash')
  assert.equal(defaultModelsForProvider({ id: 'openai', baseUrl: 'https://api.openai.com/v1' })[0].id, 'gpt-4o-mini')
  assert.deepEqual(defaultModelsForProvider({ id: 'custom', baseUrl: 'https://custom.example/v1' }), [])
  // Returned catalogs are copies: mutating one must not poison the frozen preset.
  const restored = defaultModelsForProvider({ presetId: 'minimax-coding-plan' })
  restored[0].id = 'mutated'
  assert.equal(getCodingPlanPreset('minimax-coding-plan').fallbackModels[0].id, 'MiniMax-M3')
})
