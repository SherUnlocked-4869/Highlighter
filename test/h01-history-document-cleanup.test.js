// H01 —— docs/reviews/2026-11-26-code-review-and-optimization-report.md §二.1
//
// 这些用例驱动**真实的生产路径**：真实的 HistoryService + 真实的 CaptureDocumentService
// （工厂 `createCaptureDocumentService` 就是 main.js 的装配入口），只有 electron-store 与
// nativeImage 用内存假件替代。文件树在临时目录里真实创建，删除/统计的字节数都按真实 fs 计算。
//
// 覆盖报告 §二.1 的四条根因：
//   1. 删除历史只删 head 的两个扁平文件，`history/documents/<id>/` 永久泄漏；
//   2. orphanFiles 只扫顶层文件，documents/ 子目录对清理与容量统计不可见；
//   3. recoverIndex 是从未被调用的死代码；
//   4. 数据目录迁移只重写 filePath/thumbnailPath，漏掉 docPath/baseImagePath。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { HistoryService } = require('../main/services/history-service')
const {
  INDEX_BACKUP_FILE,
  createCaptureDocumentService
} = require('../main/services/capture-document-service')
const { rewriteConfig } = require('../main/services/data-root-migration')
const { HISTORY_ENTRY_PATH_KEYS } = require('../main/services/data-root')

class MemoryStore {
  constructor(history = []) {
    this.history = history
  }

  get(key, fallback) {
    return key === 'captureHistory' ? this.history : fallback
  }

  set(key, value) {
    if (key === 'captureHistory') this.history = value
  }
}

const fakeNativeImage = {
  createFromPath: () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 120, height: 80 }),
    resize: () => ({ toPNG: () => Buffer.from('thumb') })
  }),
  createFromBuffer: () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 120, height: 80 }),
    resize: () => ({ toPNG: () => Buffer.from('thumb') })
  })
}

function withTempRoot(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-h01-'))
  try {
    return callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
  return filePath
}

// Builds one editable capture exactly like CaptureDocumentService.publishRevision() lays it out:
// documents/<id>/base/<asset>.png + documents/<id>/revisions/<rev>.{doc.json,result.png,thumb.png}.
function createEditableCapture(root, id, { revisionCount = 2, storageFormat = 'editable-v1' } = {}) {
  const documentRoot = path.join(root, 'documents', id)
  const basePath = writeFile(path.join(documentRoot, 'base', `${id}-base.png`), Buffer.alloc(1000, 1))
  let docPath = ''
  let resultPath = ''
  let thumbPath = ''
  for (let index = 0; index < revisionCount; index++) {
    // The document service recognises revision ids by the `revision-` prefix (listRevisions).
    const revisionId = `revision-${id}-${index}`
    docPath = writeFile(path.join(documentRoot, 'revisions', `${revisionId}.doc.json`), JSON.stringify({ revisionId }))
    resultPath = writeFile(path.join(documentRoot, 'revisions', `${revisionId}.result.png`), Buffer.alloc(2000, 2))
    thumbPath = writeFile(path.join(documentRoot, 'revisions', `${revisionId}.thumb.png`), Buffer.alloc(300, 3))
  }
  return {
    documentRoot,
    entry: {
      id,
      documentId: id,
      storageFormat,
      filePath: resultPath,
      thumbnailPath: thumbPath,
      docPath,
      baseImagePath: basePath,
      width: 120,
      height: 80,
      createdAt: 1
    }
  }
}

function createRig(root, history = []) {
  const historyDirectory = path.join(root, 'history')
  fs.mkdirSync(historyDirectory, { recursive: true })
  const store = new MemoryStore(history)
  const getSettings = () => ({
    screenshot: {
      historyDirectory,
      historyEnabled: true,
      historyLimit: 10
    }
  })
  const historyService = new HistoryService({
    store,
    nativeImage: fakeNativeImage,
    sharp: () => {},
    getSettings,
    assertWritable() {},
    defaultHistoryDirectory: historyDirectory,
    makeCaptureName: (prefix) => `${prefix}.png`,
    log() {}
  })
  // Same order as main.js: the history service exists first, the document service is created
  // through the assembly factory, which attaches itself back to the history service.
  const documentService = createCaptureDocumentService({
    historyService,
    getSettings,
    assertWritable() {},
    log() {}
  })
  return { root, historyDirectory, store, historyService, documentService }
}

test('H01: deleting a history entry removes the whole history/documents/<id>/ tree', () => {
  withTempRoot((root) => {
    const { documentRoot, entry } = createEditableCapture(path.join(root, 'history'), 'doc-a')
    const rig = createRig(root, [entry])
    assert.ok(fs.existsSync(documentRoot))

    assert.equal(rig.historyService.delete('doc-a'), true)

    assert.equal(fs.existsSync(documentRoot), false, 'documents/<id>/ must not survive the delete')
    assert.equal(fs.existsSync(entry.filePath), false)
    assert.equal(fs.existsSync(entry.thumbnailPath), false)
    assert.deepEqual(rig.store.get('captureHistory', []), [])
  })
})

test('H01: batch delete, clear and retention trim all clean document trees', () => {
  withTempRoot((root) => {
    const historyDirectory = path.join(root, 'history')
    const first = createEditableCapture(historyDirectory, 'doc-b1')
    const second = createEditableCapture(historyDirectory, 'doc-b2')
    const third = createEditableCapture(historyDirectory, 'doc-b3')
    const rig = createRig(root, [first.entry, second.entry, third.entry])

    const batch = rig.historyService.deleteMany(['doc-b1'])
    assert.equal(batch.deletedCount, 1)
    assert.equal(fs.existsSync(first.documentRoot), false)
    assert.ok(fs.existsSync(second.documentRoot))

    // clear() goes through the same deleteFiles() path.
    assert.equal(rig.historyService.clear(), true)
    assert.equal(fs.existsSync(second.documentRoot), false)
    assert.equal(fs.existsSync(third.documentRoot), false)
    assert.deepEqual(rig.store.get('captureHistory', []), [])
  })
})

test('H01: the retention trim deletes the discarded documents, not just their head files', () => {
  withTempRoot((root) => {
    const historyDirectory = path.join(root, 'history')
    const kept = createEditableCapture(historyDirectory, 'doc-keep')
    const discarded = createEditableCapture(historyDirectory, 'doc-drop')
    const rig = createRig(root, [kept.entry, discarded.entry])
    // historyLimit is 10 in the rig; this call is the trim path itself.
    const trimmed = rig.historyService.trimHistory([kept.entry, discarded.entry], 1)
    assert.equal(trimmed.length, 1)
    assert.equal(fs.existsSync(discarded.documentRoot), false, 'trim must reclaim the document tree')
    assert.ok(fs.existsSync(kept.documentRoot))
  })
})

test('H01: cleanup removes orphaned document trees and reports their bytes', () => {
  withTempRoot((root) => {
    const historyDirectory = path.join(root, 'history')
    const referenced = createEditableCapture(historyDirectory, 'doc-live')
    const rig = createRig(root, [referenced.entry])
    // An orphan tree: files on disk, no history entry.
    const orphanRoot = writeFile(path.join(historyDirectory, 'documents', 'doc-orphan', 'base', 'b.png'), Buffer.alloc(4096, 5))
    writeFile(path.join(historyDirectory, 'documents', 'doc-orphan', 'revisions', 'r.result.png'), Buffer.alloc(2048, 6))

    const orphans = rig.historyService.orphanFiles()
    assert.equal(orphans.length, 1, 'exactly the unreferenced tree is an orphan')
    assert.equal(orphans[0].isDirectory, true)
    assert.equal(orphans[0].filePath, path.dirname(path.dirname(orphanRoot)))
    assert.equal(orphans[0].size, 4096 + 2048)
    assert.equal(orphans[0].fileCount, 2)
    // A referenced tree is never reported, even though its files live in the same place.
    assert.ok(!orphans.some((item) => item.filePath.includes('doc-live')))

    const result = rig.historyService.cleanup()
    assert.equal(result.failures.length, 0)
    assert.equal(result.removedFiles, 2)
    assert.equal(result.reclaimedBytes, 4096 + 2048)
    assert.equal(fs.existsSync(path.join(historyDirectory, 'documents', 'doc-orphan')), false)
    assert.ok(fs.existsSync(referenced.documentRoot), 'cleanup must keep referenced documents')
  })
})

test('H01: stats count base images and every revision, and report the editable breakdown', () => {
  withTempRoot((root) => {
    const historyDirectory = path.join(root, 'history')
    const editable = createEditableCapture(historyDirectory, 'doc-stats', { revisionCount: 2 })
    const legacy = createEditableCapture(historyDirectory, 'doc-bitmap', { revisionCount: 1, storageFormat: 'bitmap-only' })
    const rig = createRig(root, [editable.entry, legacy.entry])

    const stats = rig.historyService.stats()
    // 1000 base + N revisions * (2000 result + 300 thumb + doc.json) for each document. The head
    // result/thumbnail are the last revision's files, so they are counted once (dedupe set).
    const docJsonBytes = Buffer.byteLength(JSON.stringify({ revisionId: 'revision-doc-stats-0' })) +
      Buffer.byteLength(JSON.stringify({ revisionId: 'revision-doc-stats-1' })) +
      Buffer.byteLength(JSON.stringify({ revisionId: 'revision-doc-bitmap-0' }))
    const expected = (1000 + 2 * (2000 + 300)) + (1000 + 1 * (2000 + 300)) + docJsonBytes
    assert.equal(stats.totalBytes, expected)
    assert.equal(stats.revisionCount, 3)
    assert.equal(stats.editableCount, 1)
    assert.equal(stats.bitmapOnlyCount, 1)
    assert.equal(stats.orphanCount, 0)
  })
})

test('H01: the factory runs startup index recovery (recoverIndex is no longer dead code)', () => {
  withTempRoot((root) => {
    const historyDirectory = path.join(root, 'history')
    // A readable backup with one entry while the live index is empty is the recoverable signal
    // recoverIndex() documents.
    const { entry } = createEditableCapture(historyDirectory, 'doc-recover')
    writeFile(path.join(historyDirectory, INDEX_BACKUP_FILE), JSON.stringify({ at: 1, history: [entry] }))
    const rig = createRig(root, [])

    assert.deepEqual(rig.historyService.readHistory(), [entry], 'the backup entry must be restored into the index')
  })
})

test('H01: a legacy entry without documentId cleans documents/<id>/ as well', () => {
  withTempRoot((root) => {
    const historyDirectory = path.join(root, 'history')
    const capture = createEditableCapture(historyDirectory, 'legacy-id')
    const legacyEntry = { ...capture.entry }
    delete legacyEntry.documentId
    const rig = createRig(root, [legacyEntry])

    rig.historyService.delete('legacy-id')
    assert.equal(fs.existsSync(capture.documentRoot), false)
  })
})

test('H01: data-root migration rewrites docPath/baseImagePath and keeps external references', () => {
  const source = { history: path.resolve('C:/data/history') }
  const target = { history: path.resolve('D:/newroot/history') }
  const config = {
    settings: { screenshot: { historyDirectory: path.join(source.history) } },
    captureHistory: [{
      id: 'doc-migrate',
      filePath: path.join(source.history, 'documents', 'doc-migrate', 'revisions', 'r.result.png'),
      thumbnailPath: path.join(source.history, 'documents', 'doc-migrate', 'revisions', 'r.thumb.png'),
      docPath: path.join(source.history, 'documents', 'doc-migrate', 'revisions', 'r.doc.json'),
      baseImagePath: path.join(source.history, 'documents', 'doc-migrate', 'base', 'b.png'),
      externalPath: path.resolve('E:/elsewhere/keep.png')
    }]
  }
  const rewritten = rewriteConfig(config, source, target)
  const entry = rewritten.captureHistory[0]
  for (const key of ['filePath', 'thumbnailPath', 'docPath', 'baseImagePath']) {
    assert.ok(entry[key].startsWith(target.history), `${key} must move to the new root, got ${entry[key]}`)
    assert.equal(entry[key], path.join(target.history, path.relative(source.history, config.captureHistory[0][key])))
  }
  assert.equal(entry.externalPath, config.captureHistory[0].externalPath)
  assert.equal(rewritten.settings.screenshot.historyDirectory, target.history)
})

test('H01: one shared entry-path list is used by migration and backup restore', () => {
  assert.ok(Object.isFrozen(HISTORY_ENTRY_PATH_KEYS))
  for (const key of ['filePath', 'thumbnailPath', 'docPath', 'baseImagePath']) {
    assert.ok(HISTORY_ENTRY_PATH_KEYS.includes(key), `${key} must be registered`)
  }
  const backupSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'data-root-backup.js'), 'utf8')
  assert.match(backupSource, /const \{ HISTORY_ENTRY_PATH_KEYS \} = require\('\.\/data-root'\)/)
  assert.doesNotMatch(backupSource, /const HISTORY_ENTRY_PATH_KEYS = Object\.freeze/)
  const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'data-root-migration.js'), 'utf8')
  assert.match(migrationSource, /for \(const name of HISTORY_ENTRY_PATH_KEYS\)/)
})

test('H01: main.js wiring keeps the document service factory as the single startup entry', () => {
  // main.js is line-ceilinged, so the attach + recoverIndex steps live in the factory. Pin the
  // call so a future refactor cannot silently drop the recovery again.
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(mainSource, /captureDocumentService = createCaptureDocumentService\(\{/)
  const factorySource = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'capture-document-service.js'), 'utf8')
  assert.match(factorySource, /historyService\.attachDocumentService\(service\)/)
  assert.match(factorySource, /const recovery = service\.recoverIndex\(\)/)
})
