const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_MODEL_CONFIG_PROBE='

test('feature model editor saves only on demand and replaces stale model options', { timeout: 30000 }, () => {
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-model-config-ui.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }
  })
  assert.equal(
    result.status,
    0,
    `Model config runtime probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Model config runtime probe returned no JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))
  assert.equal(probe.provider, 'provider-b')
  assert.equal(probe.model, 'b-new')
  assert.deepEqual(probe.options, ['b-new'])
  assert.match(probe.buttonText, /未保存更改/)
  assert.equal(probe.updates.length, 1)
  assert.equal(Object.hasOwn(probe.updates[0], 'providers'), false)
  const translation = probe.updates[0].ai.assignments.find((assignment) => assignment.feature === 'toolbar:translate')
  assert.deepEqual(translation, { feature: 'toolbar:translate', providerId: 'provider-b', model: 'b-new' })
})
