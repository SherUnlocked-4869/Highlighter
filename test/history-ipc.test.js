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

test('history IPC registers query, batch management, and file actions', async () => {
  const ipcMain = createIpcMain()
  const item = { id: '1', filePath: 'capture.png' }
  const historyService = {
    list: (filter) => [filter],
    listSources: () => ['capture'],
    stats: () => ({ totalCount: 1 }),
    delete: () => true,
    deleteMany: (ids) => ({ deletedCount: ids.length }),
    exportMany: (ids, directory) => ({ exportedCount: ids.length, directory }),
    cleanup: () => ({ removedEntries: 0 }),
    clear: () => true,
    setFavorite: (_id, favorite) => ({ ...item, favorite }),
    getItem: (id) => id === item.id ? item : null
  }
  registerHistoryIpc({
    ipcMain,
    historyService,
    copyItem: () => 'copied',
    editItem: () => 'edited',
    revealItem: () => 'revealed',
    chooseExportDirectory: async () => 'C:\\Exports'
  })
  assert.deepEqual([...ipcMain.handlers.keys()], [
    'history:list',
    'history:sources',
    'history:stats',
    'history:delete',
    'history:delete-many',
    'history:clear',
    'history:cleanup',
    'history:export',
    'history:favorite',
    'history:copy',
    'history:edit',
    'history:reveal'
  ])
  assert.deepEqual(ipcMain.handlers.get('history:list')(null, { query: 'test' }), [{ query: 'test' }])
  assert.equal(ipcMain.handlers.get('history:favorite')(null, { id: '1', favorite: true }).favorite, true)
  assert.equal(ipcMain.handlers.get('history:copy')(null, '1'), 'copied')
  assert.equal(ipcMain.handlers.get('history:copy')(null, 'missing'), false)
  assert.equal(ipcMain.handlers.get('history:delete-many')(null, ['1']).deletedCount, 1)
  assert.equal((await ipcMain.handlers.get('history:export')(null, ['1'])).directory, 'C:\\Exports')
})
