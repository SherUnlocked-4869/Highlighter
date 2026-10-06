# 设计文档：截图标注线宽三档选择（细 / 中 / 粗）

- 日期：2026-10-06
- 基线：`master` @ `155175b`（`package.json` 版本 2.3.0，已安装构建同为 2.3.0）
- 状态：**已交付并安装到本机**（M1 / M2 / M3 + 构建与静默安装，见 §10、§11）
- 范围：截图编辑器（`capture/`）浮层工具栏的**线宽选择**——把当前"存在但不可读、不可用"的 `<select id="lineWidth">` 换成显式三档控件（细 / 中 / 粗）
- 影响面：`capture/capture.html`、`capture/capture.css`、`capture/capture.js`、`capture/annotation-style.js`（新增）、`preload-capture.js`、`main/services/settings-defaults.js`、`test/`。**不触碰**区域录制、pin、长截图、导出链路、`main.js`

---

## 0. 需求背景与现状核实

### 0.1 用户报告

> 截图标注功能对于线段的粗细无法选择，只能默认。给三个选项：细、中、粗。

### 0.2 代码现状：控件存在，但用户实际用不了

先确认一个与直觉不符的事实：**DOM 里早就有线宽控件**，且绘制链路本身是通的。

`capture/capture.html:33`：

```html
<select id="lineWidth" title="粗细"><option value="2">细</option><option value="4" selected>中</option><option value="8">粗</option><option value="14">特粗</option></select>
```

`capture/capture.js:72` / `:200-219`：

```js
function annotationStyle() { return { color: colorInput.value, width: Number(lineWidthInput.value) || 4 } }
// drawAnnotation(): context.lineWidth = width; 直线/箭头/画笔/矩形/椭圆都取 item.width
```

`git blame -L 33,33 capture/capture.html` 显示这一行自 `f9e7fdf`（2026-07-30，v2.0 稳定版回退）起就存在，`D:\Program Files\Highlighter\resources\app.asar` 内的 `capture.html` / `capture.js` 与工作区一致。所以**这不是"功能缺失"，而是"控件在真实工具栏里不可读/不可用"**——用户看到的是一个坏掉的图标，才得出"不能选、只能默认"的结论。

### 0.3 实测证据（本次已复现，隐藏窗口，未占用显示器的可见区域）

用隐藏的 Electron 窗口加载**真实的** `capture/capture.html`，注入 `capture:init` 载荷（`mode: 'fullscreen'`）让工具栏出现，然后直接测量与截图（探针：`.tmp/capture-width-probe/probe.js`，产物 `report.json` / `toolbar.png` / `control-6x.png`）：

| 测量项 | 实测值 | 说明 |
|---|---|---|
| 工具栏尺寸 | 866 × 43 CSS px | 窗口 900 × 400（内容区 886 × 337）、缩放 100% |
| `#lineWidth` 实际尺寸 | **30–32 × 30 CSS px** | CSS 声明是 `width: 48px`（`capture.css:100`），被 flex 压缩掉了 1/3 |
| 被压缩的原因 | `.toolbar button, .toolbar select { min-width: 30px; padding: 0 7px }`（`capture.css:81-92`）+ `.toolbar` 是 `display:flex` 无 `flex-wrap` | `min-width` 与 `padding` 一起把内宽压到约 16px |
| 渲染外观 | `appearance: auto`、`border: 0`、透明背景、`color:#e8e8e8` | 原生下拉箭头 ≈14px + 7px×2 内边距，**"中"字被裁切并与箭头叠印**，6× 放大后是一个无法辨认的杂点（`control-6x.png`） |
| 选项本身 | `细/中/粗/特粗` = `2/4/8/14`，`value="4"` 默认 | 值与绘制链路都正确，问题纯在呈现 |

结论：`select` 被压成 30px 后既看不出是"粗细选择器"，也看不出当前档位，用户不会去点它——**症状描述与实测一致**。同时这说明修复方向不是"加一个控件"，而是"把不可发现的控件换掉"。

### 0.4 目标

- 截图标注的线宽在工具栏上**一眼可辨、一触可选**，恰好三档：**细 / 中 / 粗**。
- 选中的档位对**后续**标注生效，且**不修改**已提交的标注（沿用今天 `annotationStyle()` 的取值时机）。
- 三档的实际描边宽度有确定、可验证的数值（导出图上可量）。
- 用测试把"三档存在且数值正确""控件不被压缩""Enter 不误触发复制"锁住。

### 0.5 非目标（本期明确不做）

- 不改区域录制端 `record/`（它已有 细/中/粗 弹层，`record/record.html:40-44`、`record/annotation-utils.js:4`）。
- 不引入"自定义线宽 / 数值输入 / 更多档位"。用户明确要三档。
- 不改导出、复制、保存、OCR、pin、长截图路径；不改 `preload-capture.js` 现有的截图 IPC 语义。
- 不 bump 版本、无数据迁移（标注是**会话内存**数据，`capture.js:50` 的 `annotations` 不与磁盘交互）。
- 不改已有标注的渲染算法本身（`drawAnnotation` 不动）。

---

## 1. 已确认的决策（2026-10-06）

下表是**已确认**的口径，实施时逐条对照；确认过程见 §9。

| # | 问题 | **已确认的决策** | 未采纳的备选 / 代价 |
|---|---|---|---|
| **D1** | 交互形态 | **常驻三档分段控件**：工具栏内直接放"细 / 中 / 粗"三枚按钮，当前档高亮 | 未采纳：与录制端一致的"样式"弹层（工具栏几乎不增宽，但多一次点击，且截图端颜色选择器是独立的原生 `input[type=color]`，合并成弹层要顺手改颜色交互，超出本次范围） |
| **D2** | 三档数值 | **细 = 2 / 中 = 4 / 粗 = 8**（沿用今天前三档的既有值，只是删掉"特粗"） | 未采纳：改成录制端的 2/4/7。代价：与 `ANNOTATION_WIDTHS=[2,4,7]` 及 `test/annotation-utils.test.js:42`、`test/recording-ui-contract.test.js:112` 的契约纠缠，且会改变"粗"的既有观感 |
| **D3** | 是否保留"特粗(14)" | **删除**，只留三档 | — |
| **D4** | 文字 / 序号 / 高亮的映射 | **完全保持既有映射不变**：文字 = `max(14, width*5)`、序号半径 = `max(12, width*3)`、高亮 = `max(14, width*4)`（`capture.js:210-212`）。三档下即 文字 14/20/40px、序号半径 12/12/24px、高亮 14/16/32px。**即"细/中/粗"三档的实际表现与今天逐像素一致**，只有"特粗"整列消失 | 未采纳：把文字/序号与线宽解耦（三档给 16/28/48px）。代价：新增一套映射与测试，且失去"一个控件管所有笔触"的简洁 |
| **D5** | 是否记住上次档位 | **记住**（`settings.screenshot.annotationWidth`，默认 4），复用已授权的 `settings:update` 通道（`preload-capture.js:24` 的 `saveWatermarkSettings` 是同一模式）。落盘值与读取值都按 `{2,4,8}` 归一 | 注意 `main.js` 只剩 **3 行**余量（1297 / 上限 1300，`scripts/check-architecture.js:18`），相关逻辑一律放 `main/services/settings-defaults.js`、capture 域或 `capture/annotation-style.js`，**不得写进 `main.js`** |
| **D6** | 极窄屏宽度预算 | 接受工具栏 866 → 约 922px；**实施期必须实测宽度**（§5.3 第 11 项）。若在 1024 CSS px 视口下溢出，压缩按钮内边距（不缩小点击区、不隐藏文字） | 未采纳：`@media (max-width: 1000px)` 下改用三条粗细线图标（会重新引入"看不出是什么"的风险） |
| **D7** | 键盘焦点行为 | 新增按钮后把 Enter/Ctrl+S 的分支**限定**在 `.width-group` 内（今天的守卫是 `['INPUT','TEXTAREA','SELECT']`，换成 `BUTTON` 会连"复制"按钮一起挡掉，见 §4.3(c)） | — |
| **D8** | 交付节奏 | **M1 完成后立即跑真机**（见 §7 分期与 §5.4 第 15 项） | — |

> D3/D4 的能力取舍已在 §2.5 单独说明并记录为"已接受"。

### 1.1 本次确认中我补做的核实（影响 D5 的实现细节）

`settings:update` 的载荷要过 `assertSettingsPatch(patch, template)`，而 **`template` 就是 `DEFAULT_SETTINGS`**（`main/services/settings-service.js:139`）。因此：

- 只要把 `annotationWidth: 4` 加进 `main/services/settings-defaults.js` 的 `screenshot` 块，`{ screenshot: { annotationWidth: 8 } }` 这个补丁就会**自动被放行**，不需要改 `main/services/settings-validation.js`（它按模板的键名与类型做通用校验）。
- 该校验只保证"是数字"（`typeof value !== typeof template` → `类型无效`），**不做值域白名单**：`annotationWidth: 9` 也会被接受并落盘。所以**白名单归一必须由读取端负责**（`annotation-style.js` 的 `resolveWidth()`），另在写入前同时归一，形成双保险。
- `test/settings-validation.test.js` 用的是**自带的局部模板**（该文件 `:5-20`），新增默认字段不会打破它；需要为 `annotationWidth` 补一条用例（§5.2 第 8 项）。
- 渲染端读取路径已有先例：`main/domains/capture/index.js:331` 的 init 载荷里带 `settings: getSettings()`，`capture.js:678` 的 `applyWatermarkSettings(data.settings?.screenshot?.watermark)` 就是同一条路，档位记忆照抄即可，**无需新 IPC 通道**（`main/services/ipc-security.js:81` 已为 capture 角色放行 `settings:update`）。

---

## 2. 关键事实（已核实，设计的依据）

### 2.1 线宽影响的工具矩阵（`capture/capture.js:200-219`）

| 工具 | 当前取值 | 细 2 | 中 4 | 粗 8 | 特粗 14（将删除） |
|---|---|---|---|---|---|
| 直线 / 箭头 / 画笔 / 矩形 / 椭圆 | `item.width` | 2 | 4 | 8 | 14 |
| 箭头头部 | `max(10, width*3)` | 10 | 12 | 24 | 42 |
| 高亮 | `max(14, width*4)`，`globalAlpha=.28` | 14 | 16 | 32 | 56 |
| 文字 | `max(14, width*5)` px 字号 | 14 | 20 | 40 | **70** |
| 序号 | 半径 `max(12, width*3)` | 12 | 12（被 12px 下限夹住） | 24 | **42** |
| 马赛克 / 水印 | 与线宽无关 | — | — | — | — |

导出时按 `Math.max(scaleX, scaleY)` 放大（`capture.js:203`），所以档位在 Retina/缩放屏上等比放大，不需要额外处理。

### 2.2 同样的需求在录制端已经有一个成熟的实现

`record/record.html:40-44`（**正是你要的 细/中/粗**）+ `record/annotation-utils.js:4` 的白名单 `ANNOTATION_WIDTHS = [2, 4, 7]` + `test/recording-ui-contract.test.js:112` 的契约断言。设计上的启示：

- 三档用**文字按钮**是仓库里已经验证过的做法，不需要新图标语言；
- 白名单 + `active` 类是既有惯例，新控件的状态管理照抄这个形状即可；
- 但**数值**建议不同（2/4/8 而非 2/4/7，见 D2），因此不能直接复用 `annotation-utils.js` 的常量。

### 2.3 工具栏宽度现状与上限

- 实测 866 CSS px（900px 视口，20 个图标按钮 + 颜色 + 线宽 + 4 个分隔线）。
- `.toolbar { max-width: calc(100vw - 20px) }`（`capture.css:72`），但**不是**滚动容器：一旦内容超过 `max-width`，右侧按钮会被**窗口边缘裁掉**（`capture.js:260-263` 的 clamp 只能保证左边界，`innerWidth - rect.width - 6` 为负时 `left` 取 6，右边溢出）。
- 因此"三档替换 select"带来的净增宽必须实测（预计 +56px：select 实测 32px → 3×28px 按钮 + 2×2px 间距 = 88px）。

### 2.4 现有测试对 `capture/` 的约束

| 测试 | 约束 | 本次影响 |
|---|---|---|
| `test/capture-toolbar-icons.test.js` | **精确**断言 `capture.html` 中 `--icon:url(...)` 序列等于 23 个固定图标 | 若新控件用 SVG 图标，必须同步该数组；**用文字按钮则零影响**（推荐） |
| `test/capture-performance-contract.test.js` | 断言 `capture.js` 的渲染结构（`drawBackground` / `renderOverlay` / rAF 合并） | 不受影响，但改动不要破坏这些形状 |
| `test/capture-selection-resize.test.js` | 读 `capture.html` 与 `capture.js` 的 `pointerdown` 逻辑 | 不受影响（不动指针链路） |
| `test/design-tokens.test.js` | `capture/capture.html` 必须引 `../shared/tokens.css` 且用 token | 新 CSS 沿用 `var(--radius-sm)` / `var(--primary)` 即可 |
| 覆盖率门禁 | `test:coverage:loaded` 的 `--include` 只含 `capture/selection-utils.js`，**不含 `capture/capture.js` / `capture/annotation-style.js`** | 新增逻辑的单测要靠自己写足（§5） |
| **现状空白** | 全仓库**没有任何测试**引用 `lineWidth` | 本次新增契约测试正好补上 |

### 2.5 "删除特粗"的能力取舍（已接受，记录理由）

§2.1 表格把结论摆平了：**线宽控件是"总笔触开关"，不只管线段**，所以少一档就等于少一组极值——

| 受影响项 | 今天（含特粗 14） | 三档后（2/4/8） | 变化 |
|---|---|---|---|
| 文字最大字号 | 70px | 40px | 变小 |
| 序号最大半径 | 42px | 24px | 变小 |
| 高亮最大线宽 | 56px | 32px | 变小 |
| 直线 / 箭头 / 画笔 / 矩形 / 椭圆 | 2/4/8/14 | 2/4/8 | 三档逐像素不变 |
| 箭头头部 | 10/12/24/42 | 10/12/24 | 三档逐像素不变 |

**接受这条取舍的两个理由**：

1. 你要的就是三档（§9 第 2 条已确认），而"细/中/粗"三档本身**与今天完全一致**——只有"特粗"整列消失，不存在"同样叫粗、实际变细"的隐性回归。
2. "特粗"在实践中**几乎没人用得到**：它只能通过那个被压成 30px、字都被裁掉的 `select` 选中（§0.3），鼠标点击基本不可用，所以要回退的是一个**本来就不易触达**的能力，而不是日常能力。

如果将来仍需要极粗笔触，走 §8 的后续项（"自定义线宽"或给文字/序号单独一套字号档位），不在本期。

> 我在汇报第 3 点时给出的解释就是本节内容；你已确认"按推荐执行"（§9 第 3 条）。

---

## 3. 详细需求点

**FR-1 三档常驻可见**：截图工具栏中常驻显示"细 / 中 / 粗"三个可点击选项，不使用原生 `<select>`，不依赖悬停才出现。

**FR-2 选中即生效且只影响后续标注**：点击后当前档高亮（视觉 + `aria-pressed="true"`）；之后新建的标注用新档位，**已经画好的标注宽度不变**（与今天 `annotationStyle()` 在 `pointerdown` 时取值的语义一致，`capture.js:391-395`）。

**FR-3 三档数值确定**：细 = 2px、中 = 4px、粗 = 8px（导出图上的实际描边宽度，按 §2.1 的映射联动）。删除"特粗(14)"带来的极值下降见 §2.5，**已确认接受**。

**FR-4 可辨识与可访问**：三个选项有文字标签与 `title`（含实际像素值，如"线宽：粗（8px）"）；当前档位有非仅颜色的区分（选中底色 + 文字变亮，沿用 `capture.css:95` 的既有 `active` 观感）；容器有 `role="group" aria-label="标注线宽"`。

**FR-5 键盘不误触**：焦点落在新控件或任意工具栏按钮上时，Enter 不得触发"复制"、Ctrl+S 不得触发"保存"（今天的守卫只覆盖 `INPUT/TEXTAREA/SELECT`，见 §4.3）。

**FR-6 宽度不回归**：新控件替换后工具栏总宽增 ≤ 60px，且在 1024 CSS px 视口下不出现右侧裁切。

**FR-7 档位记忆（D5 已确认）**：退出后重开截图，默认选中上次使用的档位；非法/缺失值回退"中(4)"。写入与读取两端都按 `{2,4,8}` 归一（因为主进程校验只查类型、不查值域，见 §1.1）。

---

## 4. 技术设计

### 4.1 HTML：替换 `capture/capture.html:33`

```html
<!-- 旧 -->
<select id="lineWidth" title="粗细"><option value="2">细</option><option value="4" selected>中</option><option value="8">粗</option><option value="14">特粗</option></select>

<!-- 新 -->
<div id="widthGroup" class="width-group" role="group" aria-label="标注线宽">
  <button type="button" data-annotation-width="2" title="线宽：细（2px）" aria-pressed="false">细</button>
  <button type="button" data-annotation-width="4" class="active" title="线宽：中（4px）" aria-pressed="true">中</button>
  <button type="button" data-annotation-width="8" title="线宽：粗（8px）" aria-pressed="false">粗</button>
</div>
```

- 用**文字**而非图标：与录制端一致（`record/record.html:41-43`），且不会牵动 `capture-toolbar-icons.test.js` 的精确图标序列（§2.4）。
- `data-annotation-width` 属性名与录制端对齐，便于将来的契约测试统一读取。
- 保留 `.divider`（`capture.html:34`）不动。

### 4.2 CSS：新增 `.width-group`，删除 `.toolbar select` 规则

```css
/* 删除：.toolbar select { width: 48px; color-scheme: dark; }  (capture.css:100)
   并把 .toolbar button, .toolbar select { ... } 选择器收窄为 .toolbar button（82-92 行） */

.width-group { display: flex; gap: 2px; }
.width-group button { min-width: 28px; padding: 0 6px; font: 13px/1 inherit; }
.width-group button.active { color: #fff; background: rgba(255, 255, 255, .18); }
.width-group button:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
```

要点：
- **必须去掉 `min-width: 30px` 对新按钮的隐性挤压**：旧控件坏就坏在被压到 30px 且带 7px 内边距（§0.3）。新按钮最小 28px 但内容只有 1 个汉字，不会裁切。
- 选中态沿用 `.toolbar button:hover, .toolbar button.active` 的既有观感（`capture.css:95`），只把不透明度从 `.13` 提到 `.18` 以与 hover 区分。
- 若 D6 实测溢出：加 `@media (max-width: 1000px)` 分支，缩到 `min-width: 26px; padding: 0 4px`，**不隐藏文字**（隐藏会退回"看不懂"的老问题）。

### 4.3 `capture/capture.js` 改动

**(a) 状态与取值**

```js
// 12 行：const lineWidthInput = document.getElementById('lineWidth')   ← 删除
const lineWidthGroup = document.getElementById('widthGroup')
let annotationWidth = 4                       // 默认"中"

// 72 行：
function annotationStyle() { return { color: colorInput.value, width: annotationWidth } }
```

**(b) 点击与状态同步**

```js
// 只有用户点击才回写设置；初始化时的恢复不应再写一次
function setAnnotationWidth(width, persist = false) {
  annotationWidth = resolveAnnotationWidth(width)   // 白名单 2/4/8，非法回退 4
  lineWidthGroup.querySelectorAll('[data-annotation-width]').forEach((button) => {
    const active = Number(button.dataset.annotationWidth) === annotationWidth
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
  if (!persist) return
  window.captureAPI.saveAnnotationWidth(annotationWidth).catch(() => {})
}
lineWidthGroup.addEventListener('click',(event)=>{
  const button = event.target.closest('[data-annotation-width]')
  if (button) setAnnotationWidth(button.dataset.annotationWidth, true)
})
```

**(c) 键盘守卫（FR-5，必修）**

`capture.js:668` 今天是：

```js
if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName||''))return
```

把控制权交给 `select` 时，Enter 天然被浏览器吞掉；换成 `button` 后**焦点停在"粗"上按 Enter 会走进 `performAction('copy')`**（`:669`）。改法（限定范围，避免误伤"复制"按钮的既有行为）：

```js
const focused = document.activeElement
if (['INPUT','TEXTAREA','SELECT'].includes(focused?.tagName || '')) return
if (focused?.closest?.('#widthGroup')) return
```

**(d) 档位持久化（D5 / FR-7，已确认要做）**

- 读：`initData.settings.screenshot.annotationWidth`（`main/domains/capture/index.js:331` 已经在 init 载荷里带 `getSettings()`，渲染端零新增 IPC）。在 `capture.js:677-679` 的 `onInit` 里与 `applyWatermarkSettings(...)` 并列调用一次 `setAnnotationWidth(...)`。
- 写：`preload-capture.js` 增加一行，复用**已授权**的 `settings:update`（`main/services/ipc-security.js:81` 已为 capture 角色放行，无需改白名单）：

```js
saveAnnotationWidth: (width) => ipcRenderer.invoke('settings:update', { screenshot: { annotationWidth: width } })
```

- 默认值：`main/services/settings-defaults.js:29-42` 的 `screenshot` 块加 `annotationWidth: 4`。**这一处同时是 `settings:update` 的校验模板**（`main/services/settings-service.js:139` 用 `this.defaults` 当 template），所以加了默认值就等于放行了该补丁，不需要动 `main/services/settings-validation.js`（§1.1）。
- 值域：`assertSettingsPatch` 只校验"是数字"（`settings-validation.js:33`），**不校验 2/4/8**。所以写入前先 `resolveWidth()` 归一，读取时再归一一次——两端都不依赖非法值能落盘。
- 落盘时机：与 `saveWatermarkSettings` 一致（用户点击档位时写一次），不额外做防抖；`settings:update` 的失败按现有惯例 `.catch(() => {})` 静默（`capture.js:643` 同款），不阻塞标注操作。

### 4.4 抽出可单测的模块：`capture/annotation-style.js`

`capture.js` 是纯渲染脚本、无 `module.exports`，今天无法直接单测。仓库已有两个同惯例的先例——`capture/selection-utils.js`（UMD，`node:test` 可 require）与 `record/annotation-utils.js`。**本项已从"可选"升为必做**（§1 D4 的映射需要被逐档钉死）：

```js
(function exposeAnnotationStyle(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.annotationStyleUtils = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const WIDTH_PRESETS = Object.freeze([
    { id: 'thin', label: '细', width: 2 },
    { id: 'medium', label: '中', width: 4 },
    { id: 'thick', label: '粗', width: 8 }
  ])
  const WIDTHS = Object.freeze(WIDTH_PRESETS.map((preset) => preset.width))
  const DEFAULT_WIDTH = 4

  // 只看未缩放的基础宽度；导出缩放（drawAnnotation 传入的是已缩放值）在匹配之后相乘
  function resolveWidth(value) {
    const width = Number(value)
    return WIDTHS.includes(width) ? width : DEFAULT_WIDTH
  }
  function scaleFactor(value) {
    const scale = Number(value)
    return Number.isFinite(scale) && scale > 0 ? scale : 1
  }
  // §2.1 的既有映射，抽成纯函数后可直接断言
  function textFontSize(width, scale) { return Math.max(14, resolveWidth(width) * scaleFactor(scale) * 5) }
  function serialRadius(width, scale) { return Math.max(12, resolveWidth(width) * scaleFactor(scale) * 3) }
  function highlightWidth(width, scale) { return Math.max(14, resolveWidth(width) * scaleFactor(scale) * 4) }

  return { WIDTH_PRESETS, WIDTHS, DEFAULT_WIDTH, resolveWidth, scaleFactor, textFontSize, serialRadius, highlightWidth }
})
```

> `scale` 参数是实施期补上的（见 §10.4 偏差 2）：`drawAnnotation()` 手里的 `width` 已经被 `Math.max(scaleX, scaleY)` 乘过，直接喂给白名单会退化成默认档。

`capture.js` 里把 `210-212` 行的三条内联算式替换为这三个函数调用，`capture.html` 在 `selection-utils.js` 之前引入它。收益：三档数值与映射**可单测**，不必靠"正则读源码"这种弱断言。

### 4.5 文件改动清单

| 文件 | 改动 | 必选 |
|---|---|---|
| `capture/capture.html` | 替换 `:33` 的 `select` 为 `.width-group`；在 `selection-utils.js` 前引入 `annotation-style.js` | ✅ |
| `capture/capture.css` | 删 `.toolbar select` 规则（`:100`）、收窄共享选择器（`:81-82`）、新增 `.width-group` | ✅ |
| `capture/capture.js` | 删除 `:12` 的 `lineWidthInput`；新增 `annotationWidth` 状态 + `setAnnotationWidth` + 点击事件 + `onInit` 读取；改 `:72`、`:668`、`:210-212` | ✅ |
| `capture/annotation-style.js` | **新增**：`WIDTH_PRESETS` / `WIDTHS` / `resolveWidth` / `textFontSize` / `serialRadius` / `highlightWidth`（§4.4，D4 升为必做） | ✅ |
| `test/capture-annotation-width.test.js` | **新增**结构契约测试（§5.1） | ✅ |
| `test/capture-annotation-style.test.js` | **新增**纯函数单测（§5.2） | ✅ |
| `test/settings-validation.test.js` | 追加一条 `screenshot.annotationWidth` 的补丁用例（§5.2 第 8 项） | ✅ |
| `preload-capture.js` | 追加 `saveAnnotationWidth` 一行（D5） | ✅ |
| `main/services/settings-defaults.js` | `screenshot` 块加 `annotationWidth: 4`（D5；同时充当校验模板） | ✅ |
| `scripts/probe-capture-width.js` | **新增**：把 `.tmp` 里的一次性探针转成可重复的像素级验证脚本（§5.3） | ✅ |

**不改**：`main.js`（行数余量仅 3 行）、`main/services/settings-validation.js`（模板即默认值，无需改，§1.1）、`main/services/ipc-security.js`（`settings:update` 已授权）、`record/**`、`drawAnnotation()` 的绘制算法、任何导出路径。

---

## 5. 测试计划

### 5.1 结构契约（新，`test/capture-annotation-width.test.js`，照 `test/recording-ui-contract.test.js` 的写法）

1. `capture.html` 含三枚 `data-annotation-width="2|4|8"`，文案分别为 `细/中/粗`；默认"中"带 `active` 与 `aria-pressed="true"`。
2. `capture.html` **不再**含 `id="lineWidth"`，**不再**含 `<option`；`capture.js` **不再**含 `getElementById('lineWidth')`（防回退）。
3. `capture.css` **不再**含 `.toolbar select`；含 `.width-group` 且其按钮规则**不含** `min-width: 30px` 这类会挤压的声明形状（正则断言 `\.width-group button\s*\{[^}]*min-width:\s*2[4-9]px`）。
4. 数值白名单：`WIDTHS` 恰为 `[2,4,8]`，且与 HTML 中的 `data-annotation-width` 集合一致。
5. 删除"特粗"：`capture.html` 不含 `特粗`、不含 `value="14"`。

### 5.2 纯逻辑单测（新，`test/capture-annotation-style.test.js` + 追加 `test/settings-validation.test.js`）

6. `resolveWidth`：`2/4/8`（数字与字符串）原样返回；`0/9/14/''/null/undefined/'abc'/NaN` → 返回 `4`。
7. 映射回归（三档锁死，与 §2.1 表格一一对应）：`textFontSize` = `14/20/40`、`serialRadius` = `12/12/24`、`highlightWidth` = `14/16/32`；另断言导出缩放（如 `textFontSize(4, 1.5) === 30`）不会被误当成白名单匹配。
8. 预设与设置项：`WIDTH_PRESETS.map(p => p.label)` 恰为 `['细','中','粗']`；`DEFAULT_SETTINGS.screenshot.annotationWidth === 4`；`assertSettingsPatch({ screenshot: { annotationWidth: 8 } }, DEFAULT_SETTINGS)` 通过，而 `{ annotationWidth: '8' }` 抛 `类型无效`（§1.1 的类型契约）。

### 5.3 像素级渲染验证（新脚本 `scripts/probe-capture-width.js`，隐藏窗口，不进 `npm test` 门禁）

沿用本次探针的做法（`show: false` + `capturePage`，不占用显示器）：

9. 对每一档，在固定选区内画一条**水平直线**，取 `exportSelectionCanvas()` 的输出，扫描某列的不透明像素数：应为 `2 / 4 / 8`（允许 ±1 抗锯齿）。
10. 画一条线后**切换档位再画第二条**：第一条的像素宽度不变（FR-2 的回归锁）。
11. 工具栏宽度：新控件替换后 ≤ 866 + 60 px；在 1024 宽视口下 `toolbar.getBoundingClientRect().right <= innerWidth`（FR-6）。
12. 输出 6× 放大图供人工确认三档按钮可读（今天的失败正是肉眼可见的，人工确认不可省）。
12b. **档位记忆**：在隐藏窗口里模拟"点击粗 → 再次初始化"：断言第二次 init 时默认选中"粗"，且 `settings:update` 收到的补丁是 `{ screenshot: { annotationWidth: 8 } }`（可用桩记录调用）。

### 5.4 键盘与门禁

13. 焦点置为"粗"按钮后派发 `keydown` Enter：`captureAPI.copy` **未被调用**（FR-5）。
14. `npm test` 全绿；`npm run check`（语法 + 架构，`main.js` ≤ 1300 行）；`npm run test:coverage:loaded` 不下降；`npm run audit:dependencies` 无新增豁免。
15. **真机复验（M1 完成后立即执行，D8）**：按 `AGENTS.md`，可见测试窗口放副屏；本机若只有单显示器需先向你确认。流程：`Alt+A` 截图 → 三档各画一条线与一段文字 → 复制并保存，核对导出图上的线宽确为 2/4/8；焦点在"粗"上按 Enter 不会提前复制；重开截图确认档位被记住。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 删除"特粗"造成极值下降（文字最大 70→40px、序号半径 42→24px、高亮 56→32px） | 中 | **已在 §2.5 说明并确认接受**（三档本身与今天逐像素一致；特粗因控件损坏本就难以触达）。如将来仍需要，走 §8 的后续项 |
| 工具栏增宽后在窄屏/高缩放下右侧按钮被窗口裁切 | 中 | §5.3 第 11 项实测；必要时走 §4.2 的窄屏压缩分支 |
| 换掉 `select` 后 Enter 误触发"复制"（今天由 `SELECT` 守卫兜住） | 中 | §4.3(c) 的限定式守卫 + §5.4 第 13 项用例，二者同时落地 |
| 三档数值与录制端 `[2,4,7]` 不一致，未来维护者困惑 | 低 | 在 `annotation-style.js` 顶部注释写明"截图端 2/4/8，录制端 2/4/7，勿混用"，并在 §8 记一条可选统一项 |
| 档位记忆落盘非法值（主进程只校验类型，不校验值域） | 低 | 写入前与读取时都用 `resolveWidth()` 归一（§4.3(d)）+ §5.2 第 6 项用例 |
| 覆盖率门禁不含 `capture/capture.js` / `capture/annotation-style.js` | 中 | §4.4 的抽取已升为必做，§5.2 的纯函数单测是主防线 |
| `main.js` 只剩 3 行余量，顺手加校验会撞架构门禁 | 低 | 相关逻辑一律放默认值/域/渲染端模块（§4.3(d)、§4.5） |

---

## 7. 实施分期

按你确认的节奏（**M1 完成后立即跑真机**，D8）：

- **M1（控件替换 + 档位记忆，可独立验收）**：§4.1 + §4.2 + §4.3(a)(b)(c)(d) + §4.4 的新模块 + §5.1 + §5.2 + §5.3 第 9–12b 项。完成后三档可用、可读、可记忆、Enter 不误触，`npm test` / `npm run check` 全绿。
- **M2（真机复验，紧跟 M1）**：§5.4 第 13–15 项，按 `AGENTS.md` 处理显示器（副屏优先；单屏先向你确认）。这一步的产物是"导出图上能量出 2/4/8"的实测记录。
- **M3（回归资产收尾）**：把 M2 里手工用到的探针固化为 `scripts/probe-capture-width.js` 并写进文档；补 §5.3 第 12 项的人工确认留档。
- 每个阶段结束跑一次 §5.4 第 14 项门禁。

> 与初稿的差异：D5 档位记忆由"可选/M3"提前进 M1（你已确认它是需求，且真机复验要一并覆盖它）；§4.4 的模块抽取由"可选"升为必做（否则 D4 的三档映射只能靠正则读源码断言）。

---

## 8. 遗留与后续（不在本期）

- 录制端档位是否统一到 2/4/8（需同步 `record/annotation-utils.js`、`test/annotation-utils.test.js:42`、`test/recording-ui-contract.test.js:112`）。
- 是否给截图端也做"颜色 + 线宽"合并弹层（未采纳的备选 B），与录制端形态完全对齐。
- 是否需要"自定义线宽/更多档位"，或给文字/序号单独一套字号档位（§2.5 的能力取舍出口）。
- 本次 `.tmp/capture-width-probe/` 的证据（`control-6x.png` 等）在 `.gitignore` 覆盖范围内、不会入库；M3 会把它转为 `scripts/probe-capture-width.js` 长期保留（§5.3）。

---

## 9. 确认记录（2026-10-06）

你的逐条答复，以及它落到本文档的位置：

| # | 你的答复 | 落点 |
|---|---|---|
| 1 | "你选常驻三个按钮" | D1 → §4.1 的三枚文字按钮（细/中/粗） |
| 2 | "数值取 248" | D2 → 细 2 / 中 4 / 粗 8（§2.1 表格） |
| 3 | "按你的推荐" | D3 + D4 → 删除"特粗"，文字/序号/高亮**映射保持不变**，只少一列；取舍说明见 §2.5 |
| 4 | "需要记住上次档位" | D5 / FR-7 → §4.3(d)：默认值 + 一行 preload + init 读取，值域两端归一；另核实了"校验模板即默认值"（§1.1） |
| 5 | "M1 后跑真机" | D8 → §7 分期（M2 紧跟 M1）与 §5.4 第 15 项 |

**状态**：设计已定稿，**未开始编码**。等你一声令下（或指出还要调整的地方），我按 M1 → M2（真机）→ M3 推进，并在每阶段回报门禁结果与实际像素测量值。

---

## 10. M1 实施结果（2026-10-06）

### 10.1 已落地的改动

| 文件 | 改动 |
|---|---|
| `capture/annotation-style.js` | **新增**：`WIDTH_PRESETS`（细2/中4/粗8）、`WIDTHS`、`DEFAULT_WIDTH`、`resolveWidth`、`scaleFactor`、`textFontSize`、`serialRadius`、`highlightWidth`（UMD，与 `selection-utils.js` 同惯例） |
| `capture/capture.html` | `:33` 的 `<select id="lineWidth">` → `#widthGroup` 三枚按钮（带 `title`/`aria-pressed`）；在 `selection-utils.js` 之前引入 `annotation-style.js` |
| `capture/capture.css` | 删除 `.toolbar select` 两条规则、共享选择器收窄为 `.toolbar button`；新增 `.width-group`（按钮 28px 起，不再被压到 30px） |
| `capture/capture.js` | 删除 `lineWidthInput`；新增 `annotationWidth` 状态与 `setAnnotationWidth(width, persist)`；点击委托写入设置；`:72` 取值、`:210-212` 三条映射改调纯函数、键盘守卫限定 `#widthGroup`、`onInit` 恢复档位 |
| `preload-capture.js` | 追加 `saveAnnotationWidth`（复用已授权的 `settings:update`） |
| `main/services/settings-defaults.js` | `screenshot.annotationWidth: 4`（同时充当 `settings:update` 的校验模板） |
| `test/capture-annotation-width.test.js` | **新增** 5 条结构契约（三档存在、旧 select 不再存在、CSS 不压缩、脚本接线、键盘守卫、加载顺序） |
| `test/capture-annotation-style.test.js` | **新增** 5 条纯函数断言（白名单、回退、三档映射、导出缩放、非法 scale） |
| `test/settings-validation.test.js` | 追加 1 条 `screenshot.annotationWidth` 补丁用例 |
| `scripts/probe-capture-width.js` | **新增**：隐藏窗口的端到端探针（18 项断言，含导出图像素测量） |

### 10.2 门禁实况

| 门禁 | 结果 |
|---|---|
| `npm test` | **624 / 624 pass**（613 → +11：契约 5 + 纯函数 5 + 设置校验 1） |
| `npm run check` | ok：语法 228 个文件；`main.js` 1298 行 / 上限 1300 |
| `npm run test:coverage:loaded` | lines **91.09%**（与改动前持平） |
| `npm run audit:dependencies` | 失败，但**与本次改动无关**：25 个未豁免的 `undici` 通告；`git diff --name-only -- package.json package-lock.json` 为空，依赖未动，master 上同样失败 |
| `scripts/probe-capture-width.js` | **18 / 18 通过**（隐藏窗口，未占用任何显示器可见区域） |

### 10.3 实测数据（真实渲染器，隐藏窗口）

- **三档描边**：导出图上该列的实心行数分别为 2 / 4 / 8，覆盖积分同样为 2.00 / 4.00 / 8.00；导出画布 800×602 与视口同尺寸 → 1:1 无缩放干扰。
- **改档不影响已提交标注**：先画 2px，再切"粗"另画一条，原线复测仍为 2px。
- **选择器宽度**：88px（旧 `<select>` 实测 32px → **+56px**，在设计预算 ≤60px 内）。
- **工具栏宽度**：自然宽度 **959px**；旧代码自然宽度 ≈903px（§0.3 量到的 866px 是 886 视口下被 `max-width: calc(100vw - 20px)` 钳制的结果，不是自然宽度）。**1024 视口下 right = 1018 ≤ 1024，不溢出**；临界值约 979px，与旧行为同类。
- **键盘**：焦点在档位按钮上按 Enter，`captureAPI.copy` 调用数为 **0**。
- **档位记忆**：点击过程写入 `[2,4,8,8]` → 落盘 8；重新 init 恢复"粗"；非法值 9 → 回退"中"。
- **控制台**：无错误。
- **人工确认**（`.tmp/capture-width-probe/width-picker.png`）：三档渲染为可读的「细 中 粗」，当前档有高亮底 —— 原先那个"字被裁切并与下拉箭头叠印"的杂点已消失。

### 10.4 与设计稿的偏差（3 处）

1. **`serialRadius` 的数值是设计稿算错了**：§2.1 / D4 / §5.2 原写"中档 → 16"，但原式 `max(12, width*3)` 在 4px 档下是 `max(12,12) = 12`（被 12px 下限夹住）。实现按原式复算为 **12/12/24**，与旧行为逐像素一致。是新增的单测把这个问题抓出来的；已修正 §2.1、D4、§5.2 三处。
2. **映射函数多了 `scale` 参数**：`drawAnnotation()` 传给这些映射的是**已缩放**的宽度（`item.width * Math.max(scaleX, scaleY)`）。若把缩放值直接喂给白名单（例如导出 1.5 倍时的 6px），`resolveWidth()` 会把它当成非法值退回 4px —— 这是实现中必须绕开的陷阱。最终语义是"**白名单只看未缩放的基础宽度，缩放系数在匹配之后相乘**"，并补了 `textFontSize(4, 1.5) === 30` 一类断言。§4.4 的代码片段已同步。
3. **探针自身的坑（不影响产品）**：隐藏窗口默认 `backgroundThrottling: true`，`requestAnimationFrame` 被节流 → 视口变化后工具栏不重排，会得出"1024 视口溢出"的**假结论**。已让探针按真实截图窗口（`main/domains/capture/index.js:268`）补上 `backgroundThrottling: false`，并在改变视口后显式触发一次 `render()`。
4. **探针改为独立 userData**：默认 `userData` 与正在运行的 Highlighter 实例共用同一个 profile 锁，导致探针偶发启动失败（复现为一次"失败 1 项"、一次"无输出"），且页面缩放级别会在两次运行之间残留。已改为 `app.setPath('userData', .tmp/capture-width-probe/user-data)` 并固定 `force-device-scale-factor=1`；连跑 3 次均为 **18/18 通过**。这也意味着该脚本可以在你日常实例运行时安全执行。

### 10.5 M2 真机复验（已完成）

**环境**：副屏 `\\.\DISPLAY2` 1152×2048 @ (3072,-136)，`devicePixelRatio = 1.25`；以源码启动 dev 实例（`electron . --remote-debugging-port=9222`），用**你配置的真实热键 `Ctrl+1`** 触发真实截图流程，再经 CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` 注入**真实输入**（不是合成 DOM 事件）。全程未走复制/保存，**没有写入你的截图历史**；可见窗口按 `AGENTS.md` 全部落在副屏。

| 检查项 | 实测 | 结论 |
|---|---|---|
| 三档控件真实渲染 | 三枚 28×30 CSS px 按钮「细 中 粗」，工具栏可见 | ✅ |
| 面板按存储值恢复 | store = 8 → 「粗」高亮 | ✅ |
| 真实鼠标点击「粗」 | `annotationWidth === 8`，焦点落在该按钮上 | ✅ |
| 真实 store 落盘 | `E:\document\highlighter\config\config.json` → `settings.screenshot.annotationWidth = 8` | ✅ |
| 三档提交的标注宽度 | `[2, 4, 8]`（`annotations` 数组） | ✅ |
| **导出图上的物理像素** | **2.48 / 4.99 / 10.00 px**（期望 2×1.25=2.5、4×1.25=5、8×1.25=10） | ✅ 缩放屏下逐档正确，正是 §10.4 偏差 2 要防的那条路径 |
| 焦点在档位按钮上按真实 Enter | 捕获窗口未关闭、未触发复制 | ✅ |
| 第二次真实截图（新会话） | 自动恢复「粗」 | ✅ 跨会话记忆生效 |
| 还原默认 | 点「中」→ store 写回 4 | ✅ |

**证据**：`.tmp/m2/capture-first.png`（副屏真实截图：可见三档控件与三条线）、`.tmp/m2/capture-second.png`、`.tmp/m2/m2-first.json`、`.tmp/m2/m2-second.json`、`.tmp/m2-evidence/config.before.json`（改动前的完整备份）。

**对你环境的影响核对**：与改动前的 `config.json` 逐键对比，**唯一变化是新增 `settings.screenshot.annotationWidth = 4`**（即默认值）；`captureHistory` 仍是 8 条（未新增任何截图）；复验结束后 dev 实例已停止（相关进程数 0）。已安装的 2.3.0 构建**不含**本次改动，日常实例需你重新启动（若要让它带上本修复，需要出一次构建或继续用源码运行）。

### 10.6 M3 收尾

- 探针已固化：`scripts/probe-capture-width.js`（18 项断言，`show:false` 隐藏窗口，不动用显示器）。
- 人工留档：`.tmp/capture-width-probe/width-picker.png`（6× 放大，三档可读）+ 上面那张副屏真实截图。

### 10.7 复验过程中值得记下的一条经验

真机测量比隐藏窗口难在**背景不可控**：这次捕获到的桌面是近黑窗口（rgb 19,22），我最初的"按白底算覆盖率"和"按局部背景归一"两种度量都被真实内容干扰（后者把一处偏亮的像素当成了墨色参考，8px 档一度测成 2.93px）。最终度量改成"以墨色自身的红-绿差为基准，从笔画中心向外遇到无墨即停"，才同时兼容深浅背景与杂色内容。这条只影响验证脚本，不影响产品代码。

---

## 11. 构建与静默安装（2026-10-06）

### 11.1 构建

- 命令：`node_modules\.bin\electron-builder --win nsis --x64`（**跳过** `prebuild:win` 的原生重建：`native/smart-select/SmartSelect.exe`、`native/ocr/*`、`native/everything*` 均已存在，且与本次改动无关）
- 产物：`dist/Highlighter-Setup-2.3.0.exe`（137.9 MB，NSIS，`oneClick=false`、`perMachine=false`），另有 `dist/win-unpacked` 与 `.blockmap`
- 签名：**NotSigned**——本地构建没有代码签名证书（`Get-AuthenticodeSignature` 为 NotSigned），首次手动运行可能触发 SmartScreen 提示；本次为静默本地安装，不受影响
- 打包内容核对（`dist/win-unpacked/resources/app.asar`）：含 `id="widthGroup"`、`data-annotation-width`、`annotationStyleUtils`、`saveAnnotationWidth`；**不含** `id="lineWidth"`（残留的"特粗"字样只在 `annotation-style.js` 的说明注释里，无功能残留）

### 11.2 静默安装（原地升级）

关键是不要用 `/D` 去指定目录（NSIS 的 `/D` 不能被引号包裹，而 `D:\Program Files\Highlighter` 含空格）。事实是**不需要**：安装器把自己的目录写在 `HKCU\Software\513c5e9d-1311-5cc0-8303-3107835ac253` 的 `InstallLocation`，而 `multiUser.nsh`（`ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation`）会读取它并设置 `$INSTDIR`，因此静默安装会**原地升级**。

- 命令：`Start-Process dist\Highlighter-Setup-2.3.0.exe -ArgumentList '/S' -Wait` → **退出码 0**
- 结果：`D:\Program Files\Highlighter\resources\app.asar` 时间戳由 `09/27 13:03` 变为 `10/06 20:18`（本次构建时间）；桌面与开始菜单快捷方式仍指向 `D:\Program Files\Highlighter\Highlighter.exe`；`InstallLocation` 未变（未产生第二个安装）
- 安装目录可写性已先核实（用户对该目录有写权限，per-user 安装无需 UAC）

### 11.3 安装产物的运行时验收

为确认"装上去的那份确实有这个功能"，对**安装版**再跑了一次端到端（CDP 端口 9223 + 真实 `Ctrl+1` + 真实鼠标点击）：

| 检查项 | 结果 |
|---|---|
| 捕获页来源 | `file:///D:/Program%20Files/Highlighter/resources/app.asar/capture/capture.html`（确认是安装版） |
| 三档渲染 | 「细 中 粗」三枚 28px 按钮，无旧 `select`，DPR 1.25 |
| 按存储值恢复 | 存储 4 → 「中」高亮 |
| 真实点击「粗」 | `annotationWidth = 8` |
| 真实点击「中」 | `annotationWidth = 4`（设置停在默认值） |

证据：`.tmp/m2/installed-picker.png`（4× 放大）、`.tmp/m2/installed-verify.json`、`.tmp/build-win.log`。

### 11.4 收尾状态

- 日常实例已按正常方式重新启动：7 个进程，路径均为 `D:\Program Files\Highlighter\Highlighter.exe`（调试端口已关闭）
- `config.json`：`screenshot.annotationWidth = 4`（默认值），截图历史仍为 **8 条**（全程未新增）
- 唯一未闭环项：产物未签名，若要分发给他人需走 `docs/releases/AZURE_TRUSTED_SIGNING_SETUP.md` 的签名流程
