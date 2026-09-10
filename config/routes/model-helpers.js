(function exposeModelHelpers(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.modelHelpers = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  function createModelProviderId() {
    if (globalThis.crypto?.randomUUID) return `provider-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    return `provider-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  function defaultModelsForProvider(provider) {
    const id = String(provider?.id || '').toLowerCase()
    const baseUrl = String(provider?.baseUrl || '').toLowerCase()
    if (id === 'deepseek' || baseUrl.includes('deepseek')) return [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
    if (id === 'openai' || baseUrl.includes('openai.com') || baseUrl.includes('api.openai')) {
      return [
        { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4.1', name: 'GPT-4.1' }
      ]
    }
    return []
  }

  function modelProviderStatus(provider) {
    if (provider.enabled === false) return { className: 'off', title: '已停用' }
    if (!provider.baseUrl || !provider.models?.length) return { className: 'off', title: '未完成配置' }
    if (!provider.apiKey && !provider.hasApiKey) return { className: 'warn', title: '未配置 API 密钥' }
    return { className: 'on', title: '已启用' }
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
    defaultModelsForProvider,
    modelProviderStatus,
    modelTaskForFeature,
    modelsForFeature
  }
})
