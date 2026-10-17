# 剪贴板 G0 执行记录

日期：2026-10-17（Asia/Hong_Kong）

基准提交：`2db7fac`；开发分支：`codex/clipboard-g0`。实施依据为 [开发文档](F:/workspace/Highlighter/docs/plans/2026-10-17-clipboard-implementation-plan.md)。

## 进度

| 任务 | 状态 | 证据 |
|---|---|---|
| T00 资源采集与基准冻结 | 进行中 | 新增进程树采样工具、统计单元测试；已采现有应用的非受控参考快照，受控 A/B 待补 |
| T01 原生依赖可复现 | 待执行 | 固定 selection-hook 上游包、源码指纹与 Node/Electron 实际加载身份 |
| T02 原生骨架 | 待执行 | 帧协议、无可见窗口监听、有限快照与退出清理 |
| T03 取词事务协调 | 待执行 | 第一次写入前的 native worker 租约；真实复制穿插和恢复保护 |
| T04 G0 验证收口 | 未通过 | 所有前置证据齐全前，不接产品面板或宣称资源预算达标 |

## 资源采集方法

新增 `scripts/benchmark-clipboard.js`，通过显式主进程 PID 追踪进程树，进程身份包含创建时间。已观察到的子进程即使父进程退出仍被跟踪，PID 重用不会吸收无关进程。源清单不输出 command line、可执行文件完整路径或剪贴板内容。

CPU 由累计时间差按整机逻辑 CPU 数归一化；首个样本、新进程、进程退出或计数器重置导致的缺失区间返回 null，不能当作零使用率。Private Bytes/Working Set 有不可读项时整体样本也保留未知状态；Working Set 相加可能重复计算共享页。GPU/音频未由本工具测量。

使用示例（PID 和输出文件由调用者确定，输出存在时拒绝覆盖）：

```powershell
node scripts/benchmark-clipboard.js --root-pid 3800 --duration-seconds 60 --interval-ms 5000 --output .tmp/clipboard-g0/live-advisory-20261017.json --label existing-app-uncontrolled
```

这只是采样工具，不启动应用、不关闭用户窗口、不终止任何被采样进程。

## 当前应用的参考快照

采样到的主应用报告版本为 3.0.0；当前正在运行的安装包不能由源码 HEAD 自动证明构建一致。没有改变其已有窗口、OCR 或其他服务状态，因此以下不是标准托盘空闲基线，也不适用于判断新增剪贴板模块的增量。

- 约 60 秒、11 个采样点；默认间隔 5 秒，实际周期包含进程枚举成本。
- 整树 Private Bytes 中位数约 575.9 MiB，最大约 576.2 MiB。
- 整树 Working Set 中位数约 1067.5 MiB；共享页重复计数的限制适用。
- 有效 CPU 样本 9 个，另 2 个区间不完整；数值只作参考，不用于门槛验收。
- 外部已运行的 Everything 服务不因同名被算入；仅通过归属树纳入应用启动的子进程。

原始结果保存在忽略目录 `.tmp/clipboard-g0`。正式验收需补充隔离数据根、固定窗口/功能状态、OCR 释放期及匹配构建的 A/B；不能通过降低现有工具栏/会话能力来制造节省结果。

## 验证与剩余工作

资源统计单元测试覆盖后代归属、PID 重用、父退出、未知内存/CPU、累计 CPU 转换和参数限制。相关测试通过后再提交工具。

G0 尚未通过；文档中的 Private Bytes/CPU/延迟目标均仍是待验证门槛。正式系统剪贴板测试必须隔离合成数据，避免收录或覆盖用户正在使用的真实内容；可见窗口按 AGENTS.md 放在副屏。
