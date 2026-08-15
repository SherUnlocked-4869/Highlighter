const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildChatStreamRequest,
  createAiProtocolAdapter,
  extractResponsesText,
  normalizeResponsesStream
} = require('../main/services/ai-protocol-adapters')

async function* events(values) {
  for (const value of values) yield value
}

async function collect(stream) {
  const values = []
  for await (const value of stream) values.push(value)
  return values
}

test('Responses stream maps output and supported reasoning event variants', async () => {
  const values = await collect(normalizeResponsesStream(events([
    { type: 'response.reasoning.delta', delta: { text: 'r1' } },
    { type: 'response.reasoning_summary.delta', delta: 'r2' },
    { type: 'response.reasoning_summary_text.delta', delta: 'r3' },
    { type: 'response.output_text.delta', delta: 'answer' }
  ])))
  assert.deepEqual(values.map((item) => item.choices[0].delta), [
    { reasoning_content: 'r1' },
    { reasoning_content: 'r2' },
    { reasoning_content: 'r3' },
    { content: 'answer' }
  ])
})

test('Responses stream surfaces refusal, failure, and incomplete events', async () => {
  await assert.rejects(() => collect(normalizeResponsesStream(events([
    { type: 'response.refusal.delta', delta: 'policy' }
  ]))), /模型拒绝.*policy/)
  await assert.rejects(() => collect(normalizeResponsesStream(events([
    { type: 'response.failed', response: { error: { message: 'upstream failed' } } }
  ]))), /upstream failed/)
  await assert.rejects(() => collect(normalizeResponsesStream(events([
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }
  ]))), /max_output_tokens/)
})

test('Responses adapter passes AbortSignal and protocol-specific reasoning', async () => {
  const seen = []
  const signal = new AbortController().signal
  const client = {
    responses: {
      create: async (body, options) => {
        seen.push({ body, options })
        return events([{ type: 'response.output_text.delta', delta: 'ok' }])
      }
    }
  }
  const adapter = createAiProtocolAdapter({
    protocol: 'openai-responses',
    model: 'gpt-test',
    capabilities: { reasoning: 'openai-responses' }
  }, client)
  const stream = await adapter.stream([{ role: 'user', content: 'hello' }], { thinking: 'max' }, { signal })
  assert.deepEqual(await collect(stream), [{ choices: [{ delta: { content: 'ok' } }] }])
  assert.equal(seen[0].options.signal, signal)
  assert.deepEqual(seen[0].body.reasoning, { effort: 'high' })
})

test('Chat adapter passes AbortSignal and sends reasoning fields only for DeepSeek', async () => {
  const signal = new AbortController().signal
  const plain = buildChatStreamRequest({
    model: 'plain',
    capabilities: { reasoning: 'none' }
  }, [{ role: 'user', content: 'hello' }], { thinking: 'high' })
  assert.equal(Object.hasOwn(plain, 'reasoning_effort'), false)
  const deepseek = buildChatStreamRequest({
    model: 'deepseek',
    capabilities: { reasoning: 'deepseek' }
  }, [{ role: 'user', content: 'hello' }], { thinking: 'high' })
  assert.equal(deepseek.reasoning_effort, 'high')

  const seen = []
  const adapter = createAiProtocolAdapter({ protocol: 'openai-chat', model: 'plain', capabilities: { reasoning: 'none' } }, {
    chat: { completions: { create: async (body, options) => {
      seen.push({ body, options })
      return { choices: [{ message: { content: 'done' } }] }
    } } }
  })
  assert.equal(await adapter.complete([{ role: 'user', content: 'hello' }], {}, { signal }), 'done')
  assert.equal(seen[0].options.signal, signal)
})

test('Responses completion extracts nested output text', () => {
  assert.equal(extractResponsesText({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'nested' }] }]
  }), 'nested')
})
