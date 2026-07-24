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

function prepareDataRoot({ app, env = process.env, tempRoot = os.tmpdir() }) {
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
    applyElectronPaths(app, paths)
    return { portable: true, portableDirectory, locatorPath, pendingPath, legacyUserData, locator, paths, needsSelection: false }
  } catch (error) {
    const locatorMissing = error.code === 'ENOENT'
    const provisionalRoot = fs.mkdtempSync(path.join(tempRoot, 'highlighter-bootstrap-'))
    const paths = ensureDataLayoutSync(createDataPaths(provisionalRoot))
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
  }
}

function removeProvisionalRoot(context) {
  if (context?.provisionalRoot) fs.rmSync(context.provisionalRoot, { recursive: true, force: true })
}

module.exports = { applyElectronPaths, prepareDataRoot, removeProvisionalRoot }
