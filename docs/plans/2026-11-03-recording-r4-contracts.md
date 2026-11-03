# 录屏 R4 实施契约（冻结版）

> 日期：2026-11-03（第二轮迭代）
>
> 上游方案：[2026-11-03-recording-experience-implementation-plan.md](2026-11-03-recording-experience-implementation-plan.md) §7 R4、§8.1、§8.2
>
> 前置交付：[2026-11-03-recording-r1-r3-contracts.md](2026-11-03-recording-r1-r3-contracts.md)、`docs/plans/2026-11-03-recording-r1-r3-delivery-notes.md`
>
> 本文冻结 **R4** 的接口、数据、ffmpeg 合成规则与验收口径。多流并行时**名称/形状/状态不得单方面改名**；确需改动先通知 Lead。

## 0. 本轮范围

1. **窗口录制**：真正的窗口视频源（`types:['window']`），不随桌面裁剪冒充；目标冻结画布尺寸；窗口关闭结束并保留、最小化/不可见暂停提示；录制中不再有屏幕标注浮层（窗口模式禁用标注，避免坐标错位）。
2. **多段裁剪**：项目 `edit.keepRanges[]` 多段（R1 已预留），编辑器时间线多段、拆分/删除/撤销重做、预览自动跳过删除区间；单段 API 继续兼容。
3. **WebM 输出**：导出格式增加 `webm`；完整无编辑时流复制（remux），有裁剪/缩放/帧率/质量变化时重新编码且必须符合编辑。
4. **导出分辨率/质量/帧率**：长边预设（source/1080/720/480，绝不放大源）、质量三档（CRF 映射）、帧率（source/30/60，且不得高于源帧率）；UI 直接展示最终宽×高。

**不在本轮**：R5（背景/边距/圆角/阴影、事件轨、点击波纹、缩放、镜头建议）、R6（摄像头、纯录音、分轨音量、M4A/MP3）、录后撤销已烧录笔迹、任意片段重排/重复素材、4K/60 默认、云同步。

## 1. 文件归属（写作用域，仅所有者可改）

| 工作流 | 所有者 | 写作用域 |
|---|---|---|
| W6 窗口录制（主进程） | `p2-domain` | `main/domains/record/index.js`, `main/ipc/recording-workbench-ipc.js`, `main/services/ipc-security.js`, `preload.js`, `test/record-domain.test.js`, `test/ipc-security.test.js`, `test/recording-ui-contract.test.js` |
| W7 工作台窗口选择（UI） | `p4-workbench` | `config/routes/recording.js`, `shared/locales/recording.js`, `test/recording-workbench-ui.test.js` |
| W8 导出管线（多段/WebM/参数） | `p1-persistence` | `shared/recording-export-options.js`, `shared/recording-project-schema.js`, `record/recording-utils.js`, `main/services/recording-export-service.js`, `main/services/export-result-service.js`, `test/recording-export.test.js`(原 `recording-export.test.js`), `test/export-result-service.test.js`, `test/recording-project-schema.test.js`, `test/recording-project-integration.test.js`, `test/shared-recording-export-options.test.js`（若需要新建） |
| W9 编辑器多段 + 导出 UI | `p5-editor` | `record/editor.html`, `record/editor.js`, `record/editor.css`, `record/editor-timeline.js`, `record/trim-controller.js`, `record/trim-view.js`（如仍存在）, `shared/locales/recording-editor.js`, `scripts/probe-recording-editor-layout.js`, `test/recording-editor-ui.test.js`, `test/recording-trim-ui.test.js` |
| W10 控制条窗口模式 | `p3-controlbar` | `record/record.js`, `record/record.html`, `record/record.css`, `preload-record.js`, `shared/locales/record.js`, `test/record-control-bar.test.js` |

**Lead 独占**：`docs/plans/*`、`e2e/**`、最终集成冲突与门禁。

## 2. 窗口录制（W6 + W7 + W10）

### 2.1 IPC / 载荷（冻结）

`main` 角色新增 invoke：

| 通道 | 载荷 → 返回 |
|---|---|
| `record:workbench-windows` | `{}` → `{ ok:true, windows:[WindowEntry] }` / `{ ok:false, code }` |

```js
WindowEntry = {
  token: 'uuid',          // 单次使用、120s TTL、主进程持有 → desktopCapturer source id
  title: 'Visual Studio Code',
  appName: 'Visual Studio Code',   // 可空串
  width: 1920, height: 1080        // 像素（来自源缩略图/源信息，测量失败时 0）
}
```

规则：
- **绝不下发 source id / 绝对路径**；token 在主进程 Map 中保存 `{ sourceId, title, width, height, expiresAt, used }`，最多 64 条，每次调用前清理过期项。
- 过滤自身窗口：把高亮器自己所有 BrowserWindow 的标题收集起来，与 source 名精确匹配的排除；空标题排除；宽度或高度 < 120 排除；同一 source id 去重。
- 渲染层把 token 原样回传：`record:workbench-start { mode:'window', windowToken, config }`。
- 起始校验失败码：`window-required`（缺 token）、`window-unavailable`（过期/已用/源已消失）、`window-too-small`。token 在**创建录制窗之前**消费；失败不消耗（`used` 仅在成功开始后置位）。

### 2.2 主进程录制窗（window 模式）

- `createRecordWindow({ mode:'window', windowToken, ... })`：
  - 解析 token → `desktopCapturer.getSources({ types:['window'], thumbnailSize:{width:0,height:0} })` 中按 id 精确匹配；找不到 → `window-unavailable`。
  - **不创建 frame 标注窗**（窗口模式下屏幕标注浮层会与内容坐标错位）；`record:init.annotation = false`。
  - 控制条位置：鼠标所在显示器的 workArea 底部居中（12px 边距）；`selectionBounds` = 该显示器 workArea（仅用于控制条定位）。
  - `display-media` handler 只服务本控制窗主帧，`videoRequested` 时返回**绑定的窗口源**；`audioRequested && win32` 时附带 `audio:'loopback'`（系统混音，文案不得写成“仅当前窗口”）。
- `record:init` 增量字段（其余与 R2 相同）：

```js
{
  mode: 'window',
  annotation: false,
  window: { title, pixelSize: { width, height } },   // 冻结的输出画布尺寸（像素）
  display: { id, name, boundsDip, pixelSize, scaleFactor }   // 控制条所在显示器
}
```

- 冻结画布规则：`window.pixelSize` 取窗口源测量像素（失败回退 `video.getSettings()`，再失败回退 1280×720）。录制中窗口缩放/移动**不改变编码分辨率**，渲染层把帧按比例适配（contain，黑边）到固定画布。
- **目标失效**：
  - 主进程在窗口模式控制窗存活期间每 2s 枚举一次 `types:['window']`，绑定源 id 消失 → 向控制窗推送 `record:source-lost { reason:'closed' }`（仅一次），随后停止轮询。窗口关闭/录制窗关闭都要清理轮询定时器。
  - 渲染层：收到 `source-lost` 或视频轨 `ended` → 若正在录制/暂停：停止采集、排空分片、调用 `record:finish-session`（保留素材）；若在准备/倒计时：回到就绪态。
  - 视频轨 `mute`（最小化/不可见，尽力而为）：正在录制 → 自动暂停 + 警告 `record.warning.source-hidden`；`unmute` 只清除警告，**不自动恢复**（用户自己点继续）。
- 记录卡 `captureConfig.target.mode = 'window'`，`captureConfig.target.displayName = 窗口标题`；项目 `mode` 仍取 `display|window`（见 §4 schema 枚举扩展）。

### 2.3 工作台 UI（W7）

- 模式卡增加第三张「窗口录制」：`data-testid="mode-window"`；文案键 `recording.workbench.mode-window` / `mode-window-hint`。
- 选中窗口模式后展示「可录制窗口」区：
  - 顶部说明 + 「刷新」按钮 `data-testid="window-refresh"`；
  - 列表项按钮 `data-testid="window-option"`，带 `data-window-token`，显示标题 + 尺寸（`1920×1080`，为 0 时只显示标题）；
  - 空列表 `data-testid="window-empty"`（“没有可录制的窗口，先打开要录制的窗口再刷新”）；
  - 加载中/失败：`data-testid="window-loading"` / `data-testid="window-error"` + 重试；
  - 选中态 `aria-pressed` + `.active`，与显示器选择互斥（切换模式清除另一选择）。
- 开始按钮：窗口模式无选中 → 禁用并给出 `window-required` 提示；`record:workbench-start` 载荷 `{ mode:'window', windowToken, config }`（config 与 display 模式一致，含 mode:'window'）。
- 记录筛选增加「窗口」：`data-testid="records-filter-window"`；模式标签键 `recording.records.mode-window`；`ProjectSummary.mode === 'window'` 不再被当成 display 展示。
- 需要每秒刷新窗口列表吗？不需要；用户手动刷新即可（打开窗口后点刷新）。

### 2.4 控制条（W10）

- `init.mode === 'window'` 时：
  - 采集：不再 `getDisplayMedia({video:{...display constraints}})` 后 canvas 裁剪 `selectionBounds`；直接 `getDisplayMedia({video:true, audio: system?})` 取窗口轨，画布尺寸 = `init.window.pixelSize`，每帧 `drawImage` 做 contain 适配（`video` 宽高比与画布不同→黑边）。
  - 标注：`annotation === false` 时不显示标注入口、不发送 frame 命令（frame 窗不存在）。
  - `record:source-lost` 监听 + 轨道 `ended`/`mute` 处理见 §2.2；新增 preload `onSourceLost(cb)` 订阅 `record:source-lost`。
  - 状态文案：录制中在状态区显示窗口标题（可截断），暂停/警告复用现有错误行 `data-testid="error-text"`。
- 画布尺寸/适配逻辑必须与 display 模式共用同一合成器，只改目标尺寸与绘制变换。

## 3. 多段裁剪（W9）

### 3.1 数据模型（沿用 R1 schema，无 schemaVersion 变更）

`edit.keepRanges = [{ id, startMs, endMs }]`：

- `[]` = 整段（默认）；否则 1–20 段，按 `startMs` 升序、互不重叠、**允许首尾相接**（相邻段不自动合并，拆分点要可见）、每段 `>= 100ms`、`0 <= startMs < endMs <= durationMs`。
- 保存草稿走现有 `record-editor:save-draft`（CAS），数组原样保存；冲突重载逻辑不变。
- 播放/导出以探测时长为准，UI 计时不得覆盖。

### 3.2 纯函数（`record/editor-timeline.js` 扩展，node 可测）

在现有单段函数基础上新增/改造（保留单段函数供兼容测试，或标注 deprecated）：

```js
MAX_SEGMENTS = 20
normalizeSegments(segments, durationMs) -> [{ startMs, endMs }]   // 排序、丢非法、允许相接、重叠丢弃后者
isFullRange(segments, durationMs) -> boolean                       // 单段覆盖 [0,duration]（±1ms）
splitAt(segments, atMs, durationMs) -> segments                    // 仅在段内严格切分；整段时 [] 不切（等价全段不能拆），实现：全段先物化为 [{0,duration}]
deleteSegmentAt(segments, atMs, durationMs) -> segments            // 删除包含 atMs 的段；剩 0 段表示“无内容”，禁止导出
sourceToEdited(segments, ms, durationMs) -> editedMs | null        // 落在删除区间 → null
editedToSource(segments, editedMs, durationMs) -> sourceMs
totalKeptMs(segments, durationMs) -> number
segmentAt(segments, ms, durationMs) -> index | -1                  // -1 = 删除区间
nextKeptStart(segments, ms, durationMs) -> number | null
```

`splitAt` 的“全段”语义：编辑态把空数组视作 `[{startMs:0,endMs:durationMs}]` 物化后再切分；导出时若结果恰好仍是单段覆盖全段 → 发送空 `segments`（整段）。

### 3.3 编辑器交互（W9）

- 时间线：轨道上按段绘制保留块，删除区间显示为暗色空档；播放头（source 时间）可拖动；段边界可拖动（复用现有手柄拖动，边界即相邻两段的分界：拖左手柄改该段 start，拖右手柄改该段 end，受相邻段/时长约束）。
- 按钮（真实 `<button>`，新增 testid）：
  - `split-at-playhead`：在播放头拆分当前段；
  - `delete-segment`：删除播放头所在段（若在删除区间则禁用）；
  - `reset-edits`：恢复整段；
  - `undo-edit` / `redo-edit`：撤销/重做（栈上限 50；快捷键 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y，输入框聚焦时不拦截）。
- 统计：`总时长` 改为 `保留 {kept} / 原片 {duration}`；导出使用 `segments`。
- 预览：播放从播放头开始，跨删除区间自动跳到下一保留段起点；到最后一个保留段末尾暂停。播放头移动不修改段落。`播放所选` 语义改为“播放保留内容”，文案/键可更新（i18n）。
- 空选择（删除到 0 段）时导出禁用并提示；草稿仍可保存。

## 4. 导出契约 v2（W8）

### 4.1 请求形状

```js
request = {
  format: 'mp4' | 'gif' | 'webm',
  segments?: [{ startMs, endMs }],   // 新；省略/空 = 整段
  range?: { startMs, endMs },        // 旧单段兼容；与 segments 同时出现 → ambiguous-selection
  gif?: { edge, fps },               // 仅 gif
  video?: {                          // 仅 mp4/webm；gif 提供则忽略
    resolution: 'source' | '1080p' | '720p' | '480p',   // 目标“长边”上限，见 §4.2
    quality: 'standard' | 'high' | 'ultra',
    fps: 'source' | 30 | 60
  }
}
```

校验错误码（`fail(code)`，沿用现有风格）：`unsupported-format`、`duration-unavailable`、`invalid-range`、`range-out-of-bounds`、`range-too-short`、`ambiguous-selection`、`too-many-segments`、`overlapping-segments`、`invalid-video-option`、`fps-above-source`、`empty-selection`，GIF 既有码不变。

### 4.2 归一化结果（`normalizeExportRequest` 的 value）

```js
{
  format,
  segments: [{ startMs, endMs }],        // 升序、非重叠（允许相接），至少 1 段；整段 = [{0,duration}]
  totalDurationMs,                        // 各段时长之和
  gif: { edge, fps, width, height } | null,
  hasAudio: format !== 'gif' && metadata.audio.exists === true,
  video: {
    resolution: 'source'|'1080p'|'720p'|'480p',
    quality: 'standard'|'high'|'ultra',
    fps: 'source'|30|60,
    width, height,                        // 输出宽高（偶数；不放大；按源画幅等比）
    fpsValue,                             // 实际输出帧率（fps='source' → 源帧率，未知则 0=保持）
    copy: boolean                         // 仅 webm 快速路径
  },
  sourceWidth, sourceHeight
}
```

规则：
- 输出尺寸：分辨率预设是**目标长边上限**（不是高）：`RESOLUTION_PRESETS = { '1080p': 1920, '720p': 1280, '480p': 854 }`。`scale = min(1, presetLongEdge / max(sourceWidth, sourceHeight))`（`source` 时 scale=1）；`width = even(round(sw*scale))`、`height = even(round(sh*scale))`，最小 2。**绝不放大**：源长边小于预设时输出=源尺寸（预设不可选，UI 隐藏）。提供 `computeVideoOutput({ sourceWidth, sourceHeight, resolution })` 纯函数给渲染层预览同值。
- 帧率：`fps='source'` → `fpsValue = sourceFrameRate || 0`（0 = 不改变）；数值帧率 > 源帧率 + 0.5 → `fps-above-source`；源帧率未知时允许选择（按用户选择）。
- `copy=true` 条件（WebM 快速路径）：`format==='webm'` && 单段覆盖全片（±1ms）&& `resolution==='source'` && `fps==='source'`（quality 在此路径忽略）。`copy` 时 `width/height` = 源尺寸。
- `durationToleranceMs(expected)`：`max(250, total*0.05)` + `(segments.length-1) * ceil(1000 / min(sourceFps||30, 30))` +（GIF 再加 200）。

### 4.3 ffmpeg 合成规则（`buildExportArgs`）

**多段编码**（mp4/webm/gif，任何 `copy=false` 情况）：

- 逐段输入：对第 i 段 `seek = max(0, startMs-2000)`、`relStart=startMs-seek`、`relEnd=endMs-seek`：
  `-ss <seek/1000> -t <relEnd/1000> -i <input>`
- 逐段滤镜（视频）：`[i:v]trim=start=<relStart>:end=<relEnd>,setpts=PTS-STARTPTS` +（fps 需要时）`,fps=<fpsValue>` +（缩放需要时）`,scale=<W>:<H>:flags=lanczos` + `[v<i>]`
- 逐段滤镜（音频，若有）：`[i:a]atrim=...,asetpts=PTS-STARTPTS,aresample=48000[a<i>]`
- 拼接：视频 `[v0]...[vN-1]concat=n=N:v=1:a=0[outv]`；含音频 `[v0][a0][v1][a1]...concat=n=N:v=1:a=1[outv][outa]`
- 输出编码：
  - mp4：`-c:v libx264 -preset veryfast -crf {standard:28, high:23, ultra:18} -pix_fmt yuv420p -movflags +faststart`；音频 `-c:a aac -b:a 160k -ar 48000 -ac 2`；无音轨 `-an`。
  - webm（重编码）：`-c:v libvpx-vp9 -b:v 0 -row-mt 1 -crf {34,28,22}`；音频 `-c:a libopus -b:a 128k`。
  - gif：拼接后沿用现有 palettegen/paletteuse 管线（`fps`/`scale` 用 GIF 自己的选项，`video` 参数忽略）。
- 单段且 `seek=0`、无缩放/帧率变化时仍走同一条 concat 图（N=1 也合法），保持一条代码路径；不得对非关键帧边界做 `-c copy`。
- **WebM 复制路径**（`copy=true`）：`-hide_banner -nostdin -i <input> -map 0 -c copy -y <out>`，expected 时长 = 源时长、宽高 = 源宽高、音频 = 源是否有音轨。

`expected` 校验（export service `verify()` 与测试共用）：`{ format, durationMs: totalDurationMs, width, height, hasAudio, fps }`；webm 与 mp4 均校验宽高/音频/时长容差；GIF 校验宽高与时长。

### 4.4 服务与外围

- `main/services/recording-export-service.js`：临时文件扩展名按 format（`.mp4/.gif/.webm`）；`verify()` 使用新 expected；`tempPathFor` 不变逻辑；回执 kind = format。
- `main/services/export-result-service.js`：`EXPORT_KINDS` + `EXPORT_EXTENSIONS` 增加 `webm: '.webm'`；动作（打开/地址/目录）对 webm 与 mp4 一致。
- `shared/recording-project-schema.js`：`EXPORT_FORMATS` 增加 `'webm'`（`edit.format` 与 `exports[].format` 均接受；旧项目不变，不加 schemaVersion）。
- `record/recording-utils.js`：`buildFfmpegArgs`（旧 `record:save-mp4` 通道）保持现状，不扩展（新 UI 不再使用；避免双重实现）。
- 导出请求签名 `requestSignature` 必须覆盖 segments/video（同 requestId 不同参数 → `request-mismatch`）。

## 5. 编辑器导出面板（W9）

- 格式下拉增加 `webm`：`<option value="webm">WebM 视频</option>`（`export-format` 不变）。
- 新增控件（真实 `<select>`/`<input>`）：
  - `export-resolution`：`source`（原始尺寸）/`1080p`/`720p`/`480p`；只列出不放大源的档位（预设长边 > 源长边时隐藏该档；`source` 恒有）。
  - `export-quality`：`standard`/`high`/`ultra`。
  - `export-fps`：`source` + 可选 `30`/`60`（仅当源帧率已知且 >= 该值；源帧率未知时仅 `source` + `30`? —— **规则**：未知帧率只提供 `source`，避免“提高帧率创造细节”）。
  - `export-output-size`：展示最终 `宽×高`（与主进程同一 `computeVideoOutput`）与总保留时长；GIF 时显示 GIF 尺寸。
- `export-button` 提交 `{ segments, format, gif?, video? }`（`segments` 为空数组时省略 = 整段）。导出中冻结所有编辑/参数控件；成功/失败/取消恢复。
- 结果条与既有 `export:perform-action` 一致；webm 的 kind 显示为“WebM”文案（i18n）。
- 无内容（keepRanges 删空）→ 导出禁用 + 提示，不调用 IPC。

## 6. 验收与测试

| 层面 | 必测 |
|---|---|
| 窗口源 | token 单次使用/过期/源消失；自身窗口过滤；`window-required`/`window-unavailable`/`window-too-small`；窗口模式不创建 frame 窗；init 字段；`record:source-lost` 轮询与清理；editor init metadata 增加 `video.frameRate` |
| 多段数据 | 归一化（排序/相接/重叠/越界/上限/最短）；`splitAt`/`deleteSegmentAt`/映射/总数；整段等价空数组 |
| 导出管线 | 真实 ffmpeg：3 段含缺口 → 产物时长=各段和、宽高正确；webm 复制路径（无编辑全段）与重编码路径（有裁剪）；缩放 + 帧率 + 质量三档至少各 1 例；mp4/gif 回归；verify 失败码；同 requestId 不同参数 → request-mismatch |
| 服务/外围 | 临时扩展名 webm；导出结果 kind webm（注册/打开/地址）；项目导出记录 format webm；schema 接受 webm；旧 mp4/gif 项目零回归 |
| UI | 工作台窗口列表/刷新/空态/错误/选中/开始载荷/筛选；编辑器多段块渲染、拆分/删除/撤销重做、播放跳过缺口、面板档位隐藏规则、空选择禁用；三语言键齐全；窄屏/DPR 1.5 布局探针 |
| E2E（Lead） | 既有录屏 E2E 保持绿；新增窗口模式（fakeCapture 路径）与多段 + webm/缩放导出，真实 ffmpeg 校验产物 |

门禁同上一轮：目标测试文件 → `scripts/check-js.js` → `scripts/check-architecture.js` → `scripts/check-i18n.js --max 606`；新增代码零中文行（扫描区），英文注释，i18n 三语言齐全。

## 7. 已知限制（本轮明确接受）

1. 窗口模式**无录中标注浮层**（窗口移动/缩放下屏幕坐标不可靠）；既有屏幕标注能力在区域/全屏模式保留。
2. 窗口最小化/遮挡的“画面不可用”检测按 Chromium 轨道 `mute` 尽力而为；本机无法验证真实窗口采集，需真机补测 Windows 上窗口最小化/关闭/跨屏行为。
3. 窗口录制开始后窗口移动/缩放：输出画布固定、内容 contain 适配；不跟随窗口位置。
4. 多段仅支持源时间顺序保留；不支持重排/重复素材（与方案一致）。
5. 分辨率/质量/帧率为导出参数，不写入项目草稿（会话内 UI 状态；重开编辑器回到默认 `source/standard/source`）。
6. 系统声音仍为系统混音，窗口模式同样如此，文案不得写成“仅当前窗口音频”。
