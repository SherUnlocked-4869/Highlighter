// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models（模型）渲染：子导航、供应商面板、功能模型面板。

let modelsTab = 'providers'
let modelsExpandedProviderIds = new Set()
let featureAssignmentDraft = null
let codingPlanPresetId = ''

const modelFeatureCatalog = [
  { id: 'chat', label: 'config.models.feature-chat', description: 'config.models.feature-chat-description' },
  { id: 'translation', label: 'config.models.feature-translation', description: 'config.models.feature-translation-description' },
  { id: 'ocr-translate', label: 'config.models.feature-ocr-translate', description: 'config.models.feature-ocr-translate-description' },
  { id: 'toolbar:translate', label: 'config.models.feature-toolbar-translate', description: 'config.models.feature-toolbar-translate-description' },
  { id: 'toolbar:explain', label: 'config.models.feature-toolbar-explain', description: 'config.models.feature-toolbar-explain-description' }
]

function providerEditorMarkup(provider) {
  const expanded = modelsExpandedProviderIds.has(provider.id)
  const status = modelProviderStatus(provider)
  if (!expanded) {
    return `<article class="model-provider-accordion" data-provider-editor="${escapeHtml(provider.id)}"><div class="model-provider-accordion-head" data-expand-provider="${escapeHtml(provider.id)}" role="button" tabindex="0" title="${t('config.models.expand-provider')}"><span class="model-provider-expand">▸</span><span class="model-provider-item-name">${escapeHtml(provider.name)}</span>${providerBadgesMarkup(provider)}<span class="provider-head-status"><span class="provider-dot ${status.className}"></span>${escapeHtml(t(status.title))}</span><span class="model-provider-chevron">${t('config.models.expand')}</span></div></article>`
  }
  return `<article class="model-provider-accordion expanded" data-provider-editor="${escapeHtml(provider.id)}"><div class="model-provider-accordion-head" data-expand-provider="${escapeHtml(provider.id)}" role="button" tabindex="0" title="${t('config.models.collapse-provider')}"><span class="model-provider-expand">▾</span><span class="model-provider-item-name">${escapeHtml(provider.name)}</span><span class="provider-head-status"><span class="provider-dot ${status.className}"></span>${escapeHtml(t(status.title))}</span><span class="model-provider-chevron">${t('config.models.collapse')}</span></div><div class="model-provider-editor"><div class="model-provider-editor-head"><div class="model-provider-title"><b>${escapeHtml(provider.name)}</b><span class="provider-tag ${provider.builtin ? 'builtin' : ''}">${provider.builtin ? t('config.models.builtin') : t('config.models.custom')}</span>${providerBadgesMarkup(provider)}<span class="provider-dot ${status.className}" title="${escapeHtml(t(status.title))}"></span></div><button class="button danger" data-delete-provider="${escapeHtml(provider.id)}">${t('config.models.delete-provider')}</button></div><div class="model-field"><div class="model-field-label"><b>${t('config.models.api-key')}</b><small>${t('config.models.api-key-hint')}</small></div><div class="model-field-control"><input class="input" data-provider-api-key type="password" value="" placeholder="${escapeHtml((provider.apiKey || provider.hasApiKey) ? t('config.models.api-key-configured-placeholder') : 'sk-...')}"><button class="button" data-test-provider="${escapeHtml(provider.id)}">${t('config.models.test')}</button></div></div><details class="model-custom-details" open><summary>${t('config.models.custom-section')}</summary><div class="model-field"><div class="model-field-label"><b>${t('config.models.enabled-status')}</b></div><select data-provider-enabled><option value="true" ${provider.enabled !== false ? 'selected' : ''}>${t('config.models.enabled')}</option><option value="false" ${provider.enabled === false ? 'selected' : ''}>${t('config.models.disabled')}</option></select></div><div class="model-field"><div class="model-field-label"><b>${t('config.models.display-name')}</b></div><input class="input" data-provider-name type="text" value="${escapeHtml(provider.name)}" placeholder="${t('config.models.display-name-placeholder')}"></div><div class="model-field"><div class="model-field-label"><b>${t('config.models.api-url')}</b></div><input class="input" data-provider-base-url type="text" value="${escapeHtml(provider.baseUrl)}" placeholder="https://api.example.com/v1"></div><div class="model-field"><div class="model-field-label"><b>${t('config.models.api-protocol')}</b></div><select data-provider-protocol><option value="openai-chat" ${provider.protocol === 'openai-chat' ? 'selected' : ''}>openai-chat</option><option value="openai-responses" ${provider.protocol === 'openai-responses' ? 'selected' : ''}>openai-responses</option></select></div></details><div class="model-catalog-block"><div class="model-catalog-head"><div><b>${t('config.models.catalog')}</b><small>${provider.models.length ? t('config.models.catalog-custom') : t('config.models.catalog-empty')}</small></div><div class="model-catalog-actions"><button class="button" data-restore-models="${escapeHtml(provider.id)}">${t('config.models.restore-models')}</button><button class="button" data-fetch-models="${escapeHtml(provider.id)}">${t('config.models.fetch-models')}</button></div></div><div class="model-catalog-list">${provider.models.map((model, index) => modelCatalogRowMarkup(provider, index)).join('')}</div><button class="button" data-add-provider-model="${escapeHtml(provider.id)}">${t('config.models.add-model')}</button></div></div></article>`
}

function renderModelsSubnav() {
  return `<div class="models-subnav"><button class="${modelsTab === 'providers' ? 'active' : ''}" data-models-tab="providers">${t('config.models.tab-providers')}</button><button class="${modelsTab === 'features' ? 'active' : ''}" data-models-tab="features">${t('config.models.tab-features')}</button></div>`
}

function renderModelsProviderTab(providers) {
  const providerList = providers.map((provider) => providerEditorMarkup(provider)).join('') || '<div class="empty">' + t('config.models.no-providers') + '</div>'
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>${t('config.models.providers-section')}</h2><p>${t('config.models.providers-description')}</p></div><div class="models-toolbar-actions"><button class="button" id="openModelConfigFile">${t('config.models.open-config-file')}</button><button class="button" id="addCodingPlanProvider">${iconMarkup('icons/lightning.svg')}${t('config.models.add-coding-plan')}</button><button class="button primary" id="addModelProvider">${t('config.models.add-provider')}</button></div></div><div class="model-provider-list-page">${providerList}</div><div class="model-save-row"><button class="button primary" id="saveProviderSettings">${t('config.models.save-providers')}</button></div></div>`
}

function renderModelsFeatureTab(providers) {
  const featureRows = modelFeatureRows().map((feature) => featureAssignmentMarkup(feature, providers)).join('')
  const saveLabel = featureAssignmentDraft ? t('config.models.save-features-dirty') : t('config.models.save-features')
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>${t('config.models.features-section')}</h2><p>${t('config.models.features-description')}</p></div></div><div class="card feature-model-card"><div class="feature-model-head"><div><b>${t('config.models.feature-list')}</b><small>${t('config.models.feature-list-hint')}</small></div></div><div class="feature-model-list">${featureRows || '<div class="empty compact-empty">' + t('config.models.no-features') + '</div>'}</div></div><div class="model-save-row"><button class="button primary" id="saveFeatureAssignments">${saveLabel}</button></div></div>`
}


function renderModels() {
  const providers = settings.providers || []
  if (!providers.length) {
    view.innerHTML = `<div class="page">${pageHeader(t('config.route.models'), t('config.models.description'))}${renderModelsSubnav()}<div class="models-view"><div class="empty">${t('config.models.no-providers')}</div><button class="button primary" id="addFirstProvider">${t('config.models.add-first-provider')}</button></div></div>`
    document.getElementById('addFirstProvider').onclick = () => {
      const provider = { id: createModelProviderId(), name: t('config.models.new-provider'), baseUrl: '', hasApiKey: false, protocol: 'openai-chat', enabled: true, builtin: false, models: [{ id: '', name: '' }] }
      settings = { ...settings, providers: [provider] }
      modelsExpandedProviderIds = new Set([provider.id])
      modelsTab = 'providers'
      renderModels()
    }
    return
  }
  const content = modelsTab === 'features'
    ? renderModelsFeatureTab(providers)
    : renderModelsProviderTab(providers)
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.models'), t('config.models.description-managed'))}${renderModelsSubnav()}${content}</div>`

  document.querySelectorAll('[data-models-tab]').forEach((button) => {
    button.onclick = () => {
      const nextTab = button.dataset.modelsTab
      if (nextTab === modelsTab) return
      if (modelsTab === 'providers' && !commitOpenProviderEditors()) return
      modelsTab = nextTab
      renderModels()
    }
  })

  if (modelsTab === 'providers') {
    bindModelsProviderTab()
  } else {
    bindModelsFeatureTab()
  }
}


// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['bootstrapModels'] = () => bootstrapModels()
