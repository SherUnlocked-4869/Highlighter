'use strict'

// Domain locale table: the local-search window (`search/`).
//
// Layout decision (2026-10-11, Lead; plan §10.3): one file per domain, each file
// registering all three languages for that domain. This file owns `search.*`
// alone, so the wave-9 `search` migration never shares a write target with
// another stream.
//
// The zh-CN column is byte-identical to the pre-migration literals: the migration
// must not change the visible behaviour (plan §10.4-T5, §10 acceptance ⑤).
//
// `search/search-utils.js` runs under Node too (`test/search-utils.test.js`), so
// its DEFAULT_CATEGORIES / SORT_OPTIONS label fields hold these keys instead of
// sentences and `search.js` resolves them with `t()` at render time. User-defined
// categories keep their own free-text labels; `t()` returns them unchanged.
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'search.title.window': '本地搜索',
    'search.input.placeholder': '搜索本地文件（支持 Everything 语法，如 ext:pdf 报告）',
    'search.input.clear': '清空',
    'search.window.close': '关闭 (Esc)',
    'search.tabs.label': '搜索分类',
    'search.empty.prompt': '输入关键字开始搜索',
    'search.empty.searching': '正在搜索...',
    'search.empty.no-results': '没有找到结果',
    'search.status.detecting': '正在检测 Everything...',
    'search.status.ready': 'Everything 已就绪',
    'search.status.ready-version': 'Everything 已就绪 · v{version}',
    'search.status.index-empty': ' · 索引暂无内容（可能需要以管理员身份运行 Everything 或安装 Everything 服务）',
    'search.count.loaded': '已加载 {loaded} / 共 {total} 条结果',
    'search.action.reveal': '打开所在目录',
    'search.action.copy-path': '复制路径',
    'search.toggle.match-path-title': '同时匹配文件名和完整路径',
    'search.toggle.match-path': '匹配路径',
    'search.sort.label': '排序方式',
    'search.error.query-failed': '查询失败',
    'search.category.fallback': '全部',
    'search.category.all': '全部',
    'search.category.folder': '文件夹',
    'search.category.image': '图片',
    'search.category.video': '视频',
    'search.category.audio': '音频',
    'search.category.archive': '压缩文件',
    'search.sort.modified-desc': '按修改时间降序',
    'search.sort.modified-asc': '按修改时间升序',
    'search.sort.name-asc': '按名称升序',
    'search.sort.name-desc': '按名称降序',
    'search.sort.path-asc': '按路径升序',
    'search.sort.path-desc': '按路径降序',
    'search.sort.size-asc': '按大小升序',
    'search.sort.size-desc': '按大小降序'
  })

  add('en-US', {
    'search.title.window': 'Local search',
    'search.input.placeholder': 'Search local files (Everything syntax works, e.g. ext:pdf report)',
    'search.input.clear': 'Clear',
    'search.window.close': 'Close (Esc)',
    'search.tabs.label': 'Search categories',
    'search.empty.prompt': 'Type a keyword to start searching',
    'search.empty.searching': 'Searching...',
    'search.empty.no-results': 'No results found',
    'search.status.detecting': 'Detecting Everything...',
    'search.status.ready': 'Everything is ready',
    'search.status.ready-version': 'Everything is ready · v{version}',
    'search.status.index-empty': ' · the index is empty (Everything may need to run as administrator, or the Everything service may need to be installed)',
    'search.count.loaded': 'Loaded {loaded} of {total} results',
    'search.action.reveal': 'Open containing folder',
    'search.action.copy-path': 'Copy path',
    'search.toggle.match-path-title': 'Match both the file name and the full path',
    'search.toggle.match-path': 'Match path',
    'search.sort.label': 'Sort order',
    'search.error.query-failed': 'The query failed',
    'search.category.fallback': 'All',
    'search.category.all': 'All',
    'search.category.folder': 'Folder',
    'search.category.image': 'Images',
    'search.category.video': 'Videos',
    'search.category.audio': 'Audio',
    'search.category.archive': 'Archives',
    'search.sort.modified-desc': 'Newest modified first',
    'search.sort.modified-asc': 'Oldest modified first',
    'search.sort.name-asc': 'Name A to Z',
    'search.sort.name-desc': 'Name Z to A',
    'search.sort.path-asc': 'Path A to Z',
    'search.sort.path-desc': 'Path Z to A',
    'search.sort.size-asc': 'Smallest first',
    'search.sort.size-desc': 'Largest first'
  })

  add('zh-TW', {
    'search.title.window': '本機搜尋',
    'search.input.placeholder': '搜尋本機檔案（支援 Everything 語法，如 ext:pdf 報告）',
    'search.input.clear': '清除',
    'search.window.close': '關閉 (Esc)',
    'search.tabs.label': '搜尋分類',
    'search.empty.prompt': '輸入關鍵字開始搜尋',
    'search.empty.searching': '正在搜尋...',
    'search.empty.no-results': '沒有找到結果',
    'search.status.detecting': '正在偵測 Everything...',
    'search.status.ready': 'Everything 已就緒',
    'search.status.ready-version': 'Everything 已就緒 · v{version}',
    'search.status.index-empty': ' · 索引暫無內容（可能需要以系統管理員身分執行 Everything 或安裝 Everything 服務）',
    'search.count.loaded': '已載入 {loaded} / 共 {total} 筆結果',
    'search.action.reveal': '開啟所在資料夾',
    'search.action.copy-path': '複製路徑',
    'search.toggle.match-path-title': '同時匹配檔案名稱與完整路徑',
    'search.toggle.match-path': '匹配路徑',
    'search.sort.label': '排序方式',
    'search.error.query-failed': '查詢失敗',
    'search.category.fallback': '全部',
    'search.category.all': '全部',
    'search.category.folder': '資料夾',
    'search.category.image': '圖片',
    'search.category.video': '影片',
    'search.category.audio': '音訊',
    'search.category.archive': '壓縮檔',
    'search.sort.modified-desc': '依修改時間遞減',
    'search.sort.modified-asc': '依修改時間遞增',
    'search.sort.name-asc': '依名稱遞增',
    'search.sort.name-desc': '依名稱遞減',
    'search.sort.path-asc': '依路徑遞增',
    'search.sort.path-desc': '依路徑遞減',
    'search.sort.size-asc': '依大小遞增',
    'search.sort.size-desc': '依大小遞減'
  })
})()
