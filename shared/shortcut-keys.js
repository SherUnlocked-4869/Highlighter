// Single source of truth for turning recorded keystrokes into Electron global
// shortcut accelerators.
//
// Two windows need the same rules: the settings page records a keystroke, and
// the main process decides whether a stored accelerator may reach
// `globalShortcut.register`. When only the recorder knew the rules, a key the
// browser reports for an in-flight input-method composition ("Process") was
// written straight into the settings, and every later start threw
// "conversion failure from Process".
//
// UMD so the sandboxed renderer can load it without a bundler, exactly like
// toolbar/toolbar-action-meta.js.

(function exposeShortcutKeys(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.shortcutKeys = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // Recording one of these alone never produces an accelerator.
  const MODIFIER_KEYS = new Set([
    'Control', 'ControlLeft', 'ControlRight',
    'Shift', 'ShiftLeft', 'ShiftRight',
    'Alt', 'AltLeft', 'AltRight',
    'Meta', 'MetaLeft', 'MetaRight',
    'AltGraph', 'OS', 'Hyper', 'Super', 'Symbol'
  ])

  // Keys the browser reports while the character is still being composed by an
  // input method (or when the OS owns the key). "Process" is the value an IME
  // emits for the physical key that started the composition; recording it is
  // what produced the invalid "Process" accelerator this module prevents.
  const IGNORED_KEYS = new Set([
    'Process', 'Unidentified', 'Dead', 'Compose', 'Convert', 'NonConvert', 'KanaMode', 'KanjiMode'
  ])

  const MODIFIER_ALIASES = new Map([
    ['ctrl', 'Ctrl'],
    ['control', 'Ctrl'],
    ['alt', 'Alt'],
    ['option', 'Alt'],
    ['shift', 'Shift'],
    ['super', 'Super'],
    ['cmd', 'Super'],
    ['command', 'Super'],
    ['meta', 'Super'],
    ['win', 'Super'],
    ['windows', 'Super']
  ])
  const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super']

  // DOM KeyboardEvent.key -> Electron accelerator key, matched case-insensitively.
  const KEY_ALIASES = new Map(Object.entries({
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    escape: 'Escape',
    esc: 'Escape',
    ' ': 'Space',
    space: 'Space',
    spacebar: 'Space',
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    insert: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    capslock: 'Capslock',
    numlock: 'Numlock',
    scrolllock: 'Scrolllock',
    printscreen: 'PrintScreen',
    audiovolumeup: 'VolumeUp',
    audiovolumedown: 'VolumeDown',
    audiovolumemute: 'VolumeMute',
    mediaplaypause: 'MediaPlayPause',
    mediatracknext: 'MediaNextTrack',
    mediatrackprevious: 'MediaPreviousTrack',
    mediastop: 'MediaStop'
  }))

  const NUMPAD_KEY_ALIASES = new Map(Object.entries({
    Numpad0: 'num0',
    Numpad1: 'num1',
    Numpad2: 'num2',
    Numpad3: 'num3',
    Numpad4: 'num4',
    Numpad5: 'num5',
    Numpad6: 'num6',
    Numpad7: 'num7',
    Numpad8: 'num8',
    Numpad9: 'num9',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
    NumpadEnter: 'Enter'
  }))

  const NUMPAD_KEYS = new Set(['num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec'])

  // Bare (modifier-free) keys a global shortcut may use. Everything else needs
  // at least one modifier: a bare letter or digit would swallow that key
  // system-wide while the app runs.
  const BARE_ALLOWED_KEYS = new Set([
    'PrintScreen',
    'VolumeUp', 'VolumeDown', 'VolumeMute',
    'MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop'
  ])
  const FUNCTION_KEY_PATTERN = /^F([1-9]|1[0-9]|2[0-4])$/
  // Keys named by Electron's accelerator table, other than single characters.
  const NAMED_KEYS = new Set([
    ...KEY_ALIASES.values(),
    ...NUMPAD_KEYS,
    'Plus'
  ])
  const PUNCTUATION_PATTERN = /^[!-/:-@[-`{-~]$/

  function isFunctionKey(key) {
    return FUNCTION_KEY_PATTERN.test(String(key || ''))
  }

  function isSingleCharacterKey(key) {
    return /^[A-Z0-9]$/.test(String(key || '')) || PUNCTUATION_PATTERN.test(String(key || ''))
  }

  function isSupportedKey(key) {
    const value = String(key || '')
    if (!value) return false
    if (isSingleCharacterKey(value)) return true
    if (isFunctionKey(value)) return true
    return NAMED_KEYS.has(value)
  }

  function isModifierOnlyKey(key) {
    return MODIFIER_KEYS.has(String(key || ''))
  }

  function isIgnoredRecordingKey(key) {
    return IGNORED_KEYS.has(String(key || ''))
  }

  function isIgnoredRecordingEvent(event = {}) {
    if (event.isComposing === true) return true
    if (Number(event.keyCode) === 229) return true
    return isIgnoredRecordingKey(event.key)
  }

  // "+" is the accelerator separator, so the plus key ships as "Plus".
  function acceleratorKeyFromEvent(event = {}) {
    const code = String(event.code || '')
    if (NUMPAD_KEY_ALIASES.has(code)) return NUMPAD_KEY_ALIASES.get(code)
    const key = String(event.key || '')
    if (key === '+') return 'Plus'
    if (key === ' ') return 'Space'
    if (key.length === 1) return key.toUpperCase()
    return KEY_ALIASES.get(key.toLowerCase()) || ''
  }

  function acceleratorFromKeyboardEvent(event = {}) {
    if (isIgnoredRecordingEvent(event)) return ''
    if (isModifierOnlyKey(event.key)) return ''
    const key = acceleratorKeyFromEvent(event)
    if (!key) return ''
    const parts = []
    if (event.ctrlKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    if (event.metaKey) parts.push('Super')
    parts.push(key)
    return parts.join('+')
  }

  function canonicalKey(token) {
    const raw = String(token || '').trim()
    if (!raw) return ''
    if (raw.length === 1) return raw.toUpperCase()
    const alias = KEY_ALIASES.get(raw.toLowerCase())
    if (alias) return alias
    const numpad = NUMPAD_KEYS.has(raw.toLowerCase()) ? raw.toLowerCase() : ''
    if (numpad) return numpad
    if (isFunctionKey(raw.toUpperCase())) return raw.toUpperCase()
    return raw
  }

  /**
   * Parse an accelerator into modifiers + one key.
   * @returns {{ modifiers: string[], key: string, valid: boolean, reason: string }}
   *   reason is one of '' | 'empty' | 'no-key' | 'multiple-keys' | 'unsupported-key'
   */
  function parseAccelerator(raw) {
    const text = String(raw || '').trim()
    if (!text) return { modifiers: [], key: '', valid: false, reason: 'empty' }
    const tokens = text.split('+').map((token) => token.trim()).filter(Boolean)
    if (!tokens.length) return { modifiers: [], key: '', valid: false, reason: 'empty' }
    const modifiers = []
    let key = ''
    for (const token of tokens) {
      const alias = MODIFIER_ALIASES.get(token.toLowerCase())
      if (alias) {
        if (!modifiers.includes(alias)) modifiers.push(alias)
        continue
      }
      if (key) return { modifiers: MODIFIER_ORDER.filter((item) => modifiers.includes(item)), key: '', valid: false, reason: 'multiple-keys' }
      key = canonicalKey(token)
    }
    const ordered = MODIFIER_ORDER.filter((item) => modifiers.includes(item))
    if (!key) return { modifiers: ordered, key: '', valid: false, reason: 'no-key' }
    if (!isSupportedKey(key)) return { modifiers: ordered, key, valid: false, reason: 'unsupported-key' }
    return { modifiers: ordered, key, valid: true, reason: '' }
  }

  function normalizeAccelerator(raw) {
    const parsed = parseAccelerator(raw)
    if (!parsed.key) return ''
    return [...parsed.modifiers, parsed.key].join('+')
  }

  function isValidAccelerator(raw) {
    return parseAccelerator(raw).valid
  }

  // Recording policy (stricter than syntax): a bare printable key would steal
  // that key from every application, so it needs a modifier. Function keys,
  // media keys and PrintScreen stay usable on their own, which keeps the
  // shipped default F1 valid.
  function isRecordableShortcut(raw) {
    const parsed = parseAccelerator(raw)
    if (!parsed.valid) return false
    if (parsed.modifiers.length) return true
    if (isFunctionKey(parsed.key)) return true
    return BARE_ALLOWED_KEYS.has(parsed.key)
  }

  function describeShortcutRejection(raw) {
    const text = String(raw || '').trim()
    if (!text) return '请按下一个组合键'
    const head = text.split('+')[0].trim()
    if (isIgnoredRecordingKey(text) || isIgnoredRecordingKey(head)) return '输入法组合键无法作为快捷键，请先切到英文输入再录入'
    const parsed = parseAccelerator(text)
    if (parsed.reason === 'multiple-keys') return '一个快捷键只能包含一个主键'
    if (parsed.reason === 'no-key') return '请按下一个组合键'
    if (parsed.reason === 'unsupported-key') return `不支持的按键：${parsed.key || text}`
    if (!parsed.modifiers.length && !isFunctionKey(parsed.key) && !BARE_ALLOWED_KEYS.has(parsed.key)) {
      return '单独使用这个键会占用系统的同名按键，请加上 Ctrl / Alt / Shift'
    }
    return '快捷键格式无效'
  }

  return {
    MODIFIER_KEYS,
    IGNORED_KEYS,
    MODIFIER_ORDER,
    acceleratorFromKeyboardEvent,
    acceleratorKeyFromEvent,
    describeShortcutRejection,
    isFunctionKey,
    isIgnoredRecordingEvent,
    isIgnoredRecordingKey,
    isModifierOnlyKey,
    isRecordableShortcut,
    isSupportedKey,
    isValidAccelerator,
    normalizeAccelerator,
    parseAccelerator
  }
})
