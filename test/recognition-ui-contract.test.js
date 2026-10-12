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

// 热切换修复（批次 C 遗留）：#title 带 data-i18n，语言广播先做 applyTranslations()，
// 所以脚本必须在同一个广播里按当前视图重写标题，否则标题会退回静态 markup 文案。
test('renderCurrentView owns the window title for every view state', () => {
  const view = script.match(/function renderCurrentView\(\) \{[\s\S]*?\n\}/)
  assert.ok(view, 'renderCurrentView() must exist')
  const body = view[0]
  // 错误视图：标题与徽标都用错误键（徽标行为不变）。
  assert.match(body, /!errorView\.classList\.contains\('hidden'\)[\s\S]*?title\.textContent = t\('recognition\.error\.title'\)[\s\S]*?setBadge\(t\('recognition\.error\.title'\), true\)/)
  // 表格视图委托给 renderTable()，二维码视图委托给 renderQr()。
  assert.match(body, /if \(tableResult\) \{\s*\n\s*renderTable\(tableResult\)/)
  assert.match(body, /!qrView\.classList\.contains\('hidden'\)[\s\S]*?renderQr\(qrResult\)/)
  // 加载中/无结果：回到 markup 的表头文案。
  assert.match(body, /title\.textContent = t\('recognition\.header\.title'\)/)
  // 被委托的两个渲染函数确实自己写标题。
  assert.match(script, /function renderTable\(result\) \{[\s\S]*?title\.textContent = t\('recognition\.table\.title'\)/)
  assert.match(script, /function renderQr\(value\) \{[\s\S]*?title\.textContent = t\('recognition\.qr\.title'\)/)
  // 加载态标题不再由 onInit 抢先写成结果标题（那是 renderTable/renderQr 的职责）。
  assert.doesNotMatch(script, /title\.textContent = t\('recognition\.(?:table|qr)\.title'\)\s*\n\s*loadingKey/)
})

// 1 秒内切换语言时，恢复的复制标签必须是新语言，所以键保留、t() 放进定时器里。
test('the copy label restore resolves its key after a language switch', () => {
  assert.match(script, /const restoreKey = tableResult \? 'recognition\.action\.copy-table' : 'recognition\.action\.copy-content'/)
  assert.match(script, /setTimeout\(\(\) => \{ copyButton\.textContent = t\(restoreKey\) \}, 1000\)/)
  assert.match(script, /copyButton\.textContent = t\('recognition\.action\.copied'\)/)
  assert.doesNotMatch(script, /const original = t\(/, 'the pre-switch sentence must not be captured')
})
