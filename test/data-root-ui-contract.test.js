const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readConfigSource } = require('./helpers/config-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const dataRootDomain = fs.readFileSync(path.join(__dirname, '..', 'main', 'domains', 'data-root', 'index.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const config = readConfigSource()
const settingsIpc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'settings-ipc.js'), 'utf8')
const historyService = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'history-service.js'), 'utf8')
const windowActions = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'window-actions.js'), 'utf8')

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return source.slice(startIndex, endIndex)
}

test('portable bootstrap runs before Electron storage or window consumers', () => {
  assert.match(main, /require\('\.\/main\/services\/data-root-bootstrap'\)/)
  assert.match(dataRootDomain, /require\('\.\.\/\.\.\/services\/data-root'\)/)
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
  assert.match(main, /getLongCaptureTempRoot: \(\) => activePaths\?\.longCaptureCache \|\| app\.getPath\('temp'\)/)
  assert.doesNotMatch(main, /tempRoot: path\.join\(app\.getPath\('userData'\), 'temp', 'recordings'\)/)
  assert.match(main, /dataDirectory: activePaths\?\.root \|\| app\.getPath\('userData'\)/)
  // "Open the data directory" moved into main/services/window-actions.js with the
  // other shell actions (main.js line budget): main.js still owns which root is
  // active, and the module performs the open on it.
  assert.match(main, /getDataRoot: \(\) => activePaths\?\.root \|\| app\.getPath\('userData'\)/)
  assert.match(windowActions, /shell\.openPath\(getDataRoot\(\)\)/)
})

test('first portable run selects a root, migrates legacy data, and never starts the app on cancel', () => {
  const choose = section(dataRootDomain, 'async function chooseInitialDataRoot()', 'async function recoverUnavailableDataRoot()')
  assert.match(choose, /dataRootContext\.startupError[\s\S]*showMessageBox/)
  assert.match(choose, /showOpenDialog\([\s\S]*openDirectory[\s\S]*createDirectory/)
  assert.match(choose, /if \(result\.canceled \|\| !result\.filePaths\[0\]\)[\s\S]*removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(0\)[\s\S]*return/)
  assert.match(choose, /validateDataRoot\(targetRoot, dataRootContext\.legacyUserData\)/)
  assert.match(choose, /migrateDataRoot\(\{[\s\S]*source: createLegacySourcePaths\(dataRootContext\.legacyUserData\)[\s\S]*target: createDataPaths\(targetRoot\)[\s\S]*previousRoot: ''/)
  assert.match(choose, /removeProvisionalRoot\(dataRootContext\)[\s\S]*relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(0\)/)
  assert.doesNotMatch(choose, /initializeStore\(/)
})

test('unavailable portable roots recover by retry, alternate root, or exit only', () => {
  const recover = section(dataRootDomain, 'async function recoverUnavailableDataRoot()', 'function getInfo()')
  assert.match(recover, /buttons: \['重试', '选择其他目录', '退出'\]/)
  assert.match(recover, /validateDataRoot\(dataRootContext\.requestedRoot\)[\s\S]*ensureDataLayout\(createDataPaths/)
  assert.match(recover, /showOpenDialog\([\s\S]*openDirectory[\s\S]*createDirectory/)
  assert.match(recover, /writeLocator\(dataRootContext\.locatorPath, targetRoot\)/)
  assert.match(recover, /relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(0\)/)
  assert.match(recover, /removeProvisionalRoot\(dataRootContext\)[\s\S]*app\.exit\(1\)/)
  assert.doesNotMatch(recover, /initializeStore\(/)
})

test('unavailable recovery never replaces the locator while migration is pending', () => {
  const recover = section(dataRootDomain, 'async function recoverUnavailableDataRoot()', 'function getInfo()')
  const chooseAnother = recover.slice(recover.indexOf('if (response === 1)'), recover.indexOf('removeProvisionalRoot(dataRootContext)', recover.indexOf('if (response === 1)')))
  const pendingGuard = chooseAnother.match(/if \(fs\.existsSync\(dataRootContext\.pendingPath\)\) \{[^}]*\}/)?.[0] || ''

  assert.match(pendingGuard, /未完成的数据目录迁移/)
  assert.match(pendingGuard, /continue/)
  assert.doesNotMatch(pendingGuard, /writeLocator/)
  assert.ok(chooseAnother.indexOf('fs.existsSync(dataRootContext.pendingPath)') < chooseAnother.indexOf('dialog.showOpenDialog('))
})

test('startup recovers unavailable roots and finalizes every customized root before initialization', () => {
  const start = section(main, 'async function startApplication()', 'const gotTheLock')
  assert.match(start, /if \(dataRootContext\.needsSelection\) \{[\s\S]*recoverUnavailableDataRoot\(\)[\s\S]*return[\s\S]*\}[\s\S]*initializeStore\(\)/)
  assert.match(start, /if \(activePaths\) \{[\s\S]*verifyAndFinalizeMigration\(\{[\s\S]*pendingPath: dataRootContext\.pendingPath[\s\S]*activeRoot: activePaths\.root/)
  assert.doesNotMatch(start, /verifyAndFinalizeMigration\([\s\S]*pendingPath: (?:undefined|null)/)
  assert.match(start, /if \(!finalization\.finalized && finalization\.cleanupErrors\.length\)[\s\S]*console\.(?:warn|error)/)
  assert.doesNotMatch(start.match(/if \(!finalization\.finalized && finalization\.cleanupErrors\.length\) \{[^}]*\}/)[0], /rollbackPendingMigration/)
  assert.ok(start.indexOf('verifyAndFinalizeMigration(') < start.indexOf('initializeStore()'))
  assert.ok(start.indexOf('initializeStore()') < start.indexOf('persistSettings(getSettings())'))
})

test('a pending startup failure rolls back, reports, and relaunches without starting services', () => {
  const start = section(main, 'async function startApplication()', 'const gotTheLock')
  assert.match(start, /const hasPendingMigration = fs\.existsSync\(dataRootContext\.pendingPath\)/)
  assert.match(start, /catch \(startupError\) \{[\s\S]*if \(!hasPendingMigration\) throw startupError[\s\S]*app\.releaseSingleInstanceLock\(\)[\s\S]*rollbackPendingMigration\(\{[\s\S]*dialog\.showErrorBox[\s\S]*relaunchApplication\(\{ app, dataRootContext \}\)[\s\S]*app\.exit\(1\)[\s\S]*return/)
  assert.ok(start.indexOf('app.releaseSingleInstanceLock()') < start.indexOf('rollbackPendingMigration({'))
  const rollbackRecovery = start.slice(start.indexOf('catch (startupError)'), start.indexOf('initializeStore()', start.indexOf('catch (startupError)') + 1))
  assert.doesNotMatch(rollbackRecovery, /createTrayIcon|createToolbarWindow|createMainWindow|registerShortcuts|initSelectionHook|getOcrService/)
})

test('single-instance rejection removes provisional storage and ready failures exit cleanly', () => {
  const lifecycle = section(main, 'const gotTheLock')
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
  // D2-4（S14/D2-2）：renderSystemSettings 搬到 routes/settings.js 后，主壳不再内联
  // `void renderSystemSettings().catch(...)`；async 失败提示改由分派表承载 ——
  // 断言随之改为"主壳仍为 settings-system 保留错误回退文案 + 该入口已登记"。
  // P0-1-T3（S1，批次 C）：fallbackMessage 改为语言表的键，文案本体落在
  // shared/locales/config.js（readConfigSource() 已拼接它），两条一起断言。
  assert.match(config, /'settings-system': \{ key: 'renderSystemSettings', fallbackMessage: 'config\.error\.read-data-root' \}/)
  assert.match(config, /'config\.error\.read-data-root': '无法读取软件数据目录'/)
  assert.match(config, /window\.configRoutes\[entry\.key\]/)
  assert.match(config, /catch\(\(error\) => toast\(error\.message \|\| t\(entry\.fallbackMessage\)\)\)/)
  assert.match(config, /window\.configRoutes\['renderSystemSettings'\]/)
})

test('main process keeps data-root migration privileged, serialized, and restart-only on success', () => {
  assert.match(dataRootDomain, /function getInfo\(\)[\s\S]*customized: !!dataRootContext\.paths/)
  assert.match(dataRootDomain, /path: dataRootContext\.paths\?\.root \|\| dataRootContext\.legacyUserData/)
  assert.match(dataRootDomain, /function open\(\)[\s\S]*shell\.openPath\(dataRootContext\.paths\?\.root \|\| app\.getPath\('userData'\)\)/)
  assert.match(main, /registerDataRootIpc\(\{[\s\S]*controller: dataRootDomain\.createController\(\)/)
  const change = section(dataRootDomain, 'async function changeDataRoot()', 'async function chooseInitialDataRoot()')
  assert.doesNotMatch(change, /只有便携版/)
  assert.match(change, /isMigrationInProgress\(\) \|\| fs\.existsSync\(dataRootContext\.pendingPath\)/)
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
  const stopWriters = section(dataRootDomain, 'async function stopManagedDataWriters()', 'function restoreManagedDataWriters')
  assert.match(stopWriters, /activeOcrService\.stop\(\)[\s\S]*await Promise\.allSettled\(inFlight\)/)
  assert.match(stopWriters, /await recordDomain\.shutdown\(\)[\s\S]*recordingServiceRef\.set\(null\)/)
  assert.match(dataRootDomain, /await longCaptureDomain\.shutdown\(\)/)
  assert.match(main, /function assertManagedDataWritable\(\)[\s\S]*dataRootMigrationInProgress[\s\S]*throw new Error/)
  assert.match(main, /createAppLogger\(\{[\s\S]*isEnabled: \(\) => !dataRootMigrationInProgress/)
  assert.match(historyService, /persistDataUrl\(dataUrl, meta = \{\}\) \{[\s\S]*this\.assertWritable\(\)/)
  assert.match(historyService, /persistFile\(sourcePath, meta = \{\}\) \{[\s\S]*this\.assertWritable\(\)/)
  assert.match(settingsIpc, /settings:update[\s\S]*assertWritable\(\)[\s\S]*settings:reset[\s\S]*assertWritable\(\)/)
  assert.match(main, /assertWritable: assertManagedDataWritable/)
})

test('long capture rechecks the migration gate after desktop source lookup', () => {
  const longCaptureDomain = fs.readFileSync(path.join(__dirname, '..', 'main', 'domains', 'long-capture', 'index.js'), 'utf8')
  assert.match(
    longCaptureDomain,
    /const source = await getDesktopSourceForDisplay\(display\)\s+assertManagedDataWritable\(\)\s+const settings = getSettings\(\)\s+const session = new LongCaptureSession\(/
  )
  assert.match(longCaptureDomain, /isMigrationInProgress\?\.\(\)/)
})

test('recording cache operations are tracked until they settle before migration', () => {
  const recordDomain = fs.readFileSync(path.join(__dirname, '..', 'main/domains/record/index.js'), 'utf8')
  assert.match(main, /require\('\.\/main\/services\/managed-writer-coordinator'\)/)
  assert.match(main, /const managedRecordingWriters = new ManagedWriterCoordinator\(\)/)
  assert.match(recordDomain, /function cleanupRecordSession\(win, service = null, allowBlocked = false\)/)
  for (const operation of ['appendChunk', 'finishSession', 'transcode']) {
    assert.match(recordDomain, new RegExp(`managedRecordingWriters\\.track\\([^)]*${operation}`))
  }
  assert.match(recordDomain, /managedRecordingWriters\.track\(\(\) => service\.startSession\(\)/)
  assert.match(recordDomain, /function cleanupRecordSession\(win, service = null, allowBlocked = false\)[\s\S]*managedRecordingWriters\.track\(\(\) => activeService\.cleanupSession[\s\S]*\{ allowBlocked \}/)
  const change = section(dataRootDomain, 'async function changeDataRoot()', 'async function chooseInitialDataRoot()')
  assert.match(change, /quiesceAndMigrate\(\{[\s\S]*coordinator: managedRecordingWriters[\s\S]*stopWriters: stopManagedDataWriters[\s\S]*migrate:/)
  assert.match(recordDomain, /await cleanupRecordSession\(win, service\)[\s\S]*managedRecordingWriters\.assertOpen\(\)[\s\S]*managedRecordingWriters\.track\(\(\) => service\.startSession\(\)\)/)
})
