const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  LOCATOR_NAME,
  PENDING_NAME,
  createDataPaths,
  ensureDataLayoutSync,
  readLocatorSync,
  resolvePortableDirectory
} = require('./data-root')

function applyElectronPaths(app, paths) {
  app.setPath('userData', paths.runtime)
  app.setPath('sessionData', paths.electronCache)
}

function verifyWritableDirectorySync(directory, fileSystem) {
  const probe = path.join(directory, `.highlighter-bootstrap-write-${crypto.randomUUID()}`)
  const renamed = `${probe}.renamed`
  try {
    fileSystem.writeFileSync(probe, 'ok', 'utf8')
    fileSystem.renameSync(probe, renamed)
    fileSystem.rmSync(renamed, { force: true })
  } catch (error) {
    try { fileSystem.rmSync(probe, { force: true }) } catch {}
    try { fileSystem.rmSync(renamed, { force: true }) } catch {}
    throw error
  }
}

function verifyElectronPathsSync(paths, fileSystem) {
  verifyWritableDirectorySync(paths.runtime, fileSystem)
  verifyWritableDirectorySync(paths.electronCache, fileSystem)
}

function prepareDataRoot({ app, applicationName = app.getName(), env = process.env, tempRoot = os.tmpdir(), fileSystem = fs }) {
  const portableDirectory = resolvePortableDirectory(env)
  const legacyUserData = portableDirectory
    ? path.join(app.getPath('appData'), applicationName)
    : app.getPath('userData')
  const locatorDirectory = portableDirectory || legacyUserData
  const locatorPath = path.join(locatorDirectory, LOCATOR_NAME)
  const pendingPath = path.join(locatorDirectory, PENDING_NAME)
  let requestedRoot = ''
  try {
    const locator = readLocatorSync(locatorPath)
    requestedRoot = locator.dataRoot
    const rootStat = fileSystem.statSync(locator.dataRoot)
    if (!rootStat.isDirectory()) {
      const error = new Error('Highlighter 数据目录不是文件夹')
      error.code = 'ENOTDIR'
      throw error
    }
    const paths = ensureDataLayoutSync(createDataPaths(locator.dataRoot))
    verifyElectronPathsSync(paths, fileSystem)
    applyElectronPaths(app, paths)
    return {
      portable: !!portableDirectory,
      portableDirectory,
      locatorDirectory,
      locatorPath,
      pendingPath,
      legacyUserData,
      locator,
      paths,
      needsSelection: false
    }
  } catch (error) {
    const locatorMissing = error.code === 'ENOENT' && !requestedRoot
    if (!portableDirectory && locatorMissing) {
      return {
        portable: false,
        portableDirectory,
        locatorDirectory,
        locatorPath,
        pendingPath,
        legacyUserData,
        paths: null,
        needsSelection: false
      }
    }

    const provisionalRoot = fileSystem.mkdtempSync(path.join(tempRoot, 'highlighter-bootstrap-'))
    try {
      const paths = ensureDataLayoutSync(createDataPaths(provisionalRoot))
      verifyElectronPathsSync(paths, fileSystem)
      applyElectronPaths(app, paths)
      return {
        portable: !!portableDirectory,
        portableDirectory,
        locatorDirectory,
        locatorPath,
        pendingPath,
        legacyUserData,
        provisionalRoot,
        paths,
        needsSelection: true,
        requestedRoot,
        startupError: locatorMissing ? null : error
      }
    } catch (bootstrapError) {
      removeProvisionalRoot({ provisionalRoot }, fileSystem)
      throw bootstrapError
    }
  }
}

function removeProvisionalRoot(context, fileSystem = fs) {
  if (!context?.provisionalRoot) return true
  try {
    fileSystem.rmSync(context.provisionalRoot, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

module.exports = { applyElectronPaths, prepareDataRoot, removeProvisionalRoot }
