// Capture file naming convention, shared by the main process (writers) and
// HistoryService (which must recognize files it owns).
//
// The forward generator and the reverse matcher previously lived in different
// files and were kept in sync only by convention. They still share one
// definition here, and the optional naming-template segment is part of that
// same definition: a still capture produced by `makeCaptureName` must be
// accepted by `OWNED_CAPTURE_FILE`, or HistoryService would treat the app's own
// screenshots as foreign files (plan R9).
//
// Pure on purpose (no Electron, no DB): the whole module is unit-testable.

const CAPTURE_PREFIX = 'Highlighter'
const LONG_CAPTURE_PREFIX = 'Highlighter_Long'
const VIDEO_CAPTURE_PREFIX = 'Highlighter_Video'

const DEFAULT_EXTENSION = 'png'
// `{app}` falls back to the ownership prefix when the caller injects nothing.
// Electron's app.getName() reads package.json and this package has no
// root-level productName (only build.productName), so it reports the package
// name "highlighter-snowshot" — not a user-facing label. Callers that want the
// package identity pass it explicitly as `{ app: app.getName() }`.
const DEFAULT_APP_LABEL = CAPTURE_PREFIX

// `{app}` is the only identity variable the main process can resolve: there is
// no native active-window-title source in this project, so that variable is
// deliberately not offered instead of being silently empty (plan §6.2).
const TEMPLATE_VARIABLES = Object.freeze(['app', 'date', 'time', 'datetime'])
const TEMPLATE_TOKEN_PATTERN = /\{(app|date|time|datetime)\}/g
// Braces that are not a known variable never reach the file name.
const UNKNOWN_TOKEN_PATTERN = /\{[^{}]*\}/g

// Windows rejects these anywhere inside one component, plus trailing dots and
// spaces; reserved device names are rejected as a whole component.
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|]/g
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
])
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/

// Default cap for one sanitized component. The ownership matcher below allows a
// template label of at most 120 characters; `makeCaptureName` uses a tighter cap
// so that a uniqueness suffix (`-1`, `-2`, …) can never push the label out of
// the matcher again.
const MAX_FILE_NAME_LENGTH = 120
const MAX_TEMPLATE_LABEL_LENGTH = 100

// Same-source ownership contract, built from the same two halves the generator
// below emits: `PREFIX_YYYY-MM-DD_HH-mm-ss[_label].EXT`.
//
// The optional label half is the naming-template segment. It is bounded (≤120
// characters, no leading dot) so that relaxing the matcher for templates cannot
// swallow unrelated files in the history directory — `HistoryService.cleanup()`
// deletes unreferenced files it recognizes as owned
// (main/services/history-service.js:472).
//
// Matches only still captures; video exports deliberately fall outside it.
const OWNED_NAME_HEAD = 'Highlighter(?:_Long)?_\\d{4}-\\d{2}-\\d{2}_[\\d-]+'
const OWNED_NAME_LABEL = '(?:_[^\\\\/:*?"<>|.][^\\\\/:*?"<>|]{0,119})?'
const OWNED_CAPTURE_FILE = new RegExp(`^${OWNED_NAME_HEAD}${OWNED_NAME_LABEL}\\.png$`, 'i')
const OWNED_THUMBNAIL_FILE = /^\d{10,}-[a-z0-9]+-thumb\.png$/i

// Splits "stem.ext" on the last dot. A leading dot (hidden name) is part of the
// stem, and a name with no dot has no extension. Local on purpose: the result
// must not depend on the host path module.
function splitExtension(name) {
  const text = String(name ?? '')
  const dot = text.lastIndexOf('.')
  if (dot <= 0) return { stem: text, extension: '' }
  return { stem: text.slice(0, dot), extension: text.slice(dot) }
}

function normalizeExtension(value) {
  const text = String(value ?? '').trim().replace(/^\.+/, '').toLocaleLowerCase('en-US')
  return EXTENSION_PATTERN.test(text) ? text : DEFAULT_EXTENSION
}

// China Standard Time wall clock (UTC+8), so a screenshot's name can be read as
// local time.
function chinaWallClock(now = Date.now()) {
  const stamp = new Date((Number.isFinite(now) ? now : Date.now()) + 8 * 60 * 60 * 1000)
    .toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const [date, time] = stamp.split('_')
  return { date, time, stamp }
}

/**
 * Make one file-name component safe on Windows/NTFS.
 *
 * Strips path separators and the reserved characters, drops control characters
 * and surrounding dots/spaces (Windows silently removes trailing ones and
 * misreads a leading one as an extension), defuses reserved device names
 * (CON/PRN/AUX/NUL/COM1-9/LPT1-9), and caps the length. Returns `fallback` when
 * nothing usable survives.
 *
 * @param {unknown} value raw value (a whole file name or one segment)
 * @param {{ fallback?: string, maxLength?: number }} [options]
 * @returns {string}
 */
function sanitizeFileName(value, { fallback = '', maxLength = MAX_FILE_NAME_LENGTH } = {}) {
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : MAX_FILE_NAME_LENGTH
  let text = String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_FILE_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (!text) return fallback
  // Windows treats the leading dot-segment as the device name: "CON.png" is as
  // reserved as "CON".
  const dot = text.indexOf('.')
  const head = (dot === -1 ? text : text.slice(0, dot)).toLocaleUpperCase('en-US')
  if (RESERVED_DEVICE_NAMES.has(head)) text = `_${text}`
  if (text.length > limit) text = text.slice(0, limit).replace(/[.\s]+$/, '')
  return text || fallback
}

/**
 * Expand a naming template. Pure: `now`/`app` come from the context, so tests
 * stay deterministic; only the variables in `TEMPLATE_VARIABLES` are
 * substituted, and any other `{token}` is dropped rather than leaked into the
 * file name. A blank template renders to `''` (= keep the legacy format).
 *
 * The result is NOT sanitized here — `makeCaptureName` sanitizes the rendered
 * label; a direct caller must run `sanitizeFileName` on it.
 *
 * @param {unknown} template e.g. `'{app}-{date}_{time}'`
 * @param {{ now?: number, app?: string, date?: string, time?: string }} [context]
 * @returns {string}
 */
function renderNameTemplate(template, context = {}) {
  const source = String(template ?? '')
  if (!source.trim()) return ''
  const wallClock = context.date && context.time
    ? { date: String(context.date), time: String(context.time) }
    : chinaWallClock(Number.isFinite(context.now) ? context.now : Date.now())
  const values = {
    app: String(context.app ?? DEFAULT_APP_LABEL),
    date: wallClock.date,
    time: wallClock.time,
    datetime: `${wallClock.date}_${wallClock.time}`
  }
  return source
    .replace(TEMPLATE_TOKEN_PATTERN, (_match, name) => values[name] ?? '')
    .replace(UNKNOWN_TOKEN_PATTERN, '')
}

/**
 * Return `name` when it is still free, otherwise `stem-1.ext`, `stem-2.ext`, …
 * The existence probe is injected (`isTaken`) so this stays pure; the main
 * process passes a directory probe. Throws when the attempts are exhausted, so
 * a caller can never fall back to silently overwriting.
 *
 * @param {string} name requested file name (already sanitized)
 * @param {{ isTaken?: (candidate: string) => boolean, maxAttempts?: number }} [options]
 * @returns {string}
 */
function ensureUniqueName(name, { isTaken = () => false, maxAttempts = 9999 } = {}) {
  const wanted = String(name ?? '')
  if (!wanted) throw new TypeError('Unique naming requires a file name')
  if (typeof isTaken !== 'function') throw new TypeError('Unique naming requires an isTaken probe')
  if (!isTaken(wanted)) return wanted
  const { stem, extension } = splitExtension(wanted)
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 9999
  for (let index = 1; index <= attempts; index++) {
    const candidate = `${stem}-${index}${extension}`
    if (!isTaken(candidate)) return candidate
  }
  throw new Error(`无法为 ${wanted} 生成不重名的文件名`)
}

function readNameOptions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    template: typeof source.template === 'string' ? source.template : '',
    app: typeof source.app === 'string' && source.app ? source.app : DEFAULT_APP_LABEL,
    isTaken: typeof source.isTaken === 'function' ? source.isTaken : () => false,
    now: Number.isFinite(source.now) ? source.now : Date.now()
  }
}

/**
 * Build a capture file name: `PREFIX_YYYY-MM-DD_HH-mm-ss[_label].EXT`.
 *
 * @param {string} [prefix] `Highlighter` / `Highlighter_Long` / `Highlighter_Video`
 * @param {string} [ext] extension, with or without the dot (P0-4-T6 needs
 *   `makeCaptureName(prefix, 'pdf')`; default `png`, so every existing
 *   single-argument call site keeps producing `*.png`)
 * @param {{ template?: string, app?: string, isTaken?: Function, now?: number }} [nameSettings]
 *   `template` is `settings.screenshot.nameTemplate` (empty = legacy format),
 *   `isTaken` is the de-duplication probe handed to `ensureUniqueName`.
 * @returns {string}
 */
function makeCaptureName(prefix = CAPTURE_PREFIX, ext = DEFAULT_EXTENSION, nameSettings = {}) {
  const extension = normalizeExtension(ext)
  const options = readNameOptions(nameSettings)
  // 使用中国时区(UTC+8)的墙钟时间命名,便于直接按本地时间识别截图;偏移量为 8 * 60 * 60 * 1000 毫秒。
  const { date, time } = chinaWallClock(options.now)
  // Sanitized, then trimmed of separators/space so a dropped `{token}` cannot
  // leave a dangling `-` or a trailing space in the segment.
  const label = sanitizeFileName(
    renderNameTemplate(options.template, { app: options.app, date, time }),
    { fallback: '', maxLength: MAX_TEMPLATE_LABEL_LENGTH }
  ).replace(/^[-\s]+/, '').replace(/[-\s]+$/, '')
  const head = `${sanitizeFileName(prefix, { fallback: CAPTURE_PREFIX })}_${date}_${time}`
  const plain = `${head}.${extension}`
  if (!label) return ensureUniqueName(plain, { isTaken: options.isTaken })
  const templated = `${head}_${label}.${extension}`
  // Same-source guarantee: for the extension the ownership matcher governs, a
  // name that the matcher would reject is never emitted. In practice this keeps
  // `Highlighter_Video_*` from gaining a label; other extensions (pdf/mp4) sit
  // outside the matcher by design and keep theirs.
  const owned = extension !== DEFAULT_EXTENSION || OWNED_CAPTURE_FILE.test(templated)
  return ensureUniqueName(owned ? templated : plain, { isTaken: options.isTaken })
}

module.exports = {
  CAPTURE_PREFIX,
  LONG_CAPTURE_PREFIX,
  VIDEO_CAPTURE_PREFIX,
  DEFAULT_EXTENSION,
  DEFAULT_APP_LABEL,
  TEMPLATE_VARIABLES,
  MAX_FILE_NAME_LENGTH,
  MAX_TEMPLATE_LABEL_LENGTH,
  OWNED_CAPTURE_FILE,
  OWNED_THUMBNAIL_FILE,
  renderNameTemplate,
  sanitizeFileName,
  ensureUniqueName,
  makeCaptureName
}
