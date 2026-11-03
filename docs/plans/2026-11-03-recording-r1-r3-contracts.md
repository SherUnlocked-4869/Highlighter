# 录屏工作台 R1–R3 实施契约（冻结版）

> 日期：2026-11-03
>
> 上游方案：[2026-11-03-recording-experience-implementation-plan.md](2026-11-03-recording-experience-implementation-plan.md)
>
> 本文只冻结**本轮要落地的 R1–R3 最小闭环**的接口、数据、文件归属与验收口径。实现细节由各工作流决定，但**凡是本文写死的名称/形状/状态都不许单方面改名**——多条工作流并行时，改名等于让对方的代码失效。确需修改先通知 Lead。

## 0. 本轮范围（已拍板）

交付一个完整可用的新版区域/全屏录屏闭环：

1. **R1 素材与恢复基础**：`recordings/` 持久数据根、录屏项目（`project.json` + `capture.webm`）、写入检查点、启动恢复、关闭/重录不丢上一条、删除引用检查、数据目录迁移纳入。
2. **R2 录前与录中体验**：主窗口 `recording` 工作台路由（区域/全屏入口、声音、帧率/画质/倒计时、最近记录）、录制控制条精简（计时·麦克风静音·暂停·完成·更多→标注）、麦克风设备选择与静音、重复入口仲裁、托盘/快捷键统一命令。
3. **R3 编辑与导出闭环**：独立编辑器窗口（大预览 + 单时间线双手柄 + 格式/参数 + 唯一导出入口）、编辑草稿自动保存、关闭后从记录继续编辑、导出统一走既有任务服务。

**明确不在本轮**（不要顺手做）：窗口录制、多段裁剪/重排、录后外观/缩放/点击波纹、摄像头、纯录音、WebM 导出、缩略图（`thumbnail:false` 即可）、旧临时会话的恢复导入、真正的崩溃后 WebM 尾部修复 remux（只做“探测可用就纳入记录”，不可用就保持 recoverable）。

## 1. 文件归属（写作用域）

只有**所有者**可以改这些文件；其他人需要改动先找 Lead。

| 工作流 | 所有者 | 写作用域 |
|---|---|---|
| W1 持久化 | `p1-persistence` | `shared/recording-project-schema.js`(新), `main/services/recording-project-service.js`(新), `main/services/recording-service.js`, `main/services/data-root.js`, `main/services/data-root-migration.js`, `main/services/data-root-migration-cleanup.js`(如需), `main/services/data-root-bootstrap.js`(如需), `test/recording-project-service.test.js`(新), `test/recording-project-schema.test.js`(新), `test/recording-service.test.js`, `test/data-root*.test.js`, `test/usage-data-root-migration.test.js` |
| W2 主进程域/IPC | `p2-domain` | `main/domains/record/index.js`, `main/ipc/recording-ipc.js`, `main/ipc/recording-export-ipc.js`, `main/ipc/recording-workbench-ipc.js`(新), `main/services/ipc-security.js`, `main/services/function-router.js`, `main/services/tray-menu.js`, `main/services/settings-defaults.js`, `main/services/settings-normalize.js`, `main/services/settings-validation.js`, `main.js`, `preload-record-editor.js`(新), `shared/locales/main.js`, `test/record-domain.test.js`, `test/recording-ui-contract.test.js`, `test/function-router.test.js`, `test/tray-menu.test.js`, `test/ipc-security.test.js`, `test/settings-*.test.js`, `test/architecture-gate.test.js`(如需) |
| W3 录制控制条 | `p3-controlbar` | `record/record.html`, `record/record.css`, `record/record.js`, `record/audio-mixer.js`, `record/recording-utils.js`, `preload-record.js`, `shared/locales/record.js`, `shared/recording-quality.js`(**Lead 先建，W3 可改**), `test/record-control-bar.test.js`(新), `test/audio-mixer.test.js`, `test/recording-utils.test.js` |
| W4 工作台 | `p4-workbench` | `config/routes/recording.js`(新), `config/config.html`, `config/config.js`, `config/config.css`, `config/routes/settings.js`, `preload.js`, `shared/locales/recording.js`(新), `shared/locales/config.js`, `test/recording-workbench-ui.test.js`(新), `test/config-*.test.js`, `test/settings-route*.test.js`(若存在) |
| W5 编辑器 | `p5-editor` | `record/editor.html`(新), `record/editor.js`(新), `record/editor.css`(新), `record/editor-timeline.js`(新), `record/trim-controller.js`, `record/trim-view.js`, `scripts/probe-recording-editor-layout.js`(新，参考 `scripts/probe-recording-preview-layout.js`), `shared/locales/recording-editor.js`(新), `test/recording-editor-ui.test.js`(新), `test/recording-trim-ui.test.js`, `test/recording-preview-runtime.test.js` |

**Lead 独占**：`docs/plans/*`、`shared/recording-quality.js` 的首次创建、`.tmp-record/`、最终集成冲突修复。

> `record/trim-*.js` 从“录制窗预览”迁移到“编辑器”是 W5 的工作；W3 只负责把 `record/record.html` 里的预览视图整段删除（不再引用 trim脚本）。W3/W5 必须在各自完成时跑 `node --test test/recording-*.test.js` 确认彼此没有留下断引用。

## 2. 数据根与迁移

`main/services/data-root.js` 的 `createDataPaths()` 增加：

```js
recordings: path.join(root, 'recordings')   // 持久素材，绝不可当 cache 清理
```

`main/services/data-root-migration.js`：

- `MANAGED_DIRECTORIES` 增加 `'recordings'`（回滚清理）。
- `ADDITIONAL_PERSISTENT` 增加 `'recordings'`（复制 + 清单校验）。
- `MARKER_VERSION` 升到 `3`；校验必须**向后兼容 v2** pending marker（v2 的 `persistentManifests` 没有 `recordings` 键，按 `[]` 处理，不能因此拒绝一个崩溃前 v2 版本的迁移）。
- 迁移复制走 `persistentManifest` 同一套逻辑；旧数据根没有 `recordings/` 时记 `[]`。

## 3. 设置（`main/services/settings-defaults.js`）

`record` 块在保留既有字段的前提下新增（旧字段一律不动，旧配置不强改）：

```js
record: {
  frameRate: 24,                    // 既有，不动默认值
  saveDirectory: '',
  audioSystem: true,
  audioMicrophone: false,
  audioSystemGain: 1,
  audioMicrophoneGain: 1,
  quality: 'standard',              // 新：'standard' | 'high' | 'ultra'
  countdown: 3,                     // 新：0 | 3 | 5
  audioMicrophoneDeviceId: '',      // 新：'' = 系统默认设备
  lastMode: 'display',              // 新：'display' | 'region'
  lastDisplayId: ''                 // 新：'' = 鼠标所在屏
}
```

`shortcuts` 新增（默认全 `''`，不抢占用户现有组合键）：

```js
openRecording: '',       // 打开录屏工作台
recordRegion: '',        // 区域快速录制
recordFullscreen: '',    // 全屏快速录制
recordPauseResume: '',   // 暂停/继续（录制中）
recordFinish: ''         // 完成（录制中）
```

归一化/校验：`record.quality`、`record.countdown`、`record.lastMode` 必须枚举兜底；`audioMicrophoneDeviceId`、`lastDisplayId` 按文本裁剪限长。验证层若对数字/枚举没有现成 domain validator，用 `settings-validation` 的 domainValidators 挂 `record.quality` / `record.countdown` / `record.lastMode`，拒绝非法值（不要只靠读取时归一化）。

## 4. `shared/recording-quality.js`（Lead 建，W3 可改）

```js
QUALITY_LEVELS = ['standard', 'high', 'ultra']
DEFAULT_QUALITY = 'standard'
QUALITY_BITS_PER_SECOND = { standard: 4_000_000, high: 8_000_000, ultra: 16_000_000 }
normalizeQuality(value) -> 'standard'|'high'|'ultra'
qualityBitsPerSecond(value) -> number
COUNTDOWN_OPTIONS = [0, 3, 5]
DEFAULT_COUNTDOWN = 3
normalizeCountdown(value) -> 0|3|5
```

录制器把 `quality` 换成 `videoBitsPerSecond`（与既有 VP9 优先逻辑并存）；倒计时用 `countdown` 秒。UI 文案：标准/高清/极清（i18n），编码参数是内部细节。

## 5. `RecordingService` 扩展（W1）

构造参数不变。新增/调整：

```js
// 指定目录开始采集（工作台流程在项目目录里直接写 capture.webm）。
// 不传 directory 时保持旧行为（tempRoot/<uuid>）。
async startSession({ directory = null, projectId = null } = {})
  -> { id, directory, inputPath }

// 重启后把持久项目重新挂到服务上：state='ready'，引用计数 0，绝不删除目录。
registerPersistedSession({ id, directory, inputPath, metadata, projectId })
  -> session

// 从会话表里摘掉但不删目录（项目接管源文件时用）。
detachSession(sessionId) -> boolean

// 追加分片：带序号时严格校验（last+1），重复的已接受序号幂等返回同一 ACK。
async appendChunk(sessionId, buffer, { sequence = null } = {})
  -> { committedBytes, sequence, lastChunkSequence }

// finishSession 返回里增加 bytesWritten；其余语义不变。
```

会话对象新增字段：`projectId`、`bytesWritten`、`lastChunkSequence`、`ownedDirectory`（`startSession({directory})`/`registerPersistedSession` 为 `false`）。`cleanupSession` / `removeSessionDirectory` / `dispose` 遇到 `ownedDirectory === false` 时**只从 Map 移除，不 rm 目录**；目录删除由项目服务负责。

序号语义：`appendChunk` 的 `sequence` 从 1 开始、严格递增；`sequence <= lastChunkSequence` 视为重放（返回当前 ACK，不重复写）；`sequence > lastChunkSequence + 1` 视为缺口 → `throw`（错误对象带 `code='sequence-gap'`）。不带 `sequence` 时按旧行为直接追加（兼容旧测试/旧调用）。

## 6. `RecordingProjectService`（W1）

`main/services/recording-project-service.js`

```js
const service = createRecordingProjectService({
  root,                      // <dataRoot>/recordings
  fs = fsp, path = require('node:path'), now = Date.now,
  atomicWriteJson,           // main/services/data-root.js
  createId = () => randomUUID(),
  log = () => {}
})
```

必须实现（全部 async，除特别标注）：

| 方法 | 行为 |
|---|---|
| `createProject({ mode, captureConfig, name })` | 建目录 + `project.json`（state `capturing`，edit.revision 1，recovery.cleanStop false）→ `{ project, directory }` |
| `getProject(id)` | 读 `project.json` 并 schema 归一化；不存在/损坏 → `null` |
| `readProjectFile(id)` | 原始 JSON（恢复场景），损坏时不抛 |
| `listProjects({ offset = 0, limit = 20 } = {})` | 按 `updatedAt` 降序的项目摘要；**惰性恢复**：遇到 `state === 'capturing'` 的清单，原子改写成 `recoverable`（`recovery.errorCode = 'interrupted'`）后再返回摘要 |
| `checkpoint(id, { committedByteOffset, lastChunkSequence })` | 节流（>= 1s 或 >= 4MiB 才落盘）写 `recovery`；返回是否真正写过 |
| `sealProject(id, { metadata, captureOutcome })` | 写入 media/duration/bytes/`recovery.cleanStop=true`，state → `ready`；探测失败时 state → `recoverable`、`recovery.errorCode='probe-failed'`，**不抛**，返回 `{ ok:false, code, project }` |
| `updateDraft(id, { expectedRevision, edit })` | CAS：`edit.revision === expectedRevision` 才递增写入；冲突返回 `{ ok:false, code:'revision-conflict' }` |
| `renameProject(id, name)` | 1–120 字符（trim 后），返回 `{ ok, project }` |
| `appendExport(id, entry)` | 记录 `{ exportId, format, fileName, exportedAt, editRevision, targetPath }`（`targetPath` 只在主进程侧） |
| `markRecoverable(id, errorCode)` | 供恢复流程使用 |
| `markReady(id, { fileName, metadata })` | 恢复成功后纳入记录 |
| `deleteProject(id)` | 目录递归删除（调用方已完成引用检查）；返回 `{ ok }` |
| `summaryOf(project)` / `publicProject(project)` | 纯函数投影（见 §7），供 IPC 直接返回，**不含任何路径** |
| `dispose()` | flush 节流的 checkpoint 写并等待空闲 |

## 7. 项目清单（`recordings/<projectId>/project.json`，schemaVersion 1）

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "createdAt": 0,
  "updatedAt": 0,
  "name": "ScreenRecording_2026-11-03_17-00-00",
  "mode": "display",
  "state": "capturing",
  "captureConfig": {
    "target": {
      "mode": "display",
      "displayId": "2528732444",
      "displayName": "DISPLAY2",
      "boundsDip": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
      "pixelSize": { "width": 1920, "height": 1080 },
      "scaleFactor": 1
    },
    "frameRate": 30,
    "quality": "standard",
    "countdown": 3,
    "audio": { "system": true, "microphone": false, "microphoneDeviceId": "", "systemGain": 1, "microphoneGain": 1 }
  },
  "source": { "assetId": "capture", "fileName": "capture.webm", "mediaKind": "video", "mimeType": "video/webm", "bytes": 0 },
  "media": {
    "durationMs": 0,
    "video": { "width": 0, "height": 0 },
    "audio": { "tracks": 0, "codec": "" },
    "timebase": 1000,
    "probedAt": 0
  },
  "captureOutcome": { "video": true, "audio": { "system": false, "microphone": false }, "warnings": [] },
  "edit": {
    "revision": 1,
    "keepRanges": [],
    "format": "mp4",
    "gif": { "edge": 1280, "fps": 15 }
  },
  "exports": [],
  "recovery": { "committedByteOffset": 0, "lastChunkSequence": 0, "cleanStop": false, "errorCode": "" }
}
```

规则：

- 媒体路径一律为**项目目录内相对文件名**（`source.fileName`），升级/迁移后仍然有效。
- `keepRanges` 空数组 = 整段；单段时 `[{ id: 'keep-1', startMs, endMs }]`，半开区间 `[startMs, endMs)`，必须 `0 <= startMs < endMs <= durationMs`。多段不在本轮。
- `bytes` 以磁盘 stat 为准；`durationMs` 以探测结果为准，绝不信任渲染层计时。
- 原子写：一律 `atomicWriteJson`。写顺序：先媒体 flush、再推进 checkpoint。
- 所有时间整数毫秒。

**对外投影**（IPC 只返回这两种，绝不含路径）：

```js
ProjectSummary = {
  id, name, mode, state, createdAt, updatedAt,
  durationMs, width, height, bytes, frameRate, quality,
  hasAudio, audio: { system: boolean, microphone: boolean },
  exportCount, lastExport: { format, fileName, exportedAt } | null,
  thumbnail: false
}

ProjectPublic = ProjectSummary & {
  schemaVersion, captureConfig, source: { mediaKind, mimeType, bytes }, media,
  captureOutcome, edit, exports: [{ exportId, format, fileName, exportedAt, editRevision }],
  recovery: { cleanStop, errorCode }
}
```

## 8. 窗口/页面/角色

| 角色 | 页面 | preload | 说明 |
|---|---|---|---|
| `record` | `record/record.html` | `preload-record.js` | 录制控制条 + 标注框（保留 frame 窗） |
| `record-editor` | `record/editor.html` | `preload-record-editor.js` | 新：独立编辑器，可缩放/最大化、frameless + 自绘标题栏 |
| `main` | `config/config.html` | `preload.js` | 新路由 `recording`（工作台 + 记录） |

IPC 安全：`main/services/ipc-security.js` 的 `IPC_SURFACES` 增补对应 handles/listeners。工作台只拿到列举/启动/记录操作权限；追加分片只属于 `record`；草稿/导出只属于 `record-editor`。**任何通道都不接受渲染层提交的源路径/目标路径/任意 ffmpeg 参数。**

## 9. IPC 契约（冻结）

### 9.1 `main` 角色（工作台 + 记录）

| 通道 | 方向/类型 | 载荷 → 返回 |
|---|---|---|
| `record:workbench-state` | invoke | `{}` → `{ config, displays, active, recent }` |
| `record:workbench-start` | invoke | `{ mode:'display'\|'region', displayId?: string, config }` → `{ ok:true, focused?:true }` / `{ ok:false, code }` |
| `record:workbench-focus` | invoke | `{}` → `{ ok:boolean }`（录制中把控制条拉到前台） |
| `record:project-list` | invoke | `{ offset?, limit? }` → `{ items: ProjectSummary[], total, offset, limit }` |
| `record:project-open` | invoke | `{ projectId }` → `{ ok:true }` / `{ ok:false, code }` |
| `record:project-rename` | invoke | `{ projectId, name }` → `{ ok:true, project: ProjectSummary }` / `{ ok:false, code }` |
| `record:project-delete` | invoke | `{ projectId }` → `{ ok:true }` / `{ ok:false, code:'busy'\|'not-found' }` |
| `record:project-reveal` | invoke | `{ projectId }` → `{ ok:true }` |

`record:workbench-state` 形状：

```js
config = {
  mode: 'display',                 // 上次使用模式
  displayId: '',
  frameRate: 30,
  quality: 'standard',
  countdown: 3,
  audioSystem: true,
  audioMicrophone: false,
  audioMicrophoneDeviceId: '',
  saveDirectory: ''
}
displays = [{ id: '2528732444', name: 'DISPLAY2', width: 1920, height: 1080, scaleFactor: 1, primary: false, label: '2 · 1920×1080' }]
active = null | { mode, status: 'preparing'|'countdown'|'recording'|'paused'|'finalizing', elapsedMs, microphoneMuted }
recent = ProjectSummary[]      // 最多 8 条
```

名额校验：`record:project-open` 在项目 `state === 'capturing'` 时返回 `{ ok:false, code:'project-busy' }`；恢复失败的项目也允许打开编辑器（只读 + 错误说明）。

### 9.2 `record` 角色（控制条）

`record:init`（main→renderer 推送，`record:ready` 后发送）：

```js
{
  sessionId: '',            // 空串：尚未开始采集
  projectId: '',            // 开始采集后才有
  mode: 'display',
  display: { id, name, boundsDip, pixelSize, scaleFactor },
  selectionBounds: { x, y, width, height },
  frameRate: 30,
  quality: 'standard',
  countdownSeconds: 3,
  audio: { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 }
}
```

| 通道 | 方向/类型 | 载荷 → 返回 |
|---|---|---|
| `record:start-session` | invoke | `{}` → `{ id, projectId }`（主进程此时建项目 + 会话） |
| `record:append-chunk` | invoke | `{ sessionId, arrayBuffer, sequence, bytes }` → `{ committedBytes, sequence, lastChunkSequence }`；`code:'sequence-gap'` 表示滚雪球错误 |
| `record:finish-session` | invoke | `{ sessionId }` → `{ ok:true, projectId }` / `{ ok:false, code }`；主进程负责封存 + 打开编辑器 + 关闭控制条 |
| `record:cancel-session` | invoke | `{ sessionId }` → `{ ok:true }`；删除本次项目（放弃本次） |
| `record:get-state` | invoke | `{}` → 状态缓存（见下） |
| `record:state` | listener (renderer→main) | `{ sessionId, status, elapsedMs, microphoneMuted, stateVersion }` |
| `record:command-result` | listener (renderer→main) | `{ requestId, ok, state, code }` |
| `record:command`（推送 main→renderer，无 policy） | — | `{ requestId, command:'pause'\|'resume'\|'stop'\|'set-microphone-muted', value? }` |
| `record:state-changed`（推送 main→renderer，无 policy） | — | 状态缓存（托盘/快捷键操作后同步 UI） |

保留既有通道（不删除，避免旧调用面断裂）：`record:set-annotation-command`, `record:set-frame-state`, `record:restart`, `record:ready`, `record:performance`, `record:close`, `record:save-mp4`（内部不再有 UI 入口）, `record:resize-preview`, `record:probe-session`, `record:close-preview`。新增实现需保持它们不抛错。

状态形状：

```js
state = { status: 'preparing'|'countdown'|'recording'|'paused'|'finalizing', elapsedMs, microphoneMuted, stateVersion }
```

命令仲裁：控制条按钮、托盘、快捷键最终都在渲染层同一个 `applyCommand({ requestId, command, value })` 落地；`requestId` 幂等（主进程在转发前生成并登记，渲染层重复的 requestId 直接返回上次结果）。托盘/快捷键命令通过 `record:command` 推送，不直接改主进程状态。

### 9.3 `record-editor` 角色（编辑器）

`record-editor:init`（main→renderer 推送，`record-editor:ready` 后发送）：

```js
{
  project: ProjectPublic,
  sourceUrl: 'file:///.../capture.webm',    // 主进程派生的 file URL，唯一允许暴露的路径形态
  metadata: { durationMs, video: { width, height }, audio: { tracks } },
  recovery: { state: 'ready'|'recoverable', errorCode: '' }
}
```

| 通道 | 方向/类型 | 载荷 → 返回 |
|---|---|---|
| `record-editor:save-draft` | invoke | `{ projectId, expectedRevision, edit }` → `{ ok:true, revision }` / `{ ok:false, code:'revision-conflict' }` |
| `record-editor:export` | invoke | `{ projectId, requestId, request }` → `{ status:'accepted'\|'cancelled'\|'failed', task?, code? }`；`request` = `{ range:{startMs,endMs}, format:'mp4'\|'gif', gif?:{edge,fps} }`（与 `shared/recording-export-options.js` 现有契约一致；主进程负责保存对话框与目标冻结） |
| `record-editor:export-status` | invoke | `{ taskId?, requestId?, projectId? }` → 任务公开形状（同 `record:export-status`） |
| `record-editor:cancel-export` | invoke | `{ taskId }` → `{ ok }` |
| `record-editor:rename` | invoke | `{ projectId, name }` → `{ ok, project }` |
| `record-editor:rerecord` | invoke | `{ projectId }` → `{ ok:true }`（关闭编辑器 + 以相同 captureConfig 开新素材，旧项目保留） |
| `record-editor:reveal` | invoke | `{ projectId }` → `{ ok:true }`（打开素材目录） |
| `record-editor:back` | invoke | `{}` → `{ ok:true }`（关闭编辑器 + 主窗口回工作台） |
| `record-editor:reload` | invoke | `{ projectId }` → `{ ok:true, project: ProjectPublic, sourceUrl, metadata, recovery }`；恢复横幅的“重试探测”与 revision 冲突后的“重新载入”共用（主进程重新派生 file URL）。revision 冲突时 `record-editor:save-draft` 的拒绝结果额外带 `project` 供渲染层就地刷新。 |
| `record-editor:close` | listener | `{}`（窗口关闭） |
| `record-editor:window` | listener | `{ action:'minimize'\|'close' }` |
| `export:perform-action` | invoke | 复用 Feature A 回执动作（结果条） |
| `record:export-progress`（推送） | — | 任务进度（复用既有推送通道名） |

导出成功后的回执：主进程调用项目服务 `appendExport()` 记录 `{ exportId: taskId, format, fileName, exportedAt, editRevision, targetPath }`，返回给渲染层的回执形状沿用 Feature A `{ resultId, fileName, kind }`。

## 10. 录制域流程（W2）

`createRecordWindow({ display, selectionBounds, capture })`：

1. 若已有**活动**控制窗口（`isTaskActive()`）→ 不新建、不清理：`show()/focus()` 既有窗口并返回它（重复入口仲裁）。
2. 合并配置：`capture`（工作台传入）> `getSettings().record` > 默认值；`frameRate/quality/countdown/audio/deviceId` 全部归一化。
3. 记录 `_recordCaptureConfig`（含 target 描述）；窗口创建流程沿用现有 frame+control 双窗与 display-media handler（保留 content protection、源精确绑定）。
4. `record:start-session` 时：用项目服务 `createProject()` 建项目 → `recordingService.startSession({ directory: project.directory, projectId })` → 返回 `{ id, projectId }`。
5. `record:append-chunk`：校验会话 → `appendChunk(..., { sequence })` → 节流 `projectService.checkpoint()`（不阻塞 ACK）。
6. `record:finish-session`：`recordingService.finishSession()` → 探测（`probeSession`）→ `projectService.sealProject()` → 打开编辑器窗口（`openEditor(projectId)`）→ 关闭控制条（`closeRecordFlow()`，但会话改为项目级：`detachSession`，不删目录）。失败时返回 `{ ok:false, code }`，控制条保留可重试/放弃。
7. `record:cancel-session`：`projectService.deleteProject()` + `cleanupSession`（项目目录由项目服务删除）；控制条回到就绪态（不关窗）。
8. `pauseResumeActive()` / `finishActive()` / `focusActive()` / `getActiveState()`：托盘与快捷键入口；通过推送命令给渲染层实现。

`openEditor(projectId)`：

- 同项目已有窗口 → focus 并返回。
- 项目 `capturing` → 拒绝。
- `recoverable` → 尝试恢复（W1 的探测；可用则 markReady），失败也允许打开（`recovery.errorCode` 传给编辑器，导出禁用）。
- 确保会话存在：`registerPersistedSession`（幂等）。
- 窗口：`role:'record-editor'`、`record/editor.html`、`width 1120 height 760 minWidth 820 minHeight 600`、`resizable:true`、`maximizable:true`、`frame:false`、`backgroundColor` 用 `windowBackdropColor`、`show:false`，`ready-to-show` 时定位（沿用 `positionAutomationWindow` 语义：测试/自动化窗口放副屏）。窗口关闭只 detach，不删项目。
- `ownsEditorWindow(win)` 供 ipc-security 的 `authorizeRole` 使用。

`shutdown()`：先 dispose 导出服务 → 关闭控制条/编辑器 → `projectService.dispose()` → `recordingService.dispose()`（项目会话只 detach）。

## 11. 编辑器渲染层（W5）

- `record/editor.html`：frameless，自绘标题栏（拖拽区 `-webkit-app-region: drag`，最小化/关闭按钮走 `record-editor:window`）；三区：顶部（名称、自动保存状态、返回记录、导出）、中央大预览 `<video>`、底部时间线；右侧按需面板（首期只做“导出参数”：格式 MP4/GIF、GIF 长边/帧率、最终宽×高展示）。
- 时间线：单轨双手柄（左/右），点击拖动/键盘可调，时间输入框精确输入，播放头移动不改变裁剪范围；`播放所选`。区间合法性复用 `shared/recording-export-options.js` 的 `normalizeRange`。
- 草稿：编辑变化 debounce ≤ 500ms 调 `save-draft`；`pagehide`/关闭前再发一次；收到 `revision-conflict` 时提示并重载项目。
- 导出：唯一主按钮。提交后冻结控件；`record:export-progress` 更新进度；成功显示结果条（open/address/reveal 走 `export:perform-action`）；失败可重试；取消后恢复可编辑。
- 探测失败/恢复态：显示错误说明 + 重试 + 打开素材目录；**不显示假时长、不显示可导出**。
- 窄屏/高 DPI：布局用 flex/grid 自适应，最小宽度 820。

## 12. 控制条渲染层（W3）

- 状态机：`idle → preparing → countdown → recording ↔ paused → finalizing`（沿用并补齐现有 `setState`）。计时剔除暂停时长；暂停时状态文字 + 颜色双提示。
- 常驻结构：`状态点 · 00:12 | 麦克风(仅启用时) | 暂停/继续 | 完成 | 更多`；“更多”展开：标注工具（现有整套）+ 音量 + 放弃本次。标注收起时 frame 窗 `setIgnoreMouseEvents(true)` 保持穿透。
- 倒计时来自 `init.countdownSeconds`（0 = 直接开始；3/5 秒），准备阶段（设备/首帧就绪）不计入成片。
- 质量：`MediaRecorder` 的 `videoBitsPerSecond` 用 `qualityBitsPerSecond(init.quality)`；VP9 优先逻辑保留。
- 麦克风：`audio.microphone` 为真时用 `deviceId` 精确约束采集；静音按钮切换麦克风 bus 的 GainNode（不动系统音）；未启用麦克风时不显示可恢复的“静音中”假象。
- 分片：每秒 timeslice，`appendChunk` 带自增 `sequence` 与 `bytes`；ACK 失败/缺口 → 进入错误态（暂停/停止 + 明确提示），不得继续伪装正常录制。
- 完成：显示“正在整理录制” → 调 `record:finish-session` → 成功后不做任何导航（主进程会打开编辑器并关控制条）；失败显示原因可重试。
- 后端推送的 `record:command` 必须走与按钮相同的 `applyCommand`；`record:state` 每次状态变化都推送。
- 删除 `record.html` 的 `previewView` 整段（视频/裁剪/格式/保存 MP4/结果条）以及对应脚本引用；`record.js` 里预览/裁剪/`saveMp4` 分支一并移除。标注、frame 窗、音源、合成、性能上报全部保留。

## 13. 验收（每条工作流自测）

1. `node --test <自己负责的测试文件>` 全绿；新增行为必须有**行为级**测试（不要只断言字符串存在）。
2. `node scripts/check-js.js`、`node scripts/check-architecture.js`、`node scripts/check-i18n.js --max 606` 通过。
3. 新增 UI 文案一律 i18n（三语言键齐全、键形状合法）；`main/**`、`record/**`、`config/**` 新增代码**不允许出现中文行**（i18n 扫描区，现有余量只有 13 行；main 进程 `throw` 行豁免但也不要加）。
4. 不破坏既有测试语义：可以迁移测试目标文件（如预览布局探针从 record.html 移到 editor.html），但不能删除断言意图。
5. 完成后在共享任务里报告：改了哪些文件、跑过哪些命令、遗留风险。**不要**宣称跑过没跑的测试。

## 13.5 E2E 专用合成采集源（测试钩子，Lead 已确认）

这台自动化主机的显示适配器**无法初始化桌面复制**（实测：`--enable-features=AllowWgcScreenCapturer` / `--disable-gpu` 等组合下 `getDisplayMedia` 均报 `Could not start video source`，Chromium 日志 `Cannot initialize any DxgiOutputDuplicator instance`），因此真实屏幕采集无法在本机验证。为了仍然能自动验证“采集→分片→封存→探测→编辑器→导出”的完整链路，加一个**只由主进程环境变量开启**的合成采集源：

- 主进程：仅当 `process.env.HIGHLIGHTER_E2E_FAKE_CAPTURE === '1'` 时，在 `record:init` 载荷里加 `fakeCapture: true`（渲染层无法自行开启）。
- 渲染层（W3，`record/record.js`）：`init.fakeCapture === true` 时跳过 `getDisplayMedia`，改为：
  - 视频：`canvas.captureStream(init.frameRate)`，画面用动画彩条 + 时间戳，尺寸取 `init.display.pixelSize`（或 selectionBounds 折算）；
  - 音频：为每个被请求的音源（系统/麦克风）各建一个 `AudioContext` oscillator + `MediaStreamAudioDestinationNode`，走**既有 audio-mixer 混音路径**；
  - 其余逻辑（合成、标注、MediaRecorder、分片、序号、暂停、完成）与真实路径完全一致。
- 该分支必须有注释说明是 E2E-only，且默认关闭；真实路径零行为变化。

## 14. 集成顺序与冲突处理

- W1 先落服务（其余流不依赖它跑测试，只依赖形状）。
- W2 落 IPC/域；W3/W4/W5 同步做渲染层，靠本契约联调。
- Lead 负责 `main.js` 装配、最终 `npm test`、`npm run check`、真实设备验证（副屏）。
- 遇到契约未覆盖的分歧：以“不破坏旧流程 + 最小改动”为准，并通知 Lead 记录。
