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
  readLocator,
  writeLocator
} = require('../main/services/data-root')

const {
  createLegacySourcePaths,
  createManagedSourcePaths,
  migrateDataRoot,
  rewriteConfig,
  rollbackPendingMigration,
  verifyAndFinalizeMigration,
  cleanupManagedSource
} = require('../main/services/data-root-migration')

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-migration-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

async function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false)
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function countFiles(directory) {
  let count = 0
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(child)
      else count += 1
    }
  }
  if (await exists(directory)) await walk(directory)
  return count
}

test('exports the data root migration API', () => {
  assert.equal(typeof migrateDataRoot, 'function')
})

test('defines exact legacy and managed source cleanup boundaries', async (t) => {
  const parent = await temporaryRoot(t)
  const legacyRoot = path.join(parent, 'legacy')
  const managedRoot = path.join(parent, 'managed')
  const managedLayout = createDataPaths(managedRoot)

  assert.deepEqual(createLegacySourcePaths(legacyRoot), {
    root: path.resolve(legacyRoot),
    configFile: path.join(path.resolve(legacyRoot), 'config.json'),
    logFile: path.join(path.resolve(legacyRoot), 'app.log'),
    history: path.join(path.resolve(legacyRoot), 'capture-history'),
    cleanupFiles: [path.join(path.resolve(legacyRoot), 'config.json'), path.join(path.resolve(legacyRoot), 'app.log')],
    cleanupDirectories: [path.join(path.resolve(legacyRoot), 'capture-history'), path.join(path.resolve(legacyRoot), 'temp', 'recordings')]
  })
  assert.deepEqual(createManagedSourcePaths(managedRoot), {
    root: managedLayout.root,
    configFile: path.join(managedLayout.config, 'config.json'),
    logFile: path.join(managedLayout.logs, 'app.log'),
    history: managedLayout.history,
    cleanupFiles: [],
    cleanupDirectories: [managedLayout.config, managedLayout.logs, managedLayout.history, managedLayout.cache, managedLayout.runtime]
  })
})

test('rewrites only history-internal config paths', async (t) => {
  const parent = await temporaryRoot(t)
  const source = createLegacySourcePaths(path.join(parent, 'legacy'))
  const target = createManagedSourcePaths(path.join(parent, 'managed'))
  const config = {
    settings: { screenshot: { historyDirectory: source.history } },
    captureHistory: [
      { filePath: path.join(source.history, 'a.png'), thumbnailPath: 'thumbs/a.png' },
      { filePath: path.join(parent, 'external', 'b.png'), thumbnailPath: '' }
    ]
  }
  const rewritten = rewriteConfig(config, source, target)

  assert.equal(rewritten.settings.screenshot.historyDirectory, target.history)
  assert.equal(rewritten.captureHistory[0].filePath, path.join(target.history, 'a.png'))
  assert.equal(rewritten.captureHistory[0].thumbnailPath, path.join(target.history, 'thumbs', 'a.png'))
  assert.equal(rewritten.captureHistory[1].filePath, path.join(parent, 'external', 'b.png'))
})

test('migrates legacy config, log, and history transactionally', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createDataPaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.mkdir(path.join(sourceRoot, 'temp', 'recordings'), { recursive: true })
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.mkdir(path.join(source.history, 'nested'), { recursive: true })
  await fsp.writeFile(path.join(source.history, 'nested', 'two.png'), 'two')
  await fsp.writeFile(path.join(sourceRoot, 'temp', 'recordings', 'cache.tmp'), 'cache')
  await fsp.writeFile(source.logFile, 'log')
  await writeJson(source.configFile, {
    settings: { screenshot: { historyDirectory: source.history } },
    captureHistory: [{ filePath: path.join(source.history, 'one.png'), thumbnailPath: path.join(source.history, 'nested', 'two.png') }]
  })
  await fsp.mkdir(portableDirectory, { recursive: true })
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  await writeLocator(locatorPath, sourceRoot)

  const result = await migrateDataRoot({ source, target, portableDirectory })

  assert.equal(result.locatorPath, locatorPath)
  assert.ok(result.migrationId)
  assert.deepEqual(await readLocator(locatorPath), { version: 1, dataRoot: path.resolve(targetRoot) })
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(target.config, 'config.json'), 'utf8')), {
    settings: { screenshot: { historyDirectory: target.history } },
    captureHistory: [{ filePath: path.join(target.history, 'one.png'), thumbnailPath: path.join(target.history, 'nested', 'two.png') }]
  })
  assert.equal(await fsp.readFile(path.join(target.logs, 'app.log'), 'utf8'), 'log')
  assert.equal(await countFiles(target.history), 2)
  assert.equal(await exists(path.join(targetRoot, 'cache', 'recordings', 'cache.tmp')), false)
  assert.equal(await exists(path.join(portableDirectory, PENDING_NAME)), true)
})

test('copy failure leaves source, locator, pending, and target clean', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createManagedSourcePaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.writeFile(source.logFile, 'log')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  await writeLocator(locatorPath, sourceRoot)
  const originalLocator = await fsp.readFile(locatorPath, 'utf8')

  await assert.rejects(migrateDataRoot({
    source,
    target,
    portableDirectory,
    copyFile: async () => { throw new Error('copy failed') }
  }), /copy failed/)

  assert.equal(await fsp.readFile(source.logFile, 'utf8'), 'log')
  assert.equal(await fsp.readFile(locatorPath, 'utf8'), originalLocator)
  assert.equal(await exists(path.join(portableDirectory, PENDING_NAME)), false)
  assert.equal(await exists(targetRoot), true)
  assert.deepEqual(await fsp.readdir(targetRoot), [])
})

test('locator publication failure removes this migration marker and target data', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createDataPaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  await writeLocator(locatorPath, sourceRoot)

  await assert.rejects(migrateDataRoot({
    source,
    target,
    portableDirectory,
    writeLocatorFile: async () => { throw new Error('locator failed') }
  }), /locator failed/)

  assert.equal(await exists(path.join(targetRoot, '.migration.json')), false)
  assert.deepEqual(await fsp.readdir(targetRoot), [])
  assert.equal(await exists(path.join(portableDirectory, PENDING_NAME)), false)
  assert.deepEqual(await readLocator(locatorPath), { version: 1, dataRoot: path.resolve(sourceRoot) })
})

test('finalization cleans declared source paths but retains unrelated files', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createManagedSourcePaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.mkdir(path.join(sourceRoot, 'temp', 'recordings'), { recursive: true })
  await fsp.writeFile(source.configFile, '{}')
  await fsp.writeFile(source.logFile, 'log')
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.writeFile(path.join(sourceRoot, 'keep.txt'), 'keep')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  await writeLocator(locatorPath, sourceRoot)
  await migrateDataRoot({ source, target, portableDirectory, previousRoot: sourceRoot })

  const result = await verifyAndFinalizeMigration({
    pendingPath: path.join(portableDirectory, PENDING_NAME),
    activeRoot: targetRoot
  })

  assert.deepEqual(result, { finalized: true, cleanupErrors: [] })
  assert.equal(await exists(source.configFile), false)
  assert.equal(await exists(source.logFile), false)
  assert.equal(await exists(source.history), false)
  assert.equal(await exists(path.join(sourceRoot, 'temp', 'recordings')), false)
  assert.equal(await fsp.readFile(path.join(sourceRoot, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(await exists(path.join(targetRoot, '.migration.json')), false)
  assert.equal(await exists(path.join(portableDirectory, PENDING_NAME)), false)
})

test('verification failure does not clean source and rollback restores previous locator', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createManagedSourcePaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.writeFile(source.configFile, '{}')
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  await writeLocator(locatorPath, sourceRoot)
  await migrateDataRoot({ source, target, portableDirectory, previousRoot: sourceRoot })
  await writeJson(path.join(targetRoot, '.migration.json'), { migrationId: 'different', copiedHistoryCount: 1 })

  await assert.rejects(verifyAndFinalizeMigration({
    pendingPath: path.join(portableDirectory, PENDING_NAME),
    activeRoot: targetRoot
  }), /数据目录迁移验证失败/)
  assert.equal(await exists(source.configFile), true)
  assert.equal(await exists(path.join(portableDirectory, PENDING_NAME)), true)

  const previousRoot = await rollbackPendingMigration({ pendingPath: path.join(portableDirectory, PENDING_NAME), locatorPath })
  assert.equal(previousRoot, path.resolve(sourceRoot))
  assert.deepEqual(await readLocator(locatorPath), { version: 1, dataRoot: path.resolve(sourceRoot) })
  assert.equal(await exists(path.join(portableDirectory, PENDING_NAME)), false)
})

test('cleanup retry preserves pending and marker when cleanup reports errors', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createManagedSourcePaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.writeFile(source.configFile, '{}')
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.mkdir(portableDirectory, { recursive: true })
  await writeLocator(path.join(portableDirectory, LOCATOR_NAME), sourceRoot)
  await migrateDataRoot({ source, target, portableDirectory })
  const pendingPath = path.join(portableDirectory, PENDING_NAME)
  const result = await verifyAndFinalizeMigration({
    pendingPath,
    activeRoot: targetRoot,
    cleanup: async () => ['access denied']
  })

  assert.deepEqual(result, { finalized: false, cleanupErrors: ['access denied'] })
  assert.equal(await exists(pendingPath), true)
  assert.equal(await exists(path.join(targetRoot, '.migration.json')), true)
  assert.deepEqual(await readLocator(path.join(portableDirectory, LOCATOR_NAME)), { version: 1, dataRoot: path.resolve(targetRoot) })
})

test('final artifact removal failure cannot roll back to a cleaned source and can retry', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createManagedSourcePaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.writeFile(source.configFile, '{}')
  await fsp.writeFile(path.join(source.history, 'one.png'), 'one')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  const pendingPath = path.join(portableDirectory, PENDING_NAME)
  await writeLocator(locatorPath, sourceRoot)
  await migrateDataRoot({ source, target, portableDirectory, previousRoot: sourceRoot })
  let blocked = true
  const markerPath = path.join(targetRoot, '.migration.json')

  const first = await verifyAndFinalizeMigration({
    pendingPath,
    activeRoot: targetRoot,
    async removeFile(filePath, options) {
      if (filePath === markerPath && blocked) {
        blocked = false
        throw new Error('marker locked')
      }
      return fsp.rm(filePath, options)
    }
  })

  assert.deepEqual(first, { finalized: false, cleanupErrors: ['marker locked'] })
  assert.equal(JSON.parse(await fsp.readFile(pendingPath, 'utf8')).phase, 'cleaned')
  assert.equal(await exists(source.configFile), false)
  await assert.rejects(rollbackPendingMigration({ pendingPath, locatorPath }), /不能回滚/)
  assert.deepEqual(await readLocator(locatorPath), { version: 1, dataRoot: path.resolve(targetRoot) })

  assert.deepEqual(await verifyAndFinalizeMigration({ pendingPath, activeRoot: targetRoot }), {
    finalized: true,
    cleanupErrors: []
  })
  assert.equal(await exists(pendingPath), false)
})

test('cleaned retry still rejects a different active root', async (t) => {
  const parent = await temporaryRoot(t)
  const pendingPath = path.join(parent, PENDING_NAME)
  const expectedRoot = path.join(parent, 'expected')
  const otherRoot = path.join(parent, 'other')
  await writeJson(pendingPath, {
    version: 1,
    migrationId: 'migration-1',
    previousRoot: '',
    newRoot: expectedRoot,
    source: createLegacySourcePaths(path.join(parent, 'legacy')),
    phase: 'cleaned'
  })

  await assert.rejects(verifyAndFinalizeMigration({ pendingPath, activeRoot: otherRoot }), /数据目录迁移验证失败/)
  assert.equal(await exists(pendingPath), true)
})

test('rejects target conflicts before migration and rejects history links', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createManagedSourcePaths(targetRoot)
  await fsp.mkdir(path.join(targetRoot, 'cache'), { recursive: true })
  await assert.rejects(migrateDataRoot({ source, target, portableDirectory }), /目标目录已包含 Highlighter 数据/)

  await fsp.rm(targetRoot, { recursive: true, force: true })
  await fsp.mkdir(source.history, { recursive: true })
  try {
    await fsp.symlink(sourceRoot, path.join(source.history, 'link'), 'junction')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('link creation requires unavailable privileges')
    throw error
  }
  await assert.rejects(migrateDataRoot({ source, target, portableDirectory }), /符号链接或目录联接/)
  assert.deepEqual(await fsp.readdir(targetRoot), [])
})

test('rejects migration when source and target contain each other', async (t) => {
  const parent = await temporaryRoot(t)
  const portableDirectory = path.join(parent, 'portable')
  const sourceRoot = path.join(parent, 'legacy')
  await fsp.mkdir(sourceRoot, { recursive: true })

  await assert.rejects(migrateDataRoot({
    source: createLegacySourcePaths(sourceRoot),
    target: createDataPaths(path.join(sourceRoot, 'managed')),
    portableDirectory
  }), /不能互相包含/)
  await assert.rejects(migrateDataRoot({
    source: createLegacySourcePaths(path.join(sourceRoot, 'nested')),
    target: createDataPaths(sourceRoot),
    portableDirectory
  }), /不能互相包含/)
})

test('cleanupManagedSource only removes explicit files and directories', async (t) => {
  const parent = await temporaryRoot(t)
  const root = path.join(parent, 'legacy')
  const source = createLegacySourcePaths(root)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.mkdir(path.join(root, 'temp', 'recordings'), { recursive: true })
  await fsp.writeFile(source.configFile, '{}')
  await fsp.writeFile(path.join(root, 'keep.txt'), 'keep')
  const errors = await cleanupManagedSource(source)

  assert.deepEqual(errors, [])
  assert.equal(await exists(source.configFile), false)
  assert.equal(await exists(source.history), false)
  assert.equal(await exists(path.join(root, 'keep.txt')), true)
  assert.equal(await exists(root), true)
})
