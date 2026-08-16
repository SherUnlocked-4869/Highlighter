const OpenAI = require('openai')
const {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_TRANSLATE_PROMPT
} = require('./toolbar/toolbar-utils')
const {
  modelSupportsTask,
  normalizeModelCapabilities
} = require('./main/services/ai-model-capabilities')
const {
  buildChatStreamRequest,
  createAiProtocolAdapter
} = require('./main/services/ai-protocol-adapters')

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'
const AI_PROTOCOLS = new Set(['openai-chat', 'openai-responses'])

function cleanText(value, maximumLength = 2048) {
  return String(value ?? '').trim().slice(0, maximumLength)
}

function normalizeProviderInput(provider) {
  if (typeof provider === 'string') {
    return {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: DEEPSEEK_BASE_URL,
      apiKey: cleanText(provider, 512),
      model: DEEPSEEK_DEFAULT_MODEL,
      protocol: 'openai-chat',
      capabilities: { tasks: ['chat', 'translation', 'explain'], reasoning: 'deepseek' },
      vendorThinking: true
    }
  }
  const value = provider && typeof provider === 'object' ? provider : {}
  const id = cleanText(value.id, 64)
  const configuredBaseUrl = cleanText(value.baseUrl || value.baseURL)
  const deepseekCompatible = id.toLowerCase() === 'deepseek' || /deepseek/i.test(configuredBaseUrl)
  const baseUrl = configuredBaseUrl || (deepseekCompatible ? DEEPSEEK_BASE_URL : '')
  const protocol = AI_PROTOCOLS.has(value.protocol) ? value.protocol : 'openai-chat'
  const models = Array.isArray(value.models) ? value.models : []
  const firstModel = models.map((item) => cleanText(item?.id, 200)).find(Boolean) || ''
  const explicitModel = cleanText(value.model, 200)
  const model = explicitModel || firstModel || (deepseekCompatible ? DEEPSEEK_DEFAULT_MODEL : '')
  const modelRecord = models.find((item) => cleanText(item?.id, 200) === model)
  const capabilities = normalizeModelCapabilities(modelRecord?.capabilities, {
    providerId: id,
    baseUrl,
    protocol,
    modelId: model,
    modelName: modelRecord?.name
  })
  return {
    id: id || 'custom',
    name: cleanText(value.name, 100) || '自定义供应商',
    baseUrl,
    apiKey: cleanText(value.apiKey, 512),
    model,
    protocol,
    enabled: value.enabled !== false,
    capabilities,
    vendorThinking: capabilities.reasoning === 'deepseek'
  }
}

function createClient(provider, { timeoutMs = 60000 } = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该模型供应商已禁用，请先在“模型”设置中启用')
  if (!config.baseUrl) throw new Error('请先在“模型”设置中配置供应商 API 地址')
  return new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: timeoutMs,
    maxRetries: 0
  })
}

async function validateApiKey(apiKey) {
  const config = normalizeProviderInput(apiKey)
  if (!config.apiKey || !config.model) return false
  const client = createClient(config, { timeoutMs: 20000 })
  return !!(await createAiProtocolAdapter(config, client).ping())
}

function trimBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '')
}

function withV1Suffix(baseUrl) {
  return `${trimBaseUrl(baseUrl)}/v1`
}

function connectionBaseUrls(baseUrl) {
  const trimmed = trimBaseUrl(baseUrl)
  const urls = [trimmed]
  if (!/\/v1$/.test(trimmed)) urls.push(withV1Suffix(trimmed))
  return [...new Set(urls)]
}

function isNotFoundError(error) {
  const status = Number(error?.status || error?.statusCode || 0)
  if (status === 404 || status === 405) return true
  return /404|not found|no route|route not found/i.test(String(error?.message || ''))
}

function isModelNotFoundError(error) {
  const message = String(error?.message || '')
  return /model[\s\S]*(not found|does not exist|doesn't exist|invalid)|does not exist[\s\S]*model/i.test(message)
}

function describeConnectionError(error) {
  const status = Number(error?.status || error?.statusCode || 0)
  const message = String(error?.message || error || '').trim()
  if (isModelNotFoundError(error)) return `连接失败：模型不存在或不可用（HTTP ${status || 404}），请检查模型目录`
  if (status === 401 || status === 403) return `连接失败：API 密钥无效或没有访问权限（HTTP ${status}）`
  if (status === 404 || status === 405) return '连接失败：接口地址不存在（HTTP 404/405）。请检查 API 地址是否以 /v1 结尾，以及 API 协议是否与供应商兼容'
  if (status === 400) return `连接失败：请求被供应商拒绝（HTTP 400）${message ? `：${message}` : ''}`
  if (status) return `连接失败：供应商返回 HTTP ${status}${message ? `：${message}` : ''}`
  return `连接失败：${message || '网络请求失败，请检查 API 地址'}`.replace(/^连接失败：Error:\s*/, '连接失败：')
}

async function pingConnection(config) {
  if (!config.model) throw new Error('请先在模型目录中配置要测试的模型')
  const client = createClient(config, { timeoutMs: 20000 })
  await createAiProtocolAdapter(config, client).ping()
}

function connectionAttempts(config) {
  const protocols = config.protocol === 'openai-responses'
    ? ['openai-responses', 'openai-chat']
    : ['openai-chat']
  const attempts = []
  for (const baseUrl of connectionBaseUrls(config.baseUrl)) {
    for (const protocol of protocols) {
      attempts.push({ ...config, baseUrl, protocol })
    }
  }
  return attempts
}

async function probeModelsList(config) {
  let lastError = null
  for (const baseUrl of connectionBaseUrls(config.baseUrl)) {
    try {
      const client = createClient({ ...config, baseUrl }, { timeoutMs: 20000 })
      const response = await client.models.list()
      const rows = Array.isArray(response?.data) ? response.data : []
      const models = rows
        .map((item) => ({ id: cleanText(item?.id, 200), name: cleanText(item?.id, 200) }))
        .filter((item) => item.id)
      return { baseUrl, models }
    } catch (error) {
      if (isModelNotFoundError(error)) throw new Error(describeConnectionError(error))
      if (!isNotFoundError(error)) throw new Error(describeConnectionError(error))
      lastError = error
    }
  }
  throw new Error(lastError ? describeConnectionError(lastError) : '获取模型列表失败')
}

async function listProviderModels(provider) {
  const config = normalizeProviderInput(provider)
  if (!config.baseUrl) throw new Error('请先填写 API 地址')
  if (!config.apiKey) throw new Error('请先填写 API 密钥')
  return (await probeModelsList(config)).models
}

async function resolveConnectionAttempt(config) {
  let lastError = null
  for (const attempt of connectionAttempts(config)) {
    try {
      await pingConnection(attempt)
      return attempt
    } catch (error) {
      if (isModelNotFoundError(error)) throw new Error(describeConnectionError(error))
      if (!isNotFoundError(error)) throw new Error(describeConnectionError(error))
      lastError = error
    }
  }
  throw new Error(lastError ? describeConnectionError(lastError) : '连接失败，请检查 API 地址与协议')
}

async function withConnectionFallback(config, request) {
  let lastError = null
  for (const attempt of connectionAttempts(config)) {
    try {
      return await request(attempt)
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') throw error
      if (isModelNotFoundError(error)) throw new Error(describeConnectionError(error))
      if (!isNotFoundError(error)) throw new Error(describeConnectionError(error))
      lastError = error
    }
  }
  throw new Error(lastError ? describeConnectionError(lastError) : '连接失败，请检查 API 地址与协议')
}

async function testProviderConnection(provider, { fetchModels = false } = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该模型供应商已禁用，请先启用后再测试连接')
  if (!config.baseUrl) throw new Error('请先填写 API 地址')
  if (!config.apiKey) throw new Error('请先填写 API 密钥')
  if (!config.model) {
    const probe = await probeModelsList(config)
    if (!probe.models.length) {
      return {
        ok: true,
        protocol: config.protocol,
        baseUrl: probe.baseUrl,
        configuredProtocol: config.protocol,
        configuredBaseUrl: config.baseUrl,
        models: []
      }
    }
    const attempt = await resolveConnectionAttempt({ ...config, baseUrl: probe.baseUrl, model: probe.models[0].id })
    return {
      ok: true,
      protocol: attempt.protocol,
      baseUrl: attempt.baseUrl,
      model: attempt.model,
      configuredProtocol: config.protocol,
      configuredBaseUrl: config.baseUrl,
      models: probe.models
    }
  }
  const attempt = await resolveConnectionAttempt(config)
  const result = {
    ok: true,
    protocol: attempt.protocol,
    baseUrl: attempt.baseUrl,
    configuredProtocol: config.protocol,
    configuredBaseUrl: config.baseUrl
  }
  if (fetchModels) result.models = await listProviderModels(attempt)
  return result
}

function isTranslationOnlyModel(config) {
  return modelSupportsTask({ capabilities: config.capabilities }, 'translation')
    && !modelSupportsTask({ capabilities: config.capabilities }, 'chat')
    && !modelSupportsTask({ capabilities: config.capabilities }, 'explain')
}

function isShortTranslationText(text) {
  const value = String(text || '').trim()
  const words = value.split(/\s+/).filter(Boolean).length
  const characters = Array.from(value).length
  return characters > 0 && characters <= 24 && (words <= 3 || characters <= 12)
}

function containsCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text || ''))
}

function normalizeLanguageCode(language) {
  const value = String(language || '').toLowerCase()
  if (value.includes('繁体') || value.includes('traditional') || value === 'zh-tw') return 'zh-TW'
  if (value.includes('中文') || value.includes('chinese') || value === 'zh' || value === 'zh-cn') return 'zh'
  if (value.includes('英文') || value.includes('english') || value === 'en') return 'en'
  if (value.includes('日文') || value.includes('japanese') || value === 'ja') return 'ja'
  if (value.includes('韩文') || value.includes('korean') || value === 'ko') return 'ko'
  return ''
}

function sourceLanguageCodeForText(text) {
  if (/[\u3040-\u30ff]/.test(String(text || ''))) return 'ja'
  if (/[\uac00-\ud7af]/.test(String(text || ''))) return 'ko'
  if (containsCjk(text)) return 'zh'
  return 'auto'
}

function targetLanguageCodeForPrompt(prompt, text) {
  const value = String(prompt || '').toLowerCase()
  if (containsCjk(text)) {
    if (/翻译成英文|译成英文|译为英文|翻译为英文|to english|into english/.test(value)) return 'en'
    if (/翻译成日文|译成日文|译为日文|翻译为日文|to japanese|into japanese/.test(value)) return 'ja'
    if (/翻译成韩文|译成韩文|译为韩文|翻译为韩文|to korean|into korean/.test(value)) return 'ko'
    if (/翻译成中文|译成中文|译为中文|翻译为中文|to chinese|into chinese/.test(value)) return 'zh'
    return 'en'
  }
  if (/翻译成中文|译成中文|译为中文|翻译为中文|to chinese|into chinese|中文/.test(value)) return 'zh'
  if (/翻译成日文|译成日文|译为日文|翻译为日文|to japanese|into japanese|日文/.test(value)) return 'ja'
  if (/翻译成韩文|译成韩文|译为韩文|翻译为韩文|to korean|into korean|韩文/.test(value)) return 'ko'
  if (/翻译成英文|译成英文|译为英文|翻译为英文|to english|into english|英文/.test(value)) return 'en'
  if (/繁体|traditional/.test(value)) return 'zh-TW'
  return 'zh'
}

function buildTranslationOnlyPrompt(prompt, text, { retry = false } = {}) {
  const target = targetLanguageCodeForPrompt(prompt, text)
  let source = sourceLanguageCodeForText(text)
  if (source === 'auto' && (retry || /^[\x00-\x7f\s]+$/.test(String(text || '').trim()))) source = 'en'
  return `Translate the given text from ${source} to ${target}.\nReturn only the translated text, with no extra commentary.\n\nText:\n${text}`
}

function buildTranslationOnlyPromptForLanguages(text, sourceLanguage, targetLanguage) {
  const target = normalizeLanguageCode(targetLanguage) || targetLanguageCodeForPrompt(`翻译成${targetLanguage}`, text) || 'zh'
  let source = normalizeLanguageCode(sourceLanguage) || (sourceLanguage === 'auto' ? sourceLanguageCodeForText(text) : 'auto')
  if (source === 'auto' && /^[\x00-\x7f\s]+$/.test(String(text || '').trim())) source = 'en'
  return `Translate the given text from ${source} to ${target}.\nReturn only the translated text, with no extra commentary.\n\nText:\n${text}`
}

function resolveTranslateTarget(sourceLanguage, targetLanguage, text) {
  if (sourceLanguage === 'auto' && targetLanguage === '中文' && sourceLanguageCodeForText(text) === 'zh') return '英文'
  return targetLanguage
}

function composeTranslateSystemPrompt(prompt, sourceLanguage, targetLanguage) {
  const source = sourceLanguage === 'auto' ? '自动识别' : sourceLanguage
  const instruction = `你是专业翻译引擎。源语言：${source}；目标语言：${targetLanguage}。只输出译文，保持段落、列表和表格结构，不添加解释。`
  const custom = typeof prompt === 'string' && prompt.trim() && prompt !== DEFAULT_TRANSLATE_PROMPT ? `\n\n${prompt.trim()}` : ''
  return instruction + custom
}

function normalizeTranslationText(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

function isTranslationEcho(input, output) {
  const source = normalizeTranslationText(input)
  const translated = normalizeTranslationText(output)
  return !!source && translated === source
}

async function* createShortTranslationStream(config, text, sourceLanguage, targetLanguage, requestOptions = {}) {
  // When the configured source-language hint is wrong, the model may echo the
  // source text; retry once with the auto-detected language before failing.
  const detected = sourceLanguageCodeForText(text)
  const attempts = [
    buildTranslationOnlyPromptForLanguages(text, sourceLanguage, targetLanguage),
    buildTranslationOnlyPromptForLanguages(text, detected === 'auto' ? 'en' : detected, targetLanguage)
  ]
  for (const userContent of attempts) {
    let content = ''
    const stream = await withConnectionFallback(config, (attempt) => {
      const messages = [{ role: 'user', content: userContent }]
      return createAiProtocolAdapter(attempt, createClient(attempt)).stream(messages, {}, requestOptions)
    })
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta
      if (delta?.content) content += delta.content
    }
    const output = content.trim()
    if (output && !isTranslationEcho(text, output)) {
      // Short translations are small enough to buffer before emitting, so an
      // echo retry never shows a wrong first pass to the user.
      yield { choices: [{ delta: { content: output } }] }
      return
    }
  }
  throw new Error('翻译模型连续返回原文，请尝试更换模型或在划词设置中调整翻译语言')
}

function buildToolbarMessages(text, prompt, { promptInUser = false } = {}) {
  return promptInUser
    ? [{ role: 'user', content: buildTranslationOnlyPrompt(prompt, text) }]
    : [
        { role: 'system', content: prompt },
        { role: 'user', content: text }
      ]
}

function buildToolbarStreamRequest(text, prompt, { thinking = false, model = DEEPSEEK_DEFAULT_MODEL, vendorThinking = true, promptInUser = false } = {}) {
  const messages = buildToolbarMessages(text, prompt, { promptInUser })
  return buildChatStreamRequest({
    model,
    capabilities: { reasoning: vendorThinking ? 'deepseek' : 'none' }
  }, messages, { thinking })
}

function splitStreamRequestOptions(options, fallback) {
  const requestOptions = options && typeof options === 'object' ? { ...options } : {}
  const thinking = Object.hasOwn(requestOptions, 'thinking') ? requestOptions.thinking : fallback
  delete requestOptions.thinking
  return { thinking, requestOptions }
}

async function createTranslateStream(provider, text, prompt = DEFAULT_TRANSLATE_PROMPT, languages = {}, requestOptions = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!config.apiKey) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
  if (!config.model) throw new Error('请先在“模型”设置中为该供应商配置模型')
  const streamOptions = splitStreamRequestOptions(requestOptions, false)
  const sourceLanguage = cleanText(languages?.source, 32) || 'auto'
  const targetLanguage = resolveTranslateTarget(sourceLanguage, cleanText(languages?.target, 32) || '中文', text)
  if (isTranslationOnlyModel(config)) {
    if (isShortTranslationText(text)) {
      return createShortTranslationStream(config, text, sourceLanguage, targetLanguage, streamOptions.requestOptions)
    }
    return withConnectionFallback(config, async (attempt) => {
      const messages = [{ role: 'user', content: buildTranslationOnlyPromptForLanguages(text, sourceLanguage, targetLanguage) }]
      return createAiProtocolAdapter(attempt, createClient(attempt)).stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions)
    })
  }
  const systemPrompt = composeTranslateSystemPrompt(prompt, sourceLanguage, targetLanguage)
  if (typeof provider === 'string') {
    const messages = buildToolbarMessages(text, systemPrompt)
    return createAiProtocolAdapter(config, createClient(config)).stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions)
  }
  return withConnectionFallback(config, async (attempt) => {
    const messages = buildToolbarMessages(text, systemPrompt)
    return createAiProtocolAdapter(attempt, createClient(attempt)).stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions)
  })
}

async function completeChat(provider, messages, options = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!config.apiKey) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
  if (!config.model) throw new Error('请先在“模型”设置中为该供应商配置模型')
  const requestOptions = { ...(options.requestOptions || {}) }
  if (options.signal) requestOptions.signal = options.signal
  const completionOptions = { ...options }
  delete completionOptions.requestOptions
  delete completionOptions.signal
  return withConnectionFallback(config, async (attempt) => {
    return createAiProtocolAdapter(attempt, createClient(attempt)).complete(messages, completionOptions, requestOptions)
  })
}

async function translateText(provider, text, sourceLanguage = 'auto', targetLanguage = '中文') {
  const config = normalizeProviderInput(provider)
  const instruction = `你是专业翻译引擎。源语言：${sourceLanguage}；目标语言：${targetLanguage}。只输出译文，保持段落、列表和表格结构，不添加解释。`
  if (isTranslationOnlyModel(config)) {
    return completeChat(provider, [
      { role: 'user', content: buildTranslationOnlyPromptForLanguages(text, sourceLanguage, targetLanguage) }
    ], { temperature: 0.2 })
  }
  return completeChat(provider, [
    {
      role: 'system',
      content: instruction
    },
    { role: 'user', content: text }
  ], { temperature: 0.2 })
}

async function createExplainStream(provider, text, prompt = DEFAULT_EXPLAIN_PROMPT, requestOptions = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!config.apiKey) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
  if (!config.model) throw new Error('请先在“模型”设置中为该供应商配置模型')
  if (!modelSupportsTask({ capabilities: config.capabilities }, 'explain')) {
    throw new Error('该模型仅支持翻译，不能用于划词解释或自定义指令')
  }
  const streamOptions = splitStreamRequestOptions(requestOptions, true)
  if (typeof provider === 'string') {
    const messages = buildToolbarMessages(text, prompt)
    return createAiProtocolAdapter(config, createClient(config)).stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions)
  }
  return withConnectionFallback(config, async (attempt) => {
    const messages = buildToolbarMessages(text, prompt)
    return createAiProtocolAdapter(attempt, createClient(attempt)).stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions)
  })
}

async function createCustomStream(provider, text, prompt, requestOptions = {}) {
  return createExplainStream(provider, text, prompt, requestOptions)
}

module.exports = {
  buildToolbarStreamRequest,
  buildTranslationOnlyPromptForLanguages,
  composeTranslateSystemPrompt,
  resolveTranslateTarget,
  sourceLanguageCodeForText,
  createTranslateStream,
  createExplainStream,
  createCustomStream,
  completeChat,
  translateText,
  validateApiKey,
  listProviderModels,
  testProviderConnection,
  normalizeProviderInput,
  connectionBaseUrls,
  describeConnectionError,
  isNotFoundError
}
