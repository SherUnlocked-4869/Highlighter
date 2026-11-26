# 2026-11-26 全量代码评审 · 交付证据登记表

本表登记 [全量代码评审与优化建议报告](../reviews/2026-11-26-code-review-and-optimization-report.md)
对应开发计划 [2026-11-26-review-optimization-development-plan.md](../plans/2026-11-26-review-optimization-development-plan.md)
中每张工单的自动化证据与真机门槛。

`scripts/check-review-evidence.js` 会校验：表中每一行的工单编号都能在所列测试文件中找到且文件存在；
每个 P0 工单至少有一个回归用例。缺真实设备/GPU/安装包样本的项在“真机门槛”列说明，
不以模拟通过冒充真机结论。

## 工单证据

| 工单 | 优先级 | 状态 | 回归测试 | 真机/发布门槛 |
|---|---|---|---|---|
| H01 | P0 | 已实现 | test/h01-history-document-cleanup.test.js | 真机删除/清空历史后检查 `history/documents/<id>/` 目录消失、设置页磁盘占用下降；真实数据目录迁移后从历史入口重新编辑 |
| H02 | P0 | 已实现 | test/h02-mosaic-cache.test.js | 真机连续拖拽/微调/缩放马赛克笔触 30 帧后仍命中缓存（离屏 Canvas 分配数不增长），导出像素与旧实现逐像素一致 |
| H03 | P0 | 已实现 | test/h03-markdown.test.js | 真实 Electron 划词窗口内流式渲染的选区保持与代码块展示（宿主沙箱经 AGENTS.md 环境处理后可跑） |
| H04 | P0 | 已实现（报告 dwId 偏移有误，按官方 SDK 实现） | test/h04-utf8-decode.test.js, test/h04-everything-dwid.test.js | 真实 Everything 1.4/1.5 上中文路径 600 条大包；人为延迟回执验证迟到包丢弃；本机 1.4.1.1032 正路径冒烟已通过 |
| H05 | P0 | 已实现 | test/h05-architecture-extraction.test.js | 打包候选上托盘菜单/记录/代理状态与实际点击行为（真机托盘交互） |
| F02 | P0 | 已实现 | test/f02-selection-ipc-storm.test.js | 真机日常打字/滚轮时主进程不再收到 selection-hook IPC 唤醒；划词显示、点外隐藏、快捷键隐藏与剪贴板护栏不变 |
| F07 | P2 | 已实现（会话索引、usage 三项、AI/OCR/迁移） | test/f07-conversation-store-index.test.js, test/f07-usage-costs.test.js, test/f07-ai-ocr-migration.test.js | 真实 20 条会话目录的托盘重建延迟；真实 usage.db 在 24 个月数据下的体积对比 |
| F01 | P0 | 已实现 | test/f01-storage-performance.test.js | 真实 config.json/DPAPI 下的 getSettings 二读为零；真实日志轮转与历史分页（真机） |
| F03 | P0 | 已实现 | test/f03-recording-performance.test.js | 真实 1080p30 连录 30 分钟的防病毒扫描停顿；真实 ffmpeg framemd5 波纹等价（本机已做 90 帧） |
| F04 | P1 | 已实现 | test/f04-everything-performance.test.js | 真机 Everything 1.4/1.5 下逐字符搜索无全桌面枚举；120s 空闲后索引进程仍存活 |
| F05 | P1 | 已实现 | test/f05-clipboard-performance.test.js | 真机 4K PNG 复制/粘贴的屏障持锁时长与租约超时；clipboard 侧车需按源码重建 |
| F06 | P1 | 已实现 | test/f06-capture-performance.test.js | 真机长截图语料（matcher shift 一致性与耗时）、贴图 LRU 驻留内存曲线 |
| U01 | P1 | 已实现 | test/u01-capture-ux.test.js | 真机多选拖拽手感、中文输入法内联编辑、微软雅黑下 CJK 包围盒与 PDF 结果条 |
| U02 | P1 | 已实现（贴图矢量重标注/导出离屏合成未做） | test/u02-longpin-ux.test.js | 真机 100%/150% 双屏贴图松手、5 万 px 长图预览与固定悬浮栏剥离 |
| U04 | P1 | 已实现（表格/搜索、划词锁/终端保护/粘贴时序） | test/u04-table-search.test.js, test/u04-selection-lock.test.js | 真机终端内 Ctrl+C 注入防护、真实 Everything 目录 isFolder、双窗口并发长考、粘贴时序手感 |
| N03 | P2 | 已实现（导出合成为编辑器播放覆盖层） | test/n03-recording-hud.test.js | 真机录制快捷键胶囊（需焦点在控制条，见风险）、真实音轨静音分析与一键裁剪 |
| N06 | P2 | 已实现（API Key 迁移未做，见备份契约） | test/n06-config-search-backup.test.js | 真机 Ctrl+K 搜索跳转与单文件加密备份/恢复往返 |
| N01 | P2 | 已实现 | test/n01-auto-redact.test.js | 真机真实 OCR 模型下的脱敏命中/漏报与手动删除体验 |
| N02 | P2 | 已实现（历史 OCR 索引+标签、剪贴板图片动作） | test/n02-history-ocr.test.js, test/n02-clipboard-image.test.js | 真机历史搜索图中文字、剪贴板图片 OCR/Excel/贴图与真实 OCR 模型 |
| N04 | P2 | 已实现（原生拖拽投递需真机） | test/n04-search-quicklook.test.js | 真机拖到微信/钉钉/VS Code/浏览器、可见窗口 blur 清理 |
| N05 | P2 | 已实现（桌面像素差分需屏采） | test/n05-pin-onion-snapshot.test.js | 真机多显示器贴图快照恢复/挂起、洋葱皮可视比对 |
| U05 | P1 | 已实现（配置侧，main.js 解除回收已接线） | test/u05-config-lifecycle.test.js | 真机水印截图输出、跨路由搜索定时器、空闲回收与语言互换行为 |
| U03 | P1 | 已实现 | test/u03-record-ux.test.js | 真机 window 模式重录、高分屏 4K 窗口录制、双路混音爆音与 Direct-Track 标注入口 |

## 本轮验证记录（2026-11-26/27，本机）

- 分支 `feat/review-optimization-2026-11-26`，基线 `master@0e8d040`（代码基线 8416120）。共 41 个提交，153 个文件，+29742/−1722。
- 全量 `node --test test/*.test.js`：**3214 项，3213 通过**。唯一失败为 `test/usage-query.test.js` 的
  “query p95 stays inside the 100 ms budget on ~100k synthetic buckets”（全量并发下 p95 约 110–180 ms；
  单独运行 p95 66.8 ms 通过）。该测试与本次改动无关，属 AGENTS.md 已记录的满负载计时抖动。
- `npm run check`：语法 610 文件、架构（`main.js` 1204/1205 行、最长行 158/160）、i18n（三语对称，未迁移
  CJK 602/606）、评审证据（2 张登记表 / 50 工单 / 9 个必需 P0）全部通过。
- 原生：`cargo test --locked --manifest-path native/clipboard/Cargo.toml`（lib 30 + 集成 12）通过；
  `native/everything-search` cargo test 13 通过；`native/ocr` cargo test 4 通过；
  `native/everything-search/bin/HighlighterEverything.exe` 已随 Rust 改动重建并提交；
  `vendor/selection-hook`、`native/clipboard`、`native/ocr` 的构建产物在 gitignore 中，需由 `npm run build:native` 重建。
- 真实 Electron 探针（本机按 AGENTS.md 处理 `ELECTRON_RUN_AS_NODE`、`TMP/TEMP`、`--no-sandbox` 注入）：
  `diagnostics-runtime`、`electron-runtime`、`window-security-runtime` 通过。集成期间由探针发现并修复了两处回归：
  H05 遗留的 `tray` 悬空引用导致 before-quit 抛错、应用无法退出（diagnostics 探针 40 s 超时暴露）；
  N05 把 `applyPinData` 包进 `startPinRenderer()` 后窗口启动标记不可达（locked-sandbox 探针暴露）。
- 未执行：`verify:package`（需完整 electron-builder 产物与静默安装）与上表“真机/发布门槛”列的全部项。
  这些项不能由本机模拟替代，未冒充通过。

## 说明

- 本表只登记可以在 CI 复跑的用例；真机列写的是仍需在发布候选上执行、且不能由本地模拟替代的证据。
- 测试文件名必须真实存在且包含对应工单编号（注释或用例名均可），由 `npm run check:review-evidence` 强制。
- 新增 P0 时同一次提交必须补：实现、回归用例、本表一行。
