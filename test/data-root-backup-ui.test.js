'use strict'

// D04: the settings-page contract and the data-root domain wiring. The package
// service is covered by data-root-backup.test.js; this file checks that the UI
// exposes the backup block, that every string exists in the three languages, and
// that the domain stops writers, gates concurrency and switches the locator only
// after a verified restore.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { createDataRootDomain } = require('../main/domains/data-root')
const backupService = require('../main/services/data-root-backup')

const ROOT = path.join(__dirname, '..')
const settingsSource = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'settings.js'), 'utf8')
const domainSource = fs.readFileSync(path.join(ROOT, 'main', 'domains', 'data-root', 'index.js'), 'utf8')
const serviceSource = fs.readFileSync(path.join(ROOT, 'main', 'services', 'data-root-backup.js'), 'utf8')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function localeTables() {
  globalThis.__LOCALES = {}
  delete require.cache[require.resolve(path.join(ROOT, 'shared', 'locales', 'config.js'))]
  require(path.join(ROOT, 'shared', 'locales', 'config.js'))
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return source.slice(startIndex, endIndex)
}

async function temporaryDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-backup-ui-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

function fakeDomain(t, { backupServiceImpl, inProgress = false, directory = '', tasks = [] } = {}) {
  const calls = []
  const state = { value: inProgress }
  const activeTasks = tasks
  const base = directory || path.join(ROOT, '.tmp-d04-never-used')
  const app = {
    getVersion: () => '5.0.1',
    getPath: () => base,
    relaunch: () => calls.push('relaunch'),
    exit: (code) => calls.push(`exit:${code}`)
  }
  const domain = createDataRootDomain({
    app,
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 })
    },
    fs,
    path,
    shell: { openPath: async () => '' },
    dataRootContext: {
      paths: { root: path.join(base, 'active-root') },
      legacyUserData: path.join(base, 'legacy'),
      pendingPath: path.join(base, 'pending.json'),
      locatorPath: path.join(base, 'Highlighter.location.json'),
      locatorDirectory: base,
      portable: true
    },
    getSettings: () => ({ plugins: { ocr: false }, ocr: { hotStart: false } }),
    persistSettings: () => {},
    isMigrationInProgress: () => state.value,
    setMigrationInProgress: (value) => {
      state.value = value
      calls.push(`gate:${value}`)
    },
    ocrServiceRef: { get: () => null, set: () => {} },
    recordingServiceRef: { set: () => {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    recordDomain: {
      shutdown: async () => calls.push('record-shutdown'),
      isTaskActive: () => activeTasks.includes('recording')
    },
    longCaptureDomain: {
      shutdown: async () => calls.push('long-shutdown'),
      isTaskActive: () => activeTasks.includes('long-capture')
    },
    managedRecordingWriters: {},
    removeProvisionalRoot: () => true,
    markSessionClean: () => calls.push('session-clean'),
    log: () => {},
    selectionDomain: {
      quiesceConversations: async () => calls.push('selection-quiesce'),
      resumeConversations: () => calls.push('selection-resume')
    },
    getClipboardDomain: () => ({
      quiesce: async () => calls.push('clipboard-quiesce'),
      resume: async () => calls.push('clipboard-resume')
    }),
    backupService: backupServiceImpl || {
      // D04 (08): the domain validates first; the fake mirrors the service's contract.
      validateBackupRequest: async (options) => {
        calls.push('validate')
        const modules = Array.isArray(options.modules) ? options.modules : ['history', 'clipboard', 'recordings', 'settings']
        return {
          ok: true,
          code: 'ok',
          modules,
          layout: 'managed',
          requiresQuiesce: modules.filter((id) => ['usage', 'clipboard', 'conversations'].includes(id)),
          requiresExclusive: modules.includes('recordings')
        }
      },
      createBackup: async (options) => {
        calls.push('service-create')
        calls.push(`writers:${options.writersQuiesced}`)
        calls.push(`root:${options.dataRoot}`)
        return { ok: true, code: 'ok', directory: 'D:\\backups\\one', totalFiles: 1, totalBytes: 1 }
      },
      inspectBackup: async (directory) => {
        calls.push(`inspect:${directory}`)
        return { ok: true, code: 'ok', version: '1', modules: {} }
      },
      restoreBackup: async () => ({ ok: false, code: 'migration-required' }),
      deleteBackup: async () => ({ ok: true, code: 'ok' })
    }
  })
  return { domain, calls, state }
}

test('the system page renders the backup block with module and directory controls', () => {
  for (const id of [
    'backupTargetDirectory',
    'chooseBackupTarget',
    'backupSourceDirectory',
    'chooseBackupSource',
    'backupExternalHistory',
    'chooseBackupExternalHistory',
    'clearBackupExternalHistory',
    'createBackup',
    'previewBackup',
    'restoreBackup',
    'deleteIncompleteBackup',
    'backupSummary'
  ]) {
    assert.match(settingsSource, new RegExp(`id="${id}"`), `settings page has #${id}`)
  }
  assert.match(settingsSource, /const SYSTEM_BACKUP_MODULES = \['history', 'clipboard', 'recordings', 'conversations', 'usage', 'settings'\]/)
  assert.match(settingsSource, /data-backup-module value="\$\{id\}"/)
  assert.match(settingsSource, /backup-module-\$\{id\}/)
  assert.match(settingsSource, /systemBackupApi\(\)/)
  assert.match(settingsSource, /window\.electronAPI\.chooseDirectory\(\)/)
  assert.match(settingsSource, /backupPreviewMarkup\(result\)/)
  assert.match(settingsSource, /bindSystemBackupControls\(\)/)
})

test('restore previews and confirms before it calls the restore endpoint', () => {
  const restore = section(settingsSource, 'restoreButton.onclick', 'deleteButton.onclick')
  const inspectIndex = restore.indexOf('api.backupInspect(directory)')
  const confirmIndex = restore.indexOf("backup-confirm-restore")
  const chooseIndex = restore.indexOf('chooseDirectory()')
  const restoreIndex = restore.indexOf('api.backupRestore(')
  assert.ok(inspectIndex !== -1, 'restore inspects the package first')
  assert.ok(confirmIndex !== -1, 'restore asks for confirmation')
  assert.ok(chooseIndex !== -1, 'restore chooses a new root through the dialog channel')
  assert.ok(restoreIndex !== -1, 'restore calls the endpoint')
  assert.ok(inspectIndex < confirmIndex, 'preview happens before confirmation')
  assert.ok(confirmIndex < restoreIndex, 'confirmation happens before restore')
  assert.match(restore, /backup-restore-safe/)
  assert.match(restore, /if \(!result \|\| result\.ok !== true\)/)
})

test('create backup requires selected modules and a destination', () => {
  const create = section(settingsSource, 'createButton.onclick', 'previewButton.onclick')
  assert.match(create, /querySelectorAll\('\[data-backup-module\]'\)/)
  assert.match(create, /backup-select-module/)
  assert.match(create, /backup-choose-target/)
  assert.match(create, /externalHistoryInput\.value\.trim\(\)/)
  assert.match(create, /\{ id: 'history', directory: externalHistory \}/)
  assert.match(create, /api\.backupCreate\(\{ modules, targetDirectory: targetInput\.value\.trim\(\) \}\)/)
  assert.match(create, /backup-created/)
})

test('every backup string exists in all three languages', () => {
  const tables = localeTables()
  const keys = [
    'backup-section',
    'backup-modules',
    'backup-modules-hint',
    'backup-module-history',
    'backup-module-clipboard',
    'backup-module-recordings',
    'backup-module-conversations',
    'backup-module-usage',
    'backup-module-settings',
    'backup-target',
    'backup-target-hint',
    'backup-source',
    'backup-source-hint',
    'backup-external-history',
    'backup-external-history-hint',
    'backup-clear',
    'backup-create',
    'backup-creating',
    'backup-preview',
    'backup-inspecting',
    'backup-restore',
    'backup-restoring',
    'backup-delete-incomplete',
    'backup-created',
    'backup-preview-title',
    'backup-version',
    'backup-format-version',
    'backup-size',
    'backup-files',
    'backup-checksum',
    'backup-external-refs',
    'backup-external-refs-value',
    'backup-external-refs-none',
    'backup-external-missing',
    'backup-sensitive',
    'backup-sensitive-hint',
    'backup-not-sensitive',
    'backup-module-line',
    'backup-confirm-restore',
    'backup-restored',
    'backup-restore-failed',
    'backup-restore-safe',
    'backup-key-hint',
    'backup-error-not-backup',
    'backup-error-incomplete',
    'backup-error-corrupt',
    'backup-error-future',
    'backup-error-unsupported',
    'backup-error-no-space',
    'backup-error-no-space-detail',
    'backup-error-checksum',
    'backup-error-target-not-empty',
    'backup-error-migration-required',
    'backup-error-unsupported-version',
    'backup-error-permission',
    'backup-error-copy-failed',
    'backup-error-io-error',
    'backup-error-restore-failed',
    'backup-error-verification-failed',
    'backup-error-migration-failed',
    'backup-error-invalid-request',
    'backup-error-invalid-target'
  ]
  for (const language of LANGUAGES) {
    for (const key of keys) {
      const fullKey = `config.settings-system.${key}`
      const value = tables[language][fullKey]
      assert.equal(typeof value, 'string', `${language} missing ${fullKey}`)
      assert.ok(value.trim().length > 0, `${language} has an empty ${fullKey}`)
    }
  }
  for (const [key, value] of Object.entries(tables['en-US'])) {
    if (!key.startsWith('config.settings-system.backup-')) continue
    assert.doesNotMatch(value, /[\u4e00-\u9fff]/, `en-US ${key} contains Chinese text`)
  }
})

test('the backup service never opens a database or a media process itself', () => {
  assert.doesNotMatch(serviceSource, /node:sqlite|better-sqlite3|openDatabase|\.prepare\(/)
  assert.doesNotMatch(serviceSource, /ffprobe|ffmpeg|spawn\(/)
  assert.match(serviceSource, /MANIFEST_FILE = 'modules\.json'/)
  assert.match(serviceSource, /MARKER_FILE = '\.highlighter-backup\.json'/)
  // Plan item 06: format 2 puts the history index inside the history module.
  assert.equal(backupService.BACKUP_FORMAT_VERSION, 2)
  assert.equal(backupService.MIN_SUPPORTED_FORMAT_VERSION, 1, 'format 1 packages stay readable')
  assert.match(serviceSource, /HISTORY_INDEX_FILE = 'index\.json'/)
})

test('the data-root domain exposes backup controls and validates before touching writers', () => {
  assert.match(domainSource, /backupCreate: createDataRootBackup/)
  assert.match(domainSource, /backupInspect: inspectDataRootBackup/)
  assert.match(domainSource, /backupDelete: removeDataRootBackup/)
  assert.match(domainSource, /backupRestore: restoreDataRootBackup/)
  const create = section(domainSource, 'async function createDataRootBackup', 'function inspectDataRootBackup')
  assert.match(create, /assertBackupAllowed\(\)/)
  // D04 (08): the request is validated first, and only the selected modules' writers stop.
  assert.match(create, /await backupService\.validateBackupRequest\(/)
  assert.ok(create.indexOf('validateBackupRequest') < create.indexOf('quiesceBackupWriters'), 'validation precedes any writer stop')
  assert.doesNotMatch(create, /await stopManagedDataWriters\(\)/, 'a settings-only backup never stops every writer')
  const restore = section(domainSource, 'async function restoreDataRootBackup', '    changeDataRoot,')
  assert.match(restore, /assertBackupAllowed\(\)/)
  assert.match(restore, /exclusiveActivityBlocked\(\)/)
  assert.match(restore, /await stopManagedDataWriters\(\)/)
  assert.match(restore, /if \(!result\.ok\) return result/)
  assert.match(restore, /await writeLocator\(dataRootContext\.locatorPath, result\.dataRoot\)/)
  assert.ok(restore.indexOf('writeLocator(') > restore.indexOf('result.ok'), 'locator is written only after a successful restore')
  assert.match(restore, /restarting = true/)
  assert.match(restore, /relaunchApplication\(\{ app, dataRootContext \}\)/)
})

test('D04 (08): a settings-only backup stops nothing, so a live recording keeps running', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain, calls, state } = fakeDomain(t, { directory, tasks: ['recording'] })
  const result = await domain.createController().backupCreate({ modules: ['settings'], targetDirectory: 'D:\\backups' })
  assert.equal(result.ok, true)
  assert.equal(state.value, false, 'the migration gate is never taken')
  assert.deepEqual(calls.filter((entry) => entry !== `root:${path.join(directory, 'active-root')}`), [
    'validate',
    'service-create',
    'writers:false'
  ])
  assert.ok(!calls.includes('record-shutdown'), 'the recorder is not shut down')
  assert.ok(!calls.includes('long-shutdown'))
  assert.ok(!calls.includes('clipboard-quiesce'))
})

test('D04 (08): only the selected SQLite modules have their writers paused', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain, calls, state } = fakeDomain(t, { directory })
  const result = await domain.createController().backupCreate({ modules: ['usage', 'clipboard'], targetDirectory: 'D:\\backups' })
  assert.equal(result.ok, true)
  assert.equal(state.value, false)
  assert.ok(calls.includes('clipboard-quiesce'))
  assert.ok(calls.includes('clipboard-resume'))
  assert.ok(!calls.includes('selection-quiesce'), 'conversations were not selected')
  assert.ok(!calls.includes('record-shutdown'))
  assert.ok(!calls.includes('gate:true'), 'no exclusive module was selected')
})

test('D04 (08): a recordings backup refuses to freeze a live recording and offers a retry', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain, calls, state } = fakeDomain(t, { directory, tasks: ['recording'] })
  const result = await domain.createController().backupCreate({ modules: ['recordings'], targetDirectory: 'D:\\backups' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'activity-in-progress')
  assert.equal(result.retryable, true)
  assert.deepEqual(result.tasks, ['recording'])
  assert.equal(state.value, false, 'the gate is not left closed')
  assert.deepEqual(calls, ['validate'], 'nothing was stopped and no package was written')
})

test('D04 (08): a refused validation never touches a writer', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain, calls, state } = fakeDomain(t, {
    directory,
    tasks: ['recording'],
    backupServiceImpl: {
      validateBackupRequest: async () => ({ ok: false, code: 'insufficient-space', requiredBytes: 10, freeBytes: 1 }),
      createBackup: async () => { calls.push('service-create'); return { ok: true } }
    }
  })
  const result = await domain.createController().backupCreate({ modules: ['recordings'], targetDirectory: 'D:\\backups' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'insufficient-space')
  assert.equal(state.value, false)
  assert.equal(calls.includes('service-create'), false)
})

test('a backup cannot start while a migration or another backup is pending', async (t) => {
  const { domain, calls } = fakeDomain(t, { inProgress: true })
  const controller = domain.createController()
  await assert.rejects(controller.backupCreate({ modules: ['history'], targetDirectory: 'D:\\backups' }), /already in progress/)
  assert.deepEqual(calls, [])
})

test('restore writes the locator and relaunches only after a successful service result', async (t) => {
  const directory = await temporaryDirectory(t)
  const locatorPath = path.join(directory, 'Highlighter.location.json')
  const targetRoot = path.join(directory, 'new-root')
  const { domain, calls, state } = fakeDomain(t, {
    directory,
    backupServiceImpl: {
      createBackup: async () => ({ ok: true }),
      inspectBackup: async () => ({ ok: true }),
      deleteBackup: async () => ({ ok: true }),
      restoreBackup: async (options) => {
        assert.equal(options.supportedVersion, '5.0.1')
        assert.equal(typeof options.migrate, 'function')
        return { ok: true, code: 'ok', dataRoot: targetRoot, locator: { version: 1, dataRoot: targetRoot } }
      }
    }
  })
  const result = await domain.createController().backupRestore({ backupDirectory: path.join(directory, 'backup'), targetRoot })
  assert.equal(result.ok, true)
  assert.equal(result.restarting, true)
  assert.equal(JSON.parse(await fsp.readFile(locatorPath, 'utf8')).dataRoot, targetRoot)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.includes('relaunch'))
  assert.ok(calls.includes('exit:0'))
  assert.ok(calls.includes('session-clean'))
  assert.equal(state.value, true, 'the migration gate stays closed until the app exits')
})

test('a structured restore failure keeps the old root and resumes writers', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain, calls, state } = fakeDomain(t, {
    directory,
    backupServiceImpl: {
      createBackup: async () => ({ ok: true }),
      inspectBackup: async () => ({ ok: true }),
      deleteBackup: async () => ({ ok: true }),
      restoreBackup: async () => ({ ok: false, code: 'migration-required', message: 'no hook' })
    }
  })
  const result = await domain.createController().backupRestore({ backupDirectory: 'D:\\backups\\one', targetRoot: 'D:\\new-root' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'migration-required')
  assert.equal(state.value, false)
  assert.ok(calls.includes('gate:false'))
  assert.ok(calls.includes('clipboard-resume'))
  assert.ok(!calls.includes('relaunch'))
  assert.equal(fs.existsSync(path.join(directory, 'Highlighter.location.json')), false)
})

test('restore refuses a target that overlaps the live data root before touching writers', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain, calls } = fakeDomain(t, {
    directory,
    backupServiceImpl: {
      createBackup: async () => ({ ok: true }),
      inspectBackup: async () => ({ ok: true }),
      deleteBackup: async () => ({ ok: true }),
      restoreBackup: async () => { throw new Error('must not be called') }
    }
  })
  const controller = domain.createController()
  const nested = await controller.backupRestore({
    backupDirectory: path.join(directory, 'backup'),
    targetRoot: path.join(directory, 'active-root', 'nested')
  })
  assert.equal(nested.ok, false)
  assert.equal(nested.code, 'invalid-target')
  const same = await controller.backupRestore({
    backupDirectory: path.join(directory, 'backup'),
    targetRoot: path.join(directory, 'active-root')
  })
  assert.equal(same.code, 'invalid-target')
  assert.deepEqual(calls, [])
})

test('inspect and delete do not stop writers or take the migration gate', async (t) => {
  const { domain, calls } = fakeDomain(t)
  const controller = domain.createController()
  const inspected = await controller.backupInspect('D:\\backups\\one')
  assert.equal(inspected.ok, true)
  const removed = await controller.backupDelete('D:\\backups\\one')
  assert.equal(removed.ok, true)
  assert.deepEqual(calls, ['inspect:D:\\backups\\one'])
})

// ---------------------------------------------------------------------------
// D04 (06/19): the preview marks sensitive modules and the domain registers the
// production migration hooks with a supported-version window.
// ---------------------------------------------------------------------------

test('D04 (06): the preview marks per-module sensitivity and both old-package warnings', () => {
  const preview = section(settingsSource, 'function backupPreviewMarkup', 'function bindSystemBackupControls')
  assert.match(preview, /sensitiveModules/)
  assert.match(preview, /backup-module-sensitive/)
  assert.match(preview, /settings-carries-history/)
  assert.match(preview, /backup-history-index-missing/)
  assert.match(preview, /result\.historyIndex && result\.historyIndex\.available === false/)
  // The keys exist in all three tables.
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(ROOT, 'shared', 'locales')).filter((entry) => entry.endsWith('.js'))) {
    const localePath = path.join(ROOT, 'shared', 'locales', name)
    delete require.cache[require.resolve(localePath)]
    require(localePath)
  }
  for (const key of [
    'config.settings-system.backup-module-sensitive',
    'config.settings-system.backup-settings-carries-history',
    'config.settings-system.backup-history-index-missing'
  ]) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof globalThis.__LOCALES[language][key], 'string', language + ' is missing ' + key)
    }
  }
})

test('D04 (19): restore registers the production hooks and the supported version window', async (t) => {
  const directory = await temporaryDirectory(t)
  const targetRoot = path.join(directory, 'restored-root')
  let received = null
  const { domain } = fakeDomain(t, {
    directory,
    backupServiceImpl: {
      createBackup: async () => ({ ok: true }),
      inspectBackup: async () => ({ ok: true }),
      deleteBackup: async () => ({ ok: true }),
      restoreBackup: async (options) => {
        received = options
        // The production hook resolves any step and validates the staging root.
        const hook = options.migrate
        const hookResult = await hook({ from: '5.0.0', to: '5.0.1', directory })
        assert.equal(hookResult.ok, true)
        const verified = await options.verify({ directory, phase: 'migrated' })
        assert.equal(verified.ok, true)
        return { ok: true, code: 'ok', dataRoot: targetRoot, locator: { version: 1, dataRoot: targetRoot } }
      }
    }
  })
  const result = await domain.createController().backupRestore({ backupDirectory: path.join(directory, 'backup'), targetRoot })
  assert.equal(result.ok, true, result.code + ' ' + result.message)
  assert.equal(received.minSupportedVersion, '5.0.0', 'the window is derived from the running version')
  assert.equal(received.supportedVersionRange, '5.0.0 .. 5.0.1')
  assert.equal(typeof received.verify, 'function')
  assert.equal(typeof received.migrate, 'function')
})

test('D04 (19): an unsupported-version restore result is passed through with its range', async (t) => {
  const directory = await temporaryDirectory(t)
  const { domain } = fakeDomain(t, {
    directory,
    backupServiceImpl: {
      createBackup: async () => ({ ok: true }),
      inspectBackup: async () => ({ ok: true }),
      deleteBackup: async () => ({ ok: true }),
      restoreBackup: async () => ({
        ok: false,
        code: 'unsupported-version',
        version: '4.9.0',
        minSupportedVersion: '5.0.0',
        supportedVersionRange: '5.0.0 .. 5.0.1',
        originalKept: true
      })
    }
  })
  const result = await domain.createController().backupRestore({ backupDirectory: path.join(directory, 'backup'), targetRoot: path.join(directory, 'target') })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unsupported-version')
  assert.equal(result.supportedVersionRange, '5.0.0 .. 5.0.1')
  assert.equal(result.originalKept, true)
})
