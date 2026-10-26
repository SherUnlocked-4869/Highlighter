# C / D / E 批次接手文档（2026-10-25）

> 本文是**给接手者的第一份文件**：先读这里，再读三份功能交接文档。
> 对应主文档：`docs/plans/2026-10-25-snow-apps-feature-development-plan.md`（§1.2 / §1.3 是本轮的官方记录）。
>
> **状态一句话**：C（成品预设）、D（放大镜 + R0.4 识别遮罩）、E（录屏裁剪与 MP4/GIF 导出）
> 三批代码已全部落地，本地门禁全绿；**工作区未提交**；**未做 CI / 安装包 / 实机验证**；
> **代码评审未完成**（Codex 子智能体进程异常退出，无产出，见 §7）。

---

## 1. 当前仓库状态（接手第一件事）

```
分支/基线：HEAD = c20f5ba（未提交的历史编辑改造已在 HEAD 里）
版本号    ：4.1.5（`npm run check:version` 通过）
改动      ：34 个文件修改（+3208 / -139），29 个新增文件，全部**未暂存、未提交**
```

### 1.1 本地门禁（2026-10-25 23:44 实测）

```bash
cd F:\workspace\Highlighter
env -u ELECTRON_RUN_AS_NODE npm test
#   干净跑：ℹ tests 1810   ℹ pass 1810   ℹ fail 0   ℹ duration_ms 22109
#   负载下偶发：ℹ pass 1809   ℹ fail 1（唯一失败是下面的已知 lease flake）

npm run check
#   Syntax check passed for 445 JavaScript files
#   architecture-check: ok (main.js 1323 lines, ceiling 1330, domains 10)
#   i18n: locale keys zh-CN/en-US/zh-TW = 1460 / symmetric diff ok / key shape ok
#         data-i18n 295 used, 0 missing / TOTAL 592 (--max 606，未抬高)
```

**`env -u ELECTRON_RUN_AS_NODE` 是必须的**（根 `AGENTS.md` 陷阱 1）：不清掉它，Electron 会以纯 Node
启动，所有真机探针假失败。本轮有 **6 个**真 Electron 探针，其中 3 个是本轮新增（见 §5）。

**已知 flake**：`test/clipboard-coordination.test.js` 的 lease 100 轮。全量负载下偶发 1 例失败
（实测出现过 `Lease round 2`、`Lease round 98`），单独复跑 4 次均 4/4 通过。按根 `AGENTS.md`
判定为环境 flake，**不是本轮 diff 引入**，不要去"修"它。

### 1.2 工作区里还有什么

- `.tmp/`、`.tmp-probe/`：探针留下的临时根，已被 `.gitignore` 的 `.tmp*/` 覆盖，git status 干净。
  提交前可删，也可以留着。
- 无其他未跟踪垃圾文件。

---

## 2. 本轮交付了什么（按功能）

### C：截图成品预设（schema v2 → 实际落到 v3）

用户可见：工具栏多一个成品样式按钮 → 打开面板 → 三个预设（原图 / 浅色卡片 / 深色卡片）+
可调节留白、背景色与不透明度、圆角、边框宽度与颜色、阴影（开关 / 模糊 / 偏移 / 颜色 / 不透明度）。

关键设计：
- **预览与导出共用同一个合成函数**（`capture/output-compositor.js` 的 `composeOutputCanvas`）。
  plan 明令禁止把 CSS 阴影当导出依据 —— 所以面板里那点 CSS 只负责面板 chrome 与棋盘格底。
- **原图模式几何与旧版逐像素相同**：`enabled === false` 时宽高 = crop、offset 恒 0，
  其它参数**完全不参与**。这是 v1 提交校验继续成立的前提。
- **只有一个几何入口** `planOutputComposite` / `resolveOutputGeometry`（`shared/capture-output-style.js`），
  渲染层预览、渲染层导出、主进程提交校验三处都调它，不可能给出不同答案。
- **参数进内容指纹**：改留白就是改内容，会 dirty、会写新 revision；仅切换预览缩放不会。
- 一次滑块拖动 = **一个**撤销步骤；"恢复原图"走普通编辑路径，所以**可撤销**。
- **不累计叠加外框**：结果图只从"底图 + 标注"重建，全程不读上一版 result PNG。

### D：局部放大镜（schema v3）+ R0.4 识别隐私遮罩

用户可见：工具条多一个放大镜工具 → 在图上框一个源区 → 自动在右下角放镜头（可拖动、可换倍率
2×/3×/4×、可调边框宽度、可开关引线）。源区与镜头可**分别**拖动，一次手势一次撤销，每文档最多 8 个。

**R0.4 是独立 P0 修复，必须先理解它**：在此之前，**所有识别入口（OCR / 翻译 / 表格 / QR / 转文档）
都在直接把未遮罩的像素送给模型** —— 用户打了马赛克的内容会被读到。现在：
- `shared/occlusion-mask.js` 计算"哪些像素必须被遮住"（源像素空间、纯函数）；
- `capture/capture.js` 的 `applyRecognitionOcclusion` 在**任何缩放之前**把它们涂成不透明黑；
- 三个开关**互相独立、全部默认 false**：`includeAnnotations`（要不要普通标注）、
  `compose`（要不要成品外框）、`mask`（要不要遮挡）。
  识别 = `false / false / true`；用户出口 = `true / true / false`；
- **fail-closed**：遮罩计划算不出来时把整个输入涂黑，绝不回退成"未遮罩图"。

放大镜的隐私核心：镜头**只**从"底图 + blur 遮罩"合成的采样底图取样，不读屏幕像素、不读合成画布。
移动镜头位置**不**重新采样；改源区 / 改 blur / 改 crop / 换底图必须失效。缓存 32 MiB **按字节**
计费 + LRU，关闭编辑器释放。

### E：录屏头尾裁剪与 MP4/GIF 导出

用户可见：停止录制后进入预览 → 头尾两个裁剪点（可输入时间、可拖动）→ 选 MP4 或 GIF
（GIF 显示尺寸/帧率/预计帧数）→ 导出 → 显示结果条（打开 / 复制地址 / 打开文件夹）。
**导出成功后源文件保留**，可以改范围再导出。

关键设计：
- **探测不用 ffprobe**（应用只捆绑 `ffmpeg-static`）：同一份 ffmpeg 三段式 —— 头部（不解码）→
  无 duration 时只解复用（`-c copy -f null -`）→ 仍不可靠就**明确失败**，绝不返回猜测时长。
  实测 2s / 30s / 120s 样本都是 ~42ms，**无 O(时长) 代价**。
- **会话与导出任务分离**：会话 `capturing → finalizing → ready → closing → closed`；
  任务 `queued → running → publishing → succeeded`，取消 `cancelling → cancelled`。
  导出服务只持有源的**引用租约**（`acquireSource` / `releaseSource`），绝不删源 ——
  旧 `transcode → cleanupSession` 正是那个 bug。
- **发布协议**：写目标同目录的唯一临时文件 → 用探测器校验（可解码 / 容器编解码 / 尺寸 / 时长 / 音轨）
  → 再次比对目标快照 → 原子 rename。失败只删本任务临时文件，**不删用户原有目标**。
- **取消仲裁**：发布点之前取消 → 不替换目标；已发布 → 晚到的取消**不删除成品、不改报 cancelled**。
- 裁剪用 `-ss` + `trim` 滤镜**解码裁剪**，不用 `-c copy` 冒充精确裁剪。

---

## 3. 新增/改动的文件地图（按"你想改什么"索引）

### 想改成品样式（C）
| 文件 | 作用 |
|---|---|
| `shared/capture-output-style.js` | **唯一**的默认值、校验、预设、几何。改预设数值/上限改这里 |
| `capture/output-compositor.js` | 实际画像素（圆角裁切 → 背景板 → 阴影 → 边框 → 留白） |
| `capture/output-style-panel.js` | 面板 UI 控制器（预设切换、滑块手势合并、撤销帧） |
| `capture/capture.js` | 只接线：`currentOutputStyle` / `composeFinishedOutput` / 导出路径 |
| `main/services/settings-defaults.js` | `screenshot.outputStylePreset`（**只存预设 id**） |

### 想改放大镜或识别遮罩（D / R0.4）
| 文件 | 作用 |
|---|---|
| `shared/magnifier-geometry.js` | 放大镜对象模型、镜头尺寸推导、裁剪相交、缓存键 |
| `shared/occlusion-mask.js` | **隐私边界**：谁必须被遮、遮多大 |
| `capture/magnifier-sampler.js` | 采样底图合成、缓存、镜头采样 |
| `capture/annotation-geometry.js` | magnifier 的 bounds / hit / translate / resize 全部委托给上面 |
| `shared/capture-document.js` | schema v3、`magnifier` 校验、嵌套视口投影、`resolveOcclusionPlan` |
| `capture/capture.js` | `applyRecognitionOcclusion`（识别）、`ensureSampleBase`（镜头）、三开关 |

### 想改录屏导出（E）
| 文件 | 作用 |
|---|---|
| `main/services/recording-probe.js` | 媒体探测（三段式） |
| `main/services/recording-export-service.js` | 任务队列、argv、进度、临时文件、校验、原子发布、取消仲裁 |
| `shared/recording-export-options.js` | 主/渲染共用的状态表、范围与 GIF 预算、argv 构建 |
| `main/services/recording-service.js` | 会话状态机 + 源引用计数（**导出不再删源**） |
| `record/trim-controller.js` / `record/trim-view.js` | 裁剪 UI 的状态机 / DOM 层 |
| `main/ipc/recording-export-ipc.js` | `record:export` / `-status` / `-cancel-export` |

### 文档层
| 文件 | 作用 |
|---|---|
| `shared/capture-document.js` | 文档契约：schema v1→v2→v3 迁移链、内容指纹、嵌套投影 |

---

## 4. 必须知道的硬约束（改之前先看）

1. **`main.js` ≤ 1330 行**（`scripts/check-architecture.js` 硬门禁，不能抬高上限）。
   当前 1323 行 —— **只剩 7 行**。任何新装配都要进 `main/services/*-bootstrap.js`。
2. **i18n `--max 606`**（`scripts/check-i18n.js`）。当前 TOTAL 592，其中 `capture` 域 222、`main` 域 285。
   **`capture/**` 与 `record/**` 下的注释必须是英文** —— 中文字符会被计入 CJK 预算。
   `shared/**`、`main/**`、`test/**` 不在扫描范围，可以写中文。
3. **`capture/capture.html` 的 `<script>` 顺序是硬约束**：
   ```
   ../shared/capture-output-style.js
   ../shared/magnifier-geometry.js
   ../shared/occlusion-mask.js
   ../shared/capture-document.js      ← 加载期就消费上面三个，缺一个整个窗口起不来
   output-compositor.js
   magnifier-sampler.js
   ../shared/cursor-geometry.js
   export-result-bar.js
   output-style-panel.js
   capture.js
   ```
   `test/capture-script-loading.test.js` 逐条钉住。**少了 script 不是功能降级，是整个截图窗口抛异常**。
4. **IPC 每个新通道要同时改 4 处**：`main/services/ipc-security.js`（policy）、`main/ipc/*` 注册、
   对应 preload、`test/ipc-module-contracts.test.js` + `test/ipc-security.test.js`。
   `secureIpcMain.assertComplete()` 会强制通道完整性。
5. **`shared/editor-layout.js` 的 `ROW_MIN_CONTENT = 1064`** 有一个双向约束：
   `measured(1044) ≤ ROW_MIN_CONTENT ≤ TOOLBAR_SPACE - STRIP_CHROME (1074)`。
   低于 1044 主行折行把工具栏推回图像内；高于 1074 每个窄窗口白预留 34px。
   **加第 13 个工具按钮必须同时抬 `TOOLBAR_SPACE`**，那是尺寸决策不是静默改动。
6. **schema v3**：`magnifier` 是第一个嵌套几何标注，`annotationsToViewport` / `annotationsFromViewport`
   有独立分支。不要用扁平 `x/y/x2/y2` 的通用逻辑去处理它。

---

## 5. 测试地图（按"我想验证什么"索引）

### 真机探针（真实 Electron，最贵也最可信）
| 文件 | 覆盖 | 耗时 |
|---|---|---|
| `test/occlusion-recognition-runtime.test.js` | R0.4：**逐像素**证明识别帧被遮罩、且遮罩不外溢、普通标注不进识别输入 | ~2.1s |
| `test/magnifier-runtime.test.js` | D2：镜头内容正确、**blur 区内的镜头拿到的是遮罩而非原文**、缓存失效、跨缩放 | ~0.9s |
| `test/magnifier-reedit-runtime.test.js` | D4：载入 → 选中 → 改倍率 → Ctrl+S 提交 → 再载入，全链路 | ~2.2s |
| `test/capture-document-editor-runtime.test.js`（既有） | 文档编辑器恢复 / 提交 / dirty 协商 | ~30s |
| `test/capture-renderer-runtime.test.js`（既有） | 截图渲染层基础 | — |
| `test/diagnostics-runtime.test.js`（既有） | 诊断窗口 | — |

### 纯函数契约
| 文件 | 例数 | 覆盖 |
|---|---|---|
| `test/capture-output-style.test.js` | 27 | 三预设、原图等价、几何统一、预算、合成调用顺序、校验/归一化、指纹、迁移链 |
| `test/magnifier-geometry.test.js` | 36 | 倍率/源区拒绝、镜头尺寸推导、裁剪相交、缓存键、**视口往返精度**、对象预算 |
| `test/magnifier-sampler.test.js` | 15 | 遮罩顺序、缓存失效规则、字节预算、LRU、释放 |
| `test/occlusion-recognition-wiring.test.js` | 11 | 三开关独立、显示态不解除保护、遮罩不污染底图 |
| `test/capture-output-style-ui.test.js` | 29 | 面板状态机、滑块一步撤销、重开不叠加外框、设置字段 |
| `test/capture-magnifier-ui.test.js` | 20 | 工具手势、三分支拖动、撤销帧、上限、回显 |
| `test/recording-export.test.js` | 41 | 探测解析 + 真实媒体、范围/GIF/argv、会话生命周期、**真实编码导出**、取消仲裁、发布故障注入 |
| `test/recording-trim-ui.test.js` | 12 | 裁剪面板契约、错误码三语覆盖 |
| `test/capture-script-loading.test.js` | 5 | `<script>` 顺序与 UMD 全局名对齐 |

---

## 6. 实现期发现并修复的真实缺陷（值得读，都是"手测很难发现"的类型）

这三条是按严重度排的，**都只有真机探针或仔细的往返推理才能发现**：

1. **【隐私，严重】普通截图窗口的镜头采样遮罩坐标空间错误。**
   `ensureSampleBase()` 把**视口 CSS** 的 annotations 直接喂给源像素空间的 `buildOccluders()`。
   结果遮罩画在错误位置 —— **镜头会把马赛克盖住的内容原样放大出来**，正是 §7.2 要防的那件事。
   修复：新增 `annotationsForSampling()` / `magnifierInSourceSpace()`，按 `getSourcePixelRect` 投影。
   **纯静态测试永远发现不了**，是 `magnifier-runtime` 的逐像素探针抓到的。

2. **【精度】`stroke.widthPx` 的视口往返丢值。**
   `normalizeMagnifier` 曾把宽度四舍五入成整数**并**夹到 `MIN_STROKE_PX`。两个独立来源：
   `3 × 0.5 = 1.5 → 2`，除回去得 4；`1px` 描边在 zoom 0.5 时是 0.5 **视口**像素，被抬到 1 后除回去变 2。
   每次重开/缩放累加。
   修复：量化到 1/1000（防浮点噪声让指纹抖动）+ **不做范围夹取**（范围归 `validateMagnifier`，因为
   normalize 同时服务文档空间与视口空间）。验证：9 个 zoom × 7 个宽度 = 63 组合零漂移。

3. **【可用性】选中放大镜不显示属性面板**，用户无法改倍率。
   `setSelectedAnnotation()` 不调 `syncMagnifierPanel()`。

另有三条中低severity：
- `annotationWasMoved` 对嵌套对象永远判"没动" → 镜头拖动**永不压撤销帧**（静默丢撤销步骤）。
- `clampRound(value, min, max)` 用 `minimum` 当缺失值回落 → 阴影偏移"未提供"变 **-256px** 硬偏移。
- `<label data-i18n>` 包住子元素会被 `applyTranslations()` 的 `textContent` 抹掉（checkbox 直接消失）。

---

## 7. 未完成 / 未验证清单（**接手后优先补这些**）

### 7.1 代码评审 —— **未完成**
Codex 子智能体被派去做对抗式评审，结果**进程异常退出（exit code 3221225786），无任何产出**。
所以本轮**没有第三方代码评审结论**。建议接手后：
1. 优先人工审 §6 里那 3 条已修缺陷的**修复本身**是否引入新问题；
2. 重点审隐私路径：`applyRecognitionOcclusion` 的 fail-closed 分支、`annotationsForSampling` /
   `magnifierInSourceSpace` 的坐标投影、`ensureSampleBase` 的缓存键；
3. 审 E 的取消仲裁与发布协议（并发路径最难靠单测覆盖）；
4. 审 schema 迁移链是否对旧数据真的无损。

### 7.2 三账分离（按 plan §10.3，不得合并记账）
| 项 | 状态 |
|---|---|
| 本地门禁 | ✅ 1810/1810 + `npm run check` exit 0 |
| CI 通过 | ⬜ **未验证**（未推送、未触发） |
| 安装包通过 | ⬜ **C/D/E 代码不在任何已构建产物里**（`dist/` 里是 4.1.5，只含 A/B）；需重新构建 |
| 实机通过 | ⬜ **未验证** |

### 7.3 实机矩阵（全部未跑）
副屏 / 混合 DPI（100% / 150% / 200%）/ 屏幕拔插与重排 / 硬件与软件光栅差异 /
真实录制端到端 / >10min 长录制 / 磁盘故障 / 系统退出时仍有导出任务。

### 7.4 性能样本（**完全没有采集**）
- C：4K 图 + 深色卡片（阴影 bleed 48px）的预览重绘与导出耗时。
- D：4K 图 + 8 个镜头的采样缓存峰值内存、预览重绘耗时。
- E：Electron 全进程 + ffmpeg 子进程峰值内存/CPU、临时磁盘峰值、结束后回落。
- **全部无 p50/p95**。plan §10.2 要求固定机器/屏幕/样本数，本批未做。

### 7.5 功能层的已知缺口
- **真实识别模型端到端未验证**：只验证了"送给模型的像素"（这是 plan §8 指定的口径），
  没跑真实 OCR/翻译/表格/QR 服务。
- **D3 镜头的视觉质量未验证**：探针用合成色块，只证明"采对了区域"与"遮罩有效"，
  没验证真实文字/图片在 3×/4× 下的可读性。
- **"重新裁剪"手势不做**（有意）：现有编辑器没有改 crop 的入口。`clipMagnifiersToCrop` 只在
  **载入时**做一次防御，被移除对象落在**载入帧**、不可撤销（撤销不能把越界对象变回来）。
  若要新增，必须先定义它如何影响 crop、标注坐标系与 revision 语义。
- **旧 `record:save-mp4` 仍保留**（已安全：不删源、不关窗、不清 `_recordSessionId`，
  `record/record.js` 里 Save MP4 与新的 Export 两个按钮并存）。删除旧入口是 plan §8.3 的后续步骤。
- **AAC 编码延迟与 VFR 容差**来自推理（1 源帧 + AAC priming），未实测；
  当前用 `max(250ms, 5%)`（GIF +200ms）。

---

## 8. 下一步建议（按优先级）

1. **人工代码评审**（§7.1）。特别是隐私路径与 E 的并发路径。
2. **重跑覆盖率门禁**：`npm run test:coverage:loaded`（A/B 轮 92.03%，C/D/E 后**未重跑**；
   本轮实测单次 91.97% ≥ 85%，但被 lease flake 打断过，建议干净跑一次）。
3. **真机矩阵**（§7.3）—— 这是"看起来能跑"与"真的能用"的区别所在。
4. **性能采样**（§7.4），补 p50/p95。
5. **重新出安装包**并验证 C/D/E 代码确实在产物里（解包 `app.asar` 搜
   `composeOutputCanvas` / `MAX_MAGNIFIERS` / `record:export`）。
6. **提交边界**（plan §11.1）：C / D / E 应分成**独立提交**，不要把 A–E 揉成一次。
   注意工作区里 `shared/capture-document.js` 同时承载 C 的 v2 与 D 的 v3、
   `capture/capture.js` 同时承载 C 与 D —— 这两处是 C/D 的**共享文件**，
   若要拆提交，需按 §11.1 的"涉及既有共享文件时先协调改动归属"处理，
   或接受 C+D 合并为一个提交（E 可以完全独立）。

---

## 9. 相关文档索引

| 文档 | 内容 |
|---|---|
| `docs/plans/2026-10-25-snow-apps-feature-development-plan.md` | 主方案。§1.2 / §1.3 是本轮官方记录，§6–§8 有"实施结果"块 |
| `docs/plans/2026-10-25-feature-C-handoff.md` | C 的逐项交接（含契约形状、几何规则、缺陷记录） |
| `docs/plans/2026-10-25-feature-D-handoff.md` | D + R0.4 的逐项交接（含隐私边界、缓存规则、像素证据） |
| `docs/plans/2026-10-25-feature-E-handoff.md` | E 的逐项交接（含真实媒体样本、耗时、取消实测） |
| `docs/plans/2026-10-25-feature-A-handoff.md` / `-B-handoff.md` | 上一批（A/B）的交接 |
| `docs/plans/2026-10-25-history-reedit-batch0-contracts.md` | 文档/提交/坐标的冻结契约。§8 是识别遮罩规则 |
| `docs/plans/2026-10-25-feature-r0-baseline.md` | R0 基线（含 R0.4 当时的"未落地"结论） |
| `AGENTS.md`（仓库根） | **跑门禁前必读**：四个环境陷阱 + 两个已知 flake 的判定流程 |
