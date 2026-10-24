// Shared content model for every direction on the board.
//
// Every string here is taken from the real product (shared/locales/*.js,
// config/config.html, capture/capture.html, clipboard/clipboard.html and the
// surface fixtures in design-demos/tools/capture-electron.js). The three
// directions must be compared on design alone, never on invented copy.
window.HL = {
  brand: { left: 'High', right: 'lighter', tag: '截图 · 标注 · 识别 · 翻译', version: '4.1.2' },

  // Real sidebar: 14 routes, grouped exactly as config/config.html ships them.
  nav: [
    { group: null, items: [{ id: 'home', label: '快捷功能', icon: 'lightning' }] },
    {
      group: '工具箱',
      items: [
        { id: 'translation', label: '翻译', icon: 'translation' },
        { id: 'chat', label: 'AI 对话', icon: 'robot' },
        { id: 'history', label: '截图历史', icon: 'history' },
      ],
    },
    {
      group: '工具设置',
      items: [
        { id: 'selection-toolbar', label: '划词工具', icon: 'text-style' },
        { id: 'local-search', label: '本地搜索', icon: 'search' },
        { id: 'clipboard-history', label: '剪贴板历史', icon: 'history' },
        { id: 'usage', label: '用量', icon: 'usage' },
      ],
    },
    {
      group: '设置',
      items: [
        { id: 'settings-general', label: '通用', icon: 'layout' },
        { id: 'settings-function', label: '截图与录制', icon: 'settings' },
        { id: 'models', label: 'AI 与模型', icon: 'model' },
        { id: 'settings-system', label: '系统与数据', icon: 'system' },
      ],
    },
  ],
  navFooter: { id: 'about', label: '关于', icon: 'info' },

  // Status rail cells, values from the live app's refreshStatusRail().
  rail: [
    { label: '识别引擎', value: 'PP-OCRv4 · 本地', tone: 'ok' },
    { label: '当前模型', value: 'DeepSeek Chat', tone: 'accent' },
    { label: '热键配置', value: '9 / 13', tone: 'warn' },
    { label: '本地搜索', value: 'Everything 就绪', tone: 'ok' },
  ],

  pages: {
    home: {
      kicker: 'QUICK ACTIONS',
      title: '快捷功能',
      desc: '统一管理截图、AI、翻译、录屏和桌面工具；「快捷键」页签集中录入全局快捷键。',
    },
    history: {
      kicker: 'CAPTURE LIBRARY',
      title: '截图历史',
      desc: '回顾、复制和重新编辑截图；缩略图按捕获来源归档。',
    },
    usage: {
      kicker: 'TOKEN USAGE',
      title: '用量',
      desc: '本机 AI CLI 的 Token 用量；只读日志，仅存计数，不上传任何内容。',
    },
  },

  tabs: [
    { id: 'shot', label: '截图', count: 11 },
    { id: 'ai', label: 'AI', count: 3 },
    { id: 'translation', label: '翻译', count: 2 },
    { id: 'record', label: '录屏', count: 1 },
    { id: 'other', label: '其他', count: 5 },
  ],

  // name / desc / key. key: null = 未设置, 'conflict' = 与截图冲突.
  features: {
    shot: [
      { icon: 'screenshot', name: '截图', desc: '自由框选、智能标注与导出', key: 'Alt+A', state: 'set' },
      { icon: 'timer', name: '延迟截图', desc: '倒计时后开始区域截图', key: null, state: 'unset' },
      { icon: 'pin', name: '固定到屏幕', desc: '截图完成后直接贴到桌面', key: 'Alt+P', state: 'set' },
      { icon: 'ocr', name: '文本识别', desc: '截图后提取中文、英文等文字', key: 'Alt+O', state: 'set' },
      { icon: 'table', name: '表格识别', desc: '恢复截图中的行列并复制到 Excel', key: null, state: 'unset' },
      { icon: 'qr', name: '二维码识别', desc: '扫描二维码内容或打开其中的链接', key: null, state: 'unset' },
      { icon: 'translation', name: '文本识别翻译', desc: '截图识别文字后调用翻译', key: 'Alt+T', state: 'conflict' },
      { icon: 'copy', name: '复制到剪贴板', desc: '完成选区后立即复制', key: null, state: 'unset' },
      { icon: 'long-capture', name: '长截图', desc: '框选滚动区域并自动拼接', key: null, state: 'unset' },
      { icon: 'fullscreen', name: '截取全屏', desc: '捕获鼠标所在显示器', key: null, state: 'unset' },
      { icon: 'focus', name: '当前焦点窗口', desc: '捕获当前活动窗口', key: null, state: 'unset' },
    ],
    ai: [
      { icon: 'robot', name: '打开 AI 对话', desc: '使用配置的模型进行多轮对话', key: null, state: 'unset' },
      { icon: 'text-style-one', name: '对话框填入选中文本', desc: '把划选的文本送进对话输入框', key: null, state: 'unset' },
      { icon: 'text-style', name: '解释剪贴板文本', desc: '只读剪贴板并送入解释窗口，不写回剪贴板', key: null, state: 'unset' },
    ],
    translation: [
      { icon: 'translation', name: '打开翻译工具', desc: '支持自动检测源语言和自定义目标语言', key: null, state: 'unset' },
      { icon: 'translate', name: '翻译选中的文本', desc: '划词后快速翻译并回显结果', key: null, state: 'unset' },
    ],
    record: [
      { icon: 'record', name: '视频录制', desc: '区域录制、暂停预览并导出 MP4 视频', key: 'Alt+R', state: 'conflict' },
    ],
    other: [
      { icon: 'pin', name: '固定本地图片', desc: '选择本地图片并固定到桌面', key: null, state: 'unset' },
      { icon: 'draw', name: '全屏画布', desc: '在白色全屏画布中绘制', key: null, state: 'unset' },
      { icon: 'preview', name: '显示 / 隐藏所有贴图', desc: '批量控制桌面贴图', key: null, state: 'unset' },
      { icon: 'folder-open', name: '打开图片目录', desc: '打开默认截图保存位置', key: null, state: 'unset' },
      { icon: 'history', name: '打开截图历史', desc: '回顾、复制和重新编辑截图', key: null, state: 'unset' },
    ],
  },

  hotkeys: [
    { icon: 'screenshot', name: '截图', key: 'Alt+A', state: 'set' },
    { icon: 'ocr', name: '文本识别', key: 'Alt+O', state: 'set' },
    { icon: 'search', name: '本地搜索', key: 'Alt+S', state: 'set' },
    { icon: 'pin', name: '固定到屏幕', key: 'Alt+P', state: 'set' },
    { icon: 'record', name: '视频录制', key: 'Alt+R', state: 'conflict' },
    { icon: 'robot', name: '打开 AI 对话', key: null, state: 'unset' },
    { icon: 'translate', name: '翻译选中的文本', key: null, state: 'unset' },
  ],

  history: {
    stats: [
      { value: '1.42 GB', label: '占用空间' },
      { value: '186', label: '可用截图' },
      { value: '3', label: '文件缺失' },
      { value: '0', label: '孤立文件' },
    ],
    items: [
      { time: '今天 18:42', source: '区域截图', meta: '2840 × 1680 · PNG' },
      { time: '今天 16:08', source: '长截图', meta: '1280 × 4620 · PNG' },
      { time: '今天 11:20', source: '焦点窗口', meta: '1920 × 1080 · PNG' },
      { time: '昨天 22:04', source: '区域截图', meta: '1640 × 900 · PNG' },
      { time: '昨天 15:37', source: '区域截图', meta: '960 × 640 · PNG' },
      { time: '周一 09:30', source: '保存为', meta: '1440 × 900 · JPG' },
    ],
  },

  usage: {
    period: ['日', '周', '月', '总计'],
    kpis: [
      { value: '1.24 M', label: '计费 Token', sub: '最近 7 天' },
      { value: '86', label: '平均 / 活跃日', sub: '12 个活跃日' },
      { value: '42', label: '对话', sub: '区间内' },
      { value: '3', label: 'AI 工具', sub: 'Codex · DSH · OpenCode' },
    ],
    sources: [
      { name: 'Codex', value: '742 K', pct: 60 },
      { name: 'DeepSeek-Harness', value: '361 K', pct: 29 },
      { name: 'OpenCode', value: '137 K', pct: 11 },
    ],
  },

  // Capture overlay: the real strip is 27 controls in two rows.
  capture: {
    region: { w: 1280, h: 720, ratio: '16:9' },
    tools: [
      { id: 'select', icon: 'select', label: '选择/调整' },
      { id: 'rect', icon: 'rect', label: '矩形' },
      { id: 'ellipse', icon: 'ellipse', label: '椭圆' },
      { id: 'arrow', icon: 'arrow', label: '箭头' },
      { id: 'line', icon: 'line', label: '直线' },
      { id: 'pen', icon: 'pen', label: '画笔' },
      { id: 'highlight', icon: 'highlight', label: '高亮' },
      { id: 'blur', icon: 'mosaic', label: '马赛克' },
      { id: 'text', icon: 'text', label: '文字' },
      { id: 'serial', icon: 'serial', label: '序号' },
      { id: 'watermark', icon: 'watermark', label: '水印' },
    ],
    colors: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff'],
    widths: [
      { value: 2, icon: 'weight-thin', label: '细' },
      { value: 4, icon: 'weight-medium', label: '中' },
      { value: 8, icon: 'weight-thick', label: '粗' },
    ],
    actions: [
      { id: 'undo', icon: 'undo', label: '撤销' },
      { id: 'redo', icon: 'redo', label: '重做' },
      { id: 'longCapture', icon: 'long-capture', label: '长截图' },
      { id: 'qr', icon: 'qr', label: '二维码识别' },
      { id: 'table', icon: 'table', label: '表格识别' },
      { id: 'ocr', icon: 'ocr', label: '文本识别' },
      { id: 'translate', icon: 'translate', label: '识别并翻译' },
      { id: 'convertDoc', icon: 'doc-convert', label: '图片转文档' },
      { id: 'record', icon: 'record', label: '区域录制' },
      { id: 'pin', icon: 'pin', label: '固定到屏幕' },
      { id: 'save', icon: 'save', label: '保存' },
      { id: 'exportPdf', icon: 'print', label: '导出 PDF' },
    ],
    primary: { id: 'copy', icon: 'copy', label: '复制' },
    cancel: { id: 'close', icon: 'close', label: '取消' },
  },

  // Clipboard panel: real record shapes from the capture fixture.
  clipboard: {
    chips: ['全部', '文本', '链接', '图片', '文件'],
    items: [
      { kind: 'text', pinned: true, source: '微信', time: '3 分钟前', text: '把这段关于暗色模式对比度的评审意见整理成一页要点，明早发给设计组。' },
      { kind: 'url', pinned: false, source: 'Google Chrome', time: '8 分钟前', text: 'https://github.com/highlighter-app/highlighter/pull/1287' },
      { kind: 'image', pinned: false, source: '微信', time: '11 分钟前', text: 'Snipaste_2026-10-16_21-14-08.png', size: '1280 × 720' },
      { kind: 'text', pinned: false, source: 'Visual Studio Code', time: '20 分钟前', text: 'npm run verify:all 通过后再合并 #1287，避免夜间回归。' },
      { kind: 'image', pinned: true, source: '微信', time: '19 分钟前', text: '微信图片_20261015203012.png', size: '1120 × 630' },
      { kind: 'text', pinned: false, source: '微信', time: '35 分钟前', text: '小鹿：周五的评审改到 14:30，会议室 3F-北。' },
    ],
    status: { led: '运行中', count: '42 条记录', revision: 'rev 12' },
    // Real newlines, not the two-character sequence: the panel renders this
    // inside a white-space:pre-wrap block, so "\n" printed literally.
    detail: [
      '把这段关于暗色模式对比度的评审意见整理成一页要点，明早发给设计组。',
      '',
      '1. 浮层保持固定暗色，不跟随主题；',
      '2. 正文对比度至少 4.5:1，次要文字 3:1；',
      '3. 强调色只保留一个，用户可配置。'
    ].join('\n'),
    actions: ['复制', '粘贴', '固定', '删除'],
  },

  // Selection toolbar: the five real actions, copy is the local primary.
  selection: {
    led: true,
    text: 'Ship a calmer capture tool for Windows — fewer chrome, more focus.',
    actions: [
      { id: 'copy', icon: 'copy', label: '复制', primary: true },
      { id: 'search', icon: 'search', label: '搜索' },
      { id: 'translate', icon: 'translate', label: '翻译' },
      { id: 'explain', icon: 'lightbulb', label: '解释' },
      { id: 'open', icon: 'box-arrow-up-right', label: '跳转' },
    ],
  },
}
