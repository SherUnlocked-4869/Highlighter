'use strict'

// H04 §二.4 (P0): Everything `WM_COPYDATA` replies were accepted without
// checking which query they belonged to. The reply window keeps exactly one
// pending query; a late reply for a query that already timed out would be
// delivered to the *current* query, overwriting its result (the `*.exe` probe
// is the usual late sender).
//
// Rust behaviour cannot be executed from node (it needs a Windows message pump
// over a live Everything IPC window), so this file has two halves:
//   1. source-level assertions over `native/everything-search/src/main.rs`
//      (plus `cargo test --locked`, whose H04 unit tests assert the same
//      invariant at runtime, and the rebuilt tracked binary);
//   2. behavioural tests for the JS services' pending-map keying, which must
//      keep ignoring late / out-of-order `id`s.
//
// Protocol note (the review report is wrong here): EVERYTHING_IPC_LIST2 has no
// `dwId` member. The official Everything SDK header (ipc/everything_ipc.h) and
// the everything-ipc crate both define it as
//   totitems(0) numitems(4) offset(8) request_flags(12) sort_type(16), items...
// The per-query correlation value is the request's `reply_copydata_message`
// (EVERYTHING_IPC_QUERY2 dword at offset 4), which Everything echoes in the
// reply COPYDATASTRUCT.dwData — see Everything SDK's Everything_IsQueryReply,
// which compares `cds->dwData` against the reply id. Bytes 8..12 of a reply are
// the result-list `offset` (always 0 for Highlighter's requests), so comparing
// them to the query id would drop every reply.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { OcrService } = require('../main/services/ocr-service')
const { EverythingService } = require('../main/services/everything-service')

const RUST_SOURCE = path.join(__dirname, '..', 'native', 'everything-search', 'src', 'main.rs')

function rustSource() {
  return fs.readFileSync(RUST_SOURCE, 'utf8')
}

function section(source, pattern) {
  const match = source.match(pattern)
  assert.ok(match, `main.rs section not found: ${pattern}`)
  return match[0]
}

// --- Rust: reply-id plumbing ------------------------------------------------

test('H04 Rust QueryTask records the per-query reply id', () => {
  const source = rustSource()
  const task = section(source, /struct QueryTask \{[\s\S]*?\n\}/)
  assert.match(task, /query_id:\s*u32/, 'QueryTask must carry query_id: u32')
  assert.match(task, /timeout_ms:\s*u32/, 'the existing timeout field stays')
})

test('H04 Rust build_query_buffer returns the id and writes it at QUERY2 offset 4', () => {
  const source = rustSource()
  const build = section(source, /fn build_query_buffer\([\s\S]*?\n\}/)
  assert.match(build, /-> \(Vec<u8>, u32\)/, 'build_query_buffer returns (buffer, query_id)')
  assert.match(build, /let id = NEXT_QUERY_ID\.fetch_add\(1, Ordering::Relaxed\)/)
  assert.match(build, /buffer\.extend_from_slice\(&\(reply_hwnd as u32\)\.to_le_bytes\(\)\);/)
  assert.match(build, /buffer\.extend_from_slice\(&id\.to_le_bytes\(\)\);/, 'reply_copydata_message is dword 1 of the request')
  assert.match(build, /\(buffer, id\)/)
  const hwndAt = build.indexOf('&(reply_hwnd as u32).to_le_bytes()')
  const idAt = build.indexOf('&id.to_le_bytes()')
  assert.ok(hwndAt >= 0 && idAt > hwndAt, 'reply_copydata_message follows reply_hwnd (offset 4)')
})

test('H04 Rust send_copydata threads the id into the pending task and keeps timeout semantics', () => {
  const source = rustSource()
  const send = section(source, /fn send_copydata\(&self, target: isize, buffer: Vec<u8>, query_id: u32, timeout_ms: u32\)[\s\S]*?\n    \}/)
  assert.match(send, /QueryTask \{[\s\S]*?query_id,/, 'QueryTask is created with the reply id')
  assert.match(send, /recv_timeout\(Duration::from_millis\(u64::from\(timeout_ms\) \+ 4000\)\)/, 'no retry loop was added')
  assert.match(send, /Err\("timeout"\.to_string\(\)\)/, 'the timeout error is unchanged')
  assert.match(
    send,
    /self\.state\.pending\.lock\(\)\.unwrap\(\)\.take\(\);/,
    'the timeout path still cancels the pending task so a late reply cannot be misdelivered'
  )
})

test('H04 Rust reply_wndproc matches the reply COPYDATASTRUCT.dwData against pending.query_id and drops mismatches', () => {
  const source = rustSource()
  const wndproc = section(source, /unsafe extern "system" fn reply_wndproc[\s\S]*?\n\}/)

  // The correlation value is the reply's dwData (echo of the request's
  // reply_copydata_message), not a field inside the LIST2 payload.
  assert.match(wndproc, /let reply_id = copydata\.dwData as u32;/)
  assert.match(wndproc, /state\.take_reply\(reply_id\)/)
  assert.match(wndproc, /None => return LRESULT\(0\)/, 'a non-matching reply is dropped')
  assert.doesNotMatch(wndproc, /\[8\.\.12\]/, 'the LIST2 offset dword must not be used as an id')

  const takeReply = section(source, /fn take_reply\(&self, reply_id: u32\) -> Option<QueryTask> \{[\s\S]*?\n    \}/)
  assert.match(
    takeReply,
    /matches!\(guard\.as_ref\(\), Some\(pending\) if pending\.query_id == reply_id\)/,
    'the id comparison lives in take_reply'
  )
  assert.match(takeReply, /guard\.take\(\)/, 'only a matching reply is taken off the pending slot')
  assert.match(
    source,
    /that structure has no dwId member/,
    'the source documents the corrected protocol layout (the report claimed LIST2.dwId at 8..12)'
  )
})

test('H04 Rust h04 unit tests exist for the reply-id predicate', () => {
  const source = rustSource()
  assert.match(source, /fn h04_query_buffer_carries_reply_id_at_offset_four\(\)/)
  assert.match(source, /fn h04_take_reply_drops_late_reply_with_mismatched_id\(\)/)
  assert.match(source, /fn h04_take_reply_ignores_reply_without_pending_query\(\)/)
})

// --- JS side: pending-map keying must keep ignoring late/out-of-order ids ----

function createOcrTransport() {
  const service = new OcrService({
    sidecarPath: 'sidecar.exe',
    modelDir: 'models',
    tempDir: path.join(require('node:os').tmpdir(), 'highlighter-h04-dwid-ocr')
  })
  service.ready = true
  service.process = {
    killed: false,
    stdin: { write: (_line, callback) => { if (typeof callback === 'function') callback() } }
  }
  return service
}

function createEverythingTransport() {
  const service = new EverythingService({
    sidecarPath: 'sidecar.exe',
    idleTimeoutMs: 0,
    log: () => {}
  })
  service.ready = true
  service.process = {
    killed: false,
    stdin: { write: (_line, callback) => { if (typeof callback === 'function') callback() } }
  }
  return service
}

function replyLines(messages) {
  return Buffer.from(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
}

test('H04 ocr-service ignores a late reply for a timed-out request but resolves the current one', async () => {
  const service = createOcrTransport()
  const writes = []
  service.process.stdin.write = (line, callback) => {
    writes.push(JSON.parse(line))
    if (typeof callback === 'function') callback()
  }

  const stale = service.request({ action: 'recognize' }, 5)
  await assert.rejects(stale, /识别超时/)
  const staleId = writes[0].id
  assert.equal(service.pending.size, 0, 'the timed-out request left the pending map')

  const current = service.request({ action: 'recognize' }, 1000)
  const currentId = writes[1].id
  assert.notEqual(staleId, currentId)

  // The old query's reply arrives after the timeout, while the new one is
  // in flight: it must be ignored instead of resolving the new request.
  service.handleStdout(replyLines([{ id: staleId, ok: true, result: { text: '迟到' } }]), () => {})
  assert.equal(service.pending.has(currentId), true, 'the late reply must not consume the current pending request')

  service.handleStdout(replyLines([{ id: currentId, ok: true, result: { text: '当前' } }]), () => {})
  assert.deepEqual(await current, { text: '当前' })
  assert.equal(service.pending.size, 0)
})

test('H04 everything-service ignores a late reply for a timed-out request but resolves the current one', async () => {
  const service = createEverythingTransport()
  const writes = []
  service.process.stdin.write = (line, callback) => {
    writes.push(JSON.parse(line))
    if (typeof callback === 'function') callback()
  }

  const stale = service.request({ action: 'query' }, 5)
  await assert.rejects(stale, (error) => error.code === 'timeout' && /请求超时/.test(error.message))
  const staleId = writes[0].id
  assert.equal(service.pending.size, 0)

  const current = service.request({ action: 'query' }, 1000)
  const currentId = writes[1].id

  service.handleStdout(replyLines([{ id: staleId, ok: true, result: { total: 1, items: [{ name: '迟到' }] } }]), () => {})
  assert.equal(service.pending.has(currentId), true, 'the late reply must not consume the current pending request')

  service.handleStdout(replyLines([{ id: currentId, ok: true, result: { total: 2, items: [{ name: '当前' }] } }]), () => {})
  const result = await current
  assert.equal(result.total, 2)
  assert.equal(result.items[0].name, '当前')
  assert.equal(service.pending.size, 0)
})

test('H04 both services resolve out-of-order replies by their own ids', async () => {
  const ocr = createOcrTransport()
  const ocrWrites = []
  ocr.process.stdin.write = (line, callback) => {
    ocrWrites.push(JSON.parse(line))
    if (typeof callback === 'function') callback()
  }
  const ocrFirst = ocr.request({ action: 'recognize' }, 1000)
  const ocrSecond = ocr.request({ action: 'recognize' }, 1000)
  ocr.handleStdout(replyLines([
    { id: ocrWrites[1].id, ok: true, result: { text: '后发' } },
    { id: ocrWrites[0].id, ok: true, result: { text: '先发' } }
  ]), () => {})
  assert.deepEqual(await ocrFirst, { text: '先发' })
  assert.deepEqual(await ocrSecond, { text: '后发' })
  assert.equal(ocr.pending.size, 0)

  const everything = createEverythingTransport()
  const writes = []
  everything.process.stdin.write = (line, callback) => {
    writes.push(JSON.parse(line))
    if (typeof callback === 'function') callback()
  }
  const first = everything.request({ action: 'query' }, 1000)
  const second = everything.request({ action: 'query' }, 1000)
  everything.handleStdout(replyLines([
    { id: writes[1].id, ok: true, result: { total: 2, items: [{ name: 'second' }] } },
    { id: writes[0].id, ok: true, result: { total: 1, items: [{ name: 'first' }] } }
  ]), () => {})
  assert.equal((await first).items[0].name, 'first')
  assert.equal((await second).items[0].name, 'second')
  assert.equal(everything.pending.size, 0)
})
