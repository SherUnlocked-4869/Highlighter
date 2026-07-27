const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const script = fs.readFileSync(path.join(__dirname, '..', 'recognition', 'recognition.js'), 'utf8')

test('opening a recognized QR link closes the result window after handoff', () => {
  assert.match(script, /openLink\.onclick\s*=\s*async\s*\(\)\s*=>/)
  assert.match(script, /await window\.recognitionAPI\.openExternal\(activeUrl\)[\s\S]*window\.recognitionAPI\.close\(\)/)
  assert.match(script, /catch \(error\)[\s\S]*openLink\.disabled = false/)
})
