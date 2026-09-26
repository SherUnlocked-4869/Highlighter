const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ActionConversation,
  buildConversationSystemPrompt,
  buildFollowUpMessages,
  resolveFollowUpSupport,
  trimHistory
} = require('../main/services/action-conversation')
const { resolveAiAssignment } = require('../main/services/ai-providers')

function settingsFor(modelId, feature) {
  return {
    providers: [{
      id: 'p1',
      name: 'P1',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      protocol: 'openai-chat',
      enabled: true,
      models: [{ id: modelId, name: modelId }]
    }],
    ai: { assignments: [{ feature, providerId: 'p1', model: modelId }] }
  }
}

function conversationFor(options = {}) {
  return new ActionConversation({
    streamId: 1,
    action: options.action || { id: 'explain', label: '解释', prompt: '解释提示词' },
    text: options.text === undefined ? '原文' : options.text,
    provider: options.provider || null,
    support: options.support || { canFollowUp: true, reason: '' },
    ...options
  })
}

test('follow-up prompt states the original task without borrowing the first-round prompt', () => {
  const translate = buildConversationSystemPrompt({
    actionId: 'translate',
    label: '翻译',
    prompt: '只输出译文，不添加解释',
    translateLanguages: { source: 'auto', target: '英文' }
  })
  assert.match(translate, /划词翻译（自动识别 → 英文）/)
  assert.doesNotMatch(translate, /只输出译文/)

  const custom = buildConversationSystemPrompt({
    actionId: 'custom:polish',
    label: '优化',
    prompt: '优化这段文字'
  })
  assert.match(custom, /自定义指令：优化/)
  assert.match(custom, /【原始任务的指令】\n优化这段文字/)

  const explain = buildConversationSystemPrompt({
    actionId: 'explain',
    label: '解释',
    prompt: '解释提示词全文'
  })
  assert.match(explain, /划词解释/)
  assert.doesNotMatch(explain, /解释提示词全文/)
})

test('follow-up support reads capabilities from the resolved provider models', () => {
  const mt = resolveAiAssignment(settingsFor('tencent/Hunyuan-MT-7B', 'toolbar:translate'), 'toolbar:translate')
  assert.ok(mt, 'the translation-only model is a valid assignment')
  // resolveAiAssignment spreads the provider, so capabilities stay nested under
  // `models`; reading `provider.capabilities` here would silently pass.
  assert.equal(Object.hasOwn(mt, 'capabilities'), false)
  const blocked = resolveFollowUpSupport(mt)
  assert.equal(blocked.canFollowUp, false)
  assert.match(blocked.reason, /仅支持翻译/)

  const normal = resolveAiAssignment(settingsFor('deepseek-v4-flash', 'toolbar:explain'), 'toolbar:explain')
  assert.ok(normal)
  assert.deepEqual(resolveFollowUpSupport(normal), { canFollowUp: true, reason: '' })

  assert.equal(resolveFollowUpSupport(null).canFollowUp, false)
})

test('the follow-up switch wins over model capability and blocks the round', () => {
  const normal = resolveAiAssignment(settingsFor('deepseek-v4-flash', 'toolbar:explain'), 'toolbar:explain')
  const disabled = resolveFollowUpSupport(normal, { conversation: { enabled: false, maxFollowUpTurns: 10 } })
  assert.equal(disabled.canFollowUp, false)
  assert.equal(disabled.reason, '划词追问已在设置中关闭')
  // A chat-capable model must not override the user's explicit switch.
  assert.deepEqual(resolveFollowUpSupport(normal, { conversation: { enabled: true, maxFollowUpTurns: 10 } }), {
    canFollowUp: true,
    reason: ''
  })

  const conversation = conversationFor({ support: disabled })
  conversation.commitFirstResult('结果')
  assert.equal(conversation.status.canFollowUp, false)
  assert.equal(conversation.status.disabledReason, '划词追问已在设置中关闭')
  assert.equal(conversation.beginTurn('还能问吗').ok, false)
  assert.deepEqual(conversation.followUpConfig(), {
    enabled: false,
    disabledReason: '划词追问已在设置中关闭',
    maxTurns: 10,
    questionMaxLength: 2000
  })
})

test('the turn limit comes from the conversation settings', () => {
  const conversation = conversationFor({ conversationConfig: { enabled: true, maxFollowUpTurns: 3 } })
  conversation.commitFirstResult('结果')
  assert.equal(conversation.status.maxFollowUpTurns, 3)
  for (let index = 0; index < 3; index += 1) {
    assert.equal(conversation.beginTurn(`第 ${index + 1} 问`).ok, true)
    conversation.commitTurn({ content: `答 ${index + 1}` })
  }
  const over = conversation.beginTurn('第 4 问')
  assert.equal(over.ok, false)
  assert.match(over.reason, /最大追问轮数（3）/)
  // An explicit argument still wins, so tests can pin a value without settings.
  assert.equal(conversationFor({ conversationConfig: { maxFollowUpTurns: 3 }, maxFollowUpTurns: 20 }).maxFollowUpTurns, 20)
  assert.equal(conversationFor({ conversationConfig: { maxFollowUpTurns: 'nope' } }).maxFollowUpTurns, 10)
})

test('beginTurn rejects empty, in-flight and over-limit rounds while clamping length', () => {
  const conversation = conversationFor({ maxFollowUpTurns: 2, maxQuestionLength: 5 })
  conversation.commitFirstResult('结果')

  assert.equal(conversation.beginTurn('   ').ok, false)
  assert.deepEqual(conversation.beginTurn('abcdefgh'), { ok: true, question: 'abcde' })
  assert.equal(conversation.isTurnPending, true)
  assert.equal(conversation.beginTurn('再问').ok, false)

  conversation.commitTurn({ content: '回答' })
  assert.equal(conversation.beginTurn('第二问').ok, true)
  conversation.commitTurn({ content: '回答2' })

  const over = conversation.beginTurn('第三问')
  assert.equal(over.ok, false)
  assert.equal(over.rejected, true)
  assert.match(over.reason, /最大追问轮数（2）/)
})

test('status gates follow-up on a committed first result, capability and turn count', () => {
  const noResult = conversationFor()
  assert.equal(noResult.status.canFollowUp, false)
  assert.match(noResult.status.disabledReason, /首次请求失败/)

  const translationOnly = conversationFor({ support: { canFollowUp: false, reason: '仅翻译模型可用' } })
  translationOnly.commitFirstResult('结果')
  assert.equal(translationOnly.status.canFollowUp, false)
  assert.equal(translationOnly.status.disabledReason, '仅翻译模型可用')

  const ready = conversationFor()
  ready.commitFirstResult('结果')
  assert.equal(ready.status.canFollowUp, true)
  assert.equal(ready.status.disabledReason, '')
  assert.deepEqual(ready.followUpConfig(), { enabled: true, disabledReason: '', maxTurns: 10, questionMaxLength: 2000 })

  const translationOnlyConfig = translationOnly.followUpConfig()
  assert.equal(translationOnlyConfig.enabled, false)
  assert.equal(translationOnlyConfig.disabledReason, '仅翻译模型可用')
})

test('trimHistory drops the oldest whole pairs and keeps everything when the anchor overflows', () => {
  const history = [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' }
  ]
  assert.equal(trimHistory(history, 100).length, 3)
  assert.deepEqual(trimHistory(history, 9), [history[1], history[2]])
  assert.deepEqual(trimHistory(history, 3), [])
  // A fixed part that already blows the budget is left untrimmed on purpose.
  assert.deepEqual(trimHistory(history, 0), history)
  assert.deepEqual(trimHistory(history, -5), history)
})

test('failed rounds never enter the context and buildMessages keeps the anchor order', () => {
  const conversation = conversationFor({ text: '原文' })
  conversation.commitFirstResult('首轮结果')
  conversation.beginTurn('第一问')
  conversation.rollbackTurn()
  assert.equal(conversation.history.length, 0)
  assert.equal(conversation.followUpCount, 0)

  assert.equal(conversation.beginTurn('第二问').ok, true)
  conversation.commitTurn({ content: '第二答' })
  assert.equal(conversation.beginTurn('第三问').ok, true)

  const messages = conversation.buildMessages()
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user'])
  assert.equal(messages[1].content, '原文')
  assert.equal(messages[2].content, '首轮结果')
  assert.equal(messages[3].content, '第二问')
  assert.equal(messages[4].content, '第二答')
  assert.equal(messages[5].content, '第三问')
  assert.match(messages[0].content, /划词解释/)
})

test('buildFollowUpMessages trims old pairs against the shared character budget', () => {
  const conversation = conversationFor({ text: 'T' })
  conversation.systemPrompt = 'S'
  conversation.maxContextChars = 12
  conversation.commitFirstResult('F')
  ;[1, 2, 3].forEach((index) => {
    conversation.beginTurn(`q${index}`)
    conversation.commitTurn({ content: `a${index}` })
  })
  conversation.beginTurn('now')

  assert.deepEqual(
    buildFollowUpMessages({ conversation, question: 'now' }).map((message) => message.content),
    ['S', 'T', 'F', 'q3', 'a3', 'now']
  )

  // Fixed part alone exceeds the budget: nothing is trimmed at all.
  conversation.maxContextChars = 2
  assert.deepEqual(
    buildFollowUpMessages({ conversation, question: 'now' }).map((message) => message.content),
    ['S', 'T', 'F', 'q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'now']
  )
})
