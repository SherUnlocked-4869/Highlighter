const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const config = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')

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
  assert.match(main, /const \{ relaunchApplication \} = require\('\.\/main\/services\/relaunch-application'\)/)
  assert.doesNotMatch(main, /\bapp\.relaunch\(/)
  assert.match(main, /const \{ name: applicationName \} = require\('\.\/package\.json'\)/)
  assert.match(main, /const dataRootContext = prepareDataRoot\(\{ app, applicationName \}\)/)
  assert.match(main, /const activePaths = dataRootContext\.paths/)
  assert.ok(main.indexOf('prepareDataRoot({ app, applicationName })') < main.indexOf('new Store('))
  assert.ok(main.indexOf('prepareDataRoot({ app, applicationName })') < main.indexOf('app.requestSingleInstanceLock()'))
  assert.match(main, /let store = null/)
  assert.match(main, /function initializeStore\(\)/)
  assert.match(main, /if \(activePaths\) storeOptions\.cwd = activePaths\.config/)
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
  assert.match(choose, /removeProvisionalRoot\(dataRootContext\)[\s\S]*relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(0\)/)
  assert.doesNotMatch(choose, /initializeStore\(/)
})

test('unavailable portable roots recover by retry, alternate root, or exit only', () => {
  const recover = section('async function recoverUnavailableDataRoot()', 'async function startApplication()')
  assert.match(recover, /buttons: \['重试', '选择其他目录', '退出'\]/)
  assert.match(recover, /validateDataRoot\(dataRootContext\.requestedRoot\)[\s\S]*ensureDataLayout\(createDataPaths/)
  assert.match(recover, /showOpenDialog\([\s\S]*openDirectory[\s\S]*createDirectory/)
  assert.match(recover, /writeLocator\(dataRootContext\.locatorPath, targetRoot\)/)
  assert.match(recover, /relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(0\)/)
  assert.match(recover, /removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(1\)/)
  assert.doesNotMatch(recover, /initializeStore\(/)
})

test('unavailable recovery never replaces the locator while migration is pending', () => {
  const recover = section('async function recoverUnavailableDataRoot()', 'async function startApplication()')
  const chooseAnother = recover.slice(recover.indexOf('if (response === 1)'), recover.indexOf('removeProvisionalRoot(dataRootContext)', recover.indexOf('if (response === 1)')))
  const pendingGuard = chooseAnother.match(/if \(fs\.existsSync\(dataRootContext\.pendingPath\)\) \{[^}]*\}/)?.[0] || ''

  assert.match(pendingGuard, /未完成的数据目录迁移/)
  assert.match(pendingGuard, /continue/)
  assert.doesNotMatch(pendingGuard, /writeLocator/)
  assert.ok(chooseAnother.indexOf('fs.existsSync(dataRootContext.pendingPath)') < chooseAnother.indexOf('dialog.showOpenDialog('))
})

test('startup recovers unavailable roots and finalizes every customized root before initialization', () => {
  const start = section('async function startApplication()', 'const gotTheLock')
  assert.match(start, /if \(dataRootContext\.needsSelection\) \{[\s\S]*recoverUnavailableDataRoot\(\)[\s\S]*return[\s\S]*\}[\s\S]*initializeStore\(\)/)
  assert.match(start, /if \(activePaths\) \{[\s\S]*verifyAndFinalizeMigration\(\{[\s\S]*pendingPath: dataRootContext\.pendingPath[\s\S]*activeRoot: activePaths\.root/)
  assert.doesNotMatch(start, /verifyAndFinalizeMigration\([\s\S]*pendingPath: (?:undefined|null)/)
  assert.match(start, /if \(!finalization\.finalized && finalization\.cleanupErrors\.length\)[\s\S]*console\.(?:warn|error)/)
  assert.doesNotMatch(start.match(/if \(!finalization\.finalized && finalization\.cleanupErrors\.length\) \{[^}]*\}/)[0], /rollbackPendingMigration/)
  assert.ok(start.indexOf('verifyAndFinalizeMigration(') < start.indexOf('initializeStore()'))
  assert.ok(start.indexOf('initializeStore()') < start.indexOf('persistSettings(getSettings())'))
})

test('a pending startup failure rolls back, reports, and relaunches without starting services', () => {
  const start = section('async function startApplication()', 'const gotTheLock')
  assert.match(start, /const hasPendingMigration = fs\.existsSync\(dataRootContext\.pendingPath\)/)
  assert.match(start, /catch \(startupError\) \{[\s\S]*if \(!hasPendingMigration\) throw startupError[\s\S]*app\.releaseSingleInstanceLock\(\)[\s\S]*rollbackPendingMigration\(\{[\s\S]*dialog\.showErrorBox[\s\S]*relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(1\)[\s\S]*return/)
  assert.ok(start.indexOf('app.releaseSingleInstanceLock()') < start.indexOf('rollbackPendingMigration({'))
  const rollbackRecovery = start.slice(start.indexOf('catch (startupError)'), start.indexOf('initializeStore()', start.indexOf('catch (startupError)') + 1))
  assert.doesNotMatch(rollbackRecovery, /createTrayIcon|createToolbarWindow|createMainWindow|registerShortcuts|initSelectionHook|getOcrService/)
})

test('single-instance rejection removes provisional storage and ready failures exit cleanly', () => {
  const lifecycle = section('const gotTheLock')
  assert.match(lifecycle, /if \(!gotTheLock\) \{[\s\S]*removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.quit\(\)/)
  assert.match(lifecycle, /app\.whenReady\(\)\.then\(startApplication\)\.catch\([\s\S]*dialog\.showErrorBox[\s\S]*removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(1\)/)
})

test('preload exposes only fixed data-root IPC methods', () => {
  assert.match(preload, /getDataRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-root:get'\)/)
  assert.match(preload, /changeDataRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-root:change'\)/)
  assert.match(preload, /openDataRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-root:open'\)/)
  assert.doesNotMatch(preload, /changeDataRoot:\s*\([^)]/)
  assert.doesNotMatch(preload, /openDataRoot:\s*\([^)]/)
})

test('system settings renders and uses data-root controls in every build', () => {
  assert.match(config, /async function renderSystemSettings\(\)/)
  assert.match(config, /await window\.electronAPI\.getDataRoot\(\)/)
  assert.match(config, /id="dataRoot"/)
  assert.match(config, /id="openDataRoot"/)
  assert.match(config, /id="changeDataRoot"/)
  assert.doesNotMatch(config, /id="changeDataRoot"[^>]*disabled/)
  assert.match(config, /软件数据目录/)
  assert.match(config, /截图导出目录/)
  assert.match(config, /截图历史存储目录/)
  assert.match(config, /readonly/)
  assert.match(config, /window\.electronAPI\.openDataRoot\(\)/)
  assert.match(config, /window\.electronAPI\.changeDataRoot\(\)/)
  assert.match(config, /void renderSystemSettings\(\)\.catch/)
})

test('main process keeps data-root migration privileged, serialized, and restart-only on success', () => {
  const handlers = section("ipcMain.handle('settings:get'", "ipcMain.handle('history:list'")
  assert.match(handlers, /customized: !!dataRootContext\.paths/)
  assert.match(handlers, /path: dataRootContext\.paths\?\.root \|\| dataRootContext\.legacyUserData/)
  assert.match(handlers, /ipcMain\.handle\('data-root:open', \(\) => shell\.openPath\(dataRootContext\.paths\?\.root \|\| app\.getPath\('userData'\)\)\)/)
  const change = section("ipcMain.handle('data-root:change'", "ipcMain.handle('app:open-data-directory'")
  assert.doesNotMatch(change, /只有便携版/)
  assert.match(change, /dataRootMigrationInProgress \|\| fs\.existsSync\(dataRootContext\.pendingPath\)/)
  assert.match(change, /dataRootContext\.paths[\s\S]*createManagedSourcePaths\(activeRoot\)[\s\S]*createLegacySourcePaths\(activeRoot\)/)
  assert.match(change, /dialog\.showOpenDialog\([\s\S]*openDirectory[\s\S]*createDirectory/)
  assert.match(change, /if \(result\.canceled \|\| !result\.filePaths\[0]\) return \{ canceled: true \}/)
  assert.match(change, /validateDataRoot\(result\.filePaths\[0], activeRoot\)/)
  assert.match(change, /if \(path\.resolve\(targetRoot\) === path\.resolve\(activeRoot\)\) return \{ unchanged: true \}/)
  assert.match(change, /配置、日志、截图历史[\s\S]*重启/)
  assert.match(change, /persistSettings\(getSettings\(\)\)/)
  assert.match(change, /stopWriters: stopManagedDataWriters/)
  assert.match(change, /migrateDataRoot\(\{[\s\S]*source: sourcePaths[\s\S]*target: createDataPaths\(targetRoot\)[\s\S]*portableDirectory: dataRootContext\.locatorDirectory[\s\S]*previousRoot/)
  assert.match(change, /setImmediate\(\(\) => \{[\s\S]*relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(0\)/)
  assert.match(change, /return \{ restarting: true \}/)
})

test('migration quiesces managed writers and blocks late config, log, and history writes', () => {
  const stopWriters = section('async function stopManagedDataWriters()', 'function restoreManagedDataWriters')
  assert.match(stopWriters, /activeOcrService\.stop\(\)[\s\S]*await Promise\.allSettled\(inFlight\)/)
  assert.match(stopWriters, /await closeRecordFlow\(activeRecordingService, true\)[\s\S]*await activeRecordingService\.dispose\(\)/)
  assert.match(stopWriters, /await longCapture\.finishingPromise[\s\S]*closeLongCapture\(\)/)
  assert.match(main, /function assertManagedDataWritable\(\)[\s\S]*dataRootMigrationInProgress[\s\S]*throw new Error/)
  assert.match(main, /createAppLogger\(\{[\s\S]*isEnabled: \(\) => !dataRootMigrationInProgress/)
  assert.match(section('function persistHistory(', 'function createMainWindow'), /assertManagedDataWritable\(\)/)
  assert.match(section("ipcMain.handle('settings:get'", "ipcMain.handle('config:get-api-key'"), /settings:update[\s\S]*assertManagedDataWritable\(\)[\s\S]*settings:reset[\s\S]*assertManagedDataWritable\(\)/)
})

test('long capture rechecks the migration gate after desktop source lookup', () => {
  const createLongCapture = section('async function createLongCaptureFromSelection', 'async function finishLongCapture')
  assert.match(
    createLongCapture,
    /const source = await getDesktopSourceForDisplay\(display\)\s+assertManagedDataWritable\(\)\s+const settings = getSettings\(\)\s+const session = new LongCaptureSession\(/
  )
})

test('recording cache operations are tracked until they settle before migration', () => {
  assert.match(main, /require\('\.\/main\/services\/managed-writer-coordinator'\)/)
  assert.match(main, /const managedRecordingWriters = new ManagedWriterCoordinator\(\)/)
  assert.match(main, /function cleanupRecordSession\(win, service = recordingService, allowBlocked = false\)/)
  const recording = section("ipcMain.handle('record:start-session'", "ipcMain.on('record:close'")
  for (const operation of ['appendChunk', 'finishSession', 'transcode']) {
    assert.match(recording, new RegExp(`managedRecordingWriters\\.track\\([^)]*${operation}`))
  }
  assert.match(recording, /managedRecordingWriters\.track\(\(\) => service\.startSession\(\)/)
  assert.match(main, /function cleanupRecordSession\(win, service = recordingService, allowBlocked = false\)[\s\S]*managedRecordingWriters\.track\(\(\) => service\.cleanupSession[\s\S]*\{ allowBlocked \}/)
  const change = section("ipcMain.handle('data-root:change'", "ipcMain.handle('app:open-data-directory'")
  assert.match(change, /quiesceAndMigrate\(\{[\s\S]*coordinator: managedRecordingWriters[\s\S]*stopWriters: stopManagedDataWriters[\s\S]*migrate:/)
  const start = section("ipcMain.handle('record:start-session'", "ipcMain.handle('record:append-chunk'")
  assert.match(start, /await cleanupRecordSession\(win, service\)[\s\S]*managedRecordingWriters\.assertOpen\(\)[\s\S]*managedRecordingWriters\.track\(\(\) => service\.startSession\(\)\)/)
})
