function resolveThinkingLevel(thinking) {
  if (thinking === true) return 'medium'
  if (thinking === 'low' || thinking === 'medium' || thinking === 'high' || thinking === 'max') return thinking
  return ''
}

function buildChatStreamRequest(config, messages, { thinking = false } = {}) {
  const level = resolveThinkingLevel(thinking)
  const request = {
    model: config.model,
    messages,
    stream: true,
    temperature: 0.3
  }
  if (config.capabilities?.reasoning === 'deepseek') {
    if (level) {
      delete request.temperature
      request.reasoning_effort = level
      request.thinking = { type: 'enabled' }
      request.extra_body = { thinking: { type: 'enabled' } }
    } else if (thinking === 'off') {
      request.thinking = { type: 'disabled' }
      request.extra_body = { thinking: { type: 'disabled' } }
    }
  }
  return request
}

function buildResponsesMessages(messages) {
  const roles = new Set(['system', 'user', 'assistant', 'developer'])
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: roles.has(message?.role) ? message.role : 'user',
    content: typeof message?.content === 'string' ? message.content : String(message?.content || '')
  }))
}

function extractResponsesText(response) {
  if (!response) return ''
  if (typeof response.output_text === 'string') return response.output_text
  const parts = []
  for (const output of Array.isArray(response.output) ? response.output : []) {
    if (typeof output?.content === 'string') parts.push(output.content)
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('')
}

function responseFailureMessage(chunk) {
  const error = chunk?.error || chunk?.response?.error
  const detail = error?.message || error?.code || chunk?.message || chunk?.code || chunk?.response?.incomplete_details?.reason
  if (chunk?.type === 'response.refusal.delta') return `模型拒绝了该请求${chunk.delta ? `：${chunk.delta}` : ''}`
  if (chunk?.type === 'response.incomplete') return `模型响应未完成${detail ? `：${detail}` : ''}`
  return `模型请求失败${detail ? `：${detail}` : ''}`
}

async function* normalizeResponsesStream(stream) {
  const reasoningEvents = new Set([
    'response.reasoning.delta',
    'response.reasoning_summary.delta',
    'response.reasoning_summary_text.delta'
  ])
  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'response.output_text.delta' && chunk.delta) {
      yield { choices: [{ delta: { content: chunk.delta } }] }
    } else if (reasoningEvents.has(chunk.type) && chunk.delta) {
      const reasoning = typeof chunk.delta === 'string' ? chunk.delta : (chunk.delta?.text || chunk.delta?.content || '')
      if (reasoning) yield { choices: [{ delta: { reasoning_content: reasoning } }] }
    } else if (chunk.type === 'response.refusal.delta' || chunk.type === 'response.failed' || chunk.type === 'response.incomplete' || chunk.type === 'error') {
      throw new Error(responseFailureMessage(chunk))
    }
  }
}

function buildResponsesStreamRequest(config, messages, { thinking = false } = {}) {
  const request = {
    model: config.model,
    input: buildResponsesMessages(messages),
    stream: true
  }
  const level = resolveThinkingLevel(thinking)
  if (config.capabilities?.reasoning === 'openai-responses' && level) {
    const efforts = { low: 'low', medium: 'medium', high: 'high', max: 'high' }
    request.reasoning = { effort: efforts[level] || 'medium' }
  }
  return request
}

function createAiProtocolAdapter(config, client) {
  if (!client) throw new Error('AI protocol adapter requires a client')
  if (config.protocol === 'openai-responses') {
    return {
      async ping(requestOptions = {}) {
        return client.responses.create({ model: config.model, input: 'hi', max_output_tokens: 5 }, requestOptions)
      },
      async stream(messages, options = {}, requestOptions = {}) {
        const response = await client.responses.create(buildResponsesStreamRequest(config, messages, options), requestOptions)
        return normalizeResponsesStream(response)
      },
      async complete(messages, options = {}, requestOptions = {}) {
        const response = await client.responses.create({
          model: options.model || config.model,
          input: buildResponsesMessages(messages),
          max_output_tokens: options.maxTokens || 4096,
          temperature: options.temperature ?? 0.7
        }, requestOptions)
        return extractResponsesText(response)
      }
    }
  }
  return {
    async ping(requestOptions = {}) {
      return client.chat.completions.create({
        model: config.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      }, requestOptions)
    },
    stream(messages, options = {}, requestOptions = {}) {
      return client.chat.completions.create(buildChatStreamRequest(config, messages, options), requestOptions)
    },
    async complete(messages, options = {}, requestOptions = {}) {
      const response = await client.chat.completions.create({
        model: options.model || config.model,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7
      }, requestOptions)
      return response.choices?.[0]?.message?.content || ''
    }
  }
}

module.exports = {
  buildChatStreamRequest,
  buildResponsesMessages,
  buildResponsesStreamRequest,
  createAiProtocolAdapter,
  extractResponsesText,
  normalizeResponsesStream,
  resolveThinkingLevel
}
