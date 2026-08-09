const test = require('node:test')
const assert = require('node:assert/strict')
const { registerUpdateIpc } = require('../main/ipc/update-ipc')

test('update IPC exposes only fixed update operations and forces manual checks', async () => {
  const handlers = new Map()
  const calls = []
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  const updateService = {
    getStatus: () => ({ status: 'idle' }),
    check: (options) => { calls.push(['check', options]); return { status: 'checking' } },
    download: () => { calls.push(['download']); return { status: 'downloading' } },
    install: () => { calls.push(['install']); return { status: 'installing' } },
    openDownloadPage: () => { calls.push(['open']); return { status: 'idle' } }
  }
  registerUpdateIpc({ ipcMain, updateService })

  assert.deepEqual([...handlers.keys()], [
    'update:status',
    'update:check',
    'update:download',
    'update:install',
    'update:open-download-page'
  ])
  assert.deepEqual(await handlers.get('update:status')(), { status: 'idle' })
  await handlers.get('update:check')({}, { manual: false })
  await handlers.get('update:download')()
  await handlers.get('update:install')()
  await handlers.get('update:open-download-page')()
  assert.deepEqual(calls, [
    ['check', { manual: true }],
    ['download'],
    ['install'],
    ['open']
  ])
})
