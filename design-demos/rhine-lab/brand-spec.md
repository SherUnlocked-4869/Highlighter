# 莱茵生命（Rhine Lab）终端视觉规范 · 可执行版

> 用途：把《明日方舟》特别映像「莱茵生命：访问」的终端视觉语言，从两个开源复刻项目里提取成可直接写 CSS 的规范。
> 证据分级：**[官方]** 官方 PV / 官方资料；**[源码]** 复刻项目源码实测值；**[采样]** 我对真实截图的像素采样；**[推断]** 我的推断（无直接出处，谨慎使用）。
> 全部出处见 §9。参考图见 `refs/INDEX.md`。

---

## 0. 一句话定位

**一间白墙实验室里的档案终端**：暖灰纸底、近黑铅字、0 圆角、1px 发丝线、全大写宽字距英文小标压在中文之上，唯一的一点暖铜/信号橙只出现在"被选中"的东西上。

它不是"赛博朋克"，是**医疗器械 + 瑞士排版 + 一点科幻**。

---

## 1. 风格 DNA 十句

1. **底色是纸不是屏**：暖灰白（#EAE5E1 一带，带黄绿倾向），不是纯白 #FFF，也不是深空黑。
2. **墨色是铅字不是荧光**：近黑 #080A08 / #0A0A0A，靠字重与字号拉开层级，不靠颜色。
3. **只有一个颜色是"活的"**：暖铜 #9B7247（亮）/ #C5A16B（暗）或信号橙 #FF7A01；其余全部是灰阶。
4. **零圆角**：整个 RhineLabUI 的 `border-radius` 只有 1 处 `50%`（一个真圆）和 1 处 3px（壁纸特效）；卡片、按钮、弹窗、输入框全是直角。
5. **1px 就是结构**：发丝线画分区、画刻度、画进度；重线才 2px；再没有第 3 种线宽。
6. **英文小标 + 中文并置**：`DEPARTMENT / 科室`、`FILE NUMBER: X-001`、`ABSTRACT / 摘要`；英文永远大写、加 0.12–0.16em 字距，中文永远不加字距。
7. **编号系统是骨架**：`X-001`（三位前导零）、`01 / 05 COLUMN`、`01 概述 / 02 研究记录 / 03 访问日志`、`ARCHIVE / SELECT 01 / 12`。
8. **大字比极大**：58px 计数、40px 标题、37px 物件名，对 9–11px 的元数据标签——中间几乎没有过渡字号。
9. **玻璃是"解密"的介质**：磨砂盖板 → 对角解密线合拢 → 自上而下变清晰；玻璃不是装饰性毛玻璃卡片。
10. **动效是仪器的**：临界阻尼、无回弹过冲、固定节拍（25fps 对齐 / 460ms / 180ms / 300ms），从不"弹一下"。

---

## 2. 色彩

### 2.1 官方基础色（出处：[官方] PV + 官方资料）

| 角色 | 值 | 出处与说明 |
|---|---|---|
| 标志 | `#000000` / `#FFFFFF` 纯黑白 | 官方 PV 封面（BV1rr4y1b7sz）标志为白色描边，标题卡为白/近白；标志本身只有黑白两色 |
| PV 白场 | 约为 `#E3E2DD`–`#E7E7E1`（[采样] 我对此项目 boot 截图采样 `#e3e2dd 24.1%`、`#e4e3de 21.7%`） | RhineLabUI 以原 PV 6.76s 白场为基准重建，`src/style.css` boot-background 为 `radial-gradient(#e7e7e1 → #e3e1dc → #e4dfdb)` |
| PV 标题卡上的**唯一彩色** | 橙色分隔点，[采样] `#FFAE47` ~ `#FFB043` | 官方 B 站 PV 封面 1146×716 中「莱茵生命**：**访问」的冒号为橙色像素；这是全画面唯一的彩色元素 |
| 官方 slogan | 文本，非色值：**Solve Intelligence. Think Different** | [官方] PRTS 泰拉大典·莱茵生命条目 |

> 结论：**官方的"配色"其实是"黑白 + 一点橙"**。不要把它读成"暖灰 + 金 + 青"。

### 2.2 两个复刻项目各自实际用到的值

**A. RhineLabUI（LBEILC/RhineLabUI，MIT）——CSS 变量实测** [源码 `src/theme-ui.ts`]

| token | 亮（白室终端） | 暗（观测室） |
|---|---|---|
| ink（墨） | `#080A08` | `#E0E3DC` |
| muted（次墨） | `#77756D` | `#A6B0B1` |
| line（线） | `#AAA59A` | `#536166` |
| paper（底） | `#EAE5E1` | `#11181B` |
| panel（面板） | `#EDEBE4` | `#202A2F` |
| field（输入底） | `#E7E3D9` | `#2A363B` |
| accent（强调） | `#9B7247` | `#C5A16B` |

同项目其他实测色（`src/style.css`）[源码]：
- `:root { color:#080a08; background:#e8e5e1 }`，`#viewport/#stage` 同为 `#e8e5e1`
- 焦点环 `outline: 2px solid #a67d48`（offset 7px）；选中文本 `background:#cbb397; color:#151713`
- 悬停棕色家族：`#a27849`（刻度）、`#946b3c`（返回按钮）、`#9b7247`（工作台强调）
- 状态点橄榄 `#777b60`（5×5px）；元数据方块 `#8b8f75`（5×5px）；日志绿 `#7a8163`
- 3D 场景：背景/雾 `#eae5e1`（fog 22–47）；暗底 `#11181b`、地板 `#192125`、雾 `#263136`
- 材质：Index_Inlay 铜 `#c6a36b`、橙色件回退 `#bb8850`、Printed_Label `#303a3e`、Titanium `#b1b9bb`

**B. RhinE（ericzhang12111-cell/RhinE，MIT）——design token 实测** [源码 `theme/tokens/tokens.json`]

`ARCHIVE` 配色（默认）亮/暗：

| token | 亮 | 暗 |
|---|---|---|
| bg | `#EEEDE7` | `#0B0B0B` |
| fg | `#252821` | `#F2F0EA` |
| fg-soft | `#4D4F49` | `#BBB9B4` |
| text-muted | `#63665D` | `#8C8B88` |
| line-faint | `#CACAC3` | `#393938` |
| hair（发丝） | `#D2D1CB` | `#30302F` |
| panel / panel-hi | `#F4F3EE` / `#FAF9F4` | `#111110` / `#181817` |
| accent | `#FF7A01` | `#FF7A01`（唯一强调色，明暗同值） |
| on-accent | `#0B0B0B` | `#0B0B0B` |

八套配色（每套亮/暗一双）的 accent 值 [源码]：`ARCHIVE #FF7A01/#FF7A01`、`HAZARD #F2B800/#FFCF1A`、`FLARE #FFFFFF/#FF6B1A`（FLARE 的亮底整页就是橙色 `#FF6B1A`，强调色反过来用白）、`FIELD #1FA84F/#4FDC76`、`COLD FRONT #1F6FFF/#3D8BFF`、`HEARTH #C9631C/#F29A3F`、`LIVEWIRE #17699A/#5CC4EE`、`MATCHA #5F8D2E/#A3C95E`。
→ **每套只有 1 个彩色**（共 15 个 token：bg / fg / fg-soft / text-muted / mark / line-dim / line-faint / hair / panel / panel-hi / case / case-hi / well / accent / on-accent），其余 14 个都是同色系灰阶。

### 2.3 落地 token 表（6–8 色，可直接粘贴）

```css
:root{
  /* ===== 亮底：白室终端 ===== */
  --rl-paper:   #EAE5E1;  /* 底/纸   RhineLabUI paper  · 官方 PV 白场 */
  --rl-lift:    #EDEBE4;  /* 纸面之上的面板/弹窗 panel */
  --rl-ink:     #080A08;  /* 墨      RhineLabUI ink */
  --rl-ink-2:   #77756D;  /* 次墨/元数据 muted */
  --rl-line:    #AAA59A;  /* 发丝线  line */
  --rl-accent:  #9B7247;  /* 强调：暖铜（选中/可点） */
  --rl-alert:   #F2B800;  /* 警示：信号黄 RhinE HAZARD；严重态用 #FF7A01 */
  --rl-glass:   rgba(237,235,228,.97); /* 玻璃层 = panel + 97% 不透明 */
  --rl-glass-edge: #F7F5EE;            /* 玻璃高光边（1px） */
  --rl-shadow:  0 26px 95px #63513a20; /* 唯一允许的大投影 */
}
[data-theme="dark"]{
  /* ===== 暗底：观测室 ===== */
  --rl-paper:   #11181B;
  --rl-lift:    #202A2F;
  --rl-ink:     #E0E3DC;
  --rl-ink-2:   #A6B0B1;
  --rl-line:    #536166;
  --rl-accent:  #C5A16B;
  --rl-alert:   #FF7A01;
  --rl-glass:   rgba(32,42,47,.94);
  --rl-glass-edge: #536166;
  --rl-shadow:  0 26px 95px #00000066;
}
```

> 可选第二档强调（更"仪器"、更亮）：把 `--rl-accent` 换成 RhinE 的信号橙 `#FF7A01`。**同一页面只许出现一种强调色**，不要铜 + 橙同时上。

---

## 3. 字体

### 3.1 三方的选择

| 来源 | 字体 | 角色 | 证据 |
|---|---|---|---|
| 官方 PV | 无公开字体说明；画面为**极简无衬线 + 宽字距全大写** | 标题/提示 | [官方] PV 画面；[源码] RhineLabUI DESIGN.md「暖灰白底、黑色文字…保留原片标题」 |
| RhineLabUI | **MiSans** 300/400/600/700（`misans-webfont@4.3.1`，源字体 4.003） | 全部界面正文、品牌三行、中文 | [源码] `src/fonts.css` 生成自 vendored 分片；`DESIGN.md` 明写「字体为用户指定的 MiSans」 |
| RhineLabUI | **Novecento Sans Wide**（Normal / Bold / DemiBold） | 仅开场文案（ACCESS / ID CONFIRMED / 欢迎三行 / 左上 RHINE LAB） | [源码] `src/boot-lettering.ts` + `boot-lettering.css`「licensed font files are not embedded」；DESIGN.md 2026-09-11 条 |
| RhineLabUI | **@kitlangton/rolling-number 0.4.1** | 所有编号/计数/标题的滚动数字 | [源码] `src/style.css` `--rn-blur:.35; --rn-edge-fade:.08em`；DESIGN.md 460ms |
| RhinE | **Geist Mono**（默认）、**Oxanium**、**Chakra Petch**（可切换，均 SIL OFL 1.1） | 全部界面；CJK 回退系统 UI 字体 | [源码] `theme/tokens/tokens.json` `fonts.family = "Geist Mono"`；`theme/js/lib/tokens.js` `FONT_FAMILIES`；README「three fonts」 |
| RhinE | 字号用 **pt**（9 / 8.25 / 6.75 pt），布局用 **dp**（1pt = 1.333dp） |  | [源码] tokens.json `about` 字段与 `fonts.list/group/label` |

### 3.2 字体在版面上的分工（实测字号/字距）[源码]

| 层级 | 字号 | 字重 | 字距 | 用途 |
|---|---|---|---|---|
| 品牌行 1 | 44–50.75px | 750 / DemiBold | 2.324px（Novecento 版 1px） | RHINE LAB |
| 品牌行 2 | 19px / 23px 行高 | 600 | 0.587px | SYNTHESIZE INFORMATION |
| 品牌行 3 | 35px / 40px | 750 | 0（OS 3px） | ANALYSIS OS |
| 大标题 | 40px / 1.12 | 750 | −1.3px | 档案英文名 |
| 大计数 | 58px | 400 | — | 01 / 12 |
| 物件名 | 37px | 400 | −1px | 3D 档案盒名 |
| 卡片标题 | 28px | 750 | 0.2px | FILE NUMBER |
| 正文 | 15px / 1.95 | 400 | 0 | 摘要段落（justify） |
| 元数据 dt | 9px | 400 | 0.7px | DEPARTMENT / 科室 |
| 微标签 | 8–11px | 400–600 | 0.6–1.7px | tiny-label / footnote / system-footer |
| 英文小标（RhinE） | 9pt | 600 | **0.16em** | 全大写分组标签 |

### 3.3 中文可用替代（本机系统字体已确认安装）

已装：`msyh.ttc`（微软雅黑）、`Deng.ttf/b/l`（等线 DengXian）、`simsun.ttc`（宋体）、`bahnschrift.ttf`、`consola*.ttf`。

**推荐搭配 A —— 亮底 · 白室终端（最像 PV）**
```css
--rl-font-sans: "Microsoft YaHei","微软雅黑",system-ui,sans-serif;      /* 正文/中文 */
--rl-font-label: "DengXian","等线","Microsoft YaHei",sans-serif;       /* 英文小标 + 中文并置，细体更利落 */
--rl-font-num: "Bahnschrift","DIN Alternate",sans-serif;               /* 编号/计数，工业感 */
--track-label: .14em;   /* 仅英文大写；中文不得加字距 */
```
**推荐搭配 B —— 暗底 · 观测室（更终端）**
```css
--rl-font-mono: "Geist Mono",Consolas,"Cascadia Mono",monospace;       /* 全部英文/数字 */
--rl-font-sans: "Microsoft YaHei","微软雅黑",sans-serif;               /* 中文 */
```
**许可内的更好等价**（Google Fonts CDN / 自托管均可）：`Geist Mono`（RhinE 默认，OFL）、`Oxanium`（几何科幻，OFL）、`Chakra Petch`（切角，OFL）——三者都是 OFL 1.1，可直接 `@font-face` 引入替代 Consolas。
**不要**用 Montserrat / Inter / 思源黑体 Bold 来冒充：PV 的字是**窄、直、字面率高、字距宽**，Inter 太圆太松。

---

## 4. 版面语法

### 4.1 网格与边距

- **舞台基准 1920×1080**（RhineLabUI `#stage` 固定 1920×1080，按视口等比缩放）[源码]
- **外边距 59–60px**（≈3.1%）：brand `left:59 top:114`；system-footer `left/right:59 bottom:35`；archive-counter `left:60`；powered `right:59`[源码]
- **模块化栅格 8dp**（RhinE `metrics.module:8`，`gutter:24`，`column-gutter:16`）[源码]
- **三分区**：左（品牌/模型）— 右（档案 callout，`left:970 width:950`）— 底（计数/导航/页脚）。详情页改为左模型 + 右正文列 `left:1154 width:636`。

### 4.2 发丝线规则

```css
--hair: 1px;        /* 唯一常规线宽 */
--heavy: 2px;       /* 只用于标题下 rule 与选中指示 */
```
- 线色：亮 `#AAA59A` / 重线 `#20221D` / 强调线 `#504B41`；暗 `#536166`
- RhINe 的实现哲学可借：`HAIR = max(1, floor(devicePixelRatio))`，**永远在设备像素上取整**（`theme/js/lib/tokens.js`）[源码] → 写 CSS 时避免 0.5px/0.75px 的发丝线在高 DPI 下糊掉。

### 4.3 角标 / 裁切标记

- **6×6 实心方块**挂在 rule 左端（`width:6;height:6;background:#282a24`）[源码 `.callout-rule i`]
- **8×8 描边方框**作为解密扫描的角点（`<rect x-4 y-4 w8 h8>`，fill `#24221f`）[源码 `src/inspection-overlay.ts`]
- 3D 档案盒上的**两处十字螺钉 + 顶边黄色嵌片**（0.25 × 0.2239）[源码 DESIGN.md 2026-09-09 外壳条]

### 4.4 编号系统（必须成套出现）

| 用途 | 格式 | 例 |
|---|---|---|
| 档案编号 | `X-` + 三位前导零 | `X-001` … `X-040` |
| 列编号 | `COLUMN 03 / 05` | `COLUMN 01 / 05` |
| 计数 | 大号 `01` + `/` + 小号 `12` | `01 / 12` |
| 页签 | `01 概述` `02 研究记录` `03 访问日志` | — |
| 列表序号 | 两位 + 空格 + 名称（RhinE） | `01 AURORA` |
| 时间 | 24h `HH:MM:SS`；日期 `TUE · 08 OCT 2026` | — |

### 4.5 字号比与留白

- 字号阶梯实际使用：`8 / 9 / 10 / 11 / 12 / 13 / 14 / 15 / 16 / 19 / 22 / 23 / 28 / 35 / 37 / 40 / 44 / 50.75 / 55 / 58`
- **对比原则**：正文 15–16px 对应微标签 9–11px（比例 ≈1.6×）；大标题 40–58px 对应微标签（≈5×）。**不要用 20px 的中等标题**占据本该由 40px 或 15px 承担的位置。
- 留白：舞台左 59、上 114 起排；callout 与模型之间空出约 40% 画布；正文行高 1.95（`tab-panel p`），中文两端对齐。
- 一个视图只允许 **1 个视觉中心**（模型或正文），另一侧留白。

### 4.6 面板与玻璃层

```css
/* 弹窗 = 玻璃面板（RhineLabUI .terminal-modal 实测） */
.panel{
  background: var(--rl-glass);
  border: 1px solid var(--rl-glass-edge);
  box-shadow: var(--rl-shadow);
  border-radius: 0;                /* 铁律 */
  backdrop-filter: blur(18px);     /* 背景遮罩才用 blur，面板本身 97% 不透 */
}
.backdrop{ background: rgba(227,224,215,.45); backdrop-filter: blur(18px); }
```
- 亮底：面板 `rgba(237,235,228,.97)` + 白边 `#F7F5EE` + 投影 `0 26px 95px #63513a20`
- 暗底：面板 `#202A2F` + 边 `#536166` + 投影 `0 26px 95px #0003`
- 玻璃**只在模态层**使用；主界面是实心纸面。3D 里的玻璃是"档案盒盖板"，会随解密进度从 roughness 0.42 变到 0.025。

---

## 5. 签名细节（12 个，可直接落地）

> 每条都给"它为什么像莱茵"，以及可以直接抄的 CSS 参数。

### 5.1 滚动档案编号 `X-001`
```css
.archive-id{
  font-variant-numeric: tabular-nums;   /* 等宽数字，滚动不抖 */
  --rn-blur: .35;                       /* 运动模糊强度 */
  --rn-edge-fade: .08em;                /* 上下边缘淡出 */
  transition: none;                     /* 动画由 JS 逐位滚动，非 CSS */
}
```
行为：460ms、方向固定向上、快速输入从当前位置接续（不排队）。

### 5.2 权限标签 + 5×5 状态点
```html
<div class="meta"><dt>STATUS / 状态</dt><dd><i></i>已归档 · 可读取</dd></div>
```
```css
.meta dd i{width:5px;height:5px;background:#8b8f75;margin-right:8px;
           display:inline-block;vertical-align:middle}
```
权限值集合（RhineLabUI 实测）：`REFERENCE AREA` / `BUSINESS AREA` / `RESTRICTED`；界面中文对映为「已归档 · 可读取」与「目录访问」。检索行对映 `AUTHORIZED` / `CATALOG ONLY`。

### 5.3 从右向左展开的 1px 分隔线 + 末端 6×6 角标
```css
.rule{height:1px;background:#504B41;margin-left:57px;margin-top:55px;
      transform-origin:right;transform:scaleX(0);
      transition:transform 1.3s cubic-bezier(.22,1,.36,1)}
.rule.is-on{transform:scaleX(1)}
.rule i{position:absolute;left:-61px;top:-3px;width:6px;height:6px;
        background:#282A24;opacity:0}
```
> 这是全站最有辨识度的"一次动作"：线不是淡入，是**从一个点向右量出来**。

### 5.4 分段刻度（file-ticks）
```css
.tick{width:14px;height:40px;position:relative}
.tick::before{content:"";position:absolute;left:6px;top:14px;width:2px;height:12px;
              background:#AAA59A;transition:height .4s,background .4s,top .4s}
.tick[aria-current="true"]::before{height:33px;top:3px;background:#24261F}
.tick:hover::before{height:24px;top:8px;background:#A27849}
```
> 8 个刻度 = 一列 8 份档案；选中时刻度"长高"而不是"变圆点"。

### 5.5 巨型计数
```css
.counter{position:absolute;left:60px;bottom:115px}
.counter .label{font-size:11px;letter-spacing:1.7px}
.counter .num{font-size:58px;line-height:1.1;display:flex;gap:21px;align-items:baseline}
.counter .num i{font-style:normal;font-weight:300;font-size:32px;color:#8F8A80}
.counter .total{font-size:22px;color:#726F67}
```

### 5.6 对角解密线（签名中的签名）
- 2px 线，`stroke:#24221F`，`stroke-linecap:butt; stroke-linejoin:miter; filter:none`
- 两端沿**同一条对角**向中央合拢 → 保持 → 向中央收束 → 淡出
- 附带 8×8 角点方块与 r=1.8 的圆点
- 时间表（原片秒，25fps）：`34.24–36.04 生长` → `36.04–37.72 保持` → `37.72–38.84 收束` → `39.04–39.56 淡出`；交互版压缩到 ≈3.63s
- 缓动：**单调三次 Hermite 插值**（无过冲、无速度突变）

```css
.decrypt-line{position:absolute;inset:0;fill:none;stroke:#24221F;stroke-width:2;
  stroke-linecap:butt;stroke-linejoin:miter}
```

### 5.7 双环 + 正负号标志（∞）
官方构成 [官方 + 源码复刻]：两个交叠圆环 → 形成 ∞；**每环有一处断笔**；左环内 `+`，右环内 `−`；下方 `RHINE · LAB` 宽字距字标。
RhineLabUI 的矢量重建（`src/brand.ts`，viewBox 0 0 310 145）：环描边 `stroke-width:26`，加号两笔 `50/50`、减号 `44`、描边 `15`。开场动画是**一条连续贝塞尔轮廓**被"画出来再擦掉"，断口用 dash 沿轮廓移动（不是两段独立路径）。

```svg
<!-- 可直接用的极简版标识骨架（占位，正式版请用品牌矢量件） -->
<svg viewBox="0 0 310 145"><g fill="none" stroke="currentColor" stroke-width="26">
  <path d="M156 75C127 48 103 15 70 15C37 15 15 39 15 70S38 128 70 128C103 128 127 96 176 52"/>
  <path d="M155 75C182 99 208 128 240 128C273 128 295 105 295 73S273 15 240 15C221 15 207 23 192 38"/>
</g><g fill="none" stroke="currentColor" stroke-width="15">
  <path d="M44 70h50M69 45v50M219 70h44"/>
</g></svg>
```

### 5.8 扫描环（身份验证段）
```css
.scan{transform:scale(.82);transition:transform 1.6s cubic-bezier(.16,1,.3,1),opacity .6s}
.ring{stroke:#AAA9A0;stroke-width:8;stroke-dasharray:2400 900;animation:orbit 8s linear infinite}
.ring--rev{stroke-width:9;stroke-dasharray:590 500;animation:orbit 4s linear infinite reverse}
.ring--thin{stroke:#F4F3EB;stroke-width:3;stroke-dasharray:600 200;animation:orbit 16s linear infinite}
.node{fill:#E7C69B;filter:drop-shadow(0 0 15px #DDB788);animation:orbit 8s linear infinite}
@keyframes orbit{to{transform:rotate(360deg)}}
```
> 三个不同周期（8/4/16s）叠加 → 永不重复的"仪器在扫描"感。**这是全站唯一允许发光的地方**（drop-shadow 15px），因为对应实物是灯。

### 5.9 全黑实心按钮（英文 + 中文）
```css
.solid{background:#252820;color:#F0EEE5;height:46px;padding:0 18px;
       font-size:11px;letter-spacing:1px;border:0;border-radius:0;
       display:flex;align-items:center;justify-content:space-between;
       transition:background .2s}
.solid:hover{background:#4B4A3B}
.solid>span{font-size:11px;color:#BCBFB1;letter-spacing:0}  /* 中文小字，无字距 */
```
文案范式：`＋ SAVE ARCHIVE`（左）/ `收藏档案`（右）；`EXPORT ↓`。

### 5.10 密排元数据（两列 dl）
```css
.metadata{display:grid;grid-template-columns:1fr 1fr;gap:25px 42px;margin:28px 0 34px}
.metadata dt{font-size:9px;letter-spacing:.7px;color:#807B70}
.metadata dd{margin:8px 0 0;font-size:14px}
```
四项固定：`DEPARTMENT / 科室`、`COLLECTION / 编目范围`、`RELATED / 相关人物`、`STATUS / 状态`。

### 5.11 页脚状态行（仪器在运行）
```css
.footer{position:absolute;left:59px;right:59px;bottom:35px;font-size:10px;
        letter-spacing:.9px;display:flex;gap:44px;color:#78776E}
.footer .dot{width:5px;height:5px;background:#777B60;display:inline-block}
```
内容范式：`● SESSION AUTHORIZED ／ INTERNAL DATABASE ／ JOYCE MOORE ／ 12:22:19 ／ 08 OCT 2026`，右端 `POWERED BY RHINE LAB ——`（后者用一条 25×6 实心横杠收尾）。

### 5.12 编号页签 + 1×2px 滑动指示器
```css
.tabs{display:flex;gap:34px;border-bottom:1px solid #BDB8AD;position:relative}
.tabs button{font-size:10px;color:#989184;padding:0 0 14px}
.tabs button span{font-size:13px;margin-left:8px}      /* 中文比英文序号大 */
.tabs button.active{color:#191C16}
.tabs .indicator{position:absolute;bottom:-1px;height:2px;width:1px;background:#25281E;
  transform-origin:left center;transition:transform 180ms cubic-bezier(.22,1,.36,1)}
```

**附加（3D 层）**：档案盒 = 磨砂盖板 + 基板 + 内部光学腔 + 环槽 + 边框 + 螺钉 + 标签 + 刻线；顶边一处黄色嵌片；两处十字螺钉（右上/左下）。玻璃状态在"清晰/磨砂"两态之间连续插值，切换时不重置视角或拆解进度。

---

## 6. 动效词汇

| 动作 | 时长 / 节拍 | 缓动 | 出处 |
|---|---|---|---|
| 逐字输入 | 25fps 帧对齐；字符最短间隔 **24ms** | 线性（逐帧） | RhineLabUI `typing-rhythm.ts` + DESIGN.md 音效条 |
| 滚动数字 | **460ms** | `easeOut = 1−2^(−10t)`（≈`cubic-bezier(.16,1,.3,1)`） | `rolling-number` 0.4.1 / `DESIGN.md` |
| 标题滚动（带模糊） | 460ms，blur `.2` | 同上 | `src/style.css` `--rn-blur:.2` |
| 分隔线展开 | **1.3s** | `cubic-bezier(.22,1,.36,1)` | `.callout-rule` |
| 扫描环入场 | **1.6s**（scale .82→1），opacity .6s | `cubic-bezier(.16,1,.3,1)` | `.scan` |
| 环持续旋转 | 8s / 4s（反向）/ 16s | linear | `.ring-one/two/three` |
| 解密揭示 | 生长 1.8s + 保持 1.68s + 收束 1.12s + 淡出 ≈0.5s（原片）；交互版 ≈3.63s | 单调三次 Hermite，端速 0 | `src/decryption.ts` |
| 玻璃→清晰前沿 | 覆盖高度的 24% 作为羽化带，自上而下 | 单调 | DESIGN.md 外壳条 |
| 详情层进出 | **180ms** | 线性淡入 | `ui-transitions.ts` |
| 弹窗进出 | **300ms 入 / 200ms 出**，位移 12px / 8px | 可中断（从当前透明度接续） | DESIGN.md 详情与弹窗条 |
| 页签 | 正文 150ms 淡入；指示器 **180ms** | `cubic-bezier(.22,1,.36,1)` | `.tab-indicator` |
| 360° 查看器 | 320ms 淡入 / 220ms 退出 / 模型 380ms 从 0.97 倍展开；复位 560ms 减速曲线 | 可中断 | DESIGN.md |
| 主题明暗波 | 每行 **34ms**、每列 **110ms**、最大 600ms；单卡 **580ms**；背景 **850ms** | smoothstep | `theme-motion.ts` |
| 悬停抬起（3D） | ≈200ms，抬 0.28 | 临界阻尼 | DESIGN.md |
| 呼吸 | 8s + 13s 周期叠加，最大位移 0.102 单位（卡高 2.8%） | 正弦 | DESIGN.md |
| 文字乱码还原（RhinE） | **440ms**，左→右逐字定型，其余循环 `#%&/\|=+<>01_-` | easeOut | `theme/js/lib/motion.js` |
| 弹簧 | 临界阻尼 `a = w²(to−x) − 2w·v`，`w` 默认 16 | 无过冲 | 同上 |

**铁律**：
- 所有动效可被 `prefers-reduced-motion` **直落终态**（两个项目都实现）。
- 只允许 **可中断**（从当前值接续），不允许排队播放中间帧。
- 时间都来自"仪器"，不来自"网页"：**>= 180ms 的最小视觉单位，460ms 为标准读数单位**。

---

## 7. 禁区（这个风格最容易做错的地方）

1. ❌ **霓虹青 / 紫粉赛博**。官方是黑白 + 一点橙；项目里暗底强调是 `#C5A16B` 暖铜或 `#FF7A01` 信号橙。出现青蓝 glow 立刻变成另一个 IP。
2. ❌ **绿字黑底 CRT 终端**。莱茵是**白室**，不是机房。
3. ❌ **滥用扫描线 / 噪点**。RhinE 的颗粒只做 ±2 级明暗（"only darkens paper and only lightens void"）[源码 `grain.js`]；扫描线只属于一次"身份验证"动作，不是常驻纹理。
4. ❌ **圆角卡片**。源码里几乎没有 `border-radius`；卡片一律直角。圆角一出现，就从"仪器"变成"SaaS"。
5. ❌ **渐变按钮 / 发光按钮 / 彩色图标**。按钮只有实心近黑或纯文字两种。
6. ❌ **毛玻璃滥用**。`backdrop-filter: blur()` 只出现在模态遮罩一处（18px）。主界面是实心纸。
7. ❌ **emoji / 图标字体**。所有符号都用 CSS 画：`→ ↗ ↓ ＋ − ● ◐`、2px 横竖线组成的放大镜/关闭叉、6×6 方块。
8. ❌ **字距乱用**。英文小标必须 0.12–0.16em 且全大写；中文**不得加字距**（一加就散）。
9. ❌ **中等字号堆叠**。不要 18/20/24px 一路排下去；要么 40–58px 的标题，要么 9–11px 的标签，正文 15px。
10. ❌ **多重强调色**。一屏只有一个彩色；铜、橙、黄同屏 = 失败。
11. ❌ **对称居中大标题 + 副标题 + 三个特性图标**的落地页套路。这套视觉是**左对齐、贴边、按坐标定位**的 HUD，不是营销页。
12. ❌ **扫描线动效盖住正文**。解密/扫描只作用于"档案盒与元数据骨架"，正文必须可读。

---

## 8. 两类落地基调

### 8.1 亮底 · 白室终端（默认，最接近官方 PV）

```css
[data-tone="white-room"]{
  --bg:#EAE5E1;            /* 纸 */
  --bg-glow:#E7E7E1;       /* 中心微亮，边缘 #E4DFDB */
  --ink:#080A08;
  --ink-2:#77756D;
  --line:#AAA59A;
  --line-strong:#20221D;
  --accent:#9B7247;        /* 暖铜 */
  --hover:#A27849;
  --focus:#A67D48;         /* outline 2px, offset 7px */
  --selection:#CBB397;     /* 选中文本底，字 #151713 */
  --glass:rgba(237,235,228,.97);
  --shadow:0 26px 95px #63513a20;
}
```
关键参数：
| 项 | 值 |
|---|---|
| 背景渐变 | `radial-gradient(ellipse at 51% 48%, #E7E7E1 0%, #E3E1DC 76%, #E4DFDB 100%)` |
| 场景雾 | `#EAE5E1`，near 22 / far 47 |
| 光照（若做三维） | 曝光 1.05；环境 0.48；半球光 `#FFFAF5`/`#B4A18C` 0.65；主光 `#FFF7ED` 1.4 @(−6,14,−5)；补光 `#FFFFFF` 0.6 |
| 3D 背景 | `#EAE5E1`；地板 `#D8C9B9`（rough .95） |
| 玻璃盒 | 磨砂 roughness 0.42 → 清晰 0.025；transmission → 0.985 |
| 正文色 | `#5A584E`（不是纯墨；纯墨只给标题） |
| 表格线 | `#BDB8AD` |
| 适用 | 档案浏览、检索、详情正文、打印/导出视图 |

### 8.2 暗底 · 观测室

```css
[data-tone="observation"]{
  --bg:#11181B;            /* 不是纯黑；带蓝绿倾向的烟灰 */
  --lift:#202A2F;
  --field:#2A363B;
  --ink:#E0E3DC;
  --ink-2:#A6B0B1;
  --line:#536166;
  --accent:#C5A16B;        /* 琥珀；若做"信号"档可换 #FF7A01 */
  --glass:rgba(32,42,47,.94);
  --shadow:0 26px 95px #0006;
}
```
关键参数：
| 项 | 值 |
|---|---|
| 场景背景 | `#11181B`；地板 `#192125`；雾 `#263136`，near +1 / far +16 |
| 光照 | 曝光 0.98；环境 0.32；灯强 ×0.65（`themeEnvironment` 把 light.intensity 乘以 `1−0.35×amount`）|
| 边缘 | 需保留"烟灰"而不是纯黑衰减：顶部/底部各加一条 `rgba(17,24,27,.82)` 渐隐 |
| 强调用法 | 只给**当前选中**的标签；其余 index inlay 压到深灰（`#030A0C` 一带，`theme-material.ts` 的 subduedIndex） |
| 玻璃 | 清晰盖板恢复近无色透射；不要"发光的玻璃" |
| 适用 | 观测室/播放态/沉浸阅读、壁纸模式 |

> 切换方式（可直接抄）：以选中单元为原点，**每行延迟 34ms、每列 110ms、最远 600ms**，单卡 580ms、背景 850ms，smoothstep；**不附加位移**，只换颜色；可反向中断。

---

## 9. 出处索引

**官方**
- PV《明日方舟》特别映像「莱茵生命：访问」 BV1rr4y1b7sz — https://www.bilibili.com/video/BV1rr4y1b7sz/ （封面图已存 `refs/rhinelab-pv-cover.jpg`；时长 319s，简介文本「【请求访问】/【身份信息确认：乔伊丝·摩尔】/欢迎访问莱茵生命内部资料档案。/时代正等着你来改变。」来自 B 站 API）
- PRTS 泰拉大典·莱茵生命 — https://m.prts.wiki/w/泰拉大典:组织/莱茵生命 （十科结构、slogan、创始人）
- 标志构成（正负号 + 带断点的无穷符号）：https://www.bilibili.com/opus/655213349959630883 ；
  早期"猫头鹰脸"说法（绘师 NoriZC 自述，后被修改）：https://arknights.fandom.com/wiki/Rhine_Lab/Trivia
- 科室中英名对照参考：https://www.bilibili.com/opus/692744093001842690

**RhineLabUI（MIT，https://github.com/LBEILC/RhineLabUI）**
- `DESIGN.md`（视觉/相机/材质/运动/解密/主题波全部时间参数）
- `src/theme-ui.ts`（明暗 7 组 CSS 变量）、`src/style.css`（全部组件度量）、`src/theme.css`
- `src/brand.ts`（标志贝塞尔路径）、`src/fonts.css`（MiSans 分片）、`src/boot-lettering.ts/.css`（Novecento）
- `src/decryption.ts`（解密时间表与 Hermite）、`src/theme-motion.ts`（明暗波）、`src/typing-rhythm.ts`
- `src/inspection-overlay.ts`（对角线与角点）、`src/hud-projection.ts`（HUD 曲面）
- `src/archive-lighting.ts`、`src/theme-material.ts`、`src/scene.ts`（3D 材质与光照）
- `content/archives.json` + `content/README.md`（档案字段结构）
- 截图：`docs/media/*.jpg`（README 引用，1600×900 JPEG q93，采集于 commit `e0cb75f`）

**RhinE（MIT，https://github.com/ericzhang12111-cell/RhinE）**
- `README.md`（设计原则一句话、"eleven case skins and eight colour schemes"、三字体）
- `theme/tokens/tokens.json`（全部色彩 + 8dp 度量 + pt 字阶）
- `theme/js/lib/tokens.js`（HAIR/HEAVY 设备像素取整、字体回退、CJK 规则）
- `theme/js/style.js`（字距 0.12–0.16em 的标签体系、11 种 skin 描述）、`theme/js/lib/motion.js`（弹簧/乱码/滚数字）
- `theme/js/lib/grain.js`（颗粒 ±2 级）、`theme/js/lib/emblem.js`（Möbius 环 / 嵌套三角）
- `theme/screenshots/v1/*.jpg`（官方仓库自带截图 1932×1050）

**采样说明**：本文件中标注 [采样] 的数值，是我用 ffmpeg 把截图降采样到 64×36 后取 RGB 直方图得到的众数色，与源码常量可能有 ±3/255 的 JPEG 偏差；以 [源码] 值为准。
