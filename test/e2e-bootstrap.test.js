const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { configureE2eEnvironment } = require('../main/services/e2e-bootstrap')

test('E2E bootstrap is explicit, development-only, and uses an isolated absolute data root', (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-e2e-bootstrap-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const paths = new Map()
  let hardwareDisabled = false
  const app = {
    isPackaged: false,
    setPath: (name, value) => paths.set(name, value),
    disableHardwareAcceleration: () => { hardwareDisabled = true }
  }

  assert.deepEqual(configureE2eEnvironment({ app, env: {} }), { enabled: false })
  assert.throws(() => configureE2eEnvironment({
    app,
    env: { HIGHLIGHTER_E2E: '1', HIGHLIGHTER_E2E_DATA_ROOT: 'relative' }
  }), /absolute path/)

  const result = configureE2eEnvironment({
    app,
    env: { HIGHLIGHTER_E2E: '1', HIGHLIGHTER_E2E_DATA_ROOT: dataRoot }
  })
  assert.equal(result.enabled, true)
  assert.equal(result.dataRoot, path.resolve(dataRoot))
  assert.equal(paths.get('userData'), path.resolve(dataRoot))
  assert.equal(paths.get('sessionData'), path.join(path.resolve(dataRoot), 'electron-cache'))
  assert.equal(fs.existsSync(paths.get('sessionData')), true)
  assert.equal(hardwareDisabled, true)

  app.isPackaged = true
  assert.deepEqual(configureE2eEnvironment({ app, env: { HIGHLIGHTER_E2E: '1' } }), { enabled: false })
})
