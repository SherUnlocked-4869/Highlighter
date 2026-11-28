'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sourceBuildId } = require('../vendor/selection-hook/scripts/source-build-id')

test('selection-hook resolves to the reviewed source dependency and matching native build', async () => {
  const root = path.resolve(__dirname, '..')
  assert.equal(fs.realpathSync(path.dirname(require.resolve('selection-hook'))), fs.realpathSync(path.join(root, 'vendor', 'selection-hook')))
  const SelectionHook = require('selection-hook')
  assert.match(sourceBuildId(), /^hl_[a-f0-9]{64}$/)
  assert.equal(SelectionHook.nativeBuildId, sourceBuildId(), 'Rebuild the addon after native/source configuration changes')
  for (const pid of [0, -1, 0xffffffff, 1.5, NaN, Infinity, '123', null]) assert.equal(SelectionHook.allowSetForegroundWindow(pid), false)
  const hook = new SelectionHook()
  assert.equal(hook.isRunning(), false)
  assert.equal(hook.getClipboardCoordinatorDiagnostics().required, false)
  assert.equal(await hook.checkClipboardCoordinator(), false)
  assert.throws(() => hook.setClipboardCoordinator({}), /Invalid private clipboard coordinator/)
  assert.equal(hook.getClipboardCoordinatorDiagnostics().required, true)
  assert.equal(await hook.checkClipboardCoordinator(), false)
  hook.setClipboardCoordinator(null)
  assert.equal(hook.getClipboardCoordinatorDiagnostics().required, false)

  // DEV-04 native half: the bounded keyboard shortcut-combo channel is an explicit
  // opt-in, disabled by default, and readable back through the same instance.
  assert.equal(typeof hook.setKeyboardEventsEnabled, 'function')
  assert.equal(typeof hook.isKeyboardEventsEnabled, 'function')
  assert.equal(hook.isKeyboardEventsEnabled(), false, 'the keyboard combo channel defaults to off')
  assert.equal(hook.setKeyboardEventsEnabled(true), true)
  assert.equal(hook.isKeyboardEventsEnabled(), true)
  assert.equal(hook.setKeyboardEventsEnabled(false), true)
  assert.equal(hook.isKeyboardEventsEnabled(), false)
  assert.equal(hook.setKeyboardEventsEnabled('yes'), false, 'invalid opt-in input fails closed')
  assert.equal(hook.isKeyboardEventsEnabled(), false)

  // DEV-10: clipboard-copy guard counters are numeric reason counters only.
  assert.equal(typeof hook.getClipboardCopyGuardDiagnostics, 'function')
  const guardDiagnostics = hook.getClipboardCopyGuardDiagnostics()
  assert.deepEqual(Object.keys(guardDiagnostics).sort(), [
    'allowDefault', 'allowEditorEditControl', 'skipEditorHostAmbiguous',
    'skipFocusChanged', 'skipTerminalProgram', 'skipTerminalTarget'
  ])
  assert.ok(Object.values(guardDiagnostics).every((value) => typeof value === 'number' && value >= 0))
  hook.cleanup()
})
