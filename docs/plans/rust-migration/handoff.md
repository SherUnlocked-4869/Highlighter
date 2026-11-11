# Rust 迁移 R0 交接文档（2026-11-11 收尾版）

- 日期：2026-11-11 16:20（Asia/Hong_Kong）。本文件是**新会话的唯一入口**。
- 状态：**R0 部分完成；G0 未通过；R1 未开始**（计划 §8：G0 通过才放行 R1～R7）。
- 分支：`codex/rust-r0-baseline-contracts`，HEAD `93f0031`（已推送 origin）。PR #5 仍为 R0 证据批次。
- 运行机器已更换：当前为 `SHERUNLOCK02`（见 §3）；2026-11-10 原机（Ryzen 7 9850X3D / RTX 5070 Ti / 双屏 / F: 盘）数据不可与当前机器混用。
- 阅读顺序：§1 最新状态 → §2 接手顺序 → §3 环境 → §4 文档索引 → §5 未决问题 → §6 复现命令 → §7 陷阱 → §8 历史快照。

## 1. 最新状态（2026-11-11 收尾）

### 1.1 分支 / 提交 / PR

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/SherUnlocked-4869/Highlighter.git |
| 分支 | `codex/rust-r0-baseline-contracts`，与 origin 同步；HEAD `93f0031` |
| 基线产品源码 | `3df7129`（4.2.0 / Electron 43.8.3）；分支未落后 master（观察值，本轮未 fetch 复核） |
| PR | #5（base `master` @ `3df7129`）：https://github.com/SherUnlocked-4869/Highlighter/pull/5 ，OPEN |
| CI | **本轮未等待/触发 CI**（按用户要求）；本地门禁结果见 §6。不要仅凭本地通过宣称 CI 通过（AGENTS.md 有专门提醒）。 |
| 提交 | 相对基线共 17 个提交（原 13 + 交接文档 `7c45a7b` + 本轮 3 个）；17 个提交合计 190 文件 +56,620/−29 |
| 本轮新增 | `533b4c4`（R0-07 安装/性能证据 + ADR-0006/0007 候选）、`ee12374`（手动安装实测）、`93f0031`（卸载实测 + 遗留键登记）；合计 29 文件 +3,353/−60 |
| 产品代码 | **未改** `main/`、`preload*.js`、`shared/`、`package.json`、现有 Electron 构建入口/CI；所有改动在 `rust-app/` 原型、`scripts/rust/`、文档 |

### 1.2 R0 完成度

| 任务 | 状态 | 证据/入口 |
|---|---|---|
| R0-01 基线/矩阵 | 部分完成（性能对照本轮补上；真机矩阵未做） | [r0-baseline.md](r0-baseline.md)、[feature-parity.md](feature-parity.md)、[r0-performance-baseline.md](r0-performance-baseline.md) |
| R0-02 合同/夹具 | 完成（13 角色 / 257 方法 / 28 夹具 / 19 tests） | `contracts/host/`、`test/fixtures/host-parity/` |
| R0-03 窗口原型 | 原型完成（含单屏拒绝路径实测）；100/150/200% DPI、副屏/负坐标、白闪、鼠标穿透未验证 | [r0-window-prototype.md](r0-window-prototype.md)（§11 本轮新增） |
| R0-04 钩子 | 原型完成（真实选词）；真机应用矩阵/卡死恢复/native clipboard 联调未做 | [r0-hook-extraction.md](r0-hook-extraction.md)、[ADR-0002](adr/0002-hook-extraction.md) |
| R0-05 媒体 | 两路 spike 完成；长时/双音源/暂停续录/同条件对照/WGC 打包身份未做 | [r0-media-webview.md](r0-media-webview.md)、[r0-media-native.md](r0-media-native.md)、[ADR-0001](adr/0001-media-backend.md) |
| R0-06 数据/凭据/PDF/资源通道 | 大部分完成；**安装→启动→卸载已在本机实测通过**；产品真实 print.html/批量/长图、图片视频资源桥真实链路未做 | [r0-credential-migration.md](r0-credential-migration.md)、[r0-pdf-spike.md](r0-pdf-spike.md)、[r0-resource-channel.md](r0-resource-channel.md)、[r0-installation-matrix.md](r0-installation-matrix.md) §6 |
| R0-07 安装/版本/性能 | **部分完成（仅本机）**：三 NSIS 包/WebView2 五模式/缺失 Runtime 行为/两轮性能对照/手动安装卸载通过；**静默 /S 安装在本机受限会话阻塞**（环境级）、WebView2 多版本/无 Runtime/离线矩阵、fixedRuntime、修正估算未做 | [r0-installation-matrix.md](r0-installation-matrix.md)、[r0-performance-baseline.md](r0-performance-baseline.md) |
| ADR-0001～0005 | 候选，未冻结（G0 前不冻结） | [adr/README.md](adr/README.md) |
| ADR-0006 测试驱动 | 候选 A1（tauri-driver 2.1.0 + 精确匹配 msedgedriver，本机实测全流程），未冻结 | [r0-test-driver.md](r0-test-driver.md)、[adr/0006-desktop-test-driver.md](adr/0006-desktop-test-driver.md) |
| ADR-0007 最低系统 | 候选 A+D（Win10 22H2 x64 + Win11 x64、WebView2 Evergreen 默认 + 离线单独制品），未冻结 | [r0-minimum-windows-runtime.md](r0-minimum-windows-runtime.md)、[adr/0007-minimum-windows-runtime.md](adr/0007-minimum-windows-runtime.md) |
| **G0** | **未通过**；R1 不得开始 | [r0-g0-report.md](r0-g0-report.md)（§7 为本轮更新） |

### 1.3 必须带走的判断（本轮修正/新增）

1. **性能收益不成立**：同形态最小壳对照（两轮共 6 次 Electron / 7 次 Tauri；Release、固定电源方案、单屏 150%），Tauri 相对 Electron 的 Private Bytes 为 **+5.2%（217.25 vs 228.64 MB，区间重叠）**、Working Set +5.8%、进程数 **4→7**、启动 **+18.4%**；产品 Electron 托盘空闲基线 **131.90 MB**。计划 §9.2 的“托盘空闲 Private Bytes 下降约 25%”**不能靠替换宿主达成**；G0 必须显式重估收益或走失败分支。T1～T3 阈值已冻结、T4 媒体阈值未冻结（见 [r0-performance-baseline.md](r0-performance-baseline.md) §6）。
2. **安装链路（手动）已通过**：用户手动交互安装到自定义目录 `D:\Program Files\Highlighter R0 Window Prototype`，目录/文件哈希/HKCU 卸载键/开始菜单快捷方式正确；已安装 exe 四场景（无开关 exit 2；ALLOW_PRIMARY=1 PASS；缺失 WebView2 → 阻塞对话框后 exit 2）符合预期；`uninstall.exe /S` 退出码 0，目录/卸载键/快捷方式清理干净。
3. **静默安装仍阻塞（环境级）**：本机受限会话 `setup.exe /S` exit 0 但不落盘；同版本 NSIS 最小对照安装器同样复现 → 需真实桌面会话/VM 复测，不要绕过安全机制。
4. **卸载遗留键（R8-02 决策项）**：静默 `/S` 卸载保留 `HKCU\Software\<publisher>\<product>`（安装路径 + Installer Language），因 tauri-cli 2.12.4 NSIS 模板只在“删除应用数据”勾选时清理。
5. **缺失 WebView2 的失败形态**：加载器弹阻塞式 `#32770` 对话框，点确定后 Tauri 报错退出（应用 exit 2；PDF 探针 exit 3）→ 产品必须在创建窗口前检测 Runtime 并给原生引导（托盘/自启动尤其危险）。
6. **测试驱动**：tauri-driver 2.1.0 + **与 WebView2 Runtime 精确同版本**的 msedgedriver（本机 157.0.4341.46）可用；CI runner 的 Runtime 随镜像更新 → 需运行时解析版本；launch 模式无主进程通道、应用 stdout 不落盘，R1 需要应用侧结构化日志/测试钩子。
7. **最低系统候选**：Win10 22H2 上 Edge/WebView2 官方更新至少到 2028-10（不要求 ESU），但 Win10 OS 已于 2025-10-14 EOL；README 从“Windows 10 或 11”收紧到“Win10 22H2 或更新”**必须产品决策**（计划 §1 禁止默默提高）。
8. **机器已更换**：当前 `SHERUNLOCK02`（i5-13500H / 15.7 GiB / Intel Iris Xe 无独显 / 单屏 2240×1400@150% / WebView2 157.0.4341.46）；原机数据不可比；本机无副屏，可见测试窗口需用户许可（本轮已获许可）。

### 1.4 仍未完成（G0 放行前必须闭环，按优先级）

1. **真实测试机/VM 矩阵**（最高优先，多个 R0 任务共用）：Win10 22H2 + Win11、WebView2 无/旧版/离线、100/125/150/200% DPI 与副屏/负坐标、独显 GPU；GitHub hosted runner 不能替代（`docs/releases/HARDWARE_ACCEPTANCE.md`）。
2. **R0-05 长时媒体**：30 分钟/双音源/暂停续录/源目标变化、两路同条件对照、WGC 打包身份实测、媒体阈值 T4 冻结（R5 开工前，不晚于 G2）。
3. **R0-04 真机矩阵**：浏览器/编辑器/Office/资源管理器/管理员窗口、真实卡死恢复、lease required=true、与 `native/clipboard` 联调。
4. **R0-06 收尾**：产品真实 `capture/print.html` 批量/长图 PDF、图片视频资源桥真实链路。
5. **安装收尾**：(a) 静默安装环境根因（真实桌面会话/VM）；(b) 卸载遗留键清理决策（R8-02）。
6. **ADR-0006/0007 收尾**：CI runner/版本不匹配/多窗口/托盘/混合 DPI/长时稳定性；ADR-0007 真机矩阵与 README 产品决策。
7. **修正估算 + 正式 G0 报告**：含 §1.3 第 1 条的性能预期重估和 R5 媒体后端重估（计划 §11 的 38～63 人周不得沿用）。

## 2. 接手顺序（新会话建议）

1. 先跑 §6 的快速验证（JS 合同/夹具/白名单 + Rust 门禁，约 1–2 分钟），确认工作区与本地环境。
2. 读 §1.3/§1.4、[r0-g0-report.md](r0-g0-report.md) §7、[r0-installation-matrix.md](r0-installation-matrix.md) §6、[r0-performance-baseline.md](r0-performance-baseline.md) §6/§8。
3. **先与用户确认可用测试资源**（真机/VM、Win10、副屏、可见窗口许可）；本机单屏只能覆盖“Win11 + 单屏 150% + 核显”。
4. 按 §1.4 优先级推进；**G0 通过前不要开始 R1～R7 业务迁移**（计划 §7/§8）。
5. 冻结 ADR-0006/0007 候选与 README 兼容性（需产品批准），再重估 R5/总量并出正式 G0 报告。

**工作边界（必须遵守，来自计划 §8）**：

- 不改 `main/`、`preload*.js`、`shared/`、`native/ocr|clipboard|everything-search`、`package.json`/锁文件、现有 Electron 构建入口/CI 工作流（Rust CI 属 R1）。
- 原型不接入产品入口；R0 证据不进 `main`。
- 不读取真实用户凭据/设置；合成数据/合成凭据；不把密钥/密文写进仓库或日志。
- ADR/报告中的“候选/待验证”在 G0 前不得改成“已选定”；新证据回写 r0-report/r0-g0-report/对应 ADR 变更记录。
- 可见测试窗口默认副屏；本机无副屏需先征得用户同意（本轮已获同意）。
- 提交说明写清“改变了什么/为什么/如何验证/剩余限制”（计划 §11）。

## 3. 当前机器与环境事实（2026-11-11）

| 项 | 值 |
|---|---|
| 主机/用户 | `SHERUNLOCK02` / `24532`，交互式会话 1 |
| OS | Windows 11 家庭版 26300.9974（26H2） |
| CPU/RAM | i5-13500H 12C/16T；15.75 GiB |
| GPU/显示 | Intel Iris Xe（驱动 31.0.101.4032）无独显；单屏 2240×1400@150%（1493×933 DIP），无副屏 |
| WebView2 | 157.0.4341.46（per-machine） |
| Electron/产品 | Electron 43.8.3 / Highlighter 4.2.0 |
| Rust | rustc/cargo 1.97.1（`rust-app/rust-toolchain.toml` 固定），CARGO_HOME=`D:\DevCache\cargo` |
| Node/npm | 24.15.0 / 11.17.0（registry=npmmirror） |
| 仓库/磁盘 | `D:\workspace\Highlighter`；D: 剩余约 201 GiB，C: 约 15 GiB（C: 较紧） |
| 电源 | 默认平衡；性能测量时脚本临时切高性能并恢复 |

完整采集（含原机对比）见 [r0-baseline.md](r0-baseline.md) §9。

## 4. 文档与证据索引

### 4.1 核心入口

| 文档 | 内容 |
|---|---|
| [r0-g0-report.md](r0-g0-report.md) | **G0 决策报告**：七项决策状态、G0 缺口、本轮 §7 更新 |
| [r0-report.md](r0-report.md) | R0 实施报告（最终状态）；§13 为本轮明细 |
| [r0-baseline.md](r0-baseline.md) | 基线/任务状态/G0 决策登记；§9 当前机器环境 |
| [adr/README.md](adr/README.md) | ADR 索引（0001～0007，全部候选/未冻结） |
| [README.md](README.md) | 本目录索引（含本轮新增文档） |

### 4.2 本轮新增证据文档

| 文档 | 结论 |
|---|---|
| [r0-installation-matrix.md](r0-installation-matrix.md) | NSIS 三模式测试包、WebView2 五模式对照、缺失 Runtime 行为、版本冻结、**手动安装→启动→卸载实测**（§6.1/§6.4） |
| [r0-performance-baseline.md](r0-performance-baseline.md) | 两轮性能/进程树对照、产品基线、T1～T3 阈值冻结、T4 未冻结、限制 |
| [r0-test-driver.md](r0-test-driver.md) | ADR-0006 证据：tauri-driver/msedgedriver 版本冻结、6 次真实 session、能力边界、CI 计划 |
| [r0-minimum-windows-runtime.md](r0-minimum-windows-runtime.md) | ADR-0007 调研：官方支持矩阵、候选 A～D、真机矩阵计划 |
| [adr/0006-desktop-test-driver.md](adr/0006-desktop-test-driver.md)、[adr/0007-minimum-windows-runtime.md](adr/0007-minimum-windows-runtime.md) | 本轮新增 ADR（候选/待验证） |
| [r0-window-prototype.md](r0-window-prototype.md) §11 | 单屏拒绝路径实测 + 测试开关登记 |

### 4.3 机器可读产物与工具

- 合同/夹具：`contracts/host/host-contracts.json`、`test/fixtures/host-parity/`、`test/host-contracts.test.js`。
- Rust workspace：`rust-app/`（6 crates + `src-tauri` 原型；当前 107 tests）。
- 测量脚本：`scripts/rust/measure-resources.ps1`、`scripts/rust/measure-r0-07-performance.ps1`。
- 测试驱动：`scripts/rust/probe-tauri-webdriver.js`、`scripts/rust/run-tauri-webdriver-probe.ps1`。
- 安装取证：`.tmp-r07/install/verify-manual-install.ps1`（scratch，不在 git）。
- 其他原型：`rust-app/prototypes/{native-capture,webview-media,webview-pdf-resource,credential-probe}`、`native/selection-helper/`。

### 4.4 证据目录约定

- `.tmp-r0/`、`.tmp-r07/` 等全部 **gitignore**，不提交；文档内记录命令 + 关键输出 + 哈希。
- 当前机器上本轮证据仍在 `.tmp-r07/{driver,install,perf,window,env,runtime-researcher}/`；若被清理，按 §6 命令重跑重建。
- 不要提交真实日志/大文件/凭据；`.tmp*` 在提交前确认已 ignore。

## 5. 未决问题（需要用户/产品决策）

1. **性能预期重估**：计划 §9.2 “托盘空闲 Private Bytes -25%” 未获证据支持；是重设收益目标、接受“架构迁移不承诺内存收益”，还是按计划 §8 失败分支回到 Electron 增量 Rust 化？
2. **最低系统/README**：是否将 README 从“Windows 10 或 Windows 11”收紧为“Windows 10 22H2 或更新”（计划 §1 要求显式兼容决策）；Win10 继续支持到何时、是否提供 Fixed Version 渠道（ADR-0007 候选 A+D）。
3. **钩子维护面**：是否接受保留 C++ selection helper（提取方案，18–29 人日）并登记退出计划，还是要求纯 Rust 重写（ADR-0002）。
4. **测试驱动路线**：确认 ADR-0006 候选 A1（tauri-driver + 精确匹配 msedgedriver）作为 R1-e 主路线；是否评估 `@wdio/tauri-service`（A2）与 CDP 回退（B）。
5. **卸载遗留键清理**：静默卸载是否改为无条件清理 `HKCU\Software\<publisher>\<product>`（R8-02）。
6. **PR #5**：是否先合并本轮 R0 证据批次（不改产品代码），再在 master 上继续；CI 本轮未等待。
7. **测试资源**：能否提供/安排 Win10 22H2 真机或干净 VM、双屏/多 DPI、独显机器用于 §1.4 第 1 项。

## 6. 复现/验证命令（本机实测过；仓库根目录，Windows PowerShell）

### 6.1 快速门禁（约 1–2 分钟）

```powershell
node scripts/rust/extract-host-contracts.js --check        # exit 0
node scripts/rust/generate-host-fixtures.js --check        # exit 0
node --test test/host-contracts.test.js                    # 19 pass
node scripts/rust/collect-frontend-resources.js --check    # exit 0
node --test test/frontend-resource-whitelist.test.js       # 9 pass
npm run check                                              # 489 JS files / architecture / i18n
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1   # fmt+clippy+test --locked（107 tests）
```

### 6.2 R0-03 窗口自检（无副屏时默认拒绝建窗，是安全路径）

```powershell
cargo build --manifest-path rust-app/Cargo.toml -p highlighter-r0-window --locked
.\rust-app\target\debug\highlighter-r0-window.exe --self-test      # 单屏无开关：exit 2，不建窗
$env:HIGHLIGHTER_R0_ALLOW_PRIMARY='1'   # 测试专用（默认关闭；日志明示“非副屏验证”）
.\rust-app\target\debug\highlighter-r0-window.exe --self-test --hold-ms 2000
Remove-Item Env:HIGHLIGHTER_R0_ALLOW_PRIMARY
```

### 6.3 WebDriver 探针（ADR-0006）

```powershell
# 前置：tauri-driver（cargo install）与 msedgedriver（与 WebView2 Runtime 完全同版本）
powershell -File scripts/rust/run-tauri-webdriver-probe.ps1 -NativeDriver .tmp-r07\driver\msedgedriver\157.0.4341.46\msedgedriver.exe -AllowPrimaryScreen
```

### 6.4 性能/进程树对照（约 6 分钟；临时切高性能并恢复；会出现全屏透明窗口）

```powershell
powershell -File scripts/rust/measure-r0-07-performance.ps1 -Runs 3 -IdleSec 20 -IncludeProduct -OutDir .tmp-r07/perf/results-clean
```

### 6.5 安装包构建（仅 R0-07 测试包，不是产品构建入口；必须在 rust-app 下执行）

```powershell
cd rust-app
npx --yes @tauri-apps/cli@2 build --no-bundle --ci
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci        # downloadBootstrapper
# 其它 WebView2 模式：--config <embedBootstrapper.json|offlineInstaller.json>
```

### 6.6 安装/卸载取证（scratch 脚本；路径按实际安装目录调整）

```powershell
pwsh -File .tmp-r07\install\verify-manual-install.ps1                       # 安装后取证
pwsh -File .tmp-r07\install\verify-manual-install.ps1 -Uninstall            # 卸载取证
```

### 6.7 本机已知陷阱（命令前必读）

- Electron 探针：`env -u ELECTRON_RUN_AS_NODE`、`--no-sandbox` 在脚本路径之前、`TMP/TEMP` 指向 `.tmp*/`。
- 产品 E2E 隔离：`HIGHLIGHTER_E2E=1` + `HIGHLIGHTER_E2E_DATA_ROOT`（详见 `e2e/electron-app.js`）。
- 完整 `npm test`/`test:e2e` 需 AGENTS.md 的四类陷阱处理；本轮未跑（不声称 CI/E2E 通过）。

## 7. 环境陷阱与经验（累计）

1. **PowerShell 5.1 + UTF-8 无 BOM 脚本**：中文注释行尾多字节字符会被 GBK 代码页误解析并吞掉换行，导致 `param` 块出现莫名 `Unexpected token ')'`。仓库新脚本统一 UTF-8 **with BOM**（或纯 ASCII 注释）。
2. **Tauri CLI 会改写 Cargo.toml**：`tauri-cli 2.12.4` 在 build/bundle 时把 `tauri = { version = "2" }` 写成 `{ version = "2", features = [] }`（无功能影响，已登记）；且**必须在 `rust-app/` 下执行**，在仓库根执行会误把 `prototypes/webview-media` 当 Tauri 项目并改写其 Cargo.toml（已还原过）。
3. **Windows checkout/行尾**：合同与夹具做字节级 sha256 校验，`.gitattributes` 固定 LF；新增字节级校验必须考虑行尾。
4. **受限宿主 Electron**：`ELECTRON_RUN_AS_NODE=1` 导致 `app is undefined`；Chromium sandbox 在该宿主常无法启动需 `--no-sandbox`（且必须在脚本路径前）；spawned Electron 子进程写 `%LOCALAPPDATA%\Temp` 会 EPERM → `TMP/TEMP` 指向 `.tmp*/`。
5. **WebView2 缺失/损坏**：加载器弹阻塞式 `#32770` 对话框并挂起，不是产品可控错误；CI/自动化必须预装并校验 Runtime。
6. **msedgedriver 必须与 WebView2 Runtime 精确同版本**；runner 镜像更新会导致版本漂移，需运行时解析（`https://msedgedriver.microsoft.com/<pv>/edgedriver_win64.zip`）。
7. **未签名包**：经 ShellExecute 双击会弹“打开文件 - 安全警告”；自动化用 CreateProcess（`UseShellExecute=false`）。
8. **NSIS 安装包不可逐字节复现**（时间戳/临时路径）；发布需记录签名后的最终 sha256。
9. **可见窗口只放副屏**；本机单屏需先问用户（本轮已获许可）。无副屏时 R0-03 原型安全拒绝建窗（exit 2）。
10. **npm registry 随机器的差异**：本轮机器为 npmmirror（与 AGENTS.md 一致），2026-11-10 原机为官方 registry；`npm audit` 空结果先排查 registry（AGENTS 陷阱 4）。租约测试偶发失败先独立复跑（AGENTS 说明）。
11. **采样方差**：最小壳内存/启动对照轮间波动可达 ±8%，单次瞬时值不可当结论；阈值用均值/区间并记录电源方案、Runtime、内核版本（Electron 43=Chromium 150，WebView2 157 内核不同）。

## 8. 历史记录：2026-11-10 交接快照

> 以下是原 handoff.md 的 §0～§11 全文（标题层级已降一级，内容未改；其中的“当前状态/机器/未完成清单”已被本文件 §1～§5 取代）。
> 仍有效的内容：§7 环境陷阱（已并入本文件 §7）、§8 工作边界（已并入 §2）；§11 文档地图已被 §4 取代。
## Rust 迁移 R0 交接文档

日期：2026-11-11。交接对象：接手 Rust 迁移的下一名工程师/Agent。
状态：**R0 部分完成；G0 未通过；R1 未开始（计划 §8 要求 G0 通过后才放行）**。

> 先读这份文档，再按 §9 的顺序接手；不要只看 PR 标题就认为 R0 已完成。
> 所有"候选/待验证"结论以 [adr/README.md](adr/README.md) 与 [r0-g0-report.md](r0-g0-report.md) 为准，
> 文档中的"未验证"项不得改写成已验证。

### 0. TL;DR

- 分支 `codex/rust-r0-baseline-contracts` 已推送，PR **#5**（base `master` @ `3df7129`）：
  https://github.com/SherUnlocked-4869/Highlighter/pull/5 。PR 只含 R0 证据/原型/文档/测试，**未改产品代码**。
- 已完成：宿主合同 + 28 个跨语言夹具、隔离 Rust workspace（107 tests）、前端资源白名单、
  窗口/钩子/媒体/PDF/凭据/资源通道六项风险原型与证据、ADR-0001～0005 候选结论、G0 报告草案。
- 未完成：**R0-07**（NSIS 测试包、WebView2 有/无/离线矩阵、首轮性能/进程树对照）、长时/双音源媒体验证、
  真机 100/150/200% DPI 矩阵、测试驱动 ADR-0006、最低系统 ADR-0007、修正估算与正式 G0 报告。
- 下一步建议：先做 R0-07 与 R0-05 长时收尾 → 补真机矩阵 → 出正式 G0 报告；**G0 通过前不要开始 R1 业务迁移**。

### 1. 仓库/分支/PR 状态

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

### 2. 环境事实（复现前必读）

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

### 3. 已交付内容索引（R0 任务 → 证据）

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

### 4. 关键候选决策（详见 ADR，G0 前不冻结）

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

### 5. 未完成与 G0 缺口（放行前必须闭环）

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

### 6. 复现/验证命令（本分支实测通过）

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

### 7. 环境陷阱与经验（避免重复踩坑）

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

### 8. 工作边界（接手时必须遵守）

- 不改 `main/`、`preload*.js`、`shared/` 生产代码；本分支所有原型不接入产品入口。
- 不改 `native/ocr`、`native/clipboard`、`native/everything-search` 现有独立 Cargo 工程（各自锁文件）。
- 不改现有 Electron 构建入口与 CI 工作流；Rust CI 属 R1 范围。
- 不改 `package.json`/`package-lock.json`；不在原型里 `npm install`（PDF 对照的 pypdf 只装在 `.tmp-r0-pdf/pylibs`）。
- 合成数据/合成凭据：不得读取真实用户凭据/设置；不得把真实 key 或密文写进仓库或日志。
- ADR/报告中的"候选/待验证"在 G0 前不得改成"已选定"；新证据要回写 [r0-report.md](r0-report.md)、
  [r0-g0-report.md](r0-g0-report.md) 与对应 ADR 的变更记录。
- 提交说明写清"改变了什么、为什么、如何验证、剩余限制"（计划 §11）。

### 9. 建议的接手顺序

1. 跑 §6 的快速验证（约 1–2 分钟），确认分支状态与本地环境。
2. 读 [r0-g0-report.md](r0-g0-report.md) §5 与 [adr/README.md](adr/README.md)，确认下一步优先级。
3. **R0-07 可先在本机做**：Tauri NSIS 测试包、WebView2 在线/离线安装方案、首轮 Release 进程树/Private Bytes
   对照（固定电源方案；未签名候选包必须标 `NotSigned`；不以 Debug 数据下性能结论）。
4. 与用户确认后补真机矩阵（100/150/200% DPI、WebView2 有/无/离线、RDP/休眠）与 R0-05 长时媒体。
5. 补齐 ADR-0006/0007，汇总修正估算，出正式 G0 报告；G0 通过后再按
   [r0-baseline.md](r0-baseline.md) §6.3 的 R1-a～e 切片开始 R1。

### 10. 未决问题（需要用户/产品决策）

1. 是否接受"媒体后端改为原生采集 + WebView 合成/编码"候选，并据此重估 R5（计划总量 38–63 人周需更新）。
2. 是否接受"钩子保留 C++ helper 维护面"（需登记退出计划），还是要求纯 Rust 重写（成本更高）。
3. R0-03 真机 DPI 矩阵需要用户配合改显示缩放/切换单屏。
4. R0-07 完整矩阵需要真实测试机或用户桌面会话；本机只能做部分。
5. PR #5 是否先合并（R0 证据批次、不改产品代码）；合并后 R0 剩余工作可在新分支继续。

### 11. 相关文档/目录地图

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
