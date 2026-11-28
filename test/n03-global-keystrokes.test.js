'use strict'

// DEV-04 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md section 4):
// global shortcut capture while recording.
//
// The native keyboard channel is delivered by vendor/selection-hook (native-owner) as:
//   hook.setKeyboardEventsEnabled(bool) / hook.isKeyboardEventsEnabled()
//   hook.on('key-combo', { tMs, vkCode, scanCode, modifiers, combo })
// This file proves the JS half of the pipeline WITHOUT the native addon:
//   * the privacy filter in main/domains/record/keystroke-capture.js produces zero events for
//     plain typing, Shift+single-char, IME, auto-repeat, injected input and sensitive/unknown
//     focus, and only ever returns `{ at, combo }` (never raw text or window content);
//   * main/services/pointer-track-service.js carries the bounded optional track;
//   * main/domains/record/index.js merges the control-bar and global sources (dedupe), drops
//     paused-wall-clock events at media mapping time and exposes the lifecycle gates;
//   * the shipped wiring keeps feature detection so a stale addon binary still runs the legacy
//     path, and never subscribes the legacy `key-down` events for capsules.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const capture = require('../main/domains/record/keystroke-capture')
const recordDomain = require('../main/domains/record')
const { createPointerTrackService, KEYSTROKE_LIMIT } = require('../main/services/pointer-track-service')

const BASE = 1_700_000_000_000

// A native-contract payload (native-owner): epoch tMs + modifier bitmask + allowlisted combo.
function nativePayload(combo, at = BASE, modifiers = 0) {
  return { tMs: at, vkCode: 0x50, scanCode: 0, modifiers, combo }
}

// ---------------------------------------------------------------------------
// 1. privacy filter: allowed classes
// ---------------------------------------------------------------------------

test('DEV-04: native contract payloads pass and only the label/time pair survives', () => {
  for (const combo of ['Ctrl+Shift+P', 'Ctrl+C', 'Alt+Tab', 'Shift+Enter', 'Shift+F5', 'F5', 'Ctrl+Alt+Delete']) {
    const result = capture.inspectGlobalKeystroke(nativePayload(combo))
    assert.equal(result.ok, true, combo)
    assert.equal(result.combo, combo)
    assert.equal(result.at, BASE)
    assert.deepEqual(Object.keys(result).sort(), ['at', 'combo', 'ok'], 'no raw key/window fields escape')
  }
  // Native modifier bits: bit0 Shift, bit1 Ctrl, bit2 Alt, bit3 Win.
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Ctrl+Shift+P', BASE, 1 | 2)).ok, true)
  // Bare F-keys are unambiguous shortcuts and need no focus context.
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('F12')).ok, true)
})

test('DEV-04: the filter also accepts a raw key payload and formats the same labels', () => {
  assert.equal(capture.formatCombo({ key: 'p', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P')
  assert.equal(capture.formatCombo({ key: 'Tab', altKey: true }), 'Alt+Tab')
  assert.equal(capture.formatCombo({ key: 'Escape' }), 'Esc')
  assert.equal(capture.formatCombo({ key: ' ' }), '')
  assert.equal(capture.formatCombo({ key: 'F5' }), 'F5')
  assert.equal(capture.formatCombo({ key: 'Control', ctrlKey: true }), '')
  // The formatted label is then filtered exactly like a declared combo.
  const formatted = capture.inspectGlobalKeystroke({ key: 'p', ctrlKey: true, at: BASE })
  assert.deepEqual(formatted, { ok: true, at: BASE, combo: 'Ctrl+P' })
})

// ---------------------------------------------------------------------------
// 2. privacy filter: excluded classes produce zero events
// ---------------------------------------------------------------------------

test('DEV-04: plain typing, Shift+single-char, IME, repeats and sensitive focus yield nothing', () => {
  const rejected = [
    // Plain typing is never a shortcut.
    nativePayload('a'),
    nativePayload('1'),
    nativePayload('Space'),
    // Shift+letter/digit is still typing (the capture policy requires Ctrl/Alt/Win).
    nativePayload('Shift+A'),
    nativePayload('Shift+1'),
    // IME composition.
    { tMs: BASE, combo: 'Ctrl+Shift+P', isComposing: true },
    { tMs: BASE, combo: 'Ctrl+Shift+P', keyCode: 229 },
    { tMs: BASE, combo: 'Ctrl+Shift+P', vkCode: 229 },
    { tMs: BASE, combo: 'Ctrl+Shift+P', context: 'ime' },
    // OS auto-repeat.
    { tMs: BASE, combo: 'Ctrl+Z', repeat: true },
    { tMs: BASE, combo: 'Ctrl+Z', isRepeat: true },
    // Synthetic/injected input.
    { tMs: BASE, combo: 'Ctrl+V', injected: true },
    { tMs: BASE, combo: 'Ctrl+V', synthetic: true },
    // Sensitive or unknown focus.
    { tMs: BASE, combo: 'Ctrl+C', sensitive: true },
    { tMs: BASE, combo: 'Ctrl+C', context: 'password' },
    { tMs: BASE, combo: 'Ctrl+C', focus: 'text' },
    { tMs: BASE, combo: 'Ctrl+C', context: 'unknown' },
    { tMs: BASE, combo: 'Ctrl+C', editable: true },
    // A bare named key in an unknown focus could be typing: only F-keys and decorated chords
    // are accepted without a positive safe context.
    nativePayload('Enter'),
    nativePayload('Tab'),
    nativePayload('Esc'),
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
  // The reasons are stable so the host cannot accidentally forward a rejected class.
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('a')).reason, 'not-a-shortcut')
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Shift+A')).reason, 'shift-typing')
  assert.equal(capture.inspectGlobalKeystroke({ tMs: BASE, combo: 'Ctrl+Z', repeat: true }).reason, 'filtered-input')
  assert.equal(capture.inspectGlobalKeystroke({ tMs: BASE, combo: 'Ctrl+C', context: 'password' }).reason, 'sensitive-focus')
  assert.equal(capture.inspectGlobalKeystroke(nativePayload('Enter')).reason, 'unknown-focus')
  // A positively identified non-text application surface may use bare navigation keys.
  assert.equal(capture.inspectGlobalKeystroke({ tMs: BASE, combo: 'Enter', context: 'safe' }).ok, true)
})

test('DEV-04: the media clock prefers the native event time and never invents a relative one', () => {
  assert.equal(capture.inspectGlobalKeystroke({ tMs: BASE, combo: 'F5' }).at, BASE)
  assert.equal(capture.inspectGlobalKeystroke({ at: BASE + 5, combo: 'F5' }).at, BASE + 5)
  // A monotonic/relative timestamp is not an epoch: the host stamps receipt time instead.
  const now = BASE + 999
  assert.equal(capture.inspectGlobalKeystroke({ tMs: 1234, combo: 'F5' }, { now }).at, now)
  assert.equal(capture.inspectGlobalKeystroke({ combo: 'F5' }, { now }).at, now)
})

// ---------------------------------------------------------------------------
// 3. two sources -> one bounded, deduped media-time track
// ---------------------------------------------------------------------------

test('DEV-04: the control bar and global channel dedupe the same physical press', () => {
  // Both sources see the same Ctrl+S: renderer keydown arrives 30 ms after the native hook.
  const renderer = [{ at: BASE + 1030, combo: 'Ctrl+S' }]
  const global = [{ at: BASE + 1000, combo: 'Ctrl+S' }]
  assert.deepEqual(recordDomain.mergeKeystrokeSources(renderer, global), [
    { at: BASE + 1000, combo: 'Ctrl+S' }
  ])
  // Distinct combos, and the same combo pressed later than the dedupe window, are both kept.
  const merged = recordDomain.mergeKeystrokeSources(
    [{ at: BASE + 2000, combo: 'Alt+Tab' }],
    [
      { at: BASE + 1000, combo: 'Ctrl+S' },
      { at: BASE + 1400, combo: 'Ctrl+S' },
      { at: BASE + 2200, combo: 'Alt+Tab' }
    ]
  )
  assert.deepEqual(merged, [
    { at: BASE + 1000, combo: 'Ctrl+S' },
    { at: BASE + 1400, combo: 'Ctrl+S' },
    { at: BASE + 2000, combo: 'Alt+Tab' },
    { at: BASE + 2200, combo: 'Alt+Tab' }
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
// 4. shipped wiring contracts (the addon is rebuilt by native-owner; this is the JS side)
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
