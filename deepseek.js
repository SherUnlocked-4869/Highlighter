const OpenAI = require('openai')
const {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_TRANSLATE_PROMPT
} = require('./toolbar/toolbar-utils')

function createClient(apiKey) {
  return new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey
  })
}

async function validateApiKey(apiKey) {
  const client = createClient(apiKey)
  const response = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 5
  })
  return !!response
}

function buildToolbarStreamRequest(text, prompt, { thinking = false } = {}) {
  const request = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: text }
    ],
    stream: true,
    temperature: thinking ? undefined : 0.3
  }
  if (thinking) {
    delete request.temperature
    request.reasoning_effort = 'medium'
    request.extra_body = { thinking: { type: 'enabled' } }
  }
  return request
}

async function createTranslateStream(apiKey, text, prompt = DEFAULT_TRANSLATE_PROMPT) {
  const client = createClient(apiKey)
  return client.chat.completions.create(buildToolbarStreamRequest(text, prompt))
}

async function completeChat(apiKey, messages, options = {}) {
  if (!apiKey) throw new Error('请先在设置中配置 DeepSeek API Key')
  const client = createClient(apiKey)
  const response = await client.chat.completions.create({
    model: options.model || 'deepseek-v4-flash',
    messages,
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.7
  })
  return response.choices?.[0]?.message?.content || ''
}

async function translateText(apiKey, text, sourceLanguage = 'auto', targetLanguage = '中文') {
  return completeChat(apiKey, [
    {
      role: 'system',
      content: `你是专业翻译引擎。源语言：${sourceLanguage}；目标语言：${targetLanguage}。只输出译文，保持段落、列表和表格结构，不添加解释。`
    },
    { role: 'user', content: text }
  ], { temperature: 0.2 })
}

async function createExplainStream(apiKey, text, prompt = DEFAULT_EXPLAIN_PROMPT) {
  const client = createClient(apiKey)
  return client.chat.completions.create(buildToolbarStreamRequest(text, prompt, { thinking: true }))
}

async function createCustomStream(apiKey, text, prompt) {
  return createExplainStream(apiKey, text, prompt)
}

module.exports = {
  buildToolbarStreamRequest,
  createTranslateStream,
  createExplainStream,
  createCustomStream,
  completeChat,
  translateText,
  validateApiKey
}
