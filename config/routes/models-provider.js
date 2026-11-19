// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models：供应商面板的事件绑定。

const MAX_CATALOG_MODELS = 100

function openProviderPresetDialog() {
  if (!commitOpenProviderEditors({ tolerant: true })) return
  const { presets } = window.providerConnection
  const choices = [...presets, { name: t('config.models.custom'), baseUrl: '' }]
  const modal = openModal(`<div class="modal-head"><div><h3 id="providerDialogTitle">${t('config.models.add-provider')}</h3></div><button type="button" class="button icon-button" commandfor="config-native-modal" command="close" aria-label="${t('config.models.close-modal')}">×</button></div>
    <div class="provider-preset-grid">${choices.map((choice, index) => `<button class="button provider-preset-choice" data-provider-preset="${index}"><b>${escapeHtml(choice.name)}</b><small>${escapeHtml(choice.baseUrl || t('config.models.custom-connection'))}</small></button>`).join('')}</div>`, { labelledBy: 'providerDialogTitle' })
  modal.querySelectorAll('[data-provider-preset]').forEach((button) => {
    button.onclick = () => {
      const choice = choices[Number(button.dataset.providerPreset)]
      const provider = {
        id: createModelProviderId(),
        name: choice.baseUrl ? choice.name : t('config.models.new-provider'),
        baseUrl: choice.baseUrl,
        hasApiKey: false,
        protocol: choice.protocol || 'openai-chat',
        enabled: true,
        builtin: false,
        models: []
      }
      settings = { ...settings, providers: [...(settings.providers || []), provider] }
      modelsExpandedProviderIds = new Set([provider.id])
      modelsTab = 'providers'
      window.setConfigDirty?.('models-provider-settings', true)
      closeModal()
      renderModels()
      const field = choice.baseUrl && !window.providerConnection.isLoopbackProviderUrl(choice.baseUrl)
        ? '[data-provider-api-key]' : '[data-provider-base-url]'
      providerEditorRoot(provider.id)?.querySelector(field)?.focus()
    }
  })
}

function syncProviderTestModels(root) {
  const select = root.querySelector('[data-provider-test-model]')
  if (!select) return
  const previous = select.value
  const ids = new Set()
  const options = []
  for (const row of root.querySelectorAll('.model-catalog-row')) {
    const id = row.querySelector('[data-model-id]').value.trim()
    if (!id || ids.has(id)) continue
    ids.add(id)
    const name = row.querySelector('[data-model-name]').value.trim()
    options.push(new Option(name && name !== id ? `${name} · ${id}` : id, id))
  }
  select.replaceChildren(...(options.length ? options : [new Option(t('config.models.test-model-empty'), '')]))
  if (ids.has(previous)) select.value = previous
  select.disabled = !options.length
  root.querySelector('[data-test-provider]').disabled = !options.length || root.hasAttribute('data-probe-running')
}

function appendProviderModels(provider, selected, { verified = false } = {}) {
  const ids = new Set(provider.models.map((model) => model.id).filter(Boolean))
  const additions = selected.filter((model) => !ids.has(model.id)).slice(0, MAX_CATALOG_MODELS - ids.size)
  const models = [...provider.models.filter((model) => model.id || model.name), ...additions]
  const next = { ...provider, models }
  if (provider.presetId && verified && additions.length) next.modelsVerified = true
  settings = { ...settings, providers: settings.providers.map((item) => item.id === provider.id ? next : item) }
  return additions.length
}

function openProviderCatalogDialog(provider, fetched) {
  const existing = new Set(provider.models.map((model) => model.id).filter(Boolean))
  const remaining = MAX_CATALOG_MODELS - existing.size
  const preset = provider.presetId ? getCodingPlanPreset(provider.presetId) : null
  const available = (preset ? filterPresetModels(fetched, preset) : fetched).filter((model) => !existing.has(model.id))
  if (!available.length) { toast(t('config.models.catalog-up-to-date')); return }
  if (remaining <= 0) { toast(t('config.models.catalog-full', { count: MAX_CATALOG_MODELS })); return }

  const selected = new Set()
  const modal = openModal(`<div class="modal-head"><div><h3>${t('config.models.fetch-models')}</h3><p>${escapeHtml(provider.name)}</p></div><button class="button icon-button" data-close-modal aria-label="${t('config.models.close-modal')}">×</button></div>
    <input type="search" class="input" data-catalog-filter aria-label="${t('config.models.catalog-search')}" placeholder="${t('config.models.catalog-search')}">
    <p class="model-catalog-feedback" role="status" data-catalog-feedback></p>
    <div class="provider-discovery-list" data-catalog-options></div>
    <div class="modal-actions"><button class="button" data-close-modal>${t('config.models.cancel-import')}</button><button class="button primary" data-import-models></button></div>`)
  const filter = modal.querySelector('[data-catalog-filter]')
  const list = modal.querySelector('[data-catalog-options]')
  const feedback = modal.querySelector('[data-catalog-feedback]')
  const apply = modal.querySelector('[data-import-models]')
  const updateSelection = () => {
    apply.disabled = selected.size === 0
    apply.textContent = t('config.models.import-selected', { count: selected.size })
    for (const checkbox of list.querySelectorAll('input')) {
      checkbox.disabled = !checkbox.checked && selected.size >= remaining
    }
  }
  const renderOptions = () => {
    const query = filter.value.trim().toLowerCase()
    const matches = available.filter((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query))
    const visible = matches.slice(0, 80)
    list.innerHTML = visible.map((model) => `<label class="provider-discovery-row"><input type="checkbox" value="${escapeHtml(model.id)}" ${selected.has(model.id) ? 'checked' : ''}><span><b>${escapeHtml(model.name)}</b>${model.name !== model.id ? `<small>${escapeHtml(model.id)}</small>` : ''}</span></label>`).join('')
    feedback.textContent = t('config.models.catalog-matches', { shown: visible.length, total: matches.length })
    updateSelection()
  }
  list.onchange = (event) => {
    const checkbox = event.target
    if (checkbox.checked) selected.add(checkbox.value)
    else selected.delete(checkbox.value)
    updateSelection()
  }
  filter.oninput = renderOptions
  apply.onclick = () => {
    if (!commitOpenProviderEditors({ tolerant: true })) return
    const current = modelProviderById(provider.id)
    if (!current) return
    const count = appendProviderModels(current, available.filter((model) => selected.has(model.id)), { verified: true })
    window.setConfigDirty?.('models-provider-settings', true)
    closeModal()
    renderModels()
    toast(t('config.models.models-fetched', { count }))
  }
  renderOptions()
  filter.focus()
}

function bindProviderProbe(button, providerId, discover) {
  button.onclick = async () => {
    const root = providerEditorRoot(providerId)
    if (!root || root.hasAttribute('data-probe-running')) return
    const draft = readProviderEditor(providerId)
    if (!draft) return
    const model = root.querySelector('[data-provider-test-model]').value
    const inputs = [...root.querySelectorAll('[data-provider-name], [data-provider-base-url], [data-provider-protocol], [data-provider-enabled], [data-provider-api-key], [data-provider-headers], [data-model-id], [data-model-name], [data-provider-test-model]')]
    const before = inputs.map((input) => input.value)
    root.setAttribute('data-probe-running', '')
    root.querySelector('[data-fetch-models]').disabled = true
    root.querySelector('[data-test-provider]').disabled = true
    button.textContent = t(discover ? 'config.models.fetching' : 'config.models.testing')
    try {
      const result = discover
        ? await window.electronAPI.fetchProviderModels(draft)
        : await window.electronAPI.testConnection({ ...draft, model })
      if (!root.isConnected || inputs.some((input, index) => input.value !== before[index])) return
      if (!result?.ok) throw new Error(t(discover ? 'config.models.fetch-failed' : 'config.models.connect-failed'))
      const corrections = []
      if (result.protocol && result.protocol !== draft.protocol) {
        root.querySelector('[data-provider-protocol]').value = result.protocol
        corrections.push(t('config.models.protocol-switched', { protocol: result.protocol }))
      }
      if (result.baseUrl && result.baseUrl.replace(/\/+$/, '') !== draft.baseUrl.replace(/\/+$/, '')) {
        if (root.querySelector('[data-provider-api-key]').value.trim() || (!draft.apiKey && !draft.hasApiKey)) {
          root.querySelector('[data-provider-base-url]').value = result.baseUrl
        }
        corrections.push(t('config.models.base-url-used', { url: result.baseUrl }))
      }
      if (corrections.length) window.setConfigDirty?.('models-provider-editor', true)
      if (discover) {
        const fetched = Array.isArray(result.models) ? result.models : []
        if (!fetched.length) { toast(t('config.models.no-models-fetched')); return }
        openProviderCatalogDialog(draft, fetched)
      } else {
        toast(corrections.length ? t('config.models.connected-with-corrections', { details: corrections.join(t('config.common.clause-separator')) }) : t('config.models.connected'))
      }
    } catch (error) {
      if (root.isConnected) toast(errorMessage(error) || t(discover ? 'config.models.fetch-models-failed' : 'config.models.connect-failed'))
    } finally {
      root.removeAttribute('data-probe-running')
      root.querySelector('[data-fetch-models]').disabled = false
      button.textContent = t(discover ? 'config.models.fetch-models' : 'config.models.test')
      syncProviderTestModels(root)
    }
  }
}

function bindModelsProviderTab() {
  // M2/W6b: touching an open provider editor is a draft. Two reasons keep the
  // main process conservative: the DOM draft dies with the route (cleared on
  // navigate), while in-memory provider mutations survive until save persists
  // them, so only the save button clears that reason.
  const markModelsEditorDraft = (event) => {
    if (!event.target.matches('[data-provider-test-model]')) {
      event.currentTarget.dataset.providerEdited = 'true'
      window.setConfigDirty?.('models-provider-editor', true)
    }
  }
  const markModelsSettingsDraft = () => window.setConfigDirty?.('models-provider-settings', true)
  document.querySelectorAll('[data-provider-editor]').forEach((editor) => {
    editor.addEventListener('input', markModelsEditorDraft)
    editor.addEventListener('change', markModelsEditorDraft)
    editor.querySelectorAll('[data-delete-provider], [data-restore-models], [data-add-provider-model], [data-remove-model]').forEach((control) => control.addEventListener('click', markModelsSettingsDraft))
    syncProviderTestModels(editor)
    editor.addEventListener('input', (event) => {
      if (event.target.matches('[data-model-id], [data-model-name]')) syncProviderTestModels(editor)
    })
  })
  document.querySelectorAll('[data-expand-provider]').forEach((head) => {
    head.onclick = () => {
      const providerId = head.dataset.expandProvider
      if (!commitOpenProviderEditors({ tolerant: true })) return
      if (modelsExpandedProviderIds.has(providerId)) modelsExpandedProviderIds.delete(providerId)
      else modelsExpandedProviderIds.add(providerId)
      window.setConfigDirty?.('models-provider-editor', modelsExpandedProviderIds.size > 0)
      renderModels()
      document.querySelector(`[data-expand-provider="${CSS.escape(providerId)}"]`)?.focus({ preventScroll: true })
    }
  })
  document.getElementById('addModelProvider')?.addEventListener('click', openProviderPresetDialog)
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
    bindProviderProbe(button, button.dataset.testProvider, false)
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
      appendProviderModels(provider, defaults)
      renderModels()
      toast(t('config.models.models-restored'))
    }
  })
  document.querySelectorAll('[data-fetch-models]').forEach((button) => {
    bindProviderProbe(button, button.dataset.fetchModels, true)
  })
  document.querySelectorAll('[data-add-provider-model]').forEach((button) => {
    button.onclick = () => {
      const providerId = button.dataset.addProviderModel
      if (!commitOpenProviderEditors({ tolerant: true })) return
      const provider = modelProviderById(providerId)
      if (!provider) return
      if (provider.models.length >= MAX_CATALOG_MODELS) { toast(t('config.models.catalog-full', { count: MAX_CATALOG_MODELS })); return }
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
      // Vision is a per-model capability that decides whether "Image to Markdown /
      // HTML" can run on this model (2026-10-18 snow migration §6.2②). It is stored
      // in the catalog, so it survives a save through mergeModelRow().
      const visionEnabled = provider.models?.[index]?.capabilities?.vision === true
      panel.innerHTML = `<div class="model-detail-grid"><span>${t('config.models.model-id')}</span><b>${escapeHtml(modelId)}</b><span>${t('config.models.display-name')}</span><b>${escapeHtml(modelName)}</b><span>${t('config.models.owning-provider')}</span><b>${escapeHtml(provider.name)}</b><span>${t('config.models.api-protocol')}</span><b>${escapeHtml(provider.protocol || 'openai-chat')}</b><span>${t('config.models.api-url')}</span><b>${escapeHtml(provider.baseUrl || t('config.models.not-filled'))}</b></div><div class="model-detail-grid model-detail-capabilities"><span>${t('config.models.supports-images')}</span><label class="switch ${visionEnabled ? 'on' : ''}" data-model-vision="${index}" role="switch" aria-checked="${visionEnabled}" tabindex="0" title="${t('config.models.supports-images-hint')}"></label><small>${t('config.models.supports-images-hint')}</small></div>`
      panel.querySelector('[data-model-vision]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        const target = event.currentTarget
        const base = modelProviderById(providerId)
        if (!base) return
        const nextVision = base.models?.[index]?.capabilities?.vision !== true
        const models = base.models.map((model, modelIndex) => modelIndex !== index
          ? model
          : { ...model, capabilities: { ...(model.capabilities || {}), vision: nextVision } })
        settings = { ...settings, providers: settings.providers.map((item) => item.id === providerId ? { ...item, models } : item) }
        target.classList.toggle('on', nextVision)
        target.setAttribute('aria-checked', String(nextVision))
      })
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
      if (provider.models.length <= 1 && provider.models[0]?.id) { toast(t('config.models.keep-one-model')); return }
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
      window.setConfigDirty?.('models-provider-editor', false)
      window.setConfigDirty?.('models-provider-settings', false)
      if (currentRoute === 'models' && modelsTab === 'providers') {
        renderModels()
        document.getElementById('saveProviderSettings')?.focus({ preventScroll: true })
      }
    } catch (error) {
      toast(error.message || t('config.models.providers-save-failed'))
    }
  })
}
