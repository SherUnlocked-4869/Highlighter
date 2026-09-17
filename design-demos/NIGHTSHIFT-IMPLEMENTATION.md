# Nightshift · UI 语言落地说明

> 方向 C「夜航」从设计原型落地到生产代码的记录。
> 起点：`design-demos/c-nightshift.html`（三方向对比中的 C）
> 分支：`design/ui-language-redesign`

## 一句话

把三版原型里选定的方向 C，落成 `shared/tokens.css` 里一套**单一来源**的设计 token，并让全部 11 个渲染窗口消费它，而不是各自维护私有配色。

## 核心机制

### 1. `shared/tokens.css` 是唯一色板来源

window 样式表**不再声明** `--bg` / `--primary` 等颜色，只做布局与组件结构。任何页面引用这些变量前必须先 link `tokens.css`（有测试守）。

### 2. 表面明度台阶代替边框与发光

深度用四级台阶表达：`--bg` → `--surface` → `--surface-2` → `--surface-3`。

### 3. 强调色只有一个，且是可配置的

`--primary` 由用户设置（`settings.mainColor`）在运行时以内联样式覆写到 `<html>` 上。因此：

- **`--primary` 绝不在 `body.dark` 里重新声明**——那会静默忽略用户选的颜色。有测试守。
- 由它派生的两个 token 让任意用户色都可读：
  - `--primary-ink`：实心强调色**上面**的文字色，按 oklch 亮度阈值 0.54 在黑/白之间选。
  - `--primary-text`：强调色**作为文字**时的颜色，用 `min()/max()` 只调亮度、保色相。

**关于阈值的诚实说明**：0.54 是**实测最优**。扫 1008 个色相/亮度组合，没有其他阈值能把最坏情况抬高。下限约 3.8:1——因为极高饱和的中间调（如 `oklch(0.55 0.22 330)`）无论配黑还是白都到不了 4.5:1，这是色彩空间的性质，不是公式没写好。所有常见品牌色（含原 `#1677ff`、品牌紫 `#8b5cf6`）实测都过 4.5:1。

### 4. 规则「含 var() 的自定义属性只在其声明处解析一次」

所以**每个派生 token 和别名都在 `:root` 与 `body.dark` 各声明一遍**，否则浅色值会渗进深色模式。有测试守。

### 5. 别名避免大规模重写

各窗口历史上用不同的名字声明同一批颜色。与其改写数百条规则，`--panel` / `--text` / `--border` / `--text-dim` / `--panel-soft` / `--surface-hover` / `--surface-active` 等旧名**别名到新台阶**上。新规则请用规范名。

## 品牌处理

- 主色 `#1677ff` 废弃：它是「通用 Ant 感」的主因，色板里不再出现蓝色。
- 品牌紫 `#8b5cf6` 废弃：它原本只出现在 High*lighter* 一词上，与主色打架。
- 识别度改由**字标 + 单一强调色 + 签名细节**承担。`High`+`lighter`（后半着色）结构保留。
- 默认强调色改为琥珀 `#e5a44c`（`main.js` 的 `mainColor` 默认值），用户仍可在「外观配色」里改。

## 签名细节：状态轨

主配置窗口标题栏下方一条 34px 状态轨，只在 home / 热键 / 模型 / 功能设置 四个路由显示，读出：识别引擎、当前模型、热键配置度、Everything 状态。把「智能感」摊开，而不是藏在四个设置页里。数据源全部容错降级，绝不阻塞渲染。

## 浮层为什么保持暗色

截图工具条、录制 HUD、长截图面板与选区浮层**始终是暗色**，不跟随主题——它们浮在任意屏幕内容之上，浅色面板压在浅色文档上不可读。但它们仍消费共享的强调色、圆角与字体，所以不会与主界面脱节。

## 顺手修掉的问题

| 问题 | 处理 |
|------|------|
| 模型页删除按钮用 `🗑` emoji 作图标 | 换成 `close.svg` mask 图标 |
| 空状态用 `content:"🗂"` emoji | 换成 `folder-open.svg` mask 图标 |
| `⚠` / `↗` / `↕` / `↔` / `▶` 等 Extended_Pictographic 字符 | Windows 会替换成彩色 emoji 字体。换成 `▸`/`▾`/`⇗`/`⇕`/`⇔` 等纯文本字形 |
| 划词助手用 `🌐`/`📌`/`💡`/`🧠` emoji | 该窗口 CSP 为 `img-src 'none'`，无法用 mask 图标 → 改为内联 SVG |
| 识别结果窗口硬编码深色板，永远不跟随主题 | 改为消费 token + 跟随主题 |
| 历史页四个统计卡各带彩色渐变顶条（2020 dashboard slop） | 改为单一边框内用 1px 分割的仪表条 |
| 长截图「开始」「复制」按钮透明（页面没 link tokens.css） | 补 link；加测试防止复发 |
| 原生 range/checkbox 保持系统默认蓝（第二个强调色） | `accent-color:var(--primary)` |
| 工具条外阴影被无边框窗口裁切 | 改回 inset 阴影（窗口尺寸恰好等于元素） |

## 验证

```bash
npm test                                                    # 502 通过
npx playwright test --config playwright.config.js           # 5 通过（真实 Electron 端到端）
npm run check                                               # 语法 + 架构检查

node design-demos/tools/token-check.mjs                     # token 契约 + 对比度实测
node_modules/electron/dist/electron.exe design-demos/tools/capture-electron.js   # 34 个界面截图 + 错误/溢出检查
node_modules/electron/dist/electron.exe design-demos/tools/check-nav.js          # 8 条路由的 active 状态
```

`test/design-tokens.test.js` 现在守着这些契约：色板变量、深浅两套派生声明、`--primary` 不得在深色重复声明、窗口样式表不得硬编码色值、引用 token 的页面必须 link、**CSS/HTML 里引用的图标必须真实存在**、不得用 emoji 作图标、默认强调色与设计系统一致。

## 关于截图工具

`design-demos/tools/capture-electron.js` 从**真实 Electron 渲染器**截图，不是 mock。两个踩过的坑已写进注释：

1. **不能用纯 Chromium 验图标**。`file://` 下纯 Chromium 视每个文件为 origin `null`，CSS mask 图标会被当跨域拦掉。Electron 的 `file://` 正常解析。用 Chromium 测会报出一堆**并不存在**的图标失败（这正是为什么上一轮误判过图标问题）。
2. **必须在截图前冻结 CSS 过渡**。隐藏窗口出帧很慢，0.13s 的过渡可能还停在起始值，会拍出「侧栏高亮慢一拍」这种**假象**。`*{transition:none}` 之后每次截图都确定。

窗口以 `show:false` 创建、用 `capturePage()` 取图，**不会在用户屏幕上弹出任何东西**（本工作区只有一块屏，AGENTS.md 要求保持主屏干净）。

## 勘误：没有改的东西

- 没有改任何业务流程、IPC 契约或数据结构。
- `settings.mainColor` 仍是用户可配置项，只是默认值变了。
- 皮肤（`skinPath`）、紧凑模式、圆角滑块等个性化能力全部保留。
