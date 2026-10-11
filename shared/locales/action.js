'use strict'

// Domain locale table: the selection assistant window (`action/`), i.e. the
// 划词助手 popover that shows an AI answer for the selected text.
//
// Layout decision (2026-10-11, Lead; plan §10.3): one file per domain, each file
// registering all three languages for that domain. This file owns `action.*`
// alone, so the wave-9 `action` migration never shares a write target with
// another stream.
//
// The zh-CN column is byte-identical to the pre-migration literals: the migration
// must not change the visible behaviour (plan §10.4-T5, §10 acceptance ⑤).
//
// Deliberately NOT here (see the S12 report):
//   * `action/conversation-text.js` — the 【…】 markers and （…） notes are the
//     transcript format that is copied to the clipboard and fed back to the model,
//     not UI chrome (plan §10.5-4 keeps prompts out of the UI language);
//   * the AI prompts in `main/services/action-conversation.js` (main process, S13).
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'action.title.window': '划词助手',
    'action.pin.pin': '置顶',
    'action.pin.unpin': '取消置顶',
    'action.pin.window': '置顶窗口',
    'action.loading.requesting': '正在请求 DeepSeek...',
    'action.loading.translating': '正在翻译...',
    'action.loading.thinking': '正在思考...',
    'action.header.translating': '翻译中...',
    'action.composer.placeholder': '就上面的结果继续追问…',
    'action.composer.send': '发送',
    'action.composer.stop': '停止生成',
    'action.composer.quote-selected': '引用回答里选中的片段',
    'action.composer.quote': '引用选中',
    'action.composer.regenerate-hint': '重新生成最近一轮追问',
    'action.composer.regenerate': '重新生成',
    'action.composer.copy-hint': '复制整段对话',
    'action.composer.copy': '复制对话',
    'action.composer.copied': '已复制',
    'action.composer.copy-failed': '复制失败',
    'action.composer.reason.unavailable': '当前无法追问',
    'action.composer.reason.first-request-failed': '首次请求失败，无法继续追问，请重新划词',
    'action.composer.reason.max-turns': '已达到最大追问轮数（{maxTurns}），请重新划词开始新会话',
    'action.composer.notice.quote-truncated': '引用已截断到 {maxLength} 字',
    'action.composer.notice.retry-failed': '重新生成失败，请重试',
    'action.composer.notice.send-failed': '追问发送失败，请重试',
    'action.composer.notice.cancelled': '已取消本次追问',
    'action.turn.stopped': '已停止生成',
    'action.turn.interrupted': '窗口已隐藏，生成已中断',
    'action.turn.error': '错误: {detail}',
    'action.turn.error-timeout': '请求超时，请检查网络后重试',
    'action.turn.omitted': '已省略更早的 {count} 轮对话以控制上下文长度',
    'action.reasoning.title': '思考过程',
    'action.answer.label.translate': '翻译',
    'action.answer.label.explain': '解释',
    'action.error.open-link': '无法打开链接',
    'action.error.pin-limit': '最多只能置顶 {max} 个窗口，请先取消其他窗口的置顶。'
  })

  add('en-US', {
    'action.title.window': 'Selection assistant',
    'action.pin.pin': 'Pin on top',
    'action.pin.unpin': 'Unpin',
    'action.pin.window': 'Pin the window on top',
    'action.loading.requesting': 'Requesting DeepSeek...',
    'action.loading.translating': 'Translating...',
    'action.loading.thinking': 'Thinking...',
    'action.header.translating': 'Translating...',
    'action.composer.placeholder': 'Ask a follow-up about the result above…',
    'action.composer.send': 'Send',
    'action.composer.stop': 'Stop generating',
    'action.composer.quote-selected': 'Quote the selected part of the answer',
    'action.composer.quote': 'Quote selection',
    'action.composer.regenerate-hint': 'Regenerate the latest follow-up',
    'action.composer.regenerate': 'Regenerate',
    'action.composer.copy-hint': 'Copy the whole conversation',
    'action.composer.copy': 'Copy conversation',
    'action.composer.copied': 'Copied',
    'action.composer.copy-failed': 'Copy failed',
    'action.composer.reason.unavailable': 'Follow-up is unavailable right now',
    'action.composer.reason.first-request-failed': 'The first request failed, so follow-up is unavailable; select the text again',
    'action.composer.reason.max-turns': 'The maximum of {maxTurns} follow-ups was reached; select the text again to start a new conversation',
    'action.composer.notice.quote-truncated': 'The quote was truncated to {maxLength} characters',
    'action.composer.notice.retry-failed': 'Regeneration failed; try again',
    'action.composer.notice.send-failed': 'Sending the follow-up failed; try again',
    'action.composer.notice.cancelled': 'The follow-up was cancelled',
    'action.turn.stopped': 'Generation stopped',
    'action.turn.interrupted': 'The window was hidden, so generation was interrupted',
    'action.turn.error': 'Error: {detail}',
    'action.turn.error-timeout': 'The request timed out; check the network and try again',
    'action.turn.omitted': '{count} earlier conversation rounds were omitted to keep the context short',
    'action.reasoning.title': 'Reasoning',
    'action.answer.label.translate': 'Translation',
    'action.answer.label.explain': 'Explanation',
    'action.error.open-link': 'The link could not be opened',
    'action.error.pin-limit': 'At most {max} windows can be pinned; unpin another window first.'
  })

  add('zh-TW', {
    'action.title.window': '劃詞助手',
    'action.pin.pin': '置頂',
    'action.pin.unpin': '取消置頂',
    'action.pin.window': '置頂視窗',
    'action.loading.requesting': '正在請求 DeepSeek...',
    'action.loading.translating': '正在翻譯...',
    'action.loading.thinking': '正在思考...',
    'action.header.translating': '翻譯中...',
    'action.composer.placeholder': '就上面的結果繼續追問…',
    'action.composer.send': '傳送',
    'action.composer.stop': '停止生成',
    'action.composer.quote-selected': '引用回答裡選取的片段',
    'action.composer.quote': '引用選取',
    'action.composer.regenerate-hint': '重新生成最近一輪追問',
    'action.composer.regenerate': '重新生成',
    'action.composer.copy-hint': '複製整段對話',
    'action.composer.copy': '複製對話',
    'action.composer.copied': '已複製',
    'action.composer.copy-failed': '複製失敗',
    'action.composer.reason.unavailable': '目前無法追問',
    'action.composer.reason.first-request-failed': '首次請求失敗，無法繼續追問，請重新劃詞',
    'action.composer.reason.max-turns': '已達到最大追問輪數（{maxTurns}），請重新劃詞開始新對話',
    'action.composer.notice.quote-truncated': '引用已截斷到 {maxLength} 字',
    'action.composer.notice.retry-failed': '重新生成失敗，請重試',
    'action.composer.notice.send-failed': '追問傳送失敗，請重試',
    'action.composer.notice.cancelled': '已取消本次追問',
    'action.turn.stopped': '已停止生成',
    'action.turn.interrupted': '視窗已隱藏，生成已中斷',
    'action.turn.error': '錯誤: {detail}',
    'action.turn.error-timeout': '請求逾時，請檢查網路後重試',
    'action.turn.omitted': '已省略較早的 {count} 輪對話以控制上下文長度',
    'action.reasoning.title': '思考過程',
    'action.answer.label.translate': '翻譯',
    'action.answer.label.explain': '解釋',
    'action.error.open-link': '無法開啟連結',
    'action.error.pin-limit': '最多只能置頂 {max} 個視窗，請先取消其他視窗的置頂。'
  })
})()
