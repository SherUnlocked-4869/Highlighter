# 录屏合成帧率优化

- 日期：2026-08-12
- 基线提交：`ccedd2e`
- 目标帧率：24 FPS（默认）

## 问题

旧实现使用无限 `requestAnimationFrame` 重绘完整录制区域。Canvas 视频流虽然配置为 24 FPS，
但 60/120/144/160 Hz 显示器仍会按显示刷新率执行桌面裁剪、全帧 `drawImage` 和标注合成。
暂停录制和 3 秒倒计时期间也继续重绘。

## 改动

- 优先使用 `HTMLVideoElement.requestVideoFrameCallback()`，仅在桌面视频提交新帧时尝试合成。
- 使用基于绝对时间的 frame pacer 将高频回调限制到目标录制 FPS；长时间调度漂移不会累积。
- 不支持视频帧回调时，按目标 FPS 使用 timer fallback，不再跟随显示刷新率。
- 标注快照只请求下一次受节流的合成帧，多次输入自动合并。
- 倒计时只准备首帧；开始录制后才启动持续合成，暂停时停止，恢复时继续。
- 停止录制后取消视频、timer 和标注回调，并把 callback/render/skip/effective FPS 写入本地性能日志。

## 调度模型结果

`npm run bench:performance` 对 60 秒回调序列进行确定性模拟：

| 显示刷新率 | 旧全帧绘制 | 新全帧绘制 | 减少 |
|---|---:|---:|---:|
| 60 Hz | 3,600 | 1,440 | 60.00% |
| 144 Hz | 8,640 | 1,440 | 83.33% |

该数据证明调度器避免的全帧绘制次数，不等同于真实 CPU/GPU 降幅。真实录屏结束时新增的
`record.compositor` 与 `performance-snapshot` 事件会记录有效 FPS 和进程资源，后续在 1080p/4K、
5 分钟录制场景中完成 CPU、GPU、掉帧、内存和输出质量 A/B 验收。

## 回归边界

- 输出仍使用原始 `canvas.captureStream(frameRate)`、MediaRecorder 和 FFmpeg MP4 流程。
- 标注在 recording/paused 状态继续接受输入；暂停期间的最终快照在恢复首帧合成。
- 不改变码率、编码器优先级、分辨率、帧率设置或文件格式。
