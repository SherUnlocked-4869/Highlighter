# refs/ · 参考图索引

> **图片已从仓库删除。** 下面保留的是分组、来源与数量记录；
> 这些图多来自第三方仓库（MIT）与官方 PV，不宜随公开仓库分发截图本身。

所有图片为**动态抓取的真实界面/关键帧**，未做任何配色修改。
抓取方式：`curl` / `git clone` + `ffmpeg`（GIF 抽帧）。抓取日期：2026-10-23。

- **A 组（14 张）**：RhineLabUI（MIT）仓库自带截图与 GIF 抽帧 → 白室终端 / 淡入 / 解密 / 玻璃 / 拆解
- **B 组（9 张）**：RhinE（MIT）仓库自带截图 → 瑞士排版 / 单强调色 / 货架阵列
- **C 组（4 张）**：RhinE 的 3D 渲染件原图（PNG，带透明通道）→ 档案盒与 Möbius 环本体
- **D 组（1 张）**：官方 PV 封面 → 唯一彩色点与标志

合计 **28 张**（14 + 9 + 4 + 1）。

> 图注颜色值若写 [源码]，来自 `brand-spec.md §9` 列出的源码路径；若写 [采样]，为像素直方图众数，有 ±3/255 的 JPEG 误差。

---

## D · 官方

### `rhinelab-pv-cover.jpg`
- 尺寸：1146×716
- 来源：<https://i1.hdslb.com/bfs/archive/5fe6dae6358e0540d253847199ff215aca36be33.jpg>（B 站 API `view?bvid=BV1rr4y1b7sz` 的 `pic` 字段，官方 PV 封面）
- 示范：**官方唯一彩色的位置**——「莱茵生命**：**访问」中间的冒号是全画面唯一的橙色（[采样] `#FFAE47`~`#FFB043`），标志是纯白描边 ∞ + `+`/`−`，字标 `RHINE · LAB` 宽字距。整张封面只有黑白 + 一点橙。

---

## A · RhineLabUI（白室终端）

### `rhinelab-archive.jpg`
- 尺寸：1600×900
- 来源：<https://github.com/LBEILC/RhineLabUI/blob/main/docs/media/archive.jpg>
- 示范：**循环档案阵列**的完整构图——暖灰纸底铺满、五列半透明档案盒向右上退去、左侧 `RHINE LAB / SYNTHESIZE INFORMATION / ANALYSIS OS` 三行品牌、底部 `ARCHIVE / SELECT 01 / 12` 大计数。

### `rhinelab-array-browse.jpg`
- 尺寸：640×360
- 来源：`docs/media/browse.gif` 第 40 帧（ffmpeg 抽帧）
- 示范：**选中态与数字滚动**——`FILE NUMBER: X-0**0**` 正在滚动、`ACCESS FILE →` 悬停箭头、底部 8 个分段刻度与 `↑ ↓` 导航，是"仪器读数"最直接的一帧。

### `rhinelab-detail.jpg`
- 尺寸：1600×900
- 来源：`docs/media/detail.jpg`
- 示范：**双环内构 + 详情正文**——左模型右正文的分栏；右侧 `FILE X-001 / REFERENCE AREA` 页眉、40px 英文名 + 中文副题、`DEPARTMENT / 科室` 四格 dl、`01 概述 02 研究记录 03 访问日志` 编号页签、全黑实心 `＋ SAVE ARCHIVE / 收藏档案` 按钮、页脚 `JOYCE MOORE / 12:22:19 / 16:14:52`。

### `rhinelab-decryption-keyframe.jpg`
- 尺寸：960×540
- 来源：`docs/media/decryption.gif` 第 40 帧
- 示范：**对角解密线合拢前**的中段——2px 黑线沿同一对角两端向中央推进，右侧正文被黑色遮挡条覆盖，只露出标题与字段骨架。

### `rhinelab-decryption-reveal.jpg`
- 尺寸：960×540
- 来源：`docs/media/decryption.gif` 第 60 帧
- 示范：**解密完成态**——磨砂盖板已清晰、内部环体可见、正文完全可读（黑条退开），即"玻璃作为解密介质"的终点。

### `rhinelab-viewer-clear.jpg`
- 尺寸：1600×900
- 来源：`docs/media/viewer-clear.jpg`
- 示范：**清晰玻璃态**的独立查看器：玻璃近无色、内部基板与铜环完全透出，右上 `清晰 | 磨砂` 分段切换与 `拆解档案`。

### `rhinelab-viewer-frosted.jpg`
- 尺寸：1600×900
- 来源：`docs/media/viewer-frosted.jpg`
- 示范：**磨砂玻璃态**（同视角对照）——roughness 0.42 时内部结构被乳白化，与上一张形成"清晰/磨砂"的唯一差别，证明这套设计靠**透射率**而非颜色做层次。

### `rhinelab-assembly.jpg`
- 尺寸：1600×900
- 来源：`docs/media/assembly.jpg`
- 示范：**六组拆解爆炸图**——紧固件 / 透明盖板 / 折射环组 / 光学核心 / 信息基板 / 背板框架沿厚度轴分离，是"货架/档案盒 = 标本盒"的物理解释。

### `rhinelab-boot.jpg`
- 尺寸：1600×900
- 来源：`docs/media/boot.jpg`
- 示范：**白场开场**——`radial-gradient(#E7E7E1 → #E3E1DC → #E4DFDB)` 的纸底上，标志 + `RHINE·LAB` 宽字距字标居中，右下 `POWERED BY RHINE LAB ——`（25×6 实心横杠收尾）。

### `rhinelab-boot-logo-sequence.jpg`
- 尺寸：800×450
- 来源：`docs/media/boot-motion.gif` 第 100 帧
- 示范：**标志的连续贝塞尔描边**——∞ 由一条连续轮廓"画出来"，断口沿轮廓移动；左右两环为反向旋转的弧段，中央是身份验证的提示文字。

### `rhinelab-boot-scan-keyframe.jpg`
- 尺寸：800×450
- 来源：`docs/media/boot-motion.gif` 第 60 帧
- 示范：**权限扫描环**——三道不同周期的虚线圆环（8s / 4s 反向 / 16s）+ 铜色节点 `#E7C69B` + `drop-shadow(0 0 15px #DDB788)`，是全站唯一允许"发光"的地方。

### `rhinelab-research.jpg`
- 尺寸：1600×900
- 来源：`docs/media/research.jpg`
- 示范：**研究记录页签**——`02 研究记录` 激活态、1×2px 滑动下划线、编号列表项 `01/02/03` 用暖棕小字，正文 15px/1.95 两端对齐。

### `rhinelab-search.jpg`
- 尺寸：1600×900
- 来源：`docs/media/search.jpg`
- 示范：**检索结果行**——`X-001 + 中文标题 + 英文副题` 三行密排，右端 `工程研究 / AUTHORIZED ↗` 与 `CATALOG ONLY` 权限语；顶部 2px 下划线的搜索框。

### `rhinelab-settings.jpg`
- 尺寸：1600×900
- 来源：`docs/media/settings.jpg`
- 示范：**玻璃面板**——`rgba(237,235,228,.97)` + `1px #F7F5EE` 白边 + `0 26px 95px #63513a20`，0 圆角，遮罩 `rgba(227,224,215,.45)` + `blur(18px)`；内部全是细线与紧凑排字。

---

## B · RhinE（瑞士排版 + 单一强调色）

### `rhine-archive.jpg`
- 尺寸：1932×1050
- 来源：<https://github.com/ericzhang12111-cell/RhinE/blob/main/theme/screenshots/v1/archive.jpg>
- 示范：**暗底档案货架**——`#0B0B0B` 纯近黑底、`#F2F0EA` 墨、唯一强调色 `#FF7A01` 只出现在选中标记上；货架上的标本盒是渲染件而非卡片。

### `rhine-archive-light.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/archive-light.jpg`
- 示范：**亮底同构**——`#EEEDE7` 纸底 + `#252821` 墨，版面与暗底完全一致，仅换 token：证明"亮/暗"是同一套语法换配色，不是两套设计。

### `rhine-inspect.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/inspect.jpg`
- 示范：**瑞士排版样板**——全大写 9pt/0.16em 小标、8dp 网格、`01 / 10` 编号、全宽发丝线 `#30302F`、右下 `POWERED BY` 式的仪器署名；中文回退系统 UI 字体。

### `rhine-grid.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/grid.jpg`
- 示范：**封面网格版式**——同一套 token 下的第二种布局，证明这套设计不依赖 3D；发丝线是唯一的容器边界，没有卡片阴影。

### `rhine-signal.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/signal.jpg`
- 示范：**Möbius 环形信号显示**——`theme/js/lib/emblem.js` 的 `ring` emblem，会随音乐缓慢旋转；配频谱与整曲波形，是"仪器在读数"的暗底极致。

### `rhine-classic.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/classic.jpg`
- 示范：**标本图版式播放器**——封面像标本卡片、进度是分段刻度环，证明"刻度 + 编号"可以替代所有常规进度条。

### `rhine-lyrics.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/lyrics.jpg`
- 示范：**同步歌词排版**——大字号当前行 + 上下淡出，罗马音/译文用更小更淡的一级；字距与行距在这里是唯一的信息层级手段。

### `rhine-playlists.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/playlists.jpg`
- 示范：**列表与轨道栏**——`rail-width:56dp`、`row:24dp`、`manager-width:232dp` 的度量落地；行分隔只用 `line-faint` 发丝线。

### `rhine-style.jpg`
- 尺寸：1932×1050
- 来源：`theme/screenshots/v1/style.jpg`
- 示范：**11 种 case skin（标本盒皮肤）**——白塑料 / 大理石 / 碳纤维黑 / 危险黄黑条 / 珊瑚 / 玻璃 / 极光；每格 `01 AURORA` 两位编号 + 名称，选中格用 `#FF7A01` 描边。这是"档案盒可以有很多材质，但界面只有一种强调色"的最好证据。

---

## C · 3D 渲染件原图（PNG）

### `rhine-array-clear-m2.png`
- 尺寸：1200×1200
- 来源：`theme/assets/render/case-custom/array-clear-m2.png`
- 示范：**标本盒阵列的原始渲染件**（透明覆盖层），直接看到盒体的圆角极小的硬边、顶部标签槽与侧边刻度。

### `rhine-hero-clear-m1.png` / `rhine-hero-frost-m1.png`
- 尺寸：1000×1000（两文件字节完全相同，该 skin 的 clear/frost 共用同一渲染件）
- 来源：`theme/assets/render/case-custom/hero-*.png`
- 示范：**"清晰 vs 磨砂"的渲染层对照命名法**——同一几何、两个 finish 各出一张 PNG；这套项目把玻璃状态做成预渲染层而不是实时模糊。

### `rhine-inspect-05-m1.png`
- 尺寸：581×687
- 来源：`theme/assets/render/case-custom/inspect-05-m1.png`
- 示范：**单盒检视帧**（60 帧序列中的第 5 帧）——展示盒子绕单轴旋转时的稳定取景，可用于校对"抬起/旋转"的角度。

---

## 缺图说明（不留空）

| 想找的图 | 状态 | 替代证据 |
|---|---|---|
| 官方 PV 5–40s 的**原片帧** | 未拿到（B 站视频流需鉴权，不能抓帧） | 用 RhineLabUI 按其逐帧重建的 GIF 抽帧代替（`rhinelab-boot-*.jpg`、`rhinelab-decryption-*.jpg`），并在 `brand-spec.md` 中把所有时间码标为「原片秒」，而非本站秒 |
| RhinE 的 **QSS 文件** | 仓库中不存在独立 `.qss`；主题全部用 JS 的 Direct2D 绘制 + `theme/tokens/tokens.json` 声明 token | 颜色出处统一改用 `tokens.json`（真值）+ `theme/js/lib/tokens.js`（设备像素取整逻辑） |
| RhinE 的 **8 种配色截图** | 每套只有「亮/暗」两个小缩略图散落在 `style.jpg` 内 | `rhine-style.jpg` 底部 `COLOUR SCHEME 05` 一排 5 个缩略图可读；完整 8 套数值以 `tokens.json` 为准（见 `brand-spec.md §2.2`） |
| RhineLabUI 的 **暗底截图** | `docs/media/` 只有亮底 | 暗底数值取自 `src/theme-ui.ts` 常量；如需画面，可运行 `npm run dev` 后切「暗色」（未执行，避免与设计稿混淆） |
