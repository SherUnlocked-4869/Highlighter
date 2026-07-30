const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  AutomationController
} = require('../long-capture/automation')
const {
  findBestShift
} = require('../long-capture/matcher')
const {
  splitWheelDelta,
  WindowsScrollDriver
} = require('../main/services/windows-scroll-driver')

function makeFrame(width, height, valueAt) {
  const frame = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) frame[y * width + x] = valueAt(x, y)
  }
  return frame
}

function makeViewport({ width, height, scroll, header = 0, footer = 0, dynamicOffset = 0 }) {
  return makeFrame(width, height, (x, y) => {
    if (y < header) return (x * 17 + y * 11) % 251
    if (y >= height - footer) return (x * 7 + y * 23) % 251
    if (dynamicOffset && y >= Math.floor(height * 0.45) && y < Math.floor(height * 0.52)) {
      return (x * 31 + y * 13 + dynamicOffset) % 251
    }
    return (x * 19 + (y - header + scroll) * 29 + x * (y - header + scroll) * 3) % 251
  })
}

test('matcher finds forward overlap around fixed header, footer, and dynamic content', () => {
  const width = 96
  const height = 180
  const shift = 58
  const previous = makeViewport({ width, height, scroll: 0, header: 18, footer: 16, dynamicOffset: 1 })
  const current = makeViewport({ width, height, scroll: shift, header: 18, footer: 16, dynamicOffset: 47 })
  const result = findBestShift(previous, current, width, height, 'vertical', { direction: 'forward' })

  assert.equal(result.status, 'matched')
  assert.equal(result.shift, shift)
  assert.ok(result.coverage >= 0.28)
  assert.ok(result.confidence > 0.45)
})

test('matcher treats small animated regions as still at the page end', () => {
  const width = 96
  const height = 180
  const previous = makeViewport({ width, height, scroll: 120, header: 18, footer: 16, dynamicOffset: 1 })
  const current = makeViewport({ width, height, scroll: 120, header: 18, footer: 16, dynamicOffset: 17 })
  const result = findBestShift(previous, current, width, height, 'vertical', { direction: 'forward' })

  assert.equal(result.status, 'still')
})

test('matcher searches for coherent movement before classifying a mostly static frame as still', () => {
  const width = 160
  const height = 180
  const shift = 42
  const makeNarrowViewport = (scroll) => makeFrame(width, height, (x, y) => {
    if (x < 68 || x >= 92) return 18
    return (x * 29 + (y + scroll) * 41 + x * (y + scroll) * 7) % 251
  })
  const result = findBestShift(
    makeNarrowViewport(0),
    makeNarrowViewport(shift),
    width,
    height,
    'vertical',
    {
      direction: 'forward',
      minimumCoverage: 0.18,
      minimumRun: 0.1,
      minimumMargin: 0.12
    }
  )

  assert.equal(result.status, 'matched')
  assert.equal(result.shift, shift)
})

test('automation appends frames, confirms the end with real scroll probes, and stops', () => {
  const automation = new AutomationController({ endStillFrames: 2 })
  automation.start(1000)

  assert.deepEqual(automation.acceptFrame({ status: 'initialized' }, 1001).action, 'scroll')
  assert.equal(automation.acceptScroll({ ok: true }, 1002).action, 'capture')
  const matched = automation.acceptFrame({ status: 'matched' }, 1003)
  assert.equal(matched.append, 'matched')
  assert.equal(matched.action, 'scroll')
  assert.equal(automation.acceptScroll({ ok: true }, 1004).action, 'capture')
  assert.equal(automation.acceptFrame({ status: 'still' }, 1005).action, 'scroll')
  assert.equal(automation.acceptScroll({ ok: true }, 1006).action, 'capture')
  const ended = automation.acceptFrame({ status: 'still' }, 1007)
  assert.equal(ended.action, 'stop')
  assert.equal(ended.reason, 'end-reached')
  assert.equal(automation.snapshot().running, false)
})

test('automation requires extra scroll probes before declaring an initial frame is already at the end', () => {
  const automation = new AutomationController({
    endStillFrames: 2,
    initialEndStillFrames: 3
  })
  automation.start(1000)
  automation.acceptFrame({ status: 'initialized' }, 1001)
  automation.acceptScroll({ ok: true }, 1002)

  assert.equal(automation.acceptFrame({ status: 'still' }, 1003).action, 'scroll')
  automation.acceptScroll({ ok: true }, 1004)
  assert.equal(automation.acceptFrame({ status: 'still' }, 1005).action, 'scroll')
  automation.acceptScroll({ ok: true }, 1006)
  assert.equal(automation.acceptFrame({ status: 'still' }, 1007).reason, 'end-reached')
})

test('automation falls back to manual mode on unstable matches and scroll safety failures', () => {
  const unstable = new AutomationController({ failedRetries: 2 })
  unstable.start(1000)
  assert.equal(unstable.acceptFrame({ status: 'failed' }, 1001).action, 'retry')
  assert.equal(unstable.acceptFrame({ status: 'failed' }, 1002).reason, 'low-confidence')

  const userInput = new AutomationController()
  userInput.start(1000)
  const stopped = userInput.acceptScroll({ ok: false, reason: 'user-input' }, 1001)
  assert.equal(stopped.action, 'stop')
  assert.equal(stopped.reason, 'user-input')
})

test('automation enforces frame and duration limits', () => {
  const frameLimited = new AutomationController({ maxFrames: 2 })
  frameLimited.start(1000)
  frameLimited.acceptFrame({ status: 'initialized' }, 1001)
  const frameStop = frameLimited.acceptFrame({ status: 'matched' }, 1002)
  assert.equal(frameStop.append, 'matched')
  assert.equal(frameStop.reason, 'max-frames')

  const durationLimited = new AutomationController({ maxDurationMs: 1000 })
  durationLimited.start(1000)
  assert.equal(durationLimited.acceptFrame({ status: 'initialized' }, 2000).reason, 'max-duration')
})

function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  child.stdin = {
    writes: [],
    write(value, callback) {
      this.writes.push(value)
      callback?.()
      return true
    }
  }
  child.killed = false
  child.kill = () => { child.killed = true }
  return child
}

test('Windows scroll driver locks the first target for later wheel requests', async () => {
  const child = createFakeChild()
  const driver = new WindowsScrollDriver({
    executablePath: 'ScrollDriver.exe',
    spawnProcess: () => child,
    startTimeoutMs: 1000,
    requestTimeoutMs: 1000
  })
  const starting = driver.start()
  child.stdout.emit('data', '{"ready":true}\n')
  await starting

  const firstRequest = driver.scroll({ x: -120, y: 350, delta: -720, excludedProcessId: 42 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(child.stdin.writes[0], /^1 -120 350 -720 0 42 1000\n$/)
  child.stdout.emit('data', '{"id":1,"ok":true,"target":"987654","processId":77}\n')
  assert.deepEqual(await firstRequest, {
    ok: true,
    target: '987654',
    processId: 77,
    reason: ''
  })

  const secondRequest = driver.scroll({ x: -120, y: 350, delta: -720, excludedProcessId: 42 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(child.stdin.writes[1], /^2 -120 350 -720 987654 42 1000\n$/)
  child.stdout.emit('data', '{"id":2,"ok":false,"target":"123","processId":88,"reason":"target-changed"}\n')
  assert.equal((await secondRequest).reason, 'target-changed')

  driver.dispose()
  assert.equal(child.killed, true)
  assert.equal(child.stdin.writes.at(-1), 'quit\n')
})

test('Windows scroll driver splits one wheel action into smooth pulses without changing its total', async () => {
  assert.deepEqual(splitWheelDelta(-360, 6), [-60, -60, -60, -60, -60, -60])

  const child = createFakeChild()
  const waits = []
  const driver = new WindowsScrollDriver({
    executablePath: 'ScrollDriver.exe',
    spawnProcess: () => child,
    startTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    wait: async (delayMs) => { waits.push(delayMs) }
  })
  const starting = driver.start()
  child.stdout.emit('data', '{"ready":true}\n')
  await starting

  const scrolling = driver.smoothScroll({
    x: 400,
    y: 500,
    delta: -360,
    steps: 6,
    durationMs: 250,
    excludedProcessId: 42
  })
  for (let id = 1; id <= 6; id++) {
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(child.stdin.writes[id - 1], new RegExp(`^${id} 400 500 -60 (?:0|987654) 42 1000\\n$`))
    child.stdout.emit('data', `{"id":${id},"ok":true,"target":"987654","processId":77}\n`)
  }
  const result = await scrolling

  assert.equal(result.ok, true)
  assert.equal(result.pulses, 6)
  assert.deepEqual(waits, [50, 50, 50, 50, 50])
  driver.dispose()
})
