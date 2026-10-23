'use strict'

// Real-Electron runtime contract for the clipboard image grid.
//
// The static contract in test/clipboard-ui-contract.test.js pins the source-level
// invariants. This file MEASURES the panel in a real hidden BrowserWindow,
// because three of the handoff document's items cannot be proven from source
// text:
//
//   1. the accessibility tree really exposes the listbox's options as DIRECT
//      children (the #rows wrapper used to become a `generic` node in between);
//   2. the footer fits the 380 DIP minimum window without overflowing;
//   3. the column count the renderer computes is the column count the CSS
//      geometry implies (the layer that drifted in bug B3, design section 18.1).
//
// Plus the thumbnail wiring: a real <img> load through the preview protocol, and
// a failed record that still carries an accessible name.
//
// Host notes (root AGENTS.md):
//   * the child process needs ELECTRON_RUN_AS_NODE removed; this file does that
//     itself so it is runnable standalone and is a no-op where the variable is
//     unset;
//   * Chromium's sandbox cannot start in the confined automation host. The probe
//     is launched with the sandbox on first and retried with --no-sandbox (which
//     must precede the script path) only if that child dies, so a normal
//     desktop/CI host keeps the sandbox;
//   * a spawned Electron child cannot write the ambient %TEMP% there, so TMP/TEMP
//     and the Electron profile point into the checkout (`.tmp/`, gitignored);
//   * `show: false` keeps the user's only display free.
//
// Only ONE BrowserWindow may call loadFile per process on this host: the probe
// reuses its window and calls setContentSize() between measurements.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')

const css = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.css'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.js'), 'utf8')

// The locale tables are the source of the accessible names measured below.
const i18n = require(path.join(root, 'shared', 'i18n.js'))
require(path.join(root, 'shared', 'locales', 'clipboard.js'))
i18n.setLanguage('en-US')

// ---------------------------------------------------------------------------
// Fixture: six image records (one of them fails to produce a thumbnail), one
// text record and one URL record. Eight options in total, which is what makes
// the listbox-ownership count meaningful: with the old wrapper the listbox had
// exactly one generic child instead of eight options.
// ---------------------------------------------------------------------------
const imageIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666'
]
const failedId = imageIds[2]
const textId = 'a1f0c2e4-5b6d-4f8a-9c1d-2e3f4a5b6c71'
const urlId = 'b2e1d3f5-6c7a-4b9e-8d0f-1a2b3c4d5e62'
const stamp = 1792720271035
const items = [
  ...imageIds.map((id, index) => ({
    id,
    kind: 'image',
    isPinned: index === 1,
    previewText: '',
    sourceDisplayName: 'Snipper',
    lastCopiedAt: stamp - index * 60000,
    lastUsedAt: stamp - index * 60000,
    byteLength: 1200 + index,
    width: 640,
    height: 360
  })),
  { id: textId, kind: 'text', isPinned: false, previewText: 'hello world', sourceDisplayName: 'WeChat', lastCopiedAt: stamp, lastUsedAt: stamp, byteLength: 11 },
  { id: urlId, kind: 'url', isPinned: false, previewText: 'https://example.com', sourceDisplayName: 'Chrome', lastCopiedAt: stamp, lastUsedAt: stamp, byteLength: 19 }
]
const status = { phase: 'running', itemCount: items.length, pinnedCount: 1, actualDiskBytes: 1048576 }

// The stub preload mirrors preload-clipboard.js's shape. The panel is a plain
// page: this test is about DOM, geometry and the accessibility tree, NOT about
// the contextBridge boundary (test/window-security-runtime.test.js owns that).
const stubSource = `
window.clipboardAPI = (() => {
  const handlers = {}
  const on = (name) => (callback) => {
    handlers[name] = handlers[name] || []
    handlers[name].push(callback)
    return () => {}
  }
  const ok = (result) => ({ ok: true, result })
  return {
    ready() {
      setTimeout(() => {
        for (const callback of handlers.init || []) callback({
          language: 'en-US', dark: false, mainColor: '#e5a44c', generation: 'probe',
          status: ${JSON.stringify(status)}
        })
      }, 20)
    },
    interactive() {}, close() {},
    onInit: on('init'), onStatus: on('status'), onHistory: on('history'),
    onHidden: on('hidden'), onPasteResult: on('pasteResult'), onLanguage: on('language'),
    list: async () => ok({ items: ${JSON.stringify(items)}, cursor: null }),
    status: async () => ok(${JSON.stringify(status)}),
    detail: async () => ok({ kind: 'text', truncated: false, text: 'hello world' }),
    previews: async (ids) => ok(ids.map((id) => (
      id === ${JSON.stringify(failedId)} ? { id, error: 'NOT_FOUND' } : { id, url: 'highlighter-clipboard://preview/' + id }
    ))),
    copy: async () => ok({}), paste: async () => ok({}), setPinned: async () => ok({}),
    delete: async () => ok({}), prepareClear: async () => ok({}), commitClear: async () => ok({}),
    setPaused: async () => ok({})
  }
})()
`

// ---------------------------------------------------------------------------
// Static halves of the DPR-bucket contract (item 3 of the handoff, bug B3).
//
// The stylesheet declares the buckets that change the geometry; the renderer has
// to listen to a SUPERSET that includes every one of them, so crossing a CSS
// bucket boundary re-reads the metrics. Equality would be wrong: the renderer
// deliberately watches extra buckets (1.25 / 1.5 / 1.75 / 2 / 3) so that a plain
// scale-factor move between two displays is noticed too.
// ---------------------------------------------------------------------------
function parseDeclaredGeometry() {
  const block = css.match(/#list\s*\{[^}]*\}/)
  assert.ok(block, 'clipboard.css declares the #list styling block')
  const read = (name) => {
    const match = block[0].match(new RegExp(`${name}:\\s*([\\d.]+)px`))
    assert.ok(match, `clipboard.css declares ${name}`)
    return Number(match[1])
  }
  return {
    rowH: read('--row-h'),
    cellH: read('--cell-h'),
    gap: read('--grid-gap'),
    padX: read('--grid-pad-x'),
    target: read('--tile-target'),
    min: read('--tile-min')
  }
}

function parseCssBuckets() {
  const buckets = []
  for (const match of css.matchAll(/@media\s*\(min-resolution:\s*([\d.]+)dppx\)\s*\{\s*#list\s*\{([^}]*)\}/g)) {
    const cellH = match[2].match(/--cell-h:\s*([\d.]+)px/)
    buckets.push({ dppx: Number(match[1]), cellH: cellH ? Number(cellH[1]) : null })
  }
  return buckets.sort((left, right) => left.dppx - right.dppx)
}

function parseDprBuckets() {
  const match = renderer.match(/const DPR_BUCKETS = \[([^\]]+)\]/)
  assert.ok(match, 'clipboard.js declares DPR_BUCKETS')
  return match[1].split(',').map((value) => Number(value.trim()))
}

const declared = parseDeclaredGeometry()
const cssBuckets = parseCssBuckets()
const dprBuckets = parseDprBuckets()

test('every DPR bucket the stylesheet defines is one the renderer listens for', () => {
  assert.ok(cssBuckets.length > 0, 'clipboard.css declares at least one resolution bucket')
  // Each higher bucket must shrink the cell further: the whole point of the
  // media queries is that a 240 px native thumbnail is never upscaled, and the
  // base value is only defensible below the first bucket.
  const heights = [declared.cellH, ...cssBuckets.map((bucket) => bucket.cellH)]
  for (let index = 1; index < heights.length; index++) {
    assert.ok(heights[index] < heights[index - 1],
      `the ${cssBuckets[index - 1].dppx}dppx bucket must lower --cell-h below ${heights[index - 1]}px (got ${heights[index]}px)`)
  }
  for (const bucket of cssBuckets) {
    // The bug (design section 18.1, B3) was a CSS bucket the renderer never
    // observed: CSS switched the geometry while the layout model kept the old
    // cell height. A superset is correct; a missing entry is the regression.
    assert.ok(dprBuckets.includes(bucket.dppx),
      `clipboard.js DPR_BUCKETS does not listen for the CSS bucket ${bucket.dppx}dppx`)
  }
  assert.ok(dprBuckets.length > cssBuckets.length,
    'the renderer watches extra scale factors on top of the CSS buckets')
  // The extra buckets are load-bearing, not decoration: without a subscription
  // below the first CSS bucket, moving between a 1.25x and a 2x display never
  // fires a change event (no CSS bucket is crossed) and the layout keeps the old
  // geometry. This is the sibling failure mode of B3.
  assert.ok(dprBuckets.some((bucket) => bucket < cssBuckets[0].dppx),
    `DPR_BUCKETS needs a bucket below ${cssBuckets[0].dppx}dppx to notice a scale-factor move within one CSS bucket`)
  assert.deepEqual([...dprBuckets].sort((left, right) => left - right), dprBuckets,
    'DPR_BUCKETS is ascending, matching the stylesheet cascade order')
  // Each bucket is consumed through the media-query subscription, which is what
  // makes "in the array" mean "the renderer re-reads the geometry".
  assert.match(renderer, /matchMedia\(`\(resolution: \$\{bucket\}dppx\)`\)/)
  assert.match(renderer, /for \(const bucket of DPR_BUCKETS\)/)
})

// ---------------------------------------------------------------------------
// Independent recomputation of the column count from the CSS-declared values.
// This is deliberately a copy of the documented rule instead of a call into
// clipboard-layout.js: importing the module would make the check circular. The
// point is that the numbers in the stylesheet, the model the renderer built and
// the grid the browser laid out all agree.
// ---------------------------------------------------------------------------
const SOURCE_EDGE = 240
const MAX_COLUMNS = 12
const EDGE_EPSILON = 1e-9

function columnsFor(geometry) {
  const { listClientWidth, metrics, dpr } = geometry
  const available = Math.max(1, listClientWidth - 2 * metrics.padX)
  const tile = (count) => (available - (count - 1) * metrics.gap) / count
  let count = Math.max(1, Math.min(MAX_COLUMNS, Math.round((available + metrics.gap) / (metrics.target + metrics.gap))))
  while (count < MAX_COLUMNS && Math.max(tile(count), metrics.cellH) * dpr > SOURCE_EDGE + EDGE_EPSILON && tile(count + 1) >= metrics.min) count++
  return { count, width: tile(count) }
}

function expectedCellHeight(geometry) {
  let height = declared.cellH
  for (const [index, bucket] of cssBuckets.entries()) {
    if (geometry.matches[index]) height = bucket.cellH
  }
  return height
}

// ---------------------------------------------------------------------------
// Probe source: written to the scratch directory and run as an Electron main
// script. It prints one JSON report and every assertion lives in this file, so a
// failure message names the contract instead of an anonymous exit code.
// ---------------------------------------------------------------------------
const probeSource = String.raw`
const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.HIGHLIGHTER_CLIPBOARD_GRID_ROOT
const resultPath = process.env.HIGHLIGHTER_CLIPBOARD_GRID_RESULT
const stubPath = process.env.HIGHLIGHTER_CLIPBOARD_GRID_STUB
const buckets = JSON.parse(process.env.HIGHLIGHTER_CLIPBOARD_GRID_BUCKETS || '[]')

protocol.registerSchemesAsPrivileged([{ scheme: 'highlighter-clipboard', privileges: { standard: true, secure: true, supportFetchAPI: false } }])
app.setPath('userData', path.join(__dirname, 'user-data'))
app.setPath('sessionData', path.join(__dirname, 'session-data'))
app.disableHardwareAcceleration()

// A 1x1 PNG is enough: the assertions are about src/loaded wiring, not pixels.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const report = { errors: [], widths: {}, a11y: null }
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function measureInPage() {
  const list = document.getElementById('list')
  const rows = document.getElementById('rows')
  const footer = document.querySelector('.footer')
  const listStyle = getComputedStyle(list)
  const number = (name) => parseFloat(listStyle.getPropertyValue(name))
  const gridRow = rows.querySelector('.grid-row')
  const gridStyle = gridRow ? getComputedStyle(gridRow) : null
  const tile = rows.querySelector('.tile')
  const footerRect = footer.getBoundingClientRect()
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    listClientWidth: list.clientWidth,
    listClientHeight: list.clientHeight,
    metrics: {
      rowH: number('--row-h'),
      cellH: number('--cell-h'),
      gap: number('--grid-gap'),
      padX: number('--grid-pad-x'),
      target: number('--tile-target'),
      min: number('--tile-min')
    },
    matches: (window.__gridBuckets || []).map((bucket) => window.matchMedia('(min-resolution: ' + bucket + 'dppx)').matches),
    cols: Number(rows.style.getPropertyValue('--cols')),
    gridTemplateColumns: gridStyle ? gridStyle.gridTemplateColumns : '',
    gridRowHeight: gridStyle ? parseFloat(gridStyle.height) : null,
    tileWidth: tile ? tile.getBoundingClientRect().width : null,
    tileHeight: tile ? tile.getBoundingClientRect().height : null,
    gridRowCount: rows.querySelectorAll('.grid-row').length,
    textRowCount: rows.querySelectorAll('.row').length,
    tileCount: rows.querySelectorAll('.tile').length,
    optionCount: rows.querySelectorAll('[role="option"]').length,
    tiles: Array.from(rows.querySelectorAll('.tile')).map((node) => {
      const image = node.querySelector('img')
      return {
        id: node.getAttribute('data-item-id'),
        state: node.getAttribute('data-state'),
        label: node.getAttribute('aria-label') || '',
        src: image ? (image.getAttribute('src') || '') : '',
        loaded: Boolean(image) && image.naturalWidth > 0
      }
    }),
    footer: {
      scrollWidth: footer.scrollWidth,
      clientWidth: footer.clientWidth,
      left: footerRect.left,
      right: footerRect.right,
      buttons: Array.from(footer.querySelectorAll('button')).map((button) => {
        const rect = button.getBoundingClientRect()
        return { id: button.id, hidden: button.hidden, left: rect.left, right: rect.right, width: rect.width }
      })
    }
  }
}

function gridSettled() {
  const tiles = Array.from(document.querySelectorAll('#rows .tile'))
  if (tiles.length < 6) return false
  return tiles.every((tile) => tile.getAttribute('data-state') === 'failed' ||
    (tile.querySelector('img')?.getAttribute('src') || '').length > 0)
}

function thumbnailsDecoded() {
  return Array.from(document.querySelectorAll('#rows .tile img[src]')).every((image) => image.complete)
}

function selectionApplied() {
  return document.getElementById('view').hidden === false &&
    document.querySelectorAll('#rows [aria-selected="true"]').length === 1
}

async function waitFor(source, label, timeout) {
  const end = Date.now() + (timeout || 8000)
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript('(' + source + ')()')) return true
    await sleep(50)
  }
  if (label) throw new Error(label)
  return false
}

async function measure() {
  return win.webContents.executeJavaScript('(' + measureInPage.toString() + ')()')
}

async function axSnapshot() {
  const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
  const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]))
  const listbox = tree.nodes.find((node) => node.role?.value === 'listbox' && !node.ignored)
  const childIds = listbox?.childIds || []
  const children = childIds.map((id) => byId.get(id))
  const resolved = children.filter(Boolean)
  return {
    found: Boolean(listbox),
    label: listbox?.name?.value || '',
    childIds: childIds.length,
    resolved: resolved.length,
    childCount: resolved.length,
    childRoles: resolved.map((node) => node.role?.value),
    childNames: resolved.map((node) => node.name?.value || ''),
    ignoredChildren: resolved.filter((node) => node.ignored).length,
    optionsInTree: tree.nodes.filter((node) => node.role?.value === 'option' && !node.ignored).length
  }
}

let win
app.whenReady().then(async () => {
  try {
    protocol.handle('highlighter-clipboard', (request) => {
      let url
      try { url = new URL(request.url) } catch { return new Response(null, { status: 404 }) }
      if (url.hostname !== 'preview') return new Response(null, { status: 404 })
      return new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
    })
    win = new BrowserWindow({
      show: false,
      width: 480,
      height: 640,
      webPreferences: {
        preload: stubPath,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    win.webContents.on('console-message', (_event, details) => {
      const level = details && typeof details === 'object' ? details.level : undefined
      const message = details && typeof details === 'object' ? details.message : String(details || '')
      if (level === 'error') report.errors.push(message)
    })
    // Content size, not outer window size: the 380 / 480 DIP assertions are about
    // the renderer viewport, and on Windows the outer frame is wider than it.
    win.setContentSize(480, 640)
    await win.loadFile(path.join(root, 'clipboard', 'clipboard.html'))
    // Thumbnail wiring is asserted from the DOM below; a settle timeout must not
    // fail the run on its own, or the assertion that names the missing piece
    // never runs. The report records which waits timed out.
    report.settled = {
      grid: await waitFor(gridSettled.toString(), null, 8000),
      decoded: await waitFor(thumbnailsDecoded.toString(), null, 4000)
    }

    await win.webContents.executeJavaScript('window.__gridBuckets = ' + JSON.stringify(buckets))
    // The DOM-side names are what the AX tree should carry; capturing both lets a
    // failure distinguish "the attribute is empty" from "the AX layer dropped it".
    report.options = await win.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("#rows [role=\\"option\\"]")).map((node) => ({' +
      ' id: node.getAttribute("data-item-id"),' +
      ' label: node.getAttribute("aria-label") || "",' +
      ' preview: (node.querySelector(".row-preview") || {}).textContent || ""' +
      '}))'
    )
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Accessibility.enable')
    await sleep(150)
    report.a11y = await axSnapshot()

    // The normal footer set needs a text record selected: #view ("Show full
    // text") is hidden for an image record, so an image selection would measure a
    // five-control footer instead of the six-control one users actually get.
    await win.webContents.executeJavaScript('(function () { document.querySelector("#rows .row").click(); return true })()')
    await waitFor(selectionApplied.toString(), 'selecting a text record did not reveal the full-text action', 5000)
    report.widths['480'] = await measure()

    // Reuse the same window: a second BrowserWindow.loadFile fails with
    // ERR_FAILED (-2) on this Electron/host combination.
    win.setContentSize(380, 640)
    await waitFor('function () { return window.innerWidth === 380 }', 'the viewport never reached 380 DIP', 5000)
    await sleep(400)
    report.widths['380'] = await measure()
    report.visible = win.isVisible()
    report.ok = true
  } catch (error) {
    report.error = error && error.stack ? error.stack : String(error)
    // A wait that timed out has no measurement to report otherwise; capture what
    // the panel did render so the failure names the missing piece (a tile with no
    // src, a stuck data-state) instead of only the timeout.
    if (win && !win.isDestroyed()) {
      try { report.partial = await measure() } catch { /* the page itself is gone */ }
    }
  }
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
})
`

test('the clipboard grid keeps option ownership, footer fit and CSS-driven geometry', { timeout: 120000 }, (t) => {
  // Scratch lives inside the checkout (`.tmp/` is gitignored) because a spawned
  // Electron child cannot write the ambient %TEMP% on the confined host.
  const scratchRoot = path.join(root, '.tmp')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'clipboard-grid-runtime-'))
  t.after(() => {
    try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* a lingering Electron file handle must not fail the run */ }
  })
  const probePath = path.join(scratch, 'probe.cjs')
  const stubPath = path.join(scratch, 'stub-preload.js')
  const resultPath = path.join(scratch, 'report.json')
  fs.writeFileSync(probePath, probeSource)
  fs.writeFileSync(stubPath, stubSource)

  const env = {
    ...process.env,
    // Point the child's temp root and Electron profile into the checkout.
    TMP: scratch,
    TEMP: scratch,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    ELECTRON_ENABLE_LOGGING: '0',
    HIGHLIGHTER_CLIPBOARD_GRID_ROOT: root,
    HIGHLIGHTER_CLIPBOARD_GRID_RESULT: resultPath,
    HIGHLIGHTER_CLIPBOARD_GRID_STUB: stubPath,
    HIGHLIGHTER_CLIPBOARD_GRID_BUCKETS: JSON.stringify(cssBuckets.map((bucket) => bucket.dppx))
  }
  // ELECTRON_RUN_AS_NODE turns electron.exe into plain Node, where require()
  // has no `app` and the panel can never render. Removed so this file runs
  // standalone, and a no-op on a host that does not set it.
  delete env.ELECTRON_RUN_AS_NODE
  const runProbe = (extraArgs) => spawnSync(electronPath, [...extraArgs, probePath], {
    cwd: root,
    env,
    encoding: 'utf8',
    // Two attempts have to fit inside the test timeout, and a healthy run of this
    // probe takes ~1.5 s.
    timeout: 45000,
    windowsHide: true
  })
  // Keep the Chromium sandbox on where it works: the plain run is tried first
  // and only a dead child retries with --no-sandbox (which must precede the
  // script path, or Electron reads it as a script argument and falls back to
  // Node mode). This host's sandbox cannot start - the child exits with code 3
  // in ~120 ms before any page loads - so the retry is what makes the file
  // runnable standalone here, while a normal desktop/CI host never takes it.
  const attempts = [runProbe([])]
  if (attempts[0].status !== 0 && !fs.existsSync(resultPath)) attempts.push(runProbe(['--no-sandbox']))
  const result = attempts[attempts.length - 1]
  const report = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null
  const failure = `clipboard grid probe failed (sandbox attempts: ${attempts.map((attempt) => attempt.status).join(', ')}).
stdout:
${result.stdout}
${result.stderr ? `stderr:
${result.stderr}` : ''}
report:
${report ? JSON.stringify(report, null, 2) : 'no report written'}`
  assert.equal(result.status, 0, failure)
  assert.ok(report, failure)
  assert.equal(report.ok, true, failure)
  assert.equal(report.error, undefined, failure)
  assert.deepEqual(report.errors, [], 'the panel logged no renderer errors')
  assert.equal(report.visible, false, 'the probe window must stay hidden (single-display host rule)')
  // report.settled records which thumbnail waits timed out. It is diagnostic
  // only: the per-tile assertions in section 4 name the exact missing piece (no
  // src, a stuck data-state), which is a better failure than "never settled".

  // ---- 1. accessibility-tree ownership ---------------------------------
  const a11y = report.a11y
  assert.equal(a11y.found, true, 'main#list[role=listbox] is missing from the accessibility tree')
  assert.ok(a11y.label.length > 0, 'the listbox has no accessible name')
  assert.equal(a11y.childIds, a11y.resolved, 'every listbox childId must resolve inside the AX tree')
  assert.equal(a11y.ignoredChildren, 0, 'no listbox child is an ignored node')
  // The regression: <div id="rows"> with no role became a generic node, so the
  // listbox reported ONE child and every option was a grandchild.
  assert.deepEqual(
    a11y.childRoles.filter((role) => role !== 'option'),
    [],
    'every direct child of the listbox must be role=option (no generic #rows wrapper)'
  )
  assert.equal(a11y.childCount, 8, 'all eight rendered records are direct listbox children')
  assert.equal(a11y.childCount, a11y.optionsInTree, 'no option is reachable only through another node')
  assert.equal(a11y.childCount, report.widths['480'].optionCount, 'the AX children match the rendered option nodes')
  for (const [index, name] of a11y.childNames.entries()) {
    assert.ok(name.trim().length > 0, `listbox child ${index} has an empty accessible name`)
  }
  // Pin the AX names to the DOM: an image tile is named by its aria-label, a
  // text/url row by its content. A match proves the names come from the record
  // itself rather than from a generic ancestor label, and that the image tiles
  // (which carry no text at all) are still announced.
  assert.equal(a11y.childCount, report.options.length, 'every rendered option reached the accessibility tree')
  for (const [index, name] of a11y.childNames.entries()) {
    const option = report.options[index]
    assert.ok(option, `rendered option ${index} is missing`)
    if (option.label) {
      assert.ok(name.includes(option.label),
        `listbox child ${index} is announced as ${JSON.stringify(name)} but its aria-label is ${JSON.stringify(option.label)}`)
    } else {
      assert.ok(option.preview.length > 0, `rendered option ${index} has neither an aria-label nor preview text`)
      assert.ok(name.includes(option.preview),
        `listbox child ${index} is announced as ${JSON.stringify(name)} but renders ${JSON.stringify(option.preview)}`)
    }
  }

  // ---- 2. footer fit at 480 and 380 DIP --------------------------------
  const expectedFooterIds = ['clear', 'copy', 'delete', 'paste', 'pin', 'view']
  for (const width of ['480', '380']) {
    const geometry = report.widths[width]
    const footer = geometry.footer
    assert.equal(geometry.innerWidth, Number(width), `the viewport is ${width} DIP wide`)
    assert.ok(footer.scrollWidth <= footer.clientWidth + 1,
      `the footer overflows at ${width} DIP: scrollWidth ${footer.scrollWidth} > clientWidth ${footer.clientWidth}`)
    const visible = footer.buttons.filter((button) => !button.hidden && button.width > 0)
    assert.deepEqual(visible.map((button) => button.id).sort(), [...expectedFooterIds].sort(),
      `the footer shows the normal control set at ${width} DIP (a text record is selected)`)
    for (const button of visible) {
      assert.ok(button.right <= footer.right + 1,
        `#${button.id} is clipped past the footer's right edge at ${width} DIP (${button.right} > ${footer.right})`)
      assert.ok(button.left >= footer.left - 1,
        `#${button.id} starts left of the footer at ${width} DIP (${button.left} < ${footer.left})`)
      assert.ok(button.width > 0, `#${button.id} collapsed at ${width} DIP`)
    }
  }

  // ---- 3. geometry matches the stylesheet, at the host's real DPR ------
  for (const width of ['480', '380']) {
    const geometry = report.widths[width]
    assert.ok(Number.isFinite(geometry.dpr) && geometry.dpr > 0, `devicePixelRatio is measurable at ${width} DIP`)
    // The values the renderer read out of the stylesheet must be the values the
    // stylesheet declares (a drift here is the "second source of geometry" bug).
    assert.deepEqual(geometry.metrics, declared, `the computed #list geometry at ${width} DIP matches clipboard.css`)
    // The active cell height follows the CSS bucket that matches this DPR.
    assert.equal(geometry.matches.length, cssBuckets.length, 'the probe evaluated every CSS bucket')
    assert.equal(geometry.metrics.cellH, expectedCellHeight(geometry),
      `the active --cell-h at ${width} DIP must be the last matching CSS bucket override`)
    // Column count: the renderer's answer, the sizes it implies, and the grid the
    // browser actually laid out must all agree.
    const expected = columnsFor(geometry)
    assert.equal(geometry.cols, expected.count,
      `renderer columns (${geometry.cols}) != columns implied by the CSS geometry (${expected.count}) at ${width} DIP`)
    assert.equal(geometry.gridTemplateColumns.trim().split(/\s+/).length, expected.count,
      `the laid-out grid has ${expected.count} columns at ${width} DIP`)
    assert.ok(Math.abs(geometry.tileWidth - expected.width) <= 0.51,
      `the first tile is ${geometry.tileWidth}px wide, the CSS geometry implies ${expected.width}px at ${width} DIP`)
    assert.ok(Math.abs(geometry.tileHeight - geometry.metrics.cellH) <= 0.51,
      `the tile height (${geometry.tileHeight}) must be --cell-h (${geometry.metrics.cellH}) at ${width} DIP`)
    assert.ok(Math.abs(geometry.gridRowHeight - geometry.metrics.cellH) <= 0.51,
      `the grid row height (${geometry.gridRowHeight}) must be --cell-h at ${width} DIP`)
    assert.equal(geometry.gridRowCount, Math.ceil(geometry.tileCount / expected.count),
      `${geometry.tileCount} images span ${Math.ceil(geometry.tileCount / expected.count)} grid rows at ${width} DIP`)
    assert.equal(geometry.tileCount, 6, `all six image records are mounted at ${width} DIP`)
    assert.equal(geometry.textRowCount, 2, `both text records are mounted at ${width} DIP`)
    assert.equal(geometry.optionCount, 8, `all eight records are mounted as options at ${width} DIP`)
    assert.equal(geometry.innerHeight, 640, `the viewport is 640 DIP tall at ${width} DIP`)
  }

  // Concrete numbers measured on this host (scaleFactor 1.5). They are pinned so
  // a silent shrink of the panel is caught even when the recomputation above
  // would agree with a changed stylesheet; on another scale factor the sharpness
  // term of the column rule can legitimately pick another count.
  if (Math.abs(report.widths['380'].dpr - 1.5) < 1e-6) {
    assert.equal(report.widths['480'].listClientWidth, 470, 'measured list client width at 480 DIP')
    assert.equal(report.widths['380'].listClientWidth, 370, 'measured list client width at 380 DIP')
    assert.equal(report.widths['480'].cols, 4, 'measured column count at 480 DIP')
    assert.equal(report.widths['380'].cols, 3, 'measured column count at 380 DIP')
    assert.equal(report.widths['480'].metrics.cellH, 92, 'measured cell height below 2.25dppx')
  }

  // ---- 4. thumbnail wiring --------------------------------------------
  const unavailable = i18n.t('clipboard.thumbnail-unavailable')
  const sizeCopy = i18n.t('clipboard.image-size', { width: 640, height: 360 })
  const tiles = report.widths['380'].tiles
  assert.equal(tiles.length, 6)
  assert.deepEqual(tiles.filter((tile) => tile.state === 'failed').map((tile) => tile.id), [failedId])
  for (const tile of tiles) {
    if (tile.state === 'failed') {
      assert.equal(tile.src, '', 'a failed record gets no image source')
      assert.ok(tile.label.includes(unavailable),
        `a failed record is still announced as a record: ${JSON.stringify(tile.label)}`)
      assert.ok(tile.label.includes(sizeCopy),
        `the failed record keeps its image description: ${JSON.stringify(tile.label)}`)
    } else {
      assert.equal(tile.state, null, 'a successfully loaded tile clears data-state')
      assert.ok(tile.src.startsWith('highlighter-clipboard://preview/'),
        `the tile loads through the preview capability protocol: ${JSON.stringify(tile.src)}`)
      assert.equal(tile.loaded, true, 'the thumbnail actually decoded')
      assert.ok(tile.label.includes(sizeCopy), 'an image tile is described by its aria-label')
      assert.equal(tile.label.includes(unavailable), false, 'a loaded tile is not announced as unavailable')
    }
  }
})
