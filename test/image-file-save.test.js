const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createImageTargetResolver, PNG_FILTER, SAVE_TITLE } = require('../main/services/image-file-save')

const PICTURES = 'C:/Users/me/Pictures'

function makeResolver({ dialogResult = { canceled: true } } = {}) {
  const calls = { ensure: [], dialog: [] }
  const resolver = createImageTargetResolver({
    dialog: {
      showSaveDialog: async (options) => {
        calls.dialog.push(options)
        return dialogResult
      }
    },
    ensureDirectory: (directory) => calls.ensure.push(directory),
    getPicturesDirectory: () => PICTURES
  })
  return { resolver, calls }
}

test('the image target resolver validates its collaborators', () => {
  assert.throws(() => createImageTargetResolver({}), /requires a dialog/)
  assert.throws(() => createImageTargetResolver({ dialog: {} }), /requires a dialog/)
  assert.throws(() => createImageTargetResolver({ dialog: { showSaveDialog() {} } }), /requires ensureDirectory/)
  assert.throws(
    () => createImageTargetResolver({ dialog: { showSaveDialog() {} }, ensureDirectory() {} }),
    /requires a pictures directory probe/
  )
})

test('a default file name is mandatory', async () => {
  const { resolver } = makeResolver()
  await assert.rejects(() => resolver({}), /default file name/)
})

test('fast save creates the remembered directory and skips the dialog', async () => {
  const { resolver, calls } = makeResolver()
  const target = await resolver({ fast: true, directory: 'D:/shots', defaultName: 'Highlighter_1.png' })
  assert.equal(target, path.join('D:/shots', 'Highlighter_1.png'))
  assert.deepEqual(calls.ensure, ['D:/shots'])
  assert.equal(calls.dialog.length, 0)
})

test('fast save without a remembered directory falls back to the dialog', async () => {
  const { resolver, calls } = makeResolver({ dialogResult: { canceled: false, filePath: 'D:/chosen.png' } })
  const target = await resolver({ fast: true, directory: '', defaultName: 'shot.png' })
  assert.equal(target, 'D:/chosen.png')
  assert.deepEqual(calls.ensure, [])
  assert.equal(calls.dialog.length, 1)
})

test('the dialog receives the PNG filter, the save title, and the pictures fallback', async () => {
  const { resolver, calls } = makeResolver({ dialogResult: { canceled: false, filePath: 'D:/chosen.png' } })
  await resolver({ defaultName: 'shot.png' })
  assert.deepEqual(calls.dialog[0], {
    title: SAVE_TITLE,
    defaultPath: path.join(PICTURES, 'shot.png'),
    filters: [PNG_FILTER]
  })
})

test('an existing directory wins over the pictures fallback', async () => {
  const { resolver, calls } = makeResolver({ dialogResult: { canceled: false, filePath: 'D:/chosen.png' } })
  await resolver({ directory: 'E:/keep', defaultName: 'shot.png' })
  assert.equal(calls.dialog[0].defaultPath, path.join('E:/keep', 'shot.png'))
})

test('cancelling, dismissing, or an empty dialog result yields no target', async () => {
  const cancelled = makeResolver({ dialogResult: { canceled: true } })
  assert.equal(await cancelled.resolver({ defaultName: 'shot.png' }), null)
  const dismissed = makeResolver({ dialogResult: undefined })
  assert.equal(await dismissed.resolver({ defaultName: 'shot.png' }), null)
  const empty = makeResolver({ dialogResult: {} })
  assert.equal(await empty.resolver({ defaultName: 'shot.png' }), null)
})
