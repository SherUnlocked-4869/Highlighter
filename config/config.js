var apiKeyInput = document.getElementById('apiKey')
var statusEl = document.getElementById('status')
var btnSave = document.getElementById('btnSave')
var btnToggle = document.getElementById('btnToggle')

async function init() {
  var key = await window.electronAPI.getApiKey()
  if (key) { apiKeyInput.value = key; showStatus('已加载保存的 API Key', 'info') }
}

function showStatus(msg, type) { statusEl.textContent = msg; statusEl.className = 'status ' + (type || '') }

async function testApiKey(key) {
  if (!key || !key.startsWith('sk-')) { showStatus('API Key 格式不正确', 'error'); return false }
  showStatus('正在测试连接...', 'info'); btnSave.disabled = true; btnSave.textContent = '测试中...'
  try {
    var ok = await window.electronAPI.testConnection(key)
    if (ok) { showStatus('连接成功', 'success'); return true }
    else { showStatus('连接失败，请检查 API Key', 'error'); return false }
  } catch(e) { showStatus('连接失败，请检查网络', 'error'); return false }
  finally { btnSave.disabled = false; btnSave.textContent = '保存并启动' }
}

btnToggle.addEventListener('click', function() {
  var isPw = apiKeyInput.type === 'password'
  apiKeyInput.type = isPw ? 'text' : 'password'
  btnToggle.textContent = isPw ? '🙈' : '👁'
})

btnSave.addEventListener('click', async function() {
  var key = apiKeyInput.value.trim()
  if (!key) { showStatus('请输入 API Key', 'error'); return }
  var ok = await testApiKey(key)
  if (!ok) return
  await window.electronAPI.saveApiKey(key)
  await window.electronAPI.onStartHook(key)
  showStatus('配置已保存', 'success')
  setTimeout(function() { window.close() }, 1000)
})

document.getElementById('linkGetKey').addEventListener('click', function(e) {
  e.preventDefault()
  window.electronAPI.openExternal('https://platform.deepseek.com/api_keys')
})

apiKeyInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') btnSave.click() })

init()
