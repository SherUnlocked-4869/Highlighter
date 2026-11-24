const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const { parseRows } = require('../scripts/check-review-evidence')
const registry = fs.readFileSync(path.join(ROOT, 'docs', 'evidence', '2026-11-25-windows-architecture-review-evidence.md'), 'utf8')
const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'release-hardware-matrix.json'), 'utf8'))
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('D06: the evidence registry parses and covers every required P0', () => {
  const rows = parseRows(registry)
  const tickets = new Set(rows.map((row) => row.ticket))
  for (const ticket of ['D01', 'D02', 'C01', 'A01']) assert.ok(tickets.has(ticket), ticket + ' has a row')
  // Every row points at an existing test file that mentions the ticket.
  for (const row of rows) {
    assert.ok(row.tests.length > 0, row.ticket + ' lists tests')
    for (const relative of row.tests) {
      const file = path.join(ROOT, relative)
      assert.ok(fs.existsSync(file), row.ticket + ' -> ' + relative + ' exists')
      assert.match(fs.readFileSync(file, 'utf8'), new RegExp('\\b' + row.ticket + '\\b'), row.ticket + ' is traceable in ' + relative)
    }
    assert.ok(row.hardware.trim().length > 0, row.ticket + ' names its real-device gate')
  }
})

test('D06: the checker is part of the default gate and the matrix carries the new claims', () => {
  assert.match(packageJson.scripts.check, /check:review-evidence/)
  assert.equal(packageJson.scripts['check:review-evidence'], 'node scripts/check-review-evidence.js')
  const ids = new Set(matrix.requiredClaims.map((claim) => claim.id))
  for (const claim of [
    'nsis-default-offline-updates',
    'update-manual-check-single-request',
    'recording-real-audio-tracks',
    'recording-slow-disk-abort',
    'explorer-restart-tray'
  ]) assert.ok(ids.has(claim), claim + ' is a required hardware claim')
  // Claim ids stay unique and each still declares the packages it applies to.
  assert.equal(ids.size, matrix.requiredClaims.length)
  for (const claim of matrix.requiredClaims) assert.ok(Array.isArray(claim.packageTypes) && claim.packageTypes.length > 0)
})

test('D06: parseRows ignores prose and accepts a ticket row', () => {
  const rows = parseRows([
    '| 工单 | 优先级 | 状态 | 回归测试 | 真机/发布门槛 |',
    '|---|---|---|---|---|',
    '| D01 | P0 | 已实现 | test/update-domain.test.js | 网络请求为 0 |',
    'not a row'
  ].join('\n'))
  assert.deepEqual(rows, [{ ticket: 'D01', priority: 'P0', status: '已实现', tests: ['test/update-domain.test.js'], hardware: '网络请求为 0' }])
  assert.deepEqual(parseRows(''), [])
})
