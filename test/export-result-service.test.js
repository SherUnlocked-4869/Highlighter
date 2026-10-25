// Feature A1 (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §4.2, §4.3):
// the export result registry. Plain node tests: real files in a .tmp* scratch directory for the
// existence re-checks, fake shell/clipboard/clock everywhere else. Nothing here imports Electron.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  EXPORT_ACTIONS,
  EXPORT_EXTENSIONS,
  EXPORT_KINDS,
  ExportResultService,
  createExportResultService,
  ownerScope,
  storedOwnerId
} = require('../main/services/export-result-service')
const { registerExportIpc } = require('../main/ipc/export-ipc')

const ROOT = path.join(__dirname, '..')

function makeScratch() {
  const directory = fs.mkdtempSync(path.join(ROOT, '.tmp-export-result-'))
  const write = (name, contents = 'x') => {
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, contents)
    return filePath
  }
  return {
    directory,
    write,
    pathFor: (name) => path.join(directory, name),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  }
}

function makeShell({ openMessage = '', throwOnOpen = false, showThrows = false } = {}) {
  const calls = []
  return {
    calls,
    openPath: async (target) => {
      calls.push({ method: 'openPath', target })
      if (throwOnOpen) throw new Error('no associated application')
      return openMessage
    },
    showItemInFolder: (target) => {
      calls.push({ method: 'showItemInFolder', target })
      if (showThrows) throw new Error('reveal failed')
    }
  }
}

function makeClipboard() {
  const writes = []
  return {
    writes,
    writeText: (text) => writes.push(text)
  }
}

function makeService(options = {}) {
  let clock = options.startAt ?? 1_000_000
  const logs = []
  const shell = options.shell || makeShell()
  const clipboard = options.clipboard || makeClipboard()
  let sequence = 0
  const service = createExportResultService({
    now: () => clock,
    shell,
    clipboard,
    log: (...args) => logs.push(args.join(' ')),
    createId: options.createId || (() => `result-${++sequence}`),
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {})
  })
  return {
    service,
    shell,
    clipboard,
    logs,
    now: () => clock,
    advance: (milliseconds) => { clock += milliseconds },
    setClock: (value) => { clock = value }
  }
}

// ---------------------------------------------------------------------------
// module surface and constants
// ---------------------------------------------------------------------------

test('module exposes the frozen kind/action vocabulary and plan §3.3 defaults', () => {
  assert.deepEqual([...EXPORT_KINDS], ['png', 'pdf', 'xlsx', 'mp4', 'gif'])
  assert.deepEqual([...EXPORT_ACTIONS], ['open', 'copy-path', 'reveal'])
  assert.deepEqual({ ...EXPORT_EXTENSIONS }, {
    png: '.png',
    pdf: '.pdf',
    xlsx: '.xlsx',
    mp4: '.mp4',
    gif: '.gif'
  })
  assert.equal(DEFAULT_MAX_ENTRIES, 50)
  assert.equal(DEFAULT_TTL_MS, 15 * 60 * 1000)
  assert.equal(typeof ExportResultService, 'function')
  assert.equal(typeof createExportResultService, 'function')
})

test('the factory refuses to build without its injectable collaborators', () => {
  const shell = makeShell()
  const clipboard = makeClipboard()
  assert.throws(() => createExportResultService({ clipboard }), /requires a shell/)
  assert.throws(() => createExportResultService({ shell }), /requires a clipboard/)
  assert.throws(
    () => createExportResultService({ shell, clipboard, fs: {} }),
    /requires a file system/
  )
  assert.throws(
    () => createExportResultService({ shell, clipboard, now: 5 }),
    /requires a now\(\) clock/
  )
})

test('owner scope maps tray/null apart from a window and fails closed on unusable ids', () => {
  assert.equal(ownerScope(null), 'tray')
  assert.equal(ownerScope(undefined), 'tray')
  assert.equal(ownerScope('tray'), 'tray')
  assert.equal(ownerScope('1'), '1')
  assert.equal(ownerScope(7), '7')
  assert.equal(ownerScope('  '), '')
  assert.equal(ownerScope({}), '')
  assert.equal(ownerScope(Symbol('x')), '')
  // A window can never own an entry under the internal tray scope string.
  assert.equal(storedOwnerId('tray'), null)
  assert.equal(storedOwnerId(null), null)
  assert.equal(storedOwnerId('42'), '42')
})

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

test('register returns a saved receipt for a file that exists', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService({ startAt: 1234 })
    const filePath = scratch.write('Highlighter_2026-10-25.png')
    const receipt = service.register({
      filePath,
      kind: 'png',
      source: 'capture',
      ownerId: 'window-1'
    })

    // Plan §4.2 freezes the receipt shape: exactly these four fields, no path.
    assert.deepEqual(Object.keys(receipt).sort(), ['fileName', 'kind', 'resultId', 'status'])
    assert.equal(receipt.status, 'saved')
    assert.equal(receipt.resultId, 'result-1')
    assert.equal(receipt.fileName, 'Highlighter_2026-10-25.png')
    assert.equal(receipt.kind, 'png')
    assert.equal(service.list().length, 1)

    // The path, clock and owner stay main-process-only: the internal entry holds them.
    const entry = service.entries.get(receipt.resultId)
    assert.equal(entry.filePath, path.resolve(filePath))
    assert.equal(entry.registeredAt, 1234)
    assert.equal(entry.ownerId, 'window-1')
    assert.equal(entry.source, 'capture')
  } finally {
    scratch.cleanup()
  }
})

test('the public receipt never exposes filePath, registeredAt or ownerId', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const filePath = scratch.write('private.png')
    const receipt = service.register({ filePath, kind: 'png', ownerId: 'window-1', source: 'capture' })

    for (const key of ['filePath', 'registeredAt', 'ownerId', 'source', 'requestId']) {
      assert.equal(Object.hasOwn(receipt, key), false, `receipt must not carry ${key}`)
    }
    // Every read surface returns the same narrow shape, not just register().
    assert.deepEqual(Object.keys(service.latestFor('window-1')).sort(), ['fileName', 'kind', 'resultId', 'status'])
    assert.deepEqual(Object.keys(service.latestFor()).sort(), ['fileName', 'kind', 'resultId', 'status'])
    for (const listed of service.list()) {
      for (const key of ['filePath', 'registeredAt', 'ownerId']) {
        assert.equal(Object.hasOwn(listed, key), false, `list() must not carry ${key}`)
      }
    }
    // ... and nothing in the receipt leaks the scratch directory the file lives in.
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(scratch.directory.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  } finally {
    scratch.cleanup()
  }
})

test('register resolves a relative path to an absolute main-process path and keeps the base name', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const absolute = scratch.write('shot.pdf')
    const relative = path.relative(process.cwd(), absolute)
    const receipt = service.register({ filePath: relative, kind: 'pdf', ownerId: 'w' })
    assert.equal(receipt.fileName, 'shot.pdf')
    const entry = service.entries.get(receipt.resultId)
    assert.equal(path.isAbsolute(entry.filePath), true)
    assert.equal(entry.filePath, absolute)
  } finally {
    scratch.cleanup()
  }
})

test('a missing file registers as null instead of throwing (cancelled save must not look saved)', () => {
  const scratch = makeScratch()
  try {
    const { service, logs } = makeService()
    const missing = scratch.pathFor('never-written.png')
    const receipt = service.register({ filePath: missing, kind: 'png', ownerId: 'w' })

    assert.equal(receipt, null)
    assert.deepEqual(service.list(), [])
    assert.match(logs.join('\n'), /missing/)
  } finally {
    scratch.cleanup()
  }
})

test('an empty file is treated as an aborted write, not a saved result', () => {
  const scratch = makeScratch()
  try {
    const { service, logs } = makeService()
    const empty = scratch.write('empty.png', '')
    assert.equal(service.register({ filePath: empty, kind: 'png', ownerId: 'w' }), null)
    assert.match(logs.join('\n'), /empty/)
  } finally {
    scratch.cleanup()
  }
})

test('register never throws for malformed input', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const good = scratch.write('ok.png')
    for (const payload of [
      undefined,
      null,
      {},
      { filePath: '', kind: 'png' },
      { filePath: 42, kind: 'png' },
      { filePath: good, kind: 'bmp' },
      { filePath: good, kind: undefined },
      { filePath: `${good}\u0000suffix`, kind: 'png' },
      { filePath: scratch.directory + path.sep, kind: 'png' }
    ]) {
      assert.equal(service.register(payload), null, `payload ${JSON.stringify(payload)} registers nothing`)
    }
    assert.deepEqual(service.list(), [])
  } finally {
    scratch.cleanup()
  }
})

test('register replays the same requestId for the same owner instead of registering twice', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const filePath = scratch.write('once.png')
    const payload = { filePath, kind: 'png', ownerId: 'w', requestId: 'req-1' }
    const first = service.register(payload)
    const second = service.register(payload)
    assert.equal(second.resultId, first.resultId)
    assert.equal(service.list().length, 1)

    // A different owner with the same requestId is a different save.
    const other = service.register({ ...payload, ownerId: 'w2' })
    assert.notEqual(other.resultId, first.resultId)
    assert.equal(service.list().length, 2)
  } finally {
    scratch.cleanup()
  }
})

test('a kind that disagrees with the extension still registers, but the action re-check refuses it', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell } = makeService()
    const pdfFile = scratch.write('actually-a-pdf.pdf')
    const receipt = service.register({ filePath: pdfFile, kind: 'png', ownerId: 'w' })
    assert.equal(receipt.status, 'saved')
    const result = await service.perform({ resultId: receipt.resultId, action: 'open', ownerId: 'w' })
    assert.deepEqual(result, { status: 'failed', code: 'file-missing' })
    assert.deepEqual(shell.calls, [])
  } finally {
    scratch.cleanup()
  }
})

// ---------------------------------------------------------------------------
// perform: happy paths
// ---------------------------------------------------------------------------

test('open delegates to shell.openPath and reports done when the shell returns an empty string', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell } = makeService()
    const filePath = scratch.write('a.png')
    const { resultId } = service.register({ filePath, kind: 'png', ownerId: 'w' })
    const result = await service.perform({ resultId, action: 'open', ownerId: 'w' })
    assert.deepEqual(result, { status: 'done' })
    assert.deepEqual(shell.calls, [{ method: 'openPath', target: filePath }])
  } finally {
    scratch.cleanup()
  }
})

test('copy-path copies the absolute path and does not touch the shell', async () => {
  const scratch = makeScratch()
  try {
    const { service, clipboard, shell } = makeService()
    const filePath = scratch.write('a.xlsx')
    const { resultId } = service.register({ filePath, kind: 'xlsx', ownerId: 'w' })
    const result = await service.perform({ resultId, action: 'copy-path', ownerId: 'w' })
    assert.deepEqual(result, { status: 'done' })
    assert.deepEqual(clipboard.writes, [path.resolve(filePath)])
    assert.deepEqual(shell.calls, [])
  } finally {
    scratch.cleanup()
  }
})

test('reveal delegates to shell.showItemInFolder', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell } = makeService()
    const filePath = scratch.write('a.mp4')
    const { resultId } = service.register({ filePath, kind: 'mp4', ownerId: 'w' })
    const result = await service.perform({ resultId, action: 'reveal', ownerId: 'w' })
    assert.deepEqual(result, { status: 'done' })
    assert.deepEqual(shell.calls, [{ method: 'showItemInFolder', target: filePath }])
  } finally {
    scratch.cleanup()
  }
})

test('the tray owner may act on the newest result it was given by latestFor', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell } = makeService()
    const first = scratch.write('first.png')
    const second = scratch.write('second.png')
    service.register({ filePath: first, kind: 'png', ownerId: 'window-1' })
    const newest = service.register({ filePath: second, kind: 'png', ownerId: 'window-2' })

    assert.equal(service.latestFor().resultId, newest.resultId)
    const asTray = await service.perform({ resultId: newest.resultId, action: 'open', ownerId: 'tray' })
    assert.deepEqual(asTray, { status: 'done' })
    // Null is the internal tray scope too.
    const asNull = await service.perform({ resultId: newest.resultId, action: 'open', ownerId: null })
    assert.deepEqual(asNull, { status: 'done' })
    // ... but the tray cannot address an older entry it never received.
    const stale = await service.perform({ resultId: 'result-1', action: 'open', ownerId: 'tray' })
    assert.deepEqual(stale, { status: 'failed', code: 'invalid-owner' })
    assert.equal(shell.calls.length, 2)
  } finally {
    scratch.cleanup()
  }
})

// ---------------------------------------------------------------------------
// perform: failures
// ---------------------------------------------------------------------------

test('open failure (non-empty shell message) maps to open-failed', async () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService({ shell: makeShell({ openMessage: 'No application is associated with this file' }) })
    const filePath = scratch.write('a.xlsx')
    const { resultId } = service.register({ filePath, kind: 'xlsx', ownerId: 'w' })
    const result = await service.perform({ resultId, action: 'open', ownerId: 'w' })
    assert.deepEqual(result, { status: 'failed', code: 'open-failed' })
  } finally {
    scratch.cleanup()
  }
})

test('a rejected shell.openPath also maps to open-failed instead of escaping', async () => {
  const scratch = makeScratch()
  try {
    const { service, logs } = makeService({ shell: makeShell({ throwOnOpen: true }) })
    const filePath = scratch.write('a.gif')
    const { resultId } = service.register({ filePath, kind: 'gif', ownerId: 'w' })
    const result = await service.perform({ resultId, action: 'open', ownerId: 'w' })
    assert.deepEqual(result, { status: 'failed', code: 'open-failed' })
    assert.match(logs.join('\n'), /no associated application/)
  } finally {
    scratch.cleanup()
  }
})

test('an unexpected clipboard failure is diagnosed in the log with action and resultId', async () => {
  const scratch = makeScratch()
  try {
    const clipboard = {
      writeText: () => { throw new Error('clipboard is locked by another process') }
    }
    const { service, logs } = makeService({ clipboard })
    const filePath = scratch.write('a.png')
    const { resultId } = service.register({ filePath, kind: 'png', ownerId: 'w' })

    // The frozen vocabulary has no generic action-failure code, so this stays 'open-failed';
    // what matters is that the log line names the action and the id (review point, task-2).
    assert.deepEqual(
      await service.perform({ resultId, action: 'copy-path', ownerId: 'w' }),
      { status: 'failed', code: 'open-failed' }
    )
    const line = logs.find((entry) => entry.includes('action failed'))
    assert.ok(line, `a failure log line exists: ${logs.join(' | ')}`)
    assert.match(line, /copy-path/)
    assert.match(line, new RegExp(resultId))
    assert.match(line, /clipboard is locked/)
  } finally {
    scratch.cleanup()
  }
})

test('a file moved after register reports file-missing for every action', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell, clipboard } = makeService()
    const filePath = scratch.write('moving.pdf')
    const { resultId } = service.register({ filePath, kind: 'pdf', ownerId: 'w' })
    fs.renameSync(filePath, scratch.pathFor('moved.pdf'))

    for (const action of ['open', 'copy-path', 'reveal']) {
      assert.deepEqual(
        await service.perform({ resultId, action, ownerId: 'w' }),
        { status: 'failed', code: 'file-missing' },
        `${action} reports file-missing`
      )
    }
    assert.deepEqual(shell.calls, [])
    assert.deepEqual(clipboard.writes, [])
  } finally {
    scratch.cleanup()
  }
})

test('an expired entry reports result-expired and never deletes the user file', async () => {
  const scratch = makeScratch()
  try {
    const { service, advance } = makeService({ ttlMs: 1_000 })
    const filePath = scratch.write('old.png')
    const { resultId } = service.register({ filePath, kind: 'png', ownerId: 'w' })

    advance(999)
    assert.deepEqual(await service.perform({ resultId, action: 'open', ownerId: 'w' }), { status: 'done' })
    advance(1)
    assert.deepEqual(
      await service.perform({ resultId, action: 'open', ownerId: 'w' }),
      { status: 'failed', code: 'result-expired' }
    )
    assert.equal(fs.existsSync(filePath), true, 'expiry only drops the reference')
    assert.deepEqual(service.list(), [])
    assert.equal(service.latestFor(), null)
  } finally {
    scratch.cleanup()
  }
})

test('an unknown resultId reports result-expired, not a special "not found" code', async () => {
  const { service } = makeService()
  for (const resultId of ['nope', '', undefined, null, 42]) {
    assert.deepEqual(
      await service.perform({ resultId, action: 'open', ownerId: 'w' }),
      { status: 'failed', code: 'result-expired' },
      `resultId ${String(resultId)}`
    )
  }
})

test('cross-window forgery fails with invalid-owner and performs nothing', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell, clipboard } = makeService()
    const filePath = scratch.write('private.png')
    const { resultId } = service.register({ filePath, kind: 'png', ownerId: 'window-1' })

    for (const action of ['open', 'copy-path', 'reveal']) {
      assert.deepEqual(
        await service.perform({ resultId, action, ownerId: 'window-2' }),
        { status: 'failed', code: 'invalid-owner' }
      )
    }
    assert.deepEqual(
      await service.perform({ resultId, action: 'open', ownerId: {} }),
      { status: 'failed', code: 'invalid-owner' }
    )
    assert.deepEqual(shell.calls, [])
    assert.deepEqual(clipboard.writes, [])
    // The legitimate owner still can.
    assert.deepEqual(await service.perform({ resultId, action: 'open', ownerId: 'window-1' }), { status: 'done' })
  } finally {
    scratch.cleanup()
  }
})

test('an unknown action is rejected before anything is opened', async () => {
  const scratch = makeScratch()
  try {
    const { service, shell, clipboard } = makeService()
    const filePath = scratch.write('a.png')
    const { resultId } = service.register({ filePath, kind: 'png', ownerId: 'w' })
    for (const action of ['delete', 'OPEN', '', undefined, 'copy-path ']) {
      const expected = action === 'copy-path ' ? { status: 'done' } : { status: 'failed', code: 'unknown-action' }
      assert.deepEqual(await service.perform({ resultId, action, ownerId: 'w' }), expected, `action ${String(action)}`)
    }
    assert.deepEqual(shell.calls, [])
    assert.deepEqual(clipboard.writes, [path.resolve(filePath)])
  } finally {
    scratch.cleanup()
  }
})

// ---------------------------------------------------------------------------
// capacity and ownership lifecycle
// ---------------------------------------------------------------------------

test('maxEntries eviction drops the oldest entries only and never deletes their files', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService({ maxEntries: 3 })
    const files = [1, 2, 3, 4, 5].map((index) => scratch.write(`shot-${index}.png`))
    const receipts = files.map((filePath, index) =>
      service.register({ filePath, kind: 'png', ownerId: `w${index}` }))

    const listed = service.list()
    assert.equal(listed.length, 3)
    assert.deepEqual(listed.map((receipt) => receipt.resultId), ['result-5', 'result-4', 'result-3'])
    assert.equal(listed.some((receipt) => receipt.resultId === receipts[0].resultId), false)
    for (const filePath of files) {
      assert.equal(fs.existsSync(filePath), true, 'eviction is metadata-only')
    }
  } finally {
    scratch.cleanup()
  }
})

test('revokeOwner drops that owner references only and keeps the files on disk', async () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const one = scratch.write('one.png')
    const two = scratch.write('two.png')
    const three = scratch.write('three.png')
    const first = service.register({ filePath: one, kind: 'png', ownerId: 'window-1' })
    service.register({ filePath: two, kind: 'png', ownerId: 'window-1' })
    const other = service.register({ filePath: three, kind: 'png', ownerId: 'window-2' })

    assert.equal(service.revokeOwner('window-1'), 2)
    assert.deepEqual(service.list().map((receipt) => receipt.resultId), [other.resultId])
    assert.deepEqual(
      await service.perform({ resultId: first.resultId, action: 'open', ownerId: 'window-1' }),
      { status: 'failed', code: 'result-expired' }
    )
    assert.deepEqual(await service.perform({ resultId: other.resultId, action: 'open', ownerId: 'window-2' }), { status: 'done' })
    assert.equal(fs.existsSync(one), true)
    assert.equal(fs.existsSync(two), true)

    // Unknown / tray / malformed owners revoke nothing and do not throw.
    assert.equal(service.revokeOwner('window-9'), 0)
    assert.equal(service.revokeOwner(null), 0)
    assert.equal(service.revokeOwner({}), 0)
    assert.equal(service.list().length, 1)
  } finally {
    scratch.cleanup()
  }
})

test('registering again for a revoked owner works and yields a new resultId', async () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const firstPath = scratch.write('first.png')
    const secondPath = scratch.write('second.png')
    const first = service.register({ filePath: firstPath, kind: 'png', ownerId: 'window-1' })
    assert.equal(service.revokeOwner('window-1'), 1)

    const second = service.register({ filePath: secondPath, kind: 'png', ownerId: 'window-1' })
    assert.equal(second.status, 'saved')
    assert.notEqual(second.resultId, first.resultId)
    assert.deepEqual(
      await service.perform({ resultId: second.resultId, action: 'copy-path', ownerId: 'window-1' }),
      { status: 'done' }
    )
  } finally {
    scratch.cleanup()
  }
})

test('a retried requestId after revokeOwner registers a NEW result instead of resolving to the dead one', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const filePath = scratch.write('shot.png')
    const payload = { filePath, kind: 'png', ownerId: 'w', requestId: 'r1' }

    const first = service.register(payload)
    // Same requestId before any revoke is a replay.
    assert.equal(service.register(payload).resultId, first.resultId)

    assert.equal(service.revokeOwner('w'), 1)
    assert.equal(service.latestFor('w'), null)

    // The replay index must not still point at the revoked resultId.
    const retried = service.register(payload)
    assert.equal(retried.status, 'saved')
    assert.notEqual(retried.resultId, first.resultId)
    assert.equal(service.list().length, 1)
    assert.equal(service.entries.get(retried.resultId)?.requestId, 'r1')
  } finally {
    scratch.cleanup()
  }
})

test('revokeOwner leaves another owner requestId replay index intact', () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const filePath = scratch.write('shot.png')
    const mine = service.register({ filePath, kind: 'png', ownerId: 'w1', requestId: 'r1' })
    service.register({ filePath, kind: 'png', ownerId: 'w2', requestId: 'r1' })

    assert.equal(service.revokeOwner('w1'), 1)
    assert.equal(service.latestFor('w2').resultId !== mine.resultId, true)
    // w2's replay still works: its index entry was not swept up with w1's.
    const replayed = service.register({ filePath, kind: 'png', ownerId: 'w2', requestId: 'r1' })
    assert.equal(service.list().length, 1)
    assert.equal(service.latestFor('w2').resultId, replayed.resultId)
  } finally {
    scratch.cleanup()
  }
})

// ---------------------------------------------------------------------------
// reads and lifecycle
// ---------------------------------------------------------------------------

test('latestFor returns the newest live receipt per owner and for the tray', () => {
  const scratch = makeScratch()
  try {
    const { service, advance } = makeService({ ttlMs: 10_000 })
    assert.equal(service.latestFor(), null)
    assert.equal(service.latestFor('window-1'), null)
    assert.equal(service.latestFor({}), null)

    const a = scratch.write('a.png')
    const b = scratch.write('b.png')
    const c = scratch.write('c.png')
    service.register({ filePath: a, kind: 'png', ownerId: 'window-1' })
    advance(10)
    const second = service.register({ filePath: b, kind: 'png', ownerId: 'window-1' })
    advance(10)
    const third = service.register({ filePath: c, kind: 'pdf', ownerId: 'window-2' })

    assert.equal(service.latestFor('window-1').resultId, second.resultId)
    assert.equal(service.latestFor('window-2').resultId, third.resultId)
    assert.equal(service.latestFor().resultId, third.resultId)
  } finally {
    scratch.cleanup()
  }
})

test('latestFor ignores an owner whose entries all expired', () => {
  const scratch = makeScratch()
  try {
    const { service, advance } = makeService({ ttlMs: 100 })
    const filePath = scratch.write('a.png')
    service.register({ filePath, kind: 'png', ownerId: 'window-1' })
    advance(100)
    assert.equal(service.latestFor('window-1'), null)
  } finally {
    scratch.cleanup()
  }
})

test('list is newest-first and returns plain receipts', () => {
  const scratch = makeScratch()
  try {
    const { service, advance } = makeService()
    const a = service.register({ filePath: scratch.write('a.png'), kind: 'png', ownerId: 'w' })
    advance(5)
    const b = service.register({ filePath: scratch.write('b.pdf'), kind: 'pdf', ownerId: 'w' })
    const listed = service.list()
    assert.deepEqual(listed.map((receipt) => receipt.resultId), [b.resultId, a.resultId])
    // list() is the same narrow public receipt - no internal bookkeeping fields.
    for (const key of ['filePath', 'registeredAt', 'ownerId', 'source', 'requestId']) {
      assert.equal(Object.hasOwn(listed[0], key), false, `list() must not carry ${key}`)
    }
  } finally {
    scratch.cleanup()
  }
})

test('dispose drops the registry and stops accepting registrations and actions', async () => {
  const scratch = makeScratch()
  try {
    const { service } = makeService()
    const filePath = scratch.write('a.png')
    const { resultId } = service.register({ filePath, kind: 'png', ownerId: 'w' })
    service.dispose()
    service.dispose() // idempotent

    assert.equal(service.register({ filePath, kind: 'png', ownerId: 'w' }), null)
    assert.deepEqual(service.list(), [])
    assert.equal(service.latestFor(), null)
    assert.equal(service.revokeOwner('w'), 0)
    assert.deepEqual(
      await service.perform({ resultId, action: 'open', ownerId: 'w' }),
      { status: 'failed', code: 'result-expired' }
    )
  } finally {
    scratch.cleanup()
  }
})

// ---------------------------------------------------------------------------
// main/ipc/export-ipc.js
// ---------------------------------------------------------------------------

function createIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  }
}

test('export IPC module owns exactly the export:perform-action invoke channel', async () => {
  const ipcMain = createIpcMain()
  const received = []
  const controller = {
    performAction: (event, payload) => {
      received.push({ event, payload })
      return { status: 'done' }
    }
  }
  registerExportIpc({ ipcMain, controller })

  assert.deepEqual([...ipcMain.handlers.keys()], ['export:perform-action'])
  assert.deepEqual([...ipcMain.listeners.keys()], [])

  const event = { sender: { id: 7 } }
  const result = await ipcMain.handlers.get('export:perform-action')(event, { resultId: 'r1', action: 'open' })
  assert.deepEqual(result, { status: 'done' })
  assert.deepEqual(received, [{ event, payload: { resultId: 'r1', action: 'open' } }])

  assert.throws(() => registerExportIpc({ ipcMain: null, controller }), /Export IPC requires/)
  assert.throws(() => registerExportIpc({ ipcMain: createIpcMain(), controller: null }), /Export IPC requires/)
})

test('the service never imports Electron at module scope', () => {
  for (const file of ['main/services/export-result-service.js', 'main/ipc/export-ipc.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.doesNotMatch(source, /require\(['"]electron['"]\)/, `${file} has no Electron require`)
  }
})
