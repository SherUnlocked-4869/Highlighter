'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mainPath = path.join(root, 'main.js')

// The v4 refactor (2026-09-27) took main.js from 2173 lines back to assembly and
// re-established a ceiling, tightened in two steps so a partial state could still
// land: 2100 -> 1600 (intermediate) -> 1300 (this value). The design's stated
// target was ~1150 with a 1200 ceiling; the sanctioned scope lands at ~1288
// because what is left is exactly the code the design keeps: the startApplication
// and gotTheLock orchestration (D28), createMainWindow/tray/service assembly
// (§3.1) and the registerX Ipc controller wiring (§3.2). Cutting further would
// mean the "incidental optimisation to hit a line count" the design lists as a
// non-goal, so the remaining ~90 lines are registered as follow-up work instead.
//
// 2026-10-16: raised to 1330 for the Index-Translate proxy bridge (see
// docs/proxy-bridge-tray-integration.md). The addition is assembly-only - one
// require, one controller construction, a few tray-template fields, a tooltip
// read, a quit dispose, a startup adoption pass and one IPC accessor - because
// the state machine, the failure copy and the status broadcast live in
// main/services/translation-proxy-service.js and proxy-bridge-controller.js.
//
// 2026-11-26 (H05, docs/reviews/2026-11-26-code-review-and-optimization-report.md §二.5):
// back to 1205 after the tray moved to main/domains/tray and every channel registration to
// main/ipc/index.js, and the lines that had been squeezed to stay under 1330 were expanded
// again. The review's diagnosis was that a line count with no line-length cap trades
// readability for a number, so the ceiling is now paired with MAX_MAIN_LINE_LENGTH.
const MAIN_LINE_CEILING = 1205
// H05 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §二.5): the tray moved to
// its own domain module, so it joins the required-domain list, and two new checks stop the
// style the ceiling used to force: every domain channel must be registered outside main.js
// (the old pattern only looked at `.on(`, which is how a stray `.handle('record:pin-frame')`
// survived), and no assembly line may exceed MAX_MAIN_LINE_LENGTH characters (the review found
// 376-character lines squeezed in to stay under the line count).
const MAX_MAIN_LINE_LENGTH = 160
const REQUIRED_DOMAINS = [
  'pin',
  'capture',
  'long-capture',
  'record',
  'recognition',
  'search',
  'clipboard',
  'settings-effects',
  'selection',
  'data-root',
  'tray'
]
// Moved code must not come back: each pattern names something that now lives in
// its own module. window:minimize / window:close are deliberately absent - they
// are sent by the main page's preload and stay here (design D26).
const FORBIDDEN_IN_MAIN = [
  /function createPinWindow\s*\(/,
  /function createCaptureWindow\s*\(/,
  /function createRecordWindow\s*\(/,
  /function createSearchWindow\s*\(/,
  /function createRecognitionWindow\s*\(/,
  /function createLongCaptureWindow\s*\(/,
  /class SmartSelectSession/,
  // H05: `.handle()` as well as `.on()` - the review found a handle('record:pin-frame') that
  // the on()-only pattern could not see.
  /secureIpcMain\.(on|handle)\('pin:/,
  /secureIpcMain\.(on|handle)\('recognition:/,
  /secureIpcMain\.(on|handle)\('capture:/,
  /secureIpcMain\.(on|handle)\('record:/,
  /secureIpcMain\.(on|handle)\('search:/,
  /secureIpcMain\.(on|handle)\('toolbar:/,
  /secureIpcMain\.(on|handle)\('stream:/,
  /secureIpcMain\.(on|handle)\('chat:/,
  /secureIpcMain\.(on|handle)\('window:toggle-pin'/,
  // H05: the domains that were already aggregated in main/ipc/index.js keep their channels there.
  /secureIpcMain\.(on|handle)\('(history|settings|coding-plan|shortcut|app|diagnostics|update|data-root|usage|ocr|export|region|selection|clipboard|record-editor):/,
  /secureIpcMain\.(on|handle)\('record:pin-frame'/,
  /function openToolbarAiAction\s*\(/,
  /function streamToWindow\s*\(/,
  /function handleTextSelection\s*\(/,
  /function getRefPointAndOrientation\s*\(/,
  /function createToolbarStreamController\s*\(/,
  /function restoreConversation\s*\(/,
  /function changeDataRoot\s*\(/,
  /function recoverUnavailableDataRoot\s*\(/,
  /function chooseInitialDataRoot\s*\(/,
  /function stopManagedDataWriters\s*\(/,
  /function getDisplayCapture\s*\(/,
  /function captureFocusedWindow\s*\(/,
  /const DEFAULT_SETTINGS = \{/,
  /async function executeFunction\s*\(/
]

function collectFailures() {
  const mainSource = fs.readFileSync(mainPath, 'utf8')
  const mainLines = mainSource.split(/\r?\n/).length
  const failures = []
  const fail = (message) => failures.push(message)

  for (const domain of REQUIRED_DOMAINS) {
    const indexPath = path.join(root, 'main', 'domains', domain, 'index.js')
    if (!fs.existsSync(indexPath)) fail(`missing domain module main/domains/${domain}/index.js`)
  }

  for (const pattern of FORBIDDEN_IN_MAIN) {
    if (pattern.test(mainSource)) fail(`main.js must not contain ${pattern}`)
  }

  for (const domain of REQUIRED_DOMAINS) {
    const requirePattern = new RegExp(`require\\(['"]\\./main/domains/${domain}['"]\\)`)
    if (!requirePattern.test(mainSource)) fail(`main.js must load ${domain} domain`)
  }
  if (!/require\(['"]\.\/main\/services\/ai['"]\)/.test(mainSource)) fail('main.js must load AI client entry')

  if (mainLines > MAIN_LINE_CEILING) {
    fail(`main.js is ${mainLines} lines, above the ceiling of ${MAIN_LINE_CEILING}`)
  }

  // H05: the ceiling alone pushes assembly code into fewer, denser lines; this is the second
  // half of the guard. Template lines are not exempt - the assembly file should not carry
  // 300-character inline template bodies either (the menu template moved to its own module).
  const longLines = []
  mainSource.split(/\r?\n/).forEach((line, index) => {
    if (line.length > MAX_MAIN_LINE_LENGTH) longLines.push({ line: index + 1, length: line.length })
  })
  for (const entry of longLines) {
    fail(`main.js:${entry.line} is ${entry.length} characters, above the ${MAX_MAIN_LINE_LENGTH}-character line limit`)
  }

  const longestLine = mainSource
    .split(/\r?\n/)
    .reduce((longest, line) => (line.length > longest.length ? line : longest), '')
  return { mainLines, longestLine: longestLine.length, failures }
}

function run() {
  const { mainLines, longestLine, failures } = collectFailures()
  for (const message of failures) console.error(`architecture-check: ${message}`)
  if (failures.length) {
    process.exitCode = 1
    return
  }
  console.log(`architecture-check: ok (main.js ${mainLines} lines, ceiling ${MAIN_LINE_CEILING}, longest line ${longestLine}/${MAX_MAIN_LINE_LENGTH}, domains ${REQUIRED_DOMAINS.length})`)
}

if (require.main === module) run()

module.exports = {
  MAIN_LINE_CEILING,
  MAX_MAIN_LINE_LENGTH,
  REQUIRED_DOMAINS,
  FORBIDDEN_IN_MAIN,
  collectFailures
}
