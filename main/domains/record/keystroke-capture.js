'use strict'

// DEV-04 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md section 4, DEV-04):
// global shortcut capture privacy filter.
//
// The native keyboard channel (vendor/selection-hook, owned by native-owner) already drops plain
// typing, Shift+single-char, IME, AltGr text, OS auto-repeat, synthetic input and unrepresentable
// labels. This module is the JS-side SECOND line of defence, because the recording event track is
// privacy-sensitive and "the addon filtered it" must not be the only guarantee:
//   * only labels in the frozen capsule grammar (main/domains/record/index.js, record/record.js)
//     can leave the utility process;
//   * repeat / IME / sensitive / unknown-focus hints are dropped even if a payload carries them;
//   * bare non-function keys are only accepted when the payload positively identifies a safe
//     (non-text) focus context, so an unknown external text field can never leak Enter/Tab/Esc;
//   * nothing except { at, combo } is ever returned, so raw key codes or window content cannot
//     reach events.json even if the addon starts sending them.
//
// The module is intentionally dependency-free and pure so the privacy policy is unit-testable in
// plain node (test/n03-global-keystrokes.test.js) without a native hook or an Electron process.

const COMBO_MAX_LENGTH = 48
const NAMED_KEY = 'Space|Esc|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|(?:F(?:[1-9]|1[0-2]))'
const CHORD_PATTERN = new RegExp(`^(?:(?:Ctrl|Alt|Shift|Win)\\+){1,4}(?:[A-Z0-9]|${NAMED_KEY})$`)
const SINGLE_PATTERN = new RegExp(`^(?:${NAMED_KEY})$`)
// Bare keys are not obviously "shortcuts": a bare Enter/Tab/Esc in a text field is typing. They
// are only accepted when the native payload says the focus is a non-text application surface.
const SAFE_CONTEXTS = Object.freeze(['safe', 'app', 'application', 'desktop', 'window', 'shortcut', 'none'])
const SENSITIVE_CONTEXTS = Object.freeze([
  'password', 'credential', 'credentials', 'secure', 'secret', 'ime', 'composition',
  'text', 'textinput', 'editable', 'input', 'textarea', 'unknown', 'login', 'search'
])
const KEY_ALIASES = Object.freeze({
  ' ': 'Space',
  Spacebar: 'Space',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
})

function text(value) {
  return typeof value === 'string' ? value : ''
}

function lower(value) {
  return text(value).trim().toLowerCase()
}

// The capture policy in record/record.js only allows these bare keys; Space alone is typing.
const ALLOWED_BARE_KEY = /^(?:Esc|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|F(?:[1-9]|1[0-2]))$/

// The frozen persisted grammar (same labels the N03 HUD and events.json use).
function isAllowedCombo(value) {
  const combo = text(value)
  if (!combo || combo.length > COMBO_MAX_LENGTH || combo !== combo.trim()) return false
  return CHORD_PATTERN.test(combo) || SINGLE_PATTERN.test(combo)
}

function comboParts(combo) {
  const pieces = combo.split('+')
  return { modifiers: pieces.slice(0, -1), key: pieces[pieces.length - 1] }
}

// "Shift+A" is plain typing with the shift key, not a shortcut: the capture policy in
// record/record.js requires Ctrl/Alt/Win for single-character chords. Same rule here, so a
// stale/other-build track cannot smuggle Shift+letter labels into a new recording.
function isPlainTypingChord(combo) {
  if (!CHORD_PATTERN.test(combo)) return false
  const { modifiers, key } = comboParts(combo)
  const strongModifier = modifiers.some((modifier) => modifier === 'Ctrl' || modifier === 'Alt' || modifier === 'Win')
  if (strongModifier) return false
  return /^[A-Z0-9]$/.test(key)
}

function hasDropFlag(payload) {
  const dropTrue = [
    'repeat', 'isRepeat', 'autoRepeat', 'isComposing', 'composing', 'ime', 'isIme',
    'injected', 'synthetic', 'isInjected', 'isSynthetic', 'sensitive', 'isPassword',
    'password', 'editable', 'isEditable', 'inTextInput'
  ]
  for (const key of dropTrue) {
    if (payload[key] === true) return true
  }
  const keyCode = Number(payload.keyCode ?? payload.vkCode)
  if (Number.isFinite(keyCode) && keyCode === 229) return true
  return false
}

// Returns the safe/blocked focus context. `known:false` means the payload carries no context at
// all, which is the common case for a keyboard-only native event.
function focusContext(payload) {
  const raw = lower(payload.context ?? payload.focus ?? payload.focusContext ?? payload.scope)
  if (!raw) return { known: false, safe: false, blocked: false }
  if (SENSITIVE_CONTEXTS.includes(raw)) return { known: true, safe: false, blocked: true }
  return { known: true, safe: SAFE_CONTEXTS.includes(raw), blocked: false }
}

function modifierFlags(payload) {
  // Native contract: bit0 Shift, bit1 Ctrl, bit2 Alt, bit3 Win (bits 0-2 match the mouse bits).
  const mask = Number(payload.modifiers)
  const bits = Number.isFinite(mask) ? Math.max(0, Math.round(mask)) : 0
  return {
    ctrl: payload.ctrlKey === true || (bits & 2) === 2,
    alt: payload.altKey === true || (bits & 4) === 4,
    shift: payload.shiftKey === true || (bits & 1) === 1,
    meta: payload.metaKey === true || (bits & 8) === 8
  }
}

// Formats a raw {key, modifiers} payload with the SAME policy as record/record.js's
// formatKeystrokeCombo + shouldCaptureKeystroke, i.e. the label grammar the HUD understands.
function formatCombo(payload) {
  const rawKey = text(payload.key)
  if (!rawKey || rawKey === 'Unidentified' || rawKey === 'Process') return ''
  const flags = modifierFlags(payload)
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn'].includes(rawKey)) return ''
  let label = KEY_ALIASES[rawKey] || rawKey
  if (label.length === 1) label = label.toUpperCase()
  if (!/^[A-Za-z0-9]{1,16}$/.test(label)) return ''
  const modifiers = []
  if (flags.ctrl) modifiers.push('Ctrl')
  if (flags.alt) modifiers.push('Alt')
  if (flags.shift) modifiers.push('Shift')
  if (flags.meta) modifiers.push('Win')
  if (modifiers.length === 0) return ALLOWED_BARE_KEY.test(label) ? label : ''
  const combo = modifiers.join('+') + '+' + label
  return isAllowedCombo(combo) ? combo : ''
}

function plausibleEpoch(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 1_000_000_000_000 ? Math.round(number) : 0
}

// The single entry point the utility-process host uses.
//   payload: native `{ tMs, vkCode, scanCode, modifiers, combo }` (native-owner contract) or a
//            defensive key-event shape with `{ key, ctrlKey, ... }`.
//   returns { ok:true, at, combo } or { ok:false, reason } - reason codes are stable so tests can
//   prove every excluded class produces zero events.
function inspectGlobalKeystroke(payload, { now = Date.now } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed' }
  if (hasDropFlag(payload)) return { ok: false, reason: 'filtered-input' }
  const focus = focusContext(payload)
  if (focus.blocked) return { ok: false, reason: 'sensitive-focus' }
  const declared = text(payload.combo)
  // Untrimmed labels cannot come from the capture policy, so they are rejected instead of being
  // silently normalised (same rule as main/domains/record isValidKeystrokeCombo).
  if (declared && declared !== declared.trim()) return { ok: false, reason: 'not-a-shortcut' }
  const combo = declared || formatCombo(payload)
  if (!combo || !isAllowedCombo(combo)) return { ok: false, reason: 'not-a-shortcut' }
  if (isPlainTypingChord(combo)) return { ok: false, reason: 'shift-typing' }
  // Bare Space is text input, never a shortcut (record/record.js capture policy does the same).
  if (combo === 'Space') return { ok: false, reason: 'not-a-shortcut' }
  // Bare named keys (Enter/Tab/Esc/...) are only allowed with a POSITIVE safe context; a bare
  // F1-F12 is unambiguous enough to allow without one (it cannot type text).
  if (SINGLE_PATTERN.test(combo) && !/^F(?:[1-9]|1[0-2])$/.test(combo)) {
    if (!focus.known || !focus.safe) return { ok: false, reason: 'unknown-focus' }
  }
  const at = plausibleEpoch(payload.tMs) || plausibleEpoch(payload.at) || plausibleEpoch(payload.timestamp) ||
    (Number.isFinite(Number(now)) ? Math.round(Number(now)) : Date.now())
  return { ok: true, at, combo }
}

// Convenience wrapper: the label/time pair, or null.
function filterGlobalKeystroke(payload, options) {
  const result = inspectGlobalKeystroke(payload, options)
  return result.ok ? { at: result.at, combo: result.combo } : null
}

module.exports = {
  COMBO_MAX_LENGTH,
  KEY_ALIASES,
  SAFE_CONTEXTS,
  SENSITIVE_CONTEXTS,
  filterGlobalKeystroke,
  formatCombo,
  inspectGlobalKeystroke,
  isAllowedCombo,
  isPlainTypingChord
}
