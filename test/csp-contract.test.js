const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const htmlFiles = [
  'action/action.html',
  'capture/capture.html',
  'config/config.html',
  'long-capture/long-capture.html',
  'long-capture/overlay.html',
  'pin/pin.html',
  'recognition/recognition.html',
  'record/frame.html',
  'record/record.html',
  'toolbar/toolbar.html'
]

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('every local page declares a restrictive content security policy', () => {
  for (const relativePath of htmlFiles) {
    const html = read(relativePath)
    const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/i)
    assert.ok(match, `${relativePath} is missing a CSP`)
    const policy = match[1]
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "connect-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "worker-src 'none'"
    ]) {
      assert.match(policy, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${relativePath}: ${directive}`)
    }
    const scriptPolicy = policy.match(/script-src\s+([^;]+)/)?.[1] || ''
    assert.doesNotMatch(scriptPolicy, /'unsafe-inline'|'unsafe-eval'|data:|blob:/, `${relativePath} weakens script-src`)

    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    assert.deepEqual(inlineScripts.map((item) => item[1].trim()), [], `${relativePath} contains inline script`)
    for (const source of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)) {
      assert.doesNotMatch(source[1], /^(?:https?:|data:|javascript:|file:)/i, `${relativePath} loads a non-local script`)
    }
  }
})

test('AI Markdown is cleaned by DOMPurify with an explicit allowlist', () => {
  const html = read('action/action.html')
  const action = read('action/action.js')
  const packageJson = JSON.parse(read('package.json'))

  assert.ok(packageJson.dependencies.dompurify)
  assert.match(html, /node_modules\/dompurify\/dist\/purify\.min\.js/)
  assert.ok(
    html.indexOf('purify.min.js') < html.indexOf('src="action.js"'),
    'DOMPurify must load before the action renderer'
  )
  assert.match(action, /window\.DOMPurify\.sanitize\(simpleMarkdown\(text\), \{/)
  assert.match(action, /ALLOWED_TAGS: MARKDOWN_TAGS/)
  assert.match(action, /ALLOWED_ATTR: \['href', 'target', 'rel'\]/)
  assert.match(action, /ALLOWED_URI_REGEXP: \/\^https\?:/)
  assert.doesNotMatch(action, /innerHTML\s*=\s*simpleMarkdown/)
  assert.doesNotMatch(action, /innerHTML\s*\+=/)
})

test('toolbar and pin behavior live in external scripts', () => {
  const toolbarHtml = read('toolbar/toolbar.html')
  const pinHtml = read('pin/pin.html')
  const toolbarScript = read('toolbar/toolbar.js')
  const pinScript = read('pin/pin.js')

  assert.match(toolbarHtml, /<script src="toolbar\.js"><\/script>/)
  assert.match(pinHtml, /<script src="pin\.js"><\/script>/)
  assert.match(toolbarScript, /window\.toolbarAPI\.onSelection/)
  assert.match(pinScript, /window\.pinAPI\.ready\(\)/)
})
