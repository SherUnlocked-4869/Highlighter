const AI_MODEL_TASKS = Object.freeze(['chat', 'translation', 'explain'])
const AI_REASONING_MODES = Object.freeze(['none', 'deepseek', 'siliconflow', 'openai-responses'])

function isTranslationOnlyModelId(value) {
  return /hunyuan-mt|hy-mt|qwen-mt|mt-7b/i.test(String(value || ''))
}

function isSiliconFlowThinkingModel({ baseUrl = '', modelId = '', modelName = '' } = {}) {
  if (!/siliconflow\.(?:cn|com)/i.test(String(baseUrl))) return false
  return /deepseek-ai\/deepseek-v(?:3\.(?:1|2)|4)(?:[-./]|$)/i.test(`${modelId} ${modelName}`)
}

function inferReasoningMode({ providerId = '', baseUrl = '', protocol = '', modelId = '', modelName = '' } = {}) {
  if (protocol === 'openai-responses') return 'openai-responses'
  if (isSiliconFlowThinkingModel({ baseUrl, modelId, modelName })) return 'siliconflow'
  if (String(providerId).toLowerCase() === 'deepseek' || /deepseek/i.test(String(baseUrl))) return 'deepseek'
  return 'none'
}

// Vision (image → text) capability, 2026-10-18 snow migration §6.2②.
//
// The flag is stored, never guessed at request time: a provider that cannot take
// an image_url part answers with an opaque 400, so the renderer has to know
// which models it may offer the action for. When nothing is stored the flag
// falls back to a conservative *false* - the user opts a model in on the model
// page, which is the only place that knows whether the vendor supports images.
function normalizeVisionCapability(value) {
  return value === true
}

function normalizeModelCapabilities(value, context = {}) {
  const configured = value && typeof value === 'object' ? value : {}
  const identity = `${context.modelId || ''} ${context.modelName || ''}`
  const defaultTasks = isTranslationOnlyModelId(identity) ? ['translation'] : [...AI_MODEL_TASKS]
  const tasks = [...new Set((Array.isArray(configured.tasks) ? configured.tasks : defaultTasks)
    .filter((task) => AI_MODEL_TASKS.includes(task)))]
  const inferredReasoning = inferReasoningMode(context)
  const configuredReasoning = AI_REASONING_MODES.includes(configured.reasoning) ? configured.reasoning : ''
  const reasoning = inferredReasoning !== 'none' ? inferredReasoning : (configuredReasoning || inferredReasoning)
  // `vision` is attached ONLY when it is on. Every catalog in the wild was written
  // before this key existed, and a permanent `vision: false` would rewrite the
  // whole stored catalog on the first read and churn every settings snapshot and
  // fixture. Off is the default the readers already apply.
  const capabilities = { tasks: tasks.length ? tasks : defaultTasks, reasoning }
  if (configured.vision === true) capabilities.vision = true
  return capabilities
}

function modelSupportsTask(model, task) {
  if (!AI_MODEL_TASKS.includes(task)) return true
  const tasks = model?.capabilities?.tasks
  return !Array.isArray(tasks) || tasks.includes(task)
}

// A model can convert an image only when the user declared it. `tasks` is about
// text features and says nothing about multimodal input.
function modelSupportsVision(model) {
  return model?.capabilities?.vision === true
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
  isSiliconFlowThinkingModel,
  isTranslationOnlyModelId,
  modelSupportsTask,
  modelSupportsVision,
  normalizeModelCapabilities,
  normalizeVisionCapability,
  taskForFeature
}
