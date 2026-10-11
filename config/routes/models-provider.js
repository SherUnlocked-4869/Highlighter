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
    const provider = { id: createModelProviderId(), name: t('config.models.new-provider'), baseUrl: '', hasApiKey: false, protocol: 'openai-chat', enabled: true, builtin: false, models: [{ id: '', name: '' }] }
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
    toast(t('config.models.config-file-opened'))
  })
  document.querySelectorAll('[data-delete-provider]').forEach((button) => {
    button.onclick = () => {
      const providerId = button.dataset.deleteProvider
      const provider = modelProviderById(providerId)
      if (!provider) return
      if (settings.providers.length <= 1) { toast(t('config.models.keep-one-provider')); return }
      if (!commitOpenProviderEditors({ exceptId: providerId })) return
      if (!confirm(t('config.models.confirm-delete-provider', { name: provider.name }))) return
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
      toast(t('config.models.provider-deleted'))
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
      button.disabled = true; button.textContent = t('config.models.testing')
      try {
        const result = await window.electronAPI.testConnection(provider)
        if (result === true) { toast(t('config.models.connected')); return }
        if (!result?.ok) { toast(t('config.models.connect-failed')); return }
        const corrections = []
        const protocolSelect = root.querySelector('[data-provider-protocol]')
        const baseUrlInput = root.querySelector('[data-provider-base-url]')
        if (protocolSelect && result.protocol && result.protocol !== provider.protocol) {
          protocolSelect.value = result.protocol
          corrections.push(t('config.models.protocol-switched', { protocol: result.protocol }))
        }
        if (baseUrlInput && result.baseUrl && String(result.baseUrl).replace(/\/+$/, '') !== String(provider.baseUrl).replace(/\/+$/, '')) {
          baseUrlInput.value = result.baseUrl
          corrections.push(t('config.models.base-url-corrected', { url: result.baseUrl }))
        }
        if (Array.isArray(result.models) && result.models.length && !(provider.models || []).some((model) => model.id)) {
          const draft = readProviderEditorDraft(providerId)
          if (draft) {
            draft.protocol = protocolSelect?.value || draft.protocol
            draft.baseUrl = baseUrlInput?.value.trim() || draft.baseUrl
            Object.assign(draft, applyFetchedModels(base, result.models))
            settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? draft : item) }
            renderModels()
            toast(t('config.models.connected-with-models', { count: result.models.length }))
            return
          }
        }
        toast(corrections.length ? t('config.models.connected-with-corrections', { details: corrections.join(t('config.common.clause-separator')) }) : t('config.models.connected'))
      } catch (error) { toast(errorMessage(error) || t('config.models.connect-failed')) } finally {
        button.disabled = false; button.textContent = t('config.models.test')
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
      toast(t('config.models.models-restored'))
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
      button.disabled = true; button.textContent = t('config.models.fetching')
      try {
        const result = await window.electronAPI.fetchProviderModels(provider)
        if (!result?.ok) throw new Error(t('config.models.fetch-failed'))
        if (result.protocol) root.querySelector('[data-provider-protocol]').value = result.protocol
        if (result.baseUrl) root.querySelector('[data-provider-base-url]').value = result.baseUrl
        if (!commitOpenProviderEditors({ tolerant: true })) {
          button.disabled = false; button.textContent = t('config.models.fetch-models')
          return
        }
        const fetched = (Array.isArray(result.models) ? result.models : []).filter((model) => String(model?.id || '').trim())
        if (!fetched.length) {
          toast(t('config.models.no-models-fetched'))
          button.disabled = false; button.textContent = t('config.models.fetch-models')
          return
        }
        settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? { ...item, ...applyFetchedModels(base, fetched) } : item) }
        renderModels()
        toast(t('config.models.models-fetched', { count: fetched.length }))
      } catch (error) {
        toast(errorMessage(error) || t('config.models.fetch-models-failed'))
        button.disabled = false; button.textContent = t('config.models.fetch-models')
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
      const modelId = row?.querySelector('[data-model-id]')?.value.trim() || provider.models?.[index]?.id || t('config.models.not-filled')
      const modelName = row?.querySelector('[data-model-name]')?.value.trim() || provider.models?.[index]?.name || '—'
      panel.innerHTML = `<div class="model-detail-grid"><span>${t('config.models.model-id')}</span><b>${escapeHtml(modelId)}</b><span>${t('config.models.display-name')}</span><b>${escapeHtml(modelName)}</b><span>${t('config.models.owning-provider')}</span><b>${escapeHtml(provider.name)}</b><span>${t('config.models.api-protocol')}</span><b>${escapeHtml(provider.protocol || 'openai-chat')}</b><span>${t('config.models.api-url')}</span><b>${escapeHtml(provider.baseUrl || t('config.models.not-filled'))}</b></div>`
      const willOpen = panel.hidden
      panel.hidden = !panel.hidden
      button.classList.toggle('open', willOpen)
      button.title = willOpen ? t('config.models.collapse-model-details') : t('config.models.expand-model-details')
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
      if (provider.models.length <= 1) { toast(t('config.models.keep-one-model')); return }
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
      }, t('config.models.providers-saved'))
      renderModels()
    } catch (error) {
      toast(error.message || t('config.models.providers-save-failed'))
    }
  })
}
