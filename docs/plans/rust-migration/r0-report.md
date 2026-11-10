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
| R0-04 去 N-API 钩子小样 + Rust 剪贴板联调 | **未开始** | 现有源码：`vendor/selection-hook/`、`main/services/selection-hook-host.js`、`native/clipboard/` | 选词/回退复制/lease/前台授权/崩溃恢复均未演示 |
| R0-05 WebView 媒体路径验证（失败则原生采集闭环） | **未开始（最高风险）** | `main/domains/record/index.js:1367`、`record/record.js:803`；本机无 DXGI 桌面复制 | 全屏/区域/窗口、双音源、暂停、30 分钟时钟均未验证 |
| R0-06 v3 文档/v1 项目/合成凭据导入、图片/视频资源桥、PDF 样例 | **未开始（仅文档/项目夹具）** | `test/fixtures/host-parity/capture-document/`、`recording-project/` | 凭据、PDF、图片/视频资源桥与"成功/失败/恢复"用例未做 |
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
| G0 架构可行 | **未通过** | 三条高风险链路仅窗口原型有实测；媒体/钩子未做；G0 决策报告未产出，七项决策全部待验证 |
| G1 平台可用 | **未通过** | R1 未开始 |
| G2 日常功能对齐 | **未通过** | R3～R7 未开始 |
| G3 运行环境去 Node | **未通过** | 本分支未验证运行依赖清单/进程树 |
| G4 可发布 | **未通过** | 无安装包/升级/回退/真机证据 |

## 10. 下一轮建议（详版见 r0-baseline.md §6）

1. 补 R0-03 真机矩阵（100/150/200% DPI、负坐标/拔插、白闪录像）并冻结 R3 坐标基线；
2. 做 R0-05 媒体最小闭环（WebView 路径 vs 原生采集 spike），这是 G0 与估算的第一决定项；
3. 做 R0-04 钩子提取小样（独立 helper + 现有 Rust 剪贴板联调）；
4. 做 R0-06 合成凭据/PDF/图片视频资源通道小样与 ADR；
5. 做 R0-07 NSIS 测试包 + WebView2 矩阵 + 首轮进程树/Private Bytes 对照（固定 Release、电源方案）；
6. 以上至少 R0-03/R0-04/R0-05 有实测结论后，再产出 G0 决策报告并重估 R1～R8。

## 11. 已知限制

- 本分支所有合同/夹具是 **R0 证据，不是生产合同**；生产协议冻结在 R1。
- 环境：`ELECTRON_RUN_AS_NODE=1` 仍设置（Electron 探针需清除，见 AGENTS）；本机 `TMP/TEMP`
  指向仓库外临时目录（spawned Electron 子进程需改 `.tmp*/`）；本机 registry 为官方 npm，
  与 AGENTS 记录的 npmmirror 不一致（R0-07/CI 复核）。
- `rust-app/target` 在 Tauri 原型编译后约 2.9 GiB（未提交，gitignore）；CI 接入（fmt/clippy/test +
  合同/夹具 check）按计划属 R1，本分支未改任何 CI 工作流。
- 未运行完整 `npm test`/E2E/打包；JS 侧改动仅为新增测试与 scripts/rust 工具，未改生产代码。
