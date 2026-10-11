'use strict'

// P0-2-T5：shared/cursor-geometry.js 的纯几何（5 类边界）+ helper 协议解析，
// 以及 P0-2-T2 main/services/cursor-provider.js 的传输/缓存/降级路径。
//
// provider 落在 `test:coverage:loaded` 的 `--include=main/services/**` 分母里，
// 但任务卡的写作用域只给了这一个测试文件，所以 provider 的覆盖也放在这里
// （任务卡 §五.1 明确要求的做法：不新建 test/cursor-provider.test.js）。

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')

const {
  parseHelperMessage,
  resolveCursorPlacement,
  toCursorDataUrl
} = require('../shared/cursor-geometry')
const {
  DEFAULT_CACHE_TTL_MS,
  HELPER_RELATIVE_PATH,
  createCursorProvider,
  createCursorSnapshot,
  resolveCursorHelperPath
} = require('../main/services/cursor-provider')

// ---------------------------------------------------------------------------
// 假 helper：一条 line-JSON 管道的替身。测试自己决定什么时候回哪一行。
// ---------------------------------------------------------------------------
function createFakeHelper(autoReady = true) {
  const child = new EventEmitter()
  const writes = []
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.writes = writes
  child.stdin = {
    write(chunk) {
      writes.push(String(chunk))
      if (typeof child.onWrite === 'function') child.onWrite(String(chunk))
      return true
    },
    end() { child.stdinEnded = true }
  }
  child.kill = () => { child.killed = true }
  // 真 helper 启动后立刻打一行 ready；在 spawn 返回之后（下一个 tick）发出，
  // 保证 provider 已经挂好 stdout 监听。
  if (autoReady) setImmediate(() => child.stdout.emit('data', '{"ready":true,"windows":[]}\n'))
  return child
}

function reply(child, payload) {
  setImmediate(() => child.stdout.emit('data', `${JSON.stringify(payload)}\n`))
}

function createHarness(overrides = {}) {
  const { autoReady = true, ...providerOptions } = overrides
  const child = createFakeHelper(autoReady)
  const logs = []
  const provider = createCursorProvider({
    spawn: () => child,
    executablePath: 'C:\\fake\\SmartSelect.exe',
    existsSync: () => true,
    log: (...args) => logs.push(args.filter((item) => item !== undefined).join(' ')),
    ...providerOptions
  })
  return { child, logs, provider }
}

function cursorPayload(overrides = {}) {
  return {
    id: 1,
    cursor: true,
    showing: true,
    x: 640,
    y: 480,
    hotspotX: 5,
    hotspotY: 14,
    width: 48,
    height: 48,
    png: 'iVBORw0KGgo=',
    ...overrides
  }
}

// ===========================================================================
// ① resolveCursorPlacement：混合 DPI
// ===========================================================================
test('resolveCursorPlacement: 主屏 150%（本机实测量纲）落到截图像内物理坐标', () => {
  // 本机 DISPLAY1：DIP 2560x1440 @ (0,0)，scaleFactor 1.5 → 物理 3840x2160。
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 1000, y: 600 },
    captureBounds: { x: 0, y: 0, width: 2560, height: 1440 },
    imageSize: { width: 3840, height: 2160 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1.5
  })
  assert.equal(placement.visible, true)
  assert.equal(placement.pointX, 1500)
  assert.equal(placement.pointY, 900)
  assert.equal(placement.x, 1500)
  assert.equal(placement.y, 900)
  assert.equal(placement.scaleFactor, 1.5)
})

test('resolveCursorPlacement: 100% 与 150% 两块屏各自换算（混合 DPI）', () => {
  // 100% 屏：DIP 1920x1080 @ (0,0)，物理同尺寸。
  const hundredPercent = resolveCursorPlacement({
    cursorScreenPoint: { x: 1500, y: 900 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1
  })
  assert.equal(hundredPercent.pointX, 1500)
  assert.equal(hundredPercent.pointY, 900)

  // 150% 屏（同尺寸的 DIP 边界，物理放大 1.5 倍）。
  const hundredFiftyPercent = resolveCursorPlacement({
    cursorScreenPoint: { x: 1500, y: 900 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 2880, height: 1620 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1.5
  })
  assert.equal(hundredFiftyPercent.pointX, 2250)
  assert.equal(hundredFiftyPercent.pointY, 1350)
  assert.notEqual(hundredPercent.pointX, hundredFiftyPercent.pointX)
})

test('resolveCursorPlacement: 125% 屏（DIP 1920 宽 → 物理 2400 宽）', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 2000, y: 100 },
    captureBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 2400, height: 1350 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1.25
  })
  assert.equal(placement.visible, true)
  assert.equal(placement.pointX, 100) // (2000 - 1920) * 1.25
  assert.equal(placement.pointY, 125)
})

// ===========================================================================
// ② resolveCursorPlacement：负坐标副屏
// ===========================================================================
test('resolveCursorPlacement: 负坐标副屏（左侧/上方）不丢偏移', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: -1800, y: -100 },
    captureBounds: { x: -1920, y: -120, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1
  })
  assert.equal(placement.visible, true)
  assert.equal(placement.pointX, 120)
  assert.equal(placement.pointY, 20)
})

test('resolveCursorPlacement: 负坐标副屏 + scaleFactor 1.5', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: -1900, y: -100 },
    captureBounds: { x: -1920, y: -120, width: 1920, height: 1080 },
    imageSize: { width: 2880, height: 1620 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1.5
  })
  assert.equal(placement.pointX, 30)
  assert.equal(placement.pointY, 30)
})

test('resolveCursorPlacement: 只有 scaleFactor 缺失时才回落到 imageSize/bounds 比值', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 100, y: 100 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 2400, height: 1350 },
    hotspot: { x: 0, y: 0 }
  })
  assert.equal(placement.scaleFactor, 1.25)
  assert.equal(placement.pointX, 125)
})

// ===========================================================================
// ③ resolveCursorPlacement：选区外可见性
// ===========================================================================
test('resolveCursorPlacement: 光标点落在选区外 → visible=false（不绘制）', () => {
  const base = {
    cursorScreenPoint: { x: 900, y: 300 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1,
    selectionRect: { x: 0, y: 0, width: 800, height: 600 }
  }
  const outside = resolveCursorPlacement(base)
  assert.equal(outside.visible, false)
  assert.equal(outside.reason, 'outside-selection')

  const inside = resolveCursorPlacement({ ...base, cursorScreenPoint: { x: 799, y: 599 } })
  assert.equal(inside.visible, true)
  assert.equal(inside.reason, '')

  // 右/下边界取开区间，与 getSourcePixelRect 的裁剪语义一致。
  const onEdge = resolveCursorPlacement({ ...base, cursorScreenPoint: { x: 800, y: 600 } })
  assert.equal(onEdge.visible, false)
})

test('resolveCursorPlacement: 未给选区时以整张截图为可见范围', () => {
  const base = {
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    hotspot: { x: 0, y: 0 },
    scaleFactor: 1
  }
  assert.equal(resolveCursorPlacement({ ...base, cursorScreenPoint: { x: 1919, y: 1079 } }).visible, true)
  assert.equal(resolveCursorPlacement({ ...base, cursorScreenPoint: { x: 1920, y: 1080 } }).visible, false)
  assert.equal(resolveCursorPlacement({ ...base, cursorScreenPoint: { x: -1, y: 10 } }).visible, false)
})

test('resolveCursorPlacement: 点在选区内、位图跨过选区边缘时仍可见（由画布裁剪）', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 2, y: 2 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    hotspot: { x: 5, y: 14 },
    scaleFactor: 1,
    selectionRect: { x: 0, y: 0, width: 800, height: 600 },
    cursorSize: { width: 48, height: 48 }
  })
  assert.equal(placement.visible, true)
  assert.equal(placement.x, -3) // 2 - 5，负值交给 canvas 裁剪
  assert.equal(placement.y, -12) // 2 - 14
  assert.equal(placement.width, 48)
  assert.equal(placement.height, 48)
})

// ===========================================================================
// ④ resolveCursorPlacement：热点偏移（1:1，不乘 scaleFactor）
// ===========================================================================
test('resolveCursorPlacement: 减去热点（1:1），不是左上角对齐', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 500, y: 400 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    hotspot: { x: 5, y: 14 },
    scaleFactor: 1
  })
  assert.equal(placement.x, 495)
  assert.equal(placement.y, 386)
  assert.notEqual(placement.x, placement.pointX)
})

test('resolveCursorPlacement: 热点不随 scaleFactor 放大（实测：热点与位图同一像素空间）', () => {
  // 证据：IDC_ARROW 在本机 DPI-unaware 进程是 32x32 / 热点 (3,9)，
  // 在 PMv2 进程是 48x48 / 热点 (5,14) —— 后者 = 前者 ×1.5 四舍五入。
  // 位图本身已经是物理像素并按自然尺寸贴出，所以热点修正必须 1:1。
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 1000, y: 600 },
    captureBounds: { x: 0, y: 0, width: 2560, height: 1440 },
    imageSize: { width: 3840, height: 2160 },
    hotspot: { x: 5, y: 14 },
    scaleFactor: 1.5
  })
  assert.equal(placement.pointX, 1500)
  assert.equal(placement.x, 1495) // 1500 - 5
  assert.equal(placement.y, 886) // 900 - 14
  // 反面断言：热点 × scaleFactor 会在 150% 下多偏 2.5px / 7px。
  assert.notEqual(placement.x, Math.round(1500 - 5 * 1.5))
  assert.notEqual(placement.y, Math.round(900 - 14 * 1.5))
})

test('resolveCursorPlacement: drawScale 只在位图被缩放贴出时才传（默认 1）', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 100, y: 100 },
    captureBounds: { x: 0, y: 0, width: 100, height: 100 },
    imageSize: { width: 100, height: 100 },
    hotspot: { x: 5, y: 14 },
    scaleFactor: 1,
    drawScale: 2
  })
  assert.equal(placement.x, 90)
  assert.equal(placement.y, 72)
})

// ===========================================================================
// ⑤ resolveCursorPlacement：scaleFactor ≠ 1 与非法输入
// ===========================================================================
test('resolveCursorPlacement: scaleFactor 0.5（缩放副屏）也成立', () => {
  const placement = resolveCursorPlacement({
    cursorScreenPoint: { x: 400, y: 300 },
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 960, height: 540 },
    hotspot: { x: 1, y: 2 },
    scaleFactor: 0.5
  })
  assert.equal(placement.pointX, 200)
  assert.equal(placement.pointY, 150)
  assert.equal(placement.x, 199)
  assert.equal(placement.y, 148)
})

test('resolveCursorPlacement: 非法输入一律 visible=false 且不抛错', () => {
  const invalidInputs = [
    {},
    { captureBounds: { x: 0, y: 0, width: 0, height: 100 }, imageSize: { width: 10, height: 10 } },
    { captureBounds: { x: 0, y: 0, width: 100, height: 100 }, imageSize: { width: 0, height: 0 } },
    { captureBounds: null, imageSize: null }
  ]
  for (const input of invalidInputs) {
    const placement = resolveCursorPlacement(input)
    assert.equal(placement.visible, false, JSON.stringify(input))
    assert.equal(placement.reason, 'invalid-input')
  }
  // 缺 scaleFactor 但 imageSize 可用 → 走回落，不是 invalid。
  assert.equal(resolveCursorPlacement({
    cursorScreenPoint: { x: 9, y: 9 },
    captureBounds: { x: 0, y: 0, width: 10, height: 10 },
    imageSize: { width: 10, height: 10 }
  }).visible, true)
  // scaleFactor 非正数（0 / -1 / NaN）同样回落到 imageSize/bounds，而不是算成负数。
  for (const scaleFactor of [0, -1, Number.NaN, 'x']) {
    const placement = resolveCursorPlacement({
      cursorScreenPoint: { x: 10, y: 10 },
      captureBounds: { x: 0, y: 0, width: 100, height: 100 },
      imageSize: { width: 100, height: 100 },
      scaleFactor
    })
    assert.equal(placement.visible, true, String(scaleFactor))
    assert.equal(placement.scaleFactor, 1, String(scaleFactor))
    assert.equal(placement.pointX, 10, String(scaleFactor))
  }
  assert.equal(resolveCursorPlacement().visible, false)
})

// ===========================================================================
// helper 行协议解析
// ===========================================================================
test('parseHelperMessage: ready / rects / cursor / 坏行', () => {
  assert.deepEqual(parseHelperMessage('{"ready":true,"windows":[{"left":0}]}'), {
    kind: 'ready',
    windows: [{ left: 0 }]
  })
  assert.deepEqual(parseHelperMessage('{"ready":true}'), { kind: 'ready', windows: [] })
  assert.deepEqual(parseHelperMessage('{"id":3,"rects":[{"left":1}]}'), {
    kind: 'rects',
    id: 3,
    rects: [{ left: 1 }]
  })
  assert.deepEqual(parseHelperMessage(JSON.stringify(cursorPayload({ id: 9 }))), {
    kind: 'cursor',
    id: 9,
    showing: true,
    png: 'iVBORw0KGgo=',
    width: 48,
    height: 48,
    hotspot: { x: 5, y: 14 },
    physicalPoint: { x: 640, y: 480 }
  })
  // CURSOR_SHOWING=0：只有 showing 字段，没有位图。
  assert.deepEqual(parseHelperMessage('{"id":4,"cursor":true,"showing":false}'), {
    kind: 'cursor',
    id: 4,
    showing: false
  })
  // 无 id 的 cursor 响应（`cursor` 单 token 命令）也能解析。
  assert.equal(parseHelperMessage('{"cursor":true,"showing":false}').id, null)
  assert.deepEqual(parseHelperMessage('   '), { kind: 'invalid', reason: 'empty' })
  assert.deepEqual(parseHelperMessage('not json'), { kind: 'invalid', reason: 'json' })
  assert.deepEqual(parseHelperMessage('[]'), { kind: 'invalid', reason: 'shape' })
  assert.deepEqual(parseHelperMessage('{"hello":1}'), { kind: 'invalid', reason: 'unknown' })
  assert.deepEqual(parseHelperMessage('{"id":1,"cursor":true,"showing":true}'), { kind: 'invalid', reason: 'cursor-png' })
  assert.deepEqual(parseHelperMessage(undefined), { kind: 'invalid', reason: 'empty' })
})

test('toCursorDataUrl: 空值不产生前缀垃圾', () => {
  assert.equal(toCursorDataUrl('AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(toCursorDataUrl(''), '')
  assert.equal(toCursorDataUrl(null), '')
})

// ===========================================================================
// provider：路径解析
// ===========================================================================
test('resolveCursorHelperPath: 开发态走仓库根，打包态走 resources', () => {
  assert.equal(
    resolveCursorHelperPath({ rootDirectory: 'C:\\app' }),
    path.join('C:\\app', HELPER_RELATIVE_PATH)
  )
  assert.equal(
    resolveCursorHelperPath({ rootDirectory: 'C:\\app', executablePath: 'D:\\x\\SmartSelect.exe' }),
    'D:\\x\\SmartSelect.exe'
  )
  // app 存在但 isPackaged 非 true → 仍按开发态解析。
  assert.equal(
    resolveCursorHelperPath({ rootDirectory: 'C:\\app', app: { isPackaged: false } }),
    path.join('C:\\app', HELPER_RELATIVE_PATH)
  )
  // 纯 node 下 process.resourcesPath 不存在，打包分支必须回落到仓库根，
  // 而不是拿 undefined 去 path.join 抛 ERR_INVALID_ARG_TYPE。
  assert.equal(
    resolveCursorHelperPath({ rootDirectory: 'C:\\app', app: { isPackaged: true } }),
    path.join('C:\\app', HELPER_RELATIVE_PATH)
  )
  // 借 Electron 的 resourcesPath 走一次真正的打包分支。
  const original = process.resourcesPath
  Object.defineProperty(process, 'resourcesPath', { value: 'C:\\res', configurable: true })
  try {
    assert.equal(
      resolveCursorHelperPath({ rootDirectory: 'C:\\app', app: { isPackaged: true } }),
      path.join('C:\\res', HELPER_RELATIVE_PATH)
    )
  } finally {
    if (original === undefined) delete process.resourcesPath
    else Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true })
  }
})

// ===========================================================================
// provider：查询 / 缓存 / 降级
// ===========================================================================
test('provider: 正常取到快照（热点、位图、dataUrl、物理点）', async () => {
  const harness = createHarness({ now: () => 1000 })
  harness.child.onWrite = () => reply(harness.child, cursorPayload({ id: 1 }))
  const snapshot = await harness.provider.query()
  assert.ok(snapshot)
  assert.equal(snapshot.showing, true)
  assert.equal(snapshot.png, 'iVBORw0KGgo=')
  assert.equal(snapshot.dataUrl, 'data:image/png;base64,iVBORw0KGgo=')
  assert.deepEqual(snapshot.hotspot, { x: 5, y: 14 })
  assert.deepEqual(snapshot.physicalPoint, { x: 640, y: 480 })
  assert.equal(snapshot.width, 48)
  assert.equal(snapshot.height, 48)
  assert.equal(snapshot.cached, false)
  assert.equal(harness.child.writes[0], 'cursor 1\n')
  assert.equal(harness.child.writes.length, 1)
  harness.provider.dispose()
  assert.equal(harness.provider.isAvailable(), false)
  assert.deepEqual(harness.logs, [])
})

test('provider: 形状在 TTL 内命中缓存，fresh:true 绕过缓存', async () => {
  let clock = 5000
  const harness = createHarness({ now: () => clock, cacheTtlMs: DEFAULT_CACHE_TTL_MS })
  let served = 0
  harness.child.onWrite = () => {
    served++
    reply(harness.child, cursorPayload({ id: served }))
  }

  const first = await harness.provider.query()
  assert.equal(first.cached, false)
  clock += 100
  const cached = await harness.provider.query()
  assert.equal(cached.cached, true)
  assert.equal(cached.png, first.png)
  assert.equal(harness.child.writes.length, 1)

  const fresh = await harness.provider.query({ fresh: true })
  assert.equal(fresh.cached, false)
  assert.equal(harness.child.writes.length, 2)

  clock += DEFAULT_CACHE_TTL_MS + 1
  const expired = await harness.provider.query()
  assert.equal(expired.cached, false)
  assert.equal(harness.child.writes.length, 3)
  harness.provider.dispose()
})

test('provider: CURSOR_SHOWING=0 → null，且让形状缓存失效', async () => {
  const harness = createHarness()
  let served = 0
  harness.child.onWrite = () => {
    served++
    reply(harness.child, served === 1
      ? cursorPayload({ id: 1 })
      : { id: served, cursor: true, showing: false })
  }
  assert.ok(await harness.provider.query())
  assert.equal(await harness.provider.query({ fresh: true }), null)
  // 缓存已被 showing:false 清掉，下一次仍是真查询。
  assert.equal(await harness.provider.query(), null)
  assert.equal(harness.child.writes.length, 3)
  harness.provider.dispose()
})

test('provider: ready 之前发出的查询等 ready；ready 后才回结果', async () => {
  const harness = createHarness({ autoReady: false })
  harness.child.onWrite = (chunk) => {
    if (chunk.startsWith('cursor')) reply(harness.child, cursorPayload({ id: 1 }))
  }
  const pending = harness.provider.query()
  setImmediate(() => harness.child.stdout.emit('data', '{"ready":true,"windows":[]}\n'))
  const snapshot = await pending
  assert.ok(snapshot)
  harness.provider.dispose()
})

test('provider: helper 缺失 / 未注入 spawn / spawn 抛错 → 安全降级为 null', async () => {
  const missing = createHarness({ executablePath: '', rootDirectory: 'C:\\nope', existsSync: () => false })
  assert.equal(await missing.provider.query(), null)
  assert.equal(missing.provider.isAvailable(), false)
  assert.equal(missing.logs.length, 1)

  const noSpawn = createHarness({ spawn: null })
  assert.equal(await noSpawn.provider.query(), null)
  assert.equal(noSpawn.logs.length, 1)

  const throwing = createHarness({ spawn: () => { throw new Error('EACCES') } })
  assert.equal(await throwing.provider.query(), null)
  assert.equal(throwing.logs.length, 1)
})

test('provider: 子进程 exit / error → 丢在途请求并返回 null，不抛错', async () => {
  const harness = createHarness()
  const pending = harness.provider.query()
  // ready 先到、cursor 命令已写出，随后子进程才崩：在途请求必须被丢弃而不是挂死。
  setImmediate(() => setImmediate(() => harness.child.emit('error', new Error('ENOENT'))))
  assert.equal(await pending, null)
  assert.equal(harness.provider.isAvailable(), false)
  assert.equal(harness.child.writes.length, 1)
  assert.equal(await harness.provider.query(), null)
  // 已经不可用，第二次 query 不会重新拉起进程。
  assert.equal(harness.child.writes.length, 1)
  assert.equal(harness.logs.length, 1)
})

test('provider: 启动超时 → 收掉 helper 并降级', async () => {
  const harness = createHarness({ autoReady: false, readyTimeoutMs: 20 })
  const started = Date.now()
  assert.equal(await harness.provider.query(), null)
  assert.ok(Date.now() - started >= 10)
  assert.equal(harness.provider.isAvailable(), false)
  assert.equal(harness.child.killed, true)
  assert.equal(harness.child.stdinEnded, true)
  assert.match(harness.logs.join('\n'), /startup timeout/)
})

test('provider: 查询超时 → 这一次返回 null 并收掉 helper', async () => {
  const harness = createHarness({ autoReady: false, queryTimeoutMs: 20 })
  harness.child.onWrite = () => { /* 永不回应 */ }
  const pending = harness.provider.query()
  setImmediate(() => harness.child.stdout.emit('data', '{"ready":true}\n'))
  assert.equal(await pending, null)
  assert.equal(harness.provider.isAvailable(), false)
  assert.match(harness.logs.join('\n'), /query timeout/)
})

test('provider: stdin 写入抛错 → 降级；stderr 有内容时记日志', async () => {
  const harness = createHarness()
  harness.child.stdin.write = () => { throw new Error('EPIPE') }
  assert.equal(await harness.provider.query(), null)
  assert.match(harness.logs.join('\n'), /EPIPE/)

  const noisy = createHarness()
  noisy.child.onWrite = () => {}
  noisy.provider.query()
  setImmediate(() => noisy.child.stderr.emit('data', '  boom  \n'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(noisy.logs.some((line) => line.includes('boom')))
  noisy.provider.dispose()
})

test('provider: 坏行与无关行只记日志，不打断分发', async () => {
  const harness = createHarness()
  harness.child.onWrite = () => {
    // 先灌入坏行与无关的 rects 行，再回真正的 cursor 响应。
    setImmediate(() => harness.child.stdout.emit('data', 'not-json\n{"id":1,"rects":[]}\n'))
    setImmediate(() => reply(harness.child, cursorPayload({ id: 1 })))
  }
  const snapshot = await harness.provider.query()
  assert.ok(snapshot)
  assert.ok(harness.logs.some((line) => line.includes('response error')))
  harness.provider.dispose()
  harness.provider.dispose() // 幂等
})

test('provider: dispose 之后的查询不再拉起进程', async () => {
  const harness = createHarness()
  harness.provider.dispose()
  assert.equal(await harness.provider.query(), null)
  assert.equal(harness.child.writes.length, 0)
  assert.equal(harness.provider.isAvailable(), false)
})

test('createCursorSnapshot: showing!==true 或非 cursor 消息一律 null', () => {
  assert.equal(createCursorSnapshot(null, 0), null)
  assert.equal(createCursorSnapshot({ kind: 'ready' }, 0), null)
  assert.equal(createCursorSnapshot({ kind: 'cursor', showing: false }, 0), null)
  const snapshot = createCursorSnapshot({
    kind: 'cursor',
    showing: true,
    png: 'AA',
    width: 1,
    height: 1,
    hotspot: { x: 0, y: 0 },
    physicalPoint: { x: 1, y: 2 }
  }, Number.NaN)
  assert.equal(snapshot.at, 0)
  assert.equal(snapshot.cached, false)
})
