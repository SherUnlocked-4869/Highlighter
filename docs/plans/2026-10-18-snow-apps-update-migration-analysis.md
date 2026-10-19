# 对标分析：Snow Apps（Snow Shot）v1.2.6 → v1.3.2 新增能力，及向 Highlighter v3.0.0 的迁移评估

- 日期：2026-10-18（分析）／2026-10-19（实施回填）
- 性质：**分析 + 实施**。§0–§17 仍是 2026-10-18 的只读分析原文（未改动结论）；**§18 是本轮实际实施的落地记录**，逐项标注了"做了什么 / 落点 / 与分析的偏差 / 未做"
- 对标对象：`F:\workspace\snow-apps`（Snow Shot，C++/Qt 6 + Rust）
- 本项目：`F:\workspace\Highlighter`，`package.json` 版本 **3.0.0**（实施基线 `master @ d9ad364`，2026-10-19）
- 分析区间：`v1.2.6_snow-shot`（`ef47b48c6`，2026-10-10 11:36 +0800）→ `HEAD`（`881132435`，2026-10-18 20:01 +0800）
- 上游节奏：**8.4 天 6 个发布标签**（v1.2.7 / 1.2.8 / 1.2.9 / 1.3.0 / 1.3.1 / 1.3.2），约 1.5 天一个
- 关联文档（本文件不替代、只修正）：
  - `docs/plans/2026-10-10-snow-apps-feature-gap-analysis.md`（全仓对标，基线 v2.3.1）
  - `docs/plans/2026-10-14-snow-apps-toolbar-interaction-gap-analysis.md`（工具栏交互专题，基线 v2.5.0）
  - `docs/plans/2026-10-15-capture-interaction-handoff.md`（当前状态入口）
- 分域底稿：本轮分析由 5 路并行调研产出 5 份分域底稿（基线与许可证 719 行 / 截图与标注 510 行 / 新编辑器与外壳 590 行 / OCR·翻译·MCP 562 行 / 录屏·贴纸·平台 425 行）。它们是**一次性工作产物，未入库**（写在 `.tmp/snow-migration-analysis/`，该目录已被 `.gitignore` 忽略）。

> ⚠️ **本文件是自包含的**：每条结论都带上游与本仓的 `file:line` 证据，§17 给出全部可复现命令——不依赖那 5 份底稿也能逐条复核。底稿只在需要看"某一项的完整推导过程"时有用；若要重建，按 §17 的命令重新跑一遍即可。
>
> 📌 **实施状态见 §18**：本轮按 §0.3 的 7 项 P0 ± 批 1/2/4 落地，`main.js`、门禁读数、新增 IPC 通道、新增文件、以及对分析中若干成本估算的实测偏差都记在那里。§1.4 的"当前值"和 §2 的实测结论仍然是**分析当时**的读数，实施后的新读数以 §18.6 为准。

**读法建议**：先读 §0（结论摘要与 P0 清单）→ §14（批次路线）→ §13（合规前置）；需要逐项证据时再进对应章节。§15 列出与旧文档的冲突，引用旧文档前必看。

**给不同角色的入口**：

| 角色 | 先看 |
|---|---|
| 产品/排期 | §0.2 判定分布 → §0.3 P0 清单 → §14 批次 → §14.2 做/缓/不做 → **§18.1 已落地** |
| 开发（截图/标注） | §3 选区与成品感 → §4 标注工具 → §1.3 已落地基线 → **§18.3** |
| 开发（录屏/贴纸） | §8 录屏 → §9 贴图 → §2 实测结论（V1/V3）→ **§18.4** |
| 开发（识别/MCP） | §6 OCR → §7 MCP → §13 合规前置 → **§18.5** |
| 合规/发布 | §13 全文 → §1.4 门禁 → §12.2 外壳集成 → **§18.6 门禁新读数** |

---

## 0. 结论摘要

### 0.1 一句话

这 8 天 Snow Shot 的更新可以概括为三件事：**① 把截图/标注从"画得上"做成"成品级"**（多区域选区、选区效果、放大镜/气泡/角度等 5 个新标注工具）；**② 把两个新编辑器（拼图 Collage、分割 Image Split）塞进产品**（合计 11.7k 行源码 + 15.5k 行测试）；**③ 把 OCR 运行时整条换掉、把贴纸做成"能放动图/文档"的容器**。

对 Highlighter 的结论是：**"交互手感"这一层已经追平甚至局部领先，剩下的差距集中在"能力广度"与"输出成品感"**；真正值得立刻迁移的只有 **7 项约 9–9.5 人日**，其余要么是另一个产品线（Collage / Image Split），要么是 Qt/Rust 级工程（不跟）。

### 0.2 判定分布（四份分域报告合计 **189 项**，去重后约 181 项）

各分域报告自身的判定（按域独立统计，未去重）：

| 分域报告 | 项数 | 空白 | 弱 | 持平/领先 | 未接线 | 死配置 | 不跟/不做 | 缓 | 不适用 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A 截图/选区/标注 | 41 | 26 | 13 | 2 | — | — | —（其中 6 项在空白列内标注"不跟"） | — | — |
| B 新编辑器/外壳/保存 | 58 | 31 | 8 | 1 | 2 | 1 | 9 | 5 | 1 |
| C OCR/识别/翻译/MCP | 32 | 13 | 8 | 5 | — | — | 6 | — | — |
| D 录屏/贴纸/长截图/平台 | 58 | 24 | 9 | 2 | 1 | 2 | 20 | — | — |
| **合计（未去重）** | **189** | 94 | 38 | 10 | 3 | 3 | 41 | 5 | 1 |

> 行内自洽校验：A 26+13+2 = 41；B 31+8+1+2+1+9+5+1 = 58；C 13+8+5+6 = 32；D 24+9+2+1+2+20 = 58。合计 41+58+32+58 = **189**。列合计 94+38+10+3+3+41+5+1 = 195 之所以多 6，是因为 A 的 6 项"不跟"已在空白列内（A 报告把"不跟"记在优先级而不是判定里），**没有重复计**。

**跨报告重复约 8 项**（B 与 D 都覆盖贴纸滚轮透明度、关闭行为、屏幕几何重排、托盘图标、安装器关闭后台进程、贴纸旋转、`autoResize/autoOcr` 死配置；B 与 D 对「录屏 GIF 导出」一个判「不做/归 D」、一个判「空白」）。**去重后约 181 项**，其中：

| 判定 | 约数 | 说明 |
|---|---:|---|
| **空白**（Highlighter 完全无代码） | **约 86** | 去重后：94 − B/D 重叠的贴纸项（约 6）+ A 的"不跟"已在空白内（不减）。其中 P0 约 7 组、P1 约 20 项、其余为 P2 与探路项 |
| **弱**（有骨架，缺最后一公里） | **约 32** | 去重后：38 − B/D 重叠（6）。典型：Ctrl+A 只选当前屏、样式编辑不回写默认、贴纸只有 4 档透明度 |
| **持平 / Highlighter 领先** | **约 9** | 去重后：10 − 1（DIB 解码在 B 记持平、C 未涉及）。例：Enter 复制、录制中标注、长截图拼接后裁剪、发布与自动更新 |
| **有代码未接线** | **2** | 贴纸旋转 helper、`exportWindowToPdf` |
| **设置项存在但无消费者** | **3** | `fixedContent.autoResize` + `autoOcr`（同一处）、`screenshot.saveFormat`、`record.captureCursor`、`ocr.modelWriteToMemory` |
| **不跟 / 不做**（含理由） | **约 47** | 41 + A 的 6（A 把"不跟"记在优先级列）。Qt 级性能工程、macOS/ARM64、任意形状选区、跨屏统一画布、Image Split 完整编辑器等 |
| **缓**（记录，不排期） | **5** | PDF 逐页导出、PDF 预览页网格、Collage 设置持久化、性能基准进 CI、PDF 结构校验 |

> 计数口径提醒：**不要**把各报告自身的"最值得迁 N 项"或"P1 总数"直接相加——各报告的 P1 定义不同（A 用 P0/P1/P2，B 用 P0/P1/P2/P3+缓/不做，C 用 P1/P2/P3，D 用 P0–P3），本文件的批次划分（§14）是重新归并后的口径。

### 0.3 最值得迁移的 7 项（P0，合计约 **9–9.5 人日**）

> ✅ **实施状态（2026-10-19）：7 项全部落地，实测合计约 6.9 人日**（比估算省 2.1–2.6）。
> 逐项落点与偏差见 §19.2；下面的成本列保留分析时的估算值。

| # | 项 | 为什么现在做 | 成本 | 域 | 状态 |
|---|---|---|---:|---|---|
| 1 | **元素样式编辑回写"下次创建默认"** | 现有语义 **bug**：选中元素改成红色后，下一次画新矩形仍是旧颜色。Snow 专门用 308 行 `style.rs` 修它 | 1.0–1.5 | 标注 | ✅ 实测 0.6 |
| 2 | **多页 PDF（单次 `printToPDF` 出多页）** | Highlighter 已有 `print.html` + `printToPDF` 全套，只支持单图单页；改成"一个 HTML 放 N 张图 + 分页 CSS"即可 | 1.5 | 导出 | ✅ 实测 1.8 |
| 3 | **导出文件名冲突警告（含 `fastSave` 预检）** | `fastSave` 分支当前没有用户可见的覆盖提示 | 0.5 | 保存 | ✅ 实测 0.3 |
| 4 | **`exportWindowToPdf` 接线（贴图/识别结果导 PDF）** | 函数已写好且有单测，**生产零调用方**——纯白捡 | 0.5 | 导出 | ✅ 实测 0.2 |
| 5 | **死配置清理 / 接线** | `fixedContent.autoResize`、`autoOcr`、`record.captureCursor`、`screenshot.saveFormat`、`ocr.modelWriteToMemory` 五个键无消费者，设置页却在展示 | 0.5 | 卫生 | ✅ 实测 0.4（`record.captureCursor` 改为**删除**而非接线，见 §19.2 #5） |
| 6 | **贴纸屏幕几何变化重排** | 拔掉显示器/改分辨率后贴纸会飘到屏幕外；Electron 侧只需监听 `display-metrics-changed` | 1.5 | 贴纸 | ✅ 实测 1.2 |
| 7 | **贴纸旋转接线 + 滚轮调透明度** | 旋转 helper 与单测都已存在（零生产调用）；滚轮透明度是贴纸最高频的调节动作 | 3.5 | 贴纸 | ✅ 实测 2.4 |
| | **合计** | 第 1–7 项相加 | **9.0–9.5** | — | **✅ 实测 6.9** |

### 0.4 明确不跟（约 47 项中的代表）

> 完整不跟清单与逐项理由见：§3.5（选区类）、§4.1 表内标注（标注工具类）、§5.4（工具栏布局）、§6.3（OCR 运行时）、§6.2/§6.4 与 §7.3（MCP 范围）、§8.1 表内标注（录屏类）、§9.4（贴图类）、§10（长截图类）、§11.3（Image Split）、§12.2 表内标注（外壳类）、§13.4（许可证态 C）。

| 项 | 理由 |
|---|---|
| **Qt/Rust 级性能工程**（AVX2/NEON 拼接器、分块画布、16 阶段 perf 探针） | 与 Highlighter 的量级差两个数量级（`long-capture/matcher.js` 是 142 行 JS SAD 匹配），重建不成比例 |
| **任意形状选区（折线/曲线/手绘）** | 15–20 人日换异形截图，与"截图效率工具"主定位偏离；马赛克已覆盖"局部遮挡" |
| **跨显示器统一画布** | 12–18 人日改造截图底座，多屏用户占比低；应作为独立特性立项 |
| **Image Split 完整编辑器** | 尺规 + 坐标徽标 + 持久化线段树 + 无限 undo = ≥10 人日，换极低频场景；**用"长截图切分导出"（1.5 人日）替代 80% 用途** |
| **工具行布局可拖动定制** | 会废掉 42 项图标序列契约测试，且"溢出面板"方案收益更大（handoff §4.1） |
| **OCR 运行时整体重写**（RapidOCR+ONNX → Rust SIMD） | 架构同型，换内核用户不可感知；且要背 pinned nightly 工具链与子模块管理 |
| **MCP 101 工具全量对齐** | Snow 用了 15k 行 Rust/C++ + 7.9k 行测试；Highlighter 只需自研 12 工具闭环 |
| **macOS / ARM64 / vcpkg / Full-Mini 双版本** | 平台与发布形态不覆盖 |

### 0.5 一条必须先解决的合规前置

**Highlighter 至今没有 `LICENSE` / `COPYRIGHT` / `THIRD_PARTY_NOTICES.md`，`package.json` 无 `license` 字段**，而它已经在分发 GPL 的 `ffmpeg-static` 与 LGPL 的 `sharp`/libvips。

同时，上游在区间末尾把 `snow-crates/`、`snow_rust_ffi/` 从 Apache-2.0 **改成了 GPL-3.0-or-later**，并把 `snow_shot/` 内带 `GPL-3.0-only` 的文件从 **5 个扩到 79 个**。

结论：**借鉴设计随时可以；移植代码必须先落地自己的许可证，并固定"取用基准"（建议 `v1.3.2` 标签而非 `main`，见 §13）**。详见 §13。

---

## 1. 分析口径：区间真相与基线

### 1.1 上游区间："152 个提交"里到底有多少是新增能力

| 口径 | 数值 |
|---|---|
| 提交数 | **152**（151 功能/发布 + 1 个纯许可提交） |
| 变更规模（含许可 churn） | **1436 files, +227,356 / −40,266** |
| 去掉许可提交后 | 151 commits, 1402 files, **+210,460 / −35,181** |
| 提交类型 | feat **63** · fix 65 · perf 10 · build 9 · refactor 3 · docs 1 · chore 1 |
| 新增测试文件 | `snow_shot/tests` 359 → **434**（+75，其中 `*_tests.cpp` 42 个） |
| CTest 注册数 | 578 → **751** |
| 上游成熟度 | **56/63 个 feat 触及测试（89%）**，25 个触及性能基准（40%），18 个触及文档（29%） |

**读法**：`snow_shot/tests` 的 +67,750 行**比 `snow_shot/src` 的 +38,912 行还多**。这说明上游是"测试先行"，对"照着搬"是利好（行为有契约可查），对"搬多少工作量"是利空（搬功能要连语义一起搬）。

### 1.2 "存量 ≠ 增量"：任务清单里 7 项需要修正

调研时先钉死"哪些能力在 tag 时就已存在"，避免把存量算成本轮增量：

| 项 | 区间内真实 diff | 结论 |
|---|---|---|
| 长截图**自动滚动** | `screenshotscrollingautoscroller.h` 在 v1.2.6 已存在 | **存量**；本区间只把间隔做成可配（128–1000ms）。Highlighter 仍空白，但**不能把 Snow 这 8 天的投入当成可借鉴度提升的证据** |
| 管理员启动 | 区间 diff = **空** | 存量 |
| 配置归档导入导出 | `configurationarchive.cpp` **+10/−1**（仅补迁移读写） | 存量 |
| i18n 模块化机制 | `modules.json` **+20/−2** | 机制存量，增量是翻译内容 |
| AppPermissions | `apppermissionservice.cpp` **+3** | macOS 存量 |
| 贴纸多选/对齐/贴图组 | `pinnedwindowselectioncontroller.cpp` **+25/−7** | 存量 |
| CI 性能基准门槛 | 区间内**删掉** release 流水线（`d2e7302c0`），只剩 homebrew/scoop/winget | **上游没有这个门槛**；且 Snow 的 collage 基准脚本只记录不设阈值 |

另有 3 项**方向相反**（Highlighter 领先或上游退步）：发布流水线（上游删 CI release 改本地发布）、录制中标注、长截图拼接后裁剪。

### 1.3 Highlighter v3.0.0 已落地基线（**不要当空白**）

> 这一节是给后续所有分析员的"防误报"清单。旧文档（v2.3.1/v2.5.0 基线）的"现状"列**大面积过时**。

| 域 | 已落地 |
|---|---|
| 截图 | 区域 / 全屏 / 当前窗口 / 延迟 / 白板；智能选区（窗口 + UIA 子元素两级）；**光标进图**；原生抓屏（`screenshot-desktop` 优先，`desktopCapturer` 回退）；多屏 DIP/物理像素换算 |
| 标注 | 10 工具 + 选择器；**元素二次编辑**（选中/拖动/8 手柄/方向键微调/Delete/层级）；**多选 + mixed 三态 + 框选**；**第二行工具选项行**（填充/线型/圆角/箭头端点/高亮浓度/文字粗体）；**7 色预设色板 + 自定义 + ≤3 最近色**；**per-tool 样式记忆**（8 工具模板）；右键快选 + 拖动；滚轮调线宽；点击/拖动 3px 阈值；undo/redo 快照栈 |
| 长截图 | 纵/横向、180ms 自动抓帧、Worker 拼接匹配、拼后裁剪、`sharp` 合成 |
| OCR/识别 | 本地 PaddleOCR v4 + Rust sidecar；表格启发式重建 → TSV/CSV/Markdown；jsQR 二维码；OCR 结果翻译；`afterAction` 设置已接线 |
| 录屏 | 区域录制/暂停/预览/重录；**系统音 + 麦克风 + 独立增益**（已落地）；录制中标注；MP4（libx264） |
| 贴纸 | 缩放/滚轮、透明度 4 档、**点击穿透已接线**、全局显隐、从文件/历史贴图、重新标注 |
| 其它 | 截图历史、剪贴板历史（原生 sidecar）、多供应商 AI、划词工具栏、Everything 搜索、Index-Translate 内置代理、i18n 三语、自动更新双通道、数据根迁移 |

### 1.4 工程门禁（任何方案都要先算余量）

| 门禁 | 阈值 | 当前值 | 余量 | 证据 |
|---|---|---:|---:|---|
| `main.js` 行数 | **1330** | **1330** | **0 行** | `scripts/check-architecture.js:26`（`MAIN_LINE_CEILING`）；实测 `architecture-check: ok (main.js 1330 lines, ceiling 1330, domains 10)` |
| i18n 中文残留 | **606** | **588** | **18 行** | `package.json` `check:i18n --max 606`；实测 config 65 / capture 222 / record 4 / long-capture 3 / action 8 / toolbar 5 / main 281 |
| locale 对称 | 3 语言等键 | 1133 × 3 | 对称差 0 | `node scripts/check-i18n.js` |
| 测试规模 | — | 142 个测试文件 / 静态 1097 条 `test()` / 24,649 行 | — | `ls test/*.test.js \| wc -l`；`grep -cE "^test\\('"` 汇总 |
| 覆盖率 | 85% / 60% / 90%（三档） | 有（历史 91–93%，未复跑） | 有 | `package.json` 的 `test:coverage:*` |
| 依赖审计 | 0 未豁免 | 18 个失效豁免项 → 已知 exit 1 | 负 | `docs/plans/2026-10-15-capture-interaction-handoff.md:22` |

> 🔄 **实施后读数（2026-10-19）**：`main.js` **1324/1330**（余 6 行）、i18n **585/606**（余 21 行，config 65 / capture 222 / record 4 / long-capture 3 / action 8 / toolbar 5 / main 278）、locale 对称 **1169 × 3**、测试文件 **144**。详见 §19.10。上表保留分析当时的读数以便对照。

**两条会直接杀死方案的约束**：
1. 任何新增装配**不得写进 `main.js`**，必须落 `main/domains/`、`main/services/`、`main/ipc/`，且需先腾挪行数配额；
2. 扫描区（`config/capture/record/long-capture/action/search/recognition/toolbar/pin/main`）内**新增任何一行中文注释就会破 i18n 门禁**，新注释一律英文。

> ✅ **实施验证**：这两条约束在本轮全部被执行。`main.js` 不但没长，还从 1330 降到 1324；新增 CJK 行数为 **0**（585 比分析时的 588 还少 3 行）。

### 1.5 Electron 43 + Canvas 2D 的工程边界（成本档位）

定义：**S** = ≤1 人日（纯 JS/配置）· **A** = 1–3 人日（JS + 既有 IPC 面）· **B** = 3–8 人日（新原生件或重写算法）· **C** = >8 人日 / 不建议。

| 能力 | Electron 路径 | 档位 |
|---|---|---|
| Canvas 2D 绘制、DOM 工具栏/面板、Node 文件处理 | 已有先例 | **S** |
| 导出 JPG/WebP/AVIF | `sharp`（libvips）实测可用 | **S** |
| 导出 JXL/HEIC | `sharp` 无 JXL（`jxlsave_buffer not found`）；HEIC 需编码器 | **B** |
| PDF 导出（多页） | `webContents.printToPDF` + CSS 分页（**注意 `pageSize` 单位是英寸**，`pdf-export.js:14-22` 已踩坑） | **S** |
| 系统打印对话框 | `webContents.print()` 存在，但**无打印预览 API** | **B** |
| 屏幕捕获 / 多屏 DPI / 自身窗口排除 | `desktopCapturer` + `screenshot-desktop` + `setContentProtection` | **S** |
| 捕获后端可选（DXGI/WGC/GDI） | Electron 不暴露 | **C** |
| 任意形状窗口 | `win.setShape(rects)` 只吃**矩形数组**且 `@experimental`，无逐像素 alpha 掩码 | **C** |
| 点击穿透 | `setIgnoreMouseEvents(true,{forward:true})`（**只转发 move/enter/leave，不转发 wheel/键盘**） | **S**（有约束） |
| 剪贴板 DIB/DIBV5/文件列表 | `writeBuffer` 是 `@experimental`；Highlighter 已用 Rust sidecar 自建 | **B** |
| 文件关联（安装期） | electron-builder `fileAssociations` | **A** |
| 资源管理器右键菜单（运行期） | 无 API，需写 `HKCU\Software\Classes` | **C**（可用 `reg.exe` 折中） |
| 录屏（画布→视频） | `canvas.captureStream` + `MediaRecorder`（**只能 WebM**） | **S** |
| 录屏 MP4 / GIF / APNG / WebP | `ffmpeg-static`（**实测编码器与滤镜齐全**，见 §2.4） | **A** |
| 录屏硬件编码 | 需 `-f gdigrab`/`ddagrab` 绕开 Electron 合成 | **C** |
| 窗口级合成 / 全局画布 | Chromium 无桌面级合成 API | **C** |
| MCP 服务端 | `@modelcontextprotocol/sdk` 或手写 stdio JSON-RPC | **A–B** |
| 本地视觉模型（Auto Filter） | `onnxruntime-node` 已在 devDeps + ONNX 模型 | **B** |

---

## 2. 本轮 Lead 实测结论（推翻/修正了 5 处假设）

| # | 假设 | 实测结果 | 影响 |
|---|---|---|---|
| V1 | `ffmpeg-static` 可能未编入 GIF/APNG/WebP/atempo | ✅ **全部可用**：encoders 含 `gif`/`apng`/`libwebp_anim`/`libwebp`/`libx264`/`libx265`；filters 含 `atempo`/`fps`/`palettegen`/`paletteuse`/`tpad` | 录屏 trim 变速（8d）与 GIF/APNG/WebP 导出（6d）**可行性成立，无需换二进制** |
| V2 | `{WN}` 窗口标题变量约 0.5 人日 | ⚠️ **能力已存在但被丢弃**：`native/smart-select/Program.cs:98-103` 已调 `GetWindowText`，但 `WindowEntry(:421-435)` 只存 Handle/Frame/Client，`WriteResult(:251-262)` 只输出 `{"id","rects"}`，`main/domains/capture/smart-select.js:128-140` 只消费矩形 | `{WN}` 需 C# 加字段 + 改 JSON 契约 + JS 透传 → **2–3 人日**，优先级从 P1 降 P3 |
| V3 | 穿透态下 `ctrl+wheel` 可达 | ❌ **不可达**：`forward:true` 不转发 wheel/键盘；`pin/pin.js` 也无 wheel 分支 | 滚轮调透明度 **1.0 → 2.0 人日**（需先临时退出穿透或走主进程钩子） |
| V4 | 贴纸旋转是纯空白 | ⚠️ **有代码未接线**：`main/domains/pin/geometry.js:51-71` 的 `normalizePinRotation`/`getRotatedPinSize` 是成品逻辑且有 27 条断言；生产代码**零调用方**（无 transform 容器、无 `pin:rotate` IPC） | 成本 **3 → 1.5 人日** |
| V5 | 交接文档的读数可引用 | ⚠️ **已陈旧**：`main.js 1297/1300`、`i18n 605/606` 是 v2.5.0 口径 | 改用 **1330/1330**（门禁已提升到 1330）与 **588 ≤ 606** |

**另有两处探针待跑**（各 0.5 人日，不影响本文档结论方向）：
- `nativeImage.createFromPath('*.bmp')` 在 Electron 43 是否可用（BMP 导入白名单已含 bmp，解码未验证）；
- `printToPDF` 对 `page-break-after: always` 的分页支持（多页 PDF 的关键假设）。

---

## 3. 截图 / 选区：从"一个矩形"到"可编辑区域集合"

### 3.1 本域新增总览

| 能力 | 说明 | 判定 | 优先级 |
|---|---|---|---|
| 多区域截图编辑 | add/subtract 区域、单区域移动/悬停高亮/复制最近区域（`1b6cdbca0`） | 空白 | P2（先做轻量版） |
| 紧凑布局 | 去掉区域间空白带，可调 spacing（`61aa4020f`） | 空白 | **不跟** |
| 区域级吸附 | 拖动单区域时与其它区域/画布吸附 + 参考线（`fb24b3120`） | 空白 | P2（依赖多区域） |
| 选区背景不透明度 | 导出图带 alpha 背景，0–100%，滚轮调（`e7cf3253c`） | 空白 | **P1** |
| 选区圆角/阴影 | 导出效果 + 画布效果手柄；阴影颜色可持久化（`2811e9602`） | 空白 | **P1** |
| 选区数值面板 | X/Y/W/H + 比例锁 + 圆角/阴影/背景 + 快捷组入口 | 空白 | P2 |
| 选区快捷组 quick sets | 当前/上一次/自定义预设（**不是快捷键组**，是选区参数预设） | 空白 | P2 |
| 选区历史浏览 | `R` / `Shift+R` 在历史选区之间跳，按屏匹配 + revision 防串（`86d083665`） | 空白 | **P1** |
| Ctrl+A 逐级全屏 | 第一次选当前屏，已在整屏/全屏时再按扩到所有屏（`a7673a353`） | **弱**（已有 Ctrl+A，缺第二级） | **P1（0.5d）** |
| 居中滚轮缩放选区 | 四边同增缩、中心不动（`143266ee5`） | 空白 | P2 |
| 选区比例锁 | Free/1:1/3:2/4:3/16:9（`30bd4e732`） | 空白 | P2 |
| 选区形状类型 | 矩形/折线/曲线/手绘区域 | 空白 | **不跟** |
| 跨显示器统一画布 | 全桌面单画布 | 空白 | **不跟**（12–18d） |
| 智能选区动画速度 | Off / Soft 32ms / Fast 72ms（`c63a9ef5a`） | 空白 | P2（2–3d） |
| 每屏光标样式归一 | 统一 32×32 白十字 + 黑描边（`6f5fc3972`） | **弱**（Highlighter 如实抓真实光标位图） | 不跟（产品取向不同） |

### 3.2 值得做的两项（P1）

**① 选区历史浏览（4–6 人日）**

Snow 的核心只有约 60 行：`historyService.selectionForRestore(record, target)` 按"来源 + 显示器 bounds"匹配历史记录，返回可恢复的 `ScreenshotSelectionParams`；`browseSelection` 维护 `navigationId/revision`，**选区或交互模式一变就重置**（`screenshothistoryservice.cpp:724-762`）。

Highlighter 的落点很顺：
- 历史库**已存** `meta.selectionBounds`（`capture/capture.js:2014`）；
- capture 窗口 `onInit` 增加 `selectionHistory: [...]`（最近 N=20），渲染层维护 `historyIndex`；
- 键位 `R`/`Shift+R`（与现有 Ctrl+A/Z/Y/S、Delete、Enter、Esc 无冲突，`capture.js:2130-2145`）；
- **必须在 `pointerdown` 改选区后重置 index**（Snow 的 revision 语义），否则"按 R 跳回上一次"会覆盖用户刚选的东西。

**② Ctrl+A 二级（0.5 人日，仅在多屏有意义）**

Snow 的逻辑（`screenshotoverlayinputhandler.cpp:1202-1225`）：`expandToAllScreens = 正在移动选区 && 矩形选区 && (当前选区 == 当前屏 || 当前选区 == 全部屏)`，然后二选一。

Highlighter 现状是 `selection = {...imageDisplayBounds()}`（`capture.js:2141`），而 `imageDisplayBounds()` 只返回**当前窗口那一屏**。所以要做二级，得先让 `main` 在 init 里下发 `desktopBounds`（`screen.getAllDisplays()` union）。

**判断**：单屏用户零收益；双屏低 DPI 场景 0.5 天可做；若要"跨屏内容都正确"，会滑向"跨显示器统一画布"（12–18d），**按 P1 立项时务必锁死"只扩 bounds、不保证跨屏内容"**，否则范围爆炸。

### 3.3 选区成品感：圆角 / 阴影 / 背景不透明度（**P1，10–14 人日**）

这是"截图成品感"最大的单点，Snow 的数据模型可以直接照抄字段：

```
ScreenshotResultStyle { cornerRadius, shadowWidth, shadowColor,
                        backgroundOpacityPercent, region }
```
（`screenshotselectionmodel.cpp:939-946`）

Highlighter 的改造面收敛在 `exportSelectionCanvas()`（`capture/capture.js:1851-1878`）一个函数：

1. 新建 `content + 2*padding` 画布；
2. 画阴影/背景（alpha）；
3. `drawImage` 内容（按圆角 `clip`）；
4. 再 `annotations.forEach(drawAnnotation)`；
5. 顺带把"效果手柄"（画布上直接拖阴影宽度）留到第二阶段（+2–3d）。

**三个必须同步的契约点**（否则会出隐性不一致）：
- `selectionBounds` meta（`capture.js:2014`）与历史记录；
- PDF 导出的 `pxW/pxH`（`main/services/pdf-export.js`）；
- 剪贴板图片的尺寸（用户预期"复制出来的图 = 看到的效果"）。

### 3.4 多区域：建议"矩形 + 挖洞"轻量版（5–7 人日），不做完整集合模型

完整多区域（`RegionOperation{Replace,Add,Subtract}` + 可编辑区域集合 + 紧凑布局 + 区域吸附 + 复合选区标注保持）在 Snow 里是 **4 个 commit + 约 290 行紧凑布局 + 339 行 model 改动**，完整迁移估 **18–25 人日**，且强依赖后续的紧凑布局与吸附（合计 35–47 人日）。

**建议**：只做"矩形 + 挖洞（sub 一个矩形）"，用 `holes: rect[]` 数组，不改区域集合模型，覆盖"去水印 / 日志留白"这类高频场景，**成本 5–7 人日、约 70% 体验**。完整版留到有明确用户诉求再评估。

### 3.5 本域不跟

| 项 | 理由 |
|---|---|
| 紧凑布局 | 强依赖多区域，Snow 自己在 10-17 还补了 spacing 的 source scale bug（`c77542014`）；只有"多区域且区域间有大片空白"这一窄场景 |
| 任意形状选区 | 15–20d，与截图工具定位偏离；马赛克已覆盖局部遮挡 |
| 跨屏统一画布 | 12–18d，底座改造 |
| 光标 crosshair 标准化 | 与 Highlighter"如实抓光标"的产品选择冲突，不是技术差距 |

---

## 4. 标注 / 画布：5 个新工具 + 2 个"成品级"细节

### 4.1 新增标注工具

| 工具 | 数据模型 | 判定 | 优先级 | 人日 |
|---|---|---|---|---|
| **放大镜标注** | 镜头 + 源区域 + 倍率/形状/描边/转角/源框/引线（`magnifier.rs:15-36`） | 空白 | **P1** | 8–10（LeaderLine 版） |
| 对话气泡 | 体内矩形 + 多条可拖尾巴 + 内嵌文字（`speech_bubble.rs:20-33`） | 空白 | P2 | 18–25（最小版 8–10） |
| 角度 / 内角标注 | 三点 + 定向角 360°/内角 180° + 弧半径 + 单位/小数位 | 空白 | P2 | 8–12 |
| 聚光灯（挖孔） | 不透明色矩形 + 挖孔 + 形状/圆角/不透明度 | 空白 | P2 | 8–12（有区域模型后 4–5） |
| 压感画笔 | `perfect-freehand` 移植：thinning=0.6、sine easing（`pressure.rs:11-143`） | 空白 | **P1** | 10–12 |
| 形状绑定文字 | 外部文字标签 + 引线连到形状轮廓，随形状移动（`document_geometry.rs:494-549`） | 空白 | P2 | 10–14 |
| 描边渲染样式 | Architect / Artist / Cartoonist 手绘抖动，逐元素 seed 稳定 | 空白 | P2 | 10–15 |
| 序号样式扩展 | 5 种序号形状 + 描边风格（序列接续 Highlighter 已领先） | 弱 | P2 | 2–3 |
| 仅描边填充（Border） | 语义 = 闭合路径但不填色 | **持平**（`fill:'none'` 等价） | 不跟 | 0.2 |
| 元素旋转 | 旋转感知命中 + 文字跟随 | 空白 | P2 | 8–10 |
| Alt+拖复制元素 | Snow 是基线能力 | 空白（Alt 被选区逃生门占用） | P2 | 1.5–2 |
| 对齐 / 分布 | 纯几何 | 空白 | P2 | 3–4 |
| 多选整体拖动 | Highlighter 有意未做（handoff §4.4） | 弱 | P2 | 2–3 |

### 4.2 放大镜：最值得"抄一半"的工具

Snow 的实现分三层，这是它能在 15 天内做完的原因：

1. **数据层**：镜头（lens）与源（source）是两个矩形 + 一个倍率，`magnified_rect()` 由 `source_rect()` 乘 factor 得出（`magnifier.rs:79-97`）——**没有独立的镜头尺寸状态**，避免两者不同步；
2. **绘制层**：`scaledSourcePath()` 把镜头轮廓按 `1/factor` 反变换回源坐标系（`snow_canvas_magnifier_renderer.cpp:440-468`），于是"源框虚线"与"镜头边框"共享同一套圆角/形状逻辑；
3. **连接层**：`{None, LeaderLine, Gradient}`（`core/types.rs:5-11`）；LeaderLine 是剪到轮廓的箭头，Gradient 是共切曲线桥（二分 48 次求根）。

**Highlighter 的最小可行版（8–10d）**：
- 数据：`{type:'magnifier', x,y,w,h (镜头), sx,sy,sw,sh (源), factor, shape, stroke, width}`
- 绘制：在 `drawAnnotation` 加分支（`capture.js:396` 已接收 `sourceImage` 参数，`:436-439` 的 blur 就是"二次采样"先例）：源框虚线 → 镜头 `clip` 后放大画源矩形 → 描边 → 直引线；
- 交互：拖 = 移动镜头（源固定）、手柄 = 缩放镜头（factor 不变 → 源区域随之变）、滚轮 = 调 factor；
- **导出同源天然成立**：舞台与导出共用 `drawAnnotation`。

**不建议一次做到 Gradient**：共切曲线桥约 200 行二分 + 反向轮廓，只在"镜头与源很近"时可分辨；用 `quadraticCurveTo` 近似即可。

### 4.3 压感画笔（P1，10–12 人日）

Snow 的 `pressure.rs` 是 `perfect-freehand` 的移植（1154 行）。Highlighter 侧**不需要照搬**：
- Electron/Chromium 的 `PointerEvent` 有 `pressure`（鼠标恒 0.5，笔有真值）与 `tiltX/tiltY`；`pointermove` 已绑定（`capture.js:1765`）；
- 最小版：按下时 `getCoalescedEvents()` 取插值点 + 记录 pressure → "圆头笔刷沿路径填充"（每采样点画半径随压力变化的圆 + 相邻点连成胶囊）→ 导出同源；
- 风险：`MAX_PEN_POINTS` 上限会更快打满；低 DPI 下圆头叠加有"竹节"感（EMA 平滑即可）。

### 4.4 唯一的 P0：样式编辑回写默认（1–1.5 人日）

**现象**：Highlighter 的样式有两个写入口——
- `setAnnotationColor/Width/Option` 有选中项时走 `commitSelectedStyle`（**只改选中项**，`capture.js:1483-1490`）；
- 无选中项时走 `writeToolStyle`（**写记忆**，`:900-908`）。

结果：选中一个矩形改成红色 → 下一次画新矩形**仍是旧颜色**。用户必须先取消选中再改色，才能改默认。

**Snow 的修法**（`048583130`，308 行 `style.rs`）：`set_*_style_patch` 里**总是**先算 `next_default = default.merged(style, properties)` 写回默认，再对选中集逐个应用。

**Highlighter 的修法**：在 `commitSelectedStyle(patch)` 里，`applyStyleToSelectedAnnotation` 成功后追加 `writeToolStyle(toolbarStyleTool(), patch, true)`；注意用 `ownsAnnotationField`（`:1454-1458`）判定字段归属，多选混合时只写 anchor/当前工具的字段；契约测试 `test/capture-tool-styles.test.js` 钉死"整表一次写盘 + 唯一调用点"，改动要同提交更新测试。

**为什么是 P0**：这不是缺功能，是**现有功能的语义不一致**，且用户每次新建都会撞上。

---

## 5. 工具栏 / 快捷键 / 贴图

### 5.1 窗口内快捷键可配置（P1，3–5 人日）

Snow 把所有截图窗口内快捷键做成**一个本地 shortcut scope**（`SettingsLocalShortcutScope::Screenshot`），`settingscatalog.cpp` 一口气列了 40+ 条，支持多绑定、重置、冲突检测。

| 动作 | Snow 默认 | Highlighter 现状 |
|---|---|---|
| 复制 | `Ctrl+C` / `Return` | 硬编码 Enter（`capture.js:2138`）；**Return 早已支持 → 持平，非新增** |
| 保存 / 撤销 / 重做 / 取消 | `Ctrl+S` / `Ctrl+Z` / `Ctrl+Y` / `Esc` | 同（`:2139-2143`） |
| 打印 | `Ctrl+P` | 无（只有"导出 PDF"按钮） |
| 上一/下一次历史选区 | `R` / `Shift+R` | 无（见 §3.2） |
| 画布重置 | `Ctrl+Shift+Z`（Drawing scope） | 无 |
| 选区类型循环 | 由 region type cycle key 生成 | 无 |

**Highlighter 迁移设计**：
- 新增 `screenshot.localShortcuts`（逐字段白名单，同 `annotationStyles` 的校验模板写法）；
- 把 `capture.js:2130-2145` 的硬编码 `if` 链改成查表（`event.key`/`ctrlKey` 归一逻辑复用 `shared/shortcut-keys.js`）；
- 设置页新增"截图窗口内快捷键"分区（照 `config/routes/home.js:51-124` 的 recorder 行样式）；
- **冲突检测必须做**：现有契约测试断言"方向键不被 Ctrl 组合吞掉"（`test/capture-annotation-geometry.test.js:735`），默认值下必须仍成立；
- **i18n 注意**：新增三语文案会吃 18 行余量。

### 5.2 贴图工具栏（**建议走路线 A，不做路线 B**）

Snow 的 pinned 编辑器（`screenshotpinnededitcontroller.cpp:44-84`）直接复用 `ScreenshotToolPalette`，只是换一套 Options：20 个绘图工具 + OCR/翻译/表格/二维码 + 保存/复制 + 独立动作行。

Highlighter 现状：`pin/pin.js` 只有移动（6px 阈值）、滚轮缩放（1.1 步进）、双击关闭、右键菜单、点击穿透。要标注必须 `startPinReannotation`（`main/domains/pin/index.js:268-356`）——**隐藏贴纸窗口、开一个 capture 窗口**，并给窗口预留条带（`ROW_MIN_CONTENT=1040`/`toolbarSpace=1088` 是**硬编码常数**，`:295-306`）。

| 路线 | 做法 | 成本 | 风险 |
|---|---|---|---|
| **A（推荐）** | 保持"重新标注开 capture 窗口"，但把条带预留从常数改成**实测**，并让 capture 窗口在贴纸位置弹出 | 3–4d | 低 |
| B | 把 capture 的工具栏 + 画布搬进贴纸窗口（真·就地标注） | 8–12d | 中高：窗口尺寸/透明/条带/点击穿透/always-on-top 全要重算，且与"拖动整个窗口"手势冲突 |

### 5.3 贴纸标注越界（P2，2–3d）

Snow `a3c67c966` 删掉了 20 行"把标注裁到选区"的逻辑，允许标注画到贴纸内容外。Highlighter 的 stage = 窗口大小，元素被 `clampAnnotationToStage` 钳制（`capture.js:1217-1219,1250-1253`）。

**若跟**：先定义"越界元素的导出行为"（裁掉 / 扩大导出 / 报错），再改 clamp。与 §5.2 路线 A 一起做更合适。

### 5.4 工具行布局可定制：**不跟**

Snow 有 5 种 `ScreenshotToolbarLayoutKind`，支持拖拽排序并持久化。Highlighter 不做，理由：
1. 主行**已满**（handoff §4.1 实测主行 min-content 937px / 条宽 951px）；
2. 会废掉 `test/capture-toolbar-icons.test.js` 的"42 项精确图标序列 deepEqual"契约；
3. handoff §4.1 的替代方案（把 11 个识别/导出动作收进「···更多」溢出面板，主行降到 ≈566px）**收益更大、成本更低**。若要做工具栏空间优化，做溢出面板，不做可拖动布局。

---

## 6. OCR / 识别 / 翻译

### 6.1 判定总览（32 项）

| 类别 | 项 | 判定 |
|---|---|---|
| OCR 运行时 | 引擎换代（RapidOCR+ORT → 自研 SIMD） | **不跟** |
| | 模型档位（V6 三档） | 弱（P2，需先 A/B） |
| | 启动开销优化（编译产物复用） | **不跟** |
| | 常驻/热启动 | **持平** |
| | 检测器缩放策略两档 | 弱（P2） |
| | arm64 SIMD | **不跟**（无 ARM64 发行版） |
| OCR 交互 | **结果框选**（行级批量选中） | 空白（P2，2.5d） |
| | **文本高亮**（识别区域蒙版） | 空白（P2，1.0d） |
| | 识别后复制动作 | **持平**（`ocr.afterAction` 已接线） |
| | 预览缩放与自适应摆放 | 弱（P2，建议只做"滚轮缩放 overlay 字号"0.5d） |
| | 公式预览 original image mode | 空白（依附公式能力） |
| | OCR 结果文本编辑 | 弱（P2，3.5d） |
| 表格/图像/QR | **表格导出 Excel 工作簿** | **空白（P1，1.5d）** |
| | **图片转 Markdown / HTML** | **空白（P1，2.0d）** |
| | HTML MIME 保留 | 空白（随上一项） |
| | 表格编辑器（合并/拆分） | 不跟（先做导出） |
| | QR DNN（WeChat 模型）+ 条码 | 弱（P3，不引 DNN） |
| 翻译 | **原地翻译（译文绘回原图）** | 空白（P1，1.5d） |
| | **按检测语言路由** | 空白（P2，需先有"检测到的语言"提示） |
| | 专业翻译供应商 | 不跟（与 AI 多供应商 IA 冲突） |
| | 流式逐块上屏 | 不跟（IPC 契约要动，收益是观感） |
| MCP | MCP 本体 / 会话模型 / silent / job / 协议 fallback | 见 §7 |

### 6.2 三项 P1 的具体做法

**① 表格识别导出 Excel（1.5 人日）**

Highlighter 已有表格重建（`capture/recognition-utils.js:117-150`：行分组、列数众数、列锚点中位数、多块合并）与 TSV/CSV/Markdown 序列化（`:99-113`），**只差"写成 OOXML 落到文件"**。

Snow 的 `tableWorkbook()`（`screenshotrecognitionfileexport.cpp:61-283`）是 240 行手写 SpreadsheetML：4 个 part（`[Content_Types].xml` / `workbook.xml` / `styles.xml` / `sheet1.xml`）、`inlineStr` 单元格、`mergeCells` 合并、`numFmtId=49` 文本格式、32,767 字符单元格上限、1,048,576 行 / 16,384 列上限。

**Highlighter 侧实现路径**：
- 打包用 **`adm-zip`**（**已是生产依赖**，`main/services/diagnostics-service.js` 在用；`zipEntry.js:313-325` 对非空 Buffer 自动 `DEFLATED` 并写 crc32）→ **不引 `exceljs`/`sheetjs`**（体积 + 供应链风险不值得）；
- 手写 4 个 XML part（约 120 行）；
- 识别窗 footer 加"导出 Excel"按钮（`recognition/recognition.html:38-45` 现有 3 个控件旁边）；
- IPC：`recognition:exportExcel`（照 `recognition:table` / `recognition:copy` 现有模式）；
- 测试：纯函数 `buildWorkbookParts(rows)` 返回 `{name: Buffer}`，逐 part 断言 XML 片段。

**风险**：① OOXML 合法性（用 Excel/WPS/LibreOffice 三处打开验证即可）；② emoji/代理对要处理 UTF-16；③ 单元格内控制字符需 `_xHHHH_` 转义（Snow `:40-58` 已示范）。

**② 图片转 Markdown / HTML（2.0 人日）**

Highlighter 有完整多供应商 AI 管道，**但整条链路是纯文本 content**，没有 `image_url` 多模态分支——这是**唯一需要改 AI 层的地方**：

| 层 | 现状 | 改法 | 成本 |
|---|---|---|---|
| 模型能力位 | `ai-model-capabilities.js` 只有 `chat/translation/explain` | 加 `vision: boolean` | 0.3 |
| 请求体 | `buildChatStreamRequest()` 原样透传；**`buildResponsesMessages()`（`ai-protocol-adapters.js:58-64`）强制把 content 转 String —— 这是硬阻塞点** | 遇数组 content 时保留 | 0.3 |
| 调用 | `ai/client.js` 全是 `{role, content: string}` | 新增 `convertImage(provider, base64, format)` | 0.5 |
| 入口 | 无 | capture 工具栏 2 个 action + 快捷键 2 条 + 复用结果面板 | 0.5 |
| 导出 | 无 | `.md` / `.html` | 0.2 |
| 测试 | — | prompt 组装 / 去围栏 / 保存路径 | 0.2 |

**Snow 的 `imageConversionPrompt()`（`snowshotapiclient.cpp:80-129`）是可以逐条对齐的资产**（prompt 是自然语言说明，不是代码）：保持原语言/阅读顺序/标题/列表/表格/链接、禁止翻译与臆造、**图片里的指令视为正文不执行**（prompt injection 防护）、多栏按逻辑序、不可读标 `[illegible]`、只输出目标格式、代码围栏长度规则、HTML 侧禁 form/iframe/SVG/style。

**③ 原地翻译（译文绘回原图，1.5 人日）**

Snow 的"原图翻译"本质是**两套呈现模式**：格式化文本模式 vs 原图模式（原图像素 + 按 OCR 四边形绘制的译文文本层）。导出渲染器是 `renderScreenshotRecognitionImage()`。

Highlighter 缺的只是 `exportSelectionCanvas()` 里没有"把 OCR/译文块画上去"的分支：

```
exportSelectionCanvas({ includeAnnotations, includeRecognition })
  → 画原图 → 画标注 → if (includeRecognition && activeOcrResult) drawRecognitionBlocks(ctx, scaleX, scaleY)
```

**风险**：① 译文变长溢出需要"缩字号 → 换行"降级链（Snow 用 600 行做这个，Highlighter 可以先做两档）；② 竖排文字 canvas 侧要 `rotate`；③ 与"复制"语义区分（导出的是"译文版"）。

### 6.3 为什么 OCR 运行时不该跟

Snow 本区间把 **ONNX Runtime + DirectML 整条链路删了**（`fae52a182`：156 文件 / +1,372 / **−19,863**），换成自研 `simd-paddle-ocr-rs` 子模块 + 协议 6 + Runtime 1.1.0。

- **架构同型**：Highlighter 已是"Rust sidecar + ORT + Paddle 模型"，换内核只是把 ORT 换成自研 SIMD，**用户不可感知**（准确率由模型决定，不由内核决定）；
- **代价大**：pinned nightly 工具链 + 子模块管理工作流；
- **收益已被吃掉**：Highlighter 的 sidecar 是**进程级复用**（idle 30s 才杀），Snow 协议 6 解决的"session 重建开销"在 Highlighter 不是问题。

同理"模型档位扩展"也不是纯收益：单档 V6 small 就 **31.2 MB**（当前 16 MB 的 2 倍），安装包要涨 ~15 MB；且 V4 mobile vs V6 small 的**中文截图实测差异未有数据**。建议先跑 A/B（0.5 人日）再决定。

### 6.4 顺带发现的配置卫生问题

- `settings.ocr.modelWriteToMemory`、`settings.fixedContent.autoOcr` / `autoResize`、`settings.record.captureCursor`、`settings.screenshot.saveFormat`：**零消费者**（只有 defaults + `scripts/probe-*.js`；`saveFormat` 更彻底，连探针都没有）——实测见 §0.3 第 5 项与 §12.1；
- `ocr-service.js:28` 代码默认 `idleTimeoutMs=30000`，但设置默认 `300000` → 代码默认值实际不生效，易误读。

---

## 7. MCP 服务端（战略项，但**不是本轮新增**）

### 7.1 先纠正一个容易误判的事实

**MCP 在 v1.2.6 就已经是完整的 101 工具形态**，本区间只是"跟着 canvas 工具增长做机械同步"：

| 项 | v1.2.6 | HEAD | 性质 |
|---|---|---|---|
| 工具总数 | 101 | **101** | **不变** |
| 4 域分布 | screenshot 28 / application 27 / documents_jobs 33 / recording_pinned 13 | 同 | 不变 |
| `canvas_tools` 枚举 | 20 | 22 | +Magnifier +SpeechBubble（依赖标注新工具） |
| `canvas_style_sources` | 30 | 34 | +Default/Selected × 2 新工具 |
| `MCP.md` | 441 行 | 452 行 | 唯一实质新增是 `2025-11-25` 协议 fallback |
| Rust 桥 | 5,987 行 | 6,317 行 | +370：多数是 style/speech-bubble/magnifier 的 schema 样板 |

所以：**不要把 MCP 写成"本轮新增能力"**。它仍是旧文档 §3 的 P1 招牌，只是这 8 天没有质变。

### 7.2 值得借鉴的 3 条设计（不含代码）

| 设计 | Snow 做法 | 为什么重要 |
|---|---|---|
| **`session_id` + `expected_revision` 乐观并发** | 所有编辑/输出必须带；stale 时返回 `stale_revision` **且附带当前 state** | AI 是多步编辑者，必须能检测"用户中途手动改了选区" |
| **`silent` 呈现** | `presentation: visible`（默认）/ `silent`；silent 不显示 UI，断连即取消 | AI 批量处理时不能每次弹窗抢焦点 |
| **工具名 `app_domain_verb` + 机器可读能力目录** | `mcp-capabilities.json` 作为"Rust 工具 ↔ 服务端 dispatch ↔ 测试夹具"三方一致性契约 | 没有契约，101 个工具必然漂移 |

**不建议借鉴**：私有二进制 IPC（Electron 同进程 `ipcMain` 即可）、Tasks 扩展、artifact 分块（MVP 用 base64 即可）。

### 7.3 结论：**做，但必须自研 Node 版，且先落 LICENSE**

| 维度 | 结论 |
|---|---|
| 战略价值 | **高**。Snow 全仓无插件系统，扩展面 100% 由 MCP 承担；Highlighter 若做，是"AI 客户端直接驱动截图工具"的唯一入口，与划词/AI 对话形成闭环 |
| 代码移植 | **不可行/不建议**。`snow-shot-mcp/Cargo.toml:5` = **`GPL-3.0-only`**（本区间**未改**，relicense 只动了 `snow-crates/` 与 `snow_rust_ffi/`），且是 Rust + `rmcp` + 私有 IPC，Electron 侧没有对应进程边界 |
| 范围 | MVP **12 工具**（status / begin / state / set_selection / apply_annotations / render / save / copy / pin / recognize / translate / settings_get） |
| 成本 | **10 人日**（stdio 骨架 1.5 + 会话与 revision 1.0 + silent 1.5 + 12 工具 schema/dispatch 3.0 + IPC 桥接 1.0 + 测试 1.5 + 文档与开关 0.5） |
| 硬前置 | **L1–L3 落地**（LICENSE 全文 + COPYRIGHT + `package.json` license 字段），并定案 `-only` vs `-or-later`（旧文档"待定项 α"**至今未决**） |
| 软前置 | `main.js` 行数配额腾挪（1330/1330 零余量）；**首版不做设置页 UI**，用配置文件开关（省 i18n 与 UI 成本） |

验收口径：能用 Claude Desktop / Codex 配置 `command` 指向 node 脚本，完成"截图 → 标注 → 保存/复制"一次闭环。

---

## 8. 录屏

### 8.1 判定总览（15 项）

| 能力 | 判定 | 优先级 | 人日 |
|---|---|---|---|
| **trim 剪辑 + 可变播放速度（9 档）** | 空白 | **P1** | 8.0 |
| **GIF / APNG / WebP 导出（含稀疏帧瘦身）** | 空白 | **P1** | 6.0 |
| 音轨图标（静音态可视） | 空白 | P1 | 0.5 |
| 增益滑杆（±24 dB 收敛） | 弱（设置键有、UI 无） | P1 | 1.5 |
| 工具栏自动隐藏 | 空白 | P2 | 1.5 |
| 鼠标高亮半径（8–128 可配） | 空白 | P2 | 2.0 |
| 录制中标注 | **领先**（5 工具够用） | 不跟 | — |
| `record.captureCursor` 接线 | 死配置 | P1 | 1.0 |
| 离线导出策略 / 硬件编码 | 不跟 | — | — |
| 编码器默认 h264 | 不跟（只有一条路） | — | — |
| 独立音轨导出 | 不跟（兼容性差） | — | — |
| 录制结束即删 | 不跟（临时目录已清理） | — | — |
| 缩放保真 / 降采样细节 | 不跟（Electron 侧由 MediaRecorder 决定） | — | — |
| macOS 稳定性 / QoS | 不跟 | — | — |
| 删除即删选项 | 不跟 | — | — |

### 8.2 trim + 变速：不是"加一个 ffmpeg 参数"

Snow 的变速不是"加 `-vf setpts`"，而是**在 presentation 帧网格上重定时**：

- 速度白名单 25/50/75/100/125/150/175/200/300（`trim.rs:5-22`），其余报错；
- 用整数微秒 + 有理数换算，**重复或跳帧、部分末帧保留实际时长**（`docs/recording-trimming.md:29-43`）；
- 变速音频走 `atempo` 链且**保音高**（`tempo.rs:38-44`：25 → `atempo=0.5,atempo=0.5`；300 → `atempo=1.5,atempo=2`）；
- 546 行 `retimed_av_sync.rs` 专门测 A/V 同步。

**Highlighter 侧的现实选择**：
- 最小版：`ffmpeg -ss/-to` + `atempo` + `setpts` 一次转码，**验收口径放宽到"端点误差 ≤1 帧、音画偏差 ≤50ms"**，成本 5–6 人日；
- 严格版（Snow 同等精度）：需要自己在 JS 侧重排帧时间戳，成本 8 人日以上，收益边际。
- **建议**：先做最小版（5–6d），把"9 档速度 + 起止裁剪 + 音高保持"跑通；A/V 同步问题在真机上按需修。

### 8.3 GIF/APNG/WebP 导出

当前只有 MP4：`record/recording-utils.js:232-246` 硬编码 `libx264 -crf 23`，`recording-service.js:73` 断言输出必须 `.mp4`。

**V1 实测：`ffmpeg-static` 的 `gif` / `apng` / `libwebp_anim` 编码器与 `palettegen` / `paletteuse` 滤镜全部可用**，所以成本主要在：

1. 编码参数面板（格式 × 质量 × 尺寸 × 帧率）——1.5d；
2. GIF 调色板两趟法 + dither；体积优化（Snow 的**稀疏帧**思路：量化后逐行比 RGB 差分，重复帧用 1×1 透明帧只带时间，`gif_encoder.rs:29-95`）——2.5d；
3. 导出链路改造（`saveMp4` → `saveRecording({format})`、文件过滤器、命名后缀）——1.0d；
4. 测试（格式魔数、帧数、体积上限）——1.0d。

**注意**：GIF 在 Highlighter 的"录制中标注"场景下体验会打折（GIF 帧率低、无音频），产品上要明确"GIF 用于短演示，长录制仍用 MP4"。

---

## 9. 贴图

### 9.1 判定总览（17 项，>0 的）

| 能力 | 判定 | 优先级 | 人日 |
|---|---|---|---|
| **滚轮调透明度（Ctrl+wheel）** | 空白 | **P0** | 2.0（V3 实测后从 1.0 上调） |
| **屏幕几何变化重排** | 空白 | **P0** | 1.5 |
| **旋转 / 翻转接线** | **有代码未接线** | **P1** | 1.5 |
| 缩放步进可配（默认 10%） | 弱（固定 1.1） | P1 | 0.5 |
| 关闭行为配置（标注态守卫） | 空白 | P1 | 2.0 |
| 双击/中键行为可配 | 空白 | P2 | 1.5 |
| 收纳到屏幕顶部（单窗） | 空白 | P2 | 4.0（收益偏创意） |
| 一键全部收纳 | 空白 | P3 | 随上 |
| 颜色色板可交互 | 空白 | P2 | 3.0（前提：文本贴纸） |
| 格式化文本贴纸可选中 | 空白 | P2 | 5.0 |
| 文档文件贴纸（txt/md/html/css） | 空白 | P3 | 4.0 |
| 动画贴纸（GIF/APNG/WebP） | 空白 | P3 | 5.0（MVP）/ 12+（完整） |
| 文本样式配置 | 空白 | P3 | 随文本贴纸 |
| 动画播放速度持久化 | 空白 | P3 | 随完整版（**依赖贴纸持久化，Highlighter 无**） |
| 贴纸多选 / 对齐 / 贴图组 | 不跟 | — | 区间内仅 +25/−7 |
| 贴纸管理页 / 历史 | 不跟（截图历史页已承担近似职责） | — | — |
| 贴纸资源预算管理器 | 不跟（Qt 级内存管理） | — | — |

### 9.2 两块 P0 的细节

**① 屏幕几何变化重排（1.5 人日）**

Highlighter 现在**完全没有监听**：`main/domains/pin/index.js` 全文只有即时查询 `screen.getDisplayMatching` / `getCursorScreenPoint`；`syncPinDisplayScale` 只在 `pin:move-end` 时调用；全仓 `display-metrics-changed` 只命中 `main/domains/selection/index.js:282`。

后果：拔掉副屏 / 改分辨率 / 改缩放后，贴纸会留在已不存在的坐标上（表现为"贴纸消失"或"飘到屏幕外"）。

**做法**：`screen.on('display-metrics-changed' | 'display-removed' | 'display-added')` → 逐窗 clamp 到 `display.workArea`（若原屏已移除，迁移到主屏中心）。Electron 无 Qt/Cocoa 的时序坑，比 Snow 的 `screenshotpinnedhidetotopcontroller.cpp:231-240,513-544` 简单得多。

**② 滚轮调透明度（2 人日，含穿透态处理）**

- 非穿透态：`pin/pin.js` 加 `if (event.ctrlKey)` 分支 → 新 IPC `pin:set-opacity`（主进程 `setPinOpacity` 已就绪，`index.js:218-223`）；
- **穿透态不可达**（V3 实测）：`setIgnoreMouseEvents(true,{forward:true})` 只转发 mouse move/enter/leave，**不转发 wheel/键盘**。需要"临时退出穿透"或"主进程全局钩子"二选一，后者要新原生件 → **建议先只做非穿透态，穿透态在提示文案里说明**。

### 9.3 贴纸旋转：1.5 人日的"白捡"

`main/domains/pin/geometry.js:51-71` 的 `normalizePinRotation`（quarter-turn 吸附 + 绕回 [0,360)）与 `getRotatedPinSize`（90°/270° 交换宽高、1px 下限）**是成品逻辑，且有 27 条单测**（`test/pin-geometry.test.js:125-154`）。

生产代码**零调用方**：`pin.html` 无 transform 容器、`pin.js` 无旋转交互、`pin.css` 仅 18 行无 transform 规则、IPC 无 `pin:rotate` 通道。

接线即可：右键菜单加"旋转 90°"→ 存 `rotation` → 渲染层 CSS `transform: rotate()` + 主进程用 `getRotatedPinSize` 换窗口尺寸。

### 9.4 不跟部分的关键理由

- **动画贴纸**：MVP 极省（`<img src="blob:...">` 让 Chromium 原生播放，零解码代码），但**拿不到帧序列**，所以没有"步进/变速/播放暂停"。完整版等于重写 Snow 的 1271 行 `animation.cpp` + 1460 行 `screenshotanimationplayback.cpp`；且**贴纸持久化是前置依赖，Highlighter 没有**（`pinWindows` 是内存 `Set`，进程退出即丢）。→ **建议只做"能播"，不做播放控制**。
- **文本/文档贴纸**：会波及 `pin:copy` / `pin:save` / `startPinReannotation` 三处（都以 `dataUrl` 为唯一内容表示），是数据模型级改动；且 HTML 贴纸有注入面（需 `iframe sandbox` + CSP，`pin.html:5` 的 `default-src 'none'` 是良好起点）。
- **收纳到屏幕顶部**：需要"边缘把手窗 + 悬停唤出 + 占位互斥"两个窗口联动，Electron 两窗联动有抖动风险，收益偏创意。

---

## 10. 长截图

| 能力 | 判定 | 优先级 | 说明 |
|---|---|---|---|
| **自动滚动**（间隔可配 128–1000ms） | 空白（但 Snow 是**存量**能力） | P1（高危） | Highlighter 的 `native/scroll-driver` **有回滚史**；且 Snow 本区间只是把间隔做成可配，**不能把本区间投入当作可借鉴度提升的证据** |
| 拼接失败归因 | 弱（有拼接无归因） | P2 | Snow 有 `screenshotscrollingpipeline.cpp:111-204` 的失败分类 |
| 拼接后裁剪 | **持平** | — | Highlighter 已有裁前/裁后（`long-capture/long-capture.html:30-32`） |
| 拼接性能（stitch-images 加速 + 语料基准） | 不跟 | — | Highlighter 是 142 行 JS SAD，瓶颈在"用户手动滚动 + 180ms 抓帧"而非匹配算法 |
| 透明渲染无 mask / QoS 隔离 | 不跟 | — | Qt layered window / macOS 专属 |
| **切分导出（按张数/按高度）** | 空白（**建议做**） | P2 | 1.5 人日，用 `sharp().extract()` 逐段写 PNG，覆盖 Image Split 的 80% 真实用途 |

**关于自动滚动的判断**：这是 Snow 在本区间**之前**就有的能力，旧文档把它列为 P1-6。Highlighter 要做它，难点不在算法而在**驱动第三方窗口滚动**（`native/scroll-driver` 回滚过）。建议：**若做，先做"应用内可滚区域（WebView/浏览器）方案"验证，不做全局 SendInput 方案**。

---

## 11. 新编辑器：Collage 拼图与 Image Split 分割

> 用户点名关注这两个方向。结论：**Collage 缓（做 MVP 探路），Image Split 不做（用长截图切分替代）**。

### 11.1 体量证据：这是两个完整应用，不是两个功能

| 维度 | Collage | Image Split | 参照：Highlighter 单域 |
|---|---|---|---|
| 源码行数 | **7,471 行**（10 文件） | **4,267 行**（8 文件） | `main/domains/pin/` = 682 行；`config/routes/` 全量 = 2,270 行 |
| 测试行数 | 8 个测试文件 **8,480 行** + 6 个 benchmark **1,792 行** | 5 文件 **4,515 行** + 1 benchmark **612 行** | Highlighter 全仓 142 个测试文件 |
| 独立设置域 | `collage/*` + `collage/pdf_*` **20 个 key** | 无（窗口内临时状态） | `settings.screenshot` 一个块 |
| 窗口生命周期 | 单例 + 忙碌/关闭/取消状态机 | **多窗口**（每文件一窗） | 贴纸：单窗、无协调器 |
| 新增 commit | **7** | **7** | — |

Snow 把两者放在 `presentation/collage/` 与 `presentation/imagesplit/`，**与 `capture/`、`pinned/`、`recording/` 平级**——在其架构里就是"另一个应用"。

### 11.2 入口与触达成本：Snow 自己都没有一级入口

| 入口 | Collage | Image Split |
|---|:--:|:--:|
| 主界面侧栏 / 标签页 | ❌ | ❌ |
| 托盘菜单（默认可见） | ❌（需手动勾选） | ❌ |
| 全局快捷键（默认） | ❌（空数组） | ❌（空数组） |
| 历史页单条「更多」菜单 | ✅ | ✅ |
| 历史页多选批量条 | ✅ | ❌ |
| 贴纸管理页 / 贴纸右键 | ✅ | ✅ |

**这是本轮最重要的产品信号**：Snow 用 11.7k 行代码做了一个用户要走 4 步才能到的功能（先有 ≥2 张历史截图 → 进历史页 → 开多选 → 点 Collage）。对 Highlighter（更轻、用户更少、无 Snow 的历史存量）来说，触达率只会更低。

### 11.3 拍板

**Collage：缓（P2，v3.1 之后评估），先做 3 人日 MVP**

- **MVP 范围**：历史页多选 →「拼接选中」→ 纵向/横向 + 统一缩放 + 间距/边框 → 导出 PNG。**无编辑器窗口、无拖拽换位、无旋转、无 PDF**。
- **技术路径**：新建 `collage/collage.html` + Canvas 2D，按 `Sizing::Uniform` 算每格宽高 → `drawImage` 到离屏 canvas → `toBlob('image/png')` 交主进程落盘。素材直接复读历史条目 `filePath`。**不需要任何新依赖**。
- **判据**：上线一个版本后看"历史多选使用率"与"拼接点击率"，>3% 再投 +9 人日做完整编辑器；否则永久关闭。
- **不要做**：PDF 预览页网格 / 逐页导出 / 自定义 mm 纸板（合计 5.5 人日，只有做画册/打印的极少数用户会用）。

**Image Split：不做（明确排除）**

- 它是"发布前的排版工具"，与"获取/理解信息"的截图效率工具定位正交；
- 完整编辑器 = 尺规 + 坐标徽标 + 序号徽标 + **持久化线段树** + 无限 undo + 分块预览 = **≥10 人日**，换极低频场景；
- **替代方案（1.5 人日，建议做）**：长截图窗口加「切分导出…」（按张数或按每份高度 → `sharp().extract()` 逐段导出，目录唯一化）。这一项覆盖 Image Split 的 **80% 真实用途**，且落在**已有的长截图产物**上，触达成本接近零。

### 11.4 从 Collage 里"顺带能白捡"的 3 项

| 项 | 为什么白捡 | 成本 |
|---|---|---|
| **多页 PDF** | Highlighter 已有 `print.html` + `printToPDF` 全套；改成"一个 HTML 放 N 张图 + `page-break-after: always`"即可一次出多页 | **1.5** |
| **PDF 纸张/方向/边距扩展** | 扩 `PAGE_MODES`（现在只 a4/original）+ 映射 `printToPDF` 的 `margins` | 2.0 |
| **导出文件名冲突警告** | `fastSave` 分支当前无用户可见提示 | **0.5** |

---

## 12. 图像导入 / 外壳集成 / 保存导出

### 12.1 判定总览

| 类别 | 项 | 判定 | 优先级 | 人日 |
|---|---|---|---|---|
| 图像导入 | **图片粘贴进编辑窗口** | 空白 | P2 | 1.0（随 Collage MVP 一并获得） |
| | BMP 导入 | 弱（filter 已含 bmp，解码未验证） | **P1** | 0.5（写探针即可定论） |
| | 剪贴板 DIB/DIBV5 解码 | **持平**（Rust sidecar 已有等价能力） | 不跟 | — |
| | 剪贴板文件缓存（导出后粘贴为文件） | 空白 | P3 | 2.5（改 Rust sidecar，成本高于收益） |
| | 图片格式面（GIF/APNG/JXL/AVIF） | 弱 | P3 | 1.0（走 `sharp`） |
| 外壳 | **资源管理器右键「用 Highlighter 打开/贴图」** | 空白 | P1 | 3.0 |
| | 右键菜单 access key | 空白 | P3 | 1.0 |
| | 右键菜单开关 + 卸载清理 | 空白 | P1 | 1.0 |
| | **`--edit-with-highlighter` 启动参数** | 空白 | P1 | 1.0 |
| | **主题化托盘图标** | 空白 | P1 | 1.0 |
| | 安装器关闭 sidecar | 弱（只精确匹配 `Highlighter.exe`） | P1 | 1.5 |
| | Restart Manager | 不跟 | — | — |
| 保存导出 | **时间变量支持自定义日期格式** | 弱（只有 4 个固定 token） | P1 | 1.5 |
| | 目录路径也支持变量 | 空白 | P2 | 1.0 |
| | `{AN}` 应用名 / `{WN}` 窗口标题 | 空白 | P3 | 1.5 + 2–3（V2 实测后） |
| | 变量帮助 UI | 弱 | P3 | 0.5 |
| | **导出文件名冲突警告** | 空白 | **P0** | 0.5 |
| | 多页 PDF | 空白 | **P0** | 1.5 |
| | **`exportWindowToPdf` 接线** | **有代码未接线** | P1 | 0.5 |
| | GIF/APNG/WebP 录屏导出 | 归 §8 | — | — |

### 12.2 外壳集成的三个关键设计（照抄设计，不照抄代码）

**资源管理器右键菜单**（3.0 人日）——推荐用 `execFile('reg', ['add', ...])` 写 `HKCU\Software\Classes\SystemFileAssociations\.png\shell\Highlighter.Open\`（HKCU 无需 UAC）。**必须照抄 Snow 的 3 个设计**：

1. **`ProductId` 值认领归属**（`shellcontextmenuregistration.cpp:295-299`）——只改自己拥有的 verb，不碰别人的；
2. **写前 `snapshot`、失败 `restore` 回滚**（`:345-406`）；
3. **`SHChangeNotify(SHCNE_ASSOCCHANGED)` 刷新**——Electron 无现成 API，可用 `rundll32` 调或省略（Explorer 下次刷新时读取）。

**卸载清理必须进 NSIS `un.onUninstall`**，否则永久残留。**默认值应为"关"**（Snow 默认 `image_files` 开——静默改用户资源管理器菜单是口碑风险）。

**`--edit-with-highlighter` 启动参数**（1.0 人日）——`main.js:1265-1271` 的 `second-instance` 当前不读 argv，`process.argv` 全仓零命中。需要：

- `second-instance` 回调加 `(_e, argv) =>`；
- `app.whenReady` 前解析 `process.argv`；
- 动作复用 `function-router.js:76-83` 的 `fixedContent` 逻辑（改成接受路径参数）。

⚠️ **`main.js` 已 1330/1330 零余量** → 解析逻辑必须先抽到 `main/services/shell-integration.js`，否则 CI 直接红。

**主题化托盘图标**（1.0 人日）——当前 `main.js:842-864` 单一 `assets/icon.png` + `resize({24,24})`，`nativeTheme.on('updated')` 只广播外观**不重建托盘**（`main.js:1295-1297`）。加 `assets/icon-dark.png` + 在 `settings.theme === 'system'` 分支重建 tray 即可。Windows 深色任务栏下白图标不可见是真实痛点，**投入产出比最高的一项**。

### 12.3 保存/导出的两个 P0

**① 多页 PDF（1.5 人日）**

`capture/print.html` 改成 `<div id="pages">`，注入 N 张 `<img>`（每张 `page-break-after: always`），CSS `@page { size: <paper>; margin: 0 }`，一次 `printToPDF` 出多页。

**注意**：`pdf-export.js:14-22` 已记录"`pageSize` 单位是英寸而非微米"的坑，多页场景必须**复用 `computePaperOptions`** 而非另写换算；`scale` 要按"单页内容区"算而非整张图。

**② 导出文件名冲突警告（0.5 人日）**

`main/services/image-file-save.js:35-44` 只有 `showSaveDialog`，无 `existsSync` 预检。Electron 的 native save dialog 在 Windows 上**已自带覆盖确认**，但 `fastSave` 分支没有 → 补 `fastSave` 的预检 + 冲突时 `dialog.showMessageBox({type:'warning',buttons:['覆盖','取消']})`。

---

## 13. 许可证与合规：**动手前必读**

### 13.1 上游许可在区间末尾变了

**2026-10-18 20:01 的 `881132435`** 把 `snow-crates/`、`snow_rust_ffi/` 从 **Apache-2.0 改为 GPL-3.0-or-later**（提交晚于最新发布标签 `v1.3.2`，`git rev-list --count v1.3.2..HEAD` = 1）。

| 目录 | HEAD 许可 | v1.3.2 标签 | 变化 |
|---|---|---|---|
| `snow_shot/` / `snow_image/` / `snow_image_viewer/` | GPL-3.0-or-later | 同 | 无 |
| `snow-crates/` | **GPL-3.0-or-later** | Apache-2.0 | **改** |
| `snow_rust_ffi/` | **GPL-3.0-or-later** | Apache-2.0 | **改** |
| `ant_design_qt/` / `snow_draw_engine_qt/` | Apache-2.0 | 同 | 无 |
| `snow-crates/crates/simd-paddle-ocr-rs/` | **Apache-2.0** | 同 | 无（唯一例外） |

**影响**：旧文档 §5.1 的"snow-crates 可作宽松依赖引入 / 两条路线都能用"**对 HEAD 已失效**。`visual-region-detector`（Auto Filter）、`snow-recording-export`（GIF 编码）、`snow-language-detection` 都随 workspace 变成 GPL。

### 13.2 `GPL-3.0-only` 例外从 3 处膨胀到 79 个文件

| 标签 | `snow_shot` 内含 `GPL-3.0-only` 的文件数 |
|---|---:|
| `v1.2.6` | **5**（按 C/C++/TOML/Rust 类型过滤为 4） |
| `v1.2.9` | 24 |
| `v1.3.0` | 62 |
| `v1.3.2` / `HEAD` | **79**（其中 76 个带 SPDX 头） |

**净新增的 74 个 `-only` 文件全部属于本轮新功能**（按目录分布：`tests` 27、`include` 22、`src/presentation` 20、`src/storage` 3、`src/platform` 3、`rust` 2、`src/image` 1、`THIRD_PARTY_NOTICES.md` 1）。其中 **Collage 18 个、Image Split 9 个**，其余是导出命名/时间变量/窗口标题命名/录制工具栏自动隐藏/贴纸色板等。

⚠️ **这是本轮分析最重要的一条**：本轮想迁移的 **Collage / ImageSplit / 导出命名增强**，其实现文件**带 `GPL-3.0-only` 头**。若 Highlighter 声明 `GPL-3.0-or-later`（旧文档路线 A 的口径）后照抄这些文件，会构成**越权声明**——旧文档的"待定项 α"已从边角问题变成**主流路径的阻断点**。

### 13.3 Highlighter 侧的现状（实测，2026-10-18）

| 检查项 | 结果 |
|---|---|
| 根目录 `LICENSE` / `COPYRIGHT` / `THIRD_PARTY_NOTICES.md` | **全部不存在** |
| `package.json` 的 `license` 字段 | **不存在** |
| git 历史中的许可提交 | **无** |
| 已入库的许可文件 | 4 个，**全是第三方资源的**（Bootstrap Icons MIT、selection-hook MIT、Index-Translate Apache-2.0） |
| 打包白名单是否含许可文件 | **不含**（`build.files` 30 项里没有任何 `LICEN*`/`THIRD*`/`NOTICE*`） |
| 已分发的 copyleft 依赖 | `ffmpeg-static` = **GPL-3.0-or-later**；`@img/sharp-win32-x64` = **Apache-2.0 AND LGPL-3.0-or-later** |

> **这个合规缺口与"要不要移植 snow"无关**，它从 2026-10-10 起就存在且未改善：已在分发 GPL 的 FFmpeg 与 LGPL 的 libvips，但仓库零告知。

### 13.4 "要搬新功能，先决条件是什么"——三态清单

**态 A：可直接借鉴设计**（无版权成本，随时可做）

功能、交互设计、算法思路、协议、界面布局、prompt 文本、测试用例名（功能清单）、配置 schema 形状——**不受版权保护**。

> 注意：**"借鉴设计"不等于"可以逐行转写"**。把 C++ 逐行翻成 JS 属于衍生作品。

**态 B：需先落 LICENSE 才能移植**

| 序 | 先决条件 | 状态 |
|---|---|---|
| B1 | 根 `LICENSE`（GPLv3 正本，674 行逐字 + 哈希锁定） | ❌ |
| B2 | `COPYRIGHT`（程序描述/版权人/GPL 授予/无担保/SPDX/第三方不被覆盖句） | ❌ |
| B3 | `package.json` 补 `license`，且字符串须与 B5 一致 | ❌ |
| B4 | `THIRD_PARTY_NOTICES.md`（覆盖 ffmpeg-static / libvips / SmartSelect.exe / OCR sidecar / Everything / ONNX 模型 / Bootstrap Icons + 生产闭包） | ❌ |
| B5 | **`or-later` vs `only` 定案**，据此决定能否触碰 79 个 `-only` 文件 | ❌ **未决** |
| B6 | 把上述文件纳入 `build.files`/`extraResources`（否则白名单会漏发） | ❌ |
| B7 | About 页 Appropriate Legal Notices 四要素（GPLv3 §5(d)） | ❌ |
| B8 | 源码提供义务（§6）：发布页源码地址 + 3 年书面要约 | ❌ |
| B9 | 移植署名规范（O1 保留版权 / O2 改动说明+日期 / O3 整体 GPL） | ❌ |
| B10 | 许可门禁与契约测试 | ❌ |

**B5 是硬分叉**：若移植目标只含普通 `snow_shot/` 代码 → 可声明 `GPL-3.0-or-later`；若命中 74 个新增 `-only` 文件之一 → **必须声明 `GPL-3.0-only`**（或向版权人取得 `or-later` 授权），否则越权。

**态 C：无论如何不可移植**（工程/法律双杀）

Qt 级自研渲染引擎（强绑 Qt6 + OpenCV）、桌面全局画布、原生打印后端、资源管理器右键菜单注册的原生实现、DIBV5/多格式剪贴板、硬件 H.264 编码管线、任意形状窗口、`GPL-3.0-only` 且不愿改许可的具体代码。

### 13.5 一条最划算的合规建议

**把"取用基准"固定为 `v1.3.2` 标签而不是 `main`。**

理由：`v1.3.2` 的 Rust 侧仍是 Apache-2.0（`snow-crates/Cargo.toml:38` = `license = "Apache-2.0"`），可绕开 relicensing；代价是丢失 2026-10-18 之后的提交——而实测**只有 1 个纯许可提交**，代价 ≈ 0。

同时 `v1.3.2` 的 `GPL-3.0-only` 文件面也是 79（区间内已膨胀），所以 B5 仍需定案；但至少 Rust 侧的合规路径重新打开。

> 免责声明：本节为工程侧许可分析，**不构成法律意见**。正式发布前须由熟悉 GPL 的专业人士复核。

---

## 14. 迁移路线建议（按 感知 ÷ 成本 排序）

### 14.1 批次划分

> ✅ **实施状态（2026-10-19）**：本轮完成了 **批 1、批 2、批 3 的多页 PDF + Ctrl+A 二级、批 4 的表格 Excel + 图片转文档**，
> 合计约 **12 人日**实际投入（估算 16.25–20.25）。批 0 / 5 / 6 / 7 / 8 / 9 / 10 / 11 **均未开始**，与 §14.2 的"做/缓/不做"一致。
> 逐项状态见 §19。

| 批次 | 内容 | 人日 | 前置 | 本轮 |
|---|---|---:|---|---|
| **批 0：合规地基** | LICENSE + COPYRIGHT + `package.json` license + THIRD_PARTY_NOTICES + 打包白名单 + About 页告知 | **3–5** | 所有者拍板 B5 | ⬜ 未做 |
| **批 1：白捡 + bug 级** | 样式回写默认 1.25 + 文件名冲突 0.5 + `exportWindowToPdf` 接线 0.5 + 死配置清理 0.5 + 托盘主题图标 1.0 | **3.75** | 无 | ✅ 全部完成（实测 ≈2.0） |
| **批 2：贴纸体验包** | 滚轮透明度 2.0 + 屏幕几何重排 1.5 + 旋转接线 1.5 + 缩放步进 0.5 | **5.5** | 无 | ✅ 全部完成（实测 ≈4.1） |
| **批 3：导出成品感** | 多页 PDF 1.5 + 选区圆角/阴影/背景不透明度 10–14 + Ctrl+A 二级 0.5 | **12–16** | 批 1（尺寸契约） | 🟡 多页 PDF + Ctrl+A 二级完成；**选区圆角/阴影/背景不透明度未做** |
| **批 4：识别输出** | 表格导出 Excel 1.5 + 图片转 Markdown/HTML 2.0 + 原地翻译导出 1.5 | **5.0** | AI 多模态（含在 2.0 内） | 🟡 前两项完成（图片转文档实测 2.6）；**原地翻译导出未做** |
| **批 5：录屏体验** | trim/变速 5–6 + 音轨图标 0.5 + 增益滑杆 1.5 + `captureCursor` 接线 1.0 | **8–9** | V1 已实测 | ⬜ 未做（`captureCursor` 已按删除处理，见 §19.2 #5） |
| **批 6：录屏格式** | GIF/APNG/WebP + 稀疏帧瘦身 | **6.0** | 批 5（共享编码参数面板） | ⬜ 未做 |
| **批 7：选区与快捷键** | 选区历史浏览 4–6 + 窗口内快捷键 3–5 + 居中滚轮缩放 1.5 | **8.5–12.5** | 无 | ⬜ 未做 |
| **批 8：外壳集成** | 右键菜单 3.0 + `--edit-with` 1.0 + 菜单开关/卸载 1.0 + 安装器 sidecar 1.5 | **6.5** | **`main.js` 行数腾挪** | ⬜ 未做（已腾出 6 行余量，但不足以装 `shell-integration`） |
| **批 9：标注工具（逐个立项）** | 放大镜 8–10 / 压感画笔 10–12 / 角度 8–12 / 聚光灯 8–12 / 气泡 18–25 | 逐个 | 无 | ⬜ 未做 |
| **批 10：探路** | Collage MVP 3.0 + 长截图切分 1.5 + BMP 探针 0.5 | **5.0** | — | ⬜ 未做 |
| **批 11：MCP** | 自研 Node 版 12 工具 | **10.0** | **批 0 必须先完成** | ⬜ 未做 |
| **合计（批 0–8，建议本期）** | | **58–69** | — | 🟡 本轮 ≈12 |
| **批 9（若有预算再逐个立项）** | 批 9 中位 | **61.5**（区间 52–71） | — | ⬜ 未做 |
| **批 10 + 批 11** | Collage MVP/切分/BMP 探针 + MCP | **15.0** | 批 0 完成后才可做 MCP | ⬜ 未做 |
| **全部批次总计（如果全做）** | | **约 125–155** | — | 剩余 ≈113–143 |

> 校验：
> - 批 0–8 下限 = 3 + 3.75 + 5.5 + 12 + 5 + 8 + 6 + 8.5 + 6.5 = **58.25**；上限 = 5 + 3.75 + 5.5 + 16 + 5 + 9 + 6 + 12.5 + 6.5 = **69.25**。
> - 批 1–4（不含批 0）合计 **26.25–30.25 人日**。
> - 批 9 逐项中位 = 9 + 11 + 10 + 10 + 21.5 = **61.5**（区间 52–71）。
> - **全部批次总计 ≈ 125–155 人日**（下限 58.25+52+15 = 125.25；上限 69.25+71+15 = 155.25）。**这是"如果全做"的口径，不代表建议**——实际建议见 §14.2。

### 14.2 做 / 缓 / 不做

> ✅ **实施状态（2026-10-19）**：**"做（本期）"里除录屏批 5/6 外全部落地**（批 1、批 2、批 3 的导出部分、批 4 的识别输出）。
> "做（探路）"与"缓"的项一律未动。没有任何一项"不做"被偷偷做了。

| 结论 | 项 | 本轮 |
|---|---|---|
| **做（本期）** | 批 1–4（白捡 + bug + 贴纸体验 + 导出成品感 + 识别输出）；批 5/6（录屏，V1 已验证可行）；批 8 前先做 `main.js` 腾挪 | ✅ 批 1/2 全做；批 3/4 部分做；⬜ 批 5/6 未做；✅ `main.js` 腾挪已完成（1324/1330，余 6 行） |
| **做（探路）** | Collage MVP（3d，带 3% 判据）、长截图切分导出（1.5d）、BMP 探针（0.5d） | ⬜ 未做 |
| **缓** | MCP（等批 0）、标注工具逐个立项（放大镜/压感优先）、选区历史浏览（4–6d 但依赖历史 schema 扩展） | ⬜ 未做 |
| **不做** | Collage 完整编辑器、Image Split 完整编辑器、任意形状选区、跨屏统一画布、工具行可拖动、OCR 运行时重写、Qt/Rust 级性能工程、macOS/ARM64/vcpkg/双版本 | ✅ 一项未碰 |

> **一句话排期建议**：**批 1 + 批 2 + 批 4（约 14.3 人日）先做一个版本**——这三批几乎全是"白捡 / 修 bug / 补接线"，风险最低、用户每天都能感知；验完再上批 3（导出成品感，10–14 人日）与批 5/6（录屏，14–15 人日）。

### 14.3 三个"不要现在做"的理由

1. **不要先做 MCP**：它需要 10 人日 + 批 0 的合规地基，而批 1–4 的约 26–30 人日能带来更直接的用户感知；且 MCP 的验收需要外部客户端，回路最长。
2. **不要先做标注工具**：放大镜/角度/气泡都是"新画布能力"，每个 8–25 人日，但它们**不影响现有用户的主链路**；先把样式回写默认、导出效果、贴纸体验这些"每天都会撞上"的问题修掉。
3. **不要做 Collage 完整编辑器**：11.7k 行的产品线，触达需要用户走 4 步；先用 3 人日 MVP 验证点击率。

---

## 15. 与旧文档的冲突清单（引用前必看）

| 旧文档说法 | 出处 | 今日复核 | 处置 |
|---|---|---|---|
| 六支柱（第二行/右键/滚轮/per-tool/色板/mixed）均"无"或"部分" | `2026-10-14-snow-apps-toolbar-interaction-gap-analysis.md` | **v3.0.0 全部落地**（见 §1.3） | 旧文档只作历史论证保留，**不得再引用其"现状"列** |
| "点击 vs 拖动阈值：无" / "画笔端点续画：无" / "选中项样式回显：无" | 同上 §2.3/§4.3 | 均已有 | 同上 |
| "取色器 + 放大镜：空白（P1）" | `2026-10-10-snow-apps-feature-gap-analysis.md` §2.2 | 指的是**取色器旁的小放大镜**，与本次「放大镜标注」（独立工具）**不是同一功能** | 引用时注明"不同功能" |
| "Enter 默认复制" | 旧文档 P0-7 | snow 只是把 `Return` 追加进既有 `copy_to_clipboard` 默认；Highlighter **早已有**（`capture.js:2138`） | **持平，不是缺口** |
| "Ctrl+A 全屏" | 旧文档 P0-7 | Highlighter **已有** Ctrl+A（选当前屏），缺的是"第二级扩到所有屏" | 从"空白"改为"弱" |
| "OCR 引擎 = 持平（档位少）" | 旧文档 §2.4 | 本区间 snow 从 7 档砍到 3 档、**删掉 ONNX Runtime + DirectML**（−19,863 行），换自研 SIMD | 改为"路线不同，引擎代差不构成用户可感知短板" |
| "表格识别 = 弱（可编辑/合并单元格）" | 旧文档 §2.4 | 需拆细：**导出 xlsx（P1，1.5d）** 与 **表格编辑（P3，5d+）** 是两件事 | 拆成两条立项 |
| "`snow-crates/` 是 Apache-2.0，可作依赖引入" | 旧文档 §5.1 | **已失效**（`881132435` 改为 GPL-3.0-or-later） | 见 §13 |
| "GPL-3.0-only 例外共三处" | 旧文档 §5.1 | 实为 **79 文件**（按 C/C++/TOML/Rust 类型过滤时 v1.2.6 为 4、其余全类型为 5），其中 74 个是本区间净新增（四种 grep 口径互证：79−5 = 77−3 = 76−2 = 溯源 74） | 见 §13.2 |
| "MCP 是本轮 P1 招牌" | 旧文档 §3 | **是存量能力**，本区间只做机械同步（101 工具不变） | 引用时注明存量 |
| "长截图自动滚动可借鉴" | 旧文档 P1-6 | Snow 在 v1.2.6 前**已有**该能力，本区间只把间隔做成可配 | 不能把本区间投入当可借鉴度提升 |
| "交接文档：`main.js 1297/1300`、i18n 605/606、npm test 1012" | `2026-10-15-capture-interaction-handoff.md` | **已陈旧**：实测 `main.js` **1330/1330**、i18n **588 ≤ 606** | 引用新读数 |

---

## 16. 待验证项（不改变本文结论方向，但影响单项成本）

| # | 项 | 影响 | 验证方式 | 结论（2026-10-19） |
|---|---|---|---|---|
| P1 | `nativeImage.createFromPath('*.bmp')` 在 Electron 43 是否可用 | BMP 导入 0.5d vs 1.0d | 写 10 行探针读一张 BMP → `isEmpty()` | ⬜ 未验证（本轮未做 BMP） |
| P2 | `printToPDF` 对 `page-break-after: always` 的分页支持 | 多页 PDF 1.5d vs 3d | `print.html` 放 3 张图 → 断言 PDF `/Type /Page` 计数 = 3 | ✅ **成立**。真实 Electron（隐藏窗口）3 图 → `/Type /Page` = 3，MediaBox 842.88×595.92（A4 横向），`activePrintWindowCount` 归 0。**额外发现**：末页必须重置 `break-after`，否则会多一张空白页（分析未提示） |
| P3 | PNG 导出链路是否保留 alpha（`canvasPngBuffer` → `main` 写文件/剪贴板） | 选区背景不透明度 +2d | 导出带 alpha 的 PNG → 用 `sharp().metadata().hasAlpha` 校验 | ⬜ 未验证（选区背景未做，留待批 3 剩余项） |
| P4 | `PointerEvent.pressure` 在 Electron 43 + Windows 触控板/鼠标下的取值分布 | 压感画笔是否需要"模拟压力"兜底 | 真机探针记录 | ⬜ 未验证（压感画笔未做） |
| P5 | `getCoalescedEvents()` 在 capture 窗口（无焦点/`backgroundThrottling:false`）下是否可用 | 笔迹平滑降级路径 | 真机探针 | ⬜ 未验证 |
| P6 | `webUtils.getPathForFile`（Electron 32+ 已删除 `File.path`） | Collage 拖放导入必须走此 API | 写探针 | ⬜ 未验证 |
| P7 | V6 small vs V4 mobile 在**中文截图**上的准确率/速度 | 模型档位扩展是否立项 | 用现有 sidecar 跑 30 张 baseline 对比 | ⬜ 未验证 |
| P8 | `shared/shortcut-keys.js` 的 `isValidAccelerator` 是否支持 Enter 作为窗口内键 | 窗口内快捷键实现路径 | 读该模块 + 单测 | ⬜ 未验证（窗口内快捷键未做） |

> **新增的、分析时没列的验证项**（都已在本轮验证）：
>
> | # | 项 | 结论 |
> |---|---|---|
> | P9 | `PDF` 多页时 `printToPDF` 的 `scale` 是否逐页生效 | ❌ **不是**。`scale` 是文档级参数，只能设一次。因此按第一页算纸张、其余页在 CSS px 域内各自等比 fit，batch 的 `scale` 强制为 1（否则双重缩小） |
> | P10 | `buildXlsxBuffer` 产出能否被真实 Excel 打开 | ✅ 是。6 个 part 全部 DEFLATED；openpyxl 与真实 Excel（headless COM）都能读：sheet 名、维度、合并区、文本格式前导零、emoji 均正确。WPS / LibreOffice 未验（本机没装） |
> | P11 | 模型目录的 `capabilities` 能否在保存后存活 | ❌ **原本会丢**。`config/routes/models-editor.js` 保存供应商时只重建 `{id,name}`，把 `capabilities` 整个丢掉。已修（新增 `mergeModelRow()`），否则 `vision` 开关一点保存就消失 |

---

## 17. 证据索引（可复现命令）

```bash
# ── 区间真相 ────────────────────────────────────
cd F:/workspace/snow-apps
git rev-parse v1.2.6_snow-shot HEAD          # ef47b48c6… / 881132435…
git rev-list --count v1.2.6_snow-shot..HEAD  # 152
git diff --shortstat v1.2.6_snow-shot..HEAD  # 1436 files, +227356/-40266
git diff --shortstat v1.2.6_snow-shot..v1.3.2_snow-shot   # 去掉许可提交后
git log --format='%s' v1.2.6..HEAD | grep -c '^feat'      # 63
git diff --name-status --diff-filter=A v1.2.6..HEAD -- snow_shot/tests | grep -c '^A'  # 75

# ── 许可 ────────────────────────────────────────
git show 881132435 --stat --format=''        # 41 files, +16897/-5086
git show 881132435 -- LICENSE.md             # snow-crates / snow_rust_ffi 改 GPL
git show v1.3.2_snow-shot:snow-crates/Cargo.toml | grep license   # Apache-2.0（标签仍是）
grep -rl 'GPL-3.0-only' snow_shot | wc -l    # 79
git grep -l 'GPL-3.0-only' ef47b48 -- '*.h' '*.cpp' '*.toml' '*.rs' | wc -l   # 4
grep -n 'license' snow_shot/rust/snow-shot-mcp/Cargo.toml   # GPL-3.0-only

# ── MCP ────────────────────────────────────────
python -c "import json;d=json.load(open('snow_shot/mcp-capabilities.json'));print(sum(len(v['tools']) for v in d['domains'].values()))"  # 101
git diff ef47b48..HEAD -- snow_shot/mcp-capabilities.json    # 仅 canvas_tools/style_sources
git diff --shortstat ef47b48..HEAD -- snow_shot/rust/snow-shot-mcp   # 0

# ── Collage / ImageSplit 体量 ───────────────────
wc -l snow_shot/src/presentation/collage/* | tail -1        # 7471
wc -l snow_shot/src/presentation/imagesplit/* | tail -1     # 4267
wc -l snow_shot/tests/collage_* snow_shot/tests/imagesplit_* | tail -1  # 15494
grep -n "stitch_selected_images" -A 4 snow_shot/src/storage/configurationschema.cpp   # 默认 []

# ── Highlighter 现状 ────────────────────────────
cd F:/workspace/Highlighter
node scripts/check-architecture.js            # 分析时 ok (main.js 1330/1330)；实施后 1324/1330
node scripts/check-i18n.js                    # 分析时 TOTAL 588；实施后 585（--max 606）
ls LICENSE* COPYRIGHT* THIRD_PARTY_NOTICES.md 2>/dev/null   # 全不存在
node -e "console.log('license' in require('./package.json'))"   # false
grep -rn "collage\|imagesplit\|拼图\|分割" main/ config/ pin/ capture/   # 零命中
grep -rn "HKCU\|SystemFileAssociations\|MultiSelectModel" --include=*.js . # 零命中
grep -rn "display-metrics-changed" main/ main.js   # 只命中 selection/index.js:282
grep -rn "exportWindowToPdf" --include=*.js . | grep -v node_modules | grep -v .tmp  # 分析时只有定义+导出+测试；实施后已有贴图/识别两个生产调用方
grep -rn "display-metrics-changed" main/domains/pin/   # 实施后：贴纸显示几何重排已接线
grep -rn "webContents.print(" --include='*.js' .    # 0（系统打印仍空白）
FF=./node_modules/ffmpeg-static/ffmpeg.exe
"$FF" -hide_banner -encoders | grep -Ei 'gif|apng|webp|x264|x265'
"$FF" -hide_banner -filters  | grep -Ei 'atempo|palettegen|paletteuse|fps|tpad'
```

---

## 18. 附：本次分析的方法与局限

> 📌 本节是**分析轮**（2026-10-18）的方法与局限。实施轮（2026-10-19）的验证口径与残余风险见 §19.11。

**方法**：5 路并行只读调研（截图/标注、新编辑器、OCR/识别、录屏/贴纸/平台、基线与许可），全部结论落到 `文件:行号` 双侧证据；Lead 负责交叉校验与 5 项实测（V1–V5）。

**局限**：
1. **未运行任何程序** —— 所有"表现"结论来自源码与测试用例名，未经真机验证；涉及体验优劣的判断需真机复核；
2. **许可证分析不是法律意见** —— GPL 义务、`-only` 与 `or-later` 的混用风险需专业人士确认；
3. **人日估算** 基于代码体量与同类改造经验，误差约 ±40%；对依赖真机验证的项（压感、多屏、DPI）已单列（§16）；
4. **上游仍在演进** —— 分析基准为 `881132435`（2026-10-18 20:01），Snow Shot 约 1.5 天一个标签，后续新增需增量复核；
5. **判定计数按域独立统计** —— 各域项数含少量跨域重叠（贴纸相关 6 项在"新编辑器"与"录屏/贴纸"两域各出现一次），本文 §0.2 已给出去重口径，**不要**直接把各域项数相加；
6. **5 个项目级假设已在 §2 用实测修正** —— 但仍有 §16 的 8 项待探针验证（BMP 解码、`printToPDF` 分页、PNG alpha、压感取值等），它们只影响单项成本，不改变整体结论方向。

> 🔄 **实施后更新（2026-10-19）**：§16 的 P2（`printToPDF` 分页）**已实测成立**，并额外发现"末页须重置 `break-after`"这一分析未提示的坑；同时新增 P9–P11 三项分析时没列的验证项（`scale` 是文档级参数、`.xlsx` 能被真实 Excel 打开、模型 `capabilities` 原本会在保存时丢失）。其余 P1/P3–P8 仍未验证，见 §16 表内"结论"列。


---

## 19. 实施回填：2026-10-19 落地记录

> 本节是**新增**的。§0–§18 的**结论与成本估算一字未改**，只在其上叠加了三类标注：
> ① ✅/🟡/⬜ 状态列与"实测成本"（§0.3、§14.1、§14.2）；② 实施后门禁新读数（§1.4、§17）；③ §16 待验证项的结论回填。
> 因此**引用 §0–§18 的估算值时要连同状态列一起看**，引用"现状"时一律以本节为准。
> 记录口径：只记实际写进仓库的东西，包括与分析的偏差、以及分析时没预料到的坑。
> 实施基线 `master @ d9ad364`（"feat(capture): turn highlight and mosaic into brush strokes"，2026-10-19）。

### 19.1 一句话

§0.3 的 **7 项 P0 全部落地**，外加批 1/2/4 的剩余项与两项分析未列但顺带完成的能力（图片转文档、主题化托盘图标已列但成本高估）。
**未做**：MCP、选区圆角/阴影/背景不透明度、录屏 trim/GIF、Collage、长截图自动滚动、批 0 合规地基 —— 与 §14.2 的"做/缓/不做"一致，没有任何一项被降级成"假装做了"。

### 19.2 §0.3 七项 P0 的落地状态

| # | 项 | 状态 | 落点（实施后行号） | 与分析的偏差 |
|---|---|---|---|---|
| 1 | 元素样式编辑回写"下次创建默认" | ✅ | `capture/capture.js:1784` `writeSelectedStyleDefault()`；`commitSelectedStyle()` / `stageSelectedStyle()` 各接一处 | 分析说"1.0–1.5 人日"。实际的难点不在写回，而在**离散 vs 连续**两条路径的持久化纪律：取色器拖动 `input` 按鼠标频率触发，若沿用 `persist=true` 会变成每事件一次 `settings:update`。实现改为离散路径持久化、staged 路径只改内存（`change` 时才落盘），与既有"滚轮调线宽防抖"同一套纪律。成本 ≈ 0.6 人日 |
| 2 | 多页 PDF（单次 `printToPDF`） | ✅ | `main/services/pdf-export.js:500` `exportPagesToPdfBuffer()`；`capture/print.html` `#pages`；`MAX_PDF_PAGES=50` | 分析估 1.5 人日。真实难点是 **`printToPDF` 的 `scale` 是文档级属性**：不能按页设，所以纸张/方向/scale 只按第一页算，后续页在 CSS px 域内各自等比适配（页内 fit 而非二次缩放），并把 batch 的 `scale` 强制为 1 避免双重缩小。另外末页必须重置 `break-after` 否则 Chromium 会多吐一张空白页。真实 Electron 探针：3 图 → `/Type /Page` 计数 = 3，`activePrintWindowCount` 归 0。成本 ≈ 1.8 人日（略高于估算） |
| 3 | 导出文件名冲突警告（含 `fastSave` 预检） | ✅ | `main/services/image-file-save.js:37` `defaultConfirmOverwrite()`；冲突分支 `:135` | 分析估 0.5 人日。实现时补了一条分析没写的边界：`fast=true` 但**没有记忆目录**时 resolver 会退回原生保存对话框，Windows 已经自带覆盖确认，此时必须跳过预检否则会双弹窗。成本 ≈ 0.3 人日 |
| 4 | `exportWindowToPdf` 接线（贴图/识别结果导 PDF） | ✅ | 贴纸 `main/domains/pin/index.js:475` `exportPinToPdf()`；识别 `main/domains/recognition/index.js:195` `recognitionExportPdf` | 分析估 0.5 人日。实测**零成本**：`pdf-export.js` 的 `printToPdf` / `dialog` / `fs` 全部是惰性默认实现，两个域直接 import 即可，`main.js` 一行都不用加。成本 ≈ 0.2 人日 |
| 5 | 死配置清理 / 接线 | ✅ 清理 | `main/services/settings-defaults.js`（删 5 键）；`main/services/settings-normalize.js` `LEGACY_DEAD_KEYS` + `dropLegacyDeadKeys()` | 分析估 0.5 人日。**与分析有一处判断分歧**：分析把 `record.captureCursor` 归为"接线"，但 Chromium 的 `getDisplayMedia` 并不保证可供开关控制光标（`cursor` 只是 hint，可能被忽略）。给一个"勾了也可能没效果"的开关比不给更差，因此按**删除**处理，并在 normalize 里加了迁移删除（老 store 不会永久留死键）。`fixedContent.autoResize`/`autoOcr`/`ocr.modelWriteToMemory`/`screenshot.saveFormat` 同样删除。成本 ≈ 0.4 人日 |
| 6 | 贴纸屏幕几何变化重排 | ✅ | `main/domains/pin/index.js:154` `reflowPinWindow()`、`:195` `attachPinDisplayWatchers()`；纯函数在 `main/domains/pin/geometry.js:127/145` | 分析估 1.5 人日。**关键约束是分析没写的：`main.js` 已到 1330 行硬顶**，不能加 `before-quit` dispose。实现改为「首个贴纸懒挂载 3 个 `screen.on` 监听、最后一个关闭时卸载」，监听器本身随进程消亡，`main.js` 零改动。成本 ≈ 1.2 人日 |
| 7 | 贴纸旋转接线 + 滚轮调透明度 | ✅ | 旋转 `main/domains/pin/index.js:402` `rotatePin()`；透明度 `:780` `pin:set-opacity` | 分析估 3.5 人日（V4 修正后旋转 1.5 + 透明度 2.0）。实际 2.4 人日：旋转确实"白捡"（几何 helper 已有 27 条单测），但窗口包围盒要跟着交换宽高、且要处理长截图不可旋转（滚动内容无法 CSS 旋转）、旋转后 `syncPinDisplayScale` 必须 DPI 感知。透明度部分如分析所述，穿透态收不到 wheel，已如实注释未伪造。成本 ≈ 2.4 人日 |

**合计实测 ≈ 6.9 人日**（分析估 9.0–9.5），主要省在 #4（零依赖接线）与 #7（helper 已成品）。

### 19.3 截图 / 选区（批 3 与 §3.2②）

| 项 | 状态 | 落点 | 说明 |
|---|---|---|---|
| Ctrl+A 二级（扩到全桌面） | ✅ | `capture/capture.js:293` `desktopSelectionBounds()`、`:328` `ctrlASelectionExpandsToDesktop()`；主进程 `main/domains/capture/index.js:231` `desktopBounds()` | 严格按分析"**只扩 bounds、不保证跨屏内容**"立项。单显示器时并集 == 当前屏 → 纯 no-op；重复按下在"本屏 / 全部屏"之间二选一（对齐 Snow 的 `expandToAllScreens` 语义）。**分析没预见的坑**：并集选区会让 `exportSelectionCanvas` 按并集比例画标注（3840 宽的并集上标注只有一半大小并带负原点位移），导出结果会花。修法是新增 `exportSelectionRect()`（`:2238`）把选区投影回被截图像：数值相同则**返回原对象引用**，保证所有既有流程逐像素不变；不同才在一次**同步**调用内临时替换 `selection` 并在 `finally` 还原（无 `await`，rAF 无法插入）。这条是本轮唯一一处"新功能差点破坏老功能"的地方 |
| 选区圆角/阴影/背景不透明度 | ⬜ 未做 | — | 分析列为 P1（10–14 人日），但属批 3，本轮范围外 |
| 选区历史浏览 / 比例锁 / 数值面板 | ⬜ 未做 | — | 同上（P1/P2） |

### 19.4 贴图（§9 与批 2）

| 项 | 状态 | 落点 | 说明 |
|---|---|---|---|
| 屏幕几何重排 | ✅ | 见 §19.2 #6 | 屏消失→主屏 workArea 居中；仍在→夹回 workArea；随后 `syncPinDisplayScale` 走 DPI |
| 旋转接线 | ✅ | 见 §19.2 #7 | CSS transform + 窗口包围盒交换；`dataUrl` 从不重编码 |
| Ctrl+滚轮透明度 | ✅ | `pin/pin.js` wheel 分支 → `pin:set-opacity` → `setPinOpacity` | ±0.05 每格，`clampPinOpacity` 夹 0.25–1，带瞬时百分比徽标；右键菜单 4 档预设保留 |
| 缩放步进可配 | ✅ | `settings.pinned.zoomStep`（默认 0.1，夹 0.05–0.5）；设置页新增下拉 | 供 `main/domains/pin/geometry.js:34` `normalizePinZoomStep()` 与渲染层共用同一取值域 |
| 贴纸导出 PDF | ✅ | 见 §19.2 #4 | 打印已渲染窗口本身，所见即所得 |
| 动画贴纸 / 文本贴纸 / 收纳到顶部 | ⬜ 未做 | — | 与分析 §9.4 的"不跟/缓"一致；其中"动画贴纸"仍缺贴纸持久化前置 |

### 19.5 识别 / AI 输出（批 4）

| 项 | 状态 | 落点 | 说明 |
|---|---|---|---|
| 表格识别 → 真 `.xlsx` | ✅ | 新文件 `main/services/table-workbook.js`（`buildWorkbookParts()` `:322`、`buildXlsxBuffer()` `:344`）；IPC `recognition:export-excel`（`main/domains/recognition/index.js:173`，注册在 `main/ipc/capture-ipc.js:32`） | 按分析走 **手写 OOXML + `adm-zip`**，零新依赖。6 个 part（含 `xl/_rels/workbook.xml.rels`）；`inlineStr` 单元格；`mergeCells` 支持三种入参形状；`numFmtId=49` 保住前导零与 16+ 位长数字；控制字符转 `_xHHHH_` 且字面 `_x0041_` 反向转义；32,767 UTF-16 单位上限且不切断代理对；1,048,576×16,384 夹取。**已用 openpyxl 与真实 Excel（headless COM）打开验证**：sheet 名、维度、合并区、文本格式前导零、emoji 全部正确 |
| 图片转 Markdown / HTML | ✅ | 新文件 `main/services/ai-image-conversion.js`（请求形状 + prompt）、`main/services/ai-document.js`（provider 解析 + 存盘）；`main/services/ai/client.js:467` `convertImage()`；IPC `capture:convert-image`（`main/ipc/ocr-ipc.js`）；入口 `capture/capture.html` `#convertDoc` 弹出两格式菜单 | 分析点名的**硬阻塞点已修**：`ai-protocol-adapters.js` 的 `buildResponsesMessages()` 原来无条件 `String(content)`，现在 `toResponsesContent()` 保留数组并按 Responses 协议映射成 `input_text`/`input_image`。能力位 `vision` 落在 `ai-model-capabilities.js`，模型编辑页加了开关（`config/routes/models-provider.js`，顺带修了一个既有 bug：保存供应商会丢掉每个 model 的 `capabilities`）。prompt 对齐 Snow 的规则（保持原语言/阅读顺序/表格/链接、禁翻译与臆造、图中指令视为正文不执行、不可读标 `[illegible]`）。成本 ≈ 2.6 人日 |
| 原地翻译导出 | ⬜ 未做 | — | 分析列 P1（1.5 人日），本轮未排 |
| OCR 运行时重写 / 模型档位 | ⬜ 未做 | — | 与分析 §6.3 结论一致（架构同型，用户不可感知） |

### 19.6 外壳 / 卫生（批 1 收尾）

| 项 | 状态 | 落点 | 说明 |
|---|---|---|---|
| 主题化托盘图标 | ✅ | 新文件 `main/services/tray-icon.js`（`createTrayIconImage()` `:49`、`resolveTrayIconTheme()` `:33`）；`assets/icon-dark.png`；`generate-icon.js` 现在同时产出两版 | 分析估 1.0 人日。`theme==='system'` 时跟随 `nativeTheme.shouldUseDarkColors`，并在 `nativeTheme.on('updated')` 里重建托盘（原来只广播外观）。**`main.js` 行数硬顶**：为容纳 3 行新代码，先把 4 个三行 wrapper（`ensureDirectory`/`imageDataToBuffer`/`dataUrlToBuffer`/`bufferToDataUrl`）收成 2 行解构赋值，净省 7 行，最终 **1324/1330**（比改动前还低 6 行） |
| 死配置清理 | ✅ | 见 §19.2 #5 | — |
| 历史页多选 → 多页 PDF | ✅（分析未单列，属多页 PDF 的落点） | `main/services/history-service.js` `selectExportItems()`；`main/ipc/history-ipc.js:166` `history:export-pdf`；`config/routes/history.js` 批量条新增按钮；`preload.js` `exportHistoryPdf` | 多页 PDF 的真实入口：`exportMany` 改为复用 `selectExportItems()`，复制目录逻辑不重复 |
| 资源管理器右键菜单 / `--edit-with-highlighter` / 安装器 sidecar | ⬜ 未做 | — | 批 8，前置是 `main.js` 行数腾挪（已腾出 6 行但仍不够装一个 `shell-integration` 装配） |

### 19.7 新增 IPC 通道（7 条，全部已进 `IPC_SURFACES` 策略）

| 通道 | 方向 | role | 用途 |
|---|---|---|---|
| `capture:convert-image` | handle | capture | 截图 → Markdown/HTML |
| `pin:set-opacity` | listener | pin | Ctrl+滚轮透明度 |
| `pin:rotate` | listener | pin | 旋转 90° |
| `pin:export-pdf` | handle | pin | 贴纸窗口导 PDF |
| `recognition:export-excel` | handle | recognition | 表格 → `.xlsx` |
| `recognition:export-pdf` | handle | recognition | 识别结果窗导 PDF |
| `history:export-pdf` | handle | main | 历史多选 → 多页 PDF |

另有 2 条**主 → 渲染**广播（`pin:opacity-changed`、`pin:rotation-changed`），按方案 §2.2 刻意**不进** `IPC_SURFACES`（与 `i18n:language`、`capture:init` 同类）。

### 19.8 新增文件（6 个）

| 文件 | 行数量级 | 职责 |
|---|---|---|
| `main/services/table-workbook.js` | ~360 | 纯 OOXML 工作簿写入器（无 Electron 依赖，可纯 node 单测） |
| `main/services/ai-image-conversion.js` | ~160 | 多模态请求形状 + 转换 prompt + 围栏剥离 |
| `main/services/ai-document.js` | ~120 | provider 解析 → AI 调用 → 保存对话框 → 落盘（依赖注入，可纯 node 测） |
| `main/services/tray-icon.js` | ~90 | 托盘图标主题选择（资产选取 + 回退链） |
| `assets/icon-dark.png` | 256×256 | 深色任务栏用的托盘图标（`generate-icon.js` 同步产出） |
| `capture/icons/doc-convert.svg` | — | 图片转文档入口图标（已进图标序列契约测试） |

### 19.9 偏离分析的三处判断（需要知悉）

1. **`record.captureCursor` 由"接线"改为"删除"**（§19.2 #5）——理由见上：Chromium 不提供可靠的运行时开关，给一个可能无效的开关更差。
2. **`main.js` 不是"加几行装配"，而是必须先腾挪**。分析 §1.4 已警告过这条，但低估了影响面：本轮所有新能力都被强制约束在 `main/domains/`、`main/services/`、`main/ipc/` 里，且 `pin` 的显示监听改成懒挂载以免需要在 `before-quit` 里 dispose。这个约束同时是好事：新代码没有一行长进装配层。
3. **"图片转 Markdown/HTML"的成本被分析低估（2.0 → 2.6 人日）**。分析只算了 AI 层的 0.3+0.3+0.5+0.5+0.2+0.2=2.0，但漏了两件必要工作：① 保存对话框 + 默认文件名要复用 `capture-naming` 的模板（否则导出名与截图命名脱节）；② 模型目录必须能表达"这个模型支持图像"，而原实现**保存供应商时会把 `capabilities` 整个丢掉**——不修这个，`vision` 开关一点保存就消失。第 ② 项是既有 bug，本轮顺带修复。

### 19.10 门禁读数（实施后，替换 §1.4 的"当前值"列）

| 门禁 | 阈值 | 实施后 | 余量 | 证据 |
|---|---|---:|---:|---|
| `main.js` 行数 | **1330** | **1324** | **6 行** | `node scripts/check-architecture.js`（腾挪前 1330/1330） |
| i18n 中文残留 | **606** | **585** | **21 行** | `node scripts/check-i18n.js --max 606`（基线 588；新增 CJK **0 行**，全部新增文案进 locale） |
| locale 对称 | 3 语言等键 | **1169 × 3** | 对称差 0 | `node scripts/check-i18n.js` |
| 新增 locale key | — | **36 个**（config 14 / main 9 / recognition 9 / capture 3 / pin 1） | — | 同上 |
| `check-js` | — | 340 文件通过 | — | `node scripts/check-js.js` |
| 单测 | — | **1128 项 / 1110 通过 / 18 失败** | 18 条与改动前 **HEAD 基线逐条一致** | `node --test test/*.test.js`；基线失败集在 `HEAD` 上复现（Electron 运行时/发布校验类环境失败，非本轮引入） |
| 新增测试文件 | — | **0** | — | 按用户要求"优先开发，测试最后由用户判断" |
| 既有测试断言调整 | — | **7 个文件**（新增契约登记，非放宽） | — | `test/` diff: +34/−12；每处都是"行为被有意改变或新通道/新图标需要登记" |

### 19.11 未验证项（真机/环境）

- **未跑 `npm test`**、**未启动 Electron 应用**（按用户要求，且避免占用前台）。功能正确性依据：静态门禁 + 既有单测回归 + 队友用隐藏窗口做的真实 Electron 探针（多页 PDF 分页、xlsx 打开、托盘/贴纸窗口行为），探针产物已删除。
- `test/window-security-runtime.test.js` 在本 shell 因 `ELECTRON_RUN_AS_NODE=1` 失败；`env -u ELECTRON_RUN_AS_NODE` 下通过——环境问题，与本轮改动无关。
- **未做真实设备的**：多显示器拔插（几何重排只有 fake-screen 单测级别验证）、笔/触控板压感（本轮未做压感画笔）、WPS/LibreOffice 打开 `.xlsx`（只验了 Excel 与 openpyxl）。

### 19.12 下一步建议（按性价比）

1. **补 3 处单测**（用户决定是否做）：多页 PDF 的分页数与末页无空白页、`buildWorkbookParts` 的 part 集合与转义、样式回写默认值的 mixed-selection 分支。
2. **批 3 剩余**：选区圆角/阴影/背景不透明度（10–14 人日）——这是"成品感"最大的单点，且契约点已在分析 §3.3 列清（`selectionBounds` meta / PDF `pxW·pxH` / 剪贴板尺寸三处必须同步）。
3. **批 8 外壳**：需先继续腾 `main.js` 行数（当前 6 行余量不足）。
4. **MCP**：仍以批 0 合规地基为硬前置；本轮全为自研代码，未引入任何 GPL 代码，**合规状态没有因本轮变差**（现状仍是"已分发 GPL 的 ffmpeg / LGPL 的 libvips 但仓库零告知"，见 §13.3）。
