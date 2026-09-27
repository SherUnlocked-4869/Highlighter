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
const MAIN_LINE_CEILING = 1300
const REQUIRED_DOMAINS = [
  'pin',
  'capture',
  'long-capture',
  'record',
  'recognition',
  'search',
  'settings-effects',
  'selection',
  'data-root'
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
  /secureIpcMain\.on\('pin:/,
  /secureIpcMain\.on\('recognition:/,
  /secureIpcMain\.on\('capture:/,
  /secureIpcMain\.on\('record:/,
  /secureIpcMain\.on\('search:/,
  /secureIpcMain\.on\('toolbar:/,
  /secureIpcMain\.on\('stream:/,
  /secureIpcMain\.on\('chat:/,
  /secureIpcMain\.handle\('chat:/,
  /secureIpcMain\.on\('window:toggle-pin'/,
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

  return { mainLines, failures }
}

function run() {
  const { mainLines, failures } = collectFailures()
  for (const message of failures) console.error(`architecture-check: ${message}`)
  if (failures.length) {
    process.exitCode = 1
    return
  }
  console.log(`architecture-check: ok (main.js ${mainLines} lines, ceiling ${MAIN_LINE_CEILING}, domains ${REQUIRED_DOMAINS.length})`)
}

if (require.main === module) run()

module.exports = {
  MAIN_LINE_CEILING,
  REQUIRED_DOMAINS,
  FORBIDDEN_IN_MAIN,
  collectFailures
}
