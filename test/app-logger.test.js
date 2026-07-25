const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createAppLogger,
  formatLogMessage
} = require('../main/services/app-logger')

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-log-'))
  try {
    return callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('logger redacts credentials and bearer tokens', () => {
  const message = formatLogMessage([
    'request',
    { apiKey: 'sk-secretvalue', nested: { authorization: 'Bearer abc123', safe: 'ok' } },
    'Bearer another-secret'
  ])
  assert.doesNotMatch(message, /secretvalue|abc123|another-secret/)
  assert.match(message, /"apiKey":"\[REDACTED\]"/)
  assert.match(message, /"safe":"ok"/)
})

test('logger rotates files before they exceed the configured size', () => {
  withTempDirectory((directory) => {
    const filePath = path.join(directory, 'app.log')
    fs.writeFileSync(filePath, 'old log content')
    const logger = createAppLogger({
      filePath,
      maxBytes: 20,
      backupCount: 2,
      consoleLike: { log() {}, warn() {} }
    })
    logger('new log content')
    assert.equal(fs.readFileSync(`${filePath}.1`, 'utf8'), 'old log content')
    assert.match(fs.readFileSync(filePath, 'utf8'), /new log content/)
  })
})

test('logger skips disk writes while disabled', () => {
  withTempDirectory((directory) => {
    const filePath = path.join(directory, 'app.log')
    const logger = createAppLogger({
      filePath,
      isEnabled: () => false,
      consoleLike: { log() {}, warn() {} }
    })
    logger('disabled')
    assert.equal(fs.existsSync(filePath), false)
  })
})
