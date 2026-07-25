const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isAiToolbarAction,
  isLocalToolbarAction
} = require('../toolbar/toolbar-utils')

test('toolbar actions are classified before dispatch', () => {
  assert.equal(isLocalToolbarAction('copy'), true)
  assert.equal(isLocalToolbarAction('search'), true)
  assert.equal(isLocalToolbarAction('translate'), false)
  assert.equal(isAiToolbarAction('translate'), true)
  assert.equal(isAiToolbarAction('explain'), true)
  assert.equal(isAiToolbarAction('custom:polish', {
    customActions: [{ id: 'polish', name: '优化', prompt: '优化这段话' }]
  }), true)
  assert.equal(isAiToolbarAction('custom:missing', {
    customActions: [{ id: 'polish', name: '优化', prompt: '优化这段话' }]
  }), false)
  assert.equal(isAiToolbarAction('unknown'), false)
})
