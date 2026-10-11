'use strict'

// D2-1（Wave 8.5 / S14）：把 15 个契约测试对 `config/config.js` 的**源码文本断言**与
// "代码落在哪个文件"解耦。
//
// 背景：D2 会把 `config/config.js`（1839 行单体）里的 render 函数搬到 `config/routes/*.js`。
// 那些测试断言的是"设置页源码里有某段字符串/某个顺序"，与它落在哪个文件无关，但直接
// `readFileSync('config/config.js')` 会让搬迁后 ~170 处断言集体失败（方案 §3.4.1 第 5 条）。
//
// 因此统一改走本 helper：读取"主壳 + 全部路由文件"的拼接结果。搬迁时断言无需逐条修改；
// 新增路由文件也自动被覆盖（`config/routes/` 目录扫描，按文件名排序保证拼接顺序稳定）。
//
// 注意：**顺序敏感**的断言（例如 `html.indexOf('shared/coding-plan-presets.js') < html.indexOf('config.js')`
// 这类跨文件比较）不在本 helper 的职责内 —— 它们比的是 HTML 里的 script 顺序，与 D2 无关。

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const CONFIG_DIRECTORY = path.join(ROOT, 'config')
const ROUTES_DIRECTORY = path.join(CONFIG_DIRECTORY, 'routes')

// 主壳永远第一，其后是按文件名排序的路由文件。
function configSourceFiles () {
  const files = [path.join(CONFIG_DIRECTORY, 'config.js')]
  if (fs.existsSync(ROUTES_DIRECTORY)) {
    const routes = fs.readdirSync(ROUTES_DIRECTORY)
      .filter((name) => name.endsWith('.js'))
      .sort()
    for (const name of routes) files.push(path.join(ROUTES_DIRECTORY, name))
  }
  return files
}

// 拼接后的设置页源码（测试用它做 assert.match / doesNotMatch）。
function readConfigSource () {
  return configSourceFiles()
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
}

// 只读**主壳** `config/config.js`。给"文件边界"类断言用 —— 例如
// "config.js 不得重新定义纯函数 helper"：那种断言问的是"这段代码在不在主壳里"，
// 用拼接结果会让搬到 routes/ 的定义反而触发失败（D2-4 口径）。
function readConfigShell () {
  return fs.readFileSync(path.join(CONFIG_DIRECTORY, 'config.js'), 'utf8')
}

module.exports = {
  configSourceFiles,
  readConfigShell,
  readConfigSource
}
