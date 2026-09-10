const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const helpers = require('../config/routes/model-helpers')
const configHtml = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
const configJs = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')

test('config loads shared model helpers before the shell script', () => {
  const helpersIndex = configHtml.indexOf('routes/model-helpers.js')
  const configIndex = configHtml.indexOf('config.js')
  assert.ok(helpersIndex >= 0)
  assert.ok(configIndex > helpersIndex)
})

test('config.js delegates pure model helpers instead of redefining them', () => {
  assert.match(configJs, /window\.modelHelpers/)
  assert.doesNotMatch(configJs, /function createModelProviderId\(/)
  assert.doesNotMatch(configJs, /function defaultModelsForProvider\(/)
  assert.doesNotMatch(configJs, /function modelProviderStatus\(/)
  assert.doesNotMatch(configJs, /function modelTaskForFeature\(/)
  assert.doesNotMatch(configJs, /function modelsForFeature\(/)
})

test('model helpers keep provider defaults and feature task mapping', () => {
  assert.equal(helpers.createModelProviderId().startsWith('provider-'), true)
  assert.equal(helpers.defaultModelsForProvider({ id: 'deepseek', baseUrl: '' })[0].id, 'deepseek-v4-flash')
  assert.equal(helpers.modelProviderStatus({ enabled: false }).className, 'off')
  assert.equal(helpers.modelTaskForFeature('ocr-translate'), 'translation')
  assert.equal(helpers.modelTaskForFeature('toolbar:explain'), 'explain')
  assert.equal(helpers.modelTaskForFeature('chat'), 'chat')
  assert.equal(
    helpers.modelsForFeature({ models: [{ id: 'hunyuan-mt' }, { id: 'gpt-4o' }] }, 'translation').map((m) => m.id).join(','),
    'hunyuan-mt,gpt-4o'
  )
  assert.equal(
    helpers.modelsForFeature({ models: [{ id: 'hunyuan-mt' }, { id: 'gpt-4o' }] }, 'chat').map((m) => m.id).join(','),
    'gpt-4o'
  )
})
