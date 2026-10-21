const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  USAGE_HANDLE_CHANNELS,
  USAGE_PROGRESS_CHANNEL,
  registerUsageIpc
} = require('../main/ipc/usage-ipc')

function createIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
      handlers.set(channel, handler)
    }
  }
}

function createHandlers(overrides = {}) {
  const calls = []
  const record = (name) => async (args) => {
    calls.push({ name, args })
    return { name, args }
  }
  return {
    calls,
    handlers: {
      status: record('status'),
      refresh: record('refresh'),
      summary: record('summary'),
      daily: record('daily'),
      hourly: record('hourly'),
      breakdown: record('breakdown'),
      heatmap: record('heatmap'),
      clear: record('clear'),
      ...overrides
    }
  }
}

test('usage IPC registers exactly the eight handle channels as literals', () => {
  const ipcMain = createIpcMain()
  const { handlers } = createHandlers()
  registerUsageIpc({ ipcMain, handlers })
  assert.deepEqual([...ipcMain.handlers.keys()], [...USAGE_HANDLE_CHANNELS])
  assert.equal(ipcMain.handlers.has('usage:scan-progress'), false)
  assert.equal(USAGE_PROGRESS_CHANNEL, 'usage:scan-progress')

  // The repo IPC-surface contract test discovers registrations with a regex, so
  // the literal channel strings are part of the contract (Lead review 2026-10-21).
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'usage-ipc.js'), 'utf8')
  const literals = [...source.matchAll(/ipcMain\.handle\('(usage:[a-z-]+)'/g)].map((match) => match[1])
  assert.deepEqual(literals, [...USAGE_HANDLE_CHANNELS])
  assert.equal(/ipcMain\.handle\(\s*[A-Za-z_$]/.test(source), false, 'no variable channel ipcMain.handle call')
})

test('usage IPC requires every handler before registering', () => {
  const ipcMain = createIpcMain()
  const { handlers } = createHandlers()
  delete handlers.heatmap
  assert.throws(() => registerUsageIpc({ ipcMain, handlers }), /handler is missing: heatmap/)
  assert.equal(ipcMain.handlers.size, 0)
})

test('usage IPC validates and forwards status / refresh / clear arguments', async () => {
  const ipcMain = createIpcMain()
  const { handlers, calls } = createHandlers()
  registerUsageIpc({ ipcMain, handlers })

  await ipcMain.handlers.get('usage:status')(null)
  await ipcMain.handlers.get('usage:refresh')(null, { reason: 'page-open' })
  await ipcMain.handlers.get('usage:refresh')(null)
  await ipcMain.handlers.get('usage:clear')(null)
  assert.deepEqual(calls.map((call) => [call.name, call.args]), [
    ['status', undefined],
    ['refresh', { reason: 'page-open' }],
    ['refresh', { reason: 'manual' }],
    ['clear', undefined]
  ])
  await assert.rejects(
    async () => ipcMain.handlers.get('usage:refresh')(null, { reason: 'again' }),
    /usage: invalid refresh reason/
  )
})

test('usage IPC accepts custom ranges for summary/daily/breakdown', async () => {
  const ipcMain = createIpcMain()
  const { handlers, calls } = createHandlers()
  registerUsageIpc({ ipcMain, handlers })

  await ipcMain.handlers.get('usage:summary')(null, {
    period: 'custom',
    tz: 'Asia/Shanghai',
    from: '2026-09-22',
    to: '2026-10-21'
  })
  await ipcMain.handlers.get('usage:daily')(null, { period: 'custom', from: '2026-09-22', to: '2026-10-21' })
  await ipcMain.handlers.get('usage:breakdown')(null, {
    period: 'custom',
    from: '2026-09-22',
    to: '2026-10-21',
    scope: 'model'
  })
  assert.deepEqual(calls.map((call) => call.name), ['summary', 'daily', 'breakdown'])
  assert.equal(calls[0].args.period, 'custom')
  assert.equal(calls[0].args.from, '2026-09-22')
  assert.equal(calls[0].args.to, '2026-10-21')
  assert.equal(calls[0].args.tz, 'Asia/Shanghai')
  assert.equal(calls[2].args.scope, 'model')
  assert.equal(calls[1].args.tz, 'UTC', 'missing timezone falls back to UTC')
})

test('usage IPC rejects malformed query arguments with usage: errors', async () => {
  const ipcMain = createIpcMain()
  const { handlers } = createHandlers()
  registerUsageIpc({ ipcMain, handlers })
  const summary = ipcMain.handlers.get('usage:summary')
  const daily = ipcMain.handlers.get('usage:daily')
  const hourly = ipcMain.handlers.get('usage:hourly')
  const breakdown = ipcMain.handlers.get('usage:breakdown')
  const heatmap = ipcMain.handlers.get('usage:heatmap')

  await assert.rejects(summary(null, { period: 'year' }), /usage: invalid period/)
  await assert.rejects(summary(null, 'nope'), /usage: args must be an object/)
  await assert.rejects(summary(null, { period: 'custom' }), /usage: custom period requires from and to/)
  await assert.rejects(summary(null, { period: 'custom', from: '2026-10-02', to: '2026-10-01' }), /usage: range start is after range end/)
  await assert.rejects(summary(null, { period: 'custom', from: '2020-01-01', to: '2026-10-21' }), /usage: range is longer than 800 days/)
  await assert.rejects(daily(null, { period: 'custom', from: '2026-13-01', to: '2026-01-01' }), /usage: from is not a real date/)
  await assert.rejects(hourly(null, { day: 'today' }), /usage: day must be YYYY-MM-DD/)
  await assert.rejects(breakdown(null, { scope: 'session' }), /usage: invalid breakdown scope/)
  await assert.rejects(heatmap(null, { weeks: 'many' }), /usage: weeks must be a number/)
})

test('usage IPC clamps heatmap weeks and normalizes unknown timezones', async () => {
  const ipcMain = createIpcMain()
  const { handlers, calls } = createHandlers()
  registerUsageIpc({ ipcMain, handlers })
  const heatmap = ipcMain.handlers.get('usage:heatmap')
  await heatmap(null)
  await heatmap(null, { weeks: 500, tz: 'Not/AZone' })
  await heatmap(null, { weeks: -3 })
  assert.equal(calls[0].args.weeks, 52)
  assert.equal(calls[0].args.tz, 'UTC')
  assert.equal(calls[1].args.weeks, 52)
  assert.equal(calls[1].args.tz, 'UTC')
  assert.equal(calls[2].args.weeks, 1)
})

test('usage IPC maps thrown non-Error values to usage: errors', async () => {
  const ipcMain = createIpcMain()
  const { handlers } = createHandlers({
    clear: () => {
      throw 'boom'
    }
  })
  registerUsageIpc({ ipcMain, handlers })
  await assert.rejects(ipcMain.handlers.get('usage:clear')(null), /usage: boom/)
})
