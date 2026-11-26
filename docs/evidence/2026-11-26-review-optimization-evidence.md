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

## 说明

- 本表只登记可以在 CI 复跑的用例；真机列写的是仍需在发布候选上执行、且不能由本地模拟替代的证据。
- 测试文件名必须真实存在且包含对应工单编号（注释或用例名均可），由 `npm run check:review-evidence` 强制。
- 新增 P0 时同一次提交必须补：实现、回归用例、本表一行。
