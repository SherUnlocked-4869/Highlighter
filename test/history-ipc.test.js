const test = require('node:test')
const assert = require('node:assert/strict')
const { registerHistoryIpc } = require('../main/ipc/history-ipc')

function createIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle: (channel, handler) => handlers.set(channel, handler)
  }
}

test('history IPC registers query, favorite, and file actions', () => {
  const ipcMain = createIpcMain()
  const item = { id: '1', filePath: 'capture.png' }
  const historyService = {
    list: (filter) => [filter],
    listSources: () => ['capture'],
    delete: () => true,
    clear: () => true,
    setFavorite: (_id, favorite) => ({ ...item, favorite }),
    getItem: (id) => id === item.id ? item : null
  }
  registerHistoryIpc({
    ipcMain,
    historyService,
    copyItem: () => 'copied',
    editItem: () => 'edited',
    revealItem: () => 'revealed'
  })
  assert.deepEqual([...ipcMain.handlers.keys()], [
    'history:list',
    'history:sources',
    'history:delete',
    'history:clear',
    'history:favorite',
    'history:copy',
    'history:edit',
    'history:reveal'
  ])
  assert.deepEqual(ipcMain.handlers.get('history:list')(null, { query: 'test' }), [{ query: 'test' }])
  assert.equal(ipcMain.handlers.get('history:favorite')(null, { id: '1', favorite: true }).favorite, true)
  assert.equal(ipcMain.handlers.get('history:copy')(null, '1'), 'copied')
  assert.equal(ipcMain.handlers.get('history:copy')(null, 'missing'), false)
})
