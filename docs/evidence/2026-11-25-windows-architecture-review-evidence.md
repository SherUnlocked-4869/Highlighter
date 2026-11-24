# Windows 架构评审 · 回归证据登记表

本表登记 docs/reviews/2026-11-24-windows-product-architecture-review.md 中每个工单的自动化证据与真机门槛。
`scripts/check-review-evidence.js` 会校验：表中每一行的工单编号都能在所列测试文件中找到，且文件存在；
每个 P0 都至少有一个回归用例。缺真实音轨、GPU 或安装包样本的项在“真机”列说明，不以模拟通过冒充真机结论。

## 工单证据

| 工单 | 优先级 | 状态 | 回归测试 | 真机/发布门槛 |
|---|---|---|---|---|
| D01 | P0 | 已实现 | test/update-service.test.js, test/update-domain.test.js, test/update-ui-contract.test.js | 隔离 NSIS 首 2 分钟与 24h 更新域名请求数为 0（release-hardware-matrix: nsis-default-offline-updates） |
| D02 | P0 | 已实现 | test/credential-store.test.js, test/settings-service.test.js, test/d02-credentials-contract.test.js | 加密不可用/跨 Windows 用户解密的真机复现；诊断包内标记出现次数为 0 |
| C01 | P0 | 已实现 | test/chunk-backpressure.test.js, test/record-control-bar.test.js, test/recording-service.test.js | 慢盘/便携盘注入（5s、30s、永久无确认、磁盘满），真实 1080p30 30 分钟无误暂停 |
| A01 | P0 | 已实现 | test/tray-menu.test.js | 游戏模式 + 控制在全屏游戏下被遮挡时从托盘结束（真机托盘交互） |
| A02 | P1 | 已实现 | test/capture-keyboard-focus.test.js, test/capture-annotation-width.test.js | Tab 到标注/撤销/保存/录制按钮逐个按 Enter/Space；讲述人读出名称 |
| A03 | P1 | 已实现 | test/shortcut-service.test.js, test/shortcut-rebind-contract.test.js, test/settings-ipc.test.js, test/shortcut-ui-contract.test.js | 第二个本地进程占住候选键后旧键仍可用；重启后仍有效 |
| A04 | P1 | 已实现 | test/usage-format.test.js, test/usage-cost-states.test.js | 深浅色 + Windows 高对比度下五类样本（图/表/tooltip）逐项比对 |
| B06 | P1 | 已实现 | test/long-capture-output.test.js | 阈值上下各一档的真实长图；慢盘快速保存与同名占用 |
| C03 | P1 | 已实现 | test/clipboard-poll-backoff.test.js | 5,000 条混合历史首屏 P95、滚动无重复/漏页（真机面板） |
| C04 | P1 | 已实现 | test/pin-image-store-async.test.js, test/pin-domain.test.js | 慢盘/SSD 上 1/10/20 张 4K PNG 的主线程停顿 P95 与句柄基线 |
| C02 | P1 | 工具已实现 | test/performance-budget.test.js | 固定机冷启 ≥20 次 + 5 轮 30 分钟待机；绝对数字只能在真机采集 |

待登记（实现完成后补行）：B02 取色器、C04 贴图溢出异步 I/O、其余 P1/P2 工单。

## 说明

- 本表只登记可以在 CI 复跑的用例；真机列写的是仍需在发布候选上执行、且不能由本地模拟替代的证据。
- 测试文件名必须真实存在且包含对应工单编号（注释或用例名均可），由 `npm run check:review-evidence` 强制。
- 新增 P0 时同一次提交必须补：实现、回归用例、本表一行、以及（如适用）config/release-hardware-matrix.json 的一条 claim。
