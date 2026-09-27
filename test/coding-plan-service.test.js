const test = require('node:test')
const assert = require('node:assert/strict')
const { createCodingPlanProvider, uniqueProviderName } = require('../main/services/coding-plan-service')

function createSettingsService(providers = []) {
  const state = { providers }
  const calls = []
  return {
    calls,
    state,
    getSettings: () => ({ providers: state.providers }),
    updateSettings: (patch) => {
      calls.push(patch)
      state.providers = patch.providers
      return { patch, settings: { providers: state.providers } }
    }
  }
}

test('a verified plan stores the live filtered catalog and marks it verified', async () => {
  const settingsService = createSettingsService()
  const result = await createCodingPlanProvider(
    { presetId: 'opencode-go', apiKey: 'sk-live' },
    {
      settingsService,
      appVersion: '2.2.8',
      createProviderId: () => 'provider-test1',
      testProviderConnection: async (provider, options) => {
        assert.equal(provider.presetId, 'opencode-go')
        assert.equal(provider.baseUrl, 'https://opencode.ai/zen/go/v1')
        assert.equal(provider.apiKey, 'sk-live')
        assert.deepEqual(provider.models, [])
        assert.deepEqual(options, { fetchModels: true })
        return { ok: true, models: [{ id: 'kimi-k3', name: 'Kimi K3' }, { id: 'minimax-m3', name: 'MM' }, { id: 'grok-4.7', name: 'G' }] }
      }
    }
  )

  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.warning, '')
  assert.equal(result.modelsCount, 1)
  assert.equal(result.provider.id, 'provider-test1')
  assert.equal(result.provider.modelsVerified, true)
  assert.deepEqual(result.provider.models.map((model) => model.id), ['kimi-k3'])
  assert.equal(Object.hasOwn(result.provider, 'apiKey'), false)
  assert.equal(settingsService.calls.length, 1)
  assert.equal(settingsService.state.providers.length, 1)
  assert.equal(settingsService.state.providers[0].apiKey, 'sk-live')
})

test('a failed connection test saves the fallback catalog without throwing', async () => {
  const settingsService = createSettingsService()
  const result = await createCodingPlanProvider(
    { presetId: 'glm-coding-plan', apiKey: 'sk-bad' },
    {
      settingsService,
      testProviderConnection: async () => { throw new Error('连接失败：API 密钥无效或没有访问权限（HTTP 401）') }
    }
  )

  assert.equal(result.ok, true)
  assert.equal(result.verified, false)
  assert.equal(result.provider.modelsVerified, false)
  assert.deepEqual(result.provider.models.map((model) => model.id), ['glm-5.3', 'glm-5.3-flash'])
  assert.match(result.warning, /HTTP 401/)
  assert.equal(settingsService.state.providers.length, 1)
})

test('an empty live catalog falls back with a catalog-unverified warning', async () => {
  const result = await createCodingPlanProvider(
    { presetId: 'minimax-coding-plan', apiKey: 'sk-empty' },
    {
      settingsService: createSettingsService(),
      testProviderConnection: async () => ({ ok: true, models: [] })
    }
  )
  assert.equal(result.verified, false)
  assert.equal(result.provider.modelsVerified, false)
  assert.match(result.warning, /内置清单/)
  assert.deepEqual(result.provider.models.map((model) => model.id), ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'])
})

test('preset headers are stored with appVersion resolved and the session placeholder intact', async () => {
  const settingsService = createSettingsService()
  const result = await createCodingPlanProvider(
    { presetId: 'opencode-go', apiKey: 'sk-headers' },
    {
      settingsService,
      appVersion: '9.9.9',
      testProviderConnection: async () => ({ ok: true, models: [{ id: 'kimi-k3', name: 'Kimi K3' }] })
    }
  )
  assert.deepEqual(result.provider.headers, {
    'User-Agent': 'highlighter/9.9.9',
    'x-opencode-session': '${sessionId}'
  })
})

test('rejects unknown plans, missing keys, and the provider ceiling', async () => {
  const deps = { settingsService: createSettingsService(), testProviderConnection: async () => ({ ok: true, models: [] }) }
  await assert.rejects(() => createCodingPlanProvider({ presetId: 'nope', apiKey: 'sk' }, deps), /未知的 Coding Plan/)
  await assert.rejects(() => createCodingPlanProvider({ presetId: 'opencode-go', apiKey: '' }, deps), /API 密钥/)
  await assert.rejects(
    () => createCodingPlanProvider({ presetId: 'opencode-go', apiKey: 'sk' }, {
      ...deps,
      settingsService: createSettingsService(Array.from({ length: 20 }, (_item, index) => ({ id: `p${index}` })))
    }),
    /上限/
  )
})

test('a repeated plan gets an ordinal name and a custom display name wins', async () => {
  const existing = [{ id: 'p1', name: 'Open Code Go' }, { id: 'p2', name: 'Open Code Go 2' }]
  assert.equal(uniqueProviderName('Open Code Go', existing), 'Open Code Go 3')
  assert.equal(uniqueProviderName('Fresh', existing), 'Fresh')

  const result = await createCodingPlanProvider(
    { presetId: 'opencode-go', apiKey: 'sk-name' },
    { settingsService: createSettingsService(existing), testProviderConnection: async () => ({ ok: true, models: [{ id: 'kimi-k3', name: 'K3' }] }) }
  )
  assert.equal(result.provider.name, 'Open Code Go 3')

  const named = await createCodingPlanProvider(
    { presetId: 'opencode-go', apiKey: 'sk-name', displayName: '我的套餐' },
    { settingsService: createSettingsService(existing), testProviderConnection: async () => ({ ok: true, models: [{ id: 'kimi-k3', name: 'K3' }] }) }
  )
  assert.equal(named.provider.name, '我的套餐')
})
