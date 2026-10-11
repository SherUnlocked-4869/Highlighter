const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readConfigSource } = require('./helpers/config-source')

const root = path.join(__dirname, '..')
const configHtml = fs.readFileSync(path.join(root, 'config', 'config.html'), 'utf8')
const configScript = readConfigSource()
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

test('visible config UI uses Highlighter-owned copy and project links', () => {
  assert.doesNotMatch(configHtml, /Snow\s*Shot|snowshot/i)
  assert.doesNotMatch(configScript, /Snow\s*Shot|snowshot/i)
  // P0-1-T3（S1，批次 C）：设置页文案迁入 shared/locales/config.js（readConfigSource()
  // 已把该语言表拼进源码），按钮改用键取文案 —— 这里改断言"按钮带键 + 文案仍存在"。
  assert.match(configScript, /id="openProjectHome">\$\{t\('config\.about\.project-home'\)\}</)
  assert.match(configScript, /'config\.about\.project-home': '项目主页'/)
  assert.match(configScript, /github\.com\/SherUnlocked-4869\/Highlighter/)
})

test('Chinese README introduces the project and credits its inspiration once near the start', () => {
  assert.match(readme, /^# Highlighter/)
  assert.match(readme.slice(0, 400), /Snow Shot/)
  assert.equal((readme.match(/Snow Shot/g) || []).length, 1)
  assert.match(readme, /## 功能概览/)
  assert.match(readme, /## 构建 Windows 安装包/)
})
