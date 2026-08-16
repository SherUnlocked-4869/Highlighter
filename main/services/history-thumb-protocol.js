const fs = require('fs')
const path = require('path')
const { Readable } = require('node:stream')

const THUMBNAIL_SCHEME = 'historythumb'
const THUMBNAIL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/

// Must run before app ready so the scheme gains streaming privileges.
function registerHistoryThumbScheme({ protocol }) {
  protocol.registerSchemesAsPrivileged([
    { scheme: THUMBNAIL_SCHEME, privileges: { stream: true } }
  ])
}

function thumbnailIdFromUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url || ''))
  } catch {
    return ''
  }
  let id = ''
  try {
    id = decodeURIComponent(parsed.hostname || parsed.pathname.replace(/^\/+/, ''))
  } catch {
    // URL parsing accepts malformed percent-encoding (e.g. `bad%`), which
    // makes decodeURIComponent throw — treat it as an invalid id.
    return ''
  }
  return THUMBNAIL_ID_PATTERN.test(id) ? id : ''
}

function canonicalizePath(directory) {
  try {
    return fs.realpathSync(directory)
  } catch {
    return path.resolve(directory)
  }
}

function createHistoryThumbHandler({ historyService, historyDirectories, log = () => {} }) {
  const allowedDirectories = () => new Set(
    historyDirectories().map((directory) => canonicalizePath(directory).toLowerCase())
  )
  return async (request) => {
    const id = thumbnailIdFromUrl(request.url)
    if (!id) return new Response('invalid thumbnail id', { status: 400 })
    try {
      const thumbnailPath = await historyService.ensureThumbnail(id)
      if (!thumbnailPath) return new Response('thumbnail not found', { status: 404 })
      const resolved = path.resolve(thumbnailPath)
      // Compare against the real (symlink-resolved) directory so a link placed
      // inside the history folder cannot point the stream at an external file.
      if (!allowedDirectories().has(canonicalizePath(path.dirname(resolved)).toLowerCase())) {
        return new Response('thumbnail outside history directory', { status: 403 })
      }
      const stream = fs.createReadStream(resolved)
      stream.on('error', (error) => {
        log('History thumbnail stream failed:', error?.message || String(error))
      })
      return new Response(Readable.toWeb(stream), {
        headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }
      })
    } catch (error) {
      log('History thumbnail request failed:', error?.message || String(error))
      return new Response('thumbnail unavailable', { status: 500 })
    }
  }
}

function registerHistoryThumbProtocol({ protocol, historyService, historyDirectories, log }) {
  protocol.handle(
    THUMBNAIL_SCHEME,
    createHistoryThumbHandler({ historyService, historyDirectories, log })
  )
}

module.exports = {
  THUMBNAIL_SCHEME,
  createHistoryThumbHandler,
  registerHistoryThumbProtocol,
  registerHistoryThumbScheme,
  thumbnailIdFromUrl
}
