// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models 的供应商/功能模型读值与校验 helper（D2-3：巨型路由再分解）。
// 依赖 routes/model-helpers.js 与 shared/coding-plan-presets.js（均在本文件之前加载）。

if (!window.modelHelpers || !window.codingPlanPresets) {
  throw new Error('config.js requires routes/model-helpers.js and shared/coding-plan-presets.js to be loaded first')
}

const {
  createModelProviderId,
  modelProviderStatus,
  modelTaskForFeature,
  modelsForFeature
} = window.modelHelpers

const {
  defaultModelsForProvider,
  filterPresetModels,
  getCodingPlanPreset,
  listCodingPlanPresets
} = window.codingPlanPresets

function modelProviderById(id) {
  return (settings.providers || []).find((provider) => provider.id === id)
}

function modelFeatureRows() {
  const rows = [...modelFeatureCatalog]
  for (const action of settings.selectionToolbar.customActions || []) {
    rows.push({ id: `custom:${action.id}`, label: t('config.models.custom-feature-label', { name: action.name }), description: t('config.models.custom-feature-description', { name: action.name }) })
  }
  return rows
}

function modelAssignmentForFeature(feature) {
  const assignments = featureAssignmentDraft || settings.ai?.assignments || []
  return assignments.find((assignment) => assignment.feature === feature)
}


function modelCatalogRowMarkup(provider, index) {
  const model = provider.models[index] || { id: '', name: '' }
  return `<div class="model-catalog-item" data-model-catalog-item="${escapeHtml(provider.id)}:${index}"><div class="model-catalog-row" data-model-index="${index}"><input class="input model-id-input" data-model-id type="text" value="${escapeHtml(model.id)}" placeholder="${t('config.models.model-id')}"><input class="input model-name-input" data-model-name type="text" value="${escapeHtml(model.name)}" placeholder="${t('config.models.name-placeholder')}"><button class="button icon-button model-row-details" data-model-details="${escapeHtml(provider.id)}" data-model-index="${index}" title="${t('config.models.expand-model-details')}" aria-label="${t('config.models.expand-model-details')}">›</button><button class="button icon-button model-row-delete" data-remove-model="${escapeHtml(provider.id)}" data-model-index="${index}" title="${t('config.models.delete-model')}" aria-label="${t('config.models.delete-model')}">${iconMarkup('../capture/icons/close.svg')}</button></div><div class="model-detail-panel" data-model-detail-panel="${escapeHtml(provider.id)}:${index}" hidden></div></div>`
}

function modelOptionsMarkup(provider, currentModel, feature) {
  const models = modelsForFeature(provider, feature)
  if (!models.length) return '<option value="">' + t('config.models.no-applicable-model') + '</option>'
  return models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === currentModel ? 'selected' : ''}>${escapeHtml(model.name || model.id)}</option>`).join('')
}

function featureAssignmentMarkup(feature, providers) {
  const assignment = modelAssignmentForFeature(feature.id) || {}
  const providerId = providers.some((provider) => provider.id === assignment.providerId)
    ? assignment.providerId
    : providers[0]?.id
  const provider = providers.find((item) => item.id === providerId) || providers[0]
  return `<div class="feature-model-row" data-feature="${escapeHtml(feature.id)}"><div class="feature-model-label"><b>${escapeHtml(t(feature.label))}</b><small>${escapeHtml(t(feature.description))}</small></div><select data-feature-provider="${escapeHtml(feature.id)}">${providers.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === provider?.id ? 'selected' : ''}>${escapeHtml(item.name)}${item.enabled === false ? t('config.models.provider-disabled-suffix') : ''}</option>`).join('')}</select><select data-feature-model="${escapeHtml(feature.id)}">${modelOptionsMarkup(provider, assignment.model, feature.id)}</select></div>`
}

function snapshotFeatureAssignments() {
  const assignments = []
  for (const row of document.querySelectorAll('[data-feature]')) {
    const feature = row.dataset.feature
    const providerId = row.querySelector('[data-feature-provider]')?.value || ''
    const model = row.querySelector('[data-feature-model]')?.value || ''
    if (feature) assignments.push({ feature, providerId, model })
  }
  return assignments
}

function readFeatureAssignments() {
  const assignments = snapshotFeatureAssignments()
  const incomplete = assignments.find((assignment) => !assignment.providerId || !assignment.model)
  if (incomplete) {
    const feature = modelFeatureRows().find((item) => item.id === incomplete.feature)
    toast(t('config.models.no-model-for-feature', { feature: feature ? t(feature.label) : incomplete.feature }))
    return null
  }
  return assignments
}

function providerEditorRoot(providerId) {
  return document.querySelector(`[data-provider-editor="${providerId}"]`)
}

function providerDraftWithSecret(base, root) {
  const { apiKey: retainedApiKey = '', ...safeBase } = base
  const enteredApiKey = root?.querySelector('[data-provider-api-key]')?.value.trim() || ''
  const baseUrl = root.querySelector('[data-provider-base-url]').value.trim()
  const sameEndpoint = baseUrl.replace(/\/+$/, '') === String(base.baseUrl || '').replace(/\/+$/, '')
  const apiKey = enteredApiKey || (sameEndpoint ? retainedApiKey : '')
  return { ...safeBase, hasApiKey: sameEndpoint && safeBase.hasApiKey, ...(apiKey ? { apiKey } : {}) }
}

function readCustomHeaders(root) {
  const lines = root.querySelector('[data-provider-headers]').value.split(/\r?\n/).filter((line) => line.trim())
  const entries = []
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator < 1) return null
    entries.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()])
  }
  const headers = window.codingPlanPresets.sanitizeProviderHeaders(Object.fromEntries(entries))
  return entries.length === Object.keys(headers).length &&
    entries.every(([key, value]) => headers[key] === value) ? headers : null
}

function readProviderConnectionDraft(base, root, { tolerant = false } = {}) {
  const name = root.querySelector('[data-provider-name]').value.trim()
  const baseUrl = root.querySelector('[data-provider-base-url]').value.trim()
  const protocol = root.querySelector('[data-provider-protocol]').value
  const enabled = root.querySelector('[data-provider-enabled]').value !== 'false'
  const headers = readCustomHeaders(root)
  const draft = providerDraftWithSecret(base, root)
  if (!headers) { toast(t('config.models.headers-invalid')); return null }
  if (!tolerant && !name) { toast(t('config.models.provider-name-required')); return null }
  if (!tolerant && !baseUrl) { toast(t('config.models.api-url-required')); return null }
  if (baseUrl && baseUrl !== base.baseUrl && !window.providerConnection.parseProviderBaseUrl(baseUrl)) {
    toast(t('config.models.api-url-invalid'))
    return null
  }
  if ((base.hasApiKey || base.apiKey) && !draft.hasApiKey && !draft.apiKey &&
      !window.providerConnection.isLoopbackProviderUrl(baseUrl)) {
    toast(t('config.models.api-key-changed'))
    return null
  }
  return { ...draft, name, baseUrl, protocol, enabled, headers }
}

// The model row editor only owns id/name; anything else the catalog carries has
// to survive an edit. Before this, saving a provider silently dropped every
// model's `capabilities` (tasks/reasoning/vision), so a vision model lost its
// image support the first time the user pressed save.
function mergeModelRow(baseModel, row) {
  const id = row.querySelector('[data-model-id]')?.value.trim() || ''
  if (!id) return { success: false, reason: 'id' }
  const name = row.querySelector('[data-model-name]')?.value.trim() || id
  const capabilities = baseModel?.capabilities
  return capabilities && typeof capabilities === 'object'
    ? { success: true, model: { ...baseModel, id, name } }
    : { success: true, model: { id, name } }
}

function readProviderEditor(providerId, { tolerant = false } = {}) {
  const base = modelProviderById(providerId)
  const root = providerEditorRoot(providerId)
  if (!base || !root) return null
  const draft = readProviderConnectionDraft(base, root, { tolerant })
  if (!draft) return null
  const models = []
  const ids = new Set()
  for (const row of root.querySelectorAll('.model-catalog-row[data-model-index]')) {
    const index = Number(row.dataset.modelIndex)
    const merged = mergeModelRow(base.models?.[index], row)
    if (!merged.success) {
      const name = row.querySelector('[data-model-name]').value.trim()
      if (name && !tolerant) { toast(t('config.models.model-id-required')); return null }
      if (tolerant) models.push({ id: '', name })
      continue
    }
    if (ids.has(merged.model.id)) { toast(t('config.models.model-id-duplicate', { id: merged.model.id })); return null }
    ids.add(merged.model.id)
    models.push(merged.model)
  }
  return { ...draft, models }
}

function commitOpenProviderEditors({ exceptId = '', tolerant = false } = {}) {
  const providers = [...(settings.providers || [])]
  let committedDraft = false
  for (const provider of providers) {
    if (!modelsExpandedProviderIds.has(provider.id)) continue
    if (exceptId && provider.id === exceptId) continue
    const next = readProviderEditor(provider.id, { tolerant })
    if (!next) return null
    const index = providers.findIndex((item) => item.id === provider.id)
    providers[index] = next
    committedDraft ||= providerEditorRoot(provider.id)?.dataset.providerEdited === 'true'
  }
  if (committedDraft) window.setConfigDirty?.('models-provider-settings', true)
  settings = { ...settings, providers }
  return providers
}

// Coding-plan providers are marked as such, and a fallback catalog is surfaced
// as "目录未验证" instead of hiding behind a green status dot (design FR-6 / FR-4).
// Always renders the wrapper so the accordion head keeps a stable column count.
function providerBadgesMarkup(provider) {
  const badges = []
  if (provider.presetId) badges.push('<span class="provider-tag coding-plan">Coding Plan</span>')
  if (provider.modelsVerified === false) badges.push('<span class="provider-tag unverified">' + t('config.models.catalog-unverified') + '</span>')
  return `<span class="provider-badges">${badges.join('')}</span>`
}
