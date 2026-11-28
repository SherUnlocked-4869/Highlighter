'use strict'

// N01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.1):
// Smart privacy redaction — the rule library (behaviour), the OCR-text-block →
// redaction-box mapping (behaviour), and the capture-window wiring (structure +
// vm-sandbox behaviour, following test/capture-toolbar-regressions.test.js).
//
// The rule library and the mapping are pure, so they are exercised directly. The
// capture window is exercised in a vm sandbox with a minimal DOM because the parts
// that matter are interactions: which annotations are produced, that the batch is
// ONE undo step, that the batch is handed to the select tool for per-box deletion,
// and that a miss/error leaves the canvas untouched.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const PATTERNS_PATH = path.join(ROOT, 'shared', 'sensitive-patterns.js')
const patterns = require(PATTERNS_PATH)

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const CAPTURE_SCRIPT = read('capture/capture.js')
const CAPTURE_HTML = read('capture/capture.html')
const CAPTURE_CSS = read('capture/capture.css')

// ---------------------------------------------------------------------------
// 1. Rule library: behaviour-level coverage (hits, boundaries, non-hits).
// ---------------------------------------------------------------------------

function idsOf(text) {
  return patterns.detectSensitiveText(text).map((match) => match.ruleId)
}

function matchesOf(text) {
  return patterns.detectSensitiveText(text)
}

test('N01: every rule is declared as { id, labelKey, pattern } and can return a category', () => {
  assert.ok(Array.isArray(patterns.RULES) && patterns.RULES.length >= 10)
  const allowedCategories = new Set(Object.values(patterns.CATEGORIES))
  for (const rule of patterns.RULES) {
    assert.equal(typeof rule.id, 'string')
    assert.ok(rule.id.length > 0, 'rule id must be non-empty')
    assert.match(rule.labelKey, /^capture-redact\.rule-[a-z0-9-]+$/, `${rule.id} labelKey must use the runtime locale namespace`)
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} must carry a RegExp pattern`)
    assert.ok(rule.pattern.global, `${rule.id} pattern must be global (detection uses matchAll)`)
    assert.ok(allowedCategories.has(rule.category), `${rule.id} must carry a known category`)
  }
  assert.equal(patterns.RULE_BY_ID['phone-cn'].category, 'contact')
})

test('N01: common API-key / token shapes are detected with ranges and categories', () => {
  const cases = [
    ['sk-proj-abcdefghijklmnop1234567890', 'openai-api-key'],
    ['sk-abcdefghijklmnop1234567890', 'openai-api-key'],
    ['ghp_1234567890abcdefghijklmnopqrstuvwx', 'github-token'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['Bearer abcdefghijklmnopqrstuvwxyz', 'bearer-token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl', 'jwt']
  ]
  for (const [text, expectedRule] of cases) {
    const haystack = `prefix ${text} suffix`
    const found = matchesOf(haystack)
    assert.deepEqual(found.map((match) => match.ruleId), [expectedRule], `${text} must be ${expectedRule}`)
    const [match] = found
    assert.equal(match.value, text, 'the reported value is the matched substring')
    assert.equal(haystack.slice(match.start, match.end), text, 'start/end must address the matched range')
    assert.equal(typeof match.category, 'string')
  }
})

test('N01: email, mainland phone, ID card, intranet IPv4, bank card and tokenised URLs are detected', () => {
  assert.deepEqual(idsOf('联系 dev.ops+alert@sub.example.co.uk 处理'), ['email'])
  assert.deepEqual(idsOf('电话13800138000请勿外传'), ['phone-cn'])
  const idMatch = matchesOf('身份证 11010519491231002X 请核对')[0]
  assert.equal(idMatch.ruleId, 'id-card-cn')
  assert.equal(idMatch.value, '11010519491231002X')
  assert.deepEqual(idsOf('10.0.0.1'), ['intranet-ipv4'])
  assert.deepEqual(idsOf('172.16.5.4'), ['intranet-ipv4'])
  assert.deepEqual(idsOf('192.168.1.100'), ['intranet-ipv4'])
  assert.deepEqual(idsOf('卡号 4111 1111 1111 1111 谢谢'), ['bank-card'])
  assert.deepEqual(idsOf('卡号 4111111111111111 谢谢'), ['bank-card'])
  assert.deepEqual(idsOf('打开 https://api.example.com/cb?access_token=abc123&state=ok'), ['url-token-query'])
  assert.deepEqual(idsOf('打开 https://api.example.com/cb?api_key=secret-value'), ['url-token-query'])
})

test('N01: non-sensitive prose does not match (short numbers, versions, ordinary words)', () => {
  const ordinary = [
    '版本 v2.0.1，构建号 20240101',
    '这是一个普通句子，包含 12345 和 3.14',
    '订单号 1234567890123456',
    'sk-learn-python-tutorial',
    'Bearer',
    'hello@world',
    'github_pat_short',
    '8.8.8.8 172.15.0.1 172.32.0.1 192.169.1.1',
    'https://example.com/page?page=2&sort=asc',
    '2024-01-01 12:30:45',
    'AKIA1234'
  ]
  for (const text of ordinary) {
    assert.deepEqual(patterns.detectSensitiveText(text), [], `must not match: ${text}`)
  }
})

test('N01: an invalid checksum is a non-match (ID card, bank card, invalid octets)', () => {
  // Valid ISO 7064 check digit -> hit; flipped -> miss.
  assert.deepEqual(idsOf('11010519491231002X'), ['id-card-cn'])
  assert.deepEqual(idsOf('110105194912310021'), [])
  // Luhn: 4111111111111111 passes, 4111111111111112 does not.
  assert.deepEqual(idsOf('4111111111111111'), ['bank-card'])
  assert.deepEqual(idsOf('4111111111111112'), [])
  // 19-digit Luhn-valid card is accepted; a failing 19-digit number is not.
  assert.deepEqual(idsOf('6222021234567890128'), ['bank-card'])
  assert.deepEqual(idsOf('6222021234567890123'), [])
  // Octet / range validation happens after the candidate match.
  assert.deepEqual(idsOf('10.0.0.256'), [])
  assert.equal(patterns.isIntranetIpv4('10.1.2.3'), true)
  assert.equal(patterns.isIntranetIpv4('172.15.1.1'), false)
  assert.equal(patterns.isIntranetIpv4('192.168.0.1'), true)
  assert.equal(patterns.validateLuhn('4111 1111 1111 1111'), true)
  assert.equal(patterns.validateChinaId('11010519491231002X'), true)
})

test('N01: the most specific rule owns an overlapping range (no double reporting)', () => {
  // 11 digits that happen to start with 1[3-9] inside an email local part: the email
  // rule runs first and claims the whole range, so the phone rule must not re-report a
  // sub-range of it.
  const emailWithPhoneLikeLocal = 'user13800138000@example.com'
  const found = matchesOf(emailWithPhoneLikeLocal)
  assert.equal(found.length, 1)
  assert.equal(found[0].ruleId, 'email')
  // The same text without the email shape still matches the phone rule.
  assert.deepEqual(idsOf('用户13800138000在线'), ['phone-cn'])
})

test('N01: detection is stateless across calls (no lastIndex leakage)', () => {
  const text = 'ghp_1234567890abcdefghijklmnopqrstuvwx'
  assert.deepEqual(idsOf(text), ['github-token'])
  assert.deepEqual(idsOf(text), ['github-token'])
  assert.deepEqual(idsOf(text), ['github-token'])
  assert.deepEqual(idsOf('nothing here'), [])
  assert.equal(patterns.hasSensitiveText('a@b.co'), true)
  assert.equal(patterns.hasSensitiveText('plain words'), false)
  assert.deepEqual(patterns.detectSensitiveText(''), [])
  assert.deepEqual(patterns.detectSensitiveText(null), [])
})

// ---------------------------------------------------------------------------
// 2. OCR text block -> viewport-CSS redaction box mapping (pure behaviour).
// ---------------------------------------------------------------------------

const BLOCK_RECT = { x: 100, y: 50, w: 400, h: 200 }

function block(text, boxPoints) {
  return { text, text_score: 0.95, box_points: boxPoints }
}

test('N01: a hit block is mapped proportionally and padded outward', () => {
  const boxes = patterns.buildRedactionBoxes({
    blocks: [block('sk-abcdefghijklmnop1234567890', [
      { x: 200, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 120 }, { x: 200, y: 120 }
    ])],
    imageWidth: 800,
    imageHeight: 400,
    rect: BLOCK_RECT
  })
  assert.equal(boxes.length, 1)
  // scale = 400/800 = .5 horizontally and 200/400 = .5 vertically.
  assert.deepEqual({ x: boxes[0].x, y: boxes[0].y, w: boxes[0].w, h: boxes[0].h }, { x: 198, y: 98, w: 54, h: 14 })
  assert.deepEqual(boxes[0].ruleIds, ['openai-api-key'])
  assert.deepEqual(boxes[0].labelKeys, ['capture-redact.rule-api-key'])
  assert.deepEqual(boxes[0].categories, ['credential'])
})

test('N01: only blocks with a match produce a box; ordinary blocks are skipped', () => {
  const boxes = patterns.buildRedactionBoxes({
    blocks: [
      block('普通说明文字', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 20 }, { x: 0, y: 20 }]),
      block('dev@example.com', [{ x: 100, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 60 }, { x: 100, y: 60 }])
    ],
    imageWidth: 800,
    imageHeight: 400,
    rect: BLOCK_RECT
  })
  assert.equal(boxes.length, 1)
  assert.equal(boxes[0].labelKeys[0], 'capture-redact.rule-email')
})

test('N01: the whole text block is covered, including a non-matched neighbour word in the same block', () => {
  const boxes = patterns.buildRedactionBoxes({
    blocks: [block('token: sk-abcdefghijklmnop1234567890 (do not share)', [
      { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 40 }, { x: 0, y: 40 }
    ])],
    imageWidth: 400,
    imageHeight: 200,
    rect: { x: 10, y: 20, w: 200, h: 100 }
  })
  assert.equal(boxes.length, 1)
  // A partial cover would leak the rest of the credential; the full block is redacted.
  // The block spans the whole image, so it maps to the whole region; the outward padding
  // is clamped by the region edges (it may never reach outside what will be exported).
  assert.equal(boxes[0].x, 10)
  assert.equal(boxes[0].w, 200)
})

test('N01: a rotated point set maps by its axis-aligned bounding box and clamps to the region', () => {
  const boxes = patterns.buildRedactionBoxes({
    blocks: [block('13800138000', [
      { x: 0, y: 10 }, { x: 90, y: 0 }, { x: 100, y: 30 }, { x: 10, y: 40 }
    ])],
    imageWidth: 100,
    imageHeight: 50,
    rect: { x: 0, y: 0, w: 100, h: 50 },
    padding: 4
  })
  assert.equal(boxes.length, 1)
  // Bounding box 0..100 x 0..40 maps 1:1; padding pushes to the region edges and clamps.
  assert.deepEqual({ x: boxes[0].x, y: boxes[0].y, w: boxes[0].w, h: boxes[0].h }, { x: 0, y: 0, w: 100, h: 44 })
})

test('N01: invalid inputs and duplicate mapped boxes are handled without throwing', () => {
  assert.deepEqual(patterns.buildRedactionBoxes(), [])
  assert.deepEqual(patterns.buildRedactionBoxes({ blocks: [], imageWidth: 1, imageHeight: 1, rect: BLOCK_RECT }), [])
  assert.deepEqual(patterns.buildRedactionBoxes({ blocks: [block('a@b.co', [{ x: 0, y: 0 }])], imageWidth: 10, imageHeight: 10, rect: BLOCK_RECT }), [], 'fewer than 4 points is not a box')
  assert.deepEqual(patterns.buildRedactionBoxes({ blocks: [block('a@b.co', [])], imageWidth: 0, imageHeight: 0, rect: BLOCK_RECT }), [])
  assert.deepEqual(patterns.buildRedactionBoxes({ blocks: [block('a@b.co', [{}, {}, {}, {}])], imageWidth: 10, imageHeight: 10, rect: BLOCK_RECT }), [], 'non-finite points are ignored')
  // Two blocks with the same geometry and the same credential collapse to one box.
  const pointSet = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }, { x: 0, y: 10 }]
  const boxes = patterns.buildRedactionBoxes({
    blocks: [block('dev@example.com', pointSet), block('dev@example.com', pointSet)],
    imageWidth: 100,
    imageHeight: 100,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    padding: 0
  })
  assert.equal(boxes.length, 1)
  assert.deepEqual({ x: boxes[0].x, y: boxes[0].y, w: boxes[0].w, h: boxes[0].h }, { x: 0, y: 0, w: 50, h: 10 })
})

// ---------------------------------------------------------------------------
// 3. Locale table: the runtime namespace exists in all three languages.
// ---------------------------------------------------------------------------

const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function loadLocaleTables() {
  globalThis.__LOCALES = {}
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js']) {
    const file = path.join(ROOT, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  return {
    'zh-CN': globalThis.__LOCALES['zh-CN'] || {},
    'en-US': globalThis.__LOCALES['en-US'] || {},
    'zh-TW': globalThis.__LOCALES['zh-TW'] || {}
  }
}

test('N01: the capture-redact namespace is complete and symmetric across zh-CN / en-US / zh-TW', () => {
  const tables = loadLocaleTables()
  const keysOf = (language) => Object.keys(tables[language]).filter((key) => key.startsWith('capture-redact.')).sort()
  const reference = keysOf('zh-CN')
  assert.ok(reference.length >= 20, 'the redaction namespace must carry the panel copy and every rule label')
  for (const language of LANGUAGES.slice(1)) {
    assert.deepEqual(reference.filter((key) => !keysOf(language).includes(key)), [], `${language} is missing capture-redact keys`)
    assert.deepEqual(keysOf(language).filter((key) => !reference.includes(key)), [], `${language} defines extra capture-redact keys`)
  }
  for (const rule of patterns.RULES) {
    for (const language of LANGUAGES) {
      const value = tables[language][rule.labelKey]
      assert.equal(typeof value, 'string', `${language} must define ${rule.labelKey}`)
      assert.ok(value.length > 0)
      assert.notEqual(value, rule.labelKey)
    }
  }
  for (const key of reference) {
    for (const language of LANGUAGES) {
      assert.equal(typeof tables[language][key], 'string', `${language}/${key} must be a string`)
      assert.ok(tables[language][key].length > 0, `${language}/${key} must not be empty`)
    }
  }
  // The three languages really carry different copy (a copied zh-CN row would hide a
  // missing translation).
  assert.notEqual(tables['zh-CN']['capture-redact.title'], tables['en-US']['capture-redact.title'])
  assert.notEqual(tables['zh-CN']['capture-redact.title'], tables['zh-TW']['capture-redact.title'])
})

// ---------------------------------------------------------------------------
// 4. capture.html / capture.js / capture.css wiring (structural contracts).
// ---------------------------------------------------------------------------

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const redactBlock = sliceBetween(CAPTURE_SCRIPT, 'function sensitiveApi()', 'function finishSelection()')
const applyBlock = sliceBetween(CAPTURE_SCRIPT, 'function applyRedactionBoxes(boxes)', 'async function runAutoRedact()')
const runBlock = sliceBetween(CAPTURE_SCRIPT, 'async function runAutoRedact()', 'function finishSelection()')
const panelMarkup = sliceBetween(CAPTURE_HTML, '<div id="redactPanel"', '<!-- B01 (docs/reviews/2026-11-24')

test('N01: capture.html ships the redaction panel outside the measured toolbar rows', () => {
  assert.match(CAPTURE_HTML, /<div id="redactPanel" class="redact-panel hidden" role="group">/)
  // A sibling of the watermark/magnifier panels, after them and before the skip switch.
  const panelIndex = CAPTURE_HTML.indexOf('id="redactPanel"')
  assert.ok(panelIndex > CAPTURE_HTML.indexOf('id="magnifierPanel"'))
  assert.ok(panelIndex < CAPTURE_HTML.indexOf('id="skipHistoryToggle"'))
  assert.ok(panelIndex > CAPTURE_HTML.indexOf('<div id="elementBar"'), 'not inside a measured toolbar row')
  assert.match(panelMarkup, /<strong id="redactTitle"><\/strong>/)
  assert.match(panelMarkup, /<div id="redactScopeRow" class="redact-row redact-scope-row" role="group">/)
  assert.match(panelMarkup, /data-redact-scope="selection" aria-pressed="true"/)
  assert.match(panelMarkup, /data-redact-scope="image" aria-pressed="false"/)
  assert.match(panelMarkup, /<button id="redactRun" class="primary" type="button"><\/button>/)
  assert.match(panelMarkup, /<div id="redactStatus" class="redact-status hidden" role="status" aria-live="polite"><\/div>/)
  // The copy is runtime-written from the capture-redact.* namespace: no data-i18n marker
  // may be introduced (the frozen capture.* golden table must stay untouched).
  assert.doesNotMatch(panelMarkup, /data-i18n/, 'the panel carries no data-i18n marker')
  assert.doesNotMatch(panelMarkup, /--icon:url\(/, 'the panel adds no toolbar icons')
})

test('N01: capture.html loads the rule library before the controller', () => {
  const patternsIndex = CAPTURE_HTML.indexOf('<script src="../shared/sensitive-patterns.js"></script>')
  const captureIndex = CAPTURE_HTML.indexOf('<script src="capture.js"></script>')
  const occlusionIndex = CAPTURE_HTML.indexOf('<script src="../shared/occlusion-mask.js"></script>')
  assert.ok(patternsIndex > 0, 'capture.html must load shared/sensitive-patterns.js')
  assert.ok(captureIndex > patternsIndex, 'the rule library must load before capture.js')
  assert.ok(occlusionIndex >= 0 && patternsIndex > occlusionIndex, 'loads with the other shared privacy contracts')
})

test('N01: capture.js reads the library lazily and never at load time', () => {
  assert.match(CAPTURE_SCRIPT, /function sensitiveApi\(\) \{\s*return window\.sensitivePatterns \|\| null\s*\}/)
  // A load-time dereference would break every window that loads the controller without
  // the module (the existing toolbar vm harness is exactly that case).
  assert.doesNotMatch(CAPTURE_SCRIPT, /^\s*(?:const|let|var)\s+\w+\s*=\s*window\.sensitivePatterns/m)
  assert.match(redactBlock, /if \(!api \|\| typeof api\.buildRedactionBoxes !== 'function'\)/)
})

test('N01: the OCR round-trip reuses the existing local capture:ocr channel on the masked canvas', () => {
  assert.match(runBlock, /exportSelectionCanvasForAction\(false, rect, \{ compose: false, mask: true \}\)/)
  assert.match(runBlock, /window\.captureAPI\.ocr\(imageBuffer, \{ scaleFactor:/)
  assert.match(runBlock, /window\.captureAPI\.ocr\(imageBuffer/)
  // The OCR text is local: the block may keep `result`/`blocks` in variables but must not
  // send text anywhere or store it.
  assert.doesNotMatch(runBlock, /recordHistory|localStorage|sessionStorage|fetch\(|XMLHttpRequest/)
  assert.doesNotMatch(runBlock, /console\.(?:log|warn|error)/, 'OCR text must not be logged')
  // The AI/network actions are deliberately absent: this path is the local OCR sidecar only.
  assert.doesNotMatch(runBlock, /translate\(|convertImage|aiClient|openRecognition/)
  // The mask refusal is explicit and happens before any annotation edit.
  assert.match(runBlock, /if \(!output\) \{\s*setRedactStatus\('capture-redact\.mask-unavailable'/)
})

test('N01: a hit becomes one type:blur batch and exactly ONE undo frame', () => {
  assert.match(applyBlock, /type: 'blur'/)
  assert.match(applyBlock, /x: box\.x,\s*y: box\.y,\s*x2: box\.x \+ box\.w,\s*y2: box\.y \+ box\.h/)
  assert.equal((applyBlock.match(/snapshotAnnotations\(\)/g) || []).length, 1, 'the whole batch is one undo step')
  // Handed to the shipped select tool so a click selects one box and Delete removes it.
  assert.match(applyBlock, /setTool\('select'\)/)
  assert.match(applyBlock, /selectedIds = new Set\(created\.map\(\(item\) => item\.id\)\)/)
  assert.match(applyBlock, /selectedAnnotation = created\[created\.length - 1\] \|\| null/)
})

test('N01: a miss / a refusal never changes the canvas', () => {
  // Both early exits happen before applyRedactionBoxes / snapshotAnnotations.
  assert.match(runBlock, /if \(!boxes\.length\) \{[\s\S]{0,260}?setRedactStatus\('capture-redact\.no-hit'/)
  const noHitIndex = runBlock.indexOf("setRedactStatus('capture-redact.no-hit'")
  const applyIndex = runBlock.indexOf('applyRedactionBoxes(boxes)')
  assert.ok(noHitIndex > 0 && applyIndex > noHitIndex, 'the miss path returns before any annotation is pushed')
  assert.match(runBlock, /catch \(error\) \{[\s\S]{0,260}?setRedactStatus\('capture-redact\.error'/)
})

test('N01: the panel is driven by runtime copy and mounted from the floating-ui path', () => {
  assert.match(CAPTURE_SCRIPT, /function syncRedactCopy\(\) \{[\s\S]{0,1600}?'capture-redact\.title'/)
  for (const key of ["'capture-redact.run'", "'capture-redact.run-tip'", "'capture-redact.scope'", "'capture-redact.scope-selection'", "'capture-redact.scope-image'"]) {
    assert.ok(CAPTURE_SCRIPT.includes(key), `syncRedactCopy must render ${key}`)
  }
  // Boot + language broadcast both re-derive the runtime copy.
  assert.match(CAPTURE_SCRIPT, /syncSkipHistoryCopy\(\)\s+\/\/ N01: the smart-redaction panel's copy[\s\S]{0,80}?syncRedactCopy\(\)/)
  assert.match(CAPTURE_SCRIPT, /syncSkipHistoryCopy\(\)\s+\/\/ N01: same rule[\s\S]{0,120}?syncRedactCopy\(\)[\s\S]{0,80}?syncRedactPanel\(\)/)
  // The floating-ui projection and the tool/selection paths keep the panel in step.
  const floating = sliceBetween(CAPTURE_SCRIPT, 'function updateFloatingUi()', 'function positionOcrResultBar()')
  assert.ok(floating.includes('syncRedactPanel()'), 'updateFloatingUi must re-evaluate the panel')
  assert.match(CAPTURE_SCRIPT, /function setTool\(tool\) \{[\s\S]{0,1800}?syncRedactPanel\(\)/)
  assert.match(CAPTURE_SCRIPT, /syncMagnifierPanel\(\)\s*\/\/ N01: the redaction panel has the same[\s\S]{0,120}?syncRedactPanel\(\)/)
  // Reset on a new capture.
  assert.match(CAPTURE_SCRIPT, /autoRedactIds = new Set\(\)\s*setRedactStatus\('', null, false\)/)
  // The click wiring: one-shot run button + one listener per scope button.
  assert.match(CAPTURE_SCRIPT, /if \(redactRunButton\) redactRunButton\.addEventListener\('click', \(\) => \{ runAutoRedact\(\) \}\)/)
  assert.match(CAPTURE_SCRIPT, /for \(const button of redactScopeButtons\) button\.addEventListener\('click', \(\) => chooseRedactScope\(button\.dataset\.redactScope\)\)/)
  // Selecting the scope re-evaluates the panel and the run button never runs twice.
  assert.match(CAPTURE_SCRIPT, /function chooseRedactScope\(scope\) \{\s*if \(redactBusy\) return/)
  assert.match(CAPTURE_SCRIPT, /if \(redactBusy \|\| processingAction \|\| recognitionHandoff\) return/)
  // The panel survives a finished run as a receipt, but the ACTION is only available while
  // the mosaic tool is active - otherwise a second click would stack an identical batch.
  assert.match(CAPTURE_SCRIPT, /const runnable = currentTool === 'blur'/)
  assert.match(CAPTURE_SCRIPT, /redactRunButton\.disabled = redactBusy \|\| !runnable/)
  assert.ok(CAPTURE_CSS.includes('.redact-panel {'), 'capture.css must style the panel')
  assert.match(CAPTURE_CSS, /\.redact-status\.error \{/)
})

// ---------------------------------------------------------------------------
// 5. vm-sandbox behaviour: the actual redaction run, undo, miss and refusal.
// ---------------------------------------------------------------------------

function createContext2d() {
  return new Proxy({}, {
    get: (target, key) => {
      if (key === 'canvas') return { width: 1200, height: 900 }
      if (key === 'measureText') return () => ({ width: 10 })
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (Object.hasOwn(target, key)) return target[key]
      return () => {}
    },
    set: (target, key, value) => { target[key] = value; return true }
  })
}

function createDom() {
  const elements = new Map()
  const toolButtons = []
  const redactScopeButtons = []

  function makeElement(id = '') {
    const classes = new Set()
    const attributes = new Map()
    const listeners = new Map()
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      placeholder: '',
      disabled: false,
      checked: false,
      hidden: false,
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      children: [],
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, on) => { const next = on === undefined ? !classes.has(name) : !!on; if (next) classes.add(name); else classes.delete(name); return next }
      },
      _classes: classes,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
      removeAttribute: (name) => attributes.delete(name),
      hasAttribute: (name) => attributes.has(name),
      addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler) },
      removeEventListener: () => {},
      dispatch: (type, event) => (listeners.get(type) || []).forEach((handler) => handler(event)),
      click() { this.dispatch('click', { target: this, stopPropagation() {}, preventDefault() {} }) },
      getBoundingClientRect: () => ({ width: 250, height: 120, left: 0, top: 0, right: 250, bottom: 120 }),
      closest: () => null,
      appendChild(child) { this.children.push(child); return child },
      append(...items) { this.children.push(...items) },
      replaceChildren(...items) { this.children = items },
      remove() {},
      focus() {},
      getContext: () => createContext2d(),
      // canvasPngBuffer() calls toBlob on the export canvas.
      toBlob: (callback) => callback({ arrayBuffer: async () => new ArrayBuffer(8) }),
      querySelectorAll: (selector) => querySelectorAll(selector),
      querySelector: (selector) => querySelectorAll(selector)[0] || null,
      contains: () => false,
      width: 1200,
      height: 900
    }
  }

  function querySelectorAll(selector) {
    if (selector === '[data-tool]') return toolButtons
    if (selector === '[data-redact-scope]') return redactScopeButtons
    if (selector === '[data-annotation-option]') return []
    return []
  }

  return { elements, toolButtons, redactScopeButtons, makeElement, get: (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id) }, querySelectorAll }
}

function createHarness({ ocr } = {}) {
  const dom = createDom()
  const ocrCalls = []
  for (const tool of ['select', 'rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'blur', 'text', 'serial', 'watermark', 'magnifier']) {
    const button = dom.makeElement(`tool:${tool}`)
    button.dataset.tool = tool
    dom.toolButtons.push(button)
  }
  for (const scope of ['selection', 'image']) {
    const button = dom.makeElement(`scope:${scope}`)
    button.dataset.redactScope = scope
    button.setAttribute('aria-pressed', scope === 'selection' ? 'true' : 'false')
    button.closest = (selector) => (selector === '[data-redact-scope]' ? button : null)
    dom.redactScopeButtons.push(button)
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    devicePixelRatio: 1,
    innerWidth: 1200,
    innerHeight: 900,
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '#e5a44c' }),
    Image: class { constructor() { this.complete = false; this.naturalWidth = 0 } },
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: {
      getElementById: (id) => dom.get(id),
      createElement: (tag) => dom.makeElement(`created:${tag}`),
      querySelectorAll: (selector) => dom.querySelectorAll(selector),
      querySelector: (selector) => dom.querySelectorAll(selector)[0] || null,
      addEventListener: () => {},
      removeEventListener: () => {},
      body: dom.get('body'),
      documentElement: {
        style: { setProperty() {}, removeProperty() {} },
        classList: dom.get('documentElement').classList,
        dataset: {}
      },
      activeElement: null,
      createTextNode: () => ({})
    },
    window: null,
    alert: () => {},
    confirm: () => true,
    prompt: () => '',
    addEventListener: () => {},
    removeEventListener: () => {},
    captureAPI: {
      onInit: () => {},
      onShown: () => {},
      ready: () => {},
      renderReady: () => {},
      renderError: () => {},
      close: () => {},
      onInterfaceLanguage: () => () => {},
      saveAnnotationStyles: async () => {},
      saveAnnotationColor: async () => {},
      saveAnnotationWidth: async () => {},
      saveWatermarkSettings: async () => {},
      recordHistory: async () => {},
      ocr: async (buffer, options) => {
        ocrCalls.push({ buffer, options })
        if (typeof ocr === 'function') return ocr(buffer, options)
        return { text: '', textBlocks: [], imageWidth: 1, imageHeight: 1 }
      }
    }
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  // The classic scripts capture.html loads before capture.js; the locale table is the
  // real one (the assertions below compare the rendered Chinese wording, not mock keys).
  const scripts = [
    'shared/i18n.js',
    'shared/locales/capture.js',
    'capture/annotation-style.js',
    'capture/annotation-geometry.js',
    'capture/selection-utils.js',
    'capture/mosaic-patch-cache.js',
    'shared/occlusion-mask.js',
    'shared/sensitive-patterns.js'
  ]
  for (const script of scripts) vm.runInNewContext(read(script), sandbox)
  vm.runInNewContext(
    'window.annotationStyleUtils = annotationStyleUtils; window.annotationGeometry = annotationGeometry;',
    sandbox
  )
  vm.runInNewContext(CAPTURE_SCRIPT, sandbox)

  // capture.js keeps its state in top-level `let` bindings: bridge the reads/writes the
  // tests drive through a small accessor object evaluated in the same context.
  const state = vm.runInNewContext(`({
    get selection() { return selection }, set selection(value) { selection = value },
    get currentTool() { return currentTool }, set currentTool(value) { currentTool = value },
    get annotations() { return annotations }, set annotations(value) { annotations = value },
    get image() { return image }, set image(value) { image = value },
    get initData() { return initData }, set initData(value) { initData = value },
    get historyIndex() { return historyIndex },
    get selectedIds() { return selectedIds },
    get selectedAnnotation() { return selectedAnnotation },
    get autoRedactIds() { return autoRedactIds },
    get redactScope() { return redactScope },
    get redactBusy() { return redactBusy },
    get toolStyles() { return toolStyles }, set toolStyles(value) { toolStyles = value }
  })`, sandbox)

  return { sandbox, state, dom, ocrCalls, ocrScopeButtons: dom.redactScopeButtons }
}

// The image is 2400x1800 while the stage is 1200x900, so the source-pixel factor is
// exactly 2 on both axes - the mapping assertions stay integer-exact by construction.
function prepareBlurRun(harness, { imageWidth = 2400, imageHeight = 1800, selection = { x: 100, y: 100, w: 200, h: 100 } } = {}) {
  harness.state.initData = {
    scaleFactor: 2,
    source: 'region',
    captureBounds: { x: 0, y: 0 },
    settings: { plugins: { ocr: true } }
  }
  harness.state.image = { complete: true, naturalWidth: imageWidth, naturalHeight: imageHeight }
  harness.state.selection = selection
  harness.state.currentTool = 'blur'
  harness.sandbox.syncRedactPanel()
}

function selectionHitResult() {
  return {
    text: 'sk-proj-abcdefghijklmnop1234567890\n普通说明文字',
    imageWidth: 400,
    imageHeight: 200,
    textBlocks: [
      {
        text: 'sk-proj-abcdefghijklmnop1234567890',
        text_score: 0.98,
        box_points: [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 40 }, { x: 20, y: 40 }]
      },
      {
        text: '普通说明文字',
        text_score: 0.9,
        box_points: [{ x: 130, y: 60 }, { x: 200, y: 60 }, { x: 200, y: 80 }, { x: 130, y: 80 }]
      }
    ]
  }
}

test('N01 (behaviour): a hit batch becomes blur annotations in exactly one undo step', async () => {
  const harness = createHarness({ ocr: () => selectionHitResult() })
  prepareBlurRun(harness)
  const { sandbox, state, dom, ocrCalls } = harness

  await sandbox.runAutoRedact()

  assert.equal(ocrCalls.length, 1, 'one OCR round-trip per click')
  assert.equal(ocrCalls[0].options.scaleFactor, 2, 'the OCR action option is reused')
  assert.equal(state.annotations.length, 1, 'only the hit block becomes a box')
  const blur = state.annotations[0]
  assert.equal(blur.type, 'blur')
  assert.deepEqual({ x: blur.x, y: blur.y, x2: blur.x2, y2: blur.y2 }, { x: 108, y: 108, x2: 162, y2: 122 })
  assert.equal(state.historyIndex, 1, 'the batch is one snapshot frame')
  assert.equal(state.currentTool, 'select', 'handed to the select tool so per-box editing works')
  assert.equal(state.selectedIds.size, 1)
  assert.ok(state.selectedIds.has(blur.id))
  assert.ok(state.autoRedactIds.has(blur.id))
  const status = dom.get('redactStatus')
  assert.equal(status.textContent, '已生成 1 个脱敏框（API Key）')
  assert.equal(status.classList.contains('error'), false)
  assert.equal(dom.get('redactPanel').classList.contains('hidden'), false, 'the result stays readable while the batch is selected')
  // Privacy: the recognized text never reaches the DOM, only the matched rule labels do.
  assert.doesNotMatch(status.textContent, /sk-proj|abcdefghijklmnop|普通说明文字/)
  assert.doesNotMatch(JSON.stringify(state.annotations), /sk-proj|abcdefghijklmnop|普通说明文字/)

  // Ctrl+Z: ONE step removes the whole batch; Ctrl+Y restores it.
  sandbox.undoAnnotations()
  assert.equal(state.annotations.length, 0)
  sandbox.redoAnnotations()
  assert.equal(state.annotations.length, 1)
})

test('N01 (behaviour): the run button is disabled and progress is shown while OCR is in flight', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const harness = createHarness({ ocr: () => pending.then(() => selectionHitResult()) })
  prepareBlurRun(harness)
  const { sandbox, dom } = harness
  const running = sandbox.runAutoRedact()
  // The OCR round-trip is pending: progress is visible and every panel button is locked.
  assert.equal(dom.get('redactRun').disabled, true)
  assert.equal(dom.get('redactStatus').textContent, '正在本地识别敏感信息…')
  for (const button of harness.ocrScopeButtons) assert.equal(button.disabled, true, 'scope buttons are locked too')
  release()
  await running
  assert.equal(harness.state.redactBusy, false)
  // After a successful run the panel stays as a receipt with the action disabled (it is
  // the mosaic tool's action); re-activating the mosaic tool makes it available again.
  assert.equal(dom.get('redactRun').disabled, true)
  sandbox.setTool('blur')
  assert.equal(dom.get('redactRun').disabled, false)
})

test('N01 (behaviour): a single box can be clicked and deleted after the batch (shipped select path)', async () => {
  const harness = createHarness({ ocr: () => ({
    imageWidth: 400,
    imageHeight: 200,
    textBlocks: [
      { text: 'dev@example.com', text_score: 0.9, box_points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 20 }, { x: 10, y: 20 }] },
      { text: '13800138000', text_score: 0.9, box_points: [{ x: 100, y: 30 }, { x: 150, y: 30 }, { x: 150, y: 40 }, { x: 100, y: 40 }] }
    ]
  }) })
  prepareBlurRun(harness)
  const { sandbox, state } = harness
  await sandbox.runAutoRedact()
  assert.equal(state.annotations.length, 2)
  // The batch was selected; simulate clicking the first box only (the select tool sets the
  // primary + the id set) and pressing Delete.
  const first = state.annotations[0]
  state.annotations = state.annotations.slice()
  sandbox.setSelectedAnnotation(first)
  assert.deepEqual([...state.selectedIds], [first.id])
  sandbox.deleteSelectedAnnotation()
  assert.equal(state.annotations.length, 1, 'one box removed, the other stays')
  assert.notEqual(state.annotations[0].id, first.id)
})

test('N01 (behaviour): no match shows a message and leaves the canvas untouched', async () => {
  const harness = createHarness({ ocr: () => ({
    imageWidth: 400,
    imageHeight: 200,
    textBlocks: [
      { text: '这一行只是普通的界面文字', text_score: 0.9, box_points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 20 }, { x: 10, y: 20 }] }
    ]
  }) })
  prepareBlurRun(harness)
  const { sandbox, state, dom } = harness
  await sandbox.runAutoRedact()
  assert.equal(state.annotations.length, 0, 'no annotation is fabricated on a miss')
  assert.equal(state.historyIndex, 0, 'no undo frame is pushed on a miss')
  assert.equal(state.currentTool, 'blur', 'the tool is not switched on a miss')
  assert.equal(dom.get('redactStatus').textContent, '未识别到敏感信息（共 1 个文本块）')
  assert.equal(state.redactBusy, false)
})

test('N01 (behaviour): an OCR failure is reported and leaves the canvas untouched', async () => {
  const harness = createHarness({ ocr: () => { throw new Error('OCR 引擎尚未就绪') } })
  prepareBlurRun(harness)
  const { sandbox, state, dom } = harness
  await sandbox.runAutoRedact()
  assert.equal(state.annotations.length, 0)
  assert.equal(state.historyIndex, 0)
  assert.equal(state.currentTool, 'blur')
  const status = dom.get('redactStatus')
  assert.equal(status.textContent, '本地识别失败：OCR 引擎尚未就绪')
  assert.equal(status.classList.contains('error'), true)
  assert.equal(state.redactBusy, false)
  assert.equal(harness.ocrCalls.length, 1)
})

test('N01 (behaviour): OCR disabled by settings is refused before the channel is called', async () => {
  const harness = createHarness({ ocr: () => { throw new Error('should not be called') } })
  prepareBlurRun(harness)
  harness.state.initData = { ...harness.state.initData, settings: { plugins: { ocr: false } } }
  await harness.sandbox.runAutoRedact()
  assert.equal(harness.ocrCalls.length, 0, 'nothing is sent when the OCR plugin is disabled')
  assert.equal(harness.state.annotations.length, 0)
  assert.equal(harness.dom.get('redactStatus').textContent, '文本识别不可用：请先在插件页面启用文本识别')
  assert.equal(harness.dom.get('redactStatus').classList.contains('error'), true)
})

test('N01 (behaviour): an unbuildable privacy mask refuses before sending anything', async () => {
  const harness = createHarness({ ocr: () => { throw new Error('should not be called') } })
  prepareBlurRun(harness)
  // An existing mosaic makes the occlusion plan mandatory; removing the mask module makes
  // the plan unbuildable, and the fail-closed contract must refuse rather than send the
  // pixels the user covered.
  harness.state.annotations = [{ id: 1, type: 'blur', x: 10, y: 10, x2: 60, y2: 30, color: '#ff3b30', width: 4 }]
  harness.sandbox.occlusionMask = undefined
  await harness.sandbox.runAutoRedact()
  assert.equal(harness.ocrCalls.length, 0, 'no unmasked image is ever sent')
  assert.equal(harness.state.annotations.length, 1, 'the existing mosaic is untouched')
  assert.equal(harness.state.historyIndex, 0)
  assert.equal(harness.dom.get('redactStatus').textContent, '遮罩无法生成，已取消脱敏以保护隐私。请删除已有马赛克后重试。')
})

test('N01 (behaviour): the "whole image" scope scans the full captured image', async () => {
  const harness = createHarness({ ocr: () => ({
    imageWidth: 2400,
    imageHeight: 1800,
    textBlocks: [
      { text: 'ak. 内网 10.0.0.1', text_score: 0.9, box_points: [{ x: 200, y: 200 }, { x: 400, y: 200 }, { x: 400, y: 400 }, { x: 200, y: 400 }] }
    ]
  }) })
  prepareBlurRun(harness)
  const { sandbox, state, dom } = harness
  const imageScopeButton = harness.ocrScopeButtons.find((button) => button.dataset.redactScope === 'image')
  imageScopeButton.click()
  assert.equal(state.redactScope, 'image')
  assert.equal(imageScopeButton.getAttribute('aria-pressed'), 'true')
  assert.equal(harness.ocrScopeButtons.find((button) => button.dataset.redactScope === 'selection').getAttribute('aria-pressed'), 'false')

  await sandbox.runAutoRedact()
  assert.equal(state.annotations.length, 1)
  const blur = state.annotations[0]
  // Mapping is relative to the whole stage (1200x900) against a 2400x1800 image: scale 0.5.
  assert.deepEqual({ x: blur.x, y: blur.y, x2: blur.x2, y2: blur.y2 }, { x: 98, y: 98, x2: 202, y2: 202 })
  assert.equal(dom.get('redactStatus').textContent, '已生成 1 个脱敏框（内网 IP）')
})
