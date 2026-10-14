'use strict'

// P0-1-T4 / S11 —— capture/ 窗口的 i18n 契约与「zh-CN 逐字一致」验收证据。
//
// 为什么单独一个文件（而不是塞进 capture-annotation-geometry.test.js）：
//   ① scripts/check-i18n.js 的对称差检查是**全仓库**口径，而 Wave 9 是四路并行 ——
//      任何一路的 <domain>.js 处于半落地状态都会把 capture 的门禁染红。本文件只加载
//      capture 窗口真正加载的那 4 个语言文件，给出一个不依赖兄弟流的 capture 口径契约。
//   ② GOLDEN 表把「迁移前后逐字一致」（方案 §10 验收⑤）变成可复现的断言：每个键都配一条
//      **迁移前**（HEAD = 1338d12 的 capture/capture.html + capture/capture.js）用户实际看到
//      的文案；动态文案则保存迁移前的**源表达式**，并把同一个表达式作为插值参数传进去 ——
//      于是断言是与出厂字符串的逐字节比较，而不是"再翻译一遍"。
//
// 覆盖范围：capture.html 的 data-i18n* 标记、capture.js 的 t() 调用点、三语键集合对称差、
// 以及"没有死键 / 没有漏标记"的双向清单。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']
// Exactly the locale files capture/capture.html loads, in load order.
const WINDOW_LOCALE_FILES = ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js']

function localePath(name) {
  return path.join(root, 'shared', 'locales', name)
}

function loadWindowTables() {
  globalThis.__LOCALES = {}
  for (const name of WINDOW_LOCALE_FILES) {
    delete require.cache[require.resolve(localePath(name))]
    require(localePath(name))
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

// The real runtime, re-evaluated per call: t() has to be the shipping interpolation code,
// not a re-implementation, or the placeholders would be compared against a mock.
function loadRuntime(language = 'zh-CN') {
  const runtime = path.join(root, 'shared', 'i18n.js')
  delete require.cache[require.resolve(runtime)]
  const api = require(runtime)
  api.setLanguage(language)
  return api
}

// key -> 迁移前渲染出来的文案。{ source, params } 用于带插值的动态文案：
// source 是迁移前 capture.js 里的模板字面量，params 把同一个表达式作为参数值传回。
const GOLDEN = {
  'capture.window.title': 'Highlighter 截图',
  'capture.tip.drag': '拖动选择区域 · 拖动边缘或角点调整 · Esc 退出',

  'capture.toolbar.select': '选择或调整选区',
  'capture.toolbar.select-tip': '选择/调整',
  'capture.toolbar.rect': '矩形',
  'capture.toolbar.ellipse': '椭圆',
  'capture.toolbar.arrow': '箭头',
  'capture.toolbar.line': '直线',
  'capture.toolbar.pen': '画笔',
  'capture.toolbar.highlight': '高亮',
  'capture.toolbar.blur': '马赛克',
  'capture.toolbar.text': '文字',
  'capture.toolbar.serial': '序号',
  'capture.toolbar.watermark': '水印',
  'capture.toolbar.color': '颜色',
  'capture.toolbar.width-group': '标注线宽',
  'capture.toolbar.width-thin': '细',
  'capture.toolbar.width-thin-tip': '线宽：细（2px）',
  'capture.toolbar.width-medium': '中',
  'capture.toolbar.width-medium-tip': '线宽：中（4px）',
  'capture.toolbar.width-thick': '粗',
  'capture.toolbar.width-thick-tip': '线宽：粗（8px）',
  'capture.toolbar.undo': '撤销',
  'capture.toolbar.undo-tip': '撤销 Ctrl+Z',
  'capture.toolbar.redo': '重做',
  'capture.toolbar.redo-tip': '重做 Ctrl+Y',
  'capture.toolbar.long-capture': '长截图',
  'capture.toolbar.qr': '二维码识别',
  'capture.toolbar.table': '表格识别',
  'capture.toolbar.ocr': '文本识别',
  'capture.toolbar.translate': '识别并翻译',
  'capture.toolbar.record': '区域录制',
  'capture.toolbar.pin': '固定到屏幕',
  'capture.toolbar.save': '保存',
  'capture.toolbar.save-tip': '保存 Ctrl+S',
  'capture.toolbar.export-pdf': '导出 PDF',
  'capture.toolbar.copy': '复制',
  'capture.toolbar.copy-tip': '复制 Enter',
  'capture.toolbar.close': '取消',
  'capture.toolbar.close-tip': '取消 Esc',

  // A3（2026-10-14 方案）：色板新增键（迁移后新增，非 P0-1 迁移口径）。
  'capture.palette.group': '标注颜色',
  'capture.palette.red': '红',
  'capture.palette.orange': '橙',
  'capture.palette.yellow': '黄',
  'capture.palette.green': '绿',
  'capture.palette.blue': '蓝',
  'capture.palette.black': '黑',
  'capture.palette.white': '白',
  'capture.palette.custom': '自定义',
  'capture.palette.recent': '最近使用',

  // B2/B3/B5（2026-10-14 方案）：第二行工具栏选项键（同样为新增，非迁移口径）。
  'capture.options.fill-group': '填充',
  'capture.options.fill-none': '空心',
  'capture.options.fill-translucent': '半透明',
  'capture.options.fill-solid': '实心',
  'capture.options.dash-group': '线型',
  'capture.options.dash-solid': '实线',
  'capture.options.dash-dashed': '虚线',
  'capture.options.dash-dotted': '点线',
  'capture.options.radius-group': '圆角',
  'capture.options.radius-none': '直角',
  'capture.options.radius-small': '圆角 4',
  'capture.options.radius-large': '圆角 8',
  'capture.options.head-group': '箭头',
  'capture.options.head-start': '起点',
  'capture.options.head-end': '终点',
  'capture.options.alpha-group': '浓度',
  'capture.options.alpha-light': '淡',
  'capture.options.alpha-medium': '中',
  'capture.options.alpha-strong': '浓',
  'capture.options.bold-group': '字重',
  'capture.options.bold': '粗体',

  'capture.element.selected': '已选中标注',
  'capture.element.move-hint': '右键拖动元素 · Alt+拖动选区',
  'capture.element.move-hint-tip': '任意工具下按住右键拖动即可移动标注；元素铺满选区（如水印）时按住 Alt 在选区内拖动即可移动选区',
  'capture.element.resize-hint': '拖动圆点缩放',
  'capture.element.resize-hint-tip': '拖动选中虚线框上的 8 个圆点即可缩放；文本框只改字号，序号只改半径',
  'capture.element.delete-tip': '删除选中标注 Delete',
  'capture.element.delete-aria': '删除选中标注',
  'capture.element.front': '上移',
  'capture.element.front-tip': '上移一层（更靠前）',
  'capture.element.front-aria': '上移一层',
  'capture.element.back': '下移',
  'capture.element.back-tip': '下移一层（更靠后）',
  'capture.element.back-aria': '下移一层',
  'capture.element.deselect': '取消选中',
  'capture.element.deselect-tip': '取消选中 Esc',

  'capture.watermark.content': '内容',
  'capture.watermark.content-placeholder': '输入水印文字',
  'capture.watermark.date': '日期',
  'capture.watermark.date-tip': '在水印文字后拼接当前时间，格式 yyyyMMddHHmmss，例如 知何似20260910154310',
  'capture.watermark.date-suffix': '追加日期后缀',
  'capture.watermark.opacity': '透明度',
  'capture.watermark.color': '颜色',
  'capture.watermark.spacing': '间距',
  'capture.watermark.font-size': '大小',
  'capture.watermark.rotation': '角度',
  'capture.watermark.apply': '添加水印',

  'capture.result.title': '识别结果',
  'capture.result.title-ocr': '文本识别',
  'capture.result.title-translate': '截图翻译',
  'capture.result.copy': '复制文本',
  'capture.result.done': '完成',
  'capture.ocr.summary': '识别完成',
  'capture.ocr.show-source': '查看原文',
  'capture.ocr.show-translation': '查看译文',
  'capture.ocr.plain-text': '纯文本',
  'capture.ocr.copy-all': '复制全部',
  'capture.ocr.close-tip': '关闭识别结果',
  'capture.ocr.tooltip-source': { source: '原文：${block.sourceText}', params: { text: '${block.sourceText}' } },
  'capture.ocr.tooltip-confidence': {
    source: '置信度 ${Math.round(Number(block.text_score)*100)}%',
    params: { value: '${Math.round(Number(block.text_score)*100)}' }
  },
  'capture.ocr.source-count': { source: '原文 ${visibleCount} 处', params: { count: '${visibleCount}' } },
  'capture.ocr.translated-count': { source: '已翻译 ${visibleCount} 处文本', params: { count: '${visibleCount}' } },
  'capture.ocr.count-cached': { source: '识别到 ${visibleCount} 处文本 · 已缓存', params: { count: '${visibleCount}' } },
  'capture.ocr.count-timed': {
    source: '识别到 ${visibleCount} 处文本 · ${result.durationMs||0} ms',
    params: { count: '${visibleCount}', ms: '${result.durationMs||0}' }
  },

  'capture.loading.text': '处理中…',
  'capture.loading.ocr': '正在识别文字…',
  'capture.loading.translate': '正在识别并翻译…',
  'capture.input.text': '输入文字',
  'capture.confirm.reset-selection': '重新划选将清除已添加的标注，是否继续？',
  'capture.confirm.long-capture': '进入长截图将忽略当前标注，是否继续？',
  'capture.action.copied': '已复制',

  'capture.error.decode-failed': '截图图片解码失败',
  'capture.error.empty-image': '截图图片数据为空',
  'capture.error.encode-failed': '截图图片编码失败',

  // 复用公共表（shared/locales/{zh-CN,en-US,zh-TW}.js，S1 所有）而不是克隆一份。
  'common.button.cancel': '取消',
  'common.button.delete': '删除'
}

const htmlKeys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((match) => match[1])
const scriptKeys = [...script.matchAll(/\bt\('(capture\.[a-z0-9.-]+)'/g)].map((match) => match[1])
const usedKeys = new Set([...htmlKeys, ...scriptKeys])

test('capture.html loads the i18n runtime and the capture locale table before its controller', () => {
  const runtimeIndex = html.indexOf('<script src="../shared/i18n.js"></script>')
  assert.ok(runtimeIndex >= 0, 'capture.html must load ../shared/i18n.js')
  const controllerIndex = html.indexOf('<script src="capture.js"></script>')
  assert.ok(controllerIndex > 0, 'capture.html must load its controller with src="capture.js"')
  for (const name of WINDOW_LOCALE_FILES) {
    const index = html.indexOf(`<script src="../shared/locales/${name}"></script>`)
    assert.ok(index >= 0, `capture.html must load ../shared/locales/${name}`)
    assert.ok(index < controllerIndex, `../shared/locales/${name} must load before capture.js`)
  }
  // Ordering check: the runtime is declared before the tables (the runtime reads the bag lazily,
  // so either order works, but the file must stay readable and the CSP forbids inline scripts).
  assert.ok(runtimeIndex < html.indexOf('../shared/locales/zh-CN.js'), 'the runtime line comes first')
  // No inline script may be introduced: the window CSP is `script-src 'self'`.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i)
  // Every attribute marker must use one of shared/i18n.js TRANSLATABLE_ATTRIBUTES, otherwise
  // applyTranslations() silently ignores it (a typo would leave an empty tooltip).
  const suffixes = [...html.matchAll(/data-i18n-([a-z-]+)=/g)].map((match) => match[1])
  assert.ok(suffixes.length > 0)
  for (const suffix of suffixes) {
    assert.ok(
      ['title', 'placeholder', 'aria-label'].includes(suffix),
      `data-i18n-${suffix} is not a translatable attribute`
    )
  }
})

test('capture.js applies the stored language on boot and re-applies it on the i18n:language broadcast', () => {
  assert.match(script, /restoreStoredLanguage\(\)[\s\S]{0,80}?applyTranslations\(\)/)
  assert.match(
    script,
    /window\.captureAPI\.onInterfaceLanguage\(\(language\) => \{[\s\S]{0,120}?setLanguage\(language\)[\s\S]{0,80}?applyTranslations\(\)/
  )
  // The subscription is the renderer half of the settings effect; preload exposes it.
  assert.match(script, /window\.captureAPI\.onInterfaceLanguage/)
})

test('every key the capture window uses resolves to the wording that shipped before the migration', () => {
  const tables = loadWindowTables()
  const runtime = loadRuntime('zh-CN')
  for (const [key, expected] of Object.entries(GOLDEN)) {
    const value = typeof expected === 'string'
      ? runtime.t(key)
      : runtime.t(key, expected.params)
    const wanted = typeof expected === 'string' ? expected : expected.source
    assert.equal(value, wanted, `${key} must stay byte-identical to the pre-migration literal`)
  }
  // The bag also carries the cross-window `common.*` keys, so the capture-domain count is
  // compared on its own (the two reused common keys are covered by GOLDEN as well).
  const tableDomainKeys = Object.keys(tables['zh-CN']).filter((key) => key.startsWith('capture.'))
  const goldenDomainKeys = Object.keys(GOLDEN).filter((key) => key.startsWith('capture.'))
  assert.deepEqual(tableDomainKeys.sort(), goldenDomainKeys.sort())
})

test('the golden table and the markup/controller agree in both directions', () => {
  const tables = loadWindowTables()
  const tableKeys = Object.keys(tables['zh-CN'])
  // ① 用到的键都有 golden 条目（没有漏标记 / 漏登记）。
  for (const key of usedKeys) {
    assert.ok(Object.hasOwn(GOLDEN, key), `${key} is used by capture but has no golden entry`)
  }
  // ② 表里的 capture.* 键都被用到（没有死键）。
  const dead = tableKeys.filter((key) => key.startsWith('capture.') && !usedKeys.has(key))
  assert.deepEqual(dead, [], 'every capture.* key must be used by the HTML or the controller')
  // ③ 公共表复用只限这两个键，且确实是公共表的键。
  const shared = [...usedKeys].filter((key) => !key.startsWith('capture.'))
  assert.deepEqual(shared.sort(), ['common.button.cancel', 'common.button.delete'])
  assert.deepEqual(
    tableKeys.filter((key) => key.startsWith('capture.')).sort(),
    Object.keys(GOLDEN).filter((key) => key.startsWith('capture.')).sort()
  )
})

test('the capture key set is symmetric across zh-CN / en-US / zh-TW', () => {
  const tables = loadWindowTables()
  const reference = Object.keys(tables['zh-CN']).sort()
  assert.ok(reference.length > 0)
  for (const language of LANGUAGES.slice(1)) {
    const keys = Object.keys(tables[language]).sort()
    assert.deepEqual(reference.filter((key) => !keys.includes(key)), [], `${language} is missing keys`)
    assert.deepEqual(keys.filter((key) => !reference.includes(key)), [], `${language} defines extra keys`)
  }
  for (const language of LANGUAGES) {
    for (const key of Object.keys(tables[language])) {
      const value = tables[language][key]
      assert.equal(typeof value, 'string', `${language}/${key} must be a string`)
      assert.ok(value.length > 0, `${language}/${key} must not be empty`)
      assert.notEqual(value, key, `${language}/${key} must be translated, not left as the key`)
    }
  }
})
