const fs = require('node:fs')
const path = require('node:path')

function configureE2eEnvironment({ app, env = process.env, fileSystem = fs } = {}) {
  if (!app || app.isPackaged || env.HIGHLIGHTER_E2E !== '1') return { enabled: false }
  const requestedRoot = String(env.HIGHLIGHTER_E2E_DATA_ROOT || '')
  if (!path.isAbsolute(requestedRoot)) throw new Error('E2E data root must be an absolute path')
  const dataRoot = path.resolve(requestedRoot)
  const sessionData = path.join(dataRoot, 'electron-cache')
  fileSystem.mkdirSync(dataRoot, { recursive: true })
  fileSystem.mkdirSync(sessionData, { recursive: true })
  app.setPath('userData', dataRoot)
  app.setPath('sessionData', sessionData)
  app.disableHardwareAcceleration?.()
  return { enabled: true, dataRoot, sessionData }
}

module.exports = { configureE2eEnvironment }
