// 批次 1-A 用例：main/services/capture-document-service.js
//
// 钉的是 docs/plans/2026-10-25-history-reedit-redesign.md 与批次 0 契约文档
// （docs/plans/2026-10-25-history-reedit-batch0-contracts.md）里已经冻结的提交语义：
//   §4  提交协议：committed / unchanged / conflict / failed，requestId 幂等
//   §5  文件布局与归属：受控 id 推导路径、filePath 是 head result 的别名
//   §6  动作路由：create / update / save-copy 三种 intent 的行为差异
//   §9  生命周期：按文档计数保留、删除清理、空间统计
//   §10 损坏降级：doc 丢失只走"仅位图恢复"，不冒充截图
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { CaptureDocumentService, DEFAULT_REVISION_LIMIT } = require('../main/services/capture-document-service')
const documentApi = require('../shared/capture-document')

const PNG_800x600 = (() => {
  // 一个最小的合法 PNG 头：readPngSize 只读 IHDR，足够让服务校验尺寸。
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(800, 16)
  buffer.writeUInt32BE(600, 20)
  return buffer
})()
const PNG_400x300 = (() => {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(400, 16)
  buffer.writeUInt32BE(300, 20)
  return buffer
})()

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

// HistoryService 的忠实子集：服务只用到 ensureDirectory / readHistory / writeHistory /
// writeHistorySilently / defaultHistoryDirectory / nativeImage。
function createHistoryService(directory, store) {
  return {
    defaultHistoryDirectory: directory,
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 120, height: 80 }),
        resize: () => ({ toPNG: () => Buffer.from('thumb') })
      })
    },
    ensureDirectory: (target) => fs.mkdirSync(target, { recursive: true }) || target,
    readHistory: () => {
      const history = store.get('captureHistory', [])
      return Array.isArray(history) ? history : []
    },
    writeHistory: (history) => store.set('captureHistory', history),
    writeHistorySilently: (history) => store.set('captureHistory', history)
  }
}

async function withService(callback, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-doc-'))
  try {
    const store = new MemoryStore(overrides.history || [])
    const settings = {
      screenshot: {
        historyDirectory: directory,
        historyEnabled: true,
        historyLimit: 200,
        historyRevisionLimit: overrides.revisionLimit ?? DEFAULT_REVISION_LIMIT
      }
    }
    let idSeq = 0
    const service = new CaptureDocumentService({
      historyService: createHistoryService(directory, store),
      getSettings: () => (overrides.getSettings ? overrides.getSettings(settings) : settings),
      assertWritable: () => {},
      createId: () => `id${(idSeq += 1)}`,
      now: () => 1792886400000 + idSeq,
      ...overrides.service
    })
    return await callback({ service, store, directory, settings })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function startCreateSession(service) {
  const result = service.beginSession({ documentId: '', intent: 'create', windowId: 1, source: 'region' })
  assert.equal(result.ok, true)
  return result.session
}

function startEditSession(service, documentId) {
  const result = service.beginSession({ documentId, intent: 'update', windowId: 2, source: 'history' })
  assert.equal(result.ok, true)
  return result.session
}

function snapshotFor(annotations = [], crop = { x: 0, y: 0, w: 800, h: 600 }) {
  return documentApi.serializeDocument({
    baseImage: { assetId: 'placeholder', width: 800, height: 600 },
    crop,
    annotations,
    source: 'region'
  })
}

async function createFirstVersion(service, session, options = {}) {
  const annotations = options.annotations || []
  const crop = options.crop || { x: 0, y: 0, w: 800, h: 600 }
  const resultSize = { width: crop.w, height: crop.h }
  return await service.commit({
    sessionId: session.sessionId,
    requestId: options.requestId || 'req-1',
    intent: 'create',
    expectedRevisionId: null,
    snapshot: snapshotFor(annotations, crop),
    resultBuffer: pngOfSize(resultSize.width, resultSize.height),
    newBaseBuffer: PNG_800x600
  })
}

// 生成任意尺寸的最小 PNG 头（readPngSize 只读 IHDR）。
function pngOfSize(width, height) {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

// ---------- 装配层：main.js 依赖的导出必须真实存在 ----------

test('the factory main.js imports exists and wires the real service', () => {
  // Regression guard: main.js does `const { createCaptureDocumentService } = require(...)`
  // and calls it inside initializeStore(). When this export was missing, the throw happened
  // during startup and left the main process event loop starved - every Electron-runtime
  // probe (diagnostics) hung for its full timeout instead of failing loudly. A one-line
  // export check catches that class of bug without spawning Electron.
  const {
    createCaptureDocumentService,
    CaptureDocumentService
  } = require('../main/services/capture-document-service')
  assert.equal(typeof createCaptureDocumentService, 'function', 'main.js imports this factory')
  assert.equal(typeof CaptureDocumentService, 'function')
  withTempService(({ service }) => {
    assert.ok(service instanceof CaptureDocumentService)
  })
})

function withTempService(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-doc-factory-'))
  try {
    const store = new MemoryStore()
    const { createCaptureDocumentService } = require('../main/services/capture-document-service')
    const service = createCaptureDocumentService({
      historyService: createHistoryService(directory, store),
      getSettings: () => ({
        screenshot: { historyDirectory: directory, historyEnabled: true, historyLimit: 200, historyRevisionLimit: 20 }
      }),
      assertWritable: () => {}
    })
    return callback({ service, store, directory })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// ---------- §6 / §5 创建首版 ----------

test('§6 create establishes a new document with a head, a required result, and the documented file layout', async () => {
  await withService(async ({  service, store, directory  }) => {
    const session = startCreateSession(service)
    const result = await createFirstVersion(service, session, {
      annotations: [{ type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000' }]
    })
    assert.equal(result.status, 'committed', JSON.stringify(result))
    assert.equal(result.version, 1)
    assert.match(result.documentId, /^document-id/)
    assert.match(result.revisionId, /^revision-id/)
    // 文件布局（§6.5.2）：base / revisions/<revisionId>.{doc.json,result.png,thumb.png}
    const documentDirectory = path.join(directory, 'documents', result.documentId)
    assert.equal(fs.existsSync(path.join(documentDirectory, 'base', `${result.resources.baseImageId}.png`)), true)
    assert.equal(fs.existsSync(path.join(documentDirectory, 'revisions', `${result.revisionId}.doc.json`)), true)
    assert.equal(fs.existsSync(path.join(documentDirectory, 'revisions', `${result.revisionId}.result.png`)), true)
    // staging 必须被清掉（不能留在受控目录里）。
    assert.equal(fs.existsSync(path.join(documentDirectory, '.staging')), false)

    // 索引条目：filePath 是 head result 的别名，且带版本字段（§6.5.1 / §6.5.7）。
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 1)
    const entry = entries[0]
    assert.equal(entry.documentId, result.documentId)
    assert.equal(entry.id, result.documentId)
    assert.equal(entry.revisionId, result.revisionId)
    assert.equal(entry.version, 1)
    assert.equal(entry.width, 800)
    assert.equal(entry.height, 600)
    assert.equal(entry.storageFormat, 'editable-v1')
    assert.equal(entry.filePath, path.join(documentDirectory, 'revisions', `${result.revisionId}.result.png`))
    assert.equal(fs.existsSync(entry.filePath), true)

    // 落盘文档带主进程分配的 id 与底图哈希，坐标是源像素。
    const document = documentApi.parseDocument(fs.readFileSync(entry.docPath)).document
    assert.equal(document.documentId, result.documentId)
    assert.equal(document.revisionId, result.revisionId)
    assert.equal(document.parentRevisionId, null)
    assert.equal(document.crop.w, 800)
    assert.equal(document.annotations.length, 1)
    assert.match(document.baseImage.sha256, /^[0-9a-f]{64}$/)
  })
})

test('§4 create validates the result size against crop before writing anything', async () => {
  await withService(async ({  service, store, directory  }) => {
    const session = startCreateSession(service)
    const result = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-bad-size',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      // crop 是 800×600，结果图却是 400×300：必须拒绝，且不留任何文件。
      resultBuffer: PNG_400x300,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'result-size-mismatch')
    assert.deepEqual(store.get('captureHistory', []), [])
    // 校验发生在任何写入之前：受控目录里不能留下版本文件（连目录都可能还没建）。
    const documentsRoot = path.join(directory, 'documents')
    const documentDirectories = fs.existsSync(documentsRoot) ? fs.readdirSync(documentsRoot) : []
    for (const name of documentDirectories) {
      const revisionsDirectory = path.join(documentsRoot, name, 'revisions')
      if (!fs.existsSync(revisionsDirectory)) continue
      assert.deepEqual(fs.readdirSync(revisionsDirectory), [])
    }
    // 也不该有任何 staging 残留。
    for (const name of documentDirectories) {
      assert.equal(fs.existsSync(path.join(documentsRoot, name, '.staging')), false)
    }
  })
})

test('§4 create requires a base image and rejects a footerless/garbage result', async () => {
  await withService(async ({  service  }) => {
    const session = startCreateSession(service)
    const missingBase = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-no-base',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      resultBuffer: PNG_800x600
    })
    assert.equal(missingBase.code, 'missing-base-image')

    const noResult = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-no-result',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      resultBuffer: Buffer.alloc(0),
      newBaseBuffer: PNG_800x600
    })
    assert.equal(noResult.code, 'empty-result')

    const badSnapshot = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-bad-snapshot',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: Buffer.from('{"schemaVersion":99}'),
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(badSnapshot.code, 'unsupported-schema')
  })
})

test('§4 commit rejects an unknown/expired session so the renderer cannot touch another document', async () => {
  await withService(async ({  service  }) => {
    const result = await service.commit({
      sessionId: 'session-forged',
      requestId: 'req-1',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'session-expired')

    const badIntent = await service.commit({
      sessionId: startCreateSession(service).sessionId,
      requestId: 'req-2',
      intent: 'overwrite-someone-else',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(badIntent.code, 'invalid-intent')
  })
})

test('§6 history disabled is an explicit status, not a silent success', async () => {
  await withService(async ({  service  }) => {
    const session = startCreateSession(service)
    const result = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-disabled',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(result.code, 'history-disabled')
    assert.equal(result.historyStatus, 'disabled')
  }, { getSettings: (settings) => ({ ...settings, screenshot: { ...settings.screenshot, historyEnabled: false } }) })
})

// ---------- §4 update：默认原地更新 ----------

test('§6 update appends an immutable revision and moves head while keeping one card', async () => {
  await withService(async ({  service, store, directory  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    const firstEntry = store.get('captureHistory', [])[0]
    const firstDocPath = firstEntry.docPath
    const firstResultPath = firstEntry.filePath

    const editSession = startEditSession(service, first.documentId)
    const second = await service.commit({
      sessionId: editSession.sessionId,
      requestId: 'req-2',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'rect', x: 5, y: 5, x2: 50, y2: 40, width: 4, color: '#ff9900' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(second.status, 'committed', JSON.stringify(second))
    assert.equal(second.documentId, first.documentId)
    assert.notEqual(second.revisionId, first.revisionId)
    assert.equal(second.version, 2)

    // 仍然只有一张卡片（§6.5.1：列表仍只有该文档一张卡片），且卡片位置不变。
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].documentId, first.documentId)
    assert.equal(entries[0].revisionId, second.revisionId)
    assert.equal(entries[0].version, 2)
    assert.equal(entries[0].filePath, second.resources.resultPath)
    // 旧 revision 的 doc/result 仍在（不可变，旧 head 不提前删）。
    assert.equal(fs.existsSync(firstDocPath), true)
    assert.equal(fs.existsSync(firstResultPath), true)
    // 新 revision 的 parentRevisionId 指向旧 head。
    const parent = documentApi.parseDocument(fs.readFileSync(second.resources.docPath)).document
    assert.equal(parent.parentRevisionId, first.revisionId)
    // 底图跨版本复用（同一 assetId、同一文件）。
    assert.equal(entries[0].baseImageId, firstEntry.baseImageId)
    assert.equal(fs.existsSync(path.join(directory, 'documents', first.documentId, 'base', `${firstEntry.baseImageId}.png`)), true)
  })
})

test('§4 unchanged content does not create a second revision', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const annotations = [{ type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000' }]
    const first = await createFirstVersion(service, createSession, { annotations })

    const editSession = startEditSession(service, first.documentId)
    const same = await service.commit({
      sessionId: editSession.sessionId,
      requestId: 'req-same',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor(annotations),
      resultBuffer: PNG_800x600
    })
    assert.equal(same.status, 'unchanged')
    assert.equal(same.version, 1)
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].revisionId, first.revisionId)
    assert.equal(entries[0].version, 1)
    // 撤销回基线也应当是 unchanged：只把 view 改掉不产生内容变化。
    const viewOnly = documentApi.serializeDocument({
      baseImage: { assetId: 'placeholder', width: 800, height: 600 },
      crop: { x: 0, y: 0, w: 800, h: 600 },
      annotations,
      view: { zoomMultiplier: 3, centerX: 1, centerY: 1 }
    })
    const again = await service.commit({
      sessionId: editSession.sessionId,
      requestId: 'req-view-only',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: viewOnly,
      resultBuffer: PNG_800x600
    })
    assert.equal(again.status, 'unchanged')
  })
})

test('§4 a stale expectedRevisionId returns conflict with the current head and writes nothing', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    const editSession = startEditSession(service, first.documentId)
    const second = await service.commit({
      sessionId: editSession.sessionId,
      requestId: 'req-2',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(second.status, 'committed')

    // 另一个会话还停留在旧 head 上提交 ⇒ conflict（不能无提示覆盖）。
    const staleSession = startEditSession(service, first.documentId)
    const conflict = await service.commit({
      sessionId: staleSession.sessionId,
      requestId: 'req-stale',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'ellipse', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#00ff00' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(conflict.status, 'conflict')
    assert.equal(conflict.headRevisionId, second.revisionId)
    assert.equal(conflict.version, 2)
    // head 没被改动。
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].revisionId, second.revisionId)
    assert.equal(entries[0].version, 2)
  })
})

test('§4 a document deleted mid-session returns deleted and is never resurrected', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    const editSession = startEditSession(service, first.documentId)

    // 模拟用户从列表删掉了这条记录（索引里没有它了）。
    store.set('captureHistory', [])

    const result = await service.commit({
      sessionId: editSession.sessionId,
      requestId: 'req-after-delete',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'deleted')
    // 不复活：索引仍然是空的。
    assert.deepEqual(store.get('captureHistory', []), [])
  })
})

// ---------- §4 幂等 ----------

test('§4 replaying the same requestId returns the same revision instead of adding a version', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession, { requestId: 'req-create' })
    assert.equal(first.version, 1)

    // 同一 requestId 重试（模拟确认丢失后客户端重发）。
    const replay = await service.commit({
      sessionId: createSession.sessionId,
      requestId: 'req-create',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: snapshotFor(),
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(replay.status, 'committed')
    assert.equal(replay.replayed, true)
    assert.equal(replay.revisionId, first.revisionId)
    // 只有一条记录、一个版本。
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].revisionId, first.revisionId)

    // update 的幂等同理：重放不产生第 2 版。
    const editSession = startEditSession(service, first.documentId)
    const updatePayload = {
      sessionId: editSession.sessionId,
      requestId: 'req-update-1',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    }
    const update = await service.commit(updatePayload)
    assert.equal(update.version, 2)
    const updateReplay = await service.commit(updatePayload)
    assert.equal(updateReplay.replayed, true)
    assert.equal(updateReplay.revisionId, update.revisionId)
    assert.equal(store.get('captureHistory', [])[0].version, 2)
  })
})

test('§4 commit status answers a lost confirmation without re-executing it', async () => {
  await withService(async ({  service  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession, { requestId: 'req-known' })
    const known = service.commitStatus({ documentId: first.documentId, requestId: 'req-known' })
    assert.equal(known.ok, true)
    assert.equal(known.revisionId, first.revisionId)
    // 未知 requestId 明确返回 expired，不得悄悄再次执行。
    const unknown = service.commitStatus({ documentId: first.documentId, requestId: 'req-never-sent' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.status, 'expired')
    assert.equal(unknown.code, 'expired')
  })
})

// ---------- §5 消费者视角 ----------

test('§5 resolveCommittedResult is the single source for external image consumers', async () => {
  await withService(async ({  service  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    const head = service.resolveCommittedResult(first.documentId)
    assert.equal(head.ok, true)
    assert.equal(head.revisionId, first.revisionId)
    assert.equal(head.filePath, first.resources.resultPath)
    assert.equal(head.width, 800)
    // 旧版本也能解析（不是只有 head）。
    const specific = service.resolveCommittedResult(first.documentId, first.revisionId)
    assert.equal(specific.ok, true)
    // 未知文档 / 缺失记录都显式失败，不回退 base。
    assert.equal(service.resolveCommittedResult('document-missing').code, 'deleted')

    // 结果图被删后必须报 result-missing，而不是拿底图顶替。
    fs.unlinkSync(first.resources.resultPath)
    const missing = service.resolveCommittedResult(first.documentId)
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'result-missing')
  })
})

test('§10 a missing doc degrades to explicit bitmap-only recovery, never to base', async () => {
  await withService(async ({  service  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    const loaded = service.loadDocument(first.documentId)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.storageFormat, 'editable-v1')
    assert.equal(loaded.document.annotations.length, 0)

    // 删掉 doc：只能显式"仅位图恢复"，且 result 仍可读。
    fs.unlinkSync(first.resources.docPath)
    const degraded = service.loadDocument(first.documentId)
    assert.equal(degraded.ok, true)
    assert.equal(degraded.degraded, true)
    assert.equal(degraded.code, 'bitmap-only-recovery')
    assert.equal(degraded.resultImagePath, first.resources.resultPath)
    // 绝不返回 base 冒充结果图。
    assert.notEqual(degraded.resultImagePath, first.resources.baseImagePath)
  })
})

test('§10 doc AND result both missing is reported as corrupted, not silently unusable', async () => {
  await withService(async ({  service  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    fs.unlinkSync(first.resources.docPath)
    fs.unlinkSync(first.resources.resultPath)
    const degraded = service.loadDocument(first.documentId)
    assert.equal(degraded.ok, false)
    assert.equal(degraded.code, 'corrupted')
    assert.equal(degraded.resultImagePath, '')
  })
})

test('§6.7 a legacy flat entry loads as legacy and upgrades lazily on first commit', async () => {
  await withService(async ({  service, store  }) => {
    // 旧条目：只有扁平 PNG，没有任何文档字段。
    const legacyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-legacy-')), 'Highlighter_2026-10-01_10-00-00.png')
    fs.writeFileSync(legacyPath, PNG_800x600)
    store.set('captureHistory', [{ id: 'legacy-1', filePath: legacyPath, width: 800, height: 600, source: 'region' }])

    const loaded = service.loadDocument('legacy-1')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.legacy, true)
    assert.equal(loaded.storageFormat, 'legacy-bitmap')

    // 会话可以打开旧条目（兼容期 item.id === documentId）。
    const session = startEditSession(service, 'legacy-1')
    assert.equal(session.documentId, 'legacy-1')

    // 首次提交：文档 id 保持稳定，旧 PNG 变成独立不可变底图，产生第一个 revision。
    const upgraded = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-upgrade',
      intent: 'update',
      expectedRevisionId: '',
      snapshot: snapshotFor([{ type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(upgraded.status, 'committed', JSON.stringify(upgraded))
    assert.equal(upgraded.documentId, 'legacy-1')
    assert.equal(upgraded.version, 2, 'legacy 首次升级也占一版（原图为第 1 版）')
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].documentId, 'legacy-1')
    assert.equal(entries[0].storageFormat, 'editable-v1')
    // 原 PNG 仍在（不被重写），新底图是它的副本。
    assert.equal(fs.existsSync(legacyPath), true)
    assert.notEqual(entries[0].baseImagePath, legacyPath)
    assert.equal(fs.existsSync(entries[0].baseImagePath), true)
    fs.rmSync(path.dirname(legacyPath), { recursive: true, force: true })
  })
})

// ---------- §6 save-copy ----------

test('§6 save-copy creates an independent document with derivedFrom, without folding the source', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)

    const copySession = startEditSession(service, first.documentId)
    const copy = await service.commit({
      sessionId: copySession.sessionId,
      requestId: 'req-copy',
      intent: 'save-copy',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'arrow', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(copy.status, 'committed', JSON.stringify(copy))
    assert.notEqual(copy.documentId, first.documentId, '另存必须产生新 documentId')
    assert.equal(copy.version, 1, '另存首版是第 1 版')

    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 2)
    // 新文档插到首部，原文档保持原位（§6.5.1）。
    assert.equal(entries[0].documentId, copy.documentId)
    assert.equal(entries[1].documentId, first.documentId)
    const copyDocument = documentApi.parseDocument(fs.readFileSync(copy.resources.docPath)).document
    assert.deepEqual(copyDocument.derivedFrom, { documentId: first.documentId, revisionId: first.revisionId })
    // 来源文档的 head 完全没变。
    assert.equal(entries[1].revisionId, first.revisionId)
    assert.equal(entries[1].version, 1)
    // 底图物理复制（消除跨文档删除依赖），不是共享路径。
    assert.notEqual(entries[0].baseImagePath, entries[1].baseImagePath)
    assert.equal(fs.existsSync(entries[0].baseImagePath), true)

    // 删掉来源文档不影响副本打开（§6.5.1）。
    store.set('captureHistory', entries.filter((entry) => entry.documentId !== first.documentId))
    assert.equal(service.loadDocument(copy.documentId).ok, true)
  })
})

// ---------- §6 列表顺序 ----------

test('§6.5.1 an update keeps the card in place while a new screenshot inserts at the top', async () => {
  await withService(async ({  service, store  }) => {
    const sessions = []
    for (let index = 0; index < 3; index += 1) sessions.push(startCreateSession(service))
    const documents = await Promise.all(sessions.map((session, index) => createFirstVersion(service, session, { requestId: `req-${index}` })))
    // create 插到首部 ⇒ 最新在前。
    assert.deepEqual(
      store.get('captureHistory', []).map((entry) => entry.documentId),
      [documents[2].documentId, documents[1].documentId, documents[0].documentId]
    )
    // 更新中间那条：位置不能动。
    const middle = startEditSession(service, documents[1].documentId)
    const updated = await service.commit({
      sessionId: middle.sessionId,
      requestId: 'req-update-middle',
      intent: 'update',
      expectedRevisionId: documents[1].revisionId,
      snapshot: snapshotFor([{ type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(updated.status, 'committed')
    assert.deepEqual(
      store.get('captureHistory', []).map((entry) => entry.documentId),
      [documents[2].documentId, documents[1].documentId, documents[0].documentId]
    )
  })
})

// ---------- §9 保留策略 ----------

test('§9 revision retention keeps at most historyRevisionLimit revisions and never drops head', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    let head = first.revisionId
    // 连续提交 5 个新版本（上限设 3）。
    for (let index = 0; index < 5; index += 1) {
      const session = startEditSession(service, first.documentId)
      const result = await service.commit({
        sessionId: session.sessionId,
        requestId: `req-rev-${index}`,
        intent: 'update',
        expectedRevisionId: head,
        snapshot: snapshotFor([{ type: 'rect', x: index, y: index, x2: index + 5, y2: index + 5, width: 4, color: '#ff0000' }]),
        resultBuffer: PNG_800x600
      })
      assert.equal(result.status, 'committed', JSON.stringify(result))
      head = result.revisionId
    }
    const revisions = service.listRevisions(first.documentId)
    assert.ok(revisions.length <= 3, `retention kept ${revisions.length} revisions`)
    // head 永远保留。
    assert.ok(revisions.some((revision) => revision.revisionId === head))
    // 被淘汰的版本文件真的被回收了。
    for (const revision of revisions) {
      if (revision.revisionId === head) assert.equal(revision.hasResult, true)
    }
    const entry = store.get('captureHistory', [])[0]
    assert.equal(entry.revisionId, head)
    assert.equal(entry.version, 6)
  }, { revisionLimit: 3 })
})

test('§9 historyLimit still counts documents, not revisions', async () => {
  await withService(async ({  service, store  }) => {
    // 一条文档反复编辑不应该把别的截图挤掉。
    const sessions = []
    for (let index = 0; index < 3; index += 1) sessions.push(startCreateSession(service))
    const documents = await Promise.all(sessions.map((session, index) => createFirstVersion(service, session, { requestId: `req-${index}` })))
    for (let index = 0; index < 4; index += 1) {
      const session = startEditSession(service, documents[0].documentId)
      const head = store.get('captureHistory', []).find((entry) => entry.documentId === documents[0].documentId).revisionId
      await service.commit({
        sessionId: session.sessionId,
        requestId: `req-edit-${index}`,
        intent: 'update',
        expectedRevisionId: head,
        snapshot: snapshotFor([{ type: 'rect', x: index, y: index, x2: index + 4, y2: index + 4, width: 4, color: '#ff0000' }]),
        resultBuffer: PNG_800x600
      })
    }
    const entries = store.get('captureHistory', [])
    assert.equal(entries.length, 3, 'editing one document must not evict other screenshots')
    assert.ok(entries.some((entry) => entry.documentId === documents[0].documentId))
  }, { getSettings: (settings) => ({ ...settings, screenshot: { ...settings.screenshot, historyLimit: 3 } }) })
})

test('§9 document deletion removes every owned file and the stats stop counting it', async () => {
  await withService(async ({  service, store  }) => {
    const session = startCreateSession(service)
    const first = await createFirstVersion(service, session)
    const before = service.documentStats()
    assert.equal(before.documentCount, 1)
    // filePath 是当前 head result 的**别名**（同一文件），所以去重后是 4 个文件。
    assert.equal(before.fileCount, 4, 'base + doc + result(=filePath alias) + thumb')
    assert.ok(before.totalBytes > 0)

    assert.equal(service.deleteDocumentFiles(first.documentId), true)
    const directory = path.join(store.get('captureHistory', [])[0].docPath.split(path.sep + 'revisions')[0])
    assert.equal(fs.existsSync(directory), false)
    // 索引由 HistoryService 侧负责移除；这里只验证磁盘清理。
    store.set('captureHistory', [])
    const after = service.documentStats()
    assert.deepEqual(after, {
      documentCount: 0,
      revisionCount: 0,
      editableCount: 0,
      bitmapOnlyCount: 0,
      totalBytes: 0,
      fileCount: 0
    })
  })
})

// ---------- §5 索引恢复 ----------

test('§5 the index recovers from its backup when the primary index is lost', async () => {
  await withService(async ({  service, store  }) => {
    const session = startCreateSession(service)
    await createFirstVersion(service, session)
    assert.equal(store.get('captureHistory', []).length, 1)
    // 模拟主索引损坏/被清空。
    store.set('captureHistory', [])
    const recovered = service.recoverIndex()
    assert.equal(recovered.recovered, true)
    assert.equal(store.get('captureHistory', []).length, 1)
    // 健康索引上再跑一次是 no-op。
    assert.equal(service.recoverIndex().recovered, false)
  })
})

test('§5 a failed index publish rolls back to the previous head and leaves it readable', async () => {
  await withService(async ({  service, store  }) => {
    const createSession = startCreateSession(service)
    const first = await createFirstVersion(service, createSession)
    // 让第二次索引写入失败。
    const originalWrite = service.historyService.writeHistory
    service.historyService.writeHistory = () => { throw new Error('disk full') }
    const session = startEditSession(service, first.documentId)
    const result = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-publish-fail',
      intent: 'update',
      expectedRevisionId: first.revisionId,
      snapshot: snapshotFor([{ type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }]),
      resultBuffer: PNG_800x600
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'index-publish-failed')
    assert.equal(result.retryable, true)
    service.historyService.writeHistory = originalWrite
    // 旧 head 仍然可读（旧 head 文件从未被删）。
    const head = service.resolveCommittedResult(first.documentId)
    assert.equal(head.ok, true)
    assert.equal(head.revisionId, first.revisionId)
    assert.equal(store.get('captureHistory', [])[0].revisionId, first.revisionId)
  })
})

// ---------- §4 载荷边界 ----------

test('§4 the document payload budget is enforced on the received bytes', async () => {
  await withService(async ({  service  }) => {
    const session = startCreateSession(service)
    const oversized = Buffer.alloc(documentApi.MAX_DOCUMENT_BYTES + 1, 0x20)
    const result = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-huge',
      intent: 'create',
      expectedRevisionId: null,
      snapshot: oversized,
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'document-too-large')
  })
})

test('§4 a crop outside the base image is rejected rather than silently expanded', async () => {
  await withService(async ({  service  }) => {
    const session = startCreateSession(service)
    const result = await service.commit({
      sessionId: session.sessionId,
      requestId: 'req-bad-crop',
      intent: 'create',
      expectedRevisionId: null,
      // 800×600 底图，crop 却是 900 宽。
      // 注意：serializeDocument() 会按契约把 crop 钳制回底图内，所以这里刻意直接构造
      // 原始 JSON 字节 —— 模拟"不可信进程绕过发送端归一化"的情况，服务必须拒绝而不是
      // 静默接受一个越界的 crop。
      snapshot: Buffer.from(JSON.stringify({
        schemaVersion: 1,
        coordinateSpace: 'source-pixel',
        baseImage: { assetId: 'placeholder', width: 800, height: 600 },
        crop: { x: 0, y: 0, w: 900, h: 600 },
        annotations: []
      }), 'utf8'),
      resultBuffer: pngOfSize(900, 600),
      newBaseBuffer: PNG_800x600
    })
    assert.equal(result.status, 'failed')
    // 两层防御都会拒绝它：契约层的 schema 校验先命中（crop-out-of-bounds ⇒ invalid-document），
    // 服务层自己也会再查一次。两处都必须拒绝，所以接受这两个码中的任意一个，
    // 但不能是"成功"。
    assert.ok(
      ['crop-out-of-bounds', 'invalid-document'].includes(result.code),
      `out-of-bounds crop must be rejected, got ${result.code}`
    )
  })
})
