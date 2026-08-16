const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { app } = require('electron')
const { NsisUpdater } = require('electron-updater')
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
const { UpdateService } = require('../main/services/update-service')
const projectPackage = require('../package.json')

const RESULT_PREFIX = 'HIGHLIGHTER_UPDATE_FAILURE_PROBE='
const updateVersion = projectPackage.version.replace(/(\d+)$/, (patch) => String(Number(patch) + 1))
const installerName = `Highlighter-Setup-${updateVersion}.exe`
const installerPayload = Buffer.from('not-an-installer-but-a-complete-update-payload')
const installerSha512 = crypto.createHash('sha512').update(installerPayload).digest('base64')
const root = process.env.HIGHLIGHTER_UPDATE_FAILURE_ROOT
if (!root || !path.isAbsolute(root)) throw new Error('HIGHLIGHTER_UPDATE_FAILURE_ROOT must be absolute')
const userDataPath = path.join(root, 'user-data')
const cachePath = path.join(root, 'cache')
const currentBinaryPath = path.join(root, 'current', 'Highlighter.exe')
const configPath = path.join(root, 'app-update.yml')
const sentinelPath = path.join(userDataPath, 'user-data-sentinel.json')

app.disableHardwareAcceleration()
fs.mkdirSync(path.dirname(currentBinaryPath), { recursive: true })
fs.mkdirSync(userDataPath, { recursive: true })
fs.mkdirSync(cachePath, { recursive: true })
fs.writeFileSync(currentBinaryPath, 'current-version-2.1.0')
fs.writeFileSync(sentinelPath, JSON.stringify({ history: ['capture-a'], apiKey: 'sentinel-key', shortcuts: { screenshot: 'F1' } }))
app.setPath('userData', userDataPath)
app.setPath('cache', cachePath)

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function manifest() {
  return [
    `version: ${updateVersion}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${installerSha512}`,
    `    size: ${installerPayload.length}`,
    `path: ${installerName}`,
    `sha512: ${installerSha512}`,
    `releaseDate: ${new Date().toISOString()}`,
    ''
  ].join('\n')
}

function collectFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? collectFiles(entryPath) : [entryPath]
  })
}

function createServer() {
  let scenario = '404'
  const requests = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push(url.pathname)
    if (url.pathname === '/latest.yml') {
      if (scenario === '404') {
        response.writeHead(404).end('not found')
      } else if (scenario === 'invalid-manifest') {
        response.writeHead(200, { 'Content-Type': 'text/yaml' }).end('version: [broken')
      } else {
        response.writeHead(200, { 'Content-Type': 'text/yaml' }).end(manifest())
      }
      return
    }
    if (url.pathname === `/${installerName}`) {
      if (scenario === 'interrupted-download') {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': installerPayload.length + 1024
        })
        response.write(installerPayload.subarray(0, 8))
        response.destroy()
      } else {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': installerPayload.length
        }).end(installerPayload)
      }
      return
    }
    response.writeHead(404).end('not found')
  })
  return {
    server,
    requests,
    setScenario(value) { scenario = value }
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

function createUpdater(baseUrl, scenario) {
  fs.writeFileSync(configPath, [
    'provider: generic',
    `url: ${baseUrl}`,
    'updaterCacheDirName: highlighter-update-rehearsal',
    'publisherName:',
    '  - Highlighter Test',
    ''
  ].join('\n'))
  const appAdapter = {
    version: projectPackage.version,
    name: projectPackage.name,
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath,
    baseCachePath: cachePath,
    whenReady: () => app.whenReady(),
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    onQuit: (handler) => app.on('quit', (_event, exitCode) => handler(exitCode))
  }
  const updater = new NsisUpdater({ provider: 'generic', url: baseUrl }, appAdapter)
  updater.httpExecutor = new ElectronHttpExecutor((authInfo, callback) => updater.emit('login', authInfo, callback))
  updater.setFeedURL({ provider: 'generic', url: baseUrl })
  updater.disableDifferentialDownload = true
  updater.disableWebInstaller = true
  if (scenario === 'signature-mismatch') {
    updater.verifyUpdateCodeSignature = async () => 'publisher mismatch'
  }
  return updater
}

async function runScenario(name, expectedCode, baseUrl, serverState, initialHashes) {
  serverState.setScenario(name)
  const updater = createUpdater(baseUrl, name)
  let downloaded = false
  const logs = []
  updater.on('update-downloaded', () => { downloaded = true })
  const service = new UpdateService({
    updater,
    currentVersion: projectPackage.version,
    installType: 'nsis',
    channel: 'stable',
    log: (...values) => logs.push(values)
  })

  const checked = await service.check({ manual: true })
  let finalState = checked
  if (checked.status === 'available') {
    if (name === 'disk-full') {
      updater.httpExecutor.download = async () => {
        const error = new Error('ENOSPC: insufficient disk space during update download')
        error.code = 'ENOSPC'
        throw error
      }
    }
    finalState = await service.download()
  }
  service.dispose()

  if (finalState.status !== 'error' || finalState.error?.code !== expectedCode) {
    throw new Error(`${name} returned ${finalState.status}/${finalState.error?.code || 'none'}, expected error/${expectedCode}; logs=${JSON.stringify(logs)}`)
  }
  if (downloaded || updater.quitAndInstallCalled) throw new Error(`${name} reached an installable state`)
  if (sha256(currentBinaryPath) !== initialHashes.binary || sha256(sentinelPath) !== initialHashes.userData) {
    throw new Error(`${name} modified the current binary or user data`)
  }
  const cachedExecutables = collectFiles(cachePath).filter((filePath) => filePath.toLowerCase().endsWith('.exe'))
  if (cachedExecutables.length > 0) throw new Error(`${name} left an executable in the updater cache`)
  return {
    name,
    errorCode: finalState.error.code,
    currentBinaryPreserved: true,
    userDataPreserved: true,
    installTriggered: false,
    cachedExecutableCount: 0
  }
}

let finished = false
const timeout = setTimeout(() => {
  if (finished) return
  finished = true
  console.error('Update failure rehearsal timed out')
  app.exit(1)
}, 60000)

app.whenReady().then(async () => {
  const serverState = createServer()
  try {
    const port = await listen(serverState.server)
    const baseUrl = `http://127.0.0.1:${port}/`
    const initialHashes = { binary: sha256(currentBinaryPath), userData: sha256(sentinelPath) }
    const scenarios = []
    for (const [name, expectedCode] of [
      ['invalid-manifest', 'update-metadata-invalid'],
      ['404', 'network-error'],
      ['interrupted-download', 'network-error'],
      ['signature-mismatch', 'signature-invalid'],
      ['disk-full', 'disk-full']
    ]) {
      scenarios.push(await runScenario(name, expectedCode, baseUrl, serverState, initialHashes))
    }
    await close(serverState.server)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({
      updaterVersion: require('electron-updater/package.json').version,
      currentVersion: projectPackage.version,
      requests: serverState.requests,
      scenarios
    })}\n`)
    app.exit(0)
  } catch (error) {
    await close(serverState.server).catch(() => {})
    finished = true
    clearTimeout(timeout)
    console.error(error.stack || error.message || String(error))
    app.exit(1)
  }
}).catch((error) => {
  finished = true
  clearTimeout(timeout)
  console.error(error.stack || error.message || String(error))
  app.exit(1)
})
