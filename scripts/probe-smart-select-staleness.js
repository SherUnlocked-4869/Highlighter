// DEV-03 staleness check for the "reuse one long-lived SmartSelect session" option.
//
// SmartSelect.exe enumerates the visible window list ONCE in LoadWindows(), before it
// prints its `ready` line (native/smart-select/Program.cs). HitTest() then answers from
// that static list. A per-capture session therefore always sees the window list of the
// instant it was spawned. This probe proves the observable consequence:
//
//   1. create a full-display probe window on the secondary display, spawn session A
//   2. move the window to the primary display (a real window move)
//   3. ask session A about the OLD position (still answered -> stale) and the NEW
//      position (not answered -> stale)
//   4. spawn session B now and ask about the NEW position (answered) and the OLD
//      position (not answered) -> a respawn is what makes the answer correct
//
// Run: electron.exe --no-sandbox scripts/probe-smart-select-staleness.js
'use strict'
const { app, BrowserWindow, screen } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tmp-work', 'experiment', 'dev03')
const OUT_FILE = path.join(OUT_DIR, 'smart-select-staleness.json')
const HELPER = path.join(ROOT, 'native', 'smart-select', 'SmartSelect.exe')
const { createSmartSelectSessionClass } = require('../main/domains/capture/smart-select')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value) => Math.round((Number(value) || 0) * 100) / 100
const report = { schema: 1, kind: 'smart-select-staleness', startedAt: new Date().toISOString(), checks: {}, errors: [] }

function makeSession() {
  const Session = createSmartSelectSessionClass({
    spawn(file, args, options) { return spawn(file, args, options) },
    log: (message) => report.errors.push(String(message))
  })
  const session = new Session(HELPER)
  return session
}

async function timeQuery(session, x, y) {
  const started = Date.now()
  const rects = await session.query(x, y)
  return { x, y, elapsedMs: round(Date.now() - started), count: rects.length, rects }
}

function contains(rects, x, y) {
  return rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const primary = screen.getPrimaryDisplay()
  const secondary = screen.getAllDisplays().find((display) => display.id !== primary.id) || primary
  report.display = { primary: primary.bounds, secondary: secondary.bounds }

  const fullBounds = secondary.bounds
  const title = `HL Staleness Probe ${Date.now()}`
  const win = new BrowserWindow({
    x: fullBounds.x,
    y: fullBounds.y,
    width: fullBounds.width,
    height: fullBounds.height,
    show: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<title>${title}</title><body style="margin:0;background:#bcd">staleness probe</body>`)}`)
  win.setTitle(title)
  win.focus()
  await sleep(800)
  const oldBounds = win.getBounds()
  const oldPoint = { x: oldBounds.x + Math.round(oldBounds.width / 2), y: oldBounds.y + Math.round(oldBounds.height / 2) }
  report.probeWindow = { title, oldBounds, oldPoint }

  const stale = makeSession()
  await stale.waitUntilReady(4000)
  const beforeMove = await timeQuery(stale, oldPoint.x, oldPoint.y)
  report.checks.sessionAQueryOldPointBeforeMove = { ...beforeMove, containsPoint: contains(beforeMove.rects, oldPoint.x, oldPoint.y) }

  // Move the window to the primary display: a real move any UI Automation snapshot of
  // the window list would have to observe.
  const newBounds = {
    x: primary.bounds.x + 120,
    y: primary.bounds.y + 120,
    width: Math.min(900, Math.round(primary.bounds.width / 2)),
    height: Math.min(600, Math.round(primary.bounds.height / 2))
  }
  win.setBounds(newBounds)
  await sleep(800)
  const movedBounds = win.getBounds()
  const newPoint = { x: movedBounds.x + Math.round(movedBounds.width / 2), y: movedBounds.y + Math.round(movedBounds.height / 2) }
  report.probeWindow.movedBounds = movedBounds
  report.probeWindow.newPoint = newPoint

  const staleOld = await timeQuery(stale, oldPoint.x, oldPoint.y)
  const staleNew = await timeQuery(stale, newPoint.x, newPoint.y)
  report.checks.sessionAQueryOldPointAfterMove = { ...staleOld, containsPoint: contains(staleOld.rects, oldPoint.x, oldPoint.y) }
  report.checks.sessionAQueryNewPointAfterMove = { ...staleNew, containsPoint: contains(staleNew.rects, newPoint.x, newPoint.y) }

  // A respawned session sees the current window list.
  const fresh = makeSession()
  await fresh.waitUntilReady(6000)
  const freshNew = await timeQuery(fresh, newPoint.x, newPoint.y)
  const freshOld = await timeQuery(fresh, oldPoint.x, oldPoint.y)
  report.checks.sessionBQueryNewPoint = { ...freshNew, containsPoint: contains(freshNew.rects, newPoint.x, newPoint.y) }
  report.checks.sessionBQueryOldPoint = { ...freshOld, containsPoint: contains(freshOld.rects, oldPoint.x, oldPoint.y) }

  report.checks.staleAnswersOldPoint = contains(staleOld.rects, oldPoint.x, oldPoint.y)
  report.checks.staleAnswersNewPoint = contains(staleNew.rects, newPoint.x, newPoint.y)
  report.checks.freshAnswersNewPoint = contains(freshNew.rects, newPoint.x, newPoint.y)
  report.checks.freshAnswersOldPoint = contains(freshOld.rects, oldPoint.x, oldPoint.y)
  // The decisive property: a long-lived session's answer set does not change at all
  // across a real window move (it just replays its spawn-time snapshot), while a
  // respawned session answers from the current window list and returns different
  // rectangles. Other desktop windows may legitimately cover a point, so "empty
  // answer" is not a good expectation; "frozen answer vs changed answer" is.
  const staleFrozen = JSON.stringify(staleOld.rects) === JSON.stringify(beforeMove.rects) &&
    JSON.stringify(staleNew.rects) === JSON.stringify(beforeMove.rects)
  const freshChanged = JSON.stringify(freshNew.rects) !== JSON.stringify(staleNew.rects)
  report.checks.staleSessionAnswersFrozenAcrossMove = staleFrozen
  report.checks.freshSessionAnswersDifferAtNewPoint = freshChanged
  report.checks.stalenessProven = staleFrozen && freshChanged
  report.checks.interpretation = 'A reused session replays the window list captured at spawn; only a new process observes window moves/new windows. Any long-lived reuse therefore needs a protocol-level window-list refresh command before it can be adopted.'
  report.ok = true
  stale.dispose()
  fresh.dispose()
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    report.error = error?.stack || String(error)
  }
  try {
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {}
  console.log(`SMART_SELECT_STALENESS_DONE ${OUT_FILE} stalenessProven=${report.checks?.stalenessProven}`)
  app.exit(report.ok ? 0 : 1)
})
