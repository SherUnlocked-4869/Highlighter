'use strict'

// DEV-04 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md section 4):
// global shortcut capture while recording.
//
// The native keyboard channel is delivered by vendor/selection-hook (native-owner) as:
//   hook.setKeyboardEventsEnabled(bool) / hook.isKeyboardEventsEnabled()
//   hook.on('key-combo', { tMs, vkCode, scanCode, modifiers, combo, context })
// where `context` is the TRUSTED native focus classification for that key event
// ("safe" is the only accepted class; password/text input/IME/unknown are dropped natively).
//
// This file proves the JS half of the pipeline WITHOUT a live native hook:
//   * the privacy filter in main/domains/record/keystroke-capture.js produces zero events for
//     plain typing, Shift+single-char, IME, auto-repeat, injected input, a missing focus context,
//     and every non-safe focus class, and only ever returns `{ at, combo }` (never raw text or
//     window content);
//   * main/services/pointer-hook-host.js is the only forwarder and forwards only accepted payloads;
//   * main/domains/record/index.js merges the control-bar and global sources one-to-one per
//     physical press (no same-source dedupe), drops paused-wall-clock events at media mapping time
//     and exposes the lifecycle gates;
//   * the built native addon's deterministic self-test bridge agrees with the JS contract and the
//     full chain (native classification -> host filter -> merge -> events.json track) produces
//     exactly one record for one physical press on a safe surface and zero for sensitive ones.
//
// Synthetic SendInput keys are LLKHF_INJECTED and deliberately rejected by the native channel, so
// the real hardware keyboard matrix (control bar / demo page / text input / password input / IME
// composition / unknown focus) remains a real-device step.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const capture = require('../main/domains/record/keystroke-capture')
const recordDomain = require('../main/domains/record')
const { createPointerTrackService, KEYSTROKE_LIMIT } = require('../main/services/pointer-track-service')

const BASE = 1_700_000_000_000

// A production-shaped native payload: epoch tMs + modifier bitmask + allowlisted combo + the
// trusted focus class the native capture boundary classified at event time.
function nativePayload(combo, at = BASE, modifiers = 0, context = 'safe') {
  return { tMs: at, vkCode: 0x50, scanCode: 0, modifiers, combo, context }
}

// ---------------------------------------------------------------------------
// 1. privacy filter: allowed classes (a positive safe focus context is mandatory)
// ---------------------------------------------------------------------------

test('DEV-04: production payloads with a safe focus context pass and only the label/time pair survives', () => {
  for (const combo of ['Ctrl+Shift+P', 'Ctrl+C', 'Alt+Tab', 'Shift+Enter', 'Shift+F5', 'F5', 'Ctrl+Alt+Delete']) {
    const result = capture.inspectGlobalKeystroke(nativePayload(combo))
    assert.equal(result.ok, true, combo)
    assert.equal(result.combo, combo)
    assert.equal(result.at, BASE)
    assert.deepEqual(Object.keys(result).sort(), ['at', 'combo', 'ok'], 'no raw key/window/context fields escape')
  }
  // Native modifier bits: bit0 Shift, bit1 Ctrl, bit2 Alt, bit3 Win.
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Ctrl+Shift+P', BASE, 1 | 2)).ok, true)
  // Bare navigation keys are shortcuts only on a positively classified non-text surface.
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Enter')).ok, true)
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Tab')).ok, true)
})

test('DEV-04: the filter also accepts a raw key payload and formats the same labels', () => {
  assert.equal(capture.formatCombo({ key: 'p', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P')
  assert.equal(capture.formatCombo({ key: 'Tab', altKey: true }), 'Alt+Tab')
  assert.equal(capture.formatCombo({ key: 'Escape' }), 'Esc')
  assert.equal(capture.formatCombo({ key: ' ' }), '')
  assert.equal(capture.formatCombo({ key: 'F5' }), 'F5')
  assert.equal(capture.formatCombo({ key: 'Control', ctrlKey: true }), '')
  // The formatted label is then filtered exactly like a declared combo.
  const formatted = capture.inspectGlobalKeystroke({ key: 'p', ctrlKey: true, at: BASE, context: 'safe' })
  assert.deepEqual(formatted, { ok: true, at: BASE, combo: 'Ctrl+P' })
})

// ---------------------------------------------------------------------------
// 2. privacy filter: excluded classes produce zero events
// ---------------------------------------------------------------------------

test('DEV-04: plain typing, Shift+single-char, IME, repeats and drop flags yield nothing', () => {
  const rejected = [
    // Plain typing is never a shortcut.
    nativePayload('a'),
    nativePayload('1'),
    nativePayload('Space'),
    // Shift+letter/digit is still typing (the capture policy requires Ctrl/Alt/Win).
    nativePayload('Shift+A'),
    nativePayload('Shift+1'),
    // IME composition.
    { tMs: BASE, combo: 'Ctrl+Shift+P', isComposing: true, context: 'safe' },
    { tMs: BASE, combo: 'Ctrl+Shift+P', keyCode: 229, context: 'safe' },
    { tMs: BASE, combo: 'Ctrl+Shift+P', vkCode: 229, context: 'safe' },
    // OS auto-repeat.
    { tMs: BASE, combo: 'Ctrl+Z', repeat: true, context: 'safe' },
    { tMs: BASE, combo: 'Ctrl+Z', isRepeat: true, context: 'safe' },
    // Synthetic/injected input.
    { tMs: BASE, combo: 'Ctrl+V', injected: true, context: 'safe' },
    { tMs: BASE, combo: 'Ctrl+V', synthetic: true, context: 'safe' },
    // Legacy flags are still rejected even if a forged safe context is attached.
    { tMs: BASE, combo: 'Ctrl+C', sensitive: true, context: 'safe' },
    { tMs: BASE, combo: 'Ctrl+C', editable: true, context: 'safe' },
    // Not in the frozen capsule grammar.
    nativePayload('Ctrl+?'),
    nativePayload('Ctrl+Shift+;'),
    nativePayload('ctrl+p'),
    nativePayload('typed text'),
    nativePayload('Ctrl+P '),
    // Malformed payloads are dropped instead of throwing.
    null,
    'Ctrl+P',
    []
  ]
  for (const payload of rejected) {
    const result = capture.inspectGlobalKeystroke(payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(typeof result.reason, 'string')
    assert.equal(capture.filterGlobalKeystroke(payload), null)
  }
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('a')).reason, 'not-a-shortcut')
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Shift+A')).reason, 'shift-typing')
  assert.equal(capture.inspectGlobalKeystroke({ tMs: BASE, combo: 'Ctrl+Z', repeat: true, context: 'safe' }).reason, 'filtered-input')
})

test('P1-02: every combo requires the trusted native focus context; missing or sensitive -> zero events', () => {
  // The review regression: a native-contract-shaped Ctrl+V with no focus field must be rejected.
  // Nothing may pass on label shape alone, not even F-keys or chords.
  for (const combo of ['Ctrl+V', 'Ctrl+Shift+P', 'Alt+Tab', 'F5', 'F12', 'Enter']) {
    const noContext = { tMs: BASE, vkCode: 0x56, scanCode: 0, modifiers: 2, combo }
    assert.equal(capture.inspectGlobalKeystroke(noContext).ok, false, `${combo} without context must fail closed`)
    assert.equal(capture.inspectGlobalKeystroke(noContext).reason, 'missing-focus-context')
    // Legacy/untrusted context spellings are not the native contract and are not accepted.
    for (const context of ['app', 'application', 'desktop', 'window', 'shortcut', 'none', 'safe-ish', '', 0, null, 'SAFE', ' safe']) {
      assert.equal(capture.inspectGlobalKeystroke({ ...noContext, context }).ok, false, `${combo} context ${JSON.stringify(context)}`)
    }
    // Attaching the field to a raw key payload does not bypass the rule either.
    assert.equal(capture.inspectGlobalKeystroke({ key: 'v', ctrlKey: true, at: BASE, context: 'password' }).ok, false)
  }
  // Sensitive native classes are rejected with a stable reason.
  for (const context of ['password', 'text', 'ime']) {
    const result = capture.inspectGlobalKeystroke(nativePayload('Ctrl+V', BASE, 2, context))
    assert.equal(result.ok, false, context)
    assert.equal(result.reason, 'sensitive-focus')
    assert.equal(capture.filterGlobalKeystroke(nativePayload('Ctrl+V', BASE, 2, context)), null)
  }
  // An unknown/unclassifiable focus is its own reason: the label is not emitted either.
  const unknown = capture.inspectGlobalKeystroke(nativePayload('Ctrl+V', BASE, 2, 'unknown'))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'unknown-focus')
  // Only the positive trusted class is accepted.
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Ctrl+V', BASE, 2, 'safe')).ok, true)
  assert.deepEqual([...capture.SAFE_CONTEXTS], ['safe'])
  assert.deepEqual([...capture.SENSITIVE_CONTEXTS], ['password', 'text', 'ime'])
})

test('DEV-04: the media clock prefers the native event time and never invents a relative one', () => {
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('F5')).at, BASE)
  assert.equal(capture.inspectGlobalKeystroke({ at: BASE + 5, combo: 'F5', context: 'safe' }).at, BASE + 5)
  // A monotonic/relative timestamp is not an epoch: the host stamps receipt time instead.
  const now = BASE + 999
  assert.equal(capture.inspectGlobalKeystroke({ tMs: 1234, combo: 'F5', context: 'safe' }, { now }).at, now)
  assert.equal(capture.inspectGlobalKeystroke({ combo: 'F5', context: 'safe' }, { now }).at, now)
})

// ---------------------------------------------------------------------------
// 3. two sources -> one bounded, deduped media-time track (P2-06)
// ---------------------------------------------------------------------------

test('P2-06: only the control-bar report and the global report of the SAME physical press pair', () => {
  // Both sources see the same Ctrl+S: renderer keydown arrives 30 ms after the native hook.
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 1030, combo: 'Ctrl+S' }],
    [{ at: BASE + 1000, combo: 'Ctrl+S' }]
  ), [{ at: BASE + 1000, combo: 'Ctrl+S' }], 'dual-source same press -> one record')
  // Same source pressed twice 90 ms apart is TWO presses: the old by-label 120 ms dedupe dropped
  // the second one (P2-06). Never dedupe within one source.
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 1000, combo: 'Ctrl+Z' }, { at: BASE + 1090, combo: 'Ctrl+Z' }],
    []
  ), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ], 'same-source consecutive presses stay two')
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [],
    [{ at: BASE + 1000, combo: 'Ctrl+Z' }, { at: BASE + 1090, combo: 'Ctrl+Z' }]
  ), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ], 'the global source alone also keeps both presses')
  // Two cross-source presses 90 ms apart stay two records (one per physical press).
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 1000, combo: 'Ctrl+Z' }, { at: BASE + 1090, combo: 'Ctrl+Z' }],
    [{ at: BASE + 1005, combo: 'Ctrl+Z' }, { at: BASE + 1095, combo: 'Ctrl+Z' }]
  ), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1090, combo: 'Ctrl+Z' }
  ], 'two physical presses seen by both sources -> two records')
  // A pair needs the same combo and the 120 ms cross-source window.
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 2000, combo: 'Alt+Tab' }],
    [
      { at: BASE + 1000, combo: 'Ctrl+S' },
      { at: BASE + 1400, combo: 'Ctrl+S' },
      { at: BASE + 2200, combo: 'Alt+Tab' }
    ]
  ), [
    { at: BASE + 1000, combo: 'Ctrl+S' },
    { at: BASE + 1400, combo: 'Ctrl+S' },
    { at: BASE + 2000, combo: 'Alt+Tab' },
    { at: BASE + 2200, combo: 'Alt+Tab' }
  ], 'different combos never pair; outside the window both reports stay')
  // One-to-one: a single control-bar report can absorb only one global report.
  assert.equal(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 1000, combo: 'Ctrl+Z' }],
    [{ at: BASE + 1005, combo: 'Ctrl+Z' }, { at: BASE + 1090, combo: 'Ctrl+Z' }]
  ).length, 2, 'extra same-source report is never dropped')
  // Interleaved distinct combos: pairing is by combo, so the sequence is preserved.
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 1000, combo: 'Ctrl+Z' }, { at: BASE + 1010, combo: 'Ctrl+Y' }],
    [{ at: BASE + 1005, combo: 'Ctrl+Z' }, { at: BASE + 1015, combo: 'Ctrl+Y' }]
  ), [
    { at: BASE + 1000, combo: 'Ctrl+Z' },
    { at: BASE + 1010, combo: 'Ctrl+Y' }
  ])
  // Garbage from either source never reaches the track.
  assert.deepEqual(recordDomain.mergeKeystrokeSources(
    [{ at: BASE, combo: 'typed text' }, { at: 'junk', combo: 'Ctrl+P' }],
    [{ combo: 'F5' }, { at: BASE + 10, combo: 'F5' }]
  ), [{ at: BASE + 10, combo: 'F5' }])
  // The merged list respects the same bound as the persisted track.
  const many = Array.from({ length: KEYSTROKE_LIMIT + 25 }, (_value, index) => ({ at: BASE + index * 500, combo: 'F5' }))
  assert.equal(recordDomain.mergeKeystrokeSources([], many).length, KEYSTROKE_LIMIT)
})

test('DEV-04: paused wall-clock spans produce no capsules; the media clock resumes at pause start', () => {
  const timing = {
    mediaStartedAtWall: BASE,
    pausedIntervals: [{ startWall: BASE + 2000, endWall: BASE + 5000 }],
    durationMs: 8000
  }
  const entries = [
    { at: BASE + 1000, combo: 'Ctrl+S' },
    { at: BASE + 2500, combo: 'Ctrl+C' }, // during the pause: dropped
    { at: BASE + 4999, combo: 'Ctrl+V' }, // just before resume: dropped
    { at: BASE + 5200, combo: 'Alt+Tab' } // after resume: media time 2200
  ]
  assert.deepEqual(recordDomain.buildKeystrokeTrack(entries, timing), [
    { tMs: 1000, combo: 'Ctrl+S' },
    { tMs: 2200, combo: 'Alt+Tab' }
  ])
  // Global-source entries merged with the control bar's own batch use the same mapping.
  const merged = recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 1000, combo: 'Ctrl+S' }],
    [{ at: BASE + 1010, combo: 'Ctrl+S' }, { at: BASE + 5200, combo: 'Alt+Tab' }]
  )
  assert.deepEqual(recordDomain.buildKeystrokeTrack(merged, timing), [
    { tMs: 1000, combo: 'Ctrl+S' },
    { tMs: 2200, combo: 'Alt+Tab' }
  ])
})

// ---------------------------------------------------------------------------
// 4. cross-layer chain: native classification -> host filter -> merge -> events.json
// ---------------------------------------------------------------------------

const ADDON_PATH = path.join(root, 'vendor', 'selection-hook', 'build', 'Release', 'selection-hook.node')
function loadNativeAddon() {
  if (process.platform !== 'win32' || !fs.existsSync(ADDON_PATH)) return null
  try {
    return require(ADDON_PATH)
  } catch {
    return null
  }
}
const nativeAddon = loadNativeAddon()

// Runs the real pointer-hook-host source in a VM with a fake utility-process port and a fake
// EventEmitter-based SelectionHook. This is the same seam test/pointer-track-service.test.js and
// test/f02-selection-ipc-storm.test.js use; no native hook or utility process is started.
function createPointerHostFixture() {
  const port = new EventEmitter()
  port.posted = []
  port.postMessage = (message) => port.posted.push(message)
  const instances = []
  class FakeHook extends EventEmitter {
    constructor() { super(); instances.push(this) }
    start() { return true }
    stop() {}
    cleanup() {}
    isRunning() { return true }
    enableMouseMoveEvent() {}
    disableMouseMoveEvent() {}
    setKeyboardEventsEnabled() {}
    isKeyboardEventsEnabled() { return true }
  }
  const proc = { pid: 4242, parentPort: port }
  vm.runInNewContext(read('main/services/pointer-hook-host.js'), {
    process: proc,
    require: (name) => {
      if (name === 'selection-hook') return FakeHook
      // The host's privacy filter dependency is the production module itself; the assertion is
      // that the *native* dependency is only the hook module.
      if (name === '../domains/record/keystroke-capture') return capture
      throw new Error(`unexpected require in pointer host: ${name}`)
    },
    setTimeout
  })
  const outgoing = () => JSON.parse(JSON.stringify(port.posted.filter((message) => message && message.type !== 'ready')))
  port.emit('message', { type: 'start', keystrokes: true })
  port.posted.length = 0
  return {
    hook: () => instances.at(-1),
    outgoing,
    emitCombo: (payload) => instances.at(-1).emit('key-combo', payload),
    sendToHost: (message) => port.emit('message', message)
  }
}

test('P1-02: native-classified safe combo -> exactly one record; sensitive classes -> zero', { skip: !nativeAddon }, () => {
  assert.equal(typeof nativeAddon.__testClassifyKeyboardCombo, 'function', 'the rebuilt addon exposes the DEV-04 self-test')
  const classify = (focus) => nativeAddon.__testClassifyKeyboardCombo({
    vkCode: 0x53,
    scanCode: 0x1f,
    modifiers: 2, // Ctrl
    focus
  })
  // Allowed demo scenario: the native focus policy accepts the surface and names the class.
  const accepted = classify('safe')
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.combo, 'Ctrl+S')
  assert.equal(accepted.context, 'safe')
  // Production-shaped payload, exactly the fields the native ProcessKeyboardEvent emits.
  const payload = {
    tMs: BASE,
    vkCode: 0x53,
    scanCode: 0x1f,
    modifiers: 2,
    combo: accepted.combo,
    context: accepted.context
  }
  const host = createPointerHostFixture()
  host.emitCombo(payload)
  const messages = host.outgoing()
  assert.deepEqual(messages, [{ type: 'keystroke', combo: 'Ctrl+S', at: BASE }],
    'the trusted combo crosses the utility-process boundary as one minimal message')
  // Demo scenario: the recorded application has focus, so only the global channel reports this
  // physical press. Merge + media mapping is the events.json projection -> exactly one record.
  const timing = { mediaStartedAtWall: BASE, pausedIntervals: [], durationMs: 5000 }
  const merged = recordDomain.mergeKeystrokeSources([], messages.map(({ at, combo }) => ({ at, combo })))
  assert.deepEqual(recordDomain.buildKeystrokeTrack(merged, timing), [{ tMs: 0, combo: 'Ctrl+S' }])
  // A dual-source press of the same physical key also yields one record.
  assert.equal(recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 25, combo: 'Ctrl+S' }],
    [{ at: BASE, combo: 'Ctrl+S' }]
  ).length, 1)

  // Sensitive/unknown focus classes: the native classifier rejects them, and even a forged
  // production-shaped payload is dropped by the JS filter before the host forwards anything.
  for (const focus of ['password', 'text', 'ime', 'unknown']) {
    const rejected = classify(focus)
    assert.equal(rejected.accepted, false, `${focus} must be rejected natively`)
    assert.notEqual(rejected.context, 'safe')
    const forged = { ...payload, context: rejected.context }
    host.emitCombo(forged)
  }
  // A stale native build without the context field also forwards nothing (fail closed).
  const stale = { tMs: BASE, vkCode: 0x53, scanCode: 0x1f, modifiers: 2, combo: 'Ctrl+S' }
  assert.equal(capture.inspectGlobalKeystroke(stale).ok, false)
  host.emitCombo(stale)
  assert.deepEqual(host.outgoing(), messages, 'no rejected class reaches IPC')
  assert.deepEqual(recordDomain.mergeKeystrokeSources([], []), [], 'no record for rejected classes')

  // The pure focus-policy bridge classifies the same evidence the runtime collector produces.
  assert.equal(typeof nativeAddon.__testClassifyKeyboardFocus, 'function')
  const toEvidence = (overrides) => ({
    foregroundAlive: true,
    foregroundIsCurrent: true,
    elementAvailable: true,
    ...overrides
  })
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({})).classification, 'safe')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ isPassword: true })).classification, 'password')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ isTextEditControl: true })).classification, 'text')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ hasWritableValue: true })).classification, 'text')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ imeComposing: true })).classification, 'ime')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ elementAvailable: false })).classification, 'unknown')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ foregroundIsCurrent: false })).classification, 'unknown')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ ownProcess: true })).classification, 'unknown')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ probeTimedOut: true })).classification, 'unknown')
  assert.equal(nativeAddon.__testClassifyKeyboardFocus(toEvidence({ classifierAvailable: false })).classification, 'unknown')
})

// ---------------------------------------------------------------------------
// 5. shipped wiring contracts
// ---------------------------------------------------------------------------

test('DEV-04: the host feature-detects the native channel and stays legacy when it is missing', () => {
  const host = read('main/services/pointer-hook-host.js')
  // Feature detection: the enable call is never unconditional.
  assert.match(host, /typeof hook\.setKeyboardEventsEnabled !== 'function'/)
  assert.match(host, /hook\.on\('key-combo'/)
  assert.match(host, /setKeyboardEventsEnabled\(true\)/)
  assert.match(host, /setKeyboardEventsEnabled\(false\)/)
  // The privacy filter is the only path from a native payload to the process message, and it
  // emits a data-minimal message.
  assert.match(host, /inspectGlobalKeystroke\(payload\)/)
  assert.match(host, /type: 'keystroke', combo: accepted\.combo, at: accepted\.at/)
  // The legacy selection channels are never subscribed for capsules.
  assert.doesNotMatch(host, /on\('key-down'/)
  assert.doesNotMatch(host, /on\('key-up'/)
  // Enabling is impossible unless the take opted in through its start message, and the
  // disable path is part of stop/dispose.
  assert.match(host, /keyboardOptIn = startMessage\.keystrokes === true/)
  assert.match(host, /keyboardRequested = keyboardOptIn && message\.enabled === true/)
  assert.match(host, /function stopHook[\s\S]{0,160}setKeyboardEventsEnabled\(false\)/)
  // The forwarded native contract now carries the trusted focus class.
  assert.match(host, /combo, context \}/)
})

test('P1-02: the JS privacy filter requires the trusted safe context for every event', () => {
  const source = read('main/domains/record/keystroke-capture.js')
  assert.match(source, /const TRUSTED_SAFE_CONTEXT = 'safe'/)
  assert.match(source, /const FOCUS_CONTEXTS = Object\.freeze\(\['safe', 'password', 'text', 'ime', 'unknown'\]\)/)
  assert.match(source, /if \(!focus\.known\) return \{ ok: false, reason: 'missing-focus-context' \}/)
  assert.match(source, /focus\.classification === 'unknown' \? 'unknown-focus' : 'sensitive-focus'/)
  // The old "only some bare keys need a context" loophole is gone: no special case may let a
  // chord or an F-key through without the trusted context.
  assert.doesNotMatch(source, /\^F\(\?:\[1-9\]\|1\[0-2\]\)\$/)
})

test('P2-06: the merge keeps source identity and pairs one-to-one', () => {
  const domain = read('main/domains/record/index.js')
  assert.match(domain, /entries\.push\(\{ at, combo: String\(entry\.combo\)\.trim\(\), source: sourceId \}\)/)
  assert.match(domain, /unmatched\[entry\.source \^ 1\]/)
  assert.match(domain, /const paired = candidates\.splice\(pairingIndex, 1\)\[0\]/)
  assert.match(domain, /at: Math\.min\(paired\.at, entry\.at\)/)
  // The old by-combo last-timestamp map (the P2-06 bug) must be gone.
  assert.doesNotMatch(domain, /lastAtByCombo/)
})

test('DEV-04: the record domain gates capture on per-take opt-in and never outside a take', () => {
  const domain = read('main/domains/record/index.js')
  // The switch travels on the existing workbench config object (no new IPC channel).
  assert.match(domain, /demoKeystrokes: value\.demoKeystrokes === true/)
  assert.match(domain, /demoKeystrokes: provided\.demoKeystrokes === true/)
  assert.match(domain, /demoKeystrokes: config\.demoKeystrokes === true/)
  // Collection requires display/region mode and either opt-in, and passes the keyboard opt-in
  // to the host; the pointer track stays gated by demoEnhance.
  assert.match(domain, /pointer: collectable && config\.demoEnhance === true,/)
  assert.match(domain, /keystrokes: collectable && config\.demoKeystrokes === true/)
  assert.match(domain, /service\.start\(\{ keystrokes: gate\.keystrokes \}\)/)
  // Pause/resume follows the authoritative record state, and the finish path merges sources.
  assert.match(domain, /syncEventTrackKeyboard\(next\.status === 'recording'\)/)
  assert.match(domain, /mergeKeystrokeSources\(keystrokeEntries, globalKeystrokes\)/)
  // Cancel/close/quit stop the same host (no capture outside a recording).
  assert.ok((domain.match(/stopEventTrack\(\)/g) || []).length >= 4, 'every lifecycle exit stops the host')
  // No new IPC surface: the existing `record:state` payload carries the control-bar batches.
  const channels = read('main/ipc/recording-ipc.js') + read('main/ipc/recording-workbench-ipc.js')
  assert.match(channels, /record:state/)
  assert.doesNotMatch(channels, /key-combo|demoKeystrokes|keystroke/)
})

test('DEV-04: the pointer track service is the only bridge and it is bounded', () => {
  const source = read('main/services/pointer-track-service.js')
  assert.match(source, /KEYSTROKE_LIMIT = 2000/)
  assert.match(source, /if \(!this\.running \|\| !this\.keystrokesRequested\) return/)
  assert.match(source, /setKeystrokesEnabled\(enabled\)/)
  const service = createPointerTrackService({
    createHost: () => ({
      postMessage() {},
      onMessage() { return () => {} },
      onExit() { return () => {} },
      kill() {}
    }),
    log: () => {}
  })
  assert.equal(service.start({ keystrokes: true }), true)
  assert.deepEqual(service.results().keystrokes, [])
  service.dispose()
})
