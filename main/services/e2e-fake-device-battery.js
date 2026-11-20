'use strict'

const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')

// Exercise the real main-process framing, IPC and demand logic without opening
// any device handles. Use only with the isolated, unpackaged E2E environment.
function spawnFakeDeviceBattery() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  let closed = false
  let refreshed = false
  let refreshTimer
  const writeSnapshot = (refresh) => {
    if (closed) return
    child.stdout.write(JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      system: { state: 'no-battery', acOnline: true },
      ...(refresh ? { refresh } : {}),
      devices: [
        { id: 'fixture-receiver:1', name: 'Fixture Mouse <USB>', kind: 'mouse', source: 'logitech', percent: refreshed ? 1 : 0 },
        { id: 'fixture-headset:2', name: 'Fixture Headphones', kind: 'headphones', source: 'bluetooth', percent: null },
        { id: 'fixture-keyboard:4', name: 'Fixture Keyboard', kind: 'keyboard', source: 'hid', percent: 44 },
        { id: 'fixture-unknown:5', name: 'Fixture Unknown', kind: 'other', source: 'hid', percent: 36 },
        { id: 'fixture-buds:3', name: 'Fixture Earbuds', kind: 'earbuds', source: 'apple', percent: 61, estimated: true, parts: [
          { part: 'left', percent: 61 }, { part: 'right', percent: 70 }, { part: 'case', percent: 85, charging: true }
        ] }
      ]
    }) + '\n')
  }
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(refreshTimer)
    child.stdout.end()
    queueMicrotask(() => child.emit('close', 0))
  }
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const match = /^refresh ([1-9]\d*)\n$/.exec(chunk.toString())
      if (match) {
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshed = true
          writeSnapshot({ id: Number(match[1]), status: 'complete' })
        }, 350)
      }
      done()
    },
    final(done) { close(); done() }
  })
  child.kill = close
  queueMicrotask(writeSnapshot)
  return child
}

module.exports = { spawnFakeDeviceBattery }
