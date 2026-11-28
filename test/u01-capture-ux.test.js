'use strict'

// U01 —— docs/reviews/2026-11-26-code-review-and-optimization-report.md section 4.1
// ("capture & annotate"), three defects fixed together:
//
//   1. A multi-selection could be nudged and recoloured in bulk, but a mouse drag only moved the
//      item under the pointer. `pendingMove` now snapshots every selected origin + their union
//      box, and the drag translates the whole set by one clamped delta (one undo frame).
//   2. Text annotations were collected with a blocking window.prompt() (no preview, one line),
//      and the pure geometry estimated every character at 0.6em, so a Chinese label's box was
//      ~40% too narrow and its right half could not be clicked. Text is now edited in a floating
//      <textarea> (capture/annotation-inline-editor.js) and the box is measured per code point
//      (CJK 1em / ASCII 0.6em) with multi-line and optional ctx.measureText support.
//   3. `captureAPI.exportPdf()` already returned the main-process receipt and capture.js already
//      had `exportResultBar` + `showExportResult()`, but the PDF branch dropped the return value,
//      so a finished export never showed its result bar.
//
// The pure functions and the inline editor are exercised behaviourally (plain node + a minimal
// fake DOM). The capture.js wiring is pinned by source-structure assertions plus a vm harness in
// the spirit of test/capture-toolbar-regressions.test.js: the real capture.js runs against a
// stub DOM, so "type text -> Enter -> one annotation, one undo frame" is asserted through the
// module's own event handlers rather than by reading its text.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const captureScript = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const captureHtml = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const captureCss = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const inlineEditorSource = fs.readFileSync(path.join(root, 'capture', 'annotation-inline-editor.js'), 'utf8')
const captureDomain = fs.readFileSync(path.join(root, 'main', 'domains', 'capture', 'index.js'), 'utf8')

const geometry = require('../capture/annotation-geometry')
const {
  annotationBounds,
  findAnnotationAt,
  hitTestAnnotation,
  textLines,
  textLineHeight,
  textBoxSize,
  unionAnnotationBounds,
  clampSetTranslation,
  translateAnnotationSetToStage,
  TEXT_WIDTH_RATIO,
  CJK_TEXT_WIDTH_RATIO
} = geometry
const { textFontSize } = require('../capture/annotation-style')
const {
  createInlineTextEditor,
  textEditorKeyIntent,
  isComposingEvent,
  insertNewline,
  KEY_INTENTS
} = require('../capture/annotation-inline-editor')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' is declared')
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${name} body is not balanced`)
}

// ---------------------------------------------------------------------------------------------
// 1. Text geometry: CJK full-width glyphs, multi-line layout, injectable measurer
// ---------------------------------------------------------------------------------------------

test('U01 §4.1: a CJK text box accumulates full-width glyphs, so its right half is hit-testable', () => {
  const size = textFontSize(4)
  assert.equal(size, 20)
  const cjk = { type: 'text', x: 100, y: 100, text: '中文标注', color: '#ff3b30', width: 4 }
  const ascii = { type: 'text', x: 100, y: 100, text: 'abcd', color: '#ff3b30', width: 4 }
  const cjkBox = annotationBounds(cjk)
  const asciiBox = annotationBounds(ascii)
  // Four full-width glyphs are ~4em wide; four ASCII glyphs stay at the shipped 0.6em each.
  assert.equal(cjkBox.w, 4 * size)
  assert.equal(asciiBox.w, 4 * size * TEXT_WIDTH_RATIO)
  assert.equal(cjkBox.h, size)
  assert.equal(asciiBox.h, size)
  // A mixed string accumulates per code point (1em CJK + 0.6em ASCII).
  assert.equal(annotationBounds({ ...cjk, text: '中a' }).w, size + size * TEXT_WIDTH_RATIO)
  // The reported bug: this point is inside the painted glyphs but was outside the old 0.6em
  // estimate, so the right half of the label could never be selected or dragged.
  const rightHalf = { x: 100 + 3 * size, y: 100 + size / 2 }
  assert.equal(findAnnotationAt([cjk], rightHalf), cjk, 'the right half of a CJK label is clickable')
  assert.equal(hitTestAnnotation(cjk, rightHalf), true)
  // The ASCII sibling keeps the exact same hit behaviour it always had.
  assert.equal(findAnnotationAt([ascii], { x: 100 + 3 * size, y: 100 + size / 2 }), null)
  assert.equal(hitTestAnnotation(ascii, { x: 100 + 2 * size, y: 100 + size / 2 }), true)
  // Constants are the shared contract, not magic numbers hidden in the branch.
  assert.equal(CJK_TEXT_WIDTH_RATIO, 1)
})

test('U01 §4.1: multi-line text grows the painted box by the shared line height', () => {
  const size = textFontSize(4)
  const step = textLineHeight(size)
  assert.ok(step > size, 'lines must not collapse into each other')
  const two = annotationBounds({ type: 'text', x: 4, y: 6, text: 'A\nB', color: '#f00', width: 4 })
  assert.deepEqual(two, { x: 4, y: 6, w: size, h: size + step })
  const three = annotationBounds({ type: 'text', x: 0, y: 0, text: 'A\r\nB\r\nC', color: '#f00', width: 4 })
  assert.equal(three.h, size + 2 * step)
  // The widest line decides the width: the box never shrinks to the shortest line.
  const mixed = annotationBounds({ type: 'text', x: 0, y: 0, text: 'i\nMMMMM', color: '#f00', width: 4 })
  assert.equal(mixed.w, Math.max(size, 5 * size * TEXT_WIDTH_RATIO))
  // Every line-ending flavour the textarea can produce is one logical line break.
  assert.deepEqual(textLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(textLines(''), [''])
  assert.deepEqual(textLines(null), [''])
  // A trailing break is a real second line (the user pressed Ctrl+Enter and committed).
  assert.deepEqual(textLines('a\n'), ['a', ''])
  assert.equal(annotationBounds({ type: 'text', x: 0, y: 0, text: 'a\n', color: '#f00', width: 4 }).h, size + step)
})

test('U01 §4.1: the legacy single-line and empty-text boxes are unchanged', () => {
  const size = textFontSize(4)
  // Pinned by the shipped PR1 contract: one line is exactly { w: estimate, h: size }.
  assert.deepEqual(
    annotationBounds({ type: 'text', x: 12, y: 30, text: 'abc', color: '#f00', width: 4 }),
    { x: 12, y: 30, w: Math.max(size, 3 * size * TEXT_WIDTH_RATIO), h: size }
  )
  assert.deepEqual(
    annotationBounds({ type: 'text', x: 1, y: 2, color: '#f00', width: 4 }),
    { x: 1, y: 2, w: size, h: size }
  )
  assert.deepEqual(textBoxSize('', size), { w: size, h: size })
})

test('U01 §4.1: a caller with real font metrics can inject a measurer (ctx.measureText)', () => {
  const calls = []
  const measurer = (line, size) => {
    calls.push([line, size])
    return line.length * 10
  }
  assert.deepEqual(textBoxSize('abc', 20, measurer), { w: 30, h: 20 })
  // The box resolver forwards the measurer through its optional second argument.
  const box = annotationBounds({ type: 'text', x: 0, y: 0, text: 'abc', color: '#f00', width: 4 }, { measurer })
  assert.equal(box.w, 30)
  assert.deepEqual(calls[0], ['abc', 20])
  // Multi-line measurement asks for every line and takes the widest one.
  calls.length = 0
  const multi = annotationBounds({ type: 'text', x: 0, y: 0, text: 'a\nbbbb', color: '#f00', width: 4 }, { measurer })
  assert.deepEqual(calls, [['a', 20], ['bbbb', 20]])
  assert.equal(multi.w, 40)
  // A broken measurer degrades to the deterministic estimate instead of producing NaN boxes.
  assert.equal(textBoxSize('abc', 20, () => Number.NaN).w, 3 * 20 * TEXT_WIDTH_RATIO)
  assert.equal(textBoxSize('abc', 20, () => -1).w, 3 * 20 * TEXT_WIDTH_RATIO)
})

// ---------------------------------------------------------------------------------------------
// 2. Whole-selection drag: union box, one delta, clamp, origins never mutated
// ---------------------------------------------------------------------------------------------

function rectAt(id, x, y) {
  return { id, type: 'rect', x, y, x2: x + 50, y2: y + 30, color: '#f00', width: 4 }
}

test('U01 §4.1: unionAnnotationBounds covers every selected box and ignores unusable input', () => {
  const left = rectAt(1, 10, 10)
  const right = rectAt(2, 100, 40)
  assert.deepEqual(unionAnnotationBounds([left, right]), { x: 10, y: 10, w: 140, h: 60 })
  assert.deepEqual(unionAnnotationBounds([right]), { x: 100, y: 40, w: 50, h: 30 })
  // A multi-line text contributes its full painted height, not a single line.
  const text = { id: 3, type: 'text', x: 0, y: 0, text: 'A\nB', color: '#f00', width: 4 }
  const size = textFontSize(4)
  assert.deepEqual(unionAnnotationBounds([text]), { x: 0, y: 0, w: size, h: size + textLineHeight(size) })
  assert.equal(unionAnnotationBounds([]), null)
  assert.equal(unionAnnotationBounds(null), null)
  assert.equal(unionAnnotationBounds([null, undefined]), null)
})

test('U01 §4.1: a set translation applies one delta to every item and never mutates the origins', () => {
  const left = rectAt(1, 10, 10)
  const right = rectAt(2, 100, 40)
  const origins = [left, right]
  const result = translateAnnotationSetToStage(origins, 20, -5, { w: 1000, h: 800 })
  assert.deepEqual(result && { dx: result.dx, dy: result.dy }, { dx: 20, dy: -5 })
  assert.equal(result.items.length, 2)
  // Relative spacing is preserved: both items got exactly the requested delta.
  assert.equal(result.items[0].x, 30)
  assert.equal(result.items[1].x, 120)
  assert.equal(result.items[0].y, 5)
  assert.equal(result.items[1].y, 35)
  // The per-item x2/y2 follows too, so the shapes stay the same size.
  assert.equal(result.items[0].x2, 80)
  assert.equal(result.items[1].y2, 65)
  // Origins are untouched (the drag re-derives from them on every frame).
  assert.equal(left.x, 10)
  assert.equal(right.x, 100)
  assert.notEqual(result.items[0], left)
  // A pen point set is copied, not shared with the origin.
  const pen = { id: 9, type: 'pen', x: 0, y: 0, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], width: 4 }
  const movedPen = translateAnnotationSetToStage([pen], 5, 5, { w: 500, h: 500 })
  assert.deepEqual(movedPen.items[0].points, [{ x: 6, y: 7 }, { x: 8, y: 9 }])
  assert.deepEqual(pen.points, [{ x: 1, y: 2 }, { x: 3, y: 4 }])
  assert.equal(translateAnnotationSetToStage([], 1, 1, { w: 10, h: 10 }), null)
  assert.equal(translateAnnotationSetToStage(null, 1, 1, { w: 10, h: 10 }), null)
})

test('U01 §4.1: the group clamp is the single-item clamp lifted to the union box', () => {
  const left = rectAt(1, 10, 10)
  const right = rectAt(2, 100, 10)
  const stage = { w: 800, h: 600 }
  // Far to the right: the union box stops at the stage edge (right item's right side = 800),
  // and both items receive the SAME effective delta, so the 90px gap survives.
  const clamped = clampSetTranslation([left, right], 10000, 0, stage)
  assert.deepEqual(clamped, { dx: 650, dy: 0 })
  const moved = translateAnnotationSetToStage([left, right], 10000, 0, stage)
  assert.equal(moved.items[1].x2, 800)
  assert.equal(moved.items[1].x - moved.items[0].x, 90)
  // Far up/left: the union origin pins to 0 instead of letting items fly out.
  assert.deepEqual(clampSetTranslation([left, right], -500, -500, stage), { dx: -10, dy: -10 })
  // An oversized union degenerates exactly like clampAnnotationToStage: it pins to one edge.
  const oversized = [rectAt(1, 300, 300), rectAt(2, 900, 700)]
  const pinned = translateAnnotationSetToStage(oversized, 0, 0, { w: 400, h: 300 })
  assert.equal(pinned.dx, -300, 'an oversized set is pulled back to the stage origin')
  assert.equal(pinned.dy, -300)
  assert.equal(pinned.items[0].x, 0)
  assert.equal(pinned.items[0].y, 0)
  // A zero delta still returns copies (the drag path relies on "origin is never touched").
  const same = translateAnnotationSetToStage([left], 0, 0, stage)
  assert.equal(same.dx, 0)
  assert.notEqual(same.items[0], left)
  assert.deepEqual(same.items[0], left)
})

// ---------------------------------------------------------------------------------------------
// 3. The inline text editor: key contract + DOM behaviour (minimal fake DOM)
// ---------------------------------------------------------------------------------------------

function fakeElement(tagName = 'div') {
  const listeners = new Map()
  const classes = new Set()
  const attributes = new Map()
  const element = {
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    placeholder: '',
    hidden: false,
    style: {},
    children: [],
    parentNode: null,
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => {
        const next = on === undefined ? !classes.has(name) : !!on
        if (next) classes.add(name)
        else classes.delete(name)
        return next
      }
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    removeEventListener: () => {},
    dispatch: (type, event) => (listeners.get(type) || []).forEach((handler) => handler(event)),
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
    },
    focus() { this.focused = true },
    blur() {
      this.focused = false
      this.dispatch('blur', {})
    },
    setSelectionRange(start, end) {
      this.selectionStart = start
      this.selectionEnd = end
    },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end)
      this.selectionStart = this.selectionEnd = start + text.length
    },
    listeners
  }
  // A real textarea moves the caret to the end whenever its value is assigned; the tests rely on
  // that (Ctrl+Enter inserts at the caret), so the fake mirrors it.
  let textValue = ''
  Object.defineProperty(element, 'value', {
    get: () => textValue,
    set: (next) => {
      textValue = String(next ?? '')
      element.selectionStart = textValue.length
      element.selectionEnd = textValue.length
    }
  })
  return element
}

function createFakeDocument() {
  const body = fakeElement('body')
  const documentRef = {
    body,
    documentElement: body,
    activeElement: null,
    createElement: (tagName) => fakeElement(tagName)
  }
  return { document: documentRef, body }
}

function openEditor(overrides = {}) {
  const { document } = createFakeDocument()
  const calls = []
  const editor = createInlineTextEditor({
    document,
    translate: (key) => key,
    getViewport: () => ({ width: 800, height: 600 })
  })
  const opened = editor.open({
    rect: { x: 100, y: 200 },
    text: 'hi',
    fontSize: 20,
    lineHeight: 24,
    color: '#1687ff',
    bold: true,
    measureWidth: (value) => value.length * 10,
    onInput: (value) => calls.push(['input', value]),
    onCommit: (value) => calls.push(['commit', value]),
    onCancel: () => calls.push(['cancel']),
    ...overrides
  })
  return { editor, calls, opened, textarea: editor.getElement() }
}

function keyEvent(key, options = {}) {
  const event = { key, ...options }
  event.prevented = false
  event.stopped = false
  event.preventDefault = () => { event.prevented = true }
  event.stopPropagation = () => { event.stopped = true }
  return event
}

test('U01 §4.1: the editor key contract is Enter=commit, Ctrl/Cmd/Alt+Enter=newline, Esc=cancel', () => {
  // Pure key intent first, so the contract is pinned without a DOM.
  assert.equal(textEditorKeyIntent({ key: 'Enter' }), KEY_INTENTS.COMMIT)
  assert.equal(textEditorKeyIntent({ key: 'Enter', ctrlKey: true }), KEY_INTENTS.NEWLINE)
  assert.equal(textEditorKeyIntent({ key: 'Enter', metaKey: true }), KEY_INTENTS.NEWLINE)
  assert.equal(textEditorKeyIntent({ key: 'Enter', altKey: true }), KEY_INTENTS.NEWLINE)
  assert.equal(textEditorKeyIntent({ key: 'Escape' }), KEY_INTENTS.CANCEL)
  assert.equal(textEditorKeyIntent({ key: 'a' }), '')
  assert.equal(textEditorKeyIntent({ key: 'Enter', isComposing: true }), '', 'an IME composition owns Enter')
  assert.equal(textEditorKeyIntent({ key: 'Enter', keyCode: 229 }), '', 'Chromium reports IME keys as 229')
  assert.equal(isComposingEvent({ isComposing: true }), true)
  assert.equal(isComposingEvent({ keyCode: 229 }), true)
  assert.equal(isComposingEvent({}), false)
  assert.equal(textEditorKeyIntent(null), '')
  // The newline primitive appends at the caret and keeps the caret after the break.
  const textarea = fakeElement('textarea')
  textarea.value = 'ab'
  textarea.setSelectionRange(1, 1)
  assert.equal(insertNewline(textarea), 'a\nb')
  assert.equal(textarea.selectionStart, 2)
})

test('U01 §4.1: the editor opens at the annotation position with the final text style', () => {
  const { calls, opened, textarea, editor } = openEditor()
  assert.equal(opened, true)
  assert.ok(textarea, 'the editor creates a textarea')
  assert.equal(textarea.tagName, 'TEXTAREA')
  assert.ok(textarea.parentNode, 'the editor mounts it in the document')
  assert.equal(textarea.value, 'hi')
  // It IS the live preview: same font size/weight/colour and the shared line height.
  assert.equal(textarea.style.color, '#1687ff')
  assert.equal(textarea.style.fontSize, '20px')
  assert.equal(textarea.style.lineHeight, '24px')
  assert.equal(textarea.style.fontWeight, 'bold')
  assert.equal(textarea.style.fontFamily, '-apple-system,"Microsoft YaHei",sans-serif')
  assert.equal(textarea.style.display, 'block')
  // Positioned at the annotation's canvas coordinates.
  assert.equal(textarea.style.left, '100px')
  assert.equal(textarea.style.top, '200px')
  // The initial value is echoed so capture.js can seed its draft from the same call.
  assert.deepEqual(calls, [['input', 'hi']])
  assert.equal(editor.isOpen(), true)
})

test('U01 §4.1: Enter commits, Ctrl+Enter inserts a line break and Escape cancels', () => {
  // Enter commits the current value and hides the editor.
  const first = openEditor()
  first.textarea.value = 'hello'
  first.textarea.dispatch('keydown', keyEvent('Enter'))
  assert.deepEqual(first.calls.at(-1), ['commit', 'hello'])
  assert.equal(first.editor.isOpen(), false)
  assert.equal(first.textarea.style.display, 'none')

  // Ctrl+Enter is multi-line input: it must not commit and must update the live value.
  const second = openEditor({ text: 'ab' })
  const enter = keyEvent('Enter', { ctrlKey: true })
  second.textarea.dispatch('keydown', enter)
  assert.equal(second.textarea.value, 'ab\n')
  assert.equal(second.editor.isOpen(), true)
  assert.deepEqual(second.calls.at(-1), ['input', 'ab\n'])
  assert.equal(enter.prevented, true, 'the editor owns Enter')
  assert.equal(enter.stopped, true, 'the window shortcut ladder must not see it')
  // Escape discards without committing.
  second.textarea.dispatch('keydown', keyEvent('Escape'))
  assert.deepEqual(second.calls.at(-1), ['cancel'])
  assert.equal(second.editor.isOpen(), false)
  assert.equal(second.calls.some(([kind]) => kind === 'commit'), false)

  // An IME composition keeps the editor open on Enter.
  const third = openEditor({ text: '中' })
  third.textarea.dispatch('keydown', keyEvent('Enter', { isComposing: true }))
  assert.equal(third.editor.isOpen(), true)
  assert.equal(third.calls.some(([kind]) => kind === 'commit' || kind === 'cancel'), false)
})

test('U01 §4.1: the editing surface grows with the text at the shared line height', () => {
  const { textarea, editor } = openEditor({ text: '' })
  assert.equal(textarea.style.height, '24px', 'one empty line is one line tall')
  assert.equal(textarea.style.width, '160px', 'an empty annotation gets a usable minimum width')
  // A long single line grows horizontally (measureWidth is the geometry estimate).
  textarea.value = 'x'.repeat(40)
  textarea.dispatch('input', {})
  assert.equal(textarea.style.width, `${40 * 10 + 12}px`)
  // A second line doubles the height; the width follows the widest line.
  textarea.value = 'x\nshort'
  textarea.dispatch('input', {})
  assert.equal(textarea.style.height, '48px')
  assert.equal(textarea.style.width, '160px')
  // The growth is capped so the editor stays inside the window.
  textarea.value = 'x'.repeat(200)
  textarea.dispatch('input', {})
  assert.equal(textarea.style.width, '700px', 'the editor never overflows the viewport')
  assert.equal(editor.isOpen(), true)
})

test('U01 §4.1: a re-edit opens with the old wording selected and blur commits once', () => {
  const { textarea, calls, editor } = openEditor({ text: '旧文案', selectAll: true })
  assert.equal(textarea.selectionStart, 0)
  assert.equal(textarea.selectionEnd, 3)
  // A click elsewhere (the toolbar, the canvas) blurs the textarea: the edit is committed.
  textarea.value = '新文案'
  textarea.dispatch('input', {})
  textarea.blur()
  assert.deepEqual(calls.at(-1), ['commit', '新文案'])
  assert.equal(editor.isOpen(), false)
  // A second blur after the close must not fire a second commit.
  textarea.dispatch('blur', {})
  assert.equal(calls.filter(([kind]) => kind === 'commit').length, 1)
  // A press inside the editor never reaches the canvas behind it.
  const reopened = openEditor()
  let stopped = false
  reopened.textarea.dispatch('pointerdown', { stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true)
})

// ---------------------------------------------------------------------------------------------
// 4. capture.js wiring, run for real in a vm sandbox with a stub DOM
// ---------------------------------------------------------------------------------------------

// The classic scripts capture.html loads before capture.js, in the same order.
const STYLE_MODULE = fs.readFileSync(path.join(root, 'capture', 'annotation-style.js'), 'utf8')
const GEOMETRY_MODULE = fs.readFileSync(path.join(root, 'capture', 'annotation-geometry.js'), 'utf8')
const SELECTION_MODULE = fs.readFileSync(path.join(root, 'capture', 'selection-utils.js'), 'utf8')
const MOSAIC_MODULE = fs.readFileSync(path.join(root, 'capture', 'mosaic-patch-cache.js'), 'utf8')
const I18N_RUNTIME = fs.readFileSync(path.join(root, 'shared', 'i18n.js'), 'utf8')

function createHarness() {
  const elements = new Map()
  const querySelectorAll = () => []

  function makeElement(id = '', tagName = 'div') {
    const element = fakeElement(tagName)
    element.id = id
    element.hidden = false
    element.disabled = false
    element.checked = false
    element.innerHTML = ''
    element.textContent = ''
    element.dataset = {}
    element.style = { setProperty() {}, removeProperty() {} }
    element.getBoundingClientRect = () => ({ width: 900, height: 34, left: 0, top: 0, right: 900, bottom: 34 })
    element.closest = () => null
    element.append = (...items) => element.children.push(...items)
    element.replaceChildren = (...items) => { element.children = items }
    element.remove = () => {}
    element.click = () => element.dispatch('click', { target: element, stopPropagation() {}, preventDefault() {} })
    element.getContext = () => createContext2d()
    element.querySelectorAll = () => []
    element.querySelector = () => null
    element.contains = () => false
    element.width = 1200
    element.height = 900
    return element
  }

  function createContext2d() {
    return new Proxy({}, {
      get: (target, key) => {
        if (key === 'canvas') return { width: 1200, height: 900 }
        if (key === 'measureText') return () => ({ width: 10 })
        if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
        if (Object.hasOwn(target, key)) return target[key]
        return () => {}
      },
      set: (target, key, value) => {
        target[key] = value
        return true
      }
    })
  }

  const sandbox = {
    console,
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
    getComputedStyle: () => ({ getPropertyValue: () => '#36a3ff' }),
    Image: class {
      constructor() { this.complete = false; this.naturalWidth = 0 }
    },
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeElement(id))
        return elements.get(id)
      },
      createElement: (tagName) => makeElement(`created-${tagName}`, tagName),
      querySelectorAll,
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      body: null,
      documentElement: null,
      activeElement: null,
      createTextNode: () => ({})
    },
    window: null,
    t: (key) => key,
    setLanguage() {},
    applyTranslations() {},
    currentLanguage: () => 'zh-CN',
    alert: () => {},
    confirm: () => true,
    prompt: () => { throw new Error('U01: window.prompt() must not be used for text annotations') },
    addEventListener: () => {},
    removeEventListener: () => {},
    captureAPI: {
      onInit: () => {},
      onShown: () => {},
      ready: () => {},
      renderReady: () => {},
      renderError: () => {},
      close: () => {},
      saveAnnotationStyles: () => Promise.resolve(),
      saveAnnotationColor: () => Promise.resolve(),
      saveAnnotationWidth: () => Promise.resolve(),
      saveWatermarkSettings: async () => {},
      recordHistory: async () => {},
      onInterfaceLanguage: () => () => {}
    }
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.document.body = sandbox.document.getElementById('body')
  sandbox.document.documentElement = sandbox.document.getElementById('documentElement')

  // Mirror the `hidden` classes capture.html ships: several pointer/key handlers early-return
  // on them, and the real page starts with every panel closed.
  for (const id of [
    'resultPanel', 'toolbar', 'colorPalette', 'pinMenu', 'convertDocMenu', 'regionPanel',
    'regionToggle', 'watermarkPanel', 'magnifierPanel', 'outputStylePanel', 'ocrResultBar',
    'pinOutputBar', 'skipHistoryHint', 'loading'
  ]) {
    const element = sandbox.document.getElementById(id)
    element.hidden = true
    element.classList.add('hidden')
  }

  // The classic scripts capture.html loads before capture.js, in the same order.
  vm.runInNewContext(I18N_RUNTIME, sandbox)
  vm.runInNewContext(STYLE_MODULE, sandbox)
  vm.runInNewContext(GEOMETRY_MODULE, sandbox)
  vm.runInNewContext(SELECTION_MODULE, sandbox)
  vm.runInNewContext(MOSAIC_MODULE, sandbox)
  vm.runInNewContext('window.annotationStyleUtils = annotationStyleUtils; window.annotationGeometry = annotationGeometry;', sandbox)
  // U01: the new classic script capture.html loads right before capture.js.
  vm.runInNewContext(inlineEditorSource, sandbox)
  vm.runInNewContext('window.annotationInlineEditor = annotationInlineEditor;', sandbox)
  vm.runInNewContext(captureScript, sandbox)

  // capture.js keeps its state in top-level `let` bindings, so the harness bridges the few the
  // tests drive/read through accessor properties evaluated in the same context.
  const state = vm.runInNewContext(`({
    get currentTool() { return currentTool }, set currentTool(value) { currentTool = value },
    get selection() { return selection }, set selection(value) { selection = value },
    get annotations() { return annotations }, set annotations(value) { annotations = value },
    get selectedIds() { return selectedIds }, set selectedIds(value) { selectedIds = value },
    get selectedAnnotation() { return selectedAnnotation }, set selectedAnnotation(value) { selectedAnnotation = value },
    get annotationHistory() { return annotationHistory },
    get historyIndex() { return historyIndex },
    get initData() { return initData }, set initData(value) { initData = value }
  })`, sandbox)

  const canvas = sandbox.document.getElementById('stage')
  return { sandbox, state, canvas, body: sandbox.document.body }
}

function pointerEvent(x, y, overrides = {}) {
  return { clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, shiftKey: false, altKey: false, ...overrides }
}

function findTextarea(body) {
  return body.children.find((child) => child.tagName === 'TEXTAREA') || null
}

test('U01 §4.1 (vm): the text tool opens the inline editor and Enter commits exactly one undo frame', () => {
  const harness = createHarness()
  const { sandbox, state, canvas, body } = harness
  state.selection = { x: 0, y: 0, w: 1200, h: 900 }
  state.currentTool = 'text'
  state.initData = { settings: { screenshot: {} } }

  canvas.dispatch('pointerdown', pointerEvent(100, 120))
  const textarea = findTextarea(body)
  assert.ok(textarea, 'the press opens the floating textarea instead of window.prompt()')
  assert.equal(textarea.style.display, 'block')
  assert.equal(sandbox.prompt.constructor.name, 'Function', 'the prompt stub exists only as a tripwire')
  assert.equal(state.annotations.length, 0, 'nothing is committed while typing')

  textarea.value = '你好'
  textarea.dispatch('input', {})
  // Ctrl+Enter is the multi-line path: still nothing committed.
  textarea.dispatch('keydown', keyEvent('Enter', { ctrlKey: true }))
  assert.equal(textarea.value, '你好\n')
  assert.equal(state.annotations.length, 0)

  textarea.value = '你好\n世界'
  textarea.dispatch('input', {})
  textarea.dispatch('keydown', keyEvent('Enter'))
  assert.equal(textarea.style.display, 'none')
  assert.equal(state.annotations.length, 1)
  assert.equal(state.annotations[0].type, 'text')
  assert.equal(state.annotations[0].text, '你好\n世界')
  assert.equal(typeof state.annotations[0].id, 'number')
  // One gesture = one undo frame (baseline + the committed annotation).
  assert.equal(state.annotationHistory.length, 2)
})

test('U01 §4.1 (vm): Escape discards a new text annotation without touching the undo stack', () => {
  const harness = createHarness()
  const { state, canvas, body } = harness
  state.selection = { x: 0, y: 0, w: 1200, h: 900 }
  state.currentTool = 'text'
  canvas.dispatch('pointerdown', pointerEvent(40, 40))
  const textarea = findTextarea(body)
  assert.ok(textarea)
  textarea.value = 'discard me'
  textarea.dispatch('input', {})
  textarea.dispatch('keydown', keyEvent('Escape'))
  assert.equal(state.annotations.length, 0)
  assert.equal(state.annotationHistory.length, 1, 'a cancelled edit pushes no frame')
  assert.equal(textarea.style.display, 'none')
})

test('U01 §4.1 (vm): double-click re-opens an existing text annotation and commits in place', () => {
  const harness = createHarness()
  const { state, canvas, body } = harness
  state.selection = { x: 0, y: 0, w: 1200, h: 900 }
  const original = { id: 7, type: 'text', x: 100, y: 120, text: '旧', color: '#ff3b30', width: 4 }
  state.annotations = [original]
  state.currentTool = 'select'
  state.initData = { settings: { screenshot: {} } }
  // Double-click inside the painted glyphs (the CJK box is 20px wide, so x=110 is inside it).
  canvas.dispatch('dblclick', pointerEvent(110, 130))
  const textarea = findTextarea(body)
  assert.ok(textarea, 'double-click on a text annotation opens the editor instead of copying')
  assert.equal(textarea.value, '旧')
  assert.equal(state.annotations.length, 0, 'the edited item leaves the canvas while the editor is the preview')

  textarea.value = '新标题'
  textarea.dispatch('input', {})
  textarea.dispatch('keydown', keyEvent('Enter'))
  assert.equal(state.annotations.length, 1)
  assert.equal(state.annotations[0].id, original.id, 're-editing keeps the annotation identity')
  assert.equal(state.annotations[0].text, '新标题')
  assert.equal(state.annotationHistory.length, 2)

  // A cancelled re-edit restores the previous wording and pushes nothing.
  const historyBefore = state.annotationHistory.length
  canvas.dispatch('dblclick', pointerEvent(110, 130))
  const reopened = findTextarea(body)
  assert.ok(reopened)
  assert.equal(state.annotations.length, 0)
  reopened.value = 'discarded'
  reopened.dispatch('input', {})
  reopened.dispatch('keydown', keyEvent('Escape'))
  assert.equal(state.annotations.length, 1)
  assert.equal(state.annotations[0].text, '新标题')
  assert.equal(state.annotationHistory.length, historyBefore)
})

test('U01 §4.1 (vm): dragging one item of a multi-selection moves the whole set as one undo step', () => {
  const harness = createHarness()
  const { state, canvas } = harness
  state.selection = { x: 0, y: 0, w: 1200, h: 900 }
  state.currentTool = 'select'
  const first = { id: 1, type: 'rect', x: 100, y: 100, x2: 150, y2: 130, color: '#f00', width: 4 }
  const second = { id: 2, type: 'rect', x: 300, y: 100, x2: 350, y2: 130, color: '#0f0', width: 4 }
  state.annotations = [first, second]
  state.selectedIds = new Set([1, 2])
  state.selectedAnnotation = first
  state.initData = { settings: { screenshot: {} } }

  // Press INSIDE the first selected rectangle: the body press starts a group move.
  canvas.dispatch('pointerdown', pointerEvent(110, 110))
  canvas.dispatch('pointermove', pointerEvent(130, 130, { buttons: 1 }))
  let movedFirst = state.annotations.find((item) => item.id === 1)
  let movedSecond = state.annotations.find((item) => item.id === 2)
  assert.equal(movedFirst.x, 120, 'the pressed item follows the pointer')
  assert.equal(movedSecond.x, 320, 'the other selected item follows by the SAME delta')
  assert.equal(movedSecond.x - movedFirst.x, 200, 'relative spacing is preserved')
  assert.equal(movedSecond.y - movedFirst.y, 0)
  // No frame is pushed mid-drag: the whole gesture is one undo step.
  assert.equal(state.annotationHistory.length, 1)
  canvas.dispatch('pointerup', pointerEvent(130, 130, { buttons: 0 }))
  assert.equal(state.annotationHistory.length, 2, 'release pushes exactly one frame')
  assert.equal([...state.selectedIds].sort().join(','), '1,2', 'the selection survives the drag')

  // An interrupted drag (pointercancel) puts every origin back and pushes nothing. The press is
  // the CENTRE of the (already moved) first rectangle: near a corner it would hit the element
  // resize handle instead of starting a move.
  canvas.dispatch('pointerdown', pointerEvent(145, 135))
  canvas.dispatch('pointermove', pointerEvent(195, 135, { buttons: 1 }))
  assert.equal(state.annotations.find((item) => item.id === 2).x, 370)
  canvas.dispatch('pointercancel', {})
  assert.equal(state.annotations.find((item) => item.id === 1).x, 120)
  assert.equal(state.annotations.find((item) => item.id === 2).x, 320)
  assert.equal(state.annotationHistory.length, 2, 'a cancelled group drag edits nothing')
})

// ---------------------------------------------------------------------------------------------
// 5. capture.js / capture.html / main wiring (source contracts)
// ---------------------------------------------------------------------------------------------

test('U01 §4.1: no blocking window.prompt() is left on the text path', () => {
  // Strip comments first: the file documents the retired prompt on purpose, and that prose is
  // not a call site.
  const code = captureScript
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(code, /prompt\(t\('capture\.input\.text'\)\)/)
  assert.doesNotMatch(code, /window\.prompt\(/)
  // The region preset name prompt is a different feature and stays untouched.
  assert.match(code, /prompt\(t\('capture\.region\.preset-name'\)/)
})

test('U01 §4.1: capture.html loads the editor module before capture.js', () => {
  const editorIndex = captureHtml.indexOf('<script src="annotation-inline-editor.js"></script>')
  const captureIndex = captureHtml.indexOf('<script src="capture.js"></script>')
  assert.ok(editorIndex > 0, 'capture.html must load annotation-inline-editor.js')
  assert.ok(captureIndex > 0)
  assert.ok(editorIndex < captureIndex, 'the editor must exist before capture.js reads its global')
  assert.match(captureScript, /window\.annotationInlineEditor/)
})

test('U01 §4.1: the text branches open/re-open the inline editor', () => {
  const pointerdownSource = sliceBetween(captureScript, "canvas.addEventListener('pointerdown'", "canvas.addEventListener('pointermove'")
  assert.match(pointerdownSource, /if \(currentTool==='text'\) \{ beginInlineTextCreate\(point, style\); return \}/)
  // The dblclick path repairs an existing annotation; every other hit keeps double-click copy.
  assert.match(captureScript, /beginInlineTextEdit\(findAnnotationAt\(annotations,pointFromEvent\(event\)\)\)/)
  assert.match(captureScript, /if\(selection&&initData\?\.settings\?\.screenshot\?\.doubleClickCopy\) performAction\('copy'\)/)
  // A canvas press while the editor is open confirms it and is consumed.
  const inlineGuard = pointerdownSource.indexOf('if(inlineTextEditing()){commitInlineTextEdit();return}')
  assert.ok(inlineGuard > 0, 'the open editor owns the next canvas press')
  assert.ok(inlineGuard > pointerdownSource.indexOf('if (!resultPanel.classList.contains(\'hidden\')) return'))
  // The editor's Enter commits through the same commitAnnotation path (one undo frame).
  assert.match(captureScript, /function finishInlineTextCreate\(value\) \{[\s\S]{0,400}?commitAnnotation\(\{ \.\.\.state\.draft, text \}\)/)
  // An interrupted capture re-initialisation closes the floating editor silently.
  assert.match(captureScript, /inlineTextEdit = null\s*inlineTextCreate = null\s*inlineTextEditor\?\.cancel\(\)/)
  // Multi-line text is painted line by line with the shared layout primitive.
  const drawSource = sliceBetween(captureScript, 'function drawAnnotation(context, item', 'function renderOverlay()')
  assert.match(drawSource, /const step = textLineHeight\(textSize\)/)
  assert.match(drawSource, /textLines\(item\.text\)\.forEach\(\(line, lineIndex\) => \{ if \(line\) context\.fillText\(line, x, y \+ lineIndex \* step\) \}\)/)
})

test('U01 §4.1: pendingMove snapshots the selection and the drag translates the whole set', () => {
  // The move state carries the group snapshot next to the shipped single-item fields.
  assert.match(captureScript, /pendingMove = \{ id: item\.id, origin: item, start: \{ x: point\.x, y: point\.y \}, thresholdPassed: false, part \}/)
  assert.match(captureScript, /pendingMove\.group = part \? null : groupMoveSnapshot\(item\)/)
  // The snapshot is built from selectedIds (every selected origin + their union box).
  const snapshotSource = functionBody(captureScript, 'groupMoveSnapshot')
  assert.match(snapshotSource, /selectedIds\.size > 1/)
  assert.match(snapshotSource, /selectedIds\.has\(item\.id\)/)
  assert.match(snapshotSource, /annotations\.filter\(\(entry\) => selectedIds\.has\(entry\.id\)\)/)
  assert.match(snapshotSource, /unionAnnotationBounds\(origins\)/)
  // The drag applies ONE union-clamped delta to every item (relative positions preserved).
  const moveSource = functionBody(captureScript, 'moveAnnotationTo')
  assert.match(moveSource, /if \(state\.group\) \{ moveAnnotationGroupTo\(state, dx, dy\); return \}/)
  assert.match(moveSource, /const moved = clampAnnotationToStage\(/)
  const groupMoveSource = functionBody(captureScript, 'moveAnnotationGroupTo')
  assert.match(groupMoveSource, /translateAnnotationSetToStage\(group\.origins, dx, dy, stageRect\(\)\)/)
  assert.doesNotMatch(groupMoveSource, /snapshotAnnotations/, 'a drag pushes no frame before pointerup')
  // Only re-derives from untouched origins: it must never translate `state.origin` in place.
  assert.doesNotMatch(groupMoveSource, /state\.origin\.x =|annotations\[index\]\.x =/)
  // An interrupted drag puts every group origin back (cancel edits nothing, no frame).
  const cancelSource = functionBody(captureScript, 'cancelMoveAnnotation')
  assert.match(cancelSource, /annotations\[index\] = state\.origin/)
  assert.match(cancelSource, /if \(state\.group\) restoreGroupOrigins\(state\.group\)/)
  const restoreSource = functionBody(captureScript, 'restoreGroupOrigins')
  assert.match(restoreSource, /annotations\[index\] = origin/)
  // pointerup still snapshots exactly once for the whole gesture.
  assert.match(captureScript, /function finishMoveAnnotation\(\) \{[\s\S]{0,340}?if \(current && annotationWasMoved\(current, state\.origin\)\) \{ flushCoalescedEdits\(\); snapshotAnnotations\(\) \}/)
  // The pure primitives live in the shared geometry module, not in a second implementation.
  assert.match(captureScript, /const \{ textLines, textLineHeight, textBoxSize, unionAnnotationBounds, translateAnnotationSetToStage \} = window\.annotationGeometry/)
})

test('U01 §4.1: the PDF export result bar receives the main-process receipt', () => {
  const start = captureScript.indexOf("if(action==='pdf')")
  const end = captureScript.indexOf("if(action==='pin')")
  assert.ok(start > 0 && end > start)
  const branch = captureScript.slice(start, end)
  // The receipt is piped into the bar that capture.js already initialized.
  assert.match(branch, /window\.captureAPI\.exportPdf\(imageBuffer,meta,'a4'\)\.then\(showExportResult\)/)
  // A failure is reported with the export's own alert instead of being silently logged.
  assert.match(branch, /catch\(error\)\{showExportFailure\(error\);return\}/)
  // The single-export guard and the button re-enable contract are unchanged.
  assert.match(branch, /if\(pdfExporting\)return/)
  assert.match(branch, /finally\{pdfExporting=false;if\(exportButton\)exportButton\.disabled=false\}/)
  // The bar only renders a `saved` receipt; cancel/null and failure never look like success.
  assert.match(captureScript, /function showExportResult\(result\) \{[\s\S]{0,200}?result\.status === 'saved'\) exportResultBar\.show\(result\)/)
  assert.match(captureScript, /function showExportFailure\(error\) \{[\s\S]{0,200}?alert\(error\?\.message \|\| String\(error\)\)/)
  // The main handler really answers with a receipt (registerExportResult wraps the saved path).
  assert.match(captureDomain, /registerExportResult\(savedPdfPath, 'pdf'/)
  // The bar module is still loaded by capture.html (the wiring target exists at runtime).
  assert.ok(captureHtml.indexOf('<script src="export-result-bar.js"></script>') > 0)
  // capture.css owns the bar's presentation; this ticket adds no new stylesheet entry.
  assert.match(captureCss, /\.export-result-bar \{/)
})
