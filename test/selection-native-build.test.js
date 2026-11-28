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

  // P1-02: the trusted focus classification bridges. The combo bridge now combines the key
  // policy with the focus policy, and the pure focus probe plus the bounded runtime foreground
  // probe must be present in the rebuilt addon.
  const addon = require(path.join(root, 'vendor', 'selection-hook', 'build', 'Release', 'selection-hook.node'))
  assert.equal(typeof addon.__testClassifyKeyboardCombo, 'function')
  assert.equal(typeof addon.__testClassifyKeyboardFocus, 'function')
  assert.equal(typeof addon.__testClassifyFocusedContext, 'function')
  const safeCombo = addon.__testClassifyKeyboardCombo({ vkCode: 0x53, modifiers: 2, focus: 'safe' })
  assert.equal(safeCombo.accepted, true)
  assert.equal(safeCombo.combo, 'Ctrl+S')
  assert.equal(safeCombo.context, 'safe')
  const passwordCombo = addon.__testClassifyKeyboardCombo({ vkCode: 0x53, modifiers: 2, focus: 'password' })
  assert.equal(passwordCombo.accepted, false, 'a password focus never emits a combo')
  assert.equal(passwordCombo.context, 'password')
  assert.equal(addon.__testClassifyKeyboardFocus({
    foregroundAlive: true,
    foregroundIsCurrent: true,
    elementAvailable: true,
    isPassword: true
  }).classification, 'password')
  assert.equal(addon.__testClassifyKeyboardFocus({}).classification, 'unknown', 'missing evidence fails closed')
  const foreground = addon.__testClassifyFocusedContext()
  assert.equal(foreground.classifierAvailable, true, 'the bounded IUIAutomation2 client must be available')
  assert.equal(foreground.safe, foreground.classification === 'safe')

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
