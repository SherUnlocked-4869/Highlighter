// Single source of truth for the "copy whole conversation" text.
//
// The renderer owns the turn list (it includes rounds that were stopped or
// failed, which the main-process session deliberately drops), so the formatting
// lives here and the renderer just passes its state in. UMD so the sandboxed
// renderer can load it without a bundler, and node:test can assert it.
//
// A stopped or failed round is copied with an explicit marker: silently mixing a
// half answer into a transcript is worse than saying it is half.

(function exposeConversationText(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.conversationText = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const TURN_STATUS_NOTES = Object.freeze({
    cancelled: '（已停止生成）',
    error: '（生成失败）',
    rejected: '（未发送）'
  })
  const EMPTY_ANSWER = '（无内容）'

  function statusNote(turn) {
    return TURN_STATUS_NOTES[turn?.status] || (turn?.note ? `（${String(turn.note)}）` : '')
  }

  function answerBlock(turn) {
    const content = String(turn?.content ?? '').trim()
    const note = statusNote(turn)
    if (!content) return note || EMPTY_ANSWER
    return note ? `${content}\n${note}` : content
  }

  function buildConversationText({ source = '', label = '', turns = [] } = {}) {
    const list = Array.isArray(turns) ? turns : []
    const blocks = []
    const sourceText = String(source ?? '').trim()
    if (sourceText) blocks.push(['【划词原文】', sourceText].join('\n'))

    let followUpIndex = 0
    let pendingQuestion = ''
    let sawAssistant = false
    for (const turn of list) {
      if (turn?.role === 'user') {
        pendingQuestion = String(turn.content ?? '').trim()
        continue
      }
      if (turn?.role !== 'assistant') continue
      const heading = sawAssistant
        ? `【追问 ${(followUpIndex += 1)}】`
        : `【${String(label || '结果').trim() || '结果'}】`
      const body = sawAssistant && pendingQuestion
        ? `${pendingQuestion}\n${answerBlock(turn)}`
        : answerBlock(turn)
      blocks.push([heading, body].join('\n'))
      sawAssistant = true
      pendingQuestion = ''
    }

    return blocks.join('\n\n').trim()
  }

  return { buildConversationText, TURN_STATUS_NOTES }
})
