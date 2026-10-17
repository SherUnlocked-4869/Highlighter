'use strict'
const path = require('node:path')
function createFileIconLookup({ app, log }) {
  const fileIconCache = new Map()
  const FILE_ICON_CACHE_LIMIT = 256
return async function getSearchFileIcon(samplePath) {
  const value = String(samplePath || '').trim()
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return null
  const extension = path.extname(value).toLowerCase()
  if (!extension) return null
  if (fileIconCache.has(extension)) return fileIconCache.get(extension)
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
  fileIconCache.set(extension, dataUrl)
  return dataUrl
}

}
module.exports = { createFileIconLookup }
