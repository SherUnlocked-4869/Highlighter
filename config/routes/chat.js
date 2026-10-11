// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 chat（AI 对话）。

let chatMessages = []

function renderChat() {
  view.innerHTML = `<div class="page"><div class="card chat-wrap"><div class="chat-messages" id="chatMessages">${chatMessages.length ? chatMessages.map((message) => `<div class="message ${message.role}">${escapeHtml(message.content)}</div>`).join('') : '<div class="empty">' + t('config.chat.empty') + '</div>'}</div><div class="chat-input"><textarea class="input" id="chatInput" placeholder="${t('config.chat.input-placeholder')}"></textarea><button class="button primary" id="sendChat">${t('config.chat.send')}</button></div></div></div>`
  const send = async () => {
    const input = document.getElementById('chatInput'); const content = input.value.trim(); if (!content) return
    chatMessages.push({ role: 'user', content }); input.value = ''; renderChat()
    const messages = chatMessages.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }))
    try { const answer = await window.electronAPI.requestAi(messages); chatMessages.push({ role: 'assistant', content: answer }) }
    catch (error) { chatMessages.push({ role: 'assistant', content: t('config.chat.request-failed', { message: error.message || error }) }) }
    renderChat(); const box = document.getElementById('chatMessages'); box.scrollTop = box.scrollHeight
  }
  document.getElementById('sendChat').onclick = send
  document.getElementById('chatInput').onkeydown = (event) => { if (event.ctrlKey && event.key === 'Enter') send() }
  const box = document.getElementById('chatMessages'); box.scrollTop = box.scrollHeight
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderChat'] = () => renderChat()
