const test = require('node:test')
const assert = require('node:assert/strict')
const { buildConversationText, buildQuoteBlock, MAX_QUOTE_LENGTH } = require('../action/conversation-text')

function turn(role, content, extra = {}) {
  return { role, content, ...extra }
}

test('copies the source, the labelled first answer and each follow-up pair in order', () => {
  const text = buildConversationText({
    source: 'Neural machine translation replaced phrase-based systems.',
    label: '翻译',
    turns: [
      turn('assistant', '神经机器翻译取代了基于短语的系统。'),
      turn('user', '第二段说的是什么？'),
      turn('assistant', '第二段说的是旧系统的局限。'),
      turn('user', '还有别的问题吗？'),
      turn('assistant', '还有一点：它丢失了语篇连贯性。')
    ]
  })

  assert.equal(text, [
    '【划词原文】',
    'Neural machine translation replaced phrase-based systems.',
    '',
    '【翻译】',
    '神经机器翻译取代了基于短语的系统。',
    '',
    '【追问 1】',
    '第二段说的是什么？',
    '第二段说的是旧系统的局限。',
    '',
    '【追问 2】',
    '还有别的问题吗？',
    '还有一点：它丢失了语篇连贯性。'
  ].join('\n'))
})

test('marks stopped and failed rounds instead of folding in a half answer', () => {
  const text = buildConversationText({
    source: 'source',
    label: '解释',
    turns: [
      turn('assistant', '首轮解释。'),
      turn('user', '详细展开'),
      turn('assistant', '半截回答', { status: 'cancelled', note: '已停止生成' }),
      turn('user', '再来一次'),
      turn('assistant', '', { status: 'error', note: '错误: 请求失败' }),
      turn('user', '再试'),
      turn('assistant', '', { status: 'done' })
    ]
  })

  assert.match(text, /【追问 1】\n详细展开\n半截回答\n（已停止生成）/)
  assert.match(text, /【追问 2】\n再来一次\n（生成失败）/)
  assert.match(text, /【追问 3】\n再试\n（无内容）/)
})

test('quotes are plain prefixed text, clamped and reported as truncated', () => {
  assert.deepEqual(buildQuoteBlock('  一句话  '), { text: '> 一句话', truncated: false })
  // Multi-line selections are prefixed per line so markdown keeps the block together.
  assert.deepEqual(buildQuoteBlock('第一行\n第二行'), { text: '> 第一行\n> 第二行', truncated: false })
  assert.deepEqual(buildQuoteBlock(''), { text: '', truncated: false })
  assert.deepEqual(buildQuoteBlock(undefined), { text: '', truncated: false })

  const long = 'x'.repeat(MAX_QUOTE_LENGTH + 20)
  const clamped = buildQuoteBlock(long)
  assert.equal(clamped.truncated, true)
  assert.equal(clamped.text, `> ${'x'.repeat(MAX_QUOTE_LENGTH)}`)
  // Exactly at the cap is not a truncation.
  assert.equal(buildQuoteBlock('y'.repeat(MAX_QUOTE_LENGTH)).truncated, false)
  // The cap is overridable so the caller can keep quote and question inside the
  // 2000-character question limit the bridge enforces.
  assert.equal(buildQuoteBlock(long, { maxLength: 10 }).text, '> xxxxxxxxxx')
})

test('omits the source block when there is no source and never emits stray headings', () => {
  assert.equal(buildConversationText({ turns: [] }), '')
  assert.equal(buildConversationText({}), '')
  assert.equal(buildConversationText({ label: '翻译', turns: [turn('assistant', '只有结果')] }), '【翻译】\n只有结果')
  // A pending question with no answer must not leak in on its own.
  assert.equal(buildConversationText({ turns: [turn('user', '没有回答的问题')] }), '')
  // An unlabelled action still gets a readable heading.
  assert.equal(buildConversationText({ turns: [turn('assistant', 'x')] }), '【结果】\nx')
})
