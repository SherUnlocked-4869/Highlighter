'use strict'

// D04: the backup/restore contract exercised with temporary directories and
// injected hooks only. Nothing here touches a real user data root, a database or
// a display.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const backup = require('../main/services/data-root-backup')

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-backup-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

async function exists(filePath) {
  return fsp.lstat(filePath).then(() => true, () => false)
}

async function writeFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, value)
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'))
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(await fsp.readFile(filePath))
  return hash.digest('hex')
}

async function readManifest(directory) {
  return readJson(path.join(directory, backup.MANIFEST_FILE))
}

async function writeManifest(directory, manifest) {
  await writeJson(path.join(directory, backup.MANIFEST_FILE), manifest)
}

async function createFixture(t) {
  const parent = await temporaryRoot(t)
  const root = path.join(parent, 'data-root')
  const externalShots = path.join(parent, 'external-shots')
  const externalLibrary = path.join(parent, 'external-history')
  const target = path.join(parent, 'backups')
  await fsp.mkdir(externalShots, { recursive: true })
  await fsp.mkdir(externalLibrary, { recursive: true })

  await writeFile(path.join(root, 'history', 'a.png'), 'png-a')
  await writeJson(path.join(root, 'history', 'documents', 'd1', 'revisions', 'r1.doc.json'), {
    revisionId: 'r1',
    path: path.join(externalShots, 'source.png'),
    pinned: true
  })
  await writeFile(path.join(root, 'history', '.staging', 'tmp.png'), 'staging')
  await writeFile(path.join(root, 'history', 'cache', 'nested.bin'), 'cache')
  await writeFile(path.join(root, 'clipboard', 'clipboard.json'), JSON.stringify({
    items: [{ id: 'c1', pinned: true, path: path.join(externalShots, 'copied.png') }],
    filePaths: [path.join(externalShots, 'copied-2.png')]
  }))
  await writeFile(path.join(root, 'clipboard', 'thumbnails', 't.png'), 'thumb')
  await writeFile(path.join(root, 'clipboard', 'staging', 's.png'), 'staged')
  await writeFile(path.join(root, 'recordings', 'p1', 'capture.webm'), 'webm-bytes')
  await writeJson(path.join(root, 'recordings', 'p1', 'project.json'), { projectId: 'p1', name: 'Project one' })
  await writeFile(path.join(root, 'conversations', 'c1.json'), JSON.stringify({ id: 'c1' }))
  await writeFile(path.join(root, 'usage', 'usage.db'), 'sqlite-bytes')
  await writeFile(path.join(root, 'config', 'credentials.json'), '{"apiKey":"sk-file-secret"}')
  await writeFile(path.join(root, 'config', 'secret.key'), 'key')
  await writeFile(path.join(root, 'config', 'cache', 'x.json'), '{}')
  await writeFile(path.join(root, 'logs', 'app.log'), 'log')
  await writeFile(path.join(root, 'cache', 'electron', 'x'), 'cache')
  await writeFile(path.join(root, 'diagnostics', 'dump.dmp'), 'dump')
  await writeJson(path.join(root, 'config', 'config.json'), {
    credentials: { apiKey: 'sk-secret', providerApiKeys: { p: 'sk-provider' } },
    settings: {
      screenshot: {
        historyDirectory: path.join(root, 'history'),
        saveDirectory: externalShots
      },
      record: { saveDirectory: externalShots }
    },
    captureHistory: [{
      id: 'h1',
      filePath: path.join(root, 'history', 'a.png'),
      thumbnailPath: path.join(root, 'history', 'a.png'),
      pinned: true
    }]
  })

  return { parent, root, externalShots, externalLibrary, target }
}

async function createForFixture(fixture, options = {}) {
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    ...options
  })
  assert.equal(result.ok, true, `backup failed: ${result.code} ${result.message}`)
  return result
}

test('exports the backup service surface and module table', () => {
  assert.equal(backup.BACKUP_FORMAT, 'highlighter-data-backup')
  assert.equal(backup.BACKUP_FORMAT_VERSION, 1)
  assert.deepEqual(backup.DEFAULT_MODULES, ['history', 'clipboard', 'recordings', 'settings'])
  assert.deepEqual(backup.MODULE_ORDER, ['history', 'clipboard', 'recordings', 'conversations', 'usage', 'settings'])
  assert.equal(typeof backup.createBackup, 'function')
  assert.equal(typeof backup.inspectBackup, 'function')
  assert.equal(typeof backup.restoreBackup, 'function')
  assert.equal(typeof backup.deleteBackup, 'function')
  for (const id of backup.MODULE_ORDER) assert.ok(backup.MODULE_DEFINITIONS[id], id)
})


test('backs up the legacy userData layout and restores it into the managed layout', async (t) => {
  const parent = await temporaryRoot(t)
  const root = path.join(parent, 'userData')
  const target = path.join(parent, 'backups')
  await writeFile(path.join(root, 'capture-history', 'legacy.png'), 'legacy-png')
  await writeFile(path.join(root, 'clipboard', 'clipboard.json'), JSON.stringify({ items: [{ id: 'c1', pinned: true }] }))
  await writeFile(path.join(root, 'conversations', 'c1.json'), JSON.stringify({ id: 'c1' }))
  await writeFile(path.join(root, 'recordings', 'p1', 'capture.webm'), 'legacy-webm')
  await writeJson(path.join(root, 'recordings', 'p1', 'project.json'), { projectId: 'p1' })
  await writeJson(path.join(root, 'config.json'), {
    settings: { screenshot: { historyDirectory: path.join(root, 'capture-history') } },
    captureHistory: [{ id: 'h1', filePath: path.join(root, 'capture-history', 'legacy.png'), pinned: true }]
  })

  const created = await backup.createBackup({
    dataRoot: root,
    targetDirectory: target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z')
  })
  assert.equal(created.ok, true, `${created.code} ${created.message}`)
  assert.equal(created.layout, 'legacy')
  const manifest = await readManifest(created.directory)
  assert.equal(manifest.source.layout, 'legacy')
  assert.equal(manifest.modules.history.sourcePath, path.join(root, 'capture-history'))
  assert.equal(manifest.modules.settings.sourcePath, root)
  assert.deepEqual(manifest.modules.history.files.map((file) => file.path), ['legacy.png'])

  const restoreRoot = path.join(parent, 'restored-legacy')
  const restored = await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: restoreRoot })
  assert.equal(restored.ok, true, `${restored.code} ${restored.message}`)
  assert.equal(await fsp.readFile(path.join(restoreRoot, 'history', 'legacy.png'), 'utf8'), 'legacy-png')
  assert.equal(await exists(path.join(restoreRoot, 'capture-history')), false)
  const restoredConfig = await readJson(path.join(restoreRoot, 'config', 'config.json'))
  assert.equal(restoredConfig.settings.screenshot.historyDirectory, path.join(restoreRoot, 'history'))
  assert.equal(restoredConfig.captureHistory[0].filePath, path.join(restoreRoot, 'history', 'legacy.png'))
  assert.equal(restoredConfig.captureHistory[0].pinned, true)
})

test('creates a per-module package with counts, sizes and per-file sha256', async (t) => {
  const fixture = await createFixture(t)
  const result = await createForFixture(fixture)
  assert.match(path.basename(result.directory), /^highlighter-backup-1-\d{8}-\d{6}$/)
  assert.equal(result.totalFiles, 6)
  assert.ok(result.totalBytes > 0)
  assert.deepEqual(result.moduleOrder, ['history', 'clipboard', 'recordings', 'settings'])
  assert.match(result.checksum, /^[a-f0-9]{64}$/)

  const manifest = await readManifest(result.directory)
  assert.equal(manifest.format, backup.BACKUP_FORMAT)
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.version, '1')
  assert.equal(manifest.incomplete, false)
  assert.equal(manifest.checksum, result.checksum)
  assert.equal(manifest.source.layout, 'managed')
  assert.ok(Array.isArray(manifest.excluded))
  assert.deepEqual(Object.keys(manifest.modules).sort(), ['clipboard', 'history', 'recordings', 'settings'])

  for (const [id, entry] of Object.entries(manifest.modules)) {
    assert.equal(entry.sourcePath, path.join(fixture.root, backup.MODULE_DEFINITIONS[id].directory))
    assert.equal(entry.fileCount, entry.files.length)
    assert.equal(entry.bytes, entry.files.reduce((sum, file) => sum + file.size, 0))
    for (const file of entry.files) {
      const copied = path.join(result.directory, 'modules', id, ...file.path.split('/'))
      assert.equal((await fsp.stat(copied)).size, file.size)
      assert.equal(await sha256(copied), file.sha256)
    }
  }
  assert.equal(manifest.totalBytes, result.totalBytes)
  assert.equal(manifest.totalFiles, result.totalFiles)
})

test('excludes caches, staging, diagnostics and credentials', async (t) => {
  const fixture = await createFixture(t)
  const result = await createForFixture(fixture)
  const clipboardDirectory = path.join(result.directory, 'modules', 'clipboard')
  assert.equal(await exists(path.join(clipboardDirectory, 'thumbnails')), false)
  assert.equal(await exists(path.join(clipboardDirectory, 'staging')), false)
  assert.equal(await exists(path.join(result.directory, 'modules', 'history', '.staging')), false)
  assert.equal(await exists(path.join(result.directory, 'modules', 'history', 'cache')), false)

  const settingsDirectory = path.join(result.directory, 'modules', 'settings')
  assert.deepEqual(await fsp.readdir(settingsDirectory), ['config.json'])
  assert.equal(await exists(path.join(settingsDirectory, 'credentials.json')), false)
  assert.equal(await exists(path.join(settingsDirectory, 'secret.key')), false)

  const settingsCopy = await readJson(path.join(settingsDirectory, 'config.json'))
  assert.equal(Object.hasOwn(settingsCopy, 'credentials'), false)
  assert.doesNotMatch(JSON.stringify(settingsCopy), /sk-secret|sk-provider|sk-file-secret/)
  assert.equal(settingsCopy.captureHistory[0].pinned, true)
  assert.equal(settingsCopy.settings.screenshot.saveDirectory, fixture.externalShots)
})

test('records external references without copying the external files', async (t) => {
  const fixture = await createFixture(t)
  const result = await createForFixture(fixture)
  const paths = result.externalRefs.map((ref) => ref.path)
  assert.ok(paths.includes(path.join(fixture.externalShots, 'source.png')))
  assert.ok(paths.includes(path.join(fixture.externalShots, 'copied.png')))
  assert.ok(paths.includes(path.join(fixture.externalShots, 'copied-2.png')))
  assert.ok(paths.includes(fixture.externalShots))
  for (const id of ['history', 'clipboard', 'recordings', 'settings']) {
    assert.ok(result.externalRefs.some((ref) => ref.module === id), `external ref for ${id}`)
  }
  const manifest = await readManifest(result.directory)
  const allFiles = Object.values(manifest.modules).flatMap((entry) => entry.files.map((file) => file.path))
  assert.equal(allFiles.some((file) => file.includes('external-shots')), false)
})

test('marks sensitive modules and leaves settings non-sensitive', async (t) => {
  const fixture = await createFixture(t)
  const result = await createForFixture(fixture)
  assert.equal(result.sensitive, true)
  assert.deepEqual(result.sensitiveModules, ['history', 'clipboard', 'recordings'])
  assert.equal(result.containsSensitive, true)
  assert.equal(result.modules.settings.sensitive, false)
  assert.equal(result.modules.history.sensitive, true)
})

test('quiesces SQLite writers before copying and resumes afterwards', async (t) => {
  const fixture = await createFixture(t)
  const order = []
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    modules: ['usage', 'history'],
    quiesce: async () => { order.push('quiesce') },
    resume: async () => { order.push('resume') },
    copy: async (source, target) => {
      order.push(`copy:${path.basename(source)}`)
      return fsp.copyFile(source, target)
    }
  })
  assert.equal(result.ok, true)
  assert.equal(order[0], 'quiesce')
  assert.equal(order[order.length - 1], 'resume')
  assert.equal(result.sqliteQuiesced, true)
  assert.equal(result.modules.usage.sqlite, true)
  const manifest = await readManifest(result.directory)
  assert.equal(manifest.sqliteQuiesced, true)
})


test('flags a database copied without a quiesce hook instead of pretending it is consistent', async (t) => {
  const fixture = await createFixture(t)
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    modules: ['usage']
  })
  assert.equal(result.ok, true)
  assert.equal(result.sqliteQuiesced, false)
  assert.ok(result.warnings.some((warning) => warning.code === 'sqlite-not-quiesced'))
  const inspection = await backup.inspectBackup(result.directory)
  assert.ok(inspection.warnings.some((warning) => warning.code === 'sqlite-not-quiesced'))
  const manifest = await readManifest(result.directory)
  assert.equal(manifest.sqliteQuiesced, false)
})

test('does not call the SQLite hook when no database is selected', async (t) => {
  const fixture = await createFixture(t)
  let quiesced = 0
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    modules: ['history'],
    quiesce: async () => { quiesced += 1 }
  })
  assert.equal(result.ok, true)
  assert.equal(quiesced, 0)
  assert.equal(result.sqliteQuiesced, false)
})

test('inspects a package and verifies every checksum on request', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const inspection = await backup.inspectBackup(created.directory)
  assert.equal(inspection.ok, true)
  assert.equal(inspection.version, '1')
  assert.equal(inspection.formatVersion, 1)
  assert.equal(inspection.totalFiles, created.totalFiles)
  assert.equal(inspection.totalBytes, created.totalBytes)
  assert.equal(inspection.checksum, created.checksum)
  assert.equal(inspection.sensitive, true)
  assert.deepEqual(inspection.sensitiveModules, ['history', 'clipboard', 'recordings'])
  assert.equal(inspection.containsSensitive, true)
  assert.ok(inspection.externalRefCount >= 3)

  const verified = await backup.inspectBackup(created.directory, { verifyChecksums: true })
  assert.equal(verified.ok, true)
})

test('reports a directory that is not a backup', async (t) => {
  const parent = await temporaryRoot(t)
  const plain = path.join(parent, 'plain')
  await fsp.mkdir(plain)
  const result = await backup.inspectBackup(plain)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-backup')
})

test('reports an interrupted package as incomplete', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const manifest = await readManifest(created.directory)
  await writeManifest(created.directory, { ...manifest, incomplete: true })
  const incomplete = await backup.inspectBackup(created.directory)
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.code, 'incomplete')

  await fsp.rm(path.join(created.directory, backup.MANIFEST_FILE))
  const missing = await backup.inspectBackup(created.directory)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'incomplete')
})

test('reports a corrupt manifest, missing file and checksum mismatch with structured codes', async (t) => {
  const fixture = await createFixture(t)

  const corruptSource = await createForFixture(fixture)
  await fsp.writeFile(path.join(corruptSource.directory, backup.MANIFEST_FILE), '{')
  assert.equal((await backup.inspectBackup(corruptSource.directory)).code, 'corrupt-manifest')

  const missingSource = await createForFixture(fixture)
  const missingManifest = await readManifest(missingSource.directory)
  const victim = missingManifest.modules.history.files.find((file) => file.path === 'a.png')
  await fsp.rm(path.join(missingSource.directory, 'modules', 'history', 'a.png'))
  assert.equal((await backup.inspectBackup(missingSource.directory)).code, 'missing-file')
  assert.ok(victim)

  const brokenSource = await createForFixture(fixture)
  const brokenManifest = await readManifest(brokenSource.directory)
  const brokenFile = brokenManifest.modules.history.files.find((file) => file.path === 'a.png')
  await fsp.writeFile(path.join(brokenSource.directory, 'modules', 'history', 'a.png'), 'png-b')
  assert.equal((await backup.inspectBackup(brokenSource.directory, { verifyChecksums: true })).code, 'checksum-mismatch')
  assert.equal(brokenFile.size, 5)
})

test('rejects a future package schema and a tampered manifest checksum', async (t) => {
  const fixture = await createFixture(t)
  const future = await createForFixture(fixture)
  const futureManifest = await readManifest(future.directory)
  await writeManifest(future.directory, { ...futureManifest, formatVersion: 2 })
  const marker = await readJson(path.join(future.directory, backup.MARKER_FILE))
  await writeJson(path.join(future.directory, backup.MARKER_FILE), { ...marker, formatVersion: 2 })
  const futureInspection = await backup.inspectBackup(future.directory)
  assert.equal(futureInspection.ok, false)
  assert.equal(futureInspection.code, 'future-schema')

  const tampered = await createForFixture(fixture)
  const tamperedManifest = await readManifest(tampered.directory)
  tamperedManifest.modules.history.files[0].size += 1
  await writeManifest(tampered.directory, tamperedManifest)
  const tamperedInspection = await backup.inspectBackup(tampered.directory)
  assert.equal(tamperedInspection.ok, false)
  assert.equal(tamperedInspection.code, 'corrupt-manifest')
})

test('allocates a unique directory for the same timestamp and version', async (t) => {
  const fixture = await createFixture(t)
  const first = await createForFixture(fixture)
  const second = await createForFixture(fixture)
  assert.notEqual(first.directory, second.directory)
  assert.equal((await backup.inspectBackup(first.directory)).ok, true)
  assert.equal((await backup.inspectBackup(second.directory)).ok, true)
})

test('refuses a target inside the data root', async (t) => {
  const fixture = await createFixture(t)
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: path.join(fixture.root, 'backup-target'),
    version: '1'
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-target')
  assert.equal(await exists(path.join(fixture.root, 'backup-target')), false)
})

test('fails before writing when free space is insufficient', async (t) => {
  const fixture = await createFixture(t)
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    freeBytes: async () => 1
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'insufficient-space')
  assert.ok(result.requiredBytes > 0)
  await fsp.mkdir(fixture.target, { recursive: true })
  assert.deepEqual(await fsp.readdir(fixture.target), [])
})

test('a disk-full copy leaves an incomplete backup that can be deleted safely', async (t) => {
  const fixture = await createFixture(t)
  let copies = 0
  const result = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    copy: async (source, target) => {
      copies += 1
      if (copies === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return fsp.copyFile(source, target)
    }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'insufficient-space')
  assert.equal(result.incomplete, true)
  assert.equal(await exists(result.directory), true)
  const inspection = await backup.inspectBackup(result.directory)
  assert.equal(inspection.code, 'incomplete')
  const removed = await backup.deleteBackup(result.directory)
  assert.equal(removed.ok, true)
  assert.equal(await exists(result.directory), false)
  const again = await backup.deleteBackup(result.directory)
  assert.equal(again.ok, true)
  assert.equal(again.removed, false)
})

test('deletes only incomplete packages', async (t) => {
  const fixture = await createFixture(t)
  const complete = await createForFixture(fixture)
  const refused = await backup.deleteBackup(complete.directory)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'not-incomplete')
  assert.equal(await exists(complete.directory), true)

  const interrupted = path.join(fixture.target, 'highlighter-backup-1-20260101-000000')
  await fsp.mkdir(interrupted, { recursive: true })
  assert.equal((await backup.inspectBackup(interrupted)).code, 'incomplete')
  assert.equal((await backup.deleteBackup(interrupted)).ok, true)
  assert.equal(await exists(interrupted), false)

  const plain = path.join(fixture.parent, 'plain')
  await fsp.mkdir(plain)
  assert.equal((await backup.deleteBackup(plain)).code, 'not-backup')
})

test('restores a complete package into a new root and keeps the old root untouched', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  await writeFile(path.join(fixture.root, 'sentinel.txt'), 'original')
  const sentinelHash = await sha256(path.join(fixture.root, 'sentinel.txt'))
  const restoreRoot = path.join(fixture.parent, 'restored')
  let verification = null

  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    verify: async (context) => {
      verification = context
      return { ok: true, counts: { files: 6 } }
    }
  })
  assert.equal(result.ok, true, `restore failed: ${result.code} ${result.message}`)
  assert.equal(result.dataRoot, restoreRoot)
  assert.deepEqual(result.locator, { version: 1, dataRoot: restoreRoot })
  assert.equal(result.migrated.length, 0)
  assert.equal(verification.phase, 'copied')
  assert.equal(verification.version, '1')
  assert.deepEqual(verification.modules.history.files.map((file) => file.path), ['a.png', 'documents/d1/revisions/r1.doc.json'])

  assert.equal(await fsp.readFile(path.join(restoreRoot, 'history', 'a.png'), 'utf8'), 'png-a')
  assert.equal(await fsp.readFile(path.join(restoreRoot, 'recordings', 'p1', 'capture.webm'), 'utf8'), 'webm-bytes')
  assert.equal(await sha256(path.join(restoreRoot, 'history', 'a.png')), await sha256(path.join(fixture.root, 'history', 'a.png')))

  const restoredConfig = await readJson(path.join(restoreRoot, 'config', 'config.json'))
  assert.equal(restoredConfig.settings.screenshot.historyDirectory, path.join(restoreRoot, 'history'))
  assert.equal(restoredConfig.captureHistory[0].filePath, path.join(restoreRoot, 'history', 'a.png'))
  assert.equal(restoredConfig.captureHistory[0].pinned, true)
  assert.equal(Object.hasOwn(restoredConfig, 'credentials'), false)

  const stageEntries = (await fsp.readdir(restoreRoot)).filter((name) => name.startsWith('.highlighter-restore-'))
  assert.deepEqual(stageEntries, [])
  assert.equal(await sha256(path.join(fixture.root, 'sentinel.txt')), sentinelHash)
  assert.equal(await fsp.readFile(path.join(fixture.root, 'history', 'a.png'), 'utf8'), 'png-a')
})

test('migrates one supported version at a time and verifies each step', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-steps')
  const migrations = []
  const verifications = []

  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    supportedVersion: '3',
    migrate: async (step) => {
      migrations.push(`${step.from}->${step.to}`)
      await writeFile(path.join(step.directory, 'history', `migrated-${step.to}.txt`), step.to)
      return { ok: true }
    },
    verify: async (context) => {
      verifications.push(`${context.fromVersion}->${context.version}`)
      return { ok: true }
    }
  })
  assert.equal(result.ok, true, `restore failed: ${result.code} ${result.message}`)
  assert.deepEqual(migrations, ['1->2', '2->3'])
  assert.deepEqual(verifications, ['1->2', '2->3'])
  assert.deepEqual(result.migrated, [{ from: '1', to: '2' }, { from: '2', to: '3' }])
  assert.equal(result.version, '3')
  assert.equal(result.sourceVersion, '1')
  assert.equal(await fsp.readFile(path.join(restoreRoot, 'history', 'migrated-3.txt'), 'utf8'), '3')
})

test('restoring an older version without a migration rolls the new root back', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-missing-hook')
  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    supportedVersion: '3'
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'migration-required')
  assert.equal(result.rolledBack, true)
  assert.equal(await exists(restoreRoot), false)
  assert.equal(await exists(path.join(fixture.root, 'history', 'a.png')), true)
})

test('a failed verification rolls the new root back and never publishes', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-verify-fail')
  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    verify: async () => ({ ok: false, message: 'record count mismatch' })
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'verification-failed')
  assert.equal(result.rolledBack, true)
  assert.equal(await exists(restoreRoot), false)
  assert.equal(await fsp.readFile(path.join(fixture.root, 'history', 'a.png'), 'utf8'), 'png-a')
})

test('a disk-full copy during restore leaves the old root and the new root clean', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-disk-full')
  let copies = 0
  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    copy: async (source, target) => {
      copies += 1
      if (copies === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return fsp.copyFile(source, target)
    }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'insufficient-space')
  assert.equal(result.rolledBack, true)
  assert.equal(await exists(restoreRoot), false)
  assert.equal(await fsp.readFile(path.join(fixture.root, 'history', 'a.png'), 'utf8'), 'png-a')
})

test('checks free space before staging a restore', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-no-space')
  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    freeBytes: async () => 0
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'insufficient-space')
  assert.ok(result.requiredBytes > 0)
  assert.equal(await exists(restoreRoot), false)
})

test('refuses a non-empty target without touching its contents', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-not-empty')
  await writeFile(path.join(restoreRoot, 'keep.txt'), 'keep')
  const result = await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: restoreRoot })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'target-not-empty')
  assert.equal(await fsp.readFile(path.join(restoreRoot, 'keep.txt'), 'utf8'), 'keep')
})

test('restore reports incomplete, corrupt and future packages without creating the target', async (t) => {
  const fixture = await createFixture(t)

  const incompleteSource = await createForFixture(fixture)
  const incompleteManifest = await readManifest(incompleteSource.directory)
  await writeManifest(incompleteSource.directory, { ...incompleteManifest, incomplete: true })
  const incompleteTarget = path.join(fixture.parent, 'target-incomplete')
  const incomplete = await backup.restoreBackup({ backupDirectory: incompleteSource.directory, targetRoot: incompleteTarget })
  assert.equal(incomplete.code, 'incomplete')
  assert.equal(await exists(incompleteTarget), false)

  const corruptSource = await createForFixture(fixture)
  await fsp.writeFile(path.join(corruptSource.directory, backup.MANIFEST_FILE), 'not json')
  const corrupt = await backup.restoreBackup({ backupDirectory: corruptSource.directory, targetRoot: path.join(fixture.parent, 'target-corrupt') })
  assert.equal(corrupt.code, 'corrupt-manifest')

  const futureSource = await createForFixture(fixture)
  const futureMarker = await readJson(path.join(futureSource.directory, backup.MARKER_FILE))
  await writeJson(path.join(futureSource.directory, backup.MARKER_FILE), { ...futureMarker, formatVersion: 99 })
  const future = await backup.restoreBackup({ backupDirectory: futureSource.directory, targetRoot: path.join(fixture.parent, 'target-future') })
  assert.equal(future.code, 'future-schema')
  assert.equal(await exists(path.join(fixture.parent, 'target-future')), false)
})

test('restores a subset of modules into the new root', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const restoreRoot = path.join(fixture.parent, 'restored-history-only')
  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    modules: ['history']
  })
  assert.equal(result.ok, true)
  assert.deepEqual((await fsp.readdir(restoreRoot)).sort(), ['history'])
  assert.deepEqual(Object.keys(result.modules), ['history'])
  assert.equal(await exists(path.join(restoreRoot, 'config')), false)
})

test('an external screenshot library is copied by explicit selection and remapped on restore', async (t) => {
  const fixture = await createFixture(t)
  await writeFile(path.join(fixture.externalLibrary, 'external.png'), 'external-png')
  const configPath = path.join(fixture.root, 'config', 'config.json')
  const config = await readJson(configPath)
  config.settings.screenshot.historyDirectory = fixture.externalLibrary
  await writeJson(configPath, config)

  const created = await backup.createBackup({
    dataRoot: fixture.root,
    targetDirectory: fixture.target,
    version: '1',
    now: new Date('2026-11-25T02:00:00Z'),
    modules: [{ id: 'history', directory: fixture.externalLibrary }, 'settings']
  })
  assert.equal(created.ok, true)
  const manifest = await readManifest(created.directory)
  assert.equal(manifest.modules.history.sourcePath, fixture.externalLibrary)
  assert.ok(manifest.modules.history.externalRefs.some((ref) => ref.path === fixture.externalLibrary && ref.kind === 'module-source'))
  assert.deepEqual(manifest.modules.history.files.map((file) => file.path), ['external.png'])

  const restoreRoot = path.join(fixture.parent, 'restored-external')
  const restored = await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: restoreRoot })
  assert.equal(restored.ok, true)
  assert.equal(await fsp.readFile(path.join(restoreRoot, 'history', 'external.png'), 'utf8'), 'external-png')
  const restoredConfig = await readJson(path.join(restoreRoot, 'config', 'config.json'))
  assert.equal(restoredConfig.settings.screenshot.historyDirectory, path.join(restoreRoot, 'history'))
})

test('drive-letter changes surface as external reference warnings and restore still succeeds', async (t) => {
  const fixture = await createFixture(t)
  const configPath = path.join(fixture.root, 'config', 'config.json')
  const config = await readJson(configPath)
  config.settings.screenshot.historyDirectory = 'Z:\\HighlighterLibrary'
  await writeJson(configPath, config)

  const created = await createForFixture(fixture)
  const realExists = async (value) => fsp.lstat(value).then(() => true, () => false)
  const existsWithMissingZ = async (value) => (/^Z:/i.test(String(value)) ? false : realExists(value))
  const inspection = await backup.inspectBackup(created.directory, { exists: existsWithMissingZ })
  assert.equal(inspection.ok, true)
  assert.ok(inspection.warnings.some((warning) => warning.code === 'external-ref-unavailable' && /^Z:/i.test(warning.path)))

  const restoreRoot = path.join(fixture.parent, 'restored-drive-change')
  const result = await backup.restoreBackup({
    backupDirectory: created.directory,
    targetRoot: restoreRoot,
    exists: existsWithMissingZ
  })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((warning) => warning.code === 'external-ref-unavailable' && /^Z:/i.test(warning.path)))
  const restoredConfig = await readJson(path.join(restoreRoot, 'config', 'config.json'))
  assert.equal(restoredConfig.settings.screenshot.historyDirectory, 'Z:\\HighlighterLibrary')
})

test('restoring the same package twice produces identical trees', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const first = path.join(fixture.parent, 'restored-a')
  const second = path.join(fixture.parent, 'restored-b')
  assert.equal((await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: first })).ok, true)
  assert.equal((await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: second })).ok, true)
  for (const relative of ['history/a.png', 'clipboard/clipboard.json', 'recordings/p1/capture.webm']) {
    assert.equal(await sha256(path.join(first, ...relative.split('/'))), await sha256(path.join(second, ...relative.split('/'))), relative)
  }
  // The settings copy legitimately differs: the history folder is remapped into
  // each new root. Everything else in it has to match.
  for (const [target] of [[first], [second]]) {
    const config = await readJson(path.join(target, 'config', 'config.json'))
    assert.equal(config.settings.screenshot.historyDirectory, path.join(target, 'history'))
    assert.equal(config.captureHistory[0].pinned, true)
  }
})

test('restoring the same package onto its own target is refused', async (t) => {
  const fixture = await createFixture(t)
  const created = await createForFixture(fixture)
  const first = path.join(fixture.parent, 'restored-once')
  assert.equal((await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: first })).ok, true)
  const second = await backup.restoreBackup({ backupDirectory: created.directory, targetRoot: first })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'target-not-empty')
  assert.equal(await fsp.readFile(path.join(first, 'history', 'a.png'), 'utf8'), 'png-a')
})
