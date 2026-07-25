const test = require('node:test')
const assert = require('node:assert/strict')
const { buildToolbarStreamRequest } = require('../deepseek')

test('toolbar stream request sends the configured prompt and selected text in separate roles', () => {
  const request = buildToolbarStreamRequest('原始划词文本', '优化这段话')

  assert.deepEqual(request.messages, [
    { role: 'system', content: '优化这段话' },
    { role: 'user', content: '原始划词文本' }
  ])
  assert.equal(request.stream, true)
  assert.equal(request.temperature, 0.3)
  assert.equal(Object.hasOwn(request, 'reasoning_effort'), false)
})

test('explain and custom AI requests preserve thinking mode with a configured prompt', () => {
  const request = buildToolbarStreamRequest('需要解释的文本', '我的解释提示词', { thinking: true })

  assert.equal(request.messages[0].content, '我的解释提示词')
  assert.equal(request.reasoning_effort, 'medium')
  assert.deepEqual(request.extra_body, { thinking: { type: 'enabled' } })
  assert.equal(Object.hasOwn(request, 'temperature'), false)
})
