# C / D / E 批次接手文档（2026-10-26 重写）

> **这是给接手者的第一份文件。** 旧的 2026-10-25 版本已被本轮重写：它在一天内膨胀到 713 行、
> 章节编号混乱（1–9 之后突然出现 13.2–13.7），并且**多处结论已被实测推翻**。
> 本文只保留**当前仍然成立**的事实。历史演进见 §9。
>
> 主文档：`docs/plans/2026-10-25-snow-apps-feature-development-plan.md`（§1.2 / §1.3）
> 三份评审：`docs/reviews/2026-10-26-cde-{privacy,export,lead}-review.md`
> 性能样本：`docs/plans/2026-10-26-cde-performance-samples.md`

---

## 0. 一句话状态

C/D/E 三批功能**已提交并推送**（`46bada2` / `608b808` / `ee08225`），CI 绿。
本轮（2026-10-26）做了**对抗式代码评审 + 10 个缺陷修复 + 1 个实机回归修复 + 4 轮安装包重建**。
**当前工作区有 30 项未提交改动**（24 修改 + 6 新增：13 个源码文件 + 10 个测试文件 + 版本号 2 项
+ 本交接文档 + 4 份新文档 + 2 个性能探针），对应已构建的 **4.1.6 安装包**（16:50 构建）。

**本地门禁全绿**：`npm test` 1829/1829、`npm run check` exit 0。
**实机验证未完成**：最后一次修复（§2.1 的 FIX-A / FIX-B）**还没有经过用户实机确认**——这是接手后第一件事。

---

## 1. 仓库与产物当前状态（接手第一件事）

```
分支/基线 : master，HEAD = ee08225（CI run 40251315269 成功，tests 1812 / fail 0 / skipped 6）
版本号    : 4.1.6（package.json + package-lock.json，npm run check:version 通过）
未提交    : 24 modified + 6 untracked = 30 项（见 §8 文件清单）
diff 规模 : 24 files changed, +1475 / -298
产物      : dist/Highlighter-Setup-4.1.6.exe   149,941,611 B（16:50）
            dist/Highlighter-4.1.6-portable.exe 149,654,164 B
            latest.yml / SHA256SUMS.txt 均已与产物交叉核对
```

### 1.1 门禁（2026-10-26 16:5x 实测）

```bash
# 必需：env -u ELECTRON_RUN_AS_NODE（根 AGENTS.md 陷阱 1）
env -u ELECTRON_RUN_AS_NODE \
  TMP="D:/workspace/Highlighter/.tmp-t" TEMP="D:/workspace/Highlighter/.tmp-t" \
  HIGHLIGHTER_E2E_DATA_ROOT_BASE="D:/workspace/Highlighter/.tmp-t" \
  NODE_OPTIONS="--require D:/workspace/.highlighter-spawn-hook.js" \
  npm test
#   → ℹ tests 1829   ℹ pass 1829   ℹ fail 0

npm run check
#   → Syntax check passed for 447 JavaScript files
#     architecture-check: ok (main.js 1329 lines, ceiling 1330, domains 10)   ← 只剩 1 行余量
#     i18n locale keys 三语 1463 / symmetric diff ok / TOTAL 592 (--max 606)
```

`NODE_OPTIONS` 里的 spawn hook 是临时文件（**仓库外**，不提交），作用见根 `AGENTS.md` 陷阱 2。

### 1.2 已知的**假失败**（不要去"修"）

| 现象 | 判定 |
|---|---|
| `test/clipboard-coordination.test.js` 的 lease 100 轮偶发失败 | 已知环境 flake，单跑 4/4 通过。**不是 diff 引入** |
| `test/usage-query.test.js` 两个 p95 预算用例在**全量并发**时超时 | 本机有多个高 CPU 进程（msedgewebview2 / DeepSeek-Harness 自身）抢占。**单独跑 20/20 通过**。不是回归 |
| `test/capture-first-paint.test.js`、`clipboard-grid-runtime` 在全量时偶发超时 | 同上，负载型 flake，单跑通过 |

---

## 2. 本轮交付的 10 个缺陷修复（按"用户能否感知"排序）

> 全部已修复并配回归测试。**每条都验证过"回退修复 → 测试失败"**，避免假测试。

### 2.1 用户实机报的 4 个（最优先，别处文档没有）

| ID | 严重度 | 现象 | 真实根因 | 修复位置 |
|---|---|---|---|---|
| **FIX-A** | **严重** | 录制后**只能保存 MP4，导出按钮永远不可用**，红字"无法读取录制文件信息" | `main.js` 的 `getRecordingService()` 构造 `RecordingService` 时**从来没传 `probe`** → 每次 `probeSession()` 返回 `probe-unavailable` | `main.js` + `feature-services-bootstrap.js` |
| **FIX-B** | 高 | **录制时点颜色后，无法再选画笔/矩形/椭圆/箭头** | `record.css` 的 `.annotation-palette` 用 `left:50%; translate(-50%,-50%)`，而定位锚点只有 30×30px。350px 宽的浮层居中 → 左右各溢出 160px，**压在旁边所有工具按钮上**，定位元素赢命中测试 | `record/record.css` |
| **FIX-C** | 高 | 截图蒙层**只覆盖左上角**，不铺满整屏 | `resizeCanvas()` 给 `canvas.width` 赋值会**重置 2D transform**；`46bada2` 把 `renderOverlay()` 的 `setTransform` 折进了 `!image` 早退分支 → 正常截图路径按 1:1 物理像素绘制，150% 缩放下只盖 1/1.5（≈44.4% 面积） | `capture/capture.js` |
| **FIX-D** | 中 | 保存 MP4 后**没有成功提示**、窗口不关 | 成功后只把进度行留在"正在生成 MP4 · 100%"，与"还在跑"视觉上无区别。（**不自动关窗是对的**：plan §8.3 要求源录制保留以便再导出） | `record/record.js` + 三语键 |

**FIX-A 的铁证**（同一份 39s 真实规格文件 vp9+opus / 1494×934 / `-live` 无索引）：

```
WITHOUT probe → {"ok":false,"code":"probe-unavailable"}     ← 生产代码一直是这个
WITH probe    → OK durationMs=39001 source=demux
```

**为什么 FIX-A 能躲过 1825 个测试**：`recording-service.test.js` 的 11 个用例**全部**用
`new RecordingService({ tempRoot, ffmpegPath })`——**没人传 probe，也从没人调用 `probeSession`**。
装配点与 probe 路径是双重空白。

### 2.2 评审发现的 7 个（隐私 4 + 导出 3，另修 E-07/E-10/E-13）

隐私（`docs/reviews/2026-10-26-cde-privacy-review.md`）：

| ID | 严重度 | 缺陷 |
|---|---|---|
| **F1** | critical | 文档编辑器的**识别遮罩画在整张底图上，却减了 crop 原点** → crop=(100,80) 时遮罩偏移 (−100,−80)，用户马赛克只有 **11.2% 被遮，88.8% 明文进模型** |
| **F2** | critical | `magnifierInSourceSpace` 在文档编辑器里 `return magnifier`，但活动数组其实是**视口 CSS** → 镜头采样偏移 **541 px**，实测镜头画布全黑 |
| **F3** | high | `clipRestoredMagnifiers` 用源像素 crop 判视口对象 → 合法镜头**打开时被裁小或删除**，且不进撤销栈 |
| **F4** | high | 镜头遮罩宽度"先缩放后量化"，比实际画的马赛克窄（preset 8 @ 3× **每侧窄 60 源像素**） |

导出（`docs/reviews/2026-10-26-cde-export-review.md`）：

| ID | 严重度 | 缺陷 |
|---|---|---|
| **E-01** | critical | 导出按钮兼作取消按钮，却在任务运行时 `disabled` → **用户完全无法取消导出**（实测 60s GIF 跑满 22.6s / 74MB） |
| **E-02** | critical | `verify()` 期间到达的取消被**吞掉**并报成 `verify-failed` |
| **E-03** | critical | `submit()` 不拒绝"目标 == 源文件" → 用裁剪结果**覆盖唯一的源录制**还报成功 |

顺手修：**E-07**（准入竞争：5 个并发提交本应只收 3 个；取消的等待者不去队列 → 假 `rate-limited`）、
**E-10**（`publish-in-progress` 不再标红）、**E-13**（新增 `record.trim.cancelling` 三语键）。

---

## 3. 修改的文件地图（按"你想改什么"索引）

| 想改什么 | 文件 |
|---|---|
| 录制导出不可用（FIX-A） | `main.js`（`getRecordingService`）、`main/services/feature-services-bootstrap.js`（`createRecordingMediaProbe`） |
| 录制标注工具栏（FIX-B） | `record/record.css`（`.annotation-palette`）、`record/record.html` |
| 截图蒙层/DPR（FIX-C） | `capture/capture.js`（`renderOverlay`）、`capture/capture.css` |
| 保存成功提示（FIX-D） | `record/record.js`（`saveMp4` / `showSavedResultBar`）、`shared/locales/record.js` |
| 识别遮罩（F1） | `capture/capture.js`（`annotationsForMask`） |
| 放大镜采样（F2/F4） | `capture/capture.js`（`magnifierInSourceSpace` / `buildOccludersForSampling` / `annotationsForSampling`） |
| 镜头载入裁剪（F3） | `capture/capture.js`（`clipRestoredMagnifiers`） |
| 导出取消/发布（E-01/02/03/07） | `main/services/recording-export-service.js`、`record/trim-view.js` |
| 媒体探测容差 | `main/services/recording-probe.js` |
| 成品预设（C） | `shared/capture-output-style.js`、`capture/output-compositor.js`、`capture/output-style-panel.js` |
| 放大镜几何/缓存（D） | `shared/magnifier-geometry.js`、`capture/magnifier-sampler.js` |
| 文档契约 v1→v3 | `shared/capture-document.js` |

---

## 4. **接手后第一件事：实机验证 FIX-A / FIX-B**

这两条是最后一轮才修好的，**尚未经过用户实机确认**。装 `dist/Highlighter-Setup-4.1.6.exe`
（16:50 构建那份）后验证：

1. **FIX-A**：录一段（**不要暂停**）→ 停止 → 裁剪面板应显示真实时长、**导出按钮可用**、能导出 MP4/GIF。
   - 若仍失败，看 `D:\documet\highlighter\logs\app.log` 搜 `record probe failed:`——
     本轮已给失败路径加日志（原先错误码只回给渲染层，日志里查不到）。
2. **FIX-B**：录制中点颜色 → 色板应出现在工具按钮**右侧**（不再盖住画笔/矩形），能继续切工具。
3. **FIX-C**：150% 缩放下截图 → 蒙层铺满整屏。
4. **FIX-D**：保存 MP4 → 有成功提示且带文件名（窗口仍不自动关，这是设计）。

---

## 5. 必须知道的硬约束（改之前先看）

1. **`main.js` ≤ 1330 行**（`scripts/check-architecture.js` 硬门禁，不能抬高）。
   当前 **1329 行 —— 只剩 1 行**（注意：`wc -l` 会少算 1，因为文件末尾无换行；以 check 输出为准）。
   任何新装配都要进 `main/services/*-bootstrap.js`。
2. **i18n `--max 606`**。当前 TOTAL 592。**`capture/**` 与 `record/**` 下的注释必须是英文**
   （中文字符计入 CJK 预算）；`shared/**`、`main/**`、`test/**` 不受限。
3. **`capture/capture.html` 的 `<script>` 顺序是硬约束**（`test/capture-script-loading.test.js` 逐条钉住）：
   `capture-output-style` → `magnifier-geometry` → `occlusion-mask` → `capture-document`（加载期消费前三个）
   → `output-compositor` → `magnifier-sampler` → `cursor-geometry` → `export-result-bar`
   → `output-style-panel` → `capture.js`。少一个不是降级，是**整个窗口抛异常**。
4. **IPC 每个新通道要同时改 4 处**：`ipc-security.js`（policy）、`main/ipc/*` 注册、preload、
   `test/ipc-module-contracts.test.js` + `test/ipc-security.test.js`。`assertComplete()` 强制完整。
5. **`shared/editor-layout.js` 的 `ROW_MIN_CONTENT = 1064`** 有双向约束
   （`measured ≤ ROW_MIN_CONTENT ≤ TOOLBAR_SPACE - STRIP_CHROME`）。加第 13 个工具按钮必须同时抬 `TOOLBAR_SPACE`。
6. **同一功能在两个窗口有两套实现**：截图窗口（`capture/`）与录制窗口（`record/`）的工具栏/CSS/JS
   **完全独立**。改之前先确认用户报的是哪一个——本轮 FIX-B 就因为改错窗口而白修一轮。

---

## 6. 测试地图（按"我想验证什么"索引）

### 本轮新增的回归测试（都验证过"回退即失败"）

| 测试 | 钉住什么 |
|---|---|
| `recording-service.test.js`：`the production recording-service wiring supplies a media probe (main.js)` | **main.js 的 `new RecordingService({...})` 必须含 `probe:`**（FIX-A） |
| `recording-service.test.js`：`a service built without a probe reports probe-unavailable` | 无 probe 时的显式行为 |
| `recording-ui-contract.test.js`：`the annotation palette opens beside the tools so it never covers them` | 色板不得 `left:50%` / `translate(-50%`（FIX-B） |
| `capture-performance-contract.test.js`：两条 | `setTransform` 必须在 `!image` 早退**之前** + 无 transform 覆盖率恒为 `1/dpr²`（FIX-C） |
| `recording-trim-ui.test.js`：`a successful MP4 save tells the user it worked` | 成功提示 + 不自动关窗（FIX-D） |
| `recording-trim-ui.test.js`：`a running export can actually be cancelled...` | 用**遵守 disabled** 的点击模拟（E-01） |
| `recording-export.test.js`：`a cancel that lands during verification...` | 闸门式探针（E-02） |
| `recording-export.test.js`：`submitting the recording itself as the export target is refused` | 源字节不变 + 大小写变体也被拒（E-03） |
| `recording-export.test.js`：`concurrent submits cannot over-admit...` | 5 并发只收 3 + 取消等待者释放槽位（E-07） |
| `occlusion-recognition-wiring.test.js`：遮罩 crop 一致性 | 含反向对照（F1） |
| `capture-magnifier-ui.test.js`：遮罩宽度 / 载入裁剪 | 21 组预设×缩放 + 反向对照（F4/F3） |

### 真机探针（真实 Electron 像素级，最贵最可信）

`test/occlusion-recognition-runtime.test.js`（R0.4）、`test/magnifier-runtime.test.js`（D2）、
`test/magnifier-reedit-runtime.test.js`（D4）、`test/capture-document-editor-runtime.test.js`、
`test/capture-renderer-runtime.test.js`、`test/diagnostics-runtime.test.js`。
本轮全部重跑通过（三条隐私探针 3/3）。

### 性能探针（本轮新增，只读测量，不作门禁）

`scripts/probe-cde-performance.js`（C/D，真实 Electron + canvas）、
`scripts/probe-cde-export-performance.js`（E，真实 ffmpeg）。
结果见 `docs/plans/2026-10-26-cde-performance-samples.md`。

---

## 7. **未完成清单**（按优先级，别当成已完成）

### 7.1 实机验证（最高优先）
见 §4。**FIX-A / FIX-B / FIX-C / FIX-D 都还没被用户确认**。

### 7.2 评审中**未修**的发现

隐私（`docs/reviews/2026-10-26-cde-privacy-review.md` §6.1）：

| ID | 严重度 | 问题 | 为什么没修 |
|---|---|---|---|
| **F5** | medium | `normalizeRect` 的 `MIN_SOURCE_EDGE_PX=4` 地板在**两个坐标空间**都生效 → **2099/2856 组文档往返改变内容指纹**，破坏"打开不变脏"；漂移值仍能通过 `validateMagnifier` | 会改变**已落盘数据**的读取结果，需先定存量兼容策略。**未修项里最高优先** |
| **F6** | medium | 采样缓存键用 `${naturalWidth}x${naturalHeight}` 当底图身份 → **同尺寸不同图碰撞**（pin 重标注/同尺寸 A→B 命中旧缓存） | 键碰撞 CONFIRMED，端到端触发 SUSPECTED；改用 `initData.baseImage.sha256` |
| **F7** | medium | crop 外有 blur 时 plan 裁剪掉所有 op → fail-closed 全画布涂黑（隐私安全但可用性差） | F1 修好后症状缓解；"crop 外 blur 视为无需遮"需产品确认 |
| **F8/F9** | low | `sampleMagnifier` 源矩形不 clamp；`ensureSampleBase` 的 catch 不清缓存键 | 低风险 |

导出（`docs/reviews/2026-10-26-cde-export-review.md`）：

| ID | 严重度 | 问题 |
|---|---|---|
| **E-04** | high | `dispose()` 不等待处于 `publish()` 的任务就返回，任务随后仍会发布；`before-quit` 不 `preventDefault` |
| **E-05** | high | 快照复查 → rename 之间有 TOCTOU（已证明可被竞争写入覆盖并报成功）。**建议记为已知限制并改 §8.4 措辞**，不要假装已修 |
| **E-06** | high | `export-timeout` 可能残留 0 字节 `.part`（3 次实测 2 次）；且该错误码到不了渲染层（报成 `encode-failed`） |
| **E-08** | high | 被 `writerCoordinator` 拒绝的任务**已经拉起 ffmpeg** 才报失败 |
| E-09/E-11/E-12/E-14/E-15 | medium/low | receipt 为 null 时误报失败；音频短于选区时校验拒绝有效 MP4；`verify` 不查容器/编解码；`tempPathFor` 可能超 `MAX_PATH`；深探测 512KiB 上限 |

### 7.3 结构性问题（评审者的重要观察）

> **`resolveOcclusionPlan` 与 `clipMagnifiersToCrop` 在 `shared/capture-document.js` 里零生产调用方。**
> 渲染层的两条隐私路径各自独立构建 plan，主进程那份"权威" plan 从未被使用。
> **这是 F1/F2 能同时存在的结构性原因**：没有单一入口，两处就各错各的。
> 本轮只修了行为，没合入口——**建议下一轮优先合并**，否则同类坐标错配会以别的形式回来。

### 7.4 实机矩阵（**本机做不了**）

副屏 / 混合 DPI（100%/150%/200%）/ 屏幕拔插与重排 / 硬件与软件光栅差异 /
真实录制端到端 / >10min 长录制 / 磁盘故障 / 系统退出时仍有导出任务。

**本机限制**：只有一块屏（DISPLAY1 1493×933），"副屏""拔插"在本机**无法**验证，必须换机器。
150% 分支已由性能探针（DPR 1.5）间接覆盖；100%/200% 未覆盖。

### 7.5 性能样本（已补，但未达 plan §10.2 完整口径）

摘要（软件光栅、DPR 1.5、单机单次）：

| 项 | p50 | p95 |
|---|---:|---:|
| C：4K 深色卡片导出（9.53 MP） | 15.5 ms | 18.1 ms |
| C：4K 面板预览重绘 | 1.2 ms | 2.0 ms |
| C：原图模式 | 0 ms（无该代码路径） | 0 ms |
| D：采样底图冷构建（4K+8 blur） | 8.1 ms | 8.5 ms（5 样本，非统计 p95） |
| D：镜头拖动（缓存命中） | 0 ms | 0.1 ms |
| D：缓存字节预算 | 28.13 / 32 MiB，10 条目淘汰 7 | — |
| E：MP4 30s | 1809 ms 墙钟，ffmpeg 峰值 346 MiB | 单次，无 p95 |
| E：GIF 10s | 2621 ms 墙钟，ffmpeg 峰值 441 MiB | 单次，无 p95 |

**仍缺**：Electron 全进程内存/CPU、首次打开时间、整窗口交互帧、结束后回落、>10min 长录制。

### 7.6 功能层已知缺口

- **真实识别模型端到端未验证**（只验证了"送给模型的像素"，这是 plan §8 指定口径）。
- **D3 镜头视觉质量未验证**（探针用合成色块，没验证真实文字在 3×/4× 下可读性）。
- **"重新裁剪"手势不做**（有意）：crop 在载入时固定，`clipMagnifiersToCrop` 只在载入时防御一次。
- **旧 `record:save-mp4` 仍保留**（已安全：不删源、不关窗）。删除是 plan §8.3 后续步骤。

---

## 8. 未提交改动清单（30 项）

**修改（24）**：
```
capture/capture.css              capture/capture.js
main.js                          main/domains/record/index.js
main/services/feature-services-bootstrap.js
main/services/recording-export-service.js
main/services/recording-probe.js
package.json                     package-lock.json
record/record.css                record/record.js       record/trim-view.js
shared/locales/record.js
docs/plans/2026-10-25-feature-CDE-handoff.md   （被本次重写覆盖）
test/capture-color-palette.test.js       test/capture-magnifier-ui.test.js
test/capture-performance-contract.test.js test/capture-tool-options.test.js
test/magnifier-geometry.test.js          test/occlusion-recognition-wiring.test.js
test/recording-export.test.js            test/recording-service.test.js
test/recording-trim-ui.test.js           test/recording-ui-contract.test.js
```

**新增（6）**：
```
docs/plans/2026-10-26-cde-performance-samples.md
docs/reviews/2026-10-26-cde-privacy-review.md
docs/reviews/2026-10-26-cde-export-review.md
docs/reviews/2026-10-26-cde-lead-review.md
scripts/probe-cde-performance.js
scripts/probe-cde-export-performance.js
```

**按交接文档 §11.1「不擅自提交」——本轮没有创建任何 git 提交。**
提交时建议按缺陷分组（隐私 F1–F4 / 导出 E / 实机 FIX-A–D），不要揉成一次。

---

## 9. 本轮方法论教训（**最值得读的部分**）

1. **"测试全绿"不等于"用户路径被覆盖"。** FIX-A 的根因是 `main.js` 的一行装配代码，
   而所有测试都绕开装配、直接 `new` 服务并省略 probe。**装配点必须有测试。**
2. **同一功能在两个窗口有两套实现，修之前先确认用户说的是哪一个。**
   FIX-B 第一轮我改了截图窗口（`capture/`），用户报的是录制窗口（`record/`）——白修一轮，
   且因为测试绿了而误以为成功。
3. **"能 A 不能 B"的不对称是最快的定位线索。** "能保存 MP4 但不能导出" → 两者唯一区别是
   probe → 直接指向 probe 装配，而不用去查探测算法。我先前查了暂停容差、DPR、缓存，
   方向全错，浪费了两轮。
4. **静默 return 的错误码是调试黑洞。** `probe-unavailable` 不写日志，导致 3168 条 app.log
   里零线索。已给失败路径加日志。
5. **纯正则断言钉不住行为。** `occlusion-recognition-wiring.test.js` 的
   `assert.match(..., /mask\.buildOccluders\(input\.annotations\)/)` 匹配的**正是那行有 bug 的代码**；
   `capture-magnifier-ui.test.js` 同样用正则。两处都在 F1/F2 存在时继续通过。
6. **测试 double 忽略 `disabled` 会让"按钮不可点"永久隐身。** `FakeElement.dispatch` 直接调监听器，
   所以 E-01（取消按钮永远 disable）在 1810 个绿测试下存活很久。
7. **字符窗口/计数型断言会因无关改动假红。** 本轮修了两处：
   `invalidateToolbarSize()` 原本硬编码"恰好 4 次"、色板测试用 `[\s\S]{0,320}` 断言行序。
   都改成了语义断言。

---

## 10. 文档索引

| 文档 | 内容 |
|---|---|
| `docs/plans/2026-10-25-snow-apps-feature-development-plan.md` | 主方案（§6 C / §7 D / §8 E / §10 验收 / §11 提交边界） |
| **`docs/reviews/2026-10-26-cde-lead-review.md`** | **本轮修复记录 + 仍未修清单（接手先读 §6）** |
| `docs/reviews/2026-10-26-cde-privacy-review.md` | 隐私路径对抗式评审（F1–F11，含"已验证正确"清单，别重复查） |
| `docs/reviews/2026-10-26-cde-export-review.md` | 导出路径对抗式评审（E-01–E-15，真实 ffmpeg 探针） |
| `docs/plans/2026-10-26-cde-performance-samples.md` | 性能样本 |
| `docs/plans/2026-10-25-feature-{C,D,E}-handoff.md` | 逐项交接（契约形状、几何规则、缺陷记录） |
| `docs/plans/2026-10-25-history-reedit-batch0-contracts.md` | 文档/提交/坐标冻结契约。**§8 是识别遮罩规则** |
| `docs/plans/2026-10-25-feature-r0-baseline.md` | R0 基线 |
| `AGENTS.md`（仓库根） | **跑门禁前必读**：四个环境陷阱 + 两个已知 flake 判定 |
