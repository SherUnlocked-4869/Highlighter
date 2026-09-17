// Shared content model for every direction on the board.
// Copy is taken from the real product (config.js / search.html / toolbar-action-meta.js)
// so the three directions can be compared on design alone, not on content.
window.HL = {
  brand: { left: 'High', right: 'lighter', tag: '桌面截图与划词效率工具' },

  nav: [
    { group: null, items: [{ id: 'home', label: '快捷功能', icon: 'lightning' }] },
    {
      group: '工具箱',
      items: [
        { id: 'translation', label: '翻译', icon: 'translate' },
        { id: 'chat', label: 'AI 对话', icon: 'robot' },
        { id: 'history', label: '截图历史', icon: 'history' },
        { id: 'local-search', label: '本地搜索', icon: 'search' },
      ],
    },
    {
      group: '个性化',
      items: [
        { id: 'appearance', label: '外观配色', icon: 'palette' },
        { id: 'plugins', label: '插件', icon: 'components' },
      ],
    },
    {
      group: '设置',
      items: [
        { id: 'settings-general', label: '界面设置', icon: 'layout' },
        { id: 'models', label: '模型', icon: 'model' },
        { id: 'settings-function', label: '功能设置', icon: 'settings' },
        { id: 'selection-toolbar', label: '划词工具', icon: 'select' },
        { id: 'settings-hotkeys', label: '热键设置', icon: 'keyboard' },
        { id: 'settings-system', label: '系统设置', icon: 'system' },
      ],
    },
  ],
  navFooter: { id: 'about', label: '关于', icon: 'info' },

  pages: {
    home: {
      title: '快捷功能',
      desc: '统一管理截图、AI、翻译、录屏和桌面工具。',
    },
    'settings-hotkeys': {
      title: '热键设置',
      desc: '点击右侧按键框后录入组合键；右键可清除。红色警告表示快捷键冲突或不可用。',
    },
  },

  tabs: [
    { id: 'shot', label: '截图' },
    { id: 'ai', label: 'AI' },
    { id: 'translation', label: '翻译' },
    { id: 'record', label: '录屏' },
    { id: 'other', label: '其他' },
  ],

  // name / desc / key  — key: null = unset, 'conflict' = collides with 截图
  features: {
    shot: [
      { icon: 'screenshot', name: '截图', desc: '自由框选、智能标注与导出', key: 'Alt+A' },
      { icon: 'timer', name: '延迟截图', desc: '倒计时后开始区域截图', key: null },
      { icon: 'pin', name: '固定到屏幕', desc: '截图完成后直接贴到桌面', key: 'Alt+P' },
      { icon: 'ocr', name: '文本识别', desc: '截图后提取中文、英文等文字', key: 'Alt+O' },
      { icon: 'table', name: '表格识别', desc: '恢复截图中的行列并复制到 Excel', key: null },
      { icon: 'qr', name: '二维码识别', desc: '扫描二维码内容或打开其中的链接', key: null },
      { icon: 'translation', name: '文本识别翻译', desc: '截图识别文字后调用翻译', key: 'conflict' },
      { icon: 'copy', name: '复制到剪贴板', desc: '完成选区后立即复制', key: null },
      { icon: 'long-capture', name: '长截图', desc: '框选滚动区域并自动拼接', key: null },
      { icon: 'fullscreen', name: '截取全屏', desc: '捕获鼠标所在显示器', key: null },
      { icon: 'focus', name: '当前焦点窗口', desc: '捕获当前活动窗口', key: null },
    ],
    ai: [
      { icon: 'robot', name: '打开 AI 对话', desc: '使用配置的模型进行多轮对话', key: null },
      { icon: 'text-style-one', name: '对话框填入选中文本', desc: '把划选的文本送进对话输入框', key: null },
      { icon: 'text-style', name: '解释剪贴板文本', desc: '只读剪贴板并送入解释窗口，不写回剪贴板', key: null },
    ],
    translation: [
      { icon: 'translate', name: '打开翻译工具', desc: '支持自动检测源语言和自定义目标语言', key: null },
      { icon: 'translation', name: '翻译选中的文本', desc: '划词后快速翻译并回显结果', key: null },
    ],
    record: [
      { icon: 'record', name: '视频录制', desc: '区域录制、暂停预览并导出 MP4 视频', key: null },
    ],
    other: [
      { icon: 'pin', name: '固定本地图片', desc: '选择本地图片并固定到桌面', key: null },
      { icon: 'draw', name: '全屏画布', desc: '在白色全屏画布中绘制', key: null },
      { icon: 'preview', name: '显示 / 隐藏所有贴图', desc: '批量控制桌面贴图', key: null },
      { icon: 'folder-open', name: '打开图片目录', desc: '打开默认截图保存位置', key: null },
      { icon: 'history', name: '打开截图历史', desc: '回顾、复制和重新编辑截图', key: null },
    ],
  },

  hotkeys: [
    { icon: 'screenshot', name: '截图', key: 'Alt+A', state: 'set' },
    { icon: 'ocr', name: '文本识别', key: 'Alt+O', state: 'set' },
    { icon: 'search', name: '本地搜索', key: 'Alt+S', state: 'set' },
    { icon: 'pin', name: '固定到屏幕', key: 'Alt+P', state: 'set' },
    { icon: 'record', name: '视频录制', key: 'Alt+A', state: 'conflict' },
    { icon: 'robot', name: '打开 AI 对话', key: null, state: 'unset' },
    { icon: 'translate', name: '翻译选中的文本', key: null, state: 'unset' },
  ],

  search: {
    title: '本地搜索',
    placeholder: '搜索本地文件（支持 Everything 语法，如 ext:pdf 报告）',
    cats: ['全部', '文档', '图片', '视频', '音频', '压缩包', '代码', '其他'],
    files: [
      { name: 'Highlighter-架构说明.md', dir: 'D:\\Projects\\Highlighter\\docs', size: '42 KB', time: '今天 10:18', kind: 'MD' },
      { name: 'capture-domain.test.js', dir: 'D:\\Projects\\Highlighter\\test', size: '18 KB', time: '昨天 22:04', kind: 'JS' },
      { name: '产品评审纪要.docx', dir: 'D:\\Docs\\工作', size: '126 KB', time: '周一 09:30', kind: 'DOC' },
      { name: 'screenshot-2026-03-12.png', dir: 'D:\\Pictures\\Screenshots', size: '1.4 MB', time: '3 月 12 日', kind: 'PNG' },
      { name: 'release-notes-0.9.md', dir: 'D:\\Projects\\Highlighter', size: '6 KB', time: '3 月 8 日', kind: 'MD' },
    ],
    status: '已找到 5 项',
    statusIdle: '正在检测 Everything…',
    footerRight: '匹配路径 · 按修改时间',
  },

  recognition: {
    title: '识别结果',
    summary: '共识别 8 行 · 中文 · 置信度高',
    lines: [
      'Highlighter 产品评审纪要',
      '1. 截图后默认进入标注，保留撤销栈',
      '2. OCR 与表格识别保持本地执行，不上传原始图像',
      '3. 划词翻译思考强度默认「关」，高延迟场景可开「高」',
      '4. 模型供应商支持 openai-chat 与 openai-responses',
      '5. 长截图拼接方向跟随滚动区域主轴',
      'Action items：热键冲突提示需在录入时即时反馈',
    ],
    mark: 'OCR 与表格识别保持本地执行，不上传原始图像',
    actions: ['导出 Markdown', '复制'],
  },

  assistant: {
    title: '划词助手',
    state: '翻译中…',
    badge: '翻译',
    pin: '置顶',
    source: 'Ship a calmer capture tool for Windows — fewer chrome, more focus.',
    result: '为 Windows 交付更安静的截图工具——更少界面噪音，更多专注。',
    loading: '正在请求 DeepSeek…',
  },

  // Shown on the component strip so each direction proves it is a system, not a screen.
  kit: {
    title: '组件语言',
    items: [
      { label: '主按钮', kind: 'primary' },
      { label: '次按钮', kind: 'ghost' },
      { label: '危险', kind: 'danger' },
      { label: '开关', kind: 'switch' },
      { label: '芯片', kind: 'chip' },
    ],
    tokens: [
      ['背景', 'bg'],
      ['面板', 'surface'],
      ['分隔线', 'line'],
      ['正文', 'text'],
      ['弱化', 'muted'],
      ['强调', 'accent'],
    ],
  },
}
