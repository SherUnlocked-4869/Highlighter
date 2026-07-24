# Portable Data Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows portable build require a user-selected data root, keep all managed state outside `%APPDATA%`, and support transactional root changes from System Settings.

**Architecture:** A synchronous locator/path module configures Electron paths before readiness, a bootstrap module isolates first-run selection in an OS-temp process, and a migration module stages and validates managed data before atomically switching the sidecar locator. `main.js` owns Electron lifecycle and IPC while services receive named cache paths through constructor options.

**Tech Stack:** Electron 33, CommonJS JavaScript, `electron-store` 8, Node.js built-in `fs/path/os/crypto`, `node:test`, PowerShell packaging verification.

---

## File Map

- Create `main/services/data-root.js`: locator format, named paths, safe-directory validation, atomic JSON writes, managed layout creation.
- Create `main/services/data-root-bootstrap.js`: pre-ready portable detection, provisional OS-temp paths, and Electron path assignment.
- Create `main/services/data-root-migration.js`: staging, config/history rewriting, pending transaction records, verification, rollback, and narrow source cleanup.
- Create `test/data-root.test.js`: path, locator, validation, and bootstrap tests.
- Create `test/data-root-migration.test.js`: migration success, cache omission, rollback, and cleanup tests.
- Create `test/data-root-ui-contract.test.js`: IPC/preload/System Settings contract tests.
- Modify `main.js`: delayed store initialization, first-run flow, pending verification, named path consumers, migration IPC, and restart.
- Modify `main/services/ocr-service.js`: accept an injected OCR temp directory.
- Modify `main/services/long-capture-session.js`: require/create an injected long-capture temp root.
- Modify `preload.js`: expose narrow data-root methods.
- Modify `config/config.js`: show/open/change the active root and report migration errors.
- Modify `package.json`: syntax-check the new modules and tests.

## Task 1: Named Paths, Locator, and Safe Directory Validation

**Files:**
- Create: `main/services/data-root.js`
- Create: `test/data-root.test.js`

- [ ] **Step 1: Write failing tests for layout and locator I/O**

Add these cases to `test/data-root.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  LOCATOR_NAME,
  createDataPaths,
  ensureDataLayout,
  readLocator,
  resolvePortableDirectory,
  validateDataRoot,
  writeLocator
} = require('../main/services/data-root')

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-data-root-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('creates the documented managed data layout', async (t) => {
  const parent = await temporaryRoot(t)
  const root = path.join(parent, 'selected')
  const paths = createDataPaths(root)
  await ensureDataLayout(paths)
  assert.equal(paths.config, path.join(root, 'config'))
  assert.equal(paths.electronCache, path.join(root, 'cache', 'electron'))
  assert.equal(paths.longCaptureCache, path.join(root, 'cache', 'long-capture'))
  for (const directory of Object.values(paths).filter((value) => value !== root)) {
    assert.equal((await fs.stat(directory)).isDirectory(), true)
  }
})

test('writes and reads a versioned locator atomically', async (t) => {
  const portableDirectory = await temporaryRoot(t)
  const dataRoot = path.join(portableDirectory, 'data')
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  await writeLocator(locatorPath, dataRoot)
  assert.deepEqual(await readLocator(locatorPath), { version: 1, dataRoot: path.resolve(dataRoot) })
  assert.equal(await fs.access(`${locatorPath}.tmp`).then(() => true, () => false), false)
})

test('resolves only an electron-builder portable directory', () => {
  assert.equal(resolvePortableDirectory({}), '')
  assert.equal(resolvePortableDirectory({ PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' }), path.resolve('D:\\Apps'))
})
```

- [ ] **Step 2: Run the new test and verify the missing-module failure**

Run: `node --test test/data-root.test.js`

Expected: FAIL with `Cannot find module '../main/services/data-root'`.

- [ ] **Step 3: Implement the path and locator API**

Create `main/services/data-root.js` with these exports and behavior:

```js
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const LOCATOR_NAME = 'Highlighter.location.json'
const PENDING_NAME = 'Highlighter.location.pending.json'

function resolvePortableDirectory(env = process.env) {
  return env.PORTABLE_EXECUTABLE_DIR ? path.resolve(env.PORTABLE_EXECUTABLE_DIR) : ''
}

function createDataPaths(value) {
  const root = path.resolve(value)
  return {
    root,
    config: path.join(root, 'config'),
    logs: path.join(root, 'logs'),
    history: path.join(root, 'history'),
    cache: path.join(root, 'cache'),
    electronCache: path.join(root, 'cache', 'electron'),
    ocrCache: path.join(root, 'cache', 'ocr'),
    recordingCache: path.join(root, 'cache', 'recordings'),
    longCaptureCache: path.join(root, 'cache', 'long-capture'),
    runtime: path.join(root, 'runtime')
  }
}

async function ensureDataLayout(paths) {
  const directories = Object.entries(paths)
    .filter(([name]) => name !== 'root')
    .map(([, directory]) => fsp.mkdir(directory, { recursive: true }))
  await Promise.all(directories)
  return paths
}

function ensureDataLayoutSync(paths) {
  for (const [name, directory] of Object.entries(paths)) {
    if (name !== 'root') fs.mkdirSync(directory, { recursive: true })
  }
  return paths
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const backupPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.bak`
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(temporaryPath, filePath).catch(async (error) => {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
    await fsp.rename(filePath, backupPath)
    try {
      await fsp.rename(temporaryPath, filePath)
      await fsp.rm(backupPath, { force: true })
    } catch (replacementError) {
      await fsp.rename(backupPath, filePath).catch(() => {})
      throw replacementError
    }
  })
}

function parseLocator(value) {
  if (!value || value.version !== 1 || !path.isAbsolute(value.dataRoot || '')) {
    throw new Error('Highlighter 数据目录引导文件无效')
  }
  return { version: 1, dataRoot: path.resolve(value.dataRoot) }
}

async function readLocator(filePath) {
  return parseLocator(JSON.parse(await fsp.readFile(filePath, 'utf8')))
}

function readLocatorSync(filePath) {
  return parseLocator(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

async function writeLocator(filePath, dataRoot) {
  const locator = parseLocator({ version: 1, dataRoot: path.resolve(dataRoot) })
  await atomicWriteJson(filePath, locator)
  return locator
}

function isNestedPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function rejectLinks(directory) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let cursor = parsed.root
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = await fsp.lstat(cursor).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat?.isSymbolicLink()) throw new Error(`数据目录不能包含符号链接或目录联接：${cursor}`)
  }
}

async function validateDataRoot(directory, sourceRoot = '') {
  const input = String(directory || '').trim()
  if (!input || !path.isAbsolute(input)) throw new Error('数据目录必须是绝对路径')
  const root = path.resolve(input)
  if (sourceRoot && (isNestedPath(sourceRoot, root) || isNestedPath(root, sourceRoot))) {
    throw new Error('新旧数据目录不能互相包含')
  }
  await fsp.mkdir(root, { recursive: true })
  await rejectLinks(root)
  const probe = path.join(root, `.highlighter-write-${crypto.randomUUID()}`)
  const renamed = `${probe}.renamed`
  await fsp.writeFile(probe, 'ok', 'utf8')
  await fsp.rename(probe, renamed)
  await fsp.rm(renamed, { force: true })
  return root
}

module.exports = {
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
}
```

- [ ] **Step 4: Add validation tests and make them pass**

Append these tests:

```js
test('rejects source and destination containment in either direction', async (t) => {
  const parent = await temporaryRoot(t)
  const source = path.join(parent, 'source')
  const child = path.join(source, 'child')
  await fs.mkdir(child, { recursive: true })
  await assert.rejects(validateDataRoot(child, source), /不能互相包含/)
  await assert.rejects(validateDataRoot(source, child), /不能互相包含/)
})

test('rejects a selected symlink or Windows junction', async (t) => {
  const parent = await temporaryRoot(t)
  const target = path.join(parent, 'target')
  const link = path.join(parent, 'link')
  await fs.mkdir(target)
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('creating a junction requires unavailable privileges')
    throw error
  }
  await assert.rejects(validateDataRoot(link), /符号链接或目录联接/)
})
```

Run:

`node --test test/data-root.test.js`

Expected: all data-root tests PASS.

- [ ] **Step 5: Commit the path foundation**

```powershell
git add main/services/data-root.js test/data-root.test.js
git commit -m "feat: add portable data root paths"
```

## Task 2: Pre-ready Portable Bootstrap

**Files:**
- Create: `main/services/data-root-bootstrap.js`
- Modify: `test/data-root.test.js`

- [ ] **Step 1: Write failing bootstrap tests**

Append tests using this fake Electron app:

```js
function fakeApp(legacyUserData) {
  const values = { userData: legacyUserData, sessionData: path.join(legacyUserData, 'Session Storage') }
  return {
    getPath: (name) => values[name],
    setPath: (name, value) => { values[name] = value },
    values
  }
}

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
```

- [ ] **Step 2: Run and verify the missing-module failure**

Run: `node --test test/data-root.test.js`

Expected: FAIL for `data-root-bootstrap` not found.

- [ ] **Step 3: Implement synchronous bootstrap preparation**

Create `main/services/data-root-bootstrap.js`:

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  LOCATOR_NAME,
  PENDING_NAME,
  createDataPaths,
  ensureDataLayoutSync,
  readLocatorSync,
  resolvePortableDirectory
} = require('./data-root')

function applyElectronPaths(app, paths) {
  app.setPath('userData', paths.runtime)
  app.setPath('sessionData', paths.electronCache)
}

function prepareDataRoot({ app, env = process.env, tempRoot = os.tmpdir() }) {
  const legacyUserData = app.getPath('userData')
  const portableDirectory = resolvePortableDirectory(env)
  if (!portableDirectory) return { portable: false, legacyUserData, paths: null, needsSelection: false }

  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  const pendingPath = path.join(portableDirectory, PENDING_NAME)
  let requestedRoot = ''
  try {
    const locator = readLocatorSync(locatorPath)
    requestedRoot = locator.dataRoot
    const paths = ensureDataLayoutSync(createDataPaths(locator.dataRoot))
    applyElectronPaths(app, paths)
    return { portable: true, portableDirectory, locatorPath, pendingPath, legacyUserData, locator, paths, needsSelection: false }
  } catch (error) {
    const locatorMissing = error.code === 'ENOENT'
    const provisionalRoot = fs.mkdtempSync(path.join(tempRoot, 'highlighter-bootstrap-'))
    const paths = ensureDataLayoutSync(createDataPaths(provisionalRoot))
    applyElectronPaths(app, paths)
    return {
      portable: true,
      portableDirectory,
      locatorPath,
      pendingPath,
      legacyUserData,
      provisionalRoot,
      paths,
      needsSelection: true,
      requestedRoot,
      startupError: locatorMissing && !requestedRoot ? null : error
    }
  }
}

function removeProvisionalRoot(context) {
  if (context?.provisionalRoot) fs.rmSync(context.provisionalRoot, { recursive: true, force: true })
}

module.exports = { applyElectronPaths, prepareDataRoot, removeProvisionalRoot }
```

- [ ] **Step 4: Run bootstrap and path tests**

Run: `node --test test/data-root.test.js`

Expected: all tests PASS, including pre-ready `setPath` assertions.

- [ ] **Step 5: Commit bootstrap preparation**

```powershell
git add main/services/data-root-bootstrap.js test/data-root.test.js
git commit -m "feat: prepare portable paths before startup"
```

## Task 3: Transactional Migration and Rollback

**Files:**
- Create: `main/services/data-root-migration.js`
- Create: `test/data-root-migration.test.js`

- [ ] **Step 1: Write failing migration tests**

Create fixtures for legacy and managed roots and assert these public methods:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createDataPaths, readLocator } = require('../main/services/data-root')
const {
  createLegacySourcePaths,
  migrateDataRoot,
  verifyAndFinalizeMigration,
  rollbackPendingMigration
} = require('../main/services/data-root-migration')

async function root(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-migration-test-'))
  t.after(() => fs.rm(value, { recursive: true, force: true }))
  return value
}

test('migrates legacy config log and history but not cache', async (t) => {
  const parent = await root(t)
  const legacyRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'target')
  const portableDirectory = path.join(parent, 'portable')
  await fs.mkdir(path.join(legacyRoot, 'capture-history'), { recursive: true })
  await fs.mkdir(path.join(legacyRoot, 'temp', 'recordings'), { recursive: true })
  const oldImage = path.join(legacyRoot, 'capture-history', 'one.png')
  await fs.writeFile(oldImage, 'image')
  await fs.writeFile(path.join(legacyRoot, 'app.log'), 'log')
  await fs.writeFile(path.join(legacyRoot, 'config.json'), JSON.stringify({
    settings: { screenshot: { historyDirectory: path.join(legacyRoot, 'capture-history') } },
    captureHistory: [{ id: 'one', filePath: oldImage }]
  }))
  await fs.writeFile(path.join(legacyRoot, 'temp', 'recordings', 'discard.webm'), 'cache')
  await fs.mkdir(portableDirectory)

  const result = await migrateDataRoot({
    source: createLegacySourcePaths(legacyRoot),
    target: createDataPaths(targetRoot),
    portableDirectory,
    previousRoot: ''
  })
  assert.equal((await readLocator(result.locatorPath)).dataRoot, path.resolve(targetRoot))
  assert.equal(await fs.readFile(path.join(targetRoot, 'logs', 'app.log'), 'utf8'), 'log')
  assert.equal(await fs.access(path.join(targetRoot, 'cache', 'recordings', 'discard.webm')).then(() => true, () => false), false)
  const config = JSON.parse(await fs.readFile(path.join(targetRoot, 'config', 'config.json'), 'utf8'))
  assert.equal(config.captureHistory[0].filePath, path.join(targetRoot, 'history', 'one.png'))
  assert.equal(config.settings.screenshot.historyDirectory, path.join(targetRoot, 'history'))
})
```

Add this second test:

```js
test('copy failure leaves source and locator unchanged', async (t) => {
  const parent = await root(t)
  const sourceRoot = path.join(parent, 'source')
  const targetRoot = path.join(parent, 'target')
  const portableDirectory = path.join(parent, 'portable')
  await fs.mkdir(sourceRoot)
  await fs.mkdir(portableDirectory)
  await fs.writeFile(path.join(sourceRoot, 'app.log'), 'keep')
  const locatorPath = path.join(portableDirectory, 'Highlighter.location.json')
  await fs.writeFile(locatorPath, `${JSON.stringify({ version: 1, dataRoot: sourceRoot })}\n`)
  await assert.rejects(migrateDataRoot({
    source: createLegacySourcePaths(sourceRoot),
    target: createDataPaths(targetRoot),
    portableDirectory,
    previousRoot: sourceRoot,
    copyFile: async () => { throw new Error('copy failed') }
  }), /copy failed/)
  assert.equal(await fs.readFile(path.join(sourceRoot, 'app.log'), 'utf8'), 'keep')
  assert.equal((await readLocator(locatorPath)).dataRoot, path.resolve(sourceRoot))
  assert.equal(await fs.access(path.join(portableDirectory, 'Highlighter.location.pending.json')).then(() => true, () => false), false)
})
```

- [ ] **Step 2: Run and verify migration tests fail**

Run: `node --test test/data-root-migration.test.js`

Expected: FAIL because `data-root-migration` does not exist.

- [ ] **Step 3: Implement migration transaction APIs**

Create `main/services/data-root-migration.js` with this public shape:

```js
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const {
  LOCATOR_NAME,
  PENDING_NAME,
  atomicWriteJson,
  createDataPaths,
  ensureDataLayout,
  validateDataRoot,
  writeLocator
} = require('./data-root')

function createLegacySourcePaths(root) {
  const value = path.resolve(root)
  return {
    root: value,
    configFile: path.join(value, 'config.json'),
    logFile: path.join(value, 'app.log'),
    history: path.join(value, 'capture-history'),
    cleanupFiles: [path.join(value, 'config.json'), path.join(value, 'app.log')],
    cleanupDirectories: [path.join(value, 'capture-history'), path.join(value, 'temp', 'recordings')]
  }
}

function createManagedSourcePaths(root) {
  const paths = createDataPaths(root)
  return {
    root: paths.root,
    configFile: path.join(paths.config, 'config.json'),
    logFile: path.join(paths.logs, 'app.log'),
    history: paths.history,
    cleanupFiles: [],
    cleanupDirectories: [paths.config, paths.logs, paths.history, paths.cache, paths.runtime]
  }
}

function remapInside(value, sourceDirectory, targetDirectory) {
  if (!value || typeof value !== 'string') return value
  const relative = path.relative(sourceDirectory, value)
  return relative.startsWith('..') || path.isAbsolute(relative) ? value : path.join(targetDirectory, relative)
}

function rewriteConfig(config, source, target) {
  if (config.settings?.screenshot?.historyDirectory) {
    config.settings.screenshot.historyDirectory = remapInside(config.settings.screenshot.historyDirectory, source.history, target.history)
  }
  if (Array.isArray(config.captureHistory)) {
    config.captureHistory = config.captureHistory.map((item) => ({
      ...item,
      filePath: remapInside(item.filePath, source.history, target.history),
      thumbnailPath: remapInside(item.thumbnailPath, source.history, target.history)
    }))
  }
  return config
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

async function copyOptionalFile(source, target, copyFile = fs.copyFile) {
  if (!await exists(source)) return 0
  await fs.mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
  return 1
}

async function copyTree(source, target) {
  if (!await exists(source)) return 0
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false })
  const entries = await fs.readdir(target, { recursive: true, withFileTypes: true })
  if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('迁移目录不能包含符号链接或目录联接')
  return entries.filter((entry) => entry.isFile()).length
}

async function countFiles(directory) {
  if (!await exists(directory)) return 0
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).length
}

async function migrateDataRoot({ source, target, portableDirectory, previousRoot = '', copyFile = fs.copyFile }) {
  await validateDataRoot(target.root, source.root)
  const conflicts = ['config', 'logs', 'history', 'cache', 'runtime']
  for (const name of conflicts) {
    if (await exists(path.join(target.root, name))) throw new Error('目标目录已包含 Highlighter 数据')
  }
  const migrationId = crypto.randomUUID()
  const staging = path.join(target.root, `.highlighter-migration-${migrationId}`)
  const staged = createDataPaths(staging)
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  const pendingPath = path.join(portableDirectory, PENDING_NAME)
  try {
    await ensureDataLayout(staged)
    const copiedLogCount = await copyOptionalFile(source.logFile, path.join(staged.logs, 'app.log'), copyFile)
    const sourceHistoryCount = await countFiles(source.history)
    const copiedHistoryCount = await copyTree(source.history, staged.history)
    if (copiedHistoryCount !== sourceHistoryCount || await countFiles(staged.history) !== sourceHistoryCount) {
      throw new Error('截图历史文件数量校验失败')
    }
    if (await exists(source.configFile)) {
      const config = rewriteConfig(JSON.parse(await fs.readFile(source.configFile, 'utf8')), source, target)
      await atomicWriteJson(path.join(staged.config, 'config.json'), config)
      JSON.parse(await fs.readFile(path.join(staged.config, 'config.json'), 'utf8'))
    }
    await atomicWriteJson(path.join(staging, '.migration.json'), { migrationId, copiedLogCount, copiedHistoryCount })
    for (const name of ['config', 'logs', 'history']) await fs.rename(staged[name], target[name])
    await ensureDataLayout(target)
    await fs.rename(path.join(staging, '.migration.json'), path.join(target.root, '.migration.json'))
    await fs.rm(staging, { recursive: true, force: true })
    await atomicWriteJson(pendingPath, { version: 1, migrationId, previousRoot, newRoot: target.root, source })
    await writeLocator(locatorPath, target.root)
    return { locatorPath, pendingPath, migrationId }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    await fs.rm(pendingPath, { force: true }).catch(() => {})
    await Promise.all(['config', 'logs', 'history', 'cache', 'runtime'].map((name) => fs.rm(path.join(target.root, name), { recursive: true, force: true }).catch(() => {})))
    throw error
  }
}

async function cleanupManagedSource(source) {
  const operations = [
    ...(source.cleanupFiles || []).map((filePath) => fs.rm(filePath, { force: true })),
    ...(source.cleanupDirectories || []).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  ]
  const results = await Promise.allSettled(operations)
  return results.filter((result) => result.status === 'rejected').map((result) => result.reason.message)
}

async function verifyAndFinalizeMigration({ pendingPath, activeRoot, cleanup = cleanupManagedSource }) {
  if (!await exists(pendingPath)) return { finalized: false, cleanupErrors: [] }
  const pending = JSON.parse(await fs.readFile(pendingPath, 'utf8'))
  const markerPath = path.join(activeRoot, '.migration.json')
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
  if (pending.newRoot !== path.resolve(activeRoot) || marker.migrationId !== pending.migrationId) throw new Error('数据目录迁移验证失败')
  const configPath = path.join(activeRoot, 'config', 'config.json')
  if (await exists(configPath)) JSON.parse(await fs.readFile(configPath, 'utf8'))
  if (await countFiles(path.join(activeRoot, 'history')) !== marker.copiedHistoryCount) throw new Error('迁移后的截图历史校验失败')
  await atomicWriteJson(pendingPath, { ...pending, phase: 'verified' })
  const cleanupErrors = await cleanup(pending.source)
  if (cleanupErrors.length) return { finalized: false, cleanupErrors }
  await fs.rm(markerPath, { force: true })
  await fs.rm(pendingPath, { force: true })
  return { finalized: true, cleanupErrors: [] }
}

async function rollbackPendingMigration({ pendingPath, locatorPath }) {
  const pending = JSON.parse(await fs.readFile(pendingPath, 'utf8'))
  if (pending.previousRoot) await writeLocator(locatorPath, pending.previousRoot)
  else await fs.rm(locatorPath, { force: true })
  await fs.rm(pendingPath, { force: true })
  return pending.previousRoot
}

module.exports = {
  cleanupManagedSource,
  createLegacySourcePaths,
  createManagedSourcePaths,
  migrateDataRoot,
  rewriteConfig,
  rollbackPendingMigration,
  verifyAndFinalizeMigration
}
```

Keep the destination conflict check before `ensureDataLayout(target)` exactly as shown; only the staging directory may exist when migration starts.

- [ ] **Step 4: Add finalize and rollback tests**

Append these tests:

```js
test('finalization cleans declared sources but leaves unrelated files', async (t) => {
  const parent = await root(t)
  const sourceRoot = path.join(parent, 'source')
  const targetRoot = path.join(parent, 'target')
  const portableDirectory = path.join(parent, 'portable')
  await fs.mkdir(path.join(sourceRoot, 'capture-history'), { recursive: true })
  await fs.mkdir(portableDirectory)
  await fs.writeFile(path.join(sourceRoot, 'config.json'), '{}')
  await fs.writeFile(path.join(sourceRoot, 'keep.txt'), 'keep')
  const migration = await migrateDataRoot({
    source: createLegacySourcePaths(sourceRoot),
    target: createDataPaths(targetRoot),
    portableDirectory,
    previousRoot: ''
  })
  const result = await verifyAndFinalizeMigration({ pendingPath: migration.pendingPath, activeRoot: targetRoot })
  assert.deepEqual(result, { finalized: true, cleanupErrors: [] })
  assert.equal(await fs.readFile(path.join(sourceRoot, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(await fs.access(path.join(sourceRoot, 'config.json')).then(() => true, () => false), false)
  assert.equal(await fs.access(migration.pendingPath).then(() => true, () => false), false)
})

test('rollback restores the previous locator after verification failure', async (t) => {
  const parent = await root(t)
  const portableDirectory = path.join(parent, 'portable')
  const previousRoot = path.join(parent, 'previous')
  const newRoot = path.join(parent, 'new')
  const locatorPath = path.join(portableDirectory, 'Highlighter.location.json')
  const pendingPath = path.join(portableDirectory, 'Highlighter.location.pending.json')
  await fs.mkdir(portableDirectory)
  await fs.writeFile(locatorPath, JSON.stringify({ version: 1, dataRoot: newRoot }))
  await fs.writeFile(pendingPath, JSON.stringify({ version: 1, migrationId: 'broken', previousRoot, newRoot }))
  assert.equal(await rollbackPendingMigration({ pendingPath, locatorPath }), previousRoot)
  assert.equal((await readLocator(locatorPath)).dataRoot, path.resolve(previousRoot))
})
```

To cover cleanup retry, export an optional `cleanup = cleanupManagedSource` parameter from `verifyAndFinalizeMigration`, inject `async () => ['access denied']`, and assert it returns `{ finalized: false, cleanupErrors: ['access denied'] }` while the locator still points to the new root.

Run:

`node --test test/data-root-migration.test.js`

Expected: all migration tests PASS.

- [ ] **Step 5: Commit migration service**

```powershell
git add main/services/data-root-migration.js test/data-root-migration.test.js
git commit -m "feat: migrate portable data transactionally"
```

## Task 4: Inject Managed Cache Paths Into Services

**Files:**
- Modify: `main/services/ocr-service.js`
- Modify: `main/services/long-capture-session.js`
- Modify: `test/data-root.test.js`

- [ ] **Step 1: Write failing service path tests**

Append:

```js
test('OCR and long capture use injected cache roots', async (t) => {
  const parent = await temporaryRoot(t)
  const ocrTemp = path.join(parent, 'ocr')
  const longTemp = path.join(parent, 'long')
  const { OcrService } = require('../main/services/ocr-service')
  const { LongCaptureSession } = require('../main/services/long-capture-session')
  const ocr = new OcrService({ sidecarPath: 'sidecar', modelDir: 'models', tempDir: ocrTemp })
  assert.equal(ocr.tempDir, path.resolve(ocrTemp))
  const session = new LongCaptureSession({ tempRoot: longTemp })
  t.after(() => session.cleanup())
  assert.equal(session.directory.startsWith(path.resolve(longTemp)), true)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/data-root.test.js`

Expected: FAIL because OCR still uses `os.tmpdir()` and long capture does not create the injected root.

- [ ] **Step 3: Implement injected paths**

In `OcrService` replace the OS-temp assignment with:

```js
if (!options.tempDir) throw new Error('OCR 临时目录不能为空')
this.tempDir = path.resolve(options.tempDir)
```

Remove the unused `os` import. In `LongCaptureSession` replace its constructor root setup with:

```js
if (!options.tempRoot) throw new Error('长截图临时目录不能为空')
const root = path.resolve(options.tempRoot)
fs.mkdirSync(root, { recursive: true })
this.directory = fs.mkdtempSync(path.join(root, 'highlighter-long-'))
```

Remove its unused `os` import.

- [ ] **Step 4: Update existing long-capture tests and run services**

Add `os` and `path` imports to `tests/long-capture.test.js`, then wrap its session with an explicit root:

```js
const os = require('os')
const path = require('path')

const longCaptureTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-long-test-'))
const session = new LongCaptureSession({ tempRoot: longCaptureTemp, axis: 'vertical' })
try {
  session.addStrip(await png(4, 2, { r: 255, g: 0, b: 0, alpha: 1 }), { width: 4, height: 2 })
  session.addStrip(await png(4, 3, { r: 0, g: 0, b: 255, alpha: 1 }), { width: 4, height: 3 })
  assert.deepEqual(session.getSize(), { width: 4, height: 5, strips: 2, trimStart: 0, trimEnd: 0 })
  assert.deepEqual(session.setTrim(1, 1), { width: 4, height: 3, strips: 2, trimStart: 1, trimEnd: 1 })
  const output = await session.render()
  assert.ok(fs.existsSync(output))
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.width, 4)
  assert.equal(metadata.height, 3)
} finally {
  session.cleanup()
  fs.rmSync(longCaptureTemp, { recursive: true, force: true })
}
```

Run:

`node --test test/data-root.test.js test/recording-service.test.js`

`npm run test:long-capture`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit cache path injection**

```powershell
git add main/services/ocr-service.js main/services/long-capture-session.js test/data-root.test.js tests/long-capture.test.js
git commit -m "refactor: inject managed cache directories"
```

## Task 5: Wire Bootstrap and Named Paths Into the Main Process

**Files:**
- Modify: `main.js`
- Create: `test/data-root-ui-contract.test.js`

- [ ] **Step 1: Write a failing main-process contract test**

Create `test/data-root-ui-contract.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

test('main process prepares portable paths before creating the store', () => {
  assert.match(main, /prepareDataRoot\(/)
  assert.match(main, /let store = null/)
  assert.match(main, /storeOptions\.cwd\s*=\s*dataRootContext\.paths\.config/)
  assert.ok(main.indexOf('prepareDataRoot(') < main.indexOf('new Store('))
})

test('managed consumers use named paths', () => {
  assert.match(main, /dataRootContext\.paths\.logs/)
  assert.match(main, /tempDir:\s*dataRootContext\.paths\.ocrCache/)
  assert.match(main, /tempRoot:\s*dataRootContext\.paths\.recordingCache/)
  assert.match(main, /tempRoot:\s*dataRootContext\.paths\.longCaptureCache/)
  assert.doesNotMatch(main, /path\.join\(app\.getPath\('userData'\), 'temp', 'recordings'\)/)
})
```

- [ ] **Step 2: Run and verify contract failure**

Run: `node --test test/data-root-ui-contract.test.js`

Expected: FAIL because `main.js` still creates `Store` at module load and uses Electron defaults.

- [ ] **Step 3: Prepare context before readiness and delay store initialization**

At the top of `main.js`, import the new services, capture the context immediately after Electron imports, and replace `const store`:

```js
const { prepareDataRoot, removeProvisionalRoot } = require('./main/services/data-root-bootstrap')
const { createDataPaths, ensureDataLayout, validateDataRoot, writeLocator } = require('./main/services/data-root')
const {
  createLegacySourcePaths,
  createManagedSourcePaths,
  migrateDataRoot,
  rollbackPendingMigration,
  verifyAndFinalizeMigration
} = require('./main/services/data-root-migration')

const dataRootContext = prepareDataRoot({ app })
let store = null

function initializeStore() {
  const storeOptions = {
    defaults: { settings: DEFAULT_SETTINGS, captureHistory: [] }
  }
  if (dataRootContext.portable) storeOptions.cwd = dataRootContext.paths.config
  store = new Store(storeOptions)
  return store
}
```

This conditional preserves the current electron-store location for non-portable development. Do not call `getSettings()` before `initializeStore()`.

- [ ] **Step 4: Add first-run bootstrap and pending verification**

Replace the current `app.whenReady().then(...)` body with an async startup function:

```js
async function chooseInitialDataRoot() {
  if (dataRootContext.startupError) {
    await dialog.showMessageBox({ type: 'warning', message: '数据目录引导文件无法读取', detail: dataRootContext.startupError.message })
  }
  const result = await dialog.showOpenDialog({
    title: '选择 Highlighter 数据目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) {
    removeProvisionalRoot(dataRootContext)
    app.exit(0)
    return false
  }
  const targetRoot = await validateDataRoot(result.filePaths[0], dataRootContext.legacyUserData)
  await migrateDataRoot({
    source: createLegacySourcePaths(dataRootContext.legacyUserData),
    target: createDataPaths(targetRoot),
    portableDirectory: dataRootContext.portableDirectory,
    previousRoot: ''
  })
  removeProvisionalRoot(dataRootContext)
  app.relaunch()
  app.exit(0)
  return false
}

async function recoverUnavailableDataRoot() {
  while (true) {
    const response = await dialog.showMessageBox({
      type: 'error',
      buttons: ['重试', '选择其他目录', '退出'],
      defaultId: 0,
      cancelId: 2,
      message: 'Highlighter 数据目录不可用',
      detail: `${dataRootContext.requestedRoot || dataRootContext.locatorPath}\n\n${dataRootContext.startupError.message}`
    })
    if (response.response === 2) {
      removeProvisionalRoot(dataRootContext)
      app.exit(1)
      return
    }
    if (response.response === 0 && dataRootContext.requestedRoot) {
      try {
        const root = await validateDataRoot(dataRootContext.requestedRoot)
        await ensureDataLayout(createDataPaths(root))
        removeProvisionalRoot(dataRootContext)
        app.relaunch()
        app.exit(0)
        return
      } catch (error) {
        dataRootContext.startupError = error
        continue
      }
    }
    const selected = await dialog.showOpenDialog({
      title: '选择 Highlighter 数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (selected.canceled || !selected.filePaths[0]) continue
    try {
      const root = await validateDataRoot(selected.filePaths[0])
      await ensureDataLayout(createDataPaths(root))
      await writeLocator(dataRootContext.locatorPath, root)
      removeProvisionalRoot(dataRootContext)
      app.relaunch()
      app.exit(0)
      return
    } catch (error) {
      dataRootContext.startupError = error
    }
  }
}

async function startApplication() {
  if (dataRootContext.portable && dataRootContext.needsSelection) {
    if (dataRootContext.startupError) return recoverUnavailableDataRoot()
    return chooseInitialDataRoot()
  }
  try {
    initializeStore()
    const migration = await verifyAndFinalizeMigration({ pendingPath: dataRootContext.pendingPath, activeRoot: dataRootContext.paths.root })
    if (migration.cleanupErrors.length) log('Old data cleanup pending:', migration.cleanupErrors.join('; '))
  } catch (error) {
    try {
      await rollbackPendingMigration({ pendingPath: dataRootContext.pendingPath, locatorPath: dataRootContext.locatorPath })
      dialog.showErrorBox('数据目录迁移失败', `${error.message}\nHighlighter 将恢复原数据目录。`)
      app.relaunch()
      app.exit(1)
      return
    } catch {
      throw error
    }
  }
  store.set('settings', getSettings())
  createTrayIcon()
  createToolbarWindow()
  createMainWindow('home')
  registerShortcuts()
  initSelectionHook()
  if (getSettings().plugins.ocr && getSettings().ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
  if (isWin) screenshotDesktop.listDisplays().then((displays) => { nativeDisplayListPromise = Promise.resolve(displays) }).catch(() => {})
  app.setLoginItemSettings({ openAtLogin: !!getSettings().system.autoStart })
}

app.whenReady().then(startApplication).catch((error) => {
  dialog.showErrorBox('Highlighter 启动失败', error.message)
  app.exit(1)
})
```

- [ ] **Step 5: Replace all managed path consumers**

Use:

```js
const activePaths = dataRootContext.paths
const defaultHistoryDirectory = activePaths?.history || path.join(app.getPath('userData'), 'capture-history')
const logFile = activePaths ? path.join(activePaths.logs, 'app.log') : path.join(app.getPath('userData'), 'app.log')
```

Then make these exact substitutions:

- store `cwd` -> `activePaths.config` in portable mode;
- screenshot history fallback -> `defaultHistoryDirectory`;
- log output -> `logFile`;
- `OcrService.tempDir` -> `activePaths.ocrCache`;
- `RecordingService.tempRoot` -> `activePaths.recordingCache`;
- `LongCaptureSession.tempRoot` -> `activePaths.longCaptureCache`;
- `app:get-info.dataDirectory` and `app:open-data-directory` -> `activePaths.root` in portable mode.

Run: `node --test test/data-root-ui-contract.test.js test/data-root.test.js test/data-root-migration.test.js`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit main-process bootstrap wiring**

```powershell
git add main.js test/data-root-ui-contract.test.js
git commit -m "feat: bootstrap portable data outside appdata"
```

## Task 6: Data Root IPC and Settings UI

**Files:**
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `config/config.js`
- Modify: `test/data-root-ui-contract.test.js`

- [ ] **Step 1: Write failing UI and preload contract tests**

Append:

```js
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
const config = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8')

test('preload exposes narrow data-root commands', () => {
  assert.match(preload, /getDataRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-root:get'\)/)
  assert.match(preload, /changeDataRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-root:change'\)/)
  assert.match(preload, /openDataRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-root:open'\)/)
})

test('System Settings shows and changes the portable data root', () => {
  assert.match(config, /id="dataRoot"/)
  assert.match(config, /id="changeDataRoot"/)
  assert.match(config, /id="openDataRoot"/)
  assert.match(config, /window\.electronAPI\.changeDataRoot\(\)/)
})
```

- [ ] **Step 2: Run and verify UI contract failure**

Run: `node --test test/data-root-ui-contract.test.js`

Expected: FAIL for missing preload methods and controls.

- [ ] **Step 3: Add main-process IPC and transactional restart**

Register:

```js
ipcMain.handle('data-root:get', () => ({
  portable: dataRootContext.portable,
  path: dataRootContext.paths?.root || app.getPath('userData')
}))

ipcMain.handle('data-root:open', () => shell.openPath(dataRootContext.paths?.root || app.getPath('userData')))

ipcMain.handle('data-root:change', async () => {
  if (!dataRootContext.portable) throw new Error('数据目录切换仅支持 portable 版本')
  const result = await dialog.showOpenDialog({ title: '选择新的 Highlighter 数据目录', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const targetRoot = await validateDataRoot(result.filePaths[0], dataRootContext.paths.root)
  if (targetRoot === dataRootContext.paths.root) return { canceled: true }
  const confirmation = await dialog.showMessageBox({
    type: 'question',
    buttons: ['迁移并重启', '取消'],
    defaultId: 0,
    cancelId: 1,
    message: '迁移 Highlighter 数据目录？',
    detail: `配置、日志和截图历史将迁移到：\n${targetRoot}\n\n完成后 Highlighter 会重启。`
  })
  if (confirmation.response !== 0) return { canceled: true }
  store.set('settings', getSettings())
  if (ocrService) { ocrService.stop(); ocrService = null }
  await recordingService?.dispose()
  recordingService = null
  closeLongCapture()
  await migrateDataRoot({
    source: createManagedSourcePaths(dataRootContext.paths.root),
    target: createDataPaths(targetRoot),
    portableDirectory: dataRootContext.portableDirectory,
    previousRoot: dataRootContext.paths.root
  })
  setImmediate(() => { app.relaunch(); app.exit(0) })
  return { restarting: true }
})
```

Use the existing main-process error propagation so copy/validation failures appear in the renderer and do not restart.

- [ ] **Step 4: Expose preload methods and render the controls**

Add to `preload.js`:

```js
getDataRoot: () => ipcRenderer.invoke('data-root:get'),
changeDataRoot: () => ipcRenderer.invoke('data-root:change'),
openDataRoot: () => ipcRenderer.invoke('data-root:open'),
```

Make `renderSystemSettings` async, fetch `dataRoot`, and add this row to Software Data:

```js
<div class="form-row">
  <div class="form-label"><b>数据根目录</b><small>配置、日志、截图历史、缓存和运行数据</small></div>
  <input id="dataRoot" type="text" readonly value="${escapeHtml(dataRoot.path)}">
  <button class="button" id="openDataRoot">打开</button>
  <button class="button" id="changeDataRoot" ${dataRoot.portable ? '' : 'disabled'}>更改</button>
</div>
```

Bind:

```js
document.getElementById('openDataRoot').onclick = () => window.electronAPI.openDataRoot()
document.getElementById('changeDataRoot').onclick = async () => {
  const button = document.getElementById('changeDataRoot')
  button.disabled = true
  try {
    const result = await window.electronAPI.changeDataRoot()
    if (result?.restarting) toast('迁移完成，正在重启')
  } catch (error) {
    toast(error.message || '数据目录迁移失败')
    button.disabled = false
  }
}
```

Update `renderRoute` to tolerate the async renderer with `void renderSystemSettings()`.

- [ ] **Step 5: Run UI and regression tests**

Run: `node --test test/data-root-ui-contract.test.js test/selection-toolbar-settings.test.js test/recording-ui-contract.test.js`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Settings integration**

```powershell
git add main.js preload.js config/config.js test/data-root-ui-contract.test.js
git commit -m "feat: change portable data root from settings"
```

## Task 7: Syntax Checks and Full Regression Suite

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Extend the syntax-check command**

Add these paths to `scripts.check`:

```text
main/services/data-root.js
main/services/data-root-bootstrap.js
main/services/data-root-migration.js
test/data-root.test.js
test/data-root-migration.test.js
test/data-root-ui-contract.test.js
```

- [ ] **Step 2: Run syntax checks**

Run: `npm run check`

Expected: exit code 0 with no syntax errors.

- [ ] **Step 3: Run all Node tests**

Run: `npm test`

Expected: all `test/*.test.js` tests PASS with zero failures.

- [ ] **Step 4: Run long-capture tests**

Run: `npm run test:long-capture`

Expected: all long-capture tests PASS.

- [ ] **Step 5: Inspect source for unmanaged portable paths**

Run:

```powershell
rg -n "app\.getPath\('userData'\)|app\.getPath\('temp'\)|os\.tmpdir\(\)" main.js main/services
```

Expected: only documented compatibility/bootstrap uses remain; OCR, recording, long capture, logs, store, history, Electron `userData`, and `sessionData` all use named managed paths in portable mode.

- [ ] **Step 6: Commit verification wiring**

```powershell
git add package.json
git commit -m "test: verify portable data root flows"
```

## Task 8: Build and Verify the Portable Artifact

**Files:**
- No source changes expected.

- [ ] **Step 1: Build the x64 portable executable**

Run:

```powershell
$env:HTTP_PROXY='http://127.0.0.1:7897'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
npm run build:win:portable
```

Expected: exit code 0 and `dist/Highlighter-2.0.0-portable.exe` created.

- [ ] **Step 2: Verify artifact metadata and hash**

Run:

```powershell
Get-Item dist\Highlighter-2.0.0-portable.exe | Select-Object FullName,Length,LastWriteTime
Get-FileHash dist\Highlighter-2.0.0-portable.exe -Algorithm SHA256
```

Expected: a non-empty executable with a fresh build timestamp and SHA-256 output.

- [ ] **Step 3: Verify cancel-to-exit in an isolated directory**

Create an isolated verification directory and capture the existing matching AppData directories:

```powershell
$verificationRoot = Join-Path $env:TEMP 'Highlighter-portable-verification'
$verificationExe = Join-Path $verificationRoot 'Highlighter-2.0.0-portable.exe'
$selectedDataRoot = Join-Path $verificationRoot 'SelectedData'
New-Item -ItemType Directory -Force -Path $verificationRoot | Out-Null
Copy-Item dist\Highlighter-2.0.0-portable.exe $verificationExe -Force
$appDataBefore = @(Get-ChildItem $env:APPDATA -Directory | Where-Object Name -Match 'Highlighter|highlighter-snowshot' | Select-Object -ExpandProperty FullName)
Start-Process -FilePath $verificationExe
```

Cancel the displayed data-root picker, then run:

```powershell
$appDataAfter = @(Get-ChildItem $env:APPDATA -Directory | Where-Object Name -Match 'Highlighter|highlighter-snowshot' | Select-Object -ExpandProperty FullName)
Compare-Object $appDataBefore $appDataAfter
Test-Path (Join-Path $verificationRoot 'Highlighter.location.json')
```

Expected: `Compare-Object` has no output, the locator check returns `False`, and the portable process exits.

- [ ] **Step 4: Verify first and second successful launches**

Launch again, choose `$selectedDataRoot` in the picker, and verify:

```powershell
New-Item -ItemType Directory -Force -Path $selectedDataRoot | Out-Null
Start-Process -FilePath $verificationExe
Get-Content (Join-Path $verificationRoot 'Highlighter.location.json')
Get-ChildItem $selectedDataRoot -Recurse -Depth 2
```

Expected: locator version 1 points to the selected absolute root; documented directories exist; the main window opens. Close and relaunch the same EXE and confirm it opens without prompting.

- [ ] **Step 5: Verify Settings migration and failure recovery**

Create one screenshot-history item, change the root in System Settings, and verify the app restarts with settings/history preserved and caches recreated. Then make the active root temporarily unavailable and relaunch.

Expected: the recovery dialog offers Retry, Choose Another Directory, and Exit; choosing Exit does not create or use `%APPDATA%` data.

- [ ] **Step 6: Record final repository state**

Run:

```powershell
git status --short --branch
git log --oneline -8
```

Expected: no uncommitted source changes; commits correspond to the plan tasks.
