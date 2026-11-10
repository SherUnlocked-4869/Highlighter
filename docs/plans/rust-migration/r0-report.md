# R0 实施报告（分支 `codex/rust-r0-baseline-contracts`）

日期：2026-11-10。状态：**R0 部分完成；G0 未通过**。上位计划：
[2026-11-10-rust-migration-development-plan.md](../2026-11-10-rust-migration-development-plan.md)。
本报告是**最终验收口径**：`r0-baseline.md` / `feature-parity.md` / `host-contract-inventory.md`
写于并行产出收口前，其"写作时"状态以本报告与 `git log` 为准。

## 1. 结论摘要

- 计划 §12 首批 6 项：第 1、2 项完成；第 3 项完成（数据根仅有 Rust **locator 原型**，未接入产品数据）；
  第 4 项只做了窗口原型（钩子/回贴、媒体采集未开始）；第 5、6 项未完成。
- 可复跑的 R0 产出：宿主合同 + 28 个跨语言夹具（Node↔Rust 双端严格对照）、6 crate 的 Rust
  workspace（107 tests）、Tauri 2 透明浮层原型（编译/自检 PASS、副屏截图证据）、前端资源打包白名单。
- **G0 未通过**：七项决策（媒体后端/钩子边界/最低系统 Runtime/资源传输/PDF/凭据/测试驱动）
  全部"待验证"；R0-04～R0-07 未开始。本分支不构成 R1 放行依据（计划 §8）。
- 不声称"去 Node/Electron"、不声称性能收益；运行时依赖清单与进程树证据属 G3。

## 2. 交付矩阵（计划 §7 R0 任务）

| 任务 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| R0-01 基线、功能开关/数据集/硬件、入口盘点 | **部分完成** | [r0-baseline.md](r0-baseline.md)、[feature-parity.md](feature-parity.md)；13 角色核对表、F-01～F-20、D-01～D-20 | 性能对照与真机矩阵未执行；§9.2 阈值未冻结 |
| R0-02 13 preload/API、IPC 角色、schema、服务协议、资源限制 | **完成** | [host-contract-inventory.md](host-contract-inventory.md)、`contracts/host/host-contracts.json`、`test/fixtures/host-parity/`（28 case）、[contract-format.md](contract-format.md) | `capture:record-history` 死通道、`capture/print.html` 非角色窗口留 R1 决策 |
| R0-03 Tauri 托盘/无窗口启动、副屏截图浮层、Canvas 最小编辑保存 | **原型完成（真机视觉矩阵未验证）** | [r0-window-prototype.md](r0-window-prototype.md)、`rust-app/src-tauri/`；`--self-test` 2× PASS | 托盘/主窗口/单实例未做；100/200% DPI 视觉、白闪、单屏拒绝、鼠标穿透未验证 |
| R0-04 去 N-API 钩子小样 + Rust 剪贴板联调 | **原型完成（真实选词已验证；与 Rust 剪贴板联调未做）** | [r0-hook-extraction.md](r0-hook-extraction.md)、[ADR-0002](adr/0002-hook-extraction.md)、`native/selection-helper/` | 浏览器/Office/资源管理器/管理员窗口矩阵、真实卡死恢复、lease required=true、Rust 剪贴板联调未验证 |
| R0-05 WebView 媒体路径验证（失败则原生采集闭环） | **两路 spike 完成（后端选型仍待 G0）** | [r0-media-webview.md](r0-media-webview.md)、[r0-media-native.md](r0-media-native.md)、[ADR-0001](adr/0001-media-backend.md) | WebView2 无法程序指定源/loopback；原生 GDI+WASAPI 可行下限成立但 WGC 本机被拒；30 分钟/双音源/暂停续录/两路同条件对照未验证 |
| R0-06 v3 文档/v1 项目/合成凭据导入、图片/视频资源桥、PDF 样例 | **大部分完成（安装烟测未做）** | [r0-credential-migration.md](r0-credential-migration.md)、[r0-pdf-spike.md](r0-pdf-spike.md)、[r0-resource-channel.md](r0-resource-channel.md)、`test/fixtures/host-parity/` | 凭据双向实测、PDF 双后端对照、资源通道 Range/鉴权均完成；产品真实 print.html 批量/长图、图片视频资源桥真实链路、安装烟测未做 |
| R0-07 NSIS 测试包、WebView2 有/无/离线、首轮性能对照 | **未开始** | 现有脚本 `scripts/verify-release.ps1` 等；`docs/releases/evidence/` 不存在 | 未建包、未做 Runtime 矩阵与性能对照；工具链/Runtime 未冻结 |

## 3. 提交清单

| 提交 | 内容 |
|---|---|
| `82c0b41` | 计划、可行性调研、合同/夹具格式草案与 `.gitignore` 更新 |
| `f73dc61` | 前端资源打包白名单 + 收集器 + 9 项测试 |
| `f863c69` | 宿主合同（13 角色/257 方法）、28 个夹具、提取/生成脚本、19 项合同测试、差异清单 |
| `22f1ace` | R0-01 功能矩阵与实测基线两份文档 |
| `04ff372` | 隔离 Rust workspace（6 crates + 检查脚本，92 tests） |
| `3dc82cb` | 计划状态/README/首批清单回写 |
| 本报告提交 | Tauri R0-03 原型（`rust-app/src-tauri/`，15 tests）、r0-window-prototype 文档、本报告与 `r0-baseline.md`/`rust-app/README.md` 更新 |
| `e401a6f` | R0-06 合成凭据跨语言验证（OSCrypt v10 + Local State DPAPI key + AES-GCM 双向实测）+ ADR-0004 |
| `985c6b6` | R0-04 独立 C++ selection helper（真实选词验证）+ r0-hook-extraction + ADR-0002 |
| 本批次提交 | R0-05a/R0-05b 媒体两路 spike（`rust-app/prototypes/webview-media/`、`native-capture/`）、R0-06 PDF/资源通道（`rust-app/prototypes/webview-pdf-resource/`、`scripts/rust/probe-electron-pdf.js`）、ADR-0001/0003/0005、r0-g0-report 草案 |

## 4. 验证命令与结果（Lead 在本分支实际运行）

```text
$ node scripts/rust/extract-host-contracts.js --check
contracts/host/host-contracts.json is up to date (13 roles, 257 methods, 110493 bytes)   # exit 0

$ node scripts/rust/generate-host-fixtures.js --check
test/fixtures/host-parity/manifest.json and 28 case files are up to date                 # exit 0

$ node --test test/host-contracts.test.js
tests 19  pass 19  fail 0                                                                # exit 0

$ node scripts/rust/collect-frontend-resources.js --check
frontend-resources: OK 191 files, 2430229 bytes                                          # exit 0

$ node --test test/frontend-resource-whitelist.test.js
tests 9  pass 9  fail 0                                                                  # exit 0

$ npm run check
Syntax check passed for 489 JavaScript files. / architecture-check: ok (main.js 1327 lines, ceiling 1330, domains 10) / i18n TOTAL 595   # exit 0

$ cargo test --manifest-path rust-app/Cargo.toml --locked
107 passed / 0 failed（8 个测试二进制 + doctest；含 src-tauri 15）

$ powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1
check-rust-app: OK (fmt, clippy, test --locked)                                          # exit 0

$ highlighter-r0-window.exe --self-test --hold-ms 5000
[PASS] r0-03 self-test: secondary_monitor_index=1 negative_y=true ready/init_once ok dpr=1.25 canvas_dpr_ok=true   # exit 0（2 次运行均 PASS）
```

本轮 spike 追加验证（全部实际运行）：

```text
$ cargo test --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml --locked
15 passed / 0 failed
$ cargo fmt --check / cargo clippy -D warnings（四个原型 crate：native-capture / webview-media / webview-pdf-resource / credential-probe）
全部通过
$ node --check scripts/rust/probe-electron-pdf.js scripts/rust/probe-safestorage.js
通过
```

**未执行（不得视为通过）**：完整 `npm test`（1278 项）、`test:e2e`、覆盖率、打包/`verify:package`、
硬件矩阵、性能对照、任何 100%/200% DPI 真机视觉验收、R0-04/R0-05/R0-06/R0-07 的任何验证。

## 5. 冻结的宿主合同（R0-02 摘要）

- `contracts/host/host-contracts.json`（110,493 B）：**13 角色、257 个已解析方法、142 handles、
  49 listeners、62 receives、10 个错误码、8 项 §9.1 资源限制、6 项 §5.1 存储 schema**。
  角色序列化名与 Rust `WindowRole` 一一对应；`settings` 无 schemaVersion 记 `null`（不编造）。
- 28 个夹具 / 5 组：capture-document 5、clipboard-protocol 12、recording-export-options 5、
  recording-project 4、settings 2；`manifest.json` 为每个 case 记录 sha256，`--check` 逐字节校验。
- Rust 侧**只读**真实产物并严格对照（缺失即失败）：clipboard 12 case（4 valid 逐字节、8 invalid
  `failAt=feed|finish` 同阶段失败且同为 `invalid-frame`）、export limits 5 case、
  合同 JSON 的 13 角色/257 方法/10 错误码/8 限制/6 schema 版本。
- 已登记差异：`capture/print.html` 是第 14 个被加载页面（复用 `preload-capture.js`、不在
  `IPC_SURFACES`，任何 IPC 都会被 page-not-allowed）；`toolbar.onSelection` 只有模块级
  `selection:text` 订阅；`capture:record-history` 通道在渲染层无调用方（死通道）→ R1 决策。

## 6. Rust workspace 摘要（R0 隔离工程）

- `rust-app/`：workspace + `rust-toolchain.toml` 固定 **1.97.1**（rustfmt/clippy），`Cargo.lock`
  提交；成员 `crates/{contracts,core,storage,service-host,media,windows-platform}` + `src-tauri`。
- 测试分布（107）：contracts 18、core 9、storage 20、service-host 22、media 12、windows-platform 11、
  src-tauri 15。
- 边界：`contracts` 仅有 serde/serde_json（依赖方向测试兜底）；core/storage/media/windows-platform
  不依赖宿主；无 Electron/Node/真实用户数据。
- 已知限制：视频 normalize 归 R5；原子写无目录 fsync（R2/R8 故障注入）；DPI 舍入为候选实现（R3 冻结）；
  应用命令 capability ACL 隔离留 R1-04。

## 7. R0-03 窗口原型摘要

- 结构：`tauri.conf.json` 无窗口启动（`app.windows=[]`）、`frontendDist=prototype-ui`、最小 CSP；
  最小 capability 只授 `core:event:allow-listen` 且只匹配 `prototype-overlay` 窗口。
- 自检实测：副屏 `\\.\DISPLAY2` 物理 `(3840,-170)`、`1440×2560`、**125%**；窗口请求=实际位置
  `visible=true`；ready 恰好 1 次、init 恰好 1 次（重复 ready 不重发）；`dpr=1.25`，
  canvas `1152×2048`→像素 `1440×2560`；退出后应用与相关 `msedgewebview2.exe` 进程为 0；
  虚拟桌面截图确认浮层**只在副屏**、透明区可见桌面、主屏无遮挡（证据在 gitignore 的 `.tmp-r0/`）。
- **基线更正**：实际是**混合 DPI**（主屏 150% + 副屏 125%），此前 `r0-baseline.md` §1.3 的
  "两屏均 150%"读数被 Windows DPI 虚拟化放大，已按 R0-03 per-monitor aware 证据更正。
- 隔离缺口：Tauri 的 `invoke_handler` 应用命令默认不受 capability ACL 约束，任何窗口可调用；
  原型在命令入口做 `window-owner-mismatch` 标签校验作为纵深防御，**不等于** R1-04 的角色权限映射。
- 未验证：100%/200% DPI 视觉、首帧白闪、单屏/无副屏拒绝路径（改显示配置需用户确认）、鼠标穿透/
  焦点策略、WebView2 子进程组完整计数、安装包/WebView2 分发。

## 8. 未完成与风险

1. **媒体后端（R0-05）完全未验证**：WebView2 的 `setDisplayMediaRequestHandler` 指定源+loopback
   无等价承诺，原生采集（WGC/WASAPI）成本未评估——直接决定路线与 38～63 人周估算是否成立。
2. **钩子/剪贴板真实链路（R0-04）未验证**：C++ N-API addon 不能给 Rust 用；真实剪贴板受私有
   Window Station 限制，回贴/前台授权/错误目标矩阵无真机证据。
3. **数据/凭据/PDF/资源通道（R0-06）未做**：v3/v1 夹具已冻结，但凭据迁移格式、PDF 等价、
   图片/视频资源桥仍无 ADR 与小样。
4. **安装/性能（R0-07）未做**：无 NSIS 测试包、无 WebView2 有/无/离线矩阵、无首轮性能对照，
   性能目标阈值未冻结（计划 §9.2），不能下"内存下降"结论。
5. 基线已知缺陷 D-01～D-20 全部仍在（CI 从未通过的渲染用例、真实桌面链路无自动化、硬件证据
   目录缺失等），迁移验收时不得把基线缺陷算作迁移回归。

## 9. 门禁状态（计划 §8）

| 门禁 | 状态 | 说明 |
|---|---|---|
| G0 架构可行 | **未通过（有进展）** | 三条高风险链路均有实测证据（窗口/钩子/媒体两路）；五项决策（媒体/钩子/PDF/凭据/资源）为"候选"；缺 R0-07 版本矩阵与性能、长时媒体、真机 DPI 矩阵、修正估算；G0 报告草案见 [r0-g0-report.md](r0-g0-report.md) |
| G1 平台可用 | **未通过** | R1 未开始 |
| G2 日常功能对齐 | **未通过** | R3～R7 未开始 |
| G3 运行环境去 Node | **未通过** | 本分支未验证运行依赖清单/进程树 |
| G4 可发布 | **未通过** | 无安装包/升级/回退/真机证据 |

## 10. 下一轮建议（详版见 [r0-g0-report.md](r0-g0-report.md) §5）

1. R0-07：NSIS 测试包 + WebView2 有/无/离线矩阵 + 首轮 Release 性能/进程树对照（固定电源方案）；
2. R0-05 收尾：两路同条件对照（§9.2）+ 30 分钟双音源/暂停续录 + WGC 打包身份实测；
3. R0-04 收尾：浏览器/Office/资源管理器/管理员窗口矩阵 + 真实卡死恢复 + lease required=true + 与 `native/clipboard` 联调；
4. R0-03 收尾：需要用户参与完成 100/150/200% DPI 与单屏/多屏视觉矩阵（可见窗口放副屏）；
5. R0-06 收尾：产品真实 `capture/print.html` 批量/长图 PDF、图片视频资源桥真实链路、安装烟测；
6. 测试驱动 ADR-0006 与最低系统 ADR-0007 的实测与版本冻结；
7. 汇总修正估算与门禁结论，形成正式 G0 报告并重估 R1～R8（媒体后端改为原生采集候选后 R5 工时要重估）。

## 11. R0 追加批次（2026-11-10 晚，三条高风险链路 + 数据/资源/PDF/凭据）

本批次补齐计划 §7 R0-04/R0-05/R0-06 的证据，全部为独立原型，**未接入产品入口**：

| 任务 | 结果摘要 | 证据 |
|---|---|---|
| R0-04 钩子提取 | `native/selection-helper/`：vendor 2,590 行零改动复用；替换唯一 N-API 绑定 530 行；clean build 6.4s；真实选词验证（Notepad UIA 双击/拖选、WinForms 剪贴板回退 140ms）；成本：产品化 18–29 人日 | [r0-hook-extraction.md](r0-hook-extraction.md)、[ADR-0002](adr/0002-hook-extraction.md) |
| R0-05a WebView2 媒体 | 必弹选源 UI；`ScreenCaptureStarting` 无指定源方法（`SetHandled` 不抑制 UI）；loopback 无法程序控制；MediaRecorder canvas webm 闭环通过；结论：WebView2 不能作唯一后端 | [r0-media-webview.md](r0-media-webview.md) |
| R0-05b 原生媒体 | GDI 10s@30fps 1440×2560：301/301 帧、0 丢帧、p95 37.92ms；ffmpeg 管道 418 MiB/s、CPU≈1.45 核；WASAPI loopback 10s 精确字节；A/V mux 通过（end_skew -44.33ms）；WGC 本机 `E_ACCESSDENIED`（代码完整但无成功证据） | [r0-media-native.md](r0-media-native.md) |
| R0-06 PDF | WebView2 `PrintToPdfStream` vs Electron `printToPDF`：页数/文字/字体/透明逐项等价，MediaBox 差 0.96pt，纸张单位=英寸被证实；二进制不等价 | [r0-pdf-spike.md](r0-pdf-spike.md)、[ADR-0003](adr/0003-pdf-backend.md) |
| R0-06 资源通道 | command 二进制 vs 自定义协议：Range/206/416、seek、TTL/撤销/遍历拒绝、20/20 自检；`UriSchemeContext::webview_label()` 窗口归属可行（label 级）；20MiB 无 Base64 膨胀 | [r0-resource-channel.md](r0-resource-channel.md)、[ADR-0005](adr/0005-binary-resource-transport.md) |
| R0-06 凭据 | Electron 43 safeStorage = `v10` + AES-256-GCM，key 在 `Local State`（DPAPI 包装 32B）；Rust 解密 Electron 密文与反向加密均通过；裸 DPAPI 失败（负对照） | [r0-credential-migration.md](r0-credential-migration.md)、[ADR-0004](adr/0004-credential-migration.md) |

G0 汇总草案（未通过）见 [r0-g0-report.md](r0-g0-report.md)；ADR 索引见 [adr/README.md](adr/README.md)。

## 12. 已知限制

- 本分支所有合同/夹具是 **R0 证据，不是生产合同**；生产协议冻结在 R1。
- 环境：`ELECTRON_RUN_AS_NODE=1` 仍设置（Electron 探针需清除，见 AGENTS）；本机 `TMP/TEMP`
  指向仓库外临时目录（spawned Electron 子进程需改 `.tmp*/`）；本机 registry 为官方 npm，
  与 AGENTS 记录的 npmmirror 不一致（R0-07/CI 复核）。
- `rust-app/target` 在 Tauri 原型编译后约 2.9 GiB（未提交，gitignore）；CI 接入（fmt/clippy/test +
  合同/夹具 check）按计划属 R1，本分支未改任何 CI 工作流。
- 未运行完整 `npm test`/E2E/打包；JS 侧改动仅为新增测试与 scripts/rust 工具，未改生产代码。
