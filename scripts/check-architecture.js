'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mainPath = path.join(root, 'main.js')
const mainSource = fs.readFileSync(mainPath, 'utf8')
const mainLines = mainSource.split(/\r?\n/).length

const MAX_MAIN_LINES = 2100
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

if (mainLines > MAX_MAIN_LINES) {
  fail(`main.js has ${mainLines} lines (max ${MAX_MAIN_LINES})`)
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
