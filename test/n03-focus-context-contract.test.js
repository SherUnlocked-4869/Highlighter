'use strict'

// P1-02 (docs/reviews/2026-11-28-review-optimization-follow-up-delivery-review.md section P1-02):
// trusted native focus classification for the global shortcut-combo channel.
//
// The native capture boundary classifies the event-time keyboard focus (password / text input /
// IME composition / unknown / safe) with a bounded IUIAutomation2 client and only lets a "safe"
// combo cross to JavaScript. This file pins the contract that connects the native policy, the
// JavaScript wrapper and the JS privacy filter:
//   A. wrapper: the trusted `context` field is validated and forwarded; an invalid class is
//      dropped, a missing class stays missing (and is rejected downstream, never implicitly safe);
//   B. native self-test bridges: the key policy + focus policy combination and the pure focus
//      evidence policy (including fail-closed classes), plus the runtime foreground probe shape;
//   C. source contracts: the low-level hook callback never calls UIA, the event-time snapshot is
//      cheap, the classification is bounded/fail-closed, and only the JS thread runs it.
//
// P1-3 (docs/reviews/2026-11-28-d7923ac-fix-delivery-review.md section 3): missing writability
// evidence is no longer classified safe. A present but unreadable ValuePattern/TextPattern
// read-only property, an HWND-fallback container, or a Document/Text control without read-only
// evidence are all Unknown; only a confirmed read-only surface or a confirmed non-text control is
// safe. The allowed read-only demo page stays a positive case.
//
// The real hardware keyboard matrix (demo page / text input / password input / IME composition /
// unknown focus) remains a real-device step; scripts/probe-keyboard-focus-context.js covers the
// runtime focus classification with off-screen test windows and no key presses.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const ADDON_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'build', 'Release', 'selection-hook.node')
const WRAPPER_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'index.js')
const HOOK_CC_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'src', 'windows', 'selection_hook.cc')
const FOCUS_HEADER_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'src', 'windows', 'core', 'keyboard_focus.h')
const FOCUS_SOURCE_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'src', 'windows', 'core', 'keyboard_focus.cc')
const BINDING_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'binding.gyp')

const capture = require('../main/domains/record/keystroke-capture')

function loadNativeAddon() {
  if (process.platform !== 'win32' || !fs.existsSync(ADDON_PATH)) return null
  try {
    return require(ADDON_PATH)
  } catch {
    return null
  }
}
const nativeAddon = loadNativeAddon()

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing source marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1
  return source.slice(start, end > start ? end : undefined)
}

// ---------------------------------------------------------------------------
// A. JavaScript wrapper: trusted context validation/forwarding
// ---------------------------------------------------------------------------

function createWrapperHarness() {
  const instances = []
  class FakeNativeHook {
    constructor() { instances.push(this); this.callback = null; this.keyboardEnabled = false }
    start(callback) { this.callback = callback }
    stop() { this.keyboardEnabled = false }
    isRunning() { return true }
    enableMouseMoveEvent() {}
    disableMouseMoveEvent() {}
    enableClipboard() {}
    disableClipboard() {}
    setSelectionPassiveMode() {}
    setClipboardMode() {}
    setGlobalFilterMode() {}
    setFineTunedList() {}
    setKeyboardEventsEnabled(enabled) { this.keyboardEnabled = enabled === true }
    isKeyboardEventsEnabled() { return this.keyboardEnabled }
    getClipboardCopyGuardDiagnostics() {
      return {
        allowDefault: 0,
        allowEditorEditControl: 0,
        skipTerminalProgram: 0,
        skipTerminalTarget: 0,
        skipEditorHostAmbiguous: 0,
        skipFocusChanged: 0
      }
    }
    emitNative(data) { assert.ok(this.callback, 'wrapper started the native hook'); this.callback(data) }
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
  return { SelectionHook, last: () => instances.at(-1) }
}

const plain = (value) => JSON.parse(JSON.stringify(value))
// The wrapper emits the descriptor without the native `type` discriminator; everything else is
// forwarded verbatim.
const COMBO = Object.freeze({
  tMs: 1764300000000,
  vkCode: 0x53,
  scanCode: 0x1f,
  modifiers: 2,
  combo: 'Ctrl+S'
})
const NATIVE_COMBO = Object.freeze({ type: 'keyboard-combo', ...COMBO })

function emitCombo(contextValue, includeContext = true) {
  const { SelectionHook, last } = createWrapperHarness()
  const hook = new SelectionHook()
  const received = []
  hook.on('key-combo', (payload) => received.push(payload))
  hook.start({ debug: false, enableClipboard: false })
  hook.setKeyboardEventsEnabled(true)
  const data = { ...NATIVE_COMBO }
  if (includeContext) data.context = contextValue
  last().emitNative(data)
  hook.cleanup()
  return plain(received)
}

test('P1-02 wrapper forwards the trusted focus class when the native payload carries one', () => {
  assert.deepEqual(emitCombo('safe'), [{ ...COMBO, context: 'safe' }])
  // The wrapper validates the class membership but does not re-trust it: a non-safe class is
  // forwarded so the JS privacy filter can reject it with its own reason.
  assert.deepEqual(emitCombo('password'), [{ ...COMBO, context: 'password' }])
  assert.deepEqual(emitCombo('unknown'), [{ ...COMBO, context: 'unknown' }])
})

test('P1-02 wrapper drops an invalid focus class and never invents a missing one', () => {
  for (const invalid of ['junk', '', 'SAFE', 1, null, {}]) {
    assert.deepEqual(emitCombo(invalid), [], `invalid context ${JSON.stringify(invalid)} is dropped`)
  }
  // A stale addon build without the field is forwarded unchanged; the JS filter then fails
  // closed (it never treats "no field" as safe).
  const withoutContext = emitCombo(undefined, false)
  assert.deepEqual(withoutContext, [{ ...COMBO }])
  assert.equal(capture.inspectGlobalKeystroke(withoutContext[0]).ok, false)
  assert.equal(capture.inspectGlobalKeystroke(withoutContext[0]).reason, 'missing-focus-context')
  // Forwarded non-safe classes are rejected by the JS filter with the matching reason.
  for (const context of ['password', 'text', 'ime']) {
    assert.equal(capture.inspectGlobalKeystroke({ ...COMBO, context }).ok, false, context)
    assert.equal(capture.inspectGlobalKeystroke({ ...COMBO, context }).reason, 'sensitive-focus')
  }
  assert.equal(capture.inspectGlobalKeystroke({ ...COMBO, context: 'unknown' }).reason, 'unknown-focus')
  assert.equal(capture.inspectGlobalKeystroke({ ...COMBO, context: 'safe' }).ok, true)
})

// ---------------------------------------------------------------------------
// B. Native self-test bridges (pure policy + runtime probe shape)
// ---------------------------------------------------------------------------

const evidence = (overrides) => ({
  foregroundAlive: true,
  foregroundIsCurrent: true,
  elementAvailable: true,
  focusIdentityConfirmed: true,
  ...overrides
})

function focusResult(overrides) {
  return plain(nativeAddon.__testClassifyKeyboardFocus(evidence(overrides)))
}

function assertFocus(result, expected, label) {
  assert.equal(result.classification, expected.classification, label)
  assert.equal(result.safe, expected.classification === 'safe', label)
  if (expected.reason) assert.equal(result.reason, expected.reason, label)
}

test('P1-02 native focus policy classifies every sensitive class and fails closed', { skip: !nativeAddon }, () => {
  assert.equal(typeof nativeAddon.__testClassifyKeyboardFocus, 'function')
  // A confirmed non-text control (focus identity proven, no ValuePattern/TextPattern) is the
  // only positively safe surface.
  assertFocus(focusResult({}), { classification: 'safe', reason: 'safe_focus' }, 'confirmed non-text control')
  assertFocus(focusResult({ isPassword: true }), { classification: 'password', reason: 'password_focus' }, 'password')
  assertFocus(focusResult({ imeComposing: true }), { classification: 'ime', reason: 'ime_composition' }, 'ime')
  assertFocus(focusResult({ isTextEditControl: true }), { classification: 'text', reason: 'text_edit_focus' }, 'edit')
  assertFocus(focusResult({ hasWritableValue: true }), { classification: 'text', reason: 'writable_value_focus' }, 'writable value (legacy evidence field)')
  assert.equal(focusResult({ isPassword: true, isTextEditControl: true }).classification, 'password', 'password wins over text')
  // P1-02 hardening: a UIA Document/TextPattern surface must be judged by UIA_IsReadOnlyAttributeId.
  // The browser demo page is a read-only Document (TextPattern present, IsReadOnly=TRUE) -> Safe.
  assertFocus(focusResult({ textPatternPresent: true, textPatternReadOnlyKnown: true, textPatternReadOnly: true }),
    { classification: 'safe', reason: 'read_only_focus' }, 'read-only TextPattern document')
  assertFocus(focusResult({ textPatternReadOnly: true }),
    { classification: 'safe', reason: 'read_only_focus' }, 'legacy documentReadOnly evidence field')
  // A writable TextPattern is Word/RichEdit/an editable custom editor -> text input, rejected.
  assertFocus(focusResult({ textPatternPresent: true, textPatternReadOnlyKnown: true, textPatternReadOnly: false }),
    { classification: 'text', reason: 'writable_text_pattern_focus' }, 'writable TextPattern document')
  assertFocus(focusResult({ textPatternWritable: true }),
    { classification: 'text', reason: 'writable_text_pattern_focus' }, 'legacy documentWritable evidence field')
  // A strong signal keeps precedence over a writable document range.
  assert.equal(focusResult({ textPatternWritable: true, isPassword: true }).classification, 'password')
  assert.equal(focusResult({ textPatternWritable: true, isTextEditControl: true }).reason, 'text_edit_focus')
  // Fail-closed classes: every one yields Unknown (never Safe).
  const closed = [
    { foregroundAlive: false },
    { foregroundIsCurrent: false },
    { ownProcess: true },
    { classifierAvailable: false },
    { probeTimedOut: true },
    { elementAvailable: false }
  ]
  for (const override of closed) {
    const result = focusResult(override)
    assert.equal(result.classification, 'unknown', JSON.stringify(override))
    assert.equal(result.safe, false)
    assert.equal(typeof result.reason, 'string')
  }
  // Defaults fail closed when the evidence object is incomplete.
  assert.equal(nativeAddon.__testClassifyKeyboardFocus({}).classification, 'unknown')
})

test('P1-3 missing writability evidence or unconfirmed focus identity is never safe', { skip: !nativeAddon }, () => {
  // The delivery-review regression: get_CurrentControlType and get_CurrentIsPassword succeed, so
  // the element is "available", but the ValuePattern read-only property could not be read. The
  // surface may be a writable editor, so the policy must return Unknown instead of Safe.
  assertFocus(focusResult({ valuePatternPresent: true, valueReadOnlyKnown: false }),
    { classification: 'unknown', reason: 'value_read_only_unknown' }, 'ValuePattern IsReadOnly read failure')
  assert.equal(focusResult({ valuePatternPresent: true }).classification, 'unknown',
    'a present ValuePattern without a read-only answer fails closed')
  // Same for a TextPattern whose document range did not answer UIA_IsReadOnlyAttributeId.
  assertFocus(focusResult({ textPatternPresent: true, textPatternReadOnlyKnown: false }),
    { classification: 'unknown', reason: 'text_read_only_unknown' }, 'TextPattern read-only attribute read failure')
  // get_CurrentIsPassword succeeded and every sensitive flag is false, yet no read-only evidence
  // was obtained: this is the exact review payload class and it must not be Safe.
  assertFocus(focusResult({}), { classification: 'safe' }, 'positive control: fully confirmed non-text surface')
  const unproven = nativeAddon.__testClassifyKeyboardFocus({
    foregroundAlive: true,
    foregroundIsCurrent: true,
    elementAvailable: true
  })
  assert.equal(unproven.classification, 'unknown', 'elementAvailable alone no longer authorizes Safe')
  assert.equal(unproven.safe, false)
  // HWND fallback: ElementFromHandle evidence may only describe the container of virtual
  // subcontrols, so it cannot authorize Safe even when the container looks non-text.
  assertFocus(focusResult({ focusIdentityConfirmed: false }),
    { classification: 'unknown', reason: 'unconfirmed_focus_identity' }, 'HWND fallback/container evidence')
  // A virtual password subcontrol behind such a container is still rejected as password: the
  // sensitive classes are decided before the focus-identity check, never as safe.
  assertFocus(focusResult({ focusIdentityConfirmed: false, isPassword: true }),
    { classification: 'password', reason: 'password_focus' }, 'virtual password subcontrol')
  // A Document/Text control with no read-only answer cannot be proven safe either.
  assertFocus(focusResult({ isTextControlType: true }),
    { classification: 'unknown', reason: 'no_read_only_evidence' }, 'Document/Text control without read-only evidence')
  // Positively confirmed read-only evidence is the safe accept for text surfaces.
  assertFocus(focusResult({ valuePatternPresent: true, valueReadOnlyKnown: true, valueReadOnly: true }),
    { classification: 'safe', reason: 'read_only_focus' }, 'read-only ValuePattern')
  assertFocus(focusResult({ textPatternPresent: true, textPatternReadOnlyKnown: true, textPatternReadOnly: true }),
    { classification: 'safe', reason: 'read_only_focus' }, 'read-only TextPattern document')

  // Class-name shorthands used by the probe and the cross-layer tests.
  const shorthand = (focus) => plain(nativeAddon.__testClassifyKeyboardFocus({ focus }))
  assertFocus(shorthand('safe'), { classification: 'safe' }, 'safe shorthand')
  assertFocus(shorthand('documentReadOnly'), { classification: 'safe' }, 'documentReadOnly shorthand')
  assertFocus(shorthand('readOnlyValue'), { classification: 'safe' }, 'readOnlyValue shorthand')
  assertFocus(shorthand('containerOnly'), { classification: 'unknown', reason: 'unconfirmed_focus_identity' }, 'containerOnly shorthand')
  assertFocus(shorthand('valueReadOnlyUnknown'), { classification: 'unknown', reason: 'value_read_only_unknown' }, 'valueReadOnlyUnknown shorthand')
  assertFocus(shorthand('textReadOnlyUnknown'), { classification: 'unknown', reason: 'text_read_only_unknown' }, 'textReadOnlyUnknown shorthand')
  assertFocus(shorthand('textControlWithoutEvidence'), { classification: 'unknown', reason: 'no_read_only_evidence' }, 'textControlWithoutEvidence shorthand')
  assertFocus(shorthand('virtualPasswordSubcontrol'), { classification: 'password' }, 'virtualPasswordSubcontrol shorthand')
  assertFocus(shorthand('unknown'), { classification: 'unknown' }, 'unknown shorthand')

  // The bridge echoes the new evidence fields so a test can see what the policy consumed.
  const echoed = focusResult({ valuePatternPresent: true, valueReadOnlyKnown: true, valueReadOnly: true })
  assert.equal(echoed.focusIdentityConfirmed, true)
  assert.equal(echoed.elementAvailable, true)
  assert.equal(echoed.valuePatternPresent, true)
  assert.equal(echoed.valueReadOnlyKnown, true)
  assert.equal(echoed.valueReadOnly, true)
  assert.equal(echoed.textPatternPresent, false)
  assert.equal(echoed.textPatternReadOnlyKnown, false)
  assert.equal(echoed.isTextControlType, false)
  const containerEcho = focusResult({ focusIdentityConfirmed: false })
  assert.equal(containerEcho.focusIdentityConfirmed, false)
})

test('P1-02 native combo policy only accepts a grammar-valid combo on a safe surface', { skip: !nativeAddon }, () => {
  const classify = (focusValue) => plain(nativeAddon.__testClassifyKeyboardCombo({
    vkCode: 0x56,
    scanCode: 0x2f,
    modifiers: 2, // Ctrl
    focus: focusValue
  }))
  assert.deepEqual(classify('safe'), { accepted: true, combo: 'Ctrl+V', reason: 'accepted', context: 'safe' })
  // Sensitive classes are rejected by the combined policy with their focus reason.
  for (const [focusValue, reason] of [
    ['password', 'password_focus'],
    ['text', 'text_edit_focus'],
    ['ime', 'ime_composition'],
    ['unknown', 'no_focus_element']
  ]) {
    const result = classify(focusValue)
    assert.equal(result.accepted, false, focusValue)
    assert.equal(result.combo, 'Ctrl+V', 'the key policy itself still recognizes the combination')
    assert.equal(result.context, focusValue === 'unknown' ? 'unknown' : focusValue)
    assert.equal(result.reason, reason)
  }
  // The evidence-object form is the same policy the runtime builds.
  assert.equal(classify(evidence({ isPassword: true })).accepted, false)
  assert.equal(classify(evidence({})).accepted, true)
  assert.equal(classify(evidence({ probeTimedOut: true })).accepted, false)
  // P1-02 hardening: the browser-page demo scenario is a read-only Document with a TextPattern.
  // It must stay accepted, while a writable TextPattern surface is rejected as text input.
  assert.deepEqual(classify('documentReadOnly'), { accepted: true, combo: 'Ctrl+V', reason: 'accepted', context: 'safe' })
  const writableDocument = classify('documentWritable')
  assert.equal(writableDocument.accepted, false)
  assert.equal(writableDocument.combo, 'Ctrl+V', 'the key policy itself still recognizes the combination')
  assert.equal(writableDocument.context, 'text')
  assert.equal(writableDocument.reason, 'writable_text_pattern_focus')
  // P1-3: missing writability evidence and unconfirmed focus identity are rejected, not accepted.
  for (const [label, focusValue, reason] of [
    ['container-only evidence', { foregroundAlive: true, foregroundIsCurrent: true, elementAvailable: true, focusIdentityConfirmed: false }, 'unconfirmed_focus_identity'],
    ['value read failure', { foregroundAlive: true, foregroundIsCurrent: true, elementAvailable: true, focusIdentityConfirmed: true, valuePatternPresent: true }, 'value_read_only_unknown'],
    ['text read failure', { foregroundAlive: true, foregroundIsCurrent: true, elementAvailable: true, focusIdentityConfirmed: true, textPatternPresent: true }, 'text_read_only_unknown'],
    ['text control without evidence', { foregroundAlive: true, foregroundIsCurrent: true, elementAvailable: true, focusIdentityConfirmed: true, isTextControlType: true }, 'no_read_only_evidence'],
    ['virtual password subcontrol', { foregroundAlive: true, foregroundIsCurrent: true, elementAvailable: true, focusIdentityConfirmed: false, isPassword: true }, 'password_focus']
  ]) {
    const result = classify(focusValue)
    assert.equal(result.accepted, false, label)
    assert.equal(result.combo, 'Ctrl+V', label)
    assert.equal(result.context, label === 'virtual password subcontrol' ? 'password' : 'unknown', label)
    assert.equal(result.reason, reason, label)
  }
  // Confirmed read-only document stays accepted.
  assert.equal(classify(evidence({ textPatternPresent: true, textPatternReadOnlyKnown: true, textPatternReadOnly: true })).accepted, true)
  // Deliberately omitting the focus input keeps the historical key-policy-only probe (used by
  // test/selection-keyboard-combos.test.js); the production path always has focus evidence.
  const keyOnly = plain(nativeAddon.__testClassifyKeyboardCombo({ vkCode: 0x56, modifiers: 2 }))
  assert.equal(keyOnly.accepted, true)
  assert.equal(keyOnly.context, 'unclassified')
})

test('P1-02 runtime foreground probe returns a bounded classification and diagnostics', { skip: !nativeAddon }, () => {
  assert.equal(typeof nativeAddon.__testClassifyFocusedContext, 'function')
  const current = nativeAddon.__testClassifyFocusedContext()
  assert.ok(current && typeof current === 'object')
  assert.ok(['safe', 'password', 'text', 'ime', 'unknown'].includes(current.classification))
  assert.equal(current.safe, current.classification === 'safe')
  assert.equal(typeof current.reason, 'string')
  assert.equal(typeof current.classifierAvailable, 'boolean')
  assert.equal(current.classifierAvailable, true, 'the bounded IUIAutomation2 client must be available on this host')
  // Invalid explicit handles fail closed instead of throwing.
  const invalid = nativeAddon.__testClassifyFocusedContext({ hwnd: 0x12345678 })
  assert.equal(invalid.classification, 'unknown')
  assert.equal(invalid.safe, false)
  assert.equal(typeof invalid.reason, 'string')
})

// ---------------------------------------------------------------------------
// C. Source contracts: where the classification runs and that it fails closed
// ---------------------------------------------------------------------------

test('P1-02 the low-level keyboard hook never runs UIA, it only snapshots cheap handles', () => {
  const source = read('vendor/selection-hook/src/windows/selection_hook.cc')
  const hookCallback = sliceBetween(
    source,
    'LRESULT CALLBACK SelectionHook::KeyboardHookCallback',
    'void SelectionHook::EnableDpiAwareness'
  )
  for (const forbidden of ['GetFocusedElement', 'ElementFromHandle', 'CoCreateInstance', 'IUIAutomation', 'ImmGetContext', 'ClassifyComboFocus']) {
    assert.doesNotMatch(hookCallback, new RegExp(forbidden), `the hook callback must not run ${forbidden}`)
  }
  // The only focus work in the hook is the cheap event-time snapshot.
  const enqueue = sliceBetween(source, 'void SelectionHook::EnqueueKeyboardCombo', 'highlighter::KeyboardFocusDecision SelectionHook::ClassifyComboFocus')
  assert.match(enqueue, /CaptureKeyboardFocusSnapshot\(\)/)
  assert.match(enqueue, /focusSnapshot/)
  // Classification lives on the JS-thread TSFN callback and drops non-safe classes before the
  // payload object exists.
  const processKeyboard = sliceBetween(source, 'void SelectionHook::ProcessKeyboardEvent', 'bool SelectionHook::GetSelectedText')
  assert.match(processKeyboard, /ClassifyComboFocus\(pKeyboardEvent->focusSnapshot\)/)
  assert.match(processKeyboard, /IsKeyboardFocusSafe\(focus\.classification\)/)
  assert.match(processKeyboard, /"context"/)
  const safeCheckAt = processKeyboard.indexOf('IsKeyboardFocusSafe')
  const payloadAt = processKeyboard.indexOf('Napi::Object::New')
  assert.ok(safeCheckAt >= 0 && payloadAt > safeCheckAt, 'the focus gate precedes payload construction')
})

test('P1-02 the classifier is bounded IUIAutomation2 and every failure fails closed', () => {
  const header = fs.readFileSync(FOCUS_HEADER_PATH, 'utf8')
  assert.match(header, /enum class KeyboardFocusClass/)
  assert.match(header, /Safe,\n    Password,\n    TextInput,\n    ImeComposition,\n    Unknown/)
  assert.match(header, /KeyboardFocusDecision ClassifyKeyboardFocus\(const KeyboardFocusEvidence &evidence\)/)
  assert.match(header, /CaptureKeyboardFocusSnapshot\(\)/)
  // Pure policy: the header must not create OS/UIA state. Only the executable text is checked:
  // the doc comments legitimately name GetFocusedElement/ElementFromHandle when they explain the
  // P1-3 evidence provenance.
  const headerCode = header.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(headerCode, /CoCreateInstance|GetFocusedElement|ElementFromHandle/)
  // P1-02 hardening: the writable-TextPattern rule and its documented residuals are in the
  // production header/policy, not only in comments.
  assert.match(header, /textPatternWritable/)
  assert.match(header, /UIA_IsReadOnlyAttributeId/)
  assert.match(header, /same-window web-content focus change/)
  // P1-3 hardening: the policy distinguishes confirmed read-only, confirmed non-text and
  // "property read failed / focus identity unconfirmed" (the latter is Unknown, fail closed).
  for (const field of [
    'focusIdentityConfirmed',
    'isTextControlType',
    'valuePatternPresent',
    'valueReadOnlyKnown',
    'valueReadOnly',
    'textPatternPresent',
    'textPatternReadOnlyKnown',
    'textPatternReadOnly'
  ]) {
    assert.match(header, new RegExp('\\b' + field + '\\b'), `the evidence struct must carry ${field}`)
  }
  for (const reason of [
    'unconfirmed_focus_identity',
    'value_read_only_unknown',
    'text_read_only_unknown',
    'no_read_only_evidence',
    'read_only_focus'
  ]) {
    assert.match(header, new RegExp(reason), 'the policy must emit the stable reason ' + reason)
  }
  // The stale own-process claim is fixed: the control bar lives in the MAIN process (different
  // PID from the hook's utility process), so this branch is defence-in-depth and the duplicate
  // is handled by the P2-06 source pairing.
  assert.match(header, /control-bar window belongs to the MAIN/)
  assert.match(header, /P2-06/)

  const source = fs.readFileSync(FOCUS_SOURCE_PATH, 'utf8')
  assert.match(source, /CoCreateInstance\(__uuidof\(CUIAutomation8\)/)
  assert.match(source, /QueryInterface\(__uuidof\(IUIAutomation2\)/)
  assert.match(source, /put_ConnectionTimeout\(kFocusConnectionTimeoutMs\)/)
  assert.match(source, /put_TransactionTimeout\(kFocusTransactionTimeoutMs\)/)
  assert.match(source, /failed = true/, 'a client that cannot prove the timeout bound fails closed')
  assert.match(source, /evidence\.ownProcess = snapshot\.processId != 0 && snapshot\.processId == GetCurrentProcessId\(\)/)
  assert.match(source, /GetGUIThreadInfo\(foregroundThread, &threadInfo\)/)
  assert.match(source, /ImmGetCompositionStringW/)
  // P1-02 hardening: bounded writable-TextPattern evidence with every COM interface released.
  assert.match(source, /GetCurrentPatternAs\(UIA_TextPatternId/)
  assert.match(source, /get_DocumentRange\(&documentRange\)/)
  assert.match(source, /GetAttributeValue\(UIA_IsReadOnlyAttributeId, &isReadOnly\)/)
  assert.match(source, /documentRange->Release\(\)/)
  assert.match(source, /textPattern->Release\(\)/)
  assert.match(source, /textPatternWritable = isReadOnly\.boolVal == VARIANT_FALSE/)
  // P1-3: presence is recorded separately from a successful read-only read, and the HWND
  // fallback is marked as unconfirmed container/identity evidence.
  assert.match(source, /valuePatternPresent = true/)
  assert.match(source, /valueReadOnlyKnown = true/)
  assert.match(source, /textPatternPresent = true/)
  assert.match(source, /textPatternReadOnlyKnown = true/)
  assert.match(source, /UIA_DocumentControlTypeId/)
  assert.match(source, /UIA_TextControlTypeId/)
  assert.match(source, /focusIdentityConfirmed = true/, 'only a matching GetFocusedElement confirms identity')
  assert.match(source, /focusIdentityConfirmed = false/, 'the HWND fallback / explicit handle path marks its identity source')
  assert.match(source, /focusIdentityConfirmed = ProbeWindowHandle|ProbeWindowHandle\(automation, window, windowProcessId, startedAt\)/)
  // TOCTOU: the production path re-checks the foreground/focus identity after the UIA probe and
  // fails closed before spreading the evidence into the decision.
  assert.match(source, /bool FocusSnapshotStillCurrent\(const KeyboardFocusSnapshot &snapshot\)/)
  assert.match(source, /if \(!FocusSnapshotStillCurrent\(snapshot\)\)/)
  assert.match(source, /evidence\.foregroundIsCurrent = false;/)
  const probeCallAt = source.indexOf('const ElementEvidence element = ProbeFocusedElement')
  const recheckAt = source.indexOf('if (!FocusSnapshotStillCurrent(snapshot))')
  const rejectAt = source.indexOf('return ClassifyKeyboardFocus(evidence);', recheckAt)
  assert.ok(probeCallAt >= 0 && recheckAt > probeCallAt && rejectAt > recheckAt,
    'the TOCTOU re-check runs after the UIA probe and before the accept decision')
  // Never in the hook: the runtime probe is a separate translation unit.
  assert.doesNotMatch(source, /KeyboardHookCallback/)

  const binding = read('vendor/selection-hook/binding.gyp')
  assert.match(binding, /src\/windows\/core\/keyboard_focus\.cc/)
  assert.match(binding, /imm32\.lib/)
})

test('P1-02 the native focus probe script exists and never presses keys', () => {
  const probe = read('scripts/probe-keyboard-focus-context.js')
  assert.match(probe, /__testClassifyFocusedContext/)
  assert.match(probe, /password/i)
  assert.match(probe, /UseSystemPasswordChar/)
  // The probe must never synthesize input: the native channel drops injected keys by design.
  assert.doesNotMatch(probe, /SendInput|SendKeys|keybd_event/)
})

test('P1-3 the probe no longer accepts safe for a writable rich-text surface', () => {
  const probe = read('scripts/probe-keyboard-focus-context.js')
  // The writable rich-text expectation must never include 'safe' again: a writable TextPattern
  // is a text surface even when the provider cannot answer its read-only attribute (the policy
  // then fails closed to unknown). Keeping 'safe' in the allowed set was the review regression.
  const writable = sliceBetween(probe, "label: 'writable rich text document'", 'residual:')
  assert.doesNotMatch(writable, /'safe'/, 'writable rich text must not accept safe')
  assert.match(writable, /expected: \['text'/)
  // Read-only rich text stays a positive expectation (provider-dependent unknown is allowed and
  // must be documented as such).
  const readOnly = sliceBetween(probe, "label: 'read-only rich text document'", 'residual:')
  assert.match(readOnly, /expected: \['safe'(, 'unknown')?\]/)
  assert.doesNotMatch(readOnly, /'text'/, 'read-only rich text must not be treated as text input')
  // The hardened evidence classes are also checked by the probe through the native self-test
  // bridge, so the rebuilt addon is exercised for containers and read failures too.
  assert.match(probe, /__testClassifyKeyboardFocus/)
  assert.match(probe, /containerOnly/)
  assert.match(probe, /valueReadOnlyUnknown|value read failure/i)
  assert.match(probe, /focusIdentityConfirmed/)
})

