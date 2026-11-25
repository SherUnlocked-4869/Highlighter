# Windows 架构评审 · 回归证据登记表

本表登记 docs/reviews/2026-11-24-windows-product-architecture-review.md 中每个工单的自动化证据与真机门槛。
`scripts/check-review-evidence.js` 会校验：表中每一行的工单编号都能在所列测试文件中找到，且文件存在；
每个 P0 都至少有一个回归用例。缺真实音轨、GPU 或安装包样本的项在“真机”列说明，不以模拟通过冒充真机结论。

## 工单证据

| 工单 | 优先级 | 状态 | 回归测试 | 真机/发布门槛 |
|---|---|---|---|---|
| D01 | P0 | 已实现（03：重置与自动检查共用启停） | test/update-service.test.js, test/update-domain.test.js, test/update-ui-contract.test.js, test/settings-effects.test.js | 隔离 NSIS 首 2 分钟与 24h 更新域名请求数为 0（release-hardware-matrix: nsis-default-offline-updates） |
| D02 | P0 | 已实现（04：显式会话覆盖与端点绑定） | test/credential-store.test.js, test/settings-service.test.js, test/d02-credentials-contract.test.js | 加密不可用/跨 Windows 用户解密的真机复现；诊断包内标记出现次数为 0 |
| C01 | P0 | 已实现（01/02：中断收尾、已确认前缀与恢复回执） | test/chunk-backpressure.test.js, test/record-control-bar.test.js, test/recording-service.test.js, test/record-finalize.test.js, test/record-domain.test.js, test/recording-project-service.test.js | 慢盘/便携盘注入（5s、30s、永久无确认、磁盘满），真实 1080p30 30 分钟无误暂停 |
| A01 | P0 | 已实现 | test/tray-menu.test.js | 游戏模式 + 控制在全屏游戏下被遮挡时从托盘结束（真机托盘交互） |
| A02 | P1 | 已实现 | test/capture-keyboard-focus.test.js, test/capture-annotation-width.test.js | Tab 到标注/撤销/保存/录制按钮逐个按 Enter/Space；讲述人读出名称 |
| A03 | P1 | 已实现（09/11：逐键恢复与释放同步映射） | test/shortcut-service.test.js, test/shortcut-rebind-contract.test.js, test/settings-ipc.test.js, test/shortcut-ui-contract.test.js | 第二个本地进程占住候选键后旧键仍可用；重启后仍有效 |
| A04 | P1 | 已实现 | test/usage-format.test.js, test/usage-cost-states.test.js | 深浅色 + Windows 高对比度下五类样本（图/表/tooltip）逐项比对 |
| B02 | P1 | 已实现 | test/capture-color-picker.test.js | 100%/150%/200% 已知 sRGB 色值 PNG 逐点比对；剪贴板写入端到端 |
| B06 | P1 | 已实现（10：真实路径回执与历史失败分离） | test/long-capture-output.test.js, test/long-capture-completion.test.js | 阈值上下各一档的真实长图；慢盘快速保存与同名占用 |
| C03 | P1 | 已实现 | test/clipboard-poll-backoff.test.js | 5,000 条混合历史首屏 P95、滚动无重复/漏页（真机面板） |
| C04 | P1 | 已实现（16：排队可撤销与按字节硬上限） | test/pin-image-store-async.test.js, test/pin-domain.test.js | 慢盘/SSD 上 1/10/20 张 4K PNG 的主线程停顿 P95 与句柄基线 |
| A05 | P1 | 已实现 | test/clipboard-preview.test.js | 20 张相似图首次粘贴正确率（5 人）；30 次预览释放（真机面板） |
| A06 | P1 | 已实现（图标素材待补） | test/tray-menu.test.js, test/first-run-guidance.test.js | 5 名新用户 60 秒首框；16/24/32 托盘素材与深浅任务栏 |
| D03 | P1 | 已实现（17：编辑器抢救按钮已接线） | test/recording-salvage.test.js, test/recording-editor-ui.test.js | 真实强制结束/截断 WebM 的重封装与播放 |
| B01 | P1 | 已实现（05 原生私密写入已接线；12 全局历史与本次跳过已分离） | test/capture-skip-history.test.js, test/capture-pin-copy.test.js, test/clipboard-paste.test.js | 唯一测试图在截图历史/剪贴板历史/自动存盘三区新增 0；原生排除格式 |
| B03 | P1 | 已实现 | test/pin-copy-once.test.js, test/capture-pin-copy.test.js | 真机 0/90/180/270 视图导出朝向与高 DPI；预览对话框 |
| B08 | P2 | 已实现（仅素材帧） | test/recording-pin-frame.test.js | 真实 VFR 视频的 ≤1 帧偏差与去段后取帧 |
| A07 | P2 | 已实现（14：托盘随布局刷新） | test/pin-snap-geometry.test.js, test/pin-display.test.js, test/tray-menu.test.js | 真机 100%+150%/负坐标副屏/拔屏/20 张定位与 ≤1 DIP 吸附 |
| C05 | P2 | 實驗路徑已实现（默认关闭） | test/recording-direct-track.test.js, test/measure-recording-encode.test.js | 核显/独显 × 1080p30/4K30 成对样本；CPU/掉帧/音画差门槛 |
| B04 | P1 | 已实现（13：5 秒总期限与迟到授权回收） | test/recording-audio-preflight.test.js, test/recording-audio-preflight-ui.test.js | 真实四组合音轨、权限拒绝、蓝牙拔出与 5 秒采样/1 秒释放 |
| B05 | P1 | 已实现（部分数字为估算） | test/clipboard-capacity.test.js, test/clipboard-capacity-ui.test.js, test/clipboard-capacity-domain.test.js | 真实侧车 500 项/预算样本与面板视觉验收 |
| D05 | P1 | 已实现（18：托盘恢复子菜单与另存取消） | test/window-resilience.test.js, test/window-resilience-tray.test.js, test/pin-crash-recovery.test.js, test/tray-menu.test.js | 打包版 10 次启动单实例、Explorer 重启、睡眠唤醒、便携登录项 |
| D06 | P1 | 已实现 | test/review-evidence.test.js | 候选包与 CI 运行/真机记录的可追溯性 |
| B07 | P2 | 已实现（明细成本仍按最新价） | test/usage-export.test.js, test/usage-export-import.test.js, test/usage-export-ui.test.js | 真实日志轮转样本与跨版本价格复算 |
| D04 | P1 | 已实现（06/07/08/19：历史索引、编辑引用、按模块停写、生产迁移钩子） | test/data-root-backup.test.js, test/data-root-backup-ui.test.js | 普通安装与便携从上一受支持版本实机恢复；坏包/盘满/中途终止 |
| C06 | P2 | 工具已实现 | test/release-size.test.js | 两个相邻 NSIS 候选 + blockmap 的差分传输与安装耗时 |
| C02 | P1 | 已实现（15：逐指标样本与报告列，缺测阻断） | test/performance-budget.test.js | 固定机冷启 ≥20 次 + 5 轮 30 分钟待机；绝对数字只能在真机采集 |

待登记（实现完成后补行）：B02 取色器、其余 P1/P2 工单。

## 2026-11-25 修复计划 · 19 项交付登记

计划：`docs/plans/2026-11-25-windows-architecture-review-fix-plan.md`。分支 `fix/windows-architecture-review-2026-11-25`。
“已通过入口”写的是回归用例真正驱动的那条生产路径（渲染层 → preload → 主进程 / 主进程服务 API）。

| 项 | 工单 | 修复提交 | 回归用例（文件） | 已通过的生产入口 | 未完成的真机门槛 |
|---|---|---|---|---|---|
| 01 | C01 | 5781855 | test/record-finalize.test.js, test/record-domain.test.js | 真实 record/record.js（假窗口）：停止/托盘/热键共用一次收尾、ACK 期限、迟到 ACK 隔离；record:finish-session 恢复回执 | 1080p30 连录 30 分钟无误暂停；5 s/30 s/永久无 ACK 的慢盘注入 |
| 02 | C01 | 5781855 | test/recording-service.test.js, test/recording-project-service.test.js | RecordingService.appendChunk/finishSession（真实临时目录）：已确认前缀、残尾截断、无确认素材、重启只信文件 | 真实盘满卷；真实 WebM 解码至最后有效帧 |
| 17 | D03 | 6f1b5db | test/recording-salvage.test.js, test/recording-editor-ui.test.js | 编辑器窗口（假 DOM）：抢救/取消按钮 → preload salvage/cancelSalvage；单任务、切换项目丢弃迟到回执、盘满/无可解码分别提示 | 带音轨的真实截断 WebM 打开-抢救-播放-重开；FFmpeg 进程清理 |
| 13 | B04 | 6f1b5db | test/recording-audio-preflight.test.js, test/recording-audio-preflight-ui.test.js | 录制条与设置页真实流程（假时钟/假设备）：5 秒总期限从点击起算、迟到授权立即 stop、重检释放上一轮 | 静音/仅系统/仅麦克风/双路真机组合，含蓝牙断开 |
| 03 | D01 | 2f5d1bb | test/settings-effects.test.js, test/update-service.test.js | settings-effects.applyUpdate/applyReset + 真实 UpdateService（假时钟）：重置撤销定时器、重新开启、手动检查一次一次 | 隔离 NSIS 观察首 2 分钟与 24 h 更新域名请求为 0；便携包不启动更新器 |
| 04 | D02 | 2f5d1bb | test/credential-store.test.js, test/settings-service.test.js, test/d02-credentials-contract.test.js | CredentialStore 覆盖表 + SettingsService.persistSettings/prepareProviderConnection：新值胜出、端点绑定、核验密文后才移除覆盖、清空核验 | 真实 DPAPI 不可用复现；诊断包/备份明文标记命中 0 |
| 05 | B01 | 2f5d1bb | test/capture-skip-history.test.js, test/clipboard-paste.test.js | capture.copy（真实 domain）→ 注入的 native writer；ClipboardService.publishImage 真实请求/临时文件/回执；无 writer 不降级 | Win+V 剪贴板历史、原生 writer 端到端粘贴、剪贴板占用重试 |
| 12 | B01 | 2f5d1bb | test/capture-skip-history.test.js | capture.copy 四行表（全局历史 × 本次跳过）；渲染层不再把全局关闭当成本次跳过 | 重启后按唯一测试图核对目录与两类历史 |
| 08 | D04 | 523001e | test/data-root-backup-ui.test.js | data-root domain（假服务）：校验先行、仅设置不停写、按模块 quiesce、录屏中拒绝并回传任务 | 真实录屏/导出/长截图进行中做仅设置备份的候选包验证 |
| 06 | D04 | 523001e | test/data-root-backup.test.js, test/data-root-backup-ui.test.js | createBackup/restoreBackup（真实文件树）：历史独立索引、settings 纯净、旧包敏感标记、仅历史恢复发布索引 | 真实重启后读取历史列表；旧组合包/索引校验失败样本 |
| 07 | D04 | 523001e | test/data-root-backup.test.js | restoreBackup：docPath/baseImagePath/resultImagePath 重写、外部引用保持、越界拒绝 | 真机通过历史入口打开-再编辑-撤销-导出 |
| 19 | D04 | 523001e | test/data-root-backup.test.js, test/data-root-backup-ui.test.js | data-root domain → backup-migrations 生产钩子：暂存根校验、支持窗口、回滚保留原根 | 安装版/便携版上一受支持版本跨版本恢复 |
| 09 | A03 | beb7c80 | test/shortcut-service.test.js, test/shortcut-rebind-contract.test.js | shortcut-service.registerAll（逐键）+ 域 register；设置页改键仍走事务 sync | 独立本地进程占住 F2 的真实注册表验证 |
| 11 | A03 | beb7c80 | test/shortcut-service.test.js | sync：清空后映射同步移除，重新启用真的注册；交换/回滚/被抢占逐键报告 | Windows 真实按键验证 |
| 10 | B06 | beb7c80 | test/long-capture-completion.test.js, test/long-capture-output.test.js | longFinish（真实 domain）：实际路径回执、历史失败分离、重名新名、重复完成一次 | 慢盘快速保存与同名占用的候选包验证 |
| 14 | A07 | beb7c80 | test/tray-menu.test.js, test/pin-domain.test.js | main.js 接线：onPinLayoutChange/onRecoverableChange → createTrayIcon；菜单每次读实时布局 | 真机托盘首张/第二张/移动/穿透 |
| 18 | D05 | beb7c80 | test/pin-crash-recovery.test.js, test/tray-menu.test.js | pin domain trayRecoveryMenu + buildTrayMenuTemplate：恢复/另存/丢弃、上限后仅另存、取消保留、私密标志与布局随恢复保留 | 打包版异常退出后的托盘交互与 TTL 过期 |
| 15 | C02 | 7fd4022 | test/performance-budget.test.js | evaluateBaseline/currentFromReport + startup-baseline 采集器（真实子进程）：逐指标缺测阻断、重复轮次、超时回收 | 固定机 ≥20 次冷启 + 5 轮 30 分钟待机（仅采集） |
| 16 | C04 | 7fd4022 | test/pin-image-store-async.test.js, test/pin-domain.test.js | createPinImageStore：释放即出队、仅两个在途计费、按字节硬上限、单图额度、盘满保留原图 | 慢盘/SSD 1/10/20 张 4K PNG 的停顿与托盘延迟 |

## 本轮验证记录（2026-11-25/26，本机）

- 定向回归：批次一 121/121、批次二 130/130、批次三 75/75、批次四 102/102、批次五 47/47。
- 全量 `node --test test/*.test.js`：2843 项，2842 通过；唯一失败为 `test/usage-query.test.js` 的
  “query p95 stays inside the 100 ms budget on ~100k synthetic buckets”（满负载下 summary P95 超 100 ms）。
  该测试文件与 usage 相关实现相对基线提交 `deec664` 未改动，单独运行 11.2 s 通过（见 `git diff --quiet deec664..HEAD -- test/usage-query.test.js main/services/usage-*.js`），
  判定为本机负载造成的计时抖动，不作为修复回归。
- 运行时（Electron）套件：本机 Chromium 沙箱不可启动，按 AGENTS.md 用宿主侧 `--no-sandbox` 注入后 18/18 通过；该注入不在仓库内。
- 原生剪贴板：`cargo test`（lib 21 项 + 其它套件）通过；按计划重建侧车 `native/clipboard/bin/HighlighterClipboard.exe`
  （buildId `hl_b175da43...a30f`），`test/clipboard-coordination.test.js` 4/4、`test/clipboard-protocol.test.js` 4/4。
- `npm run check`：语法 572 文件、架构（main.js 1330/1330）、i18n（三语对称 2333 键）、评审证据登记全部通过。
- 未执行：`verify:package`（需完整 electron-builder 产物与静默安装）与上文“未完成的真机门槛”整列。

## 说明

- 本表只登记可以在 CI 复跑的用例；真机列写的是仍需在发布候选上执行、且不能由本地模拟替代的证据。
- 测试文件名必须真实存在且包含对应工单编号（注释或用例名均可），由 `npm run check:review-evidence` 强制。
- 新增 P0 时同一次提交必须补：实现、回归用例、本表一行、以及（如适用）config/release-hardware-matrix.json 的一条 claim。
