# 剪贴板历史：图片记录改为缩略图网格（开发方案）

- 日期：2026-10-22（Asia/Hong_Kong）
- 基线：`master` @ `fd229a2`（4.1.0；Electron 43.8.3 / Node 24.22.1）
- 状态：**仅方案与分析，未改任何产品代码、未构建原生、未启动 Electron、未跑完整 `npm test`。本文不是功能验证通过记录，也不授权自动提交、推送或发布。**
- 上游调研（本轮产出，放在 gitignore 的 `.tmp/clipboard-image-grid/`）：
  - 渲染层 `t1-render-research.md`（698 行）
  - 缩略图链路 `t2-pipeline-research.md`（573 行，附 4 个只读实测脚本）
  - 横切面/门禁 `t3-gates-research.md`（396 行）
  > 本方案把所有结论与关键证据内联，不依赖那三份笔记存活。
- 评审：本文经一轮独立评审（Codex）后修订。评审指出的 8 个阻断项与 7 个非阻断项的处理见 **§16 修订记录**；其中 5 处是我原稿的真实错误，已改，并保留了原错误与成因。

---

## 0. 结论摘要（先看这一页）

### 0.1 推荐方案一句话

> **图片记录在列表里变成缩略图格子（文本/链接仍是整行），图片格不再有任何可见文字；「点击就在下方弹出详情」整体退役 —— 选中不再触发任何详情，文本全文改为**按需打开、可关闭、不改变列表几何的浮层**。缩略图取图从「一次一张、先清后设」改为**一次批量 `previews(ids)` + 有界令牌 + 并发池 8 + 主进程 LRU**。原生侧零改动。**

### 0.2 为什么不是「只改 CSS」

用户三条诉求里，第 1 条在代码层会撞上三个硬约束，任何一个不解决都会做出「能跑但不可用」的版本：

| 约束 | 现状 | 不解决的后果 |
| --- | --- | --- |
| 取图令牌是**单活**的 | `preview()` 第一句 `revokePreviews()` 全清（`main/domains/clipboard/index.js:23,160-166`） | N 个格子同时取图，**确定性只剩最后 1 张成功**，其余全 404（§5.2 推导） |
| 原生 RPC 有背压 | `pending.size >= 16` 直接 `BACKPRESSURE`（`main/services/clipboard-service.js:151`） | 一屏 12–16 张并发即撞墙，格子成片空白 |
| 行高是**常量** | `rowHeight = 64`（`clipboard/clipboard.js:11`）× `.row{height:64px}`（`clipboard/clipboard.css:294-311`），由契约测试锁步（`test/clipboard-ui-contract.test.js:156-168`） | 网格 pitch 不再是常量，四处 `index*rowHeight` 数学（滚动窗口、spacer、键盘居中、150 条裁剪补偿）同时失效 |

### 0.3 三条需求的落法

| # | 用户要求 | 本方案 |
| --- | --- | --- |
| 1 | 图片直接展示缩略图（比例大小自控） | 图片记录进入**网格**：默认 480 面板 **4 列**、单格 **106.3 × 92 DIP**，`object-fit: contain` 保持原始比例；一屏约 **16 格**。列数与格高随面板宽度和 DPR 自适应（§3.2） |
| 2 | 图片条目不再展示文案 | 格子内**没有任何可见文字**：无 `previewText`、无「图片 W × H」、无来源/时间行、**也不加 `title`**（`title` 会产生可见悬停文案）。信息只进 `aria-label`（读屏专用），复用已有 `clipboard.image-size` |
| 3 | 移除「点击在下方弹出详情」 | 选中（单击/方向键）**不再触发任何详情、不改变任何布局**；文本全文改为显式动作（页脚「查看全文」/`Space`）以**浮层**呈现，`Esc`/再按一次/点列表关闭；图片**不提供详情** |

### 0.4 里程碑与人日

| 里程碑 | 任务 | 可演示内容 | 人日 |
| --- | --- | --- | --- |
| M0 基线冻结 | T01 | 门禁基线数字 + 27 条契约断言「保留/改写/退役」判定表 | 0.5 |
| M1 取图链路（原子提交） | T02 | 一次 IPC 拿 N 个可用 URL，且**每一个中间提交后应用仍可用** | 2.0 |
| M2 网格可用 | T03 | 面板里图片显示为格子、滚动不掉位 | 1.5 |
| M3 交互收口 | T04 | 图片零文案；点击不再弹详情；文本全文浮层 + 状态机 | 1.0 |
| M4 门禁绿 | T05 + T06 | 契约测试改写 + 新增 pitch/协议单测；i18n 收口 | 1.5 |
| M5 验收 | T07 + T08 | 副屏真机验收 + 收口文档 | 1.5 |
| **合计** | | | **8.0 人日**（单人，含真机验收） |

（原稿估 7.0 人日，经评审核定为偏乐观：T02 需含 service 超时语义、T04 需含浮层状态机，各 +0.5。）

### 0.5 本方案相对「照做三条需求」的 6 个细化决策

| # | 决策 | 理由 |
| --- | --- | --- |
| S1 | **几何单一真源 = CSS 自定义属性 + 一层 DPR 媒体查询；JS 只读** | 网格需要 6 个几何量；双写数字会让契约测试变成维护负担（§3.1） |
| S2 | **布局抽成纯函数 `layout(items, metrics)`，按「行」虚拟化** | 混排后 pitch 非常量，纯函数才能用 `node --test` 守住（§3.3） |
| S3 | **动作放进现有页脚（页脚 30→44 DIP），不新增第二条栏，也不移除「清空」** | 原稿建议「新增动作栏 + 清空移入设置页」，会把文本可见行压 -9% 并引入未被要求的 UI 变更；本方案只 -3%（§3.6） |
| S4 | **按 DPR 调列数与格高，而不是提高缩略图边长** | 240px 是「256 KiB 单帧」算出来的硬上限；384 的 PNG 存储块上界 590,321 B = 2.25×（§7.2） |
| S5 | **`previews(ids)` 在主进程内完成取字节 + 缓存 + 签 token** | 只有这样 `NOT_FOUND`/`UNTITLED` 这类逐项错误才可能**同步**返回（§5.1） |
| S6 | **不加 feature flag，用提交级回滚** | 加字段会被 `nativeRules` 透传给 Rust `deny_unknown_fields`（§6.1）；IPC 白名单要求一一对应，双通道并存是反模式（§9.3） |

### 0.6 需要拍板的 2 件事

| # | 问题 | 本方案默认 | 备选与代价 |
| --- | --- | --- | --- |
| **Q1** | 需求 3 是否「连文本全文一起删掉」 | **不删**：选中不弹，但保留显式「查看全文」浮层 | 全删：文本只剩 1 行预览，复制前无法确认全文；契约测试要改 5 条（§8.2）；人日 +0.5；`#detail` 系列 7 个 id 退役 |
| **Q2** | 「清空普通记录」按钮去留 | **保留**（仍在页脚，id `clear` 不动） | 移到设置页：属未被要求的 UI 变更，且会让 `clipboard.js:211` 的加载期 `$('clear').onclick` 抛 TypeError 杀死整个 renderer —— 若要做必须同批处理 |

> Q1 是**唯一**与「照字面执行」有出入的地方，且已按最保守的方式处理（不删功能、只改触发方式）。Q2 已改为**不做**（原稿的「移入设置页」被评审否决，见 §16）。

---

## 1. 现状与证据

### 1.1 用户看到的三件事，在代码里分别是什么

| 用户描述 | 代码事实 |
| --- | --- |
| 图片「没有缩略图，只有文案」 | `renderRows()` 对 `kind === 'image'` 写入 `t('clipboard.image-size', {width,height})` 这段文字（`clipboard/clipboard.js:63`）；行结构 = `badge(IMG) + 单行 preview + mono meta`（`clipboard.js:59-73`，样式 `clipboard.css:320-372`） |
| 「一点就弹详情，挤占列表」 | `select(id)` 除了选中还 `api.detail(id)` 并展开 `#detail`（`clipboard.js:125-150`）；`#detail` 是 `.panel` 的 flex 子项、`flex:0 1 auto; max-height:46%`（`clipboard.css:440-448`），`#list` 是 `flex:1`（`clipboard.css:277-285`）→ 必然压缩列表 |
| 「弹出后无法复原」 | 全页没有任何代码把 `#detail.hidden` 置回 `true` 而保留面板；唯一出口是 `Esc`（关的是**整个面板**，`clipboard.js:181`）或改选另一条。再次点击同一行只重复 `select()`（`clipboard.js:125-126`，无 toggle） |
| 「不知道列表里是哪张，得点开看」 | 详情那张图来自 `api.preview(id)`（`clipboard.js:140-148`），走 `highlighter-clipboard://preview/<token>`；列表行本身没有任何图像信息 |

**实测佐证**（`design-demos/shots/surfaces/REPORT.txt`，真实 Electron 截图夹具的 probe 输出）：

```
clipboard-list.light  ... "detailRect":"479x262@348","selectedRect":"64@169-233/view179 scrollTop0"
clipboard-image.light ... "detailRect":"479x275@334","selectedRect":"64@269-333/view165 scrollTop27"
```

`view179` / `view165` 即详情打开时 `#list.clientHeight` —— 从 440 掉到 165–179 DIP。「弹出后无法复原」和「挤占列表」在数据上是确凿的。

### 1.2 今天的几何（要被替换的不变量）

```
first   = max(0, floor(scrollTop / rowHeight) - 4)              // clipboard.js:55
end     = min(n, first + ceil(clientHeight / rowHeight) + 9)    // clipboard.js:56
spacer  = `${n * rowHeight}px`                                  // clipboard.js:57
rowTop  = `${index * rowHeight}px`                              // clipboard.js:60
键盘居中 scrollTop = max(0, index*rowHeight - clientHeight/2)   // clipboard.js:175,191
裁剪补偿 scrollTop = max(0, scrollTop - removed*rowHeight)       // clipboard.js:100（150 条上限）
```

全部依赖「所有行同高且无额外间距」。网格化后四条各自失效（§3.4 给出裁剪补偿的反例数值）。

### 1.3 今天的取图链路（要被替换的单活令牌）

| 环节 | 事实 |
| --- | --- |
| 渲染层 | 只对**选中的一条**请求：`api.preview(id)` → `<img src="highlighter-clipboard://preview/<uuid>">`（`clipboard.js:140-148`） |
| 主进程签发 | `preview()` **只签 URL，不读字节**；第一句 `revokePreviews()`（`tokens.clear()`，`index.js:23`），再塞 1 个新 token，TTL 60 s（`index.js:160-166`） |
| 主进程校验 | `handleResource` 要求 GET + hostname=`preview` + 无 query/hash + token 在表里 + generation 匹配 + 未过期 + 窗口可见 + owner 是当前 webContents（`index.js:73-85`；`:82` 在 `await` 后再查一遍防 TOCTOU） |
| 响应 | `Content-Type: image/png`、`nosniff`、`Cache-Control: no-store`、`CSP: default-src 'none'`；硬校验 mime/长度/≤256 KiB（`index.js:82-83`） |
| 数据源 | `<img>` 加载时才触发：`service.command('thumbnail', {id})` → 原生一次 RPC → 读 `thumbnails/<hash>.png`（`native/clipboard/src/main.rs:160-177`、`storage.rs:637-682`） |
| 会话 | 专用非持久 partition + `cache:false`（`index.js:99`）、权限全拒（`:100-101`）、页面 CSP `img-src highlighter-clipboard:`（`clipboard.html:3`） |

> **关键：今天的 `preview()` 不读字节。** 真正的原生读取发生在 `<img>` 发起协议请求时。这一点决定了 `previews(ids)` 的设计（§5.1）—— 见 §16 的 R1。

---

## 2. 需求解读与偏差声明

### 2.1 偏离风险最大的那条

需求 1、2 照字面执行没有歧义。需求 3「移除点击下方弹详情」如果理解成「文本也不能再看全文」，会**用图片的体验换掉文本的体验** —— 文本是剪贴板的主用例，复制前确认全文是刚需。

本方案的解读：**「移除」针对的是「自动触发 + 不可关闭 + 挤压列表」这三件事**，而不是「不再能看到全文」。因此单击/方向键 = 纯选中（零布局变化）；全文改为**显式**打开 + **可关闭** + **不改变列表几何**的浮层。这同时解掉「一弹出来就没法复原」和「挤占列表」两个具体抱怨。

### 2.2 偏差清单（评审请重点看）

| 偏差 | 说明 |
| --- | --- |
| 保留「查看全文」入口 | 与「移除弹详情交互」字面有出入。**这是唯一偏离**，且是显式按钮/`Space`，不再是点击副作用。若坚持全删，按 Q1 备选执行 |
| 图片格有 `aria-label` | 只在读屏时出现，**不占布局、不产生可见文案**。按评审意见已**去掉 `title`**（`title` 会产生可见悬停文案） |

---

## 3. 布局规格（渲染层）

### 3.1 几何真源：CSS 自定义属性 + 一层 DPR 媒体查询

现状是两处 64 靠测试锁步。网格需要 6 个量，继续双写不可维护。但 **DPR 无法从 CSS 读取**，所以采用「CSS 声明 + 媒体查询分档 + JS 只读」：

```css
/* 几何唯一来源。JS 用 getComputedStyle($('list')).getPropertyValue('--x') 读取，
   不得在脚本里写死像素。声明在 #list 上（不是 :root —— design-tokens 测试
   禁止本窗口自带私有 :root，见 test/design-tokens.test.js:136-143）。 */
#list {
  --row-h: 64px;        /* 文本/链接行高（与今天一致） */
  --cell-h: 92px;       /* 图片格高（与内容无关 → 追加分页不位移） */
  --grid-gap: 8px;      /* 格子与网格块间距；纯文本行之间为 0 */
  --grid-pad-x: 10px;   /* 网格左右内边距；上下内边距固定 0 */
  --tile-target: 110px; /* 密度目标：列数按它取整 */
  --tile-min: 72px;     /* 清晰度保护下限：为保清晰最多把格子压到这里 */
  --cols: 4;            /* JS 写入；CSS 只做兜底 */
  scrollbar-gutter: stable;   /* 见 §3.7 */
}

/* 格高随 DPR 分档收缩，保证 cell-h * dpr <= 240（原生缩略图长边上限）。
   这是纯 CSS 能表达的、唯一可靠的 DPR 感知方式。 */
@media (min-resolution: 2.25dppx) { #list { --cell-h: 80px; } }
@media (min-resolution: 2.5dppx)  { #list { --cell-h: 64px; } }
```

> `min-resolution: Ndppx` 在 Chromium 上按 `devicePixelRatio` 匹配（Windows 缩放 100/125/150/175/200/225/250/300% 分别对应 1/1.25/1.5/1.75/2/2.25/2.5/3 dppx）。

JS 侧：

```js
const FALLBACK = { rowH: 64, cellH: 92, gap: 8, padX: 10, target: 110, min: 72 }
function readMetrics() {
  const style = getComputedStyle($('list'))
  const num = (name, fallback) => {
    const px = parseFloat(style.getPropertyValue(name))
    return Number.isFinite(px) && px > 0 ? px : fallback
  }
  return { rowH: num('--row-h', FALLBACK.rowH), cellH: num('--cell-h', FALLBACK.cellH),
           gap: num('--grid-gap', FALLBACK.gap), padX: num('--grid-pad-x', FALLBACK.padX),
           target: num('--tile-target', FALLBACK.target), min: num('--tile-min', FALLBACK.min),
           dpr: window.devicePixelRatio || 1 }
}
```

**`devicePixelRatio` 变化必须监听**（评审提出，原稿确实漏了）：用户把窗口拖到另一块不同缩放的显示器时，`dpr` 变化但 `clientWidth` 可能完全不变，`ResizeObserver` 不会触发。必须同时监听 `matchMedia(...).addEventListener('change')` 与 `window.matchMedia` 的 dppx 分档，变化时重读 metrics + 重排 + 走 §3.4 的重锚定。契约测试要断言 `readMetrics()` 的输出包含 `dpr`。

### 3.2 列数公式（DPR 感知，含终止条件）

```
avail = list.clientWidth - 2 * padX
tile(c) = (avail - (c-1)*gap) / c

cols0 = clamp(round((avail + gap) / (target + gap)), 1, MAX_COLS)     // MAX_COLS = 12
n = cols0
while (n < MAX_COLS && max(tile(n), cellH) * dpr > 240 && tile(n+1) >= --tile-min) n++
```

三个关键点（都是评审修订的结果）：

1. **判据是 `max(tile, cellH) * dpr ≤ 240`，不是只看 `tile`** —— 原稿只看宽度，漏了「格高本身也可能超」这一半（§16 R5）。
2. **`--cell-h` 已经由 CSS 媒体查询按 DPR 收过一轮**，所以 `cellH*dpr` 永远不会超过 240（下表可验证）；加列只用于救**宽度**那一半。
3. **循环有两个独立终止条件**：`n` 触顶 `MAX_COLS`，或**再加一列就窄于 `--tile-min`**。没有第二个条件时，公式会在窄面板 + 高 DPR 下把格子无限压小（原稿没写这个条件，§16 的 R5）。

默认 480×640 面板（`#list.clientWidth = 480 − 2(面板边框) − 9(scrollbar-gutter) = 469`，`avail = 449`）：

| DPR | cols | tile DIP | cellH DIP | 长边设备像素 | 源/设备 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 1.00 | 4 | 106.3 | 92 | 106 | 2.26× | 过采样 |
| 1.25 | 4 | 106.3 | 92 | 133 | 1.81× | 过采样 |
| 1.50 | 4 | 106.3 | 92 | 159 | 1.51× | 过采样 |
| 1.75 | 4 | 106.3 | 92 | 186 | 1.29× | 过采样 |
| 2.00 | 4 | 106.3 | 92 | 213 | **1.13×** | 过采样（常规档最紧） |
| 2.25 | 4 | 106.3 | 80 | 239 | **1.00×** | 恰好贴线 |
| 2.50 | 5 | 83.4 | 64 | 209 | 1.15× | 升列保清晰 |
| 3.00 | 5 | 83.4 | 64 | 250 | **0.96×** | 触到 `--tile-min` 停手，约 4% 上采样 |

**残余上采样是显式取舍，不是遗漏**：扫描 8 档 DPR × 11 档面板宽度（380–1200）= 88 组合，其中 **7 组**（全部是 DPR 3.0）落在 0.88–1.00×：380→0.98、420→0.88、480→0.96、560→0.98、640→1.00、1080→1.00、1200→0.89。原因：这些档位已经触到 `--tile-min: 72px` 或 `MAX_COLS: 12`（1200 宽时 12 列已达上限，格子 90.1 DIP × 3 = 270 设备像素）。再压格子的代价（认不出内容）大于 12% 的轻微放大。**300% 缩放是已知且可接受的边界**，T07 要在真机确认观感；若不可接受，唯一低风险解法是给 DPR ≥3 再加一档 `--cell-h: 56px` 并把 `MAX_COLS` 提到 16（一行 CSS + 一个常量，无架构影响）。

### 3.3 布局模型（纯函数，可单测）

新文件 `clipboard/clipboard-layout.js`，UMD 形状与 `shared/usage-format.js:1-20`、`capture/selection-utils.js:1-6` 一致（渲染层 `<script>` 载入，`node:test` 直接 `require`）。

```js
// 行模型：连续图片聚成一个 images 块（每排 ≤ cols），文本/链接各占一整行。
function layout(items, m) {
  const rows = [], itemRow = [], itemCol = []
  let y = 0, i = 0
  while (i < items.length) {
    if (items[i].kind === 'image') {
      // 只在上一行是文本行时加前导 gap：连续两个图片块之间，前一块的尾随
      // gap 已经覆盖了间距，无条件加会变成 cellH + 2*gap（实测 4 列 pitch=116）。
      if (rows.length && rows[rows.length - 1].type === 'row') y += m.gap
      const cells = []
      while (i < items.length && items[i].kind === 'image' && cells.length < m.cols) {
        itemRow[i] = rows.length; itemCol[i] = cells.length; cells.push(i); i++
      }
      rows.push({ type: 'images', y, h: m.cellH, items: cells })
      y += m.cellH
      if (i < items.length) y += m.gap                  // 网格块 → 任意行，下间隙
    } else {
      itemRow[i] = rows.length; itemCol[i] = 0
      rows.push({ type: 'row', y, h: m.rowH, items: [i] })
      y += m.rowH; i++
    }
  }
  return { rows, itemRow, itemCol, height: y }
}
```

必须写成单测的不变量：

1. `itemRow/itemCol` 恰好覆盖 `[0,n)` 各一次；
2. 行 y 单调，`next.y === cur.y + cur.h + gapBetween`，`gapBetween = (cur 或 next 是 images) ? gap : 0`；
3. **退化性**：全文本输入 → `rows[i].y === i*rowH` 且 `height === n*rowH`（与今天逐字节等价，这是「文本用户零回归」的证明）；
4. 图片只与图片同排、每排 ≤ cols、列号从 0 连续；文本行恰好 1 格；
5. `height === 末行 y + 末行 h`，无尾随空白，无重叠。

### 3.4 虚拟窗口、滚动锚定与 150 条裁剪

**窗口**（按行，不按 index）：

```
rFirst = max(0, rowAt(scrollTop) - OVERSCAN)                  // OVERSCAN = 2 行
rLast  = min(rows.length-1, rowAt(scrollTop + clientHeight) + OVERSCAN)
spacer = `${layout.height}px`
```

`OVERSCAN=2` 对文本行是 128px、对图片块是 200px，比现状的 9 行（576px）小 —— 因为每排现在渲染 4 张图，节点数已经上去了（§3.9）。

**裁剪补偿**（替换 `clipboard.js:100`）：必须在**改 items 之前**取锚点，在**设完新 spacer 之后**写 `scrollTop`：

```js
const st = list.scrollTop, view = list.clientHeight
const r = layout.rows[rowAt(layout, st)]
const anchorId = items[r.items[0]].id          // 顶部行的第一格
const inner = st - r.y
items.splice(0, removed)
updateGeometry()                                // 先把 spacer 设成新高度
const at = items.findIndex((item) => item.id === anchorId)
list.scrollTop = at < 0
  ? 0
  : clamp(layoutNew.rows[layoutNew.itemRow[at]].y + Math.min(inner, layoutNew.rows[layoutNew.itemRow[at]].h),
          0, layoutNew.height - view)
```

**反例（为什么旧公式不能外推）**：200 条全图片、4 列（pitch = 92+8 = 100）、`scrollTop = 3000`，一次裁掉 50 条（12.5 排）：
- 正确：锚点约在第 25 排（y≈2400），裁剪后落到第 12.5 排附近 → `scrollTop ≈ 1128`；
- 旧公式：`3000 - 50*64 = 0` → **跳到列表顶部**，当前阅读位置整屏丢失。

纯文本序列里旧公式**恰好精确**（`removed*64` 等于真实位移），这正是它当年能工作的原因，也是不能外推到网格的原因 —— §3.3 的「退化性」不变量把这个特例钉住。

**追加分页**：布局从头部顺序生成且行高与内容无关 → 追加只在**尾部**新增行，`append=true` 时**不写 `scrollTop`**（保持 `clipboard.js:91,98` 的语义）。这是「禁止 masonry / 禁止按宽高比变高」这条硬约束的直接理由。

### 3.5 键盘模型（二维）

`r/c = layout.itemRow[i] / itemCol[i]`：

| 键 | 行为 |
| --- | --- |
| ↑ / ↓ | 视觉上一行/下一行同列（`r±1`，`c' = min(c, rows[r'].items.length-1)`） |
| ← / → | 阅读序 `index±1`（满排内即左右移格，行尾即下一行首格） |
| Home / End | 第 1 条 / 最后 1 条 |
| PageDown / PageUp | `scrollTop ± clientHeight*0.9` 后取该处行、保持列 |
| Enter | 复制（不变，`clipboard.js:176-178`） |
| Ctrl/Cmd+Enter | 粘贴（不变） |
| Delete | 删除（不变，`clipboard.js:179`） |
| **Space（新增）** | 打开/关闭文本全文浮层（图片无动作） |
| Esc | **先关浮层**，浮层已关才关面板（改 `clipboard.js:181`） |

> ↑/↓ 从「index±1」改成「视觉行同列」是**有意的行为变更**：满排里 `index+1` 会表现为横向移动，与二维网格直觉冲突；←/→ 保留阅读序，保证列表顺序永远可达。

选中态滚动：`scrollTop = clamp(row.y + row.h/2 - view/2, 0, height - view)`。

### 3.6 垂直空间账（默认 480×640）

现状 chrome：topbar 52 + status-rail 30 + search(34+18) + chips(24+10) + footer(30+1) + 面板边框 2 = **200 DIP** → `#list` = 439（旧文档里的 440 是舍入）。

本方案**不新增栏，只把页脚从 31 加高到 45 DIP**（动作放进页脚；「清空」保留）：

| 项 | 现状 | 本方案 |
| --- | --- | --- |
| chrome | 200 | 200 − 31 + 45 = **214** |
| `#list` | 439 | **425** |
| 可见文本行（64px） | 6.86 | **6.64**（−3.2%） |
| 可见图片格（4 列，pitch = 92+8） | —（0 张能认） | 4 排 × 4 = **16 格** |
| 详情打开时 `#list` | **165–179**（实测，被压到 46% 以内） | **425**（浮层不参与 flex 流） |

对比原稿（新增第二条 44px 栏 + 清空移入设置页，`#list` ≈ 396、文本行 ≈ 6.19）：本方案让文本用户少损失约 6 个百分点，且不需要动设置面、不需要删 `clear` 元素。

**页脚宽度预算**（最小窗 380 时 `#list` 内容宽约 339 DIP）——按此顺序降级，禁止 `flex-wrap`（会改高度、破坏 pitch 契约）：

1. `查看全文` 在非文本记录下 `hidden`（图片格选中时本来就没意义）；
2. `清空` 用与今天 `.footer .quiet-button{font-size:10.5px;padding:0 7px}` 一致的紧凑样式；
3. 仍溢出时按钮允许 `min-width:0` + `text-overflow:ellipsis`，**不得换行**。

T07 必须在 380 宽度下目测这一行不溢出。

### 3.7 列数翻转防护（滚动条振荡）

`clipboard.css:691` 是经典 9px 滚动条；内容从「不需要滚」变「需要滚」时 `clientWidth` 少 9px，可能跨过列数阈值 → `resize → 改列 → 改高度 → 滚动条消失 → 改列` 振荡。三重防护：

1. `#list { scrollbar-gutter: stable; }`（Chromium 94+，Electron 43 满足）→ gutter 常驻，`clientWidth` 恒定；
2. 列数只在 `clientWidth` 变化 >1px 时重算，算出来和上次相同就**不重建 layout**；
3. 列数变化必须走 §3.4 的重锚定（禁止裸 `renderRows()`，否则跳位）。

### 3.8 渲染节流与图片加载

现状每次滚动都 `replaceChildren()` 全量重建（`clipboard.js:57`）且无节流（`:168`）。图片时代会变成「每帧新建 `<img>` → 每帧重新发请求 → 闪烁 + 请求风暴」，且响应头是 `no-store`（`index.js:83`）。

必须做到：

1. `onscroll` 走 `requestAnimationFrame`；
2. `(rFirst, rLast, cols, 语言)` 都没变 → 只同步选中态，**不重建 DOM**（语言变化是例外，见 §3.10）；
3. 渲染层维护 `urlCache: Map<itemId, url>`，在 `onHistory` / `hidden` / `delete` / 清空时清空（与主进程撤销时机对齐）；
4. `img.decoding = 'async'`；**不用** `loading="lazy"`（已是虚拟窗口，lazy 只会引入二次布局）；
5. **`<img>` 必须有 `error` 兜底**：失败重试 1 次（500 ms 后），再失败置 `data-state="failed"` 显示中性占位（CSS 绘制，不能用图片资源 —— `test/clipboard-ui-contract.test.js:153` 禁止 `clipboard.css` 出现 `url(`）。
   > 硬契约：`hide()` 会清空 token（`index.js:51`），已赋 `src` 但未加载完的格会**永久留白**（渲染层以为 URL 拿到了，不会重试）。不做重试就是「切一下窗口回来，后面几张图永远空白」。
6. **`<img>` 的 `src` 只能在 `onInit` 之后、拿到真实 URL 时才设置**；`previews` 失败时**不要赋 `src`**。原因见 §9.4 第 5 条：窗口安全探针会把 `ERR_UNKNOWN_URL_SCHEME` 当失败。

### 3.9 DOM 与内存量级

| 指标 | 数值 |
| --- | --- |
| 一屏可见格 | 16（425 / 100 ≈ 4.25 排 × 4 列） |
| 渲染节点上限（含 overscan 2 排） | 约 6 排 × 4 × (`div.tile`+`img`) + 6 ≈ 54 |
| 现状文本列表节点数 | 约 70（`REPORT.txt` 实测 `nodes=95` 含 chrome） |
| 单张解码内存 | 240×240 RGBA ≈ 225 KiB；16:9 实际 `240×135` ≈ 127 KiB |
| 一屏解码峰值 | ≈ 2–3 MiB |

### 3.10 状态转移表（评审要求补，原稿只有公式没有状态机）

`renderRows()` 与 `refresh()` 的现有职责被拆开后，以下 7 个入口必须各自定义「选中项、锚点、URL、是否重建」：

| 入口 | 触发 | 选中项 | 滚动锚点 | urlCache | DOM |
| --- | --- | --- | --- | --- | --- |
| `init` | `onInit` | 清空 | 置 0 | 清空 | 全量重建 |
| `replace` | 搜索/筛选/刷新 | 若仍在列表内保留，否则清空 | **置 0** | 清空（列表换代） | 全量重建 |
| `append` | 「加载下一页」 | 保留 | **不动** | 保留 | 只追加新行 |
| `delete` | 删除 / 清空 | 清空（若删的是选中项） | 保留下一条为锚 | 清空 | 全量重建 + 重锚 |
| `language` | `onLanguage` | 保留 | 不动 | 保留 | **强制全量重建**（`aria-label` 是本地化文案，不重建会留旧语言） |
| `hidden` | `onHidden` | 清空 | 置 0 | 清空 | 清空 rows |
| `feedback` | `onPasteResult` | 清空 | 置 0 | 清空 | 进 `feedback-only` 态 |

契约测试断言：语言切换后必须重新设置 `aria-label`（可以用「`renderRows` 的调用参数包含语言」或「`onLanguage` 分支调用全量重建」来断言）。

---

## 4. 视觉规格（Nightshift 语言）

只列新增/改动；配色一律走 token（`test/design-tokens.test.js:142` 禁止 `clipboard.css` 出现任何十六进制）。

```css
/* 图片块：一行一个 grid，列数由 JS 写入 --cols */
.grid-row {
  position: absolute;
  left: var(--grid-pad-x);
  right: var(--grid-pad-x);
  height: var(--cell-h);
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  gap: var(--grid-gap);          /* 列间距；行间距由布局模型的 gap 承担，不要再加 margin */
}

/* 单格：干净底板，不留白边 */
.tile {
  position: relative;
  min-width: 0;
  height: var(--cell-h);
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--line);
  cursor: default;
}
.tile img { display: block; width: 100%; height: 100%; object-fit: contain; }

/* 选中：内描边环（被裁在视口边缘时不会外溢，比 outline 稳） */
.tile[aria-selected="true"] { box-shadow: inset 0 0 0 2px var(--primary); }

/* 置顶：6px 色点，不使用文字 */
.tile[data-pinned="true"]::after {
  content: "";
  position: absolute; top: 6px; right: 6px;
  width: 6px; height: 6px; border-radius: 2px;
  background: var(--primary-text);
}

/* 加载失败：中性板 + 两条对角线（CSS 绘制，不用图片资源） */
.tile[data-state="failed"] { background: var(--surface-3); }
.tile[data-state="failed"]::before,
.tile[data-state="failed"]::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 14px; height: 1px; background: var(--line-2);
}
.tile[data-state="failed"]::before { transform: translate(-50%, -50%) rotate(45deg); }
.tile[data-state="failed"]::after  { transform: translate(-50%, -50%) rotate(-45deg); }
```

约束（既有测试钉死的）：不得用 CSS `url()`（`clipboard-ui-contract.test.js:153`）、不得用 `style="…"` 内联属性（`:149`）、不得 inline script（`:148`）、不得用 emoji 当图标（`design-tokens.test.js:170-182`）；图片只能走 `<img src="highlighter-clipboard://…">`（CSP `img-src` 只开该协议，`clipboard.html:3`）。

### 4.1 列表布局（ASCII 线框）

```
┌────────────────────────────────────────────────┐ 480 DIP
│ 剪贴板历史  [本地]               暂停记录   ×  │ topbar 52
├────────────────────────────────────────────────┤
│ ● 正在记录 · 184 条 · 5.1 MiB          刷新    │ status 30
├────────────────────────────────────────────────┤
│ ⌕ 搜索历史文本                                 │ search 52(含 margin)
│ [全部] 文本  链接  图片            □ 置顶      │ chips 34
├────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │ ← 图片块（images row）
│ │  img │ │  img │ │  img │ │  img │            │   高 92 DIP
│ └──────┘ └──────┘ └──────┘ └──────┘            │   4 列 × 106 DIP
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │
│ │  img │ │  img │ │  img │ │  img │            │
│ └──────┘ └──────┘ └──────┘ └──────┘            │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │
│ │  img │ │  img │ │  img │ │  img │            │
│ └──────┘ └──────┘ └──────┘ └──────┘            │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │
│ │  img │ │  img │ │  img │ │  img │            │
│ └──────┘ └──────┘ └──────┘ └──────┘            │
│ 把这段关于暗色模式对比度的评审意见…            │ ← 文本行（整行，64 DIP）
│ 微信 · 10/22 21:45 · 114 B                     │
│ https://github.com/highlighter-app/…           │
│ Google Chrome · 10/22 21:42 · 62 B             │
├────────────────────────────────────────────────┤
│ [复制] [粘贴] [查看全文]          [置顶][删除] │ ← 原页脚加高为 45 DIP
│                    浮层（按需，overlay） 清空 │
└────────────────────────────────────────────────┘
```

要点：图片块与文本行**在同一滚动序列里混排**，顺序就是后端返回的顺序（`pinned DESC, pinned_order DESC, sort_at DESC, id DESC`，`native/clipboard/src/storage.rs:567-570`），前端不重排。

---

## 5. 取图链路规格（主进程）

### 5.1 契约：`clipboard:preview` → `clipboard:previews`

**关键设计决定（评审修订 R1）**：今天的 `preview()` **不读字节**，只签 URL；真正的读取发生在 `<img>` 发起协议请求时。所以「同步返回逐项 `NOT_FOUND`」在原设计下**不可能实现**。为了让错误能在 IPC 返回时就被渲染层看到（而不是变成 `<img>` 的静默 404），`previews(ids)` 改为**在主进程内完成取字节 + 缓存 + 签 token**：

```
previews(ids):
  1. 校验窗口可见 + generation
  2. 对每个 id（池 8 并发）：
       LRU 命中 → 复用 bytes
       未命中   → service.command('thumbnail', {id}) → 得到 bytes
       失败     → 记该 id 的逐项错误
  3. 为成功的 id 签发 token（指向「已缓存的 bytes」，不再二次读盘）
  4. 返回 [{id, url} | {id, error}]
```

`handleResource` 仍然保留原有的 7 项校验（token / generation / 可见性 / owner / await 后复查 / mime / 长度 ≤256 KiB），只是字节从 LRU 取而不是再发一次 RPC。

| 项 | 规格 |
| --- | --- |
| 通道名 | `clipboard:previews`（复数）。**替换**旧通道，不并存（§9.3） |
| 入参 | `{ ids: string[] }`，长度 **1–64**，逐项过 UUID 正则（复用 `clipboard-ipc.js:7` 的 `id()`），内部 `new Set` 去重 |
| 出参 | 与入参顺序对齐，逐项 `{ id, url }` 或 `{ id, error: 'NOT_FOUND' \| 'UNSUPPORTED' \| 'BACKPRESSURE' \| 'WINDOW_NOT_VISIBLE' }` |
| 窗口不可见 | 返回逐项 `WINDOW_NOT_VISIBLE`，**不 throw**（现状 `index.js:161` 是 throw） |
| 校验 | `object(args, ['ids'])` 拒绝多余键（`clipboard-ipc.js:3-6`）；错误码必须匹配 `/^[A-Z_]{1,64}$/` 否则被降级为 `CLIPBOARD_FAILED`（`:11`） |
| **不做的** | **不做**跨批预取、**不做**速率令牌桶（原稿有，评审判定为未证明必要的复杂度，已删，见 §16 N4） |

**为什么改完还是原子提交**：T02 必须**同批**改主进程、preload 与渲染层的那一个调用点（`clipboard.js:141` 的 `api.preview(id)` → `api.previews([id])`），否则 T02 一落地现有渲染层就调用不存在的 `api.preview`，应用当场坏掉（§16 R4）。

### 5.2 为什么必须改（确定性失败推导）

若渲染层按最自然的写法 `Promise.all(ids.map(id => api.preview(id)))`：

```
ipcMain.handle 的 N 次调用在主进程事件循环里同步顺序执行：
call_1  tokens={} → {t1}
call_2  tokens={} → {t2}      // t1 被抹掉
…
call_N  tokens={} → {tN}
```

Promise 全部 resolve，渲染层拿到 N 个 URL，但 `tokens` 只剩 `tN`。`<img>` 加载时 `handleResource`（`index.js:78`）对 N−1 个返回 404。**结果恰好 1 张成功，顺序完全确定，不是竞态** —— 这种「看起来像偶发、实际必现」的形态最容易在验收时被误判为环境问题。

即便去掉「先清后设」，第二道墙仍在：`pending.size >= 16` 直接 `BACKPRESSURE`（`clipboard-service.js:151`），而 `command()` 只 `await this.serial`，不构成串行化（`:188-197`）。

第三道墙是**粘性**的：`hide()` 清空 token（`index.js:51`），已赋 `src` 未加载完的格永久留白（§3.8 第 5 条）。

### 5.3 token 表：从「单活」到「有界集合」

| 项 | 现状 | 本方案 | 理由 |
| --- | --- | --- | --- |
| 数量 | 1（每次全清） | **每窗口 128 个**，超限按插入序淘汰最旧 | 128 = 一屏 16 + 一屏回滚 + 余量；与 LRU 条目上限同值 |
| TTL | 60 s（`index.js:164`） | **300 s** | 真正的限制是「窗口可见 + owner + generation」（`:79`）；TTL 只是兜底，hide 仍全清 |
| `previews` 自身 | 先全清 | **不清** | 核心改动 |
| `on('history')` | 清 token（`:25`） | **不清 token，只清 LRU** | 见下面这条 |
| `hide` / `release` | 全清（`:34,:38,:51`） | 保留 | 面板不可见后 URL 必须立即失效 |
| `delete` / `commit-clear` | 全清（`clipboard-ipc.js:31,35`） | 保留（并清 LRU） | 操作后本来就重渲染 |

> **评审修订 R3：`on('history')` 不清 token，但必须清 LRU。** 原稿写「不清 token、也不清 LRU」，理由是「缩略图不可变」。评审指出这会造成**已删除内容仍可读**：后台 `maintain()`（`native/clipboard/src/storage.rs:872-889`）会按保留期/条数删记录，而删除**不会**发 `history` 之外的精确失效信号；旧 token + LRU 命中就能继续返回已删图片。
> 正确做法：**token 不清**（保住网格，不受「别的应用复制一次就整屏失效」影响），但 **LRU 在每个 history revision 变化时清空**。这样下一次协议请求必然回原生读盘，已删 id 得到 `NOT_FOUND` → 404。代价是新复制一条内容会让缩略图缓存整体失效一次，而 history 变化频率远低于协议请求频率，可接受。

### 5.4 并发池（放主进程）

| 参数 | 值 | 依据 |
| --- | --- | --- |
| 池大小 | **8** | 必须 <16（`clipboard-service.js:151` 背压），给 2 s status 轮询与 `maintenance` 留槽 |
| 去重 | `Map<id, Promise>` 同批合流 | 分页边界可能重复渲染同一 id |
| 取消 | 队列级丢弃；**在飞不杀** | 杀在飞请求要处理原生半开帧 |
| 超时 | **不新增逐项超时**（保留 service 现有 5000 ms 语义） | 见下 |

> **评审修订 R2**：原稿写「单张 50 ms 超时 + 逐项 TIMEOUT」，但 `ClipboardService.request()` 的超时走的是 `failChild()`（`clipboard-service.js:154`，`setTimeout(() => this.failChild(child, 'BACKEND_TIMEOUT'))`）—— **会杀掉整个 sidecar**，不是逐项失败；而且 T02 的写作用域里根本没有 `clipboard-service.js`。
> 处理：**本期不新增逐项超时**，沿用 5000 ms。如果将来确实需要，正确做法是给 `request()` 加一个「非致命的超时」参数（`clearTimeout` + 从 `pending` 删除 + reject），这在协议上是安全的 —— 迟到的响应会因 `this.pending.get(requestId)` 为空而被 `continue` 丢弃（`clipboard-service.js:121-124`）。但那是**独立一期**的 service 改动，不塞进本任务。

### 5.5 主进程 LRU

| 项 | 值 | 推导 |
| --- | --- | --- |
| 键 | item id | `delete`/`clear` 可按 id 精确失效 |
| 条目上限 | **128** | 一屏 16 + 回滚 16 + 分页 50 + 余量 ≈ 82 → 取整 128 |
| 字节上限 | **8 MiB** | 128 × p95(60 KiB) = 7.5 MiB；最坏单张 192.4 KiB（实测 240 噪声）→ `8 MiB / 192.4 KiB = 42 条 ≥ 一屏 16`，余量充足 |
| 失效 | `delete`/`commit-clear` 按 id 删；**history revision 变化全清** | §5.3 |
| HTTP 层 | 继续 `Cache-Control: no-store` | URL 是**能力**不是稳定资源；partition 本来就是 `cache:false`（`index.js:99`） |

### 5.6 原生侧最危险的一条：MISSING 自愈（评审修订 R6）

`payload(thumbnail=true)` 命中 `ATTACHMENT_MISSING` 时会**同步、持 store 互斥锁**地解码整张原图（≤16 MiB）再重生成缩略图（`storage.rs:648-659`）；采集线程用的是同一把锁。实测单张 2560×1440 解码 ≈17 ms；多张同时 MISSING 会累计持锁时间，把 `captureBusyMs` 推向 `clipboard-service.js:165` 的 3000 ms 红线 —— 超过即 `failChild('CAPTURE_BLOCKED')`，**整个剪贴板后台被杀**。

> **原稿写「MISSING 自愈并发 ≤2」，评审指出这做不到**：自愈发生在 native 的 `payload()` 内部且对主进程透明，主进程**无法区分**哪些请求会触发自愈。因此该验收项已删除。
> 保留下来的唯一有效杠杆是**池大小 8**（它同时是自愈并发的上界）。T07 要实测「冷缓存下打开一屏全 MISSING 的面板」时的 `captureBusyMs` p99；若超过 500 ms，把池降到 4（一行常量），并在文档记录实测值。

### 5.7 威胁模型（放宽令牌后的增量）

| 攻击面 | 变更前 | 变更后 | 结论 |
| --- | --- | --- | --- |
| 猜 token | 122 bit 熵，不可行 | 同 | 无变化 |
| 其它窗口复用 URL | 被 owner + generation 挡（`index.js:79`） | 同 | 无变化 |
| 面板隐藏后仍可读 | hide 已全清 | hide 仍全清 | 无变化 |
| 已删除记录仍可读 | 不可能（每次 preview 全清 + 单 token） | **需要 LRU 在 history 变化时清**，否则可能 | **已按 §5.3 处理** |
| 渲染层被攻破 | 最多读当前 1 张 | 最多读当前 ≤128 张（= 屏幕本来就能看到的） | 增量≈0 |
| 外泄 | `connect-src 'none'` + 导航拦截 | 同 | 无变化 |
| 资源耗尽 | — | 批 ≤64 + 池 8 | 需实现，非安全边界 |

---

## 6. i18n 与设置

### 6.1 不新增任何设置项

网格列数不做用户可配项，由实测宽度 + CSS 媒体查询推导。新增 `clipboard.*` 字段会连锁踩 6 处，其中一处只在真机炸：

| # | 位置 | 后果 |
| --- | --- | --- |
| 1 | `main/services/clipboard-settings.js:2-3` `DEFAULT_CLIPBOARD` | 默认值进 `settings:reset` 语义 |
| 2 | 同文件 `:5-13` `assertClipboardSettings` **不校验未知键** | 不改会静默透传 |
| 3 | 同文件 `:18` `nativeRules()` 只剥 `enabled/paused/releaseAfterMs`，**其余全部透传** | 新字段会进 Rust |
| 4 | `native/clipboard/src/storage.rs:35-37` `deny_unknown_fields` | 多一个字段 → configure 失败 → 后端 `phase:error`（**只在真机暴露**） |
| 5 | `main/services/settings-defaults.js:19`、`settings-validation.js:30-33` | 不加白名单用户改不动 |
| 6 | `config/routes/clipboard.js:4-5` + 三语表 + `settings-effects` 的 effect id 契约 | 四处同步 |

### 6.2 新增 i18n key（放 `shared/locales/clipboard.js`，三语同批）

| key | zh-CN | en-US | zh-TW |
| --- | --- | --- | --- |
| `clipboard.view-text` | 查看全文 | Show full text | 檢視全文 |
| `clipboard.thumbnail-unavailable` | 缩略图不可用 | Thumbnail unavailable | 縮略圖無法使用 |

- **不新增**尺寸类 key：`clipboard.image-size`（`shared/locales/clipboard.js:36,120,204`，三语齐全）已存在，改为 `aria-label` 用途即可。
- 预算：`check:i18n` 当前 **TOTAL 585 / 上限 606**（余 21 行），`clipboard` 分区 **0 行**。该扫描器**逐行匹配 CJK 且不区分注释**（`scripts/check-i18n.js:163-188`），因此 **`clipboard/*` 下新增注释一律写英文**。
- `shared/locales/` 不在扫描区，加 key 不推高 585；但 `test/clipboard-ui-contract.test.js:199-241` 会检查 `clipboard.js` 里每个 `clipboard.*` 字面量在三张表都存在。

### 6.3 「清空」按钮保留

原稿建议移入设置页，**评审否决**（属未被要求的 UI 变更；且会让 `clipboard.js:211` 的加载期 `$('clear').onclick` 抛 TypeError）。本方案：`clear` 留在页脚，只是页脚加高为动作栏，`clear` 用既有 `.footer .quiet-button` 紧凑样式。**`clear` 相关契约测试与加载期绑定完全不动。**

---

## 7. 原生侧：零改动（含否决算术）

### 7.1 现状能力已经够用

缩略图在**采集时**就已生成并落盘：`images.rs:93-99` 做 `thumbnail(240,240)` 编码 PNG（≤256 KiB），`storage.rs:653-657` 存 `thumbnails/<sha256>.png`；读时 `payload(id, thumbnail=true)` 命中即用，缺失才自愈。本方案不需要任何新的原生能力 → native 零改动，`test:clipboard:native` 应原样通过（T01 记基线，T07 复核）。

### 7.2 为什么不能简单把边长提到 384（算术证明）

PNG 最坏情况是 zlib 退化为 stored block（每 65,535 B 加 5 B 头）：

```
raw    = N²·4 + N                        // +1 filter byte/scanline
blocks = ceil(raw / 65535)
zlib   = raw + blocks·5 + 6
png    = 8 + 25 + (12 + zlib) + 12
```

| N | raw | blocks | PNG 上界 | vs 256 KiB (262,144) |
| --- | --- | --- | --- | --- |
| **240** | 230,640 | 4 | **230,723 B = 225.3 KiB** | ✓ 余量 31,421 B（12.0%） |
| 255 | 260,355 | 4 | 260,438 B | ✓ 余量 1,706 B（**0.65%**） |
| 256 | 262,400 | 5 | 262,488 B | ✗ 超 344 B |
| **384** | 590,208 | 10 | **590,321 B = 576.5 KiB** | ✗ **2.25×** |

（该算术经独立评审逐字节复核无误。）实测交叉验证（zlib level 6、不可压缩噪声）：240 = 192.4 KiB，384 = 492.1 KiB = 1.92× 单帧块上限。

**所以「240」不是随手取的**：它是「256 KiB ÷ 4 B/px」的平方根 256 再留 6.25% 线性余量。单帧上限下的边长硬上限是 **255**。

代价链：只改边长不改 `images.rs:97` 的 256 KiB 守卫 → 错误沿 `storage.rs:361` 上传 → 记为 `invalid_image` → **整条图片记录被丢弃**（不是「缩略图缺失」）。只改守卫就要把 `MAX_CHUNK` 从 256 KiB 抬到 ≥640 KiB（`shared/clipboard-protocol.js:7` + `native/clipboard/src/protocol.rs:8`，**两份手抄常量、无一致性测试**），而它同时是**接收端单帧分配上界**（`clipboard-protocol.js:55`）。

### 7.3 替代方案裁决

| 方案 | 改动面 | 裁决 |
| --- | --- | --- |
| **D1 保持 240 + DPR 感知列数/格高** | 仅渲染层 | **本期采用**；回滚 = 改常量 |
| D2 换 WebP-lossless 做到 360–384 | native 编码器 + 扩展名 + 读侧尺寸解析 + mime + `Cargo.lock` | **推迟**（收益真实：384 噪声 30.9 KiB = PNG 的 1/16；但见下） |
| D3 换 JPEG | 同 D2 | **否决**：384 纯色 UI 48 KiB = WebP-lossless 的 315 倍；文字边缘振铃；无 alpha |
| D4 只抬 `MAX_CHUNK` 到 640 KiB | 两份协议常量 + 守卫 | **否决**：4× 字节换 1.6× 分辨率，两进程分配上界同抬 |
| D5 主进程降采样原图 | main + 内存 | **否决**：破坏「原图只在 native 侧」的边界 |
| D6 网格用 `object-fit: cover` | 仅 CSS | **否决**：16:9 素材短边只有 240×135，`cover` 在任何 DPR 下都是 0.46–0.92× |

D2 为什么推迟而不是「顺手做」—— 四个连锁陷阱：
1. `native/clipboard/Cargo.lock` 里**没有** `image-webp`，加 feature 后 `cargo build --locked`（`scripts/build-clipboard-native.js:29`）直接失败；
2. `sourceBuildId()` 把 `Cargo.toml`+`Cargo.lock`+`src/**` 全纳入哈希（`build-clipboard-native.js:9-24`）→ build id 变 → 若 `bin/build-info.json` 没重建，`clipboard-service.js:136` 抛 `INCOMPATIBLE_BACKEND`（表现为「剪贴板后端不可用」）；
3. 缩略图 `mime` 来自 payload 行、恒为 `image/png`（`storage.rs:641,681`）→ `handleResource` 的 mime 硬校验（`index.js:82`）会让**改后全部 404 且无日志**；
4. 存量 `.png` 与新 `.webp` 并存 → 老图全走同步自愈（§5.6 的锁争用）。

四条各自都不难，但同时出现在一个提交里，回滚粒度就没了。**列为独立一期。**

---

## 8. 交互与可访问性

### 8.1 交互矩阵

| 操作 | 图片格 | 文本/链接行 |
| --- | --- | --- |
| 单击 | 只选中（无详情、无布局变化） | 只选中 |
| 双击 | 复制（不变） | 复制（不变） |
| Enter / Ctrl+Enter | 复制 / 粘贴 | 同 |
| Delete | 删除 | 删除 |
| Space | 无动作 | 打开/关闭全文浮层 |
| Esc | 面板关闭 | 先关浮层，再关面板 |
| 方向键 | 二维移动 | 同（文本行 `c` 恒为 0） |

### 8.2 契约测试改写（`test/clipboard-ui-contract.test.js`，基线 13/13 绿）

| 行 | 断言 | 判定 | 处理 |
| --- | --- | --- | --- |
| **156-168** | 行高锁步 + `${items.length*rowHeight}px` + `${index*rowHeight}px` | **必然红（4 条）** | 整条重写为「几何单一真源」：6 个 CSS 变量必须声明在 `#list`、`.row{height:var(--row-h)}`、`.grid-row{height:var(--cell-h)}`、**禁止**写死像素与 `const rowHeight = \d+`；`${layout.height}px` / `${row.y}px` 必须出现；断言 `readMetrics()` 含 `dpr` |
| 68-74 | 27 个 contract id 全在 | 绿 | 追加 `actions`（若新增）/`list-wrap`/`view` 到列表；**`clear` 保留**（§6.3） |
| 125-126 | `feedback-only` 必须隐藏 `#detail` | 绿 | 顺带把 `.list-wrap` 补进那个 CSS 块（测试只查那 9 个，多写不红，漏了会视觉破） |
| 176-179 | `.row-meta`/`.detail-meta` 为 mono | 绿（两者都保留） | — |
| 184-197 | `.row[aria-selected]` 左竖条、`#copy` 是 primary | 绿 + **新增**格子选中环断言 | 补 `assert.match(css, /\.tile\[aria-selected="true"\]\s*\{[^}]*inset 0 0 0 2px var\(--primary\)/)` |
| 140-154 | CSP / 无内联 / 无 `url(` | 绿（只要不放宽） | 新增：格子缩略图必须来自 `highlighter-clipboard://` |
| 199-241 | i18n 三语齐全 | 绿（2 个新 key 同批入表） | — |

**Q1 备选（若决定连文本全文一起删）**：`68-74`、`125-126`、`176-179` 三条转红，`referenced.length >= 20` 会**恰好卡在 20**（脆弱边界）；T04/T05 +0.5 人日。这是选浮层方案在门禁上的直接收益。

**新增护栏**：

`test/clipboard-grid-layout.test.js`（新）：
1. 覆盖性：`itemRow/itemCol` 是 `[0,n)` 的排列；
2. 单调与间距：`next.y === cur.y + cur.h + gapBetween`；
3. **退化性**：全文本输入 → `y === i*rowH`、`height === n*rowH`；
4. 分组：图片只在 `images` 行、每排 ≤ cols、列号连续；文本行恰好 1 格；
5. 锚定性质：随机 200 组 `(kinds, removed, scrollTop)`，断言裁剪后锚点仍是视口顶部项且行内偏移 ≤ 该行高度；
6. 列数翻转：`clientWidth` 与 `clientWidth-9` 若 `cols` 相同则 layout 相同；
7. **列数公式**：8 档 DPR × 11 档宽度，断言 `max(tile,cellH)*dpr ≤ 240` **或**已触到 `--tile-min`/`MAX_COLS`（把 §3.2 的循环终止条件写成测试）。

`test/clipboard-preview-batch.test.js`（新，主进程侧）：
1. 入参校验：非数组 / 长度 0 / >64 / 非法 UUID / 多余键；
2. **令牌不复用清空**：连取 3 个 URL 后，第 1 个**仍能**通过 `handleResource`（防「退回单活」的回归锁）；
3. 上限与淘汰：第 129 个 token 使最旧失效；
4. TTL：`expires` 后 404；
5. 单项失败不影响整批（`{id,error}` 与 `{id,url}` 混排）；
6. `WINDOW_NOT_VISIBLE` 返回逐项错误而不是 throw；
7. 池大小常量必须 `< 16`；
8. **LRU 在 history revision 变化时清空**（防已删内容可读，§5.3）；
9. **`main/ipc/clipboard-ipc.js` 与 `main/services/**` 在覆盖率 include 名单内**（`package.json:13-16`），所以本文件必须真正 `require` 到新分支，否则会出现「include 命中但无人 require → 0/0 且退出码 0」的掩蔽（§16 N3）。

`test/clipboard-paste-renderer.test.js`（既有，需扩 stub）：该用例用 `vm.runInNewContext` 跑 `clipboard.js`，stub 只提供 `value/textContent/hidden/checked/style/scrollTop/clientHeight/children/replaceChildren/append/setAttribute/removeAttribute/focus`，**没有 `dataset`/`classList`/`querySelector`/`getComputedStyle`/`matchMedia`**，api 也只有 `preview()`。必须补：`dataset`、`getComputedStyle`、`matchMedia`、`clipboardLayout` 注入、`api.previews`。这是**预期内的测试改动**，但不要为了让 stub 过而把产品代码写成只兼容 stub 的形状。

### 8.3 可访问性（含 1 条待验证）

| 项 | 结论 |
| --- | --- |
| 容器角色 | **保持 `role="listbox"`**（`clipboard.html:38`），不换 `role="grid"`。混排里文本行是 1 宽行，`grid` 会强制 row/gridcell/行列头语义，把整行文本变成畸形单元格 |
| 网格包装 | `.grid-row` 用 `role="presentation"`，预期使 `.tile[role="option"]` 在 A11y 树上成为 listbox 的 owned child。**⚠️ 待验证**：本会话未启动 Electron，无运行时证据；规范是「presentation 节点被忽略、子节点上提」，但必须在 T07 用 DevTools Accessibility 面板或 Playwright `accessibility.snapshot()` 确认「listbox 的直接子项是 N 个 option，且树里没有 grid-row」 |
| 格子元素 | `<div class="tile" role="option" id="item-<uuid>" aria-selected tabindex="-1">`；内部 `<img alt="">`（语义由 option 承担，避免双重播报）。**注意**：`<div>` 没有 button 的原生激活行为，因此单击绑定必须在 `#list` 上做事件委托（或给 tile 绑 `click`），**焦点始终留在 `#list`**，靠 `aria-activedescendant` 播报 |
| 图片格文案 | 只有 `aria-label`（= `clipboard.image-size` · 来源 · 时间），**不用 `title`** |
| 激活项 | 继续 `#list[aria-activedescendant]`（`clipboard.js:75-76`），焦点永不进 option |
| 播报 | 状态栏 `role="status" aria-live="polite"` 继续播报结果；**不为每次方向键播报**（既有约束） |
| 浮层 | `role="region"` + `aria-label`；`#view` 带 `aria-expanded` / `aria-controls="detail"` |
| 占位 | 失败格 `aria-label=t('clipboard.thumbnail-unavailable')` |

**新增运行时断言（T07）**：点击 tile 后焦点仍在 `#list`、`aria-activedescendant` 指向该 tile。

---

## 9. 门禁与契约同步点

### 9.1 三处必须同批修改的 IPC（漏一处就启动失败）

| # | 位置 | 漏改后果 |
| --- | --- | --- |
| 1 | `main/services/ipc-security.js:67`（`role:'clipboard'` handles 白名单） | `main.js:1184` 的 `assertComplete()`（`:313-320`）启动即抛 |
| 2 | `main/ipc/clipboard-ipc.js:20`（`handle('previews', …)`） | 通道无注册 |
| 3 | `preload-clipboard.js:13`（`previews: (ids) => …`） | 渲染层调用不存在的方法；`clipboard-ui-contract.test.js:77-88` 与 `ipc-security.test.js:167-198` 都会红 |

### 9.2 门禁影响总表

| 门禁 | 命令 | 影响 | 结论 |
| --- | --- | --- | --- |
| 单测 | `node --test test/*.test.js` | 高：1 条必红 + 2 个新增 + 1 个扩 stub | 按 §8.2 执行 |
| 语法 | `node scripts/check-js.js` | 无（只做 `node --check`） | 语法正确即过 |
| 架构 | `node scripts/check-architecture.js` | **软约束但很紧**：`main.js` 实测 **1327/1330，只剩 3 行** | **一行都不要进 `main.js`**；新依赖在 `main/domains/clipboard/index.js` 内部构造 |
| i18n | `node scripts/check-i18n.js --max 606` | 中：余量 21，`clipboard` 分区须保持 0 | 只加 2 个 key 到 `shared/locales/`；`clipboard/*` 注释写英文 |
| 覆盖率 | `npm run test:coverage` | **中**：`main/ipc/**` 与 `main/services/**` **在 include 名单里**（`package.json:13-16`）→ 新 IPC 分支会计入；`clipboard/*`、`preload-clipboard.js`、`main/domains/**` 不在 | 必须真正 `require` 新分支（§8.2 第 9 条），并**实跑三档**确认 |
| 原生 | `npm run test:clipboard:native` | 低：零 native 改动；**CI 不跑这一步** | 本机人工跑一次记基线 |
| E2E | `npm run test:e2e` | 无（`e2e/*.spec.js` 无剪贴板面板用例） | 绿了也**不代表**剪贴板面板正确 |
| 窗口安全 | `test/window-security-runtime.test.js` | **中**：真实 Electron 加载 `clipboard.html`，断言控制台无 `Refused to|Uncaught|ERR_` | 见 §9.4 第 5 条 |
| 设计令牌 | `test/design-tokens.test.js` | 中：禁 `:root`（`:141`）、**禁十六进制（`:142`）**、禁颜色变量（`:143`）、禁 emoji 图标 | 新样式只用 token |
| IPC 策略 | `test/ipc-security.test.js` | 中：从 `IPC_SURFACES` 推导并与真实注册比对 | 按 §9.1 同改即可 |
| 截图夹具 | `design-demos/tools/capture-electron.js`（非门禁） | 会失真 | 见 §9.5 |

### 9.3 为什么不加 feature flag

1. 本期零 native 改动 → 没有「新 exe 配旧 JS」组合，回滚 = revert 若干 JS 文件；
2. flag 与 IPC 策略检查冲突：`assertComplete()` 要求策略集合与注册集合一一对应，同时注册 `preview` 与 `previews` 会让两套语义**永久并存**，正是该测试注释点名的反模式。**正确做法是替换，不是并存**；
3. 没有需要迁移的持久状态：`release()` 会 `destroy()` 窗口并 `unhandle` 协议（`index.js:39-43`），partition 每次新 UUID 且 `cache:false`（`:98-99`）；
4. 剪贴板历史**本身默认关闭**（`clipboard-settings.js:2` `enabled:false`；`main/domains/clipboard/index.js:88`），受影响面天然是「主动开启的用户」。

### 9.4 本机受限环境跑门禁的已知陷阱

1. `ELECTRON_RUN_AS_NODE=1` → Electron 探针全部 `app is undefined`。**先 `env -u ELECTRON_RUN_AS_NODE`**；
2. `--no-sandbox` 必须在脚本路径之前，但 `test/window-security-runtime.test.js:16-24` 是 `spawnSync(electronPath, [probe])`，**没法从外部加 flag** → 只能临时 `NODE_OPTIONS=--require <hook>` patch `spawnSync`（hook 放 checkout 外、**不提交**），或如实标记「本机未验证」；
3. 子进程不能写 `%LOCALAPPDATA%\Temp` → 把 `TMP`/`TEMP` 指到 checkout 内（如 `.tmp/clipboard-image-grid/tmp`），否则 EPERM 后挂到超时；
4. `npm audit` 走镜像返回空 —— 本任务不改 JS 依赖，不受影响；但**若做 D2（WebP）**，`Cargo.lock` 与 `audit:dependencies` 的锁步才是重点；
5. **本任务专属**：窗口安全探针的窗口用**默认 session**，没有注册 `highlighter-clipboard://` 协议 → 网格若在加载期无条件给 `<img>` 赋 `src`，会打印 `ERR_UNKNOWN_URL_SCHEME`，而 `ERR_` **正好在探针的失败关键词里**。因此 `<img>` 的 `src` 只能在 `onInit` 之后、拿到真实 URL 时才设置（§3.8 第 6 条）；
6. `npm test` 里有 13 个用例会真的 spawn Electron，所以「完整 npm test」本身就需要第 1、3 条先处理。

### 9.5 截图夹具同步（非门禁，但会让既有产物失真）

`design-demos/tools/capture-electron.js`：
- `:242-260` 假桥只有 `preview(id)` → 要加 `previews(ids)`；
- `:185-235` 的 `CLIP_PROBE` 读 `#detail` 矩形与 `#image.naturalWidth`，语义要改成「格子几何 + `#rows .tile` 计数」；
- `:405-415` `protocol.handle` 只认 `preview/<任意>` → 要按 id 返回不同 PNG，否则 16 个格子显示同一张图；
- 夹具 `CLIPBOARD_ITEMS`（`:141-175`）只有 1 张图 → 至少补 6 张，否则网格形态拍不出来。

---

## 10. 任务拆解

原则：**每个提交落地后应用必须仍可运行**（这是原稿最大的拆解缺陷，§16 R4）。本文不授权自动提交/推送。

| 编号 | 主题 | 写作用域 | 依赖 | 自测 | 完成标准 | 人日 |
| --- | --- | --- | --- | --- | --- | --- |
| **T01** | 基线冻结与契约判定 | 仅 `docs/`（或 `.tmp/`） | — | 跑 §11.1 全部静态门禁并留证 | 基线数字有出处（main.js 1327/1330、i18n 585、契约 13/13、三档覆盖率）；27 条断言「保留/改写/退役」逐条判定 | 0.5 |
| **T02** | 批量预览（**原子提交**：主进程 + preload + 渲染层调用点 + 渲染层取图循环） | `main/domains/clipboard/index.js`、`main/ipc/clipboard-ipc.js`、`main/services/ipc-security.js`（仅 `:67`）、`preload-clipboard.js`、**`clipboard/clipboard.js`（仅 preview 调用点与图片取图循环，不动布局）**、`test/clipboard-preview-batch.test.js`（新） | T01 | `node --test test/clipboard-preview-batch.test.js test/clipboard-paste.test.js test/ipc-security.test.js`；`node scripts/check-js.js` | 一次 IPC 拿 N 个 URL；token 上限 128 / TTL 300s / 逐项错误；**提交后现有 64px 列表仍能显示图片详情**（不强求网格）；`preview`→`previews` 三处一致替换；启动 `assertComplete()` 不抛 | 2.0 |
| **T03** | 布局模型 + 网格渲染 | `clipboard/clipboard-layout.js`（新）、`clipboard/clipboard.js`、`clipboard/clipboard.css`、`clipboard/clipboard.html`、`test/clipboard-grid-layout.test.js`（新） | T02 | `node --test test/clipboard-grid-layout.test.js test/clipboard-paste-renderer.test.js`；副屏手滚 | pitch 单源（CSS 变量 + 媒体查询 + JS 读 dpr）；二维键盘；150 条锚定；§3.10 状态表；rAF 节流 + 窗口早退；`<img>` error 重试与占位；`scrollbar-gutter: stable`；dpr 变化监听 | 1.5 |
| **T04** | 交互收口：图片零文案 + 全文浮层 | `clipboard/clipboard.js`、`clipboard/clipboard.css`、`clipboard/clipboard.html`、`shared/locales/clipboard.js` | T03 | `node --test test/clipboard-ui-contract.test.js`；grep 确认无残留 | 图片格无可见文字、无 `title`；点击不再弹详情；文本浮层可开可关、`Esc` 优先级正确、不改列表高度；页脚动作栏就位且 `clear` 仍在 | 1.0 |
| **T05** | 契约测试改写与新增护栏 | `test/clipboard-ui-contract.test.js`、`test/clipboard-paste-renderer.test.js` | T04 | `node --test test/clipboard-ui-contract.test.js test/clipboard-paste-renderer.test.js test/design-tokens.test.js` | §8.2 改写 + 3 组新断言全绿；旧「行高锁步」断言消失且被 pitch 同源断言取代 | 1.0 |
| **T06** | i18n 收口 | `shared/locales/clipboard.js`、`docs/` | T04 | `node scripts/check-i18n.js --max 606`；`node --test test/i18n-contract.test.js` | 2 个新 key 三语齐全；`clipboard` 分区 0；TOTAL ≤606；「不新增设置项」结论入档 | 0.5 |
| **T07** | 真机验收（副屏） | 仅验收记录 | T05,T06 | §11.2 / §11.3 全项 | 图形/键盘/断图/DPR 四档目测；A11y 树确认（§8.3 待验证项）；380 宽页脚不溢出；`captureBusyMs` p99 | 1.0 |
| **T08** | 收口与回滚演练 | `docs/` | T07 | `npm run check`；按 §9.4 受限跑 `node --test` | 修改清单、命令与结果、未验证项、回滚步骤齐备 | 0.5 |

**合计 8.0 人日。** 可选分支（D2 WebP/384）：+1.5–2.0 人日，且要重跑 native 构建与 `test:clipboard:native`。

提交主题建议：
```
feat(clipboard): batch thumbnail previews for the history panel
feat(clipboard): render image records as a thumbnail grid
refactor(clipboard): open full text on demand instead of on selection
test(clipboard): pin grid layout and thumbnail batch contracts
i18n(clipboard): add full-text action and thumbnail placeholder copy
```

---

## 11. 验收矩阵

### 11.1 纯静态 / 单测即可证明

| 项 | 命令 | 通过标准 |
| --- | --- | --- |
| 语法 | `node scripts/check-js.js` | 通过 |
| 架构 | `node scripts/check-architecture.js` | `ok (main.js ≤1330)`；**不得为过而抬上限** |
| i18n | `node scripts/check-i18n.js --max 606` | TOTAL ≤606；clipboard = 0；三语对称 |
| 单测 | `node --test test/*.test.js` | 全绿 |
| 覆盖率 | `npm run test:coverage` | 三档通过（含 `main/ipc/clipboard-ipc.js` 新分支） |
| 新协议 | `node --test test/clipboard-preview-batch.test.js` | §8.2 的 9 组断言 |
| 布局 | `node --test test/clipboard-grid-layout.test.js` | §8.2 的 7 组不变量（含随机性质测试与列数公式扫描） |

### 11.2 需要真实 Electron 窗口（副屏，遵守根 `AGENTS.md`）

| 项 | 做法 | 通过标准 |
| --- | --- | --- |
| 窗口安全探针 | `env -u ELECTRON_RUN_AS_NODE … node --test test/window-security-runtime.test.js`（按 §9.4 处理沙箱/TMP） | `clipboard` 面板无 `Refused to/Uncaught/ERR_`；`blocked` 为空 |
| 面板渲染 | 设置里启用剪贴板历史 → 呼出面板，窗口放**副屏** | 图片显示为格子、无任何可见文案；点格子无下方详情；文本浮层按需打开且列表高度不变 |
| 控制台 | DevTools | 无 CSP 违规；`highlighter-clipboard://preview/…` 404 仅出现在 token/LRU 失效后 |
| 键盘 | 全部键位 | 二维移动正确、选中格完整可见、`aria-activedescendant` 指向当前格；Esc 先关浮层 |
| A11y 树 | DevTools Accessibility / Playwright `accessibility.snapshot()` | listbox 直接子项是 N 个 option；树中无 `grid-row` 节点；点击 tile 后焦点仍在 `#list`（§8.3 待验证项） |
| 窄窗 | 面板拖到 380 宽 | 页脚动作栏不溢出、不换行（§3.6） |
| 复制/粘贴回归 | 到 Notepad 与 Chrome 输入框 | `paste.capture → prepare → hide → commit` 链行为不变 |
| 断图兜底 | 手动删/改坏 `thumbnails/<hash>.png` 后重开面板 | 出现中性占位、无破图、该格仍可选中/复制/删除 |

### 11.3 需要真机测量

| 项 | 指标 | 目标阈值 |
| --- | --- | --- |
| 首图可见 | `clipboard:init` → 第一张 `<img>.load` | p95 ≤ 150 ms |
| 满屏填充 | init → 可见格全部 load 或 error | p95 ≤ 400 ms |
| 单格端到端 | 主进程收到 invoke → `Response` 构造完 | p99 ≤ 30 ms |
| 请求数 | 首屏 / 滚一屏 / 回滚一屏 | ≤ 16 / +16 / **0**（urlCache + LRU 生效） |
| 失败率 | `ok:false` / 总数 | ≤ 0.5% |
| 采集饿死 | 预览风暴 + 冷缓存自愈时 `captureBusyMs` | p99 ≤ 500 ms（超则池降到 4，见 §5.6） |
| 内存 | 主进程 RSS 增长（10 次开关） | ≤ 8 MiB（= LRU 上限） |
| 滚动 | 150 条快速滚动 5 s | 无重叠/无空隙、无 `BACKPRESSURE`、无 404 刷屏 |
| DPR 目测 | 100/125/150/175/200/225/250/300% | 缩略图不糊；300% + 窄窗的 0.88–0.96× 上采样可接受（§3.2） |

### 11.4 本轮**未验证**项（不得声称通过）

1. 未启动 Electron → 面板真实渲染、CSP、控制台、A11y 树全部**未验证**；
2. `role="presentation"` 包 `role="option"` 的 A11y 上提行为**未实测**（§8.3）；
3. 未构建/未跑原生 → 「零 native 改动即通过」是**假设**；
4. 未跑完整 `npm test` 与三档覆盖率 → 覆盖率基线未知；
5. 未跑 `test:e2e`（且它本就不覆盖剪贴板面板）；
6. 未在真机测 DPR 观感 → §3.2 是算术结论，不是观感结论；
7. 未验证 `design-demos/tools/capture-electron.js` 改造后的截图产物；
8. `captureBusyMs` 在冷缓存全 MISSING 场景下的真实值**未知**（§5.6 的池降级阈值待实测）。

---

## 12. 风险与回滚

| # | 风险 | 触发条件 | 可观测信号 | 缓解 | 回滚 |
| --- | --- | --- | --- | --- | --- |
| **R1** | pitch 失步（四处数学各算各的） | 改布局时漏改滚动窗口/键盘居中/裁剪补偿 | 滚到底部重叠或空隙；`#rows` 高度 ≠ 末行 `y+h`；选中第 100 条后 activedescendant 在视口外 | 布局抽纯函数，三处都调它；§3.4 锚定公式配随机性质测试 | revert T03（T02 保留，渲染层回到 64px 行） |
| **R2** | 令牌模型退回单活 | 有人「顺手」在 `previews` 里加 `revokePreviews()` | 成片占位；DevTools preview 大片 404 | §8.2 第 2 条断言（连取 3 个第 1 个仍有效） | revert T02 token 段 |
| **R3** | 已删除内容仍可读 | `on('history')` 同时不清 token 也不清 LRU | 删除记录后重新打开仍能看到缩略图 | §5.3：history 变化清 LRU（不清 token） | revert 该行策略 |
| **R4** | 中间提交把应用弄坏 | T02 只改主进程不改渲染层（原稿的拆法） | T02 落地后面板图片全部报错 | T02 定为原子提交（§5.1、§10） | 整段 revert T02 |
| **R5** | 撞背压 / 杀 sidecar | 池 >16，或多张 MISSING 同步自愈 | 面板卡顿；日志 `BACKPRESSURE`；后端突然 `phase:error` | 池常量 8 + 断言；冷缓存场景实测 `captureBusyMs`，超阈降池到 4 | 渲染层降级为「滚动停止 150ms 后取图」（不注册第二个通道） |
| **R6** | 隐藏后再回来看，后半屏永久空白 | 没做 `img.onerror` 重试 | 切窗口回来固定几张是空板 | §3.8 第 5 条 | 同上 |
| **R7** | 列数振荡 | 没加 `scrollbar-gutter: stable` | 改窗宽时格子数闪动 | §3.7 三重防护 | 去掉 DPR 提列（回退固定 4 列） |
| **R8** | `ERR_UNKNOWN_URL_SCHEME` 打红窗口安全探针 | 网格加载期无条件赋 `src` | `test/window-security-runtime.test.js` 红 | §3.8 第 6 条 | revert 图片填充时机 |
| **R9** | 换显示器后布局不更新 | 漏掉 `devicePixelRatio` 监听 | 同窗宽在两块屏上格数不同 | §3.1 的 dpr 监听 + 契约断言 | 加监听即可（无需回滚） |

**回滚粒度**：T02（协议）与 T03/T04（渲染层）互相独立 —— T03/T04 可单独回滚；但 **T02 回滚必须整段 revert**（不能只改主进程不改渲染层，否则 R4 重现）。

---

## 13. 非目标（明确不做，附理由）

| 非目标 | 理由 |
| --- | --- |
| masonry / 按图片宽高比变高 | 破坏「追加分页不动前面行」与裁剪锚定的可推导性 |
| 按 kind 重排（图片都排前面） | 顺序是后端 `pinned/sort_at` 契约（`storage.rs:567-570`），前端重排会让滚动位置与刷新语义混乱 |
| 图片原图预览 / 放大 | `handleResource` 只服务缩略图；原图最大 16 MiB，搬进主进程违反既有边界 |
| 提高缩略图分辨率 / 换 WebP | §7.2、§7.3 已裁决，独立一期 |
| **跨批预取 / 速率令牌桶** | 评审判定为未证明必要的复杂度（§16 N4）；本期只做「可见区按需 + 池 8 + LRU」 |
| 右键菜单 / 仅 hover 的操作浮层 | 需要新 IPC + 菜单宿主 + 扩 IPC 白名单；键盘与自动化场景不可发现 |
| 用户可配列数 / 任何新设置字段 | §6.1 的 6 条连锁成本 |
| `role="grid"` | 混排里文本行是 1 宽行，grid 语义会畸形（§8.3） |
| 缩略图 HTTP 缓存 | URL 是能力不是资源（§5.5） |
| 改 `main.js` | 只剩 3 行余量（§9.2） |
| **逐项 50 ms 超时** | 需要改 `ClipboardService.request()` 的致命超时语义，属独立一期（§5.4） |
| **MISSING 自愈并发上限** | 主进程无法观测，做不到（§5.6） |

---

## 14. 复算脚本（可重跑，无需 Electron）

```js
// ① 列数公式的可满足性：8 档 DPR × 11 档面板宽度
const PAD = 10, GAP = 8, TARGET = 110, MIN = 72, MAX_COLS = 12, SRC = 240
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const cellHFor = (dpr) => dpr >= 2.5 ? 64 : dpr >= 2.25 ? 80 : 92   // 与 CSS 媒体查询一致
function cols(clientWidth, dpr) {
  const avail = clientWidth - 2 * PAD, cellH = cellHFor(dpr)
  const tile = (c) => (avail - (c - 1) * GAP) / c
  let n = clamp(Math.round((avail + GAP) / (TARGET + GAP)), 1, MAX_COLS)
  while (n < MAX_COLS && Math.max(tile(n), cellH) * dpr > SRC + 1e-9 && tile(n + 1) >= MIN) n++
  return n
}
// 不变量：max(tile(n),cellH)*dpr <= 240  或  n 已触 MAX_COLS / tile(n+1) < MIN
```

```js
// ② PNG stored-block 上界（§7.2）
const pngCeiling = (N) => {
  const raw = N * N * 4 + N
  const blocks = Math.ceil(raw / 65535)
  const zlib = raw + blocks * 5 + 6
  return 8 + 25 + (12 + zlib) + 12
}
// pngCeiling(240) = 230723 <= 262144
// pngCeiling(256) = 262488 >  262144（超 344 B）
// pngCeiling(384) = 590321 = 2.25 × 262144
```

---

## 15. 与既有剪贴板文档的关系

- 本文只改**面板展示与预览链路**，不动采集、存储、粘贴、迁移、数据根：`docs/plans/2026-10-17-clipboard-implementation-plan.md`（V1 落地）与 `docs/plans/2026-10-17-clipboard-active-paste-fix-plan.md`（主动粘贴修复）的契约全部保持。
- 与之冲突并被本文覆盖的只有两处：该计划文档 §2.2 表格里的「面板单击 = 选中条目，显示受限详情」，以及缩略图规格「最长边 320px」（实现为 240px，§7.2 用算术确认 240 才是 256 KiB 单帧下的正确值，320 无法成立）。
- 数据兼容：旧缩略图**不需要迁移、不需要重生成**（内容寻址 `publish()` 拒绝覆盖同名文件，`storage.rs:272-283`；读侧还有 ≤240 校验）。本方案不改缩略图像素尺寸 → 不构成迁移项。

---

## 16. 修订记录（独立评审 → 本稿的处理）

评审结论原文是「不能直接作为开发依据」，指出 8 个阻断项。逐条处理如下（**5 处是我原稿的真实错误**）：

### 16.1 阻断项

| # | 评审意见 | 处理 |
| --- | --- | --- |
| **R1** | `previews(ids)` 声明能同步返回逐项 `NOT_FOUND`，但原设计里 `preview()` 只签 URL、真正读取发生在协议请求阶段 → 不预取则无法返回错误 | **采纳并改设计**：`previews` 在主进程内完成「取字节 → 缓存 → 签 token」，`handleResource` 从 LRU 取（§5.1、§5.5）。这是我原稿的真实缺陷。 |
| **R2** | 要池 8 / 50 ms 逐项超时，但 T02 写作用域没 `clipboard-service.js`；现有超时走 `failChild()` 会杀整个 sidecar | **采纳**：删掉「50 ms 逐项超时」承诺，沿用 5000 ms；把「非致命超时」列为独立一期并说明协议上安全的理由（迟到响应被 `requestId` 匹配丢弃）（§5.4） |
| **R3** | `on('history')` 不清 token + LRU 按 id 缓存 → 后台 `maintain()` 删记录后旧 token 可能继续返回已删图片 | **采纳**：改为「history 变化**清 LRU**、不清 token」，并把「已删除内容仍可读」加进威胁模型（§5.3、§5.7） |
| **R4** | T02 把 `preview` 换成 `previews` 但 T03 才改渲染层 → T02 落地后现有渲染层调用不存在的 `api.preview`，应用当场坏 | **采纳**：T02 定为原子提交，写作用域含渲染层的调用点与取图循环（§5.1、§10） |
| **R5** | 列数公式算错：`tile-min` 与 `MAX_COLS` 冲突；DPR 3 时 `tile(5)=83.4 < 88` 却仍被判可用；`clientWidth=1200/DPR3` 会得 13 列超 `MAX_COLS=12` | **采纳**：判据改为 `max(tile, cellH)*dpr ≤ 240`；`--cell-h` 改由 CSS 媒体查询按 DPR 分档收缩；循环加第二个终止条件；表格与扫描数字全部重算（§3.1、§3.2、§14）。我原稿只算宽度、漏了格高，且 `--tile-min: 88` 与公式不自洽。 |
| **R6** | 「MISSING 自愈并发 ≤2」做不到 —— 自愈在 native 内部、主进程无法区分 | **采纳**：删除该验收项，改为「池 8 是唯一杠杆 + 实测 `captureBusyMs` 再降池」（§5.6） |
| **R7** | 纯布局函数没有覆盖完整状态机（搜索/筛选、分页、删除、语言切换、feedback-only、隐藏重建）；「窗口区间不变不重建」会让语言切换后 `aria-label` 留旧语言 | **采纳**：新增 §3.10 状态转移表 + 语言变化强制重建的断言（§8.2） |
| **R8** | 保留全文浮层 + 图片 `title` 是未获批准的偏差；`title` 会产生可见悬停文案 | **部分采纳**：**去掉 `title`**（只留 `aria-label`）；Q1 仍作为「需拍板」显式置顶（§0.6），并给出全删的代价 |

### 16.2 非阻断项

| # | 评审意见 | 处理 |
| --- | --- | --- |
| N1 | `role="presentation"` 包的 A11y 上提无实测；`<div>` 丢 button 原生激活 | **采纳**：§8.3 标「待验证」并给出验证方式；补「点击后焦点留在 `#list`」的运行时断言 |
| N2 | 新增 `#actions` 后 feedback-only 隐藏块与契约断言不会自动覆盖 | **已规避**：本稿**不新增** `#actions`，动作放进现有页脚 → 该风险消失；`clear` 保留也让契约测试免改 |
| N3 | 新 IPC 分支仍在覆盖率 include 内（`main/ipc/**`、`main/services/**`） | **采纳**：§8.2 第 9 条要求在测试里真正 `require` 新分支，并实跑三档 |
| N4 | `urlCache`/LRU/预取 50/4 批/s/8 MiB 多个复杂度没有时序与降级定义；7 人日偏乐观 | **采纳**：删掉跨批预取与速率令牌桶（列非目标）；保留池 8 + LRU + urlCache 并补齐失效时机（§5.3、§5.5、§3.8）；人日上调到 8.0 |
| N5 | 把「清空」移入设置页属额外 UI 变更；设置页已有入口不等于面板入口可无确认移除 | **采纳并回退**：`clear` 保留在页脚（§6.3） |
| N6 | 文本浮层需要独立 generation/取消/Esc 焦点恢复，T04 只 0.5 天不合理 | **采纳**：T04 上调到 1.0 人日（§10） |
| N7 | 「纯十六进制 id 会被色值正则误判」引用行号错误：颜色正则实际在 `design-tokens.test.js:142`，且只扫 CSS 不扫 HTML | **采纳并更正**：已改为 `:142`，并删掉「id 命名会被误判」这个错误说法（§4） |

### 16.3 评审确认无误的关键断言（保留原样）

- 令牌确实是单活：`index.js:23,160-166`
- `handleResource` 确实有 owner/generation/可见性/mime/256 KiB 五道校验：`index.js:73-84`
- 背压阈值确实是 `pending.size >= 16`，且 `command()` 不构成串行化：`clipboard-service.js:148-159,188-195`
- 当前渲染层确实依赖固定 64px 行高与 `index*rowHeight`：`clipboard.js:9-11,53-60,100,175-191`、`clipboard.css:294-298`
- 原生确实用 `thumbnail(240,240)` + 256 KiB 守卫 + 读侧 ≤240 校验：`images.rs:93-98`、`storage.rs:648-668`
- **PNG stored-block 算术逐字节正确**（230,723 / 262,488 / 590,321）
- `thumbnail(240,240)` 确实是 fit-inside（16:9 → 240×135）
- 新增外部 layout script 不破坏 CSP（`script-src 'self'`）与样式表顺序断言（后者只提取 `<link rel="stylesheet">`）
- IPC 白名单与注册必须同步、`assertComplete()` 会拒绝缺失注册
- i18n 门禁实测 TOTAL 585、clipboard 0

---

## 附录 A：契约测试 27 个 id 的处置

| id | 处置 |
| --- | --- |
| `search` `list` `rows` `empty` `kinds` `pinned` `status` `led` `refresh` `close` `pause` `new` `more` | 保留不动 |
| `copy` `paste` `pin` `delete` | **从 `#detail` 内移到页脚动作区**，id 与文案不变 |
| `clear` | **保留在页脚**（§6.3），加载期 `$('clear').onclick`（`clipboard.js:211`）不动 |
| `detail` `detailBadge` `detailMeta` `text` `media` `image` `truncated` | 保留（移入浮层容器），仅 `#detail` 定位方式改变 |
| `feedback` `feedbackText` | 保留不动 |
| **新增** `list-wrap`（列表与浮层的定位容器）、`view`（查看全文） | 需同步加入 `clipboard-ui-contract.test.js:68-74` 的 contract 列表 |

## 附录 B：调研过程中修正的三处口径 + 一处评审纠正

1. **「一屏可见 15–30 张图」不成立**：`#list` 可视高 425 DIP，4 列只能放 4 排 = **16 格**。30 格需面板被拖高到约 900 DIP。成本模型按 16 / 30 两档给（16 = 默认面板一屏，30 = 压测上界）。
2. **「240px 在 DPR 2 不够清晰」的成因不是 240 这个数**：`thumbnail(240,240)` 是 **fit-inside**，16:9 素材只剩 240×135。真正解法是「限单格 DIP + DPR 分档收缩格高」，不是提高边长。
3. **令牌失败是确定性的**，不是「可能失败」：N 次 `preview()` 后只剩最后 1 个 token，恰好 1 张成功（§5.2）。
4. **评审纠正了我原稿的一处自相矛盾**：判据只看 `tile` 宽度、却同时用 `--tile-min: 88` 做保护，而 DPR 3 下的合法结果是 83.4 —— 两者不自洽。现改为 `max(tile, cellH)*dpr` + CSS 分档 + 双终止条件（§3.2）。

---

## 17. 实施记录（2026-10-22，Q1 已拍板：保留「查看全文」）

> 本节记录**实际落地的代码**与本文规格之间的差异，以及验证证据。它不是"全部通过"的声明 —— §11.4 的未验证项仍未验证。

### 17.1 落地的文件

| 文件 | 性质 |
| --- | --- |
| `clipboard/clipboard-layout.js` | 新建，132 行，UMD 纯函数（`layout/rowAt/topOf/clamp/computeColumns/MAX_COLS/SOURCE_EDGE`） |
| `test/clipboard-grid-layout.test.js` | 新建，500 行，22 个用例 |
| `main/services/clipboard-thumbnail-cache.js` | 新建，LRU（`maxBytes` 8 MiB / `maxEntries` 128） |
| `test/clipboard-preview-batch.test.js` | 新建，18 个用例 |
| `clipboard/clipboard.js` | 重写（242 → 509 行）：读 CSS 几何、布局模型、二维键盘、锚定、rAF 节流、批量取图、浮层 |
| `clipboard/clipboard.html` | `#list` 包进 `.list-wrap`；`#detail` 移入浮层；动作移到 `<footer>`；新增 `#view`；加载 `clipboard-layout.js` |
| `clipboard/clipboard.css` | `#list` 声明 6 个几何变量 + DPR 媒体查询 + `scrollbar-gutter`；新增 `.grid-row`/`.tile`；`.detail` 改 absolute；页脚 30→45 |
| `main/domains/clipboard/index.js` | `previews()` 批量取字节 + LRU + 有界 token；`on('history')` 改为清 LRU |
| `main/ipc/clipboard-ipc.js` | `preview` → `previews`（1–64 + UUID 校验 + 去重） |
| `main/services/ipc-security.js` | **仅 `:67` 一行** |
| `preload-clipboard.js` | **仅 `:13` 一行** |
| `shared/locales/clipboard.js` | 三语各 +2 键（`clipboard.view-text`、`clipboard.thumbnail-unavailable`），82 → 84 |
| `test/clipboard-ui-contract.test.js` | 「行高锁步」换成「几何单一真源」；新增 4 组护栏；13 → 17 个用例 |
| `test/clipboard-paste-renderer.test.js` | vm 沙箱补齐 `dataset`/`querySelectorAll`/`closest`/`getComputedStyle`/`matchMedia`/`previews`；1 → 5 个用例 |

### 17.2 实施中发现、并已修正的两处**规格错误**

| # | 本文原规格 | 实际问题 | 处理 |
| --- | --- | --- | --- |
| **I1** | §3.3 的 `layout()` 写成 `if (rows.length) y += m.gap`（无条件前导 gap） | **与本文自己的不变量 2、5 矛盾**：连续两个图片块会在前一块尾随 gap 之外再加一次，实测 4 列全图片 pitch = 116 而非 §3.4 声明的 100，且 `height !== 末行.y + 末行.h` | 改为 `if (rows.length && rows[rows.length-1].type === 'row')`，并新增单测 group 2b 把 pitch=100 钉死（防止有人「照文档改回去」）。§3.3 代码块已同步更新 |
| **I2** | §8.2 的 `rowAt` 断言 `rows[r].y <= y` | **y 落在行间隙时按定义不可能成立**（`rowAt` 在 gap 中返回"下一个"行，其 `y > y`） | 拆成「行内点」与「任意点」两组，任意点改用正确不变量：「最后一个 `y+h <= y` 的行」+「下一行起点 `> y`」；边界（-1 / 0 / 1e9 / height / 空模型）单独一组 |

这两处都是**文档写错、实现按数学正确性纠正**，不是实现偏离设计。

### 17.3 实施阶段新发现的一个真实 bug（已修）

渲染层最初在 `renderImageRow()` 内部（节点尚未挂到 `#rows`）就触发缩略图批量请求，导致 `$('rows').querySelectorAll('.tile[data-item-id]')` **扫不到任何 tile**，批量请求永远返回空 —— 表现为网格里所有图都是空板。

- 成因：把「构造节点」与「挂载后批量取图」混在一个函数里；
- 修正：`renderRows()` 在 `replaceChildren()` + `append()` 完成之后**统一调用一次** `requestThumbnails()`；
- 护栏：`test/clipboard-paste-renderer.test.js` 的「首个渲染把全部可见缩略图合成一次 previews 调用」用例 —— 它最初就是红的，正是这条抓出来的。

> 这条值得单独记：如果当时只写「渲染出了 N 个 tile」这种断言，这个 bug 会一路带到真机。

### 17.4 验证证据（本机实跑，命令与结果）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node scripts/check-js.js` | `Syntax check passed for 393 JavaScript files` |
| 架构 | `node scripts/check-architecture.js` | `ok (main.js 1327 lines, ceiling 1330, domains 10)` — **main.js 一行未加** |
| i18n | `node scripts/check-i18n.js --max 606` | `TOTAL 585`、`clipboard 0`、三语对称 |
| 全量单测 | `node --test test/*.test.js` | **1326 / 1327 pass**（唯一红是 `clipboard-coordination.test.js` 的原生租约探针，见下） |
| 直接影响面 | 13 个相关测试文件 | **121 / 121 pass** |
| 覆盖率（载入） | `npm run test:coverage:loaded` | **91.58%** lines（阈值 85%） |
| 覆盖率（native） | `npm run test:coverage:native` | **82.89%**（阈值 60%/文件） |
| 覆盖率（critical） | `npm run test:coverage:critical` | **93.46%**（阈值 90%/文件） |
| 窗口安全探针 | `node --test test/window-security-runtime.test.js` | **pass**（真实 Electron） |
| long-capture | `node tests/long-capture.test.js` | `long capture tests passed` |
| 版本 | `node scripts/check-version.js` | `Version consistency check passed: 4.1.0` |

**窗口安全探针的逐窗证据**（真实 Electron 加载改后的 `clipboard.html`）：

```json
{ "name": "clipboard",
  "state": { "csp": "default-src 'none'; script-src 'self'; style-src 'self'; img-src highlighter-clipboard:; connect-src 'none'; ...",
             "inlineScriptCount": 0, "externalScriptCount": 7, "styleSheetCount": 2 },
  "preferences": { "contextIsolation": true, "nodeIntegration": false, "sandbox": true, "webSecurity": true },
  "consoleMessages": [], "blocked": [] }
```

> `externalScriptCount` 从 6 变 7 是新增的 `clipboard-layout.js`；控制台消息为空，说明 §9.4-5 担心的 `ERR_UNKNOWN_URL_SCHEME` **没有发生**（`<img>` 只在拿到真实 URL 后才赋 `src`）。

### 17.5 一个**未修**的既有不稳定项（不属于本次改动）

`test/clipboard-coordination.test.js` 的「native addon authenticates leases, finishes 100 rounds」在**高并发/全量跑**时偶发 `Lease round N` 失败（单跑 6/6 通过，全量跑偶发 1 次）。

- 它测的是原生 `selection-hook` 的租约往返，**不涉及本次任何改动**（`native/**` 零改动、该文件未被修改）；
- 失败点是 100 轮 `checkClipboardCoordinator()` 中的某一轮返回 false，属时序敏感；
- **未修**：修它需要动原生 addon 的租约超时语义，超出本次范围。已在此登记，避免下次被误判为回归。

### 17.6 仍未验证的项（与 §11.4 一致，不得声称通过）

1. **未在真机交互验证**：面板真实渲染观感、DPR 各档清晰度、滚动是否跳位、断图兜底的人眼确认；
2. **A11y 树未实测**：`role="presentation"` 包 `role="option"` 是否会按预期把 option 上提为 listbox 的 owned child（§8.3）——窗口安全探针只证明页面能加载，不证明 A11y 结构；
3. **380 宽页脚不溢出**未目测；
4. **`captureBusyMs` 冷缓存自愈压测**未做（§5.6 的池降级阈值仍待测）；
5. `test:e2e` 未跑（且它本就不覆盖剪贴板面板）；
6. `design-demos/tools/capture-electron.js` 的夹具**尚未同步**（§9.5 列了 4 处改动，本次未做——它不是门禁，但会让截图产物失真）。

---

## 18. 评审回归修复（2026-10-23）

第二轮独立评审（Codex）对**实现代码**（而非文档）给出 6 条阻断项 + 4 条建议。逐条核验后**全部属实**，已全部修复并配回归测试。本节记录缺陷、触发条件与修复，供后续维护时理解这些代码为什么长这样。

### 18.1 阻断级（全部已修）

| # | 缺陷 | 触发条件 | 真机表现 | 修复 |
| --- | --- | --- | --- | --- |
| **B1** | `thumbInFlight` 只在批次正常结束时删，恢复/隐藏/历史变化时不清 | 批次在途时面板隐藏或历史变化 | 同批 id 被永久跳过，**格子永久空白**（关面板重开才好） | `runThumbBatch` 无条件释放在途标记；`clearHistory`/`onHistory` 额外 `thumbInFlight.clear()` |
| **B2** | 只请求 `wanted.slice(0, 64)`，其余静默丢弃 | 面板拉高/拉宽后一屏挂载 >64 张图 | 第 65 张起**永久空白** | 抽出 `runThumbBatch`，`requestThumbnails` 递归补齐直到全部 settle |
| **B3** | 只监听 `(resolution: 1dppx)` | 窗口在 1.25× 与 2.5× 显示器之间移动 | CSS 已切 `--cell-h`，布局模型仍用旧高度 → **行重叠/空隙/列数错** | 监听 CSS 覆盖的全部 7 个分档，变化后重新订阅并重建 |
| **B4** | `handleResource` 在 post-await 校验**之前**写回 LRU；`previews` 同样 | 隐藏/历史变化/删除发生在原生读在途时 | 迟到的响应把刚清空的缓存**写回去** → 已删图片仍可读 | 引入 `cacheEpoch`：读开始捕获 epoch，写回前 `epoch === cacheEpoch` 才允许；post-await 校验提前到写回之前 |
| **B5** | `.footer .button{flex:0 0 auto}` 与 `.footer #paste` 同特异度但**源序在后**，覆盖了收缩规则 | 380 宽最小窗口 | 六个按钮最小宽度约 427px，**右侧动作被裁掉** | 把 `.footer .button` 改成 `flex:0 1 auto` + `min-width:0` + 省略号，并把它移到 `.footer #paste` 之前，靠源序生效 |
| **B6** | `trimHistory` 锚点固定取顶部行的**第一格** | 裁剪切进图片行（第一格被删、后面的格子仍在） | 锚点找不到 → `scrollTop = 0`，**跳到列表顶** | 扫描顶部行取第一个 `index >= removed` 的存活格子；整行都被裁时锚下一行 |

### 18.2 建议级（全部已修）

| # | 缺陷 | 修复 |
| --- | --- | --- |
| N1 | `thumbFailed` 未参与跳过条件（与注释相反），坏图每帧重发请求 | 加入跳过条件；失败态同时把 `aria-label` 改为 `clipboard.thumbnail-unavailable · …`，读屏不再把坏图播报成正常图片 |
| N2 | post-await 校验漏 `token.expires` | 补上；新增「读在途时 TTL 到期 → 404」用例 |
| N3 | 去重后返回去重列表，违反「与入参顺序/长度对齐」契约 | 按唯一 id 读一次，再映射回原始 `ids` 顺序；测试改为断言 20 个重复输入 → 20 个对齐结果、1 次原生读 |
| N4 | paste-hint 从可见文本降级为 tooltip 属需求外变更 | 保留（否则页脚放不下），已在 §3.6 显式记录该取舍 |
| N5 | `new URL()` 无 try/catch（既有代码） | 既有行为，未改（不在本次范围） |

### 18.3 测试有效性修复

| # | 问题 | 修复 |
| --- | --- | --- |
| T1 | 测试里 `matches`/`descendants` **重复定义两次** | 删除重复副本 |
| T2 | 无法解析的选择器**静默返回 `false`**，让所有基于它的断言变真空 | 改为**抛错**；选择器一旦变化立刻失败而不是"什么都匹配不到" |
| T3 | 只测 3 个立即成功的 id，抓不到 64 项上限、在途隐藏、快速重开 | harness 支持 deferred `previews`；新增 3 个用例覆盖这些路径 |
| T4 | 语言测试只比子节点数量；DPR 测试只确认注册了监听器 | 保留（更强的 A11y 断言需真实 A11y 树，仍列未验证项） |
| T5 | 布局测试从未执行 `trimHistory` | 新增 `test/clipboard-layout-trim.test.js`（4 个用例），并加一条「产品代码仍符合本文件所建模的规则」的漂移守卫 |

### 18.4 复验结果（修复后重跑全部）

| 门禁 | 结果 |
| --- | --- |
| `node --test test/*.test.js` | **1337 / 1337 pass，0 fail**（此前偶发红的原生租约探针本轮也未复现） |
| `check-js` / `check-architecture` / `check-i18n` | 394 文件通过 / main.js **1327 行未变** / TOTAL 585、clipboard 0 |
| 覆盖率三档 | 91.58% / 82.89% / 93.46%（阈值 85 / 60 / 90） |
| 窗口安全探针（真 Electron） | pass，`consoleMessages: []`、`blocked: []` |
| 新增测试 | renderer 6 → 9 个用例；batch 18 → 20 个用例；新增 trim 4 个用例 |

### 18.5 仍未验证（与 §17.6 一致）

真机交互观感与 DPR 各档清晰度、A11y 树结构、380 宽页脚的实测排版、`captureBusyMs` 冷缓存压测、`test:e2e`、截图夹具同步。**B5 的修复是 CSS 算术结论，仍未在 380 宽真机上目测。**
