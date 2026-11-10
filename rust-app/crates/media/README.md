# highlighter-media（R0）

计划 §3.1 的媒体 crate。R0 只冻结**纯类型与校验**（计划 §9.1 的录屏/GIF/多段导出硬限制），
以及 R5 的 trait 骨架；运行时不引入采集、编码、FFmpeg 或 WebView 依赖（`dependencies`
为空，夹具测试用 dev-dependencies 的 serde/serde_json 解析 JSON）。

## 与 JS 基线的对照

数值以 `shared/recording-export-options.js` 的 `LIMITS` / `GIF_FRAME_RATES` /
`MAX_SEGMENTS` 为准；Rust 侧常量注明计划 §9.1 来源。`tests/export_limits_fixtures.rs`
对真实 `test/fixtures/host-parity/recording-export-options/` 分组做对照（缺失即失败，不
skip）：`limits` 逐字段严格；GIF/多段 `normalize` 用 R0 已移植的纯函数对照期望值或
`reason` 错误码。视频分辨率/质量/fps 规范化属于 R5，未移植部分在测试输出登记，不伪造通过。

语义对齐要点（改之前先读 JS 注释）：

- 导出队列：同时 1 个编码任务，最多 2 个等待（`MAX_ACTIVE_TASKS`/`MAX_QUEUED_TASKS`）。
- GIF：总保留时长 ≤ 60 s、长边 ≤ 1280 px、≤ 1200 帧、fps ∈ {10,15,20}；不放大。
- 多段导出：最多 20 段，每段 ≥ 100 ms；半开区间 `[startMs, endMs)`；按 start 排序、
  重叠显式报错（首尾相接合法且不合并）；空数组 = 整段；单段覆盖整段时规范化为
  `[{0,duration}]`。
- `estimate_gif_frames` 用 `ceil(duration*fps/1000)`（结束在帧中间也输出该帧）。

## R0 交付

- `export`：`ExportLimits`（queue/gif/segments）、`estimate_gif_frames`、
  `compute_gif_dimensions`、`normalize_gif_options`、`normalize_segments`、
  稳定错误码（与 JS 的 `code` 字符串一致）。
- `backend`：`RecordingBackend`/`ExportScheduler` trait 骨架 + R5 边界注释。

## 明确不做

- 不做采集后端、选源、双音源、编码、FFmpeg argv、任务队列状态机（R5-01～R5-05）。
- 不做鼠标事件轨/建议（R5-06）、性能与 30 分钟样例（R5-07）。
- 时间输入按**整数毫秒**处理；R5 在 JSON 边界拒绝非整数，避免把 JS `Math.round`
  的浮点舍入语义扩散到 Rust 内部。
