const test = require('node:test')
const assert = require('node:assert/strict')

const {
  acceleratorFromKeyboardEvent,
  describeShortcutRejection,
  isIgnoredRecordingEvent,
  isIgnoredRecordingKey,
  isModifierOnlyKey,
  isRecordableShortcut,
  isSupportedKey,
  isValidAccelerator,
  normalizeAccelerator,
  parseAccelerator
} = require('../shared/shortcut-keys')

test('input-method and unnamed keys are never recorded', () => {
  for (const key of ['Process', 'Unidentified', 'Dead', 'Compose', 'Convert', 'NonConvert', 'KanaMode', 'KanjiMode']) {
    assert.equal(isIgnoredRecordingKey(key), true, `${key} is ignored`)
    assert.equal(acceleratorFromKeyboardEvent({ key }), '', `${key} records nothing`)
  }
  // The physical key that starts an IME composition reports keyCode 229 with
  // isComposing set; it must neither record nor close the recorder.
  assert.equal(isIgnoredRecordingEvent({ key: 'a', isComposing: true }), true)
  assert.equal(isIgnoredRecordingEvent({ key: 'a', keyCode: 229 }), true)
  assert.equal(isIgnoredRecordingEvent({ key: 'a', code: 'KeyA' }), false)
  assert.equal(isIgnoredRecordingKey('a'), false)
})

test('modifier-only keys are skipped instead of becoming a key', () => {
  for (const key of ['Control', 'ControlLeft', 'ControlRight', 'Shift', 'ShiftLeft', 'Alt', 'AltRight', 'Meta', 'MetaLeft', 'AltGraph', 'OS']) {
    assert.equal(isModifierOnlyKey(key), true, `${key} is a modifier`)
    assert.equal(acceleratorFromKeyboardEvent({ key, ctrlKey: true }), '', `${key} records nothing`)
  }
  assert.equal(isModifierOnlyKey('A'), false)
  assert.equal(isModifierOnlyKey('F1'), false)
})

test('DOM key names are mapped to accelerator key names', () => {
  const cases = [
    [{ key: 'a', code: 'KeyA', ctrlKey: true }, 'Ctrl+A'],
    [{ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true }, 'Ctrl+Up'],
    [{ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }, 'Alt+Left'],
    [{ key: ' ', code: 'Space', ctrlKey: true }, 'Ctrl+Space'],
    [{ key: '+', code: 'Equal', ctrlKey: true }, 'Ctrl+Plus'],
    [{ key: 'Escape', code: 'Escape' }, 'Escape'],
    [{ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }, 'Ctrl+Shift+Enter'],
    [{ key: 'PageDown', code: 'PageDown' }, 'PageDown'],
    [{ key: 'CapsLock', code: 'CapsLock' }, 'Capslock'],
    [{ key: 'AudioVolumeUp', code: 'AudioVolumeUp' }, 'VolumeUp'],
    [{ key: '1', code: 'Numpad1' }, 'num1'],
    [{ key: 'Add', code: 'NumpadAdd', ctrlKey: true }, 'Ctrl+numadd'],
    [{ key: 'Unidentified', code: 'NumpadEnter' }, '']
  ]
  for (const [event, expected] of cases) {
    assert.equal(acceleratorFromKeyboardEvent(event), expected, `${JSON.stringify(event)} -> ${expected}`)
  }
})

test('recording keeps the canonical modifier order and is idempotent', () => {
  assert.equal(acceleratorFromKeyboardEvent({ key: 'q', code: 'KeyQ', metaKey: true, altKey: true, shiftKey: true, ctrlKey: true }), 'Ctrl+Alt+Shift+Super+Q')
  assert.equal(normalizeAccelerator('ctrl + alt+E'), 'Ctrl+Alt+E')
  assert.equal(normalizeAccelerator('ALT+f'), 'Alt+F')
  assert.equal(normalizeAccelerator('shift+ctrl+1'), 'Ctrl+Shift+1')
  assert.equal(normalizeAccelerator('cmd+q'), 'Super+Q')
  assert.equal(normalizeAccelerator('f1'), 'F1')
  assert.equal(normalizeAccelerator('enter'), 'Enter')
  for (const value of ['Ctrl+Alt+E', 'Alt+F', 'F1', 'Ctrl+1', 'Ctrl+Space', 'Ctrl+Plus']) {
    assert.equal(normalizeAccelerator(normalizeAccelerator(value)), normalizeAccelerator(value), `${value} is idempotent`)
  }
})

test('accelerator syntax validation accepts what Electron accepts and rejects the rest', () => {
  for (const value of ['Ctrl+1', 'Alt+F', 'F1', 'F24', 'Super+Space', 'Ctrl+Alt+E', 'Ctrl+Plus', 'num1', 'Ctrl+Shift+1', 'PrintScreen', 'VolumeUp', 'Ctrl+Up', 'Ctrl+;']) {
    assert.equal(isValidAccelerator(value), true, `${value} is valid`)
  }
  for (const value of ['Process', '', '   ', 'Ctrl+', '+', 'Foo', 'Ctrl+Bar', 'Alt+Ctrl+Shift']) {
    assert.equal(isValidAccelerator(value), false, `${JSON.stringify(value)} is invalid`)
  }
  assert.equal(isValidAccelerator('Ctrl+A+B'), false, 'only one main key')
  assert.equal(parseAccelerator('Ctrl+A+B').reason, 'multiple-keys')
  assert.equal(parseAccelerator('Ctrl+').reason, 'no-key')
  assert.equal(parseAccelerator('Foo').reason, 'unsupported-key')
  assert.equal(isSupportedKey('Plus'), true)
  assert.equal(isSupportedKey('AnyKey'), false)
})

test('recording policy keeps bare keys that are safe and rejects printable ones', () => {
  for (const value of ['Ctrl+A', 'Alt+F', 'Ctrl+Shift+1', 'F1', 'F24', 'PrintScreen', 'VolumeUp', 'MediaPlayPause', 'Ctrl+Alt+E']) {
    assert.equal(isRecordableShortcut(value), true, `${value} is recordable`)
  }
  for (const value of ['A', '1', ';', 'Process', 'Foo', '']) {
    assert.equal(isRecordableShortcut(value), false, `${JSON.stringify(value)} is not recordable`)
  }
})

test('rejections carry a Chinese reason the recorder can toast', () => {
  assert.match(describeShortcutRejection('Process'), /输入法/)
  assert.match(describeShortcutRejection('A'), /Ctrl/)
  assert.match(describeShortcutRejection('Foo'), /不支持/)
  assert.match(describeShortcutRejection(''), /组合键/)
  assert.match(describeShortcutRejection('Ctrl+A+B'), /一个主键/)
})

test('the shipped default shortcuts stay valid and recordable', () => {
  const defaults = ['F1', 'Alt+F', 'Ctrl+Alt+E', 'Ctrl+1']
  for (const value of defaults) {
    assert.equal(isValidAccelerator(value), true, `${value} stays valid`)
    assert.equal(isRecordableShortcut(value), true, `${value} stays recordable`)
    assert.equal(normalizeAccelerator(value), value, `${value} needs no rewrite`)
  }
})
