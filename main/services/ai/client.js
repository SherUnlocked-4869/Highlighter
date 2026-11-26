const {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_TRANSLATE_PROMPT
} = require('../../../toolbar/toolbar-utils')
const {
  modelSupportsTask,
  modelSupportsVision,
  normalizeModelCapabilities
} = require('../ai-model-capabilities')
// Vision (image → Markdown/HTML) support, 2026-10-18 snow migration §6.2②: the
// request shape and the prompt live in their own module so the text pipelines
// below never grow a second code path.
const {
  buildImageConversionMessages,
  normalizeImageOutputFormat,
  stripEnclosingFence
} = require('../ai-image-conversion')
const {
  buildChatStreamRequest,
  createAiProtocolAdapter
} = require('../ai-protocol-adapters')
const {
  DEFAULT_AI_MODEL: DEEPSEEK_DEFAULT_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL: DEEPSEEK_BASE_URL,
  AI_PROTOCOLS: AI_PROTOCOL_LIST
} = require('../ai-providers')
const {
  resolveRuntimeHeaders,
  sanitizeProviderHeaders
} = require('../../../shared/coding-plan-presets')
const { getAiSessionId } = require('./session-id')
const { isLoopbackProviderUrl } = require('../../../shared/provider-connection')
// P0-1-T6: the connection-error copy below is returned to the settings window and
// rendered verbatim (`toast(error.message)` in config/routes/models-provider.js),
// so it is UI text. Everything else in this module is AI pipeline content — the
// translation system prompt, the language-name matchers ("中文"/"英文"), the OCR
// batch prompts and the `ai.targetLanguage` default — and is deliberately left
// alone: plan §10.5-4 keeps prompt/target-language data out of UI language
// coupling, and the matchers parse user-supplied prompt text.
const { t } = require('../i18n-bootstrap')

const AI_PROTOCOLS = new Set(AI_PROTOCOL_LIST)
const OCR_TRANSLATION_TIMEOUT_MS = 30000
// Repair requests for OCR blocks the batch answer dropped are independent; a
// small pool keeps a malformed answer from turning into a 24-deep burst of
// concurrent provider calls while still avoiding the old serial chain.
const OCR_TRANSLATION_REPAIR_CONCURRENCY = 8

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
    vendorThinking: capabilities.reasoning === 'deepseek',
    headers: sanitizeProviderHeaders(value.headers)
  }
}

function createClient(provider, { timeoutMs = 60000 } = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该模型供应商已禁用，请先在“模型”设置中启用')
  if (!config.baseUrl) throw new Error('请先在“模型”设置中配置供应商 API 地址')
  const defaultHeaders = resolveRuntimeHeaders(config.headers, { sessionId: getAiSessionId() })
  if (!config.apiKey && isLoopbackProviderUrl(config.baseUrl)) defaultHeaders.authorization = null
  const OpenAI = require('openai')
  return new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
    ...(Object.keys(defaultHeaders).length ? { defaultHeaders } : {})
  })
}

function hasProviderAuth(config) {
  return !!config.apiKey || isLoopbackProviderUrl(config.baseUrl)
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

// The provider detail is appended verbatim (it is the upstream message, not our
// copy), separated by the full-width colon the Simplified/`Traditional tables
// carry inside their own sentences. English appends it with a regular colon so
// the result reads naturally in both scripts.
function withDetail(base, detail) {
  const value = String(detail || '').trim()
  if (!value) return base
  const separator = /[\u4e00-\u9fff]/.test(base) ? '：' : ': '
  return `${base}${separator}${value}`
}

function describeConnectionError(error) {
  const status = Number(error?.status || error?.statusCode || 0)
  const message = String(error?.message || error || '').trim()
  if (isModelNotFoundError(error)) return t('main.ai.model-missing', { status: status || 404 })
  if (status === 401 || status === 403) return t('main.ai.unauthorized', { status })
  if (status === 404 || status === 405) return t('main.ai.endpoint-missing')
  if (status === 400) return withDetail(t('main.ai.bad-request'), message)
  if (status) return withDetail(t('main.ai.http-status', { status }), message)
  // `Error:` is what an Error object stringifies with; the previous single
  // template dropped it only when it led the string, so strip that one prefix
  // rather than rewriting the message.
  const detail = String(message || '').replace(/^Error:\s*/, '') || t('main.ai.fallback')
  return t('main.ai.network', { detail })
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
      const models = []
      const seen = new Set()
      for (const row of rows) {
        const id = cleanText(row?.id, 200)
        if (!id || seen.has(id)) continue
        seen.add(id)
        models.push({ id, name: cleanText(row.display_name || row.name, 120) || id })
        if (models.length >= 5000) break
      }
      return { baseUrl, models }
    } catch (error) {
      if (isModelNotFoundError(error)) throw new Error(describeConnectionError(error))
      if (!isNotFoundError(error)) throw new Error(describeConnectionError(error))
      lastError = error
    }
  }
  throw new Error(lastError ? describeConnectionError(lastError) : '获取模型列表失败')
}

async function discoverProviderModels(provider) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该模型供应商已禁用，请先启用后再获取模型')
  if (!config.baseUrl) throw new Error('请先填写 API 地址')
  if (!hasProviderAuth(config)) throw new Error('请先填写 API 密钥')
  return { ok: true, ...(await probeModelsList(config)) }
}

async function listProviderModels(provider) {
  return (await discoverProviderModels(provider)).models
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

// `withConnectionFallback` used to probe in order on every call, so a provider
// whose working route is the second candidate (`/v1` suffix, or the chat
// protocol instead of responses) paid one wasted 404 request per translation,
// per OCR block. Remember the (baseUrl, protocol) pair that answered and start
// there next time. The key is the endpoint signature taken from the provider
// settings, so changing the URL or protocol in settings produces a different key
// and probes again; an entry that starts answering 404 is dropped and the full
// probe re-runs. The map is bounded because providers come from user settings.
const CONNECTION_CACHE_LIMIT = 32
const resolvedConnections = new Map()

function connectionCacheKey(config) {
  return `${trimBaseUrl(config.baseUrl)}\u0000${config.protocol || 'openai-chat'}`
}

function rememberResolvedConnection(config, attempt) {
  const key = connectionCacheKey(config)
  resolvedConnections.delete(key)
  resolvedConnections.set(key, { baseUrl: attempt.baseUrl, protocol: attempt.protocol })
  while (resolvedConnections.size > CONNECTION_CACHE_LIMIT) {
    resolvedConnections.delete(resolvedConnections.keys().next().value)
  }
}

function forgetResolvedConnection(config) {
  resolvedConnections.delete(connectionCacheKey(config))
}

function cachedConnectionAttempt(config) {
  const key = connectionCacheKey(config)
  const cached = resolvedConnections.get(key)
  if (!cached) return null
  const attempt = connectionAttempts(config)
    .find((item) => item.baseUrl === cached.baseUrl && item.protocol === cached.protocol)
  if (!attempt) {
    resolvedConnections.delete(key)
    return null
  }
  // Refresh recency: least-recently-used entries are evicted first.
  resolvedConnections.delete(key)
  resolvedConnections.set(key, cached)
  return attempt
}

async function withConnectionFallback(config, request) {
  let lastError = null
  const cached = cachedConnectionAttempt(config)
  if (cached) {
    try {
      // Do not `return await` here without the surrounding catch: a stale entry
      // must fall through to the probe below instead of surfacing its 404.
      return await request(cached)
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') throw error
      forgetResolvedConnection(config)
      if (isModelNotFoundError(error)) throw new Error(describeConnectionError(error))
      if (!isNotFoundError(error)) throw new Error(describeConnectionError(error))
    }
  }
  for (const attempt of connectionAttempts(config)) {
    try {
      const result = await request(attempt)
      rememberResolvedConnection(config, attempt)
      return result
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
  if (!hasProviderAuth(config)) throw new Error('请先填写 API 密钥')
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

// A run of kanji with no kana is indistinguishable from Chinese by codepoint
// alone, but the Japanese shinjitai forms of a set of common characters do not
// exist in either Chinese script, and the iteration mark U+3005 is
// Japanese-only too. Treating such text as Chinese builds a wrong "translate
// from" instruction and makes resolveTranslateTarget() flip a Chinese target to
// English, so detect that small set explicitly. The list is deliberately limited
// to characters whose Chinese equivalent is a different codepoint; shared
// characters stay ambiguous and are left to the kana and context rules. The
// codepoints are spelled as escapes so this data line is not mistaken for
// un-migrated UI copy by scripts/check-i18n.js.
//   3005,6c17,99c5,5186,56f3,697d,58f2,8aad,767a,5909,7d4c,7d9a,5e83,8ee2,
//   82b8,770c,9ed2,9a13,6a29,89b3,95a2,6226,5358,4fa1,5e30,6e08,6b69
const JAPANESE_KANJI = /[\u3005\u6c17\u99c5\u5186\u56f3\u697d\u58f2\u8aad\u767a\u5909\u7d4c\u7d9a\u5e83\u8ee2\u82b8\u770c\u9ed2\u9a13\u6a29\u89b3\u95a2\u6226\u5358\u4fa1\u5e30\u6e08\u6b69]/

function containsJapaneseKanji(text) {
  return JAPANESE_KANJI.test(String(text || ''))
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
  const value = String(text || '')
  if (/[\u3040-\u30ff]/.test(value)) return 'ja'
  if (containsJapaneseKanji(value)) return 'ja'
  if (/[\uac00-\ud7af]/.test(value)) return 'ko'
  if (containsCjk(value)) return 'zh'
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
  const detected = sourceLanguageCodeForText(text)
  const attempts = [
    buildTranslationOnlyPromptForLanguages(text, sourceLanguage, targetLanguage),
    buildTranslationOnlyPromptForLanguages(text, detected === 'auto' ? 'en' : detected, targetLanguage)
  ]
  let echoed = ''
  for (const userContent of attempts) {
    const output = await completeChat(config, [{ role: 'user', content: userContent }], {
      temperature: 0.2,
      maxTokens: 1024,
      requestOptions
    })
    const content = String(output || '').trim()
    if (!content) continue
    if (!isTranslationEcho(text, content)) {
      yield { choices: [{ delta: { content } }] }
      return
    }
    echoed = content
  }
  // A proper noun ("DeepSeek", "GitHub") or a single token is legitimately
  // identical in the target language, so a second identical answer is a valid
  // translation result, not a failure: surface it instead of aborting the
  // toolbar with an error. An empty answer on both attempts is still an error.
  if (echoed) {
    yield { choices: [{ delta: { content: echoed } }] }
    return
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
  if (!hasProviderAuth(config)) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
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
  if (!hasProviderAuth(config)) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
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

// Image → Markdown/HTML (2026-10-18 snow migration §6.2②).
//
// `provider` is a resolved assignment ({...provider, model, apiKey}); the caller
// checks vision capability *before* this runs (resolveAiAssignment can only
// resolve text features, so the vision check is a separate guard). The model
// must be declared vision-capable in the model catalog, otherwise the provider
// answers with an opaque 400 that the user cannot act on.
async function convertImage(provider, image, options = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!hasProviderAuth(config)) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
  if (!config.model) throw new Error('请先在“模型”设置中为该供应商配置模型')
  if (!modelSupportsVision({ capabilities: config.capabilities })) {
    throw new Error('当前模型未开启图像理解能力，请先在「模型」设置中为该模型勾选“支持图像”')
  }
  const output = normalizeImageOutputFormat(options.output)
  const messages = buildImageConversionMessages({
    dataUrl: image?.dataUrl,
    base64: image?.base64,
    format: image?.format,
    output,
    instruction: options.instruction
  })
  const requestOptions = { ...(options.requestOptions || {}) }
  if (options.signal) requestOptions.signal = options.signal
  const text = await withConnectionFallback(config, async (attempt) => {
    return createAiProtocolAdapter(attempt, createClient(attempt, { timeoutMs: options.timeoutMs || 120000 }))
      .complete(messages, { maxTokens: options.maxTokens || 4096, temperature: 0.1 }, requestOptions)
  })
  return {
    format: output,
    text: stripEnclosingFence(text, output),
    model: config.model,
    providerId: config.id
  }
}

async function translateText(provider, text, sourceLanguage = 'auto', targetLanguage = '中文', options = {}) {
  const config = normalizeProviderInput(provider)
  const instruction = `你是专业翻译引擎。源语言：${sourceLanguage}；目标语言：${targetLanguage}。只输出译文，保持段落、列表和表格结构，不添加解释。`
  const completionOptions = { temperature: 0.2, ...options }
  if (isTranslationOnlyModel(config)) {
    return completeChat(provider, [
      { role: 'user', content: buildTranslationOnlyPromptForLanguages(text, sourceLanguage, targetLanguage) }
    ], completionOptions)
  }
  return completeChat(provider, [
    {
      role: 'system',
      content: instruction
    },
    { role: 'user', content: text }
  ], completionOptions)
}

function buildOcrTranslationBatchPrompt(texts, sourceLanguage = 'auto', targetLanguage = '中文') {
  const source = normalizeLanguageCode(sourceLanguage)
    || (sourceLanguage === 'auto' ? sourceLanguageCodeForText(texts.join('\n')) : cleanText(sourceLanguage, 32))
    || 'auto'
  const target = normalizeLanguageCode(targetLanguage) || cleanText(targetLanguage, 32) || 'zh'
  return [
    `Translate every string in the JSON array from ${source} to ${target}.`,
    'Return only valid JSON in exactly this shape: {"translations":["translated string", "translated string"]}.',
    `The translations array must contain exactly ${texts.length} strings in the same order. Do not merge, omit, reorder, or explain any item.`,
    `Input JSON: ${JSON.stringify(texts)}`
  ].join('\n')
}

function parseOcrTranslationBatchOutput(value, expectedCount) {
  const text = String(value || '').trim()
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const candidates = [unfenced]
  const objectStart = unfenced.indexOf('{')
  const objectEnd = unfenced.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(unfenced.slice(objectStart, objectEnd + 1))
  const arrayStart = unfenced.indexOf('[')
  const arrayEnd = unfenced.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(unfenced.slice(arrayStart, arrayEnd + 1))
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate)
      const values = Array.isArray(parsed) ? parsed : parsed?.translations
      if (!Array.isArray(values) || values.length !== expectedCount) continue
      const translations = values.map((item) => String(item ?? '').trim())
      if (translations.every(Boolean)) return translations
    } catch {}
  }
  throw new Error(`批量翻译返回了无法对应 OCR 文本块的结果（期望 ${expectedCount} 项）`)
}

function splitOcrTranslationBatches(texts, { maximumItems = 24, maximumCharacters = 5000 } = {}) {
  const batches = []
  let current = []
  let characters = 0
  texts.forEach((text, index) => {
    const length = Array.from(text).length
    if (current.length && (current.length >= maximumItems || characters + length > maximumCharacters)) {
      batches.push(current)
      current = []
      characters = 0
    }
    current.push({ index, text })
    characters += length
  })
  if (current.length) batches.push(current)
  return batches
}

// Indexed OCR batch translation (review section 3.7.4). The previous prompt asked for
// a positional `{"translations":[...]}` array; when the model merged two OCR
// lines (or dropped one) the count check failed and the whole batch fell back to
// one request per block, serially — up to 24 sequential round-trips. Asking for
// `[{"i":0,"t":"..."}]` keeps the mapping explicit, so a merged/dropped line only
// costs a repair request for the indices that are actually missing.
function buildOcrTranslationIndexedPrompt(items, sourceLanguage, targetLanguage) {
  const source = normalizeLanguageCode(sourceLanguage)
    || (sourceLanguage === 'auto' ? sourceLanguageCodeForText(items.map((item) => item.t).join('\n')) : cleanText(sourceLanguage, 32))
    || 'auto'
  const target = normalizeLanguageCode(targetLanguage) || cleanText(targetLanguage, 32) || 'zh'
  return [
    `Translate every "t" value in this JSON array from ${source} to ${target}.`,
    'Return only valid JSON in exactly this shape: [{"i":0,"t":"translated string"},{"i":1,"t":"translated string"}].',
    'Keep every "i" unchanged, keep one entry per input entry, and do not merge, split, omit, reorder, or explain any item.',
    `Input JSON: ${JSON.stringify(items)}`
  ].join('\n')
}

function parseOcrTranslationIndexedOutput(value, expectedIndices) {
  const expected = new Set(expectedIndices)
  const text = String(value || '').trim()
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const candidates = [unfenced]
  const arrayStart = unfenced.indexOf('[')
  const arrayEnd = unfenced.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(unfenced.slice(arrayStart, arrayEnd + 1))
  const objectStart = unfenced.indexOf('{')
  const objectEnd = unfenced.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(unfenced.slice(objectStart, objectEnd + 1))
  const translations = new Map()
  const remember = (index, translation) => {
    if (!expected.has(index) || translations.has(index)) return
    const value = String(translation ?? '').trim()
    if (value) translations.set(index, value)
  }
  for (const candidate of [...new Set(candidates)]) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const values = Array.isArray(parsed) ? parsed : parsed?.translations
    if (!Array.isArray(values) || !values.length) continue
    // A provider that ignores the indexed shape may still answer positionally;
    // map that answer by position instead of discarding the whole batch.
    if (typeof values[0] === 'string') {
      if (values.length === expectedIndices.length) expectedIndices.forEach((index, position) => remember(index, values[position]))
      continue
    }
    for (const entry of values) {
      if (!entry || typeof entry !== 'object') continue
      const index = Number(entry.i ?? entry.index)
      if (!Number.isInteger(index)) continue
      remember(index, entry.t ?? entry.text ?? entry.translation)
    }
  }
  return translations
}

async function forEachWithConcurrency(items, limit, worker) {
  const queue = [...items]
  const runnerCount = Math.max(1, Math.min(limit, queue.length))
  const runners = []
  for (let runner = 0; runner < runnerCount; runner += 1) {
    runners.push((async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item)
    })())
  }
  await Promise.all(runners)
}

async function translateOcrTextBlocks(provider, texts, sourceLanguage = 'auto', targetLanguage = '中文', { signal } = {}) {
  const normalized = (Array.isArray(texts) ? texts : []).map((text) => String(text || '').trim())
  if (!normalized.length || normalized.some((text) => !text)) throw new Error('OCR 文本块为空，无法建立翻译位置对应关系')
  const config = normalizeProviderInput(provider)
  const translations = Array(normalized.length)
  const completionOptions = {
    temperature: 0.2,
    thinking: 'off',
    requestOptions: { timeout: OCR_TRANSLATION_TIMEOUT_MS },
    signal
  }
  const indexed = normalized.map((text, index) => ({ i: index, t: text }))
  for (const batch of splitOcrTranslationBatches(normalized)) {
    signal?.throwIfAborted()
    const positions = batch.map((item) => item.index)
    const prompt = buildOcrTranslationIndexedPrompt(positions.map((index) => indexed[index]), sourceLanguage, targetLanguage)
    let output
    if (isTranslationOnlyModel(config)) {
      output = await completeChat(provider, [{ role: 'user', content: prompt }], completionOptions)
    } else {
      output = await completeChat(provider, [
        {
          role: 'system',
          content: '你是专业 OCR 翻译引擎。严格保持输入数组的条目数量和顺序，只返回指定 JSON，不添加解释。'
        },
        { role: 'user', content: prompt }
      ], completionOptions)
    }
    const parsed = parseOcrTranslationIndexedOutput(output, positions)
    for (const [index, translation] of parsed) translations[index] = translation
    // Only the indices the model dropped are repaired, and they are translated
    // concurrently: one merged line no longer serialises the whole batch.
    const missing = batch.filter((item) => translations[item.index] == null)
    await forEachWithConcurrency(missing, OCR_TRANSLATION_REPAIR_CONCURRENCY, async (item) => {
      signal?.throwIfAborted()
      const value = String(await translateText(provider, item.text, sourceLanguage, targetLanguage, completionOptions)).trim()
      if (!value) throw new Error('翻译模型返回了空文本，无法覆盖对应的 OCR 文本块')
      translations[item.index] = value
    })
  }
  return translations
}

async function createExplainStream(provider, text, prompt = DEFAULT_EXPLAIN_PROMPT, requestOptions = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!hasProviderAuth(config)) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
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

async function createFollowUpStream(provider, messages, requestOptions = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!hasProviderAuth(config)) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
  if (!config.model) throw new Error('请先在“模型”设置中为该供应商配置模型')
  if (!modelSupportsTask({ capabilities: config.capabilities }, 'chat')) {
    throw new Error('当前模型不支持对话，无法继续追问')
  }
  const streamOptions = splitStreamRequestOptions(requestOptions, true)
  return withConnectionFallback(config, async (attempt) => {
    return createAiProtocolAdapter(attempt, createClient(attempt)).stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions)
  })
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
  createFollowUpStream,
  completeChat,
  convertImage,
  translateText,
  translateOcrTextBlocks,
  buildOcrTranslationBatchPrompt,
  parseOcrTranslationBatchOutput,
  buildOcrTranslationIndexedPrompt,
  parseOcrTranslationIndexedOutput,
  validateApiKey,
  listProviderModels,
  discoverProviderModels,
  testProviderConnection,
  normalizeProviderInput,
  connectionBaseUrls,
  describeConnectionError,
  isNotFoundError
}
