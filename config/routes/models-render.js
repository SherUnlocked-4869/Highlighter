// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models（模型）渲染：子导航、供应商面板、功能模型面板。

let modelsTab = 'providers'
let modelsExpandedProviderIds = new Set()
let featureAssignmentDraft = null

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
  const id = escapeHtml(provider.id)
  const header = `<button type="button" class="model-provider-accordion-head" data-expand-provider="${id}" aria-expanded="${expanded}"><span class="model-provider-expand" aria-hidden="true">${expanded ? '▾' : '▸'}</span><span class="model-provider-item-name">${escapeHtml(provider.name || t('config.models.new-provider'))}</span>${providerBadgesMarkup(provider)}<span class="provider-head-status"><span class="provider-dot ${status.className}"></span>${escapeHtml(t(status.title))}</span></button>`
  if (!expanded) return `<article class="model-provider-accordion" data-provider-editor="${id}">${header}</article>`
  const modelCount = provider.models.filter((model) => model.id).length
  const headerText = Object.entries(provider.headers || {}).map(([key, value]) => `${key}: ${value}`).join('\n')
  const keyPlaceholder = provider.apiKey || provider.hasApiKey ? t('config.models.api-key-configured-placeholder') : 'sk-…'
  const hasDefaults = defaultModelsForProvider(provider).length > 0
  return `<article class="model-provider-accordion expanded" data-provider-editor="${id}">
    ${header}
    <div class="model-provider-editor">
      <div class="model-provider-editor-head">
        <b>${t('config.models.connection')}</b>
        <div class="model-provider-actions">
          <select data-provider-enabled aria-label="${t('config.models.enabled-status')}">
            <option value="true" ${provider.enabled !== false ? 'selected' : ''}>${t('config.models.enabled')}</option>
            <option value="false" ${provider.enabled === false ? 'selected' : ''}>${t('config.models.disabled')}</option>
          </select>
          <button class="button danger" data-delete-provider="${id}">${t('config.models.delete-provider')}</button>
        </div>
      </div>
      <label class="model-field"><span class="model-field-label"><b>${t('config.models.display-name')}</b></span><input class="input" data-provider-name type="text" maxlength="100" value="${escapeHtml(provider.name)}"></label>
      <label class="model-field"><span class="model-field-label"><b>${t('config.models.api-url')}</b><small>${t('config.models.base-url-hint')}</small></span><input class="input" data-provider-base-url type="url" spellcheck="false" maxlength="2048" value="${escapeHtml(provider.baseUrl)}" placeholder="https://api.example.com/v1"></label>
      <label class="model-field"><span class="model-field-label"><b>${t('config.models.api-protocol')}</b></span>
        <select data-provider-protocol>
          <option value="openai-chat" ${provider.protocol === 'openai-chat' ? 'selected' : ''}>OpenAI Chat Completions</option>
          <option value="openai-responses" ${provider.protocol === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
        </select>
      </label>
      <label class="model-field"><span class="model-field-label"><b>${t('config.models.api-key')}</b><small>${t('config.models.key-local-hint')}</small></span><input class="input" data-provider-api-key type="password" maxlength="512" autocomplete="off" placeholder="${escapeHtml(keyPlaceholder)}"></label>
      <details class="model-custom-details">
        <summary>${t('config.models.advanced-connection')}</summary>
        <label class="model-field"><span class="model-field-label"><b>${t('config.models.custom-headers')}</b><small>${t('config.models.headers-hint')}</small></span><textarea class="input" data-provider-headers rows="3" maxlength="3300" spellcheck="false" placeholder="X-Title: Highlighter">${escapeHtml(headerText)}</textarea></label>
      </details>
      <div class="model-field">
        <label class="model-field-label" for="test-model-${id}"><b>${t('config.models.test-model')}</b></label>
        <div class="model-field-control"><select id="test-model-${id}" data-provider-test-model></select><button class="button" data-test-provider="${id}">${t('config.models.test')}</button></div>
      </div>
      <div class="model-catalog-block">
        <div class="model-catalog-head">
          <div><b>${t('config.models.catalog')}</b><small>${modelCount ? t('config.models.catalog-count', { count: modelCount }) : t('config.models.catalog-empty')}</small></div>
          <div class="model-catalog-actions">
            ${hasDefaults ? `<button class="button" data-restore-models="${id}">${t('config.models.restore-models')}</button>` : ''}
            <button class="button" data-fetch-models="${id}">${t('config.models.fetch-models')}</button>
            <button class="button" data-add-provider-model="${id}">${t('config.models.add-model')}</button>
          </div>
        </div>
        <div class="model-catalog-list">${provider.models.map((model, index) => modelCatalogRowMarkup(provider, index)).join('')}</div>
      </div>
    </div>
  </article>`
}

function renderModelsSubnav() {
  return `<div class="tabs models-subnav"><button aria-pressed="${modelsTab === 'providers'}" data-models-tab="providers">${t('config.models.tab-providers')}</button><button aria-pressed="${modelsTab === 'features'}" data-models-tab="features">${t('config.models.tab-features')}</button><button aria-pressed="${modelsTab === 'defaults'}" data-models-tab="defaults">${t('config.models.tab-defaults')}</button></div>`
}

// D02: the credentials banner. The page has to say WHY a key may not survive a restart,
// because "saved" and "saved for this session" look identical otherwise.
function credentialNoticeMarkup() {
  const state = settings.credentialState || {}
  const notices = []
  if (state.decryptFailed) notices.push('config.models.credential-decrypt-failed')
  else if (state.encryptionAvailable === false) notices.push('config.models.credential-session-only')
  if (state.encryptionFailed) notices.push('config.models.credential-encryption-failed')
  // D02 (04): a value that replaced a stored one but could not be written yet. The restart
  // behaviour has to be spelled out: the temporary value disappears and the still-stored old
  // one only applies to the configuration it was entered for.
  const overrides = state.sessionOverrides && typeof state.sessionOverrides === 'object'
    ? state.sessionOverrides
    : null
  if (overrides && Array.isArray(overrides.replaced) && overrides.replaced.length) {
    notices.push('config.models.credential-session-override')
  }
  if (overrides && Array.isArray(overrides.cleared) && overrides.cleared.length) {
    notices.push('config.models.credential-session-cleared')
  }
  if (state.legacyPlaintext) notices.push('config.models.credential-legacy-plaintext')
  return notices.map((key) => `<div class="update-guidance warning" data-credential-notice>${t(key)}</div>`).join('')
}

function renderModelsProviderTab(providers) {
  const providerList = providers.map((provider) => providerEditorMarkup(provider)).join('') || '<div class="empty">' + t('config.models.no-providers') + '</div>'
  const editing = modelsExpandedProviderIds.size > 0 || configDirtyReasons.has('models-provider-settings')
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>${t('config.models.providers-section')}</h2><p>${t('config.models.providers-description')}</p></div><div class="models-toolbar-actions action-group"><button class="button subtle" id="openModelConfigFile">${t('config.models.open-config-file')}</button><button class="button" id="addCodingPlanProvider">${iconMarkup('icons/lightning.svg')}${t('config.models.add-coding-plan')}</button><button class="button${editing ? '' : ' primary'}" id="addModelProvider">${t('config.models.add-provider')}</button></div></div><div class="model-provider-list-page">${providerList}</div><div class="model-save-row"><button class="button${editing ? ' primary' : ''}" id="saveProviderSettings">${t('config.models.save-providers')}</button></div></div>`
}

function renderModelsFeatureTab(providers) {
  const featureRows = modelFeatureRows().map((feature) => featureAssignmentMarkup(feature, providers)).join('')
  const saveLabel = featureAssignmentDraft ? t('config.models.save-features-dirty') : t('config.models.save-features')
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>${t('config.models.features-section')}</h2><p>${t('config.models.features-description')}</p></div></div><div class="card feature-model-card"><div class="feature-model-head"><div><b>${t('config.models.feature-list')}</b><small>${t('config.models.feature-list-hint')}</small></div></div><div class="feature-model-list">${featureRows || '<div class="empty compact-empty">' + t('config.models.no-features') + '</div>'}</div></div><div class="model-save-row"><button class="button primary" id="saveFeatureAssignments">${saveLabel}</button></div></div>`
}


// The defaults tab absorbs the AI sampling parameters that used to sit on the
// function-settings page. Every row saves on change, so the tab has no save button.
function renderModelsDefaultsTab() {
  const languageOptions = [['中文', 'config.language.zh'], ['英文', 'config.language.en'], ['日文', 'config.language.ja'], ['韩文', 'config.language.ko'], ['繁体中文', 'config.language.zh-hant']]
    .map(([value, label]) => `<option value="${value}" ${settings.ai.targetLanguage === value ? 'selected' : ''}>${t(label)}</option>`)
    .join('')
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>${t('config.models.tab-defaults')}</h2><p>${t('config.models.defaults-description')}</p></div></div><div class="card form-card"><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ai-max-tokens')}</b></div><input id="aiMaxTokens" type="number" value="${settings.ai.maxTokens}"></div><div class="form-row"><div class="form-label"><b>Temperature</b></div><input id="aiTemperature" type="number" min="0" max="2" step="0.1" value="${settings.ai.temperature}"></div><div class="form-row"><div class="form-label"><b>${t('config.function-settings.ai-target-language')}</b></div><select id="aiTargetLanguage">${languageOptions}</select></div><div class="form-row"><div class="form-label"><small>${t('config.models.prompt-settings-link')}</small></div><button class="button" id="openPromptSettings">${t('config.route.selection-toolbar')}</button></div></div></div>`
}

function bindModelsDefaultsTab() {
  document.getElementById('aiMaxTokens').onchange = (event) => updateSettings({ ai: { maxTokens: Number(event.target.value) } })
  document.getElementById('aiTemperature').onchange = (event) => updateSettings({ ai: { temperature: Number(event.target.value) } })
  document.getElementById('aiTargetLanguage').onchange = (event) => updateSettings({ ai: { targetLanguage: event.target.value } })
  document.getElementById('openPromptSettings').onclick = () => navigate('selection-toolbar')
}

function bindModelsSubnav() {
  document.querySelectorAll('[data-models-tab]').forEach((button) => {
    button.onclick = () => {
      const nextTab = button.dataset.modelsTab
      if (nextTab === modelsTab) return
      // Leaving the providers tab commits the open editors first (same contract as
      // before); the defaults tab has no draft editor to commit.
      if (modelsTab === 'providers' && !commitOpenProviderEditors()) return
      modelsTab = nextTab
      renderModels()
      document.querySelector(`[data-models-tab="${nextTab}"]`)?.focus({ preventScroll: true })
    }
  })
}

function renderModels() {
  const providers = settings.providers || []
  const description = providers.length ? t('config.models.description-managed') : t('config.models.description')
  // The defaults tab stays reachable without a provider; only the provider-driven
  // tabs fall back to the empty state.
  if (!providers.length && modelsTab !== 'defaults') {
    view.innerHTML = `<div class="page">${pageHeader(t('config.route.models'), description)}${credentialNoticeMarkup()}${renderModelsSubnav()}<div class="models-view"><div class="empty">${t('config.models.no-providers')}</div><button class="button primary" id="addFirstProvider">${t('config.models.add-first-provider')}</button></div></div>`
    document.getElementById('addFirstProvider').onclick = openProviderPresetDialog
    bindModelsSubnav()
    return
  }
  if (modelsTab === 'defaults') {
    view.innerHTML = `<div class="page">${pageHeader(t('config.route.models'), description)}${credentialNoticeMarkup()}${renderModelsSubnav()}${renderModelsDefaultsTab()}</div>`
    bindModelsSubnav()
    bindModelsDefaultsTab()
    return
  }
  const content = modelsTab === 'features'
    ? renderModelsFeatureTab(providers)
    : renderModelsProviderTab(providers)
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.models'), description)}${credentialNoticeMarkup()}${renderModelsSubnav()}${content}</div>`
  bindModelsSubnav()
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
