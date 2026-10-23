'use strict'

// Nightshift UI contract for the clipboard history panel.
//
// The panel is a plain renderer page: no framework, no inline style, no private
// palette. These assertions pin the invariants the redesign introduced, so a
// later refactor cannot quietly fall back to a window-local theme, a second
// accent colour, a broken element/bridge contract or virtual rows that drift
// off the list pitch. They deliberately avoid pinning decorative class names;
// the roles (chip, primary action, LED rail, feedback view) are the contract.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.css'), 'utf8')
const script = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-clipboard.js'), 'utf8')
const domain = fs.readFileSync(path.join(root, 'main', 'domains', 'clipboard', 'index.js'), 'utf8')

const IDS = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])

test('the panel links shared/tokens.css before its own stylesheet', () => {
  // Load order is the whole mechanism: window CSS consumes the shared custom
  // properties, and a window-local sheet before the tokens would shadow them.
  const stylesheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map((match) => match[1])
  assert.deepEqual(stylesheets, ['../shared/tokens.css', 'clipboard.css'])
})

test('the panel toggles the Nightshift dark theme on <body> in both appearance paths', () => {
  // shared/tokens.css scopes its dark values to body.dark. Toggling
  // documentElement (as the old private :root.dark palette did) can never reach
  // those declarations, so the window would stay in the light palette.
  assert.doesNotMatch(css, /:root\.dark/)
  assert.doesNotMatch(script, /documentElement\.classList\.toggle\('dark'/)
  const toggles = script.match(/document\.body\.classList\.toggle\('dark'/g) || []
  assert.ok(toggles.length >= 2, 'onInit and onPasteResult both adopt the broadcast theme')
  assert.match(script, /api\.onInit\(/)
  assert.match(script, /api\.onPasteResult\(/)
})

test('the runtime accent override feeds --primary instead of a private --accent', () => {
  // settings.mainColor is applied as an inline custom property on <html>. The
  // stylesheet must consume --primary so that --primary-ink / --primary-text,
  // which the compiler derives from --primary, follow the user's colour.
  assert.match(script, /document\.documentElement\.style\.setProperty\('--primary', data\.mainColor\)/)
  assert.doesNotMatch(script, /--accent/)
  assert.doesNotMatch(css, /var\(--accent\)/)
  assert.match(css, /var\(--primary-ink\)/)
  assert.match(css, /var\(--primary-soft\)/)
})

test('every element id clipboard.js reads exists exactly once in the page', () => {
  // The renderer addresses the panel directly by id; a rename that misses one
  // side throws on the first click (or silently skips a state update).
  const referenced = [...new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]))]
  assert.ok(referenced.length >= 20, 'clipboard.js still drives the panel through direct ids')
  assert.deepEqual(referenced.filter((id) => !IDS.includes(id)), [], 'clipboard.js reads ids that clipboard.html does not define')
  const duplicates = IDS.filter((id, index) => IDS.indexOf(id) !== index)
  assert.deepEqual(duplicates, [], 'clipboard.html defines duplicate ids')
  // The critical ids are the panel's data contract: row list, filters, status
  // rail, inspector and paste-result view. They are also used by the automation
  // capture harness, so losing one breaks more than the UI.
  const contractIds = [
    'search', 'list', 'rows', 'empty', 'kinds', 'pinned', 'status', 'led', 'refresh',
    'copy', 'paste', 'pin', 'delete', 'clear', 'close', 'pause', 'new', 'more',
    'detail', 'detailBadge', 'detailMeta', 'text', 'media', 'image', 'truncated',
    'feedback', 'feedbackText'
  ]
  assert.deepEqual(contractIds.filter((id) => !IDS.includes(id)), [], 'the documented element-id contract stays intact')
})

test('every bridge call clipboard.js makes is exposed by its dedicated preload', () => {
  // The panel gets its own contextBridge surface; a method rename on either side
  // fails at the first invocation, not at load, so pin the pair together.
  const calls = [...new Set([...script.matchAll(/\bapi\.([A-Za-z]+)\(/g)].map((match) => match[1]))]
  assert.ok(calls.length >= 10, 'the renderer talks to the main process')
  const exposed = preload.match(/exposeInMainWorld\('clipboardAPI', \{([\s\S]*?)\n\}\)/)
  assert.ok(exposed, 'preload-clipboard.js exposes clipboardAPI')
  assert.deepEqual(calls.filter((name) => !new RegExp(`\\b${name}\\s*:`).test(exposed[1])), [],
    'clipboard.js calls a bridge method that the preload does not expose')
  assert.match(domain, /path\.join\(rootDirectory, 'clipboard', 'clipboard\.html'\)/)
  assert.match(domain, /path\.join\(rootDirectory, 'preload-clipboard\.js'\)/)
})

test('the kind filter is a chip group whose pressed state is the selection', () => {
  // The redesign replaced the <select> with a chip row: one filter is always
  // pressed, and the pressed chip is the selected kind. The four values are the
  // backend's kind contract, not decoration.
  const kinds = [...html.matchAll(/<button[^>]*class="chip"[^>]*data-kind="([^"]*)"/g)].map((match) => match[1])
  assert.deepEqual(kinds, ['', 'text', 'url', 'image'])
  assert.match(html, /data-kind=""[^>]*aria-pressed="true"/)
  const pressed = html.match(/aria-pressed="true"/g) || []
  assert.equal(pressed.length, 1, 'exactly one filter is pressed on open')
  // One delegated listener on the group; the state lives in aria-pressed.
  assert.match(script, /\$\('kinds'\)\.onclick/)
  assert.match(script, /closest\?\.\('button\[data-kind\]'\)/)
  assert.match(script, /kind = button\.getAttribute\('data-kind'\) \|\| ''/)
  assert.match(script, /chip\.setAttribute\('aria-pressed'/)
  assert.match(script, /kind, pinnedOnly/)
  // The retired native <select> must not come back as a second control.
  assert.doesNotMatch(html, /<select/)
})

test('the pinned filter is a toggle button, not a checkbox', () => {
  assert.match(html, /<button[^>]*id="pinned"[^>]*class="chip"[^>]*aria-pressed="false"/)
  assert.doesNotMatch(html, /<input[^>]*id="pinned"/)
  assert.match(script, /\$\('pinned'\)\.onclick/)
  assert.match(script, /pinnedOnly = !pinnedOnly/)
  assert.match(script, /\$\('pinned'\)\.setAttribute\('aria-pressed', String\(pinnedOnly\)\)/)
  assert.match(css, /#pinned\[aria-pressed="true"\]::before/)
})

test('the paste-result state swaps the panel for the #feedback result view', () => {
  // body.feedback-only is the documented state switch: the panel chrome hides,
  // #feedback becomes the whole window, and its LED is toned by data-tone.
  assert.match(script, /document\.body\.classList\.add\('feedback-only'\)/)
  assert.match(script, /document\.body\.classList\.remove\('feedback-only'\)/)
  const hiddenBlock = css.match(/\.feedback-only \.topbar,[\s\S]*?display:\s*none !important;/)
  assert.ok(hiddenBlock, 'the feedback-only state hides the panel chrome')
  for (const selector of ['.topbar', '.status-rail', '.search-row', '.chips', '#new', '#list', '#more', '#detail', '.footer']) {
    assert.ok(hiddenBlock[0].includes(`.feedback-only ${selector}`), `feedback-only hides ${selector}`)
  }
  assert.match(html, /<div id="feedback"[^>]*role="status"[^>]*aria-live="polite"/)
  assert.match(html, /id="feedbackText"/)
  assert.match(script, /\$\('feedbackText'\)\.textContent = t\(key\)/)
  assert.match(script, /\$\('feedback'\)\.setAttribute\('data-tone'/)
  for (const tone of ['ok', 'warn', 'danger']) {
    assert.match(css, new RegExp(`#feedback\\[data-tone="${tone}"\\]`), `feedback tone ${tone} has a colour`)
  }
  // The dismiss countdown matches the four-second hold in the main process, so
  // the bar is an honest timer rather than decoration.
  assert.match(css, /animation:\s*feedback-dismiss 4s linear forwards/)
})

test('the page keeps the locked clipboard CSP and stays inline-script/style free', () => {
  for (const directive of [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", 'img-src highlighter-clipboard:',
    "connect-src 'none'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", "frame-src 'none'"
  ]) {
    assert.ok(html.includes(directive), `CSP keeps ${directive}`)
  }
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline script')
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attributes')
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'no inline event handlers')
  // img-src only allows the preview protocol, so a stylesheet image asset would
  // be blocked (and log a CSP error); the glyphs are drawn with CSS rules.
  assert.doesNotMatch(css, /url\(/)
})

test('grid geometry has one source: CSS custom properties read by the renderer', () => {
  // Mixed image/text rows have no single pitch, so the old "rowHeight constant
  // equals .row height" lockstep is gone. The invariant that replaced it: every
  // geometry value is declared once in the stylesheet, the renderer only reads
  // it, and the spacer/row positions come from the layout model instead of
  // index arithmetic.
  const listBlock = css.match(/#list\s*\{[^}]*\}/)
  assert.ok(listBlock, 'clipboard.css declares the #list styling block')
  for (const variable of ['--row-h', '--cell-h', '--grid-gap', '--grid-pad-x', '--tile-target', '--tile-min']) {
    assert.match(listBlock[0], new RegExp(`${variable}\\s*:\\s*\\d+(\\.\\d+)?px`), `${variable} is declared on #list`)
  }
  // Declared on #list, never on :root (the window must not own a private palette).
  assert.doesNotMatch(css, /:root\s*\{/)
  assert.match(css, /\.row\s*\{[^}]*?height:\s*var\(--row-h\)/, 'the text row consumes --row-h')
  assert.match(css, /\.grid-row\s*\{[^}]*?height:\s*var\(--cell-h\)/, 'the image row consumes --cell-h')
  assert.doesNotMatch(css, /\.row\s*\{[^}]*?height:\s*\d+px/, 'the text row no longer hardcodes its height')
  // The retired dual-write: no script constant and no index arithmetic.
  assert.doesNotMatch(script, /const rowHeight\s*=\s*\d+/)
  assert.doesNotMatch(script, /index \* rowHeight/)
  for (const variable of ['--row-h', '--cell-h', '--grid-gap', '--grid-pad-x', '--tile-target', '--tile-min']) {
    assert.ok(script.includes(`getPropertyValue('${variable}')`) || script.includes(`'${variable}'`), `the renderer reads ${variable}`)
  }
  assert.ok(script.includes('${model.height}px'), 'the spacer follows the layout model')
  assert.ok(script.includes('${row.y}px'), 'each row is positioned by the layout model')
  // DPR is part of the metrics contract: without it a window moved to a display
  // with another scale factor would keep the old column count.
  assert.match(script, /devicePixelRatio/)
})

test('image records render as thumbnails only, with no visible copy', () => {
  // The three requested behaviours, pinned: a thumbnail plate, no caption, and
  // no detail sheet opened by selecting a row.
  assert.match(script, /className = 'tile'/)
  assert.match(script, /className = 'grid-row'/)
  assert.match(script, /role', 'presentation'/)
  // The tile is described for assistive tech, not painted with text.
  assert.match(script, /setAttribute\('aria-label', imageLabel\(item\)\)/)
  assert.doesNotMatch(script, /appendText\([^)]*'row-preview'[^)]*clipboard\.image-size/)
  // No visible per-tile caption or metadata line.
  const tileRenderer = script.slice(script.indexOf('function renderImageRow'), script.indexOf('function retryThumbnail'))
  assert.doesNotMatch(tileRenderer, /appendText\(/)
  assert.doesNotMatch(tileRenderer, /row-meta/)
  assert.doesNotMatch(tileRenderer, /\.textContent\s*=/)
  // Selection must not fetch a detail entry: that was the removed interaction.
  const selectBody = script.slice(script.indexOf('async function select('), script.indexOf('async function openDetail'))
  assert.doesNotMatch(selectBody, /api\.detail/)
  assert.doesNotMatch(selectBody, /\$\('detail'\)\.hidden\s*=\s*false/)
})

test('thumbnail plates load through the batched capability protocol', () => {
  // One call issues every token, so consecutive previews cannot revoke each
  // other; and a failed load gets exactly one retry because hiding the panel
  // revokes tokens and would otherwise leave a tile blank forever.
  assert.match(script, /api\.previews\(/)
  assert.doesNotMatch(script, /api\.preview\(/)
  assert.match(script, /addEventListener\('error'/)
  assert.match(script, /THUMB_RETRY_MS/)
  assert.match(script, /data-state', 'failed'/)
  assert.match(css, /\.tile\[data-state="failed"\]/)
})

test('the full-text sheet overlays the list instead of shrinking it', () => {
  // The reported bug was that opening the sheet squeezed the history list and
  // could not be undone. An absolutely positioned sheet never reflows #list.
  assert.match(css, /\.list-wrap\s*\{[^}]*position:\s*relative/)
  assert.match(css, /\.detail\s*\{[^}]*position:\s*absolute/)
  assert.match(css, /\.detail\s*\{[^}]*bottom:\s*0/)
  assert.doesNotMatch(css, /\.detail\s*\{[^}]*flex:\s*0 1 auto/)
  // Superseded by the footer action row: the retired in-sheet action block.
  assert.doesNotMatch(css, /\.detail-actions/)
  // The sheet is closable: Escape closes the sheet before the panel.
  assert.match(script, /if \(!\$\('detail'\)\.hidden\) \{ clearDetail\(\); return \}/)
})

test('record actions live in the footer so no selection is required to reach them', () => {
  // Copy/Paste/Show-full-text/Pin/Delete used to sit inside the detail sheet,
  // which only existed for the selected record. They are chrome now.
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
  for (const id of ['copy', 'paste', 'view', 'pin', 'delete', 'clear']) {
    assert.match(footer, new RegExp(`id="${id}"`), `${id} lives in the footer`)
  }
  const detail = html.slice(html.indexOf('id="detail"'), html.indexOf('</section>', html.indexOf('id="detail"')))
  for (const id of ['copy', 'paste', 'pin', 'delete']) {
    assert.doesNotMatch(detail, new RegExp(`id="${id}"`), `${id} no longer lives inside #detail`)
  }
  assert.match(html, /id="view"[^>]*aria-expanded="false"[^>]*aria-controls="detail"/)
})

test('the panel speaks Nightshift: surface ladder, mono metadata, display title', () => {
  // Depth comes from the ladder, not from borders or shadows, and metadata is
  // set in the mono face so the panel reads as an instrument strip.
  for (const token of ['--bg', '--surface', '--surface-2', '--surface-3']) {
    assert.ok(css.includes(`var(${token})`), `the surface ladder uses ${token}`)
  }
  for (const selector of ['.row-meta', '.detail-meta', '.status-rail']) {
    const block = css.match(new RegExp(`${selector.replace('.', '\\.') }\\s*\\{[^}]*\\}`))
    assert.ok(block, `${selector} rule exists`)
    assert.match(block[0], /font-family:\s*var\(--font-mono\)/, `${selector} metadata is mono`)
  }
  assert.match(css, /\.topbar h1\s*\{[^}]*font-family:\s*var\(--font-display\)/, 'the panel title uses the display face')
})

test('the accent is reserved for selection, active filter and the primary action', () => {
  // Nightshift has exactly one accent. It marks the selected row, the active
  // chip/toggle and the primary Copy action; status uses --ok/--warn/--danger.
  assert.match(css, /\.row\[aria-selected="true"\]\s*\{[^}]*box-shadow:\s*inset 2px 0 0 var\(--primary\)/)
  assert.match(css, /\.chip\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--primary-text\)[^}]*background:\s*var\(--primary-soft\)/)
  assert.match(css, /\.button\.primary\s*\{[^}]*color:\s*var\(--primary-ink\)[^}]*background:\s*var\(--primary\)/)
  assert.match(html, /id="copy"[^>]*class="button primary"/)
  // The LED rail reports status, not a second accent.
  assert.match(css, /\.led\s*\{[^}]*background:\s*var\(--ok\)/)
  assert.match(css, /\.led\.tone-danger\s*\{[^}]*var\(--danger\)/)
  assert.match(script, /\$\('led'\)\.className = `led tone-\$\{tone\}`/)
  // The retired Ant blue must not return anywhere in the panel.
  assert.doesNotMatch(css, /#1677ff|#1890ff|rgba?\(22,\s*135,\s*255/)
})

test('every clipboard key the panel uses resolves in all three locale tables', () => {
  // A key missing from one table renders as the raw key in that language. The
  // redesign added a local-only badge, a parameterized count and the result
  // eyebrow, so check the panel's whole key surface, not just the old copy.
  globalThis.__LOCALES = {}
  const localeFile = path.join(root, 'shared', 'locales', 'clipboard.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  const tables = globalThis.__LOCALES
  const languages = ['zh-CN', 'en-US', 'zh-TW']
  const used = new Set()
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(match[1])
  for (const match of script.matchAll(/(['"])(clipboard\.[a-z0-9.-]+)\1/g)) used.add(match[2])
  const keys = [...used].filter((key) => key.startsWith('clipboard.'))
  assert.ok(keys.length >= 15, 'the panel resolves its copy through locale keys')
  const missing = []
  for (const key of keys) {
    for (const language of languages) {
      if (!Object.hasOwn(tables[language] || {}, key)) missing.push(`${key} (${language})`)
    }
  }
  assert.deepEqual(missing, [], 'a missing table entry would render the raw key')
  // Copy added by this redesign, present symmetrically.
  for (const key of ['clipboard.badge.local', 'clipboard.count', 'clipboard.pinned-count', 'clipboard.result.eyebrow']) {
    for (const language of languages) assert.ok(Object.hasOwn(tables[language], key), `${key} exists in ${language}`)
  }
  // The status rail fragments are parameterized; a translation that drops
  // {count} would silently print a count-less label.
  for (const language of languages) {
    assert.match(tables[language]['clipboard.count'], /\{count\}/)
    assert.match(tables[language]['clipboard.pinned-count'], /\{count\}/)
  }
  // Every status phase the renderer can label has a key in every table.
  const phaseBlock = script.match(/const PHASE_TONE = \{([^}]*)\}/)
  assert.ok(phaseBlock, 'PHASE_TONE declares the status phases')
  const phases = new Set([...phaseBlock[1].matchAll(/([a-z-]+):/g)].map((match) => match[1]))
  phases.add('disabled')
  for (const phase of phases) {
    for (const language of languages) {
      assert.ok(Object.hasOwn(tables[language], `clipboard.phase.${phase}`), `clipboard.phase.${phase} exists in ${language}`)
    }
  }
})
