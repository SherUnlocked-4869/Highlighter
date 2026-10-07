const test = require('node:test')
const assert = require('node:assert/strict')

const { migrateShortcutSettings } = require('../main/services/shortcut-migration')

test('an accelerator an input method produced is cleared once', () => {
  const messages = []
  const migration = migrateShortcutSettings({
    shortcuts: { chatSelectText: 'Process', screenshot: 'Ctrl+1', localSearch: 'Alt+F' }
  }, { log: (...args) => messages.push(args) })

  assert.equal(migration.changed, true)
  assert.deepEqual(migration.cleared, ['chatSelectText'])
  assert.equal(migration.settings.shortcuts.chatSelectText, '')
  assert.equal(migration.settings.shortcuts.screenshot, 'Ctrl+1')
  assert.equal(migration.settings.shortcuts.localSearch, 'Alt+F')
  assert.equal(messages.length, 1)
  assert.match(String(messages[0][0]), /Shortcut settings repaired/)
})

test('already-canonical shortcuts report no change so nothing is rewritten', () => {
  const settings = {
    shortcuts: {
      screenshot: 'Ctrl+1',
      screenshotDelay: '',
      localSearch: 'Alt+F',
      explainClipboard: 'Ctrl+Alt+E'
    }
  }
  const migration = migrateShortcutSettings(settings)
  assert.equal(migration.changed, false)
  assert.equal(migration.settings, settings)
  assert.deepEqual(migration.cleared, [])
  assert.deepEqual(migration.normalized, [])
})

test('surviving values are normalised without being cleared', () => {
  const migration = migrateShortcutSettings({
    shortcuts: { screenshot: 'ctrl + 1', localSearch: 'alt+f', videoRecord: 'cmd+shift+r' }
  })
  assert.equal(migration.changed, true)
  assert.deepEqual(migration.normalized, ['screenshot', 'localSearch', 'videoRecord'])
  assert.deepEqual(migration.cleared, [])
  assert.equal(migration.settings.shortcuts.screenshot, 'Ctrl+1')
  assert.equal(migration.settings.shortcuts.localSearch, 'Alt+F')
  assert.equal(migration.settings.shortcuts.videoRecord, 'Shift+Super+R')
})

test('non-string and unknown shapes are repaired without throwing', () => {
  const migration = migrateShortcutSettings({
    shortcuts: { screenshot: null, localSearch: 42, videoRecord: 'Ctrl+Alt+F9' }
  })
  assert.equal(migration.changed, true)
  assert.equal(migration.settings.shortcuts.screenshot, '')
  assert.equal(migration.settings.shortcuts.localSearch, '')
  assert.equal(migration.settings.shortcuts.videoRecord, 'Ctrl+Alt+F9')
})

test('settings without a shortcuts object are returned untouched', () => {
  for (const input of [null, undefined, {}, { shortcuts: null }, { shortcuts: [] }, 'nope']) {
    const migration = migrateShortcutSettings(input)
    assert.equal(migration.changed, false, `${JSON.stringify(input)} unchanged`)
  }
})

test('migration is idempotent', () => {
  const first = migrateShortcutSettings({ shortcuts: { chatSelectText: 'Process', screenshot: 'ctrl+1' } })
  const second = migrateShortcutSettings(first.settings)
  assert.equal(second.changed, false)
})
