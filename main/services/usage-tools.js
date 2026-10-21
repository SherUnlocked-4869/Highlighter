// Usage tool registry and discovery adapters (B1: Codex only; B2 adds DSH and
// OpenCode through the same table).
//
// Adapter contract (plan §2.4):
//   probe({ homeDir, explicitHome, env, deps }) -> {
//     source, label, state: 'ok'|'empty'|'unreadable'|'absent'|'error',
//     detected, readable, files: string[], fileCount,
//     root, sessionsDir, coverageStartAt, lastError
//   }
//
// Discovery uses explicit paths: the injected home (test/e2e via
// HIGHLIGHTER_USAGE_HOME) always wins; CODEX_HOME is honored only when the home
// was not injected. Nothing here writes to a user directory and no child
// process is spawned (the WSL stub makes the vendored probe native-only).

const path = require('node:path')
const fssync = require('node:fs')

const { scanRootDirState } = require('../vendor/tokentracker/scan-roots')

const CODEX_SOURCE = 'codex'
const CODEX_LABEL = 'Codex'
const DSH_SOURCE = 'dsh'
const DSH_LABEL = 'DeepSeek Harness'
const OPENCODE_SOURCE = 'opencode'
const OPENCODE_LABEL = 'OpenCode'
const ROLLOUT_DATE_PATTERN = /^rollout-(\d{4}-\d{2}-\d{2})T/

let rolloutModule = null

function getRolloutModule() {
  if (!rolloutModule) {
    rolloutModule = require('../vendor/tokentracker/rollout')
  }
  return rolloutModule
}

// Resolve the scanned user home. `homeDir` is the injected value (tests/e2e),
// `HIGHLIGHTER_USAGE_HOME` is the environment override used by e2e runs, and
// `defaultHome` is the app's real home passed by the composition root.
function resolveHomeContext({ homeDir = null, env = process.env, defaultHome = null } = {}) {
  if (typeof homeDir === 'string' && homeDir.trim()) {
    return { homeDir: path.resolve(homeDir.trim()), explicitHome: true }
  }
  const override = typeof env.HIGHLIGHTER_USAGE_HOME === 'string' ? env.HIGHLIGHTER_USAGE_HOME.trim() : ''
  if (override) return { homeDir: path.resolve(override), explicitHome: true }
  if (typeof defaultHome === 'string' && defaultHome.trim()) {
    return { homeDir: path.resolve(defaultHome.trim()), explicitHome: false }
  }
  return { homeDir: null, explicitHome: false }
}

function resolveCodexRoot({ homeDir, explicitHome, env = process.env } = {}) {
  if (!homeDir) return null
  if (!explicitHome) {
    const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
    if (codexHome) return path.resolve(codexHome)
  }
  return path.join(homeDir, '.codex')
}

function coverageStartFromFiles(files) {
  let earliest = null
  for (const file of Array.isArray(files) ? files : []) {
    const match = ROLLOUT_DATE_PATTERN.exec(path.basename(String(file || '')))
    if (!match) continue
    if (!earliest || match[1] < earliest) earliest = match[1]
  }
  return earliest ? `${earliest}T00:00:00.000Z` : null
}

function baseProbe(source, label, overrides = {}) {
  return {
    source,
    label,
    state: 'absent',
    detected: false,
    readable: false,
    files: [],
    fileCount: 0,
    root: null,
    sessionsDir: null,
    coverageStartAt: null,
    lastError: null,
    ...overrides
  }
}

async function probeCodex({ homeDir, explicitHome = false, env = process.env, deps = {} } = {}) {
  const root = resolveCodexRoot({ homeDir, explicitHome, env })
  if (!root) {
    return baseProbe(CODEX_SOURCE, CODEX_LABEL, { state: 'absent', lastError: 'no home directory' })
  }
  const sessionsDir = path.join(root, 'sessions')
  const rootState = scanRootDirState(root, deps)
  if (!rootState.exists && !rootState.error) {
    return baseProbe(CODEX_SOURCE, CODEX_LABEL, { root, sessionsDir })
  }
  if (rootState.error) {
    return baseProbe(CODEX_SOURCE, CODEX_LABEL, {
      root,
      sessionsDir,
      state: 'unreadable',
      detected: true,
      lastError: `codex root unreadable (${rootState.error})`
    })
  }
  const sessionsState = scanRootDirState(sessionsDir, deps)
  if (!sessionsState.exists && !sessionsState.error) {
    return baseProbe(CODEX_SOURCE, CODEX_LABEL, {
      root,
      sessionsDir,
      state: 'empty',
      detected: true,
      readable: true
    })
  }
  if (sessionsState.error) {
    return baseProbe(CODEX_SOURCE, CODEX_LABEL, {
      root,
      sessionsDir,
      state: 'unreadable',
      detected: true,
      lastError: `codex sessions unreadable (${sessionsState.error})`
    })
  }
  let files = []
  try {
    files = await getRolloutModule().listRolloutFiles(sessionsDir)
  } catch (error) {
    return baseProbe(CODEX_SOURCE, CODEX_LABEL, {
      root,
      sessionsDir,
      state: 'error',
      detected: true,
      readable: true,
      lastError: error?.message || String(error)
    })
  }
  const ordered = (Array.isArray(files) ? files : []).filter((file) => typeof file === 'string' && file)
  return baseProbe(CODEX_SOURCE, CODEX_LABEL, {
    root,
    sessionsDir,
    state: ordered.length > 0 ? 'ok' : 'empty',
    detected: true,
    readable: true,
    files: ordered,
    fileCount: ordered.length,
    coverageStartAt: coverageStartFromFiles(ordered)
  })
}

// ── DeepSeek Harness (dsh) ──────────────────────────────────────────────────
// Sessions live under `<home>/.dsh/sessions/<project>/<session>/session.vN.jsonl[.zstd]`.
// The file list must be resolved outside the parser (`parseDshIncremental` takes
// `sessionFiles`), so discovery uses the vendored resolver with an explicit
// DSH_HOME to keep it deterministic in tests/e2e.
function resolveDshRoot({ homeDir, explicitHome, env = process.env } = {}) {
  if (!homeDir) return null
  if (!explicitHome) {
    const override =
      (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) ||
      (typeof env.TOKENTRACKER_DSH_HOME === 'string' && env.TOKENTRACKER_DSH_HOME.trim())
    if (override) return path.resolve(override.trim())
  }
  return path.join(homeDir, '.dsh')
}

function coverageStartFromStats(files, statSync) {
  let earliest = null
  for (const file of Array.isArray(files) ? files : []) {
    try {
      const stat = statSync(file)
      const mtimeMs = Number(stat?.mtimeMs)
      if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) continue
      const day = new Date(mtimeMs).toISOString().slice(0, 10)
      if (!earliest || day < earliest) earliest = day
    } catch (_error) {
      // A stat failure only loses the coverage hint.
    }
  }
  return earliest ? `${earliest}T00:00:00.000Z` : null
}

async function probeDsh({ homeDir, explicitHome = false, env = process.env, deps = {} } = {}) {
  const root = resolveDshRoot({ homeDir, explicitHome, env })
  if (!root) {
    return baseProbe(DSH_SOURCE, DSH_LABEL, { state: 'absent', lastError: 'no home directory' })
  }
  const sessionsDir = path.join(root, 'sessions')
  const rootState = scanRootDirState(root, deps)
  if (!rootState.exists && !rootState.error) {
    return baseProbe(DSH_SOURCE, DSH_LABEL, { root, sessionsDir })
  }
  if (rootState.error) {
    return baseProbe(DSH_SOURCE, DSH_LABEL, {
      root,
      sessionsDir,
      state: 'unreadable',
      detected: true,
      lastError: `dsh root unreadable (${rootState.error})`
    })
  }
  const sessionsState = scanRootDirState(sessionsDir, deps)
  if (!sessionsState.exists && !sessionsState.error) {
    return baseProbe(DSH_SOURCE, DSH_LABEL, { root, sessionsDir, state: 'empty', detected: true, readable: true })
  }
  if (sessionsState.error) {
    return baseProbe(DSH_SOURCE, DSH_LABEL, {
      root,
      sessionsDir,
      state: 'unreadable',
      detected: true,
      lastError: `dsh sessions unreadable (${sessionsState.error})`
    })
  }
  let files = []
  try {
    files = await getRolloutModule().resolveDshSessionFiles(
      { ...env, DSH_HOME: root },
      { nativeHome: root }
    )
  } catch (error) {
    return baseProbe(DSH_SOURCE, DSH_LABEL, {
      root,
      sessionsDir,
      state: 'error',
      detected: true,
      readable: true,
      lastError: error?.message || String(error)
    })
  }
  const ordered = (Array.isArray(files) ? files : []).filter((file) => typeof file === 'string' && file)
  return baseProbe(DSH_SOURCE, DSH_LABEL, {
    root,
    sessionsDir,
    state: ordered.length > 0 ? 'ok' : 'empty',
    detected: true,
    readable: true,
    files: ordered,
    fileCount: ordered.length,
    coverageStartAt: coverageStartFromStats(ordered, deps.statSync || fssync.statSync)
  })
}

// ── OpenCode ────────────────────────────────────────────────────────────────
// One SQLite database (read-only) at `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`.
function resolveOpencodeDbPath({ homeDir, explicitHome, env = process.env } = {}) {
  if (!homeDir) return null
  if (!explicitHome) {
    const xdg = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : ''
    if (xdg) return path.join(path.resolve(xdg), 'opencode', 'opencode.db')
  }
  return path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db')
}

async function probeOpencode({ homeDir, explicitHome = false, env = process.env, deps = {} } = {}) {
  const dbPath = resolveOpencodeDbPath({ homeDir, explicitHome, env })
  if (!dbPath) {
    return baseProbe(OPENCODE_SOURCE, OPENCODE_LABEL, { state: 'absent', lastError: 'no home directory' })
  }
  const root = path.dirname(dbPath)
  const statSync = deps.statSync || fssync.statSync
  let stat
  try {
    stat = statSync(dbPath)
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'EUNKNOWN'
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return baseProbe(OPENCODE_SOURCE, OPENCODE_LABEL, { root, sessionsDir: dbPath })
    }
    return baseProbe(OPENCODE_SOURCE, OPENCODE_LABEL, {
      root,
      sessionsDir: dbPath,
      state: 'unreadable',
      detected: true,
      lastError: `opencode database unreadable (${code})`
    })
  }
  if (stat && typeof stat.isFile === 'function' && stat.isFile() === false) {
    return baseProbe(OPENCODE_SOURCE, OPENCODE_LABEL, { root, sessionsDir: dbPath })
  }
  return baseProbe(OPENCODE_SOURCE, OPENCODE_LABEL, {
    root,
    sessionsDir: dbPath,
    state: 'ok',
    detected: true,
    readable: true,
    files: [dbPath],
    fileCount: 1,
    coverageStartAt: null
  })
}

// Registry order is the scan order (`priority`): serial, high priority first
// (plan appendix C).
const TOOLS = Object.freeze([
  Object.freeze({
    source: CODEX_SOURCE,
    label: CODEX_LABEL,
    priority: 1,
    probe: probeCodex
  }),
  Object.freeze({
    source: DSH_SOURCE,
    label: DSH_LABEL,
    priority: 2,
    probe: probeDsh
  }),
  Object.freeze({
    source: OPENCODE_SOURCE,
    label: OPENCODE_LABEL,
    priority: 3,
    probe: probeOpencode
  })
])

// Tools that are deliberately not collected in this release. The status payload
// always lists them so the page can say why they are missing (plan §1.1).
const UNSUPPORTED_TOOLS = Object.freeze([
  Object.freeze({
    source: 'cursor',
    label: 'Cursor',
    state: 'unsupported',
    reason: 'account-api',
    lastError: null
  }),
  Object.freeze({
    source: 'trae',
    label: 'TRAE',
    state: 'unsupported',
    reason: 'sqlcipher',
    lastError: null
  })
])

function listTools() {
  return TOOLS.slice()
}

async function probeTool(source, context) {
  const tool = TOOLS.find((entry) => entry.source === source)
  if (!tool) throw new Error(`unknown usage tool: ${source}`)
  return tool.probe(context)
}

async function probeTools(context) {
  const probes = []
  for (const tool of TOOLS) {
    probes.push(await tool.probe(context))
  }
  return probes
}

module.exports = {
  CODEX_LABEL,
  CODEX_SOURCE,
  DSH_LABEL,
  DSH_SOURCE,
  OPENCODE_LABEL,
  OPENCODE_SOURCE,
  TOOLS,
  UNSUPPORTED_TOOLS,
  coverageStartFromFiles,
  coverageStartFromStats,
  listTools,
  probeCodex,
  probeDsh,
  probeOpencode,
  probeTool,
  probeTools,
  resolveCodexRoot,
  resolveDshRoot,
  resolveHomeContext,
  resolveOpencodeDbPath
}
