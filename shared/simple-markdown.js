// H03: the selection assistant's Markdown renderer and streaming block splitter.
//
// This used to live as `simpleMarkdown` inside action/action.js, where it first
// replaced ``` fences with <pre><code> and then split the whole string on "\n"
// and parsed every line again. That second pass ran over the already-emitted
// <pre> markup, so a code block lost its blank lines, lines starting with "#",
// "- ", "1. ", "---" or "> " were re-parsed as headings/lists/rules/quotes,
// indentation was wrapped in <p> and code such as `int *ptr = *other;` became
// <em>.
//
// The state machine below tracks `inCodeBlock` while it scans: fenced content
// (blank lines and indentation included) is emitted verbatim as a single
// <pre><code>, an unterminated fence is still closed at EOF so a streaming
// answer shows partial code instead of leaking fence lines, and nothing inside
// a fence reaches the inline parser.
//
// The module also owns the streaming split: `splitStreamBlocks` cuts the answer
// at blank lines and closed fences (the only points where rendering a block
// independently produces the same markup as rendering the whole answer), and
// `planStreamUpdate` tells the renderer which stable blocks are new. action.js
// therefore appends a completed block once and only rewrites the active tail.
//
// UMD because action.html loads it as a classic script while node:test requires
// it directly.

(function exposeSimpleMarkdown(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.simpleMarkdown = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  // Fences and table rows are decided on `trim()`, but the model may still send
  // CRLF; normalize first so block splitting and rendering agree on line ends.
  function normalizeMarkdown(value) {
    return String(value || '').replace(/\r\n?/g, '\n')
  }

  function normalizeExternalUrl(value) {
    try {
      const url = new URL(String(value || ''))
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
    } catch {
      return null
    }
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

  // A fence opens on any line that starts with three backticks (the info string
  // is ignored: the language class is deliberately not emitted, because the
  // renderer's DOMPurify whitelist only allows href/rel and widening it for a
  // cosmetic class is not worth it). Only a bare fence line closes it, so a
  // nested ```lang inside the code stays content.
  function isFenceStart(trimmed) {
    return trimmed.startsWith('```')
  }

  function isFenceEnd(trimmed) {
    return /^`{3,}\s*$/.test(trimmed)
  }

  function splitTableRow(line) {
    let text = String(line || '').trim()
    if (text.startsWith('|')) text = text.slice(1)
    if (text.endsWith('|')) text = text.slice(0, -1)
    return text.split('|').map((cell) => cell.trim())
  }

  function isTableDelimiter(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed.includes('|')) return false
    const cells = splitTableRow(trimmed)
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  }

  // A table starts at a row followed by a delimiter row. The delimiter check
  // keeps a plain paragraph that happens to contain "|" from becoming a table.
  function isTableStart(lines, index) {
    const trimmed = String(lines[index] || '').trim()
    if (!trimmed.includes('|')) return false
    return lines[index + 1] !== undefined && isTableDelimiter(lines[index + 1])
  }

  // Cells are emitted without alignment attributes on purpose: the DOMPurify
  // whitelist allows no attributes besides href/rel, so an align/style here
  // would only be stripped again.
  function buildTableMarkup(header, rows) {
    const head = header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')
    const body = rows
      .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`)
      .join('')
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }

  function render(markdownText) {
    const lines = escapeHtml(normalizeMarkdown(markdownText)).split('\n')
    const output = []
    let inList = false
    let listType = ''
    let inCodeBlock = false
    let codeLines = []

    function closeList() {
      if (!inList) return
      output.push(`</${listType}>`)
      inList = false
      listType = ''
    }

    function flushCodeBlock() {
      if (!inCodeBlock) return
      inCodeBlock = false
      output.push(`<pre><code>${codeLines.join('\n')}</code></pre>`)
      codeLines = []
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const trimmed = line.trim()

      if (inCodeBlock) {
        // Fenced content is already escaped and is never inspected again.
        if (isFenceEnd(trimmed)) flushCodeBlock()
        else codeLines.push(line)
        continue
      }
      if (isFenceStart(trimmed)) {
        closeList()
        inCodeBlock = true
        codeLines = []
        continue
      }
      if (!trimmed) {
        closeList()
        continue
      }
      if (isTableStart(lines, index)) {
        closeList()
        const header = splitTableRow(line)
        const rows = []
        let rowIndex = index + 2
        while (rowIndex < lines.length) {
          const rowTrimmed = lines[rowIndex].trim()
          if (!rowTrimmed || !rowTrimmed.includes('|')) break
          rows.push(splitTableRow(lines[rowIndex]))
          rowIndex += 1
        }
        output.push(buildTableMarkup(header, rows))
        index = rowIndex - 1
        continue
      }
      if (/^-{3,}$/.test(trimmed)) {
        closeList()
        output.push('<hr>')
        continue
      }
      if (trimmed.startsWith('&gt; ')) {
        closeList()
        output.push(`<blockquote>${inlineMarkdown(trimmed.slice(5))}</blockquote>`)
        continue
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.+)/)
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
      output.push(`<p>${inlineMarkdown(line)}</p>`)
    }

    flushCodeBlock()
    closeList()
    return output.join('')
  }

  // Splits a (possibly still streaming) answer into complete blocks and the
  // active tail. A block is complete only where rendering it on its own is
  // provably identical to rendering it inside the whole answer: at a blank line
  // outside a fence (the line parser closes lists/tables/quotes there) or right
  // after a closed fence. The blank separator lines themselves are dropped —
  // they never produce markup.
  function splitStreamBlocks(markdownText) {
    const lines = normalizeMarkdown(markdownText).split('\n')
    const blocks = []
    let inCodeBlock = false
    let blockStart = 0

    function pushBlock(endExclusive) {
      if (endExclusive <= blockStart) return
      const block = lines.slice(blockStart, endExclusive).join('\n')
      if (block.trim()) blocks.push(block)
    }

    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim()
      if (inCodeBlock) {
        if (isFenceEnd(trimmed)) {
          inCodeBlock = false
          pushBlock(index + 1)
          blockStart = index + 1
        }
        continue
      }
      if (isFenceStart(trimmed)) {
        inCodeBlock = true
        continue
      }
      if (!trimmed) {
        pushBlock(index)
        blockStart = index + 1
      }
    }

    return { blocks, tail: lines.slice(blockStart).join('\n') }
  }

  // Tells the renderer how to update its stable container: an append-only stream
  // keeps the previous block list as a prefix, so only the blocks after
  // `appendFrom` need to be rendered. Anything else (a restored or replaced
  // answer) rebuilds, which is the only case where the DOM may change upstream.
  function planStreamUpdate(previousBlocks, nextBlocks) {
    const previous = Array.isArray(previousBlocks) ? previousBlocks : []
    const next = Array.isArray(nextBlocks) ? nextBlocks : []
    if (previous.length > next.length) return { rebuild: true, appendFrom: 0 }
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== next[index]) return { rebuild: true, appendFrom: 0 }
    }
    return { rebuild: false, appendFrom: previous.length }
  }

  return { escapeHtml, planStreamUpdate, render, splitStreamBlocks }
})
