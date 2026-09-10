const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const aiIndex = fs.readFileSync(path.join(root, 'main/services/ai/index.js'), 'utf8')

test('main process uses a single AI client entry instead of ad-hoc deepseek requires', () => {
  assert.match(main, /require\('\.\/main\/services\/ai'\)/)
  assert.match(main, /const aiClient = require\('\.\/main\/services\/ai'\)/)
  assert.doesNotMatch(main, /require\('\.\/deepseek'\)/)
  assert.match(main, /aiClient\.validateApiKey/)
  assert.match(main, /aiClient\.completeChat/)
  assert.match(main, /aiClient\.translateText/)
  assert.match(main, /aiClient\.translateOcrTextBlocks/)
  assert.match(aiIndex, /require\('\.\.\/\.\.\/\.\.\/deepseek'\)/)
})
