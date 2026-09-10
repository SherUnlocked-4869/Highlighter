const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveProtocolAdapter, listSupportedProtocols } = require('../main/services/ai')

function fakeClient() {
  return {
    responses: {
      create: async () => ({ output: [] })
    },
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: 'ok' } }] })
      }
    }
  }
}

test('resolveProtocolAdapter is the single protocol entry for AI clients', async () => {
  assert.ok(listSupportedProtocols().includes('openai-chat'))
  assert.ok(listSupportedProtocols().includes('openai-responses'))

  const chat = resolveProtocolAdapter({ model: 'm', protocol: 'openai-chat' }, fakeClient())
  assert.equal(typeof chat.stream, 'function')
  assert.equal(typeof chat.complete, 'function')
  assert.equal(await chat.complete([{ role: 'user', content: 'hi' }]), 'ok')

  const responses = resolveProtocolAdapter({ model: 'm', protocol: 'openai-responses' }, fakeClient())
  assert.equal(typeof responses.stream, 'function')
  assert.equal(typeof responses.complete, 'function')
})

test('resolveProtocolAdapter rejects unknown protocols and missing config', () => {
  assert.throws(() => resolveProtocolAdapter(null, fakeClient()), /requires a provider\/model config/)
  assert.throws(
    () => resolveProtocolAdapter({ model: 'm', protocol: 'graphql' }, fakeClient()),
    /Unsupported AI protocol: graphql/
  )
})
