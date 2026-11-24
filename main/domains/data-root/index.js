'use strict'

const { createDataPaths, ensureDataLayout, isNestedPath, validateDataRoot, writeLocator } = require('../../services/data-root')
const {
  createLegacySourcePaths,
  createManagedSourcePaths,
  migrateDataRoot
} = require('../../services/data-root-migration')
const { quiesceAndMigrate } = require('../../services/managed-writer-coordinator')
const { getActiveUsageFeature } = require('../../services/usage-runtime')
const { relaunchApplication } = require('../../services/relaunch-application')
const dataRootBackupService = require('../../services/data-root-backup')

// The data-root surface: first-run directory selection, recovery from an
// unusable configured root, and the live "change directory" migration with its
// restart. It owns the migration-in-progress gate and the writer quiesce/restore
// pair that the migration depends on. Window, store and writer handles arrive
// injected, since those are the parts main.js owns and can stop.
function createDataRootDomain(deps) {
  const {
    app,
    dialog,
    fs,
    path,
    shell,
    dataRootContext,
    getSettings,
    persistSettings,
    isMigrationInProgress,
    setMigrationInProgress,
    ocrServiceRef,
    recordingServiceRef,
    getOcrService,
    recordDomain,
    longCaptureDomain,
    managedRecordingWriters,
    removeProvisionalRoot,
    markSessionClean,
    log
  } = deps

  const backupService = deps.backupService || dataRootBackupService

  async function stopManagedDataWriters() {
    // Usage owns a WAL SQLite database under the managed root: checkpoint and close
    // it before any file is copied so the migration cannot capture a torn database.
    await getActiveUsageFeature()?.quiesce?.()
    await deps.getClipboardDomain?.()?.quiesce()
    await deps.selectionDomain?.quiesceConversations()
    const activeOcrService = ocrServiceRef.get()
    if (activeOcrService) {
      const inFlight = [...activeOcrService.inFlight.values()]
      activeOcrService.stop()
      await Promise.allSettled(inFlight)
      if (ocrServiceRef.get() === activeOcrService) ocrServiceRef.set(null)
    }

    await recordDomain.shutdown()
    recordingServiceRef.set(null)

    await longCaptureDomain.shutdown()
  }

  function restoreManagedDataWriters(restartOcr) {
    // Reopen on the (unchanged) active root when a migration attempt was aborted.
    getActiveUsageFeature()?.resume?.()
    deps.selectionDomain?.resumeConversations()
    deps.getClipboardDomain?.()?.resume().catch(() => {})
    if (!restartOcr) return
    getOcrService().ensureStarted().catch((error) => log('OCR restart failed:', error.message))
  }

  async function changeDataRoot() {
    if (isMigrationInProgress() || fs.existsSync(dataRootContext.pendingPath)) throw new Error('已有未完成的数据目录迁移，不能开始新的迁移')

    const activeRoot = dataRootContext.paths?.root || dataRootContext.legacyUserData
    const sourcePaths = dataRootContext.paths
      ? createManagedSourcePaths(activeRoot)
      : createLegacySourcePaths(activeRoot)
    const previousRoot = dataRootContext.paths ? activeRoot : ''
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    if (path.resolve(result.filePaths[0]) === path.resolve(activeRoot)) return { unchanged: true }
    const targetRoot = await validateDataRoot(result.filePaths[0], activeRoot)
    if (path.resolve(targetRoot) === path.resolve(activeRoot)) return { unchanged: true }

    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '迁移并重启'],
      defaultId: 1,
      cancelId: 0,
      message: '更改软件数据目录？',
      detail: 'Highlighter 将迁移配置、日志、截图历史、保存的会话、剪贴板历史与用量数据，并在迁移完成后重启。缓存和运行数据不会迁移。'
    })
    if (confirmation.response !== 1) return { canceled: true }
    if (isMigrationInProgress() || fs.existsSync(dataRootContext.pendingPath)) throw new Error('已有未完成的数据目录迁移，不能开始新的迁移')

    const restartOcr = !!ocrServiceRef.get() && getSettings().plugins.ocr && getSettings().ocr.hotStart
    let writerShutdownStarted = false
    setMigrationInProgress(true)
    try {
      persistSettings(getSettings())
      writerShutdownStarted = true
      await quiesceAndMigrate({
        coordinator: managedRecordingWriters,
        stopWriters: stopManagedDataWriters,
        migrate: () => migrateDataRoot({
          source: sourcePaths,
          target: createDataPaths(targetRoot),
          portableDirectory: dataRootContext.locatorDirectory,
          previousRoot
        }),
        relaunch: () => setImmediate(() => {
          markSessionClean('data-root-relaunch')
          relaunchApplication({ app, dataRootContext })
          app.exit(0)
        })
      })
    } catch (error) {
      setMigrationInProgress(false)
      restoreManagedDataWriters(restartOcr)
      const recovery = writerShutdownStarted ? '；为保证数据安全，录屏和长截图已停止，可重新启动这些功能' : ''
      throw new Error(`数据目录迁移失败：${error.message || String(error)}${recovery}`)
    }

    return { restarting: true }
  }

  async function chooseInitialDataRoot() {
    if (dataRootContext.startupError) {
      await dialog.showMessageBox({
        type: 'warning',
        title: '数据目录启动警告',
        message: '当前数据目录不可用，请重新选择。',
        detail: dataRootContext.startupError.message || String(dataRootContext.startupError),
        buttons: ['确定']
      })
    }

    const result = await dialog.showOpenDialog({
      title: '选择 Highlighter 数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      removeProvisionalRoot(dataRootContext)
      app.exit(0)
      return
    }

    let targetRoot = result.filePaths[0]
    targetRoot = await validateDataRoot(targetRoot, dataRootContext.legacyUserData)
    await migrateDataRoot({
      source: createLegacySourcePaths(dataRootContext.legacyUserData),
      target: createDataPaths(targetRoot),
      portableDirectory: dataRootContext.locatorDirectory,
      previousRoot: ''
    })
    if (!removeProvisionalRoot(dataRootContext)) console.warn('Unable to remove provisional data directory')
    relaunchApplication({ app, dataRootContext })
    app.exit(0)
  }

  async function recoverUnavailableDataRoot() {
    let recoveryError = dataRootContext.startupError
    while (true) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Highlighter 数据目录不可用',
        message: '无法使用已配置的数据目录。',
        detail: recoveryError?.message || String(recoveryError || ''),
        buttons: ['重试', '选择其他目录', '退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })

      if (response === 0) {
        try {
          const targetRoot = await validateDataRoot(dataRootContext.requestedRoot)
          await ensureDataLayout(createDataPaths(targetRoot))
          if (!removeProvisionalRoot(dataRootContext)) console.warn('Unable to remove provisional data directory')
          relaunchApplication({ app, dataRootContext })
          app.exit(0)
          return
        } catch (error) {
          recoveryError = error
        }
        continue
      }

      if (response === 1) {
        if (fs.existsSync(dataRootContext.pendingPath)) {
          recoveryError = new Error('检测到未完成的数据目录迁移，请先恢复原数据目录')
          continue
        }
        const result = await dialog.showOpenDialog({
          title: '选择 Highlighter 数据目录',
          properties: ['openDirectory', 'createDirectory']
        })
        if (result.canceled || !result.filePaths[0]) continue
        try {
          const targetRoot = await validateDataRoot(result.filePaths[0])
          await ensureDataLayout(createDataPaths(targetRoot))
          await writeLocator(dataRootContext.locatorPath, targetRoot)
          if (!removeProvisionalRoot(dataRootContext)) console.warn('Unable to remove provisional data directory')
          relaunchApplication({ app, dataRootContext })
          app.exit(0)
          return
        } catch (error) {
          recoveryError = error
        }
        continue
      }

      removeProvisionalRoot(dataRootContext)
      app.exit(1)
      return
    }
  }

  function getInfo() {
    return {
      portable: dataRootContext.portable,
      customized: !!dataRootContext.paths,
      path: dataRootContext.paths?.root || dataRootContext.legacyUserData
    }
  }

  function open() {
    return shell.openPath(dataRootContext.paths?.root || app.getPath('userData'))
  }

  // D04: backup and restore reuse the same writer stop/restore pair as a root
  // migration, because both copy files a live app is still writing. The service
  // owns the package format, the checksums and the rollback; this domain owns the
  // gate, the writers, the locator and the relaunch. Neither action may start
  // while a migration (or another backup) is pending.
  function assertBackupAllowed() {
    if (isMigrationInProgress() || fs.existsSync(dataRootContext.pendingPath)) {
      throw new Error('a data root migration or backup is already in progress')
    }
  }

  function shouldRestartOcr() {
    return !!ocrServiceRef.get() && getSettings().plugins.ocr && getSettings().ocr.hotStart
  }

  async function createDataRootBackup(options = {}) {
    assertBackupAllowed()
    const restartOcr = shouldRestartOcr()
    let writersStopped = false
    setMigrationInProgress(true)
    try {
      await stopManagedDataWriters()
      writersStopped = true
      return await backupService.createBackup({
        dataRoot: dataRootContext.paths?.root || dataRootContext.legacyUserData,
        modules: options.modules,
        targetDirectory: options.targetDirectory,
        version: options.version || app.getVersion?.(),
        portable: dataRootContext.portable === true,
        writersQuiesced: writersStopped
      })
    } catch (error) {
      return { ok: false, code: 'backup-failed', message: error.message || String(error) }
    } finally {
      setMigrationInProgress(false)
      if (writersStopped) restoreManagedDataWriters(restartOcr)
    }
  }

  function inspectDataRootBackup(directory) {
    return backupService.inspectBackup(directory)
  }

  function removeDataRootBackup(directory) {
    return backupService.deleteBackup(directory)
  }

  async function restoreDataRootBackup(options = {}) {
    assertBackupAllowed()
    const activeRoot = dataRootContext.paths?.root || dataRootContext.legacyUserData
    const requestedTarget = typeof options.targetRoot === 'string' ? options.targetRoot : ''
    if (requestedTarget && path.isAbsolute(requestedTarget) &&
      (isNestedPath(activeRoot, requestedTarget) || isNestedPath(requestedTarget, activeRoot))) {
      // The restore target is a NEW root; it must never overlap the live root, or
      // a failed attempt would have written inside the data it promises to keep.
      return { ok: false, code: 'invalid-target', message: 'the restore target must not overlap the active data root' }
    }
    const restartOcr = shouldRestartOcr()
    let writersStopped = false
    let restarting = false
    setMigrationInProgress(true)
    try {
      await stopManagedDataWriters()
      writersStopped = true
      const result = await backupService.restoreBackup({
        backupDirectory: options.backupDirectory,
        targetRoot: options.targetRoot,
        supportedVersion: options.supportedVersion || app.getVersion?.(),
        verify: options.verify,
        migrate: async (step) => {
          const hook = deps.backupMigrationHooks?.[`${step.from}->${step.to}`]
          if (typeof hook !== 'function') throw new Error(`no backup migration hook for ${step.from}->${step.to}`)
          return hook(step)
        }
      })
      if (!result.ok) return result
      // The service only returns a locator after the new root is complete and
      // verified; switching is one atomic locator write followed by a relaunch.
      // The old root is left in place, so a failed relaunch is recoverable.
      await writeLocator(dataRootContext.locatorPath, result.dataRoot)
      restarting = true
      setImmediate(() => {
        markSessionClean('data-root-backup-restore')
        relaunchApplication({ app, dataRootContext })
        app.exit(0)
      })
      return { ...result, restarting: true }
    } catch (error) {
      return { ok: false, code: 'restore-failed', message: error.message || String(error) }
    } finally {
      if (!restarting) {
        setMigrationInProgress(false)
        if (writersStopped) restoreManagedDataWriters(restartOcr)
      }
    }
  }

  return {
    changeDataRoot,
    chooseInitialDataRoot,
    recoverUnavailableDataRoot,
    stopManagedDataWriters,
    createDataRootBackup,
    inspectDataRootBackup,
    removeDataRootBackup,
    restoreDataRootBackup,
    getInfo,
    open,
    createController: () => ({
      get: getInfo,
      open,
      change: changeDataRoot,
      backupCreate: createDataRootBackup,
      backupInspect: inspectDataRootBackup,
      backupDelete: removeDataRootBackup,
      backupRestore: restoreDataRootBackup
    })
  }
}

module.exports = {
  createDataRootDomain
}
