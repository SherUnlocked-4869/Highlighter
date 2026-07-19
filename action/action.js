let isPinned = false
let isDone = false
let reasoning = ''
let hasReasoning = false
let fullText = ''
let loadTimer = null
let userScrolled = false
const hasMarkdown = !!(window.electronAPI && typeof window.electronAPI.renderMarkdown === 'function')

const el = {
  headerIcon: document.getElementById('headerIcon'),
  headerTitle: document.getElementById('headerTitle'),
  headerBadge: document.getElementById('headerBadge'),
  sourceText: document.getElementById('sourceText'),
  result: document.getElementById('result'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText')
}

function resetUI() {
  isDone = false; reasoning = ''; hasReasoning = false; fullText = ''; userScrolled = false
  const old = document.getElementById('reasoningBox'); if (old) old.remove()
  el.result.innerHTML = ''
  el.loading.style.display = 'none'
}

function showLoading(s) { if (el.loading) el.loading.style.display = s ? 'flex' : 'none' }
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML }

// Full Markdown renderer (inline, no dependencies)
function simpleMarkdown(text) {
  var t = text
  // Escape HTML first
  t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Code blocks ```...```
  t = t.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    return '<pre><code>' + code + '</code></pre>'
  })

  var lines = t.split('\n')
  var out = []
  var inList = false
  var listType = ''

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    // Empty line closes list
    if (line.trim() === '') {
      if (inList) { out.push('</' + listType + '>'); inList = false }
      continue
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) { out.push('<hr>'); continue }

    // Blockquote
    if (line.trim().startsWith('&gt; ')) {
      if (inList) { out.push('</' + listType + '>'); inList = false }
      out.push('<blockquote>' + inlineMd(line.trim().slice(4)) + '</blockquote>')
      continue
    }

    // Headings
    if (line.trim().startsWith('### ')) {
      if (inList) { out.push('</' + listType + '>'); inList = false }
      out.push('<h3>' + inlineMd(line.trim().slice(4)) + '</h3>')
      continue
    }
    if (line.trim().startsWith('## ')) {
      if (inList) { out.push('</' + listType + '>'); inList = false }
      out.push('<h2>' + inlineMd(line.trim().slice(3)) + '</h2>')
      continue
    }
    if (line.trim().startsWith('# ')) {
      if (inList) { out.push('</' + listType + '>'); inList = false }
      out.push('<h1>' + inlineMd(line.trim().slice(2)) + '</h1>')
      continue
    }

    // Unordered list: - item or * item
    var ulMatch = line.match(/^(\s*)[-*]\s+(.+)/)
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) out.push('</' + listType + '>')
        out.push('<ul>')
        inList = true; listType = 'ul'
      }
      out.push('<li>' + inlineMd(ulMatch[2]) + '</li>')
      continue
    }

    // Ordered list: 1. item
    var olMatch = line.match(/^(\s*)\d+\.\s+(.+)/)
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) out.push('</' + listType + '>')
        out.push('<ol>')
        inList = true; listType = 'ol'
      }
      out.push('<li>' + inlineMd(olMatch[2]) + '</li>')
      continue
    }

    // Regular paragraph
    if (inList) { out.push('</' + listType + '>'); inList = false }
    // Check if line is inside a pre block
    if (line.indexOf('<pre>') === -1 && line.indexOf('</pre>') === -1) {
      out.push('<p>' + inlineMd(line) + '</p>')
    } else {
      out.push(line)
    }
  }
  if (inList) out.push('</' + listType + '>')
  return out.join('')
}

// Inline markdown: bold, italic, strikethrough, code, links
function inlineMd(text) {
  var t = text
  // Inline code (must come before other formatting)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Italic
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Strikethrough
  t = t.replace(/~~(.+?)~~/g, '<del>$1</del>')
  // Links [text](url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
  return t
}

function renderResult(text) {
  // Use built-in simpleMarkdown for reliability - preload renderer may not be available
  el.result.innerHTML = simpleMarkdown(text)
}

function doScroll() {
  if (userScrolled) return
  var s = document.getElementById('scrollSentinel')
  if (s) s.scrollIntoView({ block: 'end', behavior: 'instant' })
}

function addReasoning() {
  var box = document.getElementById('reasoningBox')
  if (!box) {
    box = document.createElement('div')
    box.id = 'reasoningBox'
    box.className = 'reasoning-box'
    box.innerHTML = '<div class="reasoning-header">🧠 思考过程 <span style="flex:1"></span><span class="reasoning-arrow">▶</span></div>' +
      '<div class="reasoning-preview"></div>' +
      '<div class="reasoning-full"></div>'
    box.querySelector('.reasoning-header').addEventListener('click', function() {
      box.classList.toggle('open')
      box.querySelector('.reasoning-arrow').textContent = box.classList.contains('open') ? '▼' : '▶'
      // When opening, update full content and scroll full area
      if (box.classList.contains('open')) {
        var fullEl = box.querySelector('.reasoning-full')
        fullEl.textContent = reasoning
        fullEl.scrollTop = fullEl.scrollHeight
      }
    })
    el.result.parentNode.insertBefore(box, el.result)
  }
  return {
    preview: box.querySelector('.reasoning-preview'),
    full: box.querySelector('.reasoning-full')
  }
}

window.electronAPI.onActionStart(function(data) {
  resetUI()
  el.sourceText.textContent = data.text
  if (data.type === 'translate') {
    el.headerIcon.innerHTML = '🌐'; el.headerTitle.textContent = '翻译'
    el.headerBadge.textContent = '翻译'; el.headerBadge.className = 'badge'
    el.loadingText.textContent = '正在翻译...'
  } else {
    el.headerIcon.innerHTML = '💡'; el.headerTitle.textContent = '解释'
    el.headerBadge.textContent = '解释'; el.headerBadge.className = 'badge explain'
    el.loadingText.textContent = '正在思考...'
  }
  showLoading(true)
  clearTimeout(loadTimer)
  loadTimer = setTimeout(function() {
    if (!isDone) { showLoading(false); el.result.innerHTML = '<div style="color:#f44336;">请求超时</div>'; window.electronAPI.finishStream() }
  }, 30000)
})

window.electronAPI.onStreamData(function(data) {
  if (isDone) return
  clearTimeout(loadTimer)
  showLoading(false)
  fullText += data.content
  // Show simple formatted text during streaming
  el.result.innerHTML = simpleMarkdown(fullText) + '<span class="cursor"></span>'
  doScroll()
})

window.electronAPI.onStreamReasoning(function(data) {
  if (isDone) return
  showLoading(false)
  hasReasoning = true; reasoning += data.content
  var rc = addReasoning()
  if (rc.preview) {
    rc.preview.textContent = reasoning
    rc.preview.scrollTop = rc.preview.scrollHeight
    rc.full.textContent = reasoning
  }
  doScroll()
})

window.electronAPI.onStreamDone(function() {
  isDone = true; showLoading(false); clearTimeout(loadTimer)
  // Final render: use full markdown if available, else simple
  renderResult(fullText)
  doScroll()
  fullText = ''
  window.electronAPI.finishStream()
})

window.electronAPI.onStreamError(function(data) {
  isDone = true; showLoading(false); clearTimeout(loadTimer)
  fullText = ''
  el.result.innerHTML += '<div style="color:#f44336;margin-top:8px;">错误: ' + esc(data.error) + '</div>'
  doScroll()
  window.electronAPI.finishStream()
})

document.getElementById('btnPin').addEventListener('click', function() {
  if (!isPinned) {
    // Request to pin - result comes via IPC
    isPinned = true
    var btn = document.getElementById('btnPin')
    btn.classList.add('pinned')
    btn.textContent = '📍'
    btn.title = '取消置顶'
    window.electronAPI.togglePin(true)
  } else {
    isPinned = false
    var btn = document.getElementById('btnPin')
    btn.classList.remove('pinned')
    btn.textContent = '📌'
    btn.title = '置顶窗口'
    window.electronAPI.togglePin(false)
  }
})

// Detect manual scrolling
document.getElementById('content').addEventListener('wheel', function() {
  userScrolled = true
})

// Listen for pin denied (max 3 reached)
window.electronAPI.onPinDenied(function(data) {
  isPinned = false
  var btn = document.getElementById('btnPin')
  btn.classList.remove('pinned')
  btn.textContent = '📌'
  btn.title = '置顶窗口'
  alert('最多只能置顶 ' + data.max + ' 个窗口，请先取消其他窗口的置顶。')
})
