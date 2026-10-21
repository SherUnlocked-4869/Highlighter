const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  TOOLS,
  UNSUPPORTED_TOOLS,
  coverageStartFromFiles,
  probeCodex,
  resolveCodexRoot,
  resolveHomeContext
} = require('../main/services/usage-tools')

const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'usage', 'home')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-tools-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('codex probe finds the fixture-home rollout files', async () => {
  const probe = await probeCodex({ homeDir: FIXTURE_HOME, explicitHome: true, env: {} })
  assert.equal(probe.source, 'codex')
  assert.equal(probe.label, 'Codex')
  assert.equal(probe.state, 'ok')
  assert.equal(probe.detected, true)
  assert.equal(probe.readable, true)
  assert.equal(probe.fileCount, 3)
  assert.equal(probe.files.length, 3)
  for (const file of probe.files) assert.ok(path.isAbsolute(file), file)
  assert.equal(probe.coverageStartAt, '2026-03-14T00:00:00.000Z')
  assert.ok(probe.sessionsDir.endsWith(path.join('.codex', 'sessions')))
})

test('codex probe reports absent / empty / unreadable installs', async (t) => {
  const dir = tempDir(t)
  const absent = await probeCodex({ homeDir: dir, explicitHome: true, env: {} })
  assert.equal(absent.state, 'absent')
  assert.equal(absent.detected, false)
  assert.deepEqual(absent.files, [])

  fs.mkdirSync(path.join(dir, '.codex'))
  const empty = await probeCodex({ homeDir: dir, explicitHome: true, env: {} })
  assert.equal(empty.state, 'empty')
  assert.equal(empty.detected, true)
  assert.equal(empty.readable, true)

  const unreadable = await probeCodex({
    homeDir: dir,
    explicitHome: true,
    env: {},
    deps: {
      statSync: () => ({ isDirectory: () => true }),
      opendirSync: () => {
        const error = new Error('denied')
        error.code = 'EACCES'
        throw error
      }
    }
  })
  assert.equal(unreadable.state, 'unreadable')
  assert.equal(unreadable.detected, true)
  assert.equal(unreadable.readable, false)
  assert.match(unreadable.lastError, /EACCES/)
})

test('codex probe honors CODEX_HOME only when the home was not injected', async (t) => {
  const dir = tempDir(t)
  const env = { CODEX_HOME: path.join(FIXTURE_HOME, '.codex') }
  const fromEnv = await probeCodex({ homeDir: dir, explicitHome: false, env })
  assert.equal(fromEnv.state, 'ok')
  assert.equal(fromEnv.fileCount, 3)

  const injected = await probeCodex({ homeDir: FIXTURE_HOME, explicitHome: true, env })
  assert.equal(injected.state, 'ok')
  assert.ok(injected.sessionsDir.startsWith(FIXTURE_HOME))
  assert.equal(resolveCodexRoot({ homeDir: dir, explicitHome: true, env }), path.join(dir, '.codex'))
})

test('home context precedence: injected home > HIGHLIGHTER_USAGE_HOME > default home', () => {
  const injected = resolveHomeContext({ homeDir: 'D:/fixtures', env: { HIGHLIGHTER_USAGE_HOME: 'D:/env' }, defaultHome: 'D:/real' })
  assert.equal(injected.explicitHome, true)
  assert.equal(path.basename(injected.homeDir), 'fixtures')

  const envHome = resolveHomeContext({ homeDir: null, env: { HIGHLIGHTER_USAGE_HOME: path.join(os.tmpdir(), 'env-home') }, defaultHome: 'D:/real' })
  assert.equal(envHome.explicitHome, true)
  assert.ok(envHome.homeDir.endsWith('env-home'))

  const fallback = resolveHomeContext({ homeDir: null, env: {}, defaultHome: 'D:/real' })
  assert.equal(fallback.explicitHome, false)
  assert.equal(path.basename(fallback.homeDir), 'real')

  assert.deepEqual(resolveHomeContext({ homeDir: null, env: {}, defaultHome: null }), { homeDir: null, explicitHome: false })
})

test('coverage start is derived from rollout file names', () => {
  assert.equal(
    coverageStartFromFiles([
      'C:/x/rollout-2026-03-15T23-50-00-uuid.jsonl',
      'C:/x/rollout-2026-03-14T01-15-00-uuid.jsonl',
      'C:/x/not-a-rollout.jsonl'
    ]),
    '2026-03-14T00:00:00.000Z'
  )
  assert.equal(coverageStartFromFiles([]), null)
  assert.equal(coverageStartFromFiles(null), null)
})

test('registry exposes Codex as the B1 tool and lists unsupported account tools', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.source), ['codex'])
  assert.equal(TOOLS[0].priority, 1)
  const sources = UNSUPPORTED_TOOLS.map((tool) => tool.source)
  assert.ok(sources.includes('cursor'))
  for (const tool of UNSUPPORTED_TOOLS) assert.equal(tool.state, 'unsupported')
})
