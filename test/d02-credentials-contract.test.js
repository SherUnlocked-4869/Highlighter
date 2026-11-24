const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { SettingsService } = require('../main/services/settings-service')
const { createSensitiveValueCollector } = require('../main/services/diagnostics-bootstrap')
const { createSanitizer } = require('../main/services/diagnostics-service')
const { readConfigSource } = require('./helpers/config-source')

const ROOT = path.resolve(__dirname, '..')
const config = readConfigSource()
const localeSource = fs.readFileSync(path.join(ROOT, 'shared', 'locales', 'config.js'), 'utf8')
const settingsServiceSource = fs.readFileSync(path.join(ROOT, 'main', 'services', 'settings-service.js'), 'utf8')
const credentialStoreSource = fs.readFileSync(path.join(ROOT, 'main', 'services', 'credential-store.js'), 'utf8')

const MARKER = 'sk-D02-SESSIONONLY-MARKER'

class MemoryStore {
  constructor(values = {}) { this.values = new Map(Object.entries(values)) }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback }
  set(key, value) { this.values.set(key, value) }
  delete(key) { this.values.delete(key) }
}

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  }
}

const defaults = { apiKey: '', theme: 'system', system: { autoStart: true }, screenshot: { historyDirectory: 'history' } }

test('D02: a session-only key is absent from persisted settings, diagnostics and backups', () => {
  const store = new MemoryStore()
  const service = new SettingsService({ store, safeStorage: createSafeStorage(false), defaults })
  service.updateSettings({ apiKey: MARKER })

  // 1. The persisted store (the file a backup would copy) never sees the marker.
  assert.equal(JSON.stringify([...store.values.entries()]).includes(MARKER), false)
  // 2. The diagnostics collector sees the live value, so the bundle redacts it...
  const collect = createSensitiveValueCollector({ getStore: () => store, getSettings: () => service.getSettings() })
  const sensitiveValues = collect()
  assert.ok(sensitiveValues.includes(MARKER), 'the collector must know the live session key')
  // 3. ... and the sanitizer actually replaces it in log text and structured records.
  const { sanitizeString, sanitize } = createSanitizer({ sensitiveValues })
  assert.equal(sanitizeString(`request failed with ${MARKER}`).includes(MARKER), false)
  const sanitized = JSON.stringify(sanitize({ message: `boom ${MARKER}`, apiKey: MARKER }))
  assert.equal(sanitized.includes(MARKER), false)
  // The service still works for this run.
  assert.equal(service.getSettings().apiKey, MARKER)
})

test('D02: the settings page is told which credential state it is rendering', () => {
  const store = new MemoryStore()
  const service = new SettingsService({ store, safeStorage: createSafeStorage(false), defaults })
  service.updateSettings({ apiKey: MARKER })
  const pub = service.getPublicSettings()
  assert.equal(typeof pub.credentialState, 'object')
  assert.equal(pub.credentialState.encryptionAvailable, false)
  assert.equal(pub.credentialState.sessionOnly, true)
  assert.equal(JSON.stringify(pub).includes(MARKER), false)

  // The models route explains the state above the provider list instead of pretending
  // the key was saved durably.
  assert.match(config, /function credentialNoticeMarkup\(\)/)
  assert.match(config, /settings\.credentialState/)
  for (const key of ['credential-session-only', 'credential-legacy-plaintext', 'credential-decrypt-failed', 'credential-encryption-failed']) {
    const occurrences = localeSource.split(`config.models.${key}`).length - 1
    assert.equal(occurrences, 3, `config.models.${key} must exist in all three languages`)
    assert.ok(config.includes(`config.models.${key}`), `the models page renders config.models.${key}`)
  }
})

test('D02: the credential store never writes plaintext and verifies migrations before deleting', () => {
  // Static backstop for the two rules that are easy to regress in a later refactor.
  assert.match(credentialStoreSource, /Never fall back to plaintext|never writes a plaintext key/)
  assert.match(credentialStoreSource, /Verify the ciphertext reads back BEFORE removing the plaintext original|Verify the ciphertext reads back/)
  assert.match(settingsServiceSource, /no new plaintext ever reaches the store/)
  assert.match(settingsServiceSource, /publicSettings\.credentialState = this\.credentials\.getCredentialState\(\)/)
})
