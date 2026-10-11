(function exposeModelHelpers(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.modelHelpers = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  function createModelProviderId() {
    if (globalThis.crypto?.randomUUID) return `provider-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    return `provider-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  function modelProviderStatus(provider) {
    if (provider.enabled === false) return { className: 'off', title: 'config.models.status-disabled' }
    if (!provider.baseUrl || !provider.models?.length) return { className: 'off', title: 'config.models.status-incomplete' }
    if (!provider.apiKey && !provider.hasApiKey) return { className: 'warn', title: 'config.models.status-no-api-key' }
    return { className: 'on', title: 'config.models.status-enabled' }
  }

  function modelTaskForFeature(feature) {
    if (feature === 'translation' || feature === 'ocr-translate' || feature === 'toolbar:translate') return 'translation'
    if (feature === 'toolbar:explain' || String(feature || '').startsWith('custom:')) return 'explain'
    return 'chat'
  }

  function modelsForFeature(provider, feature) {
    const task = modelTaskForFeature(feature)
    return (provider?.models || []).filter((model) => {
      if (Array.isArray(model.capabilities?.tasks)) return model.capabilities.tasks.includes(task)
      if (/hunyuan-mt|hy-mt|qwen-mt|mt-7b/i.test(`${model.id || ''} ${model.name || ''}`)) return task === 'translation'
      return true
    })
  }

  return {
    createModelProviderId,
    modelProviderStatus,
    modelTaskForFeature,
    modelsForFeature
  }
})
