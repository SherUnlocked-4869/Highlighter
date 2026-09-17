# Highlighter · 整套 UI 语言重设计

> 交付形态：高保真可交互 HTML 原型（单文件自包含，双击即开）
> 分支：`design/ui-language-redesign`
> 入口：双击 `design-demos/index.html`，用 `1` `2` `3` 或点标签切换三个方向

## 先看这个

| 文件 | 内容 |
|------|------|
| `index.html` | **对比壳**：三方向并排切换，含每个方向的定位/签名细节/主色说明 |
| `a-instrument.html` | 方向 A · 仪器（工业信号橙） |
| `b-editorial.html` | 方向 B · 朱批（编辑排版朱砂） |
| `c-nightshift.html` | 方向 C · 夜航（暖炭灰琥珀暗色） |

每个方向都是**自包含单文件**：45 个图标以 base64 内联，字体走 Google Fonts CDN，无本地依赖、无跨域脚本、双击可开。

## 为什么重跑一轮

上一轮（commit `b96b64c`）的三版原型留在 `design-demos/` 下，但存在一个**致命且不易察觉的缺陷**：

所有图标都用 CSS `mask: url('./assets/icons/x.svg')` 引用外部 SVG。页面通过 `file://` 打开时 origin 为 `null`，浏览器按跨域处理并拦截，**图标全部静默消失**——不是变小或错位，而是整列空白。实测每页 76–88 条 console 报错、19–22 个 mask 请求失败。

这在本机用截图看不会发现（截图工具同样走 file://），但用户双击打开时看到的就是没有图标的界面。新版把图标全部内联为 data URI 解决，`design-demos/tools/audit.mjs` 会持续守住这条。

另外上一轮还有两处布局问题：`designer-teenage-engineering.html` 的「SHOT/AI/TRANSLATE」标签条溢出到侧边栏之上，`roulette-white-gallery.html` 的主窗口在 1000px 视口下被裁掉底部。新版三版都在 1600×1000 下完整可读。

## 三个方向

三个方向共用**同一份内容模型**（`src/content.js`，文案取自 `config/config.js` 等真实源码），所以横向对比时差异全部来自设计，而不是内容。

### A · 仪器 INSTRUMENT
把 Highlighter 当一台桌面精密仪器。暖灰机身 + 单信号橙 `#ff4d00`；IBM Plex Mono 承担所有标签、数值与按键，Plex Sans + Noto Sans SC 承担正文；面板网格底纹。
**签名细节**：快捷键渲染成有物理厚度的键帽（2px 下唇 + 悬停位移），未设置的显示为虚线槽位。
**为什么**：工具型产品最需要一眼定位，等宽标签让 11 项功能像仪表盘一样可扫读。

### B · 朱批 EDITORIAL
纸白 + 朱砂 `#a8331f`，容器消失。只靠发丝线和字阶划分，不用阴影堆叠、不用卡片边框；标题用衬线（Source Serif 4 / Noto Serif SC）。
**签名细节**：功能清单做成书籍目录索引——名称 + 点线引导 + 右对齐快捷键。
**为什么**：每天开合几十次的工具，最好的界面是几乎不存在的界面；识别结果用衬线排版读起来像校对好的文稿。

### C · 夜航 NIGHTSHIFT
暖炭灰 + 琥珀 `#e5a44c`，暗色为默认。用**表面明度台阶**（bg → surface → surface-2 → surface-3）造深度，不用发光边框。
**签名细节**：状态轨把「智能感」摊开给你看——OCR 本地执行 / 当前模型 / 热键配置度 9/13 / Everything 状态。
**为什么**：截图与 OCR 是深夜高频工作，暗色是主场景；状态轨让用户随时知道系统正在用什么能力。
**注意**：刻意避开「深蓝底 `#0D1117` + 青紫霓虹 glow」这一种 SaaS 烂大街暗色组合。

## 品牌色怎么处理

原 tokens 是 `#1677ff`（Ant 蓝）+ Segoe UI + 品牌紫 `#8b5cf6`。本轮按「允许探索新视觉方向」处理，三个方向都**没有沿用**这两色：

- 主色 `#1677ff` 全部废弃——它是「通用 Ant 感」的主要来源，配色板里不再出现蓝色。
- 品牌紫 `#8b5cf6` 也废弃——它原本只出现在 High*lighter* 一词上，与主色打架。三个方向改为各自建立**单一强调色**，并统一规则：**强调色只用于选中态与主操作**，不做装饰。
- 品牌识别改由「字标 + 强调色 + 签名细节」承担，而不是靠一个蓝色主色。`High` + `lighter`（后半着色）的字标结构在三版都保留。

紫色渐变、emoji 图标、圆角卡 + 左彩条这三类 slop 在三版中均为零。

## 验证

三版都跑过真实浏览器验证，脚本留在 `tools/` 下可复跑：

```bash
node design-demos/tools/build.mjs      # 从 src/ 生成三版单文件（内联图标 + 内容模型）
node design-demos/tools/audit.mjs      # 渲染 + 截图 + 检查 console 错误 / 图标缺失 / 溢出
node design-demos/tools/interact.mjs   # 45 项交互断言
```

`interact.mjs` 每个方向跑 15 项：Tab 切换真的换内容、侧栏切到热键路由、搜索过滤、分类芯片、**主题切换真的改变计算后的背景色并能切回**、开关切换、所有图标盒子有尺寸、无未裁剪元素溢出、文档无横向滚动、console 无报错。当前 **45/45 通过**。

## 目录结构

```
design-demos/
├── index.html                  对比壳
├── a-instrument.html           方向 A（生成物）
├── b-editorial.html            方向 B（生成物）
├── c-nightshift.html           方向 C（生成物）
├── src/
│   ├── content.js              共用内容模型（真实产品文案）
│   ├── a-instrument.html       方向 A 源文件
│   ├── b-editorial.html        方向 B 源文件
│   └── c-nightshift.html       方向 C 源文件
├── assets/icons/               45 个 SVG（被 build 内联）
├── shots/                      渲染截图
└── tools/
    ├── build.mjs               生成器
    ├── audit.mjs               渲染检查
    └── interact.mjs            交互测试
```

**改设计要改 `src/` 下的源文件，然后重跑 `build.mjs`**——直接改根目录的生成物会在下次构建时被覆盖。

## 下一步

三个方向是**并列候选，不是成品**。选定一个（或混搭，例如「A 的键帽 + C 的配色」）之后再进主干实现：把这套 tokens 落到 `shared/tokens.css`，再逐个改造 `config.css` / `search.css` / `recognition.css` / `action.css` / `pin.css`。本轮未改动任何生产代码。
