# Feature E 交接记录：录屏裁剪与 MP4/GIF 导出

> 对应文档：`docs/plans/2026-10-25-snow-apps-feature-development-plan.md` §8（E0–E4）、§3、§10.3、§11.2。
> 本文只记录**实际做到并实际跑过**的内容。未执行项一律标「未验证」，不以测试文件存在代替通过记录。

- 状态：E0–E3 已实现并有自动化测试；E4 只完成"资源/性能样本"与文档，**真实设备矩阵未跑**。
- 未创建 git 提交（按 §11.1，由 Lead 统一处理）。

---

## 1. 最终范围

| 子阶段 | 交付内容 | 状态 |
|---|---|---|
| E0 | 主进程媒体探测适配器（无 ffprobe，复用捆绑 ffmpeg）；无声/有声/无索引样本实测 | 完成 |
| E1 | 会话 `capturing→finalizing→ready→closing→closed` 与导出任务拆分；导出成功不再删源；源引用计数；`managedRecordingWriters` 追踪 | 完成 |
| E2 | 时间范围裁剪、MP4/GIF 参数、任务队列、临时文件+校验+原子发布、取消仲裁、三个 invoke + 一个 push 通道 | 完成 |
| E3 | 裁剪 UI（头尾双点、输入+拖动、范围播放、格式/GIF 预设、进度、结果条）、旧 `record:save-mp4` 适配 | 完成 |
| E4 | 真实媒体样本与耗时/取消/失败注入样本、本文件 | 部分（实机矩阵未跑） |

编排决定（原计划未指定落点，实施时确定）：

- **探测落在 `main/services/recording-probe.js`**，而不是塞进导出服务。原因：探测器是独立于导出的事
  实来源（E0 验收对象），并且会话预览（`record:probe-session`）也要用它；单独成文件后测试可以只针对
  解析规则与外层三次探测策略，不必构造整个导出服务。
- **裁剪 UI 拆成两层**：`record/trim-controller.js`（状态机，纯 Node 可测）与 `record/trim-view.js`
  （DOM）。`record/record.js` 只加"构造/attached/teardown/推送转发/切语言重渲染"五处调用，
  避免把已有 890 行的录制器再撑大，也避免 DOM 逻辑无法测试。
- **通道注册走 `main/ipc/recording-export-ipc.js` + bootstrap**，控制器方法仍在 record 域内：
  "这个发送方是否本窗口的录制会话"是域已有的窗口归属判断，放进 service 会重复实现。
  main.js 只增加 2 行装配（1323/1330 行）。

---

## 2. 文件与接口变化

### 2.1 新增文件

| 文件 | 职责 |
|---|---|
| `main/services/recording-probe.js` | `MediaProbe` / `createMediaProbe`；三段式探测（头部 → 头部重试 → 只解复用的深度探测），导出 `parseProbeOutput`、`parseProgressEndTime` |
| `main/services/recording-export-service.js` | `RecordingExportService` / `createRecordingExportService`；队列、argv、进度、临时文件、校验、原子发布、取消仲裁、`EXPORT_ERROR_CODES` |
| `main/ipc/recording-export-ipc.js` | `registerRecordingExportIpc({ ipcMain, controller })`：`record:export` / `record:export-status` / `record:cancel-export` |
| `shared/recording-export-options.js` | 主进程与渲染层共用的唯一判定源：会话/任务状态表、范围与 GIF 预算校验、`buildExportArgs`、`durationToleranceMs`、`requestSignature`、`toExportRequest` |
| `record/trim-controller.js` | 裁剪/导出状态机（DOM 无关）：范围、格式、GIF 预算、范围播放决策、提交冻结、任务应用、重试 |
| `record/trim-view.js` | 裁剪面板 DOM：渲染控制器状态、范围播放执行、进度、Feature A 结果条 |
| `test/recording-export.test.js` | 41 个用例：探测解析与真实媒体、范围/GIF/argv、会话生命周期、真实编码导出、队列/重放/限流、取消仲裁、发布故障注入、控制器状态机 |
| `test/recording-trim-ui.test.js` | 12 个用例：标记/样式契约、preload 与 IPC 面、假 DOM 下的视图行为与结果条、错误码三语覆盖、CJK 门禁 |

### 2.2 修改文件

| 文件 | 变化 |
|---|---|
| `main/services/recording-service.js` | 会话状态机；`probeSession`；`acquireSource`/`releaseSource` 引用计数；`cleanupSession` 在仍有引用时推迟到 `closing` 并最后释放才删；**`transcode` 不再删除源、不再关闭会话**；`dispose` 不打断活跃导出 |
| `main/domains/record/index.js` | 新增 `probeSession` / `exportRecording` / `exportStatus` / `cancelExport` / `closePreview`；`saveMp4` 保留 `'' \| path` 返回但移除 `cleanupSession` 与 `_recordSessionId = null`；`shutdown` 先取消导出再销毁会话；注入 `getRecordingExportService` / `getExportResultService` |
| `main/services/ipc-security.js` | `record` 角色 handles 增加 `record:probe-session`、`record:export`、`record:export-status`、`record:cancel-export`、`record:close-preview`、`export:perform-action` |
| `main/ipc/recording-ipc.js` | 注册 `record:probe-session`、`record:close-preview` |
| `main/services/feature-services-bootstrap.js` | 新增 `createRecordingExportForApp` / `createRecordingExportRef`（惰性）/ `registerRecordingExportFeatureIpc` |
| `main.js` | 2 行装配：`createRecordingExportRef({...})` + `registerRecordingExportFeatureIpc({...})` |
| `preload-record.js` | `probeSession` / `exportRecording` / `exportStatus` / `cancelExport` / `closePreview` / `onExportProgress` / `exportAction` |
| `record/record.html` | 裁剪面板、GIF 选项、结果条、`trimExport` 主按钮；加载 `shared/recording-export-options.js` → `trim-controller.js` → `trim-view.js` |
| `record/record.css` | 裁剪面板/结果条样式；`body[data-format="mp4"] .trim-gif-only{display:none}`；preview 网格增加两行 `auto` |
| `record/record.js` | `ensureTrimView()`、`finishRecording` 探测后 attach、`saveMp4` 不再关窗、关闭预览释放会话、进度/语言转发 |
| `shared/locales/record.js` | 新增 46 个键 × 三语（`record.trim.*` 23 个、`record.error.export-*` 23 个） |
| `test/ipc-module-contracts.test.js` | 更新 recording 通道清单；新增导出模块契约用例 |
| `test/record-domain.test.js` | 更新旧 `saveMp4` 断言；新增 E1 无 cleanup、域导出通道、保存对话框/取消、归属校验、探测失败透传用例 |

### 2.3 IPC 契约（plan §8.3）

```ts
// 渲染层提交：只有范围/格式/GIF 规格，绝不提交源路径或目标路径
type RecordingExportRequest = {
  sessionId: string, requestId: string,
  request: {
    range: { startMs: number, endMs: number },   // 源时间半开区间 [start, end)
    format: 'mp4' | 'gif',
    gif?: { maxEdgePx: number, fps: 10 | 15 | 20, loop: true }
  }
}
// record:export → { status:'accepted', task } | { status:'cancelled' } | { status:'failed', code }
// record:export-status → { ok:true, task } | { ok:false, code:'task-not-found'|'invalid-owner' }
// record:cancel-export  → { ok:true, state, late?, task } | { ok:false, code:'publish-in-progress'|'invalid-owner'|'task-not-found' }
// record:export-progress（主→渲染）→ { taskId, state, requestId, sessionId, format, progress?, error?:{code}, receipt? }
```

`receipt` 就是 Feature A 的 `{ status:'saved', resultId, fileName, kind }`（**无路径**），
渲染层通过 `export:perform-action` 按 `resultId` 打开/复制路径/定位文件。

---

## 3. E0 技术验证：方案与真实样本

### 3.1 方案（已落到代码）

捆绑组件只有 `ffmpeg-static`（ffmpeg 6.1.1），**没有 ffprobe**；不新增依赖，用同一份 ffmpeg:

1. **头部探测（首选，不解码）**：`ffmpeg -hide_banner -ss 0 -i <file>`。因为没给输出文件，ffmpeg 必然
   以 `exit 1` 结束——这是预期行为，信息全在 stderr。解析 `Duration: HH:MM:SS.ss`、`start:`、
   `Stream #0:N ... Video: <codec>, ..., WxH, ... <fps> fps`、`Stream #0:N ... Audio: <codec>, ...`。
2. **无 duration 时的深度探测（只解复用，不解码）**：`ffmpeg -i <file> -map 0 -c copy -f null -
   -progress pipe:1`，取最后一个 `out_time_us` 作为结束时间。`-c copy` 是这个方案的关键：它只
   解复用全部数据包，代价与时长近似线性但**远低于全解码**（下面样本里 30s/120s 与 2s 都是 ~40ms）。
   计划 §8.1 警告的是"`-f null -` 全解码长录制"，这里刻意避开。
3. **不可靠即失败**：拿不到 duration 返回 `{ ok:false, code:'duration-unavailable' }`，绝不返回 0/Infinity/
   猜测值；渲染层 `durationMs` **只**作为交叉校验（`crossCheckMs`），偏差超过
   `max(1000ms, 25%)` 直接 `renderer-duration-disagrees`。

时间基准：所有范围都是**媒体时间轴上的毫秒**（与 `<video>.currentTime` 同一坐标系）；容器的
`start` 偏移单独作为 `startMs` 上报诊断，**不加进范围**（实测证明 `-ss` 与预览播放同一时间轴）。

### 3.2 真实样本结果（2026-10-25，本机 Windows，ffmpeg 6.1.1-essentials_build）

样本全部由捆绑 ffmpeg 现场生成（`testsrc` + `sine`），非仓库固定用例文件：

| 样本 | 大小 | 探测耗时 | durationMs | durationSource | 分辨率/帧率 | 音轨 |
|---|---|---|---|---|---|---|
| `silent-2s.webm`（`-an`） | 36 296 B | **47.6 ms** | 2000 | `container` | 320x240 / 10 | `exists:false` |
| `audio-2s.webm`（vp8+opus） | 55 115 B | **41.9 ms** | 2010 | `container` | 320x240 / 10 | `exists:true`, opus 48kHz mono |
| `live-no-duration.webm`（`-live 1`，头部无 duration） | 36 237 B | **81.3 ms** | 1900 | **`demux`** | 320x240 / 10 | `exists:false` |
| `long-30s.webm`（1280x720/15，含音轨） | 3 409 499 B | **42.0 ms** | 30010 | `container` | 1280x720 | `exists:true` |
| `long-120s.webm`（1280x720/20，含音轨） | 13 395 878 B | **43.7 ms** | 120010 | `container` | 1280x720 | `exists:true` |

要点：

- 无声文件**没有**音轨，`audio.exists=false`，MP4 导出据此走 `-an`（不会凭空造音轨）。
- `live` 样本头部是 `Duration: N/A`，深度探测得到 1900 ms（真实 2s，末帧时间戳 1.9s），
  证明回退路径必要且有效。
- 30s/120s 与 2s 的探测耗时几乎相同 → 头部方案没有 O(时长) 代价。
- 容器 `start` 可能是负数（有音轨样本 `startMs=-7`），因此绝不能用它平移范围。

---

## 4. 测试命令与结果

### 4.1 全量门禁（本机实测）

```bash
env -u ELECTRON_RUN_AS_NODE npm test
# 第一次（E 完成时）：ℹ tests 1773  ℹ pass 1772  ℹ fail 1
#   → test/capture-script-loading.test.js「capture.js reads the contract modules through their globals」
# 第二次（同一工作区、同伴继续改 capture/** 之后）：ℹ tests 1773  ℹ pass 1770  ℹ fail 3
#   → 上述 1 个 + capture-floating-placement.test.js、capture-tool-options.test.js 各 1 个
# 3 个失败全部落在**他人写入范围**的 capture/**：git status 显示 capture/capture.js 为 M，
# magnifier-sampler.js / magnifier-geometry.js / capture-script-loading.test.js 为 ??；
# E 不修改 capture/**、shared/capture-document.js、capture-document-service.js、
# capture-output-style.js、magnifier-*.js、settings-defaults.js。
```

Feature E 相关测试单独运行（114 用例，全绿）：

| 测试文件 | 用例数 | 结果 |
|---|---|---|
| `test/recording-export.test.js`（新） | 41 | 41 pass |
| `test/recording-trim-ui.test.js`（新） | 12 | 12 pass |
| `test/record-domain.test.js` | 13 | 13 pass |
| `test/recording-service.test.js` | 6 | 6 pass |
| `test/recording-ui-contract.test.js` | 10 | 10 pass |
| `test/ipc-module-contracts.test.js` | 11 | 11 pass |
| `test/ipc-security.test.js` | 6 | 6 pass |
| `test/recording-utils.test.js` + `test/i18n.test.js` + `test/i18n-contract.test.js` | — | pass |

### 4.2 静态门禁

```bash
npm run check   # exit 0
#  Syntax check passed for 440 JavaScript files.
#  architecture-check: ok (main.js 1323 lines, ceiling 1330, domains 10)
#  i18n: TOTAL 592 ≤ 606（record 域 4，未新增；新增 46 键已在三语表）
```

### 4.3 真实编码（测试与证据脚本都跑真 ffmpeg）

- MP4 有声裁剪 350–750ms → 输出 400ms、320x240、'h264'、音轨存在。
- MP4 无声裁剪 0–1000ms → 输出无音轨（`audio.exists=false`）。
- GIF 15fps 100–1500ms → 输出 1400ms、320x240、`codec:gif`、无音轨、循环。
- 非关键帧边界：源 10fps，起止点 350/750 非帧边界，输出首帧与源第 4 帧（对应 0.4s）逐像素比对
  一致（`-ss` + `trim` 滤镜组合，未用 `-c copy`）。

### 4.4 故障注入（全部自动化）

| 场景 | 断言 |
|---|---|
| ffmpeg 退出码 1 | 任务 `failed/encode-failed`，用户原文件内容不变，无残留 `.part` |
| 校验不通过（尺寸不符） | `failed/verify-failed`，原文件保留，**临时文件已删**（回归用例） |
| 导出期间目标被外部改写 | `failed/target-changed`，竞争写入的内容保留，不被覆盖 |
| 运行中取消 | `cancelling → cancelled`，子进程被杀，原文件不变，无残留 |
| 已发布后取消 | 返回 `late:true` 且 `task.state==='succeeded'`，成品不被删除，不改报 cancelled |
| 队列中取消 | 从未 spawn 子进程 |
| 发布阶段（`publishing`）取消 | `{ ok:false, code:'publish-in-progress' }` |
| 1 编码 + 2 排队后第 4 个 | `rate-limited` |
| 同 requestId 同参数 | 复用同一 taskId（`replayed:true`） |
| 同 requestId 不同参数 | `request-mismatch` |
| 跨窗口轮询/取消 | `invalid-owner` |
| 退出（`dispose`） | 取消活跃任务、等子进程退出、绝不把未校验文件报成功 |

---

## 5. 性能样本（本机，2026-10-25）

单次运行，非统计结论（§10.2 要求 p50/p95，这里只有 1 次观测，如实标注）：

| 场景 | 输入 | 耗时 | 输出 |
|---|---|---|---|
| MP4 有声裁剪 0.4s | 320x240/10，2s | 101 ms | 14 701 B |
| MP4 30s 全段 | 1280x720/15 | **756 ms** | 950 262 B |
| MP4 120s 中段 6s | 1280x720/20 | **308 ms** | 210 546 B |
| GIF 15fps 1.4s | 320x240/10 | 136 ms | 78 383 B（320x240，无音轨） |
| GIF 20fps 30s（1200 帧上限内） | 1280x720/15 | **3 976 ms** | 18 274 395 B（1280x720） |
| 取消（120s 任务进行中） | 1280x720/20 | 请求→`cancelled` **775 ms** | 原目标文件不变，无残留 |

未采集（如实标注）：Electron 全进程内存峰值、CPU、临时磁盘峰值、完成后回落、空闲监听数。
`performance-monitor` 未覆盖 ffmpeg 子进程，E 也没有新增其采样。

---

## 6. 已知限制

1. **GIF 体积**：30s/20fps/1280×720 输出约 18 MB。§3.3 只限时长/边/fps/帧数，不限体积，UI 已明确
   "不编造精确体积"，但用户在长选区 + 高帧率下会得到很大文件。
2. **`managedRecordingWriters` 阻塞期提交**：导出任务在 `blocked`（数据目录迁移中）时被
   `track(..., { allowBlocked:false })` 拒绝；此时任务已登记为 `queued` 并在受控抛错下进入 `failed`。
   迁移流程本身仍是"等待活跃任务"，但**跨迁移的排队任务行为未做端到端实测**。
3. **预览窗口关闭竞争**：`closePreview` 会 `cleanupSession`，此时活跃导出持有引用 → 会话进入
   `closing`，最后一个 release 才删目录。这条路径有单测（`recording-export.test.js` 引用计数用例），
   但**没有真实 Electron 窗口 + 真实 ffmpeg 的集成实测**。
4. **崩溃恢复**：按 §8.4 首版不承诺。异常退出后没有事务标记清理，用户会看到遗留的
   `.tmp-*` 录制目录与目标目录下的 `.part` 文件。文档与 UI 均未承诺清理。
5. **时间取整**：范围取整到毫秒，编码用 `trim`/`atrim` 精确裁剪；AAC 编码延迟（约 20–40ms）与
   可变帧率样本的真实偏差**未单独测量**，仅用 `durationToleranceMs = max(250ms, 5%)`
   （GIF 再加 200ms）覆盖。这个容差的来源是"1 源帧 + AAC priming"，不是实测最优值。
6. **无 `record:save-progress` 迁移**：旧 `record:save-mp4` 仍用旧进度通道与旧的 `buildFfmpegArgs`
   （无裁剪、无实际音轨检测）。它保留只是因为"所有生产调用方迁移完成"是 E 的退出条件之外的事——
   `record.js` 已经同时提供新旧两个按钮，旧按钮仍是可用的降级入口。
7. **GIF 调色板**：单次 `palettegen` + `paletteuse`（`stats_mode=diff`, `dither=bayer`）。
   画质没有与两遍法比较过；长动画用一遍是耗时与临时文件的折中。

---

## 7. 实机矩阵（未验证）

**全部未验证。** 本次开发在受限会话中完成，没有可用的真实桌面交互环境：

| 项 | 状态 |
|---|---|
| 有声/无声真实录制的端到端（点开始→停止→裁剪→导出→打开结果） | 未验证 |
| 多显示器 / 混合 DPI 下的预览窗口与裁剪面板布局 | 未验证（`test/recording-preview-runtime.test.js` 只覆盖 1.5 DPR 的布局探针，且它测的是旧按钮行） |
| 长录制（>10 min）真实内存/CPU/临时磁盘 | 未验证 |
| 磁盘满 / 只读目录 / 网络盘 | 未验证（仅用 `target-unavailable` 覆盖了不可写目录） |
| 覆盖已有文件（用户确认覆盖） | 未验证（快照比较逻辑有单测，真实保存对话框的覆盖确认未测） |
| 系统退出时仍有导出任务 | 未验证（`dispose` 有单测，Electron `before-quit` 的真实时序未测） |
| 安装包（asar.unpacked ffmpeg 路径 + 探测） | 未验证（探测确实走 `createFfmpegPathResolver`，但没有打包产物验证） |

---

## 8. 下一步

1. **实机矩阵**（§7 上表）需要真实桌面会话；优先：有声录制端到端、长录制、系统退出、覆盖已有文件。
2. **性能证据补齐**：p50/p95、Electron 全进程 + ffmpeg 峰值内存、临时磁盘峰值、结束后回落。
   需要把 ffmpeg 子进程纳入 `performance-monitor` 或另写采样。
3. **旧入口收尾**：把 `record.js` 的 `Save MP4` 按钮移除、删除 `record:save-mp4` 通道与
   `RecordingService.transcode`，并清理 `record/save-progress` 通道。E 已让它的语义安全
   （不删源），但它仍是未裁剪路径。
4. **AAC 延迟与 VFR 容差实测**：当前容差来自推理，建议用真实麦克风 + 系统声混音录制样本实测，
   再决定是否收紧 `durationToleranceMs`。
5. **`cancelling` 阶段的 UI 文案**：目前复用"正在导出…/正在完成…"，没有单独的"正在取消"。
6. **GIF 体积提示**（§6.1）：可以按 `帧数 × 尺寸` 给一个数量级提示，仍不承诺精确体积。

---

## 9. 与 C/D 的交叉点（最小侵入处理）

- `export:perform-action` 在 `ipc-security.js` 的 `record` 角色追加——与 capture/recognition 共享同一
  通道，未改其实现，`test/feature-ab-integration.test.js` 与 `test/ipc-security.test.js` 均通过。
- 未触碰 `capture/**`、`shared/capture-document.js`、`main/services/capture-document-service.js`、
  `shared/capture-output-style.js`、`shared/magnifier-*.js`、`main/services/settings-defaults.js`。
- 全量 `npm test` 的 1 个失败来自 C/D 未跟踪的 `test/capture-script-loading.test.js`（要求
  `capture.js` 通过全局读取 `window.magnifierGeometry`），与 E 无关；`test/clipboard-coordination.test.js`
  在本次全量运行中出现过一次，按 AGENTS 单独重跑 2 次均 pass，判定为已知 flake。
