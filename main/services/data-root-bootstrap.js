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

function prepareDataRoot({ app, env = process.env, tempRoot = os.tmpdir(), fileSystem = fs }) {
  const legacyUserData = app.getPath('userData')
  const portableDirectory = resolvePortableDirectory(env)
  if (!portableDirectory) return { portable: false, legacyUserData, paths: null, needsSelection: false }

  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  const pendingPath = path.join(portableDirectory, PENDING_NAME)
  let requestedRoot = ''
  try {
    const locator = readLocatorSync(locatorPath)
    requestedRoot = locator.dataRoot
    const paths = ensureDataLayoutSync(createDataPaths(locator.dataRoot))
    verifyElectronPathsSync(paths, fileSystem)
    applyElectronPaths(app, paths)
    return { portable: true, portableDirectory, locatorPath, pendingPath, legacyUserData, locator, paths, needsSelection: false }
  } catch (error) {
    const locatorMissing = error.code === 'ENOENT'
    const provisionalRoot = fileSystem.mkdtempSync(path.join(tempRoot, 'highlighter-bootstrap-'))
    try {
      const paths = ensureDataLayoutSync(createDataPaths(provisionalRoot))
      verifyElectronPathsSync(paths, fileSystem)
      applyElectronPaths(app, paths)
      return {
        portable: true,
        portableDirectory,
        locatorPath,
        pendingPath,
        legacyUserData,
        provisionalRoot,
        paths,
        needsSelection: true,
        requestedRoot,
        startupError: locatorMissing && !requestedRoot ? null : error
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
