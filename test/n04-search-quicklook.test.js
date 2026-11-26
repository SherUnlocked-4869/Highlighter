// N04 (review report section 5.4): Space Quick Look and native file drag for the
// local search window. The renderer is driven only through structural assertions
// (it is a classic script that needs a real DOM); the main-process half is
// exercised behaviourally with temporary files and a fake IPC event, so no
// Electron process is required.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  createSearchDomain,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MARKDOWN_MAX_CHARACTERS,
  DRAG_ICON_FALLBACK_DATA_URL,
  classifyPreviewKind,
  previewUsesHashComments,
  formatPreviewJson,
  decodePreviewText,
  renderMarkdownPreview,
  highlightCodePreview
} = require('../main/domains/search')

const ROOT = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(ROOT, '.tmp-n04-test-'))
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let caseIndex = 0
function fixture(name, content) {
  const directory = fs.mkdtempSync(path.join(scratch, `case-${caseIndex++}-`))
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function fakeNativeImage() {
  const created = []
  return {
    created,
    api: {
      createFromDataURL (dataUrl) {
        const icon = {
          dataUrl,
          getSize: () => ({ width: 16, height: 16 }),
          resize: (options) => {
            const resized = { dataUrl, resizedTo: options }
            created.push(resized)
            return resized
          }
        }
        created.push(icon)
        return icon
      }
    }
  }
}

function createHarness(overrides = {}) {
  const settings = {
    mainColor: '#e5a44c',
    theme: 'light',
    search: {
      matchPath: true,
      maxResults: 600,
      pageSize: 30,
      sortMode: 'modified-desc',
      categories: [{ id: 'all', label: 'search.category.all', rule: '' }]
    }
  }
  const events = []
  const deps = {
    path,
    rootDirectory: ROOT,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    },
    clipboard: { writeText: () => {} },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { showItemInFolder: () => {}, openPath: async () => '' },
    BrowserWindow: { fromWebContents: (sender) => (sender && sender.win) || null },
    createLocalWindow: () => { throw new Error('the Quick Look tests need no window') },
    getSettings: () => settings,
    log: (event, details) => events.push({ event, details }),
    assertGameModeDisabled: () => {},
    isGameModeEnabled: () => false,
    getEverythingService: () => ({
      query: async () => ({ items: [], total: 0 }),
      refreshStatus: () => ({ phase: 'ready' }),
      ensureReady: async () => ({ phase: 'ready' })
    }),
    positionAutomationWindow: () => {},
    getSearchFileIcon: async () => 'data:image/png;base64,AAAA',
    setTimer: () => null,
    clearTimer: () => {},
    now: () => 0,
    ...overrides
  }
  const domain = createSearchDomain(deps)
  return { domain, controller: domain.createSearchController(), events, settings }
}

// The controller method is the handler behind `search:file-icon`; the event only
// matters for the drag branch, mirroring the real ipcMain contract.
function fakeDragEvent(startDrag = () => {}) {
  const calls = []
  return {
    calls,
    event: { sender: { startDrag: (item) => { calls.push(item); if (startDrag) startDrag(item) } } }
  }
}

function preview(controller, filePath) {
  return controller.getFileIcon({}, { path: filePath, action: 'preview' })
}

// ---------------------------------------------------------------------------
// Pure classifiers / renderers
// ---------------------------------------------------------------------------

test('N04 preview classification picks the right body for each file family', () => {
  assert.equal(classifyPreviewKind('C:\\shots\\photo.PNG'), 'image')
  assert.equal(classifyPreviewKind('C:\\shots\\photo.svg'), 'image')
  assert.equal(classifyPreviewKind('C:\\docs\\report.json'), 'json')
  assert.equal(classifyPreviewKind('C:\\docs\\readme.MD'), 'markdown')
  assert.equal(classifyPreviewKind('C:\\src\\main.js'), 'code')
  assert.equal(classifyPreviewKind('C:\\src\\main.py'), 'code')
  assert.equal(classifyPreviewKind('C:\\notes\\todo.txt'), 'text')
  assert.equal(classifyPreviewKind('C:\\notes\\README'), 'text')
  assert.equal(classifyPreviewKind('C:\\docker\\Dockerfile.dev'), 'text')
  assert.equal(classifyPreviewKind('C:\\files\\archive.zip'), 'info')
  assert.equal(classifyPreviewKind('C:\\files\\no-extension-here'), 'info')
  assert.equal(classifyPreviewKind(''), 'info')
  // Only hash-comment languages get the `#` comment token; a CSS hex colour must
  // not be mistaken for a comment.
  assert.equal(previewUsesHashComments('C:\\src\\tool.py'), true)
  assert.equal(previewUsesHashComments('C:\\src\\main.js'), false)
  assert.equal(previewUsesHashComments('C:\\web\\site.css'), false)
})

test('N04 JSON is re-indented when it parses and shown verbatim when it does not', () => {
  const formatted = formatPreviewJson('{"name":"highlighter","nested":{"ok":true},"count":2}')
  assert.equal(formatted.formatted, true)
  assert.equal(formatted.text, '{\n  "name": "highlighter",\n  "nested": {\n    "ok": true\n  },\n  "count": 2\n}')
  assert.equal(formatPreviewJson('[1,2,3]').text, '[\n  1,\n  2,\n  3\n]')
  assert.deepEqual(formatPreviewJson('not json at all'), { formatted: false, text: 'not json at all' })
  assert.deepEqual(formatPreviewJson(''), { formatted: false, text: '' })
})

test('N04 markdown renders a small safe subset and escapes raw HTML', () => {
  const html = renderMarkdownPreview('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n> quote\n').html
  assert.match(html, /<h2>Title<\/h2>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<ul>.*<li>one<\/li>.*<li>two<\/li>/)
  assert.match(html, /<blockquote>quote<\/blockquote>/)

  // A Markdown document in the search results is untrusted input.
  const escaped = renderMarkdownPreview('<script>alert(1)</script>\n\n**<img src=x onerror=alert(2)>**').html
  assert.doesNotMatch(escaped, /<script/)
  assert.doesNotMatch(escaped, /<img/)
  assert.match(escaped, /&lt;script&gt;/)
  assert.match(escaped, /&lt;img src=x onerror=alert\(2\)&gt;/)

  const fenced = renderMarkdownPreview('```js\nconst a = "<b>"\n```\n').html
  assert.match(fenced, /<pre class="preview-code-block"><code>const a = &quot;&lt;b&gt;&quot;<\/code><\/pre>/)

  const big = renderMarkdownPreview('# ' + 'a'.repeat(PREVIEW_MARKDOWN_MAX_CHARACTERS + 10))
  assert.equal(big.truncated, true)
  assert.equal(renderMarkdownPreview('# small').truncated, false)
})

test('N04 code tokens highlight comments, strings and numbers with no extra dependency', () => {
  const html = highlightCodePreview("const answer = 42 // comment\nconsole.log('hi')\n")
  assert.match(html, /<span class="preview-token-number">42<\/span>/)
  assert.match(html, /<span class="preview-token-comment">\/\/ comment<\/span>/)
  assert.match(html, /<span class="preview-token-string">&#39;hi&#39;<\/span>/)
  assert.match(html, /const answer = /)

  const hash = highlightCodePreview('# note\nvalue = 1\n', { hashComments: true })
  assert.match(hash, /<span class="preview-token-comment"># note<\/span>/)

  // Source code is untrusted too: markup characters must stay escaped.
  const escaped = highlightCodePreview('if (a < b) { /* <script> */ }')
  assert.doesNotMatch(escaped, /<script>/)
  assert.match(escaped, /a &lt; b/)
})

test('N04 text decoding drops a BOM, handles UTF-16 and flags binary content', () => {
  assert.deepEqual(decodePreviewText(Buffer.from('plain')), { binary: false, text: 'plain' })
  assert.equal(decodePreviewText(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69])).text, 'hi')
  // Notepad "Unicode" (UTF-16 LE with BOM) and its big-endian counterpart.
  assert.equal(decodePreviewText(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('hello', 'utf16le')])).text, 'hello')
  assert.equal(decodePreviewText(Buffer.from([0xFE, 0xFF, 0x00, 0x68, 0x00, 0x69])).text, 'hi')
  assert.deepEqual(decodePreviewText(Buffer.from([0x61, 0x00, 0x62])), { binary: true, text: '' })
  assert.deepEqual(decodePreviewText(null), { binary: false, text: '' })
})

// ---------------------------------------------------------------------------
// Main-process reader, reached through the real controller (fake IPC event)
// ---------------------------------------------------------------------------

test('N04 the main process reads text, JSON, Markdown and code payloads', async () => {
  const harness = createHarness()

  const textFile = fixture('todo.txt', '第一行\nsecond line\n')
  const textPayload = await preview(harness.controller, textFile)
  assert.equal(textPayload.ok, true)
  assert.equal(textPayload.kind, 'text')
  assert.equal(textPayload.text, '第一行\nsecond line\n')
  assert.equal(textPayload.name, 'todo.txt')
  assert.equal(textPayload.extension, 'txt')
  assert.equal(textPayload.path, textFile)
  assert.equal(textPayload.size, fs.statSync(textFile).size)
  assert.ok(textPayload.modifiedAt > 0)
  assert.equal(textPayload.truncated, false)

  const jsonFile = fixture('data.json', '{"ok":true,"items":[1,2]}')
  const jsonPayload = await preview(harness.controller, jsonFile)
  assert.equal(jsonPayload.kind, 'json')
  assert.equal(jsonPayload.formatted, true)
  assert.equal(jsonPayload.text, '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}')

  const markdownFile = fixture('note.md', '# Hi\n\n- item\n')
  const markdownPayload = await preview(harness.controller, markdownFile)
  assert.equal(markdownPayload.kind, 'markdown')
  assert.match(markdownPayload.html, /<h2>Hi<\/h2>/)
  assert.match(markdownPayload.html, /<li>item<\/li>/)

  const codeFile = fixture('main.js', 'const n = 7 // seven\n')
  const codePayload = await preview(harness.controller, codeFile)
  assert.equal(codePayload.kind, 'code')
  assert.match(codePayload.html, /preview-token-comment/)
  assert.match(codePayload.html, /preview-token-number/)
})

test('N04 the 512 KB text limit truncates oversized files and reports it', async () => {
  const harness = createHarness()
  const oversized = fixture('huge.log', Buffer.alloc(PREVIEW_TEXT_MAX_BYTES + 128, 0x61))
  const payload = await preview(harness.controller, oversized)
  assert.equal(payload.kind, 'text')
  assert.equal(payload.truncated, true)
  assert.equal(payload.limitBytes, PREVIEW_TEXT_MAX_BYTES)
  assert.ok(payload.text.length <= PREVIEW_TEXT_MAX_BYTES)
  assert.ok(payload.text.length > 0)

  const exact = fixture('exact.txt', Buffer.alloc(PREVIEW_TEXT_MAX_BYTES, 0x62))
  const exactPayload = await preview(harness.controller, exact)
  assert.equal(exactPayload.truncated, false)
  assert.equal(exactPayload.text.length, PREVIEW_TEXT_MAX_BYTES)
})

test('N04 images come back as a bounded data URL and huge images as information', async () => {
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const harness = createHarness()
  const imageFile = fixture('pixel.png', tinyPng)
  const payload = await preview(harness.controller, imageFile)
  assert.equal(payload.kind, 'image')
  assert.equal(payload.mime, 'image/png')
  assert.equal(payload.dataUrl, `data:image/png;base64,${tinyPng.toString('base64')}`)
  assert.ok(payload.dataUrl.length < 1024)

  const limited = createHarness({ previewLimits: { imageBytes: 16 } })
  const bigImage = fixture('big.png', Buffer.alloc(64, 0x89))
  const limitedPayload = await preview(limited.controller, bigImage)
  assert.equal(limitedPayload.kind, 'info')
  assert.equal(limitedPayload.reason, 'image-too-large')
  assert.equal(limitedPayload.limitBytes, 16)
  assert.equal(limitedPayload.dataUrl, undefined)
})

test('N04 folders, binaries, unknown types and missing files degrade to information', async () => {
  const harness = createHarness()

  const folder = fs.mkdtempSync(path.join(scratch, 'directory-'))
  const folderPayload = await preview(harness.controller, folder)
  assert.equal(folderPayload.ok, true)
  assert.equal(folderPayload.kind, 'info')
  assert.equal(folderPayload.reason, 'directory')

  const binary = fixture('looks.txt', Buffer.from([0x61, 0x00, 0x62, 0x63]))
  const binaryPayload = await preview(harness.controller, binary)
  assert.equal(binaryPayload.kind, 'info')
  assert.equal(binaryPayload.reason, 'binary')

  const empty = fixture('empty.txt', '')
  const emptyPayload = await preview(harness.controller, empty)
  assert.equal(emptyPayload.kind, 'info')
  assert.equal(emptyPayload.reason, 'empty')
  assert.equal(emptyPayload.size, 0)

  const unknown = fixture('thing.weird', Buffer.from([1, 2, 3]))
  const unknownPayload = await preview(harness.controller, unknown)
  assert.equal(unknownPayload.kind, 'info')
  assert.equal(unknownPayload.reason, 'unsupported')
  assert.equal(unknownPayload.name, 'thing.weird')
  assert.ok(unknownPayload.size > 0)
  assert.ok(unknownPayload.modifiedAt > 0)

  assert.deepEqual(await preview(harness.controller, path.join(scratch, 'does-not-exist.txt')), {
    ok: false,
    reason: 'missing',
    path: path.join(scratch, 'does-not-exist.txt')
  })
  assert.deepEqual(await preview(harness.controller, 'relative.txt'), { ok: false, reason: 'invalid-path' })
  assert.deepEqual(await preview(harness.controller, ''), { ok: false, reason: 'invalid-path' })

  // The legacy payload shape still routes to the icon lookup, which is called with
  // the value it always received (an absent path stays absent).
  const requested = []
  const iconHarness = createHarness({ getSearchFileIcon: async (samplePath) => { requested.push(samplePath); return null } })
  assert.equal(await iconHarness.controller.getFileIcon({}, null), null)
  assert.deepEqual(requested, [undefined])
})

// ---------------------------------------------------------------------------
// Native drag
// ---------------------------------------------------------------------------

test('N04 drag starts a native drag with the file icon and the resolved path', async () => {
  const native = fakeNativeImage()
  const harness = createHarness({ nativeImage: native.api })
  const file = fixture('draggable.txt', 'drag me')
  const { event, calls } = fakeDragEvent()
  const fileIcon = 'data:image/png;base64,ICON'

  const result = harness.controller.getFileIcon(event, { path: file, action: 'drag', icon: fileIcon })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, path.resolve(file))
  assert.equal(calls[0].icon.dataUrl, fileIcon)
  // The 16px shell icon is upscaled for the drag image.
  assert.equal(calls[0].icon.resizedTo.width, 32)
  assert.equal(calls[0].icon.resizedTo.height, 32)
})

test('N04 drag falls back to the bundled placeholder for a missing or invalid icon', async () => {
  const native = fakeNativeImage()
  const harness = createHarness({ nativeImage: native.api })
  const file = fixture('plain.txt', 'x')
  const { event, calls } = fakeDragEvent()

  const noIcon = harness.controller.getFileIcon(event, { path: file, action: 'drag' })
  assert.equal(noIcon.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(native.created[0].dataUrl, DRAG_ICON_FALLBACK_DATA_URL)
  assert.match(DRAG_ICON_FALLBACK_DATA_URL, /^data:image\/png;base64,/)

  for (const invalid of ['javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/png;base64,' + 'A'.repeat(300 * 1024)]) {
    const before = native.created.length
    const result = harness.controller.getFileIcon(event, { path: file, action: 'drag', icon: invalid })
    assert.equal(result.ok, true)
    assert.equal(native.created[before].dataUrl, DRAG_ICON_FALLBACK_DATA_URL, 'an unusable icon never reaches startDrag')
  }
})

test('N04 drag still starts when the platform image factory is unavailable', async () => {
  const native = {
    api: {
      createFromDataURL: () => { throw new Error('no nativeImage here') }
    }
  }
  const harness = createHarness({ nativeImage: native.api })
  const file = fixture('no-icon.txt', 'x')
  const { event, calls } = fakeDragEvent()

  const result = harness.controller.getFileIcon(event, { path: file, action: 'drag', icon: 'data:image/png;base64,AAAA' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, path.resolve(file))
  assert.equal(calls[0].icon, undefined, 'startDrag is called without an icon rather than not at all')
})

test('N04 drag refuses folders, missing files and relative paths silently', async () => {
  const native = fakeNativeImage()
  const harness = createHarness({ nativeImage: native.api })
  const folder = fs.mkdtempSync(path.join(scratch, 'drag-folder-'))
  const file = fixture('kept.txt', 'x')
  const { event, calls } = fakeDragEvent()

  assert.deepEqual(await harness.controller.getFileIcon(event, { path: folder, action: 'drag' }), { ok: false })
  assert.deepEqual(await harness.controller.getFileIcon(event, { path: path.join(scratch, 'gone.txt'), action: 'drag' }), { ok: false })
  assert.deepEqual(await harness.controller.getFileIcon(event, { path: 'relative.txt', action: 'drag' }), { ok: false })
  assert.deepEqual(await harness.controller.getFileIcon(event, { path: `${file}\u0000`, action: 'drag' }), { ok: false })
  assert.equal(calls.length, 0, 'a refused drag must never reach webContents.startDrag')
})

test('N04 a throwing or unavailable startDrag stays silent and returns false', async () => {
  const native = fakeNativeImage()
  const harness = createHarness({ nativeImage: native.api })
  const file = fixture('fragile.txt', 'x')

  const throwing = fakeDragEvent(() => { throw new Error('native drag unavailable') })
  assert.deepEqual(await harness.controller.getFileIcon(throwing.event, { path: file, action: 'drag' }), { ok: false })
  assert.equal(throwing.calls.length, 1)
  assert.ok(harness.events.some((entry) => entry.event === 'Search drag start failed:'))

  assert.deepEqual(await harness.controller.getFileIcon({}, { path: file, action: 'drag' }), { ok: false })
  assert.deepEqual(await harness.controller.getFileIcon({ sender: {} }, { path: file, action: 'drag' }), { ok: false })
})

test('N04 the existing icon lookup is preserved when no action is sent', async () => {
  const requested = []
  const harness = createHarness({
    getSearchFileIcon: async (samplePath) => { requested.push(samplePath); return 'data:image/png;base64,PLAIN' }
  })
  const file = fixture('icon.txt', 'x')
  assert.equal(await harness.controller.getFileIcon({}, { path: file }), 'data:image/png;base64,PLAIN')
  assert.deepEqual(requested, [file])
})

// ---------------------------------------------------------------------------
// Renderer / preload wiring (structural: the renderer needs a real DOM and the
// existing repo tests use structural assertions for this window)
// ---------------------------------------------------------------------------

test('N04 the search window markup exposes an accessible Quick Look dialog', () => {
  const html = fs.readFileSync(path.join(ROOT, 'search', 'search.html'), 'utf8')
  assert.match(html, /id="quickLook"[^>]*role="dialog"/)
  assert.match(html, /id="quickLook"[^>]*aria-labelledby="quickLookTitle"/)
  assert.match(html, /id="quickLookBody"[^>]*aria-live="polite"/)
  assert.match(html, /id="quickLookBody"[^>]*aria-atomic="true"/)
  assert.match(html, /id="quickLookClose"[^>]*data-i18n-aria-label="search\.preview\.close"/)
  assert.match(html, /id="quickLookClose"[^>]*aria-label="Close preview"/)
  // The static fallback must not hard-code Chinese; the locale table owns it.
  assert.doesNotMatch(html, /[\u4e00-\u9fff]/)
})

test('N04 the hidden overlay is not painted (author display vs the hidden attribute)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'search', 'search.css'), 'utf8')
  // `.quick-look { display: flex }` would beat the user-agent `[hidden]` rule; the
  // stylesheet must keep an explicit hidden rule or the "closed" overlay stays
  // visible. Verified against a real renderer by the ticket probe.
  assert.match(css, /\[hidden\] \{ display: none !important; \}/)
  assert.match(css, /\.quick-look \{[\s\S]*?display: flex;/)
})

test('N04 the renderer toggles the preview from Space and keeps the search box focused', () => {
  const script = fs.readFileSync(path.join(ROOT, 'search', 'search.js'), 'utf8')
  // Space/Escape precedence: preview first, window close second.
  const escape = script.indexOf("if (event.key === 'Escape')")
  assert.ok(escape > 0, 'Escape is handled in the window keydown handler')
  assert.ok(script.indexOf('if (quickLook.open) {', escape) > escape)
  assert.ok(script.indexOf('closeQuickLook()', escape) > escape)
  assert.match(script, /event\.key === ' ' && !event\.ctrlKey/)
  assert.match(script, /openQuickLook\(item\)/)
  // Preview content follows the active selection, and a new query retires it.
  assert.match(script, /if \(quickLook\.open\) syncQuickLook\(\)/)
  assert.match(script, /if \(quickLook\.open\) closeQuickLook\(\)/)
  assert.doesNotMatch(script, /[\u4e00-\u9fff]/, 'no hard-coded Chinese copy in the search renderer')
  // All user-visible preview copy comes from the locale table.
  for (const key of [
    'search.preview.loading',
    'search.preview.unavailable',
    'search.preview.directory',
    'search.preview.binary',
    'search.preview.empty',
    'search.preview.image-too-large',
    'search.preview.truncated',
    'search.preview.json-invalid',
    'search.preview.info-title',
    'search.preview.name',
    'search.preview.path',
    'search.preview.size',
    'search.preview.modified'
  ]) {
    assert.match(script, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `${key} resolved through t()`)
  }
  assert.match(script, /searchAPI\.previewFile\(item\.fullPath\)/)
  // The overlay renders images with a bounded <img>, and metadata otherwise.
  assert.match(script, /className = 'quick-look-image'/)
  assert.match(script, /quickLookInfoMarkup\(payload, item\)/)
  assert.match(script, /els\.quickLookClose\.addEventListener\('click'/)
})

test('N04 result rows start a native drag and folders stay undraggable', () => {
  const script = fs.readFileSync(path.join(ROOT, 'search', 'search.js'), 'utf8')
  assert.match(script, /draggable="\$\{isFolderItem\(item\) \? 'false' : 'true'\}"/)
  assert.match(script, /addEventListener\('dragstart'/)
  const dragStart = script.indexOf("addEventListener('dragstart'")
  assert.ok(script.indexOf('event.preventDefault()', dragStart) > dragStart, 'the HTML5 drag is cancelled')
  assert.match(script, /isFolderItem\(item\) \|\| !item\.fullPath/)
  assert.match(script, /const icon = cacheKey \? state\.iconCache\.get\(cacheKey\) \|\| '' : ''/)
  assert.match(script, /searchAPI\.startDrag\(item\.fullPath, icon\)\.catch\(\(\) => \{\}\)/)
})

test('N04 the preload reuses the existing search:file-icon channel for preview and drag', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload-search.js'), 'utf8')
  assert.match(preload, /previewFile: \(path\) => ipcRenderer\.invoke\('search:file-icon', \{ path, action: 'preview' \}\)/)
  assert.match(preload, /startDrag: \(path, icon\) => ipcRenderer\.invoke\('search:file-icon', \{/)
  assert.match(preload, /action: 'drag'/)
  // The icon lookup keeps its original payload shape.
  assert.match(preload, /getFileIcon: \(path\) => ipcRenderer\.invoke\('search:file-icon', \{ path \}\)/)
})

test('N04 the three locale tables carry the same preview copy', () => {
  globalThis.__LOCALES = {}
  const localeFile = path.join(ROOT, 'shared', 'locales', 'search.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  const tables = globalThis.__LOCALES
  const keys = Object.keys(tables['zh-CN']).filter((key) => key.startsWith('search.preview.'))
  assert.ok(keys.length >= 14, 'every preview string is registered')
  for (const key of keys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} missing ${key}`)
      assert.ok(tables[language][key].length > 0, `${language} has an empty ${key}`)
    }
  }
  // English/Traditional columns are real translations, not copies of zh-CN.
  assert.notEqual(tables['en-US']['search.preview.close'], tables['zh-CN']['search.preview.close'])
  assert.notEqual(tables['zh-TW']['search.preview.close'], tables['zh-CN']['search.preview.close'])
})
