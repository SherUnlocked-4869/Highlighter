// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models（模型）渲染：子导航、供应商面板、功能模型面板。

let modelsTab = 'providers'
let modelsExpandedProviderIds = new Set()
let featureAssignmentDraft = null
let codingPlanPresetId = ''

const modelFeatureCatalog = [
  { id: 'chat', label: 'AI 对话', description: '主界面的多轮 AI 对话' },
  { id: 'translation', label: '翻译工具', description: '翻译窗口与选中文本快速翻译' },
  { id: 'ocr-translate', label: '截图 OCR 翻译', description: '截图识别文字后调用翻译' },
  { id: 'toolbar:translate', label: '划词翻译', description: '划词工具栏“翻译”按钮' },
  { id: 'toolbar:explain', label: '划词解释', description: '划词工具栏“解释”按钮' }
]

function providerEditorMarkup(provider) {
  const expanded = modelsExpandedProviderIds.has(provider.id)
  const status = modelProviderStatus(provider)
  if (!expanded) {
    return `<article class="model-provider-accordion" data-provider-editor="${escapeHtml(provider.id)}"><div class="model-provider-accordion-head" data-expand-provider="${escapeHtml(provider.id)}" role="button" tabindex="0" title="点击展开供应商配置"><span class="model-provider-expand">▸</span><span class="model-provider-item-name">${escapeHtml(provider.name)}</span>${providerBadgesMarkup(provider)}<span class="provider-head-status"><span class="provider-dot ${status.className}"></span>${escapeHtml(status.title)}</span><span class="model-provider-chevron">展开</span></div></article>`
  }
  return `<article class="model-provider-accordion expanded" data-provider-editor="${escapeHtml(provider.id)}"><div class="model-provider-accordion-head" data-expand-provider="${escapeHtml(provider.id)}" role="button" tabindex="0" title="点击收起供应商配置"><span class="model-provider-expand">▾</span><span class="model-provider-item-name">${escapeHtml(provider.name)}</span><span class="provider-head-status"><span class="provider-dot ${status.className}"></span>${escapeHtml(status.title)}</span><span class="model-provider-chevron">收起</span></div><div class="model-provider-editor"><div class="model-provider-editor-head"><div class="model-provider-title"><b>${escapeHtml(provider.name)}</b><span class="provider-tag ${provider.builtin ? 'builtin' : ''}">${provider.builtin ? '内置' : '自定义'}</span>${providerBadgesMarkup(provider)}<span class="provider-dot ${status.className}" title="${escapeHtml(status.title)}"></span></div><button class="button danger" data-delete-provider="${escapeHtml(provider.id)}">删除供应商</button></div><div class="model-field"><div class="model-field-label"><b>API 密钥</b><small>通过系统安全存储加密保存在本机</small></div><div class="model-field-control"><input class="input" data-provider-api-key type="password" value="" placeholder="${escapeHtml((provider.apiKey || provider.hasApiKey) ? '已配置——输入新值可替换' : 'sk-...')}"><button class="button" data-test-provider="${escapeHtml(provider.id)}">测试</button></div></div><details class="model-custom-details" open><summary>自定义设置</summary><div class="model-field"><div class="model-field-label"><b>启用状态</b></div><select data-provider-enabled><option value="true" ${provider.enabled !== false ? 'selected' : ''}>启用</option><option value="false" ${provider.enabled === false ? 'selected' : ''}>停用</option></select></div><div class="model-field"><div class="model-field-label"><b>显示名称</b></div><input class="input" data-provider-name type="text" value="${escapeHtml(provider.name)}" placeholder="例如：DeepSeek"></div><div class="model-field"><div class="model-field-label"><b>API 地址</b></div><input class="input" data-provider-base-url type="text" value="${escapeHtml(provider.baseUrl)}" placeholder="https://api.example.com/v1"></div><div class="model-field"><div class="model-field-label"><b>API 协议</b></div><select data-provider-protocol><option value="openai-chat" ${provider.protocol === 'openai-chat' ? 'selected' : ''}>openai-chat</option><option value="openai-responses" ${provider.protocol === 'openai-responses' ? 'selected' : ''}>openai-responses</option></select></div></details><div class="model-catalog-block"><div class="model-catalog-head"><div><b>模型目录</b><small>${provider.models.length ? '已自定义模型目录' : '尚未配置模型'}</small></div><div class="model-catalog-actions"><button class="button" data-restore-models="${escapeHtml(provider.id)}">恢复默认模型</button><button class="button" data-fetch-models="${escapeHtml(provider.id)}">获取可用模型</button></div></div><div class="model-catalog-list">${provider.models.map((model, index) => modelCatalogRowMarkup(provider, index)).join('')}</div><button class="button" data-add-provider-model="${escapeHtml(provider.id)}">＋ 添加模型</button></div></div></article>`
}

function renderModelsSubnav() {
  return `<div class="models-subnav"><button class="${modelsTab === 'providers' ? 'active' : ''}" data-models-tab="providers">供应商</button><button class="${modelsTab === 'features' ? 'active' : ''}" data-models-tab="features">功能模型</button></div>`
}

function renderModelsProviderTab(providers) {
  const providerList = providers.map((provider) => providerEditorMarkup(provider)).join('') || '<div class="empty">暂无供应商，请点击“添加供应商”创建。</div>'
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>供应商</h2><p>列表默认只显示名称，点击展开后配置显示名称、API 地址、API 协议、密钥和模型目录。Coding Plan 套餐可一键接入。</p></div><div class="models-toolbar-actions"><button class="button" id="openModelConfigFile">打开配置文件</button><button class="button" id="addCodingPlanProvider">${iconMarkup('icons/lightning.svg')}添加 Coding Plan</button><button class="button primary" id="addModelProvider">＋ 添加供应商</button></div></div><div class="model-provider-list-page">${providerList}</div><div class="model-save-row"><button class="button primary" id="saveProviderSettings">保存供应商配置</button></div></div>`
}

function renderModelsFeatureTab(providers) {
  const featureRows = modelFeatureRows().map((feature) => featureAssignmentMarkup(feature, providers)).join('')
  const saveLabel = featureAssignmentDraft ? '保存功能模型（有未保存更改）' : '保存功能模型'
  return `<div class="models-view"><div class="models-provider-toolbar"><div class="models-section-head"><h2>功能模型</h2><p>为每个 AI 功能单独指定供应商；模型选项来自该供应商的模型目录。</p></div></div><div class="card feature-model-card"><div class="feature-model-head"><div><b>AI 功能列表</b><small>划词功能包含内置功能与自定义划词功能</small></div></div><div class="feature-model-list">${featureRows || '<div class="empty compact-empty">暂无可配置的 AI 功能</div>'}</div></div><div class="model-save-row"><button class="button primary" id="saveFeatureAssignments">${saveLabel}</button></div></div>`
}


function renderModels() {
  const providers = settings.providers || []
  if (!providers.length) {
    view.innerHTML = `<div class="page">${pageHeader('模型', '配置 AI 供应商并为不同功能分配模型。')}${renderModelsSubnav()}<div class="models-view"><div class="empty">暂无供应商，请点击“添加供应商”创建。</div><button class="button primary" id="addFirstProvider">添加供应商</button></div></div>`
    document.getElementById('addFirstProvider').onclick = () => {
      const provider = { id: createModelProviderId(), name: '新供应商', baseUrl: '', hasApiKey: false, protocol: 'openai-chat', enabled: true, builtin: false, models: [{ id: '', name: '' }] }
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
  view.innerHTML = `<div class="page">${pageHeader('模型', '管理 AI 供应商，并为对话、翻译和划词功能分别指定模型。')}${renderModelsSubnav()}${content}</div>`

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
