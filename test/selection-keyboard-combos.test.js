'use strict'

// DEV-04 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
//   The recording HUD captured shortcut combos only while its own control bar had
//   keyboard focus. The native selection hook already installs a WH_KEYBOARD_LL hook, so
//   the addon now exposes a bounded, explicitly opt-in "key-combo" channel for the
//   recording host to consume only while a take is recording.
//
// This file pins that contract without a GUI session:
//   A. native combo policy (pure function through the addon's deterministic self-test
//      bridge): only modifier chords / bare F-keys are accepted, and every accepted label
//      matches the persisted events.json `keystrokes` grammar;
//   B. the JavaScript wrapper: events are gated behind the opt-in API, payloads are
//      re-validated, disabling is exact (already-queued events are dropped), and
//      stop()/cleanup() clear the flag;
//   C. source contracts for the parts node cannot drive: injected/auto-repeat/AltGr
//      filtering, one descriptor per physical press, and the channel's independence from
//      the legacy keyboard events and the mouse hook.
//
// Note: synthetic OS input always carries LLKHF_INJECTED and is rejected by design, so
// real hardware keystrokes and the real VS Code/Cursor/Windows Terminal matrix remain a
// manual/real-device step (documented in the delivery report, not claimed here).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const ADDON_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'build', 'Release', 'selection-hook.node')
const WRAPPER_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'index.js')
const HOOK_CC_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'src', 'windows', 'selection_hook.cc')
const COMBO_HEADER_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'src', 'windows', 'core', 'keyboard_combo.h')
const PROJECT_SERVICE_PATH = path.join(ROOT, 'main', 'services', 'recording-project-service.js')

// Persistence-side grammar, restated independently of the native implementation so a
// drifted native label fails here instead of at playback time.
const NAMED_KEY =
  'Space|Esc|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|(?:F(?:[1-9]|1[0-2]))'
const CHORD_PATTERN = new RegExp(`^(?:(?:Ctrl|Alt|Shift|Win)\\+){1,4}(?:[A-Z0-9]|${NAMED_KEY})$`)
const SINGLE_PATTERN = new RegExp(`^(?:${NAMED_KEY})$`)

// Modifier bits emitted by the native hook.
const SHIFT = 1
const CTRL = 2
const ALT = 4
const WIN = 8

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing source marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1
  return source.slice(start, end > start ? end : undefined)
}

// Objects created inside the wrapper VM realm have that realm's prototypes; compare
// plain data, never reference identity.
const plain = (value) => JSON.parse(JSON.stringify(value))

function loadNativeAddon() {
  if (process.platform !== 'win32' || !fs.existsSync(ADDON_PATH)) return null
  return require(ADDON_PATH)
}

const addon = loadNativeAddon()

function classifyCombo(evidence) {
  assert.ok(addon && typeof addon.__testClassifyKeyboardCombo === 'function',
    'the rebuilt addon exposes the deterministic combo policy self-test')
  return addon.__testClassifyKeyboardCombo(evidence)
}

// ---------------------------------------------------------------------------
// A. Native combo policy: allow-list, rejection reasons, persisted grammar.
// ---------------------------------------------------------------------------

test('DEV-04 native combo policy accepts modifier chords and bare function keys', { skip: !addon }, () => {
  const accepted = [
    [{ vkCode: 0x43, modifiers: CTRL }, 'Ctrl+C'],
    [{ vkCode: 0x50, modifiers: CTRL | SHIFT }, 'Ctrl+Shift+P'],
    [{ vkCode: 0x53, modifiers: CTRL }, 'Ctrl+S'],
    [{ vkCode: 0x41, modifiers: ALT }, 'Alt+A'],
    [{ vkCode: 0x44, modifiers: WIN }, 'Win+D'],
    [{ vkCode: 0x31, modifiers: CTRL }, 'Ctrl+1'],
    [{ vkCode: 0x74 }, 'F5'],
    [{ vkCode: 0x7a }, 'F11'],
    [{ vkCode: 0x7b }, 'F12'],
    [{ vkCode: 0x74, modifiers: SHIFT }, 'Shift+F5'],
    [{ vkCode: 0x09, modifiers: CTRL }, 'Ctrl+Tab'],
    [{ vkCode: 0x0d, modifiers: SHIFT }, 'Shift+Enter'],
    [{ vkCode: 0x1b, modifiers: CTRL }, 'Ctrl+Esc'],
    [{ vkCode: 0x20, modifiers: CTRL }, 'Ctrl+Space'],
    [{ vkCode: 0x25, modifiers: CTRL }, 'Ctrl+Left']
  ]
  for (const [evidence, label] of accepted) {
    const decision = classifyCombo(evidence)
    assert.equal(decision.accepted, true, `expected ${JSON.stringify(evidence)} to be accepted`)
    assert.equal(decision.combo, label)
    assert.equal(decision.reason, 'accepted')
    // The label must be persistable byte-for-byte by main/services/recording-project-service.js.
    assert.ok(CHORD_PATTERN.test(label) || SINGLE_PATTERN.test(label),
      `${label} must match the persisted keystrokes grammar`)
  }
})

test('DEV-04 modifier bitmask drives the label order Ctrl+Alt+Shift+Win', { skip: !addon }, () => {
  const decision = classifyCombo({ vkCode: 0x50, modifiers: CTRL | ALT | SHIFT | WIN })
  assert.equal(decision.accepted, true)
  assert.equal(decision.combo, 'Ctrl+Alt+Shift+Win+P',
    'the order matches record/record.js so the control-bar and native paths agree')
})

test('DEV-04 plain typing, Shift+character and non-representable keys never produce a label', { skip: !addon }, () => {
  const rejected = [
    [{ vkCode: 0x41 }, 'plain_text_input'], // plain letter
    [{ vkCode: 0x41, modifiers: SHIFT }, 'plain_text_input'], // capital letter = typed text
    [{ vkCode: 0x31, modifiers: SHIFT }, 'plain_text_input'], // "!" typed via Shift+1
    [{ vkCode: 0x1b }, 'bare_named_key'], // bare navigation/editing key
    [{ vkCode: 0xba, modifiers: CTRL }, 'key_not_allowlisted'], // punctuation cannot be persisted
    [{ vkCode: 0xac, modifiers: CTRL }, 'key_not_allowlisted'], // browser key
    [{ vkCode: 0x84, modifiers: CTRL }, 'key_not_allowlisted'], // F25+ / media-range key
    [{ vkCode: 0x11, modifiers: CTRL }, 'modifier_key'], // Ctrl itself
    [{ vkCode: 0x5b, modifiers: WIN }, 'modifier_key'], // Win itself
    [{ vkCode: 0xe5, modifiers: CTRL }, 'ime_process_key'], // VK_PROCESSKEY
    [{ vkCode: 0x43, modifiers: CTRL, injected: true }, 'injected_input'],
    [{ vkCode: 0x43, modifiers: CTRL, autoRepeat: true }, 'auto_repeat'],
    [{ vkCode: 0x51, modifiers: CTRL | ALT, altGraph: true }, 'altgraph_text_input']
  ]
  for (const [evidence, reason] of rejected) {
    const decision = classifyCombo(evidence)
    assert.equal(decision.accepted, false, `expected ${JSON.stringify(evidence)} to be rejected`)
    assert.equal(decision.combo, '')
    assert.equal(decision.reason, reason)
  }
})

test('DEV-04 the persistence service still enforces the same combo grammar', () => {
  const source = fs.readFileSync(PROJECT_SERVICE_PATH, 'utf8')
  assert.match(source, /KEYSTROKE_CHORD_PATTERN/)
  assert.match(source, /KEYSTROKE_SINGLE_PATTERN/)
  // The native label grammar and this persistence grammar are the two ends of the same
  // contract; the native test above asserts every emitted label matches this grammar.
  assert.match(source, /const KEYSTROKE_NAMED_KEY =/)
})

// ---------------------------------------------------------------------------
// B. JavaScript wrapper: opt-in gating, payload re-validation, exact disable.
// ---------------------------------------------------------------------------

function createWrapperHarness() {
  const instances = []
  class FakeNativeHook {
    constructor() {
      this.calls = []
      this.callback = null
      this.keyboardEnabled = false
      this.clipboardGuardDiagnostics = {
        allowDefault: 0,
        allowEditorEditControl: 0,
        skipTerminalProgram: 0,
        skipTerminalTarget: 0,
        skipEditorHostAmbiguous: 0,
        skipFocusChanged: 0
      }
      instances.push(this)
    }
    start(callback) { this.calls.push(['start']); this.callback = callback }
    // The real native stop() clears the opt-in flag; mirror that so the harness keeps the
    // fail-closed contract explicit.
    stop() { this.calls.push(['stop']); this.keyboardEnabled = false }
    isRunning() { return true }
    // Config methods used by SelectionHook#initByConfig / start({ ... }).
    enableMouseMoveEvent() {}
    disableMouseMoveEvent() {}
    enableClipboard() {}
    disableClipboard() {}
    setSelectionPassiveMode() {}
    setClipboardMode() {}
    setGlobalFilterMode() {}
    setFineTunedList() {}
    setKeyboardEventsEnabled(enabled) {
      this.calls.push(['setKeyboardEventsEnabled', enabled])
      this.keyboardEnabled = enabled === true
    }
    isKeyboardEventsEnabled() { return this.keyboardEnabled }
    getClipboardCopyGuardDiagnostics() { return { ...this.clipboardGuardDiagnostics } }
    emitNative(data) {
      assert.ok(this.callback, 'wrapper started the native hook')
      this.callback(data)
    }
  }
  const fakeModule = { TextSelectionHook: FakeNativeHook }

  const sandbox = {
    require: (name) => {
      if (name === 'events') return require('events')
      if (name === 'path') return path
      if (name === 'node-gyp-build') return () => fakeModule
      throw new Error(`unexpected require: ${name}`)
    },
    module: { exports: {} },
    exports: {},
    __dirname: path.join(ROOT, 'vendor', 'selection-hook'),
    process: { platform: 'win32', versions: process.versions },
    console
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(fs.readFileSync(WRAPPER_PATH, 'utf8'), sandbox, { filename: WRAPPER_PATH })
  const SelectionHook = sandbox.module.exports
  assert.equal(typeof SelectionHook, 'function')
  return {
    SelectionHook,
    last: () => instances.at(-1),
    instances
  }
}

const VALID_COMBO = Object.freeze({
  type: 'keyboard-combo',
  tMs: 1764300000000,
  vkCode: 80,
  scanCode: 25,
  modifiers: CTRL | SHIFT,
  combo: 'Ctrl+Shift+P'
})

test('DEV-04 wrapper emits nothing while the channel is off and exactly the descriptor once enabled', () => {
  const { SelectionHook, last } = createWrapperHarness()
  const hook = new SelectionHook()
  const received = []
  hook.on('key-combo', (payload) => received.push(payload))
  assert.equal(hook.start({ debug: false, enableClipboard: false }), true)
  const native = last()

  native.emitNative(VALID_COMBO)
  assert.deepEqual(received, [], 'the channel is off by default and opt-in is explicit')

  assert.equal(hook.isKeyboardEventsEnabled(), false)
  assert.equal(hook.setKeyboardEventsEnabled(true), true)
  assert.equal(hook.isKeyboardEventsEnabled(), true)
  native.emitNative(VALID_COMBO)
  assert.deepEqual(plain(received), [{
    tMs: 1764300000000,
    vkCode: 80,
    scanCode: 25,
    modifiers: CTRL | SHIFT,
    combo: 'Ctrl+Shift+P'
  }], 'only the bounded descriptor fields are forwarded, never text')

  // Payload re-validation: a malformed label or a non-numeric timestamp is dropped.
  native.emitNative({ ...VALID_COMBO, combo: 'hello world' })
  native.emitNative({ ...VALID_COMBO, combo: 'a' })
  native.emitNative({ ...VALID_COMBO, tMs: 'soon' })
  native.emitNative({ ...VALID_COMBO, vkCode: 99999 })
  native.emitNative({ ...VALID_COMBO, modifiers: 0xff })
  assert.equal(received.length, 1, 'bounded/validated payloads only')
  hook.cleanup()
})

test('DEV-04 disabling is exact: an in-flight native event is dropped, never delivered late', () => {
  const { SelectionHook, last } = createWrapperHarness()
  const hook = new SelectionHook()
  const received = []
  hook.on('key-combo', (payload) => received.push(payload))
  hook.start({ debug: false, enableClipboard: false })
  hook.setKeyboardEventsEnabled(true)
  const native = last()
  native.emitNative(VALID_COMBO)
  assert.equal(received.length, 1)

  assert.equal(hook.setKeyboardEventsEnabled(false), true)
  // Simulate a native event that was already queued before the opt-out returned.
  native.emitNative(VALID_COMBO)
  assert.equal(received.length, 1, 'queued events are dropped at dispatch after disable')
  assert.equal(hook.isKeyboardEventsEnabled(), false)
  hook.cleanup()
})

test('DEV-04 opt-in survives start() but is cleared by stop()/cleanup()/restart', () => {
  const { SelectionHook, last } = createWrapperHarness()
  const hook = new SelectionHook()
  hook.setKeyboardEventsEnabled(true) // allowed before start, like the other config methods
  hook.start({ debug: false, enableClipboard: false })
  assert.equal(hook.isKeyboardEventsEnabled(), true)
  hook.stop()
  assert.equal(hook.isKeyboardEventsEnabled(), false, 'stop() clears the channel (fail closed)')
  hook.start({ debug: false, enableClipboard: false })
  assert.equal(hook.isKeyboardEventsEnabled(), false, 'a restarted session must opt in again')
  assert.equal(last().keyboardEnabled, false, 'the native instance flag is cleared too')
  hook.setKeyboardEventsEnabled(true)
  hook.cleanup()
  assert.equal(hook.isKeyboardEventsEnabled(), false, 'cleanup() also clears the channel')
})

test('DEV-04 invalid arguments fail closed and never enable the channel', () => {
  const { SelectionHook, last } = createWrapperHarness()
  const hook = new SelectionHook()
  hook.start({ debug: false, enableClipboard: false })
  for (const value of [undefined, null, 1, 'true', {}]) {
    assert.equal(hook.setKeyboardEventsEnabled(value), false)
    assert.equal(hook.isKeyboardEventsEnabled(), false)
  }
  assert.deepEqual(last().calls.filter((call) => call[0] === 'setKeyboardEventsEnabled'), [],
    'invalid input never reaches the native setter')
  hook.cleanup()
})

test('DEV-04 enabling the combo channel does not gate legacy keyboard or mouse events', () => {
  const { SelectionHook, last } = createWrapperHarness()
  const hook = new SelectionHook()
  const legacyKeys = []
  const mouse = []
  hook.on('key-down', (data) => legacyKeys.push(data))
  hook.on('mouse-up', (data) => mouse.push(data))
  hook.start({ debug: false, enableClipboard: false })
  const native = last()
  hook.setKeyboardEventsEnabled(true)

  native.emitNative({ type: 'keyboard-event', action: 'key-down', uniKey: 'a', vkCode: 65, sys: false, scanCode: 30, flags: 0 })
  native.emitNative({ type: 'mouse-event', action: 'mouse-up', x: 10, y: 20, button: 0 })
  assert.deepEqual(plain(legacyKeys), [{ uniKey: 'a', vkCode: 65, sys: false, scanCode: 30, flags: 0 }])
  assert.deepEqual(plain(mouse), [{ x: 10, y: 20, button: 0 }])
  hook.cleanup()
})

// ---------------------------------------------------------------------------
// C. Source contracts for the hooks node cannot drive.
// ---------------------------------------------------------------------------

test('DEV-04 the keyboard hook gates the combo channel before allocating, and filters injected input', () => {
  const source = fs.readFileSync(HOOK_CC_PATH, 'utf8')
  assert.match(source, /std::atomic<bool> keyboard_events_enabled\{false\};/,
    'the channel is disabled by default')
  assert.match(source, /setKeyboardEventsEnabled/)
  assert.match(source, /isKeyboardEventsEnabled/)
  assert.match(source, /keyboard-combo/)

  const callback = sliceBetween(
    source,
    'LRESULT CALLBACK SelectionHook::KeyboardHookCallback',
    'void SelectionHook::EnableDpiAwareness'
  )
  const gateAt = callback.indexOf('keyboard_events_enabled.load(std::memory_order_acquire)')
  const observeAt = callback.indexOf('highlighter::ObserveInput')
  const enqueueAt = callback.indexOf('EnqueueKeyboardCombo')
  assert.ok(observeAt >= 0, 'real input observation is unconditional (clipboard guardrail)')
  assert.ok(gateAt > observeAt, 'the opt-in gate is evaluated after the unconditional input observation')
  assert.ok(enqueueAt > gateAt, 'no combo event object is built while the channel is disabled')
  assert.ok(gateAt < callback.indexOf('new KeyboardEventContext'), 'the gate precedes allocation')

  const enqueue = sliceBetween(source, 'void SelectionHook::EnqueueKeyboardCombo', 'void SelectionHook::ProcessKeyboardEvent')
  assert.match(enqueue, /LLKHF_INJECTED/, 'synthesized input (including our own fallback keys) is filtered')
  assert.match(enqueue, /ClassifyKeyboardCombo/, 'the shared bounded policy decides acceptance')
  assert.doesNotMatch(enqueue, /convertKeyCodeToUniKey/,
    'the combo channel never converts a key to a character/uniKey')
  assert.match(enqueue, /autoRepeat/, 'OS auto-repeat is suppressed to one descriptor per press')
  assert.match(enqueue, /CurrentEpochMilliseconds/, 'the event-time stamp is sampled in the hook')
})

test('DEV-04 the native combo object carries only the bounded descriptor', () => {
  const source = fs.readFileSync(HOOK_CC_PATH, 'utf8')
  const processKeyboard = sliceBetween(
    source,
    'void SelectionHook::ProcessKeyboardEvent',
    'bool SelectionHook::GetSelectedText'
  )
  const comboBranch = sliceBetween(
    processKeyboard,
    'if (pKeyboardEvent->combo)',
    'if (!currentInstance->ShouldProcessGetSelection())'
  )
  assert.match(comboBranch, /"keyboard-combo"/)
  for (const field of ['"tMs"', '"vkCode"', '"scanCode"', '"modifiers"', '"combo"']) {
    assert.ok(comboBranch.includes(field), `combo payload exposes ${field}`)
  }
  assert.doesNotMatch(comboBranch, /"uniKey"|"text"|"title"/,
    'the combo payload deliberately has no character/text/title fields')
  assert.match(comboBranch, /keyboard_events_enabled\.load\(std::memory_order_acquire\)/,
    'disable() drops already-queued combo events at dispatch')

  const header = fs.readFileSync(COMBO_HEADER_PATH, 'utf8')
  assert.match(header, /plain typing must never leave the process|never a typed/i)
  assert.match(header, /VK_PROCESSKEY/)
  assert.match(header, /injected/)
  assert.match(header, /autoRepeat/)
})

test('DEV-04 stop/dispose clears the native flag and the mouse hook is untouched', () => {
  const source = fs.readFileSync(HOOK_CC_PATH, 'utf8')
  const stopBody = sliceBetween(source, 'void SelectionHook::Stop(const Napi::CallbackInfo &info)', 'Napi::Value SelectionHook::GetCurrentSelection')
  assert.match(stopBody, /keyboard_events_enabled\.store\(false, std::memory_order_release\)/,
    'stop() clears the channel before the hook thread is joined')
  const cleanupHookBody = sliceBetween(source, 'void SelectionHook::EnvironmentCleanupHook(void *data)', 'Napi::Object SelectionHook::Init')
  assert.match(cleanupHookBody, /keyboard_events_enabled\.store\(false, std::memory_order_release\)/,
    'environment teardown clears the channel')
  const destructorBody = sliceBetween(source, 'SelectionHook::~SelectionHook()', 'void SelectionHook::RegisterEnvironmentCleanupHook')
  assert.match(destructorBody, /keyboard_events_enabled\.store\(false, std::memory_order_release\)/,
    'destruction clears the channel')

  // The pointer-hook host shares this addon; the mouse callback must not depend on the
  // keyboard opt-in in any way.
  const mouseCallback = sliceBetween(
    source,
    'LRESULT CALLBACK SelectionHook::MouseHookCallback',
    'LRESULT CALLBACK SelectionHook::KeyboardHookCallback'
  )
  assert.doesNotMatch(mouseCallback, /keyboard_events_enabled/,
    'enabling the combo channel cannot change mouse-selection behavior')
})

test('DEV-04 the JavaScript wrapper keeps the opt-in and validation contract', () => {
  const source = fs.readFileSync(WRAPPER_PATH, 'utf8')
  assert.match(source, /#keyboardEventsEnabled = false;/)
  assert.match(source, /setKeyboardEventsEnabled\(enabled\)/)
  assert.match(source, /isKeyboardEventsEnabled\(\)/)
  assert.match(source, /KEY_COMBO_PATTERN/)
  assert.match(source, /this\.emit\("key-combo"/)
  const stopBody = sliceBetween(source, 'stop() {', 'getCurrentSelection()')
  assert.match(stopBody, /#keyboardEventsEnabled = false;/,
    'the wrapper clears the channel on stop()')
  const cleanupBody = sliceBetween(source, 'cleanup() {', '#getDefaultConfig()')
  assert.match(cleanupBody, /#keyboardEventsEnabled = false;/,
    'the wrapper clears the channel on cleanup()')
})

// ---------------------------------------------------------------------------
// D. Real rebuilt addon lifecycle (no synthetic keystrokes: those are rejected by design).
// ---------------------------------------------------------------------------

test('DEV-04 rebuilt native addon exposes the opt-in channel and clears it on stop/restart', { skip: process.platform !== 'win32' }, () => {
  const SelectionHook = require('selection-hook')
  assert.equal(typeof SelectionHook.prototype.setKeyboardEventsEnabled, 'function')
  assert.equal(typeof SelectionHook.prototype.isKeyboardEventsEnabled, 'function')

  const hook = new SelectionHook()
  try {
    assert.equal(hook.isKeyboardEventsEnabled(), false, 'disabled by default')
    assert.equal(hook.start({ debug: false, enableClipboard: false }), true)
    assert.equal(hook.setKeyboardEventsEnabled(true), true)
    assert.equal(hook.isKeyboardEventsEnabled(), true)
    hook.stop()
    assert.equal(hook.isKeyboardEventsEnabled(), false, 'stop() clears the flag on the real addon')
    assert.equal(hook.start({ debug: false, enableClipboard: false }), true)
    assert.equal(hook.isKeyboardEventsEnabled(), false, 'restart requires a new explicit opt-in')
    assert.equal(hook.setKeyboardEventsEnabled(false), true)
  } finally {
    hook.cleanup()
  }
})
