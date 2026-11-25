const test = require('node:test')
const assert = require('node:assert/strict')
const { createShortcutDomain } = require('../main/domains/shortcuts')
const { t, registerLocales } = require('../main/services/i18n-bootstrap')

registerLocales()

function createService(outcome = { ok: true, statuses: {} }) {
  const calls = []
  return {
    calls,
    sync(shortcuts) { calls.push(['sync', shortcuts]); return outcome },
    // A03 (09): the recovery path attempts each key individually.
    registerAll(shortcuts) { calls.push(['registerAll', shortcuts]); return outcome },
    suspendAll(shortcuts, reason) { calls.push(['suspend', reason]); return { suspended: true } }
  }
}

function createDomain({ service, gameMode = false, shortcuts = { screenshot: 'F1', screenshotOcr: '' } }) {
  const settings = { shortcuts }
  return createShortcutDomain({
    shortcutService: service,
    getSettings: () => settings,
    isGameModeEnabled: () => gameMode,
    t
  })
}

test('A03: a successful rebind returns an undo that restores the previous map', () => {
  const service = createService({ ok: true, statuses: {} })
  const domain = createDomain({ service })
  const undo = domain.preparePatch({ shortcuts: { screenshot: 'F2' } })
  assert.equal(typeof undo, 'function')
  assert.deepEqual(service.calls[0], ['sync', { screenshot: 'F2', screenshotOcr: '' }])
  undo()
  assert.deepEqual(service.calls[1], ['sync', { screenshot: 'F1', screenshotOcr: '' }])
})

test('A03: a rejected combination throws with the reason and the still-working key', () => {
  const service = createService({ ok: false, failed: { name: 'screenshot', accelerator: 'F2', reason: 'unavailable' } })
  const domain = createDomain({ service })
  assert.throws(
    () => domain.preparePatch({ shortcuts: { screenshot: 'F2' } }),
    (error) => {
      assert.equal(error.code, 'shortcut-unavailable')
      assert.match(error.message, /F2/)
      assert.match(error.message, /F1/)
      assert.equal(error.message, t('main.shortcut.rebind-failed', { accelerator: 'F2', reason: t('main.shortcut.unavailable'), previous: 'F1' }))
      return true
    }
  )
})

test('A03: a rejected FIRST binding says nothing was changed', () => {
  const service = createService({ ok: false, failed: { name: 'openClipboardHistory', accelerator: 'F9', reason: 'unavailable' } })
  const domain = createDomain({ service, shortcuts: { screenshot: 'F1' } })
  assert.throws(
    () => domain.preparePatch({ shortcuts: { openClipboardHistory: 'F9' } }),
    (error) => {
      assert.equal(error.message, t('main.shortcut.rebind-failed-empty', { accelerator: 'F9', reason: t('main.shortcut.unavailable') }))
      return true
    }
  )
})

test('A03: game mode stores the draft without touching the registry', () => {
  const service = createService()
  const domain = createDomain({ service, gameMode: true })
  assert.equal(domain.preparePatch({ shortcuts: { screenshot: 'F2' } }), null)
  assert.deepEqual(service.calls, [])
  domain.register()
  assert.deepEqual(service.calls, [['suspend', 'game-mode']])
})

test('A03: a patch without shortcuts never reaches the shortcut service', () => {
  const service = createService()
  const domain = createDomain({ service })
  assert.equal(domain.preparePatch({ theme: 'dark' }), null)
  assert.deepEqual(service.calls, [])
})

test('A03: the register path is diff-based, not unregister-all', () => {
  const service = createService()
  const domain = createDomain({ service })
  domain.register()
  // A03 (09): the register path attempts each key on its own instead of a transactional
  // sync (a single occupied key may not drag the whole set down).
  assert.deepEqual(service.calls, [['registerAll', { screenshot: 'F1', screenshotOcr: '' }]])
})
