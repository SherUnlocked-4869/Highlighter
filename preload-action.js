const { contextBridge, ipcRenderer } = require('electron')

const MAX_TEXT_LENGTH = 1024 * 1024
const MAX_QUESTION_LENGTH = 2000
const MAX_COPY_LENGTH = 65536

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
    mainColor: /^#[0-9a-f]{6}$/i.test(value?.mainColor || '') ? value.mainColor : '#e5a44c'
  }
}

function normalizeFollowUp(value = {}) {
  return {
    enabled: value?.enabled === true,
    disabledReason: boundedText(value?.disabledReason, 256),
    maxTurns: Number.isSafeInteger(value?.maxTurns) && value.maxTurns > 0 ? value.maxTurns : 10,
    questionMaxLength: Number.isSafeInteger(value?.questionMaxLength) && value.questionMaxLength > 0
      ? value.questionMaxLength
      : MAX_QUESTION_LENGTH
  }
}

function normalizeActionStart(value = {}) {
  return {
    type: boundedText(value?.type, 64),
    label: boundedText(value?.label, 128),
    icon: boundedText(value?.icon, 16),
    text: boundedText(value?.text),
    streamId: Number.isSafeInteger(value?.streamId) && value.streamId > 0 ? value.streamId : null,
    appearance: normalizeAppearance(value?.appearance),
    followUp: normalizeFollowUp(value?.followUp)
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
  onStreamError: (callback) => subscribe('stream:error', callback, (data) => ({
    error: boundedText(data?.error, 4096),
    cancelled: data?.cancelled === true,
    rejected: data?.rejected === true,
    interrupted: data?.interrupted === true
  })),
  onChatTurn: (callback) => subscribe('chat:turn', callback, (data) => ({
    streamId: Number.isSafeInteger(data?.streamId) ? data.streamId : null,
    question: boundedText(data?.question, MAX_QUESTION_LENGTH),
    omittedPairs: Number.isSafeInteger(data?.omittedPairs) && data.omittedPairs > 0 ? data.omittedPairs : 0
  })),
  cancelStream: (streamId) => sendStreamSignal('stream:cancel', streamId),
  finishStream: (streamId) => sendStreamSignal('stream:finish', streamId),
  askQuestion: (streamId, question, replaceLast = false) => {
    if (!Number.isSafeInteger(streamId) || streamId <= 0) return false
    if (typeof question !== 'string') return false
    const value = question.trim().slice(0, MAX_QUESTION_LENGTH)
    if (!value) return false
    ipcRenderer.send('chat:ask', { streamId, question: value, replaceLast: replaceLast === true })
    return true
  },
  copyConversation: (text) => {
    if (typeof text !== 'string') return Promise.resolve(false)
    const value = text.slice(0, MAX_COPY_LENGTH)
    if (!value) return Promise.resolve(false)
    return ipcRenderer.invoke('chat:copy', value)
  },
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
