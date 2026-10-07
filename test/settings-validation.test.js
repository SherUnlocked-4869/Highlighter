const test = require('node:test')
const assert = require('node:assert/strict')
const { assertSettingsPatch } = require('../main/services/settings-validation')
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')

const template = {
  apiKey: '',
  theme: 'system',
  compact: false,
  screenshot: {
    historyLimit: 200,
    saveDirectory: '',
    watermark: { content: '', opacity: 80, color: '#ffffff', spacing: 30, fontSize: 24, rotation: 30, dateSuffix: false }
  },
  system: { gameMode: false },
  selectionToolbar: {
    order: [],
    prompts: { translate: '', explain: '' },
    conversation: { enabled: true, maxFollowUpTurns: 10, persist: false }
  }
}

test('accepts partial settings patches with matching types', () => {
  const patch = { compact: true, screenshot: { historyLimit: 500 }, system: { gameMode: true } }
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
  assert.throws(() => assertSettingsPatch({ system: { gameMode: 'yes' } }, template), /类型无效/)
  assert.throws(() => assertSettingsPatch({ screenshot: { historyLimit: Infinity } }, template), /有限数字/)
})

test('bounds sensitive strings and array sizes', () => {
  assert.throws(() => assertSettingsPatch({ apiKey: `sk-${'a'.repeat(600)}` }, template), /内容过长/)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { order: Array(101).fill('copy') } }, template), /项目过多/)
})

test('accepts watermark settings patches and rejects invalid watermark values', () => {
  const watermark = { content: '仅供内部使用', opacity: 60, color: '#ffffff', spacing: 25, fontSize: 28, rotation: -30, dateSuffix: true }
  const patch = { screenshot: { watermark } }
  assert.equal(assertSettingsPatch(patch, template), patch)
  assert.equal(assertSettingsPatch({ screenshot: { watermark: { opacity: 50 } } }, template).screenshot.watermark.opacity, 50)
  assert.equal(assertSettingsPatch({ screenshot: { watermark: { dateSuffix: true } } }, template).screenshot.watermark.dateSuffix, true)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { unknown: 1 } } }, template), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { rotation: Infinity } } }, template), /有限数字/)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { content: 123 } } }, template), /类型无效/)
  assert.throws(() => assertSettingsPatch({ screenshot: { watermark: { dateSuffix: 'yes' } } }, template), /类型无效/)
})

test('accepts the annotation width patch and only enforces its type', () => {
  // The real patch template is DEFAULT_SETTINGS, so the default value added for
  // the screenshot thickness picker is what authorises this patch. The validator
  // checks the type only — the 2/4/8 whitelist lives in capture/annotation-style.js.
  assert.equal(
    assertSettingsPatch({ screenshot: { annotationWidth: 8 } }, DEFAULT_SETTINGS).screenshot.annotationWidth,
    8
  )
  assert.equal(DEFAULT_SETTINGS.screenshot.annotationWidth, 4)
  assert.throws(() => assertSettingsPatch({ screenshot: { annotationWidth: '8' } }, DEFAULT_SETTINGS), /类型无效/)
  assert.throws(() => assertSettingsPatch({ screenshot: { annotationWidth: Infinity } }, DEFAULT_SETTINGS), /有限数字/)
})

test('accepts follow-up conversation patches and rejects broken shapes', () => {
  const patch = { selectionToolbar: { conversation: { enabled: false } } }
  assert.equal(assertSettingsPatch(patch, template), patch)
  assert.equal(assertSettingsPatch({ selectionToolbar: { conversation: { maxFollowUpTurns: 5 } } }, template)
    .selectionToolbar.conversation.maxFollowUpTurns, 5)
  assert.equal(assertSettingsPatch({ selectionToolbar: { conversation: { persist: true } } }, template)
    .selectionToolbar.conversation.persist, true)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { conversation: { persist: 'yes' } } }, template), /类型无效/)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { conversation: { unknown: 1 } } }, template), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { conversation: { enabled: 'yes' } } }, template), /类型无效/)
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { conversation: { maxFollowUpTurns: '5' } } }, template), /类型无效/)
  // This is the shape a dotted data-switch would produce: a boolean where the
  // template holds an object. The settings page must not write it.
  assert.throws(() => assertSettingsPatch({ selectionToolbar: { conversation: false } }, template), /必须是对象/)
})

test('rejects an accelerator that could never register while keeping clearing legal', () => {
  const shortcutsTemplate = { ...template, shortcuts: { screenshot: '', chatSelectText: '', localSearch: '' } }
  assert.equal(assertSettingsPatch({ shortcuts: { screenshot: 'Ctrl+1' } }, shortcutsTemplate).shortcuts.screenshot, 'Ctrl+1')
  // Clearing a shortcut is a right-click action, so an empty value stays legal.
  assert.equal(assertSettingsPatch({ shortcuts: { chatSelectText: '' } }, shortcutsTemplate).shortcuts.chatSelectText, '')
  // "Process" is what an input method reports for the key that starts a
  // composition; it reached the store once and made every start log
  // `Shortcut registration failed: Process ...`.
  assert.throws(() => assertSettingsPatch({ shortcuts: { chatSelectText: 'Process' } }, shortcutsTemplate), /快捷键格式无效/)
  assert.throws(() => assertSettingsPatch({ shortcuts: { localSearch: 'Ctrl+' } }, shortcutsTemplate), /快捷键格式无效/)
  // Validation checks syntax only; canonicalising case/order is the migration's job.
  assert.equal(assertSettingsPatch({ shortcuts: { localSearch: 'alt+f' } }, shortcutsTemplate).shortcuts.localSearch, 'alt+f')
})
