'use strict'

const { createHmac, randomBytes } = require('node:crypto')

const MAX_LINE_BYTES = 256 * 1024
const KINDS = new Set(['mouse', 'keyboard', 'headphones', 'earbuds', 'controller', 'pen', 'speaker', 'other', 'phone'])
const SOURCES = new Set(['bluetooth', 'gatt', 'logitech', 'razer', 'steelseries', 'hyperx', 'sony', 'apple', 'gaming', 'hid', 'phone-link'])
const PARTS = new Set(['left', 'right', 'case'])
const SYSTEM_STATES = new Set(['ready', 'no-battery', 'unavailable'])
const STATUS = new Set(['loading', 'ready', 'partial'])

const percent = (value) => Number.isInteger(value) && value >= 0 && value <= 100 ? value : null
const flag = (value) => typeof value === 'boolean' ? value : null
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

function normalizeSystem(value) {
  const state = SYSTEM_STATES.has(value?.state) ? value.state : 'unavailable'
  return {
    state,
    percent: state === 'ready' ? percent(value.percent) : null,
    acOnline: state !== 'unavailable' ? flag(value.acOnline) : null,
    charging: state === 'ready' ? flag(value.charging) : null
  }
}

function normalizeParts(parts) {
  if (!Array.isArray(parts)) return []
  const seen = new Set()
  const result = []
  for (const item of parts.slice(0, 6)) {
    if (!PARTS.has(item?.part) || seen.has(item.part)) continue
    seen.add(item.part)
    result.push({ part: item.part, percent: percent(item.percent), charging: flag(item.charging) })
  }
  return result
}

// The wire key can contain a Windows device path, serial number or a Bluetooth
// address. Use a fresh per-process secret, and reconstruct every renderer field.
function createSnapshotDecoder(secret = randomBytes(32)) {
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  return (line) => {
    const value = JSON.parse(utf8.decode(line))
    if (!object(value) || value.schemaVersion !== 1 || !STATUS.has(value.status) || !object(value.system) || !Array.isArray(value.devices)) {
      throw new Error('invalid-battery-snapshot')
    }
    let receipt
    if (value.refresh != null) {
      const { id, status } = value.refresh
      if (!object(value.refresh) || !Number.isInteger(id) || id < 1 || id > 0x7fffffff ||
          (status !== 'complete' && status !== 'partial') || value.status === 'loading') {
        throw new Error('invalid-battery-refresh')
      }
      receipt = { id, status }
    }
    const devices = []
    const keys = new Set()
    const limit = 128
    let partial = value.devices.length > limit
    for (const row of value.devices.slice(0, limit)) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || row.id.length > 1024 || !SOURCES.has(row.source) || typeof row.name !== 'string') {
        partial = true
        continue
      }
      if (keys.has(row.id)) continue
      keys.add(row.id)
      devices.push({
        id: createHmac('sha256', secret).update(row.id).digest('hex').slice(0, 32),
        name: row.name.slice(0, 128).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim(),
        kind: KINDS.has(row.kind) ? row.kind : 'other',
        source: row.source,
        percent: percent(row.percent),
        charging: flag(row.charging),
        estimated: row.estimated === true,
        stale: row.stale === true,
        parts: normalizeParts(row.parts)
      })
    }
    return {
      status: partial && value.status === 'ready' ? 'partial' : value.status,
      system: normalizeSystem(value.system),
      devices,
      ...(receipt ? { refresh: receipt } : {})
    }
  }
}

function createLineReader(onLine) {
  let pieces = []
  let pending = 0
  return (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    let from = 0
    while (from < chunk.length) {
      const end = chunk.indexOf(10, from)
      const part = chunk.subarray(from, end < 0 ? chunk.length : end)
      pending += part.length
      if (pending > MAX_LINE_BYTES) throw new Error('battery-snapshot-too-large')
      if (part.length) pieces.push(part)
      if (end < 0) break
      const line = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, pending)
      pieces = []
      pending = 0
      if (onLine(line) === false) return
      from = end + 1
    }
  }
}

module.exports = { MAX_LINE_BYTES, createSnapshotDecoder, createLineReader, normalizeSystem }
