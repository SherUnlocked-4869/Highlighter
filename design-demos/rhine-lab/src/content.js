/* Highlighter · 真实产品内容模型
 *
 * 来源：Highlighter 4.1.2 源码只读考古（README.md / package.json / 各窗口
 * HTML+JS / shared/locales 中文语言包 / main/services/settings-defaults.js）。
 * 所有中文文案均为源码原文，未翻译、未改写、未编造功能。
 *
 * 标注「未确认」的地方：源码里没有可引用的原文或状态不可从代码判定。
 * 用于原型时请把「示意」类字段（AI 回答正文、OCR 置信度数值）当作占位展示，
 * 不要宣称它们来自真实运行结果。
 *
 * 挂载：window.HC
 */
(function exposeHighlighterContent(root) {
  const HC = {
    meta: {
      name: 'Highlighter',
      version: '4.1.2',
      // README:3 —— “Highlighter 是一款面向 Windows 的桌面截图与划词效率工具。”
      tagline: '桌面截图与划词效率工具',
      taglineSource: 'config.about.tagline（zh-CN 语言包原文）',
      platform: 'Windows 10 / Windows 11 · x64',
      windows: 12,
      // 窗口数量口径：config / capture / toolbar / action / search / recognition /
      // pin / record-control / record-frame / long-capture-controller /
      // long-capture-overlay / clipboard。capture/print.html 是离屏打印页，不计入。
      primaryWindowSize: '1120×760',
      sourceNote:
        '窗口尺寸取自 main.js 与 main/domains/*/index.js 的 BrowserWindow 参数；' +
        '文案取自 shared/locales/*.js 的 zh-CN 列与 README.md。'
    },

    /* ------------------------------------------------------------------ *
     * 功能清单：与「快捷功能」页的 functionGroups 一一对应（28 项，源码实数）
     * 来源 config/routes/home.js，文案取自 shared/locales/config.js
     * ------------------------------------------------------------------ */
    features: [
      { id: 'screenshot', name: '截图', desc: '自由框选、智能标注与导出', icon: 'capture', surface: '截图浮层', group: '截图' },
      { id: 'screenshotDelay', name: '延迟截图', desc: '倒计时后开始区域截图', icon: 'capture', surface: '截图浮层', group: '截图' },
      { id: 'screenshotFixed', name: '固定到屏幕', desc: '截图完成后直接贴到桌面', icon: 'pin', surface: '贴图窗口', group: '截图' },
      { id: 'screenshotOcr', name: '文本识别', desc: '截图后提取中文、英文等文字', icon: 'ocr', surface: '截图浮层', group: '截图' },
      { id: 'screenshotTable', name: '表格识别', desc: '恢复截图中的行列并复制到 Excel', icon: 'ocr', surface: '识别结果窗口', group: '截图' },
      { id: 'screenshotQr', name: '二维码识别', desc: '扫描二维码内容或打开其中的链接', icon: 'ocr', surface: '识别结果窗口', group: '截图' },
      { id: 'screenshotOcrTranslate', name: '文本识别翻译', desc: 'OCR 后调用翻译服务', icon: 'translate', surface: '截图浮层', group: '截图' },
      { id: 'screenshotCopy', name: '复制到剪贴板', desc: '完成选区后立即复制', icon: 'copy', surface: '截图浮层', group: '截图' },
      { id: 'screenshotLong', name: '长截图', desc: '框选滚动区域并自动拼接', icon: 'scroll', surface: '长截图窗口', group: '截图' },
      { id: 'screenshotFullScreen', name: '截取全屏', desc: '捕获鼠标所在显示器', icon: 'capture', surface: '截图浮层', group: '截图' },
      { id: 'screenshotFocusedWindow', name: '当前焦点窗口', desc: '捕获当前活动窗口', icon: 'capture', surface: '截图浮层', group: '截图' },

      { id: 'chat', name: '打开 AI 对话', desc: '使用配置的 AI 模型进行多轮对话', icon: 'ai', surface: '主窗口 · AI 对话', group: 'AI' },
      { id: 'chatSelectText', name: '对话框填入选中文本', desc: '保留现有划词助手工作流', icon: 'ai', surface: '主窗口 · AI 对话', group: 'AI' },
      { id: 'explainClipboard', name: '解释剪贴板文本', desc: '只读剪贴板并送入解释窗口，不写回剪贴板', icon: 'ai', surface: '划词助手窗口', group: 'AI' },

      { id: 'translation', name: '打开翻译工具', desc: '支持自动检测与中英互译', icon: 'translate', surface: '主窗口 · 翻译', group: '翻译' },
      { id: 'translationSelectText', name: '翻译选中的文本', desc: '划词后快速翻译', icon: 'translate', surface: '主窗口 · 翻译', group: '翻译' },

      { id: 'videoRecord', name: '视频录制', desc: '录制屏幕并导出 MP4 视频', icon: 'record', surface: '录制控制条', group: '视频录制' },

      { id: 'localSearch', name: '本地搜索', desc: '使用 Everything 全盘搜索本地文件', icon: 'search', surface: '本地搜索窗口', group: '其它' },

      { id: 'openClipboardHistory', name: '剪贴板历史', desc: '本地保存文本、链接和静态图片。关闭后停止采集并保留历史。', icon: 'clipboard', surface: '剪贴板面板', group: '其它' },
      { id: 'fixedContent', name: '固定本地图片', desc: '选择图片并固定到桌面', icon: 'pin', surface: '贴图窗口', group: '其它' },
      { id: 'fullScreenDraw', name: '全屏画布', desc: '在白色全屏画布中绘制', icon: 'capture', surface: '截图浮层 · canvas 模式', group: '其它' },
      { id: 'toggleFixedContentVisibility', name: '显示/隐藏所有贴图', desc: '批量控制桌面贴图', icon: 'pin', surface: '桌面贴图', group: '其它' },
      { id: 'openImageSaveFolder', name: '打开图片目录', desc: '打开默认截图保存位置', icon: 'folder', surface: '系统资源管理器', group: '其它' },
      { id: 'openCaptureHistory', name: '打开截图历史', desc: '回顾、复制和重新编辑截图', icon: 'history', surface: '主窗口 · 截图历史', group: '其它' },
      { id: 'screenshotQuickSave', name: '快速保存', desc: '完成选区后直接保存到上次的目录', icon: 'save', surface: '截图浮层', group: '其它' },
      { id: 'screenshotSaveAs', name: '另存为', desc: '完成选区后弹出保存对话框', icon: 'save', surface: '截图浮层', group: '其它' },
      { id: 'togglePinClickThrough', name: '取消全部穿透', desc: '立即让所有贴图退出点击穿透状态', icon: 'pin', surface: '桌面贴图', group: '其它' },
      {
        id: 'toggleTranslationProxy',
        name: '翻译代理开关',
        desc: '启动或停止 Index-Translate 本地代理（沉浸式翻译用）',
        icon: 'update',
        surface: '系统托盘',
        group: '其它'
      }
    ],

    /* ------------------------------------------------------------------ *
     * 快捷键
     * A. 全局快捷键：main/services/settings-defaults.js 的 DEFAULT_SETTINGS.shortcuts
     *    共 25 个键位，只有 3 个带出厂默认值，其余默认空字符串（设置页显示「未设置」）。
     * B. 窗口内快捷键：各窗口 JS 的 keydown 处理（真实存在，不是全局热键）。
     * ------------------------------------------------------------------ */
    hotkeys: [
      { action: '截图', keys: ['F1'], note: '全局唯一出厂默认热键；25 个可配置项中只有 3 项有默认值', scope: 'global' },
      { action: '本地搜索', keys: ['Alt', 'F'], note: '全局快捷键', scope: 'global' },
      { action: '解释剪贴板文本', keys: ['Ctrl', 'Alt', 'E'], note: '全局快捷键', scope: 'global' },

      { action: '复制截图', keys: ['Enter'], note: '截图浮层内；也可双击画布复制（可关闭）', scope: 'capture' },
      { action: '保存截图', keys: ['Ctrl', 'S'], note: '截图浮层内', scope: 'capture' },
      { action: '撤销标注', keys: ['Ctrl', 'Z'], note: '截图浮层内', scope: 'capture' },
      { action: '重做标注', keys: ['Ctrl', 'Y'], note: '截图浮层内', scope: 'capture' },
      { action: '选中当前显示器 / 再按一次扩到整桌面', keys: ['Ctrl', 'A'], note: '截图浮层内，两级行为', scope: 'capture' },
      { action: '删除选中标注', keys: ['Delete'], note: '截图浮层内', scope: 'capture' },
      { action: '取消 / 逐级关闭', keys: ['Esc'], note: '截图浮层内；优先级：结果面板 → 转换菜单 → 取色板 → OCR 结果 → 水印面板 → 取消选中 → 关闭窗口', scope: 'capture' },
      { action: '微调选中标注', keys: ['方向键'], note: '1px；按住 Shift 为 10px（截图浮层内）', scope: 'capture' },

      { action: '发送追问', keys: ['Enter'], note: '划词助手输入框内；Shift+Enter 换行', scope: 'action' },
      { action: '发送消息', keys: ['Ctrl', 'Enter'], note: '主窗口 AI 对话（提示词原文：输入消息，Ctrl+Enter 发送）', scope: 'chat' },

      { action: '打开文件所在目录', keys: ['Ctrl', 'Enter'], note: '本地搜索窗口内', scope: 'search' },
      { action: '打开选中文件', keys: ['Enter'], note: '本地搜索窗口内', scope: 'search' },
      { action: '切换分类', keys: ['Tab'], note: 'Shift+Tab 反向；本地搜索窗口内', scope: 'search' },
      { action: '关闭窗口', keys: ['Esc'], note: '本地搜索窗口', scope: 'search' },

      { action: '复制选中记录', keys: ['Enter'], note: '剪贴板面板', scope: 'clipboard' },
      { action: '粘贴选中记录', keys: ['Ctrl', 'Enter'], note: '剪贴板面板；粘贴到呼出面板前的输入框', scope: 'clipboard' },
      { action: '查看全文', keys: ['Space'], note: '剪贴板面板', scope: 'clipboard' },
      { action: '删除选中记录', keys: ['Delete'], note: '剪贴板面板', scope: 'clipboard' },

      { action: '关闭贴图 / 复制贴图', keys: ['Esc'], note: '贴图窗口内 Esc 关闭；Ctrl+C 复制；双击图片关闭', scope: 'pin' },
      { action: '贴图缩放 / 透明度', keys: ['滚轮'], note: '滚轮缩放（默认每格 10%）；Ctrl+滚轮 调不透明度', scope: 'pin' },

      { action: '完成长截图（复制并关闭）', keys: ['Enter'], note: '长截图控制窗内', scope: 'long-capture' },
      { action: '取消长截图', keys: ['Esc'], note: '长截图控制窗内', scope: 'long-capture' },

      { action: '添加水印', keys: ['Enter'], note: '水印面板内容输入框内', scope: 'capture' },

      { action: '录屏窗口内快捷键', keys: [], note: '未确认：record/record.js 未绑定键盘快捷键', scope: 'record' }
    ],

    /* ------------------------------------------------------------------ *
     * 窗口清单（12 个可见表面）
     * size 均取自 BrowserWindow 参数；标记「随选区/显示器」的窗口是运行时计算。
     * ------------------------------------------------------------------ */
    windows: [
      {
        id: 'config',
        title: 'Highlighter（主窗口）',
        size: '1120×760',
        minSize: '880×620',
        sizeNote: '无边框（frame:false），窗口标题 Highlighter',
        role: '设置与全部功能的管理中枢：13 个侧栏路由 + 页头状态栏',
        regions: [
          { name: '侧栏', desc: '品牌字标 Highlighter（High 加粗）+ 13 个导航项，分「工具箱 / 工具设置 / 设置」三组，固定宽 224px' },
          { name: '标题栏', desc: '当前页面标题 + 最小化、关闭两个窗口按钮' },
          { name: '状态栏（status rail）', desc: '识别引擎 / 模型 / 热键 / 本地搜索 四格；仅在「快捷功能」「截图与录制」「AI 与模型」三页出现，高 34px' },
          { name: '内容区', desc: '各路由渲染区，最大宽度 980px 居中' },
          { name: 'Toast', desc: '底部轻提示，1.8s 自动消失（如「设置已保存」「已恢复默认设置」）' }
        ],
        states: ['快捷功能', '翻译', 'AI 对话', '截图历史', '划词工具', '本地搜索', '剪贴板历史', '用量', '通用', '截图与录制', 'AI 与模型', '系统与数据', '关于', '浅色/深色', '紧凑布局', '自定义皮肤', '快捷键冲突红标']
      },
      {
        id: 'capture',
        title: 'Highlighter 截图',
        size: '覆盖选区所在显示器全屏',
        sizeNote: 'createLocalWindow 先给 min(bounds,800×600)，随后 setBounds(captureBounds) 撑满显示器；frame:false，非 canvas 模式不透明',
        role: '框选、标注、识别、导出的一体化浮层',
        regions: [
          { name: '背景画布 backgroundStage', desc: '截屏原图 + 选区外遮罩（默认 rgba(0,0,0,.46)）' },
          { name: '标注画布 stage', desc: '所有标注元素与选区控制点（8 个角点/边点）' },
          { name: '顶部提示 tip', desc: '「拖动选择区域 · 拖动边缘或角点调整 · Esc 退出」' },
          { name: '尺寸徽标 sizeBadge', desc: '选区左上角显示「1280 × 720」式尺寸' },
          { name: '截图工具栏 toolbar', desc: '两行：第 1 行全部工具与出口，第 2 行为当前工具专属选项；宽屏在选区下方，放不下翻到上方并反转行序' },
          { name: '元素操作条 elementBar', desc: '选中标注后出现：已选中标注 / 右键拖动元素 · Alt+拖动选区 / 拖动圆点缩放 / 删除 / 上移 / 下移 / 取消选中' },
          { name: '水印面板 watermarkPanel', desc: '内容、日期后缀、透明度 80%、颜色、间距 30%、大小 24px、角度 30°、添加水印' },
          { name: '识别结果面板 resultPanel', desc: '标题 + 原文（翻译模式）+ 只读文本域 + 复制文本 / 完成' },
          { name: 'OCR 覆盖层 ocrOverlay', desc: '按文字块逐块覆盖原文：识别结果条显示「识别到 N 处文本 · {ms} ms」，可切「查看原文 / 查看译文」「纯文本」「复制全部」' },
          { name: '处理中 loading', desc: '「处理中…」「正在识别文字…」「正在识别并翻译…」' }
        ],
        states: ['手动框选', '智能选区（auto）', '已选中', '拖动/缩放', '标注中（9 种工具）', 'OCR 结果覆盖', '识别并翻译覆盖', '全屏截图', '图像编辑（贴图重新标注）', '白色全屏画布']
      },
      {
        id: 'toolbar',
        title: '划词工具栏',
        size: '宽 359 × 高 40',
        sizeNote: '宽由按钮数计算（默认 4 个按钮、中文标签 = 359px）；高固定 40px；透明无边框、hasShadow:false',
        role: '选中文本后浮出的快捷操作条',
        regions: [
          { name: '状态 LED', desc: '6×6 强调色方块，与主窗口状态栏呼应' },
          { name: '动作按钮', desc: '图标（15px mask）+ 标签；复制为主按钮（强调色实心），其余为表面层' },
          { name: '分隔线', desc: '按钮之间 1px 竖线' }
        ],
        states: ['默认 4 按钮：复制 / 搜索 / 翻译 / 解释', '可选第 5 项：跳转', '自定义 AI 功能（最多 12 个）', '浅色/深色']
      },
      {
        id: 'action',
        title: '划词助手',
        size: '550×560',
        minSize: '380×340',
        sizeNote: 'resultWindow 默认尺寸，可拖拽并记忆',
        role: '翻译 / 解释 / 自定义划词功能的结果窗口，支持多轮追问',
        regions: [
          { name: '页头', desc: '图标 + 标题（翻译中...）+ 类型徽章（翻译 / 解释）+ 置顶按钮' },
          { name: '划词原文 sourceText', desc: '被划取的原文，置顶展示' },
          { name: '对话区 transcript', desc: '每轮回答；「思考过程」可折叠（预览态 + 全文）' },
          { name: '加载态', desc: '「正在请求 DeepSeek...」「正在翻译...」「正在思考...」' },
          { name: '追问输入区 composer', desc: '「就上面的结果继续追问…」+ 发送/停止按钮 + 引用选中 / 重新生成 / 复制对话 + 提示行' }
        ],
        states: ['请求中', '流式生成中', '已停止生成', '窗口已隐藏，生成已中断', '请求超时', '首次请求失败（无法追问）', '达到最大追问轮数', '已置顶']
      },
      {
        id: 'search',
        title: '本地搜索',
        size: '840×620',
        minSize: '620×420',
        role: '基于 Everything 的全盘文件搜索',
        regions: [
          { name: '搜索框', desc: '占位「搜索本地文件（支持 Everything 语法，如 ext:pdf 报告）」+ 清空按钮 + 关闭' },
          { name: '分类页签', desc: '全部 / 文件夹 / EXCEL / WORD / PPT / PDF / 图片 / 视频 / 音频 / 压缩文件' },
          { name: '结果列表', desc: '每行：文件图标（或扩展名徽标）、高亮文件名、完整路径、大小、修改时间；行内动作「打开所在目录」「复制路径」' },
          { name: '空态', desc: '「输入关键字开始搜索」「正在搜索...」「没有找到结果」' },
          { name: '页脚', desc: 'Everything 状态 + 匹配路径开关 + 排序下拉（8 种）+ 计数「已加载 N / 共 M 条结果」' }
        ],
        states: ['正在检测 Everything...', 'Everything 已就绪 · v{version}', '索引暂无内容', '搜索中', '无结果', '查询失败']
      },
      {
        id: 'recognition',
        title: '识别结果（表格 / 二维码）',
        size: '表格 820×620 · 二维码 640×420',
        minSize: '表格 600×440 · 二维码 480×320',
        role: '表格识别与二维码识别的结果窗口',
        regions: [
          { name: '页头', desc: '标题（表格识别 / 二维码识别）+ 摘要（「{rows} 行 × {columns} 列」「已识别链接」）+ 「本地 OCR」徽章 + 关闭' },
          { name: '表格视图', desc: '还原行列的表格' },
          { name: '二维码视图', desc: '只读文本域展示二维码内容' },
          { name: '页脚', desc: '复制格式（TSV（粘贴到表格）/ CSV / Markdown）、打开链接、导出 Excel、导出 PDF、复制（主按钮）' }
        ],
        states: ['正在处理…', '正在恢复表格结构…', '正在扫描二维码…', '识别失败', '未识别到二维码', '导出失败']
      },
      {
        id: 'pin',
        title: '贴图窗口',
        size: '随图片内容（useContentSize）',
        sizeNote: '最大不超过工作区 55%；窗口按旋转后包围盒计算；滚轮缩放会改窗口尺寸',
        role: '把截图或本地图片固定在桌面最前方',
        regions: [
          { name: '图片/画布面', desc: '旋转容器内的图片或逐像素画布' },
          { name: '缩放徽标', desc: '「100%」，滚轮后显示 550ms' },
          { name: '不透明度徽标', desc: '「100%」，Ctrl+滚轮后显示；title 原文「不透明度（Ctrl + 滚轮调整）」' },
          { name: '穿透标签', desc: '「穿透中 · 悬停退出」，点击穿透状态下显示' },
          { name: '右键菜单', desc: '重新标注 / 文本识别 / 表格识别 / 二维码识别 / 旋转 90° / 透明度（25–100%）/ 点击穿透（开启·关闭）/ 复制 / 保存 / 导出 PDF… / 关闭' }
        ],
        states: ['正常', '点击穿透', '旋转 90°', '不透明度 25/50/75/100%', '长截图贴图（可滚动）']
      },
      {
        id: 'record-control',
        title: 'Highlighter 区域录制',
        size: '宽 ≤760 × 高 86（窄屏 126）',
        sizeNote: '宽度 min(760, 工作区宽)，高 86px；工作区宽 <700 时变 126px；贴在选区下方 12px，放不下翻到上方',
        role: '录屏控制条：计时、标注、开始/暂停/停止',
        regions: [
          { name: '状态簇', desc: '状态点 + 计时「00:00」+ 状态文字 + 「24 FPS」' },
          { name: '倒计时', desc: '开始前居中显示秒数' },
          { name: '标注工具组', desc: '指针 / 画笔 / 矩形 / 椭圆 / 箭头 + 颜色和粗细（7 色、细中粗）+ 撤销标注 + 清除全部标注' },
          { name: '控制按钮', desc: '开始（主）/ 暂停 / 停止（危险）/ 取消录制（×）' },
          { name: '预览视图', desc: '录制预览 + 时长 + 重新录制 + 保存 MP4 + 进度「正在生成 MP4 · {percent}%」' }
        ],
        states: ['区域已就绪', '即将开始', '正在录制', '录制已暂停', '录制完成', '正在生成 MP4', '无声视频提示（麦克风/系统声音不可用）']
      },
      {
        id: 'record-frame',
        title: 'Highlighter 录制区域',
        size: '选区外扩 2px',
        role: '录屏时显示在选区上的标注层（透明、置顶、不可点击）',
        regions: [{ name: '标注画布', desc: '仅绘制录制期间的画笔/矩形/椭圆/箭头标注，不显示其他 UI' }],
        states: ['idle', 'recording', 'paused', '预览']
      },
      {
        id: 'long-capture-controller',
        title: '长截图',
        size: '420×570',
        sizeNote: '贴在选区右侧 10px；右侧放不下依次换到左侧 / 下方 / 上方，都放不下则贴工作区右下',
        role: '滚动截图的方向、裁剪与出口控制',
        regions: [
          { name: '标题栏', desc: '状态点 + 「长截图」+ 取消长截图（×）' },
          { name: '预览区', desc: '160×180 画布实时拼接预览；空态「等待开始」' },
          { name: '状态区', desc: '状态文字 + 尺寸「0 × 0」+ 段数「0 段」+ 匹配置信度百分比' },
          { name: '方向', desc: '「纵向」「横向」+「选区」（调整截图区域）' },
          { name: '裁剪', desc: '「裁前」「裁后」像素输入 + px' },
          { name: '传输区', desc: '「开始」/「暂停」/「继续」主按钮' },
          { name: '出口', desc: '贴图 / 保存 / 快存 / 复制并关闭（主）' }
        ],
        states: ['正在准备屏幕采集', '已记录起始画面，等待滚动', '匹配成功', '等待画面滚动', '未能匹配，请放慢滚动速度', '已暂停', '准备就绪', '屏幕采集失败']
      },
      {
        id: 'long-capture-overlay',
        title: '长截图选区',
        size: '显示器全屏',
        role: '长截图时覆盖全屏的透明选区框（8 个方向手柄 + 标题）',
        regions: [
          { name: '选区框', desc: '4 边框 + 8 个手柄（n/s/e/w/nw/ne/sw/se）' },
          { name: '标签', desc: '框内「长截图」' }
        ],
        states: ['只读（点击穿透）', '调整选区（可拖动/缩放）']
      },
      {
        id: 'clipboard',
        title: '剪贴板历史',
        size: '480×640',
        minSize: '380×420',
        sizeNote: '不超过工作区；打开时定位在工作区垂直方向 1/3 处；失焦自动隐藏',
        role: '本地剪贴板历史：搜索、粘贴、置顶、清理',
        regions: [
          { name: '顶栏', desc: '标题「剪贴板历史」+「本地」徽章 + 暂停记录 + 关闭' },
          { name: '状态条', desc: 'LED + 运行状态（正在记录 / 已暂停 / 已关闭 / 后台异常 / 已停止）+ 刷新' },
          { name: '搜索框', desc: '「搜索历史文本」' },
          { name: '类型筛选', desc: '全部 / 文本 / 链接 / 图片 + 置顶' },
          { name: '新记录横幅', desc: '「有新记录，点击刷新」' },
          { name: '列表', desc: '虚拟滚动；文本为单行（预览文本 + 来源应用 · 时间 · 大小 + TXT/URL 徽标），图片为缩略图网格；文本行高 64px、图片格 92px' },
          { name: '详情区', desc: '全文 / 图片 + 类型徽标 + 「图片 {width} × {height}」+ 截断提示「详情仅显示前 64 KiB，复制时保留完整原文。」' },
          { name: '页脚', desc: '复制（主）/ 粘贴 / 查看全文 / 置顶 / 删除 / 清空普通记录' },
          { name: '粘贴结果反馈', desc: '「粘贴结果」+ 成功或失败文案（如「已发送粘贴，请在目标应用查看。」）' }
        ],
        states: ['正在记录', '已暂停', '因系统状态暂停', '已关闭', '后台异常', '已停止', '暂无匹配记录', '加载下一页', '粘贴结果反馈']
      }
    ],

    /* ------------------------------------------------------------------ *
     * 设置页导航树（侧栏 13 项）与每页真实控件
     * 控件值 = main/services/settings-defaults.js 的出厂默认值
     * ------------------------------------------------------------------ */
    configNav: [
      {
        section: '快捷功能',
        route: 'home',
        items: [
          { label: '功能页签', control: 'button', value: '截图 / AI / 翻译 / 视频录制 / 其它 / 快捷键', options: ['截图', 'AI', '翻译', '视频录制', '其它', '快捷键'] },
          { label: '功能行', control: 'button', value: '28 项快捷功能，行内右侧为快捷键录制按钮', note: '点击行直接执行功能；延迟截图会先弹「延迟秒数」输入（默认 3 秒）' },
          { label: '快捷键页签说明', control: 'text', value: '点击右侧按键框后录入组合键（输入法组合键等无效按键会被忽略）；右键可清除。红色警告表示快捷键冲突或不可用。' }
        ]
      },
      {
        section: '翻译',
        route: 'translation',
        items: [
          { label: '源语言', control: 'select', value: '自动检测', options: ['自动检测', '中文', '英文', '日文', '韩文'] },
          { label: '源文本', control: 'input', value: '', note: '占位「输入或粘贴要翻译的文本」' },
          { label: '交换语言', control: 'button', value: '⇄' },
          { label: '清空 / 翻译', control: 'button', value: '清空 / 翻译' },
          { label: '目标语言', control: 'select', value: '中文', options: ['中文', '英文', '日文', '韩文', '繁体中文'] },
          { label: '结果', control: 'input', value: '', note: '只读，占位「翻译结果」；动作「复制结果」' }
        ]
      },
      {
        section: 'AI 对话',
        route: 'chat',
        items: [
          { label: '空态文案', control: 'text', value: '输入问题开始对话。可在“设置 > 模型”中为 AI 对话选择供应商、模型，并调整 Temperature 与 Token 上限。' },
          { label: '输入框', control: 'input', value: '', note: '占位「输入消息，Ctrl+Enter 发送」' },
          { label: '发送', control: 'button', value: '发送' }
        ]
      },
      {
        section: '截图历史',
        route: 'history',
        items: [
          { label: '统计卡', control: 'text', value: '占用空间 / 有效记录 / 失效记录 / 孤立文件' },
          { label: '搜索', control: 'input', value: '', note: '占位「搜索来源、操作或文件名」' },
          { label: '来源筛选', control: 'select', value: '全部来源', options: ['全部来源', '区域截图', '长截图', '焦点窗口', '本地图片', '历史编辑', '快速保存', '另存为'] },
          { label: '批量操作', control: 'button', value: '全选已加载项 / 导出选中项 / 导出 PDF / 删除选中项', note: '页头另有「清理失效项」「清空全部」' },
          { label: '分页', control: 'button', value: '加载更多', note: '每页 40 项' }
        ]
      },
      {
        section: '划词工具',
        route: 'selection-toolbar',
        items: [
          { label: '启用划词工具栏', control: 'toggle', value: true },
          { label: '剪贴板兼容模式', control: 'toggle', value: false },
          { label: '功能与顺序', control: 'button', value: '拖动排序（4 个内置 + 可选「跳转」+ 自定义）' },
          { label: '翻译提示词', control: 'input', value: '你是一个专业的翻译助手。请按照设置的语言方向翻译用户输入的文本，只输出翻译结果，不要添加任何额外说明或解释。' },
          { label: '解释提示词', control: 'input', value: '你是一个知识渊博的解说专家。请对用户提供的文本进行深入分析和解读：核心要点 / 详细解释 / 延伸知识三段式，请使用中文回答，内容充实但不冗长，层次分明。' },
          { label: '翻译思考强度', control: 'select', value: '关', options: ['关', '低', '高', '最高'] },
          { label: '解释思考强度', control: 'select', value: '高', options: ['关', '低', '高', '最高'] },
          { label: '翻译原语言', control: 'select', value: '自动识别', options: ['自动识别', '中文', '日文', '英文', '韩文'] },
          { label: '翻译目标语言', control: 'select', value: '中文', options: ['中文', '日文', '英文'] },
          { label: '搜索引擎', control: 'select', value: 'Bing', options: ['Bing', '百度', 'Google'] },
          { label: '追问开关', control: 'toggle', value: true },
          { label: '追问轮数', control: 'select', value: '10 轮', options: ['3 轮', '5 轮', '10 轮', '20 轮'] },
          { label: '保存对话到本地', control: 'toggle', value: false },
          { label: '自定义 AI 功能', control: 'button', value: '＋ 添加功能', note: '最多 12 个；每项含功能名称、提示词、思考强度' }
        ]
      },
      {
        section: '本地搜索',
        route: 'local-search',
        items: [
          { label: '运行状态', control: 'text', value: '未运行 / 已就绪 / 运行中 / 异常 / 启动中 / 检测中' },
          { label: '打开搜索窗口', control: 'button', value: '打开' },
          { label: '匹配路径', control: 'toggle', value: true },
          { label: '单次结果上限', control: 'input', value: 600, note: '范围 100–2000' },
          { label: '自动启动内置 Everything', control: 'toggle', value: true },
          { label: '搜索分类', control: 'button', value: '添加分类 / 恢复默认分类 / 保存分类', note: '默认 10 类，规则如 ext:pdf、folder:' }
        ]
      },
      {
        section: '剪贴板历史',
        route: 'clipboard-history',
        items: [
          { label: '启用剪贴板历史', control: 'toggle', value: false, note: '出厂默认关闭' },
          { label: '记录文本与链接', control: 'toggle', value: true },
          { label: '记录静态图片', control: 'toggle', value: true },
          { label: '普通记录数量上限', control: 'input', value: 500, note: '范围 100–5000' },
          { label: '普通记录保留天数', control: 'input', value: 30, note: '范围 1–365' },
          { label: '原件容量上限（MiB）', control: 'input', value: 256, note: '范围 64–1024' },
          { label: '磁盘软上限（MiB）', control: 'input', value: 384, note: '范围 128–2048' },
          { label: '缩略图容量上限（MiB）', control: 'input', value: 64, note: '范围 16–256' },
          { label: '隐藏后释放面板', control: 'select', value: '1 分钟', options: ['立即', '1 分钟', '5 分钟'] },
          { label: '排除应用', control: 'input', value: '', note: '每行一个小写 .exe 文件名，如 keepass.exe' },
          { label: '操作', control: 'button', value: '保存设置 / 打开历史面板 / 清空普通记录 / 清空全部记录（含置顶）' }
        ]
      },
      {
        section: '用量',
        route: 'usage',
        items: [
          { label: '说明', control: 'text', value: '本机 AI CLI 的 Token 用量；只读日志，仅存计数，不上传任何内容' },
          { label: '首次访问', control: 'button', value: '开启统计', note: '统计默认关闭，需显式开启后才扫描' },
          { label: '统计周期', control: 'select', value: '日', options: ['日', '周', '月', '总计', '自定义'] },
          { label: 'AI 工具筛选', control: 'select', value: '全部', options: ['全部', 'Codex', 'DeepSeek-Harness', 'OpenCode'] },
          { label: '总览', control: 'text', value: 'TOKEN 总数 / 计费 Token / 来源占比 / 区间 / 活跃热力图（近 52 周）/ 今日小时分布 / 模型占比 / 使用趋势 / 每日明细' },
          { label: '操作', control: 'button', value: '刷新 / 清除数据' }
        ]
      },
      {
        section: '通用',
        route: 'settings-general',
        items: [
          { label: '主题', control: 'select', value: '跟随系统', options: ['跟随系统', '浅色', '深色'] },
          { label: '主色', control: 'input', value: '#e5a44c', note: '按钮、选中状态和截图框颜色' },
          { label: '圆角', control: 'slider', value: 8, note: '0–20' },
          { label: '紧凑布局', control: 'toggle', value: false },
          { label: '皮肤图片路径', control: 'input', value: '', note: '支持 PNG、JPG、WebP 等本地图片' },
          { label: '皮肤透明度', control: 'slider', value: 18, note: '0–100' },
          { label: '自定义 CSS', control: 'input', value: '', note: '覆盖主界面样式' },
          { label: '界面语言', control: 'select', value: '简体中文', options: ['简体中文', 'English', '繁體中文'] },
          { label: '界面缩放', control: 'text', value: '自动', note: '使用系统 DPI 与窗口缩放' },
          { label: '开机自动启动', control: 'toggle', value: true },
          { label: '启用系统托盘', control: 'toggle', value: true },
          { label: '游戏模式', control: 'toggle', value: false, note: '暂停全局快捷键、划词工具以及截图、搜索和录屏等唤出入口' },
          { label: '运行日志', control: 'toggle', value: true },
          { label: '功能模块', control: 'toggle', value: '文本识别 / 翻译 / AI 对话 / 视频录制 均开启', note: '四项独立开关' },
          { label: '更新通道', control: 'select', value: '稳定版', options: ['稳定版', '测试版'] },
          { label: '软件更新', control: 'button', value: '检查更新 / 打开下载页 / 下载更新 / 退出并安装' }
        ]
      },
      {
        section: '截图与录制',
        route: 'settings-function',
        items: [
          { label: '页签', control: 'select', value: '截图与输出', options: ['截图与输出', '文本识别', '录制与贴图'] },
          { label: '复制后自动保存', control: 'toggle', value: false },
          { label: '一键快速保存', control: 'toggle', value: false },
          { label: '截图快门音', control: 'toggle', value: true },
          { label: '截图带光标', control: 'toggle', value: false },
          { label: '长截图默认方向', control: 'select', value: '纵向', options: ['纵向', '横向'] },
          { label: '保存目录', control: 'input', value: '', note: '留空用系统「图片」目录；右侧「选择」' },
          { label: '文件命名模板', control: 'input', value: '', note: '占位 Highlighter_{date}_{time}；可用变量 {app}、{date}、{time}、{datetime}' },
          { label: '序号跨截图保留', control: 'toggle', value: false },
          { label: '记录截图历史', control: 'toggle', value: true },
          { label: '历史数量上限', control: 'input', value: 200, note: '范围 10–1000' },
          { label: '截图历史存储目录', control: 'input', value: '', note: '不能为空；右侧「选择」' },
          { label: '截图选区遮罩', control: 'input', value: 'rgba(0,0,0,.46)' },
          { label: '双击复制截图', control: 'toggle', value: true },
          { label: '显示取色器入口', control: 'toggle', value: true },
          { label: '识别模型', control: 'select', value: 'PaddleOCR v4 中英移动版' },
          { label: '文字方向检测', control: 'toggle', value: false },
          { label: '最低置信度', control: 'input', value: 0.3, note: '0–1' },
          { label: '识别后操作', control: 'select', value: '显示识别结果', options: ['显示识别结果', '复制全部文本', '复制文本并关闭截图'] },
          { label: '帧率', control: 'select', value: '24 FPS', options: ['5 FPS', '16 FPS', '24 FPS', '30 FPS', '60 FPS'] },
          { label: '系统声音', control: 'toggle', value: true },
          { label: '麦克风', control: 'toggle', value: false, note: '默认关闭（隐私优先）' },
          { label: '视频保存目录', control: 'input', value: '' },
          { label: '新贴图默认进入点击穿透', control: 'toggle', value: false },
          { label: '贴图滚轮缩放步进', control: 'select', value: '10%', options: ['5%', '10%', '15%', '20%', '25%', '50%'] },
          { label: '滚轮调透明度', control: 'text', value: '提示行：贴图窗口内按住 Ctrl 滚动滚轮可调透明度（点击穿透时不可用）' }
        ]
      },
      {
        section: 'AI 与模型',
        route: 'models',
        items: [
          { label: '页签', control: 'select', value: '供应商', options: ['供应商', '功能模型', '默认参数'] },
          { label: '添加供应商', control: 'button', value: '＋ 添加供应商 / 添加 Coding Plan / 打开配置文件' },
          { label: '显示名称', control: 'input', value: 'DeepSeek', note: '占位「例如：DeepSeek」' },
          { label: 'API 地址', control: 'input', value: 'https://api.deepseek.com' },
          { label: 'API 协议', control: 'select', value: 'openai-chat', options: ['openai-chat', 'openai-responses'] },
          { label: 'API 密钥', control: 'input', value: '', note: '占位「已配置——输入新值可替换」；提示「通过系统安全存储加密保存在本机」' },
          { label: '模型目录', control: 'button', value: '获取可用模型 / ＋ 添加模型 / 恢复默认模型', note: '默认模型 DeepSeek V4 Flash' },
          { label: '支持图像输入', control: 'toggle', value: false, note: '勾选后可用「图片转 Markdown / HTML」' },
          { label: '功能模型', control: 'select', value: 'AI 对话 / 翻译工具 / 截图 OCR 翻译 / 划词翻译 / 划词解释', note: '每个功能单独指定供应商与模型' },
          { label: '最大 Token', control: 'input', value: 4096 },
          { label: 'Temperature', control: 'input', value: 0.7 },
          { label: '默认翻译目标语言', control: 'select', value: '中文', options: ['中文', '英文', '日文', '韩文', '繁体中文'] }
        ]
      },
      {
        section: '系统与数据',
        route: 'settings-system',
        items: [
          { label: '软件数据目录', control: 'input', value: '（运行时路径）', note: '只读；右侧「打开」「更改」' },
          { label: '清除截图历史', control: 'button', value: '清除', note: '同时删除截图历史目录中的对应图片文件' },
          { label: '代理状态', control: 'text', value: '未运行 / 运行中 / 正在切换… / 启动或停止失败' },
          { label: '随 Highlighter 启动', control: 'toggle', value: false },
          { label: '端口', control: 'input', value: 8080 },
          { label: '监听地址', control: 'select', value: '127.0.0.1', options: ['127.0.0.1', '0.0.0.0'] },
          { label: '上游 API 地址', control: 'input', value: '', note: '留空使用内置云端接口；网页正文会被发送到该地址' },
          { label: '沉浸式翻译配置', control: 'button', value: '复制配置', note: '模板：翻译服务：OpenAI 兼容 / 接口地址 / 模型 Index-Translate-35B-A3B / API Key：任意字符串 / 最大请求频率：3~5' },
          { label: '预览诊断信息', control: 'button', value: '预览' },
          { label: '导出诊断包', control: 'button', value: '导出 ZIP' },
          { label: '包含崩溃转储', control: 'toggle', value: false },
          { label: '恢复默认设置', control: 'button', value: '恢复默认设置' }
        ]
      },
      {
        section: '关于',
        route: 'about',
        items: [
          { label: '标语', control: 'text', value: '桌面截图与划词效率工具' },
          { label: '版本行', control: 'text', value: '版本 4.1.2 · win32 · 开发环境', note: '安装类型四选一：安装版 / 便携版 / 解压测试版 / 开发环境' },
          { label: '简介', control: 'text', value: '集截图标注、长截图、文字与表格识别、二维码扫描、贴图、历史管理、翻译、AI 对话、录屏、全屏画布、热键和个性化设置于一体。' },
          { label: '项目主页', control: 'button', value: '项目主页', note: 'https://github.com/SherUnlocked-4869/Highlighter' },
          { label: '软件更新', control: 'button', value: '软件更新', note: '已移至「设置 · 通用 · 软件更新」' }
        ]
      }
    ],

    /* ------------------------------------------------------------------ *
     * 截图工具栏（capture/capture.html 第 1 行，全部真实按钮）
     * key = 源码里的键位提示原文（无提示的留空字符串）
     * ------------------------------------------------------------------ */
    toolbar: [
      { id: 'select', label: '选择/调整', key: '', icon: 'select', group: 'tool' },
      { id: 'rect', label: '矩形', key: '', icon: 'rect', group: 'tool' },
      { id: 'ellipse', label: '椭圆', key: '', icon: 'ellipse', group: 'tool' },
      { id: 'arrow', label: '箭头', key: '', icon: 'arrow', group: 'tool' },
      { id: 'line', label: '直线', key: '', icon: 'line', group: 'tool' },
      { id: 'pen', label: '画笔', key: '', icon: 'pen', group: 'tool' },
      { id: 'highlight', label: '高亮', key: '', icon: 'highlight', group: 'tool' },
      { id: 'blur', label: '马赛克', key: '', icon: 'mosaic', group: 'tool' },
      { id: 'text', label: '文字', key: '', icon: 'text', group: 'tool' },
      { id: 'serial', label: '序号', key: '', icon: 'serial', group: 'tool' },
      { id: 'watermark', label: '水印', key: '', icon: 'watermark', group: 'tool' },
      { id: 'color', label: '颜色', key: '', icon: 'palette', group: 'style', note: '弹出 7 色 + 自定义取色 + 最近使用' },
      { id: 'width', label: '线宽', key: '', icon: 'weight-medium', group: 'style', note: '细 2px / 中 4px / 粗 8px，默认中' },
      { id: 'undo', label: '撤销', key: 'Ctrl+Z', icon: 'undo', group: 'edit' },
      { id: 'redo', label: '重做', key: 'Ctrl+Y', icon: 'redo', group: 'edit' },
      { id: 'longCapture', label: '长截图', key: '', icon: 'long-capture', group: 'convert' },
      { id: 'qr', label: '二维码识别', key: '', icon: 'qr', group: 'convert' },
      { id: 'table', label: '表格识别', key: '', icon: 'table', group: 'convert' },
      { id: 'ocr', label: '文本识别', key: '', icon: 'ocr', group: 'convert' },
      { id: 'translate', label: '识别并翻译', key: '', icon: 'translate', group: 'convert' },
      { id: 'convertDoc', label: '图片转文档', key: '', icon: 'doc-convert', group: 'convert', note: '弹出「转为 Markdown」「转为 HTML」两项' },
      { id: 'record', label: '区域录制', key: '', icon: 'record', group: 'convert', note: '选区小于 16×16 时禁用' },
      { id: 'pin', label: '固定到屏幕', key: '', icon: 'pin', group: 'export' },
      { id: 'save', label: '保存', key: 'Ctrl+S', icon: 'save', group: 'export' },
      { id: 'exportPdf', label: '导出 PDF', key: '', icon: 'print', group: 'export' },
      { id: 'copy', label: '复制', key: 'Enter', icon: 'copy', group: 'export', primary: true },
      { id: 'close', label: '取消', key: 'Esc', icon: 'close', group: 'export' }
    ],

    toolbarOptions: [
      { group: '填充', tools: '矩形 / 椭圆', values: ['空心', '半透明', '实心'], default: '空心' },
      { group: '线型', tools: '矩形 / 椭圆 / 直线 / 箭头', values: ['实线', '虚线', '点线'], default: '实线' },
      { group: '圆角', tools: '矩形', values: ['直角', '圆角 4', '圆角 8'], default: '直角' },
      { group: '箭头', tools: '箭头', values: ['起点', '终点'], default: '终点' },
      { group: '浓度', tools: '高亮', values: ['淡', '中', '浓'], default: '中' },
      { group: '字重', tools: '文字', values: ['粗体'], default: '关闭' }
    ],

    /* ------------------------------------------------------------------ *
     * OCR
     * sampleText / blocks 的文字全部来自本仓库原文（README、语言包），
     * 为「真实的中英混排」；置信度数值是示意值（源码里没有可引用的固定数值）。
     * ------------------------------------------------------------------ */
    ocr: {
      sourceNote: '文字取自 README.md 与 shared/locales/config.js 原文；置信度为示意值。',
      sampleText: [
        'Highlighter 是一款面向 Windows 的桌面截图与划词效率工具。',
        '本地 OCR，可识别中英文等文字内容。',
        '导出 H.264 MP4 文件；当前录制不包含音轨。',
        'PaddleOCR v4 中英'
      ].join('\n'),
      blocks: [
        { text: 'Highlighter 是一款面向 Windows 的桌面截图与划词效率工具。', confidence: 0.97, vertical: false },
        { text: '本地 OCR，可识别中英文等文字内容。', confidence: 0.95, vertical: false },
        { text: '导出 H.264 MP4 文件；当前录制不包含音轨。', confidence: 0.93, vertical: false },
        { text: 'PaddleOCR v4 中英', confidence: 0.99, vertical: false }
      ],
      engine: 'PaddleOCR v4 中英',
      engineBadge: '本地 OCR',
      minConfidence: 0.3,
      summaryTemplates: [
        '识别到 {count} 处文本 · {ms} ms',
        '识别到 {count} 处文本 · 已缓存',
        '原文 {count} 处',
        '已翻译 {count} 处文本',
        '置信度 {value}%'
      ],
      actions: ['纯文本', '复制全部', '查看原文', '查看译文', '关闭识别结果'],
      afterActions: ['显示识别结果', '复制全部文本', '复制文本并关闭截图']
    },

    /* ------------------------------------------------------------------ *
     * 翻译
     * 示例原文/译文取自同一键的 zh-CN 与 en-US 两列，属于产品内真实双语对照。
     * ------------------------------------------------------------------ */
    translate: {
      sourceNote: '源文 = config.usage.subtitle 的 zh-CN 原文；结果 = 同一键的 en-US 原文。',
      direction: '中文→English',
      source: '本机 AI CLI 的 Token 用量；只读日志，仅存计数，不上传任何内容',
      result: 'Token usage from local AI CLIs. Logs are read-only and only counts are stored; nothing is uploaded.',
      placeholderSource: '输入或粘贴要翻译的文本',
      placeholderResult: '翻译结果',
      sourceAuto: '自动检测',
      sourceLanguages: ['自动检测', '中文', '英文', '日文', '韩文'],
      targetLanguages: ['中文', '英文', '日文', '韩文', '繁体中文'],
      actions: ['清空', '翻译', '翻译中…', '复制结果', '译文已复制']
    },

    /* ------------------------------------------------------------------ *
     * AI：两种真实形态（划词助手窗口 / 主窗口 AI 对话）
     * 回答正文为示意（源码只有提示词与外壳），标注在 note 里。
     * ------------------------------------------------------------------ */
    ai: {
      note: '回答正文是示意文本，用于展示排版；真实输出由所配置模型决定。',
      // —— 划词助手（action 窗口）——
      assistant: {
        windowTitle: '划词助手',
        headerTitle: '翻译 | 解释 | 自定义功能名',
        badges: ['翻译', '解释'],
        sourceText: '本地 OCR，可识别中英文等文字内容。',
        loading: ['正在请求 DeepSeek...', '正在翻译...', '正在思考...'],
        reasoningTitle: '思考过程',
        messages: [
          { role: 'user', text: '本地 OCR，可识别中英文等文字内容。' },
          { role: 'assistant', text: '本地 OCR 指文字识别在设备上完成：图片解码、文本框检测和字符识别都由随应用分发的 PaddleOCR v4 模型在本机执行，不走网络。因此截图里的中英文可以在离线状态下被提取，且图片本身不会离开这台电脑。' }
        ],
        followUp: {
          placeholder: '就上面的结果继续追问…',
          hint: '可继续追问（默认 10 轮）；先用「引用选中」，再做多轮追问',
          actions: ['引用选中', '重新生成', '复制对话', '发送', '停止生成']
        },
        conversationFormat: ['【划词原文】', '【翻译】', '【追问 1】', '（已停止生成）', '（无内容）'],
        errors: ['首次请求失败，无法继续追问，请重新划词', '已达到最大追问轮数（{maxTurns}），请重新划词开始新会话', '请求超时，请检查网络后重试', '窗口已隐藏，生成已中断']
      },
      // —— 主窗口 AI 对话 ——
      chat: {
        emptyState: '输入问题开始对话。可在“设置 > 模型”中为 AI 对话选择供应商、模型，并调整 Temperature 与 Token 上限。',
        placeholder: '输入消息，Ctrl+Enter 发送',
        sendLabel: '发送',
        sampleMessages: [
          { role: 'user', text: '帮我把这段说明压缩成一句话。' },
          { role: 'assistant', text: 'Highlighter 把截图、识别、翻译、贴图和录屏收进同一个本地优先的桌面工具里。' }
        ]
      },
      actions: ['发送', '停止生成', '重新生成', '复制对话', '引用选中', '置顶窗口'],
      providers: [
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'openai-chat', models: ['DeepSeek V4 Flash'], builtin: true, enabled: true }
      ],
      codingPlans: ['Open Code Go', 'GLM Coding Plan', 'MiniMax Coding Plan'],
      featureAssignments: ['AI 对话', '翻译工具', '截图 OCR 翻译', '划词翻译', '划词解释']
    },

    /* ------------------------------------------------------------------ *
     * 剪贴板面板
     * 行数据取自 test/clipboard-grid-runtime.test.js 的真实 fixture
     * （sourceDisplayName / previewText 原样），时间按 formatTime 格式展示。
     * ------------------------------------------------------------------ */
    clipboard: {
      sourceNote: '前三行文字取自仓库测试 fixture（WeChat / Chrome / Snipper），时间与大小为示意值。',
      rows: [
        { kind: 'text', app: 'WeChat', time: '10-23 09:41', preview: 'hello world', size: '11 B', pinned: false },
        { kind: 'url', app: 'Chrome', time: '10-23 09:38', preview: 'https://example.com', size: '19 B', pinned: false },
        { kind: 'text', app: 'Highlighter', time: '10-22 21:03', preview: 'Highlighter 是一款面向 Windows 的桌面截图与划词效率工具。', size: '86 B', pinned: true, note: '置顶记录；正文取自 README 首段' },
        { kind: 'image', app: 'Snipper', time: '10-22 21:03', preview: '640 × 360', size: '1.2 KB', pinned: false },
        { kind: 'text', app: 'Chrome', time: '10-22 20:15', preview: '本机 AI CLI 的 Token 用量；只读日志，仅存计数，不上传任何内容', size: '92 B' },
        { kind: 'image', app: 'Snipper', time: '10-22 18:47', preview: '1280 × 720', size: '2.4 KB', pinned: false }
      ],
      kinds: ['全部', '文本', '链接', '图片', '置顶'],
      badges: { text: 'TXT', url: 'URL', image: 'IMG' },
      filters: ['全部', '文本', '链接', '图片'],
      actions: ['复制', '粘贴', '查看全文', '置顶', '取消置顶', '删除', '清空普通记录', '清空全部记录（含置顶）', '暂停记录', '恢复记录', '刷新'],
      status: ['正在记录', '已暂停', '因系统状态暂停', '已关闭', '后台异常', '已停止'],
      copy: {
        title: '剪贴板历史',
        badge: '本地',
        search: '搜索历史文本',
        empty: '暂无匹配记录',
        more: '加载下一页',
        newBanner: '有新记录，点击刷新',
        truncated: '详情仅显示前 64 KiB，复制时保留完整原文。',
        pasteSent: '已发送粘贴，请在目标应用查看。',
        pasteCopiedOnly: '已复制，无法自动粘贴。请在目标输入框手动粘贴。',
        pasteCanceled: '粘贴已取消：剪贴板内容已变化，请重新选择记录。',
        privacy: '历史内容保存在本机普通数据文件中。敏感内容请先暂停，或排除相关应用。',
        description: '本地保存文本、链接和静态图片。关闭后停止采集并保留历史。'
      }
    },

    /* 长截图：文案与状态取自 shared/locales/long-capture.js */
    longCapture: {
      desc: '框选滚动区域，自动采集并拼接；可选纵向或横向，可裁前后边、暂停后继续。',
      directions: ['纵向拼接', '横向拼接'],
      selected: [
        '区域：1280 × 720',
        '方向：纵向',
        '裁前 0 px / 裁后 0 px',
        '状态：匹配成功'
      ],
      stitched: 7,
      metrics: { size: '1280 × 5040', strips: '7 段', confidence: '98%' },
      metricsNote: '尺寸/段数/置信度为示意值；源码只提供格式（如「{count} 段」、置信度百分比）。',
      statuses: [
        '正在准备屏幕采集',
        '已记录起始画面，等待滚动',
        '匹配成功',
        '等待画面滚动',
        '未能匹配，请放慢滚动速度',
        '已暂停',
        '准备就绪',
        '正在生成长截图'
      ],
      actions: ['开始', '暂停', '继续', '选区', '贴图', '保存', '快存', '复制并关闭'],
      empty: '等待开始'
    },

    /* 录屏：文案取自 shared/locales/record.js */
    record: {
      modes: ['5 FPS', '16 FPS', '24 FPS', '30 FPS', '60 FPS'],
      defaultMode: '24 FPS',
      output: 'MP4',
      statuses: ['区域已就绪', '即将开始', '正在录制', '录制已暂停', '录制完成', '正在生成 MP4'],
      controls: [
        { id: 'start', label: '开始', kind: 'primary' },
        { id: 'pause', label: '暂停', kind: 'normal' },
        { id: 'resume', label: '继续', kind: 'normal' },
        { id: 'stop', label: '停止', kind: 'danger' },
        { id: 'cancel', label: '取消录制', kind: 'icon' },
        { id: 'rerecord', label: '重新录制', kind: 'normal' },
        { id: 'saveMp4', label: '保存 MP4', kind: 'primary' }
      ],
      annotationTools: ['指针', '画笔', '矩形', '椭圆', '箭头'],
      annotationStyle: { colors: ['红色', '橙色', '黄色', '绿色', '蓝色', '黑色', '白色'], widths: ['细', '中', '粗'], defaultWidth: '中' },
      audio: {
        sources: ['系统声音', '麦克风'],
        defaults: { system: true, microphone: false },
        notices: [
          '录制包含：系统声音',
          '无法采集声音，本次录制为无声视频',
          '麦克风不可用，本次录制仅包含系统声音',
          '系统声音已中断，本次录制继续但不再包含系统声音'
        ],
        note: 'README 写「当前录制不包含音轨」，但代码里已有系统声音/麦克风采集与混音（设置默认系统声音开启、麦克风关闭），README 该行已过期。'
      },
      preview: { title: '录制预览', progress: '正在生成 MP4 · {percent}%' }
    },

    /* 本地搜索：分类与排序取自 search/search-utils.js，文案取自 shared/locales/search.js */
    search: {
      placeholder: '搜索本地文件（支持 Everything 语法，如 ext:pdf 报告）',
      scopes: ['全部', '文件夹', 'EXCEL', 'WORD', 'PPT', 'PDF', '图片', '视频', '音频', '压缩文件'],
      sorts: ['按修改时间降序', '按修改时间升序', '按名称升序', '按名称降序', '按路径升序', '按路径降序', '按大小升序', '按大小降序'],
      defaultSort: '按修改时间降序',
      status: { detecting: '正在检测 Everything...', ready: 'Everything 已就绪', indexEmpty: '索引暂无内容（可能需要以管理员身份运行 Everything 或安装 Everything 服务）' },
      empty: { prompt: '输入关键字开始搜索', searching: '正在搜索...', none: '没有找到结果' },
      countTemplate: '已加载 {loaded} / 共 {total} 条结果',
      rowActions: ['打开所在目录', '复制路径'],
      // 结果行为本仓库真实文件（名称/路径/大小/修改时间均取自工作区实测）
      sampleResults: [
        { ext: 'MD', name: 'README.md', path: 'F:\\workspace\\Highlighter\\README.md', size: '8.8 KB', time: '2026-10-17 22:20' },
        { ext: 'JSON', name: 'package.json', path: 'F:\\workspace\\Highlighter\\package.json', size: '7.8 KB', time: '2026-10-23 18:33' },
        { ext: 'HTML', name: 'highlighter-full-features.html', path: 'F:\\workspace\\Highlighter\\docs\\architecture\\highlighter-full-features.html', size: '714.4 KB', time: '2026-09-15 19:31' },
        { ext: 'JS', name: 'config.js', path: 'F:\\workspace\\Highlighter\\shared\\locales\\config.js', size: '172.1 KB', time: '2026-10-23 18:33' },
        { ext: 'JS', name: 'capture.js', path: 'F:\\workspace\\Highlighter\\capture\\capture.js', size: '140.4 KB', time: '2026-10-19 22:02' }
      ],
      note: '路径为工作区真实绝对路径；原型里可截断展示。'
    },

    /* 关于页：只有真实可查的许可与链接；根目录没有 LICENSE 文件，故不写版权行 */
    about: {
      tagline: '桌面截图与划词效率工具',
      versionLine: '版本 4.1.2 · win32 · 开发环境',
      intro: '集截图标注、长截图、文字与表格识别、二维码扫描、贴图、历史管理、翻译、AI 对话、录屏、全屏画布、热键和个性化设置于一体。',
      copyright: '未确认：仓库根目录没有 LICENSE / 版权声明文件；package.json 的 author 字段为「Highlighter」。',
      licenses: [
        { name: 'Bootstrap Icons v1.13.1', license: 'MIT', copyright: 'Copyright (c) 2019-2024 The Bootstrap Authors', files: 'capture/icons/LICENSE、toolbar/icons/LICENSE', note: '截图与划词工具栏图标；仅归一化 SVG 外层属性，路径数据未改' },
        { name: 'Index-Translate (bilibili)', license: 'Apache-2.0', copyright: 'bilibili/Index-Translate', files: 'docs/third-party/LICENSE-Index-Translate.txt', note: '本地 OpenAI 兼容中继的改写实现（main/services/translation-proxy-service.js）' },
        { name: 'TokenTracker', license: 'MIT', copyright: 'Copyright (c) 2026 xiufengsun', files: 'docs/third-party/LICENSE-TokenTracker.txt', note: '用量页的日志解析闭包（tokentracker-cli@1.4.7，commit 148b758e）' },
        { name: 'selection-hook', license: 'MIT', copyright: 'Copyright (c) 2025 0xfullex', files: 'vendor/selection-hook/LICENSE', note: '划词取词的原生钩子' }
      ],
      links: [
        { label: '项目主页', url: 'https://github.com/SherUnlocked-4869/Highlighter' },
        { label: '发布页', url: 'https://github.com/SherUnlocked-4869/Highlighter/releases' }
      ],
      updateNote: '软件更新已移至「设置 · 通用 · 软件更新」。'
    },

    /* 托盘菜单：真实的 14 个条目（含分隔与条件项） */
    tray: [
      '截图', '截取全屏', '截取焦点窗口', '固定图片到屏幕', '视频录制', '本地搜索', '剪贴板历史',
      '翻译代理（Index-Translate）', '游戏模式', '取消全部穿透', '显示划词对话', '截图历史', '显示主界面', '退出'
    ],

    /* 运行状态词汇（用于状态栏/徽章/提示） */
    statuses: {
      app: ['未设置', '已配置', '未配置', '已就绪', '启动中', '待启用', '组件缺失', '检测失败'],
      shortcut: ['未设置', '快捷键已启用', '快捷键未能注册', '与“{names}”重复', '与其他应用内快捷键重复', '已被系统或其他应用占用', '快捷键格式无效', '游戏模式已暂停此快捷键'],
      toast: ['设置已保存', '截图已复制', '已复制', '已恢复默认设置', '分类已保存', '界面语言已切换', '正在下载 {percent}%']
    },

    /* 设计 token（shared/tokens.css 原文值，供系统板使用） */
    tokens: {
      light: { bg: '#eeebe4', surface: '#fffefb', surface2: '#f6f3ed', surface3: '#ece8e0', line: '#e2ddd3', line2: '#cdc6ba', ink: '#1b1815', ink2: '#4a453d', muted: '#6d675e', faint: '#9a938a', primary: '#e5a44c', ok: '#2e7d51', warn: '#8a6a1f', danger: '#b8382c' },
      dark: { bg: '#121110', surface: '#1c1a18', surface2: '#242220', surface3: '#2d2a27', line: '#332f2b', line2: '#453f39', ink: '#f1ece4', ink2: '#c6c0b5', muted: '#8c8679', faint: '#67615a', ok: '#63b98a', warn: '#d9a94a', danger: '#e0736a' },
      radius: 8,
      fonts: {
        ui: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
        display: '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
        mono: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'
      },
      annotationColors: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff'],
      annotationWidths: [2, 4, 8]
    }
  }

  // 允许在浏览器脚本里直接读，也允许 node 里 require 做校验
  if (typeof module === 'object' && module.exports) module.exports = HC
  else root.HC = HC
})(typeof globalThis === 'object' ? globalThis : this)
