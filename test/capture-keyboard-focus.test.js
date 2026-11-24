const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { CONTROL_SELECTOR, canvasOwnsKeyboard, focusedControlElement } = require('../capture/keyboard-focus')

const ROOT = path.resolve(__dirname, '..')
const capture = fs.readFileSync(path.join(ROOT, 'capture', 'capture.js'), 'utf8').replace(/\r\n/g, '\n')
const captureHtml = fs.readFileSync(path.join(ROOT, 'capture', 'capture.html'), 'utf8')

// Minimal stand-ins for the three shapes the predicate sees: a control (matches the
// selector), a non-control element, and the document itself.
function fakeControl(selectorMatch) {
  return {
    closest(selector) {
      return selector === CONTROL_SELECTOR && selectorMatch ? this : null
    }
  }
}

function fakeDocument(activeElement) {
  return {
    activeElement,
    body: { tagName: 'BODY' },
    documentElement: { tagName: 'HTML' }
  }
}

test('A02: the canvas owns the keyboard only when nothing is focused', () => {
  assert.equal(canvasOwnsKeyboard(fakeDocument(null)), true)
  const bodyDoc = fakeDocument(null)
  bodyDoc.activeElement = bodyDoc.body
  assert.equal(canvasOwnsKeyboard(bodyDoc), true)
  const htmlDoc = fakeDocument(null)
  htmlDoc.activeElement = htmlDoc.documentElement
  assert.equal(canvasOwnsKeyboard(htmlDoc), true)
})

test('A02: a focused button or input owns the keyboard instead', () => {
  assert.equal(canvasOwnsKeyboard(fakeDocument(fakeControl(true))), false)
  assert.equal(focusedControlElement(fakeDocument(fakeControl(true))) !== null, true)
  // An element that does not match the control selector (the canvas stage) still lets the
  // canvas keep its shortcuts.
  assert.equal(canvasOwnsKeyboard(fakeDocument(fakeControl(false))), true)
})

test('A02: the keydown handler asks the predicate before treating Enter as copy', () => {
  // The exact regression: a BUTTON had focus, Enter still called performAction('copy').
  assert.match(capture, /const focusedControl=focusedControlElement\(document\)/)
  assert.match(capture, /if\(event\.key==='Enter'&&!event\.ctrlKey&&!focusedControl&&documentEditor\)\{event\.preventDefault\(\);return\}/)
  assert.match(capture, /if\(event\.key==='Enter'&&!event\.ctrlKey&&!focusedControl&&!activeOcrResult&&resultPanel\.classList\.contains\('hidden'\)\)performAction\('copy'\)/)
  // Escape stays the window-level key and keeps its documented unwinding order.
  const escape = capture.indexOf("if(event.key==='Escape')")
  const enter = capture.indexOf("event.key==='Enter'&&!event.ctrlKey&&!focusedControl&&!activeOcrResult")
  assert.ok(escape > 0 && escape < enter, 'Escape is handled before canvas keys')
  const ladder = capture.slice(escape, capture.indexOf('return}', escape))
  for (const step of ['resultPanel', 'convertDocMenu', 'colorPalette', 'activeOcrResult', 'watermarkPanel', 'selectedAnnotationItem()', 'closeCaptureWindow()']) {
    assert.ok(ladder.includes(step), `Escape unwinds through ${step}`)
  }
})

test('A02: the helper loads before capture.js and the main action keeps a readable name', () => {
  assert.match(captureHtml, /keyboard-focus\.js[\s\S]*capture\.js/)
  // The primary action is a real button with an aria-label resolved from the locale table,
  // so tabbing to it announces "copy" rather than an icon.
  assert.match(captureHtml, /<button id="copy" class="primary" data-i18n-title="capture\.toolbar\.copy-tip" data-i18n-aria-label="capture\.toolbar\.copy"/)
  for (const id of ['save', 'record', 'pin', 'ocr']) {
    assert.match(captureHtml, new RegExp(`<button id="${id}" data-i18n-title="capture\\.toolbar\\.`), `#${id} carries a readable name`)
  }
})
