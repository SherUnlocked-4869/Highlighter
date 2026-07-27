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
  assert.match(preload, /deleteHistoryMany:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\('history:delete-many', ids\)/)
  assert.match(preload, /exportHistory:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\('history:export', ids\)/)
  assert.match(preload, /cleanupHistory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('history:cleanup'\)/)
})

test('history page renders storage statistics and batch controls', () => {
  assert.match(config, /window\.electronAPI\.getHistoryStats\(\)/)
  assert.match(config, /id="selectAllHistory"/)
  assert.match(config, /id="exportSelectedHistory"/)
  assert.match(config, /id="deleteSelectedHistory"/)
  assert.match(config, /data-history-select/)
  assert.match(config, /stats\.missingCount/)
  assert.match(config, /stats\.orphanCount/)
  assert.match(styles, /\.history-stats\{/)
  assert.match(styles, /\.history-batch\{/)
  assert.match(styles, /\.history-item\.selected\{/)
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
