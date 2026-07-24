const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const helperPath = path.join(__dirname, '..', 'main', 'services', 'relaunch-application.js')

function loadRelaunchApplication() {
  assert.ok(fs.existsSync(helperPath), 'relaunch application helper must exist')
  return require(helperPath).relaunchApplication
}

function createApp() {
  const calls = []
  return {
    calls,
    relaunch(...args) {
      calls.push(args)
    }
  }
}

function withPortableExecutableFile(value, run) {
  const original = process.env.PORTABLE_EXECUTABLE_FILE
  try {
    process.env.PORTABLE_EXECUTABLE_FILE = value
    run()
  } finally {
    if (original === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE
    else process.env.PORTABLE_EXECUTABLE_FILE = original
  }
}

test('portable relaunch uses the original absolute wrapper path', () => {
  const relaunchApplication = loadRelaunchApplication()
  const app = createApp()
  const wrapperPath = path.join(path.parse(process.cwd()).root, 'Portable Apps', 'Highlighter.exe')

  withPortableExecutableFile(wrapperPath, () => {
    relaunchApplication({ app, dataRootContext: { portable: true } })
  })

  assert.deepEqual(app.calls, [[{ execPath: path.resolve(wrapperPath) }]])
})

test('portable relaunch rejects a relative wrapper path', () => {
  const relaunchApplication = loadRelaunchApplication()
  const app = createApp()

  withPortableExecutableFile('Highlighter.exe', () => {
    relaunchApplication({ app, dataRootContext: { portable: true } })
  })

  assert.deepEqual(app.calls, [[]])
})

test('portable relaunch rejects an empty wrapper path', () => {
  const relaunchApplication = loadRelaunchApplication()
  const app = createApp()

  withPortableExecutableFile('', () => {
    relaunchApplication({ app, dataRootContext: { portable: true } })
  })

  assert.deepEqual(app.calls, [[]])
})

test('non-portable relaunch preserves Electron default behavior', () => {
  const relaunchApplication = loadRelaunchApplication()
  const app = createApp()
  const wrapperPath = path.join(path.parse(process.cwd()).root, 'Portable Apps', 'Highlighter.exe')

  withPortableExecutableFile(wrapperPath, () => {
    relaunchApplication({ app, dataRootContext: { portable: false } })
  })

  assert.deepEqual(app.calls, [[]])
})
