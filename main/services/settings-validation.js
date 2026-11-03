const { isValidAccelerator } = require('../../shared/shortcut-keys')
const { QUALITY_LEVELS, COUNTDOWN_OPTIONS } = require('../../shared/recording-quality')

const MAX_PATCH_BYTES = 256 * 1024
const MAX_ARRAY_ITEMS = 100
const DEFAULT_STRING_LIMIT = 32 * 1024
const STRING_LIMITS = new Map([
  ['apiKey', 512],
  ['customCss', 128 * 1024],
  ['selectionToolbar.prompts.translate', 6000],
  ['selectionToolbar.prompts.explain', 6000],
  // R2 (contracts §3): user-controlled text that is not a path and not free-form copy.
  ['record.audioMicrophoneDeviceId', 256],
  ['record.lastDisplayId', 128]
])
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// R2 (docs/plans/2026-11-03-recording-r1-r3-contracts.md §3): enum settings cannot be checked by
// the template walk, because the template only knows the TYPE of `'standard'` / `3` /
// `'display'`. Without these, an illegal value would be persisted and silently repaired on read,
// which is exactly the "only normalized at read time" gap the contract forbids. They are merged
// UNDER the caller-supplied `domainValidators` map (a caller may still override a path) and live
// here instead of settings-service.js so the write gate needs no new wiring in that module.
const RECORD_MODES = Object.freeze(['display', 'region'])
const RECORD_ENUM_VALIDATORS = new Map([
  ['record.quality', (value) => {
    if (!QUALITY_LEVELS.includes(value)) throw new RangeError('Unsupported setting value: record.quality')
  }],
  ['record.countdown', (value) => {
    if (!COUNTDOWN_OPTIONS.includes(value)) throw new RangeError('Unsupported setting value: record.countdown')
  }],
  ['record.lastMode', (value) => {
    if (!RECORD_MODES.includes(value)) throw new RangeError('Unsupported setting value: record.lastMode')
  }]
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Per-path domain validators (feature B, plan §5.2).
//
// The template walk can only check SHAPE: `screenshot.regionPreferences.presets` is an
// empty array in DEFAULT_SETTINGS, so the generic walk would length-check it and accept
// any junk items. A `null` template leaf (lastByMode.capture / .record) has the same
// problem from the other side: `typeof null === 'object'`, so it used to reject a legal
// value that happens to sit in that slot. Both are the migration gap the plan names: a
// default (absent) lastByMode and an empty array must not be mis-rejected by template
// type validation, so they need dedicated domain validation plus migration tests.
//
// The hook is deliberately OPTIONAL and additive: `assertSettingsPatch(patch, template)`
// with two arguments behaves exactly as before (see test/settings-validation.test.js).
// `domainValidators` is a Map<dotted-path, (value) => void>; a registered path OWNS its
// whole subtree - the validator is called with the patch value and the generic walk does
// not descend into it (the domain validator is responsible for unknown keys there, which
// is what makes a hand-written region-presets validator stricter, not looser).
function domainValidatorFor(domainValidators, path) {
  if (!path) return null
  if (domainValidators && typeof domainValidators.get === 'function') {
    const validator = domainValidators.get(path)
    if (typeof validator === 'function') return validator
  } else if (domainValidators && typeof domainValidators === 'object' && Object.hasOwn(domainValidators, path)) {
    const validator = domainValidators[path]
    if (typeof validator === 'function') return validator
  }
  return RECORD_ENUM_VALIDATORS.get(path) || null
}

function assertValue(value, template, path, domainValidators) {
  const domainValidator = domainValidatorFor(domainValidators, path)
  if (domainValidator) {
    // The domain validator throws its own (more specific) TypeError/RangeError. Its
    // messages are English because they surface through the settings write path.
    domainValidator(value)
    return
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`)
    if (value.length > MAX_ARRAY_ITEMS) throw new RangeError(`${path} 包含的项目过多`)
    return
  }
  // A null/undefined template leaf means "any value is accepted at this path" (the
  // `lastByMode.{capture,record}` slots start as null). Without this the `typeof` check
  // below compares against "object"/"undefined" and mis-rejects perfectly legal values.
  if (template === null || template === undefined) return
  if (isPlainObject(template)) {
    if (!isPlainObject(value)) throw new TypeError(`${path} 必须是对象`)
    for (const [key, item] of Object.entries(value)) {
      const itemPath = path ? `${path}.${key}` : key
      if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(template, key)) throw new Error(`不支持的设置项：${itemPath}`)
      assertValue(item, template[key], itemPath, domainValidators)
    }
    return
  }
  if (typeof value !== typeof template) throw new TypeError(`${path} 类型无效`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${path} 必须是有限数字`)
  if (typeof value === 'string') {
    // Defence in depth for the recorder: an accelerator the browser reported
    // while an input method was composing ("Process") can never register, so it
    // must not reach the store even when a caller or a hand-edited config file
    // supplies one. An empty value stays legal - that is how a shortcut is
    // cleared.
    if (path.startsWith('shortcuts.') && value.trim() && !isValidAccelerator(value)) {
      throw new Error(`快捷键格式无效：${value}`)
    }
    const maximumLength = STRING_LIMITS.get(path) || DEFAULT_STRING_LIMIT
    if (value.length > maximumLength) throw new RangeError(`${path} 内容过长`)
  }
}

// options is optional and additive: `assertSettingsPatch(patch, template)` keeps its
// exact historical behaviour, and `{ domainValidators }` is the sanctioned extension
// point for subtrees whose real contract is domain-specific (currently only
// screenshot.regionPreferences).
function assertSettingsPatch(patch, template, { domainValidators } = {}) {
  if (!isPlainObject(patch)) throw new TypeError('设置更新必须是对象')
  let serialized
  try {
    serialized = JSON.stringify(patch)
  } catch {
    throw new TypeError('设置更新无法序列化')
  }
  if (Buffer.byteLength(serialized || '') > MAX_PATCH_BYTES) throw new RangeError('设置更新内容过大')
  assertValue(patch, template, '', domainValidators)
  return patch
}

module.exports = {
  assertSettingsPatch,
  isPlainObject
}
