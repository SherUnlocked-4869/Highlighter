const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { escapeHtml, planStreamUpdate, render, splitStreamBlocks } = require('../shared/simple-markdown')

const root = path.resolve(__dirname, '..')
const actionScript = fs.readFileSync(path.join(root, 'action', 'action.js'), 'utf8')
const actionHtml = fs.readFileSync(path.join(root, 'action', 'action.html'), 'utf8')

// The code block below deliberately contains every construct the old parser
// re-interpreted while scanning the already-emitted <pre> markup.
const FENCED_SAMPLE = [
  '```python',
  '# comment stays',
  '- item stays',
  '1. item stays',
  '---',
  '> quote stays',
  '',
  '    indented = 4',
  'int *ptr = *other;',
  '__init__(self)',
  'print("<b>")',
  '```'
].join('\n')

test('H03: fenced code content survives verbatim (blank lines, indentation, markdown glyphs)', () => {
  const html = render(FENCED_SAMPLE)
  const expectedCode = [
    '# comment stays',
    '- item stays',
    '1. item stays',
    '---',
    '&gt; quote stays',
    '',
    '    indented = 4',
    'int *ptr = *other;',
    '__init__(self)',
    // Escaping happens before parsing, so quotes show up as entities here while
    // the code element's textContent still reads print("<b>").
    'print(&quot;&lt;b&gt;&quot;)'
  ].join('\n')
  assert.equal(html, `<pre><code>${expectedCode}</code></pre>`)
  // None of the fenced lines may leak into the block parser.
  for (const tag of ['<h1>', '<h2>', '<h3>', '<hr>', '<ul>', '<ol>', '<blockquote>', '<p>', '<em>']) {
    assert.equal(html.includes(tag), false, `${tag} must not be produced inside a code block`)
  }
  // The fence line's info string is not emitted as a class: the DOMPurify
  // whitelist only allows href/rel, and a stripped attribute is dead weight.
  assert.doesNotMatch(html, /class=|language-/)
})

test('H03: an unterminated fence renders as code and is closed automatically', () => {
  // Streaming sends the opening fence long before the closing one arrives.
  assert.equal(render('```js'), '<pre><code></code></pre>')
  assert.equal(
    render('```js\nconst a = 1\n\nlet b = 2'),
    '<pre><code>const a = 1\n\nlet b = 2</code></pre>'
  )
  // The blank line inside the fence survives the EOF flush.
  assert.match(render('```\nfirst\n\nthird'), /first\n\nthird/)
})

test('H03: a closed fence is followed by normally parsed markdown', () => {
  const html = render('Before.\n```\n# not a heading\n```\n## Heading\n- item')
  assert.equal(
    html,
    '<p>Before.</p><pre><code># not a heading</code></pre><h2>Heading</h2><ul><li>item</li></ul>'
  )
})

test('H03: tables render as table/thead/tbody/tr/th/td without extra attributes', () => {
  const html = render([
    '| Name | Value |',
    '| --- | :---: |',
    '| **a** | `b` |',
    '| c | d |'
  ].join('\n'))
  assert.equal(
    html,
    '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>'
      + '<tr><td><strong>a</strong></td><td><code>b</code></td></tr>'
      + '<tr><td>c</td><td>d</td></tr>'
      + '</tbody></table>'
  )
  // The table tags carry no attributes at all (no align/style/class): the
  // renderer whitelist allows href/rel only.
  assert.doesNotMatch(html, /<(?:table|thead|tbody|tr|th|td)\s+[^>]/)
})

test('H03: a table only starts when a delimiter row follows', () => {
  // A paragraph that happens to contain "|" must stay a paragraph.
  assert.equal(render('a | b'), '<p>a | b</p>')
  assert.equal(render('| a | b |'), '<p>| a | b |</p>')
  // Delimiter detection is per cell and requires three dashes.
  assert.equal(render('| a |\n| - |'), '<p>| a |</p><p>| - |</p>')
  // Streaming: the header renders as a paragraph until the delimiter arrives.
  assert.equal(splitStreamBlocks('| a |').blocks.length, 0)
})

test('H03: headings h4-h6 are supported', () => {
  assert.equal(render('#### four'), '<h4>four</h4>')
  assert.equal(render('##### five'), '<h5>five</h5>')
  assert.equal(render('###### six'), '<h6>six</h6>')
  assert.equal(render('####### seven'), '<p>####### seven</p>')
})

test('H03: existing headings, lists, quotes, rules and inline styles do not regress', () => {
  assert.equal(render('# one'), '<h1>one</h1>')
  assert.equal(render('## two'), '<h2>two</h2>')
  assert.equal(render('### three'), '<h3>three</h3>')
  assert.equal(render('---'), '<hr>')
  assert.equal(render('> quoted'), '<blockquote>quoted</blockquote>')
  assert.equal(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
  assert.equal(
    render('**bold** *em* ~~gone~~ `code`'),
    '<p><strong>bold</strong> <em>em</em> <del>gone</del> <code>code</code></p>'
  )
  // A list between two paragraphs stays one list, not one per line.
  assert.equal(render('a\n- x\n- y\nb'), '<p>a</p><ul><li>x</li><li>y</li></ul><p>b</p>')
  // A second paragraph is still a paragraph even after a blank line.
  assert.equal(render('one\n\ntwo'), '<p>one</p><p>two</p>')
})

test('H03: HTML is escaped outside and inside code blocks', () => {
  assert.equal(render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  assert.equal(render('a & b < c > d'), '<p>a &amp; b &lt; c &gt; d</p>')
  assert.equal(render('```\n<script>alert(1)</script>\n```'), '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>')
  // A javascript: link keeps only its label; no navigable anchor is produced.
  assert.equal(render('[bad](javascript:alert)'), '<p>bad</p>')
  assert.equal(render('"quoted" \'single\''), '<p>&quot;quoted&quot; &#39;single&#39;</p>')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;')
})

test('H03: splitStreamBlocks only cuts at blank lines and closed fences', () => {
  // A blank line inside a fence is content, never a block boundary.
  const fenced = splitStreamBlocks('```js\nconst a = 1\n\nconst b = 2\n```')
  assert.deepEqual(fenced.blocks, ['```js\nconst a = 1\n\nconst b = 2\n```'])
  assert.equal(fenced.tail, '')

  // An open fence stays in the tail, even though it contains blank lines.
  const open = splitStreamBlocks('before\n\n```js\nconst a = 1\n\nconst b = 2')
  assert.deepEqual(open.blocks, ['before'])
  assert.equal(open.tail, '```js\nconst a = 1\n\nconst b = 2')

  // A closed fence is stable even without a following blank line.
  const closed = splitStreamBlocks('```\ncode\n```\nafter')
  assert.deepEqual(closed.blocks, ['```\ncode\n```'])
  assert.equal(closed.tail, 'after')

  // Blank lines close a list block the same way the renderer does.
  assert.deepEqual(splitStreamBlocks('- a\n- b\n\n- c').blocks, ['- a\n- b'])
})

test('H03: every streaming prefix renders identically from stable blocks plus tail', () => {
  // This is the invariant the two-level renderer depends on: appending
  // render(block) for the stable prefix and re-rendering the tail must produce
  // exactly the markup a full render would, at every character boundary a
  // stream can arrive at.
  const samples = [
    'para one\n\npara two',
    '```js\nconst a = 1\n\nconst b = 2\n```\n\nafter',
    'text\n```\ncode\n```\nmore',
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nafter table',
    '- a\n- b\n\n1. c\n2. d',
    '## head\n\n> quote\n\n---\n\n**bold** and `code`',
    '```python\n# comment\n\n- item\n  1. nested\n```',
    'plain\n\n```\nunclosed fence\n\nafter blank',
    'a\r\nb\r\n\r\nc',
    'no blank lines at all just one block',
    '```\n\n```',
    'para\n\n\n\npara2',
    '| a |\n| --- |\n| x |\n```\ncode\n```'
  ]
  for (const sample of samples) {
    for (let end = 0; end <= sample.length; end += 1) {
      const prefix = sample.slice(0, end)
      const { blocks, tail } = splitStreamBlocks(prefix)
      const splitHtml = blocks.map((block) => render(block)).join('') + render(tail)
      assert.equal(splitHtml, render(prefix), `${JSON.stringify(prefix)} must split losslessly`)
    }
  }
})

test('H03: planStreamUpdate appends new stable blocks and never re-renders old ones', () => {
  assert.deepEqual(planStreamUpdate([], []), { rebuild: false, appendFrom: 0 })
  assert.deepEqual(planStreamUpdate([], ['a']), { rebuild: false, appendFrom: 0 })
  // Append-only growth: only the new blocks are rendered.
  assert.deepEqual(planStreamUpdate(['a'], ['a', 'b']), { rebuild: false, appendFrom: 1 })
  assert.deepEqual(planStreamUpdate(['a', 'b'], ['a', 'b']), { rebuild: false, appendFrom: 2 })
  // A changed or shortened prefix cannot be patched: the stable DOM is rebuilt.
  assert.deepEqual(planStreamUpdate(['a'], ['a2']), { rebuild: true, appendFrom: 0 })
  assert.deepEqual(planStreamUpdate(['a', 'b'], ['a']), { rebuild: true, appendFrom: 0 })
  // Non-array input is treated as "nothing rendered yet".
  assert.deepEqual(planStreamUpdate(undefined, ['a']), { rebuild: false, appendFrom: 0 })
})

test('H03: a simulated stream appends each stable block exactly once', () => {
  const chunks = [
    'First paragraph.',
    '\n\nSecond ',
    'paragraph.\n\n',
    '```js\nconst a = 1\n',
    '\nconst b = 2\n',
    '```\n\n',
    'Done.'
  ]
  let content = ''
  let previousBlocks = []
  let appendedBlocks = 0
  let tailRenders = 0
  for (const chunk of chunks) {
    content += chunk
    const { blocks } = splitStreamBlocks(content)
    const plan = planStreamUpdate(previousBlocks, blocks)
    // A stream only ever appends, so the renderer never has to rebuild.
    assert.equal(plan.rebuild, false, `chunk ${JSON.stringify(chunk)} must not force a rebuild`)
    appendedBlocks += blocks.length - plan.appendFrom
    if (blocks.length > previousBlocks.length) {
      for (let index = 0; index < previousBlocks.length; index += 1) {
        assert.equal(blocks[index], previousBlocks[index], 'an emitted block never changes')
      }
    }
    if (splitStreamBlocks(content).tail) tailRenders += 1
    previousBlocks = blocks
  }
  const final = splitStreamBlocks(content)
  assert.equal(appendedBlocks, final.blocks.length, 'every stable block is rendered exactly once')
  assert.ok(tailRenders > 0, 'the active tail is re-rendered while streaming')
  assert.equal(final.tail, 'Done.')
})

test('H03: the action renderer wires the two-level streaming DOM', () => {
  // action.html must load the shared module before action.js.
  const moduleIndex = actionHtml.indexOf('shared/simple-markdown.js')
  const actionIndex = actionHtml.indexOf('src="action.js"')
  assert.ok(moduleIndex >= 0, 'action.html loads shared/simple-markdown.js')
  assert.ok(actionIndex > moduleIndex, 'the markdown module loads before action.js')

  // Streaming goes through the block splitter instead of the full innerHTML
  // replacement, and returns before the final-render assignment.
  assert.match(actionScript, /const markdown = window\.simpleMarkdown/)
  assert.match(actionScript, /markdown\.splitStreamBlocks\(turn\.content\)/)
  assert.match(actionScript, /markdown\.planStreamUpdate\(stream\.blocks, blocks\)/)
  assert.match(actionScript, /if \(cursor\) \{\s*renderStreamingAnswer\(turn\)\s*return\s*\}/)
  // Stable blocks are marked and appended; only the tail container is rewritten.
  assert.match(actionScript, /setAttribute\('data-stable', ''\)/)
  assert.match(actionScript, /setAttribute\('data-stream-tail', ''\)/)
  assert.match(actionScript, /stream\.stableEl\.replaceChildren\(\)/)
  assert.match(actionScript, /stream\.tailEl\.replaceChildren\(fragment\)/)

  // The sanitizer whitelist gained the table and h4-h6 tags, but no attributes:
  // tables must render without class/style/align.
  const tagsMatch = actionScript.match(/const ALLOWED_MARKDOWN_TAGS = \[([\s\S]*?)\]/)
  assert.ok(tagsMatch, 'ALLOWED_MARKDOWN_TAGS is declared')
  const tags = [...tagsMatch[1].matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1])
  for (const tag of ['h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td']) {
    assert.ok(tags.includes(tag), `${tag} must be allowed by DOMPurify`)
  }
  assert.match(actionScript, /ALLOWED_ATTR: \['href', 'rel'\]/)
})
