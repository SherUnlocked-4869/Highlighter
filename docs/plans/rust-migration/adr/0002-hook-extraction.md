# ADR-0002：划词/回贴钩子提取边界（C++ helper vs Rust 重写）

- 状态：**候选（有构建与真实选词证据，未冻结）；2026-11-11 补证完成：环境修复后真机应用矩阵 9/10 行通过、管理员窗口 UIPI 负样本、卡死恢复进程级复核、clipboard lease 协议级互通；真实 provider 卡死与 helper↔native/clipboard 联调仍未验证。**
- 决定批次：R0-04；实施批次：R3（划词/剪贴板/焦点协作）
- 日期：2026-11-10 初稿；2026-11-11 补证
- 关联计划：§2 D04、§7 R0-04/R3、§8 G0；
- 证据文档：[r0-hook-extraction.md](../r0-hook-extraction.md)（§4.9–§4.12 为 2026-11-11 补证）、`native/selection-helper/`、`.tmp-r0-hook/`

## 1. 背景与问题

计划 D04 规定"优先把 Windows selection core 包装成独立 helper，替换 N-API 宿主；提取成本高于重写
且行为夹具完备时再选择 Rust 钩子实现"。现有实现是 C++ N-API addon
（`vendor/selection-hook`，Windows 平台核心 `engine/worker/lib` 共约 2,590 行），由 Electron
utility process 承载（`main/services/selection-hook-host.js`）。Rust 宿主不能直接消费 `.node`，
必须在 A（提取 C++ helper）、B（Rust 重写）、C（Node sidecar 过渡）之间决定。

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| A 提取 C++ 独立 helper | `engine + lib` 原样编译进独立 exe，Rust 通过进程协议拉起 | 2,590 行兼容逻辑零改写；COM/UIA 继续进程隔离；崩溃可整进程回收；与现有 utility process 隔离模型同构 | 需重做进程协议与配置面；保留 C++ 维护面；需计划打包/签名/退出策略 |
| B Rust 重写 | 用 `windows` crate 重写 UIA→MSAA→剪贴板事务、hook 线程与手势过滤 | 终态纯 Rust、无跨语言协议 | 约 3,000 行 issue 驱动兼容逻辑重写；无行为夹具库；UIA/COM/剪贴板事务等价风险高 |
| C Node sidecar | 短期保留既有 addon | 0 改动 | 违反 D08/G3 终态，只能登记退出批次的临时方案 |

## 3. 实测条件与命令

- 环境：Windows 11（build 26300.9711）、MSVC Build Tools 2022、副屏 `\\.\DISPLAY2`
  `(3840,-170) 1440×2560@125%`；真实窗口与 SendInput 真实鼠标手势。
- 2026-11-11 补测环境：`SHERUNLOCK02`，Windows 11 家庭版 26300.9974、单屏 2240×1400@150%、
  Chrome 157 / Edge 157 / Office LTSC 2024 16.0.17932；**该工作区带 `Low Mandatory Level`
  继承标签，工作区内构建的 helper 以 Low IL 运行，跨应用真实选词样本不可用（环境缺陷，
  已登记；见 r0-hook-extraction.md §4.10）**。
- 构建：`native/selection-helper/build.ps1`（vswhere → vcvars64 → cl/link，`/std:c++17 /EHsc
  /utf-8 /MT /DNOMINMAX`，链 uiautomationcore/user32/ole32/oleaut32/oleacc/shell32/gdi32），
  clean + self-test 6.4s，9 个编译单元，产出 306,176 B exe；2026-11-11 本机 rebuild
  产出 309,248 B，`-Clean -SelfTest` PASS。
- 运行：`--self-test` / `--duration*` / `--heartbeat-ms` / `--exit-after-selection` 等参数；
  JSONL 事件（选词文本/sourcePid/sourceHwnd/6 组坐标/method/stage/error/heartbeat）。
- 真实选词自动化：`native/selection-helper/test/real-selection.ps1`（副屏窗口 + SendInput，
  2026-11-10 用）；2026-11-11 新增 `test/real-selection-matrix.ps1`（多应用矩阵，主屏授权窗口，
  UIA/剪贴板双路径、驱动侧独立校验、helper IL 预检）与 `test/run-selection-matrix.ps1`
  （一键重建 + 逐行矩阵 + JSON 汇总）；当前因环境缺陷拒绝记录矩阵证据（矩阵脚本 exit 7 / runner 预检 exit 3）。
- 剪贴板协调器：2026-11-11 用 `.tmp-r0-hook/clipboard-lease-interop.ps1` 驱动真实
  `native/clipboard/bin/HighlighterClipboard.exe`（stdio 帧 + 命名管道固定包协议）验证
  `required=true` 的 begin/end/status 协议路径；**不是** C++ helper 的客户端联调。

## 4. 证据

| 验证项 | 结果 | 判定 |
|---|---|---|
| vendor 复用边界 | 16 文件 2,590 行零改动复用；N-API 命中 0（`engine/types/lib`）；唯一 Node 绑定是 `core/worker.{h,cc}` 530 行 | 通过（边界明确） |
| 构建耦合 | 需补 `binding.gyp` 未写的 `/DNOMINMAX` 与 `gdi32.lib`（隐式耦合已记录） | 通过（成本已量化） |
| self-test / 生命周期 | PASS + exit 0；参数错 4、UIA 注入失败 2、钩子注入失败 3、无选词超时 6；kill → 重启 → exit 0，无残留进程 | 通过 |
| 真实选词（Notepad） | 双击 UIA `text="04"`（positionLevel=3 full），拖选 37 字符 | **通过** |
| 真实选词（WinForms RichTextBox） | UIA/MSAA 无结果后走剪贴板回退 `method=99`，37 字符，140ms，剪贴板前后一致 restored=true | **通过** |
| 负样本 | 同一 WinForms 目标不开剪贴板回退时取不到（method=0，16ms） | 通过（provider 差异如实记录） |
| 鼠标/键盘钩子 | F24 down/up×2 实测；`--exit-after-selection` 正常 | 通过 |
| 浏览器/Office/资源管理器矩阵（2026-11-11，Medium IL 重跑） | 10 行中 9 行 PASS（真实 SendInput 手势，全部 `method=1 uia`）：Notepad 39 字符、Chrome 默认/强制 a11y 各 15、Edge 默认/强制 a11y 各 15、Word 36（31 ms）、Excel 默认/`--clipboard` 各 29（16/32 ms）、资源管理器双击选词 4；资源管理器**拖选**行因测试校准失败（样本未建立） | **通过（9/10；1 行为测试校准问题，非 helper 缺陷）** |
| 真实 UIA/钩子卡死恢复（2026-11-11，Medium IL） | 冻结 UI 线程目标未真正阻塞 UIA（取词 31 ms 完成）；进程级 kill helper/kill 目标进程恢复通过（残留 0、重启 self-test exit 0）；2 s 有界停止超时分支未真实触发 | **进程级恢复通过；真实 provider 卡死未验证** |
| 管理员/高完整性窗口（2026-11-11） | UAC 经用户批准取得 High IL 目标；Medium helper 对其真实拖选 `mouseEventsQueued=0`（UIPI） | **负样本通过（平台限制，不承诺越权）** || clipboard coordinator `required=true` 命名管道 lease（2026-11-11 补证） | 协议级最小互通：真实 `native/clipboard` sidecar + 脚本协议客户端，begin/end/status 闭环成功（`generation=2`、`leaseMs=2000`、`lastCompletion outcome=restored`、sidecar exit 0）；**helper 无 lease 客户端，未启用 capture 竞争** | **协议互通通过；helper↔native/clipboard 联调未通过（缺口明确）** |
| 与既有 Rust 剪贴板的产品级联调（R0-04 后半） | 未做（helper 无 coordinator 客户端；`required=false` 恒授权语义） | 未验证 |

**成本结论（本机依据）**：A 产品化剩余 **18–29 人日**（≈3.5–6 人周；协议重设计、Rust 宿主健康/重启、
18 方法/6 事件配置面、真机矩阵、打包签名）；B 重写 **27–45 人日**（≈5.5–9 人周）且缺少行为夹具库、
兼容风险更高；C 只允许登记退出批次的过渡。2026-11-11 补证不改变该成本对比；环境修复后的矩阵重跑已完成
（9/10 行 PASS），R3 仍须补 coordinator lease 客户端（约 118+71 行参考实现移植）与 PDF/DPI/长稳矩阵。
## 5. 结论（建议）

**建议选 A（提取 C++ 独立 helper），置信度中高。** 前提与必须同时登记的约束：

1. 协议必须重新设计（帧/版本/心跳/ping/背压/错误码），**原型 JSONL 不是产品协议**；
2. helper 需要产品化：单实例/健康检查/崩溃重启/有界停止/日志脱敏/打包与签名；
3. C++ helper 的维护责任与退出计划必须登记（计划 D08：临时兼容方案不能无限延期）；
4. G0 仍缺：PDF 阅读器/真实网页/混合 DPI 矩阵、真实 provider 卡死、`required=true` lease 的产品级联调
   （helper 端客户端）、长稳/进程组；真机应用矩阵与管理员窗口 UIPI 负样本已补（2026-11-11）。
5. **重跑前置（2026-11-11）**：宿主工作区 `Low Mandatory Level` 继承标签已修复（Low→Medium），
   helper 已重建并以 Medium IL 运行；`run-selection-matrix.ps1` 的 Medium IL 预检保留，环境回退时拒绝记录。6. **R3 前置（2026-11-11 新增）**：helper 必须实现 clipboard coordinator lease 客户端
   （或明确“协调器启用时禁用剪贴板回退”）；仅在 `required=false` 下恒授权的行为不能进入产品。
7. 本 ADR 不改变 G0 状态；仅在补证后由 G0 报告确认。

## 6. 未解决限制

- 真实选词已覆盖 Notepad/Chrome/Edge/Word/Excel/资源管理器（2026-11-11，9/10 行 PASS）；未覆盖 PDF 阅读器、
  真实网页/Electron 应用、混合 DPI/多屏长稳。资源管理器**拖选**样本未建立（测试校准问题），已用同窗口
  双击选词覆盖。
- 真实 provider 卡死未复现（2 s 有界停止超时分支无真实触发证据）；`getCurrentSelection` 同步 API 未验证；
  clipboard coordinator 命名管道 lease（`required=true`）只完成**协议级**互通，helper 端客户端与 capture
  竞争未验证；管理员高完整性窗口只有 UIPI 负样本，无正向样本。- 与 Rust 宿主/剪贴板服务的进程协议、权限边界、崩溃回收尚未设计；R3 需要把 supervisor、
  coordinator 注册宿主 PID、endpoint 下发与 revision/健康握手一起设计。
- 本机新发现的测试环境约束（helper 控制台可见性、Chromium 默认 UIA 关闭）已登记，产品运行环境不受
  这些测试脚本约束，但真机测试必须遵守。
- C++ 维护面保留带来的长期成本与安全更新责任未量化。

## 7. 责任批次与退出验收

- R3-00（前置）：✅ 已完成（2026-11-11）宿主/工作区完整性环境修复（Medium IL）+ helper rebuild；矩阵脚本 Medium IL 预检通过并产出有效结果。
- R3-01：helper 产品化 + 协议设计 + Rust 宿主 supervisor 接入。
- R3-02/R3-05：剪贴板协调身份/lease/前台授权、SmartSelect/光标协作联调；helper 移植 lease 客户端。
- 退出验收：G2 前完成真机矩阵与错误目标拒绝；G3 前确认 helper 属可保留的 C++ 资产（非 Node 依赖）；
  G4 前完成安装/升级/签名与回退。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：建议 A（提取），附构建/真实选词/成本证据与未验证项 | [r0-hook-extraction.md](../r0-hook-extraction.md) |
| 2026-11-11 | 补证：真机矩阵脚本/一键重跑；登记并修复宿主工作区 Low IL 缺陷；完成 clipboard coordinator `required=true` 协议级互通并明确 helper 缺客户端 | [r0-hook-extraction.md](../r0-hook-extraction.md) §4.9–§4.12、`.tmp-r0-hook/`（gitignored） |
| 2026-11-11 | **补证完成**：工作区 Low→Medium 修复后矩阵 10 行 9 PASS（真实手势、全部 UIA）；管理员窗口 UIPI 负样本（UAC 经用户批准）；卡死恢复进程级通过但真实 provider 卡死未复现；成本对比与 A 建议不变 | [r0-hook-extraction.md](../r0-hook-extraction.md) §4.9/§4.13/§4.14、`.tmp-r0-hook/matrix-results.jsonl`、`hang-recovery-results.json`、`admin-negative-results.json` |
