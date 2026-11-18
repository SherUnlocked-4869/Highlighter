const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { physicalJsonlRecords } = require('../vendor/tokentracker/jsonl-lines')
const { createCodexModelAttributionState, applyCodexModelEvent, currentCodexModel } = require('../vendor/tokentracker/codex-model-attribution')

const FILE_LIMIT = 64 * 1024 * 1024
const RECORD_LIMIT = 8 * 1024 * 1024
const ROW_LIMIT = 12000
const SQL_LIMIT = 25000
const SQL_BYTE_LIMIT = 32 * 1024 * 1024
const BATCH_MS = 7500
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'reasoning_output_tokens']
const CODEX_TOOL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call', 'image_generation_call'])

function hash(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}

function label(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit) : ''
}

function projectOf(...values) {
  const directory = values.find((value) => typeof value === 'string' && value.trim())
  if (!directory) return { project: '', projectName: '' }
  const normalized = directory.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const projectName = label(normalized.split('/').at(-1), 120)
  return projectName ? { project: hash(normalized.toLowerCase()), projectName } : { project: '', projectName: '' }
}

function isoTime(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const ms = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value)
  return Number.isFinite(ms) && ms >= 0 && ms < 253402300800000 ? new Date(ms).toISOString() : null
}

function json(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null
  try { return JSON.parse(value) } catch { return null }
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function fileSkills(tool, payload) {
  const name = tool.split('.').at(-1)
  if (!/^(exec|exec_command|shell|shell_command|local_shell_call|read|read_file|view)$/.test(name)) return []
  const args = json(payload.arguments)
  const skills = new Set()
  const skillPath = /(?:^|[/\\])([\p{L}\p{N}_.:-]+)[/\\]SKILL\.md(?=$|[\s'"\x60);])/gu
  if (/^(read|read_file|view)$/.test(name)) {
    for (const value of [args?.path, args?.file_path, args?.filePath]) {
      if (typeof value !== 'string' || /[*?]/.test(value)) continue
      const skill = Array.from(value.matchAll(skillPath)).at(-1)?.[1]
      if (value.endsWith('/SKILL.md') || value.endsWith('\\SKILL.md')) if (skill) skills.add(skill)
    }
  }
  for (const command of [args?.cmd, args?.command, payload.action?.command, payload.input]) {
    const text = Array.isArray(command) ? command.filter((part) => typeof part === 'string').join(' ') : command
    if (typeof text !== 'string' || !text.includes('SKILL.md') || text.includes('*** Begin Patch')) continue
    for (const segment of text.split(/[;\r\n|&]/)) {
      if (/[>*?]/.test(segment) || !/^\s*(?:(?:pwsh|powershell)(?:\.exe)?\s+-(?:command|c)\s+["']?)?(?:cat|type|Get-Content|gc|head|tail|sed|bat)\b/i.test(segment)) continue
      for (const match of segment.matchAll(skillPath)) skills.add(match[1])
    }
  }
  return skills
}

function createSnapshot(source, cutoff) {
  const buckets = new Map()
  const calls = new Map()
  const callIds = new Set()
  const recordIds = new Set()
  let records = 0
  const sessions = new Map()
  let partial = false
  const within = (time) => time && time >= cutoff
  const hourOf = (time) => time.slice(0, 14) + (time.slice(14, 16) < '30' ? '00' : '30') + ':00.000Z'
  function remember(context) {
    if (context.title) sessions.set(context.session, context.title)
  }
  function token(context, timestamp, tokens, identity) {
    const time = isoTime(timestamp)
    const fields = TOKEN_FIELDS.map((field) => count(tokens?.[field]))
    const total = count(tokens?.total_tokens) || fields.reduce((sum, value) => sum + value, 0)
    if (!within(time) || !total) return
    if (records >= ROW_LIMIT * 5) { partial = true; return }
    if (identity && recordIds.has(identity)) return
    if (identity) recordIds.add(identity)
    records += 1
    remember(context)
    const hour = hourOf(time)
    const key = JSON.stringify([context.session, context.project, context.model, hour])
    let row = buckets.get(key)
    if (!row) {
      if (buckets.size >= ROW_LIMIT) { partial = true; return }
      row = { ...context, hour_start: hour, first: time, last: time, conversation_count: 0, total_tokens: 0, billable_total_tokens: 0, times: [] }
      buckets.set(key, row)
    }
    row.times.push(Date.parse(time))
    if (time < row.first) row.first = time
    if (time > row.last) row.last = time
    row.conversation_count += 1
    row.total_tokens += total
    row.billable_total_tokens += total
    TOKEN_FIELDS.forEach((field, index) => { row[field] = (row[field] || 0) + fields[index] })
  }
  function call(context, timestamp, kind, raw, identity) {
    const time = isoTime(timestamp)
    const name = label(raw)
    if (!name || !within(time)) return
    const callKey = hash(context.session, kind, name, identity)
    if (callIds.has(callKey)) return
    if (callIds.size >= ROW_LIMIT * 5) { partial = true; return }
    callIds.add(callKey)
    remember(context)
    const hour = hourOf(time)
    const key = JSON.stringify([context.session, context.project, context.model, hour, kind, name])
    const row = calls.get(key)
    if (row) {
      row.calls += 1
      if (time > row.last) row.last = time
    } else if (calls.size < ROW_LIMIT) calls.set(key, { ...context, hour_start: hour, kind, name, calls: 1, last: time })
    else partial = true
  }
  function result() {
    const withTitle = (row) => ({ ...row, title: sessions.get(row.session) || row.title || '' })
    const timedBuckets = Array.from(buckets.values()).sort((left, right) => left.first.localeCompare(right.first))
    const lastTimes = new Map()
    const stats = timedBuckets.map(({ times, ...row }) => {
      const previousKey = row.session
      let previous = lastTimes.get(previousKey) || 0
      let activeSeconds = 0
      for (const time of times.sort((left, right) => left - right)) {
        const gap = (time - previous) / 1000
        if (gap > 0 && gap < 300) activeSeconds += gap
        previous = Math.max(time, previous)
      }
      lastTimes.set(previousKey, previous)
      return { ...withTitle(row), activeSeconds }
    })
    return { source, buckets: stats, calls: Array.from(calls.values(), withTitle), partial }
  }
  return { token, call, remember, result, markPartial() { partial = true } }
}

async function* logRecords(filename, stat, rollout) {
  if (/\.zstd$/i.test(filename)) {
    const plain = await rollout.readDshSessionText(filename, { maxOutputBytes: FILE_LIMIT })
    if (plain === null) throw new Error('usage log missing')
    yield* physicalJsonlRecords([Buffer.from(plain)], { invalidUtf8: 'record', maxRecordBytes: RECORD_LIMIT, maxPhysicalBytes: FILE_LIMIT })
  } else if (stat.size > 0) {
    yield* physicalJsonlRecords(fs.createReadStream(filename, { end: stat.size - 1 }), {
      invalidUtf8: 'record', maxRecordBytes: RECORD_LIMIT, maxPhysicalBytes: FILE_LIMIT
    })
  }
}

async function scanLog(filename, stat, source, cutoff, rollout, titles) {
  const result = createSnapshot(source, cutoff)
  const codex = source === 'codex'
  const context = { session: hash(source, filename), project: '', projectName: '', title: '', model: 'unknown' }
  let seenHeader = false
  let inherited = 0
  let waitingForSeed = false
  let forkCutoff = ''
  let cumulative = null
  const modelState = createCodexModelAttributionState()
  let lineNumber = 0
  for await (const record of logRecords(filename, stat, rollout)) {
    lineNumber += 1
    if (record.oversized || record.utf8Valid === false) { result.markPartial(); continue }
    if (!record.line?.trim()) continue
    const line = json(record.line)
    if (!line) { result.markPartial(); continue }
    const data = codex ? line.payload : line.data
    if (!seenHeader && (codex ? line.type === 'session_meta' : ['session', 'session/start'].includes(line.type))) {
      const id = data?.id || data?.sessionId || line.id
      if (typeof id === 'string' && id) context.session = hash(source, id)
      Object.assign(context, projectOf(data?.cwd, line.cwd, line.workingDirectory, data?.workingDirectory))
      context.title = label(titles?.get(id) || data?.title || line.title)
      inherited = count(line.seedLength ?? line.inheritedEventCount ?? line.fork?.inheritedEventCount)
      waitingForSeed = line.version >= 2 && line.isSeeded === true
      if (codex && (data?.forked_from_id || data?.source?.subagent?.thread_spawn?.parent_thread_id)) forkCutoff = isoTime(data.timestamp || line.timestamp) || ''
      seenHeader = true
    }
    if (codex) {
      applyCodexModelEvent(modelState, line)
      context.model = label(currentCodexModel(modelState), 256) || 'unknown'
      if (line.type === 'turn_context' && data?.cwd) Object.assign(context, projectOf(data.cwd))
      if (line.type === 'event_msg' && data?.type === 'thread_name_updated') {
        context.title = label(data.thread_name || data.name)
        result.remember(context)
      }
      if (data?.type === 'token_count' && data.info) {
        const next = data.info.total_token_usage
        let usage = data.info.last_token_usage || next
        if (next && cumulative && TOKEN_FIELDS.every((field) => count(next[field]) >= count(cumulative[field]))) {
          usage = Object.fromEntries([...TOKEN_FIELDS, 'total_tokens'].map((field) => [field, Math.max(0, count(next[field]) - count(cumulative[field]))]))
        }
        if (next) cumulative = next
        if (usage && (!forkCutoff || isoTime(line.timestamp) >= forkCutoff)) {
          result.token(context, line.timestamp, { ...usage, input_tokens: Math.max(0, count(usage.input_tokens) - count(usage.cached_input_tokens)) })
        }
      }
      if (line.type === 'response_item' && CODEX_TOOL_TYPES.has(data?.type) && (!forkCutoff || isoTime(line.timestamp) >= forkCutoff)) {
        const name = label(data.name || data.type)
        const identity = data.call_id || data.id || line.ordinal || lineNumber
        result.call(context, line.timestamp, 'tool', name, identity)
        for (const skill of fileSkills(name, data)) result.call(context, line.timestamp, 'skill', skill, identity)
      }
      continue
    }
    if (waitingForSeed) {
      if (line.type === 'session/end-seed' && data?.inherited === true) waitingForSeed = false
      else continue
    }
    if (data?.inherited === true || (Number.isInteger(line.seq) && line.seq < inherited)) continue
    if (line.type === 'session/title') {
      context.title = label(data?.title)
      result.remember(context)
    }
    if (line.type === 'request/header') context.model = label(rollout.normalizeDshModelName(data?.header?.config?.model), 256) || context.model
    if (line.type === 'assistant/message' || line.type === 'message/assistant') {
      const model = rollout.normalizeDshModelName(data?.message?.source?.model || data?.model)
      if (model) context.model = label(model, 256) || context.model
      const tokens = rollout.dshUsageToTotals(data?.usage || line.usage)
      result.token(context, line.time ?? line.timestamp ?? data?.time, tokens, hash(context.session, data?.message?.id || line.seq || lineNumber))
    } else if (line.type === 'tool/call') {
      const identity = data?.callId || data?.toolCallId || line.seq || lineNumber
      result.call(context, line.time, 'tool', data?.name, identity)
      if (data?.name === 'skill') result.call(context, line.time, 'skill', json(data.arguments)?.name, identity)
    } else if (line.type === 'user/message' && data?.source?.kind === 'skill-invocation') {
      result.call(context, line.time, 'skill', data.source.name, line.seq ?? lineNumber)
    }
  }
  return result.result()
}

function scanOpenCode(filename, cutoff) {
  const db = new DatabaseSync(filename, { readOnly: true })
  const snapshot = createSnapshot('opencode', cutoff)
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF')
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name))
    const selects = new Map()
    for (const table of ['session', 'session_v2']) {
      if (tables.has(table)) selects.set(table, db.prepare('SELECT * FROM ' + table + ' WHERE id=?'))
    }
    const contexts = new Map()
    function context(id, data, modern) {
      if (typeof id !== 'string' || !id) return null
      const table = modern ? selects.get('session_v2') || selects.get('session') : selects.get('session')
      const key = (modern ? '2' : '1') + id
      let meta = contexts.get(key)
      if (!meta) {
        const session = table?.get(id)
        meta = { session: hash('opencode', id), title: label(session?.title), directory: session?.directory }
        contexts.set(key, meta)
      }
      return { session: meta.session, title: meta.title, ...projectOf(meta.directory, data?.path?.cwd, data?.directory), model: label(data?.modelID || data?.modelId || data?.model?.id, 256) || 'unknown' }
    }
    function part(data, ctx, time, id) {
      if (!ctx || !data || !['skill', 'tool'].includes(data.type)) return
      const at = data.time?.ran ?? data.state?.time?.start ?? data.time?.created ?? time
      const identity = data.callID || data.callId || data.id || id
      if (data.type === 'skill') snapshot.call(ctx, at, 'skill', data.skill || data.name, identity)
      else {
        const tool = data.tool || data.name
        snapshot.call(ctx, at, 'tool', tool, identity)
        if (tool === 'skill') snapshot.call(ctx, at, 'skill', data.state?.input?.name || data.state?.input?.id, identity)
      }
    }
    function read(sql, visit) {
      let index = 0
      let bytes = 0
      const deadline = Date.now() + BATCH_MS
      for (const row of db.prepare(sql).iterate(SQL_LIMIT + 1)) {
        bytes += typeof row.data === 'string' ? Buffer.byteLength(row.data) : 0
        if (++index > SQL_LIMIT || bytes > SQL_BYTE_LIMIT || Date.now() > deadline) { snapshot.markPartial(); break }
        const data = json(row.data)
        if (data) visit(row, data)
        else snapshot.markPartial()
      }
    }
    function message(row, data, modern) {
      const ctx = context(row.session_id || data.sessionID, data, modern)
      if (!ctx) return
      const time = data.time?.created ?? row.time_created
      if (row.type === 'assistant' || (!modern && (data.role === 'assistant' || data.tokens))) {
        const tokens = data.tokens
        if (tokens) snapshot.token(ctx, data.time?.completed ?? time, {
          input_tokens: tokens.input, cached_input_tokens: tokens.cache?.read, cache_creation_input_tokens: tokens.cache?.write,
          output_tokens: tokens.output, reasoning_output_tokens: tokens.reasoning
        }, hash(ctx.session, row.id || data.id))
        if (Array.isArray(data.content)) data.content.forEach((item, index) => part(item, ctx, time, row.id + ':' + index))
      }
      if (row.type === 'skill') snapshot.call(ctx, time, 'skill', data.skill, row.id)
      if (Array.isArray(data.skills)) for (const skill of data.skills) snapshot.call(ctx, time, 'skill', skill?.id || skill?.name, row.id)
    }
    const timestamps = (table) => db.prepare('PRAGMA table_info(' + table + ')').all().some((row) => row.name === 'time_created') ? 'time_created,' : ''
    if (tables.has('session_message')) read("SELECT id,session_id,type," + timestamps('session_message') + "CASE WHEN length(data)<=8388608 THEN data END AS data FROM session_message WHERE type IN ('assistant','user','skill') ORDER BY id DESC LIMIT ?", (row, data) => message(row, data, true))
    if (tables.has('message')) read('SELECT id,session_id,' + timestamps('message') + 'CASE WHEN length(data)<=8388608 THEN data END AS data FROM message ORDER BY id DESC LIMIT ?', (row, data) => message(row, data, false))
    if (tables.has('part')) {
      const parents = tables.has('message') ? db.prepare('SELECT CASE WHEN length(data)<=8388608 THEN data END AS data FROM message WHERE id=?') : null
      read('SELECT id,session_id,message_id,' + timestamps('part') + 'CASE WHEN length(data)<=8388608 THEN data END AS data FROM part ORDER BY id DESC LIMIT ?', (row, data) => {
        if (!['skill', 'tool'].includes(data.type)) return
        const parent = json(parents?.get(row.message_id)?.data)
        part(data, context(row.session_id || data.sessionID, parent, false), parent?.time?.created ?? row.time_created, row.id)
      })
    }
    if (!tables.has('message') && !tables.has('session_message')) snapshot.markPartial()
    return snapshot.result()
  } finally {
    db.close()
  }
}

async function scanUsageDetails({ source, files, previous, cutoff, rollout, codexIndex }) {
  const candidates = []
  let partial = false
  let pending = false
  const updates = []
  const stamps = previous || {}
  let indexStamp = ''
  if (source === 'codex' && codexIndex) {
    try {
      const stat = fs.statSync(codexIndex, { throwIfNoEntry: false })
      indexStamp = stat?.isFile() ? stat.size + ':' + stat.mtimeMs : ''
    } catch { partial = true }
  }
  for (const filename of files) {
    try {
      const stat = fs.statSync(filename)
      if (!stat.isFile()) continue
      if (source !== 'opencode' && stat.mtime.toISOString() < cutoff) continue
      const key = hash(source, filename)
      const wal = source === 'opencode' ? fs.statSync(filename + '-wal', { throwIfNoEntry: false }) : null
      const stamp = [stat.ino, stat.size, stat.mtimeMs, wal?.size, wal?.mtimeMs].join(':')
      if (stamps[key]?.stamp === stamp) { partial ||= stamps[key].partial === true; continue }
      if (source !== 'opencode' && stat.size > FILE_LIMIT) {
        partial = true
        continue
      }
      candidates.push({ filename, key, stamp, stat })
    } catch { partial = true }
  }
  const titles = new Map()
  const readIndex = indexStamp && indexStamp !== previous?.titleIndex?.stamp && Number(indexStamp.split(':')[0]) <= 4 * 1024 * 1024
  if (readIndex) {
    try {
      for (const record of fs.readFileSync(codexIndex, 'utf8').split('\n')) {
        const item = json(record)
        if (typeof item?.id === 'string' && typeof item?.thread_name === 'string') titles.set(item.id, label(item.thread_name))
      }
    } catch { partial = true }
  }
  candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
  let bytes = 0
  let rows = 0
  let scanned = 0
  const deadline = Date.now() + BATCH_MS
  for (const { filename, key, stamp, stat } of candidates) {
    if (scanned >= 32 || (scanned > 0 && (bytes + stat.size > FILE_LIMIT || Date.now() > deadline)) || rows >= ROW_LIMIT) { pending = true; break }
    scanned += 1
    bytes += stat.size
    try {
      const snapshot = source === 'opencode' ? scanOpenCode(filename, cutoff) : await scanLog(filename, stat, source, cutoff, rollout, titles)
      const final = fs.statSync(filename)
      if (stat.size !== final.size || stat.mtimeMs !== final.mtimeMs) pending = true
      partial ||= snapshot.partial
      rows += snapshot.buckets.length + snapshot.calls.length
      updates.push({ key, stamp, ...snapshot })
    } catch { partial = true }
  }
  const titleIndex = readIndex && titles.size ? { stamp: indexStamp,
    rows: Array.from(titles, ([id, title]) => ({ session: hash('codex', id), title })).slice(-10000) } : null
  return { updates, pending, partial, titleIndex }
}

module.exports = { scanUsageDetails, projectOf, fileSkills }
