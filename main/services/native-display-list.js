const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HELPER_FILES = ['screenCapture_1.3.2.bat', 'app.manifest']

function prepareCaptureHelper() {
  const sourceDirectory = path.dirname(require.resolve('screenshot-desktop/lib/win32/index.js'))
  const tempDirectory = path.join(os.tmpdir(), 'screenCapture')
  fs.mkdirSync(tempDirectory, { recursive: true })

  for (const fileName of HELPER_FILES) {
    const target = path.join(tempDirectory, fileName)
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(sourceDirectory, fileName), target)
  }

  return {
    directory: tempDirectory,
    batchFile: path.join(tempDirectory, HELPER_FILES[0])
  }
}

function listNativeDisplays(parseDisplaysOutput) {
  if (typeof parseDisplaysOutput !== 'function') {
    return Promise.reject(new Error('无法解析 Windows 显示器列表'))
  }

  let helper
  try {
    helper = prepareCaptureHelper()
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    execFile(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', helper.batchFile, '/list'],
      { cwd: helper.directory, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        try {
          resolve(parseDisplaysOutput(String(stdout || '')))
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

module.exports = { listNativeDisplays }
