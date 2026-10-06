# 工具栏图标替换清单（**已复核通过，已实施**）

> 实施细节见 [设计文档](2026-10-06-toolbar-icon-replacement-design.md)，落地结果见 [验证报告](2026-10-06-toolbar-icon-replacement-verification.md)。
> 复核用视觉稿：[2026-10-06-toolbar-icon-replacement-preview.png](2026-10-06-toolbar-icon-replacement-preview.png)

- **图标来源**：`F:\aitools\素材\icons` = **bootstrap-icons v1.13.1**（2078 个 SVG，MIT 协议）
- **现状**
  - 截图工具栏：23 个自绘 **IconPark 风格**线性图标（`viewBox 0 0 48 48`，`stroke-width 4`）
  - 划词工具栏：**没有图标文件**，直接渲染文字符号（`⧉ ⌕ 译 ? ⇗ ✦`）
- **目标**：两个工具栏统一为 bootstrap-icons 的 16×16 矢量图标
- **状态**：仅清单，**未替换任何文件**

---

## 1. 统一规则（建议）

| 项 | 规则 | 理由 |
| --- | --- | --- |
| 渲染方式 | 沿用现有 **CSS mask + `background: currentColor`**（`capture.css` 的 `.toolbar-icon`、`config.css` 的 `.svg-icon`） | 工程里已验证可用；颜色自动跟随主题与 `--primary-ink` 反色，无需引入字体、无 CSP 风险 |
| 文件规格 | `viewBox="0 0 16 16"`、`fill="#000"`，删掉 `width/height/class` | mask 只取 alpha 通道；去掉 `currentColor` 避免外部 SVG 无继承色时的歧义 |
| 文件名 | **能对应的保持原名**（`copy.svg`、`table.svg`…）直接替换内容 | `config/config.js` 的快捷功能列表、`config/config.html` 标题栏都引用 `../capture/icons/*.svg`，改内容即自动同步 |
| 冲突处理 | 只有 `line.svg` 有冲突（见 §3 注 ①），新增 `line-tool.svg` | 最小改动面 |
| 划词工具栏 | 新建 `toolbar/icons/` 放 6 个 SVG；`toolbar.js` 由 `textContent` 改为 `<span class="toolbar-icon">` + `<span>标签</span>` | 与截图工具栏 DOM 结构对齐 |

---

## 2. 划词工具栏（`toolbar/toolbar-action-meta.js`）

| 顺序 | 功能 | id | 现状符号 | 建议图标 | 备选 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 复制 | `copy` | `⧉` | `bi-copy` | — | 语义完全对应；这是唯一的主色按钮 |
| 2 | 搜索 | `search` | `⌕` | `bi-search` | — | 标准放大镜 |
| 3 | 翻译 | `translate` | `译` | `bi-translate` | — | 汉字"译"与其它符号字重/基线不统一 |
| 4 | 解释 | `explain` | `?` | `bi-lightbulb` | `bi-question-circle` | `?` 在深色底上过小；灯泡=讲解/理解 |
| 5 | 跳转 | `open` | `⇗` | `bi-box-arrow-up-right` | `bi-link-45deg` | 外链 / 新窗口打开的标准符号 |
| 6 | 自定义 AI 功能 | `custom:*` | `✦` | `bi-stars` | `bi-magic` | 保留"闪光"语义升级为矢量图标（现在由 `toolbar-utils.js` 硬编码 `✦`） |

---

## 3. 截图工具栏（`capture/capture.html` + `capture/icons/`）

### 3.1 标注工具（11 个）

| 功能 | id | 现状文件 | 建议图标 | 备选 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 选择/调整 | `select` | `select.svg` | `bi-cursor` | `bi-arrows-move` | 指针=选择模式；若更强调"拖动调整选区"可选 4 向箭头 |
| 矩形 | `rect` | `rect.svg` | `bi-square` | `bi-bounding-box` | 空心方框 |
| 椭圆 | `ellipse` | `ellipse.svg` | `bi-circle` | — | 空心圆 |
| 箭头 | `arrow` | `arrow.svg` | `bi-arrow-up-right` | — | 斜箭头，与实际绘制方向一致 |
| 直线 | `line` | `line.svg` | `bi-slash-lg` → **新文件 `line-tool.svg`** | `bi-dash-lg` | ① 见下方说明 |
| 画笔 | `pen` | `pen.svg` | `bi-pencil` | `bi-brush` | 铅笔=自由绘制 |
| 高亮 | `highlight` | `highlight.svg` | `bi-highlighter` | — | 荧光笔，语义完全对应 |
| 马赛克 | `blur` | `mosaic.svg` | `bi-grid-3x3-gap` | `bi-border-all` | 九宫格=像素化；刻意不用 `bi-grid-3x3`，避免与"表格识别"撞脸 |
| 文字 | `text` | `text.svg` | `bi-fonts`（T） | `bi-type`（Aa） | 经典文字工具字形 |
| 序号 | `serial` | `serial.svg` | `bi-123` | `bi-list-ol` | 直接表达自动递增序号 |
| 水印 | `watermark` | `watermark.svg` | `bi-droplet-half` | `bi-water` | 水滴=水印 |

> **注 ① `line.svg` 冲突**：该文件现在**同时**被 `config/config.html` 的标题栏"最小化"按钮使用（`../capture/icons/line.svg`）。
> 若把它换成正斜线，最小化按钮会变成一条斜杠。建议：**`line.svg` 保持不动**，"直线"工具改用新文件 `line-tool.svg`。
> 代价：`test/capture-toolbar-icons.test.js` 的期望列表里把 `'line'` 换成 `'line-tool'`。

### 3.2 历史（2 个）

| 功能 | id | 现状文件 | 建议图标 | 备选 |
| --- | --- | --- | --- | --- |
| 撤销 | `undo` | `undo.svg` | `bi-arrow-counterclockwise` | `bi-arrow-return-left` |
| 重做 | `redo` | `redo.svg` | `bi-arrow-clockwise` | — |

### 3.3 输出与识别（10 个）

| 功能 | id | 现状文件 | 建议图标 | 备选 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 长截图 | `longCapture` | `long-capture.svg` | `bi-arrows-vertical`（↕） | `bi-arrow-bar-down` | ② 见下方说明 |
| 二维码识别 | `qr` | `qr.svg` | `bi-qr-code-scan` | `bi-qr-code` | 带扫描线，比静态二维码更准确 |
| 表格识别 | `table` | `table.svg` | `bi-table` | — | 语义完全对应 |
| 文本识别 | `ocr` | `ocr.svg` | `bi-card-text` | `bi-file-text` | 刻意与"文字"工具的 `bi-fonts` 区分开 |
| 识别并翻译 | `translate` | `translate.svg` | `bi-translate` | — | 与划词工具栏统一 |
| 区域录制 | `record` | `record.svg` | `bi-record-circle` | `bi-camera-video` | 录制圆点 |
| 固定到屏幕 | `pin` | `pin.svg` | `bi-pin-angle` | `bi-pin-angle-fill` | 图钉，语义完全对应 |
| 保存 | `save` | `save.svg` | `bi-download` | `bi-save` / `bi-floppy` | 导出到磁盘；软盘图标偏传统 |
| 复制 | `copy` | `copy.svg` | `bi-clipboard-check` | `bi-clipboard` | 主按钮，兼任"完成并复制" |
| 取消 | `close` | `close.svg` | `bi-x-lg` | — | ③ 见下方说明 |

> **注 ② 长截图**：原本想用 `bi-arrows-expand-vertical`，实测该图标是 **←｜→ 横向**（bootstrap 命名与实际相反），已排除。改用 ↕ 的 `bi-arrows-vertical`。
>
> **注 ③ `close.svg` 复用面**：该文件还被 `config/config.html` 标题栏"关闭"和 `config/config.js` 模型行"删除"按钮使用。
> 换成 `bi-x-lg` 后这三处会一起统一——**这是期望效果**，但请确认你接受。

---

## 4. 可选统一项（不在两个工具栏内，默认**不动**）

| 位置 | 现状 | 建议 | 说明 |
| --- | --- | --- | --- |
| `resultPanel` 关闭 | 文字 `×` | `bi-x-lg` | 可与工具栏取消按钮统一 |
| `ocrResultBar` 关闭 | 文字 `×` | `bi-x-lg` | 同上 |
| 颜色选择（截图工具栏） | 色块圆点 | **不变** | 需要显示真实颜色，换成调色盘图标反而丢信息 |
| 线宽 细/中/粗（截图工具栏） | 文字 | **不变** | 文字比图标更直观；三档用图标无法区分轻重 |

---

## 5. 配套代码改动（确认后才执行）

| 文件 | 改动 |
| --- | --- |
| `capture/icons/*.svg` | 替换 **22** 个图标内容，新增 `line-tool.svg`（`line.svg` 保持不动） |
| `capture/capture.html` | `--icon:url('icons/line.svg')` → `icons/line-tool.svg`（第 23 行）；面板 `×` 若采纳 §4 一并改 |
| `toolbar/icons/*.svg` | **新增** 6 个：`copy / search / translate / lightbulb / box-arrow-up-right / stars` |
| `toolbar/toolbar.js` | 按钮由 `textContent` 改为 `图标 span + 标签 span` 结构 |
| `toolbar/toolbar.html` | 新增 `.toolbar .toolbar-icon` 的 mask 样式（对齐 `capture.css`） |
| `toolbar/toolbar-action-meta.js` | `icon` 字段由符号改为图标文件名（或删掉，由 id 直接映射） |
| `toolbar/toolbar-utils.js` | 自定义动作的硬编码 `icon: '✦'` → `stars` |
| `test/capture-toolbar-icons.test.js` | 期望列表 `'line'` → `'line-tool'` |
| `config/**` | **无需改动**（文件名保持后自动同步） |

---

## 6. 风险点

1. **划词工具栏宽度会变**：`toolbar-utils.js` 的 `getToolbarWidth()` 按"文字符号 + 标签字数"估算窗口宽度（`42 + 字数*14`），换成 18px 图标后需要把基数调大（约 `+23px`）。该值是 frameless 窗口的**精确宽度**，估算偏小会导致按钮被裁切、标签截断——必须同步修改并实测。
2. **划词工具栏 CSP**：`toolbar.html` 为 `default-src 'none'`，mask 图片走 `img-src 'self'`。截图窗口已是同样配置且工作正常，风险低，但需实测一次。
3. **视觉风格混搭**：替换后两个工具栏是 bootstrap 填充风格，而 `config/icons/` 侧边栏仍是 IconPark 线性风格。若希望全局统一，需要另开一轮（不在本次范围）。
4. **18px 下的辨识度**：bootstrap-icons 原生 16px，放大到 18px 渲染正常；`bi-grid-3x3-gap` 这类密集图形在小尺寸下略"糊"，已在预览图中核对。

---

## 7. 验证方式（执行后）

```powershell
npm test                                   # 含 capture-toolbar-icons / config-icon-contract
node .tmp/icon-review/build-preview.js     # 复核稿
```

- 单元测试：`node --test test/capture-toolbar-icons.test.js test/config-icon-contract.test.js`
- 人工实测：截一次图看工具栏、选中一段文字看划词工具栏，重点看**图标是否清晰**与**划词工具栏有没有被裁切**。
