// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models 的 Coding Plan 预设选择器与功能指派引导（D2-3）。
// 依赖 routes/models-editor.js（modelFeatureRows）、routes/models-render.js（renderModels）
// 与 routes/shared.js（openModal/closeModal/toast/updateSettings）。

function codingPlanPresetCardMarkup(preset) {
  return `<div class="coding-plan-card"><button type="button" class="coding-plan-choice" data-coding-plan-preset="${escapeHtml(preset.id)}"><span class="coding-plan-card-head"><b>${escapeHtml(preset.name)}</b><span class="provider-tag coding-plan">Coding Plan</span></span><span class="coding-plan-tagline">${escapeHtml(preset.tagline)}</span></button><button type="button" class="button coding-plan-docs" data-docs-url="${escapeHtml(preset.docsUrl)}">${t('config.models.view-docs')}</button></div>`
}

function codingPlanReadonlyRow(label, value) {
  return `<div class="coding-plan-preset-field"><span>${escapeHtml(label)}</span><code class="coding-plan-readonly">${escapeHtml(value)}</code></div>`
}

function codingPlanFormMarkup(preset) {
  return `<div class="coding-plan-form-head"><div><b>${escapeHtml(preset.name)}</b><small>${escapeHtml(preset.tagline)}</small></div><span class="provider-tag coding-plan">Coding Plan</span></div><div class="model-field"><div class="model-field-label"><label for="codingPlanKey"><b>${t('config.models.api-key')}</b></label><small id="codingPlanKeyHint">${t('config.models.api-key-hint')}</small></div><input id="codingPlanKey" class="input" data-coding-plan-key type="password" aria-describedby="codingPlanKeyHint" placeholder="sk-..." autocomplete="off"></div><div class="model-field"><div class="model-field-label"><label for="codingPlanName"><b>${t('config.models.display-name')}</b></label><small id="codingPlanNameHint">${t('config.models.display-name-optional')}</small></div><input id="codingPlanName" class="input" data-coding-plan-name type="text" aria-describedby="codingPlanNameHint" value="${escapeHtml(preset.name)}"></div><div class="coding-plan-preset-info">${codingPlanReadonlyRow(t('config.models.api-url'), preset.baseUrl)}${codingPlanReadonlyRow(t('config.models.api-protocol'), preset.protocol)}</div><p class="coding-plan-note">${t('config.models.coding-plan-note')}</p><div class="modal-actions"><button class="button" data-coding-plan-back>${t('config.models.back')}</button><button class="button primary" data-coding-plan-save>${t('config.models.save-and-verify')}</button></div>`
}

function openCodingPlanDialog() {
  const presets = listCodingPlanPresets()
  const modal = openModal(`<div class="modal-head"><div><h3 id="codingPlanDialogTitle">${t('config.models.add-coding-plan')}</h3><p>${t('config.models.coding-plan-intro')}</p></div><button type="button" class="button icon-button" commandfor="config-native-modal" command="close" aria-label="${t('config.models.close-modal')}">×</button></div><div class="coding-plan-picker">${presets.map(codingPlanPresetCardMarkup).join('')}</div><div class="coding-plan-form" data-coding-plan-form hidden></div>`, 'codingPlanDialogTitle')
  const picker = modal.querySelector('.coding-plan-picker')
  const form = modal.querySelector('[data-coding-plan-form]')

  const selectPreset = (choice) => {
    const preset = presets.find((item) => item.id === choice.dataset.codingPlanPreset)
    if (!preset) return
    picker.hidden = true
    form.hidden = false
    form.innerHTML = codingPlanFormMarkup(preset)
    form.querySelector('[data-coding-plan-key]')?.focus()
    form.querySelector('[data-coding-plan-back]').onclick = () => {
      form.hidden = true
      form.replaceChildren()
      picker.hidden = false
      choice.focus()
    }
    form.querySelector('[data-coding-plan-save]').onclick = () => saveCodingPlanPreset(modal, preset)
  }

  picker.querySelectorAll('[data-coding-plan-preset]').forEach((choice) => {
    choice.closest('.coding-plan-card').onclick = () => selectPreset(choice)
  })
  picker.querySelectorAll('[data-docs-url]').forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); openDocs(button.dataset.docsUrl) }
  })
}

async function saveCodingPlanPreset(modal, preset) {
  const form = modal.querySelector('[data-coding-plan-form]')
  const saveButton = form?.querySelector('[data-coding-plan-save]')
  const apiKey = form?.querySelector('[data-coding-plan-key]')?.value.trim() || ''
  const displayName = form?.querySelector('[data-coding-plan-name]')?.value.trim() || ''
  if (!apiKey) { toast(t('config.models.api-key-required')); return }
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = t('config.models.saving-and-verifying') }
  try {
    const result = await window.electronAPI.createCodingPlanProvider({ presetId: preset.id, apiKey, displayName })
    settings = await window.electronAPI.getSettings()
    applyAppearance()
    void refreshStatusRail()
    if (!modal.open || !saveButton?.isConnected) return
    closeModal()
    modelsTab = 'providers'
    modelsExpandedProviderIds = new Set([result.provider.id])
    renderModels()
    providerEditorRoot(result.provider.id)?.querySelector('[data-expand-provider]')?.focus()
    toast(result.verified ? t('config.models.preset-added', { name: result.provider.name, count: result.modelsCount }) : t('config.models.preset-added-with-warning', { name: result.provider.name, warning: result.warning }))
    openCodingPlanAssignmentGuide(result.provider)
  } catch (error) {
    toast(errorMessage(error) || t('config.models.add-coding-plan-failed'))
    if (saveButton) { saveButton.disabled = false; saveButton.textContent = t('config.models.save-and-verify') }
  }
}

// The save already wrote the provider; this only offers to repoint AI features
// at it, and never overwrites an assignment the user did not tick (design D8).
function openCodingPlanAssignmentGuide(provider) {
  const models = provider.models || []
  if (!models.length) return
  const rows = modelFeatureRows().map((feature, index) => `<div class="coding-plan-assignment"><input id="codingPlanFeature-${index}" type="checkbox" data-coding-plan-feature="${escapeHtml(feature.id)}" checked><label class="coding-plan-assignment-label" for="codingPlanFeature-${index}"><b id="codingPlanFeatureName-${index}">${escapeHtml(t(feature.label))}</b><small>${escapeHtml(t(feature.description))}</small></label><select aria-labelledby="codingPlanFeatureName-${index}" data-coding-plan-feature-model="${escapeHtml(feature.id)}">${models.map((model, index) => `<option value="${escapeHtml(model.id)}" ${index === 0 ? 'selected' : ''}>${escapeHtml(model.name || model.id)}</option>`).join('')}</select></div>`).join('')
  const modal = openModal(`<div class="modal-head"><div><h3 id="codingPlanAssignmentTitle">${t('config.models.switch-features-title', { name: escapeHtml(provider.name) })}</h3><p>${t('config.models.switch-features-intro')}</p></div><button type="button" class="button icon-button" commandfor="config-native-modal" command="close" aria-label="${t('config.models.close-modal')}">×</button></div><div class="coding-plan-assignment-list">${rows}</div><p class="coding-plan-note">${t('config.models.coding-plan-assignment-note')}</p><div class="modal-actions"><button type="button" class="button" data-coding-plan-skip commandfor="config-native-modal" command="close" autofocus>${t('config.models.skip')}</button><button type="button" class="button primary" data-coding-plan-apply>${t('config.models.apply-features')}</button></div>`, 'codingPlanAssignmentTitle')
  modal.querySelector('[data-coding-plan-apply]').onclick = async () => {
    const assignments = [...(settings.ai?.assignments || [])]
    modal.querySelectorAll('[data-coding-plan-feature]').forEach((checkbox) => {
      if (!checkbox.checked) return
      const feature = checkbox.dataset.codingPlanFeature
      const model = modal.querySelector(`[data-coding-plan-feature-model="${feature}"]`)?.value || ''
      if (!model) return
      const next = { feature, providerId: provider.id, model }
      const index = assignments.findIndex((item) => item.feature === feature)
      if (index >= 0) assignments[index] = next
      else assignments.push(next)
    })
    try {
      await updateSettings({ ai: { schemaVersion: 2, assignments } }, t('config.models.features-updated'))
      if (!modal.open) return
      closeModal()
      renderModels()
      providerEditorRoot(provider.id)?.querySelector('[data-expand-provider]')?.focus()
    } catch (error) {
      toast(errorMessage(error) || t('config.models.features-save-failed'))
    }
  }
}

// 与拆分前 renderRoute() 的调用形态一致：导航进入 models 时先重置子页签与展开项，
// 再渲染供应商面板（models-render.js 的 renderModels）。
function bootstrapModels() {
  modelsTab = 'providers'
  modelsExpandedProviderIds = new Set()
  renderModels()
}
