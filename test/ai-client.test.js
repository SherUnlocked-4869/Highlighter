const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildToolbarStreamRequest,
  buildTranslationOnlyPromptForLanguages,
  composeTranslateSystemPrompt,
  connectionBaseUrls,
  createExplainStream,
  describeConnectionError,
  isNotFoundError,
  normalizeProviderInput,
  resolveTranslateTarget,
  sourceLanguageCodeForText
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

test('explicit translate languages drive MT prompts and Japanese is no longer treated as Chinese', () => {
  const { DEFAULT_TRANSLATE_PROMPT } = require('../toolbar/toolbar-utils')

  assert.equal(sourceLanguageCodeForText('異常なし'), 'ja')
  assert.equal(sourceLanguageCodeForText('ここまで'), 'ja')
  assert.equal(sourceLanguageCodeForText('你好世界'), 'zh')
  assert.equal(sourceLanguageCodeForText('안녕하세요'), 'ko')
  assert.equal(sourceLanguageCodeForText('Hello world'), 'auto')

  assert.match(
    buildTranslationOnlyPromptForLanguages('異常なし', 'auto', '中文'),
    /^Translate the given text from ja to zh\./
  )
  assert.match(
    buildTranslationOnlyPromptForLanguages('異常なし', '日文', '英文'),
    /^Translate the given text from ja to en\./
  )
  assert.match(
    buildTranslationOnlyPromptForLanguages('Hello world', 'auto', '中文'),
    /^Translate the given text from en to zh\./
  )

  assert.equal(resolveTranslateTarget('auto', '中文', '今天天气不错'), '英文')
  assert.equal(resolveTranslateTarget('auto', '中文', '異常なし'), '中文')
  assert.equal(resolveTranslateTarget('auto', '日文', '今天天气不错'), '日文')
  assert.equal(resolveTranslateTarget('中文', '中文', '今天天气不错'), '中文')

  assert.equal(
    composeTranslateSystemPrompt(DEFAULT_TRANSLATE_PROMPT, 'auto', '中文'),
    '你是专业翻译引擎。源语言：自动识别；目标语言：中文。只输出译文，保持段落、列表和表格结构，不添加解释。'
  )
  assert.equal(
    composeTranslateSystemPrompt('用正式书面语翻译', '日文', '英文'),
    '你是专业翻译引擎。源语言：日文；目标语言：英文。只输出译文，保持段落、列表和表格结构，不添加解释。\n\n用正式书面语翻译'
  )
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
