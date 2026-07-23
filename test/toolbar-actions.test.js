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
  assert.equal(isAiToolbarAction('unknown'), false)
})
