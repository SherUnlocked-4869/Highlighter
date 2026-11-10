# ADR-0002：划词/回贴钩子提取边界（C++ helper vs Rust 重写）

- 状态：**候选（有构建与真实选词证据，未冻结）**
- 决定批次：R0-04；实施批次：R3（划词/剪贴板/焦点协作）
- 日期：2026-11-10
- 关联计划：§2 D04、§7 R0-04/R3、§8 G0；
- 证据文档：[r0-hook-extraction.md](../r0-hook-extraction.md)、`native/selection-helper/`、`.tmp-r0-hook/`

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
- 构建：`native/selection-helper/build.ps1`（vswhere → vcvars64 → cl/link，`/std:c++17 /EHsc
  /utf-8 /MT /DNOMINMAX`，链 uiautomationcore/user32/ole32/oleaut32/oleacc/shell32/gdi32），
  clean + self-test 6.4s，9 个编译单元，产出 306,176 B exe。
- 运行：`--self-test` / `--duration*` / `--heartbeat-ms` / `--exit-after-selection` 等参数；
  JSONL 事件（选词文本/sourcePid/sourceHwnd/6 组坐标/method/stage/error/heartbeat）。
- 真实选词自动化：`native/selection-helper/test/real-selection.ps1`（副屏窗口 + SendInput）。

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
| 浏览器/Office/资源管理器/管理员窗口 | 未验证 | 未验证 |
| 真实 UIA/钩子卡死恢复 | 仅有 2s 有界停止代码路径，未做真实卡死复现 | 未验证 |
| clipboard coordinator `required=true` 命名管道 lease | 未做 | 未验证 |
| 与既有 Rust 剪贴板联调（R0-04 后半） | 未做 | 未验证 |

**成本结论（本机依据）**：A 产品化剩余 **18–29 人日**（≈3.5–6 人周；协议重设计、Rust 宿主健康/重启、
18 方法/6 事件配置面、真机矩阵、打包签名）；B 重写 **27–45 人日**（≈5.5–9 人周）且缺少行为夹具库、
兼容风险更高；C 只允许登记退出批次的过渡。

## 5. 结论（建议）

**建议选 A（提取 C++ 独立 helper），置信度中高。** 前提与必须同时登记的约束：

1. 协议必须重新设计（帧/版本/心跳/ping/背压/错误码），**原型 JSONL 不是产品协议**；
2. helper 需要产品化：单实例/健康检查/崩溃重启/有界停止/日志脱敏/打包与签名；
3. C++ helper 的维护责任与退出计划必须登记（计划 D08：临时兼容方案不能无限延期）；
4. G0 仍缺的真机矩阵（浏览器/Office/资源管理器/管理员窗口）、真实卡死恢复、`required=true`
   lease、与现有 Rust 剪贴板（`native/clipboard`）联调在 R0 收尾/R3 前补齐；
5. 本 ADR 不改变 G0 状态；仅在补证后由 G0 报告确认。

## 6. 未解决限制

- 真实选词只覆盖 Notepad 与 WinForms RichTextBox 两类样本；浏览器、Office、资源管理器、
  PDF 阅读器、管理员权限目标未验证。
- 真实 UIA/钩子卡死恢复、clipboard coordinator 命名管道 lease（required=true）、
  `getCurrentSelection` 同步 API 未验证。
- 与 Rust 宿主/剪贴板服务的进程协议、权限边界、崩溃回收尚未设计。
- C++ 维护面保留带来的长期成本与安全更新责任未量化。

## 7. 责任批次与退出验收

- R3-01：helper 产品化 + 协议设计 + Rust 宿主 supervisor 接入。
- R3-02/R3-05：剪贴板协调身份/lease/前台授权、SmartSelect/光标协作联调。
- 退出验收：G2 前完成真机矩阵与错误目标拒绝；G3 前确认 helper 属可保留的 C++ 资产（非 Node 依赖）；
  G4 前完成安装/升级/签名与回退。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：建议 A（提取），附构建/真实选词/成本证据与未验证项 | [r0-hook-extraction.md](../r0-hook-extraction.md) |
