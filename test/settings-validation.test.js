const test = require('node:test')
const assert = require('node:assert/strict')
const { assertSettingsPatch } = require('../main/services/settings-validation')

const template = {
  apiKey: '',
  theme: 'system',
  compact: false,
  screenshot: {
    historyLimit: 200,
    saveDirectory: '',
    watermark: { content: '', opacity: 80, color: '#ffffff', spacing: 30, fontSize: 24, rotation: 30 }
  },
  selectionToolbar: { order: [], prompts: { translate: '', explain: '' } }
}

test('accepts partial settings patches with matching types', () => {
  const patch = { compact: true, screenshot: { historyLimit: 500 } }
  assert.equal(assertSettingsPatch(patch, template), patch)
})

test('rejects unknown and prototype-related settings', () => {
  assert.throws(() => assertSettingsPatch({ unknown: true }, template), /不支持的设置项/)
  const patch = Object.create(null)
  Object.defineProperty(patch, '__proto__', { value: {}, enumerable: true })
  assert.throws(() => assertSettingsPatch(patch, template), /不支持的设置项/)
})

test('rejects mismatched types and non-finite numbers', () => {
  assert.throws(() => assertSettingsPatch({ compact: 'yes' }, template), /类型无效/)
  assert.throws(() => assertSettingsPatch({ screenshot: { historyLimit: Infinity } }, template), /有限数字/)
})

test('bounds sensitive strings and array sizes', () => {
  assert.throws(() => assertSettingsPatch({ apiKey: `sk-${'a'.repeat(600)}` }, template), /内容过长/)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { order: Array(101).fill('copy') } }, template), /项目过多/)
})

test('accepts watermark settings patches and rejects invalid watermark values', () => {
  const watermark = { content: '仅供内部使用', opacity: 60, color: '#ffffff', spacing: 25, fontSize: 28, rotation: -30 }
  const patch = { screenshot: { watermark } }
  assert.equal(assertSettingsPatch(patch, template), patch)
  assert.equal(assertSettingsPatch({ screenshot: { watermark: { opacity: 50 } } }, template).screenshot.watermark.opacity, 50)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { unknown: 1 } } }, template), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { rotation: Infinity } } }, template), /有限数字/)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { content: 123 } } }, template), /类型无效/)
})
