'use strict'

// B1.4 (history re-edit): the list page's continuity contract (plan §2.1 "回到列表",
// §5.1 main flow, §6.5.1 identity/version/list contract, §6.5.7, §9.1 B1.4).
//
// Scope note: this file pins the *structure* of config/routes/history.js — the parts
// whose failure mode is "the page silently goes back to page one / the edit entry
// silently does nothing / the badge never appears". It reads source text for the
// wiring assertions (same idiom as test/history-management-ui.test.js, which is the
// existing contract and stays untouched) and evaluates the pure helpers for the
// behaviour assertions, so the version rule and the selection rule are checked as
// behaviour rather than as a regex.
//
// Not covered here (needs a real Electron renderer, per the plan's §12): actual
// scroll offset after a patch, IntersectionObserver delivery and thumbnail paint.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readConfigSource } = require('./helpers/config-source')

const root = path.join(__dirname, '..')
const historyPath = path.join(root, 'config', 'routes', 'history.js')
const history = fs.readFileSync(historyPath, 'utf8')
const shell = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8')
const config = readConfigSource()
const styles = fs.readFileSync(path.join(root, 'config', 'config.css'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

// --- helpers ---------------------------------------------------------------

// The production route file is a classic <script> with no exports, so a helper is
// lifted by name and evaluated on its own. Only functions whose body is pure (no
// DOM, no t(), no IPC) are eligible; anything touching the window stays a
// source-text assertion.
function sliceFunction (source, name) {
  const match = new RegExp(`(?:async )?function ${name} ?\\(`).exec(source)
  assert.ok(match, `expected function ${name}() in config/routes/history.js`)
  const open = source.indexOf('{', match.index)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(match.index, index + 1)
    }
  }
  throw new Error(`unbalanced braces while lifting ${name}()`)
}

function evaluateHelperSet (names) {
  // `new Function` cannot receive function declarations as values, so the lifted
  // source is concatenated into the wrapper and the wanted helpers are returned.
  const source = names.map((name) => sliceFunction(history, name)).join('\n')
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn { ${names.join(', ')} }`)()
}

// The body of one production function, so a test can look inside it rather than at
// the whole file (an assertion that holds elsewhere must not satisfy it).
function functionBody (name) {
  return sliceFunction(history, name)
}

function localeTables () {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(root, 'shared', 'locales')).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(root, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

const NEW_KEYS = [
  'config.history.version-badge',
  'config.history.long-capture-no-edit',
  'config.history.action-edit-loading',
  'config.history.edit-failed'
]

// --- in-place refresh -------------------------------------------------------

test('history:changed goes to the in-place refresh, not the full re-render', () => {
  // The exact regression this batch fixes: every history write rebuilt the page.
  assert.match(shell, /onHistoryChanged\(\(\) => \{[^}]*refreshHistoryOnChange\(\)/)
  assert.doesNotMatch(shell, /onHistoryChanged\(\(\) => \{ if \(currentRoute === 'history'\) renderHistory\(\) \}/)
  // The route exposes the incremental entry point and its full-render fallback.
  assert.match(history, /function refreshHistoryOnChange\(\)/)
  assert.match(history, /async function refreshHistoryInPlace\(\)/)
  assert.match(history, /async function refreshHistoryList\(\)/)
})

test('entering the route still runs the full render', () => {
  // Plan §5.1: first entry keeps the existing behaviour; only the push path is new.
  assert.match(history, /window\.configRoutes\['renderHistory'\] = \(\) => renderHistory\(\)/)
  assert.match(history, /async function renderHistory\(\)/)
  // A route entry must not be served by the patch path: the full render bumps the
  // version and drops the list the patch would have targeted.
  assert.match(history, /const renderVersion = \+\+historyRenderVersion[\s\S]{0,400}?historyListState = null/)
})

test('the refresh refetches the loaded pages instead of resetting to page one', () => {
  assert.match(history, /async function historyLoadLoadedPages\(targetCount\)/)
  // Cursor paging in a loop, bounded by what the user already had on screen.
  assert.match(history, /const page = await window\.electronAPI\.getHistory\(\{[\s\S]{0,300}?\.\.\.\(cursor \? \{ cursor \} : \{\}\)/)
  assert.match(history, /items\.length >= targetCount/)
  assert.match(history, /const targetCount = Math\.max\(HISTORY_PAGE_SIZE, state\.items\.length\)/)
  // Never more than the service accepts in one page.
  assert.match(history, /HISTORY_MAX_PAGE_SIZE = 100/)
  assert.match(history, /Math\.min\(HISTORY_MAX_PAGE_SIZE, targetCount - items\.length\)/)
})

test('the refresh patches cards in place and keeps the surrounding blocks', () => {
  assert.match(history, /function historyPatchCards\(state, items\)/)
  assert.match(history, /data-history-document=/)
  assert.match(history, /data-history-signature=/)
  // Unchanged cards keep their element (and loaded thumbnail); only changed ones
  // are re-created.
  assert.match(history, /if \(!card \|\| card\.dataset\.historySignature !== historyCardSignature\(item\)\)/)
  assert.match(history, /next = historyCreateCard\(item\)/)
  assert.match(history, /if \(card\) card\.replaceWith\(next\)/)
  // A refresh must not rebuild stats / filters / batch: no innerHTML write on the
  // page container inside the patch path, only on the results slot.
  const patch = functionBody('historyPatchCards')
  assert.doesNotMatch(patch, /view\.innerHTML/)
  assert.doesNotMatch(patch, /document\.querySelectorAll\('\.page'\)/)
  assert.match(patch, /state\.results\.querySelector\('\.history-grid'\)/)
})

test('the refresh preserves the scroll offset of #view', () => {
  // #view is the only scroller (config.css `#view{flex:1;overflow:auto}`); the same
  // save/restore shape as routes/usage.js.
  assert.match(styles, /#view\{flex:1;overflow:auto/)
  assert.match(history, /const scrollTop = view\.scrollTop \|\| 0/)
  assert.match(history, /function historyRestoreScroll\(scrollTop\)/)
  assert.match(history, /if \(scrollTop > 0 && view\.scrollTop !== scrollTop\) view\.scrollTop = scrollTop/)
  // Re-applied next frame: right after the swap the grid has no geometry yet.
  assert.match(history, /requestAnimationFrame\(applyScroll\)/)
  assert.match(history, /historyRestoreScroll\(scrollTop\)/)
  // The offset is read after the fetch, right before the patch, so a user who
  // scrolled while the list was loading is not rewound.
  const refresh = functionBody('refreshHistoryList')
  assert.ok(
    refresh.indexOf('await historyLoadLoadedPages(targetCount)') < refresh.indexOf('const scrollTop = view.scrollTop'),
    'the scroll offset must be captured after the refetch, not before it'
  )
})

test('the refresh keeps the thumbnail cache and the loaded page count', () => {
  // The cache used to be a per-render local Map, so every write refetched every
  // thumbnail. It has to outlive a render now.
  assert.doesNotMatch(history, /renderHistory\s*\([^)]*\)\s*\{[^}]*const thumbnailCache = new Map\(\)/)
  assert.match(history, /let historyThumbnailCache = new Map\(\)/)
  // Plan §6.5.1: cache key is (documentId, headRevisionId) so a new version cannot
  // be served the previous version's thumbnail.
  assert.match(history, /function historyThumbnailKey\(item\)/)
  assert.match(history, /return `\$\{historyDocumentId\(item\)\}::\$\{historyRevisionId\(item\)\}`/)
  assert.match(history, /imageElement\.dataset\.historyThumbnailKey \|\| documentId/)
  assert.match(history, /data-history-thumbnail-key=/)
  // Bounded cache: a long-lived Map otherwise grows with every revision browsed.
  assert.match(history, /HISTORY_THUMBNAIL_CACHE_LIMIT = 120/)
  // The refresh never resets `items` to a first page.
  const refresh = functionBody('refreshHistoryList')
  assert.doesNotMatch(refresh, /state\.items = \[\]/)
})

test('selection survives a refresh and only drops documents that disappeared', () => {
  const { historySelectionAfterRefresh } = evaluateHelperSet(['historySelectionAfterRefresh'])
  const previousIds = ['doc-a', 'doc-b', 'doc-c']
  // Nothing changed: the very same set comes back (no clear).
  const unchanged = new Set(['doc-a', 'doc-c'])
  assert.equal(historySelectionAfterRefresh(unchanged, previousIds, previousIds), unchanged)
  // A document was deleted: only its id is dropped, the rest keep their ticks.
  assert.deepEqual(
    [...historySelectionAfterRefresh(new Set(['doc-a', 'doc-b']), previousIds, ['doc-a', 'doc-c'])],
    ['doc-a']
  )
  // A document that merely changed pages is not a reason to drop the selection.
  assert.deepEqual([...historySelectionAfterRefresh(new Set(['doc-b']), [], ['doc-a', 'doc-b'])], ['doc-b'])
  // The refresh path routes through this helper rather than a blanket clear.
  assert.match(history, /historySelectedIds = historySelectionAfterRefresh\(historySelectedIds, previousIds, nextIds\)/)
})

test('concurrent history:changed pushes are coalesced and never patch a stale render', () => {
  // One user action can emit several pushes (batch delete); a refresh also must not
  // land on a page a newer full render replaced.
  assert.match(history, /HISTORY_REFRESH_DELAY/)
  assert.match(history, /if \(historyRefreshRunning\) \{\s*historyRefreshPending = true/)
  // A refresh that resolves after the page was rebuilt must not patch the old DOM.
  assert.match(history, /refreshVersion !== historyRenderVersion \|\| historyListState !== state\) return false/)
  // A queued search debounce already owns re-rendering the list.
  assert.match(history, /if \(historySearchTimer\) return/)
  // Mid-render pushes are folded into one refresh after the render completes.
  assert.match(history, /if \(historyRenderInFlight\) \{\s*historyRefreshPending = true/)
})

// --- version badge (plan §6.5.1) -------------------------------------------

test('the version badge only renders above version 1', () => {
  const { historyVersion } = evaluateHelperSet(['historyVersion'])
  // Missing field (legacy rows) and version 1 produce no badge-worthy value.
  assert.equal(historyVersion({}), 1)
  assert.equal(historyVersion({ version: undefined }), 1)
  assert.equal(historyVersion({ version: 1 }), 1)
  assert.equal(historyVersion({ version: '1' }), 1)
  assert.equal(historyVersion({ version: 0 }), 1)
  // Real revisions.
  assert.equal(historyVersion({ version: 2 }), 2)
  assert.equal(historyVersion({ version: '3' }), 3)
  // Junk falls back to the first version instead of rendering "第 NaN 版".
  assert.equal(historyVersion({ version: 'abc' }), 1)
  assert.equal(historyVersion({ version: -4 }), 1)
  assert.equal(historyVersion(null), 1)
  // The card gates the markup on `version > 1`, so "第 1 版" can never appear.
  assert.match(history, /const versionBadge = version > 1 \? `/)
  assert.match(history, /t\('config\.history\.version-badge', \{ version \}\)/)
})

test('history identity fields are read defensively (documentId, then id)', () => {
  const { historyDocumentId } = evaluateHelperSet(['historyDocumentId'])
  // Compatibility window: item.id === item.documentId, but a row without either new
  // field must still render and cache under its own key.
  assert.equal(historyDocumentId({ documentId: 'doc-a', id: 'doc-a' }), 'doc-a')
  assert.equal(historyDocumentId({ id: 'legacy-id' }), 'legacy-id')
  assert.equal(historyDocumentId({ documentId: 'doc-b', id: 'doc-b' }), 'doc-b')
  assert.equal(historyDocumentId(null), '')
  // `??` (not `||`): an explicit empty documentId is a data error, not a fallback.
  assert.equal(historyDocumentId({ documentId: '', id: 'x' }), '')
})

test('cards and the list are keyed by documentId, not the bare id', () => {
  assert.match(history, /const documentId = historyDocumentId\(item\)/)
  assert.match(history, /const id = escapeHtml\(documentId\)/)
  assert.match(history, /data-history-document="\$\{id\}"/)
  assert.match(history, /data-history-select data-id="\$\{id\}"/)
  assert.match(history, /data-history-action="edit" data-id="\$\{id\}"/)
  // Selection bookkeeping uses the same identity as the cards.
  assert.match(history, /const selected = historySelectedIds\.has\(documentId\)/)
})

test('the badge and its plate have styles and the meta run can still shrink', () => {
  // New rules only appended to the history block; the existing rules are untouched.
  assert.match(styles, /\.history-version\{[^}]*margin-left:auto/)
  assert.match(styles, /\.history-version\{[^}]*border-radius:var\(--radius-pill\)/)
  assert.match(styles, /\.history-version\{[^}]*white-space:nowrap/)
  // A third flex item in `.history-meta` needs the min-size override on the nowrap run.
  assert.match(styles, /\.history-meta-sub\{min-width:0\}/)
  // The badge takes theme colours, never a hardcoded hex, like the action buttons.
  const badgeRule = styles.match(/\.history-version\{([^}]*)\}/)[1]
  assert.doesNotMatch(badgeRule, /color:\s*#/)
  assert.match(badgeRule, /color:var\(--primary-text\)/)
})

// --- edit entry failure visibility ----------------------------------------

test('the edit action wraps the IPC call in try/catch and checks the result', () => {
  const edit = functionBody('historyEditItem')
  assert.ok(edit.length > 0, 'expected historyEditItem()')
  // No bare `await window.electronAPI.editHistory(id)` without a guard: the old code
  // threw an unhandled rejection on game mode / a deleted file and stayed silent.
  assert.doesNotMatch(history, /^\s*if \(action === 'edit'\) await window\.electronAPI\.editHistory\(id\)\s*$/m)
  assert.match(edit, /try \{/)
  assert.match(edit, /catch \(error\) \{/)
  assert.match(edit, /toast\(errorMessage\(error\) \|\| t\('config\.history\.edit-failed'\)\)/)
  // main.js returns false when the file is gone (main.js editItem's `existsSync` guard);
  // the returned value is checked instead of being dropped.
  assert.match(edit, /const opened = await window\.electronAPI\.editHistory\(id\)/)
  assert.match(edit, /if \(opened === false\) toast\(t\('config\.history\.edit-failed'\)\)/)
  // The preload method name is a cross-process contract: unchanged.
  assert.match(preload, /editHistory:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('history:edit', id\)/)
})

test('the edit button is locked and relabelled while the request is in flight', () => {
  const edit = functionBody('historyEditItem')
  assert.match(edit, /if \(!button \|\| button\.disabled\) return/)
  assert.match(edit, /button\.disabled = true/)
  assert.match(edit, /button\.textContent = t\('config\.history\.action-edit-loading'\)/)
  // The label is restored from the captured original, so a second click cannot
  // stack a second toast/editor, and a replaced card is not left half-locked.
  assert.match(edit, /const label = button\.textContent/)
  assert.match(edit, /finally \{/)
  assert.match(edit, /button\.textContent = label/)
  assert.match(edit, /button\.disabled = false/)
  // A patch may have replaced the button with its card; detached nodes are skipped.
  assert.match(edit, /if \(button\.isConnected\)/)
})

test('the other card actions report failures through the same errorMessage helper', () => {
  // errorMessage() strips the Electron "Error invoking remote method ..." wrapper, so
  // a toast shows the reason rather than the IPC plumbing.
  assert.match(history, /toast\(errorMessage\(error\) \|\| t\('config\.history\.open-failed'\)\)/)
  assert.match(history, /toast\(errorMessage\(error\) \|\| t\('config\.history\.address-copy-failed'\)\)/)
  assert.match(readConfigSource(), /function errorMessage\(error\)/)
})

// --- long capture explanation (plan §6.5.1 S8 / §11.1) ----------------------

test('long captures keep no edit button but explain why', () => {
  // Behaviour is unchanged: no edit button. What is new is the tooltip on the plate.
  assert.match(history, /const editButton = item\?\.longCapture \? '' : `<button data-history-action="edit"/)
  assert.match(history, /const imageTitle = item\?\.longCapture \? ` title="\$\{escapeHtml\(t\('config\.history\.long-capture-no-edit'\)\)\}"` : ''/)
  assert.match(history, /<div class="history-image"\$\{imageTitle\}>/)
  // A tooltip alone is not a keyboard affordance; the plate must stay reachable.
  assert.match(styles, /\.history-image\[title\]\{cursor:help\}/)
  // The copy lives in the locale table, not in the markup.
  assert.match(config, /'config\.history\.long-capture-no-edit':/)
})

// --- i18n -------------------------------------------------------------------

test('every new history key exists in all three tables', () => {
  const tables = localeTables()
  for (const key of NEW_KEYS) {
    for (const language of LANGUAGES) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key}`)
      assert.ok(tables[language][key].length > 0, `${language} has an empty value for ${key}`)
    }
  }
  // The two interpolating keys keep their placeholder in every language.
  for (const language of LANGUAGES) {
    assert.match(tables[language]['config.history.version-badge'], /\{version\}/)
  }
  // The three tables hold identical key sets after this change.
  const reference = Object.keys(tables['zh-CN']).sort()
  for (const language of LANGUAGES.slice(1)) {
    assert.deepEqual(reference.filter((key) => !Object.hasOwn(tables[language], key)), [], `${language} misses keys present in zh-CN`)
    assert.deepEqual(Object.keys(tables[language]).sort().filter((key) => !reference.includes(key)), [], `${language} defines keys absent from zh-CN`)
  }
})

test('the new keys follow the checker key shape and are actually used', () => {
  const KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/
  for (const key of NEW_KEYS) {
    assert.match(key, KEY_PATTERN, `${key} must follow <domain>.<module>.<semantic>`)
    // A key only the test knows about is dead weight; each one is resolved by t().
    assert.match(history, new RegExp(`t\\('${key.replace(/\./g, '\\.')}'`), `${key} is not resolved by config/routes/history.js`)
  }
})

test('no raw Chinese UI copy was added to the history route', () => {
  // The i18n gate scans for CJK and counts lines; new user-facing copy must go
  // through t(), so the only CJK left in the file is the pre-existing header and the
  // route registration footer carried over from the route-split wave.
  const cjkLines = history.split(/\r?\n/).filter((line) => /[\u4e00-\u9fff]/.test(line))
  const allowed = /^\/\/ (S14 \/ D2-2|路由 history|D2-2（S14）|包一层箭头函数)/
  const unexpected = cjkLines.filter((line) => !allowed.test(line.trim()))
  assert.deepEqual(unexpected, [], 'new Chinese copy must be a locale key resolved through t()')
})
