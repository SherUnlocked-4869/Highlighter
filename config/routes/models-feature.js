// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 models：功能模型面板的事件绑定。

function bindModelsFeatureTab() {
  const markFeatureAssignmentsDirty = () => {
    featureAssignmentDraft = snapshotFeatureAssignments()
    const button = document.getElementById('saveFeatureAssignments')
    if (button) button.textContent = t('config.models.save-features-dirty')
  }
  const persistFeatureAssignments = async () => {
    const assignments = readFeatureAssignments()
    if (!assignments) return false
    try {
      settings = await updateSettings({
        ai: {
          schemaVersion: 2,
          assignments
        }
      }, t('config.models.features-saved'))
      featureAssignmentDraft = null
      return true
    } catch (error) {
      toast(errorMessage(error) || t('config.models.features-save-failed'))
      return false
    }
  }
  document.querySelectorAll('[data-feature-provider]').forEach((select) => {
    select.onchange = () => {
      const feature = select.dataset.featureProvider
      const provider = modelProviderById(select.value)
      const modelSelect = document.querySelector(`[data-feature-model="${feature}"]`)
      if (!modelSelect) return
      modelSelect.innerHTML = modelOptionsMarkup(provider, '', feature)
      markFeatureAssignmentsDirty()
    }
  })
  document.querySelectorAll('[data-feature-model]').forEach((select) => {
    select.onchange = markFeatureAssignmentsDirty
  })
  document.getElementById('saveFeatureAssignments')?.addEventListener('click', async () => {
    if (await persistFeatureAssignments()) renderModels()
  })
}
