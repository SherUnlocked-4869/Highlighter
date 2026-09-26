const test = require('node:test')
const assert = require('node:assert/strict')
const { ActionConversation, streamConversationTurn } = require('../main/services/action-conversation')

function createController() {
  return {
    cancelled: false,
    cancelReason: '',
    finished: false,
    armCount: 0,
    signal: { aborted: false },
    armTimeout() {
      this.armCount += 1
      return true
    },
    finish() {
      this.finished = true
      return true
    }
  }
}

function createWin(destroyed = false) {
  return { isDestroyed: () => destroyed }
}

function chunk(content, reasoning) {
  return { choices: [{ delta: { content, reasoning_content: reasoning } }] }
}

function pendingConversation() {
  const conversation = new ActionConversation({
    streamId: 5,
    action: { id: 'explain', label: '解释' },
    text: '原文',
    provider: { id: 'p1' },
    thinking: 'high',
    support: { canFollowUp: true, reason: '' }
  })
  conversation.commitFirstResult('首轮结果')
  assert.equal(conversation.beginTurn('追问').ok, true)
  return conversation
}

function collect() {
  const events = []
  return { events, queueMessage: (channel, data) => events.push({ channel, data }) }
}

test('streamConversationTurn forwards deltas, finishes the round and commits the answer', async () => {
  const conversation = pendingConversation()
  const controller = createController()
  const { events, queueMessage } = collect()
  const captured = []
  await streamConversationTurn({
    conversation,
    win: createWin(),
    controller,
    queueMessage,
    createStream: async (provider, messages, options) => {
      captured.push({ provider, messages, options })
      return (async function* () {
        yield chunk('', '先想一下')
        yield chunk('答案')
      })()
    }
  })

  assert.equal(captured.length, 1)
  assert.deepEqual(captured[0].provider, { id: 'p1' })
  assert.deepEqual(captured[0].options, { signal: controller.signal, thinking: 'high' })
  assert.equal(captured[0].messages.at(-1).content, '追问')
  assert.deepEqual(events, [
    { channel: 'stream:reasoning', data: { content: '先想一下' } },
    { channel: 'stream:data', data: { content: '答案' } },
    { channel: 'stream:done', data: undefined }
  ])
  assert.equal(conversation.isTurnPending, false)
  assert.equal(conversation.history.length, 1)
  assert.equal(conversation.history[0].answer, '答案')
  assert.equal(controller.finished, true)
  assert.ok(controller.armCount >= 1, 'the idle timer is re-armed for the round')
})

test('a user stop reports a cancelled error and never commits the partial answer', async () => {
  const conversation = pendingConversation()
  const controller = createController()
  const { events, queueMessage } = collect()
  await streamConversationTurn({
    conversation,
    win: createWin(),
    controller,
    queueMessage,
    createStream: async () => (async function* () {
      yield chunk('半截')
      controller.cancelled = true
      controller.cancelReason = 'user-cancelled'
    })()
  })

  assert.deepEqual(events, [
    { channel: 'stream:data', data: { content: '半截' } },
    { channel: 'stream:error', data: { error: '已停止生成', cancelled: true } }
  ])
  assert.equal(conversation.history.length, 0)
  assert.equal(conversation.isTurnPending, false)
  assert.equal(controller.finished, true)
})

test('a hidden window reports an interrupt so the renderer can recover at once', async () => {
  const conversation = pendingConversation()
  const controller = createController()
  const { events, queueMessage } = collect()
  await streamConversationTurn({
    conversation,
    win: createWin(),
    controller,
    queueMessage,
    createStream: async () => (async function* () {
      yield chunk('半截')
      controller.cancelled = true
      controller.cancelReason = 'window-hidden'
    })()
  })

  // visibilitychange does not fire for BrowserWindow.hide() in Electron, so the
  // service has to report the interrupt itself instead of staying silent.
  assert.deepEqual(events, [
    { channel: 'stream:data', data: { content: '半截' } },
    { channel: 'stream:error', data: { error: '窗口已隐藏，生成已中断', cancelled: true, interrupted: true } }
  ])
  assert.equal(conversation.history.length, 0)
  assert.equal(conversation.isTurnPending, false)
})

test('a closed window or game-mode stop stays silent', async () => {
  for (const reason of ['window-closed', 'game-mode']) {
    const conversation = pendingConversation()
    const controller = createController()
    const { events, queueMessage } = collect()
    await streamConversationTurn({
      conversation,
      win: createWin(),
      controller,
      queueMessage,
      createStream: async () => (async function* () {
        yield chunk('半截')
        controller.cancelled = true
        controller.cancelReason = reason
      })()
    })
    assert.deepEqual(events, [{ channel: 'stream:data', data: { content: '半截' } }], reason)
    assert.equal(conversation.history.length, 0, reason)
  }
})

test('a failing round reports the error and rolls the round back', async () => {
  const conversation = pendingConversation()
  const controller = createController()
  const { events, queueMessage } = collect()
  await streamConversationTurn({
    conversation,
    win: createWin(),
    controller,
    queueMessage,
    createStream: async () => { throw new Error('模型挂了') }
  })

  assert.deepEqual(events, [{ channel: 'stream:error', data: { error: '模型挂了' } }])
  assert.equal(conversation.history.length, 0)
  assert.equal(conversation.isTurnPending, false)
  assert.equal(controller.finished, true)
})

test('a destroyed window sends nothing and rolls the round back', async () => {
  const conversation = pendingConversation()
  const controller = createController()
  const { events, queueMessage } = collect()
  await streamConversationTurn({
    conversation,
    win: createWin(true),
    controller,
    queueMessage,
    createStream: async () => (async function* () { yield chunk('答案') })()
  })

  assert.deepEqual(events, [])
  assert.equal(conversation.history.length, 0)
  assert.equal(controller.finished, true)
})
