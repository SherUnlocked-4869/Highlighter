# 主动粘贴修复验证记录

修复方案：[主动粘贴失败修复方案](../plans/2026-10-17-clipboard-active-paste-fix-plan.md)。本记录随实现更新；未列为通过的验证不代表完成。

## R1：Windows 发布阶段证据

2026-10-17，在交互剪贴板上显式启用合成数据探针。探针只发布固定测试文字及 `ExcludeClipboardContentFromMonitorProcessing` 标记，不读取用户之前的剪贴板，不恢复旧内容，也不打开可见窗口。

```json
{"before":526,"beforeClose":529,"afterClose":532,"afterOwnerRelease":532,"oldWriterSequenceStillCurrent":false}
```

这次实测确认：**CloseClipboard 将序列从 529 推进到 532，旧 writer 返回的 529 已失效；随后 owner 销毁没有再推进该样本的序列。** 数字及增量是本次样本，不编码为平台规则。

- 私有 Window Station 验证：`CreateWindowStationW` 返回 `0x80070005 / E_ACCESSDENIED`，在任何写入前失败，没有隐式切换为交互测试。该隔离路径仍未通过。
- 显式交互探针：`HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE=1 cargo test --locked --manifest-path native/clipboard/Cargo.toml --test publication_sequence -- --ignored --nocapture`，1/1 通过。
- 探针所在代码：`native/clipboard/tests/publication_sequence.rs`，默认 ignored；普通 `cargo test` 不接触交互剪贴板。

## R2/R3：原生发布与提交保护

实现提交 `26cf211`。共享发布器复用消息线程上的稳定 owner；暂停采集时首次复制/粘贴可惰性创建运行时，不启动采集 worker。所有权丢失及退出会撤销凭据。

写入显式检查 CloseClipboard，再取得候选序列。有限次数重新打开后，检查 owner、撤销代数、格式集合、长度及原始格式内容哈希；验证前后序列必须完全相等。提交继续检查该凭据，不采用固定增量、不忽略外部变化、不自动重放 Ctrl+V。图片验证直接借用 Windows HGLOBAL，没有额外 PNG/DIB 验证缓存。屏障回到 Idle 后只重查最新事件；原生自身 owner 的写入不会重新入库。

显式合成数据验证：`HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE=1 cargo test --locked --manifest-path native/clipboard/Cargo.toml --test publication_repair -- --ignored --nocapture`，1/1 通过，包括文字、PNG/DIBV5 和每次发布后的外部复制失效检查。此次记录：

| 数据 | Close 前 | Close 后及验证序列 | 发布耗时 | 验证耗时 |
| --- | --- | --- | --- | --- |
| 文字 | 544 | 547 | 161 μs | 810 μs |
| PNG/DIBV5 | 555 | 557 | 404 μs | 605 μs |

这些是小型合成样本的单次耗时，不代表大图片性能或整体应用资源指标。探针只写合成内容，不读取或恢复用户之前的剪贴板。

普通 Rust 回归：12/12 通过；3 项需要特殊权限/显式交互的测试默认 ignored。Clippy 使用 `--all-targets -- -D warnings`，不降低门禁。

## R4：即时、非聚焦反馈

实现提交 `ffcfcff`。失败后复用已有窗口，切换为 148 像素高的反馈视图；使用非聚焦窗口和 showInactive，不重新初始化或查询历史，清空列表、详情、搜索及预览引用。4 秒后按原释放设置隐藏/释放；重新呼出取消旧计时器，恢复普通窗口并重新捕获目标。主动关闭、锁屏、游戏模式、迁移、禁用及退出仍取消恢复。

7 项主进程回归和 1 项 renderer 回归通过，覆盖精确序列变化、未知结果、处理中关闭、恢复窗口、过期计时器以及历史请求在反馈期间完成时不得回填 DOM。没有把“已发送输入”表述成目标应用已经消费内容。

提交 `06a35c1` 修正既有 IPC 清单测试：原扫描器遗漏 clipboard 模块通过局部 helper 注册的 11 个 handler，导致 114 与 125 不符。现在实际观察该模块的注册集合，保留完整集合与策略逐项比较。该项以及跨页面、iframe、过期 owner、preload 通道检查通过。

## R5：实机及资源验证状态

构建出的原生组件：

- build ID：`hl_621180fb5b59cc4b03e8edd42b44fcbd1365ffb04acd52393baccd26306e7c4f`
- SHA-256：`b32f44ad3ef563b316f313d88a849370adb951279310c9435f02dd12c244f806`
- 通过 `npm run build:clipboard` 构建，没有执行会终止用户应用的全量构建前置脚本。

提供显式实机探针 `scripts/probe-clipboard-paste-runtime.js`，使用实际 domain、IPC 安全工厂、preload、renderer、原生 sidecar 和独立临时数据根。Rust fixture 仅在新建、指定前缀的本机临时目录写入四条合成记录，包含链接、中文/emoji、空白/换行及大于 64 KiB 的文字。不会启动正常应用的取词 hook、更新器或用户数据根；采集暂停。

运行方式：先设置 `HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE=1`，清除 `ELECTRON_RUN_AS_NODE`，直接运行 `node_modules/electron/dist/electron.exe scripts/probe-clipboard-paste-runtime.js --remote-debugging-port=19333`。探针要求副屏，快捷键为 `Ctrl+Alt+Shift+F10`。仅用于开发验证，不随产品打包。

本次已经确认副屏存在，探针完成初始化，独立 Chrome 合成输入页按指定位置启动。**在第一次读取 Chrome 窗口状态时，computer-use 因无法可靠识别当前浏览器 URL 而中止本轮操作。未执行实际粘贴，不能把页面成功打开计为粘贴通过。** 已停止窗口操作并关闭本轮探针和专用 Chrome 进程，未终止用户安装版 Highlighter 或原有 Chrome。

仍待完成：Notepad/Chrome 各 20 次实际输入验证、外部变化下的真实 UI 提示及焦点验证、完整应用 A/B 内存/CPU、连续操作回落和 24 小时稳定性。私有 Window Station 仍受权限限制。原生生命周期测试证明暂停采集时 worker 不启动，不等同于整机低资源验收。

**本次已完成修复实现及自动回归，实机兼容性与资源验收未完成。现有 Setup 安装包仍含旧代码，本次没有重建安装包。**
