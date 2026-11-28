'use strict'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('INVALID_ARGUMENT')
  return value
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_ID'); return value }
// Batch counterpart of id(): 1..64 entries, each a UUID, validated before any of
// them reaches the native side. Deduplication happens in the domain, which owns
// the result ordering contract.
function ids(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('INVALID_IDS')
  return value.map(id)
}
function registerClipboardIpc({ ipcMain, service, domain, setPaused }) {
  const handle = (name, fn) => ipcMain.handle(`clipboard:${name}`, async (event, args) => {
    try { return { ok: true, result: await fn(event, args) } }
    catch (error) { return { ok: false, error: { code: /^[A-Z_]{1,64}$/.test(error.code || error.message || '') ? error.code || error.message : 'CLIPBOARD_FAILED' } } }
  })
  // B05: the renderer receives the status plus the derived capacity view. The
  // native status protocol is unchanged; the view is pure arithmetic over the
  // fields the sidecar already reports.
  handle('status', (event) => {
    if (domain.statusSnapshotFor) return domain.statusSnapshotFor(event)
    return domain.statusSnapshot ? domain.statusSnapshot() : service.snapshot()
  })
  handle('list', async (_event, args) => {
    object(args, ['search', 'kind', 'pinnedOnly', 'cursor', 'limit'])
    if (typeof args.search !== 'string' || [...args.search].length > 200 || !['', 'text', 'url', 'image', 'files'].includes(args.kind) || typeof args.pinnedOnly !== 'boolean' || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) || JSON.stringify(args.cursor || null).length > 2048) throw new Error('INVALID_FILTER')
    return service.command('list', args)
  })
  handle('detail', (_event, args) => { object(args, ['id']); return service.command('detail', { id: id(args.id) }) })
  handle('previews', (event, args) => { object(args, ['ids']); return domain.previews(event, ids(args.ids)) })
  // N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.2):
  // one-click image actions. `id` is the only payload - the main process reads the
  // pixels from its own store and owns the save dialog, so the page cannot submit or
  // learn a path, a URL or a byte buffer.
  handle('image-ocr', (event, args) => { object(args, ['id']); return domain.imageOcr(event, id(args.id)) })
  handle('image-table', (event, args) => { object(args, ['id']); return domain.imageTable(event, id(args.id)) })
  handle('image-pin', (event, args) => { object(args, ['id']); return domain.imagePin(event, id(args.id)) })
  // The OCR result sheet's copy button. A text payload capped at the clipboard
  // store's own text ceiling keeps this from becoming a generic large-write channel;
  // the main process owns the system clipboard, so the sandboxed page needs no
  // clipboard permission of its own.
  handle('copy-text', (event, args) => {
    object(args, ['text'])
    if (typeof args.text !== 'string' || Buffer.byteLength(args.text, 'utf8') > 1024 * 1024) throw new Error('INVALID_TEXT')
    return domain.copyText(event, args.text)
  })
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
