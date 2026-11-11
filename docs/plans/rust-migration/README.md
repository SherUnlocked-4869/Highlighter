# Rust 迁移 R0 实施索引

日期：2026-11-10（更新 2026-11-11 14:00：R0-07 本机部分、ADR-0006/0007 证据与性能基线）。分支：`codex/rust-r0-baseline-contracts`（基线源码 `3df7129`，Highlighter 4.2.0 / Electron 43.8.3）。
上位计划：[2026-11-10-rust-migration-development-plan.md](../2026-11-10-rust-migration-development-plan.md)；可行性调研：[2026-11-10-rust-migration-feasibility.md](../../research/2026-11-10-rust-migration-feasibility.md)。

**状态：R0 进行中；G0 未通过。** 本目录只登记 R0 的实际产物、证据和缺口，不声称任何架构选型已验证，
也不代表 R1 已获准开始（计划 §8：R1 以 G0 通过为前提）。G0 汇总草案见 [r0-g0-report.md](r0-g0-report.md)。

## 1. 文档索引

| 文档 | 内容 | 状态 |
|---|---|---|
| [handoff.md](handoff.md) | **交接文档**：分支/PR 状态、已完成/未完成清单、环境陷阱、接手顺序与未决问题 | **接手先读** |
| [contract-format.md](contract-format.md) | 宿主合同与跨语言夹具格式（草案 v1），R0-02 实现规格 | 已落地并按其实现 |
| [feature-parity.md](feature-parity.md) | R0-01 功能矩阵：13 角色核对 + F-01～F-20 + D-01～D-20 | 已完成（文档） |
| [r0-baseline.md](r0-baseline.md) | R0-01 实测基线、R0 任务状态、G0 决策登记、R1 切片建议 | 已完成（含 R0-04/05/06 状态更新） |
| [host-contract-inventory.md](host-contract-inventory.md) | R0-02 合同盘点与差异清单 | 已完成 |
| [r0-window-prototype.md](r0-window-prototype.md) | R0-03 Tauri 透明窗口/截图浮层原型 | 原型完成（编译/自检 PASS；真机视觉矩阵未验证） |
| [r0-hook-extraction.md](r0-hook-extraction.md) | R0-04 划词钩子独立 helper 提取小样（真实选词验证） | 原型完成；ADR-0002 候选 |
| [r0-media-webview.md](r0-media-webview.md) | R0-05a WebView2 媒体路径能力验证 | 实测完成；WebView2 不可作唯一后端 |
| [r0-media-native.md](r0-media-native.md) | R0-05b 原生采集最小闭环（GDI/WGC + WASAPI + ffmpeg） | 实测完成；可行下限成立、WGC 待打包身份 |
| [r0-pdf-spike.md](r0-pdf-spike.md) | R0-06 PDF 双后端对照（WebView2 vs Electron） | 实测完成；ADR-0003 候选 |
| [r0-resource-channel.md](r0-resource-channel.md) | R0-06 二进制资源通道（command vs 自定义协议） | 实测完成；ADR-0005 候选 |
| [r0-credential-migration.md](r0-credential-migration.md) | R0-06 合成凭据迁移（safeStorage ↔ Rust） | 实测完成；ADR-0004 候选 |
| [r0-installation-matrix.md](r0-installation-matrix.md) | R0-07 安装/分发矩阵：三种 NSIS 测试包、WebView2 五模式对照、缺失 Runtime 行为、版本冻结 | 部分完成；安装链路阻塞（未验证） |
| [r0-performance-baseline.md](r0-performance-baseline.md) | R0-07 首轮性能/进程树对照（两轮取样）、阈值冻结 T1～T3、T4 未冻结 | 已完成（本机，跨机器不可比） |
| [r0-test-driver.md](r0-test-driver.md) | ADR-0006 证据：tauri-driver 2.1.0 + msedgedriver 157.0.4341.46 最小 WebDriver 全流程、能力边界、版本冻结 | 已完成（CI/多版本未验证） |
| [r0-minimum-windows-runtime.md](r0-minimum-windows-runtime.md) | ADR-0007 调研：Electron/Tauri/WebView2 官方支持矩阵、Win10 22H2 生命周期、候选 A～D | 已完成（需真实测试机矩阵） |
| [r0-g0-report.md](r0-g0-report.md) | G0 决策报告草案：七项决策状态、未完成 R0 清单 | **G0 未通过** |
| [r0-report.md](r0-report.md) | 本分支 R0 实施报告：交付矩阵、验证命令、缺口、门禁状态 | **最终状态以本文件为准** |
| [adr/README.md](adr/README.md) | ADR 索引（0001 媒体 / 0002 钩子 / 0003 PDF / 0004 凭据 / 0005 资源通道 / 0006 测试驱动 / 0007 最低系统） | 七项候选（0006/0007 本轮由待验证推进为候选），均未冻结 |

## 2. 机器可读产物与代码

| 产物 | 路径 | 验证入口 |
|---|---|---|
| 宿主合同 | [`contracts/host/host-contracts.json`](../../../contracts/host/host-contracts.json)（13 角色 / 257 方法 / 10 错误码 / 8 项限制 / 6 项 schema） | `node scripts/rust/extract-host-contracts.js --check` |
| 跨语言夹具 | [`test/fixtures/host-parity/`](../../../test/fixtures/host-parity/)（5 组 28 case + manifest sha256） | `node scripts/rust/generate-host-fixtures.js --check` |
| 合同测试 | [`test/host-contracts.test.js`](../../../test/host-contracts.test.js)（19 测试） | `node --test test/host-contracts.test.js` |
| 前端资源白名单 | [`scripts/rust/frontend-resources.whitelist.json`](../../../scripts/rust/frontend-resources.whitelist.json) + 收集器（10 页面 + shared + assets） | `node scripts/rust/collect-frontend-resources.js --check` |
| Rust workspace | [`rust-app/`](../../../rust-app)（6 crates + `src-tauri` R0-03 原型，107 tests） | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1` |
| 钩子 helper | [`native/selection-helper/`](../../../native/selection-helper)（独立 C++ exe，build.ps1） | `native/selection-helper/build.ps1 -Clean -SelfTest` |
| 媒体原生原型 | [`rust-app/prototypes/native-capture/`](../../../rust-app/prototypes/native-capture) | 见原型 README 与 r0-media-native §3.2 |
| 媒体 WebView 原型 | [`rust-app/prototypes/webview-media/`](../../../rust-app/prototypes/webview-media) | `rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild` |
| PDF/资源通道原型 | [`rust-app/prototypes/webview-pdf-resource/`](../../../rust-app/prototypes/webview-pdf-resource)（`--pdf` / `--resource`，15 tests） | `cargo test --manifest-path ... --locked` |
| 凭据探针 | [`rust-app/prototypes/credential-probe/`](../../../rust-app/prototypes/credential-probe) + [`scripts/rust/probe-safestorage.js`](../../../scripts/rust/probe-safestorage.js) | 见 r0-credential-migration §6 |

> 所有原型均为独立 Cargo 工程（自带空 `[workspace]`，不并入主 workspace），未接入产品入口；
> 运行证据在 `.tmp-r0-*/`（gitignore，不提交）。

## 3. 复现命令（本分支实测，均有非零失败即中止语义）

```bash
node scripts/rust/extract-host-contracts.js --check
node scripts/rust/generate-host-fixtures.js --check
node --test test/host-contracts.test.js
node scripts/rust/collect-frontend-resources.js --check
node --test test/frontend-resource-whitelist.test.js
npm run check
cargo test --manifest-path rust-app/Cargo.toml --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1
# R0-03 窗口自检（可见窗口只在副屏）
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test --hold-ms 5000
```

## 4. 与计划首批清单的对应（计划 §12）

1. 基线/功能矩阵 —— 完成（性能/真机对照未执行，R0-07）。
2. API/角色/错误/夹具冻结 —— 完成并接入 Rust 对照测试。
3. 隔离 workspace / 数据根 / 资源打包白名单 —— workspace 与白名单完成；数据根为 Rust locator 原型。
4. 三类原型 —— 窗口/截图（R0-03）、钩子/回贴（R0-04）、媒体采集（R0-05）均已有原型与证据；
   真机矩阵与长时验证未完成。
5. 数据/凭据/PDF/视频资源小样与安装烟测 —— 文档/项目夹具、凭据、PDF、资源通道小样完成；
   安装烟测与产品真实链路未做。
6. G0 决策报告 —— **草案已产出但 G0 未通过**（[r0-g0-report.md](r0-g0-report.md)），缺 R0-07 版本矩阵/性能、
   长时媒体、真机 DPI 矩阵、测试驱动/最低系统决策与修正估算。

## 5. 边界声明

- 不改动 `main/`、`preload*.js`、`shared/` 生产代码；Electron 构建入口与现有测试入口未被替换。
- 运行环境"去 Node/Electron"未验证（计划 G3）；本分支不包含安装包或发布流程改动。
- 所有 R0 结论以本目录文档与 `git log` 的实际提交为准；文档中的"待验证"不得改写成已验证。
