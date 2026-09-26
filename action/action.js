const actionBridge = window.actionAPI
const systemThemeMedia = matchMedia('(prefers-color-scheme: dark)')
const STREAM_IDLE_TIMEOUT_MS = 30000
const MIN_COMPOSER_HEIGHT = 34
const MAX_COMPOSER_HEIGHT = 120
const DEFAULT_FOLLOW_UP = { enabled: false, disabledReason: '', maxTurns: 10, questionMaxLength: 2000 }
const ALLOWED_MARKDOWN_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'hr',
  'li', 'ol', 'p', 'pre', 'strong', 'ul'
]

const ACTION_ICONS = {
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>',
  explain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3Z"/></svg>',
  reasoning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3Z"/><path d="M9.5 19.5h5"/></svg>',
  custom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9Z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/></svg>',
  pinned: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/></svg>'
}

let isPinned = false
let loadTimer = null
let userScrolled = false
let configuredTheme = 'system'
let configuredMainColor = '#e5a44c'
let renderQueued = false
let renderToken = 0
let resultDirty = false
let reasoningDirty = false

// The window is a conversation: turns[0] is the assistant's first answer (its
// prompt is the selection shown in .source), every later pair is one follow-up.
const conversation = {
  streamId: null,
  label: '',
  followUp: { ...DEFAULT_FOLLOW_UP },
  turns: [],
  activeTurn: -1,
  pendingQuestion: '',
  notice: '',
  replaceOnNextTurn: false
}

const el = {
  headerIcon: document.getElementById('headerIcon'),
  headerTitle: document.getElementById('headerTitle'),
  headerBadge: document.getElementById('headerBadge'),
  sourceText: document.getElementById('sourceText'),
  transcript: document.getElementById('transcript'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  composerHint: document.getElementById('composerHint'),
  btnCopy: document.getElementById('btnCopy'),
  btnRetry: document.getElementById('btnRetry'),
  questionInput: document.getElementById('questionInput'),
  btnSend: document.getElementById('btnSend')
}

function applyAppearance(appearance = {}) {
  configuredTheme = ['light', 'dark'].includes(appearance.theme) ? appearance.theme : 'system'
  const resolvedTheme = configuredTheme === 'system'
    ? (systemThemeMedia.matches ? 'dark' : 'light')
    : configuredTheme
  configuredMainColor = /^#[0-9a-f]{6}$/i.test(appearance.mainColor || '')
    ? appearance.mainColor
    : '#e5a44c'
  document.body.classList.toggle('dark', resolvedTheme === 'dark')
  document.documentElement.style.setProperty('--primary', configuredMainColor)
}

systemThemeMedia.addEventListener('change', () => {
  if (configuredTheme === 'system') applyAppearance({ theme: 'system', mainColor: configuredMainColor })
})

function resetUI() {
  userScrolled = false
  conversation.streamId = null
  conversation.followUp = { ...DEFAULT_FOLLOW_UP }
  conversation.turns = []
  conversation.activeTurn = -1
  conversation.pendingQuestion = ''
  conversation.notice = ''
  conversation.replaceOnNextTurn = false
  clearTimeout(loadTimer)
  loadTimer = null
  renderToken++
  renderQueued = false
  resultDirty = false
  reasoningDirty = false
  el.transcript.replaceChildren()
  el.questionInput.value = ''
  resizeComposerInput()
  el.loading.style.display = 'none'
  renderComposer()
}

function showLoading(visible) {
  if (el.loading) el.loading.style.display = visible ? 'flex' : 'none'
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function appendResultError(message) {
  const error = document.createElement('div')
  error.className = 'result-error'
  error.textContent = message
  el.transcript.appendChild(error)
}

function armStreamTimeout() {
  clearTimeout(loadTimer)
  loadTimer = setTimeout(function() {
    const turn = activeAssistantTurn()
    if (!turn) return
    finishTurnWith(turn, 'cancelled', '请求超时，请检查网络后重试')
    showLoading(false)
    renderComposer()
    actionBridge.cancelStream(conversation.streamId)
  }, STREAM_IDLE_TIMEOUT_MS)
}

function safeLinkMarkup(label, value) {
  const decoded = value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  const url = normalizeExternalUrl(decoded)
  if (!url) return label
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>`
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => safeLinkMarkup(label, url))
}

function simpleMarkdown(text) {
  let value = escapeHtml(text)
  value = value.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _language, code) => `<pre><code>${code}</code></pre>`)

  const lines = value.split('\n')
  const output = []
  let inList = false
  let listType = ''

  function closeList() {
    if (!inList) return
    output.push(`</${listType}>`)
    inList = false
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      closeList()
      continue
    }
    if (/^-{3,}$/.test(trimmed)) {
      closeList()
      output.push('<hr>')
      continue
    }
    if (trimmed.startsWith('&gt; ')) {
      closeList()
      output.push(`<blockquote>${inlineMarkdown(trimmed.slice(4))}</blockquote>`)
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)/)
    if (heading) {
      closeList()
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    const unorderedItem = line.match(/^\s*[-*]\s+(.+)/)
    if (unorderedItem) {
      if (!inList || listType !== 'ul') {
        closeList()
        output.push('<ul>')
        inList = true
        listType = 'ul'
      }
      output.push(`<li>${inlineMarkdown(unorderedItem[1])}</li>`)
      continue
    }

    const orderedItem = line.match(/^\s*\d+\.\s+(.+)/)
    if (orderedItem) {
      if (!inList || listType !== 'ol') {
        closeList()
        output.push('<ol>')
        inList = true
        listType = 'ol'
      }
      output.push(`<li>${inlineMarkdown(orderedItem[1])}</li>`)
      continue
    }

    closeList()
    if (line.includes('<pre>') || line.includes('</pre>')) output.push(line)
    else output.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  closeList()
  return output.join('')
}

function sanitizedMarkdown(text) {
  const markup = simpleMarkdown(text)
  if (!window.DOMPurify) return `<p>${escapeHtml(text)}</p>`
  return window.DOMPurify.sanitize(markup, {
    ALLOWED_TAGS: ALLOWED_MARKDOWN_TAGS,
    ALLOWED_ATTR: ['href', 'rel'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^https?:\/\//i
  })
}

function normalizeLinks(root) {
  for (const link of root.querySelectorAll('a')) {
    const url = normalizeExternalUrl(link.href)
    if (!url) {
      link.replaceWith(document.createTextNode(link.textContent))
      continue
    }
    link.href = url
    link.rel = 'noopener noreferrer'
    link.removeAttribute('target')
  }
}

function renderTurnAnswer(turn, { cursor = false } = {}) {
  turn.answerEl.innerHTML = sanitizedMarkdown(turn.content)
  normalizeLinks(turn.answerEl)
  if (cursor) {
    const cursorElement = document.createElement('span')
    cursorElement.className = 'cursor'
    turn.answerEl.appendChild(cursorElement)
  }
}

function createAssistantTurn() {
  const turn = { role: 'assistant', content: '', reasoning: '', status: 'streaming', note: '', notice: '' }
  turn.el = document.createElement('div')
  turn.el.className = 'turn turn-assistant'
  // The notice is a separate element from the note: the note carries the round's
  // outcome (stopped / interrupted / failed) and must never be overwritten.
  turn.noticeEl = document.createElement('div')
  turn.noticeEl.className = 'turn-notice'
  turn.answerEl = document.createElement('div')
  turn.answerEl.className = 'answer'
  turn.noteEl = document.createElement('div')
  turn.noteEl.className = 'turn-note'
  turn.el.append(turn.noticeEl, turn.answerEl, turn.noteEl)
  conversation.turns.push(turn)
  conversation.activeTurn = conversation.turns.length - 1
  el.transcript.appendChild(turn.el)
  return turn
}

function appendUserTurn(question) {
  const turn = { role: 'user', content: question, status: 'done' }
  const node = document.createElement('div')
  node.className = 'turn turn-user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = question
  node.appendChild(bubble)
  // Kept so a regenerated pair can be removed again — the model and the DOM
  // must stay in step.
  turn.el = node
  conversation.turns.push(turn)
  el.transcript.appendChild(node)
  return turn
}

function activeAssistantTurn() {
  const turn = conversation.turns[conversation.activeTurn]
  return turn && turn.role === 'assistant' ? turn : null
}

function addReasoning(turn) {
  if (!turn.reasoningBox) {
    const box = document.createElement('div')
    box.className = 'reasoning-box'

    const header = document.createElement('div')
    header.className = 'reasoning-header'
    const title = document.createElement('span')
    title.className = 'reasoning-title'
    title.innerHTML = ACTION_ICONS.reasoning + '<span>思考过程</span>'
    const spacer = document.createElement('span')
    spacer.className = 'reasoning-spacer'
    const arrow = document.createElement('span')
    arrow.className = 'reasoning-arrow'
    arrow.textContent = '▸'
    header.append(title, spacer, arrow)

    const preview = document.createElement('div')
    preview.className = 'reasoning-preview'
    const full = document.createElement('div')
    full.className = 'reasoning-full'
    box.append(header, preview, full)

    header.addEventListener('click', function() {
      box.classList.toggle('open')
      arrow.textContent = box.classList.contains('open') ? '▾' : '▸'
      if (box.classList.contains('open')) {
        full.textContent = turn.reasoning
        full.scrollTop = full.scrollHeight
      }
    })
    turn.el.insertBefore(box, turn.answerEl)
    turn.reasoningBox = box
  }
  return turn.reasoningBox
}

function renderTurnReasoning(turn) {
  const box = addReasoning(turn)
  const preview = box.querySelector('.reasoning-preview')
  const full = box.querySelector('.reasoning-full')
  preview.textContent = turn.reasoning
  preview.scrollTop = preview.scrollHeight
  full.textContent = turn.reasoning
}

function renderFinalTurn(turn) {
  if (turn.reasoning) renderTurnReasoning(turn)
  if (turn.content) renderTurnAnswer(turn)
  else turn.answerEl.replaceChildren()
  turn.noteEl.textContent = turn.note
  const isError = turn.status === 'error' || turn.status === 'rejected'
  turn.noteEl.className = isError ? 'turn-note error' : 'turn-note'
}

function finishTurnWith(turn, status, note) {
  turn.status = status
  turn.note = note
  renderFinalTurn(turn)
  conversation.activeTurn = -1
}

function doScroll() {
  if (userScrolled) return
  document.getElementById('scrollSentinel')?.scrollIntoView({ block: 'end', behavior: 'instant' })
}

function scheduleStreamRender() {
  if (renderQueued) return
  renderQueued = true
  const token = renderToken
  requestAnimationFrame(function() {
    renderQueued = false
    if (token !== renderToken) return
    const turn = activeAssistantTurn()
    if (!turn) return
    if (reasoningDirty) {
      reasoningDirty = false
      renderTurnReasoning(turn)
    }
    if (resultDirty) {
      resultDirty = false
      renderTurnAnswer(turn, { cursor: true })
    }
    doScroll()
  })
}

function followUpCount() {
  return conversation.turns.filter((turn) => turn.role === 'user').length
}

// The newest follow-up question, or '' when the latest round is not a follow-up.
// Regeneration only ever targets that round, so its question is simply the user
// turn sitting right before the last assistant turn.
function lastFollowUpQuestion() {
  const turns = conversation.turns
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant' || last.status === 'streaming') return ''
  const question = turns[turns.length - 2]
  return question && question.role === 'user' ? question.content : ''
}

// Drops the newest pair so the regenerated round replaces it instead of piling a
// second copy next to it. Called only once the server has echoed chat:turn, so a
// rejected retry keeps the old answer on screen.
function dropLastPair() {
  for (let count = 0; count < 2; count += 1) {
    const turn = conversation.turns.pop()
    if (turn && turn.el) turn.el.remove()
  }
  conversation.activeTurn = -1
}

function composerState() {
  const followUp = conversation.followUp
  if (followUp.enabled !== true) {
    return { enabled: false, reason: followUp.disabledReason || '当前无法追问' }
  }
  const first = conversation.turns.find((turn) => turn.role === 'assistant')
  if (!first || first.status === 'error' || first.status === 'cancelled') {
    return { enabled: false, reason: '首次请求失败，无法继续追问，请重新划词' }
  }
  if (followUpCount() >= followUp.maxTurns) {
    return { enabled: false, reason: `已达到最大追问轮数（${followUp.maxTurns}），请重新划词开始新会话` }
  }
  return { enabled: true, reason: '' }
}

function resizeComposerInput() {
  const input = el.questionInput
  input.style.height = 'auto'
  input.style.height = `${Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, input.scrollHeight))}px`
}

function renderComposer() {
  const busy = conversation.activeTurn >= 0 || conversation.pendingQuestion !== ''
  const state = busy ? { enabled: false, reason: '' } : composerState()
  el.questionInput.disabled = true
  el.btnSend.classList.toggle('stop', busy)
  // The transcript is copyable as soon as there is an answer to copy — while a
  // round is still streaming it copies what has arrived so far.
  el.btnCopy.disabled = !conversation.turns.some((turn) => turn.role === 'assistant' && turn.content)
  el.btnRetry.disabled = busy || !lastFollowUpQuestion()
  if (busy) {
    el.btnSend.disabled = false
    el.btnSend.title = '停止生成'
    el.composerHint.textContent = ''
    el.composerHint.className = 'composer-hint'
  } else {
    el.btnSend.disabled = !state.enabled
    el.btnSend.title = '发送'
    el.composerHint.textContent = conversation.notice || (state.enabled ? '' : state.reason)
    el.composerHint.className = conversation.notice ? 'composer-hint error' : 'composer-hint'
    el.questionInput.disabled = !state.enabled
  }
}

function submitQuestion() {
  if (conversation.activeTurn >= 0 || conversation.pendingQuestion) return
  if (!composerState().enabled) return
  const value = el.questionInput.value.trim()
  if (!value) return
  sendTurn(value, false)
}

// Regenerating keeps the question and lets the server drop the previous answer
// from the context, so the new answer is not built on top of the old attempt.
function retryLastTurn() {
  const question = lastFollowUpQuestion()
  if (!question) return
  sendTurn(question, true)
}

function sendTurn(question, replaceLast) {
  conversation.notice = ''
  conversation.pendingQuestion = question
  conversation.replaceOnNextTurn = replaceLast
  if (!actionBridge.askQuestion(conversation.streamId, question, replaceLast)) {
    conversation.pendingQuestion = ''
    conversation.replaceOnNextTurn = false
    conversation.notice = replaceLast ? '重新生成失败，请重试' : '追问发送失败，请重试'
  }
  renderComposer()
}

function stopStream() {
  const turn = activeAssistantTurn()
  if (turn) finishTurnWith(turn, 'cancelled', '已停止生成')
  else if (conversation.pendingQuestion) conversation.notice = '已取消本次追问'
  conversation.pendingQuestion = ''
  clearTimeout(loadTimer)
  loadTimer = null
  showLoading(false)
  renderComposer()
  actionBridge.cancelStream(conversation.streamId)
}

actionBridge.onActionStart(function(data) {
  applyAppearance(data.appearance)
  resetUI()
  conversation.streamId = data.streamId
  conversation.label = data.type === 'translate' ? '翻译' : (data.label || '解释')
  if (data.followUp) conversation.followUp = data.followUp
  el.sourceText.textContent = data.text
  if (data.type === 'translate') {
    el.headerIcon.innerHTML = ACTION_ICONS.translate
    el.headerTitle.textContent = '翻译'
    el.headerBadge.textContent = '翻译'
    el.headerBadge.className = 'badge'
    el.loadingText.textContent = '正在翻译...'
  } else {
    const label = data.label || '解释'
    // Custom AI functions supply their own short glyph (e.g. '译', '⇗'), which
    // is rendered as text. The built-ins and the no-icon fallback use an inline
    // SVG. textContent is used for the caller-supplied glyph so it can never
    // inject markup.
    if (data.type === 'explain') el.headerIcon.innerHTML = ACTION_ICONS.explain
    else if (data.icon) el.headerIcon.textContent = data.icon
    else el.headerIcon.innerHTML = ACTION_ICONS.custom
    el.headerTitle.textContent = label
    el.headerBadge.textContent = label
    el.headerBadge.className = 'badge explain'
    el.loadingText.textContent = '正在思考...'
  }
  createAssistantTurn()
  renderComposer()
  showLoading(true)
  armStreamTimeout()
})

actionBridge.onActionAppearance(applyAppearance)

actionBridge.onStreamData(function(data) {
  const turn = activeAssistantTurn()
  if (!turn) return
  armStreamTimeout()
  showLoading(false)
  turn.content += data.content
  resultDirty = true
  scheduleStreamRender()
})

actionBridge.onStreamReasoning(function(data) {
  const turn = activeAssistantTurn()
  if (!turn) return
  armStreamTimeout()
  showLoading(false)
  turn.reasoning += data.content
  reasoningDirty = true
  scheduleStreamRender()
})

actionBridge.onChatTurn(function(data) {
  if (data.streamId !== null && data.streamId !== conversation.streamId) return
  // The server accepted the round: only now is it safe to drop the pair that is
  // being regenerated.
  if (conversation.replaceOnNextTurn) {
    conversation.replaceOnNextTurn = false
    dropLastPair()
  }
  const question = data.question || conversation.pendingQuestion
  conversation.pendingQuestion = ''
  conversation.notice = ''
  el.questionInput.value = ''
  resizeComposerInput()
  appendUserTurn(question)
  const turn = createAssistantTurn()
  if (data.omittedPairs > 0) {
    turn.notice = `已省略更早的 ${data.omittedPairs} 轮对话以控制上下文长度`
    turn.noticeEl.textContent = turn.notice
  }
  userScrolled = false
  resultDirty = false
  reasoningDirty = false
  armStreamTimeout()
  renderComposer()
  doScroll()
})

actionBridge.onStreamDone(function() {
  clearTimeout(loadTimer)
  loadTimer = null
  resultDirty = false
  reasoningDirty = false
  showLoading(false)
  const turn = activeAssistantTurn()
  if (turn) finishTurnWith(turn, 'done', '')
  renderComposer()
  doScroll()
  actionBridge.finishStream(conversation.streamId)
})

actionBridge.onStreamError(function(data) {
  clearTimeout(loadTimer)
  loadTimer = null
  resultDirty = false
  reasoningDirty = false
  showLoading(false)
  const turn = activeAssistantTurn()
  if (turn) {
    const note = data.interrupted
      ? '窗口已隐藏，生成已中断'
      : (data.cancelled ? '已停止生成' : `错误: ${data.error}`)
    finishTurnWith(turn, data.cancelled ? 'cancelled' : (data.rejected ? 'rejected' : 'error'), note)
  } else if (data.rejected) {
    // The ask never became a turn: keep the typed text and surface the reason.
    // A refused regeneration must also release its intent, or the next accepted
    // round would drop an unrelated pair.
    conversation.pendingQuestion = ''
    conversation.replaceOnNextTurn = false
    conversation.notice = data.error
  }
  renderComposer()
  doScroll()
  actionBridge.finishStream(conversation.streamId)
})

function onSendClick() {
  if (conversation.activeTurn >= 0 || conversation.pendingQuestion) stopStream()
  else submitQuestion()
}

el.btnSend.addEventListener('click', onSendClick)

el.btnRetry.addEventListener('click', retryLastTurn)

let copyResetTimer = null

el.btnCopy.addEventListener('click', function() {
  const text = window.conversationText.buildConversationText({
    source: el.sourceText.textContent,
    label: conversation.label,
    turns: conversation.turns.map((turn) => ({
      role: turn.role,
      content: turn.content,
      status: turn.status,
      note: turn.note
    }))
  })
  if (!text) return
  actionBridge.copyConversation(text).then(function(copied) {
    el.btnCopy.textContent = copied ? '已复制' : '复制失败'
    clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(function() { el.btnCopy.textContent = '复制对话' }, 1500)
  }, function() {
    el.btnCopy.textContent = '复制失败'
  })
})

el.questionInput.addEventListener('keydown', function(event) {
  if (event.key !== 'Enter' || event.shiftKey) return
  // Chinese IMEs confirm a candidate with Enter; that must not send.
  if (event.isComposing) return
  event.preventDefault()
  if (conversation.activeTurn >= 0 || conversation.pendingQuestion) return
  submitQuestion()
})

el.questionInput.addEventListener('input', function() {
  resizeComposerInput()
  if (conversation.notice) {
    conversation.notice = ''
    renderComposer()
  }
})

document.addEventListener('visibilitychange', function() {
  if (!document.hidden || conversation.activeTurn < 0) return
  const turn = activeAssistantTurn()
  if (turn) finishTurnWith(turn, 'cancelled', '窗口已隐藏，生成已中断')
  clearTimeout(loadTimer)
  loadTimer = null
  showLoading(false)
  renderComposer()
})

document.getElementById('btnPin').addEventListener('click', function() {
  isPinned = !isPinned
  const button = document.getElementById('btnPin')
  button.classList.toggle('pinned', isPinned)
  button.innerHTML = isPinned ? ACTION_ICONS.pinned : ACTION_ICONS.pin
  button.title = isPinned ? '取消置顶' : '置顶窗口'
  actionBridge.togglePin(isPinned)
})

document.getElementById('content').addEventListener('wheel', function() {
  userScrolled = true
})

el.transcript.addEventListener('click', function(event) {
  const link = event.target.closest('a')
  if (!link || !el.transcript.contains(link)) return
  event.preventDefault()
  const url = normalizeExternalUrl(link.href)
  if (!url) return
  actionBridge.openExternal(url).catch((error) => appendResultError(error.message || '无法打开链接'))
})

actionBridge.onPinDenied(function(data) {
  isPinned = false
  const button = document.getElementById('btnPin')
  button.classList.remove('pinned')
  button.innerHTML = ACTION_ICONS.pin
  button.title = '置顶窗口'
  alert(`最多只能置顶 ${data.max} 个窗口，请先取消其他窗口的置顶。`)
})
