const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
const config = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'config', 'config.css'), 'utf8')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

test('preload exposes fixed history management methods', () => {
  assert.match(preload, /getHistoryStats:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('history:stats'\)/)
  assert.match(preload, /getHistoryThumbnail:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('history:thumbnail', id\)/)
  assert.match(preload, /deleteHistoryMany:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\('history:delete-many', ids\)/)
  assert.match(preload, /exportHistory:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\('history:export', ids\)/)
  assert.match(preload, /cleanupHistory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('history:cleanup'\)/)
  assert.match(preload, /openHistory:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('history:open', id\)/)
  assert.match(preload, /copyHistoryPath:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('history:copy-path', id\)/)
})

test('history page renders storage statistics and batch controls', () => {
  assert.match(config, /window\.electronAPI\.getHistoryStats\(\)/)
  assert.match(config, /id="selectAllHistory"/)
  assert.match(config, /id="exportSelectedHistory"/)
  assert.match(config, /id="deleteSelectedHistory"/)
  assert.match(config, /data-history-select/)
  assert.match(config, /IntersectionObserver/)
  assert.match(config, /id="loadMoreHistory"/)
  assert.match(config, /limit:\s*HISTORY_PAGE_SIZE/)
  assert.match(config, /stats\.missingCount/)
  assert.match(config, /stats\.orphanCount/)
  assert.match(styles, /\.history-stats\{/)
  assert.match(styles, /\.history-batch\{/)
  assert.match(styles, /\.history-item\.selected\{/)
  assert.match(styles, /\.history-image img\{display:block;width:100%;height:100%;object-fit:contain\}/)
})

test('history action buttons keep readable color in dark mode', () => {
  assert.match(styles, /\.history-actions button\{[^}]*color:var\(--text\)/)
})

test('history page opens screenshots with the default application', () => {
  assert.match(config, /data-history-action="open"[^>]*>打开<\/button>/)
  assert.match(config, /window\.electronAPI\.openHistory\(id\)/)
  assert.match(main, /shell\.openPath\(item\.filePath\)/)
})

test('history page copies a screenshot absolute path instead of revealing it', () => {
  assert.match(config, /data-history-action="address"[^>]*>地址<\/button>/)
  assert.match(config, /window\.electronAPI\.copyHistoryPath\(id\)/)
  assert.match(config, /图片地址已复制/)
  assert.match(main, /clipboard\.writeText\(path\.resolve\(item\.filePath\)\)/)
  assert.doesNotMatch(config, /data-history-action="reveal"[^>]*>定位<\/button>/)
  assert.doesNotMatch(preload, /history:reveal|revealHistory/)
})

test('capture file names use China Standard Time (UTC+8)', () => {
  assert.match(main, /function makeCaptureName\(prefix = 'Highlighter'\)[\s\S]{0,300}?8 \* 60 \* 60 \* 1000/)
  assert.doesNotMatch(main, /function makeCaptureName\(prefix = 'Highlighter'\)[\s\S]{0,300}?new Date\(\)\.toISOString\(\)\.replace/)
})

test('history page does not expose favorite controls or state', () => {
  assert.doesNotMatch(preload, /history:favorite|setHistoryFavorite/)
  assert.doesNotMatch(config, /historyFavorites|favorite-button|仅收藏|取消收藏/)
  assert.doesNotMatch(styles, /favorite-button|history-item\.favorite/)
  assert.doesNotMatch(main, /setFavorite/)
})

test('history page confirms destructive cleanup and reports partial failures', () => {
  assert.match(config, /confirm\(`确定删除选中的 \$\{historySelectedIds\.size\} 项截图及对应文件？`\)/)
  assert.match(config, /window\.electronAPI\.deleteHistoryMany\(\[\.\.\.historySelectedIds\]\)/)
  assert.match(config, /未被引用的 Highlighter 文件/)
  assert.match(config, /window\.electronAPI\.cleanupHistory\(\)/)
  assert.match(config, /result\.failures\?\.length/)
})

test('main process owns the export directory picker', () => {
  assert.match(main, /title: '选择截图导出目录'/)
  assert.match(main, /properties: \['openDirectory', 'createDirectory'\]/)
  assert.match(main, /exportMany: \(ids, directory\) => historyService\.exportMany\(ids, directory\)/)
})
