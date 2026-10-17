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

上述为首轮验证状态；下文记录用户打开目标文档后的续测和新增修复。

## 续测：前台授权与激活过渡修复

用户在副屏打开的程序是 **Notepad--（Ndd）**，不是 Windows 内置 Notepad。本轮只选择其空白 `New 0` 文档，使用实际全局快捷键呼出仓库构建的隔离测试面板，点击记录及“粘贴”。没有操作其他用户文档。

新增实机证据揭示了两个后续阻塞点：

1. 发布凭据验证成功，原目标及焦点有效，按键全部释放，但前台仍停在隐藏的面板；原生进程不能完成激活，最终返回 `FOCUS_OR_KEYS_BUSY`。
2. 增加指定进程授权后，`SetForegroundWindow` 成功，紧随其后的前台查询短暂返回空窗口。旧条件将这个过渡误判为第三方窗口，返回 `FOCUS_CHANGED`。

修复提交 **`13e959d`**：主进程在原窗口仍可见、聚焦且操作上下文未变化时，通过现有 addon 为实际存活的剪贴板子进程调用 `AllowSetForegroundWindow(pid)`。addon 同时验证调用进程实际拥有前台，并拒绝无效 PID、非整数及 `ASFW_ANY`。不增加 renderer IPC 参数、常驻线程或 hook。Windows 提供该 API 供有权切换前台的进程向指定进程授权；授权不会保证激活成功，因此实际前台、原目标焦点、按键和剪贴板凭据仍需全部通过。[Microsoft API 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow)。

激活后的空窗口过渡沿用原有 300 ms 截止时间；发现实际第三方前台窗口仍立即取消。没有模拟 Alt、AttachThreadInput、提权或重新发送粘贴。私有诊断最多保留 16 条布尔状态/耗时/结果，不输出窗口句柄、PID、正文或凭据。

## Ndd：20 次实际输入结果

| 项目 | 结果 |
| --- | --- |
| 全局快捷键 → 选中记录 → 点击粘贴 | 20/20 次完成 |
| 指定子进程的前台授权 | 20/20 次成功 |
| 原生输入提交结果 | 20/20 `injected`，没有取消或未知结果 |
| 目标实际文档完整内容 | 与预期完全一致，归一化换行后 66,290 个 UTF-16 码元 |
| 覆盖内容 | 普通文字、链接、中文/emoji、首尾空白、CRLF；其中长记录原始 UTF-8 为 114,711 字节 |
| 重复/遗漏/预览截断 | 完整内容比对未发现 |
| 提交阶段耗时 | 最小 18.06 ms，中位 20.69 ms，最大 21.82 ms |

耗时是 `paste.commit` 请求至服务完成刷新的测量值，不代表目标应用渲染或人工感知延迟。最终成功判定使用实际文档内容，不仅依赖 `injected` 回执。

UIA 提取会去除末尾空白，并将大文档截到约 20,000 字，不能据此判定长内容丢失。保存对话框的控件索引亦无法可靠使用，已取消该对话框，未保存或覆盖文件。最终显式从当前纯合成文档全选复制，在本地与预期全文比较；探针仅返回相等标志与长度，不输出剪贴板正文，也未读取/恢复测试开始前的剪贴板。结果 `matches=true`。所有测试内容保留在用户打开的这份测试文档中。

本轮暂停采集，原生 `accepted=0`；这证明测试没有主动采集其他剪贴板内容，不代表启用采集情况下的完整资源验收。

## 本轮构建、回归及剩余验收

- 最新 clipboard build ID：`hl_1bcd27cb76902e12e4ecab084177de7a8212ada2ecc1b3826fcc25cad014919e`。
- 最新 EXE SHA-256：`60bfe10d546cacfb57fae9430d709b5056667131430bb1c64e6d5377d91603a7`。
- 同步重建了 selection addon；构建身份一致性测试通过。现有安装版未被停止或替换。
- 相关 JS 回归 **38/38** 通过，含实际 addon 协调、进程授权、IPC 安全、renderer 数据清理和窗口策略；Rust **12/12** 通过；静态/架构/i18n 检查及 Clippy `--all-targets -- -D warnings` 通过。
- Chromium 测试目标现保存在 `test/fixtures/clipboard-paste-target.html`。探针通过仅监听回环地址的 `/synthetic-target` 返回固定合成页面；状态及控制端点仍要求独立随机令牌。

Chrome 续测尚未通过。在改用明确的本地 HTTP 测试地址后，computer-use 仍因无法可靠识别当前 Windows 浏览器 URL 而终止本轮操作。已停止所有窗口输入，关闭专用测试 Chrome 和探针；没有改用其他输入手段绕过这次中止。浏览器 CDP 直接操作加 HTTP 呼出不能模拟真实 Windows 快捷键带来的前台权限，因此此前的尝试不计入 Chrome 通过次数。

以上修复阶段尚待完成的专项验证包括：Windows 内置 Notepad、Chrome 各 20 次实际输入；外部变化下的真实 UI 取消/提示/焦点验证；完整应用 A/B 内存/CPU、连续操作回落和 24 小时稳定性。私有 Window Station 仍受权限限制。Setup 的后续构建和用户验收见下文。

## Setup 构建与用户实机验收

2026-10-17，基于 `9c8e771` 构建 Windows x64 `Highlighter-Setup-3.0.0.exe`，已包含发布序列号修复、即时反馈及前台授权补修 `13e959d`。

- 文件大小：144,685,666 字节（137.98 MiB）。
- SHA-256：`e34bfd5d5311ebed6e3a97117ecca85f624603d7529020fc314936b84a84c6e2`。
- 签名状态：`NotSigned`。
- 安装包及内层压缩包完整性、包内源文件/原生组件匹配、更新清单哈希、8 项 Electron fuses 和打包入口启动检查通过。

用户随后明确反馈：**“粘贴修复我实机验证通过。”** 据此记录本次主动粘贴修复的用户实机验收通过。用户未单独提供各应用的验证次数；上述专项兼容性矩阵和长期资源指标仍保留原验证范围。

按用户要求合并至 master 并推送远程，不等待 CI 结果。
