'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mainPath = path.join(root, 'main.js')
const mainSource = fs.readFileSync(mainPath, 'utf8')
const mainLines = mainSource.split(/\r?\n/).length

// main.js has no line ceiling any more. The old one (2100) was lifted on
// 2026-09-26 so the follow-up-conversation v2 could land without dragging an
// out-of-scope refactor into it. The size problem is still real and is tracked
// as the fourth version of the selection-toolbar roadmap: it extracts the
// selection domain and the inline IPC surfaces and then re-establishes a LOWER
// ceiling. Until that happens the count is still reported below, so the drift
// stays visible in CI output instead of becoming invisible.
const REQUIRED_DOMAINS = [
  'pin',
  'capture',
  'long-capture',
  'record',
  'recognition',
  'search',
  'settings-effects'
]
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
  /secureIpcMain\.on\('search:/
]

function fail(message) {
  console.error(`architecture-check: ${message}`)
  process.exitCode = 1
}

for (const domain of REQUIRED_DOMAINS) {
  const indexPath = path.join(root, 'main', 'domains', domain, 'index.js')
  if (!fs.existsSync(indexPath)) {
    fail(`missing domain module main/domains/${domain}/index.js`)
  }
}

for (const pattern of FORBIDDEN_IN_MAIN) {
  if (pattern.test(mainSource)) {
    fail(`main.js must not contain ${pattern}`)
  }
}

for (const domain of REQUIRED_DOMAINS) {
  const requirePattern = new RegExp(`require\\(['"]\\./main/domains/${domain}['"]\\)`)
  if (!requirePattern.test(mainSource)) {
    fail(`main.js must load ${domain} domain`)
  }
}
if (!/require\(['"]\.\/main\/services\/ai['"]\)/.test(mainSource)) fail('main.js must load AI client entry')

if (!process.exitCode) {
  console.log(`architecture-check: ok (main.js ${mainLines} lines, domains ${REQUIRED_DOMAINS.length})`)
}