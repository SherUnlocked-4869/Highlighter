'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sourceBuildId } = require('../vendor/selection-hook/scripts/source-build-id')

test('selection-hook resolves to the reviewed source dependency and matching native build', () => {
  const root = path.resolve(__dirname, '..')
  assert.equal(fs.realpathSync(path.dirname(require.resolve('selection-hook'))), fs.realpathSync(path.join(root, 'vendor', 'selection-hook')))
  const SelectionHook = require('selection-hook')
  assert.match(sourceBuildId(), /^hl_[a-f0-9]{64}$/)
  assert.equal(SelectionHook.nativeBuildId, sourceBuildId(), 'Rebuild the addon after native/source configuration changes')
  const hook = new SelectionHook()
  assert.equal(hook.isRunning(), false)
  hook.cleanup()
})
