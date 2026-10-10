const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createImageTargetResolver, createImageFileSaver, PNG_FILTER, SAVE_TITLE } = require('../main/services/image-file-save')

const PICTURES = 'C:/Users/me/Pictures'

// A fake file system: `existing` lists the base names already taken.
function makeSaver({ dialogResult = { canceled: true }, template = '', saveDirectory = 'D:/shots', existing = [] } = {}) {
  const written = []
  const remembered = []
  const ensured = []
  const dialogCalls = []
  const saver = createImageFileSaver({
    dialog: {
      showSaveDialog: async (options) => {
        dialogCalls.push(options)
        return dialogResult
      }
    },
    fs: {
      existsSync: (target) => existing.includes(path.basename(target)),
      promises: { writeFile: async (target, buffer) => written.push({ target, buffer }) }
    },
    ensureDirectory: (directory) => ensured.push(directory),
    getPicturesDirectory: () => PICTURES,
    getSettings: () => ({ screenshot: { saveDirectory, nameTemplate: template } }),
    makeCaptureName: (prefix, ext, nameSettings) => {
      const label = nameSettings?.template ? `_${nameSettings.template}` : ''
      const name = `${prefix}${label}.${ext}`
      return nameSettings?.isTaken?.(name) ? `${prefix}${label}-1.${ext}` : name
    },
    imageDataToBuffer: (value) => Buffer.from(String(value)),
    rememberDirectory: (directory) => remembered.push(directory),
    log: () => {}
  })
  return { saver, written, remembered, ensured, dialogCalls }
}

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

test('the image file saver validates its collaborators', () => {
  // The fs/naming/buffer collaborators have real defaults, so only an explicitly
  // broken injection - or a missing settings/pictures probe - can fail.
  assert.throws(() => createImageFileSaver({ fs: {} }), /requires a file system/)
  assert.throws(() => createImageFileSaver(), /requires getSettings/)
  assert.throws(() => createImageFileSaver({ getSettings: () => ({}) }), /requires a pictures directory probe/)
  assert.throws(
    () => createImageFileSaver({ getSettings: () => ({}), getPicturesDirectory: () => PICTURES, makeCaptureName: null }),
    /requires makeCaptureName/
  )
  assert.throws(
    () => createImageFileSaver({ getSettings: () => ({}), getPicturesDirectory: () => PICTURES, imageDataToBuffer: null }),
    /requires imageDataToBuffer/
  )
})

test('a fast save writes a template-aware, de-duplicated name and remembers the directory', async () => {
  const { saver, written, remembered, ensured } = makeSaver({ template: 'shot' })
  const filePath = await saver(Buffer.from('image'), { fast: true })
  assert.equal(filePath, path.join('D:/shots', 'Highlighter_shot.png'))
  assert.deepEqual(ensured, ['D:/shots'])
  assert.deepEqual(written.map((entry) => entry.target), [filePath])
  assert.equal(written[0].buffer.toString(), 'image')
  assert.deepEqual(remembered, [path.dirname(filePath)])
})

test('a taken name is de-duplicated instead of overwritten', async () => {
  const { saver, written } = makeSaver({ template: 'shot', existing: ['Highlighter_shot.png'] })
  const filePath = await saver(Buffer.from('image'), { fast: true })
  assert.equal(path.basename(filePath), 'Highlighter_shot-1.png')
  assert.equal(written.length, 1)
})

test('an empty template keeps the legacy name', async () => {
  const { saver } = makeSaver()
  assert.equal(path.basename(await saver(Buffer.from('image'), { fast: true })), 'Highlighter.png')
})

test('the dialog branch writes the chosen path and remembers its directory', async () => {
  const { saver, written, remembered, ensured, dialogCalls } = makeSaver({
    dialogResult: { canceled: false, filePath: path.join('E:/picked', 'mine.png') }
  })
  const filePath = await saver(Buffer.from('image'), {})
  assert.equal(filePath, path.join('E:/picked', 'mine.png'))
  assert.deepEqual(ensured, [])
  assert.deepEqual(remembered, [path.dirname(filePath)])
  assert.deepEqual(written.map((entry) => entry.target), [filePath])
  assert.equal(dialogCalls[0].title, SAVE_TITLE)
})

test('a cancelled dialog writes nothing and returns null', async () => {
  const { saver, written, remembered } = makeSaver({ dialogResult: { canceled: true } })
  assert.equal(await saver(Buffer.from('image'), {}), null)
  assert.deepEqual(written, [])
  assert.deepEqual(remembered, [])
})

test('a failing directory memory does not fail the save', async () => {
  const logged = []
  const written = []
  const saver = createImageFileSaver({
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    fs: {
      existsSync: () => false,
      promises: { writeFile: async (target) => written.push(target) }
    },
    ensureDirectory: () => {},
    getPicturesDirectory: () => PICTURES,
    getSettings: () => ({ screenshot: { saveDirectory: 'D:/shots', nameTemplate: '' } }),
    makeCaptureName: (prefix) => `${prefix}.png`,
    imageDataToBuffer: () => Buffer.from('x'),
    rememberDirectory: () => {
      throw new Error('store is read-only')
    },
    log: (...args) => logged.push(args)
  })
  const filePath = await saver(Buffer.from('image'), { fast: true })
  assert.equal(filePath, path.join('D:/shots', 'Highlighter.png'))
  assert.equal(written.length, 1)
  assert.equal(logged.length, 1)
  assert.match(logged[0][0], /last save directory/)
})
