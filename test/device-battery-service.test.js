'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { createLineReader, createSnapshotDecoder, MAX_LINE_BYTES } = require('../main/services/device-battery-protocol')
const { createDeviceBatteryService, resolveDeviceBatteryExecutable } = require('../main/services/device-battery-service')

const wire = (status = 'ready') => ({ schemaVersion: 1, status, system: { state: 'no-battery', percent: 15, acOnline: true }, devices: [] })
const asBuffer = (value) => Buffer.from(JSON.stringify(value))

function harness(options = {}) {
  const calls = []
  const states = []
  const timers = new Map()
  let now = 0
  let nextTimer = 0
  const service = createDeviceBatteryService({
    getExecutable: () => path.resolve('native/device-battery/bin/HighlighterDeviceBattery.exe'),
    getStateDirectory: () => path.resolve('.tmp-device-battery-test'),
    supported: true,
    monotonicNow: () => now,
    now: () => 10_000 + now,
    startTimeoutMs: 500,
    heartbeatTimeoutMs: 600,
    stopTimeoutMs: 200,
    ...options,
    setTimer(callback, timeout) {
      const id = ++nextTimer
      timers.set(id, { callback, due: now + timeout })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    onSnapshot: (snapshot) => states.push(snapshot),
    spawnProcess(executable, args, opts) {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdin = new EventEmitter()
      const commands = []
      let killed = 0
      child.stdin.write = (text) => commands.push(text)
      child.stdin.end = (text) => commands.push(text)
      child.kill = () => { killed++ }
      const run = {
        executable, args, opts, child, commands, killed: () => killed,
        report: (value) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')),
        close: () => child.emit('close', 0)
      }
      calls.push(run)
      return child
    }
  })
  function tickTo(next) {
    for (;;) {
      const entry = [...timers].sort(([, a], [, b]) => a.due - b.due)[0]
      if (!entry || entry[1].due > next) break
      const [id, timer] = entry
      now = timer.due
      timers.delete(id)
      timer.callback()
    }
    now = next
  }
  return { service, calls, states, tickTo }
}

test('snapshot decoder keeps zero and parts, sanitizes names and never exposes wire device identifiers', () => {
  const decode = createSnapshotDecoder(Buffer.alloc(32))
  const native = wire()
  native.devices = [
    { id: 'bt:AABBCCDDEEFF', name: '鼠标\u0000 <Mouse>', kind: 'mouse', source: 'logitech', percent: 0, stale: true, address: 'AABBCCDDEEFF' },
    { id: 'usb:serial', name: 'Buds', kind: 'earbuds', source: 'apple', percent: 255, estimated: true, parts: [
      { part: 'left', percent: 24, charging: false }, { part: 'right', percent: -1 }, { part: 'case', percent: 90, charging: true }, { part: 'case', percent: 1 }
    ] },
    { id: 'bt:AABBCCDDEEFF', name: 'duplicate', source: 'gatt' }
  ]
  const result = decode(asBuffer(native))
  assert.deepEqual(result.system, { state: 'no-battery', percent: null, acOnline: true, charging: null })
  assert.equal(result.devices.length, 2)
  assert.equal(result.devices[0].name, '鼠标 <Mouse>')
  assert.equal(result.devices[0].percent, 0)
  assert.equal(result.devices[0].stale, true)
  assert.equal(result.devices[0].charging, null)
  assert.match(result.devices[0].id, /^[0-9a-f]{32}$/)
  assert.equal(result.devices[0].id, decode(asBuffer(native)).devices[0].id)
  assert.doesNotMatch(JSON.stringify(result), /AABBCCDDEEFF|usb:serial/)
  assert.equal(result.devices[1].percent, null)
  assert.equal(result.devices[1].estimated, true)
  assert.deepEqual(result.devices[1].parts, [
    { part: 'left', percent: 24, charging: false }, { part: 'right', percent: null, charging: null }, { part: 'case', percent: 90, charging: true }
  ])
  assert.throws(() => decode(asBuffer({ ...native, schemaVersion: 2 })))
  assert.throws(() => decode(Buffer.from([0xC0, 0xB0])))
  assert.equal(decode(asBuffer({ ...native, devices: [{ id: 'wrong', source: 'error', name: 'ignored' }] })).status, 'partial')
})

test('framing handles split Chinese UTF-8 and bounds unterminated lines', () => {
  const lines = []
  const feed = createLineReader((line) => lines.push(line.toString('utf8')))
  const bytes = Buffer.from('外设\r\n{}\n')
  feed(bytes.subarray(0, 2))
  feed(bytes.subarray(2, 7))
  feed(bytes.subarray(7))
  assert.deepEqual(lines, ['外设\r', '{}'])
  feed(Buffer.alloc(MAX_LINE_BYTES))
  assert.throws(() => feed(Buffer.from('x')), /too-large/)
})

test('does not spawn until demanded and resolves fixed paths inside resources', async () => {
  const { service, calls, states } = harness()
  assert.equal(service.getSnapshot().status, 'paused')
  assert.equal((await service.refresh()).status, 'paused')
  assert.equal(calls.length, 0)
  service.setActive(true)
  service.setActive(true)
  assert.equal(calls.length, 1)
  const [run] = calls
  assert.equal(run.executable, path.resolve('native/device-battery/bin/HighlighterDeviceBattery.exe'))
  assert.deepEqual(run.args, ['--watch', '--state-dir', path.resolve('.tmp-device-battery-test')])
  assert.equal(run.opts.shell, false)
  assert.equal(run.opts.windowsHide, true)
  assert.equal(run.opts.cwd, path.dirname(run.executable))
  run.report(wire('loading'))
  assert.equal(service.getSnapshot().updatedAt, null)
  run.report(wire())
  assert.equal(service.getSnapshot().updatedAt, 10_000)
  assert.deepEqual(states.map((s) => s.revision), states.map((_s, index) => index + 1))
  assert.equal(resolveDeviceBatteryExecutable({ appRoot: 'unused', resourcesPath: path.resolve('resources'), packaged: true }),
    path.resolve('resources/native/device-battery/HighlighterDeviceBattery.exe'))
  const done = service.dispose()
  assert.deepEqual(run.commands, ['stop\n'])
  run.close()
  await done
})

const ack = (id, status = 'complete', value = wire()) => ({ ...value, refresh: { id, status } })

test('manual refresh waits for its own completion even when a heartbeat or another receipt arrives', async () => {
  const { service, calls, tickTo } = harness({ heartbeatTimeoutMs: 20_000 })
  service.setActive(true)
  const [run] = calls
  run.report(wire('loading'))
  const first = service.refresh()
  assert.equal(service.refresh(), first, 'concurrent IPC requests share one read')
  assert.deepEqual(run.commands, ['refresh 1\n'], 'first click is not silently throttled during startup')
  let completed = false
  void first.then(() => { completed = true })
  tickTo(30)
  run.report(wire())
  run.report(ack(123))
  await Promise.resolve()
  assert.equal(completed, false, 'ordinary pushes and unrelated acknowledgements do not complete the action')

  const mouse = { id: 'm', name: 'Mouse', kind: 'mouse', source: 'hid', percent: 17 }
  tickTo(50)
  run.report(ack(1, 'complete', { ...wire(), devices: [mouse] }))
  const result = await first
  assert.equal(result.status, 'complete')
  assert.equal(result.snapshot.devices[0].percent, 17)
  assert.equal(result.snapshot.updatedAt, 10_050)
  assert.equal(result.snapshot.refresh, undefined, 'wire-only metadata is not a renderer field')

  const second = service.refresh()
  tickTo(4999)
  assert.deepEqual(run.commands, ['refresh 1\n'])
  tickTo(5000)
  assert.deepEqual(run.commands, ['refresh 1\n', 'refresh 2\n'], 'a quick click is queued, not dropped')
  run.report(ack(2, 'partial', { ...wire(), devices: [mouse] }))
  assert.equal((await second).status, 'partial')
  assert.equal(calls.length, 1, 'no restart is needed to refresh the list')
  service.dispose()
  run.close()
})

test('refresh times out without losing data and hidden pages cancel queued work', async () => {
  const { service, calls, tickTo } = harness({ refreshTimeoutMs: 200, heartbeatTimeoutMs: 20_000 })
  service.setActive(true)
  const [run] = calls
  run.report(wire())
  const first = service.refresh()
  const snapshot = service.getSnapshot()
  tickTo(200)
  assert.deepEqual(await first, { status: 'timeout', snapshot })
  const next = service.refresh()
  run.report(ack(1)) // A late completion can update readings, but must not finish this request.
  service.setActive(false)
  assert.deepEqual(await next, { status: 'paused', snapshot: service.getSnapshot() })
  run.close()
  tickTo(5000)
  assert.deepEqual(run.commands, ['refresh 1\n', 'stop\n'])
  assert.equal(calls.length, 1)
})

test('rapid hide/reopen waits for graceful exit and drops superseded output', async () => {
  const { service, calls, tickTo } = harness()
  service.setActive(true)
  const [old] = calls
  service.setActive(false)
  assert.deepEqual(old.commands, ['stop\n'])
  old.report(wire())
  assert.equal(service.getSnapshot().status, 'paused')
  service.setActive(true)
  assert.equal(calls.length, 1)
  tickTo(200)
  assert.equal(old.killed(), 1)
  assert.equal(calls.length, 1)
  old.close()
  assert.equal(calls.length, 2)
  old.report(wire())
  assert.equal(service.getSnapshot().status, 'loading')
  const newRun = calls[1]
  newRun.report(wire('partial'))
  assert.equal(service.getSnapshot().status, 'partial')
  const stop = service.dispose()
  newRun.close()
  await stop
  assert.equal(service.dispose(), null)
})

test('startup timeout, stalled heartbeat and invalid output fail closed without an automatic restart loop', () => {
  for (const cause of ['startup', 'heartbeat', 'invalid']) {
    const { service, calls, tickTo } = harness()
    service.setActive(true)
    const [run] = calls
    if (cause === 'startup') {
      run.report(wire('loading'))
      tickTo(500)
    } else if (cause === 'heartbeat') {
      run.report(wire())
      tickTo(600)
    } else {
      run.child.stdout.emit('data', Buffer.from('garbage\n'))
    }
    assert.equal(service.getSnapshot().status, 'unavailable')
    assert.deepEqual(run.commands, ['stop\n'])
    run.close()
    assert.equal(calls.length, 1)
    tickTo(5000)
    service.refresh()
    assert.equal(calls.length, 2)
    service.dispose()
    calls[1].close()
  }
})
