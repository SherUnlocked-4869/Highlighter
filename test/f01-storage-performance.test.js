// F01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md, section 3.1):
// settings, log and history storage must stop re-reading config.json synchronously, re-parsing
// JSON and re-decrypting the same DPAPI blobs on every read. These tests drive the real services
// with counting fakes and assert on observable call counts, not on source text.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { SettingsService } = require('../main/services/settings-service')
const { createAppLogger } = require('../main/services/app-logger')
const { HistoryService } = require('../main/services/history-service')

const ROOT = path.resolve(__dirname, '..')

class CountingStore {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values))
    this.getKeys = []
    this.setCalls = 0
  }

  get(key, fallback) {
    this.getKeys.push(key)
    return this.values.has(key) ? this.values.get(key) : fallback
  }

  set(key, value) {
    this.setCalls += 1
    this.values.set(key, value)
  }

  delete(key) {
    this.values.delete(key)
  }

  resetCounters() {
    this.getKeys = []
    this.setCalls = 0
  }
}

function createCountingSafeStorage(available = true) {
  const calls = { decrypt: 0, encrypt: 0, availabilityChecks: 0 }
  return {
    calls,
    safeStorage: {
      isEncryptionAvailable: () => { calls.availabilityChecks += 1; return available },
      encryptString(value) { calls.encrypt += 1; return Buffer.from(`encrypted:${value}`) },
      decryptString(value) { calls.decrypt += 1; return value.toString().replace(/^encrypted:/, '') }
    }
  }
}

function ciphertext(value) {
  return Buffer.from(`encrypted:${value}`).toString('base64')
}

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-f01-'))
  try {
    return callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// A settings service seeded the way a real profile looks after the user saved keys: the master
// key and two provider keys live as DPAPI ciphertexts, the plaintext only exists in the store's
// credential keys (never in `settings`).
function createSeededSettings() {
  const providers = [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.example', apiKey: '', models: [] },
    { id: 'jbb', name: 'JBB', baseUrl: 'https://api.jbb.example', apiKey: '', models: [] }
  ]
  const store = new CountingStore({
    settings: { theme: 'system', providers: providers.map((provider) => ({ ...provider })) },
    'credentials.apiKey': ciphertext('sk-master'),
    'credentials.providerApiKeys': {
      deepseek: ciphertext('sk-deepseek'),
      jbb: ciphertext('sk-jbb')
    },
    'credentials.providerEndpoints': {
      deepseek: 'https://api.deepseek.example',
      jbb: 'https://api.jbb.example'
    }
  })
  const { safeStorage, calls } = createCountingSafeStorage()
  const service = new SettingsService({
    store,
    safeStorage,
    defaults: {
      apiKey: '',
      theme: 'system',
      providers: providers.map((provider) => ({ ...provider, apiKey: '' }))
    }
  })
  store.resetCounters()
  calls.decrypt = 0
  calls.encrypt = 0
  return { store, service, calls }
}

test('F01: a second getSettings() is a memory snapshot and never re-reads the store', () => {
  const { store, service, calls } = createSeededSettings()

  const first = service.getSettings()
  const firstReads = store.getKeys.length
  const firstDecrypts = calls.decrypt
  assert.equal(first.apiKey, 'sk-master')
  assert.deepEqual(first.providers.map((provider) => provider.apiKey), ['sk-deepseek', 'sk-jbb'])
  assert.ok(firstReads > 0, 'the first read has to populate the snapshot from the store')
  assert.ok(firstDecrypts > 0, 'the first read has to decrypt the stored credentials')

  store.resetCounters()
  calls.decrypt = 0
  const second = service.getSettings()
  assert.deepEqual(second, first)
  assert.equal(store.getKeys.length, 0, 'the second getSettings() must not call store.get()')
  assert.equal(calls.decrypt, 0, 'the second getSettings() must not decrypt anything again')
})

test('F01: one settings pass decrypts each credential blob once, not three times', () => {
  const { service, calls } = createSeededSettings()
  const credentialCount = 3 // master + two providers

  const settings = service.getSettings()
  assert.equal(settings.apiKey, 'sk-master')
  const afterSettings = calls.decrypt
  assert.equal(afterSettings, credentialCount, 'one decrypt per stored blob')

  // The old path re-read settings and re-decrypted every blob inside getCredentialState(), so
  // getSettings() + getPublicSettings() cost 3 x credentialCount. The public state now reuses
  // the pass the settings read already performed.
  const publicSettings = service.getPublicSettings()
  assert.equal(publicSettings.hasApiKey, true)
  assert.equal(publicSettings.credentialState.encryptionAvailable, true)
  assert.equal(publicSettings.credentialState.decryptFailed, false)
  assert.equal(calls.decrypt, credentialCount, 'getPublicSettings() must add no DPAPI calls')

  service.getSettings()
  assert.equal(calls.decrypt, credentialCount, 'a repeated read stays on the snapshot')
})

test('F01: settings and session-only credential writes invalidate the snapshot', () => {
  const { store, service } = createSeededSettings()
  assert.equal(service.getSettings().theme, 'system')

  store.resetCounters()
  service.updateSettings({ theme: 'dark' })
  assert.ok(store.setCalls >= 1, 'the update has to reach the store')
  assert.equal(service.getSettings().theme, 'dark', 'the write must be visible immediately')

  // A session override (the value the user typed when it could not be persisted) is the
  // effective credential, so the cached snapshot must be dropped even though the store did not
  // change for it.
  const { safeStorage } = createCountingSafeStorage(false)
  const unavailableStore = new CountingStore({ settings: {} })
  const unavailable = new SettingsService({
    store: unavailableStore,
    safeStorage,
    defaults: { apiKey: '', theme: 'system' }
  })
  assert.equal(unavailable.getSettings().apiKey, '')
  unavailable.updateSettings({ apiKey: 'sk-session-only' })
  assert.equal(unavailable.getSettings().apiKey, 'sk-session-only')
  assert.equal(unavailable.getPublicSettings().hasApiKey, true)
  unavailable.updateSettings({ apiKey: '' })
  assert.equal(unavailable.getSettings().apiKey, '', 'clearing the key must not serve the old snapshot')
  assert.equal(unavailable.getPublicSettings().credentialState.sessionOnly, false)
})

test('F01: explicit out-of-band invalidation drops a snapshot built before the store changed', () => {
  const { store, service } = createSeededSettings()
  assert.equal(service.getSettings().theme, 'system')
  // Simulate a migration that edits config.json behind the service's back: the snapshot is
  // stale until the writer explicitly invalidates it.
  store.values.set('settings', { ...store.values.get('settings'), theme: 'light' })
  assert.equal(service.getSettings().theme, 'system')
  service.invalidateSettingsCache()
  assert.equal(service.getSettings().theme, 'light')
})

function createCountingFileSystem(initialFiles = new Map()) {
  const files = new Map(initialFiles)
  const calls = { mkdirSync: 0, existsSync: 0, statSync: 0, appendFileSync: 0, renameSync: 0, rmSync: 0 }
  const missing = (filePath) => {
    const error = new Error(`ENOENT: ${filePath}`)
    error.code = 'ENOENT'
    return error
  }
  const fileSystem = {
    mkdirSync() { calls.mkdirSync += 1 },
    existsSync(filePath) { calls.existsSync += 1; return files.has(filePath) },
    statSync(filePath) {
      calls.statSync += 1
      if (!files.has(filePath)) throw missing(filePath)
      return { size: files.get(filePath).length }
    },
    appendFileSync(filePath, data) {
      calls.appendFileSync += 1
      files.set(filePath, (files.get(filePath) || '') + data)
    },
    renameSync(source, destination) {
      calls.renameSync += 1
      if (!files.has(source)) throw missing(source)
      files.set(destination, files.get(source))
      files.delete(source)
    },
    rmSync(filePath) { calls.rmSync += 1; files.delete(filePath) }
  }
  return { fileSystem, files, calls }
}

test('F01: app-logger creates the directory and stats the file once, then one append per line', () => {
  const { fileSystem, files, calls } = createCountingFileSystem()
  const logger = createAppLogger({
    filePath: 'C:/fake/logs/app.log',
    fileSystem,
    consoleLike: null,
    now: () => new Date('2026-11-26T12:00:00.000Z')
  })

  logger('line 1')
  const afterFirst = { ...calls }
  assert.equal(afterFirst.mkdirSync, 1, 'the directory is created once per process')
  assert.equal(afterFirst.statSync, 1, 'the file size is seeded once at startup')
  assert.equal(afterFirst.appendFileSync, 1)
  assert.equal(afterFirst.existsSync, 0, 'no per-line existence probe')

  for (let index = 2; index <= 10; index += 1) logger(`line ${index}`)
  assert.equal(calls.mkdirSync, 1, 'no mkdir per line')
  assert.equal(calls.statSync, 1, 'no stat per line')
  assert.equal(calls.existsSync, 0, 'rotation was never needed, so no existence probes either')
  assert.equal(calls.appendFileSync, 10, 'exactly one append per line')
  assert.equal(calls.renameSync, 0)
  assert.equal(calls.rmSync, 0)

  const written = files.get('C:/fake/logs/app.log')
  assert.equal(written.trim().split('\n').length, 10, 'the last line is not lost')
  assert.match(written, /"message":"line 10"/)

  // Redaction through the single sanitization step still applies to both message and details.
  logger('token=sk-secret-value', { apiKey: 'sk-details-value' })
  const lastLine = files.get('C:/fake/logs/app.log').trim().split('\n').pop()
  assert.doesNotMatch(lastLine, /sk-secret-value|sk-details-value/)
  assert.match(lastLine, /\[REDACTED\]/)
})

test('F01: app-logger rotates from the startup size and still appends one line', () => {
  const { fileSystem, files, calls } = createCountingFileSystem(new Map([['C:/fake/logs/app.log', 'x'.repeat(300)]]))
  const logger = createAppLogger({
    filePath: 'C:/fake/logs/app.log',
    maxBytes: 200,
    backupCount: 2,
    fileSystem,
    consoleLike: null,
    now: () => new Date('2026-11-26T12:00:00.000Z')
  })

  logger('after rotation')
  assert.equal(calls.statSync, 1, 'the existing file is measured once, at startup')
  assert.equal(calls.renameSync >= 1, true, 'the oversized file is rotated before the append')
  assert.equal(files.get('C:/fake/logs/app.log.1'), 'x'.repeat(300))
  assert.match(files.get('C:/fake/logs/app.log'), /after rotation/)
})

function createHistoryService(directory, history) {
  return new HistoryService({
    store: {
      get: (key, fallback) => (key === 'captureHistory' ? history : fallback),
      set: () => {}
    },
    nativeImage: {},
    sharp: () => {},
    getSettings: () => ({ screenshot: { historyDirectory: directory, historyEnabled: true, historyLimit: 200 } }),
    assertWritable: () => {},
    defaultHistoryDirectory: directory,
    makeCaptureName: () => 'capture.png'
  })
}

function countExistsSync(callback) {
  const original = fs.existsSync
  let calls = 0
  fs.existsSync = (...args) => { calls += 1; return original(...args) }
  try {
    return { result: callback(), calls }
  } finally {
    fs.existsSync = original
  }
}

test('F01: HistoryService.list probes only the page it returns, not the whole index', () => {
  withTempDirectory((directory) => {
    const filePath = path.join(directory, 'capture.png')
    fs.writeFileSync(filePath, 'image')
    const history = Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      filePath,
      source: 'capture',
      action: 'copy'
    }))
    const service = createHistoryService(directory, history)

    const first = countExistsSync(() => service.list({ limit: 40 }))
    assert.equal(first.result.items.length, 40)
    assert.equal(first.result.totalCount, 200)
    assert.equal(first.result.hasMore, true)
    assert.equal(first.calls, 40, 'only the 40 returned records may hit the filesystem')

    const second = countExistsSync(() => service.list({ cursor: first.result.nextCursor, limit: 40 }))
    assert.deepEqual(second.result.items.map((item) => item.id).slice(0, 2), ['40', '41'])
    assert.equal(second.calls, 40)
  })
})

test('F01: list() skips records whose file vanished without probing the rest of the index', () => {
  withTempDirectory((directory) => {
    const filePath = path.join(directory, 'capture.png')
    fs.writeFileSync(filePath, 'image')
    const history = Array.from({ length: 60 }, (_, index) => ({
      id: String(index),
      filePath: index < 5 ? path.join(directory, `gone-${index}.png`) : filePath,
      source: 'capture'
    }))
    const service = createHistoryService(directory, history)

    const { result, calls } = countExistsSync(() => service.list({ limit: 40 }))
    assert.equal(result.items.length, 40)
    assert.equal(result.items[0].id, '5', 'missing records are skipped, not returned')
    assert.equal(result.totalCount, 60, 'totalCount is the metadata index size now')
    assert.equal(calls, 45, 'five misses plus the forty returned records')
    assert.ok(calls < history.length, 'the probe must not walk the whole index')
  })
})

test('F01: main.js runLog gate reads the cached settings snapshot, not the store per line', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const predicate = mainSource.split(/\r?\n/).find((line) => line.includes('isEnabled:'))
  assert.ok(predicate, 'main.js must still wire the log gate')
  assert.match(predicate, /isEnabled: \(\) => !dataRootMigrationInProgress/)
  assert.match(predicate, /settingsService\?\.getSettings\(\)\.system\?\.runLog/)
  assert.doesNotMatch(predicate, /store\.get\('settings'/, 'the per-line store read is the bug this replaces')
})
