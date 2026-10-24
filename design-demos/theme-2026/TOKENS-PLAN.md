# 落地计划：从选定方向到 `shared/tokens.css`

> 这是**方向选定后**的执行清单，不是现在就要做的东西。写在这里是为了让三版原型从一开始就
> 按「能落进现有架构」的方式做——现有产品有 11 个渲染窗口、13 个路由、一套被测试守着的 token 规则，
> 原型再好看，落不进去就是废稿。

## 0. 现状（必须先知道的约束）

`shared/tokens.css` 现在是 Nightshift 语言，169 行，被 12 个窗口样式表消费。里面有三条**被测试守着**的规则：

1. **`--primary` 只能在 `:root` 声明一次**。运行时 `settings.mainColor` 以内联样式覆写到 `<html>`，`body.dark`
   里再声明一次会静默吃掉用户选的颜色。（`test/design-tokens.test.js`）
2. **含 `var()` 的自定义属性只在其声明处解析一次**，所以每个派生 token 与别名都要在 `:root` 和 `body.dark`
   **各写一遍**，否则浅色值渗进深色模式。
3. **每个窗口样式表必须先 link `tokens.css`**，且自己不声明颜色（有测试守）。

任何新语言都必须在这三条之内完成。好消息：三条都不是障碍，是新 token 树的形状约束。

## 1. 方向 → token 的映射表

| 语言要素 | A1 哑光 | B1 浮层 | C2 珐琅 | 落成 token |
|---|---|---|---|---|
| 表面层级 | 4 档明度台阶（差 4–5 L） | z0–z3 浮面高度 | 珐琅底 + 牌面 | `--bg / --surface / --surface-2 / --surface-3`（沿用现有四个名字，改值） |
| 深度表达 | 1px 接缝 + 2px 凹槽 | 双层阴影 + 模糊 | 1px 描边 + 内阴影 | `--shadow-1/2/3` 改配方；新增 `--seam-top / --seam-bottom`（接缝的上亮下暗）或 `--bevel`（倒角） |
| 材质纹理 | 细砂噪点（feTurbulence data URI） | 无 | 珐琅极缓渐变 | 新增 `--grain`（背景图 data URI，默认 `none`）+ `--grain-opacity` |
| 圆角 | 小（4–8px） | 中（14–20px） | 中空（4–8px 牌面） | 沿用 `--radius`（用户可配 `settings.borderRadius`），派生 `--radius-sm/-lg` |
| 选中态 | 压进面板（inset 1px） | 浮起（阴影加深） | 点亮牌（描边 + 微光） | 新增 `--selected-bg / --selected-shadow`（默认值随主题） |
| 强调色 | 只给当前与主操作 | 同 | 黄铜/朱红双色，强调色当黄铜 | 沿用 `--primary` + `--primary-ink / --primary-text / --primary-soft / --primary-line` |
| 正文色 | 近黑刻字 | 近黑 | 奶白刻字（暗）/ 深墨（亮） | 沿用 `--ink / --ink-2 / --muted / --faint`，改值 |
| 字体 | Segoe UI Variable + YaHei | 同 | 标题/正文 Noto Serif SC，标签 YaHei | 沿用 `--font-ui / --font-display / --font-mono`，C2 需要改 `--font-display` 与新增 `--font-serif-cjk` |
| 动效 | 压制阻尼 | 轻盈 | 牌面点亮 | 新增 `--ease-out / --ease-emphasized / --dur-press / --dur-hover / --dur-overlay / --dur-page` |

## 2. 新增 token（三方向通用，值随方向变）

```css
:root {
  /* 材质：默认全部关闭，选定方向后只开一个 */
  --grain: none;              /* A1 打开：feTurbulence data URI */
  --grain-opacity: 0;
  --bevel: none;              /* 接缝/倒角：none | <shadow-list> */
  --surface-alpha: 1;         /* B1: 玻璃需要 <1 + --blur */
  --blur: 0px;

  /* 选中态统一成一个 token，两个方向的"压进"与"浮起"都用它 */
  --selected-bg: var(--surface-2);
  --selected-shadow: none;

  /* 动效：时长与曲线集中，组件只引用 */
  --dur-press: 110ms;
  --dur-hover: 140ms;
  --dur-overlay: 200ms;
  --dur-page: 260ms;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-soft: cubic-bezier(.22, .61, .36, 1);
  --ease-press: cubic-bezier(.2, .7, .3, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-press: 1ms; --dur-hover: 1ms; --dur-overlay: 1ms; --dur-page: 1ms; }
}
```

注意 `--grain` 是 `background-image`，data URI 里不能出现未转义的 `#`（用 `%23`），且**必须 base64 或百分号编码**，
因为 CSP `img-src 'self' data:` 只放行 `data:` 协议本身，不改写内容。

## 3. 逐窗改造顺序（按用户接触频率）

1. `config/config.css`（主窗口，1120×760）——先做，因为它决定整套语言的判定
2. `capture/capture.css`（浮层 + 27 控件工具条）——最容易翻车的地方：浮层永远暗色 + 高密度
3. `clipboard/clipboard.css` + `clipboard/clipboard.html`（480×640 面板）
4. `toolbar/toolbar.html` 的内联样式（620×56 划词条）
5. 其余窗口（`search` / `recognition` / `action` / `record` / `pin` / `long-capture`）——它们已经在消费 token，
   多数会自动跟上，只需要复核浮层的暗色一致性

每窗改完跑一次真实截图：
```bash
env -u ELECTRON_RUN_AS_NODE node design-demos/tools/capture-electron.js
```
它在隐藏窗口里 capturePage，不占用显示器（AGENTS.md 要求）。

## 4. 验收

```bash
npm test                  # 含 tokens.test.js / config-routes.test.js 等
npm run check             # 语法 + 架构 + i18n
npx playwright test --config playwright.config.js
```

新增测试建议（落地方向时补）：
- `test/design-tokens.test.js` 追加：新增的 `--grain/--bevel/--surface-alpha` 也遵守「`var()` 派生在 `:root` 与 `body.dark` 各声明一次」
- 新增：`--dur-*` 在 `prefers-reduced-motion` 下必须趋近 0
- 新增：所有浮层窗口（capture / record / long-capture / clipboard / toolbar / pin）的底色不随 `settings.theme` 变亮

## 4.5 落地预演已经发现的问题（用真实 Electron 渲染器跑出来的）

`tools/landing-preview.js` 把三个方向的调色注入**真实窗口**（`config.html` / `capture.html` /
`toolbar.html` / `clipboard.html`），在真实安全配置（`contextIsolation:true, sandbox:true`）下截图并
量对比度。当前 30/30 表面通过、0 处新增低对比度文字。它同时挖出了四个只有套进真实 DOM 才会暴露的问题：

| # | 问题 | 证据 | 落地时怎么修 |
|---|---|---|---|
| 1 | **产品缺一个「机身侧壁」token** | `config.css` 里 `.sidebar` 与 `.card` 同读 `--surface`，`#view` 读 `--bg`。A1 的签名是「机身侧边比面板深一档」，没有额外 token 就只能把深色放进内容区、侧栏反而更亮——签名被画反 | 新增 `--chrome`（侧壁/标题栏），`.sidebar` 改读它。这是三个方向里唯一需要**新增 token** 的地方 |
| 2 | **浮层必须固定暗色，不能跟随主题** | 第一版让剪贴板面板跟随 app 主题，亮色档把它刷成浅底，4 个芯片掉到 3.3–3.8:1 | 浮层窗口（capture / record / long-capture / clipboard / toolbar / pin）读 `body.dark` 的 token 值，与 `settings.theme` 解耦。SPEC §2.3 早就这么写了，但 token 层没有强制 |
| 3 | **选区虚线是硬编码的旧主题蓝** | `capture/capture.js:737` `ctx.strokeStyle='#36a3ff'`；`:766` 的默认值也是它 | 改为读 `--primary`。三个方向下这条蓝线都和新调色打架，且它本来就是「第二个强调色」 |
| 4 | **`--faint` 被用作 11px 分组标题** | `.nav-group` 用的是 `--faint`，三个方向初版都掉到 3.9–4.3:1 | `--faint` 在 token 语义里应当是「装饰性」的；分组标题改用 `--muted`，或把 `--faint` 的最低亮度约束写进测试 |

预演还确认了两件事**不需要改**：截图浮层/工具条/剪贴板的白字压暗底在各方向下都通过（浮层暗色是正确决策）；
主窗口 13 路由 × 双主题在三个方向下都无横向溢出、控制台零报错。

复跑：
```bash
env -u ELECTRON_RUN_AS_NODE TMP=<in-repo> TEMP=<in-repo>   ./node_modules/electron/dist/electron.exe --no-sandbox   design-demos/theme-2026/tools/landing-preview.js
```
产物：`design-demos/theme-2026/shots/landing/`（30 张真实窗口截图 + `REPORT.txt`）。
判据是**相对当前 Nightshift 基线的回归**，不是一个绝对阈值——浮层里本来就有几处刻意低对比的文字
（8.5px 的「本地」徽标、截图提示条压在任意屏幕内容上），拿绝对 4.5:1 去判会把旧设计的账算到新主题头上。

## 4.6 已经落进 `shared/tokens.css` 的槽位（2026-10-24，零视觉变化）

落地预演证明三件事的产品 token 层表达不了，所以先把**槽位**加上，默认值全部是 no-op：

| 新 token | 默认 | 为什么需要 | 何时生效 |
|---|---|---|---|
| `--chrome` | `var(--surface)` | `config.css` 里 `.sidebar` 和 `.card` 读同一个 `--surface`，方向卡里「机身侧边比面板深一档」**无处安放**。实测：没有它，A1 的签名在真实窗口里是反的 | 选定 A1 后把侧栏/标题栏改读它 |
| `--grain` / `--grain-opacity` | `none` / `0` | 材质纹理（细砂 / 纸纤维 / 珐琅）目前没有任何 token 位置 | 选定方向后注入 data URI |
| `--primary-text-l` | `0.48` | 强调色当文字用的亮度上限。0.48 对近白底够用；**中明度台面需要约 0.35** 才到 4.5:1（A1 实测 `#e5a44c` 在中明度底上只有 1.34:1，压到 0.48 也不够） | 选定方向后按台面亮度调 |
| `--dur-press/hover/overlay/page`、`--ease-out/soft/press` | 110/150/200/260ms + 三条曲线 | 各窗口现在把 `.13s`–`.22s` 写死在组件里，没有共享时间尺度，动效无法统一调 | 逐窗改造时替换字面量 |

**验证「零视觉变化」的方法（像素比对不可用）**：`design-demos/tools/capture-electron.js` 同一份代码
连跑两次，像素差异最大 delta **219**——截图工具本身非确定，所以像素比对不能当证据。改用计算属性：
在真实渲染器里读每个 token 的解析值，全部不变；`--primary-text` 仍解析为
`oklch(0.48 0.128896 71.8296)`（与旧的 `min(l, 0.48)` 等价）；`--chrome` 解析为 `--surface` 的实际色值。

守卫测试：`test/design-tokens.test.js` 新增 3 条（槽位存在且为 no-op、`--primary-text` 从 token 读上限、
材质槽位在 `body.dark` 里重复声明）。`npm test` 1352/1353——唯一失败是 `clipboard-coordination` 的
原生租约计时 flake（单独跑 4/4 通过，已记入 `AGENTS.md`）。

## 4.7 同时修掉的产品缺陷：选区边线不再硬编码旧主题蓝

`capture/capture.js` 的选区虚线是 `#36a3ff`（上一代主题的蓝），手柄描边是硬的 `#e5a44c`。
前者在任何新方向下都是一个**不相关的第二个强调色**；后者在用户改主色后就不跟手了。
两者现在都走已有的 `selectedAccent()`（读 `--primary`）。回退值也从 `#36a3ff` 改成 `#e5a44c`。

`npm test` 覆盖：`test/capture-toolbar-regressions.test.js` 新增一条守卫，断言这两个绘制路径都解析 accent、
且不再带字面量颜色。注意那个文件里既有的 `drawHandles` 契约要求在函数头 600 字符内出现
`ctx.fillRect(x-4,y-4,8,8)`，所以注释必须写在函数**外面**。

## 6. B1 落地记录（2026-10-24，用户选定之后）

### 6.1 改了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `shared/tokens.css` | 全套 FILM 调色（亮/暗）、三级 elevation 阶梯、`--radius` 9→13px、新增 `--shadow-bevel`、文件头重写 | 单一来源 |
| `main/services/window-backdrop.js` | `#eeebe4/#121110` → `#ebe5d8/#191713` | 原生窗口底色必须等于 `--bg`，否则窗口圆角处露旧色（有测试守） |
| `main/services/settings-defaults.js` | `borderRadius` 8 → 13 | 运行时以内联样式覆写 `--radius`，不改默认值 B1 的圆角永远不生效 |
| `config/config.css` | `.window-shell` 用 `position:absolute;inset:0` 取代 `width/height:100%` | 见 6.3 |
| `toolbar/toolbar.html` | 内阴影配方 → `var(--shadow-bevel)` | 见 6.2 |
| `clipboard/clipboard.css`、`config/routes/usage.js`、`config/config.css` | 注释里的 Nightshift → FILM | 后来人不能读到已废弃的语言名 |

### 6.2 落地时才发现的三个真问题（都是看图才发现的）

1. **`shadow-1` 一开始给太重**（`0 6px 14px -8px`）。`config.css` 里有 28 条规则是「1px 边框 + shadow-1」，
   深阴影让设置列表变成一堆积木，丢了 B1 名字里那个「轻」。改成 `0 2px 4px -2px` 后恢复。
   **教训**：阴影步长要和它搭配的边框权重一起看，不能只看阴影本身。
2. **划词条的内阴影是"给深底写的"**：`inset 1px white .06` 假设自己永远在深色上，但它跟随主题，
   亮色下白高光消失在近白底上，整条发平。改消费 token 后又发现**外阴影会被窗口裁成矩形**
   （`hasShadow:false` + 窗口尺寸正好等于元素，有测试守着）。最终加 `--shadow-bevel`：
   **只含内阴影**，语义上就是"给不能有外阴影的透明浮层用的那半个 elevation"。
3. **窗口底部一条灰带**：`.window-shell` 用 `width/height:100%` + `1px` 边框，边框被加在 100% 之外，
   于是 shell 比视口大 1px，右下那条发丝线被裁成半像素带。改成 `inset:0` 定位后边框完整落在窗口内。
   （核实过：这条灰带在改动**之前**就存在，不是 B1 引入的。）

### 6.3 守卫测试的变化

改调色会让一批「断言具体 hex」的测试失败。区分对待：

- `test/design-tokens.test.js`：**把「断言 hex」换成「算对比度」**。原来只证明"值等于某个字符串"，
  任何错误的调色板都能过；现在计算每对 ink/surface 的 WCAG 比值，正文/次要文字/状态色低于 4.5:1 直接失败，
  另外检查表面台阶相邻两级的亮度差（台阶太平 = 层级看不见）。新增 8 条。
- `test/selection-window-manager.test.js`：断言从 `'#121110'` 改成 `WINDOW_BACKDROP.dark`。
  它想测的是**契约**（窗口用共享底色），钉死 hex 只会让正确的改名失败。
- `test/selection-toolbar-settings.test.js`：原本断言工具栏的 `box-shadow` 字面量以 `inset` 开头，
  现在工具栏读 token，断言改成**解析 token 的每一层并验证都是 inset**——这才是那条测试真正要防的东西。

### 6.4 验收

```
npm test                         1361/1361（新增 8 条守卫）
npm run check                    通过（396 个 JS 文件语法 + 架构 + i18n）
npm run check:version            4.1.2 一致
capture-electron.js              44 个窗口表面全部 render clean、0 console error
```

真实截图逐张看过：主窗口亮/暗、通用设置页、AI 与模型页、剪贴板面板、划词条、搜索窗。
暖纸底 + 轻浮面 + 13px 圆角 + 暗色暖烟灰，B1 的「浮层优先」在真实产品里成立。

### 6.5 已知的、本轮没修的东西

- **`capture-electron.js` 对剪贴板面板的 `.dark` 截图是假的**：它用 `body.dark` 切换，
  但剪贴板的重渲染会覆盖回去，所以 `.dark` 图其实是亮色。改动**之前**就是这样
  （实测基线 `clipboard-list.dark.png` 顶栏 `(255,254,251)`）。工装问题，不影响产品；
  本轮没修是因为它属于截图工具，不属于主题落地。
- **动效没统一切换到 `--dur-*`**：token 已就位，各窗口仍是自己的 `.13s`–`.22s`。
- **A1 / C2 原型保留**：没有被任何产品代码引用。

## 5. 风险与预案

| 风险 | 预案 |
|---|---|
| 玻璃（B1）在 Electron 的透明窗口上性能差 | 只在主窗口内部用小面积 `backdrop-filter`；浮层窗口本身是独立透明窗口，**不做**全窗 backdrop，改用半透明底面 + 内高光 |
| 细砂噪点（A1）data URI 太大 | 90×90 的 SVG 噪点 base64 约 400B，可接受；也可用 `repeating-conic-gradient` 近似降级 |
| 宋体正文（C2）在 13px 以下糊 | 正文最小 14px 是硬约束；Windows 上 Noto Serif SC 是可变字重，`font-weight: 500` 比 400 更清楚 |
| 用户把强调色设成极亮/极暗 | 现有 `--primary-ink` / `--primary-text` 的 oklch 阈值机制直接复用，不重新发明 |
| 动效落到真实代码后掉帧 | 只用 transform/opacity；列表 stagger 用 CSS `animation-delay` 而不是 JS 定时器 |
