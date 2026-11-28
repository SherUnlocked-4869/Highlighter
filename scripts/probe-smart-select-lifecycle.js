// DEV-03 measurement probe: SmartSelect.exe lifecycle for the "reuse one long-lived
// session" candidate. It drives the real main/domains/capture/smart-select.js session
// class against the real sidecar binary; no product file is modified.
//
// What it measures:
//   * spawn -> ready cost (what the on-demand pipeline pays as `smartSelectMs`)
//   * first hit-test query round-trip and the same query when repeated
//   * 30-query p50/p95 round-trip, plus rect conversion cost
//   * staleness: the helper snapshots the visible window list ONCE at startup
//     (`LoadWindows()` before the `ready` line), so a long-lived session returns
//     stale rectangles after any window appears/moves. Compared against a freshly
//     spawned session at the same screen point.
//   * idle cost over N seconds (memory drift + CPU seconds + sidecar count)
//   * dispose -> process exit, and sidecar count after exit
//
// Run:
//   node_modules\electron\dist\electron.exe --no-sandbox scripts\probe-smart-select-lifecycle.js -- --idle-seconds 600
// ENV: clear ELECTRON_RUN_AS_NODE, set TMP/TEMP under .tmp-work, keep windows on DISPLAY2.
'use strict'
const { app, BrowserWindow, screen } = require('electron')
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = process.env.PROBE_OUT_DIR || path.join(ROOT, '.tmp-work', 'experiment', 'dev03')
const OUT_FILE = path.join(OUT_DIR, 'smart-select-lifecycle.json')
const HELPER = path.join(ROOT, 'native', 'smart-select', 'SmartSelect.exe')
const { createSmartSelectSessionClass, convertSmartSelectRects } = require('../main/domains/capture/smart-select')

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) ? value : fallback
}
const IDLE_SECONDS = Math.max(1, argValue('--idle-seconds', 600))
const QUERY_ROUNDS = Math.max(10, argValue('--query-rounds', 30))
const QUERIES = []
const LOGS = []
const report = {
  schema: 1,
  kind: 'smart-select-lifecycle',
  startedAt: new Date().toISOString(),
  helperPath: HELPER,
  pid: process.pid,
  idleSeconds: IDLE_SECONDS,
  queryRounds: QUERY_ROUNDS,
  logs: LOGS,
  errors: []
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}
function log(message) {
  LOGS.push(`${new Date().toISOString()} ${message}`)
}
function nowIso() { return new Date().toISOString() }

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)])
}

function getHelperProcessById(pid) {
  if (process.platform !== 'win32') return null
  try {
    const command = `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU,HandleCount | ConvertTo-Json -Compress`
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 15000
    }).trim()
    if (!output) return null
    const item = JSON.parse(output)
    return {
      pid: Number(item.Id),
      workingSetMiB: round(Number(item.WorkingSet64) / 1048576, 1),
      privateMiB: round(Number(item.PrivateMemorySize64) / 1048576, 1),
      cpuSeconds: round(item.CPU, 2),
      handles: Number(item.HandleCount) || 0
    }
  } catch { return null }
}

function getHelperProcesses() {
  if (process.platform !== 'win32') return []
  const command = [
    "$items = Get-Process -Name 'SmartSelect' -ErrorAction SilentlyContinue",
    "$items | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU,HandleCount | ConvertTo-Json -Compress"
  ].join('; ')
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 15000
    }).trim()
    if (!output) return []
    const parsed = JSON.parse(output)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    return items.map((item) => ({
      pid: Number(item.Id),
      workingSetMiB: round(Number(item.WorkingSet64) / 1048576, 1),
      privateMiB: round(Number(item.PrivateMemorySize64) / 1048576, 1),
      cpuSeconds: round(item.CPU, 2),
      handles: Number(item.HandleCount) || 0
    }))
  } catch (error) {
    log(`getHelperProcesses failed: ${error.message}`)
    return []
  }
}

// Call the real session class with a counted spawn so spawn->ready can be attributed.
function makeSession() {
  let spawnAt = 0
  let spawnedPid = null
  const Session = createSmartSelectSessionClass({
    spawn(file, spawnArgs, options) {
      spawnAt = performance.now()
      const child = spawn(file, spawnArgs, options)
      spawnedPid = child.pid
      return child
    },
    log: (message) => log(`session: ${message}`)
  })
  const session = new Session(HELPER)
  return {
    session,
    spawnedPid: () => spawnedPid,
    waitReady: async () => {
      await session.waitUntilReady(4000)
      return round(performance.now() - spawnAt)
    }
  }
}

async function timeQuery(session, x, y) {
  const startedAt = performance.now()
  const rects = await session.query(x, y)
  const elapsedMs = round(performance.now() - startedAt)
  return { x, y, elapsedMs, rects, count: rects.length, at: nowIso() }
}

function rectContains(rects, x, y) {
  return rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

function rectsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function main() {
  if (!fs.existsSync(HELPER)) throw new Error(`SmartSelect helper missing: ${HELPER}`)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  report.helperProcessesBefore = getHelperProcesses()
  report.memoryBefore = { smartSelectCount: report.helperProcessesBefore.length }

  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const display = displays.find((item) => item.id !== primary.id) || primary
  report.display = { id: display.id, bounds: display.bounds, primaryId: primary.id }

  const x = display.bounds.x + Math.round(display.bounds.width / 2) - 300
  const y = display.bounds.y + Math.round(display.bounds.height / 2) - 200
  const title = `HL SmartSelect Probe ${Date.now()}`
  const probeWindow = new BrowserWindow({
    x, y, width: 600, height: 400, show: true, title, frame: true, skipTaskbar: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  })
  await probeWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<title>${title}</title><body style="margin:0;background:#cfe">probe window</body>`)}`)
  probeWindow.setTitle(title)
  await sleep(500)
  const initialBounds = probeWindow.getBounds()
  report.probeWindow = { title, initialBounds }

  // Point deep inside the client area (avoid the frame strip).
  const oldPoint = {
    x: initialBounds.x + Math.round(initialBounds.width / 2),
    y: initialBounds.y + Math.round(initialBounds.height / 2)
  }
  report.oldPoint = oldPoint

  // ---- cold session: what the current per-capture pipeline pays ----
  const cold = makeSession()
  const coldReadyMs = await cold.waitReady()
  report.coldSession = {
    pid: cold.spawnedPid(),
    spawnToReadyMs: coldReadyMs,
    readyWindowCount: Array.isArray(cold.session.windowRects) ? cold.session.windowRects.length : null,
    memoryAfterReady: getHelperProcesses()
  }

  const firstQuery = await timeQuery(cold.session, oldPoint.x, oldPoint.y)
  report.firstQuery = { ...firstQuery, expectedProbeWindow: true, containsProbePoint: rectContains(firstQuery.rects, oldPoint.x, oldPoint.y) }

  // Rect conversion cost (pure JS, the part the main process also pays).
  const conversionTimes = []
  for (let index = 0; index < 200; index += 1) {
    const startedAt = performance.now()
    convertSmartSelectRects(firstQuery.rects, {
      captureBounds: initialBounds,
      physicalBounds: initialBounds
    })
    conversionTimes.push(performance.now() - startedAt)
  }
  report.rectConversion = { p50Ms: percentile(conversionTimes, 50), p95Ms: percentile(conversionTimes, 95) }

  const roundTrips = []
  for (let index = 0; index < QUERY_ROUNDS; index += 1) {
    const result = await timeQuery(cold.session, oldPoint.x, oldPoint.y)
    roundTrips.push(result.elapsedMs)
  }
  report.hotQueries = {
    count: roundTrips.length,
    p50Ms: percentile(roundTrips, 50),
    p95Ms: percentile(roundTrips, 95),
    minMs: round(Math.min(...roundTrips)),
    maxMs: round(Math.max(...roundTrips)),
    samplesMs: roundTrips.map((value) => round(value))
  }

  // ---- staleness: move the probe window, then ask the long-lived session ----
  // Move down by more than the frame height so the new centre is outside the old
  // cached frame (a small move would keep the new point inside the stale rectangle
  // and prove nothing); the window stays fully on the secondary display.
  const movedX = initialBounds.x
  const movedY = initialBounds.y + initialBounds.height + 80
  probeWindow.setBounds({ x: movedX, y: movedY, width: initialBounds.width, height: initialBounds.height })
  await sleep(600)
  const movedBounds = probeWindow.getBounds()
  const newPoint = {
    x: movedBounds.x + Math.round(movedBounds.width / 2),
    y: movedBounds.y + Math.round(movedBounds.height / 2)
  }
  report.moved = { movedBounds, newPoint }
  const staleOld = await timeQuery(cold.session, oldPoint.x, oldPoint.y)
  const staleNew = await timeQuery(cold.session, newPoint.x, newPoint.y)
  report.staleness = {
    helps: 'SmartSelect.exe calls LoadWindows() once before its ready line; a long-lived session cannot see later window moves or new windows.',
    staleSessionQueryOldPoint: staleOld,
    staleSessionQueryNewPoint: staleNew,
    staleOldPointStillReturnsRect: staleOld.count > 0,
    staleNewPointReturnsRect: rectContains(staleNew.rects, newPoint.x, newPoint.y),
    freshSessionQueryNewPoint: null,
    freshSessionQueryOldPoint: null
  }

  // ---- fresh respawn at the same moment: the cost of staying correct ----
  const fresh = makeSession()
  const freshReadyMs = await fresh.waitReady()
  const freshNew = await timeQuery(fresh.session, newPoint.x, newPoint.y)
  const freshOld = await timeQuery(fresh.session, oldPoint.x, oldPoint.y)
  report.freshSession = {
    pid: fresh.spawnedPid(),
    spawnToReadyMs: freshReadyMs,
    queryNewPoint: freshNew,
    queryOldPoint: freshOld,
    newPointReturnsRect: rectContains(freshNew.rects, newPoint.x, newPoint.y),
    oldPointReturnsRect: rectContains(freshOld.rects, oldPoint.x, oldPoint.y),
    sameRectsAsStale: rectsEqual(freshNew.rects, staleNew.rects)
  }
  // Persist what the fresh session saw so the two sessions can be compared later.
  report.staleness.freshSessionQueryNewPoint = freshNew
  report.staleness.freshSessionQueryOldPoint = freshOld

  // ---- idle window: memory / CPU drift and staleness after a long hold ----
  const idleSnapshots = []
  const idleStartedAt = Date.now()
  let lastCpu = null
  let movedDuringIdle = false
  while (Date.now() - idleStartedAt < IDLE_SECONDS * 1000) {
    const elapsed = Date.now() - idleStartedAt
    const remaining = IDLE_SECONDS * 1000 - elapsed
    const waitMs = Math.min(60000, remaining)
    if (!movedDuringIdle && elapsed > Math.min(30000, (IDLE_SECONDS * 1000) / 2)) {
      // Half-way through the idle hold: move the probe window and open a second one so the
      // helper's cached rect list is provably out of date when the post-idle query arrives.
      const holdBounds = probeWindow.getBounds()
      probeWindow.setBounds({ x: holdBounds.x - 120, y: holdBounds.y + 60 })
      const secondWindow = new BrowserWindow({
        x: initialBounds.x + 40, y: initialBounds.y + initialBounds.height + 80,
        width: 380, height: 240, show: true, frame: true, skipTaskbar: true,
        title: `HL SmartSelect Probe Second ${Date.now()}`,
        webPreferences: { contextIsolation: false, nodeIntegration: false }
      })
      await secondWindow.loadURL('data:text/html;charset=utf-8,<title>HL SmartSelect Probe Second</title><body>second</body>')
      report.secondWindow = { bounds: secondWindow.getBounds() }
      movedDuringIdle = true
    }
    await sleep(waitMs)
    const processes = getHelperProcesses()
    const helper = processes[0] || null
    idleSnapshots.push({
      elapsedMs: Date.now() - idleStartedAt,
      smartSelectCount: processes.length,
      workingSetMiB: helper ? helper.workingSetMiB : null,
      privateMiB: helper ? helper.privateMiB : null,
      cpuSeconds: helper ? helper.cpuSeconds : null,
      cpuDeltaSeconds: helper && lastCpu !== null ? round(helper.cpuSeconds - lastCpu, 2) : null
    })
    lastCpu = helper ? helper.cpuSeconds : lastCpu
  }
  report.idle = {
    requestedSeconds: IDLE_SECONDS,
    measuredSeconds: round((Date.now() - idleStartedAt) / 1000, 1),
    snapshots: idleSnapshots,
    movedWindowDuringIdle: movedDuringIdle,
    cpuSecondsUsed: idleSnapshots.length && idleSnapshots.at(-1).cpuSeconds !== null && idleSnapshots[0].cpuSeconds !== null
      ? round(idleSnapshots.at(-1).cpuSeconds - idleSnapshots[0].cpuSeconds, 2)
      : null
  }

  const idleQuery = await timeQuery(cold.session, newPoint.x, newPoint.y)
  report.postIdleQuery = {
    ...idleQuery,
    containsMovedProbeWindow: rectContains(idleQuery.rects, newPoint.x, newPoint.y),
    note: 'The helper has been alive for the whole idle hold; false means its window snapshot is stale.'
  }

  // ---- teardown: dispose the long-lived session and verify ITS process exits ----
  const coldPid = cold.spawnedPid()
  const exitStart = performance.now()
  cold.session.dispose()
  let exited = false
  while (performance.now() - exitStart < 5000) {
    if (!getHelperProcessById(coldPid)) { exited = true; break }
    await sleep(50)
  }
  report.dispose = {
    disposedPid: coldPid,
    disposeToProcessGoneMs: round(performance.now() - exitStart),
    processGone: exited,
    coldHelperStillAlive: getHelperProcessById(coldPid),
    allHelpersAfter: getHelperProcesses()
  }
  fresh.session.dispose()
  await sleep(300)

  report.coldSpawnReadyMs = coldReadyMs
  report.freshSpawnReadyMs = freshReadyMs
  report.reuseSavingPerCaptureMs = round(coldReadyMs, 2)
  report.ok = true
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    report.error = error.stack || String(error)
  }
  try {
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error('write failed', error)
  }
  console.log(`SMART_SELECT_PROBE_DONE ${OUT_FILE}`)
  app.exit(report.ok ? 0 : 1)
})

