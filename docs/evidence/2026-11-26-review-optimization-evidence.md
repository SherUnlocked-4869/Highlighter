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
| F07 | P2 | 已实现（会话索引 + usage 三项） | test/f07-conversation-store-index.test.js, test/f07-usage-costs.test.js | 真实 20 条会话目录的托盘重建延迟；真实 usage.db 在 24 个月数据下的体积对比 |
| U05 | P1 | 已实现（配置侧，main.js 解除回收已接线） | test/u05-config-lifecycle.test.js | 真机水印截图输出、跨路由搜索定时器、空闲回收与语言互换行为 |

## 说明

- 本表只登记可以在 CI 复跑的用例；真机列写的是仍需在发布候选上执行、且不能由本地模拟替代的证据。
- 测试文件名必须真实存在且包含对应工单编号（注释或用例名均可），由 `npm run check:review-evidence` 强制。
- 新增 P0 时同一次提交必须补：实现、回归用例、本表一行。
