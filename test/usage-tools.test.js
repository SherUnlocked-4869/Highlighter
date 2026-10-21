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
  probeDsh,
  probeOpencode,
  resolveCodexRoot,
  resolveDshRoot,
  resolveHomeContext,
  resolveOpencodeDbPath
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

test('dsh probe finds the fixture-home zstd sessions', async (t) => {
  const probe = await probeDsh({ homeDir: FIXTURE_HOME, explicitHome: true, env: {} })
  assert.equal(probe.source, 'dsh')
  assert.equal(probe.label, 'DeepSeek Harness')
  assert.equal(probe.state, 'ok')
  assert.equal(probe.detected, true)
  assert.equal(probe.readable, true)
  assert.equal(probe.fileCount, 2)
  assert.equal(probe.files.every((file) => file.endsWith('.jsonl.zstd')), true)
  assert.match(probe.coverageStartAt || '', /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)

  const dir = tempDir(t)
  assert.equal((await probeDsh({ homeDir: dir, explicitHome: true, env: {} })).state, 'absent')
  fs.mkdirSync(path.join(dir, '.dsh'))
  assert.equal((await probeDsh({ homeDir: dir, explicitHome: true, env: {} })).state, 'empty')
})

test('dsh probe honors DSH_HOME only when the home was not injected', async (t) => {
  const dir = tempDir(t)
  const fromEnv = await probeDsh({ homeDir: dir, explicitHome: false, env: { DSH_HOME: path.join(FIXTURE_HOME, '.dsh') } })
  assert.equal(fromEnv.state, 'ok')
  assert.equal(fromEnv.fileCount, 2)
  assert.equal(resolveDshRoot({ homeDir: dir, explicitHome: true, env: { DSH_HOME: 'D:/elsewhere' } }), path.join(dir, '.dsh'))
})

test('opencode probe finds the fixture-home database', async (t) => {
  const probe = await probeOpencode({ homeDir: FIXTURE_HOME, explicitHome: true, env: {} })
  assert.equal(probe.source, 'opencode')
  assert.equal(probe.label, 'OpenCode')
  assert.equal(probe.state, 'ok')
  assert.equal(probe.detected, true)
  assert.equal(probe.readable, true)
  assert.equal(probe.fileCount, 1)
  assert.ok(probe.files[0].endsWith(path.join('opencode', 'opencode.db')))

  const dir = tempDir(t)
  assert.equal((await probeOpencode({ homeDir: dir, explicitHome: true, env: {} })).state, 'absent')
  const unreadable = await probeOpencode({
    homeDir: dir,
    explicitHome: true,
    env: {},
    deps: {
      statSync: () => {
        const error = new Error('denied')
        error.code = 'EACCES'
        throw error
      }
    }
  })
  assert.equal(unreadable.state, 'unreadable')
  assert.equal(unreadable.detected, true)
  assert.match(unreadable.lastError, /EACCES/)
})

test('opencode probe honors XDG_DATA_HOME only when the home was not injected', async (t) => {
  const dir = tempDir(t)
  const xdg = path.join(FIXTURE_HOME, '.local', 'share')
  const fromEnv = await probeOpencode({ homeDir: dir, explicitHome: false, env: { XDG_DATA_HOME: xdg } })
  assert.equal(fromEnv.state, 'ok')
  assert.equal(resolveOpencodeDbPath({ homeDir: dir, explicitHome: true, env: { XDG_DATA_HOME: xdg } }), path.join(dir, '.local', 'share', 'opencode', 'opencode.db'))
})

test('registry exposes the three first-release tools in scan order', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.source), ['codex', 'dsh', 'opencode'])
  assert.deepEqual(TOOLS.map((tool) => tool.priority), [1, 2, 3])
  const sources = UNSUPPORTED_TOOLS.map((tool) => tool.source)
  assert.ok(sources.includes('cursor'))
  for (const tool of UNSUPPORTED_TOOLS) assert.equal(tool.state, 'unsupported')
})
