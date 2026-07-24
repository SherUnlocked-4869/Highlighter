const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function section(start, end) {
  const startIndex = main.indexOf(start)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  const endIndex = end ? main.indexOf(end, startIndex + start.length) : main.length
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return main.slice(startIndex, endIndex)
}

test('portable bootstrap runs before Electron storage or window consumers', () => {
  assert.match(main, /require\('\.\/main\/services\/data-root-bootstrap'\)/)
  assert.match(main, /require\('\.\/main\/services\/data-root'\)/)
  assert.match(main, /require\('\.\/main\/services\/data-root-migration'\)/)
  assert.match(main, /const dataRootContext = prepareDataRoot\(\{ app \}\)/)
  assert.match(main, /const activePaths = dataRootContext\.paths/)
  assert.ok(main.indexOf('prepareDataRoot({ app })') < main.indexOf('new Store('))
  assert.ok(main.indexOf('prepareDataRoot({ app })') < main.indexOf('app.requestSingleInstanceLock()'))
  assert.match(main, /let store = null/)
  assert.match(main, /function initializeStore\(\)/)
  assert.match(main, /if \(dataRootContext\.portable\) storeOptions\.cwd = dataRootContext\.paths\.config/)
})

test('portable named paths own history, logs, and service caches', () => {
  assert.match(main, /const defaultHistoryDirectory = activePaths\?\.history \|\| path\.join\(app\.getPath\('userData'\), 'capture-history'\)/)
  assert.match(main, /const logFile = activePaths \? path\.join\(activePaths\.logs, 'app\.log'\) : path\.join\(app\.getPath\('userData'\), 'app\.log'\)/)
  assert.match(main, /tempDir: activePaths\?\.ocrCache \|\| path\.join\(app\.getPath\('temp'\), 'Highlighter', 'ocr'\)/)
  assert.match(main, /tempRoot: activePaths\?\.recordingCache \|\| path\.join\(app\.getPath\('userData'\), 'temp', 'recordings'\)/)
  assert.match(main, /tempRoot: activePaths\?\.longCaptureCache \|\| app\.getPath\('temp'\)/)
  assert.doesNotMatch(main, /tempRoot: path\.join\(app\.getPath\('userData'\), 'temp', 'recordings'\)/)
  assert.match(main, /dataDirectory: activePaths\?\.root \|\| app\.getPath\('userData'\)/)
  assert.match(main, /shell\.openPath\(activePaths\?\.root \|\| app\.getPath\('userData'\)\)/)
})

test('first portable run selects a root, migrates legacy data, and never starts the app on cancel', () => {
  const choose = section('async function chooseInitialDataRoot()', 'async function recoverUnavailableDataRoot()')
  assert.match(choose, /dataRootContext\.startupError[\s\S]*showMessageBox/)
  assert.match(choose, /showOpenDialog\([\s\S]*openDirectory[\s\S]*createDirectory/)
  assert.match(choose, /if \(result\.canceled \|\| !result\.filePaths\[0\]\)[\s\S]*removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(0\)[\s\S]*return/)
  assert.match(choose, /validateDataRoot\(targetRoot, dataRootContext\.legacyUserData\)/)
  assert.match(choose, /migrateDataRoot\(\{[\s\S]*source: createLegacySourcePaths\(dataRootContext\.legacyUserData\)[\s\S]*target: createDataPaths\(targetRoot\)[\s\S]*previousRoot: ''/)
  assert.match(choose, /removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.relaunch\(\)[\s\S]*app\.exit\(0\)/)
  assert.doesNotMatch(choose, /initializeStore\(/)
})

test('unavailable portable roots recover by retry, alternate root, or exit only', () => {
  const recover = section('async function recoverUnavailableDataRoot()', 'async function startApplication()')
  assert.match(recover, /buttons: \['重试', '选择其他目录', '退出'\]/)
  assert.match(recover, /validateDataRoot\(dataRootContext\.requestedRoot\)[\s\S]*ensureDataLayout\(createDataPaths/)
  assert.match(recover, /showOpenDialog\([\s\S]*openDirectory[\s\S]*createDirectory/)
  assert.match(recover, /writeLocator\(dataRootContext\.locatorPath, targetRoot\)/)
  assert.match(recover, /app\.relaunch\(\)[\s\S]*app\.exit\(0\)/)
  assert.match(recover, /removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(1\)/)
  assert.doesNotMatch(recover, /initializeStore\(/)
})

test('startup guards non-portable finalization and returns before initializing a selection flow', () => {
  const start = section('async function startApplication()', 'const gotTheLock')
  assert.match(start, /if \(dataRootContext\.portable && dataRootContext\.needsSelection\) \{[\s\S]*return[\s\S]*\}[\s\S]*initializeStore\(\)/)
  assert.match(start, /if \(dataRootContext\.portable\) \{[\s\S]*verifyAndFinalizeMigration\(\{[\s\S]*pendingPath: dataRootContext\.pendingPath[\s\S]*activeRoot: activePaths\.root/)
  assert.doesNotMatch(start, /verifyAndFinalizeMigration\([\s\S]*pendingPath: (?:undefined|null)/)
  assert.match(start, /if \(!finalization\.finalized && finalization\.cleanupErrors\.length\)[\s\S]*console\.(?:warn|error)/)
  assert.doesNotMatch(start.match(/if \(!finalization\.finalized && finalization\.cleanupErrors\.length\) \{[^}]*\}/)[0], /rollbackPendingMigration/)
  assert.ok(start.indexOf('initializeStore()') < start.indexOf('verifyAndFinalizeMigration('))
  assert.ok(start.indexOf('verifyAndFinalizeMigration(') < start.indexOf("store.set('settings'"))
})

test('a pending startup failure rolls back, reports, and relaunches without starting services', () => {
  const start = section('async function startApplication()', 'const gotTheLock')
  assert.match(start, /const hasPendingMigration = fs\.existsSync\(dataRootContext\.pendingPath\)/)
  assert.match(start, /catch \(startupError\) \{[\s\S]*if \(!hasPendingMigration\) throw startupError[\s\S]*rollbackPendingMigration\(\{[\s\S]*dialog\.showErrorBox[\s\S]*app\.relaunch\(\)[\s\S]*app\.exit\(1\)[\s\S]*return/)
  const rollbackRecovery = start.slice(start.indexOf('catch (startupError)'), start.indexOf('initializeStore()', start.indexOf('catch (startupError)') + 1))
  assert.doesNotMatch(rollbackRecovery, /createTrayIcon|createToolbarWindow|createMainWindow|registerShortcuts|initSelectionHook|getOcrService/)
})

test('single-instance rejection removes provisional storage and ready failures exit cleanly', () => {
  const lifecycle = section('const gotTheLock')
  assert.match(lifecycle, /if \(!gotTheLock\) \{[\s\S]*removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.quit\(\)/)
  assert.match(lifecycle, /app\.whenReady\(\)\.then\(startApplication\)\.catch\([\s\S]*dialog\.showErrorBox[\s\S]*removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(1\)/)
})
