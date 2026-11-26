'use strict'
const path = require('node:path')

// U04 (review report section 4.4 item 7): .exe/.lnk/.ico carry a per-file icon, so
// caching them by extension paints every executable/shortcut with the first
// path's icon. Keep the cheap one-icon-per-extension cache for document types and
// key the path-sized icon set by the full (case-insensitive) path.
const PATH_KEYED_EXTENSIONS = new Set(['.exe', '.lnk', '.ico'])

function iconCacheKey(filePath, extension) {
  return PATH_KEYED_EXTENSIONS.has(extension) ? `path:${filePath.toLowerCase()}` : `ext:${extension}`
}

function createFileIconLookup({ app, log }) {
  const fileIconCache = new Map()
  const FILE_ICON_CACHE_LIMIT = 256
return async function getSearchFileIcon(samplePath) {
  const value = String(samplePath || '').trim()
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return null
  const extension = path.extname(value).toLowerCase()
  if (!extension) return null
  const cacheKey = iconCacheKey(value, extension)
  if (fileIconCache.has(cacheKey)) return fileIconCache.get(cacheKey)
  let dataUrl = null
  try {
    const icon = await app.getFileIcon(value, { size: 'small' })
    if (icon && !icon.isEmpty()) dataUrl = icon.toDataURL()
  } catch (error) {
    log('File icon lookup failed:', error.message)
  }
  if (fileIconCache.size >= FILE_ICON_CACHE_LIMIT) {
    fileIconCache.delete(fileIconCache.keys().next().value)
  }
  fileIconCache.set(cacheKey, dataUrl)
  return dataUrl
}

}

module.exports = { createFileIconLookup }
