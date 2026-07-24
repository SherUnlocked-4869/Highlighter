const path = require('node:path')

function relaunchApplication({ app, dataRootContext }) {
  const portableExecutableFile = process.env.PORTABLE_EXECUTABLE_FILE
  if (dataRootContext.portable && typeof portableExecutableFile === 'string' && path.isAbsolute(portableExecutableFile)) {
    app.relaunch({ execPath: path.resolve(portableExecutableFile) })
    return
  }

  app.relaunch()
}

module.exports = { relaunchApplication }
