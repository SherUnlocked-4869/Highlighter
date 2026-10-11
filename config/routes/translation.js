// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 translation（翻译）。

function renderTranslation() {
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.translation'), t('config.translation.description'))}<div class="translation-layout"><section class="card text-panel"><div class="panel-tools"><select id="sourceLanguage"><option value="auto">${t('config.translation.source-auto')}</option><option value="中文">${t('config.language.zh')}</option><option value="英文">${t('config.language.en')}</option><option value="日文">${t('config.language.ja')}</option><option value="韩文">${t('config.language.ko')}</option></select><button class="button" id="swapLanguage">⇄</button></div><textarea class="textarea" id="sourceText" placeholder="${t('config.translation.source-placeholder')}"></textarea><div class="panel-actions"><button class="button" id="clearSource">${t('config.translation.clear')}</button><button class="button primary" id="translateNow">${t('config.translation.translate')}</button></div></section><section class="card text-panel"><div class="panel-tools"><select id="targetLanguage"><option value="中文">${t('config.language.zh')}</option><option value="英文">${t('config.language.en')}</option><option value="日文">${t('config.language.ja')}</option><option value="韩文">${t('config.language.ko')}</option><option value="繁体中文">${t('config.language.zh-hant')}</option></select></div><textarea class="textarea" id="translatedText" readonly placeholder="${t('config.translation.result-placeholder')}"></textarea><div class="panel-actions"><button class="button" id="copyTranslation">${t('config.translation.copy-result')}</button></div></section></div></div>`
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage || '中文'
  document.getElementById('translateNow').onclick = async () => {
    const source = document.getElementById('sourceText').value.trim(); if (!source) return
    const button = document.getElementById('translateNow'); button.disabled = true; button.textContent = t('config.translation.translating')
    try { document.getElementById('translatedText').value = await window.electronAPI.translateText(source, document.getElementById('sourceLanguage').value, document.getElementById('targetLanguage').value) }
    catch (error) { toast(error.message || String(error)) }
    finally { button.disabled = false; button.textContent = t('config.translation.translate') }
  }
  document.getElementById('clearSource').onclick = () => { document.getElementById('sourceText').value = ''; document.getElementById('translatedText').value = '' }
  document.getElementById('copyTranslation').onclick = async () => { await navigator.clipboard.writeText(document.getElementById('translatedText').value); toast(t('config.translation.copied')) }
  document.getElementById('swapLanguage').onclick = () => { const source = document.getElementById('sourceText'), target = document.getElementById('translatedText'); if (target.value) { const old = source.value; source.value = target.value; target.value = old } }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderTranslation'] = () => renderTranslation()
