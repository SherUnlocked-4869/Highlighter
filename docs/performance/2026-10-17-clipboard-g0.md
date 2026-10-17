# 剪贴板 G0 执行记录

日期：2026-10-17（Asia/Hong_Kong）

基准提交：`2db7fac`；开发分支：`codex/clipboard-g0`。实施依据为 [开发文档](F:/workspace/Highlighter/docs/plans/2026-10-17-clipboard-implementation-plan.md)。

## 进度

| 任务 | 状态 | 证据 |
|---|---|---|
| T00 资源采集与基准冻结 | 进行中 | 新增进程树采样工具、统计单元测试；已采现有应用的非受控参考快照，受控 A/B 待补 |
| T01 原生依赖可复现 | 已完成本机验证 | 固定 selection-hook 2.1.1 源码；空依赖目录重编译；Node 24.16.0 / Electron 43.2.0 加载相同指纹 |
| T02 原生骨架 | 已实现，采集真机证据待补 | 受限双端帧协议、默认关闭、消息窗口/有限队列、暂停监听器反复启停、父管道关闭退出；隔离采集测试受环境权限阻止 |
| T03 取词事务协调 | 核心已实现，真机准入待完成 | [T03 执行记录](F:/workspace/Highlighter/docs/performance/2026-10-17-clipboard-t03.md)：认证管道/屏障、100 轮握手及合成交错、宿主退出保护；qualified 仍为 false |
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

### T01 原生依赖

`vendor/selection-hook/PROVENANCE.md` 记录上游 MIT 许可、tarball 摘要和本地差异。依赖锁定为 `file:vendor/selection-hook`，不再依赖 npm 包里的预编译二进制。T01 提交只增加构建身份，没有改变取词算法；后续 T03 修改见单独执行记录。

执行 `node scripts/verify-selection-source-build.js` 会在 `.tmp/clipboard-g0/selection-clean-*` 中复制不含 build/prebuild 的源文件，从仓库 lockfile 取出 addon 的精确依赖，用 `npm ci --ignore-scripts` 安装后显式编译，再由 Node 和 Electron 的 Node 宿主分别实例化与清理。两者均报告 `hl_1ba2fde105b98a81849a3bca958c317a4547282ef3e4da6594211bf816d46ce0`；Python 3.12.10、node-gyp 12.4.0、VS2022 17.14.37502.11、Windows x64。

`node --test test/selection-native-build.test.js test/electron-runtime.test.js` 共 3 项通过；Electron 的正常 main 进程探针也校验源码指纹。构建身份不是发行二进制签名，完整安装包验证仍属于后续门禁。

尝试整个项目的隔离 `npm ci --ignore-scripts` 时，现有 lockfile 的 `typedarray@https://registry.npmmirror.com/typedarray/-/typedarray-0.0.6.tgz` 被当前 npm 策略以 `EALLOWREMOTE` 拒绝。本次没有放宽 npm 安装策略，也没有修改该无关依赖；上面的 addon 独立干净安装已经通过，不能据此宣称整个项目的干净安装通过。

### T02 原生骨架与验证

新增 `native/clipboard` Rust 工程，单独执行 `npm run build:clipboard` 构建 `native/clipboard/bin/HighlighterClipboard.exe`。没有接入应用启动、设置、托盘或 renderer。默认初始化不会创建监听器，不追读启动前的剪贴板；开发协议显式 configure 后才监听。T02 阶段 capability 为 `history:false, coordination:false`；T03 已增加协调协议，但仍保留 `history:false, qualified:false`，不可作为正式历史功能使用。

`WM_CLIPBOARDUPDATE` 回调只放入序列号/配置世代，队列上限 64；采集线程在独立线程读取并拥有快照，暂时只累加计数后丢弃，无数据库或正文输出。检查隐私格式/文件格式后，才考虑 Unicode 文本、PNG、DIB/DIBV5；分配大小、尺寸、像素数先校验。图像目前只有格式头和边界校验，完整安全解码/原子附件存储仍未实现。

stdio 使用 `u32 length + u8 kind + u32 jsonLength + json + optional binary`，帧 1 MiB、JSON 512 KiB、二进制分片 256 KiB 上限，Rust/JS 两端均在主体分配前检查长度。会话 epoch 仅用于父子 stdio 会话识别，不能代替 T03 命名管道要求的随机 nonce、ACL 和宿主身份验证。

自动验证：

- Rust：6 项纯协议/边界测试和 1 项暂停监听器生命周期测试通过。后者连续启停 3 次，每次重复 stop，未启用内容采集。
- Node：分块/Unicode/二进制帧、畸形输入、默认关闭、会话拒绝、反复 quiesce、父管道关闭退出；错误只输出固定诊断，测试正文不出现在日志。
- `cargo clippy --all-targets -- -D warnings`、现有 JavaScript 全套测试、语法/架构/i18n 门禁通过。没有放宽门禁阈值。

`isolated_capture` fixture 包含合成文本保真、过期序列、隐私格式、文件复制排除、启停后采集等用例，写入之前必须创建私有非交互 Window Station。本机实际执行时 `CreateWindowStationW` 返回 `0x80070005 E_ACCESSDENIED`；减少为必要权限后仍拒绝。因此该用例标为显式 opt-in，并计为**未验证**，不计为通过。运行命令：

```powershell
cargo test --locked --manifest-path native/clipboard/Cargo.toml --test isolated_capture -- --ignored --nocapture
```

不能用交互桌面的真实用户剪贴板代替隔离 fixture。上述失败发生在任何剪贴板写入之前。

T02 阶段构建身份为 `hl_c5aea1f3054ce119b96886ed660a44070b24b187d8f60a6e539e30a65f4e736e`，Release exe 为 412,672 B，SHA-256 `e7cc3a748c72156095a07823fdba82c16fdf6704af022b13c68c08c5aa9f78d0`。这只是开发原型，不是发行包。停止超时会保留待停止状态并拒绝重新启用，不能在下一次 quiesce 中把尚未退出的采集线程当作已经停止。

### 原生骨架独立空闲采样

命令：`node scripts/benchmark-clipboard-native.js --duration-seconds 60 --interval-ms 5000 --output .tmp/clipboard-g0/native-disabled-20261017.json`。

测量的是单个原生原型进程，初始化后保持 disabled，未创建监听器；**不是** Highlighter 整树 A/B，也不覆盖启用监听、取词协调、4K 快照或历史库。构建身份 `hl_6eeb5d26244ace299fa828f9e6ec5e874c4c524aa10c9839b062a470f68042b1`（后续停止状态修复会改变源码身份，以原始报告为准）。

- 11 个样本；Private Bytes 中位数 2,170,880 B，约 2.07 MiB；最大 2,269,184 B，约 2.16 MiB。
- Working Set 中位数 14,086,144 B，约 13.43 MiB。
- CPU 10 个有效区间均未测得累计 CPU 增长；首样本为未知。不能据此声称活动监听 CPU 为零。
- 原始报告在忽略目录，包含进程创建时间、样本缺失情况、构建身份和观察状态。

### 未关闭的准入项

T03 已补充认证租约、采集屏障、同锁区恢复检查和 orphaned 回收实现，备份已设为 64 个格式 / 64 MiB 上限。100 轮真实协议握手与 100 轮合成策略交错通过，但真实 Ctrl+C/Ctrl+X、系统锁、多格式恢复、延迟发布和宿主分阶段崩溃仍待真机验证。详情与资源参考见 [T03 记录](F:/workspace/Highlighter/docs/performance/2026-10-17-clipboard-t03.md)；不能把合成测试当作 G0 已通过。

T00 受控整树 A/B、T04 文本/4K 真实采集与最小迁移 fixture 均待完成。G0 维持“未通过”，按原开发文档不提前进入 V1 面板/存储阶段。

资源统计单元测试覆盖后代归属、PID 重用、父退出、未知内存/CPU、累计 CPU 转换和参数限制。相关测试通过后再提交工具。

G0 尚未通过；文档中的 Private Bytes/CPU/延迟目标均仍是待验证门槛。正式系统剪贴板测试必须隔离合成数据，避免收录或覆盖用户正在使用的真实内容；可见窗口按 AGENTS.md 放在副屏。
