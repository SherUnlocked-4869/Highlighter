'use strict'

const { normalizeProviderInput } = require('./ai/client')
const { modelSupportsTask } = require('./ai-model-capabilities')

// First version keeps these as module constants. The second version may let
// `selectionToolbar.conversation` override the turn limit (see the design doc).
const MAX_FOLLOW_UP_TURNS = 10
const MAX_QUESTION_LENGTH = 2000
const MAX_CONTEXT_CHARS = 24000
// Clipboard writes are bounded on both sides of the bridge: the preload clamps
// what the renderer may send, and this bounds what the main process will write.
const MAX_CONVERSATION_COPY_LENGTH = 65536
const FOLLOW_UP_TASK = 'chat'
const CUSTOM_ACTION_PREFIX = 'custom:'
const DISABLED_REASONS = Object.freeze({
  noFirstResult: '首次请求失败，无法继续追问，请重新划词',
  translationOnly: '当前模型仅支持翻译，无法追问。请在「模型」设置中为划词功能选择一个支持对话的模型',
  turnLimit: (maxTurns) => `已达到最大追问轮数（${maxTurns}），请重新划词开始新会话`,
  pending: '正在生成回答，请稍候',
  emptyQuestion: '追问内容不能为空',
  retryNotNewest: '只能重新生成最近一轮追问'
})

function isCustomAction(actionId) {
  return String(actionId || '').startsWith(CUSTOM_ACTION_PREFIX)
}

// The follow-up round must not reuse the first round's system prompt: the
// translation prompt forbids anything but the translation, and the explain
// template is a fixed three-section outline. Both would make the model refuse
// to answer a follow-up question.
function describeOriginalTask({ actionId, label, translateLanguages } = {}) {
  const id = String(actionId || '')
  if (id === 'translate') {
    const source = !translateLanguages?.source || translateLanguages.source === 'auto'
      ? '自动识别'
      : translateLanguages.source
    const target = translateLanguages?.target || '中文'
    return `划词翻译（${source} → ${target}）`
  }
  if (id === 'explain') return '划词解释'
  if (isCustomAction(id)) return `自定义指令：${label || ''}`
  return `划词${label || ''}`
}

function buildConversationSystemPrompt({ actionId, label, prompt, translateLanguages } = {}) {
  const lines = [
    '你正在「划词助手」的结果窗口中继续对话。',
    `用户此前划选了一段文本并执行了「${label || '划词'}」操作，你已回答（见上文助手消息）。`,
    '现在请直接回答用户的追问：可以引用原文或你此前的回答；不要重复输出此前的完整回答。',
    '使用与用户提问相同的语言回答。',
    '',
    `【原始任务】${describeOriginalTask({ actionId, label, translateLanguages })}`
  ]
  // A custom prompt carries the user's real intent, so it stays available as
  // context. The built-ins keep theirs out to avoid colliding with the
  // "translate only" / three-section instructions.
  if (isCustomAction(actionId) && typeof prompt === 'string' && prompt.trim()) {
    lines.push('', '【原始任务的指令】', prompt.trim())
  }
  return lines.join('\n')
}

// Capability gate. resolveAiAssignment returns `{ ...provider, model, apiKey }`,
// so the capabilities live on `provider.models[i].capabilities` rather than on
// the returned object itself: go through normalizeProviderInput so this matches
// exactly what createFollowUpStream will decide.
//
// The user's own switch is checked first: turning follow-up off is an explicit
// intent and must win over any model capability reasoning.
function resolveFollowUpSupport(provider, { conversation } = {}) {
  if (conversation?.enabled === false) {
    return { canFollowUp: false, reason: '划词追问已在设置中关闭' }
  }
  if (!provider) return { canFollowUp: false, reason: '当前功能未配置可用的模型供应商' }
  const config = normalizeProviderInput(provider)
  if (!config.enabled) return { canFollowUp: false, reason: '该功能指定的模型供应商已禁用' }
  if (!config.baseUrl) return { canFollowUp: false, reason: '该功能未配置可用的模型供应商或 API 地址' }
  if (!config.apiKey) return { canFollowUp: false, reason: '请先在“模型”设置中为该功能配置 API 密钥' }
  if (!config.model) return { canFollowUp: false, reason: '请先在“模型”设置中为该供应商配置模型' }
  if (!modelSupportsTask({ capabilities: config.capabilities }, FOLLOW_UP_TASK)) {
    return { canFollowUp: false, reason: DISABLED_REASONS.translationOnly }
  }
  return { canFollowUp: true, reason: '' }
}

function pairLength(pair) {
  return String(pair?.question ?? '').length + String(pair?.answer ?? '').length
}

function historyPairs(value) {
  return (Array.isArray(value) ? value : []).filter((pair) => pair && typeof pair === 'object')
}

// `budget` is the character budget left for the follow-up pairs once the fixed
// part (system prompt + source text + first result + current question) is paid
// for. Whole pairs are dropped from the oldest end; a half pair is never kept.
// When the fixed part alone already exceeds the total budget nothing is trimmed
// — the anchor is what gives the model its context, so losing it is worse.
function trimHistory(history, budget) {
  const pairs = historyPairs(history)
  if (!(budget > 0)) return pairs.slice()
  const kept = []
  let used = 0
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const size = pairLength(pairs[index])
    if (used + size > budget) break
    used += size
    kept.unshift(pairs[index])
  }
  return kept
}

// Returns `{ messages, omittedPairs }`: the dropped count is what the renderer
// turns into "已省略更早的 N 轮对话", so trimming must never be silent.
function buildFollowUpMessages({ conversation, question }) {
  const systemPrompt = String(conversation?.systemPrompt ?? '')
  const text = String(conversation?.text ?? '')
  const firstResult = String(conversation?.firstResult ?? '')
  const questionText = String(question ?? '').trim()
  const configured = Number(conversation?.maxContextChars)
  const budget = configured > 0 ? configured : MAX_CONTEXT_CHARS
  const pairs = historyPairs(conversation?.history)
  const history = trimHistory(pairs, budget - systemPrompt.length - text.length - firstResult.length - questionText.length)
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
    { role: 'assistant', content: firstResult }
  ]
  for (const pair of history) {
    messages.push({ role: 'user', content: pair.question }, { role: 'assistant', content: pair.answer })
  }
  messages.push({ role: 'user', content: questionText })
  return { messages, omittedPairs: pairs.length - history.length }
}

// A cancelled round has to be reported to the renderer, because main.js notifies
// nobody on window-hidden / window-closed / game-mode. Electron never fires
// visibilitychange for BrowserWindow.hide(), so the renderer cannot self-heal:
// without this the round sits in "generating" until the 30s idle timeout and
// then blames the network. Both rounds share this path so they cannot drift.
// window-closed / game-mode stay silent — the window is going away.
function reportCancelledTurn({ controller, win, queueMessage = () => {} } = {}) {
  if (!controller?.cancelled || win?.isDestroyed()) return false
  if (controller.cancelReason === 'user-cancelled') {
    queueMessage('stream:error', { error: '已停止生成', cancelled: true })
    return true
  }
  if (controller.cancelReason === 'window-hidden') {
    queueMessage('stream:error', { error: '窗口已隐藏，生成已中断', cancelled: true, interrupted: true })
    return true
  }
  return false
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function boundConversationCopyText(text) {
  return typeof text === 'string' ? text.slice(0, MAX_CONVERSATION_COPY_LENGTH) : ''
}

class ActionConversation {
  constructor({
    streamId,
    action,
    text,
    provider,
    translateLanguages = {},
    thinking = 'off',
    support = { canFollowUp: false, reason: '' },
    conversationConfig,
    maxFollowUpTurns,
    maxQuestionLength = MAX_QUESTION_LENGTH,
    maxContextChars = MAX_CONTEXT_CHARS
  } = {}) {
    this._streamId = Number.isSafeInteger(streamId) ? streamId : 0
    this.action = action && typeof action === 'object' ? action : {}
    this.text = String(text ?? '')
    this.provider = provider || null
    this.translateLanguages = translateLanguages && typeof translateLanguages === 'object' ? translateLanguages : {}
    this.thinking = thinking || 'off'
    this.support = support && typeof support === 'object' ? support : { canFollowUp: false, reason: '' }
    // The configured limit wins over the module default; an explicit
    // maxFollowUpTurns argument still overrides both so tests can pin a value.
    this.maxFollowUpTurns = positiveInteger(maxFollowUpTurns, positiveInteger(conversationConfig?.maxFollowUpTurns, MAX_FOLLOW_UP_TURNS))
    this.maxQuestionLength = positiveInteger(maxQuestionLength, MAX_QUESTION_LENGTH)
    this.maxContextChars = positiveInteger(maxContextChars, MAX_CONTEXT_CHARS)
    this.history = []
    this.firstResultContent = ''
    this.pending = null
    this.systemPrompt = buildConversationSystemPrompt({
      actionId: this.action.id,
      label: this.action.label,
      prompt: this.action.prompt,
      translateLanguages: this.translateLanguages
    })
  }

  get streamId() {
    return this._streamId
  }

  get firstResult() {
    return this.firstResultContent
  }

  get followUpCount() {
    return this.history.length + (this.pending ? 1 : 0)
  }

  get isTurnPending() {
    return this.pending !== null
  }

  get canFollowUp() {
    return this.disabledReason() === ''
  }

  disabledReason() {
    if (!this.firstResultContent.trim()) return DISABLED_REASONS.noFirstResult
    if (!this.support.canFollowUp) return this.support.reason || DISABLED_REASONS.translationOnly
    if (this.followUpCount >= this.maxFollowUpTurns) return DISABLED_REASONS.turnLimit(this.maxFollowUpTurns)
    if (this.isTurnPending) return DISABLED_REASONS.pending
    return ''
  }

  get status() {
    const reason = this.disabledReason()
    return {
      canFollowUp: reason === '',
      disabledReason: reason,
      followUpCount: this.followUpCount,
      maxFollowUpTurns: this.maxFollowUpTurns,
      questionMaxLength: this.maxQuestionLength
    }
  }

  // The renderer only needs the capability gate plus the limits; the turn count
  // is something it tracks itself as the conversation moves on.
  followUpConfig() {
    const status = this.status
    return {
      enabled: this.support.canFollowUp === true,
      disabledReason: this.support.canFollowUp === true ? '' : (this.support.reason || DISABLED_REASONS.translationOnly),
      maxTurns: status.maxFollowUpTurns,
      questionMaxLength: status.questionMaxLength
    }
  }

  commitFirstResult(content) {
    this.firstResultContent = String(content ?? '')
    return this.firstResultContent
  }

  // The messages are built here rather than in buildMessages() because the
  // renderer needs to know how many pairs were dropped *before* the stream
  // starts: chat:turn is what opens the round and paints the notice.
  //
  // `replaceLast` regenerates the newest round: that pair is dropped before the
  // new one is built, so it is never answered against its own previous attempt.
  beginTurn(question, { replaceLast = false } = {}) {
    const value = typeof question === 'string' ? question.trim().slice(0, this.maxQuestionLength) : ''
    if (!value) return { ok: false, reason: DISABLED_REASONS.emptyQuestion, rejected: true }
    // Replacing anything but the newest round would invalidate every answer
    // after it, and the question has to match or the request and the session
    // have drifted apart. Both are refused before anything is touched.
    const replaced = replaceLast ? this.history.at(-1) : null
    if (replaceLast) {
      if (!replaced || replaced.question !== value) {
        return { ok: false, reason: DISABLED_REASONS.retryNotNewest, rejected: true }
      }
      this.history.pop()
    }
    // Checked after the drop: a regenerated round frees its own slot, so being
    // at the turn limit must not block it.
    const reason = this.disabledReason()
    if (reason) {
      if (replaced) this.history.push(replaced)
      return { ok: false, reason, rejected: true }
    }
    const built = buildFollowUpMessages({ conversation: this, question: value })
    this.pending = { question: value, content: '', built, omittedPairs: built.omittedPairs }
    return {
      ok: true,
      question: value,
      omittedPairs: built.omittedPairs,
      // Assembled here so the payload the renderer depends on is unit-testable
      // and main.js only forwards it.
      turnPayload: { streamId: this.streamId, question: value, omittedPairs: built.omittedPairs }
    }
  }

  buildMessages() {
    if (this.pending) return this.pending.built.messages
    return buildFollowUpMessages({ conversation: this, question: '' }).messages
  }

  commitTurn({ content } = {}) {
    if (!this.pending) return false
    this.history.push({ question: this.pending.question, answer: String(content ?? this.pending.content ?? '') })
    this.pending = null
    return true
  }

  // A failed or cancelled round never enters the context: the half answer would
  // pollute later rounds. The renderer still shows it, marked as such.
  rollbackTurn() {
    if (!this.pending) return false
    this.pending = null
    return true
  }
}

async function streamConversationTurn({
  conversation,
  win,
  controller,
  queueMessage = () => {},
  createStream
}) {
  if (!conversation || !win || !controller) throw new TypeError('streamConversationTurn requires a conversation, window and controller')
  const requestStream = createStream || require('./ai/client').createFollowUpStream
  let content = ''
  let failure = null
  try {
    const stream = await requestStream(conversation.provider, conversation.buildMessages(), {
      signal: controller.signal,
      thinking: conversation.thinking
    })
    controller.armTimeout()
    for await (const chunk of stream) {
      if (controller.cancelled || win.isDestroyed()) break
      controller.armTimeout()
      const delta = chunk?.choices?.[0]?.delta
      if (delta?.reasoning_content) queueMessage('stream:reasoning', { content: delta.reasoning_content })
      if (delta?.content) {
        content += delta.content
        queueMessage('stream:data', { content: delta.content })
      }
    }
  } catch (error) {
    failure = error
  }

  const destroyed = win.isDestroyed()
  if (destroyed) {
    conversation.rollbackTurn()
  } else if (!controller.cancelled && !failure) {
    queueMessage('stream:done')
    conversation.commitTurn({ content })
  } else {
    conversation.rollbackTurn()
    if (controller.cancelled) reportCancelledTurn({ controller, win, queueMessage })
    else queueMessage('stream:error', { error: failure?.message || '请求失败' })
  }
  controller.finish()
}

module.exports = {
  MAX_FOLLOW_UP_TURNS,
  MAX_QUESTION_LENGTH,
  MAX_CONTEXT_CHARS,
  MAX_CONVERSATION_COPY_LENGTH,
  FOLLOW_UP_TASK,
  ActionConversation,
  boundConversationCopyText,
  buildConversationSystemPrompt,
  buildFollowUpMessages,
  describeOriginalTask,
  reportCancelledTurn,
  resolveFollowUpSupport,
  streamConversationTurn,
  trimHistory
}
