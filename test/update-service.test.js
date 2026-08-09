const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  UpdateService,
  normalizeUpdateError,
  sanitizeUpdateText
} = require('../main/services/update-service')

class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.checkCalls = 0
    this.downloadCalls = 0
    this.installCalls = []
    this.checkImplementation = async () => {}
    this.downloadImplementation = async () => {}
  }

  checkForUpdates() {
    this.checkCalls++
    return this.checkImplementation()
  }

  downloadUpdate() {
    this.downloadCalls++
    return this.downloadImplementation()
  }

  quitAndInstall(...args) {
    this.installCalls.push(args)
  }
}

function createService(overrides = {}) {
  const updater = overrides.updater === undefined ? new FakeUpdater() : overrides.updater
  const service = new UpdateService({
    updater,
    currentVersion: '2.1.0',
    installType: 'nsis',
    ...overrides
  })
  return { service, updater }
}

test('configures stable and beta channels without allowing downgrade', () => {
  const { service, updater } = createService()
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.channel, 'latest')
  assert.equal(updater.allowPrerelease, false)
  assert.equal(updater.allowDowngrade, false)

  service.setChannel('beta')
  assert.equal(updater.channel, 'beta')
  assert.equal(updater.allowPrerelease, true)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(service.getStatus().channel, 'beta')
})

test('moves through check and download states with sanitized metadata and progress', async () => {
  const snapshots = []
  const { service, updater } = createService({ notify: (snapshot) => snapshots.push(snapshot) })
  updater.checkImplementation = async () => {
    updater.emit('checking-for-update')
    updater.emit('update-available', {
      version: '2.1.1',
      releaseDate: '2026-08-10T00:00:00.000Z',
      releaseNotes: 'Fixes https://example.com/release?token=secret',
      files: [{ size: 120 }, { size: 80 }]
    })
  }

  const available = await service.check({ manual: true })
  assert.equal(available.status, 'available')
  assert.equal(available.version, '2.1.1')
  assert.equal(available.size, 120)
  assert.equal(available.releaseNotes.includes('secret'), false)

  updater.downloadImplementation = async () => {
    updater.emit('download-progress', { percent: 47.5, transferred: 57, total: 120, bytesPerSecond: 20 })
    updater.emit('update-downloaded', {
      version: '2.1.1',
      releaseDate: '2026-08-10T00:00:00.000Z',
      releaseNotes: 'Ready',
      files: [{ size: 120 }]
    })
  }
  const downloaded = await service.download()
  assert.equal(downloaded.status, 'downloaded')
  assert.equal(downloaded.progress.percent, 100)
  assert.ok(snapshots.some((snapshot) => snapshot.status === 'downloading' && snapshot.progress.percent === 47.5))

  updater.emit('download-progress', { percent: 12 })
  assert.equal(service.getStatus().progress.percent, 100, 'out-of-order progress must be ignored')
})

test('throttles automatic checks while manual checks bypass the interval', async () => {
  let currentTime = Date.parse('2026-08-09T00:00:00.000Z')
  const { service, updater } = createService({ now: () => currentTime })
  updater.checkImplementation = async () => {
    updater.emit('checking-for-update')
    updater.emit('update-not-available')
  }

  await service.check()
  await service.check()
  assert.equal(updater.checkCalls, 1)
  await service.check({ manual: true })
  assert.equal(updater.checkCalls, 2)
  currentTime += DEFAULT_CHECK_INTERVAL_MS
  await service.check()
  assert.equal(updater.checkCalls, 3)
})

test('schedules the first and subsequent automatic checks at controlled intervals', async () => {
  const timers = []
  const { service, updater } = createService({
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn: (timer) => { timer.cleared = true }
  })
  updater.checkImplementation = async () => updater.emit('update-not-available')

  assert.equal(service.start(), true)
  assert.equal(service.start(), false)
  assert.equal(timers[0].delay, DEFAULT_STARTUP_DELAY_MS)
  await timers[0].callback()
  assert.equal(updater.checkCalls, 1)
  assert.equal(timers[1].delay, DEFAULT_CHECK_INTERVAL_MS)
  service.dispose()
  assert.equal(timers[1].cleared, true)
})

test('coalesces repeated check and download requests', async () => {
  let releaseCheck
  let releaseDownload
  const { service, updater } = createService()
  updater.checkImplementation = () => new Promise((resolve) => { releaseCheck = resolve })
  const firstCheck = service.check({ manual: true })
  const secondCheck = service.check({ manual: true })
  assert.equal(updater.checkCalls, 1)
  updater.emit('update-available', { version: '2.1.1' })
  releaseCheck()
  await Promise.all([firstCheck, secondCheck])

  updater.downloadImplementation = () => new Promise((resolve) => { releaseDownload = resolve })
  const firstDownload = service.download()
  const secondDownload = service.download()
  assert.equal(updater.downloadCalls, 1)
  updater.emit('update-downloaded', { version: '2.1.1' })
  releaseDownload()
  await Promise.all([firstDownload, secondDownload])
  assert.equal(service.getStatus().status, 'downloaded')
})

test('portable builds only open the release page', async () => {
  let openedChannel = ''
  const updater = new FakeUpdater()
  const service = new UpdateService({
    updater: null,
    currentVersion: '2.1.0',
    installType: 'portable',
    channel: 'beta',
    openDownloadPage: async (channel) => { openedChannel = channel }
  })

  await service.check({ manual: true })
  await service.download()
  await service.install()
  assert.equal(openedChannel, 'beta')
  assert.equal(updater.checkCalls, 0)
  assert.equal(service.start(), false)
})

test('blocks install while work is active and quiesces before installing', async () => {
  let allowInstall = false
  let prepared = false
  const { service, updater } = createService({
    canInstall: async () => allowInstall ? { ok: true } : { ok: false, reason: 'OCR 正在识别，请完成后重试。' },
    prepareInstall: async () => { prepared = true }
  })
  service.setState({ status: 'downloaded', version: '2.1.1' })

  const blocked = await service.install()
  assert.equal(blocked.status, 'downloaded')
  assert.match(blocked.installBlocked, /OCR/)
  assert.equal(updater.installCalls.length, 0)

  allowInstall = true
  const installing = await service.install()
  assert.equal(installing.status, 'installing')
  assert.equal(prepared, true)
  assert.deepEqual(updater.installCalls, [[false, true]])
})

test('normalizes update failures and removes secrets from logs and notes', async () => {
  assert.equal(normalizeUpdateError(new Error('certificate mismatch')).code, 'signature-invalid')
  assert.equal(normalizeUpdateError(new Error('ENOSPC')).code, 'disk-full')
  assert.equal(normalizeUpdateError(new Error('ETIMEDOUT')).code, 'network-timeout')
  assert.equal(normalizeUpdateError(new Error('ENOTFOUND')).code, 'network-error')
  assert.equal(normalizeUpdateError(new Error('download interrupted')).code, 'download-failed')
  const sanitized = sanitizeUpdateText('https://example.com/a?token=secret Bearer abc token=hidden')
  assert.equal(sanitized.includes('secret'), false)
  assert.equal(sanitized.includes('hidden'), false)
  assert.equal(sanitized.includes('abc'), false)

  const logs = []
  const { service, updater } = createService({ log: (...args) => logs.push(args) })
  updater.logger.info('request', { url: 'https://example.com/file?token=logger-secret', authorization: 'Bearer hidden' })
  assert.equal(JSON.stringify(logs).includes('logger-secret'), false)
  assert.equal(JSON.stringify(logs).includes('hidden'), false)
  updater.checkImplementation = async () => { throw new Error('download https://example.com/file?token=secret') }
  const status = await service.check({ manual: true })
  assert.equal(status.status, 'error')
  assert.equal(JSON.stringify(logs).includes('secret'), false)
})

test('survives a destroyed status target and removes updater listeners on dispose', async () => {
  const { service, updater } = createService({ notify: () => { throw new Error('window destroyed') } })
  updater.checkImplementation = async () => updater.emit('update-not-available')
  const status = await service.check({ manual: true })
  assert.equal(status.status, 'idle')
  assert.ok(updater.listenerCount('error') > 0)
  service.dispose()
  assert.equal(updater.listenerCount('error'), 0)
})
