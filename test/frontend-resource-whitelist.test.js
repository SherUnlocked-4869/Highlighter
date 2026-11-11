'use strict'

// R0 首批任务：前端资源打包白名单校验（计划 §3.1）。
//
// 证明 Tauri 前端资源只能来自白名单登记的页面/shared/assets 目录，
// 收集结果确定性可复现，输出目录受控，且禁止 main/、preload、测试、
// native/、node_modules 等被嵌入。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const resources = require('../scripts/rust/collect-frontend-resources.js')

const REPO_ROOT = resources.REPO_ROOT
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'rust', 'collect-frontend-resources.js')
const SCRATCH_DIR = path.join(REPO_ROOT, '.tmp-frontend-whitelist-test')

function cloneWhitelist(whitelist) {
  return JSON.parse(JSON.stringify(whitelist))
}

function collect() {
  const whitelist = resources.loadWhitelist()
  const manifest = resources.collectResources({ whitelist })
  resources.assertCoverage(manifest, whitelist)
  return { whitelist, manifest }
}

test('白名单登记 10 个页面 + shared + assets，且通过结构自检', () => {
  const whitelist = resources.loadWhitelist()
  assert.equal(whitelist.schemaVersion, 1)
  assert.equal(whitelist.kind, 'highlighter.frontend-resources')
  const pages = whitelist.sources.filter((source) => source.role === 'page')
  assert.deepEqual(
    pages.map((source) => source.root).sort(),
    ['action', 'capture', 'clipboard', 'config', 'long-capture', 'pin', 'recognition', 'record', 'search', 'toolbar']
  )
  assert.ok(whitelist.sources.some((source) => source.role === 'shared' && source.root === 'shared'))
  assert.ok(whitelist.sources.some((source) => source.role === 'assets' && source.root === 'assets'))
  assert.ok(whitelist.forbiddenRoots.includes('main'))
  assert.ok(whitelist.forbiddenRoots.includes('test'))
  assert.ok(whitelist.forbiddenRoots.includes('native'))
  assert.ok(whitelist.outputs.defaultOutDir.startsWith('.tmp'))
})

test('收集结果只包含白名单资源，覆盖所有页面 HTML 且无禁止内容', () => {
  const { manifest } = collect()
  assert.ok(manifest.totals.files >= 150, `expected >= 150 files, got ${manifest.totals.files}`)
  assert.ok(manifest.totals.bytes > 1024 * 1024, 'expected more than 1 MiB of collected frontend resources')

  const pageHtml = new Map()
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(file.bytes) && file.bytes > 0)
    const segments = file.path.split('/')
    assert.ok(!segments.includes('node_modules'), `node_modules leaked into ${file.path}`)
    assert.ok(!segments.includes('main'), `main/ leaked into ${file.path}`)
    assert.ok(!segments.includes('preload'), `preload leaked into ${file.path}`)
    assert.ok(!segments.includes('test'), `test/ leaked into ${file.path}`)
    assert.ok(!segments.includes('native'), `native/ leaked into ${file.path}`)
    assert.ok(!file.path.startsWith('dist/'), `dist/ leaked into ${file.path}`)
    assert.ok(!file.path.endsWith('.test.js'), `test file leaked into ${file.path}`)
    assert.ok(!file.path.endsWith('.md'), `markdown leaked into ${file.path}`)
    assert.notEqual(file.path, 'config/release-hardware-matrix.json')
    const root = segments[0]
    assert.ok(
      ['shared', 'assets', 'config', 'capture', 'clipboard', 'action', 'toolbar', 'pin', 'long-capture', 'recognition', 'search', 'record'].includes(root),
      `unexpected collected root: ${file.path}`
    )
    if (file.path.toLowerCase().endsWith('.html')) pageHtml.set(root, (pageHtml.get(root) || 0) + 1)
  }
  assert.equal([...pageHtml.keys()].length, 10, 'every page root must contribute at least one HTML entry point')
})

test('收集顺序与哈希确定性可复现（--check 依赖此性质）', () => {
  const first = collect().manifest
  const second = collect().manifest
  assert.deepEqual(first, second)
  const paths = first.files.map((file) => file.path)
  const sorted = [...paths].sort()
  assert.deepEqual(paths, sorted)
  assert.equal(first.totals.bytes, first.files.reduce((sum, file) => sum + file.bytes, 0))
  assert.equal(first.totals.files, first.files.length)
})

test('CLI --check 退出码 0，--list 输出可解析 manifest', () => {
  const check = spawnSync(process.execPath, [SCRIPT_PATH, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /frontend-resources: OK \d+ files, \d+ bytes/)

  const list = spawnSync(process.execPath, [SCRIPT_PATH, '--list'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(list.status, 0, list.stderr)
  const listed = JSON.parse(list.stdout)
  assert.equal(listed.kind, 'highlighter.frontend-manifest')
  assert.equal(listed.totals.files, collect().manifest.totals.files)
})

test('--out 只写受控临时目录，manifest 与收集结果一致且可重复覆盖', () => {
  try {
    const { manifest } = collect()
    const outDir = '.tmp-frontend-whitelist-test'
    const first = resources.writeResources(manifest, outDir)
    const manifestPath = path.join(outDir, 'frontend-manifest.json')
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.deepEqual(written, manifest)
    assert.equal(fs.readFileSync(path.join(REPO_ROOT, outDir, 'config', 'config.html'), 'utf8').length > 0, true)
    const second = resources.writeResources(manifest, outDir)
    assert.equal(first.totals.files, second.totals.files)
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest)
  } finally {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true })
  }
  assert.equal(fs.existsSync(SCRATCH_DIR), false)
})

test('writeResources 拒绝越界/重叠/非受控输出目录', () => {
  const whitelist = resources.loadWhitelist()
  const manifest = resources.collectResources({ whitelist })
  assert.throws(() => resources.writeResources(manifest, '.'), /repository root/)
  assert.throws(() => resources.writeResources(manifest, 'dist/frontend'), /output directory must be/)
  assert.throws(() => resources.writeResources(manifest, 'main/tmp'), /output directory must be/)
  assert.throws(() => resources.writeResources(manifest, 'config'), /overlap whitelist source/)
  assert.throws(() => resources.writeResources(manifest, '../outside'), /inside the repository/)
  // 专属发布目录本身合法（计划 §3.1），只解析不实际写入。
  const releaseOut = resources.resolveOutputDir('rust-app/dist/frontend', whitelist)
  assert.equal(releaseOut, path.join(REPO_ROOT, 'rust-app', 'dist', 'frontend'))
  fs.rmSync(path.join(REPO_ROOT, '.tmp-frontend-unsafe-check'), { recursive: true, force: true })
})

test('白名单自检拒绝路径穿越、禁止根与非法扩展名', () => {
  const base = resources.loadWhitelist()
  const mutations = [
    (whitelist) => { whitelist.sources[2].root = '../main' },
    (whitelist) => { whitelist.sources[2].root = 'main' },
    (whitelist) => { whitelist.sources[2].root = 'test' },
    (whitelist) => { whitelist.sources[2].root = path.join(REPO_ROOT, 'config') },
    (whitelist) => { whitelist.sources.push({ ...whitelist.sources[2] }) },
    (whitelist) => { whitelist.sources[2].allowExtensions = ['.exe'] },
    (whitelist) => { whitelist.sources[2].allowExtensions = [] },
    (whitelist) => { whitelist.outputs.defaultOutDir = '../outside' },
    (whitelist) => { whitelist.sources = [] }
  ]
  for (const mutate of mutations) {
    const whitelist = cloneWhitelist(base)
    mutate(whitelist)
    assert.throws(() => resources.validateWhitelist(whitelist), resources.WhitelistError)
  }
})

test('缺失源根时收集失败而不是静默跳过', () => {
  const whitelist = cloneWhitelist(resources.loadWhitelist())
  whitelist.sources.push({ id: 'missing-page', role: 'page', root: 'does-not-exist-page', allowExtensions: ['.html'] })
  assert.throws(() => resources.collectResources({ whitelist }), /source root missing on disk/)
})

test('收集器不引入 Electron 或网络依赖，可在纯 Node 下运行', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8')
  for (const banned of ['node:electron', 'require(\'electron\')', 'fetch(', 'https://', 'http://']) {
    assert.equal(source.includes(banned), false, `collector must not reference ${banned}`)
  }
})
