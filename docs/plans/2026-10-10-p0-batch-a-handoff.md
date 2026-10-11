# 交接文档：P0 批次 A 收尾 → 新会话继续（2026-10-10）

> 用途：上一会话上下文已过大，本文件是新会话的**唯一入口**。请先读本文件，再按其中的指针读方案文档的相关小节，不要从头重读 900 行方案。

---

## 0. 30 秒速览

| 项 | 状态 |
| --- | --- |
| 方案进度 | **批次 A：Wave 0 ✅ · Wave 1 ✅ · Wave 2 ✅ · Wave 3（真机）→ 全部挂账。批次 B：Wave 4 ✅ · Wave 5 ✅ · Wave 6 ✅ · Wave 7 ✅ · Wave 7.5 ✅ · Wave 8（收口门禁）✅ → 代码完成** |
| 代码 | 批次 A + 序号接续修复 + 批次 B 四流（录屏音轨 / 光标采集 / 标注二次编辑 / config 收口）；**HEAD = `453b027`** |
| 门禁 | `npm test` **858/858** · `main.js` **1286/1300**（余量 14）· 覆盖率 **92.62%**（11220/12113）· critical 93.22/92.99/92.42 · `audit` 26/0 · **e2e 5/5** · `check` 257 文件 |
| 真机验收 | 已验：A1/A2/A3、B1/B2、C1、C4 前半、C8（静态）。**C6 缺陷已修（待复验）**；**其余全部挂账**（2026-10-11 用户决定：先开发、开发完成后统一测试）；批次 B 的 T6/T8 同样挂账 |
| dev 实例 | **已停止**（测试挂账）。需要时再跑 `.\node_modules\.bin\electron.cmd .`；✕ 是"收进托盘"不是退出（`main.js:1227` 的 `second-instance` 会调出主窗口） |
| 下一步 | ① **统一测试阶段**（用户配合）：批次 A 挂账项 + C6 复验 + 批次 B 的音轨/光标/标注编辑（清单见 `2026-10-11-consolidated-verification-checklist.md`）；② 之后进 **Wave 8.5（S14/D2 配置页拆分）→ Wave 9（批次 C i18n）** |

---

## 1. 仓库与提交状态

工作区在本文件提交后应为**干净**（仅 `.zcodeignore` 为有意保留的 untracked）。

| 提交 | 内容 |
| --- | --- |
| `07153a6` | 两份规划文档（上一轮） |
| `5c6a0ef` | **Wave 0**：15 键设置契约 + IPC「通道与注册点同 PR」规则 + `main.js` 1298→1267 |
| `83aabeb` | **Wave 1**：`pdf-export.js`/`print.html`、贴图穿透接线、命名模板 + 两个快捷键 handler + 托盘兜底；Lead 落两条通道登记与 3 处 `main.js` 接线 |
| `724be28` · `3fb3d0d` · `455a1db` · `64efc29` | 评审跟进：`makeCaptureName` 正常双参声明；保存流程迁入 `image-file-save.js`（`main.js` 1294→**1278**）；命名模板覆盖历史与长截图；`lastSaveDirectory` **读闭环** + 两处"打开目录"对齐 |
| `b1c1cc2` | **Wave 2**：config 设置项（3 个快捷键行 + `sourceLabels` + 4 个冻结键行）+ 图标计数同步 + `region` 标签 |
| `1139a5a` | **Wave 2**：capture 接线（PDF 按钮+图标、`saveMode`、快门音、`Ctrl+A`、序号、PDF 命名跟随模板） |
| `f8b2109` | 收口门禁抓到的**跨流集成修复**（`test/pdf-export.test.js` 补 `getSettings`） |
| `82fe6ce` | 方案文档 §18 回填 |
| `7727f0b` | **真机验收发现的缺陷修复**：打印图片按 DPI 换算尺寸排版（高 DPI 屏 PDF 分页） |
| `a46bbc0` | **评审改进**：打印页图片居中（留白对称） |
| 本文件 + 验收记录 | 交接文档 + `2026-10-10-p0-batch-a-verification.md` |
| 第二轮真机验收产出 | **序号跨截图保留精确接续修复**（验收记录 §3.6）：`capture/capture.js` · `main/domains/capture/index.js` · `preload-capture.js` + 2 个测试文件。**不新增 IPC 通道、不改 `main.js`、不碰冻结文件**（复用既有通道的 `meta` 字段） |
| `eb90eb7` | **Wave 4·S2**：录屏音轨（`record/audio-mixer.js` 新 + `record.js` getDisplayMedia 迁移 + ffmpeg AAC 参数 + `recording-service` 透传 + 热切换） |
| `882b1f0` | **Wave 5 接线（S2 部分）**：`setDisplayMediaRequestHandler` + `_recordInit` 4 个音频键 + `saveMp4` 透传 `{audio}` + `record.html` 引入 mixer |
| `0ceaa3b` | **Wave 4·S5**：光标原生采集（C# `cursor` 命令 + `cursor-provider.js` + `shared/cursor-geometry.js` + 29 用例） |
| `2ae1042` | **Wave 5 接线（S5 部分）**：`main.js` 注入 cursor provider + `package.json` c8 include 追加 `shared/cursor-geometry.js` |
| `7991198` | **Wave 7.5·S10b**：`config/**` 收口（「系统声音」「麦克风」「截图带光标」三个开关 + 「仅包含画面」文案改写 + 两个耦合测试断言同步） |
| `ba35790` | **Wave 6·PR1**：标注选中 + 删除 + 深拷贝快照栈 + D4 先确认（`capture/annotation-geometry.js` 新 + capture 三件套 + 测试） |
| `6f1cca4` | **Wave 6·PR2**：标注拖动 + 边界 clamp + 方向键微调 + **Alt+拖动=移动选区**（Lead 决策） |
| `c8e245c` | **Wave 6·PR3**：8 手柄缩放（`resizeAnnotationToBox`：镜像不翻、最小 3px、pen 等比、text 仅字号、serial 仅半径） |
| `3f1dcd0` | **Wave 6·PR4**：层级 ↑↓ + 颜色/线宽作用于选中项（离散/连续样式分开压帧，undo 不串） |
| `453b027` | **Wave 7·S9b**：光标合成接线（域侧并行查询 + 120ms 预算 + `_captureInit.cursor`；渲染层预解码 + `resolveCursorPlacement` 贴图；识别路径不画） |

**`main.js` 现状**：1286 行 / 上限 1300（**余量 14**）。批次 A 期间零净增长；批次 B 的 Wave 5 接线净 +8（cursor provider 注入 + 释放）。**任何新接线前先看余量。**

> **覆盖率读数勘误（2026-10-10）**：旧值 **91.87%（10007/10892）在干净 HEAD 上复测不可复现**；用 `git stash` 退回 HEAD 实测 **10005/10892 = 91.85%**，与带修复的工作区**完全一致**（修复落在 `main/domains/**` 与 `capture/capture.js`，不在 `test:coverage:loaded` 的 `--include` 内）。门禁阈值 85% 不受影响。详见验收记录 §2。

---

## 2. 三份必读文档（按顺序，只读相关小节）

| 文档 | 用途 | 建议读法 |
| --- | --- | --- |
| `docs/plans/2026-10-10-p0-gap-closure-plan.md`（执行手册，~1100 行） | §0.1 总账（唯一数字来源）、§1 约束、§2 冻结契约、§3.1.1 **工作流注册表（owner 唯一来源）**、§3.1.2 回滚纪律、§4–§10 各功能任务表、§11 收口、§13 决策、**§16/§17/§18/§19 已回填的实施结果** | 先读 §3.1.1 + §3.2 + 你要派发的那一节 |
| `docs/plans/2026-10-10-snow-apps-feature-gap-analysis.md`（~456 行） | §2 能力差依据、§3 优先级、§5 许可证与义务、§5.6 L1–L16 落地清单 | 只在碰 P1/许可证时读 |
| `docs/plans/2026-10-10-p0-batch-a-verification.md`（本轮新建） | **真机验收记录**：§3 逐项实测、§3.4 高 DPI 分页缺陷、§3.5 居中、§6 观察项、**§7 剩余待验清单** | 接手验收时先读 §7 |

---

## 3. 门禁怎么跑（含环境陷阱）

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 必做！
npm test                       # 766/766（114 个测试文件）
npm run check                  # 语法 250 文件 + main.js 1278/1300
npm run test:coverage:loaded   # 行覆盖 91.87%
npm run test:coverage:critical # 93.22 / 92.99 / 92.42
npm run audit:dependencies     # 26 已豁免 / 0 未豁免
npm run test:e2e               # 5/5
```

**环境陷阱（本机实测，务必记住）**：
1. **本 shell 预设 `ELECTRON_RUN_AS_NODE=1`** → 所有 spawn Electron 的测试（`test/diagnostics-runtime.test.js`、`test:runtime`、e2e、真实窗口探针）都会在探针 `app.setPath` 处崩（`TypeError: Cannot read properties of undefined (reading 'setPath')`）。**跑任何门禁前先清掉**。这是环境事实，不是代码回归。
2. **`read`/`grep` 工具在本机曾出现显示差异**：`main.js:89` 的 `require('./toolbar/toolbar-utils')` 被显示成 `require('../../toolbar/toolbar-utils')`（磁盘以 node/pwsh 为准）。**改动前用 node/pwsh 核对确切字符串**，`edit` 工具匹配的是磁盘。
3. **`edit` 的转义陷阱**：JS 源里写 `'C:\\pictures'`（两个反斜杠），在 `edit` 参数里要写**四个**反斜杠；尽量改用正斜杠路径或正则规避。
4. **子智能体通信是单向的**：subagent 能向 Lead 发消息（中途与最终报告），但 Lead **无法** `send_message` 回子智能体（它们不是 teammate，`list_agents` 里看不到）。→ **派发时必须把所有约束一次写进 prompt**，别指望中途纠偏。
5. 可见窗口按 `AGENTS.md` 放副屏（`\\.\DISPLAY2`，1152×2048 @ 3072,-136，**125% 缩放**）；主屏 2560×1440。

---

## 4. 真机验收：已验 / 剩余

### 已验（用户真机确认 + 我方量化）

- **A1** 工具栏出现 PDF 打印机图标（保存与复制之间）
- **A2** 点击 → 保存对话框 → `test-wide.pdf` = 1 页、A4 横向；**导出后截图窗保持打开**；截图时快门音响一次
- **A3** 高选区（1440×2520 @125%）导出 = **1 页**、A4 纵向（详见 §3.4/§3.5 的缺陷与修复）；居中留白复验用户确认通过
- **B1/B2** 贴图点击穿透：右键「点击穿透」开启 → 底层记事本收到点击；角标悬停退出；穿透态拖动/缩放被禁
- **C1** 设置页三行快捷键 + 4 个新控件默认值正确

### 剩余（**2026-10-11 全部转为挂账**：先开发，开发完成后统一测试）

> 用户指示：**"测试都先跳过，先进行后续开发，开发完成后统一进行测试处理。"** 因此下表不再逐项走真机，批次 A 收口**不阻塞** Wave 4。挂账项的取证准备见验收记录 §7.1。

| # | 步骤 | 期望 |
| --- | --- | --- |
| **B3** | 两个贴图都开穿透 → 托盘「取消全部穿透」 | 两个都退出（handler 返回退出数） |
| **B4** | **开游戏模式 → 托盘「取消全部穿透」** | 代码侧已核为绕开 `assertGameModeDisabled()` 的直连路径（验收记录 §7），**运行时仍未实测** → 风险见 §11 |
| **C2** | 设置页录入「快速保存」「另存为」热键 → 截图后分别触发 | 快速保存直接落盘无对话框；另存为弹对话框 |
| **C3** | 另存到桌面 → 再快速保存 | 落桌面（记忆目录）；设置页「打开截图目录」也开桌面 |
| **C4 后半** | 关掉「截图快门音」开关 → 截图 | 不响（前半已验：开着时响一次） |
| **C5** | `Ctrl+A` | 选中整屏（徽标 = 屏幕分辨率）；Enter/Ctrl+S 不受影响 |
| **C6 复验** | 开启「序号跨截图保留」→ 第 1 张落 1/2/3 → 第 2 张 | **从 4 接续**（首验为 3，已修，见验收记录 §3.6） |
| **C7** | 命名模板（如 `{date}_{time}-{app}`）→ 保存 | 文件名符合模板；**历史库仍认「本应用所有」**；非法字符被 sanitize；重名加 `-1` 不覆盖 |
| ~~**C8**~~ | ~~历史筛选下拉~~ | ✅ **静态核实**：`config/config.js:426-437` 的 `sourceLabels` 已把 `region`/`capture` 映射为「区域截图」 |
| **A4** | 贴图/识别窗口复用导出函数 | ✅ 本期无 UI 入口，以单测 + 隐藏窗口探针为准（已绿） |

**我方侧证手段**（统一测试时可用）：
- 读 `E:\document\highlighter\config\config.json` 验证设置落盘（**注意：里面可能含凭据字段，只读你要的键**）；同目录 `captureHistory` 现有 **164 条**用户真实历史，勿损坏。
- 解析导出的 PDF：页数/MediaBox 用 `.tmp/pdf-ctm.js`（逐 token 解释 q/Q/cm 变换栈，给出图片在页面上的 bbox —— 比肉眼看可靠）。
- 用户数据根：`E:\document\highlighter`；`saveDirectory = E:\pictures\highlighterQuickSave`；截图热键 = `Ctrl+1`。

---

## 5. 已定口径（**不要重新论证**）

### 决策（方案 §13 / §13.1）
**D1–D8 全部已确认闭环。**

### 本会话新增/修正的口径
1. **IPC 通道登记规则（W0-3 修法 ①，§2.2）**：`IPC_SURFACES` 只登记页面→主进程通道，且**每条通道与它的运行时注册点同一个 PR 落地**。W0-3 只冻结规则、不登记通道。主→渲染广播**一律不登记**（`pin:click-through-changed`、`i18n:language`）。新通道/新键走 **§2.1.1 契约变更流程**（Lead 串行落地）。
   - `test/ipc-security.test.js:96` 与 `:143` 是**派生断言**（扫 main.js/main\/ipc\/**/main\/domains\/** 与 11 个 preload），所以加通道不需要手改清单，但**注册点与策略必须同 PR**。
2. **W0-1 目标**：从"≥60 行 / ≤1240"下调为"**净 ≥20 行 / ≤1280**"（原目标按点名的三处抽取不可达）。实际落地净 −31。
3. **命名模板覆盖边界**：✅ 快速保存/另存为、**历史入库**、**长截图保存**、**PDF 默认名**；❌ 录屏（`screenshot.*` 是截图键，按路径拆模板属后续立项）。
   - 实现：`main.js` 的 `makeCaptureName` 是**透传**（`prefix, ext, nameSettings`），各调用点显式决定是否传 `{ template }`。
   - 所有权正则与生成器**同源**（`capture-naming.js:61-63`，可选有界标签段）。**注意该谓词被 `history-service.js` 的 `cleanup()` 用于 unlink**，标签段因此限长 ≤120 且不得以点开头。
4. **`lastSaveDirectory`（P0-7B）语义**：目录解析优先级 = `options.directory` → **记忆目录** → 配置的 `saveDirectory`；两个分支共用；仅当目录变化时才回写（比较走 `path.resolve` + Windows 折叠大小写）。两个"打开截图目录"动作（`main.js` 的 `openSaveDirectory`、`function-router.js` 的 `openImageSaveFolder`）共用 `resolveSaveDirectory` 单一来源。
   - 可见行为变化（**用户已明确同意**）：未配置固定目录的用户，经历一次另存为后快速保存不再弹对话框。
5. **PDF 纸张**：`printToPDF` 自定义 `pageSize` 单位是**英寸**（不是微米），且**下限 1 英寸**（低于则 `content area is empty`）；200 英寸上限为保守夹取。模块内部保留微米口径 + 夹取，只在 Chromium 边界换算。**图片必须按 DPI 换算后的 CSS 尺寸排版**（否则高 DPI 屏分页）。
6. **PDF 产品口径**：**A4 是唯一模式**（未暴露"原图尺寸"）；**导出后不关闭截图窗口**；页面内图片**居中**（留白对称）。
7. **`keepSerialAcrossCaptures` 已改为精确接续（2026-10-10 第二轮真机验收修正）**：真机首验发现"一张图落 3 个序号后，下一张从 3 重复开始"。根因是主进程只记"第几次截图"，渲染层的计数从不回报。现已改为：主进程记"下一个该用的号"，渲染层在**导出/编码完成后**通过既有通道的 `meta.serialNumber`（保存/贴图/识别/历史/导出 PDF）与 `capture:close` 载荷回报，主进程**只接受前进**。口径 = **落过就推进**（含落完后 Esc 取消），**没落过不消耗**。**不新增通道、不改 `main.js`、不碰冻结文件**。详见验收记录 §3.6。
8. **`{app}` 模板变量**统一展开为 `DEFAULT_APP_LABEL = 'Highlighter'`（不再用 `app.getName()`，避免出现包名 `highlighter-snowshot`）。

### 仍待用户拍板（阻塞 P1 / 合规）
- **F1-① 许可证字符串**：`GPL-3.0-only`（建议）还是 `-or-later` —— **任何 `snow_shot/` 代码移植之前必须先定案**。
- **F1-②** `sharp`/libvips 的 LGPL 专项（建议接受并落实 L15）。
- **F1-③** 历史 release 追溯合规（建议轻量盘点 + 只补最新版）。
- **L2 版权人署名**。
- **真机验证需用户配合**（副屏操作）。

---

## 6. 本会话值得记住的发现（含两次"门禁抓不到"的教训）

1. **跨流集成缺陷**：S9a 让 `exportPdf` 用 `getSettings()` 取名后，S4 在 Wave 1 写的 harness 没注入它 → **两流各自全绿、合并后炸**。→ 处置：修 harness（`getSettings` 是域的真实契约），不在生产代码加防御性回落。
2. **真机才暴露的缺陷**：PDF 分页（高 DPI 排版/缩放不一致）——**dpi=96 的探针永远抓不到**。→ 教训：涉及物理尺寸/DPI 的验收，探针必须带 `scaleFactor ≠ 1` 的用例。
3. **我自己犯过一次解析错误**：用正则解析 PDF 内容流时重复计了矩阵，得出"图片被裁切"的错误结论，写了逐 token 的 q/Q/cm 解释器才纠正。→ 复杂格式断言要用状态机，不要用正则。
4. `pin/geometry.js` 与 `test/pin-geometry.test.js` **并非新建**（`de1d3c7` 已存在），S3 是扩展；T5 的三个函数此前全仓不存在，且**当前无生产调用方**（旋转按 D5 延后）。
5. `pinned.clickThrough` 此前**无读取方**，现接为新贴图预显示前的初始态。
6. **观察项（未处理，非本批次引入）**：划词工具条在 125% 缩放下周期性因尺寸不匹配重建（请求 444×40 vs 实际 446×46/447×47，来自 `3ffc9d6` 的容差）；`.toolbar` 无 flex-wrap（新按钮再加宽 ~33px）。详见验收记录 §6。

---

## 7. 后续波次与 owner（**owner 唯一来源是方案 §3.1.1**）

| 波次 | 内容 | owner / 作用域要点 |
| --- | --- | --- |
| **Wave 3** | 批次 A 收口：真机验收剩余项**全部挂账**（2026-10-11 用户决定先开发）→ 回填 → v2.3.2 | Lead |
| **Wave 4** | S2 录屏音轨（`record/**` + `recording-service.js`）· S5 光标原生采集（`native/smart-select/**` + `cursor-provider.js` + `shared/cursor-geometry.js`） | ✅ **已完成（2026-10-11）**：`eb90eb7`（S2）/ `0ceaa3b`（S5）；两条流作用域互斥、各自定向测试绿 |
| **Wave 5** | Lead 接线：`setDisplayMediaRequestHandler` + 光标 provider 注入 | ✅ **已完成**：`882b1f0`（record 侧 4 处）/ `2ae1042`（main.js + c8 include）；`main.js` 1278→1286 |
| **Wave 6** | S6 标注二次编辑（`capture/**` 独占，PR1–PR4 串行） | ✅ **已完成（2026-10-11）**：`ba35790`（PR1）/ `6f1cca4`（PR2）/ `c8e245c`（PR3）/ `3f1dcd0`（PR4）；`capture/**` 已释放；方案 §20 已回填 |
| **Wave 7** | S9b capture 光标合成接线 | ✅ **已完成（2026-10-11）**：`453b027`；`capture/**` + `main/domains/capture/index.js`；方案 §21 已回填 |
| **Wave 7.5** | S10b 批次 B 的 `config/**` 收口（录屏音频/光标开关；含 P0-3-T6 文案"仅包含画面"必须改） | ✅ **已完成**：`7991198`；「仅包含画面」已改写并被测试锁死 |
| **Wave 8** | 批次 B 收口 + 真机（音轨/光标/标注编辑）→ v2.4.0 | ✅ **代码收口完成**：858/858 · 覆盖率 92.62% · e2e 5/5 · `main.js` 1286/1300（§21.2）；**真机项挂账**到统一测试阶段 |
| **Wave 8** | 批次 B 收口 + 真机（音轨/光标/标注编辑）→ v2.4.0 | Lead |
| **Wave 8.5** | **S14 / D2 配置页路由拆分**（批次 C 硬前置门 D7） | `config/**` 独占；3.75–6.5 人日；先建 `test/helpers/config-source.js` 再搬迁 |
| **Wave 9** | 批次 C：S1 i18n 框架+config · S11 capture 窗 · S12 其余渲染窗 · S13 主进程文案 | 四路并行 |
| **Wave 10** | 批次 C 收口 + 三语言真机 → v2.5.0 | Lead |

> 另：P1（Auto Filter / MCP）**以"L1–L3 + L9 + L10 已落地"为前置门**（分析文档 §5.6），且受 F1-① 阻塞。

---

## 8. 派发子智能体的既有做法（照抄即可）

1. **一个工作流 = 一个 `subagent`**；在**同一条消息**里并发派发多个（互不依赖），Lead 继续做自己的事。
2. Prompt 必须**自包含**并写全：项目路径与基线 HEAD、要读的方案小节、**独占写作用域（逐文件列出）**、明确禁止触碰的文件（`main.js`、`settings-defaults.js`、`ipc-security.js`、`package.json`、`docs/**`、其他流的作用域）、交付物五件套（代码 / 定向测试 / 门禁证据 / 接线说明 / 验收自证）、**只能跑定向测试不得跑全量**（规则 C8）、禁止任何 git 写操作、可见窗口放副屏、`ELECTRON_RUN_AS_NODE` 陷阱、read/grep 显示差异与 `edit` 转义陷阱。
3. 子智能体跑完会**主动发最终报告**（含偏差）。Lead 逐个复核：`git status` 对照声明作用域（越界即按 §3.1.2 第 3 条丢弃重派）、审关键 diff、再决定落地。
4. **Lead 独占**：`main.js` 接线、冻结文件（`ipc-security.js` / `settings-defaults.js`）的契约变更、`package.json`（c8 include）、文档回填、全量门禁、git 提交。
5. **每个波次收口必须重跑 §1.1 全部门禁**（不接受"上次跑过"）；本轮两次真实收益：`f8b2109`（跨流 harness）与真机发现的 `7727f0b`。

---

## 9. 本机环境与运行态（交接时快照）

| 项 | 值 |
| --- | --- |
| dev 实例 | **运行中**：主窗口 `Highlighter`（pid 2456），后台 job `pwsh-358`；日志 `.tmp/dev-instance.log` |
| 调出主窗口 | 再跑一次 `.\node_modules\.bin\electron.cmd .`（`second-instance` → `createMainWindow('home')`） |
| 停止实例 | `npm run stop:app`（会结束所有 Highlighter/electron） |
| **不要用** `npm start` | 它的 `prestart` 会重建被跟踪的 `native/everything-search/bin/HighlighterEverything.exe`，把工作区弄脏 |
| 副屏测试目标 | 已开：`F:\workspace\Highlighter\.tmp\click-through-test.txt`（记事本，副屏 `x 3160, y -100, 980×820`）；**用户自己的 `opencodego.txt` 窗口勿动** |
| 用户数据根 | `E:\document\highlighter`（`config/config.json`，`captureHistory` 160 条；`saveDirectory = E:\pictures\highlighterQuickSave`；截图热键 `Ctrl+1`） |
| 证据目录 | `.tmp/`（gitignored）：`pdf-export-probe/`（PDF 与 `test-result.json`）、`capture-renderer-probe/`、`tall-probe.js`、`pdf-ctm.js`、`print-icon-preview.png`、各门禁输出 `*.txt`、`dev-instance.log` |
| 环境 | Windows / PowerShell；主屏 2560×1440，副屏 DISPLAY2 1152×2048 @3072,-136 **125%** |

---

## 10. 新会话建议的第一批动作

1. `git log --oneline -12` + `git status` 确认干净、`HEAD = a46bbc0`（或本文件所在提交）。
2. 读本文件 §4 的剩余清单 + 验收记录 `2026-10-10-p0-batch-a-verification.md` §7。
3. 与用户约时间做完剩余 9 项真机验收（**B4 游戏模式兜底优先级最高**）。
4. 验完后按 §11 收口：全量门禁 + 真机记录回填 + 版本号到 v2.3.2（版本 bump 属 Lead，涉及 `package.json`，按需与用户确认）。
5. 再进 **Wave 4（批次 B 两流并行）**：按 §3.1.1 的 S2/S5 作用域派发（照 §8 的模板写 prompt）。
6. 许可证三问（F1-①/②/③）与 L2 署名仍在等用户拍板 —— 只在要碰 P1 或合规文件时再提。

---

## 11. 交接时的已知风险

| 风险 | 说明 |
| --- | --- |
| 真机验收未完成 | **B4（游戏模式托盘兜底）已被用户明确跳过** —— 若该路径在运行时失效，用户会遇到"穿透后无法退出"的陷阱（代码侧已核为绕开游戏模式断言的直连路径，但**未经运行验证**）；B3/C2/C3/C4 后半/C5/C7 仍待验 |
| `main.js` 余量 22 行 | Wave 5/9 的接线预计 10–15 行，够用但需盯住；不够时按同一套路再腾挪 |
| 观察项 | 划词工具条周期性重建（125%）与工具栏无 flex-wrap —— 非本批次引入，未处理 |
| 新会话无本会话记忆 | 所有口径都在本文件与方案 §16–§18；**不要凭直觉改口径** |
| dev 实例仍在跑 | 会占用单实例锁与用户数据根；测试用 E2E/探针实例走独立 userData，互不干扰（但 `npm run stop:app` 会一锅端） |
| 覆盖率读数曾有偏差 | 旧值 91.87% 已在干净 HEAD 复测证伪（实为 91.85%）；**引用门禁读数前先看验收记录 §2 的勘误** |
