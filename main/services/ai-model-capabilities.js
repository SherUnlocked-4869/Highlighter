const AI_MODEL_TASKS = Object.freeze(['chat', 'translation', 'explain'])
const AI_REASONING_MODES = Object.freeze(['none', 'deepseek', 'openai-responses'])

function isTranslationOnlyModelId(value) {
  return /hunyuan-mt|hy-mt|qwen-mt|mt-7b/i.test(String(value || ''))
}

function inferReasoningMode({ providerId = '', baseUrl = '', protocol = '' } = {}) {
  if (protocol === 'openai-responses') return 'openai-responses'
  if (String(providerId).toLowerCase() === 'deepseek' || /deepseek/i.test(String(baseUrl))) return 'deepseek'
  return 'none'
}

function normalizeModelCapabilities(value, context = {}) {
  const configured = value && typeof value === 'object' ? value : {}
  const identity = `${context.modelId || ''} ${context.modelName || ''}`
  const defaultTasks = isTranslationOnlyModelId(identity) ? ['translation'] : [...AI_MODEL_TASKS]
  const tasks = [...new Set((Array.isArray(configured.tasks) ? configured.tasks : defaultTasks)
    .filter((task) => AI_MODEL_TASKS.includes(task)))]
  const inferredReasoning = inferReasoningMode(context)
  const reasoning = AI_REASONING_MODES.includes(configured.reasoning) ? configured.reasoning : inferredReasoning
  return { tasks: tasks.length ? tasks : defaultTasks, reasoning }
}

function modelSupportsTask(model, task) {
  if (!AI_MODEL_TASKS.includes(task)) return true
  const tasks = model?.capabilities?.tasks
  return !Array.isArray(tasks) || tasks.includes(task)
}

function taskForFeature(feature) {
  const id = String(feature || '')
  if (id === 'translation' || id === 'ocr-translate' || id === 'toolbar:translate') return 'translation'
  if (id === 'toolbar:explain' || id.startsWith('custom:')) return 'explain'
  return 'chat'
}

module.exports = {
  AI_MODEL_TASKS,
  AI_REASONING_MODES,
  inferReasoningMode,
  isTranslationOnlyModelId,
  modelSupportsTask,
  normalizeModelCapabilities,
  taskForFeature
}
