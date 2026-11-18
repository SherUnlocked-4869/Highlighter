const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { zstdCompressSync } = require('node:zlib')
const { DatabaseSync } = require('node:sqlite')
const { scanUsageDetails } = require('../main/services/usage-detail-scan')
const { openUsageStore } = require('../main/services/usage-store')
const { createUsageQuery } = require('../main/services/usage-query')
const { assertUsagePrices, normalizeUsagePrices } = require('../main/services/usage-pricing')
const rollout = require('../main/vendor/tokentracker/rollout')

const TIME = '2026-11-16T15:59:00.000Z'
const NEXT = '2026-11-16T16:01:00.000Z'
const AS_OF = new Date('2026-11-18T00:00:00.000Z')
const RANGE = { period: 'custom', from: '2026-11-16', to: '2026-11-17', tz: 'Asia/Hong_Kong' }
const COUNT = { input_tokens: 1000000, cached_input_tokens: 250000, output_tokens: 50000, total_tokens: 1050000 }

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-detail-'))
  const dbPath = path.join(root, 'usage.db')
  const store = openUsageStore({ dbPath, now: () => AS_OF })
  let prices = []
  const query = createUsageQuery({ getStore: () => store, now: () => AS_OF, getPrices: () => prices })
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }) })
  async function scan(source, files, index) {
    const details = await scanUsageDetails({
      source, files, previous: store.getDetailStamps(source), cutoff: '2024-11-01T00:00:00.000Z', rollout, codexIndex: index
    })
    store.commitScan({ source, details })
    return details
  }
  return { root, dbPath, store, query, scan, setPrices(next) { prices = next } }
}

function writeLog(filename, rows, compressed = false) {
  const text = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(filename, compressed ? zstdCompressSync(text) : text)
}

test('Codex projects, session metadata, calls and prices survive incremental rescans', async (t) => {
  const { root, dbPath, store, query, scan, setPrices } = harness(t)
  const log = path.join(root, 'rollout.jsonl')
  const index = path.join(root, 'session_index.jsonl')
  writeLog(index, [{ id: 'raw-session-id', thread_name: 'Fix local usage' }])
  const event = (timestamp, totals) => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totals, last_token_usage: COUNT } } })
  const tool = { timestamp: TIME, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: JSON.stringify({ cmd: 'Get-Content "C:\\private\\skills\\review\\SKILL.md"' }) } }
  const rows = [
    { type: 'session_meta', payload: { id: 'raw-session-id', cwd: 'F:\\PRIVATE_FULL_PROJECT\\Highlighter' } },
    { type: 'turn_context', payload: { model: 'test-model' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'PRIVATE_LARGE_PROMPT_MARKER' } },
    event(TIME, COUNT), event(TIME, COUNT), tool, tool,
    { ...tool, payload: { ...tool.payload, call_id: 'b', arguments: '{"cmd":"echo /skills/no-skill/SKILL.md"}' } }
  ]
  writeLog(log, rows)
  store.commitScan({ source: 'codex', upserts: [{
    ...COUNT, source: 'codex', model: 'test-model', hour_start: '2026-11-16T15:30:00.000Z',
    input_tokens: COUNT.input_tokens - COUNT.cached_input_tokens, billable_total_tokens: COUNT.total_tokens, conversation_count: 1
  }, {
    source: 'codex', model: 'unpriced-model', hour_start: '2026-11-16T15:30:00.000Z', input_tokens: 11,
    output_tokens: 2, total_tokens: 13, billable_total_tokens: 13, conversation_count: 1
  }] })
  assert.equal((await scan('codex', [log], index)).updates.length, 1)
  assert.equal((await scan('codex', [log], index)).updates.length, 0)
  const base = query.summary(RANGE)
  assert.equal(base.totals.total_tokens, 1050013, 'grand totals still come from the legacy ledger')
  assert.equal(base.details.sessionCount, 1)
  assert.equal(base.details.projects[0].name, 'Highlighter')
  assert.equal(base.details.sessionRanks[0].title, 'Fix local usage')
  assert.equal(base.details.tools.calls, 2)
  assert.deepEqual(base.details.skills.top.map(({ name, calls }) => [name, calls]), [['review', 1]])
  const project = base.details.projects[0].id
  const filter = { ...RANGE, project, model: 'test-model' }
  assert.equal(query.summary(filter).totals.input_tokens, 750000)
  assert.equal(query.daily(filter).rows[0].sessions, 1)
  assert.equal(query.heatmap({ project, tz: RANGE.tz, weeks: 1 }).weeks[0][0].total_tokens, 1050000)
  assert.equal(query.hourly({ project, day: RANGE.from, tz: RANGE.tz }).rows[23].total_tokens, 1050000)
  setPrices([{ model: 'test-model', input: 2, cached: .4, output: 8 }])
  assert.equal(query.summary(RANGE).totals.costCny, 2)
  assert.equal(query.summary(RANGE).totals.unpricedModels, 1)
  assert.equal(query.daily(filter).rows[0].costCny, 2)
  assert.equal(query.breakdown(filter).models[0].costCny, 2)
  assert.equal(query.summary(filter).details.sessionRanks[0].costCny, 2)
  setPrices([{ model: 'test-model', input: 0, cached: 0, output: 0 }])
  assert.equal(query.summary(filter).totals.costCny, 0)

  const doubled = Object.fromEntries(Object.entries(COUNT).map(([key, value]) => [key, value * 2]))
  writeLog(log, [...rows, event(NEXT, doubled)])
  assert.equal((await scan('codex', [log], index)).updates.length, 1)
  assert.equal(query.summary(filter).details.sessionRanks[0].total_tokens, 2100000)
  assert.equal(query.summary(filter).details.activeSeconds, 120)
  assert.equal(query.daily(filter).rows[1].sessions, 1)
  writeLog(index, [{ id: 'raw-session-id', thread_name: 'Renamed session in index' }])
  assert.equal((await scan('codex', [log], index)).updates.length, 0)
  assert.equal(query.summary(filter).details.sessionRanks[0].title, 'Renamed session in index')
  store.checkpoint()
  const db = fs.readFileSync(dbPath)
  for (const marker of ['PRIVATE_FULL_PROJECT', 'PRIVATE_LARGE_PROMPT_MARKER', 'raw-session-id', 'Get-Content']) assert.equal(db.includes(marker), false, marker)
  store.clear()
  assert.equal(query.summary(RANGE).details, null)
})

test('DSH compressed logs omit inherited calls and OpenCode merges both DB layouts', async (t) => {
  const { root, store, query, scan } = harness(t)
  const log = path.join(root, 'session.v2.jsonl.zstd')
  const sessionRows = [
    { type: 'session', id: 'dsh-id', cwd: 'F:/Workspace/DeepSeek', version: 2, isSeeded: true },
    { type: 'tool/call', seq: 1, time: TIME, data: { name: 'not-counted' } },
    { type: 'session/end-seed', seq: 2, time: TIME, data: { inherited: true } },
    { type: 'user/message', seq: 3, time: TIME, data: { source: { kind: 'skill-invocation', name: 'explicit-skill' } } },
    { type: 'tool/call', seq: 4, time: TIME, data: { name: 'skill', callId: 'dsh-tool', arguments: { name: 'named-skill' } } },
    { type: 'session/title', seq: 5, time: TIME, data: { title: 'DSH session' } },
    { type: 'assistant/message', seq: 6, time: TIME, data: { message: { id: 'first', source: { model: 'vendor/dsh-model' } }, usage: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, outputTokens: 10 } } }
  ]
  writeLog(log, sessionRows, true)
  await scan('dsh', [log])
  const renamed = path.join(root, 'session.v2.jsonl')
  writeLog(renamed, sessionRows)
  await scan('dsh', [renamed])
  const dsh = query.summary({ ...RANGE, model: 'dsh-model' }).details
  assert.equal(dsh.sessionCount, 1)
  assert.equal(dsh.sessionRanks[0].title, 'DSH session')
  assert.equal(dsh.sessionRanks[0].total_tokens, 185)
  assert.equal(dsh.tools.calls, 1)
  assert.equal(dsh.skills.calls, 2)

  const filename = path.join(root, 'opencode.db')
  const db = new DatabaseSync(filename)
  db.exec('CREATE TABLE session_v2(id TEXT PRIMARY KEY,title TEXT,directory TEXT);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT);CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT)')
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('session', 'OpenCode', 'F:/Workspace/OpenCode')
  const message = {
    role: 'assistant', modelID: 'opencode-model', path: { cwd: 'F:/Workspace/OpenCode' }, time: { created: TIME },
    tokens: { input: 30, output: 10, cache: { read: 5 } },
    content: [{ type: 'tool', tool: 'read', callID: 'identical-tool' }]
  }
  db.prepare('INSERT INTO message VALUES (?,?,?)').run('message', 'session', JSON.stringify(message))
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?)').run('message', 'session', 'assistant', JSON.stringify(message))
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('part', 'session', 'message', JSON.stringify({ type: 'tool', tool: 'read', callID: 'identical-tool' }))
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?)').run('skill', 'session', 'skill', JSON.stringify({ skill: 'open-skill', time: { created: TIME } }))
  db.close()
  await scan('opencode', [filename])
  const open = query.summary({ ...RANGE, sources: ['opencode'] }).details
  assert.equal(open.sessionCount, 1)
  assert.equal(open.projects[0].name, 'OpenCode')
  assert.equal(open.sessionRanks[0].total_tokens, 45)
  assert.equal(open.tools.calls, 1)
  assert.equal(open.skills.calls, 1)
  assert.equal(store.getDetailStamps('opencode') && (await scan('opencode', [filename])).updates.length, 0)
})

test('model price validation rejects partial, duplicate and invalid rows and preserves zero', () => {
  const valid = { model: 'local-model', input: 0, cached: 0, output: 0 }
  assert.doesNotThrow(() => assertUsagePrices([valid]))
  assert.deepEqual(normalizeUsagePrices([valid, { model: 'another' }]), [valid])
  for (const invalid of [{ model: 'a' }, { ...valid, input: Infinity }, { ...valid, cached: -1 }, { ...valid, output: '0' }, { ...valid, key: 1 }]) {
    assert.throws(() => assertUsagePrices([invalid]), /Model prices require/)
  }
  assert.throws(() => assertUsagePrices([valid, valid]), /Duplicate/)
})

test('backfill resumes after a bounded batch without rescanning completed files', async (t) => {
  const { root, query, scan } = harness(t)
  const files = Array.from({ length: 34 }, (_, index) => {
    const filename = path.join(root, 'rollout-' + index + '.jsonl')
    writeLog(filename, [
      { type: 'session_meta', payload: { id: 'session-' + index, cwd: 'F:/Shared/Project' } },
      { type: 'turn_context', payload: { model: 'fixture' } },
      { type: 'event_msg', timestamp: TIME, payload: { type: 'token_count', info: { total_token_usage: COUNT } } }
    ])
    return filename
  })
  assert.equal((await scan('codex', files)).pending, true)
  assert.equal(query.summary(RANGE).details.sessionCount, 32)
  assert.equal(query.summary(RANGE).details.status, 'pending')
  assert.equal((await scan('codex', files)).updates.length, 2)
  assert.equal(query.summary(RANGE).details.sessionCount, 34)
  assert.equal(query.summary(RANGE).details.status, 'ready')
  assert.equal((await scan('codex', files)).updates.length, 0)
})
