# Rust 迁移 R0 交接文档（2026-11-11 晚间接手版：**回到原机**）

- 日期：2026-11-11 21:55（Asia/Hong_Kong）。本文件是**新会话的唯一入口**；上一版（21:00）见
  `git show 800ea67:docs/plans/rust-migration/handoff.md`（其后续 `f8a5fd7` 为推送状态记录）。
- 状态：**R0 继续推进；G0 仍未通过；R1 未开始**（计划 §8：G0 通过才放行 R1～R7）。
- 分支：`codex/rust-r0-baseline-contracts`；本轮提交见 §1.5.5（含 WGC 多显示器缺陷修复、R0-03/04/05 复验与环境登记）。
  PR #5 保持 OPEN、**不合并**；CI 仍按用户要求未作为本轮的放行依据（本地门禁见 §6.1）。
- **运行机器：已回到原机 `SHERUNLOCK`（Ryzen 7 9850X3D / 47 GiB / RTX 5070 Ti / 双屏 4K@150% + 1440×2560@125% 负 Y / F:）。**
  §3 的表仍是阶段②笔记本（SHERUNLOCK02）事实；**当前机器事实见 §1.5 与 [r0-baseline.md](r0-baseline.md) §9.4，三段机器的数据不可混用。**
- 阅读顺序：**§1.5（本轮原机接手）** → §1 最新状态 → §2 接手顺序（含 §2 第 0 步换机器检查）→ §3 环境（**先看 §3.2 完整性标签**）→ §4 文档索引 → §5 未决问题 →
  §6 复现命令 → §7 陷阱 → §8 历史。

## 1. 最新状态（2026-11-11 晚间收尾）

### 1.1 分支 / 提交 / PR

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/SherUnlocked-4869/Highlighter.git |
| 分支 | `codex/rust-r0-baseline-contracts` |
| 本地 HEAD | 本轮 3 个提交：`652a7f0`（R0-04/05/06/07 收尾证据/原型）、`800ea67`（G0 重估/交接文档）、推送状态记录；HEAD 见 `git log` |
| origin | 与本地同步（本轮已推送 `codex/rust-r0-baseline-contracts`） |
| 基线产品源码 | `3df7129`（4.2.0 / Electron 43.8.3） |
| PR | #5（base `master` @ `3df7129`）：https://github.com/SherUnlocked-4869/Highlighter/pull/5 ，OPEN；**本轮用户决定不合并** |
| CI | **按用户要求跳过本次 CI**：推送前临时禁用 `Windows CI` workflow（推送后立即恢复），本次推送未触发/未等待 CI。本地门禁结果见 §6.1 与 [r0-report.md](r0-report.md) §14.4；不要凭本地通过宣称 CI 通过 |
| 提交规模 | 相对基线共约 20 个提交（17 + 本轮 3）；本轮的证据/原型/文档提交合计约 40 文件 +1.1 万行 |
| 产品代码 | **未改** `main/`、`preload*.js`、`shared/`、`capture/`、`package.json`、现有 Electron 构建入口/CI；改动全在 `rust-app/` 原型、`native/selection-helper/`、`scripts/rust/`、文档 |

### 1.2 R0 完成度

| 任务 | 状态 | 证据/入口 |
|---|---|---|
| R0-01 基线/矩阵 | 部分完成（性能对照与产品基线完成；真机矩阵未做） | [r0-baseline.md](r0-baseline.md)、[feature-parity.md](feature-parity.md)、[r0-performance-baseline.md](r0-performance-baseline.md) |
| R0-02 合同/夹具 | 完成（13 角色 / 257 方法 / 28 夹具 / 19 tests） | `contracts/host/`、`test/fixtures/host-parity/`、`test/host-contracts.test.js` |
| R0-03 窗口原型 | 原型完成；单屏拒绝路径、副屏负坐标（原机）实测；ACL 修复后自检复跑 PASS | [r0-window-prototype.md](r0-window-prototype.md)、`rust-app/src-tauri/`；100/125/200% DPI、白闪、鼠标穿透未验证 |
| R0-04 钩子 | **真机矩阵收尾（单机）**：10 行 9 PASS（Notepad/Chrome/Edge/Word/Excel/资源管理器双击）；管理员窗口 UIPI 负样本；卡死恢复进程级通过；lease 协议级互通 | [r0-hook-extraction.md](r0-hook-extraction.md) §4.9–§4.14、[ADR-0002](adr/0002-hook-extraction.md)；真实 provider 卡死、helper↔native/clipboard 联调未验证 |
| R0-05 媒体 | **长时/双音源/暂停/窗口采集收尾（单机）**；**WGC 更正确认可用**（Medium IL 10s@30fps 采集通过） | [r0-media-native.md](r0-media-native.md) §4.1/§4.11–§4.15、[r0-media-webview.md](r0-media-webview.md)、[ADR-0001](adr/0001-media-backend.md)；WGC 打包身份/同意/其它 Windows、双音源对齐真机、两路同条件对照未做 |
| R0-06 数据/凭据/PDF/资源 | **大部分完成 + PDF 产品真实页复验**：产品 `capture/print.html` 单图 A4/200in 长图/批量 50 页双后端语义等价；凭据/资源通道小样完成 | [r0-pdf-spike.md](r0-pdf-spike.md) §8、[r0-credential-migration.md](r0-credential-migration.md)、[r0-resource-channel.md](r0-resource-channel.md)、[ADR-0003](adr/0003-pdf-backend.md)~[0005](adr/0005-binary-resource-transport.md)；图片视频资源桥真实链路、缺字体机器未做 |
| R0-07 安装/版本/性能 | **本机链路全部通过**：手动与静默安装→启动→卸载均实测通过（ACL 修复后）；三种 NSIS 包/WebView2 五模式/缺失 Runtime 行为/首轮性能对照完成；**性能收益已由产品决策重估** | [r0-installation-matrix.md](r0-installation-matrix.md) §6.2/§6.4、[r0-performance-baseline.md](r0-performance-baseline.md) §10；WebView2 多版本/离线真机矩阵、fixedRuntime、卸载遗留键决策未做 |
| ADR-0001～0007 | 全部**候选，未冻结**（G0 前不冻结）；本轮 0001/0002/0003/0006 证据增强 | [adr/README.md](adr/README.md) |
| **G0** | **未通过**；R1 不得开始 | [r0-g0-report.md](r0-g0-report.md) §8/§9（本轮结论） |

### 1.3 必须带走的判断（本轮新增/更正，务必读完）

1. **评测环境缺陷（本轮最重要发现）**：工作区根目录曾带有 DSH workspace-write 沙箱遗留的强制完整性标签
   `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（+Everyone DENY +能力 SID），继承到全部文件 →
   工作区内 exe 以 **Low IL** 运行 → **静默 NSIS 安装 exit 0 不落盘、WGC E_ACCESSDENIED、真实 SendInput/UIA
   选词失败、spawned Electron 写 TMP EPERM** 等“受限宿主/环境级”结论全部同源。
   2026-11-11 19:55–20:00 用户批准后 Lead 用 `icacls` 修复（**61,767 个文件 Low→Medium**，移除 deny/能力 SID），
   并已复验：静默安装链路、WGC、选词矩阵全部恢复/通过。**接手第一步先检查标签（§3.2）**；若将来再用
   workspace-write 沙箱会话，标签可能被重写。
2. **性能收益不成立（产品决策已处理）**：同形态最小壳对照 Tauri 相对 Electron Private Bytes **+5.2%**（区间重叠）、
   进程数 **4→7**、启动 **+18.4%**（指示性）；产品 Electron 托盘空闲基线 **131.90 MB**。
   计划 §9.2 的“Private Bytes 下降约 25%”**已由产品决策撤回**；G0 按架构/维护收益重估，**不承诺内存与启动收益**；
   T1 改为非回归守卫（候选 Tauri 托盘空闲 ≤ **145.09 MB**），T2 待 R1 冻结等价里程碑后再判定；
   计划 §12“换壳后收益不明显”风险行**已触发并接受**。详见 [r0-performance-baseline.md](r0-performance-baseline.md) §10。
3. **WGC 结论更正为可用**：Medium IL 下 `CreateForMonitor #0`（2240×1400）与 `CreateForWindow` 均 OK；
   修复原型 `IDirect3DSurface→ID3D11Texture2D` 读取 bug（须经 `IDirect3DDxgiInterfaceAccess`）后，
   **WGC 10s@30fps 采集成功**（送达 590 帧、写入 300、复制补齐 0、全量解码 exit 0、有效 30.0000 fps）。
   原“WGC 本机被拒/无成功证据”作废；**打包身份（MSIX/能力声明）、同意 UI/采集指示/企业策略、
   Win10 22H2 与其它 build、多显示器/HDR/4K/60/长时 WGC 仍未验证**。
4. **安装链路（手动+静默）已在本机通过**：Medium IL 下工作区原件 `setup.exe /S` exit 0/770 ms，安装目录/文件哈希/
   HKCU 卸载键/快捷方式正确；已安装 exe 四场景一致（无 env exit 2、`ALLOW_PRIMARY=1` PASS、缺失 WebView2 →
   加载器阻塞对话框后 exit 2）；`uninstall.exe /S` exit 0/565 ms 清理干净。
   已知遗留：`HKCU\Software\<publisher>\<product>`（Tauri NSIS 模板行为，R8-02 决策）；UAC/SmartScreen 体验未记录。
5. **R0-04 真机矩阵（单机）**：10 行 9 PASS（method=1 UIA，0–32 ms）；资源管理器地址栏拖选样本未建立
   （双击 PASS）；管理员窗口只有 UIPI 负样本；真实 provider 卡死（2 s 有界停止超时）未真实复现；
   lease 仅协议级互通，**helper↔native/clipboard 未联调**（helper 无 coordinator 客户端）。
6. **PDF 产品真实页**：`capture/print.html` 单图 A4 竖/横、DPR 负对照、20000/30000px→200in 夹取、
   批量 5/50 页，两后端（WebView2 `PrintToPdfStream` vs Electron `printToPDF`）**内容/分页/图片绘制框语义等价**；
   MediaBox 最大差 0.96pt（Electron 自定义 pageSize 的 0.24pt 网格量化）；**R4-07 实现约束**：
   A4 必须显式传 Electron 实测英寸（595.92/72×842.88/72，横版交换）、WebView2 `ExecuteScript` 不等待页面
   Promise 需轮询 DOM、旧 `PrintToPdf` 只接受绝对路径、回归断言用语义/≤1pt 容差。
7. **测试驱动 ADR-0006**：ACL 修复后 WebDriver 全流程复跑 exit 0；仍缺 CI runner/版本不匹配/无 Runtime/
   多窗口/托盘/混合 DPI/长时稳定性。
8. **机器与环境**：`SHERUNLOCK02`（Win11 26300.9974 26H2、i5-13500H、15.7 GiB、Intel Iris Xe 无独显、
   单屏 2240×1400@150%、WebView2 157.0.4341.46）；装有 Chrome 157 / Edge / Office LTSC 2024（Word/Excel）。
   本轮用户授权主屏短暂可见窗口、30 分钟屏幕采集、一次性计划任务、ACL 修复；真机/VM 矩阵稍后安排。
9. **本轮提交/推送状态**：`652a7f0`/`800ea67` + 推送状态记录共 3 个提交**已推送 origin**；
   按用户要求**跳过 CI**（临时禁用 `Windows CI` workflow 后推送、已恢复），本次无 CI 运行/未等待 CI。

### 1.4 仍未完成（G0 放行前必须闭环，按优先级）

1. **真实测试机/VM 矩阵**（最高优先，待用户资源）：Win10 22H2、WebView2 无/旧/离线、100/125/150/200% DPI、
   副屏/负坐标、独显、RDP/锁屏/DWM；GitHub hosted runner 不能替代。
2. **WGC 收尾**：打包身份（MSIX/`uap11:Capability`）、同意 UI/采集指示/企业策略、Win10 22H2 与其它 build
   （含 `CreateForMonitor` 版本差异/`TryCreateFromDisplayId`）、多显示器/窗口/HDR/4K/60/长时 WGC；
   WebView2 MediaRecorder 与原生采集的**两路同条件对照**；双音源时间对齐真机。
3. **R0-04 收尾**：真实 provider 卡死（2s 有界停止真实触发）、管理员窗口正向样本、资源管理器拖选样本、
   PDF 阅读器/真实网页、混合 DPI/多屏、前台授权（AllowSetForegroundWindow）、helper↔native/clipboard lease 联调。
4. **R0-06 收尾**：图片/视频资源桥真实产品链路；缺字体机器；旧/Fixed Runtime 的 `ICoreWebView2_16`；
   RDP/锁屏；打印峰值内存/30s 超时/取消；凭据跨版本/多用户/漫游。
5. **R0-07/安装收尾**：WebView2 多版本/无 Runtime/离线真实机器矩阵、fixedRuntime 实测、UAC/SmartScreen 体验、
   卸载遗留键决策（R8-02）、代码签名门禁。
6. **ADR-0006/0007 收尾**：CI runner 实测、msedgedriver 版本不匹配/无 Runtime 行为、多窗口/托盘/混合 DPI/长时稳定性；
   README 最低系统产品决策（当前仍候选）。
7. **修正估算 + 正式 G0 报告**：按本轮证据重估 R5（WGC 可用后媒体后端成本下降、但打包身份/权限语义待验）与
   R1～R8 总量（计划 §11 的 38～63 人周不得沿用）；按 §1.3 第 2 条重写收益表述。

## 1.5 2026-11-11 21:00 原机接手轮（当前状态）

### 1.5.1 机器变更（三段，数据不可混用）

| 阶段 | 主机 / 用户 | 仓库 | 显示器 / GPU | 证据 |
|---|---|---|---|---|
| ① 2026-11-10 | SHERUNLOCK / MSN | `F:\workspace\Highlighter` | 双屏 4K@150% + 1440×2560@125% 负 Y；RTX 5070 Ti | r0-baseline §1–§8、R0-03 §7、R0-05 初版 |
| ② 2026-11-11 白天/晚 | SHERUNLOCK02 / 24532 | `D:\workspace\Highlighter` | 单屏 2240×1400@150%；Intel Iris Xe | r0-baseline §9.1–§9.3、R0-04 矩阵、R0-05 扩展、R0-06 PDF 产品页、R0-07 安装/性能 |
| **③ 2026-11-11 21:00 起（本轮）** | **SHERUNLOCK / MSN**（回到 ①） | `F:\workspace\Highlighter` | **双屏** 3840×2160@150% 主屏 + 1440×2560@125% 竖屏（(3840,−170) 负 Y）；**RTX 5070 Ti** | 本节、[r0-baseline.md](r0-baseline.md) §9.4、[r0-window-prototype.md](r0-window-prototype.md) §12、[r0-media-native.md](r0-media-native.md) §4.16、[r0-hook-extraction.md](r0-hook-extraction.md) §4.15 |

当前机器事实（OS/CPU/GPU/显示器/Node/Office/WebView2/磁盘/电源/环境陷阱）见 [r0-baseline.md](r0-baseline.md) §9.4.2；§3 的表保留为阶段②历史。

### 1.5.2 本轮做了什么

1. **换机器体检**：分支同步（`0 0`）、工作区先清掉 `core.autocrlf` 造成的假“56 文件全行修改”（§7 陷阱 14）、
   §6.1 快速门禁全部复跑通过。
2. **完整性标签第二次复现并修复**：工作区根再次带 Low 强制标签（工作区内 `whoami.exe` 副本 → Low IL），
   用户批准后修复为 Medium。**新发现**：非提权会话直接 `icacls /setintegritylevel /T` 会对目录报 `Access is denied`，
   必须先给属主授 `(WO)` 再改、改完回收（§7 陷阱 15、r0-baseline §9.4.3）。
3. **R0-03 原机双屏复验**：4 次自检 PASS（副屏 index=1、`origin_physical=(3840,−170)`、`negative_y=true`、
   `dpr=1.25`、`exit 0`）；副屏/主屏截图核对（浮层只覆盖副屏、透明、图案清晰；主屏无窗）；
   `--monitor 0` 负样本 exit 2；退出后 0 残留。见 [r0-window-prototype.md](r0-window-prototype.md) §12。
4. **R0-05 原机复验 + 缺陷修复**：发现原型 `capture::run` 未透传真实 `HMONITOR` —— 多屏下 WGC item 变成整个虚拟桌面
   （5280×2560）导致采集失败；**单屏机器上虚拟桌面尺寸==屏幕尺寸，所以笔记本那轮看不出来**。修复后逐屏正确：
   竖屏 1440×2560@30/@60 满帧、4K@30 未满帧、**4K@60 在“原始 BGRA→stdin→libx264”架构下不可持续**。
   见 [r0-media-native.md](r0-media-native.md) §4.16。
5. **R0-04 原机复跑**：见 §1.5.4（双屏下窗口自动落副屏，Office 版本与笔记本不同）。
6. **文档登记**：r0-baseline §9.4、r0-window-prototype §12、r0-media-native §4.16、[ADR-0001](adr/0001-media-backend.md) 变更记录、
   原型 README（WGC 多显示器修复与 4K/60 结论）、README 索引、本文件。

### 1.5.3 R0 完成度增量（相对 §1.2）

| 任务 | 本轮增量 | 入口 |
|---|---|---|
| R0-03 窗口原型 | **原机双屏/负 Y/混合 DPI（150%+125%）复验 PASS（4 次）**；截图核对、负样本、无残留。100/200% DPI 需改缩放，用户本轮不授权 → 仍未验证 | [r0-window-prototype.md](r0-window-prototype.md) §12 |
| R0-04 钩子 | 原机（双屏 + 新版 Office 16.0.20527）复跑：见 §1.5.4 | [r0-hook-extraction.md](r0-hook-extraction.md) §4.15 |
| R0-05 媒体 | **多显示器 WGC 缺陷修复 + 逐屏验证**；4K@30 未满帧、4K@60 不可持续；竖屏 30/60 fps 满帧 | [r0-media-native.md](r0-media-native.md) §4.16 |
| 环境 | Low 标签二次复现与修复（含 WO 前置）；autocrlf 假改动；PowerShell 静默调用陷阱 | §7 陷阱 14–16、r0-baseline §9.4.3 |
| G0 | **仍未通过**（§1.4 的真实测试机矩阵/WGC 打包身份/R0-04 剩余/修正估算等不变） | [r0-g0-report.md](r0-g0-report.md) §10 |

### 1.5.4 R0-04 原机复跑（2026-11-11 晚）

**结果：首跑 7/10 PASS；Edge 两行冷却后单独复跑 2/2 PASS；唯一稳定 FAIL 是「资源管理器拖选」（与阶段②一致）。**
三条 FAIL 都已定位到**测试侧/目标应用首启状态**，没有一条归因到 helper 取词能力：
- Edge-default：helper 实际取到 15 字符（`found=true method=uia 15 ms`），FAIL 由「首启登录提示条被当成页面文本」
  + 「runner 用 `Get-Content`(GBK) 读 UTF-8 JSONL 把 `found=true` 读成 0 条」两层测试侧问题造成；
- Edge-force：页面 UIA 树对驱动侧不可用 + Ctrl+C 读回旧剪贴板 → 校准失败（exit 5，helper 未启动），复跑 PASS；
- Explorer drag：helper 收到真实事件（`mouseEventsQueued=2`）但地址栏未建立可读选择；校准被旧剪贴板假阳性。
另：卡死恢复**进程级**复核通过（kill helper/kill 目标 → 0 残留 → 重启 exit 0），2 s 有界停止超时仍未触发；
管理员负样本本机未复现（未提权）；发现 **4 条测试夹具缺陷**（GBK 读回、剪贴板假阳性、`-OutDir` 未透传、清理漏杀），
列入 R0-04 收尾。详细数字/原始证据/未定性清单见 [r0-hook-extraction.md](r0-hook-extraction.md) §4.15。

### 1.5.5 本轮提交

（提交后回填：`git log --oneline -3` 与本轮改动清单；PR #5 保持 OPEN、不合并。）

### 1.5.6 仍未闭环（G0 放行前）

1. **真实测试机/VM**：Win10 22H2、WebView2 无/旧/离线、RDP/锁屏、其它 DPI 档；
   ——本机已补：双屏/负坐标/混合 DPI（150%+125%）、独显。
2. **100%/200% DPI 视觉矩阵**：需要改系统缩放（用户本轮明确不授权）。
3. **WGC 收尾**：打包身份（MSIX/能力声明）、同意 UI/采集指示/企业策略、HDR、同屏多路、
   **4K@60 的硬编/GPU 拷贝路径**、长时 WGC；双音源时间对齐真机。
4. **R0-04 剩余**：真实 provider 卡死、管理员窗口正向样本、资源管理器拖选样本、helper↔`native/clipboard` lease 联调。
5. **R0-06/R0-07 剩余**：图片/视频资源桥真实链路、缺字体机器、旧/Fixed Runtime、打印峰值/超时/取消；
   WebView2 多版本/离线矩阵、fixedRuntime、UAC/SmartScreen、卸载遗留键决策。
6. **ADR-0006/0007 收尾 + 修正估算 + 正式 G0 报告**（计划 §11 的 38～63 人周不得沿用）。
## 2. 接手顺序（新会话建议）

> **本轮新增第 0 步（换机器接手必做）**：先确认自己跑在哪台机器上，再动任何代码/证据：
> (a) `git rev-parse --abbrev-ref HEAD` + `git rev-list --left-right --count @{u}...HEAD` 确认分支/同步；
> (b) `git config --get core.autocrlf` 与 `git ls-files --eol | grep -c w/crlf`：若 autocrlf 未设而
>     工作区是 CRLF（`i/lf w/crlf`），`git status` 会把**行尾差异**显示成几十个文件“全行修改” ——
>     先 `git config core.autocrlf true` 再判断是否有真实改动（本轮踩过，见 §7 陷阱 14）；
> (c) 完整性标签：见下面第 2 步（**每次换机器都要查**）。

1. 跑 §6.1 快速门禁（约 1–2 分钟），确认工作区与本地环境。
2. **检查工作区完整性标签**：`icacls "D:\workspace\Highlighter" | findstr /i "Mandatory"` 应为
   `Medium Mandatory Level`；若为 `Low`，按 §3.2 修复（需要 danger-full-access 会话 + 用户批准）。
3. 读 §1.3/§1.4、[r0-g0-report.md](r0-g0-report.md) §8/§9、[r0-installation-matrix.md](r0-installation-matrix.md) §6.2、
   [r0-performance-baseline.md](r0-performance-baseline.md) §10，以及各证据文档的本轮新增章节。
4. **先与用户确认可用测试资源**（真机/VM、Win10、副屏、可见窗口许可），再决定本轮优先级。
5. 按 §1.4 优先级推进；**G0 通过前不要开始 R1～R7 业务迁移**（计划 §7/§8）。
6. 冻结 ADR-0006/0007 候选与 README 兼容性（需产品批准），重估 R5/总量并出正式 G0 报告。

**工作边界（必须遵守，来自计划 §8）**：

- 不改 `main/`、`preload*.js`、`shared/`、`capture/` 生产代码、`native/ocr|clipboard|everything-search`、
  `package.json`/锁文件、现有 Electron 构建入口/CI 工作流（Rust CI 属 R1）。
- 原型不接入产品入口；R0 证据不进 `main`。
- 不读取真实用户凭据/设置；合成数据/合成凭据；不把密钥/密文写进仓库或日志。
- ADR/报告中的“候选/待验证”在 G0 前不得改成“已选定”；新证据回写对应证据文档/ADR 变更记录。
- 可见测试窗口默认副屏；本机无副屏需先征得用户同意（本轮已获授权）。
- 提交说明写清“改变了什么/为什么/如何验证/剩余限制”（计划 §11）。

## 3. 机器与环境事实（**下表是阶段②笔记本**；当前已回到原机，见 §1.5 / r0-baseline §9.4）

> 2026-11-11 21:00 起运行主机已回到原机 `SHERUNLOCK`（Ryzen 7 9850X3D / RTX 5070 Ti / 双屏）。
> 下表保留为**阶段②（SHERUNLOCK02 笔记本）**的历史事实，复现命令/陷阱仍然有效；
> 当前机器的 OS/CPU/GPU/显示器/Node/Office/WebView2 事实见 [r0-baseline.md](r0-baseline.md) §9.4.2。

| 项 | 值 |
|---|---|
| 主机/用户 | `SHERUNLOCK02` / `24532`；当前 shell token = Medium |
| OS | Windows 11 家庭版 26300.9974（26H2） |
| CPU/RAM | i5-13500H 12C/16T；15.75 GiB |
| GPU/显示 | Intel Iris Xe 无独显；单屏 2240×1400@150%（1493×933 DIP），无副屏 |
| WebView2 | 157.0.4341.46（per-machine） |
| Electron/产品 | Electron 43.8.3 / Highlighter 4.2.0 |
| Rust | rustc/cargo 1.97.1（`rust-app/rust-toolchain.toml` 固定），CARGO_HOME=`D:\DevCache\cargo` |
| Node/npm | 24.15.0 / 11.17.0（registry=npmmirror） |
| 其它应用 | Chrome 157.0.8103.50、Edge、Office LTSC 2024（Word/Excel 16.0.17932） |
| 仓库/磁盘 | `D:\workspace\Highlighter`；D: 约 197 GiB 空闲，C: 约 15 GiB（较紧） |
| 电源 | 默认平衡；性能测量脚本临时切高性能并恢复 |
| 完整性标签 | 已修复为 Medium（2026-11-11 19:55–20:00，61,767 文件）；见 §3.2 |
| 工具链 | MSVC Build Tools 2022（vswhere 定位）；ffmpeg=`node_modules/ffmpeg-static/ffmpeg.exe`；tauri-driver=`D:\DevCache\cargo\bin\tauri-driver.exe`；msedgedriver=`.tmp-r07/driver/msedgedriver/157.0.4341.46/msedgedriver.exe` |

### 3.2 工作区完整性标签（关键）

```powershell
# 检查（应为 Medium；Low 表示沙箱标签被重写，会让工作区内 exe 以 Low IL 运行）
icacls "D:\workspace\Highlighter" | findstr /i "Mandatory"

# 修复（需 danger-full-access 会话 + 用户批准；2026-11-11 实操通过）
icacls "D:\workspace\Highlighter" /setintegritylevel "(OI)(CI)M" /T /C /Q   # 61,767 files → Medium
icacls "D:\workspace\Highlighter" /remove:d Everyone
# 能力 SID 若 icacls 无法解析（错误 1332），用 .NET ACL API 移除 S-1-4-... 后 Set-Acl
```

症状对照（修复前实测）：静默安装 exit 0 不落盘（NSIS 静默吞写失败）；WGC `E_ACCESSDENIED`；
真实 SendInput/UIA 选词失败（UIPI）；spawned Electron 写 `%LOCALAPPDATA%\Temp` EPERM；
非静默 NSIS 弹 `#32770 Error opening file for writing`。完整证据：`.tmp-r07/install/rootcause/ROOTCAUSE.md`
（gitignore）、[r0-installation-matrix.md](r0-installation-matrix.md) §6.2、[r0-g0-report.md](r0-g0-report.md) §8.4。

### 3.3 本轮已确认可用的环境能力

- WGC：Medium IL 下 monitor/window capture 均 OK，10s@30fps 采集成功；
- 真实 SendInput/UIA 选词：Chrome/Edge/Word/Excel/Notepad 矩阵通过；
- 静默 NSIS 安装/卸载：工作区原件直跑通过；
- Draco/WebDriver：tauri-driver + 同版本 msedgedriver 全流程通过（仍不覆盖 CI runner/版本漂移）。

## 4. 文档与证据索引

### 4.1 核心入口

| 文档 | 内容 |
|---|---|
| [r0-g0-report.md](r0-g0-report.md) | **G0 决策报告**：§1 状态、§2 ADR 登记、§8 用户决策/ACL 修复、§9 晚间复验结果与最终缺口 |
| [r0-report.md](r0-report.md) | R0 实施报告（最终验收口径）；§14 为本轮明细 |
| [r0-baseline.md](r0-baseline.md) | 基线/任务状态/G0 决策登记；§9 当前机器环境 |
| [adr/README.md](adr/README.md) | ADR 索引（0001～0007，全部候选/未冻结） |
| [README.md](README.md) | 本目录索引 |

### 4.2 本轮更新的证据文档

| 文档 | 本轮变化 |
|---|---|
| [r0-installation-matrix.md](r0-installation-matrix.md) | §6.2 重写：静默安装根因（Low 完整性标签）+ ACL 修复后完整复跑（问题关闭）；§2/§6.4/§6.5/§9/§10/§12 同步 |
| [r0-media-native.md](r0-media-native.md) | §4.1/§4.11–§4.15：WGC 更正确认可用、30 分钟 Low IL + 10 分钟 Medium IL 样例、暂停/双音源/区域窗口/源目标变化、T4 候选区间、环境缺陷与修复 |
| [r0-hook-extraction.md](r0-hook-extraction.md) | §4.9 真机矩阵（10 行 9 PASS）、§4.10 环境缺陷修复、§4.11 lease 协议级互通、§4.13 卡死恢复、§4.14 管理员负样本 |
| [r0-pdf-spike.md](r0-pdf-spike.md) | §8 产品真实 `capture/print.html` 双后端复验（7 用例 + 2 产品函数对照）、R4-07 实现约束 |
| [r0-performance-baseline.md](r0-performance-baseline.md) | §10 产品决策：收益假设重估（撤回 -25%、T1 非回归守卫候选、T2 待 R1） |
| [r0-test-driver.md](r0-test-driver.md) | §12 ACL 修复后 WebDriver 探针复跑记录 |
| [r0-window-prototype.md](r0-window-prototype.md) | 未改（§11 单屏拒绝路径仍有效；ACL 修复后自检复跑 PASS 记录见 g0 §9.1） |
| [adr/0001](adr/0001-media-backend.md)、[0002](adr/0002-hook-extraction.md)、[0003](adr/0003-pdf-backend.md) | 证据/限制/变更记录更新；状态仍候选 |

### 4.3 机器可读产物与工具

- 合同/夹具：`contracts/host/host-contracts.json`、`test/fixtures/host-parity/`、`test/host-contracts.test.js`。
- Rust workspace：`rust-app/`（6 crates + `src-tauri` 原型；本轮 `cargo test --locked` 107+ tests 经 check-rust-app 全绿）。
- 媒体原型：`rust-app/prototypes/native-capture/`（新增 `pause.rs`/`sync.rs`/`testwin.rs`/`capture/window.rs`/`env.rs`/
  `run-long-sample.ps1`；CLI `--scenario`/`--region`/`--pause-*`/`--audio-endpoint`/`--probe-wgc` 等）。
- PDF 原型：`rust-app/prototypes/webview-pdf-resource/`（`--pdf`、`--resource`、新增 `--pdf-product`）+
  `scripts/rust/{pdf-product-cases.js,probe-electron-product-pdf.js,analyze-product-pdfs.py}`。
- 钩子：`native/selection-helper/`（`build.ps1`、`test/real-selection.ps1`、新增 `test/real-selection-matrix.ps1`、
  `test/run-selection-matrix.ps1`）。
- 测量/驱动：`scripts/rust/{measure-resources.ps1,measure-r0-07-performance.ps1,probe-tauri-webdriver.js,run-tauri-webdriver-probe.ps1}`。
- 安装取证：`.tmp-r07/install/rootcause/`（scratch，gitignore：`ROOTCAUSE.md`、`probe-*.ps1`、`probe-*.log/json`）。

### 4.4 证据目录约定

- `.tmp-r0/`、`.tmp-r07/`、`.tmp-r0-media-native/`、`.tmp-r0-hook/`、`.tmp-r0-pdf/` 等全部 **gitignore，不提交**；
  文档内记录命令 + 关键输出 + 哈希。当前机器上本轮证据仍在对应 `.tmp*` 目录；若被清理，按 §6 命令重跑重建。
- 目录中可能残留旧机（Ryzen/RTX/F:）时期的证据，**新结论只用当前机重新跑出的数据**；引用时注意文档中的机器标注。

## 5. 未决问题（需要用户/产品决策）

1. **README 最低系统**：是否将 README 从“Windows 10 或 Windows 11”收紧为“Windows 10 22H2 或更新”（ADR-0007 候选 A+D）。
2. **卸载遗留键**：静默卸载是否无条件清理 `HKCU\Software\<publisher>\<product>`（R8-02）。
3. **钩子维护面**：是否接受保留 C++ selection helper（ADR-0002 候选 A）并登记退出计划，还是要求纯 Rust 重写。
4. **测试驱动路线**：确认 ADR-0006 候选 A1（tauri-driver + 精确匹配 msedgedriver）作为 R1-e 主路线。
5. **PR #5 / CI**：本轮提交已推送（3 个提交）、PR #5 未合并；本次 CI 已按用户要求跳过，
   下一轮何时补跑 CI/合并 PR 需用户决定（推送或手动 dispatch 会触发 `Windows CI`）。
6. **测试资源**：能否提供/安排 Win10 22H2 真机或干净 VM、双屏/多 DPI、独显机器（§1.4 第 1 项）。
7. **修正估算/正式 G0**：依赖 1～6 与真机矩阵；R5 媒体后端在 WGC 可用后需重新评估（但打包身份/同意语义未验）。

**已解决（本轮）**：性能收益假设（撤回 -25% 目标，接受不承诺内存/启动收益，见 §1.3 第 2 条）；
静默安装“不落盘”根因（环境缺陷，已修复复验）。

## 6. 复现/验证命令（本机实测；仓库根目录，Windows PowerShell）

### 6.1 快速门禁（约 1–2 分钟）

```powershell
node scripts/rust/extract-host-contracts.js --check        # exit 0
node scripts/rust/generate-host-fixtures.js --check        # exit 0
node --test test/host-contracts.test.js                    # 19 pass
node scripts/rust/collect-frontend-resources.js --check    # OK 191 files
node --test test/frontend-resource-whitelist.test.js       # 9 pass
npm run check                                              # 489 JS files / architecture / i18n
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1   # fmt+clippy+test
```

### 6.2 R0-03 窗口自检（无副屏时默认拒绝建窗，是安全路径；本机已获可见窗口授权）

```powershell
cargo build --manifest-path rust-app/Cargo.toml -p highlighter-r0-window --release --locked
.\rust-app\target\release\highlighter-r0-window.exe --self-test          # 单屏无开关：exit 2，不建窗
$env:HIGHLIGHTER_R0_ALLOW_PRIMARY='1'
.\rust-app\target\release\highlighter-r0-window.exe --self-test --hold-ms 2000   # exit 0 PASS（测试专用开关）
Remove-Item Env:HIGHLIGHTER_R0_ALLOW_PRIMARY
```

### 6.3 WebDriver 探针（ADR-0006）

```powershell
# 前置：tauri-driver（cargo install）与 msedgedriver（与 WebView2 Runtime 完全同版本）
powershell -File scripts/rust/run-tauri-webdriver-probe.ps1 `
  -NativeDriver .tmp-r07\driver\msedgedriver\157.0.4341.46\msedgedriver.exe -AllowPrimaryScreen
```

### 6.4 性能/进程树对照（约 6 分钟；临时切高性能并恢复；会出现全屏透明窗口）

```powershell
powershell -File scripts/rust/measure-r0-07-performance.ps1 -Runs 3 -IdleSec 20 -IncludeProduct -OutDir .tmp-r07/perf/results-clean
```

### 6.5 安装包构建（仅 R0-07 测试包；必须在 rust-app 下执行）

```powershell
cd rust-app
npx --yes @tauri-apps/cli@2 build --no-bundle --ci
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci        # downloadBootstrapper
# 其它 WebView2 模式：--config <embedBootstrapper.json|offlineInstaller.json>
```

### 6.6 安装/卸载取证（ACL 修复后工作区原件可直接跑；证据在 .tmp-r07/install/rootcause/）

```powershell
# 探针（可复跑；详见 .tmp-r07/install/rootcause/ROOTCAUSE.md §4）
pwsh -File .tmp-r07/install/rootcause/probe-silent-install.ps1   # 基线/对照（含 IL 取证）
pwsh -File .tmp-r07/install/rootcause/probe-uninstall.ps1        # 卸载
pwsh -File .tmp-r07/install/rootcause/cleanup-probe.ps1          # 清理
```

### 6.7 本轮新增证据复现

```powershell
# R0-05 WGC 探测 / 10s WGC 采集 / 暂停 / 双音源 / 区域 / 窗口 / 长样例（Release）
cargo build --release --manifest-path rust-app/prototypes/native-capture/Cargo.toml --locked
rust-app\prototypes\native-capture\target\release\native-capture.exe --probe-wgc --animate --monitor 0 --out .tmp-r0-media-native\probe-wgc
rust-app\prototypes\native-capture\target\release\native-capture.exe --seconds 10 --fps 30 --capture wgc --monitor 0 --animate --out .tmp-r0-media-native\wgc-10s
pwsh -File rust-app\prototypes\native-capture\run-long-sample.ps1 -OutDir .tmp-r0-media-native\long-sample -Seconds 600

# R0-04 真机选词矩阵（helper 必须 Medium IL；附 Medium 预检）
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1 -Clean -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1

# R0-06 产品真实 print.html 双后端 PDF（隐藏窗口）
node scripts/rust/pdf-product-cases.js
$env:ELECTRON_RUN_AS_NODE=$null; $env:TMP="$PWD\.tmp-r0-pdf\tmp"; $env:TEMP=$env:TMP
node_modules\electron\dist\electron.exe --no-sandbox scripts/rust/probe-electron-product-pdf.js
$env:CARGO_TARGET_DIR='rust-app/target'
cargo build --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml --locked
.\rust-app\target\debug\highlighter-r0-pdf-resource.exe --pdf-product
$env:PYTHONPATH="$PWD\.tmp-r0-pdf\pylibs"; python scripts/rust/analyze-product-pdfs.py
```

### 6.8 本机已知陷阱（命令前必读）

- **先查工作区完整性标签**（§3.2）：Low 会让上面多数“失败”变成环境伪失败。
- Electron 探针：`env -u ELECTRON_RUN_AS_NODE`、`--no-sandbox` 在脚本路径之前、`TMP/TEMP` 指向 `.tmp*/`。
- 产品 E2E 隔离：`HIGHLIGHTER_E2E=1` + `HIGHLIGHTER_E2E_DATA_ROOT`（详见 `e2e/electron-app.js`）。
- 完整 `npm test`/`test:e2e` 本轮未跑（不声称 CI/E2E 通过）。
- 原型调用：本宿主下 PowerShell 5.1 `& <exe>` 可能静默不执行（见 §7 陷阱 16）；用 bash 或 `cmd /c`。
- 行尾：仓库混合 CRLF/LF blob（`core.autocrlf=true`）；**换机器先 `git config core.autocrlf true`**（§7 陷阱 14）；改文件时保持该文件 HEAD 的行尾约定，
  否则会出现整文件 diff；`git -c core.whitespace=cr-at-eol diff --check` 干净可作为提交前检查。

## 7. 环境陷阱与经验（累计）

1. **工作区 Low 完整性标签（2026-11-11 新增，最重要）**：见 §3.2。症状、诊断、修复与复验证据；
   该缺陷曾导致“受限宿主/环境级”错误结论（静默安装、WGC、SendInput、Electron TMP）。
   **不要再把这些现象当成机器能力结论**；先查标签。修复后再用 workspace-write 会话可能重写标签。
2. **PowerShell 5.1 + UTF-8 无 BOM 脚本**：中文注释行尾多字节字符会被 GBK 代码页误解析并吞掉换行，
   导致 `param` 块 `Unexpected token`。仓库新脚本统一 UTF-8 **with BOM**（或纯 ASCII 注释）。
3. **Tauri CLI 会改写 Cargo.toml**：`tauri-cli 2.12.4` 在 build/bundle 时把 `tauri = { version = "2" }` 写成
   `{ version = "2", features = [] }`；且**必须在 `rust-app/` 下执行**（在仓库根会把 `prototypes/webview-media`
   当 Tauri 项目并改写其 Cargo.toml）。
4. **行尾/CRLF（更新）**：仓库部分文件历史 blob 为 CRLF、部分 LF（`core.autocrlf=true` 但历史混用）。
   修改已有文件时保持其 HEAD 行尾；新增文件用 LF。提交前用
   `git -c core.whitespace=cr-at-eol diff --check`（普通 `git diff --check` 会把 CRLF 的 CR 误报为 trailing whitespace）。
   合同/夹具仍做字节级 sha256 校验（`.gitattributes` 固定 LF）。
5. **Electron 探针（更新）**：`ELECTRON_RUN_AS_NODE=1` 会导致 `app is undefined`；
   `--no-sandbox` 必须在脚本路径前；spawned Electron 写 `%LOCALAPPDATA%\Temp` EPERM 的**旧结论很可能是
   Low IL 造成**，ACL 修复后**未完整复测**（本轮未跑完整 npm test，不要写成已解决）。
6. **WebView2 缺失/损坏**：加载器弹阻塞式 `#32770` 对话框并挂起，应用 exit 2；产品必须启动前检测 Runtime
   并给原生引导（托盘/自启动尤其危险）。
7. **msedgedriver 必须与 WebView2 Runtime 精确同版本**；runner 镜像更新会导致版本漂移，需运行时解析
   （`https://msedgedriver.microsoft.com/<pv>/edgedriver_win64.zip`）。
8. **未签名包**：经 ShellExecute 双击会弹“打开文件 - 安全警告”；自动化用 CreateProcess（`UseShellExecute=false`）。
9. **NSIS 安装包不可逐字节复现**（时间戳/临时路径）；发布需记录签名后的最终 sha256。
10. **可见窗口默认副屏**；本机单屏需先问用户（本轮已获授权）。无副屏时 R0-03 原型安全拒绝建窗（exit 2）。
11. **npm registry 差异**：本机 npmmirror（与 AGENTS.md 一致）；`npm audit` 空结果先排查 registry。
12. **采样方差**：最小壳内存/启动对照轮间波动可达 ±8%；阈值用均值/区间并记录电源方案、Runtime、内核版本。
13. **测试环境扰动**：长媒体/性能测量期间并行跑其它重活会造成背压/时间轴截短（本轮已实测一次，登记为不可用）；
    正式测量需隔离负载并记录 system-load。
14. **换机器接手：`core.autocrlf` 未设置 → 假“全文件修改”**（2026-11-11 晚实测）：工作区从另一台机器拷回后，
    `git status` 显示 56 个文件、1.9 万行改动，但 `git diff --numstat` 每个文件都是“增=删=行数”，
    `git ls-files --eol` 统计 `i/lf w/crlf` = 973。原因：本机 `core.autocrlf` 为空（HEAD blob 是 LF，工作区是 CRLF）。
    **修复**：`git config core.autocrlf true` → `git status` 立即干净，没有覆盖任何真实改动。
    教训：换机器第一件事查行尾，别把 EOL 差异当成上轮未提交的工作。
15. **给工作区换完整性标签需要先授 `WRITE_OWNER`**（2026-11-11 晚实测）：直接
    `icacls <root> /setintegritylevel (OI)(CI)M /T /C /Q` 在非提权会话里会对**目录**报
    `Access is denied`（属主只有隐式 `READ_CONTROL`+`WRITE_DAC`，改 mandatory label 需要 `WO`）。
    可行序列：`icacls <root> /grant "*<SID>:(WO)" /T /C /Q` → `/setintegritylevel ... /T` →
    `icacls <root> /remove:g "*<SID>" /T /C /Q` 回收；`(WO)` **必须带括号**，否则 `Invalid parameter`（exit 87）。
16. **PowerShell 5.1 直接 `& <console-exe>` 在本宿主会静默返回**（2026-11-11 晚实测）：
    `& rust-app\prototypes\native-capture\target\release\native-capture.exe --help` 在函数/变量赋值里
    得到 0 行输出且 `$LASTEXITCODE` 未设置（既不报错也不执行）；同一命令用 `cmd /c "..."` 或 bash 直接调用正常。
    原型/探针批量跑建议用 bash 或 `cmd /c` 包一层，并在脚本里断言 `$LASTEXITCODE` 非空。

## 8. 历史记录

- 2026-11-11 16:20 交接版（含 2026-11-10 快照）：`git show a2a87e3:docs/plans/rust-migration/handoff.md`。
- 2026-11-10 原机（Ryzen 7 9850X3D / RTX 5070 Ti / 双屏 / F:）数据与当前机**不可混用**；原机证据只在
  `r0-baseline.md` §9 等历史章节保留。
