const OpenAI = require('openai')

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

async function createTranslateStream(apiKey, text) {
  const client = createClient(apiKey)
  return client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: '你是一个专业的翻译助手。请将用户输入的任何语言翻译成中文。对于中文输入，翻译成英文。只输出翻译结果，不要添加任何额外说明或解释。'
      },
      { role: 'user', content: text }
    ],
    stream: true,
    temperature: 0.3
  })
}

async function createExplainStream(apiKey, text) {
  const client = createClient(apiKey)
  return client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: '你是一个知识渊博的解说专家。请对用户提供的文本进行深入分析和解读：\n\n### 核心要点\n先用一句话概括核心内容。\n\n### 详细解释\n对文本中的关键概念、术语、背景进行详细解释，帮助用户全面理解。如果涉及专业知识，请进行通俗易懂的说明。\n\n### 延伸知识\n补充相关的背景信息、实际应用场景或有趣的引申知识点。\n\n请使用中文回答，内容充实但不冗长，层次分明。'
      },
      { role: 'user', content: text }
    ],
    stream: true,
    reasoning_effort: 'medium',
    extra_body: { thinking: { type: 'enabled' } }
  })
}

module.exports = { createTranslateStream, createExplainStream, validateApiKey }
