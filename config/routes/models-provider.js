// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models：供应商面板的事件绑定。

function bindModelsProviderTab() {
  document.querySelectorAll('[data-expand-provider]').forEach((head) => {
    head.onclick = () => {
      const providerId = head.dataset.expandProvider
      if (!commitOpenProviderEditors({ tolerant: true })) return
      if (modelsExpandedProviderIds.has(providerId)) modelsExpandedProviderIds.delete(providerId)
      else modelsExpandedProviderIds.add(providerId)
      renderModels()
    }
    head.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); head.click() }
    }
  })
  document.getElementById('addModelProvider')?.addEventListener('click', () => {
    if (!commitOpenProviderEditors()) return
    const provider = { id: createModelProviderId(), name: '新供应商', baseUrl: '', hasApiKey: false, protocol: 'openai-chat', enabled: true, builtin: false, models: [{ id: '', name: '' }] }
    settings = { ...settings, providers: [...settings.providers, provider] }
    modelsExpandedProviderIds = new Set([provider.id])
    renderModels()
    providerEditorRoot(provider.id)?.querySelector('[data-provider-name]')?.focus()
  })
  document.getElementById('addCodingPlanProvider')?.addEventListener('click', () => {
    if (!commitOpenProviderEditors()) return
    openCodingPlanDialog()
  })
  document.getElementById('openModelConfigFile')?.addEventListener('click', () => {
    window.electronAPI.openDataDirectory().catch(() => {})
    toast('已打开数据目录，配置文件位于该目录下')
  })
  document.querySelectorAll('[data-delete-provider]').forEach((button) => {
    button.onclick = () => {
      const providerId = button.dataset.deleteProvider
      const provider = modelProviderById(providerId)
      if (!provider) return
      if (settings.providers.length <= 1) { toast('至少保留一个供应商'); return }
      if (!commitOpenProviderEditors({ exceptId: providerId })) return
      if (!confirm(`确定删除供应商“${provider.name}”？`)) return
      const remaining = settings.providers.filter((item) => item.id !== providerId)
      const assignments = (settings.ai?.assignments || []).map((assignment) => {
        if (assignment.providerId !== providerId) return assignment
        const fallback = remaining.find((item) => modelsForFeature(item, assignment.feature).length)
        const model = modelsForFeature(fallback, assignment.feature)[0]
        return fallback && model ? { ...assignment, providerId: fallback.id, model: model.id } : null
      }).filter(Boolean)
      settings = { ...settings, providers: remaining, ai: { ...settings.ai, assignments } }
      featureAssignmentDraft = null
      modelsExpandedProviderIds.delete(providerId)
      renderModels()
      toast('供应商已删除，请保存以生效')
    }
  })
  document.querySelectorAll('[data-test-provider]').forEach((button) => {
    button.onclick = async () => {
      const providerId = button.dataset.testProvider
      const root = providerEditorRoot(providerId)
      const base = modelProviderById(providerId)
      if (!root || !base) return
      const provider = {
        ...providerDraftWithSecret(base, root),
        baseUrl: root.querySelector('[data-provider-base-url]')?.value.trim() || base.baseUrl,
        protocol: root.querySelector('[data-provider-protocol]')?.value || base.protocol
      }
      button.disabled = true; button.textContent = '测试中'
      try {
        const result = await window.electronAPI.testConnection(provider)
        if (result === true) { toast('连接成功'); return }
        if (!result?.ok) { toast('连接失败'); return }
        const corrections = []
        const protocolSelect = root.querySelector('[data-provider-protocol]')
        const baseUrlInput = root.querySelector('[data-provider-base-url]')
        if (protocolSelect && result.protocol && result.protocol !== provider.protocol) {
          protocolSelect.value = result.protocol
          corrections.push(`协议已切换为 ${result.protocol}`)
        }
        if (baseUrlInput && result.baseUrl && String(result.baseUrl).replace(/\/+$/, '') !== String(provider.baseUrl).replace(/\/+$/, '')) {
          baseUrlInput.value = result.baseUrl
          corrections.push(`API 地址已修正为 ${result.baseUrl}`)
        }
        if (Array.isArray(result.models) && result.models.length && !(provider.models || []).some((model) => model.id)) {
          const draft = readProviderEditorDraft(providerId)
          if (draft) {
            draft.protocol = protocolSelect?.value || draft.protocol
            draft.baseUrl = baseUrlInput?.value.trim() || draft.baseUrl
            Object.assign(draft, applyFetchedModels(base, result.models))
            settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? draft : item) }
            renderModels()
            toast(`连接成功，已自动获取 ${result.models.length} 个模型`)
            return
          }
        }
        toast(corrections.length ? `连接成功：${corrections.join('，')}` : '连接成功')
      } catch (error) { toast(errorMessage(error) || '连接失败') } finally {
        button.disabled = false; button.textContent = '测试'
      }
    }
  })
  document.querySelectorAll('[data-restore-models]').forEach((button) => {
    button.onclick = async () => {
      const providerId = button.dataset.restoreModels
      if (!commitOpenProviderEditors({ tolerant: true })) return
      const provider = modelProviderById(providerId)
      if (!provider) return
      const defaults = defaultModelsForProvider(provider)
      if (!defaults.length) {
        providerEditorRoot(providerId)?.querySelector('[data-fetch-models]')?.click()
        return
      }
      settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? { ...item, models: defaults } : item) }
      renderModels()
      toast('已恢复默认模型目录')
    }
  })
  document.querySelectorAll('[data-fetch-models]').forEach((button) => {
    button.onclick = async () => {
      const providerId = button.dataset.fetchModels
      const root = providerEditorRoot(providerId)
      const base = modelProviderById(providerId)
      if (!root || !base) return
      const provider = {
        ...providerDraftWithSecret(base, root),
        baseUrl: root.querySelector('[data-provider-base-url]')?.value.trim() || base.baseUrl,
        protocol: root.querySelector('[data-provider-protocol]')?.value || base.protocol
      }
      button.disabled = true; button.textContent = '获取中'
      try {
        const result = await window.electronAPI.fetchProviderModels(provider)
        if (!result?.ok) throw new Error('获取失败')
        if (result.protocol) root.querySelector('[data-provider-protocol]').value = result.protocol
        if (result.baseUrl) root.querySelector('[data-provider-base-url]').value = result.baseUrl
        if (!commitOpenProviderEditors({ tolerant: true })) {
          button.disabled = false; button.textContent = '获取可用模型'
          return
        }
        const fetched = (Array.isArray(result.models) ? result.models : []).filter((model) => String(model?.id || '').trim())
        if (!fetched.length) {
          toast('未获取到模型，已保留当前模型目录')
          button.disabled = false; button.textContent = '获取可用模型'
          return
        }
        settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? { ...item, ...applyFetchedModels(base, fetched) } : item) }
        renderModels()
        toast(`已获取 ${fetched.length} 个模型`)
      } catch (error) {
        toast(errorMessage(error) || '获取可用模型失败')
        button.disabled = false; button.textContent = '获取可用模型'
      }
    }
  })
  document.querySelectorAll('[data-add-provider-model]').forEach((button) => {
    button.onclick = () => {
      const providerId = button.dataset.addProviderModel
      if (!commitOpenProviderEditors({ tolerant: true })) return
      const provider = modelProviderById(providerId)
      if (!provider) return
      settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? { ...item, models: [...item.models, { id: '', name: '' }] } : item) }
      renderModels()
      providerEditorRoot(providerId)?.querySelector('.model-catalog-row:last-child [data-model-id]')?.focus()
    }
  })
  document.querySelectorAll('[data-model-details]').forEach((button) => {
    button.onclick = () => {
      const providerId = button.dataset.modelDetails
      const index = Number(button.dataset.modelIndex)
      const provider = modelProviderById(providerId)
      const item = button.closest('.model-catalog-item')
      const panel = item?.querySelector('[data-model-detail-panel]')
      if (!item || !panel || !provider) return
      const row = item.querySelector('.model-catalog-row')
      const modelId = row?.querySelector('[data-model-id]')?.value.trim() || provider.models?.[index]?.id || '未填写'
      const modelName = row?.querySelector('[data-model-name]')?.value.trim() || provider.models?.[index]?.name || '—'
      panel.innerHTML = `<div class="model-detail-grid"><span>模型 ID</span><b>${escapeHtml(modelId)}</b><span>显示名称</span><b>${escapeHtml(modelName)}</b><span>所属供应商</span><b>${escapeHtml(provider.name)}</b><span>API 协议</span><b>${escapeHtml(provider.protocol || 'openai-chat')}</b><span>API 地址</span><b>${escapeHtml(provider.baseUrl || '未填写')}</b></div>`
      const willOpen = panel.hidden
      panel.hidden = !panel.hidden
      button.classList.toggle('open', willOpen)
      button.title = willOpen ? '收起模型详情' : '展开模型详情'
      button.setAttribute('aria-label', button.title)
    }
  })
  document.querySelectorAll('[data-remove-model]').forEach((button) => {
    button.onclick = () => {
      const providerId = button.dataset.removeModel
      const index = Number(button.dataset.modelIndex)
      if (!commitOpenProviderEditors({ tolerant: true })) return
      const provider = modelProviderById(providerId)
      if (!provider) return
      if (provider.models.length <= 1) { toast('每个供应商至少保留一个模型'); return }
      const models = provider.models.filter((_model, itemIndex) => itemIndex !== index)
      settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? { ...item, models } : item) }
      renderModels()
    }
  })
  document.getElementById('saveProviderSettings')?.addEventListener('click', async () => {
    if (!commitOpenProviderEditors()) return
    try {
      settings = await updateSettings({
        providers: settings.providers,
        ai: { schemaVersion: 2, assignments: settings.ai?.assignments || [] }
      }, '供应商配置已保存')
      renderModels()
    } catch (error) {
      toast(error.message || '供应商配置保存失败')
    }
  })
}
