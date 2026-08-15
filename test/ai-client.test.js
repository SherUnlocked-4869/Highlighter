const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildToolbarStreamRequest,
  connectionBaseUrls,
  createExplainStream,
  describeConnectionError,
  isNotFoundError,
  normalizeProviderInput
} = require('../deepseek')

test('normalizes string keys to the legacy DeepSeek provider', () => {
  const provider = normalizeProviderInput('sk-legacy')
  assert.equal(provider.id, 'deepseek')
  assert.equal(provider.baseUrl, 'https://api.deepseek.com')
  assert.equal(provider.model, 'deepseek-v4-flash')
  assert.equal(provider.vendorThinking, true)
})

test('normalizes provider objects with a selected model and protocol', () => {
  const provider = normalizeProviderInput({
    id: 'jbb',
    name: 'jbb',
    baseUrl: 'https://jbbt.pages.dev/v1',
    apiKey: 'sk-jbb',
    model: 'gpt-5.6-terra',
    protocol: 'openai-responses'
  })
  assert.equal(provider.model, 'gpt-5.6-terra')
  assert.equal(provider.protocol, 'openai-responses')
  assert.equal(provider.vendorThinking, false)
})

test('custom providers without models do not fall back to the DeepSeek model', () => {
  const provider = normalizeProviderInput({
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-silicon',
    models: [{ id: '', name: '' }]
  })
  assert.equal(provider.model, '')
})

test('custom providers without endpoints do not fall back to DeepSeek', () => {
  const provider = normalizeProviderInput({
    id: 'custom',
    name: 'Custom',
    baseUrl: '',
    apiKey: 'sk-custom',
    models: [{ id: 'custom-model', name: 'Custom Model' }]
  })
  assert.equal(provider.baseUrl, '')
  assert.equal(provider.model, 'custom-model')
  assert.equal(provider.vendorThinking, false)
})

test('non-DeepSeek providers omit DeepSeek thinking extension fields', () => {
  const request = buildToolbarStreamRequest('文本', '提示词', {
    thinking: 'high',
    model: 'gpt-5.6-terra',
    vendorThinking: false
  })
  assert.equal(request.model, 'gpt-5.6-terra')
  assert.equal(Object.hasOwn(request, 'reasoning_effort'), false)
  assert.equal(Object.hasOwn(request, 'thinking'), false)
  assert.equal(Object.hasOwn(request, 'extra_body'), false)
  assert.equal(request.temperature, 0.3)
})

test('translation-specialized models receive the instruction in the user message', () => {
  const request = buildToolbarStreamRequest('Hello world', '请将以下内容翻译成中文', {
    model: 'tencent/Hunyuan-MT-7B',
    promptInUser: true
  })
  assert.deepEqual(request.messages, [
    { role: 'user', content: 'Translate the given text from en to zh.\nReturn only the translated text, with no extra commentary.\n\nText:\nHello world' }
  ])
})

test('translation-only models are rejected for explain requests before network access', async () => {
  await assert.rejects(() => createExplainStream({
    id: 'mt',
    name: 'MT',
    baseUrl: 'https://mt.example/v1',
    apiKey: 'sk-mt',
    model: 'tencent/Hunyuan-MT-7B',
    protocol: 'openai-chat'
  }, 'hello', '解释这段文本'), /仅支持翻译/)
})

test('connection probing adds the /v1 suffix and detects 404 responses', () => {
  assert.deepEqual(connectionBaseUrls('https://api.siliconflow.cn/'), ['https://api.siliconflow.cn', 'https://api.siliconflow.cn/v1'])
  assert.deepEqual(connectionBaseUrls('https://api.deepseek.com/v1/'), ['https://api.deepseek.com/v1'])
  assert.equal(isNotFoundError({ status: 404 }), true)
  assert.equal(isNotFoundError({ statusCode: 405 }), true)
  assert.equal(isNotFoundError({ message: 'Error: 404 not found' }), true)
  assert.equal(isNotFoundError({ status: 401 }), false)
  assert.match(describeConnectionError({ status: 404 }), /API 地址/)
  assert.match(describeConnectionError({ status: 401 }), /API 密钥/)
})
