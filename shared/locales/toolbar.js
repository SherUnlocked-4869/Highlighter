'use strict'

// Domain locale table: the selection toolbar strip (`toolbar/`).
//
// Layout decision (2026-10-11, Lead; plan §10.3): one file per domain, each file
// registering all three languages for that domain. This file owns `toolbar.*`
// alone, so the wave-9 `toolbar` migration never shares a write target with
// another stream.
//
// The zh-CN column is byte-identical to the pre-migration literals: the migration
// must not change the visible behaviour (plan §10.4-T5, §10 acceptance ⑤).
//
// Who reads these keys:
//   * `toolbar/toolbar-action-meta.js` holds them as `label` / `description`
//     *keys* (it runs under Node too, so it cannot call `t()` itself);
//   * `toolbar/toolbar.js` resolves the label for the strip;
//   * `config/routes/*.js` renders the same strings in the settings page and
//     resolves them the same way (see the S12 wiring note — one call site).
;
// Deliberately NOT here (see the S12 report):
//   * `DEFAULT_TRANSLATE_PROMPT` / `DEFAULT_EXPLAIN_PROMPT` in
//     `toolbar/toolbar-utils.js`: prompts do not follow the UI language
//     (plan §10.5-4);
//   * `TRANSLATE_SOURCE_LANGUAGES` / `TRANSLATE_TARGET_LANGUAGES` /
//     `DEFAULT_TRANSLATE_LANGUAGES`: these members are the persisted settings
//     values and part of the model API contract, not labels (plan §10.5-3).
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'toolbar.action.copy.label': '复制',
    'toolbar.action.copy.description': '复制划词内容到系统剪贴板',
    'toolbar.action.search.label': '搜索',
    'toolbar.action.search.description': '使用默认浏览器搜索划词内容',
    'toolbar.action.translate.label': '翻译',
    'toolbar.action.translate.description': '使用下方自定义提示词翻译划词内容',
    'toolbar.action.explain.label': '解释',
    'toolbar.action.explain.description': '使用下方自定义提示词解释划词内容',
    'toolbar.action.open.label': '跳转',
    'toolbar.action.open.description': '在默认浏览器中打开划词内容，内容将直接作为网址跳转'
  })

  add('en-US', {
    'toolbar.action.copy.label': 'Copy',
    'toolbar.action.copy.description': 'Copy the selected text to the system clipboard',
    'toolbar.action.search.label': 'Search',
    'toolbar.action.search.description': 'Search the web for the selected text in the default browser',
    'toolbar.action.translate.label': 'Translate',
    'toolbar.action.translate.description': 'Translate the selected text with the custom prompt below',
    'toolbar.action.explain.label': 'Explain',
    'toolbar.action.explain.description': 'Explain the selected text with the custom prompt below',
    'toolbar.action.open.label': 'Open',
    'toolbar.action.open.description': 'Open the selected text in the default browser, using it directly as the address'
  })

  add('zh-TW', {
    'toolbar.action.copy.label': '複製',
    'toolbar.action.copy.description': '複製劃詞內容到系統剪貼簿',
    'toolbar.action.search.label': '搜尋',
    'toolbar.action.search.description': '使用預設瀏覽器搜尋劃詞內容',
    'toolbar.action.translate.label': '翻譯',
    'toolbar.action.translate.description': '使用下方自訂提示詞翻譯劃詞內容',
    'toolbar.action.explain.label': '解釋',
    'toolbar.action.explain.description': '使用下方自訂提示詞解釋劃詞內容',
    'toolbar.action.open.label': '跳轉',
    'toolbar.action.open.description': '在預設瀏覽器中開啟劃詞內容，內容將直接作為網址跳轉'
  })
})()
