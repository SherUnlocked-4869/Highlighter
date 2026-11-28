'use strict'

// N02b / integration helper: the lazy EverythingService singleton moved out of main.js.
//
// main.js sits at a hard line ceiling (scripts/check-architecture.js) and needs two resolver
// lines for the clipboard domain (pin creation + the shared OCR service), so this ~20-line
// factory moved here: the construction is unchanged, only the module boundary is new.
//
// The getter is lazy because a search may never happen in a session and the sidecar spawn is
// the expensive part; `isMigrationInProgress` is a resolver because the migration flag lives
// in main.js and must be read at call time, not at construction time.

function createEverythingServiceGetter({
  app,
  path,
  getActivePaths,
  getSettings,
  getSearchDomain,
  e2eContext,
  log,
  EverythingService,
  createFakeEverythingQuery,
  isMigrationInProgress = () => false,
  rootDirectory
}) {
  let service = null

  function get() {
    if (isMigrationInProgress()) throw new Error('数据目录正在迁移，请稍候')
    if (service) return service
    const root = rootDirectory || __dirname
    const resourceRoot = app.isPackaged ? process.resourcesPath : root
    const sidecarPath = app.isPackaged
      ? path.join(resourceRoot, 'native', 'everything-search', 'HighlighterEverything.exe')
      : path.join(resourceRoot, 'native', 'everything-search', 'bin', 'HighlighterEverything.exe')
    const bundledEverythingPath = path.join(resourceRoot, 'native', 'everything', 'Everything.exe')
    const activePaths = getActivePaths()
    service = new EverythingService({
      sidecarPath,
      bundledEverythingPath,
      runtimeEverythingDir: path.join(
        activePaths?.runtime || path.join(app.getPath('userData'), 'runtime'),
        'everything'
      ),
      getUseBundledEverything: () => getSettings().search.useBundledEverything !== false,
      onStatusChange: (status) => {
        getSearchDomain()?.notifyStatusChanged(status)
      },
      ...(e2eContext.fakeEverything ? { e2eQuery: createFakeEverythingQuery() } : {}),
      log
    })
    return service
  }

  function stop() {
    if (!service) return
    try {
      service.stop()
    } finally {
      service = null
    }
  }

  return { get, stop, peek: () => service }
}

module.exports = { createEverythingServiceGetter }
