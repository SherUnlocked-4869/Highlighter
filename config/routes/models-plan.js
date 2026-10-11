// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models 的 Coding Plan 预设选择器与功能指派引导（D2-3）。
// 依赖 routes/models-editor.js（modelFeatureRows）、routes/models-render.js（renderModels）
// 与 routes/shared.js（openModal/closeModal/toast/updateSettings）。

function codingPlanPresetCardMarkup(preset) {
  return `<div class="coding-plan-card" data-coding-plan-preset="${escapeHtml(preset.id)}" role="button" tabindex="0"><div class="coding-plan-card-head"><b>${escapeHtml(preset.name)}</b><span class="provider-tag coding-plan">Coding Plan</span></div><p>${escapeHtml(preset.tagline)}</p><button class="button coding-plan-docs" data-docs-url="${escapeHtml(preset.docsUrl)}">查看文档</button></div>`
}

function codingPlanReadonlyRow(label, value) {
  return `<div class="coding-plan-preset-field"><span>${escapeHtml(label)}</span><code class="coding-plan-readonly">${escapeHtml(value)}</code></div>`
}

function codingPlanFormMarkup(preset) {
  return `<div class="coding-plan-form-head"><div><b>${escapeHtml(preset.name)}</b><small>${escapeHtml(preset.tagline)}</small></div><span class="provider-tag coding-plan">Coding Plan</span></div><div class="model-field"><div class="model-field-label"><b>API 密钥</b><small>通过系统安全存储加密保存在本机</small></div><input class="input" data-coding-plan-key type="password" placeholder="sk-..." autocomplete="off"></div><div class="model-field"><div class="model-field-label"><b>显示名称</b><small>可选，留空则使用套餐名称</small></div><input class="input" data-coding-plan-name type="text" value="${escapeHtml(preset.name)}"></div><div class="coding-plan-preset-info">${codingPlanReadonlyRow('API 地址', preset.baseUrl)}${codingPlanReadonlyRow('API 协议', preset.protocol)}</div><p class="coding-plan-note">保存时自动测试连接并拉取实时模型目录；拉取失败会写入内置模型清单，不阻断保存。coding plan 通常有额度窗口限制。</p><div class="modal-actions"><button class="button" data-coding-plan-back>返回</button><button class="button primary" data-coding-plan-save>保存并验证</button></div>`
}

function openCodingPlanDialog() {
  const presets = listCodingPlanPresets()
  const modal = openModal(`<div class="modal-head"><div><h3>添加 Coding Plan</h3><p>选择套餐后只需填写 API 密钥，API 地址、协议与模型目录会自动配置。</p></div><button class="button icon-button" data-close-modal aria-label="关闭">×</button></div><div class="coding-plan-picker">${presets.map(codingPlanPresetCardMarkup).join('')}</div><div class="coding-plan-form" data-coding-plan-form hidden></div>`)
  const picker = modal.querySelector('.coding-plan-picker')
  const form = modal.querySelector('[data-coding-plan-form]')

  const selectPreset = (presetId) => {
    const preset = presets.find((item) => item.id === presetId)
    if (!preset) return
    codingPlanPresetId = preset.id
    picker.hidden = true
    form.hidden = false
    form.innerHTML = codingPlanFormMarkup(preset)
    form.querySelector('[data-coding-plan-key]')?.focus()
    form.querySelector('[data-coding-plan-back]').onclick = () => {
      codingPlanPresetId = ''
      form.hidden = true
      form.innerHTML = ''
      picker.hidden = false
    }
    form.querySelector('[data-coding-plan-save]').onclick = () => saveCodingPlanPreset(preset)
  }

  picker.querySelectorAll('[data-coding-plan-preset]').forEach((card) => {
    const activate = () => selectPreset(card.dataset.codingPlanPreset)
    card.onclick = activate
    card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } }
  })
  picker.querySelectorAll('[data-docs-url]').forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); openDocs(button.dataset.docsUrl) }
  })
}

async function saveCodingPlanPreset(preset) {
  const form = modalOverlay?.querySelector('[data-coding-plan-form]')
  const saveButton = form?.querySelector('[data-coding-plan-save]')
  const apiKey = form?.querySelector('[data-coding-plan-key]')?.value.trim() || ''
  const displayName = form?.querySelector('[data-coding-plan-name]')?.value.trim() || ''
  if (!apiKey) { toast('请填写 API 密钥'); return }
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = '保存并验证…' }
  try {
    const result = await window.electronAPI.createCodingPlanProvider({ presetId: preset.id, apiKey, displayName })
    closeModal()
    settings = await window.electronAPI.getSettings()
    applyAppearance()
    void refreshStatusRail()
    modelsTab = 'providers'
    modelsExpandedProviderIds = new Set([result.provider.id])
    renderModels()
    toast(result.verified ? `已添加 ${result.provider.name}，获取到 ${result.modelsCount} 个模型` : `已添加 ${result.provider.name}：${result.warning}`)
    openCodingPlanAssignmentGuide(result.provider)
  } catch (error) {
    toast(errorMessage(error) || '添加 Coding Plan 失败')
    if (saveButton) { saveButton.disabled = false; saveButton.textContent = '保存并验证' }
  }
}

// The save already wrote the provider; this only offers to repoint AI features
// at it, and never overwrites an assignment the user did not tick (design D8).
function openCodingPlanAssignmentGuide(provider) {
  const models = provider.models || []
  if (!models.length) return
  const rows = modelFeatureRows().map((feature) => `<label class="coding-plan-assignment"><input type="checkbox" data-coding-plan-feature="${escapeHtml(feature.id)}" checked><span class="coding-plan-assignment-label"><b>${escapeHtml(feature.label)}</b><small>${escapeHtml(feature.description)}</small></span><select data-coding-plan-feature-model="${escapeHtml(feature.id)}">${models.map((model, index) => `<option value="${escapeHtml(model.id)}" ${index === 0 ? 'selected' : ''}>${escapeHtml(model.name || model.id)}</option>`).join('')}</select></label>`).join('')
  const modal = openModal(`<div class="modal-head"><div><h3>把功能切换到 ${escapeHtml(provider.name)}？</h3><p>勾选要使用该套餐的功能并选择模型；未勾选的功能保持原配置。也可以直接跳过。</p></div><button class="button icon-button" data-close-modal aria-label="关闭">×</button></div><div class="coding-plan-assignment-list">${rows}</div><p class="coding-plan-note">coding plan 有额度窗口限制，建议只把常用功能切过来。</p><div class="modal-actions"><button class="button" data-coding-plan-skip>跳过</button><button class="button primary" data-coding-plan-apply>应用功能模型</button></div>`)
  modal.querySelector('[data-coding-plan-skip]').onclick = closeModal
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
      await updateSettings({ ai: { schemaVersion: 2, assignments } }, '功能模型已更新')
      closeModal()
      renderModels()
    } catch (error) {
      toast(errorMessage(error) || '功能模型保存失败')
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
