const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  LOCATOR_NAME,
  PENDING_NAME,
  atomicWriteJson,
  createDataPaths,
  ensureDataLayout,
  ensureDataLayoutSync,
  isNestedPath,
  parseLocator,
  readLocator,
  readLocatorSync,
  resolvePortableDirectory,
  validateDataRoot,
  writeLocator
} = require('../main/services/data-root')
const { LongCaptureSession } = require('../main/services/long-capture-session')
const { OcrService } = require('../main/services/ocr-service')

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-data-root-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

function fakeApp(legacyUserData) {
  const values = { userData: legacyUserData, sessionData: path.join(legacyUserData, 'Session Storage') }
  return {
    getPath: (name) => values[name],
    setPath: (name, value) => { values[name] = value },
    values
  }
}

function expectedDataPaths(root) {
  const absoluteRoot = path.resolve(root)
  return {
    root: absoluteRoot,
    config: path.join(absoluteRoot, 'config'),
    logs: path.join(absoluteRoot, 'logs'),
    history: path.join(absoluteRoot, 'history'),
    cache: path.join(absoluteRoot, 'cache'),
    electronCache: path.join(absoluteRoot, 'cache', 'electron'),
    ocrCache: path.join(absoluteRoot, 'cache', 'ocr'),
    recordingCache: path.join(absoluteRoot, 'cache', 'recordings'),
    longCaptureCache: path.join(absoluteRoot, 'cache', 'long-capture'),
    runtime: path.join(absoluteRoot, 'runtime')
  }
}

async function assertDirectories(paths) {
  for (const directory of Object.values(paths)) {
    assert.equal((await fsp.stat(directory)).isDirectory(), true, directory)
  }
}

test('injects the managed OCR cache directory', async (t) => {
  const parent = await temporaryRoot(t)
  const ocrTemp = path.join(parent, 'managed', 'ocr')

  const service = new OcrService({ sidecarPath: 'sidecar', modelDir: 'models', tempDir: ocrTemp })

  assert.equal(service.tempDir, path.resolve(ocrTemp))
})

test('requires a managed OCR cache directory', () => {
  assert.throws(
    () => new OcrService({ sidecarPath: 'sidecar', modelDir: 'models' }),
    /OCR 临时目录不能为空/
  )
})

test('creates long-capture sessions under the managed cache directory', async (t) => {
  const parent = await temporaryRoot(t)
  const longTemp = path.join(parent, 'managed', 'long-capture')
  let session

  try {
    session = new LongCaptureSession({ tempRoot: longTemp })
    assert.equal(session.directory.startsWith(`${path.resolve(longTemp)}${path.sep}`), true)
  } finally {
    session?.cleanup()
  }
})

test('requires a managed long-capture cache directory', () => {
  assert.throws(() => new LongCaptureSession(), /长截图临时目录不能为空/)
})

test('creates the exact documented managed data layout', async (t) => {
  const parent = await temporaryRoot(t)
  const root = path.join(parent, 'selected')
  const paths = createDataPaths(root)

  assert.deepEqual(paths, expectedDataPaths(root))
  assert.equal(await ensureDataLayout(paths), paths)
  await assertDirectories(paths)
})

test('creates the managed data layout synchronously', async (t) => {
  const parent = await temporaryRoot(t)
  const paths = createDataPaths(path.join(parent, 'sync-selected'))

  assert.equal(ensureDataLayoutSync(paths), paths)
  await assertDirectories(paths)
})

test('writes, replaces, and reads a versioned locator without temporary artifacts', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  const firstRoot = path.join(portableDirectory, 'first-data')
  const dataRoot = path.join(portableDirectory, 'data')

  await writeLocator(locatorPath, firstRoot)
  const locator = await writeLocator(locatorPath, dataRoot)

  assert.deepEqual(locator, { version: 1, dataRoot: path.resolve(dataRoot) })
  assert.deepEqual(await readLocator(locatorPath), locator)
  assert.deepEqual(readLocatorSync(locatorPath), locator)
  assert.deepEqual(JSON.parse(await fsp.readFile(locatorPath, 'utf8')), locator)
  assert.deepEqual(
    (await fsp.readdir(portableDirectory)).filter((name) => name.startsWith(`${LOCATOR_NAME}.`)),
    []
  )
})

test('atomic JSON writes create their parent directory', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, 'nested', PENDING_NAME)

  await atomicWriteJson(target, { pending: true })

  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { pending: true })
})

test('atomic JSON writes use a backup when replacement is blocked by Windows semantics', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, LOCATOR_NAME)
  const calls = []
  let firstRename = true
  await fsp.writeFile(target, JSON.stringify({ dataRoot: 'old' }))

  await atomicWriteJson(target, { dataRoot: 'new' }, {
    ...fsp,
    async rename(from, to) {
      calls.push([from, to])
      if (firstRename) {
        firstRename = false
        const error = new Error('target is in use')
        error.code = 'EPERM'
        throw error
      }
      return fsp.rename(from, to)
    }
  })

  assert.equal(calls.length, 3)
  assert.match(calls[1][1], /\.bak$/)
  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { dataRoot: 'new' })
})

test('atomic JSON writes restore the original file when backup replacement fails', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, LOCATOR_NAME)
  let renameCount = 0
  await fsp.writeFile(target, JSON.stringify({ dataRoot: 'old' }))

  await assert.rejects(
    atomicWriteJson(target, { dataRoot: 'new' }, {
      ...fsp,
      async rename(from, to) {
        renameCount += 1
        if (renameCount === 1) {
          const error = new Error('target is in use')
          error.code = 'EEXIST'
          throw error
        }
        if (renameCount === 3) throw new Error('replacement failed')
        return fsp.rename(from, to)
      }
    }),
    /replacement failed/
  )

  assert.equal(renameCount, 4)
  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { dataRoot: 'old' })
})

test('atomic JSON writes retain an undeletable backup after a successful replacement', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, LOCATOR_NAME)
  let firstRename = true
  let backupRemovalAttempts = 0
  await fsp.writeFile(target, JSON.stringify({ dataRoot: 'old' }))

  await atomicWriteJson(target, { dataRoot: 'new' }, {
    ...fsp,
    async rename(from, to) {
      if (firstRename) {
        firstRename = false
        const error = new Error('target is in use')
        error.code = 'EPERM'
        throw error
      }
      return fsp.rename(from, to)
    },
    async rm(filePath, options) {
      if (filePath.endsWith('.bak')) {
        backupRemovalAttempts += 1
        const error = new Error('backup is locked')
        error.code = 'EPERM'
        throw error
      }
      return fsp.rm(filePath, options)
    }
  })

  assert.equal(backupRemovalAttempts, 1)
  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { dataRoot: 'new' })
})

test('rejects malformed locators and relative locator roots', () => {
  assert.throws(() => parseLocator(null), /引导文件无效/)
  assert.throws(() => parseLocator({ version: 2, dataRoot: path.resolve('data') }), /引导文件无效/)
  assert.throws(() => parseLocator({ version: 1, dataRoot: 'relative-data' }), /引导文件无效/)
})

test('resolves only an electron-builder portable directory', () => {
  assert.equal(resolvePortableDirectory({}), '')
  assert.equal(resolvePortableDirectory({ PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' }), path.resolve('D:\\Apps'))
})

test('detects equal and descendant paths without matching siblings', () => {
  const root = path.resolve('selected-root')

  assert.equal(isNestedPath(root, root), true)
  assert.equal(isNestedPath(root, path.join(root, 'child')), true)
  assert.equal(isNestedPath(root, `${root}-sibling`), false)
})

test('rejects blank and relative data roots', async () => {
  await assert.rejects(validateDataRoot(''), /绝对路径/)
  await assert.rejects(validateDataRoot('relative-data'), /绝对路径/)
})

test('rejects source and destination containment in either direction', async (t) => {
  const parent = await temporaryRoot(t)
  const source = path.join(parent, 'source')
  const child = path.join(source, 'child')
  await fsp.mkdir(child, { recursive: true })

  await assert.rejects(validateDataRoot(child, source), /不能互相包含/)
  await assert.rejects(validateDataRoot(source, child), /不能互相包含/)
  await assert.rejects(validateDataRoot(source, source), /不能互相包含/)
})

test('requires an absolute source data root and permits disjoint absolute roots', async (t) => {
  const parent = await temporaryRoot(t)
  const source = path.join(parent, 'source')
  const target = path.join(parent, 'target')
  await fsp.mkdir(source)

  await assert.rejects(validateDataRoot(target, 'relative-source'), /旧数据目录必须是绝对路径/)
  assert.equal(await validateDataRoot(target, source), path.resolve(target))
})

test('rejects a selected symlink or Windows junction', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, 'target')
  const link = path.join(parent, 'link')
  await fsp.mkdir(target)
  try {
    await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction requires unavailable privileges')
      return
    }
    throw error
  }

  await assert.rejects(validateDataRoot(link), /符号链接或目录联接/)
})

test('rejects a child of a symlink or Windows junction before creating it in the target', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, 'target')
  const link = path.join(parent, 'link')
  const selectedChild = path.join(link, 'created-before-rejection')
  const physicalChild = path.join(target, 'created-before-rejection')
  await fsp.mkdir(target)
  try {
    await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction requires unavailable privileges')
      return
    }
    throw error
  }

  await assert.rejects(validateDataRoot(selectedChild), /符号链接或目录联接/)
  assert.equal(fs.existsSync(physicalChild), false)
})

test('rejects a source symlink or Windows junction that aliases the target parent', async (t) => {
  const parent = await temporaryRoot(t)
  const physicalSource = path.join(parent, 'source')
  const sourceLink = path.join(parent, 'source-link')
  const target = path.join(physicalSource, 'target')
  await fsp.mkdir(physicalSource)
  try {
    await fsp.symlink(physicalSource, sourceLink, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction requires unavailable privileges')
      return
    }
    throw error
  }

  await assert.rejects(validateDataRoot(target, sourceLink), /符号链接或目录联接/)
  assert.equal(fs.existsSync(target), false)
})

test('validates writable roots and removes its write probe', async (t) => {
  const parent = await temporaryRoot(t)
  const root = path.join(parent, 'selected')

  assert.equal(await validateDataRoot(root), path.resolve(root))
  assert.equal(fs.existsSync(root), true)
  assert.deepEqual(
    (await fsp.readdir(root)).filter((name) => name.startsWith('.highlighter-write-')),
    []
  )
})

test('applies located portable paths before Electron readiness', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const root = path.join(portableDirectory, 'selected')
  await writeLocator(path.join(portableDirectory, LOCATOR_NAME), root)
  const app = fakeApp(path.join(portableDirectory, 'legacy'))
  const { prepareDataRoot } = require('../main/services/data-root-bootstrap')
  const context = prepareDataRoot({ app, env: { PORTABLE_EXECUTABLE_DIR: portableDirectory } })
  assert.equal(context.needsSelection, false)
  assert.equal(app.values.userData, path.join(root, 'runtime'))
  assert.equal(app.values.sessionData, path.join(root, 'cache', 'electron'))
})

test('uses OS temp provisionally when no locator exists', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const bootstrapTemp = await temporaryRoot(t)
  const app = fakeApp(path.join(portableDirectory, 'legacy'))
  const { prepareDataRoot } = require('../main/services/data-root-bootstrap')
  const context = prepareDataRoot({ app, env: { PORTABLE_EXECUTABLE_DIR: portableDirectory }, tempRoot: bootstrapTemp })
  assert.equal(context.needsSelection, true)
  assert.equal(context.legacyUserData, path.join(portableDirectory, 'legacy'))
  assert.match(app.values.userData, /highlighter-bootstrap-/)
  assert.equal(app.values.userData.startsWith(bootstrapTemp), true)
})

test('falls back when located Electron paths are not writable', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const bootstrapTemp = await temporaryRoot(t)
  const root = path.join(portableDirectory, 'selected')
  const legacyUserData = path.join(portableDirectory, 'legacy')
  const denied = new Error('access denied')
  denied.code = 'EACCES'
  await writeLocator(path.join(portableDirectory, LOCATOR_NAME), root)
  const app = fakeApp(legacyUserData)
  const { prepareDataRoot, removeProvisionalRoot } = require('../main/services/data-root-bootstrap')
  const fileSystem = {
    ...fs,
    writeFileSync(filePath, ...args) {
      if (filePath.startsWith(path.join(root, 'runtime'))) throw denied
      return fs.writeFileSync(filePath, ...args)
    }
  }

  const context = prepareDataRoot({
    app,
    env: { PORTABLE_EXECUTABLE_DIR: portableDirectory },
    tempRoot: bootstrapTemp,
    fileSystem
  })
  t.after(() => removeProvisionalRoot(context))

  assert.equal(context.needsSelection, true)
  assert.equal(context.requestedRoot, root)
  assert.equal(context.startupError, denied)
  assert.equal(app.values.userData.startsWith(bootstrapTemp), true)
})

test('verifies located Electron paths with probes and removes the probe files', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const root = path.join(portableDirectory, 'selected')
  const app = fakeApp(path.join(portableDirectory, 'legacy'))
  const probedDirectories = []
  await writeLocator(path.join(portableDirectory, LOCATOR_NAME), root)
  const { prepareDataRoot } = require('../main/services/data-root-bootstrap')
  const fileSystem = {
    ...fs,
    writeFileSync(filePath, ...args) {
      probedDirectories.push(path.dirname(filePath))
      return fs.writeFileSync(filePath, ...args)
    }
  }

  const context = prepareDataRoot({ app, env: { PORTABLE_EXECUTABLE_DIR: portableDirectory }, fileSystem })

  assert.deepEqual(probedDirectories, [context.paths.runtime, context.paths.electronCache])
  assert.deepEqual(await fsp.readdir(context.paths.runtime), [])
  assert.deepEqual(await fsp.readdir(context.paths.electronCache), [])
})

test('preserves malformed locator errors for startup handling', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const bootstrapTemp = await temporaryRoot(t)
  const app = fakeApp(path.join(portableDirectory, 'legacy'))
  await fsp.writeFile(path.join(portableDirectory, LOCATOR_NAME), JSON.stringify({ version: 2, dataRoot: 'invalid' }))
  const { prepareDataRoot, removeProvisionalRoot } = require('../main/services/data-root-bootstrap')

  const context = prepareDataRoot({
    app,
    env: { PORTABLE_EXECUTABLE_DIR: portableDirectory },
    tempRoot: bootstrapTemp
  })
  t.after(() => removeProvisionalRoot(context))

  assert.equal(context.needsSelection, true)
  assert.equal(context.requestedRoot, '')
  assert.match(context.startupError.message, /引导文件无效/)
})

test('leaves Electron paths unchanged outside portable mode', () => {
  const legacyUserData = path.resolve('legacy-user-data')
  const app = fakeApp(legacyUserData)
  const originalValues = { ...app.values }
  const { prepareDataRoot } = require('../main/services/data-root-bootstrap')

  assert.deepEqual(prepareDataRoot({ app, env: {} }), {
    portable: false,
    legacyUserData,
    paths: null,
    needsSelection: false
  })
  assert.deepEqual(app.values, originalValues)
})

test('removes provisional roots idempotently', async (t) => {
  const parent = await temporaryRoot(t)
  const provisionalRoot = path.join(parent, 'provisional')
  await fsp.mkdir(provisionalRoot)
  const { removeProvisionalRoot } = require('../main/services/data-root-bootstrap')

  assert.equal(removeProvisionalRoot(null), true)
  assert.equal(removeProvisionalRoot({}), true)
  assert.equal(removeProvisionalRoot({ provisionalRoot }), true)
  assert.equal(fs.existsSync(provisionalRoot), false)
  assert.equal(removeProvisionalRoot({ provisionalRoot }), true)
})

test('returns false instead of throwing when provisional cleanup is blocked', () => {
  const cleanupError = new Error('directory is busy')
  cleanupError.code = 'EBUSY'
  const { removeProvisionalRoot } = require('../main/services/data-root-bootstrap')

  assert.equal(removeProvisionalRoot({ provisionalRoot: path.resolve('locked-bootstrap') }, {
    rmSync() { throw cleanupError }
  }), false)
})

test('cleans the provisional root before rethrowing initialization errors', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const bootstrapTemp = await temporaryRoot(t)
  const applyError = new Error('cannot apply Electron paths')
  const app = fakeApp(path.join(portableDirectory, 'legacy'))
  app.setPath = () => { throw applyError }
  let provisionalRoot = ''
  let cleanupAttempts = 0
  const fileSystem = {
    ...fs,
    mkdtempSync(prefix) {
      provisionalRoot = fs.mkdtempSync(prefix)
      return provisionalRoot
    },
    rmSync(target, options) {
      if (target === provisionalRoot) cleanupAttempts += 1
      return fs.rmSync(target, options)
    }
  }
  const { prepareDataRoot } = require('../main/services/data-root-bootstrap')

  assert.throws(() => prepareDataRoot({
    app,
    env: { PORTABLE_EXECUTABLE_DIR: portableDirectory },
    tempRoot: bootstrapTemp,
    fileSystem
  }), (error) => error === applyError)
  assert.equal(cleanupAttempts, 1)
  assert.equal(fs.existsSync(provisionalRoot), false)
})
