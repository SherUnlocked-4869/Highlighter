# 设计文档：划词工具栏与截图工具栏的图标替换（bootstrap-icons）

- 日期：2026-10-06
- 基线：`master` @ `4203c85`（`package.json` 版本 2.3.0）
- 状态：**已实施**（见[验证报告](2026-10-06-toolbar-icon-replacement-verification.md)）；源码树 + 无头渲染验证完成，真机观感待确认
- 范围：划词工具栏的 6 个文字符号 + 截图工具栏的 23 个自绘图标 → 统一为 bootstrap-icons v1.13.1
- 图标来源：`F:\aitools\素材\icons`（bootstrap-icons 1.13.1，MIT），从本机逐个拷贝，不联网
- 影响面：`toolbar/`（4 个文件改动 + 新增 `toolbar/icons/`）、`capture/icons/`（22 替换 + 1 新增）、`capture/capture.html`、`capture/capture.css`、`config/config.js`、`config/config.css`、`action/action.js`、`preload-action.js`、`test/`（4 个既有测试 + 1 个新增）。**不触碰** `config/icons/` 侧边栏图标，以及截图/标注/录制/贴图/长截图的业务链路
- 关联：清单 [2026-10-06-toolbar-icon-replacement-checklist.md](2026-10-06-toolbar-icon-replacement-checklist.md) · 视觉稿 [2026-10-06-toolbar-icon-replacement-preview.png](2026-10-06-toolbar-icon-replacement-preview.png)

---

## 1. 目标与非目标

### 1.1 目标

1. 划词工具栏的 6 个文字符号（`⧉ ⌕ 译 ? ⇗ ✦`）换成矢量图标——汉字与符号混排的字重、基线、字号在不同 Windows 字体版本下不一致。
2. 截图工具栏的 23 个自绘 IconPark 图标（48×48 线性）换成统一风格的 16×16 填充图标。
3. 两个工具栏与设置页、快捷功能列表保持一致，不再出现"同一功能两种图标"。

### 1.2 非目标

- 不改 `config/icons/` 侧边栏图标（仍是 IconPark 线性风格，属另一个范围）。
- 不改 `action/`（划词助手结果窗）的内联 SVG 图标集——该窗口 CSP 是 `img-src 'none'`，**物理上无法使用 mask 图标**（见 §4.3）。
- 不改截图工具栏的颜色选择（色块）与线宽"细/中/粗"（文字）。
- 不引入图标字体（`font/bootstrap-icons.woff2`）——现有 mask 方案已能覆盖，且字体方案会新增一个 100KB+ 二进制资源与额外的 `@font-face` CSP 面。

---

## 2. 决策一览

### 2.1 已确认（用户第 2 轮回复）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | `line.svg` 与 config 标题栏"最小化"按钮冲突 | **`line.svg` 保持不动**，"直线"工具新增 `line-tool.svg` |
| 2 | `close.svg` 换成 `bi-x-lg` 会连带统一 config 标题栏"关闭"与模型行"删除" | **接受**该连带效果 |
| 3 | `bi-arrows-expand-vertical` 实为横向图标 | **改用 `bi-arrows-vertical`**（↕） |

### 2.2 本设计新引入的决定（请一并确认）

| # | 决定 | 原因 | 影响 |
| --- | --- | --- | --- |
| A | `icon` 字段的语义从「显示用字符」改为「图标资产名」 | 三个渲染点必须能各自拼出路径 | 见 §6，影响 5 个文件 |
| B | 设置页「划词工具」排序列表的图标**同步换成 SVG** | 该处直接渲染 `info.icon` 文本；不换会显示字面量 `copy` | `config/config.js` + `config/config.css` |
| C | 划词助手结果窗的"自定义功能"头部由文字 `✦` 改为内联 SVG 闪光 | 同上，`action.js` 有一处 `textContent = data.icon` | 视觉微调，功能不变 |
| D | 图标盒尺寸：截图工具栏 18px → **17px**，划词工具栏 **15px** | 实测 bootstrap 图标墨迹占比 87.5%，IconPark 为 80%，同尺寸会大 10% | 见 §4.2 实测数据 |

---

## 3. 图标资产规范

### 3.1 来源与许可

- 全部图标逐个从本机 `F:\aitools\素材\icons\icons\*.svg` 拷贝，**不联网**。
- bootstrap-icons 为 **MIT** 协议。拷贝进仓库属"再分发"，需保留版权声明：新增 `toolbar/icons/LICENSE` 与 `capture/icons/LICENSE`（内容为 bootstrap-icons 的 MIT 声明 + 版本号 1.13.1），并在 `README.md` 补一行第三方资源说明。

### 3.2 文件规格（归一化规则）

源文件形如：

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-copy" viewBox="0 0 16 16">
  <path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8…"/>
</svg>
```

归一化为单行：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000"><path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8…"/></svg>
```

| 规则 | 理由 |
| --- | --- |
| 删 `width` / `height` / `class` | 尺寸由 CSS 盒决定，`class` 是 bootstrap 的，无意义 |
| 保留 `viewBox="0 0 16 16"` | `mask: center/contain` 依赖它做等比缩放 |
| `fill="currentColor"` → `fill="#000"` | mask 取 **alpha 通道**；外部 SVG 图片没有宿主文档的 `color` 可继承，写死不透明色可消除歧义 |
| 单行输出 | 与 `capture/icons/` 现有文件一致（现有文件都是单行） |
| `path` 数据**原样保留** | 不手改路径，避免破坏形状与许可完整性 |

### 3.3 落地位置

| 目录 | 内容 | 数量 |
| --- | --- | --- |
| `capture/icons/` | 就地替换 22 个；`line.svg` **不动**；新增 `line-tool.svg` | 收尾共 24 个文件 |
| `toolbar/icons/` | **新建**，放划词工具栏的 6 个：`copy / search / translate / lightbulb / box-arrow-up-right / stars` | 6 个 |

打包配置 `package.json > build.files` 已包含 `toolbar/**/*` 与 `capture/**/*`，**无需修改**。

---

## 4. 渲染契约

### 4.1 方案：CSS mask + `background: currentColor`

工程里已有两处同款实现，直接复用：

```css
/* capture/capture.css:94（现状，不改） */
.toolbar-icon { display: block; width: 18px; height: 18px; background: currentColor;
  -webkit-mask: var(--icon) center/contain no-repeat; mask: var(--icon) center/contain no-repeat; }

/* config/config.css:389（现状，不改） */
.svg-icon{display:inline-block;width:20px;height:20px;flex:0 0 auto;background:currentColor;
  -webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}
```

调用方只提供 `--icon:url('...svg')`。颜色自动跟随 `currentColor`，因此：

- 深/浅色主题切换无需额外规则；
- 划词工具栏的**主色复制按钮**（`.pri`，`color: var(--primary-ink)`）图标自动变成反色墨，不会出现"白底白图标"。

### 4.2 尺寸（实测依据）

用 Playwright 把每个图标渲染到 100px 盒，统计非透明像素包围盒：

| 指标 | 现有 IconPark（48 viewBox） | bootstrap-icons（16 viewBox） |
| --- | --- | --- |
| 墨迹宽占自身 viewBox | **0.800** | **0.875** |
| 墨迹高占自身 viewBox | 0.775 | 0.880 |
| 18px 盒实际墨迹 | 14.4px | 15.8px（+10%） |

结论：

- 截图工具栏图标盒 **18px → 17px**（墨迹 14.9px，与原 14.4px 基本一致，条带节奏不变）。若偏好更醒目，可保留 18px。
- 划词工具栏用 **15px**（墨迹 13.1px，与 12px 中文标签搭配正常）。

### 4.3 不适用 mask 的窗口

`action/action.html` 的 CSP 是 `default-src 'none'; img-src 'none'`，**mask 图标会被拦截**（该文件里已有注释说明这一点）。因此结果窗继续使用内联 SVG，见 §6.9。

---

## 5. 图标映射表（最终）

### 5.1 划词工具栏

| 顺序 | 功能 | id | 现状 | 图标资产名 | 落地文件 |
| --- | --- | --- | --- | --- | --- |
| 1 | 复制 | `copy` | `⧉` | `copy` | `toolbar/icons/copy.svg` |
| 2 | 搜索 | `search` | `⌕` | `search` | `toolbar/icons/search.svg` |
| 3 | 翻译 | `translate` | `译` | `translate` | `toolbar/icons/translate.svg` |
| 4 | 解释 | `explain` | `?` | `lightbulb` | `toolbar/icons/lightbulb.svg` |
| 5 | 跳转（可选） | `open` | `⇗` | `box-arrow-up-right` | `toolbar/icons/box-arrow-up-right.svg` |
| 6 | 自定义 AI 功能 | `custom:*` | `✦` | `stars` | `toolbar/icons/stars.svg` |

### 5.2 截图工具栏

| 分组 | 功能 | id | 资产名 | 分组 | 功能 | id | 资产名 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 标注 | 选择/调整 | `select` | `cursor` | 输出 | 长截图 | `longCapture` | `arrows-vertical` |
| 标注 | 矩形 | `rect` | `square` | 输出 | 二维码识别 | `qr` | `qr-code-scan` |
| 标注 | 椭圆 | `ellipse` | `circle` | 输出 | 表格识别 | `table` | `table` |
| 标注 | 箭头 | `arrow` | `arrow-up-right` | 输出 | 文本识别 | `ocr` | `card-text` |
| 标注 | 直线 | `line` | `slash-lg` → `line-tool.svg` | 输出 | 识别并翻译 | `translate` | `translate` |
| 标注 | 画笔 | `pen` | `pencil` | 输出 | 区域录制 | `record` | `record-circle` |
| 标注 | 高亮 | `highlight` | `highlighter` | 输出 | 固定到屏幕 | `pin` | `pin-angle` |
| 标注 | 马赛克 | `blur` | `grid-3x3-gap` | 输出 | 保存 | `save` | `download` |
| 标注 | 文字 | `text` | `fonts` | 输出 | 复制 | `copy` | `clipboard-check` |
| 标注 | 序号 | `serial` | `123` | 输出 | 取消 | `close` | `x-lg` |
| 标注 | 水印 | `watermark` | `droplet-half` | 历史 | 撤销 | `undo` | `arrow-counterclockwise` |
| | | | | 历史 | 重做 | `redo` | `arrow-clockwise` |

**刻意避开的撞脸组合**：`text` 用 `fonts`（不使用 `table`）、`ocr` 用 `card-text`（不使用 `fonts`）、`blur` 用 `grid-3x3-gap`（不使用 `grid-3x3`，避免与 `table` 混淆）。

### 5.3 不改的部分

| 位置 | 现状 | 保持原因 |
| --- | --- | --- |
| 截图工具栏颜色选择 | 色块圆点 | 需要显示真实颜色 |
| 截图工具栏线宽 | 文字"细/中/粗" | 三档用图标无法区分轻重 |
| `capture/icons/line.svg` | IconPark 横线 | 仍被 config 标题栏"最小化"使用 |

---

## 6. 代码改动设计

### 6.1 `toolbar/toolbar-action-meta.js`

`icon` 的值由符号改为资产名，**字段顺序必须保持 `id, label, icon`**——`test/selection-toolbar-settings.test.js:55` 用正则锁定 `copy: Object.freeze({ id: 'copy', label:` 前缀。

```diff
- copy: Object.freeze({ id: 'copy', label: '复制', icon: '⧉', kind: 'local', … }),
- search: Object.freeze({ id: 'search', label: '搜索', icon: '⌕', kind: 'local', … }),
- translate: Object.freeze({ id: 'translate', label: '翻译', icon: '译', kind: 'ai', … }),
- explain: Object.freeze({ id: 'explain', label: '解释', icon: '?', kind: 'ai', … }),
+ copy: Object.freeze({ id: 'copy', label: '复制', icon: 'copy', kind: 'local', … }),
+ search: Object.freeze({ id: 'search', label: '搜索', icon: 'search', kind: 'local', … }),
+ translate: Object.freeze({ id: 'translate', label: '翻译', icon: 'translate', kind: 'ai', … }),
+ explain: Object.freeze({ id: 'explain', label: '解释', icon: 'lightbulb', kind: 'ai', … }),
-   icon: '⇗',
+   icon: 'box-arrow-up-right',
```

### 6.2 `toolbar/toolbar-utils.js`

**(a) 自定义功能图标**（第 187 行）：`icon: '✦'` → `icon: 'stars'`

**(b) 窗口宽度预算**（`getToolbarWidth`）：基数 `42` → `46`，理由见 §7。

```diff
- return width + Math.max(70, Math.min(126, 42 + characters * 14))
+ return width + Math.max(70, Math.min(126, 46 + characters * 14))
```

### 6.3 `toolbar/toolbar.js`

`textContent = "${icon} ${label}"` 改为两个子元素。**必须保持 `action.id === 'copy' ? ' pri' : ''` 与 `led.className = 'led'` 原文**（`test/design-tokens.test.js:143-144` 有正则锁定）。

```diff
+const ICON_NAME_PATTERN = /^[a-z0-9-]+$/
+function iconName(action) {
+  // 资产名来自本仓库的冻结元数据与 'stars' 兜底，不是用户输入；
+  // 仍做白名单校验，避免 --icon 的 url() 被拼接出意外路径。
+  return ICON_NAME_PATTERN.test(action.icon || '') ? action.icon : 'stars'
+}

   // Solid accent reserved for the primary local action (copy).
   const primaryClass = action.id === 'copy' ? ' pri' : ''
   button.className = `btn btn-${builtinClass}${primaryClass}`
   button.title = action.label
-  button.textContent = `${action.icon || '✦'} ${action.label}`
+  const icon = document.createElement('span')
+  icon.className = 'toolbar-icon'
+  icon.style.setProperty('--icon', `url('icons/${iconName(action)}.svg')`)
+  icon.setAttribute('aria-hidden', 'true')
+  const label = document.createElement('span')
+  label.className = 'label'
+  label.textContent = action.label
+  button.append(icon, label)
   button.onclick = () => window.toolbarAPI.action(action.id)
```

### 6.4 `toolbar/toolbar.html`

在现有 `<style>` 中**追加**（不改动 `.toolbar {`、`.led`、`.btn.pri` 三条规则，测试对它们有正则断言）：

```css
.toolbar .toolbar-icon {
  flex: 0 0 auto; display: block; width: 15px; height: 15px;
  background: currentColor;
  -webkit-mask: var(--icon) center/contain no-repeat;
  mask: var(--icon) center/contain no-repeat;
}
.toolbar .btn .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

`.toolbar .btn` 已有 `gap: 5px`，图标与标签间距无需新增。`.label` 的 `min-width:0` 是必需的：否则 16 字自定义名称会把图标挤出按钮。

### 6.5 `capture/capture.html`

仅一行（第 23 行）：

```diff
- <button data-tool="line" title="直线" aria-label="直线"><span class="toolbar-icon" style="--icon:url('icons/line.svg')" aria-hidden="true"></span></button>
+ <button data-tool="line" title="直线" aria-label="直线"><span class="toolbar-icon" style="--icon:url('icons/line-tool.svg')" aria-hidden="true"></span></button>
```

### 6.6 `capture/icons/`

- 替换 22 个文件内容（`arrow / close / copy / ellipse / highlight / long-capture / mosaic / ocr / pen / pin / qr / rect / redo / save / select / serial / table / text / translate / undo / watermark / record`）。
- 新增 `line-tool.svg`（`slash-lg`）。
- `line.svg` **不修改**。
- 新增 `LICENSE`（见 §3.1）。

配套 `capture/capture.css` 只改尺寸（决策 D）：

```diff
- .toolbar-icon { display: block; width: 18px; height: 18px; background: currentColor; … }
+ .toolbar-icon { display: block; width: 17px; height: 17px; background: currentColor; … }
```

`test/capture-toolbar-icons.test.js` 只断言 `background: currentColor` 与 `-webkit-mask: var(--icon) center/contain no-repeat`，不锁尺寸，**无需改动**。

### 6.7 `config/config.js`（设置页"划词工具"）

**(a)** 自定义功能图标（第 621 行）：`icon: '✦'` → `icon: 'stars'`

**(b)** 排序列表图标（第 641 行片段）由文本改为 mask 图标：

```diff
- <span class="toolbar-order-icon">${escapeHtml(info.icon)}</span>
+ <span class="toolbar-order-icon">${iconMarkup(iconAssetPath(info.icon))}</span>
```

复用文件里已有的 `iconMarkup(iconPath)`（第 90 行），不另造 span。新增一个路径解析函数（与 `toolbar.js` 的白名单同构）：

```js
const TOOLBAR_ICON_NAME = /^[a-z0-9-]+$/
function iconAssetPath(name) {
  return `../toolbar/icons/${TOOLBAR_ICON_NAME.test(name || '') ? name : 'stars'}.svg`
}
```

保留 `.toolbar-order-icon` 的 30×30 主色底片（`background: var(--primary-soft)`），只把中间的字符换成 16px 图标——**不能**直接把 `.svg-icon` 加到该元素上，两者都会写 `background`，会互相覆盖。

### 6.8 `config/config.css`

追加一条，**不改**第 389 行的 `.svg-icon{…}`（`test/config-icon-contract.test.js:43` 有正则断言）：

```css
.toolbar-order-icon .svg-icon{width:16px;height:16px;color:var(--primary-text)}
```

### 6.9 `action/action.js`（划词助手结果窗）

该窗口 `img-src 'none'`，无法用 mask。现状：

```js
if (data.type === 'explain') el.headerIcon.innerHTML = ACTION_ICONS.explain
else if (data.icon) el.headerIcon.textContent = data.icon   // ← 现在收到的是资产名 'stars'
else el.headerIcon.innerHTML = ACTION_ICONS.custom
```

改为删除中间分支，其余两分支不变：

```js
if (data.type === 'explain') el.headerIcon.innerHTML = ACTION_ICONS.explain
else el.headerIcon.innerHTML = ACTION_ICONS.custom
```

效果：自定义功能的头部由文字 `✦` 变为已有的内联闪光 SVG。内置 `translate` / `explain` 完全不受影响（它们走前面的分支）。**`ACTION_ICONS` 与窗口 CSP 均不改。**

### 6.10 `preload-action.js`

```diff
- icon: boundedText(value?.icon, 16),
+ icon: boundedText(value?.icon, 64),
```

`box-arrow-up-right` 是 19 字符，会被原来的 16 截断。虽然该图标目前不会进入结果窗（`open` 是本地动作），但字段语义变了就该同步放宽上界。

### 6.11 开发脚本与探针

| 文件 | 改动 |
| --- | --- |
| `design-demos/tools/capture-electron.js:134` | 演示注入的 `icon: '⧉'` 等改为资产名，否则设计预览页会显示文字 |
| `scripts/probe-action-security.js:84` | `icon: '✦'` → `icon: 'stars'`（探针只断言 IPC 通道，不受影响） |

---

## 7. 宽度预算（实测）

划词工具栏的窗口是 **frameless 且按 `getToolbarWidth()` 精确开窗**，预算偏小会直接把按钮裁掉。用真实 `toolbar.html` 样式 + 新图标结构在 Chromium 里量了自然宽度：

| 标签 | 字数 | 现状自然宽 | 新方案自然宽 | 现有预算 | 新方案基数 46 的预算 |
| --- | --- | --- | --- | --- | --- |
| 复制 | 2 | 62.0 | 66.0 | 70（+4） | 74（+8） |
| 总结要点 | 4 | 83.1 | 90.0 | 98（+8） | 102（+12） |
| 把这段话润色一下 | 8 | 131.1 | 138.0 | 126 → 截断 | 126 → 截断 |

推导：按钮固定开销 = padding 20 + border 2 + 图标 15 + gap 5 = **42px**，恰好等于现有公式的基数 42——也就是说基数里的余量被图标吃光了，2 字标签只剩 4px。把基数提到 46 可恢复到改动前的余量水平（2 字标签 +8px）。

连带更新：`test/toolbar-utils.test.js:170-171` 的期望值 `100 → 104`、`343 → 359`；`:175` 的预算下界测试（`62 * count`）仍然通过（74 > 62）。

同时验证整条工具栏在预算宽度内不溢出：4 个按钮 `window=343px`、5 个按钮 `window=424px` 时，`scrollWidth ≤ clientWidth`，无按钮被裁。

---

## 8. 测试改动

### 8.1 受影响的既有测试

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `test/toolbar-utils.test.js` | 88-90 | 三个 `icon` 期望值 → `stars` / `translate` / `copy` |
| `test/toolbar-utils.test.js` | 170-171 | 宽度期望 `100 → 104`、`343 → 359` |
| `test/selection-toolbar-thinking.test.js` | 75-83 | `open` 的 `icon` → `box-arrow-up-right`，并替换那段关于 U+21D7 的注释 |
| `test/capture-toolbar-icons.test.js` | 11 | `'line'` → `'line-tool'`（`:23-24` 的 CSS 断言不锁尺寸，改 17px 不受影响） |
| `test/selection-toolbar-settings.test.js` | — | 无需改（它只断言 `id/label` 前缀） |
| `test/config-icon-contract.test.js` | — | 无需改（标题栏仍引用 `line.svg` / `close.svg`） |
| `test/design-tokens.test.js` | — | 无需改（`toolbar.html` 仍只链 `tokens.css`；LED / `.pri` / 复制主色断言都保留） |

### 8.2 新增契约测试：`test/toolbar-icons.test.js`

参照 `capture-toolbar-icons.test.js` 的写法，锁住三件事：

1. `TOOLBAR_ACTION_META` 里每个 `icon` + 自定义兜底 `stars`，都存在于 `toolbar/icons/<name>.svg`；且资产名匹配 `/^[a-z0-9-]+$/`。
2. `toolbar/toolbar.html` 声明了 `.toolbar-icon` 的 `background: currentColor` 与 `mask: var(--icon) center/contain no-repeat`。
3. `toolbar/toolbar.js` 通过 `--icon` 构造 `icons/<name>.svg`；`config/config.js` 构造 `../toolbar/icons/<name>.svg`。

补这一条的原因：`design-tokens.test.js` 只扫描 **HTML/CSS 里的字面 `url(...svg)`**，而划词工具栏的路径是 JS 拼接的，现在完全没有存在性校验——漏文件会静默渲染成空白。

### 8.3 资产完整性

`capture/icons/` 的 23 个引用已由 `capture-toolbar-icons.test.js` 逐个 `fs.existsSync` 校验，新增的 `line-tool.svg` 会自动纳入。

---

## 9. 兼容性与回滚

- **无设置迁移**：`settings.selectionToolbar` 只持久化 `order / buttons / customActions(id,name,prompt,enabled,thinking) / prompts / searchEngine / translateLanguages / conversation / resultWindow`，**不存图标**。改 `icon` 字段语义不触碰任何落盘数据。
- **无 IPC 契约破坏**：`icon` 仍是短字符串，只是取值集合变了；同一份 `preload-action.js` 与主进程都要一起发版，Electron 应用不存在跨版本混跑的渲染进程。
- **资产是纯增量**：`line-tool.svg`、`toolbar/icons/` 都是新增，`line.svg` 不动；回滚 = `git revert` 单个提交，不残留脏资产。
- **唯一外部影响**：设置页与结果窗的图标观感变化（§2.2 B/C），已显式确认。

---

## 10. 验证计划

### 10.1 自动化

```powershell
npm test                                                        # 全量单测
node --test test/toolbar-icons.test.js test/capture-toolbar-icons.test.js test/toolbar-utils.test.js
node .tmp/icon-review/measure.js                                # 宽度余量实测（本次设计用的量测脚本）
node .tmp/icon-review/build-preview.js                          # 重建复核稿
```

> `.tmp/icon-review/` 是本次设计的一次性量测工具（Playwright 渲染 + 像素包围盒统计），已被 `.gitignore` 忽略。实施时若不保留，可把同样的量测逻辑并入 `test/toolbar-icons.test.js` 的断言值，或按 §7 的结论直接落地。

### 10.2 人工实测（必须做，单测覆盖不到渲染）

| 场景 | 检查点 |
| --- | --- |
| 选中一段中文 → 划词工具栏 | 6 个图标清晰；**工具栏没有被裁切/标签没有截断**；复制按钮的图标是深色（主色反色） |
| 设置 → 划词工具 | 排序列表每行左侧是 30×30 主色底片 + 居中图标，不是文字 `copy` |
| 设置 → 外观配色 | 切浅色/深色，图标颜色跟随；换一个主色，复制按钮图标仍可辨 |
| 截图（Alt+A） | 23 个图标逐个看一遍，重点：直线 / 马赛克 / 文本识别 / 长截图 四处不与邻居撞脸 |
| 截图 → 识别并翻译 | 划词助手结果窗头部图标正常（内联 SVG），自定义功能入口也正常 |
| 截图确认 | 图标与图标之间视觉大小一致（17px 盒的效果） |

测试窗口按 `AGENTS.md` 要求放到副屏；无副屏时先询问。

### 10.3 验收标准

1. `npm test` 全绿。
2. 两个工具栏内**没有任何字符型图标残留**：`grep -n "icon: '" toolbar/*.js capture/**/*.js config/config.js` 只返回资产名（`copy` / `stars` …），不再返回 `⧉ ⌕ 译 ? ⇗ ✦`。
3. `capture/icons/*.svg` 全部为 16×16 `fill="#000"` 单行格式（`line.svg` 除外）。
4. 划词工具栏在 1–17 个动作（含 16 字自定义名）下都不溢出窗口。
5. 人工实测六项全部通过。

---

## 11. 风险与缓解

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | 划词工具栏窗口宽度预算不足导致裁切 | **高** | §7 实测 + 基数 42→46 + 保留 `getToolbarWidth` 的整条预算测试 |
| 2 | `icon` 语义变更漏改某个渲染点，界面显示字面量 `copy` | **高** | 已穷举全部消费点：产出 2 处（§6.2a、§6.7a），渲染 3 处（§6.3、§6.7b、§6.9），传递 1 处（§6.10）；收尾用 `grep '\.icon\b\|icon:'` 复查 |
| 3 | 划词工具栏 mask 被 CSP 拦截 | 中 | `img-src 'self'` 已允许；capture/config 同款配置已在跑。仍列入人工实测 |
| 4 | bootstrap 图标在 18px 下偏大、条带显拥挤 | 中 | §4.2 实测，盒尺寸降到 17px |
| 5 | 图标风格与 `config/icons/` 侧边栏不一致 | 低 | 已列为非目标；后续如需统一另开一轮 |
| 6 | 目录密集图标（`grid-3x3-gap`）在小尺寸发糊 | 低 | 视觉稿已逐个放大核对 |
| 7 | 再分发 MIT 资产未署名 | 低 | §3.1 补 `LICENSE` 与 README 说明 |
| 8 | 自定义动作名 16 字时图标被挤掉 | 低 | `.label{min-width:0;overflow:hidden;text-overflow:ellipsis}`，图标 `flex:0 0 auto` |

---

## 12. 待确认

请确认 §2.2 的四项新决定（A/B/C/D），以及 §5 的最终映射表。确认后按 §6 的顺序实施：**先资产、后渲染、最后测试**，并在每组改动后跑一次 `npm test`。
