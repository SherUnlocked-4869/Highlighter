'use strict'
// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.2):
// one-click OCR / Excel / pin for a clipboard image record.
//
// Everything here is behaviour-level and mock-only: no native sidecar, no Electron
// window, no real save dialog. The main-process half runs the real domain with an
// injected fake ClipboardService, a fake OCR engine, an injected table builder and
// an injected file system; the renderer half runs the real clipboard.js in a vm
// with a minimal DOM (same technique as test/clipboard-paste-renderer.test.js).
// The real OCR -> buildTableFromOcr -> table-workbook pipeline is also exercised
// once end to end (the fake is only the OCR engine), so the wiring to the U04b
// column clustering and the merged-cell workbook writer cannot silently drift.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const AdmZip = require('adm-zip')
const { createClipboardDomain } = require('../main/domains/clipboard')
const { buildIpcPolicies } = require('../main/services/ipc-security')

const ROOT = path.resolve(__dirname, '..')
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
// The native thumbnail is <=256 KiB and the original attachment <=16 MiB; the
// fixtures only have to be distinguishable and start with the PNG signature.
const THUMBNAIL = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8, 0x22)])
const ORIGINAL = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64, 0x11)])
const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const ITEM = uuid(7)
const OTHER = uuid(8)
const tick = () => new Promise((resolve) => setImmediate(resolve))
const settle = async (count = 6) => { for (let index = 0; index < count; index++) await tick() }
const errorCode = (value) => value?.error?.code

// ---------------------------------------------------------------------------
// Main-process harness
// ---------------------------------------------------------------------------

function mainHarness(options = {}) {
  const handlers = new Map()
  const listeners = new Map()
  const protocols = new Map()
  const commands = []
  const writes = []
  const copiedTexts = []
  const dialogCalls = []
  const pinCalls = []
  const ocrInputs = []
  const gameMode = { value: options.gameMode === true }
  const migration = { value: options.migration === true }
  const settings = {
    language: 'en-US',
    theme: 'dark',
    clipboard: { enabled: true, releaseAfterMs: 60000 },
    plugins: { ocr: options.ocrEnabled !== false },
    ocr: { detectAngle: false, minConfidence: 0.3, idleTimeoutMs: 300000 },
    screenshot: { nameTemplate: '', saveDirectory: '', lastSaveDirectory: '' },
    ...options.settings
  }
  const records = new Map([
    [ITEM, { kind: 'image', byteLength: options.declaredBytes ?? ORIGINAL.length }],
    [OTHER, { kind: 'text', byteLength: 10 }]
  ])
  if (options.records) for (const [id, record] of options.records) records.set(id, record)

  const fakeFs = options.fs || {
    promises: {
      async readdir() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      async readFile() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      async stat() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      async writeFile(filePath, data) { writes.push({ filePath, data }); return undefined }
    }
  }

  const ocr = options.ocr || {
    getStatus: () => ({ available: options.ocrAvailable !== false }),
    recognize: async (bytes, recognizeOptions) => {
      ocrInputs.push({ bytes, options: recognizeOptions })
      if (options.ocrError) throw options.ocrError
      return options.ocrResult || { text: 'Hello world\nSecond line', textBlocks: [], cached: false }
    }
  }

  const dialog = options.dialog || {
    async showMessageBox() { return { response: 1 } },
    async showSaveDialog(...args) {
      dialogCalls.push(args)
      return options.saveResult || { canceled: false, filePath: path.join('C:', 'out', 'table.xlsx') }
    }
  }

  const pinDomain = options.pinDomain || null
  const domainOptions = {
    app: { isPackaged: false, getPath: () => path.join(ROOT, '.tmp-n02') },
    rootDirectory: ROOT,
    directory: options.directory || 'unused',
    nativeTheme: {},
    getSettings: () => settings,
    updateSettings: () => {},
    getHook: () => null,
    isGameModeEnabled: () => gameMode.value,
    isMigrationInProgress: () => migration.value,
    positionAutomationWindow() {},
    dialog,
    fs: fakeFs,
    clipboard: options.electronClipboard,
    writeClipboardText: options.writeClipboardText
      || ((text) => { copiedTexts.push(text) }),
    screen: {
      getCursorScreenPoint: () => ({}),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } })
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        protocol: {
          handle: (scheme, fn) => protocols.set(scheme, fn),
          unhandle: (scheme) => protocols.delete(scheme)
        }
      })
    },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on: (name, handler) => listeners.set(name, handler)
    },
    createLocalWindow: () => {
      const win = new EventEmitter()
      win.visible = false
      win.focused = false
      win.destroyed = false
      win.messages = []
      win.webContents = new EventEmitter()
      win.webContents.id = 1
      win.webContents.send = (channel, data) => win.messages.push({ channel, data })
      win.webContents.isDestroyed = () => win.destroyed
      win.isDestroyed = () => win.destroyed
      win.isVisible = () => win.visible
      win.isFocused = () => win.focused
      win.getNativeWindowHandle = () => Buffer.from('3412000000000000', 'hex')
      win.loadFile = async () => {}
      win.show = () => { win.visible = true }
      win.focus = () => { win.focused = true }
      win.hide = () => { win.visible = false; win.focused = false; win.emit('blur') }
      win.destroy = () => { win.destroyed = true; win.emit('closed') }
      harness.win = win
      return win
    }
  }
  if (options.getOcrService !== false) domainOptions.getOcrService = () => ocr
  if (pinDomain) domainOptions.getPinDomain = () => pinDomain
  if (options.buildTableFromOcr) domainOptions.buildTableFromOcr = options.buildTableFromOcr
  if (options.buildXlsxBuffer) domainOptions.buildXlsxBuffer = options.buildXlsxBuffer

  const domain = createClipboardDomain(domainOptions)
  assert.equal(typeof domain.service, 'object', 'the domain exposes its service for the fakes')
  domain.service.command = async (method, args = {}) => {
    commands.push({ method, args })
    if (method === 'detail') {
      const record = records.get(args.id)
      if (!record) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
      return { id: args.id, kind: record.kind, byteLength: record.byteLength, text: '' }
    }
    if (method === 'thumbnail') {
      if (options.thumbnailError) throw options.thumbnailError
      if (options.thumbnailMime && options.thumbnailMime !== 'image/png') {
        return { bytes: THUMBNAIL, value: { mime: options.thumbnailMime, byteLength: THUMBNAIL.length } }
      }
      return { bytes: options.thumbnail || THUMBNAIL, value: { mime: 'image/png', byteLength: (options.thumbnail || THUMBNAIL).length } }
    }
    if (method === 'copy') return { copied: options.copyResult !== false }
    return {}
  }
  domain.service.refresh = async () => domain.service.snapshot()
  domain.service.snapshot = () => ({ datasetId: 'dataset', revision: 1, itemCount: records.size, pinnedCount: 0 })

  const harness = {
    domain,
    settings,
    commands,
    writes,
    copiedTexts,
    dialogCalls,
    pinCalls,
    ocrInputs,
    handlers,
    listeners,
    gameMode,
    migration,
    win: null,
    invoke(channel, args, sender) {
      return handlers.get(channel)({ sender: sender || harness.win.webContents }, args)
    },
    mutatingCommands() {
      return commands.filter((call) => ['copy', 'paste.prepare', 'paste.commit', 'paste.cancel', 'delete', 'clear', 'set-pinned'].includes(call.method))
    },
    commandNames() { return commands.map((call) => call.method) }
  }
  // Let present() finish its status round trip; the IPC handlers themselves only
  // need win.isVisible(), which show()+ready() already established.
  harness.open = async function open() {
    domain.show()
    listeners.get('clipboard:ready')({ sender: harness.win.webContents })
    await settle()
  }
  return harness
}

// ---------------------------------------------------------------------------
// Renderer harness (same selector-aware DOM stub style as the clipboard tests)
// ---------------------------------------------------------------------------

function matches(node, selector) {
  const parts = selector.match(/^([a-z0-9]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/i)
  if (!parts) throw new Error(`test stub cannot parse selector: ${selector}`)
  const [, tag, tail] = parts
  if (tag && String(node.tagName || '').toLowerCase() !== tag.toLowerCase()) return false
  for (const token of (tail.match(/\[[^\]]+\]|\.[\w-]+/g) || [])) {
    if (token.startsWith('.')) {
      if (!String(node.className || '').split(/\s+/).includes(token.slice(1))) return false
      continue
    }
    const body = token.slice(1, -1)
    const equals = body.indexOf('=')
    const name = equals < 0 ? body : body.slice(0, equals)
    if (equals >= 0) {
      const expected = body.slice(equals + 1).replace(/^["']|["']$/g, '')
      if (node.getAttribute(name) !== expected) return false
    } else if (node.getAttribute(name) == null) return false
  }
  return true
}

function descendants(node, selector) {
  const found = []
  const walk = (current) => {
    for (const child of current.children || []) {
      if (matches(child, selector)) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

function rendererHarness(overrides = {}) {
  const elements = new Map()
  const callbacks = {}
  const calls = []
  const element = (id, tagName = 'div') => {
    const node = {
      id, tagName, value: '', textContent: '', hidden: false, disabled: false, className: '',
      style: { setProperty(name, value) { node.style[name] = value } },
      scrollTop: 0, clientHeight: 300, clientWidth: 469, children: [],
      dataset: {}, attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      replaceChildren(...values) { this.children = values.slice(); for (const value of values) value.parent = this },
      append(...values) { for (const value of values) value.parent = this; this.children.push(...values) },
      appendChild(value) { value.parent = this; this.children.push(value); return value },
      setAttribute(name, value) {
        node.attributes[name] = String(value)
        if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
      },
      getAttribute(name) { return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null },
      removeAttribute(name) { delete node.attributes[name] },
      querySelector(selector) { return descendants(node, selector)[0] || null },
      querySelectorAll(selector) { return descendants(node, selector) },
      closest(selector) { let current = node.parent; while (current) { if (matches(current, selector)) return current; current = current.parent } return null },
      focus() { node.focused = true },
      addEventListener(type, fn) { (node.listeners ||= {})[type] = fn },
      dispatchEvent() {},
      isConnected: true
    }
    return node
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id) }
  const imageActions = { ocr: [], table: [], pin: [] }
  const textWrites = []
  let listResult = { items: [], cursor: null }
  const api = {
    ready() {}, interactive() {}, close() {},
    list() { calls.push('list'); return Promise.resolve({ ok: true, result: listResult }) },
    detail() { return Promise.resolve({ ok: true, result: { text: '', truncated: false, kind: 'text' } }) },
    previews(ids) {
      const copy = Array.from(ids)
      return Promise.resolve({ ok: true, result: copy.map((id) => ({ id, url: `highlighter-clipboard://preview/${id}` })) })
    },
    status() { return Promise.resolve({ ok: true, result: {} }) },
    copy() { return Promise.resolve({ ok: true, result: {} }) },
    paste() { return Promise.resolve({ ok: true, result: {} }) },
    setPinned() { return Promise.resolve({ ok: true, result: {} }) },
    delete() { return Promise.resolve({ ok: true, result: {} }) },
    prepareClear() { return Promise.resolve({ ok: true, result: { canceled: true } }) },
    commitClear() { return Promise.resolve({ ok: true, result: {} }) },
    setPaused(value) { return Promise.resolve({ ok: true, result: { userPaused: value } }) },
    imageOcr(id) { imageActions.ocr.push(id); return overrides.imageOcr ? overrides.imageOcr(id) : Promise.resolve({ ok: true, result: { text: 'Hello', lineCount: 1, lowResolution: false } }) },
    imageTable(id) { imageActions.table.push(id); return overrides.imageTable ? overrides.imageTable(id) : Promise.resolve({ ok: true, result: { saved: true, name: 'table.xlsx' } }) },
    imagePin(id) { imageActions.pin.push(id); return overrides.imagePin ? overrides.imagePin(id) : Promise.resolve({ ok: true, result: { pinned: true, fallback: null } }) },
    copyText(text) { textWrites.push(text); return Promise.resolve({ ok: true, result: true }) }
  }
  for (const name of ['Init', 'Hidden', 'PasteResult', 'Status', 'History', 'Language']) {
    api[`on${name}`] = (fn) => { callbacks[name] = fn; return () => {} }
  }
  const media = { addEventListener() {}, matches: false }
  const context = {
    window: {
      clipboardAPI: api,
      clipboardLayout: require('../clipboard/clipboard-layout.js'),
      clipboardPreview: require('../clipboard/clipboard-preview.js'),
      devicePixelRatio: 1,
      innerWidth: 480,
      innerHeight: 640,
      addEventListener() {},
      matchMedia: () => media
    },
    document: {
      getElementById: get,
      createElement: (tag) => element(`created-${tag}`, tag),
      documentElement: { classList: { toggle() {} }, style: { setProperty() {} } },
      body: { classList: { add() {}, remove() {}, toggle() {} } }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setImmediate,
    crypto: require('node:crypto').webcrypto,
    // Error keys resolve to a distinct value so imageActionErrorText() can be
    // asserted to choose the specific clipboard.error.* entry.
    t: (key, params) => key.startsWith('clipboard.error.')
      ? `E:${key}`
      : (params ? `${key}:${JSON.stringify(params)}` : key),
    setLanguage() {}, applyTranslations() {}, currentLanguage: () => 'en-US'
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'clipboard', 'clipboard.js'), 'utf8'), context)
  return {
    api, callbacks, calls, imageActions, textWrites, get,
    // Accepts the same { ok, result } envelope the page hands around, because the
    // fake list() wraps it again the way the real IPC does.
    page(value) { listResult = value && value.result ? value.result : value },
    tiles() { return get('rows').querySelectorAll('[data-item-id]') },
    node(id) { return get(id) },
    keydown(key, extra = {}) { return { key, isComposing: false, preventDefault() {}, stopPropagation() {}, ...extra } }
  }
}

const IMAGE_ITEM = { id: ITEM, kind: 'image', width: 640, height: 480, isPinned: false, previewText: '', sourceDisplayName: 'App', createdAt: 1, lastCopiedAt: 1, lastUsedAt: 0, byteLength: 100 }
const TEXT_ITEM = { id: OTHER, kind: 'text', previewText: 'plain text', sourceDisplayName: 'App', createdAt: 1, lastCopiedAt: 1, lastUsedAt: 0, byteLength: 10 }

function textOf(node) {
  let value = node?.textContent || ''
  for (const child of node?.children || []) value += textOf(child)
  return value
}

async function rendererWith(overrides = {}) {
  const h = rendererHarness(overrides)
  h.page({ ok: true, result: { items: overrides.items || [IMAGE_ITEM, TEXT_ITEM], cursor: null } })
  h.callbacks.Init({ language: 'en-US' })
  await settle(8)
  return h
}

function imageTile(h) {
  return h.tiles().find((node) => node.getAttribute('data-item-id') === ITEM)
}

async function selectImageTile(h) {
  const tile = imageTile(h)
  assert.ok(tile, 'the image tile is mounted')
  tile.onclick()
  await settle(2)
  return tile
}

async function openImagePreview(h) {
  await selectImageTile(h)
  h.get('list').onkeydown(h.keydown(' '))
  await settle(2)
  assert.equal(h.get('preview').hidden, false, 'the image preview overlay opened')
}

// ---------------------------------------------------------------------------
// 1. OCR
// ---------------------------------------------------------------------------

test('N02 main: OCR runs in the main process and answers text only', async () => {
  const h = mainHarness()
  await h.open()
  const response = await h.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.equal(response.result.text, 'Hello world\nSecond line')
  assert.equal(response.result.lineCount, 2)
  assert.equal(response.result.lowResolution, true, 'the thumbnail fallback is reported honestly')
  assert.equal(Object.hasOwn(response.result, 'textBlocks'), false, 'block coordinates never reach the page')
  assert.equal(Object.hasOwn(response.result, 'bytes'), false, 'no pixels cross the IPC boundary')
  assert.equal(response.result.text.includes(path.sep), false)
  assert.equal(h.ocrInputs.length, 1)
  assert.ok(Buffer.isBuffer(h.ocrInputs[0].bytes), 'main hands the decoded payload to the OCR service')
  assert.deepEqual([...h.ocrInputs[0].bytes], [...THUMBNAIL])
  assert.equal(h.ocrInputs[0].options.minConfidence, 0.3)
  assert.deepEqual(h.commandNames().filter((method) => method !== 'paste.capture'), ['detail', 'thumbnail'], 'only read-only clipboard commands ran')
  assert.deepEqual(h.mutatingCommands(), [], 'OCR must not mutate the clipboard history')
})

test('N02 main: OCR reads the full-resolution attachment behind the thumbnail', async () => {
  const root = path.join(ROOT, `.tmp-n02-attachments-${process.pid}`)
  const hash = 'a'.repeat(64)
  fs.mkdirSync(path.join(root, 'thumbnails'), { recursive: true })
  fs.mkdirSync(path.join(root, 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(root, 'thumbnails', `${hash}.png`), THUMBNAIL)
  fs.writeFileSync(path.join(root, 'attachments', `${hash}.png`), ORIGINAL)
  try {
    // Real fs: the content-addressed lookup is what is under test.
    const h = mainHarness({ directory: root, fs: require('node:fs') })
    await h.open()
    const response = await h.invoke('clipboard:image-ocr', { id: ITEM })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.equal(response.result.lowResolution, false, 'the full-resolution original was found')
    assert.ok(h.ocrInputs[0].bytes.equals(ORIGINAL), 'OCR received the original bytes, not the 240 px thumbnail')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('N02 main: OCR failures are stable codes and leave the busy latch released', async () => {
  const notImage = mainHarness()
  await notImage.open()
  const wrongKind = await notImage.invoke('clipboard:image-ocr', { id: OTHER })
  assert.equal(errorCode(wrongKind), 'NOT_IMAGE')
  assert.deepEqual(notImage.commandNames().filter((method) => method !== 'paste.capture'), ['detail'], 'a non-image record is rejected before any payload read')
  assert.equal(notImage.ocrInputs.length, 0)

  const oversized = mainHarness({ declaredBytes: 16 * 1024 * 1024 + 1 })
  await oversized.open()
  const tooLarge = await oversized.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(errorCode(tooLarge), 'IMAGE_TOO_LARGE')
  assert.deepEqual(oversized.commandNames().filter((method) => method !== 'paste.capture'), ['detail'], 'the declared size is checked before reading pixels')

  const disabled = mainHarness({ ocrEnabled: false })
  await disabled.open()
  const noPlugin = await disabled.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(errorCode(noPlugin), 'OCR_DISABLED')
  assert.deepEqual(disabled.commandNames().filter((method) => method !== 'paste.capture'), [], 'a disabled OCR plugin costs no native round trip')

  const unavailable = mainHarness({ ocrAvailable: false })
  await unavailable.open()
  const noEngine = await unavailable.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(errorCode(noEngine), 'OCR_UNAVAILABLE')

  const failed = mainHarness({ ocrError: Object.assign(new Error('boom'), { code: 'INTERNAL' }) })
  await failed.open()
  const engineError = await failed.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(errorCode(engineError), 'OCR_FAILED', 'an engine error collapses into one stable code')
  const retried = await failed.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(errorCode(retried), 'OCR_FAILED', 'the failed action did not leave the one-at-a-time latch set')
  assert.deepEqual(failed.mutatingCommands(), [])
})

test('N02 main: only one image action runs at a time and the latch releases afterwards', async () => {
  let resolveOcr = null
  let calls = 0
  const deferred = mainHarness({
    ocr: {
      getStatus: () => ({ available: true }),
      recognize: () => {
        calls += 1
        if (calls === 1) return new Promise((resolve) => { resolveOcr = resolve })
        return Promise.resolve({ text: 'done', textBlocks: [] })
      }
    }
  })
  await deferred.open()
  const first = deferred.invoke('clipboard:image-ocr', { id: ITEM })
  await tick()
  await tick()
  const second = await deferred.invoke('clipboard:image-pin', { id: ITEM })
  assert.equal(errorCode(second), 'OPERATION_BUSY', 'a second click cannot start a parallel decode')
  assert.equal(deferred.pinCalls.length, 0)
  assert.equal(deferred.commandNames().filter((method) => method === 'copy').length, 0, 'the busy rejection had no side effect')
  resolveOcr({ text: 'done', textBlocks: [] })
  const answer = await first
  assert.equal(answer.ok, true, JSON.stringify(answer.error))
  const third = await deferred.invoke('clipboard:image-ocr', { id: ITEM })
  assert.equal(third.ok, true, 'the latch is released after the action settles')
  assert.equal(calls, 2, 'the retry reached the OCR engine once the previous action finished')
})

// ---------------------------------------------------------------------------
// 2. Excel table
// ---------------------------------------------------------------------------

test('N02 main: no table structure answers NO_TABLE and writes nothing', async () => {
  const h = mainHarness({ buildTableFromOcr: () => null })
  await h.open()
  const response = await h.invoke('clipboard:image-table', { id: ITEM })
  assert.equal(errorCode(response), 'NO_TABLE')
  assert.equal(h.dialogCalls.length, 0, 'the save dialog never opens for an empty recognition')
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.mutatingCommands(), [])

  const degenerate = mainHarness({ buildTableFromOcr: () => ({ rows: [['only one cell']], columnCount: 1 }) })
  await degenerate.open()
  const oneCell = await degenerate.invoke('clipboard:image-table', { id: ITEM })
  assert.equal(errorCode(oneCell), 'NO_TABLE', 'a degenerate table model is rejected too')
  assert.deepEqual(degenerate.writes, [])
})

test('N02 main: table recognition writes the workbook through the save dialog', async () => {
  const table = {
    rows: [['name', 'score'], ['ada', '10']],
    rowCount: 2,
    columnCount: 2,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  }
  const tableInputs = []
  const workbookInputs = []
  const XLSX = Buffer.from('xlsx-bytes')
  const h = mainHarness({
    buildTableFromOcr: (ocrResult, options) => { tableInputs.push({ ocrResult, options }); return table },
    buildXlsxBuffer: (rows, options) => { workbookInputs.push({ rows, options }); return XLSX },
    dialog: {
      async showMessageBox() { return { response: 1 } },
      async showSaveDialog(...args) { h.dialogCalls.push(args); return { canceled: false, filePath: path.join('D:', 'exports', 'clipboard-table.xlsx') } }
    }
  })
  await h.open()
  const response = await h.invoke('clipboard:image-table', { id: ITEM })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.equal(response.result.saved, true)
  assert.equal(response.result.name, 'clipboard-table.xlsx')
  assert.equal(response.result.rows, 2)
  assert.equal(response.result.columns, 2)
  assert.equal(h.dialogCalls.length, 1, 'exactly one save dialog')
  const dialogOptions = h.dialogCalls[0].at(-1)
  assert.equal(dialogOptions.filters[0].extensions[0], 'xlsx')
  assert.match(dialogOptions.defaultPath, /\.xlsx$/)
  assert.equal(tableInputs.length, 1)
  assert.equal(tableInputs[0].ocrResult.text, 'Hello world\nSecond line')
  assert.equal(tableInputs[0].ocrResult.textBlocks.length, 0)
  assert.equal(workbookInputs.length, 1)
  assert.deepEqual(workbookInputs[0].rows, table.rows)
  assert.deepEqual(workbookInputs[0].options.merges, table.merges, 'the U04b merged-cell metadata is forwarded')
  assert.ok(typeof workbookInputs[0].options.sheetName === 'string' && workbookInputs[0].options.sheetName.length > 0)
  assert.equal(h.writes.length, 1)
  assert.ok(h.writes[0].data.equals(XLSX))
  assert.equal(JSON.stringify(response.result).includes('exports'), false, 'the directory never reaches the renderer')
  assert.equal(JSON.stringify(response.result).includes(path.sep + 'out'), false)
  assert.deepEqual(h.mutatingCommands(), [], 'exporting a table does not touch the clipboard history')
})

test('N02 main: a cancelled save dialog writes nothing and reports a cancel', async () => {
  const h = mainHarness({
    saveResult: { canceled: true },
    buildTableFromOcr: () => ({ rows: [['a', 'b'], ['c', 'd']], columnCount: 2, merges: [] })
  })
  await h.open()
  const response = await h.invoke('clipboard:image-table', { id: ITEM })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.deepEqual(response.result, { canceled: true })
  assert.equal(h.dialogCalls.length, 1)
  assert.deepEqual(h.writes, [], 'a cancel never writes a partial file')
  assert.deepEqual(h.mutatingCommands(), [])
})

test('N02 main: the real OCR -> column clustering -> workbook pipeline produces one sheet', async () => {
  const block = (text, left, top) => ({
    text,
    text_score: 0.95,
    box_points: [
      { x: left, y: top }, { x: left + 40, y: top },
      { x: left + 40, y: top + 10 }, { x: left, y: top + 10 }
    ]
  })
  const ocrResult = {
    text: 'name score\nada 10',
    textBlocks: [block('name', 0, 0), block('score', 60, 0), block('ada', 0, 24), block('10', 60, 24)]
  }
  const h = mainHarness({
    ocr: { getStatus: () => ({ available: true }), recognize: async () => ocrResult },
    dialog: {
      async showMessageBox() { return { response: 1 } },
      async showSaveDialog(...args) { h.dialogCalls.push(args); return { canceled: false, filePath: path.join('D:', 'exports', 'pipeline.xlsx') } }
    }
  })
  await h.open()
  const response = await h.invoke('clipboard:image-table', { id: ITEM })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.deepEqual({ rows: response.result.rows, columns: response.result.columns }, { rows: 2, columns: 2 })
  assert.equal(h.writes.length, 1)
  const archive = new AdmZip(h.writes[0].data)
  const sheet = archive.getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8')
  for (const value of ['name', 'score', 'ada', '10']) assert.ok(sheet.includes(value), `the workbook contains ${value}`)
  assert.ok(sheet.includes('<mergeCells') === false, 'a plain 2x2 table carries no merges')
  assert.equal(h.commandNames().includes('copy'), false)
})

// ---------------------------------------------------------------------------
// 3. Pin
// ---------------------------------------------------------------------------

test('N02 main: an injected pin domain receives the record image', async () => {
  const pinCalls = []
  const pinDomain = {
    canPinMore: () => true,
    createPinWindow: (bytes, meta) => { pinCalls.push({ bytes, meta }); return {} }
  }
  const h = mainHarness({ pinDomain })
  await h.open()
  const response = await h.invoke('clipboard:image-pin', { id: ITEM })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.equal(response.result.pinned, true)
  assert.equal(response.result.fallback, null)
  assert.equal(pinCalls.length, 1)
  assert.ok(pinCalls[0].bytes.equals(THUMBNAIL))
  assert.deepEqual(pinCalls[0].meta, { source: 'clipboard' })
  assert.equal(h.commandNames().includes('copy'), false, 'a real pin does not clobber the system clipboard')
})

test('N02 main: pin reports the limit instead of creating another window', async () => {
  let created = 0
  const h = mainHarness({
    pinDomain: { canPinMore: () => false, createPinWindow: () => { created += 1 } }
  })
  await h.open()
  const response = await h.invoke('clipboard:image-pin', { id: ITEM })
  assert.equal(errorCode(response), 'PIN_LIMIT')
  assert.equal(created, 0)
  assert.deepEqual(h.mutatingCommands(), [])
})

test('N02 main: without a pin resolver the action degrades to the exclusion-marked copy', async () => {
  const h = mainHarness()
  await h.open()
  const response = await h.invoke('clipboard:image-pin', { id: ITEM })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.equal(response.result.pinned, false, 'it must not pretend a desktop pin was created')
  assert.equal(response.result.fallback, 'copied')
  assert.equal(response.result.copied, true)
  const copies = h.commands.filter((call) => call.method === 'copy')
  assert.equal(copies.length, 1)
  assert.equal(copies[0].args.id, ITEM)
  assert.match(copies[0].args.operationId, /^[0-9a-f-]{36}$/)
  assert.equal(JSON.stringify(response.result).includes(path.sep), false)
})

// ---------------------------------------------------------------------------
// 4. Validation / policy / copy
// ---------------------------------------------------------------------------

test('N02 main: the sender must be the live panel and the feature states are honoured', async () => {
  const h = mainHarness()
  await h.open()
  assert.equal(errorCode(await h.invoke('clipboard:image-ocr', { id: ITEM }, { id: 99 })), 'WINDOW_NOT_VISIBLE')

  h.gameMode.value = true
  assert.equal(errorCode(await h.invoke('clipboard:image-ocr', { id: ITEM })), 'IMAGE_ACTIONS_UNAVAILABLE')
  h.gameMode.value = false

  h.settings.clipboard.enabled = false
  assert.equal(errorCode(await h.invoke('clipboard:image-table', { id: ITEM })), 'FEATURE_DISABLED')
  h.settings.clipboard.enabled = true

  h.domain.hide()
  assert.equal(errorCode(await h.invoke('clipboard:image-ocr', { id: ITEM })), 'WINDOW_NOT_VISIBLE', 'a hidden panel cannot start an action')

  const migrated = mainHarness()
  await migrated.open()
  migrated.migration.value = true
  assert.equal(errorCode(await migrated.invoke('clipboard:image-ocr', { id: ITEM })), 'IMAGE_ACTIONS_UNAVAILABLE')
})

test('N02 main: the image action channels exist only on the clipboard surface policy', () => {
  const policies = buildIpcPolicies(ROOT)
  for (const channel of ['clipboard:image-ocr', 'clipboard:image-table', 'clipboard:image-pin', 'clipboard:copy-text']) {
    const policy = policies.get(channel)
    assert.ok(policy, `${channel} has a sender policy`)
    assert.equal(policy.kind, 'handle')
    assert.deepEqual(policy.pages.map(({ role }) => role), ['clipboard'], `${channel} is clipboard-role only`)
  }
  // The IPC layer validates every argument before the domain sees it.
  const ipc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'clipboard-ipc.js'), 'utf8')
  assert.match(ipc, /handle\('image-ocr', \(event, args\) => \{ object\(args, \['id'\]\)/)
  assert.match(ipc, /handle\('image-table', \(event, args\) => \{ object\(args, \['id'\]\)/)
  assert.match(ipc, /handle\('image-pin', \(event, args\) => \{ object\(args, \['id'\]\)/)
  assert.match(ipc, /handle\('copy-text', \(event, args\) => \{/)
  assert.match(ipc, /Buffer\.byteLength\(args\.text, 'utf8'\) > 1024 \* 1024/)
  // No image action accepts a filesystem path from the page.
  assert.doesNotMatch(ipc, /object\(args, \[[^\]]*'path'/)
})

test('N02 main: copy-text validates its payload and writes through the main process', async () => {
  const h = mainHarness()
  await h.open()
  const response = await h.invoke('clipboard:copy-text', { text: 'recognized text' })
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.equal(response.result, true)
  assert.deepEqual(h.copiedTexts, ['recognized text'])

  for (const args of [
    [{ text: 42 }, 'INVALID_TEXT'],
    [{}, 'INVALID_TEXT'],
    [{ text: 'x'.repeat(1024 * 1024 + 1) }, 'INVALID_TEXT'],
    [{ text: 'ok', filePath: '/tmp/x' }, 'INVALID_ARGUMENT']
  ]) {
    const rejected = await h.invoke('clipboard:copy-text', args[0])
    assert.equal(errorCode(rejected), args[1])
  }
  assert.deepEqual(h.copiedTexts, ['recognized text'], 'a rejected payload never reaches the clipboard')
})

test('N02 does not add any network capability', () => {
  for (const file of [
    'main/domains/clipboard/index.js',
    'main/ipc/clipboard-ipc.js',
    'clipboard/clipboard.js',
    'preload-clipboard.js'
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/(?!schemas\.)/i, `${file} stays offline`)
  }
})

// ---------------------------------------------------------------------------
// 5. Renderer: preview action bar + image context menu
// ---------------------------------------------------------------------------

test('N02 renderer: the preview layer and the image context menu expose the three actions', () => {
  const html = fs.readFileSync(path.join(ROOT, 'clipboard', 'clipboard.html'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'clipboard', 'clipboard.css'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'clipboard', 'clipboard.js'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'preload-clipboard.js'), 'utf8')
  for (const [id, key] of [
    ['previewOcr', 'clipboard.action.ocr'],
    ['previewTable', 'clipboard.action.table'],
    ['previewPin', 'clipboard.action.pin'],
    ['menuOcr', 'clipboard.action.ocr'],
    ['menuTable', 'clipboard.action.table'],
    ['menuPin', 'clipboard.action.pin']
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-i18n="${key.replaceAll('.', '\\.')}"`), `${id} is a localized control`)
  }
  assert.match(html, /<div id="contextMenu" class="context-menu" role="menu"/)
  assert.match(html, /<section id="ocr" class="ocr-sheet" role="dialog"[^>]*aria-labelledby="ocrTitle"/)
  assert.match(html, /id="ocrCopy"[^>]*data-i18n="clipboard\.ocr-copy"/)
  assert.match(html, /id="ocrClose"[^>]*data-i18n-aria-label="clipboard\.ocr-close"/)
  assert.match(html, /id="previewNotice"[^>]*role="status"/)
  // The renderer talks to the main process through the dedicated preload only.
  for (const method of ['imageOcr', 'imageTable', 'imagePin', 'copyText']) {
    assert.match(preload, new RegExp(`${method}:`), `${method} is exposed by preload-clipboard.js`)
  }
  assert.match(script, /\$\('previewOcr'\)\.onclick = \(\) => runImageAction\('ocr'/)
  assert.match(script, /tile\.oncontextmenu = \(event\) => openContextMenu\(item, event\)/)
  assert.match(css, /\.context-menu\s*\{[^}]*position:\s*fixed/)
  assert.match(css, /\.preview-notice\[data-tone="danger"\]/)
  // No raw colours in the new styles (the panel stays on the token ladder).
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i)
})

test('N02 renderer: the context menu runs OCR, disables duplicate clicks and shows the text', async () => {
  let resolveOcr = null
  const h = await rendererWith({
    imageOcr: () => new Promise((resolve) => { resolveOcr = resolve })
  })
  const tile = imageTile(h)
  const event = { clientX: 30, clientY: 40, preventDefault() {}, stopPropagation() {} }
  tile.oncontextmenu(event)
  assert.equal(h.get('contextMenu').hidden, false, 'right-click opens the image action menu')
  assert.equal(h.get('menuOcr').disabled, false)

  h.get('menuOcr').onclick()
  await settle(2)
  h.get('menuOcr').onclick()
  await settle(2)
  assert.deepEqual(h.imageActions.ocr, [ITEM], 'a second click is ignored while the action runs')
  for (const id of ['menuOcr', 'menuTable', 'menuPin', 'previewOcr', 'previewTable', 'previewPin']) {
    assert.equal(h.get(id).disabled, true, `${id} is disabled while the action runs`)
  }
  assert.equal(h.get('contextMenu').hidden, true, 'the menu closes when its action starts')

  resolveOcr({ ok: true, result: { text: 'Line one\nLine two', lineCount: 2, lowResolution: false } })
  await settle(4)
  assert.equal(h.get('ocr').hidden, false, 'the OCR result sheet opens')
  assert.equal(h.get('ocrText').textContent, 'Line one\nLine two')
  assert.match(textOf(h.get('ocrMeta')), /clipboard\.ocr-lines/)
  for (const id of ['menuOcr', 'previewOcr']) assert.equal(h.get(id).disabled, false, `${id} is usable again`)

  h.get('ocrCopy').onclick()
  await settle(3)
  assert.deepEqual(h.textWrites, ['Line one\nLine two'], 'the copy button sends the exact recognized text')
  assert.match(textOf(h.get('ocrNotice')), /clipboard\.ocr-copied/)
})

test('N02 renderer: OCR failure and the empty result are both reported in the preview', async () => {
  const failing = await rendererWith({
    imageOcr: () => Promise.resolve({ ok: false, error: { code: 'OCR_FAILED' } })
  })
  await openImagePreview(failing)
  failing.get('previewOcr').onclick()
  await settle(4)
  assert.equal(failing.get('previewNotice').hidden, false)
  assert.equal(failing.get('previewNotice').textContent, 'E:clipboard.error.ocr-failed')
  assert.equal(failing.get('previewNotice').getAttribute('data-tone'), 'danger')
  assert.equal(failing.get('ocr').hidden, true, 'a failure does not open an empty result sheet')
  assert.equal(failing.get('previewOcr').disabled, false)

  const empty = await rendererWith({
    imageOcr: () => Promise.resolve({ ok: true, result: { text: '', lineCount: 0, lowResolution: false } })
  })
  await openImagePreview(empty)
  empty.get('previewOcr').onclick()
  await settle(4)
  assert.equal(empty.get('ocr').hidden, false, 'an empty recognition still answers explicitly')
  assert.equal(empty.get('ocrText').textContent, 'clipboard.ocr-empty')
  assert.equal(empty.get('ocrCopy').disabled, true, 'there is nothing to copy')
})

test('N02 renderer: table and pin outcomes render the saved name and the pin fallback', async () => {
  const h = await rendererWith({
    imageTable: () => Promise.resolve({ ok: true, result: { saved: true, name: 'Highlighter_table.xlsx' } }),
    imagePin: () => Promise.resolve({ ok: true, result: { pinned: false, fallback: 'copied' } })
  })
  await openImagePreview(h)
  h.get('previewTable').onclick()
  await settle(4)
  const tableNotice = h.get('previewNotice').textContent
  assert.match(tableNotice, /^clipboard\.table-saved:/)
  assert.match(tableNotice, /Highlighter_table\.xlsx/)
  assert.equal(h.get('previewTable').disabled, false)

  h.get('previewPin').onclick()
  await settle(4)
  assert.equal(h.get('previewNotice').textContent, 'clipboard.pin-fallback', 'the degraded pin is stated explicitly')
  assert.equal(h.get('previewNotice').getAttribute('data-tone'), 'warn')

  const pinned = await rendererWith({ imagePin: () => Promise.resolve({ ok: true, result: { pinned: true, fallback: null } }) })
  await openImagePreview(pinned)
  pinned.get('previewPin').onclick()
  await settle(4)
  assert.equal(pinned.get('previewNotice').textContent, 'clipboard.pin-done')
  assert.equal(pinned.get('previewNotice').getAttribute('data-tone'), 'ok')

  const failedTable = await rendererWith({
    imageTable: () => Promise.resolve({ ok: false, error: { code: 'NO_TABLE' } })
  })
  await openImagePreview(failedTable)
  failedTable.get('previewTable').onclick()
  await settle(4)
  assert.equal(failedTable.get('previewNotice').textContent, 'E:clipboard.error.no-table')
  assert.equal(failedTable.get('previewNotice').getAttribute('data-tone'), 'danger')
  assert.equal(failedTable.get('previewTable').disabled, false)
})

test('N02 renderer: text records and the closed state never offer the image actions', async () => {
  const h = await rendererWith()
  // The context menu is wired per image tile only.
  const textRow = h.get('rows').querySelectorAll('[data-item-id]').find((node) => node.getAttribute('data-item-id') === OTHER)
  assert.ok(textRow, 'the text row is mounted')
  assert.equal(textRow.oncontextmenu, undefined, 'a text row has no image action menu')
  // Selecting a text record and firing a stray menu click must not reach main.
  textRow.onclick()
  await settle(2)
  h.get('menuOcr').onclick()
  await settle(2)
  assert.deepEqual(h.imageActions.ocr, [])
  assert.equal(h.get('contextMenu').hidden, true)
  // A hidden panel never opens the preview action bar.
  h.callbacks.Hidden()
  assert.equal(h.get('ocr').hidden, true)
})

// ---------------------------------------------------------------------------
// 6. Locale coverage
// ---------------------------------------------------------------------------

test('N02 locale: the new image-action copy exists in all three tables', () => {
  globalThis.__LOCALES = {}
  const localeFile = path.join(ROOT, 'shared', 'locales', 'clipboard.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  const tables = globalThis.__LOCALES
  const keys = [
    'clipboard.image-actions',
    'clipboard.action.ocr', 'clipboard.action.table', 'clipboard.action.pin',
    'clipboard.image-action-working', 'clipboard.ocr-title', 'clipboard.ocr-empty',
    'clipboard.ocr-lines', 'clipboard.ocr-low-resolution', 'clipboard.ocr-copy',
    'clipboard.ocr-copied', 'clipboard.ocr-close', 'clipboard.ocr-hint',
    'clipboard.table-saved', 'clipboard.table-dialog-title', 'clipboard.table-dialog-filter',
    'clipboard.table-sheet-name', 'clipboard.pin-done', 'clipboard.pin-fallback',
    'clipboard.error.not-image', 'clipboard.error.image-too-large',
    'clipboard.error.image-unavailable', 'clipboard.error.image-actions-unavailable',
    'clipboard.error.ocr-disabled', 'clipboard.error.ocr-unavailable',
    'clipboard.error.ocr-failed', 'clipboard.error.ocr-stopped', 'clipboard.error.no-table',
    'clipboard.error.table-failed', 'clipboard.error.pin-limit', 'clipboard.error.pin-failed',
    'clipboard.error.pin-unavailable', 'clipboard.error.clipboard-unavailable'
  ]
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    for (const key of keys) {
      assert.equal(typeof tables[language]?.[key], 'string', `${key} exists in ${language}`)
      assert.ok(tables[language][key].length > 0)
    }
    assert.match(tables[language]['clipboard.ocr-lines'], /\{count\}/, `${language} keeps the {count} placeholder`)
    assert.match(tables[language]['clipboard.table-saved'], /\{name\}/, `${language} keeps the {name} placeholder`)
  }
})
