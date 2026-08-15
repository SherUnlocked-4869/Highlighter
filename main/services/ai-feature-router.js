const { resolveToolbarAiProvider } = require('./ai-providers')

async function createToolbarActionStream({
  settings,
  action,
  text,
  requestOptions = {},
  clients = require('../../deepseek')
}) {
  const actionId = String(action?.id || '')
  const provider = resolveToolbarAiProvider(settings, actionId)
  if (!provider) throw new Error(`划词${action?.label || '功能'}未配置可用的模型供应商`)
  if (actionId === 'translate') {
    return clients.createTranslateStream(provider, text, action.prompt, requestOptions)
  }
  if (actionId === 'explain') {
    return clients.createExplainStream(provider, text, action.prompt, requestOptions)
  }
  return clients.createCustomStream(provider, text, action.prompt, requestOptions)
}

module.exports = {
  createToolbarActionStream
}
