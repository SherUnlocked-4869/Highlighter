'use strict'

// Behavioural tests for the three capture-toolbar defects fixed 2026-10-19.
//
// These run `capture/capture.js` inside a vm sandbox with a minimal DOM, because the
// bugs were all *interaction* bugs that a source-regex assertion cannot catch:
//
//   1. setTool order  - the swatch echoed the PREVIOUS tool, so the colour shown and
//                        the colour the next shape used disagreed (user report).
//   2. toggle options - startHead/endHead/bold could be turned on but never off
//                        because the button only ever submitted its static `true`
//                        (user report).
//   3. style write-back - editing a selected element must also teach the tool its new
//                        creation default, with a mixed selection only adopting the
//                        anchor tool's own fields.
//
// The sandbox is intentionally small: it stubs just enough DOM for the functions
// under test to run, and reads state back through the public entry points
// (`setTool`, `setAnnotationOption`) rather than internal variables.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = fs.readFileSync(path.join(ROOT, 'capture', 'capture.js'), 'utf8')
const STYLE_MODULE = fs.readFileSync(path.join(ROOT, 'capture', 'annotation-style.js'), 'utf8')
const GEOMETRY_MODULE = fs.readFileSync(path.join(ROOT, 'capture', 'annotation-geometry.js'), 'utf8')
const SELECTION_MODULE = fs.readFileSync(path.join(ROOT, 'capture', 'selection-utils.js'), 'utf8')
// capture.js calls restoreStoredLanguage()/applyTranslations() at module scope, so the
// real runtime has to be loaded rather than stubbed - it is a classic script whose
// functions land on the shared global scope, exactly like the window does.
const I18N_RUNTIME = fs.readFileSync(path.join(ROOT, 'shared', 'i18n.js'), 'utf8')

// A DOM stub: elements are created lazily by id and remember the attributes and
// classes the renderer touches. Query selectors used by the option row resolve to a
// flat list of the option buttons that were registered.
function createDom() {
  const elements = new Map()
  const optionButtons = []
  const toolButtons = []

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
      getBoundingClientRect: () => ({ width: 900, height: 34, left: 0, top: 0, right: 900, bottom: 34 }),
      closest: () => null,
      appendChild(child) { this.children.push(child); return child },
      append(...items) { this.children.push(...items) },
      replaceChildren(...items) { this.children = items },
      remove() {},
      focus() {},
      click() { this.dispatch('click', { target: this, stopPropagation() {}, preventDefault() {} }) },
      getContext: () => createContext2d(),
      querySelectorAll: (selector) => querySelectorAll(selector),
      querySelector: (selector) => querySelectorAll(selector)[0] || null,
      contains: () => false,
      width: 1200,
      height: 900
    }
  }

  function querySelectorAll(selector) {
    if (selector === '[data-annotation-option]') return optionButtons
    if (selector === '[data-tool]') return toolButtons
    if (selector === '[data-annotation-color]') return []
    if (selector === '[data-annotation-width]') return []
    return []
  }

  return { elements, optionButtons, toolButtons, makeElement, get: (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id) }, querySelectorAll }
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
    set: (target, key, value) => { target[key] = value; return true }
  })
}

function createHarness() {
  const dom = createDom()
  // Populate the SAME arrays the DOM stub's querySelectorAll returns, so a click on
  // one of these buttons reaches the delegated listener capture.js installed.
  const optionButtons = dom.optionButtons
  const toolButtons = dom.toolButtons
  const savedStyles = []
  const savedColors = []
  const savedWidths = []

  // The option buttons the renderer queries. Each one carries the same declarative
  // shape capture.html gives it, so the click path is exercised verbatim.
  const optionSpecs = [
    ['fill', 'none'], ['fill', 'translucent'], ['fill', 'solid'],
    ['dash', 'solid'], ['dash', 'dashed'], ['dash', 'dotted'],
    ['radius', '0'], ['radius', '4'], ['radius', '8'],
    ['startHead', 'true'], ['endHead', 'true'],
    ['alpha', 'light'], ['alpha', 'medium'], ['alpha', 'strong'],
    ['bold', 'true']
  ]
  for (const [key, value] of optionSpecs) {
    const button = dom.makeElement(`${key}:${value}`)
    button.dataset.annotationOption = key
    button.dataset.annotationOptionValue = value
    button.setAttribute('aria-pressed', 'false')
    button.closest = (selector) => (selector === '[data-annotation-option]' ? button : null)
    optionButtons.push(button)
  }
  for (const tool of ['select', 'rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'blur', 'text', 'serial', 'watermark']) {
    const button = dom.makeElement(`tool:${tool}`)
    button.dataset.tool = tool
    toolButtons.push(button)
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
    Image: class { constructor() { this.complete = false; this.naturalWidth = 0 } },
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: {
      getElementById: (id) => dom.get(id),
      createElement: () => dom.makeElement('created'),
      querySelectorAll: (selector) => dom.querySelectorAll(selector),
      querySelector: (selector) => dom.querySelectorAll(selector)[0] || null,
      addEventListener: () => {},
      removeEventListener: () => {},
      body: dom.get('body'),
      documentElement: { style: { setProperty() {}, removeProperty() {} }, classList: dom.get('documentElement').classList },
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
    prompt: () => 'text',
    // capture.js registers window-level listeners at module scope.
    addEventListener: () => {},
    removeEventListener: () => {},
    captureAPI: {
      onInit: () => {},
      onShown: () => {},
      ready: () => {},
      renderReady: () => {},
      renderError: () => {},
      close: () => {},
      // These return Promises because capture.js chains `.catch()` onto them.
      saveAnnotationStyles: (styles) => { savedStyles.push(JSON.parse(JSON.stringify(styles))); return Promise.resolve() },
      saveAnnotationColor: (color) => { savedColors.push(color); return Promise.resolve() },
      saveAnnotationWidth: (width) => { savedWidths.push(width); return Promise.resolve() },
      saveWatermarkSettings: async () => {},
      recordHistory: async () => {},
      onInterfaceLanguage: () => () => {}
    }
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  // The classic scripts capture.html loads before capture.js, in the same order.
  vm.runInNewContext(I18N_RUNTIME, sandbox)
  vm.runInNewContext(STYLE_MODULE, sandbox)
  vm.runInNewContext(GEOMETRY_MODULE, sandbox)
  vm.runInNewContext(SELECTION_MODULE, sandbox)
  vm.runInNewContext('window.annotationStyleUtils = annotationStyleUtils; window.annotationGeometry = annotationGeometry;', sandbox)

  vm.runInNewContext(SCRIPT, sandbox)

  // `capture.js` keeps its state in top-level `let` bindings, which live in the
  // script's lexical scope and are therefore NOT properties of the vm context.
  // Re-running only the reads we need, inside the same context, exposes them through
  // a small accessor object. (`var`/function declarations would already be visible;
  // these are `let`, so the harness bridges them explicitly.)
  const state = vm.runInNewContext('({ get toolStyles() { return toolStyles }, set toolStyles(value) { toolStyles = value }, get currentTool() { return currentTool }, get annotations() { return annotations }, set annotations(value) { annotations = value }, get selectedIds() { return selectedIds }, set selectedIds(value) { selectedIds = value }, get selectedAnnotation() { return selectedAnnotation }, set selectedAnnotation(value) { selectedAnnotation = value }, get annotationColor() { return annotationColor } })', sandbox)

  return { sandbox, state, dom, optionButtons, toolButtons, savedStyles, savedColors, savedWidths }
}

// `capture.js` keeps its state in module scope, so the harness exposes the few
// entry points the tests drive and reads the effect through the toolbar DOM.
function readSwatch(harness) {
  return harness.dom.get('colorSwatch').style.background
}

function pressOption(harness, key, value) {
  const button = harness.optionButtons.find((item) => item.dataset.annotationOption === key && item.dataset.annotationOptionValue === value)
  assert.ok(button, `option ${key}=${value} must exist in the row`)
  harness.dom.get('toolOptions').dispatch('click', { target: button, stopPropagation() {}, preventDefault() {} })
  return button
}

function readPressed(harness, key, value) {
  const button = harness.optionButtons.find((item) => item.dataset.annotationOption === key && item.dataset.annotationOptionValue === value)
  return button.getAttribute('aria-pressed')
}

test('switching tools echoes the tool that will actually draw (the reported bug)', () => {
  const harness = createHarness()
  const { sandbox, state } = harness
  // Teach rect a blue default and leave ellipse on red, exactly like a user who
  // recoloured a rectangle in the previous capture.
  state.toolStyles = {
    rect: { color: '#1687ff', width: 4 },
    ellipse: { color: '#ff3b30', width: 4 }
  }

  sandbox.setTool('rect')
  assert.equal(readSwatch(harness), '#1687ff', 'selecting rect must show the colour rect will draw')

  sandbox.setTool('ellipse')
  assert.equal(readSwatch(harness), '#ff3b30', 'selecting ellipse must show the colour ellipse will draw')
})

test('a tool with no remembered block falls back to its own default, not the previous tool', () => {
  const harness = createHarness()
  const { sandbox, state } = harness
  state.toolStyles = { rect: { color: '#1687ff', width: 4 } }
  sandbox.setTool('rect')
  assert.equal(readSwatch(harness), '#1687ff')
  // `select` owns no style block, so the swatch must not keep echoing rect's blue.
  sandbox.setTool('select')
  assert.notEqual(readSwatch(harness), '#1687ff', 'select must not echo the previous tool colour')
})

test('boolean option groups toggle on and off (the reported bug)', () => {
  const harness = createHarness()
  const { sandbox } = harness
  sandbox.setTool('arrow')
  sandbox.syncToolOptionControls()

  // startHead starts off (arrow default) and must survive a full on/off/on cycle.
  assert.equal(readPressed(harness, 'startHead', 'true'), 'false')
  pressOption(harness, 'startHead', 'true')
  assert.equal(readPressed(harness, 'startHead', 'true'), 'true', 'first click turns the head on')
  pressOption(harness, 'startHead', 'true')
  assert.equal(readPressed(harness, 'startHead', 'true'), 'false', 'second click MUST turn it off again')

  // endHead starts ON (arrow default) - the reported "cannot cancel" case.
  assert.equal(readPressed(harness, 'endHead', 'true'), 'true')
  pressOption(harness, 'endHead', 'true')
  assert.equal(readPressed(harness, 'endHead', 'true'), 'false', 'endHead must be cancellable')
  pressOption(harness, 'endHead', 'true')
  assert.equal(readPressed(harness, 'endHead', 'true'), 'true')
})

test('text bold toggles too (same defect, not reported yet)', () => {
  const harness = createHarness()
  const { sandbox } = harness
  sandbox.setTool('text')
  sandbox.syncToolOptionControls()
  assert.equal(readPressed(harness, 'bold', 'true'), 'false')
  pressOption(harness, 'bold', 'true')
  assert.equal(readPressed(harness, 'bold', 'true'), 'true')
  pressOption(harness, 'bold', 'true')
  assert.equal(readPressed(harness, 'bold', 'true'), 'false')
})

test('radio-style option groups keep their declarative value instead of toggling', () => {
  const harness = createHarness()
  const { sandbox } = harness
  sandbox.setTool('rect')
  sandbox.syncToolOptionControls()
  // Clicking the already-active fill value must NOT turn the fill off; it is a
  // one-of-three choice, not a switch.
  pressOption(harness, 'fill', 'solid')
  assert.equal(readPressed(harness, 'fill', 'solid'), 'true')
  pressOption(harness, 'fill', 'solid')
  assert.equal(readPressed(harness, 'fill', 'solid'), 'true', 'a radio option re-selects, never cancels')
  // And picking another value moves the active state over.
  pressOption(harness, 'fill', 'none')
  assert.equal(readPressed(harness, 'fill', 'none'), 'true')
  assert.equal(readPressed(harness, 'fill', 'solid'), 'false')
})

test('a style edit on the selected element also teaches the tool its new default', () => {
  const harness = createHarness()
  const { sandbox, state } = harness
  // Select a rect, then change its colour: the next rect must come out blue.
  const rect = { id: 1, type: 'rect', color: '#ff3b30', width: 4, x: 10, y: 10, w: 60, h: 40 }
  state.annotations = [rect]
  state.selectedIds = new Set([rect.id])
  state.selectedAnnotation = rect
  sandbox.setTool('rect')
  sandbox.setAnnotationColor('#1687ff', false)
  assert.equal(state.toolStyles.rect.color, '#1687ff', 'the tool default must adopt the new colour')
  // The legacy scalar keys stay written for older builds.
  assert.equal(state.annotationColor, '#1687ff')
})

test('a style edit with nothing selected still writes the tool default', () => {
  const harness = createHarness()
  const { sandbox, state } = harness
  sandbox.setTool('rect')
  sandbox.setAnnotationColor('#1687ff', false)
  assert.equal(state.toolStyles.rect.color, '#1687ff')
})

test('the tool default is normalised through the same resolver the shape uses', () => {
  const harness = createHarness()
  const { sandbox, state } = harness
  sandbox.setTool('rect')
  // A malformed colour must not reach the remembered block.
  sandbox.setAnnotationColor('not-a-colour', false)
  assert.match(state.toolStyles.rect.color, /^#[0-9a-f]{6}$/i)
})
