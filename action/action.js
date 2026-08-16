const actionBridge = window.actionAPI
const systemThemeMedia = matchMedia('(prefers-color-scheme: dark)')
const STREAM_IDLE_TIMEOUT_MS = 30000
const ALLOWED_MARKDOWN_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'hr',
  'li', 'ol', 'p', 'pre', 'strong', 'ul'
]

let isPinned = false
let isDone = false
let reasoning = ''
let fullText = ''
let loadTimer = null
let userScrolled = false
let configuredTheme = 'system'
let configuredMainColor = '#1677ff'
let currentStreamId = null
let renderQueued = false
let renderToken = 0
let resultDirty = false
let reasoningDirty = false
let lastStreamRenderAt = 0
// Full-text markdown + sanitize + innerHTML rebuild costs O(text length); a
// per-token rAF loop makes a long answer O(n²). Throttle repaints instead.
const STREAM_RENDER_INTERVAL_MS = 120

const el = {
  headerIcon: document.getElementById('headerIcon'),
  headerTitle: document.getElementById('headerTitle'),
  headerBadge: document.getElementById('headerBadge'),
  sourceText: document.getElementById('sourceText'),
  result: document.getElementById('result'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText')
}

function applyAppearance(appearance = {}) {
  configuredTheme = ['light', 'dark'].includes(appearance.theme) ? appearance.theme : 'system'
  const resolvedTheme = configuredTheme === 'system'
    ? (systemThemeMedia.matches ? 'dark' : 'light')
    : configuredTheme
  configuredMainColor = /^#[0-9a-f]{6}$/i.test(appearance.mainColor || '')
    ? appearance.mainColor
    : '#1677ff'
  document.body.classList.toggle('dark', resolvedTheme === 'dark')
  document.documentElement.style.setProperty('--primary', configuredMainColor)
}

systemThemeMedia.addEventListener('change', () => {
  if (configuredTheme === 'system') applyAppearance({ theme: 'system', mainColor: configuredMainColor })
})

function resetUI() {
  isDone = false
  reasoning = ''
  fullText = ''
  userScrolled = false
  currentStreamId = null
  clearTimeout(loadTimer)
  loadTimer = null
  renderToken++
  renderQueued = false
  resultDirty = false
  reasoningDirty = false
  lastStreamRenderAt = 0
  document.getElementById('reasoningBox')?.remove()
  el.result.replaceChildren()
  el.loading.style.display = 'none'
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
  el.result.appendChild(error)
}

function armStreamTimeout() {
  clearTimeout(loadTimer)
  loadTimer = setTimeout(function() {
    if (isDone) return
    isDone = true
    showLoading(false)
    el.result.replaceChildren()
    appendResultError('模型长时间无输出，已取消。免费模型高峰期易排队超时，可重试或更换模型')
    actionBridge.cancelStream(currentStreamId)
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

function renderResult(text, { cursor = false } = {}) {
  el.result.innerHTML = sanitizedMarkdown(text)
  for (const link of el.result.querySelectorAll('a')) {
    const url = normalizeExternalUrl(link.href)
    if (!url) {
      link.replaceWith(document.createTextNode(link.textContent))
      continue
    }
    link.href = url
    link.rel = 'noopener noreferrer'
    link.removeAttribute('target')
  }
  if (cursor) {
    const cursorElement = document.createElement('span')
    cursorElement.className = 'cursor'
    el.result.appendChild(cursorElement)
  }
}

function doScroll() {
  if (userScrolled) return
  document.getElementById('scrollSentinel')?.scrollIntoView({ block: 'end', behavior: 'instant' })
}

function scheduleStreamRender() {
  if (renderQueued) return
  renderQueued = true
  const token = renderToken
  const delay = Math.max(0, STREAM_RENDER_INTERVAL_MS - (performance.now() - lastStreamRenderAt))
  setTimeout(function() {
    renderQueued = false
    if (token !== renderToken || isDone) return
    requestAnimationFrame(function() {
      if (token !== renderToken || isDone) return
      lastStreamRenderAt = performance.now()
      if (reasoningDirty) {
        reasoningDirty = false
        const reasoningContent = addReasoning()
        reasoningContent.preview.textContent = reasoning
        reasoningContent.preview.scrollTop = reasoningContent.preview.scrollHeight
        if (reasoningContent.full.closest('.open')) {
          reasoningContent.full.textContent = reasoning
          reasoningContent.full.scrollTop = reasoningContent.full.scrollHeight
        }
      }
      if (resultDirty) {
        resultDirty = false
        renderResult(fullText, { cursor: true })
      }
      doScroll()
    })
  }, delay)
}

function addReasoning() {
  let box = document.getElementById('reasoningBox')
  if (!box) {
    box = document.createElement('div')
    box.id = 'reasoningBox'
    box.className = 'reasoning-box'

    const header = document.createElement('div')
    header.className = 'reasoning-header'
    const title = document.createElement('span')
    title.textContent = '🧠 思考过程'
    const spacer = document.createElement('span')
    spacer.className = 'reasoning-spacer'
    const arrow = document.createElement('span')
    arrow.className = 'reasoning-arrow'
    arrow.textContent = '▶'
    header.append(title, spacer, arrow)

    const preview = document.createElement('div')
    preview.className = 'reasoning-preview'
    const full = document.createElement('div')
    full.className = 'reasoning-full'
    box.append(header, preview, full)

    header.addEventListener('click', function() {
      box.classList.toggle('open')
      arrow.textContent = box.classList.contains('open') ? '▼' : '▶'
      if (box.classList.contains('open')) {
        full.textContent = reasoning
        full.scrollTop = full.scrollHeight
      }
    })
    el.result.parentNode.insertBefore(box, el.result)
  }
  return {
    preview: box.querySelector('.reasoning-preview'),
    full: box.querySelector('.reasoning-full')
  }
}

actionBridge.onActionStart(function(data) {
  applyAppearance(data.appearance)
  resetUI()
  currentStreamId = data.streamId
  el.sourceText.textContent = data.text
  if (data.type === 'translate') {
    el.headerIcon.textContent = '🌐'
    el.headerTitle.textContent = '翻译'
    el.headerBadge.textContent = '翻译'
    el.headerBadge.className = 'badge'
    el.loadingText.textContent = '正在翻译...'
  } else {
    const label = data.label || '解释'
    el.headerIcon.textContent = data.type === 'explain' ? '💡' : (data.icon || '✦')
    el.headerTitle.textContent = label
    el.headerBadge.textContent = label
    el.headerBadge.className = 'badge explain'
    el.loadingText.textContent = '正在思考...'
  }
  showLoading(true)
  armStreamTimeout()
})

actionBridge.onActionAppearance(applyAppearance)

actionBridge.onStreamData(function(data) {
  if (isDone) return
  armStreamTimeout()
  showLoading(false)
  fullText += data.content
  resultDirty = true
  scheduleStreamRender()
})

actionBridge.onStreamReasoning(function(data) {
  if (isDone) return
  armStreamTimeout()
  showLoading(false)
  reasoning += data.content
  reasoningDirty = true
  scheduleStreamRender()
})

actionBridge.onStreamDone(function() {
  isDone = true
  showLoading(false)
  clearTimeout(loadTimer)
  resultDirty = false
  reasoningDirty = false
  renderResult(fullText)
  doScroll()
  fullText = ''
  actionBridge.finishStream(currentStreamId)
})

actionBridge.onStreamError(function(data) {
  isDone = true
  showLoading(false)
  clearTimeout(loadTimer)
  if (fullText) renderResult(fullText)
  else el.result.replaceChildren()
  resultDirty = false
  reasoningDirty = false
  fullText = ''
  appendResultError(`错误: ${data.error}`)
  doScroll()
  actionBridge.finishStream(currentStreamId)
})

document.getElementById('btnPin').addEventListener('click', function() {
  isPinned = !isPinned
  const button = document.getElementById('btnPin')
  button.classList.toggle('pinned', isPinned)
  button.textContent = isPinned ? '📍' : '📌'
  button.title = isPinned ? '取消置顶' : '置顶窗口'
  actionBridge.togglePin(isPinned)
})

document.getElementById('content').addEventListener('wheel', function() {
  userScrolled = true
})

el.result.addEventListener('click', function(event) {
  const link = event.target.closest('a')
  if (!link || !el.result.contains(link)) return
  event.preventDefault()
  const url = normalizeExternalUrl(link.href)
  if (!url) return
  actionBridge.openExternal(url).catch((error) => appendResultError(error.message || '无法打开链接'))
})

actionBridge.onPinDenied(function(data) {
  isPinned = false
  const button = document.getElementById('btnPin')
  button.classList.remove('pinned')
  button.textContent = '📌'
  button.title = '置顶窗口'
  alert(`最多只能置顶 ${data.max} 个窗口，请先取消其他窗口的置顶。`)
})
