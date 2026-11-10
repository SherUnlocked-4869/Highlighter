# Rust 迁移 R0 实施索引

日期：2026-11-10。分支：`codex/rust-r0-baseline-contracts`（基线源码 `3df7129`，Highlighter 4.2.0 / Electron 43.8.3）。
上位计划：[2026-11-10-rust-migration-development-plan.md](../2026-11-10-rust-migration-development-plan.md)；可行性调研：[2026-11-10-rust-migration-feasibility.md](../../research/2026-11-10-rust-migration-feasibility.md)。

**状态：R0 进行中；G0 未通过。** 本目录只登记 R0 的实际产物、证据和缺口，不声称任何架构选型已验证，也不代表 R1 已获准开始（计划 §8：R1 以 G0 通过为前提）。

## 1. 产物索引

| 文档 | 内容 | 状态 |
|---|---|---|
| [contract-format.md](contract-format.md) | 宿主合同与跨语言夹具格式（草案 v1），R0-02 实现规格 | 已落地并按其实现 |
| [feature-parity.md](feature-parity.md) | R0-01 功能矩阵：13 角色核对 + F-01～F-20 功能域 + D-01～D-20 缺陷/未验证证据 | 已完成（文档） |
| [r0-baseline.md](r0-baseline.md) | R0-01 实测基线：版本/环境/显示器、R0-01～07 状态、G0 七项决策登记（全部待验证）、R1 切片建议 | 已完成（文档） |
| [host-contract-inventory.md](host-contract-inventory.md) | R0-02 合同盘点与差异清单：13 角色、knownGaps、§9.1 限制、§5.1 schema、错误码 | 已完成 |
| [r0-window-prototype.md](r0-window-prototype.md) | R0-03 Tauri 透明窗口/截图浮层原型：构建、自检、人工验收步骤与未验证项 | 原型完成：编译/自检 PASS（副屏截图证据），100/200% DPI 等真机视觉未验证 |
| [r0-report.md](r0-report.md) | 本分支 R0 实施报告：交付矩阵、验证命令与结果、缺口、门禁状态、下一轮建议 | **最终状态以本文件为准** |

机器可读产物与代码：

| 产物 | 路径 | 验证入口 |
|---|---|---|
| 宿主合同 | [`contracts/host/host-contracts.json`](../../../contracts/host/host-contracts.json)（13 角色 / 257 方法 / 10 错误码 / 8 项限制 / 6 项 schema） | `node scripts/rust/extract-host-contracts.js --check` |
| 跨语言夹具 | [`test/fixtures/host-parity/`](../../../test/fixtures/host-parity/)（5 组 28 case + manifest sha256） | `node scripts/rust/generate-host-fixtures.js --check` |
| 合同测试 | [`test/host-contracts.test.js`](../../../test/host-contracts.test.js)（19 测试） | `node --test test/host-contracts.test.js` |
| 前端资源白名单 | [`scripts/rust/frontend-resources.whitelist.json`](../../../scripts/rust/frontend-resources.whitelist.json) + [`collect-frontend-resources.js`](../../../scripts/rust/collect-frontend-resources.js)（10 页面 + shared + assets，191 文件 / 2,430,229 B） | `node scripts/rust/collect-frontend-resources.js --check` |
| 白名单测试 | [`test/frontend-resource-whitelist.test.js`](../../../test/frontend-resource-whitelist.test.js)（9 测试） | `node --test test/frontend-resource-whitelist.test.js` |
| Rust workspace | [`rust-app/`](../../../rust-app)（6 crates，toolchain 1.97.1） | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1` |

## 2. 复现命令（本分支实测，均有非零失败即中止语义）

```bash
node scripts/rust/extract-host-contracts.js --check
node scripts/rust/generate-host-fixtures.js --check
node --test test/host-contracts.test.js
node scripts/rust/collect-frontend-resources.js --check
node --test test/frontend-resource-whitelist.test.js
npm run check
cargo test --manifest-path rust-app/Cargo.toml --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1
```

## 3. 与计划首批清单的对应

计划 §12 的"下一轮首批只完成 R0"清单，本分支实际覆盖：

1. 基线/功能矩阵 —— 文档完成，性能/真机对照**未执行**（R0-07）。
2. API/角色/错误/夹具冻结 —— 已完成并接入 Rust 对照测试。
3. 隔离 workspace / 数据根 / 资源打包白名单 —— workspace 与白名单完成；数据根为 Rust **locator 原型**，未接入产品数据。
4. 透明窗口/截图、钩子/回贴、媒体采集三类原型 —— 仅有窗口原型；钩子与媒体**未开始**。
5. 文档/项目/凭据/PDF/视频资源小样与安装烟测 —— 文档/项目夹具已冻结；凭据、PDF、视频资源与安装烟测**未做**。
6. G0 决策报告 —— **未产出**；七项决策全部"待验证"。

## 4. 边界声明

- 不改动 `main/`、`preload*.js`、`shared/` 生产代码；Electron 构建入口与现有测试入口未被替换。
- 运行环境"去 Node/Electron"未验证（计划 G3）；本分支不包含任何安装包或发布流程改动。
- 所有 R0 结论以本目录文档与 `git log` 的实际提交为准；文档中的"待验证"不得改写成已验证。
