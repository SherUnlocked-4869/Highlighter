'use strict'

// B05: the capacity view is attached by the clipboard domain, not by a new
// sidecar method. This harness fakes the service status so the one piece of
// state that is genuinely new - the this-run skip counters - can be driven
// through the same event and IPC paths the panel and settings page use.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createClipboardDomain } = require('../main/domains/clipboard')

const MIB = 1048576

function harness() {
  const handlers = new Map()
  const settings = { enabled: true, historyLimit: 500, retentionDays: 30, maxPayloadMiB: 256, maxDiskMiB: 384, maxThumbnailMiB: 64, releaseAfterMs: 60000, language: 'en-US', theme: 'light', mainColor: '#e5a44c', excludedApps: [] }
  const domain = createClipboardDomain({
    app: { isPackaged: false },
    rootDirectory: path.resolve(__dirname, '..'),
    directory: 'unused',
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    nativeTheme: { shouldUseDarkColors: false },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle() {}, unhandle() {} } }) },
    dialog: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    createLocalWindow: () => { throw new Error('this harness never opens the panel') },
    positionAutomationWindow() {},
    getSettings: () => ({ clipboard: settings, language: 'en-US', theme: 'light', compact: false, mainColor: '#e5a44c' }),
    updateSettings() {},
    getHook: () => null,
    isGameModeEnabled: () => false,
    isMigrationInProgress: () => false,
    automation: true
  })
  const base = { phase: 'running', available: true, datasetId: 'dataset', revision: 1, itemCount: 3, pinnedCount: 1, payloadBytes: 10 * MIB, actualDiskBytes: 12 * MIB, pendingGcBytes: 0, messageKey: null }
  domain.service.snapshot = () => ({ ...base })
  domain.service.command = async () => ({})
  const emit = (patch) => domain.service.emit('status', { ...base, ...patch })
  const status = async () => {
    const response = await handlers.get('clipboard:status')({})
    assert.equal(response.ok, true, JSON.stringify(response.error))
    return response.result
  }
  return { domain, settings, emit, status, base, handlers }
}

test('the status IPC carries a capacity view derived from the snapshot', async () => {
  const h = harness()
  const snapshot = await h.status()
  assert.equal(snapshot.itemCount, 3, 'the existing status fields are preserved')
  const capacity = snapshot.capacity
  assert.ok(capacity, 'capacity is attached')
  assert.equal(capacity.counts.ordinary.value, 2)
  assert.equal(capacity.counts.pinned.value, 1)
  assert.equal(capacity.counts.ordinary.estimated, false)
  assert.equal(capacity.bytes.payload.value, 10 * MIB)
  assert.equal(capacity.bytes.payload.estimated, false)
  assert.equal(capacity.bytes.thumbnails.value, 2 * MIB)
  assert.equal(capacity.bytes.thumbnails.estimated, true)
  assert.equal(capacity.budgets.records.limit.value, 500)
  assert.equal(capacity.budgets.records.remaining.value, 498)
  assert.equal(capacity.skip.since, 'run')
  assert.equal(capacity.skip.total, 0)
  assert.equal(capacity.pinned.neverEvicted, true)
})

test('status events accumulate this-run skip deltas and the latest reason', async () => {
  const h = harness()
  h.emit({ skipped: { excluded: 2 } })
  let snapshot = await h.status()
  assert.equal(snapshot.capacity.skip.total, 2)
  assert.equal(snapshot.capacity.skip.last, null, 'the first observed counter is a baseline, not a recency claim')
  h.emit({ skipped: { excluded: 3, storage_error: 2 } })
  snapshot = await h.status()
  const reasons = Object.fromEntries(snapshot.capacity.skip.reasons.map((reason) => [reason.code, reason.count]))
  assert.deepEqual(reasons, { excluded: 3, storage_error: 2 })
  assert.equal(snapshot.capacity.skip.last.code, 'storage_error')
  assert.equal(snapshot.capacity.skip.last.count, 2)
  assert.equal(snapshot.capacity.pinned.squeeze.possible, true, 'a storage rejection with pins is evidence')
  assert.equal(snapshot.capacity.pinned.squeeze.evidence, 'storage-rejection')
})

test('a sidecar counter reset is new work, not a negative delta', async () => {
  const h = harness()
  h.emit({ skipped: { excluded: 3, oversized: 2 } })
  await h.status()
  h.emit({ skipped: { excluded: 1 } })
  const snapshot = await h.status()
  const reasons = Object.fromEntries(snapshot.capacity.skip.reasons.map((reason) => [reason.code, reason.count]))
  assert.deepEqual(reasons, { excluded: 4, oversized: 2 }, 'the old totals survive and the new counter is added')
  assert.equal(snapshot.capacity.skip.total, 6)
  assert.equal(snapshot.capacity.skip.last.code, 'excluded')
  assert.equal(snapshot.capacity.skip.last.count, 1)
})

test('the view is computed from current settings, not cached at construction', async () => {
  const h = harness()
  h.settings.historyLimit = 120
  const snapshot = await h.status()
  assert.equal(snapshot.capacity.budgets.records.limit.value, 120)
  assert.equal(snapshot.capacity.budgets.records.remaining.value, 118)
})

test('opening settings spends at most one fresh status request', async () => {
  const h = harness()
  let refreshes = 0
  h.domain.service.refresh = async () => { refreshes += 1; return h.domain.service.snapshot() }
  h.domain.service.lastRefreshAt = 0
  await h.handlers.get('clipboard:status')({ sender: { id: 42 } })
  assert.equal(refreshes, 1, 'the settings window asks for one current aggregate')
  h.domain.service.lastRefreshAt = Date.now()
  await h.handlers.get('clipboard:status')({ sender: { id: 42 } })
  assert.equal(refreshes, 1, 'a status younger than the paint budget is reused')
})

test('reading the capacity view does not mutate the service status', async () => {
  const h = harness()
  const raw = h.domain.service.snapshot()
  assert.equal(Object.hasOwn(raw, 'capacity'), false)
  await h.status()
  assert.equal(Object.hasOwn(h.domain.service.snapshot(), 'capacity'), false)
})

test('an empty status still produces a usable, all-zero capacity view', async () => {
  const h = harness()
  h.domain.service.snapshot = () => ({ phase: 'disabled', itemCount: 0, pinnedCount: 0 })
  const snapshot = await h.status()
  assert.equal(snapshot.capacity.counts.ordinary.value, 0)
  assert.equal(snapshot.capacity.skip.total, 0)
  assert.equal(snapshot.capacity.budgets.records.limit.value, 500)
})
