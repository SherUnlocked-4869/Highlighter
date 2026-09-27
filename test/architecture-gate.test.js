const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const {
  MAIN_LINE_CEILING,
  REQUIRED_DOMAINS,
  FORBIDDEN_IN_MAIN,
  collectFailures
} = require('../scripts/check-architecture')

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

test('architecture gate keeps main.js assembled from domains', () => {
  const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'check-architecture.js')], {
    encoding: 'utf8'
  })
  assert.match(output, /architecture-check: ok/)
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'check-architecture.js')), true)
})

test('main.js stays under the ceiling and the gate reports the ceiling it enforced', () => {
  const mainLines = mainSource.split(/\r?\n/).length
  assert.ok(
    mainLines <= MAIN_LINE_CEILING,
    `main.js is ${mainLines} lines, above the ${MAIN_LINE_CEILING}-line ceiling`
  )
  const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'check-architecture.js')], {
    encoding: 'utf8'
  })
  assert.match(output, new RegExp(`main\\.js ${mainLines} lines`))
  assert.match(output, new RegExp(`ceiling ${MAIN_LINE_CEILING}`))
})

test('every moved block is absent from main.js', () => {
  for (const pattern of FORBIDDEN_IN_MAIN) {
    assert.doesNotMatch(mainSource, pattern, `main.js must not contain ${pattern}`)
  }
  // The two window channels the main page's preload still owns stay behind.
  assert.match(mainSource, /secureIpcMain\.on\('window:minimize'/)
  assert.match(mainSource, /secureIpcMain\.on\('window:close'/)
})

test('every required domain exists on disk and is loaded by main.js', () => {
  for (const domain of REQUIRED_DOMAINS) {
    assert.equal(
      fs.existsSync(path.join(root, 'main', 'domains', domain, 'index.js')),
      true,
      `main/domains/${domain}/index.js exists`
    )
    assert.match(mainSource, new RegExp(`require\\('\\./main/domains/${domain}'\\)`), `main.js loads ${domain}`)
  }
})

test('the gate collects no failures for the committed tree and its ceiling is a real reduction', () => {
  const { mainLines, failures } = collectFailures()
  assert.deepEqual(failures, [])
  assert.equal(mainLines, mainSource.split(/\r?\n/).length)
  assert.ok(MAIN_LINE_CEILING < 2173, 'the ceiling is below the pre-refactor size')
})
