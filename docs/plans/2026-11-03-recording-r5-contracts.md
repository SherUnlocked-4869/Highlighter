# 录屏 R5 实施契约（冻结版）

> 日期：2026-11-03（第三轮迭代）
>
> 上游方案 §7 R5、§8.3：[2026-11-03-recording-experience-implementation-plan.md](2026-11-03-recording-experience-implementation-plan.md)
>
> 前置：[R1–R3 契约](2026-11-03-recording-r1-r3-contracts.md)、[R4 契约](2026-11-03-recording-r4-contracts.md)
>
> 本文冻结 R5（演示成片）的接口、数据、渲染规则与验收口径。**名称/形状不得单方面改名**。

## 0. 范围与原则

交付：**非破坏性外观（背景/边距/圆角/阴影）+ 手动缩放段 + 点击波纹 + 录制事件轨 + 本地自动缩放建议**，预览与导出共用同一参数求值；无事件轨的旧素材仍可手动缩放与套样式。

原则（方案 §8.3）：
- 外观/镜头只存编辑参数，不烧录进原片；原片不可变。
- 归一化坐标 0–1：镜头焦点、事件位置都是**源内容坐标**；DIP/物理像素/源像素显式转换，样式边距属于成片坐标。
- 事件轴用**媒体时间**：暂停与倒计时不进入事件轴；裁剪通过同一时间映射变换事件/镜头（源时间 → 成片时间）。
- 不记录键盘内容、剪贴板、窗口文本；事件采集与划词服务**解耦**，仅录制且用户启用“演示增强”时订阅。
- 自动建议只做本地点击聚类/驻留规则，可被用户删除/调整；不接远程模型。

## 1. 文件归属

| 工作流 | 所有者 | 写作用域 |
|---|---|---|
| W11 事件轨采集（主进程） | `p2-domain` | `main/services/pointer-hook-host.js`(新), `main/services/pointer-track-service.js`(新), `main/domains/record/index.js`, `main/ipc/recording-workbench-ipc.js`, `main/services/ipc-security.js`, `preload-record-editor.js`, `record/record.js`(仅 finish 载荷/时钟字段), `main.js`, `test/pointer-track-service.test.js`(新), `test/record-domain.test.js`, `test/ipc-security.test.js`, `test/ipc-module-contracts.test.js` |
| W12 演示渲染引擎 | `p1-persistence` | `shared/recording-demo.js`(新), `shared/recording-export-options.js`, `shared/recording-project-schema.js`, `main/services/recording-project-service.js`, `main/services/recording-export-service.js`, `test/shared-recording-demo.test.js`(新), `test/recording-export.test.js`, `test/recording-project-service.test.js`, `test/recording-project-schema.test.js` |
| W13 编辑器 UI/预览 | `p5-editor` | `record/editor.html`, `record/editor.js`, `record/editor.css`, `record/editor-timeline.js`, `record/trim-controller.js`, `shared/locales/recording-editor.js`, `scripts/probe-recording-editor-layout.js`, `test/recording-editor-ui.test.js`, `test/recording-trim-ui.test.js` |
| W14 工作台选项 | `p4-workbench` | `config/routes/recording.js`, `shared/locales/recording.js`, `preload.js`, `test/recording-workbench-ui.test.js` |

**Lead 独占**：`docs/plans/*`, `e2e/**`, 冲突修复、门禁、文档、提交推送。

## 2. 事件轨（W11）

### 2.1 采集源

独立 utility process：`main/services/pointer-hook-host.js` 加载 `selection-hook`，`start({ enableClipboard:false })` + `enableMouseMove()`；**不订阅/读取文本选择或剪贴板**。与划词 hook 相互独立（可同时存在两个 WH_MOUSE_LL）。

- 移动节流：默认 20Hz（`>=50ms` 且坐标变化）；`pointer` 事件含 `{ kind:'move'|'down'|'up', x, y, button, at }`（x/y = 物理屏幕像素，at = `Date.now()`）。
- `main/services/pointer-track-service.js`：`start()` / `stop()` / `results()`；有界缓冲（pointer ≤ 20000、clicks ≤ 2000，超出丢弃最旧并计数）；stop 有超时（1s，超时 kill）；测试注入 host 工厂（不需要真实原生 hook）。

### 2.2 录制域接线

- `captureConfig.demoEnhance === true` 且目标模式 ∈ `display|region` 时：`record:start-session` 启动采集；`finish-session`/`cancel-session`/控制窗关闭/应用退出停止并清理。窗口模式（`mode:'window'`）**不采集**（无窗口屏幕边界，坐标不可靠），事件轨为 null。
- 渲染层在 `record:finish-session` 载荷增加 `{ mediaStartedAtWall, pausedIntervals: [{startWall,endWall}] }`（`record.js` 在 `MediaRecorder.start()` 时取 `Date.now()`，暂停/继续时记录区间）。主进程把事件墙钟映射为媒体毫秒：`mediaMs = at - mediaStartedAtWall - 已发生的暂停时长`；丢弃 `<0` 或 `> 媒体时长` 的事件（媒体时长以 finish 后探测结果为准）。
- 坐标归一化：`screen.screenToDipPoint({x,y})`（不可用回退 `x/scaleFactor`）→ 相对内容区（display 模式 = display.bounds；region 模式 = selectionBounds）→ `(px - left)/width`，clamp 0–1，保留 3 位小数；内容区外的点丢弃。
- 落盘：`projectService.writeEventTrack(projectId, track)` 写 `<project>/events.json`（原子写，schema 见 §2.3）；失败只记录日志，不影响完成录制。窗口模式/未启用 → 不写文件。
- 编辑器 IPC（`record-editor` 角色）：`record-editor:events` invoke `{ projectId }` → `{ ok:true, track }` / `{ ok:true, track:null }` / `{ ok:false, code:'not-found' }`。track 只含数据，不含路径。

### 2.3 `events.json` schema v1

```json
{
  "schemaVersion": 1,
  "durationMs": 12345,
  "sampledAtHz": 20,
  "pointer": [{ "tMs": 0, "x": 0.512, "y": 0.334 }],
  "clicks": [{ "tMs": 1200, "x": 0.51, "y": 0.33, "button": 0 }],
  "truncated": false
}
```

规则：`tMs` 为媒体时间（非负整数，≤ durationMs）；x/y 归一化 0–1；pointer 按时间升序、同坐标去重；clicks 只保留 `button 0/1/2`；读入时限长与数量上限，非法条目丢弃。

## 3. 演示渲染（W12）

### 3.1 `shared/recording-demo.js`（新模块，纯函数，UMD）

```js
DEMO_DEFAULTS = { enabled:false, background:'#0f1115', padding:0.08, radius:12, shadow:true, ripples:false }
STYLE_LIMITS = { paddingMin:0, paddingMax:0.2, radiusMin:0, radiusMax:24 }
ZOOM_LIMITS = { maxSegments:8, minDurationMs:600, scaleMin:1.25, scaleMax:3, rampMs:300 }
RIPPLE_LIMITS = { maxClicks:30, durationMs:600, basePx:28, growPx:96 }
BACKGROUND_PRESETS = ['#0f1115','#1e1e1e','#f5f2ea','#0a2540']   // 深/浅/品牌色，UI 展示色块

normalizeDemoStyle(value)       -> { enabled, background, padding, radius, shadow, ripples }
normalizeZoomSegments(value)    -> [{ id, startMs, endMs, scale, focusX, focusY, easing }]  // 源时间；排序；不重叠；时长≥600；scale 1.25–3；focus 0–1；最多 8 段；easing 'linear'|'ease-in-out'
normalizeClickTrack(value)      -> { durationMs, pointer:[], clicks:[], truncated }
mapDemoToOutput({ style, zooms, clicks }, segments) -> {
  style, zooms: [{ startMs,endMs,scale,focusX,focusY,easing }], clicks: [{ tMs,x,y,button }]
}   // 源时间 -> 成片时间：裁剪掉删除区间内的事件/镜头；跨越删除区间的镜头按保留部分截断；
    // 重叠/相接后合并；输出按 startMs 排序；无保留内容时为空
resolveDemoCanvas({ sourceWidth, sourceHeight, resolution, style }) -> {
  contentWidth, contentHeight,   // R4 分辨率档位结果（偶数）
  canvasWidth, canvasHeight,     // 加边距后的成片尺寸（偶数）
  paddingPx, radiusPx
}   // canvas = content / (1 - 2*padding)，偶数；padding=0 或 style.enabled=false 时 canvas=content
suggestZoomSegments({ track, durationMs, outputSegments? }) -> suggestion[]  // 见 §3.4
zoomExpression({ zooms, fps, contentWidth, contentHeight }) -> { z,x,y }   // ffmpeg zoompan 表达式（见 §3.3）
```

### 3.2 导出请求扩展

```js
request.demo = {
  style: <normalizeDemoStyle 值>,
  zooms: [<源时间 zoom 段>],
  clicks: [<源时间 click>]        // 仅当 style.ripples 且编辑器有事件轨
}
```

规则：`demo` 可选；`style.enabled=false` 且无 zooms/ripples 时与 R4 输出等价（expected 不含 demo）。`normalizeExportRequest` 增补 `demo` 归一化（非法 → `invalid-demo-option`），并把源时间映射为成片时间后放入 value。`expected` 增补 `{ demoRendered: boolean, contentWidth, contentHeight }`；成片宽高即 `resolveDemoCanvas` 的 canvas 尺寸。

### 3.3 导出渲染（`main/services/recording-export-service.js` + sharp 生成素材）

仅当 `demoRendered === true` 走增强路径（否则完全沿用 R4 参数）：

1. **素材生成（Node + sharp，导出前一次性）**：
   - `bg.png`（canvasWidth×canvasHeight）：背景色 + 阴影（内容区域下方/四周模糊黑色圆角矩形；`shadow=false` 时无阴影）。
   - `mask.png`（contentWidth×contentHeight）：白色圆角矩形（radius 按 content 尺寸缩放，白=不透明），用于圆角裁切。
   - `ripple.png`（`RIPPLE_LIMITS.basePx*2` 见方）：白色圆环/半透明圆，边缘柔和。
   素材放目标临时目录旁，导出结束/失败清理（沿用临时文件清理纪律）。
2. **滤镜链顺序**：
   `concat 基础视频 → scale=contentWidth:contentHeight → [ripples overlay] → zoompan(z,x,y, s=contentWidth×contentHeight, fps) → alphamerge(mask) → overlay bg at padding offset → format=yuv420p`
   - 有音轨时音频分支不变（trim/atrim + concat），demo 不影响音频。
   - 圆角：`[content][mask]alphamerge`（mask 循环输入 `-loop 1 -framerate <fps> -i mask.png`）；无圆角/无阴影但有背景时仍走 overlay bg。
   - 波纹：每个 click 一个循环输入 `-loop 1 -framerate <fps> -i ripple.png`，滤镜 `[k:v]scale=w='<growPx>*(0.35+0.65*min(1,t/0.6))':h=...:eval=frame,format=rgba[rk]`，`overlay=x=<cx*contentW - size/2>:y=...:enable='between(t,<start>,<end>)'`（start = clickMs, end = +600ms，成片时间）；最多 30 个。
   - 缩放：`zoompan=z='<zoomExpression.z>':x='<zoomExpression.x>':y='<zoomExpression.y>':d=1:s=<contentW>x<contentH>:fps=<fps>`；表达式用 `on`（输出帧号）换算秒；每段 300ms 线性入出；焦点 `x=clip(fx*iw-(iw/zoom/2),0,iw-iw/zoom)`、`y` 同理；无缩放段时用常量 `z=1:x=0:y=0`（或省略 zoompan）。
3. 校验：`expected.width/height` = canvas 尺寸；`demoRendered` 仅作为信息字段，不额外改变时长容差。

### 3.4 自动缩放建议（本地规则）

`suggestZoomSegments({ track, durationMs })`：

1. **点击聚类**：2s 窗口 + 0.18 归一距离内 ≥2 次点击成一个簇；焦点=簇质心；scale = `min(2.2, 1.4 + 0.2 * count)`；区间 = `[firstClick-800ms, lastClick+1200ms]`，clamp 到 [0,duration]，最短 1.2s。
2. **驻留**（pointer 轨）：连续 ≥1.2s 位移 <0.04 视为驻留；焦点=驻留中心；scale 1.6；区间 = 驻留前后各扩 600ms。
3. 合并重叠/相邻建议，最多 5 条，按 startMs 排序；每条带 `id,startMs,endMs,scale,focusX,focusY,reason:'clicks'|'dwell'`。
4. 纯本地、确定性；无事件轨时返回 []。

## 4. 编辑器（W13）

### 4.1 数据与草稿

- 草稿 `edit.style`（normalizeDemoStyle）、`edit.zoomSegments`（**源时间**，normalizeZoomSegments）随现有 CAS 保存；`edit.format/gif` 沿用。
- `edit.revision` 语义不变。

### 4.2 预览（与导出同参）

- 预览区包一层“成片画布” `#demo-preview-frame`（宽高比 = canvas），内部内容框按 padding 缩放，背景色/圆角/阴影用 CSS；`style.enabled=false` 时画布=原视频。
- 缩放：按当前播放头（源时间→成片时间映射）计算 zoom 段生效值与焦点，对 `<video>` 施加 `transform: scale(z) translate(...)`（focus 为变换原点），过渡 300ms；播放头移动不修改参数。
- 波纹：`style.ripples && clicks` 时，播放到 click 时间点（成片时间）在预览画布上播放 600ms 扩散动画（CSS keyframes），位置=click 归一坐标。
- 事件轨状态：`#events-status`（“已记录 N 次点击 / 无事件轨，可手动添加缩放”）；无事件轨时波纹开关禁用并提示。

### 4.3 控件（真实按钮/输入，新增 id/data-testid）

| id | 行为 |
|---|---|
| `demo-enabled` | 样式总开关（默认关） |
| `demo-background` | 背景色（4 预置 + 自定义色值输入 `demo-background-custom`） |
| `demo-padding` | range 0–20（%），显示当前值 |
| `demo-radius` | range 0–24（px） |
| `demo-shadow` | 复选框 |
| `demo-ripples` | 复选框（无事件轨时禁用） |
| `zoom-add` | 在播放头处添加 2.0x 缩放段（焦点=中心，最短 1.2s，clamp），≤8 段 |
| `zoom-list` / `zoom-item` | 段列表，含 `zoom-item-focus`（拾取焦点按钮：点击预览设置焦点）、`zoom-item-scale`（range 1.25–3）、`zoom-item-delete` |
| `zoom-suggestions` / `zoom-suggestion-add` / `zoom-suggestion-ignore` | 自动建议列表（来自 `record-editor:events` + 本地算法），一键添加/忽略 |
| `demo-reset` | 恢复默认样式与空缩放 |

- 导出请求附带 `demo`（style + zooms + clicks（仅 ripples 开启时））；导出中冻结全部演示控件；空选择仍禁导出。
- 所有新文案三语言 i18n；`record/**` 零新增中文行。

### 4.4 交互细节

- 缩放焦点拾取：点击预览画面 → 归一坐标；`Escape` 取消拾取。
- 缩放段与裁剪多段独立：裁剪后仍保留源时间参数，导出时自动映射；跨越删除区间的段按保留部分截断或丢弃（映射规则见 §3.1）。
- 撤销/重做只覆盖分段编辑（缩放/样式不进入 R4 的 undo 栈；样式改动走草稿自动保存）。

## 5. 工作台（W14）

- 录制参数区新增“演示增强”开关 `data-testid="demo-enhance"`：说明“记录鼠标移动与点击，用于缩放建议与点击波纹；不记录键盘内容，仅本次录制生效”，默认关；`record:workbench-start` 的 `config.demoEnhance` 透传；记录卡详情可显示“含演示事件”（当 `ProjectSummary` 有事件轨时——若 W11/W12 不扩 summary 则此项可不做，见 §7）。
- 设置页不改（会话内开关）。
- 三语言 key；`config/**` 零新增中文行。

## 6. 验收

| 层面 | 必测 |
|---|---|
| 事件轨 | pointer-track-service 生命周期/有界缓冲/超时 kill；域：demoEnhance 门控、窗口模式不采集、墙钟→媒体映射（含暂停区间）、坐标归一（display/region、越界丢弃）、events.json 原子写与读取上限；IPC 越权/项目归属 |
| 映射/算法 | mapDemoToOutput（跨删除区间截断、全删除为空）、resolveDemoCanvas（边距/偶数/不放大）、suggestZoomSegments（聚类/驻留/合并/上限/确定性） |
| 导出渲染 | **真实 ffmpeg + 抽帧断言**：开启样式后成片尺寸=canvas、边角像素=背景色（圆角外）、内容区中心像素≠背景色；缩放段后同一时间点画面区域被放大（对比无缩放样片中心区域像素差异/尺寸关系）；波纹开启后点击时刻帧在点击坐标附近出现非背景像素、关闭时无；无 demo 请求输出与 R4 等价；demo 校验错误码 |
| 编辑器 | 样式控件默认值/范围/草稿往返；缩放添加/删除/焦点拾取/上限；自动建议渲染与添加；预览 transform 与画布比例；无事件轨提示与波纹禁用；导出中冻结；i18n 完整；布局探针（DPR 1.5、窄屏 820×600）通过 |
| 工作台 | demoEnhance 开关默认值/载荷/持久选择（会话内）；三语言 |
| E2E（Lead） | 预置含 events.json 的项目 → 编辑器开启样式+波纹+添加缩放 → 导出 MP4/WebM → ffmpeg 抽帧验证（canvas 尺寸、背景/圆角、水印波纹时刻、缩放下画面放大）→ 关闭重开草稿保留 demo 参数 |

门禁：目标测试 → check-js → check-architecture → check-i18n（`--max 606`）。新增扫描区代码零中文行，英文注释。

## 7. 已知限制（本轮接受）

1. 窗口录制无事件轨（坐标不可靠）；无事件轨素材仅支持手动缩放。
2. 事件采集依赖原生 hook；本机无法验证真实鼠标轨迹与点击对齐（需真机），但服务/映射/算法有单测，导出渲染用合成事件轨验证。
3. 波纹动画为单图标量缩放（非逐帧渲染），缩放过渡为线性/缓入出，不做镜头抖动/自动跟焦。
4. 演示参数是会话内编辑，不写入导出记录；样式仅支持纯色背景（不支持图片/渐变）。
5. `ProjectSummary` 不新增事件轨字段（工作台卡片不显示“含演示事件”）；编辑器通过 `record-editor:events` 判定。
6. 事件轨采样 20Hz，快速移动可能漏点；点击对齐精度受 MediaRecorder 时间戳与墙钟误差影响（±1 帧量级）。
