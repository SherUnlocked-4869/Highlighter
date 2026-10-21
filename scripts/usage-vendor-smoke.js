#!/usr/bin/env node
'use strict'

// Development-only smoke check for the vendored TokenTracker parser closure
// (plan batch B0-2). It proves the vendor layer loads under plain Node, exposes
// the parser entry points the usage scan worker will call, survives empty
// synthetic incremental calls, and - when the shared usage fixture home exists -
// proves the injected bucket sink emits byte-identical rows to the upstream
// JSONL append for the three first-release tools (Codex / DSH / OpenCode).
// It never spawns a process and never opens a network connection; it is
// intentionally not part of `npm test`.
//
//   node scripts/usage-vendor-smoke.js

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const VENDOR_DIR = path.join(__dirname, '..', 'main', 'vendor', 'tokentracker')
const ROLLOUT_PATH = path.join(VENDOR_DIR, 'rollout.js')

const REQUIRED_FUNCTIONS = [
  'parseRolloutIncremental',
  'parseDshIncremental',
  'parseOpencodeDbIncremental',
  'readOpencodeDbMessagesIncremental',
  'setBucketSink',
  'bucketKey',
  'groupBucketKey',
  'totalsKey',
  'normalizeHourlyState',
  'toUtcHalfHourStart',
]

// V1/V2 residue that must never come back into the vendor directory.
const FORBIDDEN_CONTENT = [
  { pattern: /trae/i, label: 'Trae' },
  { pattern: /cursor-config|parseCursorApi|fetchCursorUsage/i, label: 'Cursor account API' },
  { pattern: /@mongodb-js\/zstd/, label: 'external zstd dependency' },
  { pattern: /child_process|spawn\(|execFileSync\(|execSync\(/, label: 'child process' },
]

let passed = 0
let failed = 0

function pass(message) {
  passed += 1
  console.log(`PASS ${message}`)
}

function fail(message) {
  failed += 1
  console.error(`FAIL ${message}`)
}

function assert(condition, message) {
  if (condition) pass(message)
  else fail(message)
}

function isNumericCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isIncrementalResult(result, keys) {
  if (!result || typeof result !== 'object') return false
  return keys.every((key) => isNumericCount(result[key]))
}

// Runs one parser twice - upstream JSONL mode and injected-sink mode - and
// proves both report the same counts and that the sink rows serialize to exactly
// the same JSONL bytes the upstream append writes (V3 acceptance).
async function runParserBothModes(rollout, tmpRoot, label, invoke) {
  const jsonlQueue = path.join(tmpRoot, `${label}-jsonl`, 'queue.jsonl')
  const sinkQueue = path.join(tmpRoot, `${label}-sink`, 'queue.jsonl')
  const jsonlResult = await invoke(jsonlQueue)
  const captured = []
  rollout.setBucketSink(async (rows) => {
    captured.push(...rows)
  })
  let sinkResult
  try {
    sinkResult = await invoke(sinkQueue)
  } finally {
    rollout.setBucketSink(null)
  }
  const jsonlText = fs.existsSync(jsonlQueue) ? fs.readFileSync(jsonlQueue, 'utf8') : ''
  const sinkText = captured.length ? captured.map((row) => JSON.stringify(row)).join('\n') + '\n' : ''
  assert(
    isIncrementalResult(jsonlResult, ['eventsAggregated', 'bucketsQueued']) &&
      isIncrementalResult(sinkResult, ['eventsAggregated', 'bucketsQueued']),
    `${label}: JSONL and sink runs both return incremental counts`,
  )
  assert(
    jsonlResult.eventsAggregated === sinkResult.eventsAggregated &&
      jsonlResult.bucketsQueued === sinkResult.bucketsQueued,
    `${label}: sink mode reports the same counts as JSONL mode`,
  )
  assert(jsonlResult.bucketsQueued > 0, `${label}: fixture scan queued buckets (${jsonlResult.bucketsQueued})`)
  assert(jsonlText === sinkText, `${label}: sink rows are byte-identical to the upstream JSONL append`)
  assert(!fs.existsSync(sinkQueue), `${label}: sink mode wrote no queue file`)
}

// Optional fixture-based check. The fixture home belongs to the oracle task
// (B0-4); when it is absent this section is skipped instead of failing.
async function runFixtureCheck(rollout, tmpRoot) {
  const fixtureHome = path.join(__dirname, '..', 'test', 'fixtures', 'usage', 'home')
  const codexSessions = path.join(fixtureHome, '.codex', 'sessions')
  if (!fs.existsSync(codexSessions)) {
    console.log(`SKIP usage fixture home not present: ${path.relative(process.cwd(), fixtureHome)}`)
    return
  }

  const codexFiles = await rollout.listRolloutFiles(codexSessions)
  assert(Array.isArray(codexFiles) && codexFiles.length > 0, `codex fixture files discovered (${codexFiles.length})`)
  await runParserBothModes(rollout, tmpRoot, 'codex', (queuePath) =>
    rollout.parseRolloutIncremental({ rolloutFiles: codexFiles, cursors: {}, queuePath }),
  )

  const dshHome = path.join(fixtureHome, '.dsh')
  const dshFiles = await rollout.resolveDshSessionFiles(
    { ...process.env, DSH_HOME: dshHome },
    { nativeHome: dshHome },
  )
  assert(Array.isArray(dshFiles) && dshFiles.length > 0, `dsh fixture files discovered (${dshFiles.length})`)
  await runParserBothModes(rollout, tmpRoot, 'dsh', (queuePath) =>
    rollout.parseDshIncremental({ sessionFiles: dshFiles, cursors: {}, queuePath }),
  )

  const opencodeDb = path.join(fixtureHome, '.local', 'share', 'opencode', 'opencode.db')
  if (!fs.existsSync(opencodeDb)) {
    console.log('SKIP opencode fixture database not present')
    return
  }
  const opencodeRead = rollout.readOpencodeDbMessagesIncremental(opencodeDb)
  assert(
    Array.isArray(opencodeRead.messages) && opencodeRead.messages.length > 0,
    `opencode fixture messages read (${opencodeRead.messages.length})`,
  )
  await runParserBothModes(rollout, tmpRoot, 'opencode', (queuePath) =>
    rollout.parseOpencodeDbIncremental({
      dbMessages: opencodeRead.messages,
      dbPath: opencodeDb,
      dbCursor: opencodeRead.cursor,
      cursors: {},
      queuePath,
      source: 'opencode',
      cursorKey: 'opencode',
    }),
  )
}

async function run() {
  assert(fs.existsSync(VENDOR_DIR), `vendor directory exists: ${path.relative(process.cwd(), VENDOR_DIR)}`)
  assert(fs.existsSync(ROLLOUT_PATH), 'vendored rollout.js exists')

  const rollout = require(ROLLOUT_PATH)
  for (const name of REQUIRED_FUNCTIONS) {
    assert(typeof rollout[name] === 'function', `rollout.${name} is a function`)
  }

  // The vendor copy must stay free of the dropped tools and of child-process
  // code paths (V1/V2/V5). Read the sources instead of probing behaviour.
  for (const name of fs.readdirSync(VENDOR_DIR).filter((entry) => entry.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(VENDOR_DIR, name), 'utf8')
    for (const rule of FORBIDDEN_CONTENT) {
      assert(!rule.pattern.test(source), `${name} has no ${rule.label} residue`)
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-smoke-'))
  const queuePath = path.join(tmpRoot, 'runtime', 'queue.jsonl')
  try {
    const sinkBatches = []
    rollout.setBucketSink(async (rows, meta) => {
      sinkBatches.push({ rows, meta })
    })

    const codex = await rollout.parseRolloutIncremental({
      rolloutFiles: [],
      cursors: {},
      queuePath,
    })
    assert(
      isIncrementalResult(codex, ['filesProcessed', 'eventsAggregated', 'bucketsQueued']),
      `parseRolloutIncremental({ rolloutFiles: [] }) returned counts ${JSON.stringify(codex)}`,
    )
    assert(codex.eventsAggregated === 0 && codex.bucketsQueued === 0, 'empty Codex scan emits no events/buckets')

    const dsh = await rollout.parseDshIncremental({
      sessionFiles: [],
      cursors: {},
      queuePath,
    })
    assert(
      isIncrementalResult(dsh, ['recordsProcessed', 'eventsAggregated', 'bucketsQueued']),
      `parseDshIncremental({ sessionFiles: [] }) returned counts ${JSON.stringify(dsh)}`,
    )
    assert(dsh.eventsAggregated === 0 && dsh.bucketsQueued === 0, 'empty DSH scan emits no events/buckets')

    assert(sinkBatches.length === 0, 'empty scans call the bucket sink zero times')
    assert(!fs.existsSync(queuePath), 'sink mode does not create the queue JSONL placeholder')

    rollout.setBucketSink(null)
    const noSink = await rollout.parseRolloutIncremental({
      rolloutFiles: [],
      cursors: {},
      queuePath: path.join(tmpRoot, 'runtime-jsonl', 'queue.jsonl'),
    })
    assert(
      isIncrementalResult(noSink, ['filesProcessed', 'eventsAggregated', 'bucketsQueued']),
      'parser still runs with no bucket sink installed (upstream JSONL mode)',
    )

    await runFixtureCheck(rollout, tmpRoot)
  } finally {
    rollout.setBucketSink(null)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error('FAIL uncaught error:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
