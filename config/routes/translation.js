// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 translation（翻译）。

function renderTranslation() {
  view.innerHTML = `<div class="page">${pageHeader('翻译', '支持自动检测源语言和自定义目标语言；可与划词助手、截图 OCR 配合。')}<div class="translation-layout"><section class="card text-panel"><div class="panel-tools"><select id="sourceLanguage"><option value="auto">自动检测</option><option value="中文">中文</option><option value="英文">英文</option><option value="日文">日文</option><option value="韩文">韩文</option></select><button class="button" id="swapLanguage">⇄</button></div><textarea class="textarea" id="sourceText" placeholder="输入或粘贴要翻译的文本"></textarea><div class="panel-actions"><button class="button" id="clearSource">清空</button><button class="button primary" id="translateNow">翻译</button></div></section><section class="card text-panel"><div class="panel-tools"><select id="targetLanguage"><option>中文</option><option>英文</option><option>日文</option><option>韩文</option><option>繁体中文</option></select></div><textarea class="textarea" id="translatedText" readonly placeholder="翻译结果"></textarea><div class="panel-actions"><button class="button" id="copyTranslation">复制结果</button></div></section></div></div>`
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage || '中文'
  document.getElementById('translateNow').onclick = async () => {
    const source = document.getElementById('sourceText').value.trim(); if (!source) return
    const button = document.getElementById('translateNow'); button.disabled = true; button.textContent = '翻译中…'
    try { document.getElementById('translatedText').value = await window.electronAPI.translateText(source, document.getElementById('sourceLanguage').value, document.getElementById('targetLanguage').value) }
    catch (error) { toast(error.message || String(error)) }
    finally { button.disabled = false; button.textContent = '翻译' }
  }
  document.getElementById('clearSource').onclick = () => { document.getElementById('sourceText').value = ''; document.getElementById('translatedText').value = '' }
  document.getElementById('copyTranslation').onclick = async () => { await navigator.clipboard.writeText(document.getElementById('translatedText').value); toast('译文已复制') }
  document.getElementById('swapLanguage').onclick = () => { const source = document.getElementById('sourceText'), target = document.getElementById('translatedText'); if (target.value) { const old = source.value; source.value = target.value; target.value = old } }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderTranslation'] = () => renderTranslation()
