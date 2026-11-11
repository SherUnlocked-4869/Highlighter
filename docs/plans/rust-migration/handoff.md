# Rust 迁移 R0 交接文档

日期：2026-11-11。交接对象：接手 Rust 迁移的下一名工程师/Agent。
状态：**R0 部分完成；G0 未通过；R1 未开始（计划 §8 要求 G0 通过后才放行）**。

> 先读这份文档，再按 §9 的顺序接手；不要只看 PR 标题就认为 R0 已完成。
> 所有"候选/待验证"结论以 [adr/README.md](adr/README.md) 与 [r0-g0-report.md](r0-g0-report.md) 为准，
> 文档中的"未验证"项不得改写成已验证。

## 0. TL;DR

- 分支 `codex/rust-r0-baseline-contracts` 已推送，PR **#5**（base `master` @ `3df7129`）：
  https://github.com/SherUnlocked-4869/Highlighter/pull/5 。PR 只含 R0 证据/原型/文档/测试，**未改产品代码**。
- 已完成：宿主合同 + 28 个跨语言夹具、隔离 Rust workspace（107 tests）、前端资源白名单、
  窗口/钩子/媒体/PDF/凭据/资源通道六项风险原型与证据、ADR-0001～0005 候选结论、G0 报告草案。
- 未完成：**R0-07**（NSIS 测试包、WebView2 有/无/离线矩阵、首轮性能/进程树对照）、长时/双音源媒体验证、
  真机 100/150/200% DPI 矩阵、测试驱动 ADR-0006、最低系统 ADR-0007、修正估算与正式 G0 报告。
- 下一步建议：先做 R0-07 与 R0-05 长时收尾 → 补真机矩阵 → 出正式 G0 报告；**G0 通过前不要开始 R1 业务迁移**。

## 1. 仓库/分支/PR 状态

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/SherUnlocked-4869/Highlighter.git` |
| 分支 | `codex/rust-r0-baseline-contracts`（本地与 origin 一致，HEAD `27dfb63`） |
| PR | #5 `feat(rust): R0 风险验证批次（合同/夹具、隔离 workspace 与六项风险原型）`，OPEN / MERGEABLE / mergeStateStatus=CLEAN（观察值） |
| 基线 | 产品源码 `3df7129`（4.2.0 / Electron 43.8.3）；分支未落后 master |
| 规模 | 本交接提交之前 13 个提交（179 文件、+53,084/−29），另加本交接提交 |
| 证据目录 | `.tmp-r0-*`（gitignore，不提交；约 160 MB），文档中记录了命令/输出/哈希 |

提交清单（按时间）：

```text
82c0b41 docs(rust): add R0 migration plan, feasibility study and contract freeze spec
f73dc61 feat(rust): add frontend resource packaging whitelist and collector
f863c69 feat(rust): freeze host contracts and cross-language parity fixtures
22f1ace docs(rust): add R0 feature parity matrix and measured baseline
04ff372 feat(rust): scaffold isolated R0 workspace with contract, protocol and storage crates
3dc82cb docs(rust): record R0 implementation status in plan, README and checklist
a842ea9 feat(rust): add R0-03 Tauri transparent overlay prototype and R0 report
eb863f4 docs(rust): prepare ADR index and prototype build ignores for R0-04/05/06 spike batch
e401a6f feat(rust): prove synthetic credential migration via OSCrypt key + AES-GCM (R0-06)
985c6b6 feat(rust): extract standalone C++ selection helper with real-selection evidence (R0-04)
9c1ef8c feat(rust): add R0-04/05/06 risk spikes, ADRs and G0 report draft
124d138 docs(rust): finalize R0 report status for spike batch
27dfb63 fix(rust): make contract/fixture byte checks line-ending independent for Windows CI
```

CI 说明：PR 创建后 GitHub 未立即触发 `pull_request` CI，曾手动 dispatch 验证；首次失败源于
Windows checkout 的 CRLF 与字节级夹具校验冲突，已由 `27dfb63` 修复（规范化 + `.gitattributes` 固定 LF）。
最近观察 PR 的 `mergeStateStatus=CLEAN`。**本轮按用户要求不再等待/触发 CI**；如需复核请到 PR 页面看 checks。

## 2. 环境事实（复现前必读）

| 项 | 值 |
|---|---|
| OS | Windows 11，build 26300.9711（`Win32_OperatingSystem`） |
| 硬件 | AMD Ryzen 7 9850X3D（8C/16T）、47.2 GiB RAM、RTX 5070 Ti + AMD 核显、F: 盘仓库所在 |
| 显示器 | 主屏 `\\.\DISPLAY1` 3840×2160@150%；副屏 `\\.\DISPLAY2` 竖屏 1440×2560@**125%**，物理原点 **(3840,-170)**（负 Y）。可见测试窗口只放副屏（`AGENTS.md`） |
| 工具链 | Node 24.22.1 / npm 12.1.0；Electron 43.8.3；WebView2 Runtime 157.0.4341.42；rustc/cargo **1.97.1**（`rust-app/rust-toolchain.toml` 固定） |
| Tauri | tauri 2.12.5 / wry 0.57.2 / webview2-com(-sys) 0.39.1 |
| 媒体工具 | `node_modules/ffmpeg-static/ffmpeg.exe`；PATH 里另有 ffprobe 8.1.1；PDF 对照用 `.tmp-r0-pdf/pylibs` 的 pypdf 7.0.1（临时安装，不提交） |
| 原生构建 | MSVC Build Tools 2022：`D:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`（用 vswhere 找 vcvars64） |
| 其他 | `ELECTRON_RUN_AS_NODE=1` 仍在环境里（Electron 探针需 `env -u`）；`TMP/TEMP` 在仓库外（Electron 子进程写临时目录会 EPERM，需指向 `.tmp*/`）；npm registry 为官方 npm（AGENTS 中 npmmirror 记录已过时） |

## 3. 已交付内容索引（R0 任务 → 证据）

| 任务 | 交付 | 状态 | 证据/入口 |
|---|---|---|---|
| R0-01 基线/矩阵 | 实测基线、13 角色核对、F-01～F-20、D-01～D-20 | 部分（性能/真机未做） | [r0-baseline.md](r0-baseline.md)、[feature-parity.md](feature-parity.md) |
| R0-02 合同/夹具 | 13 角色/257 方法/10 错误码/8 限制/6 schema + 28 夹具 + 脚本 + 19 测试 | 完成 | [contract-format.md](contract-format.md)、[host-contract-inventory.md](host-contract-inventory.md)、`contracts/host/`、`test/fixtures/host-parity/` |
| R0-03 窗口 | Tauri 2 无窗口启动、透明浮层、副屏负坐标、ready/init 单次握手、`--self-test` PASS + 截图 | 原型完成（真机视觉未验） | [r0-window-prototype.md](r0-window-prototype.md)、`rust-app/src-tauri/` |
| R0-04 钩子 | 独立 C++ helper：复用 2,590 行、替换 530 行 N-API；真实选词（Notepad UIA/WinForms 剪贴板回退） | 原型完成（矩阵/联调未做） | [r0-hook-extraction.md](r0-hook-extraction.md)、[ADR-0002](adr/0002-hook-extraction.md)、`native/selection-helper/` |
| R0-05a WebView2 媒体 | 必弹选源 UI；无程序指定源 API；loopback 不可程序控制；MediaRecorder webm 闭环通过 | 完成（结论：不能作唯一后端） | [r0-media-webview.md](r0-media-webview.md)、`rust-app/prototypes/webview-media/` |
| R0-05b 原生媒体 | GDI 10s@30fps 1440×2560：301/301 帧、0 丢帧、p95 37.92ms；WASAPI loopback；A/V mux；WGC 本机 E_ACCESSDENIED | 完成（WGC 待打包身份验证） | [r0-media-native.md](r0-media-native.md)、[ADR-0001](adr/0001-media-backend.md)、`rust-app/prototypes/native-capture/` |
| R0-06 PDF | WebView2 `PrintToPdfStream` vs Electron：内容/分页/字体/文字/透明等价；纸张单位=英寸 | 完成（产品真实页未复验） | [r0-pdf-spike.md](r0-pdf-spike.md)、[ADR-0003](adr/0003-pdf-backend.md)、`rust-app/prototypes/webview-pdf-resource/` |
| R0-06 资源通道 | command 二进制 vs 自定义协议：Range/206/416、seek、TTL/撤销/遍历拒绝、20/20 自检、window label 归属 | 完成（取消/销毁释放未验） | [r0-resource-channel.md](r0-resource-channel.md)、[ADR-0005](adr/0005-binary-resource-transport.md) |
| R0-06 凭据 | Electron 43 safeStorage = `v10`+AES-256-GCM，key 在 Local State（DPAPI 包装）；Rust 双向兼容；裸 DPAPI 失败 | 完成（跨版本/真实数据未验） | [r0-credential-migration.md](r0-credential-migration.md)、[ADR-0004](adr/0004-credential-migration.md)、`rust-app/prototypes/credential-probe/`、`scripts/rust/probe-safestorage.js` |
| R0-07 安装/性能 | — | **未开始** | 见 §5 |
| 汇总 | G0 报告草案 | 未通过 | [r0-g0-report.md](r0-g0-report.md)、[r0-report.md](r0-report.md) |

## 4. 关键候选决策（详见 ADR，G0 前不冻结）

1. **媒体后端（ADR-0001）**：建议混合 C——视频/系统音频由原生层采集（WGC 优先，GDI 回退需明确风险），
   WebView 只做 UI/合成/编码（canvas + MediaRecorder 已验证）。WebView2 无法等价 Electron 的
   "程序指定源 + loopback + 无选源框"。**R5 的 8–14 人周需按此重估**；WGC 需打包身份/同意/采集指示验证。
2. **钩子（ADR-0002）**：建议提取 C++ helper（产品化 18–29 人日），保留 C++ 维护面与退出计划。
3. **PDF（ADR-0003）**：建议 WebView2 `PrintToPdfStream` 作 R4-07 主后端；纸张按英寸显式传参；
   R4-07 前必须用产品真实 `capture/print.html`（批量/长图/缺字体机器）复验。
4. **凭据（ADR-0004）**：主路径 B（读 Local State DPAPI key + AES-GCM）+ C 强制兜底；A 仅最后手段；
   不得静默清空，密钥/密文不得进日志。
5. **资源通道（ADR-0005）**：建议 D（不可猜测 ID + owner 校验；协议 Range 流式 + command 敏感内容）；
   label 级归属≠角色权限，R1-04 仍要做命令/资源权限映射。
6. ADR-0006 测试驱动、ADR-0007 最低系统：**待验证**，见 [adr/README.md](adr/README.md)。

## 5. 未完成与 G0 缺口（放行前必须闭环）

| # | 事项 | 说明/阻塞 |
|---|---|---|
| 1 | R0-07：NSIS 测试包、WebView2 有/无/离线矩阵、首轮 Release 性能/进程树对照 | 可在本机做部分（Tauri NSIS/WebView2 在线包、Release 对照）；完整矩阵需真实测试机 |
| 2 | R0-05 长时收尾：30 分钟/双音源/暂停续录/源目标变化、两路同条件对照（§9.2） | 需要较长时间与固定 Release/电源方案 |
| 3 | R0-04 收尾：浏览器/Office/资源管理器/管理员窗口矩阵、真实卡死恢复、lease `required=true`、与 `native/clipboard` 联调 | 需真机/人工操作 |
| 4 | R0-03 真机 DPI 矩阵：100%/150%/200%、白闪、单屏/无副屏拒绝 | **需要用户参与改显示缩放**（步骤见 [r0-window-prototype.md](r0-window-prototype.md) §7） |
| 5 | R0-06 收尾：产品真实 `capture/print.html` 批量/长图 PDF、图片视频资源桥真实链路、安装烟测 | 依赖 R4/R5 的接入形态 |
| 6 | ADR-0006 测试驱动（tauri-driver/CDP 对照、版本冻结、生产包不含测试端点） | 未评估 |
| 7 | ADR-0007 最低 Windows/WebView2 Runtime | 需真实测试机矩阵 |
| 8 | 修正估算 + 正式 G0 报告 | 依赖 1～7 |

G0 报告草案：[r0-g0-report.md](r0-g0-report.md) §5 有逐项收尾清单。

## 6. 复现/验证命令（本分支实测通过）

```bash
# JS/合同/白名单
node scripts/rust/extract-host-contracts.js --check
node scripts/rust/generate-host-fixtures.js --check
node --test test/host-contracts.test.js
node scripts/rust/collect-frontend-resources.js --check
node --test test/frontend-resource-whitelist.test.js
npm run check

# Rust 主 workspace（107 tests）
cargo test --manifest-path rust-app/Cargo.toml --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1

# R0-03 窗口自检（可见窗口只在副屏；约 5s 自动退出）
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test --hold-ms 5000

# 独立原型（各自 [workspace] 隔离；fmt/clippy/test 已通过）
cargo test --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml --locked   # 15 tests
cargo fmt --manifest-path rust-app/prototypes/<name>/Cargo.toml -- --check
cargo clippy --manifest-path rust-app/prototypes/<name>/Cargo.toml --all-targets -- -D warnings

# 原型运行入口
rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild
rust-app/prototypes/native-capture/README.md（--probe-wgc / --capture auto / --audio 等）
native/selection-helper/build.ps1 -Clean -SelfTest
scripts/rust/probe-electron-pdf.js（Electron 需 env -u ELECTRON_RUN_AS_NODE，--no-sandbox 在脚本前）
scripts/rust/probe-safestorage.js（同上；--decrypt 方向）
```

完整 `npm test`/`test:e2e` 在本机受限宿主需要 AGENTS.md 的四类陷阱处理（`ELECTRON_RUN_AS_NODE`、
`--no-sandbox` 位置、TMP/TEMP 指向 `.tmp*/`、spawn hook），本轮未执行；CI 的 quality job 曾在
手动 dispatch 中全绿（但按用户要求本轮不再等待 CI）。

## 7. 环境陷阱与经验（避免重复踩坑）

1. **CI CRLF 陷阱**：Windows checkout 可能把 LF 转 CRLF，破坏夹具 sha256 与 `--check`。已用
   `.gitattributes`（`contracts/host/host-contracts.json`、`test/fixtures/host-parity/**` 固定 `eol=lf`）
   + 脚本/测试规范化修复；新增字节级校验时必须同时考虑行尾。
2. **dsh-ops 并发执行器 bug**：多 Agent 并行跑 bash 时偶发 `EXECUTOR_UNAVAILABLE`（niubash 链接失败），
   等 10–20 秒重试即可；不要绕过沙箱。
3. **WGC 在本机被拒**：`CreateForMonitor`/`CreateForWindow` 均 `E_ACCESSDENIED 0x80070005`；per-app
   `graphicsCaptureProgrammatic` 允许项注入也无效。原型已实现 WGC 代码但**无成功证据**；R5 若选 WGC
   必须验证打包身份/能力声明/用户同意/采集指示。
4. **本机 OS 输入注入受限**：`SetCursorPos`/`SendInput` 在受限宿主不生效；WebView 激活用 Chromium CDP
   `Input.dispatchMouseEvent` 成功；钩子真实选词自动化脚本已绕过（SendInput 在 helper 场景有效，与宿主不同）。
5. **可见窗口只放副屏**；无副屏时先询问用户，不要在主屏开窗。
6. **证据不进 git**：`.tmp-r0-*` 全部 gitignore；文档里写命令/关键输出/哈希，不要把大日志塞进仓库。
7. **原型工程约定**：`rust-app/prototypes/<name>/` 各自独立 Cargo 工程（`Cargo.toml` 内空 `[workspace]`），
   不要并入主 workspace；`rust-app/target` 与各原型 `target/`、`gen/` 均已 gitignore。

## 8. 工作边界（接手时必须遵守）

- 不改 `main/`、`preload*.js`、`shared/` 生产代码；本分支所有原型不接入产品入口。
- 不改 `native/ocr`、`native/clipboard`、`native/everything-search` 现有独立 Cargo 工程（各自锁文件）。
- 不改现有 Electron 构建入口与 CI 工作流；Rust CI 属 R1 范围。
- 不改 `package.json`/`package-lock.json`；不在原型里 `npm install`（PDF 对照的 pypdf 只装在 `.tmp-r0-pdf/pylibs`）。
- 合成数据/合成凭据：不得读取真实用户凭据/设置；不得把真实 key 或密文写进仓库或日志。
- ADR/报告中的"候选/待验证"在 G0 前不得改成"已选定"；新证据要回写 [r0-report.md](r0-report.md)、
  [r0-g0-report.md](r0-g0-report.md) 与对应 ADR 的变更记录。
- 提交说明写清"改变了什么、为什么、如何验证、剩余限制"（计划 §11）。

## 9. 建议的接手顺序

1. 跑 §6 的快速验证（约 1–2 分钟），确认分支状态与本地环境。
2. 读 [r0-g0-report.md](r0-g0-report.md) §5 与 [adr/README.md](adr/README.md)，确认下一步优先级。
3. **R0-07 可先在本机做**：Tauri NSIS 测试包、WebView2 在线/离线安装方案、首轮 Release 进程树/Private Bytes
   对照（固定电源方案；未签名候选包必须标 `NotSigned`；不以 Debug 数据下性能结论）。
4. 与用户确认后补真机矩阵（100/150/200% DPI、WebView2 有/无/离线、RDP/休眠）与 R0-05 长时媒体。
5. 补齐 ADR-0006/0007，汇总修正估算，出正式 G0 报告；G0 通过后再按
   [r0-baseline.md](r0-baseline.md) §6.3 的 R1-a～e 切片开始 R1。

## 10. 未决问题（需要用户/产品决策）

1. 是否接受"媒体后端改为原生采集 + WebView 合成/编码"候选，并据此重估 R5（计划总量 38–63 人周需更新）。
2. 是否接受"钩子保留 C++ helper 维护面"（需登记退出计划），还是要求纯 Rust 重写（成本更高）。
3. R0-03 真机 DPI 矩阵需要用户配合改显示缩放/切换单屏。
4. R0-07 完整矩阵需要真实测试机或用户桌面会话；本机只能做部分。
5. PR #5 是否先合并（R0 证据批次、不改产品代码）；合并后 R0 剩余工作可在新分支继续。

## 11. 相关文档/目录地图

```text
docs/plans/rust-migration/
  README.md                  # 索引（从这里进入）
  handoff.md                 # 本文件
  contract-format.md         # 合同/夹具格式
  feature-parity.md          # R0-01 功能矩阵
  r0-baseline.md             # 基线/任务状态/G0 决策登记
  host-contract-inventory.md # R0-02 盘点与差异
  r0-window-prototype.md     # R0-03
  r0-hook-extraction.md      # R0-04
  r0-media-webview.md        # R0-05a
  r0-media-native.md         # R0-05b
  r0-pdf-spike.md            # R0-06 PDF
  r0-resource-channel.md     # R0-06 资源通道
  r0-credential-migration.md # R0-06 凭据
  r0-g0-report.md            # G0 报告草案（未通过）
  r0-report.md               # R0 实施报告（最终状态）
  adr/                       # ADR 索引 + 0000 模板 + 0001~0007

contracts/host/              # 机器可读合同
test/fixtures/host-parity/   # 跨语言夹具 + manifest
test/host-contracts.test.js  # 合同测试（19）
test/frontend-resource-whitelist.test.js
scripts/rust/                # 合同/夹具生成、白名单收集、check-rust-app、Electron 探针
rust-app/                    # 主隔离 workspace（6 crates + src-tauri R0-03 原型）
rust-app/prototypes/         # 独立原型：native-capture / webview-media / webview-pdf-resource / credential-probe
native/selection-helper/     # R0-04 独立 C++ helper
```
