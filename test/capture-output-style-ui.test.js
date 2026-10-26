// 功能 C2/C3：渲染层（capture/）的成品预设面板与出口接线契约。
//
// 设计基线：docs/plans/2026-10-25-snow-apps-feature-development-plan.md
//   §6.1 统一合成（预览与导出同一实现，禁止 CSS-only 阴影当导出依据；控件/选择框不进入成品）
//   §6.2 presetId 只是 UI 偏好，产物由完整解析参数决定；原图模式几何与 v1 完全相同
//   §6.3 一次滑块拖动只产生一个撤销步骤；恢复"原图"可撤销；重开/反复保存/贴图不累计叠加外框
//   §6.4 C2/C3 的必须验证项
//
// 这里钉两类东西：
//   ① 纯函数行为：面板控制器的状态机（预设切换、手势收口、no-op 抑制、样式时间线与撤销栈对齐）；
//   ② 源码契约：渲染层确实只**接线**共享实现（预览调 compositor、识别入口显式不合成、
//     结果图只从底图+标注重建、outputStyle 进文档快照）。
//
// 真机观感（阴影/圆角在真实光栅下的样子）不在本文件的覆盖范围，见最终报告的"未验证"清单。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const styleApi = require('../shared/capture-output-style')
const compositor = require('../capture/output-compositor')
const docApi = require('../shared/capture-document')
const panelApi = require('../capture/output-style-panel')
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { createSettingsNormalizer } = require('../main/services/settings-normalize')

const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const localeSource = fs.readFileSync(path.join(root, 'shared', 'locales', 'capture.js'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

// ---------- 桩画布：录下调用序列，不真实渲染 ----------

function createStubCanvas(width, height) {
  const calls = []
  const state = { width, height, calls }
  const context = {
    canvas: state,
    imageSmoothingEnabled: false,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() { calls.push(['save']) },
    restore() { calls.push(['restore']) },
    beginPath() { calls.push(['beginPath']) },
    closePath() { calls.push(['closePath']) },
    moveTo(x, y) { calls.push(['moveTo', x, y]) },
    lineTo(x, y) { calls.push(['lineTo', x, y]) },
    arcTo(...args) { calls.push(['arcTo', ...args]) },
    rect(...args) { calls.push(['rect', ...args]) },
    roundRect(...args) { calls.push(['roundRect', ...args]) },
    clip() { calls.push(['clip']) },
    fill() { calls.push(['fill']) },
    stroke() { calls.push(['stroke']) },
    drawImage(...args) { calls.push(['drawImage', ...args]) }
  }
  state.getContext = () => context
  return state
}

function createCanvasFactory() {
  const canvases = []
  const factory = (width, height) => {
    const canvas = createStubCanvas(width, height)
    canvases.push(canvas)
    return canvas
  }
  factory.canvases = canvases
  return factory
}

// ---------- ① 面板状态机（纯函数，无 DOM） ----------

function makeController(overrides = {}) {
  const events = { preview: [], commit: [], preset: [] }
  const controller = panelApi.createOutputStyleController({
    styleApi,
    initialStyle: overrides.initialStyle,
    initialPresetId: overrides.initialPresetId,
    onPreview: (style) => events.preview.push(style),
    onCommit: (event) => events.commit.push(event),
    onPreset: (presetId) => events.preset.push(presetId)
  })
  return { controller, events }
}

test('§6.1 the three presets resolve through the shared table and each one is a single undo step', () => {
  const { controller, events } = makeController()
  // 原图 = 禁用效果，唯一的判据是 enabled（不是 presetId 字符串）。
  assert.equal(controller.isEnabled(), false)
  assert.equal(controller.getPresetId(), 'original')
  for (const presetId of styleApi.PRESET_IDS) {
    const before = events.commit.length
    const changed = controller.selectPreset(presetId)
    const style = controller.getStyle()
    assert.equal(controller.getPresetId(), presetId)
    if (presetId === 'original') {
      // 回到原图是**一次编辑**（可撤销），不是 reset：几何必须与 v1 逐像素相同。
      assert.equal(style.enabled, false)
      const geometry = styleApi.resolveOutputGeometry({ contentWidth: 800, contentHeight: 600, outputStyle: style })
      assert.deepEqual(geometry, { width: 800, height: 600, contentOffsetX: 0, contentOffsetY: 0 })
    } else {
      assert.equal(changed, true)
      assert.equal(style.enabled, true)
      assert.ok(style.paddingPx > 0, `${presetId} must add padding`)
      assert.ok(style.shadow.enabled, `${presetId} must enable the shadow`)
      assert.equal(controller.getStyle().background.color, styleApi.OUTPUT_STYLE_PRESETS[presetId].style.background.color)
    }
    assert.equal(events.commit.length, before + (changed ? 1 : 0), `${presetId} must push exactly ${changed ? 1 : 0} frame(s)`)
  }
})

test('§6.3 one slider drag produces exactly ONE undo frame, however many input events it fires', () => {
  const { controller, events } = makeController({ initialStyle: styleApi.presetStyle('card-light'), initialPresetId: 'card-light' })
  events.commit.length = 0
  events.preview.length = 0
  // pointerdown -> many input -> pointerup/change: the drag is one gesture.
  controller.beginGesture()
  for (const padding of [50, 52, 56, 60, 64, 68, 72]) controller.applyPatch({ paddingPx: padding })
  assert.equal(controller.getStyle().paddingPx, 72, 'the live value follows every input event')
  assert.ok(events.preview.length >= 7, 'each input event repaints the preview')
  assert.equal(events.commit.length, 0, 'nothing is committed until the gesture ends')
  controller.endGesture()
  assert.equal(events.commit.length, 1, 'a whole drag is one frame')
  assert.equal(events.commit[0].style.paddingPx, 72)
  // A second end (pointerup after change) must not push a duplicate frame.
  controller.endGesture()
  assert.equal(events.commit.length, 1)
})

test('§6.3 a no-op edit never creates an undo step (slider landed on the same integer)', () => {
  const { controller, events } = makeController({ initialStyle: styleApi.presetStyle('card-light'), initialPresetId: 'card-light' })
  events.commit.length = 0
  controller.beginGesture()
  assert.equal(controller.applyPatch({ paddingPx: controller.getStyle().paddingPx }), false)
  controller.endGesture()
  assert.equal(events.commit.length, 0)
  // A colour popup dismissed without choosing a new colour is the same case.
  controller.beginGesture()
  assert.equal(controller.applyPatch({ background: { color: controller.getStyle().background.color } }), false)
  controller.endGesture()
  assert.equal(events.commit.length, 0)
})

test('§6.3 the style timeline mirrors the annotation undo stack index-for-index', () => {
  const { controller } = makeController({ initialStyle: styleApi.presetStyle('original'), initialPresetId: 'original' })
  // Frame 0 is the session's initial style (the state a freshly opened editor is in).
  assert.equal(controller.frames.length, 1)
  assert.equal(controller.frameAt(0).enabled, false)
  // The stack protocol: truncate to the pre-push length, then push the current style.
  controller.selectPreset('card-light') // one edit, but no annotation snapshot pushed it yet
  controller.truncateFrames(1)
  controller.pushFrame()
  assert.equal(controller.frames.length, 2)
  assert.equal(controller.frameAt(1).enabled, true)
  // A parameter edit adds a second frame.
  controller.beginGesture()
  controller.applyPatch({ paddingPx: 96 })
  controller.endGesture()
  controller.truncateFrames(2)
  controller.pushFrame()
  assert.equal(controller.frames.length, 3)
  assert.equal(controller.frameAt(2).paddingPx, 96)
  // Undo one step -> the card is back at 48px; undo again -> original picture.
  controller.restoreFrame(controller.frameAt(1))
  assert.equal(controller.getStyle().paddingPx, 48)
  assert.equal(controller.isEnabled(), true)
  controller.restoreFrame(controller.frameAt(0))
  assert.equal(controller.isEnabled(), false, 'undoing back to the original picture disables the card')
  // Redo forward again.
  controller.restoreFrame(controller.frameAt(2))
  assert.equal(controller.getStyle().paddingPx, 96)
  // A restore never pushes a frame (it is the same user action arriving from the other direction).
  controller.truncateFrames(3)
  assert.equal(controller.frames.length, 3)
})

test('§6.3 the style timeline survives an undo-stack overflow without going out of phase', () => {
  const { controller } = makeController({ initialStyle: styleApi.presetStyle('card-light'), initialPresetId: 'card-light' })
  // Model the annotation stack's cap: every push past the limit drops the oldest frame. The style
  // list must be dropped from the front by the same count, otherwise frameAt(i) points one step
  // forward from the annotation frame and Ctrl+Z restores the wrong card.
  const limit = 4
  for (let index = 1; index <= 6; index += 1) {
    controller.beginGesture()
    controller.applyPatch({ paddingPx: 40 + index })
    controller.endGesture()
    controller.truncateFrames(Math.min(limit, controller.frames.length))
    controller.pushFrame()
    if (controller.frames.length > limit) controller.trimFramesFromFront(controller.frames.length - limit)
  }
  assert.equal(controller.frames.length, limit)
  // The last frame is the newest style, and it is what the annotation stack's top index holds.
  assert.equal(controller.frameAt(controller.frames.length - 1).paddingPx, 46)
})

test('§6.1 a parameter edit on the "original" preset turns the effect on in ONE frame', () => {
  const { controller, events } = makeController()
  events.commit.length = 0
  controller.beginGesture()
  // The panel sends `enabled: true` together with the first parameter change, so the frame the user
  // undoes is "the card appeared at 48px", not an invisible no-op followed by a visible edit.
  controller.applyPatch({ enabled: true, paddingPx: 48 })
  assert.equal(controller.isEnabled(), true)
  controller.endGesture()
  assert.equal(events.commit.length, 1)
  assert.equal(events.commit[0].style.paddingPx, 48)
  assert.equal(events.commit[0].style.enabled, true)
  // Undo returns to the original picture in one step.
  const originalFrame = controller.frameAt(0)
  controller.restoreFrame(originalFrame)
  assert.equal(controller.isEnabled(), false)
})

test('§6.2 the preset id is UI preference and never leaks into the style object', () => {
  const { controller } = makeController()
  controller.selectPreset('card-dark')
  const serialized = JSON.stringify(controller.getStyle())
  for (const forbidden of ['preset', 'imageStyle', 'card-dark', 'presetId']) {
    assert.equal(serialized.includes(forbidden), false, `the style must not carry ${forbidden}`)
  }
  // The document model's field whitelist is the authority: an extra key would be dropped by
  // normalizeDocument, so a preset id kept inside the style would silently not round-trip.
  assert.deepEqual(
    Object.keys(controller.getStyle()).sort(),
    [...styleApi.STYLE_FIELDS].sort()
  )
})

test('§6.2 a manually tuned style matches no preset, so no button claims to be active', () => {
  // This mirrors capture.js matchOutputStylePreset() and the panel's own syncControls(): a parameter
  // set that equals no preset must report '' instead of quietly highlighting the preset it started
  // from. Keeping the rule in one shape (outputStyleEquals) is what makes the panel, the reopen path
  // and the persisted preference agree.
  const match = (style) => {
    if (!styleApi.isOutputStyleEnabled(style)) return 'original'
    for (const presetId of styleApi.PRESET_IDS) {
      if (presetId === 'original') continue
      if (styleApi.outputStyleEquals(styleApi.presetStyle(presetId), style)) return presetId
    }
    return ''
  }
  assert.equal(match(styleApi.presetStyle('card-light')), 'card-light')
  assert.equal(match(styleApi.presetStyle('original')), 'original')
  const tuned = styleApi.normalizeOutputStyle(Object.assign({}, styleApi.presetStyle('card-light'), { paddingPx: 51 }))
  assert.equal(match(tuned), '')
  // The panel latches a button with the SAME comparison, so it cannot disagree with the reopen path.
  const panelSource = fs.readFileSync(path.join(root, 'capture', 'output-style-panel.js'), 'utf8')
  const sync = sliceBetween(panelSource, 'function syncControls()', 'function syncSizeHint()')
  assert.match(sync, /styleApi\.presetStyle\(button\.dataset\.outputPreset\)/)
  assert.match(sync, /styleApi\.outputStyleEquals\(presetStyle, style\)/)
  assert.doesNotMatch(sync, /controller\.getPresetId\(\)/, 'a latched button must reflect the parameters, not the last clicked id')
})

// ---------- ① 合成器调用序列（预览与导出共用） ----------

test('§6.1 the compositor composes in the documented order and never allocates in original mode', () => {
  const content = createStubCanvas(800, 600)
  const factory = createCanvasFactory()
  // Original mode: no allocation, no drawing, `null` back so the caller keeps the content canvas.
  assert.equal(compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: styleApi.presetStyle('original'), createCanvas: factory }), null)
  assert.equal(factory.canvases.length, 0)
  // Card mode: one canvas at the shared geometry's size, and the content is CLIPPED then drawn.
  const cardStyle = styleApi.presetStyle('card-light')
  const canvas = compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: cardStyle, createCanvas: factory })
  assert.ok(canvas)
  const geometry = styleApi.resolveOutputGeometry({ contentWidth: 800, contentHeight: 600, outputStyle: cardStyle })
  assert.equal(canvas.width, geometry.width)
  assert.equal(canvas.height, geometry.height)
  const names = canvas.calls.map((call) => call[0])
  // Order: shadow (fill) -> background (fill) -> content (clip + drawImage) -> border (stroke).
  const firstClip = names.indexOf('clip')
  const firstDrawImage = names.indexOf('drawImage')
  assert.ok(firstClip >= 0 && firstDrawImage > firstClip, 'the content must be clipped before it is drawn')
  assert.ok(names.includes('stroke'), 'the border is stroked last')
  // Every rounded surface goes through the shared path helper (roundRect or arcTo fallback).
  assert.ok(names.includes('roundRect') || names.includes('arcTo'))
})

test('§6.1 preview and export call the SAME compositor with the SAME style (only the scale differs)', () => {
  const content = createStubCanvas(800, 600)
  const cardStyle = styleApi.presetStyle('card-dark')
  // The preview passes a small scale, the export omits it; geometry still comes from one function.
  const previewFactory = createCanvasFactory()
  const exportFactory = createCanvasFactory()
  const preview = compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: cardStyle, createCanvas: previewFactory, scale: 0.25 })
  const exported = compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: cardStyle, createCanvas: exportFactory })
  const exportGeometry = styleApi.resolveOutputGeometry({ contentWidth: 800, contentHeight: 600, outputStyle: cardStyle })
  assert.equal(exported.width, exportGeometry.width)
  assert.equal(exported.height, exportGeometry.height)
  // The preview keeps the aspect ratio of the export: same plan, scaled.
  assert.ok(Math.abs(preview.width / preview.height - exported.width / exported.height) < 0.02)
  // And the drawing script is the same sequence - the only difference is the pixel scale.
  assert.deepEqual(
    preview.calls.map((call) => call[0]),
    exported.calls.map((call) => call[0])
  )
})

// ---------- ① DOM 半部：用假 document 驱动真实的监听器 ----------

// A minimal element stub that supports exactly what the panel touches: value/checked/disabled,
// classList, dataset, attributes, listeners and the few query helpers. This is enough to prove the
// WIRING (which element owns which field, when a frame is pushed) without a browser.
function createFakeElement(id) {
  const listeners = new Map()
  const classes = new Set()
  const attributes = new Map()
  const element = {
    id,
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force === true
        if (on) classes.add(name)
        else classes.delete(name)
        return on
      }
    },
    setAttribute(name, value) { attributes.set(name, String(value)) },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler(Object.assign({ target: element, stopPropagation() {} }, event))
    },
    contains() { return false },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 100, top: 200, width: 300, height: 360 } },
    append() {}
  }
  return element
}

function createFakeDocument(ids) {
  const elements = new Map()
  for (const id of ids) elements.set(id, createFakeElement(id))
  const presetButtons = ['original', 'card-light', 'card-dark'].map((presetId) => {
    const button = createFakeElement(`preset-${presetId}`)
    button.dataset.outputPreset = presetId
    return button
  })
  const panel = elements.get('outputStylePanel')
  panel.classList.add('hidden')
  const total = { clicks: 0 }
  panel.querySelectorAll = (selector) => (selector === '[data-output-preset]' ? presetButtons : [])
  return {
    elements,
    presetButtons,
    total,
    getElementById: (id) => elements.get(id) || null,
    addEventListener: () => {}
  }
}

test('the mounted panel wires each slider to its own field and pushes ONE frame on change', () => {
  const ids = ['outputStylePanel', 'outputStyleToggle', 'outputStyleStatus', 'outputStyleSize', 'outputStylePreview']
  for (const control of panelApi.CONTROLS) {
    ids.push(control.id)
    if (control.outputId) ids.push(control.outputId)
  }
  const fakeDocument = createFakeDocument(ids)
  // Seed the colour inputs so readControl() sees a legal value.
  fakeDocument.elements.get('outputBackgroundColor').value = '#ffffff'
  fakeDocument.elements.get('outputBorderColor').value = '#e0e0e3'
  fakeDocument.elements.get('outputShadowColor').value = '#000000'

  const commits = []
  const controller = panelApi.createOutputStyleController({
    styleApi,
    onCommit: (event) => commits.push(event)
  })
  const panel = panelApi.mountOutputStylePanel({
    document: fakeDocument,
    styleApi,
    controller,
    translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    getGeometry: () => ({ width: 900, height: 700 })
  })
  assert.ok(panel, 'the panel must mount when the markup is present')

  // A drag on the padding slider: many input events, ONE frame at change.
  const padding = fakeDocument.elements.get('outputPadding')
  panel.open()
  for (const value of ['40', '44', '48', '52']) {
    padding.value = value
    padding.dispatch('input')
  }
  assert.equal(controller.getStyle().paddingPx, 52, 'the live style follows the slider')
  assert.equal(panel.getStyle().enabled, true, 'the first parameter edit turns the effect on')
  assert.equal(commits.length, 0, 'no frame until the gesture ends')
  padding.dispatch('change')
  assert.equal(commits.length, 1, 'one drag = one frame')
  // pointerup after change must not add a second frame.
  padding.dispatch('pointerup')
  assert.equal(commits.length, 1)
  // The value label is written from the same style.
  assert.equal(fakeDocument.elements.get('outputPaddingValue').textContent, '52px')

  // Each control writes its own field: the corner-radius slider must not touch padding.
  const radius = fakeDocument.elements.get('outputCornerRadius')
  radius.value = '12'
  radius.dispatch('input')
  radius.dispatch('change')
  assert.equal(controller.getStyle().cornerRadiusPx, 12)
  assert.equal(controller.getStyle().paddingPx, 52)

  // The background-alpha slider travels 0..100 in the DOM and 0..1 in the document.
  const alpha = fakeDocument.elements.get('outputBackgroundAlpha')
  alpha.value = '40'
  alpha.dispatch('input')
  alpha.dispatch('change')
  assert.equal(controller.getStyle().background.alpha, 0.4)

  // The shadow toggle is a boolean, and the nested fields follow it.
  const shadowToggle = fakeDocument.elements.get('outputShadowEnabled')
  shadowToggle.checked = true
  shadowToggle.dispatch('input')
  shadowToggle.dispatch('change')
  assert.equal(controller.getStyle().shadow.enabled, true)
  const shadowBlur = fakeDocument.elements.get('outputShadowBlur')
  shadowBlur.value = '20'
  shadowBlur.dispatch('input')
  shadowBlur.dispatch('change')
  assert.equal(controller.getStyle().shadow.blurPx, 20)

  // A preset click replaces the whole parameter block and latches exactly one button.
  panel.open()
  const dark = fakeDocument.presetButtons.find((button) => button.dataset.outputPreset === 'card-dark')
  fakeDocument.elements.get('outputStylePanel').dispatch('click', { target: { closest: () => dark } })
  assert.equal(controller.getStyle().background.color, styleApi.OUTPUT_STYLE_PRESETS['card-dark'].style.background.color)
  assert.equal(dark.getAttribute('aria-pressed'), 'true')
  assert.equal(fakeDocument.presetButtons[0].getAttribute('aria-pressed'), 'false')
})

test('the panel closes when its anchor goes away and never renders a preview without a selection', () => {
  const ids = ['outputStylePanel', 'outputStyleToggle', 'outputStyleStatus', 'outputStyleSize', 'outputStylePreview']
  for (const control of panelApi.CONTROLS) {
    ids.push(control.id)
    if (control.outputId) ids.push(control.outputId)
  }
  const fakeDocument = createFakeDocument(ids)
  const panel = panelApi.mountOutputStylePanel({
    document: fakeDocument,
    styleApi,
    controller: panelApi.createOutputStyleController({ styleApi }),
    translate: (key) => key,
    getGeometry: () => null
  })
  assert.equal(panel.isOpen(), false, 'the panel starts hidden (no mandatory extra step)')
  panel.open()
  assert.equal(panel.isOpen(), true)
  assert.equal(fakeDocument.elements.get('outputStyleToggle').getAttribute('aria-expanded'), 'true')
  panel.close()
  assert.equal(panel.isOpen(), false)
  assert.equal(fakeDocument.elements.get('outputStyleToggle').getAttribute('aria-expanded'), 'false')
  // With no geometry (no selection yet) the size hint stays hidden instead of showing 0 × 0.
  assert.equal(fakeDocument.elements.get('outputStyleSize').classList.contains('hidden'), true)
})

// ---------- ② 源码契约：capture.js 只接线，不复制实现 ----------

test('§6.1 the export path composes through the shared module and keeps the content canvas in original mode', () => {
  // composeFinishedOutput() sits between exportSelectionRect() and the export helpers.
  const compose = sliceBetween(script, 'function composeFinishedOutput(', '// The projection is applied around the one synchronous export call')
  // The shared compositor is the ONE implementation; a local re-implementation is what the plan
  // forbids (it is how a preview and an export drift apart).
  assert.match(compose, /window\.captureOutputCompositor/)
  assert.match(compose, /compositor\.composeOutputCanvas\(\{ contentCanvas, outputStyle \}\)/)
  assert.match(compose, /return null/, 'original mode and over-budget both fall back to the content canvas')
  assert.match(compose, /output-too-large/)
  // It must NOT paint its own background/shadow: no canvas context calls in this wrapper.
  assert.doesNotMatch(compose, /getContext|fillRect|shadowBlur|beginPath/)
})

test('§6.1 recognition entries explicitly bypass the finished look (the model must see the bare crop)', () => {
  const action = sliceBetween(script, 'async function performAction(action)', 'function showResult(')
  // The three switches are INDEPENDENT: "may the model see my arrows?", "may it see a card frame?"
  // and (R0.4) "must it be stopped from reading what I covered?". Sharing one boolean would block
  // the next dimension and would let a future change silently decorate a recognition input.
  assert.match(action, /const recognitionActions=\['ocr','translate','table','qr','convert'\]/)
  assert.match(action, /const pixelOnlyActions = recognitionActions\.includes\(action\)/)
  assert.match(action, /const composedActions = !pixelOnlyActions/)
  assert.match(action, /const maskedActions = pixelOnlyActions/)
  assert.match(action, /exportSelectionCanvasForAction\(!pixelOnlyActions,exportRect,\{ compose: composedActions, mask: maskedActions \}\)/)
  // And the recognition branches themselves never reach the compositor.
  const ocrBranch = action.slice(action.indexOf("if(['ocr','translate'].includes(action)&&!initData.editPin)"), action.indexOf("if(action==='table'||action==='qr')"))
  assert.doesNotMatch(ocrBranch, /composeOutputCanvas|composeFinishedOutput/)
  // Both options default to OFF: a caller that does not ask for the user-facing picture gets the
  // shipped, undecorated, unmasked image (never an accidental card, never an accidental black box).
  const helper = sliceBetween(script, 'function exportSelectionCanvasForAction(', 'function annotationsForMask(')
  assert.match(helper, /const compose = options\.compose === true/)
  assert.match(helper, /const mask = options\.mask === true/)
  // It is an option object, not a positional flag: that is what leaves room for a fourth dimension.
  assert.match(helper, /options = \{\}\)/)
})

test('§6.3 the committed result is rebuilt from base image + annotations, never from the previous result', () => {
  const result = sliceBetween(script, 'async function documentResultBuffer()', '// Commit the frozen content state')
  // Content layer: crop-sized, base image slice, annotations projected once.
  assert.match(result, /output\.width = Math\.max\(1, crop\.w\)/)
  assert.match(result, /output\.height = Math\.max\(1, crop\.h\)/)
  assert.match(result, /out\.drawImage\(image, crop\.x, crop\.y, crop\.w, crop\.h, 0, 0, crop\.w, crop\.h\)/)
  assert.match(result, /for \(const item of viewsForExport\) drawAnnotation\(out, item, 1, 1, crop\.x, crop\.y, image\)/)
  // Then ONE composition, and in original mode the content canvas itself is encoded.
  assert.match(result, /const composed = composeFinishedOutput\(output, currentOutputStyle\(\)\)/)
  assert.match(result, /return canvasPngBuffer\(composed \|\| output\)/)
  // No path may read a previously written PNG: that is what would stack a second frame.
  assert.doesNotMatch(result, /resultBuffer|readFile|loadImage|previousResult|lastResult/)
})

test('§6.2 the document snapshot carries the live style, and the contract layer normalizes it', () => {
  const snapshot = sliceBetween(script, 'function buildDocumentSnapshot()', 'function documentFingerprintNow()')
  assert.match(snapshot, /outputStyle: currentOutputStyle\(\) \|\| undefined/)
  // The renderer must not hand-build the style shape or hard-code the schema number.
  assert.doesNotMatch(snapshot, /paddingPx:|cornerRadiusPx:|blurPx:/)
  assert.match(snapshot, /schemaVersion: api\.SCHEMA_VERSION/)
  assert.doesNotMatch(snapshot, /schemaVersion: [0-9]/)
})

test('§6.3 reopening a document restores its own style and starts a fresh undo timeline', () => {
  const restore = sliceBetween(script, 'function restoreOutputStyleForDocument(', 'function matchOutputStylePreset(')
  // The document's own outputStyle is the product truth: a reopen must not inherit the style of the
  // last unrelated capture.
  assert.match(restore, /api\.normalizeOutputStyle\(document\?\.outputStyle\)/)
  assert.match(restore, /mountOutputStylePanelFor\(style, presetId\)/)
  assert.match(restore, /resetFrames\(style\)/)
  // Legacy records are forced to original by the contract layer (their bitmap may already carry
  // baked-in decoration), and no action here may add a second frame.
  const restoreEditor = sliceBetween(script, 'function restoreDocumentEditor(', 'function restoreOutputStyleForDocument(')
  assert.match(restoreEditor, /annotationHistory = \[cloneAnnotations\(annotations\)\]/)
  assert.match(restoreEditor, /historyIndex = 0/)
})

test('§6.3 undo/redo restores the style from the same frame index, without pushing a new one', () => {
  const restore = sliceBetween(script, 'function restoreAnnotations(index)', 'function undoAnnotations()')
  assert.match(restore, /restoreOutputStyleFrame\(\)/)
  const frame = sliceBetween(script, 'function restoreOutputStyleFrame()', 'function undoAnnotations()')
  assert.match(frame, /outputStyleController\.restoreFrame\(outputStyleController\.frameAt\(historyIndex\)\)/)
  assert.doesNotMatch(frame, /pushFrame|snapshotAnnotations/)
  // The push path mirrors the annotation stack's own structural edits.
  const push = sliceBetween(script, 'function pushOutputStyleFrame(index)', '// 把"已生效但未收口"')
  assert.match(push, /truncateFrames\(index\)/)
  assert.match(push, /pushFrame\(\)/)
  const snapshot = sliceBetween(script, 'function snapshotAnnotations()', 'function pushOutputStyleFrame(')
  assert.match(snapshot, /pushOutputStyleFrame\(base - dropped\)/)
})

test('§6.2 a plain capture window reads only the persisted preset, never the tuned parameters', () => {
  const preferred = sliceBetween(script, 'function preferredOutputStylePreset()', 'function currentOutputStyle()')
  assert.match(preferred, /initData\?\.settings\?\.screenshot\?\.outputStylePreset/)
  assert.match(preferred, /api\.PRESET_IDS\.includes\(stored\)/)
  assert.match(preferred, /return 'original'/)
  // Re-annotation editors (image/canvas modes) start original: their bitmap may already BE a
  // composed result, so applying a card on top of it would stack a second frame.
  assert.match(preferred, /\['image', 'canvas'\]\.includes\(initData\?\.mode\)/)
  // The persisted preset is a single id, never a whole style object.
  assert.doesNotMatch(preferred, /paddingPx|background|cornerRadius/)
})

test('§6.1 the preview paints the compositor output, not a CSS approximation', () => {
  const preview = sliceBetween(script, 'function renderOutputStylePreview()', 'function previewBox(')
  // The preview MUST go through the shared compositor.
  assert.match(preview, /compositor\.composeOutputCanvas\(\{ contentCanvas: content, outputStyle: style, scale: box\.scale \}\)/)
  // And it draws that canvas: no border-radius/box-shadow painting in script.
  assert.match(preview, /ctx\.drawImage\(composed, box\.left, box\.top\)/)
  assert.doesNotMatch(preview, /shadowBlur|borderRadius|fillRect/)
  // The CSS must not sell the preview as the export basis either: the panel's chrome is allowed to
  // be styled, but there is no rule that draws a fake card behind the preview.
  assert.match(css, /\.output-style-preview \{[\s\S]{0,600}?background-size: 12px 12px/)
})

test('capture.html declares the panel with the existing declarative conventions', () => {
  // Hidden by default (plan §6.1: no extra mandatory step on the common path).
  assert.match(html, /<div id="outputStylePanel" class="output-style-panel hidden"/)
  // The strip toggle is a button with aria-expanded, like the region toggle.
  assert.match(html, /id="outputStyleToggle"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/)
  // Three presets, plain latched buttons carrying data-output-preset + aria-pressed.
  for (const presetId of styleApi.PRESET_IDS) {
    assert.match(
      html,
      new RegExp(`data-output-preset="${presetId}" aria-pressed="(true|false)"`),
      `preset ${presetId} must be a latched button`
    )
  }
  assert.equal((html.match(/data-output-preset="/g) || []).length, styleApi.PRESET_IDS.length)
  // The panel is NOT part of the per-tool option row: it is not a tool option and the row is a
  // projection of the active tool, so it would be hidden whenever no tool owns options.
  const toolOptionsStart = html.indexOf('<div id="toolOptions"')
  assert.ok(toolOptionsStart > 0)
  const toolOptions = html.slice(toolOptionsStart, html.indexOf('<div id="elementBar"'))
  assert.doesNotMatch(toolOptions, /data-output-preset/)
  // Every control the controller drives exists in the markup: the module's own table is the list.
  for (const control of panelApi.CONTROLS) {
    assert.match(html, new RegExp(`id="${control.id}"`), `${control.id} must exist in capture.html`)
    if (control.outputId) {
      assert.match(html, new RegExp(`id="${control.outputId}"`), `${control.outputId} must exist in capture.html`)
    }
  }
  // The preview is a real canvas, so the drawn compositor output has somewhere to land.
  assert.match(html, /<canvas id="outputStylePreview"/)
  // Every visible string goes through the locale table.
  assert.doesNotMatch(html, /data-i18n="capture\.output\.[a-z-]+">[^<]*[\u4e00-\u9fff]/)
})

test('§6.1 the preview canvas is the module panel draws into, and the strip toggle is a toolbar icon', () => {
  // The controller and the markup must agree on the element ids it looks up.
  assert.match(script, /document\.getElementById\('outputStylePreview'\)/)
  assert.match(script, /document\.getElementById\('outputStylePanel'\)/)
  // The toggle lives on the strip and uses a local SVG mask icon like every other strip button.
  assert.match(html, /id="outputStyleToggle"[^>]*>[\s\S]{0,200}?--icon:url\('icons\/output-style\.svg'\)/)
  assert.equal(fs.existsSync(path.join(root, 'capture', 'icons', 'output-style.svg')), true)
})

test('§6.1 the panel is kept in step on EVERY floating-UI path, including the ones that hide the strip', () => {
  // updateFloatingUi() has four early returns (no selection, OCR overlay, auto/marquee/drag/resize,
  // and the normal path). The panel hangs off the strip, so a path that hides the strip must close
  // it - syncing only on the normal path would leave a card panel floating over an OCR overlay.
  const floating = sliceBetween(script, 'function updateFloatingUi()', 'function positionOcrResultBar()')
  const syncIndex = floating.indexOf('syncOutputStyleUi()')
  assert.ok(syncIndex > 0, 'updateFloatingUi must sync the finished-look panel')
  // It runs BEFORE the first early return, so every branch is covered.
  const firstReturn = floating.indexOf('return }')
  assert.ok(syncIndex < firstReturn, 'the sync must precede the first early return')
  // And the panel's own sync closes on every unavailable state rather than only repositioning.
  const sync = sliceBetween(script, 'function syncOutputStyleUi()', 'function outputContentSize()')
  assert.match(sync, /if \(!available\) \{[\s\S]{0,120}?outputStylePanel\.close\(\)/)
  // The preview is not repainted on every frame: it is keyed off the content rect signature.
  assert.match(sync, /outputStylePreviewSignature/)
  assert.match(sync, /if \(signature !== outputStylePreviewSignature\)/)
})

// ---------- ② i18n + settings ----------

test('every capture.output.* key exists in all three languages and follows the naming rule', () => {
  globalThis.__LOCALES = {}
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js']) {
    delete require.cache[require.resolve(path.join(root, 'shared', 'locales', name))]
    require(path.join(root, 'shared', 'locales', name))
  }
  const tables = globalThis.__LOCALES
  const keys = Object.keys(tables['zh-CN']).filter((key) => key.startsWith('capture.output.'))
  assert.ok(keys.length >= 19)
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)
    for (const language of ['en-US', 'zh-TW']) {
      assert.ok(Object.hasOwn(tables[language], key), `${language} is missing ${key}`)
      assert.notEqual(tables[language][key], '', `${language}.${key} must not be empty`)
    }
  }
  // The panel's own key table must be a subset: a key the module resolves but the locale table does
  // not carry would render as the raw key.
  for (const key of panelApi.LOCALE_KEYS) {
    assert.ok(keys.includes(key), `${key} is resolved by output-style-panel.js but missing from the table`)
  }
  // The three preset labels come from the shared preset table, not from a second list.
  for (const presetId of styleApi.PRESET_IDS) {
    const labelKey = styleApi.OUTPUT_STYLE_PRESETS[presetId].labelKey
    assert.ok(keys.includes(labelKey), `${labelKey} must exist`)
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.ok(Object.hasOwn(tables[language], labelKey), `${language} is missing ${labelKey}`)
    }
  }
  assert.match(localeSource, /'capture\.output\.too-large'/)
})

test('§6.2 the settings template exposes exactly one style preference field, and normalization guards it', () => {
  // Only ONE style preference field may live in the settings template. `annotationStyles` is the
  // pre-existing per-tool annotation block (feature B4), not a finished-look parameter, so it is
  // excluded by name rather than by loosening the pattern.
  assert.equal(DEFAULT_SETTINGS.screenshot.outputStylePreset, 'original')
  const styleFieldsInSettings = Object.keys(DEFAULT_SETTINGS.screenshot)
    .filter((key) => key !== 'annotationStyles')
    .filter((key) => /style|padding|corner|shadow|border|background/i.test(key))
  assert.deepEqual(styleFieldsInSettings, ['outputStylePreset'], 'the settings block must not grow the whole style object')
  const normalizer = createSettingsNormalizer({ defaultHistoryDirectory: 'C:/history' })
  const normalize = (value) => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.screenshot.outputStylePreset = value
    return normalizer(settings).screenshot.outputStylePreset
  }
  for (const presetId of styleApi.PRESET_IDS) assert.equal(normalize(presetId), presetId)
  for (const illegal of ['card-neon', '', null, 42, {}, []]) assert.equal(normalize(illegal), 'original')
  // A store written before the feature existed has no key at all: legal, normalizes to original.
  const legacy = structuredClone(DEFAULT_SETTINGS)
  delete legacy.screenshot.outputStylePreset
  assert.equal(normalizer(legacy).screenshot.outputStylePreset, 'original')
})

// ---------- ② 端到端：原图模式等价 + 重开不叠加 ----------

test('§6.2 a document built from the panel style round-trips through the contract layer unchanged', () => {
  const { controller } = makeController({ initialStyle: styleApi.presetStyle('card-light'), initialPresetId: 'card-light' })
  const style = controller.getStyle()
  const document = docApi.createInitialDocument({ assetId: 'placeholder', width: 1200, height: 800, outputStyle: style })
  assert.deepEqual(document.outputStyle, styleApi.normalizeOutputStyle(style))
  // The document's geometry is what the service will validate the result PNG against.
  const geometry = docApi.resolveOutputGeometry(document)
  const expected = styleApi.resolveOutputGeometry({ contentWidth: 1200, contentHeight: 800, outputStyle: style })
  assert.deepEqual(geometry, expected)
  // A reopened document gives back the same style (that is "reopen keeps the style").
  const reopened = docApi.normalizeDocument(document)
  assert.deepEqual(reopened.outputStyle, styleApi.normalizeOutputStyle(style))
})

test('§6.2 original mode is byte-identical to v1: the geometry is exactly the crop', () => {
  const document = docApi.createInitialDocument({ assetId: 'placeholder', width: 1280, height: 720 })
  assert.equal(document.outputStyle.enabled, false)
  const geometry = docApi.resolveOutputGeometry(document)
  assert.deepEqual(geometry, { width: 1280, height: 720, contentOffsetX: 0, contentOffsetY: 0 })
  // And the compositor refuses to even allocate a canvas for it, so the caller keeps the content
  // canvas - that is the property, not a promise about pixels.
  const content = createStubCanvas(1280, 720)
  const factory = createCanvasFactory()
  assert.equal(compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: document.outputStyle, createCanvas: factory }), null)
  assert.equal(factory.canvases.length, 0)
})

test('§6.3 repeated saves never accumulate a frame: the content layer keeps its crop size', () => {
  // The property under test is structural: the content canvas is always built at crop size and the
  // composition happens once at the end. Feeding a PREVIOUS result back in would grow the padding
  // by one card per save; the source shows there is no such read (the result is never an input).
  const result = sliceBetween(script, 'async function documentResultBuffer()', '// Commit the frozen content state')
  assert.match(result, /output\.width = Math\.max\(1, crop\.w\)/)
  assert.equal((result.match(/composeFinishedOutput\(/g) || []).length, 1, 'exactly one composition per save')
  // Producing the same content twice produces the same geometry (no accumulating state).
  const cardStyle = styleApi.presetStyle('card-dark')
  const first = styleApi.resolveOutputGeometry({ contentWidth: 900, contentHeight: 600, outputStyle: cardStyle })
  const second = styleApi.resolveOutputGeometry({ contentWidth: 900, contentHeight: 600, outputStyle: cardStyle })
  assert.deepEqual(first, second)
  // Composing the SAME content layer again yields the same size - the compositor is stateless.
  const factory = createCanvasFactory()
  const a = compositor.composeOutputCanvas({ contentCanvas: createStubCanvas(900, 600), outputStyle: cardStyle, createCanvas: factory })
  const b = compositor.composeOutputCanvas({ contentCanvas: createStubCanvas(900, 600), outputStyle: cardStyle, createCanvas: factory })
  assert.equal(a.width, b.width)
  assert.equal(a.height, b.height)
})

test('the style participates in the content fingerprint (a parameter change is a real revision)', () => {
  const base = docApi.createInitialDocument({ assetId: 'placeholder', width: 800, height: 600 })
  const carded = docApi.createInitialDocument({ assetId: 'placeholder', width: 800, height: 600, outputStyle: styleApi.presetStyle('card-light') })
  assert.notEqual(docApi.documentFingerprint(base), docApi.documentFingerprint(carded))
  // Reopening the SAME document is clean: normalize is the only place a fingerprint is computed, so
  // the migration path and the write path cannot disagree.
  const reopened = docApi.parseDocument(JSON.stringify(base))
  assert.equal(reopened.ok, true)
  assert.equal(docApi.documentFingerprint(reopened.document), docApi.documentFingerprint(base))
})
