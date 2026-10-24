# 应用图标参考板 · 取证记录（SOURCES）

本次任务的产出物：
- `design-demos/app-icon/refs/ref-board.png` —— 参考板（1600×892）
- `design-demos/app-icon/refs/dark-taskbar-16-24px-proof.png` —— 深色任务栏小尺寸证据图（1600×763）
- `design-demos/app-icon/refs/SOURCES.md` —— 本文件
- `design-demos/app-icon/refs/raw/` —— 24 个官方原始图标文件

**只收集官方发布的原始图标文件，未重绘、未改色、未做美化**；下文每一条都附可复核的来源 URL 与取得方式。

- 采集时间：2026-10-24
- 采集环境：Windows，从仓库根用 `node` + `node_modules/playwright`（Headless Chromium）渲染参考板
- 覆盖：**7 家**同类产品（要求 5–7 家）+ 4 条平台规范 + 4 项未取得说明
- 校验：`refs/raw/` 共 24 个文件，每个文件的大小/格式在下方「原始尺寸」列逐一核对过

---

## 1. 同类产品真实图标

> 「它做了什么」= 客观描述**图标画面**；「可借 / 该避开」= 对 Highlighter 桌面图标的判断。

| # | 名称 | 官方来源 URL | 取得方式 | 原始尺寸 | 它的图标做了什么 | 可借 / 该避开 |
|---|------|--------------|----------|----------|------------------|----------------|
| 1 | **Snipaste** | 官网 <https://www.snipaste.com/> → 官方下载链接 <https://dl.snipaste.com/win-x64><br>（Store 页 <https://apps.microsoft.com/detail/9p1wxpkb68kx>） | 下载官方 win-x64 包（19.4 MB zip）→ 解包得 `Snipaste.exe` → 从其 PE 资源段 `RT_GROUP_ICON` 提取 ICO → 解出 256px PNG | **256×256** PNG（源自 `.ico`）<br>ICO 内含 16/32/48/64/128/256 | 四块**纯色直角方块**拼成一个不对称十字，右下块被斜切成尖角——抽象「贴图/标记」的四象限。**无底板、无圆角、无阴影**，全透明背景 | **可借**：最激进的「零装饰」路线——纯几何色块在 16px 依然可辨，证明**不放底板也能活**。<br>**该避开**：它依赖四色高饱和拼色来立辨识度；我们的品牌是单一琥珀色，直接照搬到小尺寸会糊成一团 |
| 2 | **PixPin** | 官网 <https://pixpin.com/>（图片直链 <https://pixpin.com/images/logo/1024.png>） | 直接下载官网页面所用的 logo 图（1024px 原图） | **1024×1024** PNG | 白色圆角底板（**四边 0 内边距、满铺到画布边缘**，仅圆角处透明）上，一个**蓝色粗体字母 P** 叠加一对浅蓝圆角**取景框括号**——「P + 截图框」的双关 | **可借**：**取景框括号**这个母题和截图工具的功能绑定极强，且能被缩到 16px 仍读得出「框」。<br>**该避开**：**用首字母当主形**——需要用户先认识品牌才懂；微软规范也明确「图标里不要放文字/字母，应用名会始终伴随显示」。另外它 0 内边距、实体占比 94.8%，是**唯一真正铺满整个画布**的一家，缩小时边缘容易被切 |
| 3 | **ShareX** | 官方 GitHub <https://github.com/ShareX/ShareX> → `ShareX/ShareX_Icon.ico`<br>原始文件：<https://raw.githubusercontent.com/ShareX/ShareX/master/ShareX/ShareX_Icon.ico> | 直接下载仓库内的官方 `.ico` → 解出 256px PNG；另取仓库内 `ShareX.HelpersLib/Resources/ShareX_Logo.png`（256×256）交叉核对 | **256×256** PNG（源自 `.ico`）<br>ICO 内含 16/32/48/256 | 三个**首尾互扣的半透明圆环**（红/绿/蓝）叠成风车状，中心留白眼——「循环 / 捕获」的抽象符号 | **可借**：圆环互扣 = 用**形状关系**而非具体物体表达功能，在任何底色上都成立。<br>**该避开**：**半透明叠色**在深色任务栏上会掉对比度；且这种几何图形缩小到 16px 时三环糊成一个彩色团（见参考板底排 16px 小图） |
| 4 | **Microsoft 截图工具 Snipping Tool**（Win11 版） | Microsoft Store 产品页 <https://apps.microsoft.com/detail/9MZ95KL8MR0L><br>本机官方包 `Microsoft.ScreenSketch` 11.2605.38.0 | 从本机已安装的**微软官方 MSIX 包**里直接取官方资产 `Assets/SnippingToolAppList.targetsize-256.png`（同时取 16/24/48px 帧） | **256×256** PNG<br>另有 16/24/48px 官方帧 | 白色圆角方底板（squircle 观感），上面一把**灰色剪刀**与一圈**橙色虚线选框**叠成「裁切」动作。是唯一**官方多层叠放 + 有底板**的一家 | **可借**：**「选框四角 + 工具」的双层结构**能同时说清「框」和「截」；官方还提供了 16/24/48 三档**单独绘制**的帧，值得学「每档单独调」的做法。<br>**该避开**：它靠**白底板**换取浅色场景的可读性，代价是深色任务栏上会变成一个白方块；我们也已有浅/深两套 tray 资产的类似问题 |
| 5 | **CleanShot X**（macOS） | 官网 <https://cleanshot.com> → 官方 DMG（Homebrew cask 元数据核对的官方地址）<https://updates.getcleanshot.com/v3/CleanShot-X-5.0.1.dmg> | 下载官方 DMG（50.6 MB，sha256 与 cask 记录一致）→ 7-Zip 解包 → `CleanShot X.app/Contents/Resources/AppIcon.icns` → 解析 ICNS 取出 1024px PNG | **1024×1024** PNG（源自 `.icns`，另含 128/256/512） | **深灰圆角底板**，右上角一张**蓝色纸页被卷起一角**（翻页高光），页面上撒着**几个彩色小圆点/方块**（截图后的标注点） | **可借**：**「卷角」**是目前最能一眼读出「截图/贴图」的单一动作，且用一个**明暗渐变**就把纸的厚度说清了；彩色小点极省笔墨地暗示「标注」能力。<br>**该避开**：它是 macOS 应用（圆角矩形是系统强制的），**尺寸语义与 Windows 不同**——它的实体区域在四周留了约 9.8% 的透明边，留白比例比 Windows 惯例（0–6.3%）大得多（见 §3） |
| 6 | **Flameshot**（加分项） | 官方 GitHub <https://github.com/flameshot-org/flameshot> → `data/img/app/org.flameshot.Flameshot-1024.png`<br>原始文件：<https://raw.githubusercontent.com/flameshot-org/flameshot/master/data/img/app/org.flameshot.Flameshot-1024.png> | 直接下载仓库内官方资产（另存了同目录的 `flameshot.svg` 矢量原件） | **1024×1024** PNG（另有官方 SVG） | **紫色满铺圆形**里一朵黄→品红渐变的**火焰**，无底板、无边框，纯「圆形 + 一个符号」 | **可借**：**「一个容器形 + 一个符号」**是最省认知的结构，缩到 16px 仍是个「有东西的圆」；圆形在深/浅底上都安全。<br>**该避开**：**满铺实心圆**在 Windows 任务栏上会被系统当成「已带底板」，与其它程序图标并排时会显得偏重；而且它和「截图/标记」的语义关联很弱（火焰是项目名不是功能） |
| 7 | **Windows PowerToys**（加分项） | 官方 GitHub <https://github.com/microsoft/PowerToys> → `doc/images/icons/PowerToys icon/PNG/PowerToysAppList.targetsize-256.png`<br>原始文件：<https://raw.githubusercontent.com/microsoft/PowerToys/main/doc/images/icons/PowerToys%20icon/PNG/PowerToysAppList.targetsize-256.png> | 直接下载微软官方仓库内的 AppList 图标（同目录另有完整 `.ico` 与 14–256px 全尺寸 PNG） | **256×256** PNG<br>另有官方 `.ico`（内含 16/20/24/32/40/48/64/256） | **米色底板上一个深色「彩色色卡/工具盒」**：中央一条橙→绿→蓝渐变竖条 + 底部三个浅色小方块。**有底板、有内边框、有内阴影** | **可借**：这是**微软自家**在 Windows 上的基准答案——底板 + 内边框 + 单一符号，与系统其它图标并排不打架；它的 `.ico` 尺寸集合是全样本里最全的。<br>**该避开**：细节密度明显偏高（渐变条 + 三块小方 + 双层边），在 16/24px 会全部糊掉；它自身也只有 224/256 ≈ 87% 的墨迹占比 |

---

## 2. 参考板里怎么读这些数据

`ref-board.png`（1600px 宽）分上下两条带，**同一批原始位图 1:1 渲染**：

- **上排白底 `#ffffff` / 下排深底 `#14161a`** —— 用来同时看「浅色资源管理器」和「深色任务栏」两种实际环境。
- 每格下方：产品名 → **原始像素尺寸** → 取得方式 → 来源域名。
- 每格最底部的小图：把**同一个原始文件**缩到 `16px` / `24px`，即任务栏与托盘的真实尺寸。**这不是官方提供的 16px 帧**（只有 Snipping Tool 我们拿到了官方 16/24px 帧），而是一次「缩下去会不会烂」的直接压力测试。

---

## 3. 实测：各图标的有效墨迹占比（自己算的，可复现）

对每个原始位图逐像素扫描 alpha 通道，求**实体区域（α ≥ 200）**的紧致包围盒与占比。**这是「该不该铺底板」最硬的一条证据。**
（用 α ≥ 200 而非 α > 0 是刻意的：很多图标带极淡的外发光/投影，按 α>0 算会把包围盒撑到满画布，失去意义。）

| 名称 | 画布 | 实体占比 | 四边留白（左/上/右/下） | 是否满铺底板 |
|------|------|---------|------------------------|--------------|
| Snipaste | 256×256 | 52.5% | 12.5% / 0.0% / 12.5% / 0.4% | 否（图形上下顶到边） |
| PixPin | 1024×1024 | 94.8% | 0.0% × 4 | **是**（白底板满铺到边） |
| ShareX | 256×256 | 64.9% | 3.9% × 4 | 否（仅 4% 安全边） |
| Snipping Tool | 256×256 | 61.2% | 0.0% × 4 | **是**（白底板满铺到边） |
| CleanShot X | 1024×1024 | 61.0% | 9.8% × 4 | 是（深色底板，四周留 9.8%） |
| Flameshot | 1024×1024 | 69.7% | 2.9% / 2.8% / 2.9% / 3.0% | 是（紫色实心圆，几乎满铺） |
| PowerToys | 256×256 | 76.4% | 6.3% × 4 | 是（米色底板，留 6.3%） |

**结论（跨 7 个真实产品）**：留白差异从 0% 到 12.5% 都有，**没有统一约定**。但可以观察到一个规律——
凡是**自己画了底板**的（PixPin / Snipping Tool / CleanShot X / Flameshot / PowerToys，5/7 家），底板都画到**接近画布边缘**（0–9.8%）；只有**没底板**的（Snipaste / ShareX）才依赖 4–12.5% 的透明边距。也就是说：**「有底板」和「留安全区」是两套互斥的策略，不要既铺满底板又留大边**——否则底板会变成画面中间一块奇怪的方块。

---

## 3b. 实测：深色任务栏上最容易糊掉的是哪几个

**方法**：把每个官方图标按 Lanczos 重采样到 16×16（任务栏/托盘 100% 缩放的真实绘制尺寸），逐像素与任务栏底色 `#14161a` 算 WCAG 对比度。**只统计 alpha ≥ 128 的不透明像素**——透明背景是合法设计（Snipaste 有 47% 是透明的），若把透明像素也算进「身体」会冤枉它。数值可复现：`.tmp-icon/ref/dark-legibility.mjs`。

**可视证据**：`refs/dark-taskbar-16-24px-proof.png`（同一批图标叠在 `#14161a` 上，16px 与 24px 两排，**8× 最近邻放大、未插值**，像素保持诚实）。

| 名称 | 图标实体占比 | 实体中位对比度 | 过 3:1 面积 | 过 4.5:1 面积 | 内部边缘能量 | 融底面积(<2:1) |
|------|-------------|---------------|------------|--------------|-------------|---------------|
| **Flameshot** | 70% | **2.37 : 1** ❌ | 28% | 22% | 0.061 | 0% |
| **CleanShot X** | 55% | 5.84 : 1 | 79% | 61% | 0.069 | **11%** |
| PowerToys | 77% | 5.93 : 1 | 95% | 59% | 0.147 | 0% |
| ShareX | 63% | 5.97 : 1 | 100% | 89% | **0.058** | 0% |
| Snipaste | 49% | 6.94 : 1 | 100% | 100% | **0.022** | 0% |
| Snipping Tool | 62% | 11.80 : 1 | 100% | 96% | 0.157 | 0% |
| PixPin | 95% | 17.05 : 1 | 100% | 100% | 0.106 | 0% |

**结论（一段话，直接可用）**：

> 深色任务栏上最容易糊掉的是 **Flameshot** 和 **CleanShot X**，但两者糊掉的原因完全不同。
> **Flameshot 是「底色与任务栏打架」**：它那圈几乎满铺的**深紫色圆盘 RGB(136,0,170) 对 `#14161a` 只有 2.27:1**，而圆盘占了图标的 70%；整枚图标只有 26% 的面积能过硬 3:1——亮黄→品红的火焰本身够亮（最高 6.17:1），却被包在一个和任务栏几乎同明度的紫盘里，于是 16px 下看到的是「一团暗紫里有个小亮点」，轮廓先丢了。
> **CleanShot X 是「深色底板融进深色任务栏」**：它的深灰底板底边实测 RGB(55,60,71) 对任务栏只有 **1.64:1**，11% 的实体面积落在 2:1 以下——底板边缘与任务栏糊成一片，图标看起来像是「没有边界、只剩中间一张蓝色纸页浮着」；好在纸页本身是 9.6:1 的亮蓝，核心信息还在，但**图形外轮廓完全丧失**。
> 反过来，**Snipaste 是教科书式的反面示范怎么躲坑**：它没有底板、47% 透明，实体像素中位对比度 6.94:1、100% 过 4.5:1，虽然内部边缘能量最低（0.022，因为就是四块纯色），但**轮廓极其干净**，在深色栏上反而比两个「有底板」的更清楚。
> 给我们的直接教训：**深色场景的敌人不是「没有底板」，而是「底板明度接近任务栏」**。若要保留底板，底板与 `#14161a` 的对比至少要 ≥3:1。
> ⚠️ **需要立刻复核的自家数字**：现有三个候选方向（`design-demos/app-icon/out/manifest.json`）用的底板渐变是 `#2c261e → #161310`，实测对 `#14161a` 只有 **1.21:1 → 1.02:1**，比 CleanShot X 的 1.64:1 **还要低**——也就是说，我们现有的深色底板方向在深色任务栏上会重蹈 CleanShot X 的覆辙（甚至更严重）。同一套色里 `#f9f5ec` 奶白（16.65:1）和 `#e5a44c` 琥珀（8.41:1）都是安全的，问题只出在**深色底板那两档**。
> 另外 **ShareX 的 0.058 低边缘能量**说明「半透明互扣圆环」这类造型在小尺寸会糊成彩团——这也是我们要避开的。

---

## 4. 实测：官方 `.ico` 里到底装了哪些尺寸

不看文档，直接解析三家官方 `.ico` 的目录项：

| 名称 | `.ico` 内含尺寸 | 备注 |
|------|----------------|------|
| ShareX | 256(PNG) / 48 / 32 / 16 | 只有 4 档，**省略了 24px** |
| Snipaste | 128 / 72 / 48 / 32 / 24 / 16（全为 8bpp DIB） | 有 128，**没有 256**；且用 8 位调色板而非 32 位真彩 |
| PowerToys | 256(PNG) / 64 / 48 / 40 / 32 / 24 / 20 / 16 | 最全，**无 128** |

**结论**：官方必备项就是 `16 / 24 / 32 / 48 / 256`（三家全都有），而 `20 / 40 / 64 / 128` 是**按需**——PowerToys 为 125%/200%/250% 缩放到 20/40/64，Snipaste 则给了 128 却没给 256。`128` 在这三家里只有 1 家提供。

---

## 5. 平台规范（可核验的事实）

> 每条都写「原文 + 来源 URL」。凡查不到的，明确写查不到，不做推断。

### 5.1 Windows `.ico` 必须包含哪些尺寸

**结论**：微软文档明确给出的「底线」是 **16 / 24 / 32 / 48 / 256**，其中 256 的作用是「保证 Windows 只会缩小、永不放大」。`20 / 40 / 64` 等是**缩放因子变体**，按使用场景需要才加；`128` **不在微软的任何必备列表里**。

- 来源：<https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-construction>
- 原文（Icon scaling 一节下的 Note）：

  > Apps should have, at the bare minimum: 16x16, 24x24, 32x32, 48x48, and 256x256. This covers the most common icon sizes, and by providing a 256px icon, ensures Windows should only ever scale your icon down, never up.

- 同一页的缩放表（为什么会有 20/40/64）：显示缩放 100/125/150/200/250/300/400% 时，**右键菜单、标题栏、系统托盘**对应 `16/20/24/32/40/48/64` px；**任务栏、搜索结果、开始菜单所有应用列表**对应 `24/30/36/48/60/72/96` px；**开始菜单固定项**对应 `32/40/48/64/80/96/256` px。
- 同一页的匹配规则：

  > When Windows displays your app's icon, it will look for an exact size match first. If there is no exact match it will look for the next size above and scale down.

- ⚠️ **诚实说明**：该页有一个 `## Icon sizes (Win32)` 小节，但**正文只有一句话**（"standard sizes that are used which is a subset of the full set above"），**表格是空的**——我核对了页面 HTML 和官方 Markdown 源文件（`raw.githubusercontent.com/MicrosoftDocs/windows-dev-docs/docs/hub/apps/design/iconography/app-icon-construction.md` 第 21–23 行），两处都没有 Win32 尺寸表。所以「Win32 该有哪些尺寸」在**这份文档里查不到细则**，只能依据上面那条 Note + §4 的实测。

- 补充（历史文档，作者自己标注了「未针对新版更新」）：Windows Vista 时代的设计指南给出的应用图标全集是 `16/32/48/256`，并说明「Classic 模式」为 `16/24/32/48/64`。此为历史规范，**不应直接当作 Win11 要求**。
  - 来源：<https://learn.microsoft.com/en-us/windows/win32/uxguide/vis-icons>
  - 原文：> Application icons and Control Panel items: The full set includes 16x16, 32x32, 48x48, and 256x256 (code scales between 32 and 256). The .ico file format is required. For Classic Mode, the full set is 16x16, 24x24, 32x32, 48x48 and 64x64.
  - 该页开头自述：> This design guide was created for Windows 7 and has not been updated for newer versions of Windows.

### 5.2 Windows 11 图标有「squircle 底板 / 安全区」约定吗？

**结论：查不到。** 我通读了微软官方的应用图标设计页与构建页（含其 Markdown 源文件），**没有任何一处**使用 "squircle"、"safe area"、"安全区" 或规定「图标必须画圆角底板 / 必须留 N% 边距」的表述。能找到的最接近的三条官方说法如下——注意它们**都不是**「必须」：

1. **底板是可选的，但有代价。**
   来源：<https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-construction>（Transparent backgrounds 一节）
   > Icons look best with a transparent background. If your app's branding requires your icon be plated on a background, that's okay too. However, you'll have to re-implement some theming functionality that transparent icons get for free. For example, you might provide a version of your app's icon plated on a two different backgrounds, one better suited to a light theme and the other to a dark theme.

2. **不提供深/浅主题资产时，Windows 会自己给图标加一个「系统底板」。**（也就是说底板是系统的兜底行为，不是让应用自己画）
   同页：
   > Separate files for all three theme variations (default, light theme, dark theme) are required, even if the icon is the same. If you do not provide these files, your icon will appear on a system icon plate to ensure a minimum contrast ratio.

3. **唯一被明文规定的「圆角」是 48×48 网格上的 2px / 1px 半径。**
   来源：<https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-design>（Shape → The grid and rounded corners）
   > Microsoft aligns its icons to a 48x48 grid initially to ensure a balanced icon that takes advantage of the space available, while still maintaining a distinctive shape and silhouette.
   > … When rounded corners are applied to an exterior curve, use a 2px radius at 48x48. When rounded corners are applied to an interior curve, use a 1px radius instead.

   （即：**外圆角 2px、内圆角 1px，基准网格 48×48**。这是「圆角该多大」唯一有数字的官方出处，但它针对的是**图形轮廓**，不是「必须画一个方形底板」。）

> 🧭 对我们项目的实际含义：**「画一个圆角矩形底板」不是 Windows 的要求**，而是很多应用（以及我们现有的 3 个候选方向 A/B/C，都是用 `rx=58` 的底板）自己选择的品牌策略。要在 Windows 上「看起来像原生应用」，官方给的抓手其实是 48 网格 + 2px/1px 圆角 + 明确建议透明背景，而**不是**某个特定的底板形状。另外注意 CleanShot X 那类 macOS 图标的圆角是**系统强制**的，不能作为 Windows 的参考依据。

### 5.3 Fluent 关于「小尺寸简化 / 网格 / 笔画下限」的可引用说法

**(a) 产品图标缩到 48px 以下要「简化」，且要按具体尺寸单独出图，不要靠缩放。**
来源：<https://fluent2.microsoft.design/iconography>（Product launch icons → Scaling down）
> As the product icons scale below 48 pixels, they simplify in detail in favor of readability. Use icons at specific sizes, instead of scaling them, to create pixel-perfect results.

（同页 Scaling up：> When scaling product icons larger than 48 pixels, use the full-fidelity icon and scale by factors of four, (48, 64, 96…). Scaling to 4x the base icon, i.e. 48 pixels to 192 pixels, ensures pixel perfection.) —— 即**放大按 4 倍档：48/64/96**。

**(b) 「笔画下限」要说清楚是**哪一类**图标：Fluent 系统图标是单线（monoline），笔画 = 1 epx。这个数字**不适用于应用图标**。**
来源：<https://learn.microsoft.com/en-us/windows/apps/design/iconography/>
> All glyphs in Segoe Fluent Icons are drawn in a monoline style. That means they're created through a single stroke of 1 epx.

同页还有对「小图标只做信息、不做交互」的说法：
> Use 12 pixel icons to give information — They're generally too small for interactions.

> ⚠️ 诚实说明：我在微软官方文档里**没有找到**针对**应用图标（app icon）**的「最小笔画宽度」规定。1 epx 是 Segoe Fluent **字体字形**的规范，属于应用**内部 UI 图标**，不是桌面图标。请勿把「1px 笔画」写进 app icon 的设计规范里。

**(c) 网格与隐喻的硬性约束（可引用，且对我们直接有用）**
来源：<https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-design>
> Your icon should illustrate the concept of your app in a singular element using simple forms. … To enhance communication clarity, use no more than two metaphors in a single icon. If a single metaphor can be used, that's even better.
> Icons should not include typography as part of the design. Letters and words on your icon should be avoided and only used when it's essential. The app's name will appear in association with the icon throughout the operating system.

同页还有一条关于对比度的可执行阈值（很适合验收时用）：
> Make sure at least half of your icon passes a 3.0:1 contrast ratio on light and dark theme.

以及一条**已取消**的要求，避免我们白做：
> Windows 11 no longer requires high contrast assets for app icons.

### 5.4 taskbar / 托盘 16–24px 的现实约束

**结论**：托盘在 100% 缩放下按 **16px** 绘制，150% 时 **24px**，200% 时 **32px**（见下方缩放表区间）。官方要求**同时提供 16×16 与 32×32，并用 `LoadIconMetric` 让系统挑**，而不是让系统去缩放单一尺寸。

来源：<https://learn.microsoft.com/en-us/windows/win32/shell/notification-area>
> Notification area icons should be high-DPI aware. An application should provide both a 16x16 pixel icon and a 32x32 icon in its resource file, and then use LoadIconMetric to ensure that the correct icon is loaded and scaled appropriately.

尺寸区间（与 5.1 的缩放表一致）：托盘/标题栏/右键菜单在 100%–400% 缩放下依次是 `16 / 20 / 24 / 32 / 40 / 48 / 64` px。

**小尺寸必须重画、不能缩**的三条官方原话：

- 来源：<https://learn.microsoft.com/en-us/windows/win32/uxguide/vis-icons>
  > Simply scaling down from the 256x256 size does not work. … All sizes need relevant level of detail; the smaller the icon the more you need to exaggerate the defining details.
  > At the size of 16x16 pixels and smaller, render icons straight-on (front-facing).
  > Don't use shadows in icons at 24x24 or smaller sizes.

  （同上，该页自述是 Windows 7 时代文档、未针对新版更新，引用时应带上这个限定。）

- 与 Fluent 的「below 48 pixels → simplify」互为印证（见 5.3a）。

**对我们项目的直接含义**：`main/services/tray-icon.js` 现在固定按 **24px 逻辑尺寸**渲染（该文件注释说明这是为了让 150% 缩放下不糊）。这与官方「提供 16 与 32 两档、让系统用 LoadIconMetric 挑」的做法**不完全一致**——我们是给了单一 24px 位图、由 Windows 去缩放。这是个可讨论的取舍（当前实现是刻意的，见该文件注释列出的第 3 个陷阱），本次只做取证、不改代码。

---

## 6. 未取得项（明确列出，未用臆造图代替）

| 项 | 状态 | 原因 |
|----|------|------|
| **CleanShot X 官方 press kit / 品牌资源包** | 未取得 | 官网无 press kit 页面；搜索结果里的 brandfetch / toolradar / logo-marque 等均为**第三方** logo 站，不能算官方来源，故**弃用**。改从官方 DMG 内的 `.icns` 提取，来源链可核验（sha256 与 Homebrew cask 记录一致） |
| **Snipaste 官网 ≥128px 位图** | 未取得（已用等价方案补齐） | 官网只提供 `favicon.ico`（8bpp 调色板，最大 128px）与 60×60 的 apple-touch-icon。**官方站点没有 256px 位图**。改用官方安装包内 exe 的图标资源取得真 256px PNG（同一品牌官方产物） |
| **Microsoft Store 商品图 API 里的 Snipping Tool 图标** | 未取得 | 查询 `displaycatalog.mp.microsoft.com` 的 Products 详情，返回的 package 节点中 `Logo` 为 `null`，未给出可直接下载的图标 URL。改用本机已安装的**微软官方 MSIX 包**内的 `AppList.targetsize-256.png`（更权威，且能拿到官方 16/24/48 帧） |
| **Windows 11「squircle 底板 / 安全区」官方规范** | **查不到** | 微软官方 app icon 文档中无此表述（详见 §5.2）。我们现有候选方向里的 `rx=58 @ 256` 属于自定品牌策略，**没有官方依据可引**，不应在文档里写成「符合 Windows 规范」 |
| **应用图标的「最小笔画宽度」官方数值** | **查不到** | 官方只对 Segoe Fluent **字体字形**规定 1 epx（§5.3b）。app icon 无对应数值 |
| **PowerToys / Flameshot 的 Store 商品页图** | 未取（不需要） | 这两家官方 GitHub 仓库内即有权威原图（含 `.ico` 与 14–256px 全档 PNG），优先用仓库原件 |

---

## 7. 文件清单

### `refs/raw/`（24 个文件，全部为官方原始文件或其无损提取帧）

```
CleanShotX/
  CleanShot_X_1024px.png      1024×1024  ← ref-board 使用的主图（.icns 提取）
  CleanShot_X_512px.png        512×512
  CleanShot_X_256px.png        256×256
  CleanShot_X_128px.png        128×128
  CleanShot_X_AppIcon.icns     官方原始 .icns（1.13 MB，保留以便复核）
  CleanShotX_web_touchicon_180.png   官网 apple-touch-icon（180×180）
  CleanShotX_web_favicon_32.png      官网 favicon@2x（32×32）
Flameshot/
  Flameshot_1024.png          1024×1024  ← ref-board 使用的主图
  Flameshot.svg                  官方矢量原件
PixPin/
  PixPin_1024.png             1024×1024  ← ref-board 使用的主图
PowerToys/
  PowerToys_256.png            256×256   ← ref-board 使用的主图
  PowerToys.ico                  官方原始 .ico（内含 16–256 共 8 档）
ShareX/
  ShareX_256.png               256×256   ← ref-board 使用的主图（.ico 提取）
  ShareX_AppIcon.ico             官方原始 .ico
  ShareX_Logo.png              256×256   （仓库内官方 logo，交叉核对用）
Snipaste/
  Snipaste_256.png             256×256   ← ref-board 使用的主图（exe 资源提取）
  Snipaste_exe.ico               官方 exe 内提取重组出的 .ico
  Snipaste_web_favicon.ico       官网原始 favicon（最大 128px）
  Snipaste_favicon_128.png     128×128   （上述 favicon 的 128px 帧解码结果）
  Snipaste_web_touchicon_60.png 60×60
SnippingTool/
  SnippingToolAppList.targetsize-256.png  256×256  ← ref-board 使用的主图
  SnippingToolAppList.targetsize-48.png    48×48   （官方单独绘制帧）
  SnippingToolAppList.targetsize-24.png    24×24   （官方单独绘制帧）
  SnippingToolAppList.targetsize-16.png    16×16   （官方单独绘制帧）
```

### `refs/ref-board.png`

1600×892，白底 + 深底两条带，各 7 格。

### `refs/dark-taskbar-16-24px-proof.png`

1600×763，§3b 的可视证据：同样 7 个图标叠在 `#14161a`（深色任务栏）上，16px / 24px 两排，8× 最近邻放大，图上直接标了各家对比度。

---

## 8. 复现方式

临时脚本都在 `.tmp-icon/ref/`（已 gitignore，收尾时已删除）：

- `board.mjs` —— Playwright 渲染 `ref-board.png`
- `dark-legibility.mjs` —— 深色任务栏对比度/边缘能量实测（§3b 的数值来源）
- `dark-proof.mjs` —— 渲染 `dark-taskbar-16-24px-proof.png`
- `ico.mjs` —— 手写 ICO 解析器（枚举目录项；支持 PNG 帧与 32bpp/8bpp 调色板 DIB 解码）
- `peicon.mjs` —— 从 PE 文件资源段提取 `RT_GROUP_ICON` 并重组为标准 `.ico`（Snipaste 的取法）

```bash
cd /f/workspace/Highlighter          # 必须在仓库根跑，否则 playwright 解析不到
node .tmp-icon/ref/board.mjs            # 重新生成参考板
node .tmp-icon/ref/dark-legibility.mjs  # 重跑深色任务栏实测
node .tmp-icon/ref/dark-proof.mjs       # 重新生成深底证据图
node .tmp-icon/ref/peicon.mjs <exe> <out.ico>   # 从任意 exe 提取应用图标
```
