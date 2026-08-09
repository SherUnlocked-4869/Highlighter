const { contextBridge, ipcRenderer } = require('electron')

const MAX_TEXT_LENGTH = 1024 * 1024

function boundedText(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function subscribe(channel, callback, mapPayload = (value) => value) {
  if (typeof callback !== 'function') throw new TypeError('IPC subscription requires a callback')
  const handler = (_event, payload) => callback(mapPayload(payload))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

function normalizeAppearance(value = {}) {
  return {
    theme: ['light', 'dark', 'system'].includes(value?.theme) ? value.theme : 'system',
    mainColor: /^#[0-9a-f]{6}$/i.test(value?.mainColor || '') ? value.mainColor : '#1677ff'
  }
}

function normalizeActionStart(value = {}) {
  return {
    type: boundedText(value?.type, 64),
    label: boundedText(value?.label, 128),
    icon: boundedText(value?.icon, 16),
    text: boundedText(value?.text),
    streamId: Number.isSafeInteger(value?.streamId) && value.streamId > 0 ? value.streamId : null,
    appearance: normalizeAppearance(value?.appearance)
  }
}

function sendStreamSignal(channel, streamId) {
  if (!Number.isSafeInteger(streamId) || streamId <= 0) return false
  ipcRenderer.send(channel, streamId)
  return true
}

function normalizeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

contextBridge.exposeInMainWorld('actionAPI', {
  onActionStart: (callback) => subscribe('action:start', callback, normalizeActionStart),
  onActionAppearance: (callback) => subscribe('action:appearance', callback, normalizeAppearance),
  onStreamData: (callback) => subscribe('stream:data', callback, (data) => ({ content: boundedText(data?.content) })),
  onStreamReasoning: (callback) => subscribe('stream:reasoning', callback, (data) => ({ content: boundedText(data?.content) })),
  onStreamDone: (callback) => subscribe('stream:done', callback, () => undefined),
  onStreamError: (callback) => subscribe('stream:error', callback, (data) => ({ error: boundedText(data?.error, 4096) })),
  cancelStream: (streamId) => sendStreamSignal('stream:cancel', streamId),
  finishStream: (streamId) => sendStreamSignal('stream:finish', streamId),
  togglePin: (pinned) => ipcRenderer.send('window:toggle-pin', pinned === true),
  onPinDenied: (callback) => subscribe('window:pin-denied', callback, (data) => ({
    max: Number.isSafeInteger(data?.max) && data.max > 0 ? data.max : 1
  })),
  openExternal: (value) => {
    const url = normalizeExternalUrl(value)
    if (!url) throw new TypeError('Only HTTP and HTTPS links can be opened')
    return ipcRenderer.invoke('shell:open-external', url)
  }
})
