// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 chat（AI 对话）。

let chatMessages = []
let chatPending = false

function refreshChatMessages() {
  const box = document.getElementById('chatMessages')
  if (!box) return
  box.innerHTML = chatMessages.length
    ? chatMessages.map((message) => `<div class="message ${message.role}">${escapeHtml(message.content)}</div>`).join('')
    : '<div class="empty">' + t('config.chat.empty') + '</div>'
  box.scrollTop = box.scrollHeight
  document.getElementById('chatStatus').textContent = chatPending ? t('config.chat.waiting') : ''
  document.getElementById('sendChat').disabled = chatPending
}

function renderChat() {
  view.innerHTML = `<div class="page"><div class="card chat-wrap"><div class="chat-messages" id="chatMessages" aria-live="polite"></div><form class="chat-input"><p class="chat-status" id="chatStatus" role="status"></p><textarea class="input" id="chatInput" rows="1" aria-label="${t('config.chat.message')}" placeholder="${t('config.chat.input-placeholder')}"></textarea><button type="submit" class="button primary" id="sendChat">${t('config.chat.send')}</button></form></div></div>`
  const input = document.getElementById('chatInput')
  const form = input.form
  form.onsubmit = async (event) => {
    event.preventDefault()
    const content = input.value.trim()
    if (!content || chatPending) return
    chatPending = true
    chatMessages.push({ role: 'user', content })
    input.value = ''
    input.focus()
    refreshChatMessages()
    try {
      const answer = await window.electronAPI.requestAi([...chatMessages])
      chatMessages.push({ role: 'assistant', content: answer })
    } catch (error) {
      chatMessages.push({ role: 'assistant', content: t('config.chat.request-failed', { message: error.message || error }) })
    } finally {
      chatPending = false
      refreshChatMessages()
    }
  }
  input.onkeydown = (event) => {
    if (event.isComposing || !event.ctrlKey || event.key !== 'Enter') return
    event.preventDefault()
    form.requestSubmit()
  }
  refreshChatMessages()
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderChat'] = () => renderChat()
