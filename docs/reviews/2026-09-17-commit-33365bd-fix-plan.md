# 修复方案 · commit `33365bd`

配套评审结论：`docs/reviews/2026-09-17-commit-33365bd-code-review.md`

本方案只描述改动，**未落地任何代码**。所有 diff 均针对 `HEAD = 33365bd` 的当前文件内容，可直接应用。

## 一、总览

| # | 优先级 | 文件 | 改动量 | 需改测试 | 影响面 |
| --- | --- | --- | --- | --- | --- |
| 1 | **P0** | `toolbar/toolbar-utils.js`、`test/toolbar-utils.test.js` | ~15 行 | 是（2 处断言 + 1 个新用例） | 出厂界面（默认配置即触发） |
| 2 | P1 | `recognition/recognition.js`、`recognition/recognition.css` | ~10 行 | 否 | 出厂界面（失败路径） |
| 3 | P1 | `config/config.css` | 2 处单行 | 否 | 出厂界面（截图历史） |
| 4 | P2 | `main/services/appearance-migration.js` | 删 1 行 | 否（测试按集合遍历，自动跟随） | 用户持久化设置 |
| 5 | P2 | `config/config.css` | 1 处单行 | 否 | 出厂界面（视觉） |
| 6 | P2 | `recognition/recognition.css` | 删 2 行 | 否 | 出厂界面（视觉） |
| 7 | P3 | `design-demos/toolbar-history-redesign.html` | 删 1 段声明 | 否 | 仅设计稿 |
| 8 | P3 | `design-demos/toolbar-history-redesign.html` | 1 处选择器 | 否 | 仅设计稿 |

**建议批次**：P0 单独一批（它是唯一阻断项，且是纯回归）；P1 两项可与 P0 同批；P2/P3 随后。

---

## 二、P0 · 工具栏窗口宽度预算

### 2.1 关键修正：单纯抬高基线不够

评审结论里给出的建议（`20` → 约 `36`）只是**在当时算出的 n≤5 范围内**成立。把它当作完整方案会留下一个更大的坑，先看清楚再动手：

每个按钮在预算里占 `max(70, …) ≥ 70`，但 CSS 的 `min-width` 是 `62`，即有 **8px/按钮的富余**。新增的外框开销是 **11px/按钮**（分隔线 1 + 左右外边距 2+2 = 5，加上两侧 flex gap 3+3 = 6）。因此每个按钮的净缺口恒为 `11 − 8 = 3px`，**随动作数线性增长**：

```
预算   B(n)     = 20 + 70n
最小需求 W_min(n) = 14 + 13 + 62n + 5(n−1) + 3(2n−1) = 73n + 19
缺口   W_min − B = 3n − 1
```

| n | 预算 B | 最小需求 W_min | 内容盒溢出 |
| --- | --- | --- | --- |
| 4（默认） | 300 | 311 | 11px |
| 5（+`open`） | 370 | 384 | 14px |
| 6 | 440 | 457 | 17px |
| 17（4 内置 + 1 可选 + 12 自定义 `MAX_CUSTOM_ACTIONS`） | 1210 | 1260 | 50px |

> 上表是"全部 2 字标签"的解析模型。**实测修正（Chromium，方法见 2.5）**：这里的"溢出"是**内容盒**溢出，**不等于被窗口裁切**——300px 窗口的内容盒为 286px，溢出量先吃掉每侧 6px 的内边距，所以：
>
> - **n=4**：窗口级裁切 **0**。真实症状是内缩从设计值 **9/7px** 变成 **3.5/1.5px**（条带局促、左右失衡），标签 0/4 截断；
> - **n=5**：LED 的 3px 光晕被切 **1px**，末按钮与外框齐平（内缩 0）；
> - **n=6**：内缩 7.5/5.5，1/6 标签截断——**改动前亦为 1/6，非本次引入**；
> - **n=17（满配）**：内缩正常，但 **12/17 个标签被截断**（改动前 0/17）——这是本次唯一的功能性损伤。
>
> 因此本条的优先级实为 **Medium**（评审结论已由 High 下调）。修复必要性不变：预算缺陷真实存在，且满配时确实造成截断。

顺带说明：这个缺陷不是本次才出现的。改动前每动作的外框是 `1 + 4×2 = 9px`，而当时的按钮富余是 `70 − 62 = 8px`，**净缺口 1px/动作**，所以旧公式在 n ≥ 8 时**内容盒**同样溢出（`n=8`：`W_min = 581 > B = 580`），只是默认 4 个动作离阈值很远，从未暴露。本次把 `.btn` 水平内边距从 6px 加到 10px、并加入 LED 与更宽的分隔线后，净缺口升到 3px/动作，阈值从 n = 8 掉到 **n = 4，即出厂默认配置**。

结论：**固定基线抬高对 n ≥ 6 一律无效**（`20 → 36` 只覆盖到 n = 5；要覆盖 n=17 需要基线 ≥ 70）。必须让预算**逐动作**地计入新增外框。上面的 `缺口 = 3n − 1` 就是"抬高基线"思路失效的原因——缺口本身是 n 的函数。

### 2.2 改动 `toolbar/toolbar-utils.js`

把外框开销显式算出来，直接与 CSS 对齐：

```diff
 function getToolbarWidth(actions) {
   if (!Array.isArray(actions) || !actions.length) return 0
-  return 20 + actions.reduce((width, action) => {
+  const buttons = actions.reduce((width, action) => {
     const label = typeof action === 'object' ? action?.label : (BUILTIN_TOOLBAR_ACTIONS[action]?.label || OPTIONAL_TOOLBAR_ACTIONS[action]?.label)
     const characters = Array.from(String(label || '')).length
     return width + Math.max(70, Math.min(126, 42 + characters * 14))
   }, 0)
+  // Mirror the boxes toolbar/toolbar.html wraps around the buttons. The window
+  // is frameless and sized exactly to this value, so an unbudgeted LED, gap or
+  // separator makes the strip overflow its own content box: the buttons eat the
+  // 6px padding and the outer insets collapse, and once the overflow exceeds that
+  // padding the edge items are clipped and long labels truncate. Keep these terms
+  // in sync with that stylesheet:
+  //   fixed       border 1+1, padding 6+6, status LED 6 with 2px/5px margins
+  //   per action  1px separator with 2px margins
+  //   per child   the 3px flex gap between all (2n-1) children
+  const count = actions.length
+  const chrome = 14 + 13 + (count - 1) * 5 + (2 * count - 1) * 3
+  return chrome + buttons
 }
```

为什么写成"外框 + 按钮宽度"而不是两个魔数：`chrome` 的每一项都能在 `toolbar/toolbar.html` 里指出来，改 CSS 时容易发现同步点；同时按钮宽度仍走原来的标签公式，行为不变。

**取值变化**

| 动作数 | 旧 | 新 | 窗口内按钮实际宽度 |
| --- | --- | --- | --- |
| 1 | 90 | 100 | 70 |
| 4（默认） | 300 | **343** | 70 |
| 5（+`open`） | 370 | **424** | 70 |

`TOOLBAR_W`（`main.js:301`）→ `main.js:845` 的 `toolbarWidth` 依赖注入、`main.js:1014` 的 `calculateToolbarPosition` 默认参数都是从它派生的，会**自动跟随**，无需另改。`test/selection-window-manager.test.js:245` 的 `width: 300` 是显式 fixture，与本函数无关，不受影响。

### 2.3 改动 `test/toolbar-utils.test.js`

```diff
 test('toolbar width grows by stable slots and accommodates longer custom labels', () => {
   assert.equal(getToolbarWidth([]), 0)
-  assert.equal(getToolbarWidth(['copy']), 90)
-  assert.equal(getToolbarWidth(['copy', 'search', 'translate', 'explain']), 300)
+  assert.equal(getToolbarWidth(['copy']), 100)
+  assert.equal(getToolbarWidth(['copy', 'search', 'translate', 'explain']), 343)
   assert.ok(getToolbarWidth([{ label: '这是一个较长功能' }]) > getToolbarWidth(['copy']))
 })
+
+test('toolbar window budget covers the chrome the strip CSS adds', () => {
+  // Mirrors toolbar/toolbar.html. 17 is the largest reachable action count:
+  // 4 builtin + 1 optional + MAX_CUSTOM_ACTIONS (12).
+  const minimum = (count) =>
+    14 + 13 + (count - 1) * 5 + (2 * count - 1) * 3 + 62 * count
+  for (let count = 1; count <= 17; count += 1) {
+    const actions = Array.from({ length: count }, () => 'copy')
+    assert.ok(
+      getToolbarWidth(actions) >= minimum(count),
+      `${count} actions must fit inside the window the manager is told to open`
+    )
+  }
+})
```

该用例锁定的不变量是：`max(70, …)` 的按钮下限必须始终高于 CSS 的 `min-width: 62px`，且外框被完整计入。**这是本次唯一能防住"再改 CSS 又溢出"的手段**——注意截图工具 `design-demos/tools/capture-electron.js` 以 620px 渲染工具栏页面，无论窗口预算错成什么样它都照样好看，所以纯视觉验证发现不了这类问题。

如果想要更强的约束，可按 `test/design-tokens.test.js` 既有风格再加一条读 `toolbar/toolbar.html` 源码的用例，把 `gap`/`padding`/`.led` 宽度等数值本身钉住（一旦 CSS 改动就强制重新评估预算）。代价是正则解析 CSS 比较脆，**不是必须项**。

### 2.4 是否可以保住原来的 ~300px 宽度

宽出来的 43px 全部来自 2.2 的预算方式：按钮按标签公式拿到 70px，而旧版在 300px 窗口里只分到约 63.75px。

先说清一个容易走错的方向：**只把 `.btn` 的 `min-width` 从 62px 降下来，就能让原公式重新成立、且一行公式都不用改**——解 `19 + 11n + m·n ≤ 20 + 70n` 得 `m ≤ 59 + 1/n`，即 `min-width ≤ 59px` 时对任意 n 都不再溢出（例：`m=59, n=4` → 299 ≤ 300）。

> **实测修正**：原文这里断言"压到 59px 会开始吃掉标签"，**该论据不准确**。实测 62px 下 2 字标签（`⧉ 复制`）的 `scrollWidth` 未超过 `clientWidth`，即 0/4 截断，说明内容需求低于 62px、也低于 59px，2 字标签不会因 59px 而截断。
>
> 但该方案仍然不该采用，理由是**它救不了 3 字自定义标签**：满配时 12 个 `自定义`（3 字）按钮的预算为 `42 + 3×14 = 84px`，而压缩 `min-width` 只是让它们与其他按钮一起挤在更窄的宽度里——实测满配旧预算下 **12/17 个标签被截断**（详见 2.5）。逐动作预算才是能同时满足 2 字与长标签的解法。

因此建议**接受窗口从 300px 变宽到 343px，直接采用 2.2**。若产品上必须守住 300px，那不是调几个 CSS 数值能解决的，需要重新设计这块的密度（例如把分隔线改成 `border-left` 而不占 flex 项；仅去掉 LED 只能收回约 16px，`343 → 327`，仍高于 300），并且**无论如何都要保留 2.2 的逐动作预算**。

### 2.5 实测验证（Chromium headless）

源码算术只能证明"内容盒溢出"，不能证明"被窗口裁切"——两者之间的差额正是 6px 内边距。因此用 Playwright 启动 Chromium 加载真实 `toolbar/toolbar.html`，用 `addInitScript` 注入 `toolbarAPI` 桩，再派发 `getVisibleToolbarActionDefinitions(DEFAULT_SELECTION_TOOLBAR)` 产生的真实载荷，在目标宽度下测量子元素相对**窗口边界**的位置与每个按钮的 `scrollWidth > clientWidth`。

三种状态对照（a = 改动前 / b = 本次提交 / c = 本修复）：

| 动作数 | 状态 | 预算 | 窗口级裁切 | 光晕裁切 | 左/右内缩 | 标签截断 |
| --- | --- | --- | --- | --- | --- | --- |
| 4 默认 | a 改动前 | 300 | 0 | 0 | 9 / 9 | 0/4 |
| 4 默认 | b 本次提交 | 300 | 0 | 0 | **3.5 / 1.5** | 0/4 |
| 4 默认 | **c 修复后** | 343 | 0 | 0 | **9 / 7** | 0/4 |
| 5 +跳转 | a | 370 | 0 | 0 | 9 / 9 | 0/5 |
| 5 +跳转 | b | 370 | 0 | **1** | **2 / 0** | 0/5 |
| 5 +跳转 | **c** | 424 | 0 | 0 | **9 / 7** | 0/5 |
| 6 +1 自定义 | a | 454 | 0 | 0 | 9 / 9 | 1/6 |
| 6 +1 自定义 | b | 454 | 0 | 0 | 7.5 / 5.5 | 1/6 |
| 6 +1 自定义 | **c** | 519 | 0 | 0 | **9 / 7** | **0/6** |
| 17 满配 | a | 1378 | 0 | 0 | 9 / 9 | 0/17 |
| 17 满配 | b | 1378 | 0 | 0 | 9 / 7 | **12/17** |
| 17 满配 | **c** | 1564 | 0 | 0 | **9 / 7** | **0/17** |

内缩的设计意图 = 边框 1 + 内边距 6，左侧再加 LED 的 2px 左边距，即 **9 / 7**。修复后四个动作数全部精确落在 9/7，且最小按钮宽度 ≥ 70px（CSS `min-width` 为 62px）。

**结论**：
1. 窗口级裁切在任何情形下都是 0，原"裁掉 LED 与首尾按钮"的表述不成立；默认 4 动作的真实症状只是内缩被吃到 3.5/1.5（局促、失衡）。
2. 唯一的功能性损伤在满配：改动前 0/17 截断，改动后 **12/17** 截断。5 动作时另有 LED 光晕被切 1px、末按钮与外框齐平。
3. 修复后内缩恢复设计值、四个动作数全部 0 截断，并顺带修掉了 6 动作那 1 例**改动前就存在**的截断（1/6 → 0/6）。

---

## 三、P1 · 徽标失败态

### 3.1 改动 `recognition/recognition.css`

在 `.badge` 规则之后（现第 75 行 `}` 与第 77 行 `.icon-button` 之间）插入：

```diff
   -webkit-app-region: no-drag;
 }
 
+/* The badge carries the outcome as well as the engine, so the failure path
+   needs its own tone instead of staying on the success green. */
+.badge.is-error {
+  color: var(--danger);
+  background: var(--danger-soft);
+}
+
 .icon-button {
```

`--danger` / `--danger-soft` 在 `shared/tokens.css` 明暗两套里都已定义（`:60,95` 与 `:136,153`）。

### 3.2 改动 `recognition/recognition.js`

用一个小助手把文字与色调绑在一起，避免两条路径再次漂移（当前正是"只改文字、忘改 class"造成的缺陷）：

```diff
 let tableResult = null
 let qrResult = ''
 let activeUrl = ''
 
+function setBadge(text, failed = false) {
+  badge.textContent = text
+  badge.classList.toggle('is-error', failed)
+}
+
 function showError(error) {
   loading.classList.add('hidden')
   tableView.classList.add('hidden')
   qrView.classList.add('hidden')
   actions.classList.add('hidden')
-  badge.textContent = '识别失败'
+  setBadge('识别失败', true)
   errorText.textContent = error?.message || String(error)
   errorView.classList.remove('hidden')
 }
 
 function renderTable(result) {
   tableResult = result
   title.textContent = '表格识别'
   summary.textContent = `${result.rowCount} 行 × ${result.columnCount} 列`
-  badge.textContent = '本地 OCR'
+  setBadge('本地 OCR')
```

`renderQr` 内的另一处 `badge.textContent = '本地 OCR'` 同样改为 `setBadge('本地 OCR')`（它负责在失败后重新识别成功时清掉 `is-error`）。

**替代方案**：若认为徽标应当只表示"识别引擎来源"而不表示结果，则更干净的做法是失败时**不改文字、也不改色调**，把失败信息完全交给已有的 `#error` 视图。但本次提交已经引入了 `识别失败` 文案，故上面按保留该设计意图给出最小改动。

---

## 四、P1 · 隐藏的历史操作按钮仍可点击

### 4.1 改动 `config/config.css`

```diff
-.history-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 12px;opacity:0;transform:translateY(4px);transition:opacity .16s,transform .16s}
-.history-item:hover .history-actions,.history-item:focus-within .history-actions,.history-item.selected .history-actions{opacity:1;transform:none}
+.history-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 12px;opacity:0;pointer-events:none;transform:translateY(4px);transition:opacity .16s,transform .16s}
+.history-item:hover .history-actions,.history-item:focus-within .history-actions,.history-item.selected .history-actions{opacity:1;pointer-events:auto;transform:none}
```

选 `pointer-events` 而非 `visibility: hidden` 的原因：后者会把按钮从 tab 序列里一并移除，`opacity` + `pointer-events` 的组合既挡住了鼠标误触，又保留了键盘可达性。键盘用户 Tab 到第一个按钮即触发 `.history-item:focus-within`，操作条随之显现，这也是选择器里已经预留的路径。

同一提交的参考稿 `design-demos/toolbar-history-redesign.html:116` 有同样写法（`.h-a .acts{…opacity:0…}`），建议一并处理，见第七节 Fix 8。

---

## 五、P2 · 主色迁移集合去掉 `#1687ff`

### 5.1 改动 `main/services/appearance-migration.js`

```diff
 const LEGACY_MAIN_COLORS = new Set([
   '#1677ff',
-  '#1687ff',
   '#1890ff'
 ])
```

**依据**（已用 `git log -S` 逐一确认）：

- `git show fda21b6^:main.js` 显示重设计前的默认主色**只有** `#1677ff`。
- `git log --all -S"mainColor: '#1687ff'" -- main.js` 与 `-S"mainColor: '#1890ff'"` 均为**空**——两者从未作为出厂默认值出现。
- `#1687ff` 的实际来源是录屏标注色：`record/annotation-utils.js:3` 的 `ANNOTATION_COLORS`、`record/record.html:36` 的色板按钮。

保留 `#1890ff` 仍属合理（Ant Design v4 的主蓝，用户可能照文档填过）；`#1687ff` 则是本应用自己的标注蓝，用户把它设为主色的概率不低，且 `resolveMainColor` 在 `normalizeSettings` 中无条件生效，会**无提示地静默改写持久化设置**。

测试无需改动：`test/appearance-migration.test.js` 以 `for (const legacy of LEGACY_MAIN_COLORS)` 遍历，自动跟随；`test/design-tokens.test.js` 断言的是 `/#1677ff/`，仍然存在。建议顺手把文件头注释里"only the known pre-redesign accents"补一句具体来源（`#1677ff` 为出厂默认，`#1890ff` 为 AntD v4 蓝），避免后人再把标注色加回来。

---

## 六、P2 · 两处视觉修正

### 6.1 `config/config.css` — 缩略图发丝边框被图片遮挡

```diff
-.history-image{position:relative;height:158px;overflow:hidden;background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--line)}
+.history-image{position:relative;height:158px;overflow:hidden;background:var(--surface-2);border:1px solid var(--line)}
```

`box-shadow: inset` 属背景绘制阶段、位于后代内容之下，而 `img{position:absolute;inset:0}` 铺满整块底片，会把边框贴到的那两条边盖掉。改用真实 `border` 后：全局 `box-sizing:border-box` 保证 `height:158px` 不变，`inset:0` 相对 padding box 解析，边框与 `.unavailable::after` 都落在边框内侧，始终可见。

`test/design-tokens.test.js` 的正则 `/\.history-image\{[^}]*background:var\(--surface-2\)/` 仍然匹配（`border` 声明中不含 `}`），无需改动。

**替代方案**：沿用参考稿的做法，保留 `box-shadow` 并补一个 `::after` 覆盖层（`toolbar-history-redesign.html:112` 正是 `.plate::after{inset:0;box-shadow:inset 0 0 0 1px var(--line);pointer-events:none}`）。它比 `border` 多一层定位上下文，但对圆角/缩放的适应性更好。

### 6.2 `recognition/recognition.css` — 2px 边框接缝

删掉 `.table-view`（第 128 行）与 `.qr-view`（第 163 行）的 `border-top`，保留各自的 `border-bottom`：

```diff
 .table-view {
   height: 100%;
   overflow: auto;
   padding: 0;
   background: var(--surface-2);
-  border-top: 1px solid var(--line);
   border-bottom: 1px solid var(--line);
 }
```

```diff
 .qr-view {
   height: 100%;
   padding: 18px 22px;
   background: var(--surface-2);
-  border-top: 1px solid var(--line);
   border-bottom: 1px solid var(--line);
 }
```

`.topbar` 的 `border-bottom` 已提供上方分隔（三种视图状态都在它下面），`border-bottom` 则负责与 `.actions` 分隔（`.actions` 本次已移除自身的 `border-top`）。删 `border-top` 后每处接缝恰好一条线。

---

## 七、P3 · 仅设计稿

### 7.1 `design-demos/toolbar-history-redesign.html:22` — 日间主题对比度

```diff
 body.day{
   --bg:#eeebe4; --surface:#fffefb; --surface-2:#f6f3ed; --surface-3:#ece8e0;
   --line:#e2ddd3; --line-2:#cdc6ba;
   --ink:#1b1815; --ink-2:#4a453d; --muted:#6d675e; --faint:#9a938a;
-  --primary-ink:#fff8ec; --primary-soft:rgba(168,106,31,.11); --primary-line:rgba(168,106,31,.38);
+  --primary-soft:rgba(168,106,31,.11); --primary-line:rgba(168,106,31,.38);
   --ok:#2e7d51; --danger:#b8382c;
 }
```

直接删掉该声明，让 `--primary-ink` 继承 `:root` 的 `#241a08`。这与出厂 token 体系一致：`shared/tokens.css` 里 `--primary-ink` 由 `--primary` 推导（`oklch(from var(--primary) …)`），刻意**不出现在**明暗覆盖块中——因为 `--primary` 本身在两个主题下都是那块琥珀，压在其上的文字色不应随主题翻转。原值 `#fff8ec` 配 `#e5a44c` 实测对比度约 **2.04:1**。

`--primary-soft` / `--primary-line` 用暖棕半透明值是正确的日间微调，保留。

### 7.2 `design-demos/toolbar-history-redesign.html:117` — 死选择器与键盘可达性

```diff
-.h-card:hover .h-a .acts,.h-a:hover .acts{opacity:1;transform:none}
+.h-a:hover .acts,.h-a:focus-within .acts{opacity:1;transform:none}
```

第 234 行是 `<div class="h-card h-a">`，`.h-card` 与 `.h-a` 同属一个节点，故 `.h-card:hover .h-a .acts` 永不匹配（节点不可能是自己的后代）；真正生效的一直是 `.h-a:hover .acts`。改成 `:focus-within` 后与出厂实现（Fix 3）保持同一约定，变体 A 的 打开/复制/地址/删除 按钮键盘可达。

---

## 八、验证步骤

```powershell
# 1. 单元测试（覆盖 Fix 1 / 4 的断言）
npm test

# 或只跑受影响的三组
node --test test/toolbar-utils.test.js test/appearance-migration.test.js test/design-tokens.test.js

# 2. 静态检查（含架构约束）
npm run check
```

**实测结果（已执行）**：`npm test` **515/515 通过**；`npm run check` 199 个 JS 文件语法通过、architecture-check ok；`test/toolbar-utils.test.js` 两处断言（100 / 343）与新增的 n=1..17 用例通过；`test/design-tokens.test.js` 与 `test/appearance-migration.test.js` 未改动即通过。Chromium 实测见 2.5：内缩恢复 9/7，4/5/6/17 动作全部 0 裁切、0 截断。

**真机验证（已执行，Fix 2 的失败态）**：用真实 Electron 渲染真实 `recognition/recognition.html` + 真实 `preload-recognition.js` + 真实 IPC，采用应用的锁定偏好（`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`webSecurity:true`），**无任何桩**；窗口以 `show:false` + offscreen 渲染创建，全程不显示在任何显示器上。通过 `ipcMain` 让 `recognition:table` 分别 resolve / reject，从而同时走通成功与失败两条真实路径。四种组合全部通过，`console` 错误 0：

| 阶段 | 徽标文字 | class | 计算色 | == `--danger`/`--ok` | 背景 | 帧内徽标区均值 (B,G,R) | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 成功/浅色 | 本地 OCR | `badge` | `rgb(46,125,81)` | ✅ `--ok` | ✅ `--ok-soft` | 218.2, **228.9**, 216.1 | 绿占优 |
| 成功/深色 | 本地 OCR | `badge` | `rgb(99,185,138)` | ✅ `--ok` | ✅ `--ok-soft` | 45.3, **57.5**, 41.3 | 绿占优 |
| 失败/浅色 | 识别失败 | **`badge is-error`** | `rgb(184,56,44)` | ✅ `--danger` | ✅ `--danger-soft` | 215.7, 220.3, **241.0** | **红占优** |
| 失败/深色 | 识别失败 | **`badge is-error`** | `rgb(224,115,106)` | ✅ `--danger` | ✅ `--danger-soft` | 38.2, 40.8, **66.7** | **红占优** |

不只是读了计算样式——还验证了**确实被绘制**：offscreen 产生了 149 次 paint，四帧 SHA-256 **两两不同**（4/4），并从原始位图中采样徽标区域。位图通道序不是假设的：页面内绘制了一个纯红校准色块（实测 `c2 ≈ 254.7`），据此确认 Electron 的 `getBitmap()` 为 BGRA，再判定红/绿通道谁占优。失败态红占优、成功态绿占优，四个阶段全部符合预期。

**这次验证的边界（如实说明）**：失败是注入在 `recognition:table` 这个 IPC 边界上的，即驱动的是渲染层的真实错误分支（`recognition.js` 的 `catch → showError()`）；并未让真实 OCR 引擎真的失败。徽标的绘制只取决于该 catch 分支，与错误如何产生无关，因此该覆盖对 Fix 2 是充分的。

**验证脚本**：临时脚本位于会话临时目录（`verify-recognition4.js`），未写入仓库；截图同样在临时目录。按仓库约定（`AGENTS.md`），若日后需要可见窗口验证，请放到副屏（本机 `\\.\DISPLAY2`，1152×2048 @ X=3072）。

---

## 九、不建议做的事

- **不要只把 `getToolbarWidth` 的 `20` 抬到 `36` 就收工**——见 2.1 的表，n ≥ 6 仍然溢出，而 n 上限是 17。
- **不要用 `visibility: hidden` 隐藏历史操作条**——会连带破坏键盘可达性，与本次刚建立的 `:focus-within` 约定冲突。
- **不要为了"消除双边框"去删 `.topbar` 的 `border-bottom`**——`.table-view` / `.qr-view` 在 loading/error 状态下不显示，删顶栏那道线会在这些状态下丢掉分隔。
