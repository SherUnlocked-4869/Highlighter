const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { listProviderModels } = require('../main/services/ai')
const { getAiSessionId, resetAiSessionIdForTests } = require('../main/services/ai/session-id')

// Preset-declared headers must reach the wire on every request path that shares
// createClient: ping, stream, complete and list models (design FR-7 / §4.4).
async function withModelServer(run) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    if (request.url !== '/v1/models') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'missing' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3', object: 'model' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run({ port: server.address().port, requests })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('preset headers are injected on model listing and the session id rotates per launch', async () => {
  resetAiSessionIdForTests('session-aaaa')
  await withModelServer(async ({ port, requests }) => {
    const provider = {
      id: 'provider-cp',
      name: 'Open Code Go',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'sk-plan-key',
      protocol: 'openai-chat',
      presetId: 'opencode-go',
      headers: {
        'User-Agent': 'highlighter/2.2.8',
        'x-opencode-session': '${sessionId}'
      },
      models: [{ id: 'kimi-k3', name: 'Kimi K3' }]
    }
    const models = await listProviderModels(provider)
    assert.deepEqual(models.map((model) => model.id), ['kimi-k3'])

    const sent = requests.at(-1).headers
    assert.equal(sent['user-agent'], 'highlighter/2.2.8')
    assert.equal(sent['x-opencode-session'], 'session-aaaa')
    assert.equal(sent.authorization, 'Bearer sk-plan-key')
    // The API key must never be smuggled through a preset header.
    assert.equal(Object.values(sent).includes('sk-plan-key'), false)

    resetAiSessionIdForTests('session-bbbb')
    assert.equal(getAiSessionId(), 'session-bbbb')
    await listProviderModels(provider)
    assert.equal(requests.at(-1).headers['x-opencode-session'], 'session-bbbb')
  })
})

test('providers without preset headers keep the default request shape', async () => {
  await withModelServer(async ({ port, requests }) => {
    await listProviderModels({
      id: 'provider-plain',
      name: 'Plain',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'sk-plain',
      protocol: 'openai-chat',
      models: [{ id: 'kimi-k3', name: 'Kimi K3' }]
    })
    const sent = requests.at(-1).headers
    assert.equal(Object.hasOwn(sent, 'x-opencode-session'), false)
    assert.match(sent['user-agent'], /^OpenAI\//)
  })
})
