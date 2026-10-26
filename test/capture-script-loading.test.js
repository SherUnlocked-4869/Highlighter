// 渲染层加载顺序契约：共享契约模块必须先于 capture.js 存在。
//
// 为什么要单独一个文件：C/D 把 `shared/capture-document.js` 变成了**加载期**依赖三个 shared
// 模块的模块（成品样式几何 / 放大镜几何 / 遮挡合成），而它自己又被 capture.js 在加载期读取。
// 少一个 <script> 的后果不是"功能降级"，而是整个截图窗口抛异常起不来 —— 2026-10-25 在真实
// Electron 探针里确实发生过一次（`capture-document requires shared/capture-output-style.js`
// 之后紧跟 `Cannot read properties of undefined (reading 'fitViewport')`，因为 capture.js 的
// 顶层就把 window.captureDocument 缓存下来了）。
//
// 所以这里钉三件事：
//   1. 五个 shared 模块都在 capture.html 里，且都在 capture.js 之前；
//   2. `capture-document.js` 在它自己的三个依赖之后（否则它加载时就抛）；
//   3. 每个模块的 UMD 暴露名与 capture.js/其它渲染层文件的取用名一致。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const captureScript = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')

function indexOfScript(src) {
  return html.indexOf(`<script src="${src}"></script>`)
}

// capture-document.js 在加载期 require/读取的三个模块（顺序无关，但都必须在它之前）。
const CONTRACT_DEPENDENCIES = [
  '../shared/capture-output-style.js',
  '../shared/magnifier-geometry.js',
  '../shared/occlusion-mask.js'
]

test('the document contract is loaded from the same module the main process requires', () => {
  assert.ok(indexOfScript('../shared/capture-document.js') > 0, 'capture.html must load shared/capture-document.js')
  // 同一个文件：主进程 require('../shared/capture-document')，渲染层不能有第二份实现。
  assert.equal(fs.existsSync(path.join(root, 'shared', 'capture-document.js')), true)
})

test('every module the document contract needs at load time is present and loaded before it', () => {
  const documentIndex = indexOfScript('../shared/capture-document.js')
  for (const dependency of CONTRACT_DEPENDENCIES) {
    const dependencyIndex = indexOfScript(dependency)
    assert.ok(
      dependencyIndex > 0,
      `${dependency} must be loaded by capture.html: shared/capture-document.js throws at load time without it`
    )
    assert.ok(
      dependencyIndex < documentIndex,
      `${dependency} must load BEFORE ../shared/capture-document.js (it is a load-time dependency)`
    )
  }
})

test('the document contract and the compositor both load before capture.js', () => {
  const captureIndex = indexOfScript('capture.js')
  assert.ok(captureIndex > 0)
  for (const src of ['../shared/capture-document.js', 'output-compositor.js', 'magnifier-sampler.js']) {
    const index = indexOfScript(src)
    assert.ok(index > 0, `${src} must be loaded by capture.html`)
    assert.ok(index < captureIndex, `${src} must load BEFORE capture.js`)
  }
  // The sampler lives in capture/ (it needs a canvas factory), the model in shared/
  // (the main process validates it too). Their relative order does not matter, but the
  // sampler must come after the model it consumes at load time.
  assert.ok(
    indexOfScript('magnifier-sampler.js') > indexOfScript('../shared/magnifier-geometry.js'),
    'the sampler consumes the magnifier model, so it must load after it'
  )
})

test('the shared modules expose the globals the renderer reads', () => {
  // UMD 暴露名 + 读取名必须一一对上，否则渲染层拿到 undefined 只会在第一次用到时才炸。
  const expectations = [
    ['shared/capture-output-style.js', 'captureOutputStyle'],
    ['shared/magnifier-geometry.js', 'magnifierGeometry'],
    ['shared/occlusion-mask.js', 'occlusionMask'],
    ['shared/capture-document.js', 'captureDocument'],
    ['capture/output-compositor.js', 'captureOutputCompositor'],
    ['capture/magnifier-sampler.js', 'magnifierSampler']
  ]
  for (const [file, globalName] of expectations) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(
      source,
      new RegExp(`root\\.${globalName}\\s*=`),
      `${file} must expose window.${globalName}`
    )
  }
})

test('capture.js reads the contract modules through their globals, not through a re-implementation', () => {
  // 渲染层只能"取用"契约层，不能自己再算一遍几何（这正是 shared/ 存在的理由）。
  assert.match(captureScript, /window\.captureDocument/)
  // 合成器与放大镜采样器必须通过 UMD 全局名取用。这一条同时防止"忘记加载 <script>、
  // 但代码看起来正常"的静默降级 —— 少一个 tag 会让 window.X 是 undefined，而不是报错。
  assert.match(captureScript, /window\.captureOutputCompositor/, 'the compositor must be read from its UMD global')
  assert.match(captureScript, /window\.magnifierGeometry/, 'the magnifier model must be read from its UMD global')
  // The sampler is D2's; it is read through the same global. A `typeof` guard is allowed (and
  // expected) because the recognition path may run in a window that never creates a magnifier -
  // but the name must appear, otherwise a missing <script> would degrade silently.
  assert.match(captureScript, /window\.magnifierSampler/, 'the lens sampler must be read from its UMD global')
})
