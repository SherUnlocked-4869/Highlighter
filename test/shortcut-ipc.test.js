const test = require('node:test')
const assert = require('node:assert/strict')
const { registerShortcutIpc } = require('../main/ipc/shortcut-ipc')

test('shortcut IPC exposes the current registration status', () => {
  const handlers = new Map()
  const statuses = {
    screenshot: { accelerator: 'F1', registered: false, reason: 'unavailable' }
  }
  registerShortcutIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler)
    },
    shortcutService: {
      getStatuses: () => statuses
    }
  })

  assert.deepEqual([...handlers.keys()], ['shortcuts:status'])
  assert.equal(handlers.get('shortcuts:status')(), statuses)
})
