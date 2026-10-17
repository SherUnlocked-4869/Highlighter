'use strict'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('INVALID_ARGUMENT')
  return value
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_ID'); return value }
function registerClipboardIpc({ ipcMain, service, domain, setPaused }) {
  const handle = (name, fn) => ipcMain.handle(`clipboard:${name}`, async (event, args) => {
    try { return { ok: true, result: await fn(event, args) } }
    catch (error) { return { ok: false, error: { code: /^[A-Z_]{1,64}$/.test(error.code || error.message || '') ? error.code || error.message : 'CLIPBOARD_FAILED' } } }
  })
  handle('status', () => service.snapshot())
  handle('list', async (_event, args) => {
    object(args, ['search', 'kind', 'pinnedOnly', 'cursor', 'limit'])
    if (typeof args.search !== 'string' || [...args.search].length > 200 || !['', 'text', 'url', 'image'].includes(args.kind) || typeof args.pinnedOnly !== 'boolean' || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) || JSON.stringify(args.cursor || null).length > 2048) throw new Error('INVALID_FILTER')
    return service.command('list', args)
  })
  handle('detail', (_event, args) => { object(args, ['id']); return service.command('detail', { id: id(args.id) }) })
  handle('preview', (event, args) => { object(args, ['id']); return domain.preview(event, id(args.id)) })
  handle('copy', (_event, args) => { object(args, ['id', 'operationId']); return service.command('copy', { id: id(args.id), operationId: id(args.operationId) }) })
  handle('paste', (event, args) => { object(args, ['id', 'operationId']); return domain.paste(event, id(args.id), id(args.operationId)) })
  handle('set-pinned', (_event, args) => {
    object(args, ['id', 'pinned', 'operationId'])
    if (typeof args.pinned !== 'boolean') throw new Error('INVALID_ARGUMENT')
    return service.command('set-pinned', { id: id(args.id), pinned: args.pinned, operationId: id(args.operationId) })
  })
  handle('delete', (_event, args) => {
    object(args, ['ids', 'operationId'])
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 100) throw new Error('INVALID_IDS')
    domain.revokePreviews()
    return service.command('delete', { ids: args.ids.map(id), operationId: id(args.operationId) })
  })
  handle('prepare-clear', (event, args) => { object(args, ['scope']); return domain.prepareClear(event, args.scope) })
  handle('commit-clear', (event, args) => { object(args, ['token', 'operationId']); domain.revokePreviews(); return domain.commitClear(event, id(args.token), id(args.operationId)) })
  handle('set-paused', (_event, args) => { object(args, ['paused']); if (typeof args.paused !== 'boolean') throw new Error('INVALID_ARGUMENT'); return setPaused(args.paused) })
  ipcMain.on('clipboard:ready', (event) => domain.ready(event))
  ipcMain.on('clipboard:interactive', (event, generation) => domain.interactive(event, generation))
  ipcMain.on('clipboard:close', () => domain.hide())
}
module.exports = { registerClipboardIpc }
