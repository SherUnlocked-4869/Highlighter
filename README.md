# Highlighter

Highlighter 是一款面向 Windows 的桌面截图与划词效率工具。项目早期的界面组织与部分交互设计受到 Snow Shot 启发，并在此基础上围绕截图、识别、桌面贴图、录屏和文本处理持续扩展。

## 功能概览

### 截图与标注

- 自由框选截图，选区创建后仍可拖动边缘和角点调整大小。
- 支持延迟截图、全屏截图、当前焦点窗口截图和一键复制。
- 支持矩形、椭圆、箭头、直线、画笔、高亮、马赛克、文字和序号标注。
- 可调整标注颜色与线条粗细，并支持撤销、重做。
- 截图完成后可复制到剪贴板、保存到文件或固定到桌面。

### 长截图

- 支持纵向自动滚动采集，也可随时暂停并切换为手动捕获。
- 支持纵向和横向内容拼接；横向截图使用手动捕获。
- 自动识别页面底部，并对固定头尾和小范围动态内容进行容错。
- 可在设置中选择默认拼接方向。

### OCR 与内容识别

- 本地 OCR，可识别中英文等文字内容。
- 表格识别，可将截图恢复为表格并按 TSV、CSV 或 Markdown 格式复制。
- 二维码识别，可复制识别内容或使用系统浏览器打开 HTTP/HTTPS 链接。
- OCR 结果支持继续翻译。

### 屏幕录制

- 框选屏幕区域进行录制。
- 支持暂停、继续、预览和重新录制。
- 录制期间可使用基础标注工具。
- 导出 H.264 MP4 文件；当前录制不包含音轨。

### 桌面贴图与画布

- 将截图或本地图片固定在桌面最前方。
- 支持集中显示或隐藏全部贴图。
- 可从贴图重新进入截图识别或编辑流程。
- 提供白色全屏画布用于临时绘制和演示。

### 截图历史

- 自动记录截图历史并生成缩略图。
- 支持搜索、来源筛选和数量上限。
- 支持批量导出、批量删除及无效记录清理。
- 可从历史记录复制、定位或重新编辑截图。

### 划词工具栏

- 选中文本后显示快捷工具栏。
- 内置复制、搜索、翻译和解释操作。
- 支持调整按钮顺序、关闭不需要的功能及选择搜索引擎。
- 支持自定义 AI 操作和提示词。

### 翻译与 AI

- 提供独立翻译页面，支持自动检测源语言和设置目标语言。
- 提供基于 DeepSeek API 的多轮 AI 对话。
- AI 模型、输出长度、温度和目标语言均可配置。
- API Key 在系统加密能力可用时使用 Electron 安全存储保护。

### 个性化与系统设置

- 支持跟随系统、浅色和深色主题。
- 可调整主色、圆角、紧凑布局、背景皮肤和自定义 CSS。
- 所有主要功能均可配置全局快捷键，并会提示快捷键冲突。
- 支持开机启动、系统托盘和运行日志。
- 支持自定义软件数据目录、截图导出目录和截图历史目录。

## 系统要求

### 使用安装包

- Windows 10 或 Windows 11
- x64 处理器

OCR 模型、Electron 运行时和所需原生组件会随正式安装包一起提供。

### 本地开发

- Windows 10 或 Windows 11 x64
- 当前 Node.js LTS 与 npm
- Rust 工具链及 Cargo，用于构建 OCR 辅助进程
- Windows 64 位 .NET Framework C# 编译器，用于构建智能选区组件

## 安装

从项目的 [Releases](https://github.com/SherUnlocked-4869/Highlighter/releases) 页面下载：

- `Highlighter-Setup-<版本号>.exe`：NSIS 安装程序，支持选择安装目录。
- `Highlighter-<版本号>-portable.exe`：便携版本，无需安装。

相同架构和安装范围下，新版安装程序通常可以直接覆盖升级。升级前建议退出正在运行的 Highlighter。

## 快速开始

1. 启动 Highlighter，打开“热键设置”页面。
2. 为截图、OCR、长截图、录屏等常用功能录入全局快捷键。
3. 触发截图后拖动鼠标创建选区；选区完成后可继续调整边缘或角点。
4. 使用截图工具栏进行标注、识别、复制、保存或贴图。
5. 如需 AI 翻译、解释和对话，在“功能设置”中填写 DeepSeek API Key。

## 数据与隐私

- 截图、历史记录、运行日志和缓存默认保存在应用数据目录。
- 可在“系统设置 → 软件数据”中更改数据目录。应用会迁移配置、日志和目录内的截图历史，缓存则会重新创建。
- OCR 和二维码识别在本地执行。
- 只有使用 AI 对话、AI 翻译、解释或自定义 AI 功能时，相关文本才会发送到配置的 DeepSeek 服务。
- 更改数据目录或升级应用前，请先结束正在进行的截图、OCR、长截图和录屏任务。

## 开发

安装依赖：

```powershell
npm install
```

启动应用：

```powershell
npm start
```

`npm start` 会先构建智能选区和 OCR 原生组件，然后启动 Electron。

运行测试和语法检查：

```powershell
npm test
npm run check
```

## 构建 Windows 安装包

使用项目已经安装的本地 Electron，并跳过 Windows 代码签名：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run build:win -- --config.electronDist=node_modules/electron/dist
```

生成的 NSIS 安装包位于 `dist` 目录。

构建便携版本：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run build:win:portable -- --config.electronDist=node_modules/electron/dist
```

## 项目结构

```text
Highlighter/
├─ capture/          截图选择、标注和截图工具栏
├─ long-capture/     长截图采集、选区与拼接控制
├─ recognition/      表格和二维码识别结果窗口
├─ record/           区域录屏、预览和录制标注
├─ pin/              桌面贴图
├─ toolbar/          划词工具栏
├─ config/           主界面和设置页面
├─ main/             主进程服务与 IPC 模块
├─ native/           智能选区及本地 OCR 组件
├─ ocr/models/       OCR 模型
├─ test/             Node.js 自动化测试
└─ dist/             本地构建产物
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm start` | 构建原生组件并启动应用 |
| `npm test` | 运行自动化测试 |
| `npm run check` | 检查 JavaScript 语法 |
| `npm run build:native` | 重新构建全部原生组件 |
| `npm run build:win` | 构建 Windows NSIS 安装包 |
| `npm run build:win:portable` | 构建 Windows 便携版本 |

## 反馈与贡献

如需报告问题或提出功能建议，请在 [GitHub Issues](https://github.com/SherUnlocked-4869/Highlighter/issues) 中提交，并尽量附上：

- Highlighter 版本和 Windows 版本
- 问题复现步骤
- 预期行为与实际行为
- 必要的截图或运行日志
