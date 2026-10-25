// 紧凑编辑器窗口几何（shared/editor-layout.js）：pin 重标注与 history 继续编辑共用一份
// 算式，所以这里的第一组测试是**与 pin 改造前算式的逐值对照**——把那个算式原样搬进
// 本文件当 oracle，改动只要让 pin 的窗口挪一个像素就会红。
//
// 第二组是 history 新增的能力（extraRows / extraRowHeight 顶部信息区），第三组是
// 输入健壮性、clamp 边界与契约常数。全部纯 Node，不依赖 Electron。
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  EDITOR_LAYOUT_CONSTANTS,
  MINIMUM_EDITOR_WIDTH,
  MINIMUM_SOURCE_SCALE_FACTOR,
  resolveEditorLayout,
  scaleFactorFor
} = require('../shared/editor-layout')

// ---------------------------------------------------------------------------
// oracle：main/domains/pin/index.js 在 2026-10-25 抽取前的原算式，逐行照抄（只把
// editBounds/workArea 变成入参、imageSize.width 变成入参）。不许为了"看起来更整齐"
// 重写它 —— 它的价值就是完全没有被我的新模块影响过。
// ---------------------------------------------------------------------------
function pinLegacyLayout({ editBounds, workArea, sourceWidth }) {
  const ROW_MIN_CONTENT = 1040
  const STRIP_ROW_HEIGHT = 34
  const OPTIONS_ROW_HEIGHT = 30
  const STRIP_CHROME = 14
  const STRIP_SLACK = 22
  const toolbarSpace = 1088
  const width = Math.min(workArea.width, Math.max(toolbarSpace, Math.max(420, editBounds.width)))
  const stripRows = Math.max(1, Math.ceil(ROW_MIN_CONTENT / Math.max(1, width - STRIP_CHROME)))
  const actionSpace = stripRows * STRIP_ROW_HEIGHT + OPTIONS_ROW_HEIGHT + STRIP_CHROME + STRIP_SLACK
  const scale = Math.min(
    1,
    workArea.width / editBounds.width,
    Math.max(1, workArea.height - actionSpace) / editBounds.height
  )
  const imageWidth = Math.max(1, Math.round(editBounds.width * scale))
  const imageHeight = Math.max(1, Math.round(editBounds.height * scale))
  const height = Math.min(workArea.height, imageHeight + actionSpace)
  const x = Math.round(Math.max(workArea.x, Math.min(
    editBounds.x + (editBounds.width - width) / 2,
    workArea.x + workArea.width - width
  )))
  const y = Math.round(Math.max(workArea.y, Math.min(
    editBounds.y,
    workArea.y + workArea.height - height
  )))
  return {
    width,
    stripRows,
    actionSpace,
    scale,
    imageWidth,
    imageHeight,
    height,
    x,
    y,
    editorBounds: { x, y, width, height },
    imageBounds: {
      x: Math.round((width - imageWidth) / 2),
      y: 0,
      width: imageWidth,
      height: imageHeight
    },
    sourceScaleFactor: Math.max(0.25, sourceWidth / imageWidth)
  }
}

// pin 的调用方式：图像盒 = 钉图窗口原点 + renderer 给的 imageBounds 偏移。
function fromPin(imageBox, workArea, sourceWidth = imageBox.width) {
  return resolveEditorLayout({
    imageWidth: imageBox.width,
    imageHeight: imageBox.height,
    workArea,
    anchor: { x: imageBox.x, y: imageBox.y }
  })
}

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }

// 覆盖要求里的 5 组：普通窗口 / 超宽窗口 / 需要换行的窄窗口 / 超高图片（scale<1）/
// 超过屏幕的图片；再加负坐标副屏与"贴边"两种真实形态。
const EQUIVALENCE_CASES = [
  // 普通窗口：图文都比工作区小，scale 被钉在 1。
  { name: 'ordinary window', imageBox: { x: 300, y: 120, width: 640, height: 400 }, workArea: PRIMARY },
  // 超宽窗口：宽度超过工作区，scale 由 workArea.width 决定（<1）。
  { name: 'ultra-wide window', imageBox: { x: -120, y: 40, width: 3600, height: 380 }, workArea: PRIMARY },
  // 需要换行的窄窗口：工作区 < 1088，工具栏折行 → stripRows 2、条带更高。
  {
    name: 'narrow work area forces a wrapped strip',
    imageBox: { x: 40, y: 30, width: 900, height: 500 },
    workArea: { x: 0, y: 0, width: 1024, height: 728 }
  },
  // 超高图片：高度吃掉可用高度，scale 由 height - actionSpace 决定。
  {
    name: 'tall image scales down by height',
    imageBox: { x: 200, y: -60, width: 700, height: 3000 },
    workArea: PRIMARY
  },
  // 超过屏幕的图片：宽高都超，宽高两个分支都比一遍。
  {
    name: 'image larger than the screen in both axes',
    imageBox: { x: 0, y: 0, width: 3840, height: 2160 },
    workArea: PRIMARY
  },
  // 负坐标副屏（虚拟桌面左/上边界为负），且图像盒部分在屏幕外。
  {
    name: 'secondary display with negative origin',
    imageBox: { x: -2200, y: -300, width: 800, height: 600 },
    workArea: { x: -2560, y: -200, width: 2560, height: 1440 }
  },
  // 贴右下角的图像盒：x/y 两个 clamp 的上界分支都要走到。
  {
    name: 'image box flushing the bottom-right corner',
    imageBox: { x: 1800, y: 1000, width: 900, height: 700 },
    workArea: PRIMARY
  }
]

test('resolveEditorLayout is pixel-identical to the pin formula it replaced', () => {
  for (const testCase of EQUIVALENCE_CASES) {
    const expected = pinLegacyLayout({
      editBounds: testCase.imageBox,
      workArea: testCase.workArea,
      sourceWidth: testCase.imageBox.width
    })
    const actual = fromPin(testCase.imageBox, testCase.workArea, testCase.imageBox.width)

    for (const key of ['width', 'stripRows', 'actionSpace', 'scale', 'imageWidth', 'imageHeight', 'height', 'x', 'y']) {
      assert.equal(actual[key], expected[key], `${testCase.name}: ${key}`)
    }
    assert.deepEqual(actual.editorBounds, expected.editorBounds, `${testCase.name}: editorBounds`)
    assert.deepEqual(actual.imageBounds, expected.imageBounds, `${testCase.name}: imageBounds`)
    assert.equal(
      scaleFactorFor({ imageWidth: actual.imageWidth, sourceWidth: testCase.imageBox.width }),
      expected.sourceScaleFactor,
      `${testCase.name}: sourceScaleFactor`
    )
    // extraRows 缺省时不得偷偷加高。
    assert.equal(actual.extraSpace, 0, `${testCase.name}: extraSpace defaults to 0`)
    assert.equal(actual.actionSpace, actual.baseActionSpace, `${testCase.name}: actionSpace == baseActionSpace`)
  }
})

test('the equivalence cases really exercise every branch they claim', () => {
  // 这组断言保护上面的 oracle 不被"无害地"改窄：如果哪天常量或分支变了、某些 case 不再
  // 触发该分支，这里会先红，而不是让对照测试悄悄退化成同一段代码的输出。
  const ordinary = fromPin(EQUIVALENCE_CASES[0].imageBox, PRIMARY)
  assert.equal(ordinary.scale, 1)
  assert.equal(ordinary.stripRows, 1)

  const wide = fromPin(EQUIVALENCE_CASES[1].imageBox, PRIMARY)
  assert.ok(wide.scale < 1, 'the ultra-wide case must be scaled by width')
  assert.equal(wide.scale, Math.min(1, PRIMARY.width / EQUIVALENCE_CASES[1].imageBox.width, wide.scale))

  const narrow = fromPin(EQUIVALENCE_CASES[2].imageBox, EQUIVALENCE_CASES[2].workArea)
  assert.equal(narrow.stripRows, 2, 'work area below one-row width must wrap')
  assert.equal(narrow.actionSpace, 2 * 34 + 30 + 14 + 22)

  const tall = fromPin(EQUIVALENCE_CASES[3].imageBox, PRIMARY)
  assert.ok(tall.scale < 1)
  assert.equal(tall.imageHeight, Math.round(EQUIVALENCE_CASES[3].imageBox.height * tall.scale))

  const huge = fromPin(EQUIVALENCE_CASES[4].imageBox, PRIMARY)
  assert.ok(huge.scale < 1)
  assert.equal(huge.imageWidth, Math.round(EQUIVALENCE_CASES[4].imageBox.width * huge.scale))
})

// ---------------------------------------------------------------------------
// history 顶部信息区：只加高度，不改 imageBounds 的宽度语义
// ---------------------------------------------------------------------------

test('extraRows only grows the reserved action area and never the window width', () => {
  const imageBox = { x: 200, y: 100, width: 800, height: 500 }
  const base = fromPin(imageBox, PRIMARY)
  const laidOut = resolveEditorLayout({
    imageWidth: imageBox.width,
    imageHeight: imageBox.height,
    workArea: PRIMARY,
    anchor: { x: imageBox.x, y: imageBox.y },
    extraRows: 1,
    extraRowHeight: 28
  })
  const twoRows = resolveEditorLayout({
    imageWidth: imageBox.width,
    imageHeight: imageBox.height,
    workArea: PRIMARY,
    anchor: { x: imageBox.x, y: imageBox.y },
    extraRows: 2,
    extraRowHeight: 28
  })

  // 宽度与条带推导完全不变。
  assert.equal(laidOut.width, base.width)
  assert.equal(laidOut.stripRows, base.stripRows)
  // 高度线性增加，且 baseActionSpace 仍是原值。
  assert.equal(laidOut.extraSpace, 28)
  assert.equal(laidOut.actionSpace, base.actionSpace + 28)
  assert.equal(twoRows.extraSpace, 2 * 28)
  assert.equal(twoRows.actionSpace, base.actionSpace + 56)
  assert.equal(twoRows.editorBounds.height, laidOut.editorBounds.height + 28)
  // 信息区不吃图像的实际显示尺寸（这组图片本来就没被缩放），但窗口盒子必须跟着长高。
  assert.equal(laidOut.imageWidth, base.imageWidth)
  assert.equal(laidOut.imageHeight, base.imageHeight)
  // imageBounds 的宽度语义不变：仍然居中、仍然 <= 窗口宽度。
  assert.equal(laidOut.imageBounds.x, Math.round((laidOut.width - laidOut.imageWidth) / 2))
  assert.equal(laidOut.imageBounds.width, base.imageBounds.width)
  assert.equal(laidOut.imageBounds.y, 0)
  assert.ok(laidOut.imageBounds.width <= laidOut.editorBounds.width)
  // 加高之后图像仍在条带之上，窗口仍装得下（不产生负的 imageBounds 或越界窗口）。
  assert.ok(laidOut.imageBounds.height + laidOut.actionSpace <= laidOut.editorBounds.height + 1)
  // 同一入参再算一次得到逐值相同的结果（纯函数）。
  assert.deepEqual(laidOut, resolveEditorLayout({
    imageWidth: imageBox.width,
    imageHeight: imageBox.height,
    workArea: PRIMARY,
    anchor: { x: imageBox.x, y: imageBox.y },
    extraRows: 1,
    extraRowHeight: 28
  }))
})

test('extraRows shrinks the image instead of overflowing when height runs out', () => {
  const imageBox = { x: 0, y: 0, width: 1200, height: 900 }
  const base = fromPin(imageBox, PRIMARY)
  // 900 + 100 = 1000px：还有 40px 余量，所以加一行信息区仍然 scale 1，窗口长到 1040（= 工作区高）。
  assert.equal(base.scale, 1)
  assert.equal(base.editorBounds.height, 1000)
  const oneRow = resolveEditorLayout({
    imageWidth: imageBox.width,
    imageHeight: imageBox.height,
    workArea: PRIMARY,
    extraRows: 1,
    extraRowHeight: 40
  })
  assert.equal(oneRow.scale, 1, 'this image still fits at scale 1 with one info row')
  assert.equal(oneRow.editorBounds.height, base.editorBounds.height + 40)
  // 高度不够时降 scale 而不是让窗口越过工作区：图像少占的那一点高度就是信息区的空间。
  const tall = resolveEditorLayout({
    imageWidth: imageBox.width,
    imageHeight: 1000,
    workArea: PRIMARY,
    extraRows: 3,
    extraRowHeight: 40
  })
  assert.ok(tall.scale < 1, 'the extra 120px must come out of the image height')
  assert.equal(tall.editorBounds.height, PRIMARY.height)
  assert.equal(tall.imageHeight, Math.round(1000 * tall.scale))
  assert.ok(tall.imageBounds.y + tall.imageBounds.height <= tall.editorBounds.height)
  assert.ok(tall.actionSpace > base.actionSpace, 'the reserve still grew')
})

test('extraRows degrades invalid values to zero instead of poisoning the layout', () => {
  const imageBox = { x: 10, y: 20, width: 640, height: 400 }
  const base = fromPin(imageBox, PRIMARY)
  for (const extraRows of [0, -3, Number.NaN, Infinity, 'nope', null, undefined]) {
    const layout = resolveEditorLayout({
      imageWidth: imageBox.width,
      imageHeight: imageBox.height,
      workArea: PRIMARY,
      anchor: { x: imageBox.x, y: imageBox.y },
      extraRows
    })
    assert.deepEqual(layout.editorBounds, base.editorBounds, `extraRows=${String(extraRows)}`)
  }
  // extraRowHeight 缺失/坏掉时同样只按 0 加。
  for (const extraRowHeight of [undefined, Number.NaN, Infinity, -40, 'nope']) {
    const layout = resolveEditorLayout({
      imageWidth: imageBox.width,
      imageHeight: imageBox.height,
      workArea: PRIMARY,
      anchor: { x: imageBox.x, y: imageBox.y },
      extraRows: 2,
      extraRowHeight
    })
    assert.equal(layout.extraSpace, 0, `extraRowHeight=${String(extraRowHeight)}`)
    assert.deepEqual(layout.editorBounds, base.editorBounds, `extraRowHeight=${String(extraRowHeight)}`)
  }
})

// ---------------------------------------------------------------------------
// 极端输入：绝不抛错、绝不返回负尺寸
// ---------------------------------------------------------------------------

function assertSane(layout, label) {
  for (const key of ['width', 'height', 'imageWidth', 'imageHeight']) {
    assert.ok(Number.isFinite(layout[key]) && layout[key] > 0, `${label}: ${key} must be a positive finite number (got ${layout[key]})`)
    assert.ok(Number.isInteger(layout[key]), `${label}: ${key} must be integral (got ${layout[key]})`)
  }
  for (const key of ['x', 'y']) {
    assert.ok(Number.isInteger(layout[key]), `${label}: ${key} must be integral (got ${layout[key]})`)
  }
  assert.ok(Number.isFinite(layout.scale) && layout.scale > 0, `${label}: scale must be positive`)
  assert.ok(layout.scale <= 1, `${label}: scale never magnifies`)
  assert.ok(layout.stripRows >= 1, `${label}: at least one strip row`)
  assert.ok(Number.isFinite(layout.actionSpace) && layout.actionSpace > 0, `${label}: actionSpace positive`)
  assert.ok(Number.isInteger(layout.imageBounds.x) && layout.imageBounds.x >= 0, `${label}: imageBounds.x >= 0`)
  assert.ok(layout.imageBounds.width <= layout.width, `${label}: image fits the window width`)
}

test('degenerate work areas degrade instead of throwing or going negative', () => {
  const imageBox = { x: 0, y: 0, width: 640, height: 400 }
  const cases = [
    ['zero width', { x: 0, y: 0, width: 0, height: 1040 }],
    ['zero height', { x: 0, y: 0, width: 1920, height: 0 }],
    ['both zero', { x: 0, y: 0, width: 0, height: 0 }],
    ['negative width', { x: 0, y: 0, width: -40, height: 1040 }],
    ['negative origin and sizes', { x: -100, y: -100, width: -1, height: -1 }],
    ['NaN sizes', { x: 0, y: 0, width: Number.NaN, height: Number.NaN }],
    ['infinite sizes', { x: 0, y: 0, width: Infinity, height: Infinity }],
    ['tiny work area', { x: 0, y: 0, width: 40, height: 30 }],
    ['missing work area', undefined],
    ['non-object work area', 'workArea']
  ]
  for (const [label, workArea] of cases) {
    const layout = fromPin(imageBox, workArea)
    assertSane(layout, label)
    // 窗口（与它内部的图像）始终落在本函数归一化后的工作区内。
    assert.ok(layout.editorBounds.x >= layout.workArea.x, `${label}: x >= workArea.x`)
    assert.ok(layout.editorBounds.y >= layout.workArea.y, `${label}: y >= workArea.y`)
    assert.ok(layout.editorBounds.x + layout.editorBounds.width <= layout.workArea.x + layout.workArea.width, `${label}: right edge inside`)
    assert.ok(layout.editorBounds.y + layout.editorBounds.height <= layout.workArea.y + layout.workArea.height, `${label}: bottom edge inside`)
  }
})

test('invalid image sizes degrade to a 1px box instead of NaN geometry', () => {
  for (const [label, imageWidth, imageHeight] of [
    ['zero', 0, 0],
    ['negative', -640, -400],
    ['NaN', Number.NaN, Number.NaN],
    ['infinite', Infinity, Infinity],
    ['strings', '640', '400'],
    ['null', null, null],
    ['undefined', undefined, undefined]
  ]) {
    const layout = resolveEditorLayout({ imageWidth, imageHeight, workArea: PRIMARY, anchor: { x: 0, y: 0 } })
    assertSane(layout, label)
    // 只有真正合法的数字才按原值（字符串 '640' 走 Number()，是合法的）。
    const expected = Number(imageWidth)
    if (Number.isFinite(expected) && expected > 0) {
      assert.equal(layout.editorBounds.width, Math.min(PRIMARY.width, Math.max(1088, Math.max(420, expected))), label)
    } else {
      assert.equal(layout.imageBounds.width, 1, `${label}: degenerate base width becomes 1px`)
    }
  }
})

test('a missing or malformed anchor centres the editor in the work area', () => {
  const imageBox = { x: 1234, y: 567, width: 640, height: 400 }
  const anchored = fromPin(imageBox, PRIMARY)
  const centred = resolveEditorLayout({ imageWidth: 640, imageHeight: 400, workArea: PRIMARY })
  for (const anchor of [undefined, null, 'anchor', {}, { x: 10 }, { y: 10 }, { x: Number.NaN, y: 0 }]) {
    const layout = resolveEditorLayout({ imageWidth: 640, imageHeight: 400, workArea: PRIMARY, anchor })
    assert.deepEqual(layout.editorBounds, centred.editorBounds, `anchor=${JSON.stringify(anchor)}`)
  }
  assert.notDeepEqual(centred.editorBounds, anchored.editorBounds)
  // 居中：两侧余量相差不超过 1px（取整误差），垂直同理。
  assert.ok(Math.abs(centred.editorBounds.x - (PRIMARY.x + (PRIMARY.width - centred.editorBounds.width) / 2)) <= 0.5)
  assert.ok(Math.abs(centred.editorBounds.y - (PRIMARY.y + (PRIMARY.height - centred.editorBounds.height) / 2)) <= 0.5)
  // 编辑器居中意味着 imageBounds 在窗口里也基本居中（图像按比例缩小后仍居中）。
  assert.ok(Math.abs(centred.imageBounds.x - (centred.editorBounds.width - centred.imageBounds.width) / 2) <= 0.5)
})

test('editorBounds never leaves the work area, and always contains the image', () => {
  const workAreas = [
    PRIMARY,
    { x: -2560, y: -200, width: 2560, height: 1440 },
    { x: 1920, y: 0, width: 1280, height: 720 },
    { x: 0, y: 0, width: 1024, height: 728 },
    { x: 300, y: 200, width: 800, height: 600 }
  ]
  const imageBoxes = [
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 640, height: 400 },
    { x: 100, y: 100, width: 1920, height: 1080 },
    { x: 5000, y: 5000, width: 800, height: 600 },
    { x: -9000, y: -9000, width: 800, height: 600 },
    { x: 12.4, y: 7.6, width: 333.7, height: 222.2 }
  ]
  for (const workArea of workAreas) {
    for (const imageBox of imageBoxes) {
      const layout = fromPin(imageBox, workArea)
      const { x, y, width, height } = layout.editorBounds
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `integral origin for ${JSON.stringify([workArea, imageBox])}`)
      assert.ok(x >= workArea.x, `left inside: ${JSON.stringify([workArea, imageBox])}`)
      assert.ok(y >= workArea.y, `top inside: ${JSON.stringify([workArea, imageBox])}`)
      assert.ok(x + width <= workArea.x + workArea.width, `right inside: ${JSON.stringify([workArea, imageBox])}`)
      assert.ok(y + height <= workArea.y + workArea.height, `bottom inside: ${JSON.stringify([workArea, imageBox])}`)
      // 图像盒完全落在编辑器窗口内（否则渲染层会把工具条推进图像里，即那个真机缺陷）。
      assert.ok(layout.imageBounds.x >= 0, 'image left inside window')
      assert.ok(layout.imageBounds.y >= 0, 'image top inside window')
      assert.ok(layout.imageBounds.x + layout.imageBounds.width <= width, 'image right inside window')
      assert.ok(layout.imageBounds.y + layout.imageBounds.height <= height, 'image bottom inside window')
    }
  }
})

test('the reserve strip always fits below the image', () => {
  // 回归真机缺陷：窗口只比图像大一点点时，图像下方的条带必须放得下工具条。
  // 这里按契约常数直接验算，避免 oracle 自证。
  const { STRIP_ROW_HEIGHT, OPTIONS_ROW_HEIGHT, STRIP_CHROME, STRIP_SLACK } = EDITOR_LAYOUT_CONSTANTS
  for (const workArea of [PRIMARY, { x: 0, y: 0, width: 1024, height: 728 }, { x: 0, y: 0, width: 800, height: 600 }]) {
    for (const imageBox of [
      { x: 0, y: 0, width: 300, height: 100 },
      { x: 0, y: 0, width: 640, height: 400 },
      { x: 0, y: 0, width: 3000, height: 2000 }
    ]) {
      const layout = fromPin(imageBox, workArea)
      const stripNeeded = layout.stripRows * STRIP_ROW_HEIGHT + OPTIONS_ROW_HEIGHT + STRIP_CHROME
      assert.ok(
        layout.editorBounds.height - layout.imageBounds.height >= stripNeeded,
        `strip ${stripNeeded}px must fit under the image (${layout.editorBounds.height - layout.imageBounds.height}px free)`
      )
      assert.ok(layout.editorBounds.height - layout.imageBounds.height >= stripNeeded + STRIP_SLACK - 1)
    }
  }
})

// ---------------------------------------------------------------------------
// scaleFactorFor：pin 的 sourceScaleFactor 原式
// ---------------------------------------------------------------------------

test('scaleFactorFor reproduces the pin source scale factor', () => {
  assert.equal(scaleFactorFor({ imageWidth: 1000, sourceWidth: 2000 }), 2)
  assert.equal(scaleFactorFor({ imageWidth: 640, sourceWidth: 640 }), 1)
  assert.equal(scaleFactorFor({ imageWidth: 2000, sourceWidth: 500 }), MINIMUM_SOURCE_SCALE_FACTOR)
  assert.equal(scaleFactorFor({ imageWidth: 100, sourceWidth: 20 }), MINIMUM_SOURCE_SCALE_FACTOR)
  // 原式没有上限：钉图里放大显示（pin zoom > 1）时会算出 >1 的值，保持原样。
  assert.equal(scaleFactorFor({ imageWidth: 100, sourceWidth: 400 }), 4)
  // 推荐的显示宽度字段名；两者同时给时 displayWidth 优先（历史 pin 接线用的是 imageWidth）。
  assert.equal(scaleFactorFor({ displayWidth: 1000, sourceWidth: 2000 }), 2)
  assert.equal(scaleFactorFor({ displayWidth: 250, imageWidth: 1000, sourceWidth: 2000 }), 8)
  // 渲染方块无效 -> 中性值 1；源宽无效 -> 下限 0.25。
  assert.equal(scaleFactorFor({ imageWidth: 0, sourceWidth: 800 }), 1)
  assert.equal(scaleFactorFor({ imageWidth: -5, sourceWidth: 800 }), 1)
  assert.equal(scaleFactorFor({ imageWidth: Number.NaN, sourceWidth: 800 }), 1)
  assert.equal(scaleFactorFor({ displayWidth: 0, imageWidth: 0, sourceWidth: 800 }), 1)
  assert.equal(scaleFactorFor({ imageWidth: 400 }), MINIMUM_SOURCE_SCALE_FACTOR)
  assert.equal(scaleFactorFor({ imageWidth: 400, sourceWidth: Number.NaN }), MINIMUM_SOURCE_SCALE_FACTOR)
  assert.equal(scaleFactorFor(), 1)
  assert.equal(scaleFactorFor(null), 1)
})

test('scaleFactorFor accepts the layout output directly', () => {
  const imageBox = { x: 0, y: 0, width: 800, height: 600 }
  const layout = fromPin(imageBox, PRIMARY)
  // 同一张图：显示宽度 == 基准宽度（scale 1）时因子为 1。
  assert.equal(scaleFactorFor({ displayWidth: layout.imageWidth, sourceWidth: imageBox.width }), 1)
  // 缩小显示（大图）时因子 > 1，正是 pin 传下去的那个方向。
  const huge = fromPin({ x: 0, y: 0, width: 3840, height: 2160 }, PRIMARY)
  assert.equal(
    scaleFactorFor({ displayWidth: huge.imageWidth, sourceWidth: 3840 }),
    Math.max(0.25, 3840 / huge.imageWidth)
  )
})

// ---------------------------------------------------------------------------
// 契约常数：capture-floating-placement.test.js 从 capture.html/capture.css 反推这些
// 数字，这里再把 6 个值单独钉一遍 —— 改错时只有本文件红，而不是散在三处。
// ---------------------------------------------------------------------------

test('the strip constants are the historical pin values, frozen and exported', () => {
  assert.equal(EDITOR_LAYOUT_CONSTANTS.ROW_MIN_CONTENT, 1040)
  assert.equal(EDITOR_LAYOUT_CONSTANTS.STRIP_ROW_HEIGHT, 34)
  assert.equal(EDITOR_LAYOUT_CONSTANTS.OPTIONS_ROW_HEIGHT, 30)
  assert.equal(EDITOR_LAYOUT_CONSTANTS.STRIP_CHROME, 14)
  assert.equal(EDITOR_LAYOUT_CONSTANTS.STRIP_SLACK, 22)
  assert.equal(EDITOR_LAYOUT_CONSTANTS.TOOLBAR_SPACE, 1088)
  assert.equal(MINIMUM_EDITOR_WIDTH, 420)
  assert.equal(MINIMUM_SOURCE_SCALE_FACTOR, 0.25)
  assert.ok(Object.isFrozen(EDITOR_LAYOUT_CONSTANTS), 'the constants object is frozen')
  // 冻结的是顶层：严格模式下改字段必须抛 TypeError（本文件非严格，所以显式声明）。
  assert.throws(() => {
    'use strict'
    EDITOR_LAYOUT_CONSTANTS.ROW_MIN_CONTENT = 1
  }, TypeError)
  // 非严格模式下静默失败也必须保持原值。
  EDITOR_LAYOUT_CONSTANTS.ROW_MIN_CONTENT = 1
  assert.equal(EDITOR_LAYOUT_CONSTANTS.ROW_MIN_CONTENT, 1040)
  // 单行条带 = 1 行 + 选项行 + chrome + slack，与 pin 的 actionSpace 公式一致。
  const oneRow = EDITOR_LAYOUT_CONSTANTS.STRIP_ROW_HEIGHT + EDITOR_LAYOUT_CONSTANTS.OPTIONS_ROW_HEIGHT +
    EDITOR_LAYOUT_CONSTANTS.STRIP_CHROME + EDITOR_LAYOUT_CONSTANTS.STRIP_SLACK
  assert.equal(oneRow, 100)
  assert.equal(fromPin({ x: 0, y: 0, width: 640, height: 400 }, PRIMARY).actionSpace, oneRow)
})

test('resolveEditorLayout is pure and deterministic', () => {
  const input = {
    imageWidth: 900,
    imageHeight: 540,
    workArea: { ...PRIMARY },
    anchor: { x: 120, y: 80 },
    extraRows: 1,
    extraRowHeight: 30
  }
  const first = resolveEditorLayout(input)
  const second = resolveEditorLayout(input)
  assert.deepEqual(first, second)
  // 输入对象没有被改写（包括 workArea / anchor 这两个嵌套对象）。
  assert.deepEqual(input, {
    imageWidth: 900,
    imageHeight: 540,
    workArea: { ...PRIMARY },
    anchor: { x: 120, y: 80 },
    extraRows: 1,
    extraRowHeight: 30
  })
  // 返回值每次都是新对象（调用方可以随意改，不污染下一次）。
  first.editorBounds.x += 10
  assert.notDeepEqual(first.editorBounds, resolveEditorLayout(input).editorBounds)
})

// ---------------------------------------------------------------------------
// UMD 双端暴露（照 shared/cursor-geometry.js 的写法）：主进程 require，渲染层挂全局。
// ---------------------------------------------------------------------------

test('the module loads in both a CommonJS and a browser-style global context', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'editor-layout.js'), 'utf8')

  // 主进程侧：require 拿到具名导出（本文件顶部已经证过，这里再断言形状）。
  assert.equal(typeof resolveEditorLayout, 'function')
  assert.equal(typeof scaleFactorFor, 'function')
  assert.equal(typeof EDITOR_LAYOUT_CONSTANTS, 'object')

  // 渲染层侧：没有 module / exports 的全局上下文里挂到 root.editorLayout。
  const sandbox = { Math, Number, Object, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(sandbox.editorLayout, 'exposes root.editorLayout when module.exports is unavailable')
  const commonJsApi = require('../shared/editor-layout')
  for (const key of ['resolveEditorLayout', 'scaleFactorFor', 'EDITOR_LAYOUT_CONSTANTS']) {
    assert.equal(typeof sandbox.editorLayout[key], typeof commonJsApi[key], key)
  }
  const inBrowser = sandbox.editorLayout.resolveEditorLayout({
    imageWidth: 800,
    imageHeight: 600,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  })
  // 跨 vm realm 的对象原型不同，deepEqual 会因 reference-equal 失败 —— 按 JSON 比较值。
  assert.deepEqual(
    JSON.parse(JSON.stringify(inBrowser)),
    JSON.parse(JSON.stringify(resolveEditorLayout({
      imageWidth: 800,
      imageHeight: 600,
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }
    }))),
    'the browser copy computes the same layout as the CommonJS copy'
  )
  // 不 require Electron：源码里不能出现 electron 的加载。
  assert.doesNotMatch(source, /require\(\s*['"]electron['"]\s*\)/)
})
