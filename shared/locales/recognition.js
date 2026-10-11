'use strict'

// Domain locale table: the recognition-result window (`recognition/`), i.e. the
// OCR table view and the QR-code view.
//
// Layout decision (2026-10-11, Lead; plan §10.3): one file per domain, each file
// registering all three languages for that domain. This file owns
// `recognition.*` alone, so the wave-9 `recognition` migration never shares a
// write target with another stream.
//
// The zh-CN column is byte-identical to the pre-migration literals: the migration
// must not change the visible behaviour (plan §10.4-T5, §10 acceptance ⑤). Note
// that the loading strings use the single-character ellipsis `…` (U+2026), not
// three ASCII dots — that is how the original literals were written.
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'recognition.title.window': '识别结果',
    'recognition.header.title': '识别结果',
    'recognition.header.close': '关闭',
    'recognition.badge.local-ocr': '本地 OCR',
    'recognition.status.loading': '正在处理…',
    'recognition.error.title': '识别失败',
    'recognition.error.read-qr-image': '无法读取二维码图片',
    'recognition.error.qr-not-found': '未识别到二维码，请保持二维码完整并适当扩大选区',
    'recognition.error.open-link': '打开链接失败：{detail}',
    'recognition.table.title': '表格识别',
    'recognition.table.summary': '{rows} 行 × {columns} 列',
    'recognition.table.loading': '正在恢复表格结构…',
    'recognition.qr.title': '二维码识别',
    'recognition.qr.summary-link': '已识别链接',
    'recognition.qr.summary-text': '已识别文本内容',
    'recognition.qr.loading': '正在扫描二维码…',
    'recognition.qr.content-label': '二维码内容',
    'recognition.format.label': '复制格式',
    'recognition.format.tsv': 'TSV（粘贴到表格）',
    'recognition.action.open-link': '打开链接',
    'recognition.action.copy': '复制',
    'recognition.action.copy-table': '复制表格',
    'recognition.action.copy-content': '复制内容',
    'recognition.action.copied': '已复制'
  })

  add('en-US', {
    'recognition.title.window': 'Recognition result',
    'recognition.header.title': 'Recognition result',
    'recognition.header.close': 'Close',
    'recognition.badge.local-ocr': 'Local OCR',
    'recognition.status.loading': 'Processing…',
    'recognition.error.title': 'Recognition failed',
    'recognition.error.read-qr-image': 'The QR-code image could not be read',
    'recognition.error.qr-not-found': 'No QR code was found; keep the code complete and widen the selection',
    'recognition.error.open-link': 'Opening the link failed: {detail}',
    'recognition.table.title': 'Table recognition',
    'recognition.table.summary': '{rows} rows × {columns} columns',
    'recognition.table.loading': 'Rebuilding the table structure…',
    'recognition.qr.title': 'QR code recognition',
    'recognition.qr.summary-link': 'Link recognised',
    'recognition.qr.summary-text': 'Text recognised',
    'recognition.qr.loading': 'Scanning the QR code…',
    'recognition.qr.content-label': 'QR-code content',
    'recognition.format.label': 'Copy format',
    'recognition.format.tsv': 'TSV (paste into a spreadsheet)',
    'recognition.action.open-link': 'Open link',
    'recognition.action.copy': 'Copy',
    'recognition.action.copy-table': 'Copy table',
    'recognition.action.copy-content': 'Copy content',
    'recognition.action.copied': 'Copied'
  })

  add('zh-TW', {
    'recognition.title.window': '辨識結果',
    'recognition.header.title': '辨識結果',
    'recognition.header.close': '關閉',
    'recognition.badge.local-ocr': '本機 OCR',
    'recognition.status.loading': '正在處理…',
    'recognition.error.title': '辨識失敗',
    'recognition.error.read-qr-image': '無法讀取二維碼圖片',
    'recognition.error.qr-not-found': '未辨識到二維碼，請保持二維碼完整並適當擴大選取範圍',
    'recognition.error.open-link': '開啟連結失敗：{detail}',
    'recognition.table.title': '表格辨識',
    'recognition.table.summary': '{rows} 列 × {columns} 欄',
    'recognition.table.loading': '正在還原表格結構…',
    'recognition.qr.title': '二維碼辨識',
    'recognition.qr.summary-link': '已辨識連結',
    'recognition.qr.summary-text': '已辨識文字內容',
    'recognition.qr.loading': '正在掃描二維碼…',
    'recognition.qr.content-label': '二維碼內容',
    'recognition.format.label': '複製格式',
    'recognition.format.tsv': 'TSV（貼到試算表）',
    'recognition.action.open-link': '開啟連結',
    'recognition.action.copy': '複製',
    'recognition.action.copy-table': '複製表格',
    'recognition.action.copy-content': '複製內容',
    'recognition.action.copied': '已複製'
  })
})()
