# 5.1.1 后续批次执行记录（DEV-01…DEV-10 / E01–E03）

2026-11-28 · 依据 [后续开发与缺陷验收任务](2026-11-28-review-optimization-follow-up-tasks.md) §4/§6、
[交接记录](2026-11-28-review-optimization-handoff.md)、[5.1.1 后续验收台账](2026-11-28-follow-up-acceptance-status.md)。
代码基线为 root 已提交的 DEV 批次并含 DEV-08 采用提交（HEAD `0ccc397`，接 `c2e6003` 计划提交），
E01/DEV-03 记录随 `be11fa8` 入库；集成复跑结果见 §5。

**本记录只登记“实现/提交/自动化回归/未做项”的事实，不做真机或发布验收结论。** 凡写“已实现”均指
代码已提交且仓库内存在对应回归文件；真机门槛一律引用验收台账，未执行的真机步骤不得由本记录冒充通过。
本记录由 docs-owner 依据提交内容、`git show --stat` 与定向测试整理；实现细节以 root/对应 owner 的提交说明为准。

## 0. 状态词

| 状态 | 含义 |
|---|---|
| `implemented` | 代码已提交；仓库内存在对应回归文件（是否本轮复跑单独标注） |
| `implemented（回退开关）` | 同上，且提交内含停用/回退路径 |
| `measurement only / decision pending` | 只有测量与试验，无产品改动；是否采用待决议 |
| `experiment-only / not adopted` | 原型未接线、未采用，不改变产品行为 |
| `decision` | 产品/凭据边界结论（不写代码路径） |
| `pending integration` | 需 root 在集成阶段复跑全量门禁/原生构建后确认 |

## 1. DEV 工单状态

| 单号 | 状态 | 提交 | 实现要点（按提交内容） | 自动化证据 | 剩余真机/发布门槛 |
|---|---|---|---|---|---|
| DEV-01 贴图矢量重标注 | `implemented` | `7f6133b` | 截图侧生成 `shared/capture-document.js` v3 编辑快照，经既有 `meta.pinEditable` 传给贴图；pin 只在内存保存，重标注时读回底图 PNG + 矢量；保存成功后一起替换显示图与快照；**不写入** meta/工作区快照/恢复票据/历史 | `test/u02-pin-reedit.test.js`（新增，本轮复跑 ✔）；提交同时扩展 `test/pin-copy-once.test.js`、`test/capture-pin-copy.test.js`、`test/u02-longpin-ux.test.js`（未复跑；文件内未写 U02，登记表格式见 §4） | 真实窗口“截图→贴图→改旧箭头/文字→保存→再次打开”往返（100%/150% DPI）；私密截图存工作区/恢复后检查工件中无未脱敏底图；重复改图/关闭与部分失败重试 |
| DEV-02 离屏导出当前视图 | `implemented` | `7f6133b` | 渲染层离屏合成器 `pin/pin-view-export.js`；复用既有 `pin:context-menu` 有界命令信封，**无新增 IPC 通道**；预览确认与落盘使用同一 PNG 字节 | `test/u02-pin-view-export.test.js`（新增，本轮复跑 ✔）；`pin/pin.html` 加载顺序接线在用例内断言 | 真实窗口逐像素/视觉对照（0°/90°、缩放、长图中段、两档 DPI）；导出时无可见样式跳变（逐帧录像）；取消后无文件、异常释放缓冲 |
| DEV-03 截图窗口预热 / SmartSelect 试验 | `measurement only / not adopted` | `be11fa8`（仅探针与测量记录，无产品改动） | 在真实候选管线测得：热键→首帧热 p95 为 DISPLAY2 212 ms / DISPLAY1 315 ms（冷 194/301 ms），其中抓屏 148/238 ms；隐藏窗口预热需 +29–33 MiB private / +103–107 MiB WS；SmartSelect 复用空闲 +24.8 MiB、8 分钟 0 CPU，但原生侧车启动时冻结可见窗口列表、窗口移动后返回陈旧矩形（已实测复现）。按预先写定的阈值（每套显示配置热 p95 ≥30 ms 且 ≥12%、空闲 ≤48 MiB/≤128 MiB、回收 ≤500 ms）两项均**不采用**；`capture/**`、`main.js` 无产品改动 | 测量记录（含阈值、原始样本与决策理由）：`docs/plans/2026-11-28-dev03-e01-measurements.md`；探针 `scripts/measure-capture-pipeline.js`、`scripts/probe-smart-select-lifecycle.js`、`scripts/probe-smart-select-staleness.js` | 无需真机即可关闭该试验单（结论=不采用、保持按需创建）；若未来继续延迟优化，落点是 `capture.acquired` 与约 46–48 ms 的渲染层尾段，并须重新测量后再改产品 |
| DEV-04 全局快捷键采集 | `implemented` | `f0f5333`（原生通道 `33fc2ee`） | `vendor/selection-hook` 新增显式 opt-in 的 `key-combo` 原生通道；JS `main/domains/record/keystroke-capture.js` 隐私过滤（普通打字/Shift 单字/IME/连击/注入/敏感焦点均丢弃，只产出 `{at, combo}`，不含文本与窗口内容）；`events.json` 增量 `keystrokes` 轨；workbench 参数页新增开关；不改 IPC | `test/n03-global-keystrokes.test.js`（新增，本轮复跑 ✔）、`test/selection-keyboard-combos.test.js`（原生自测桥，本轮复跑 ✔）、`test/pointer-track-service.test.js`（扩展，本轮复跑 ✔）、`test/recording-workbench-ui.test.js`（扩展，本轮复跑 ✔）；`test/selection-native-build.test.js` 随原生件更新（未复跑） | 真实桌面矩阵：控制条/演示页/文本框/密码框/拼音组字/未知焦点间切换；允许组合只出现一次、排除场景计数 0、暂停段无事件；合成输入按设计被拒，须真机硬件键盘验证 |
| DEV-05 导出成片覆盖层 | `implemented` | `30ddf1d` | 导出请求新增源时间 `keystrokes` 轨；按保留片段投影到输出时间（剪掉的时间不出胶囊）；1100 ms 显示窗、500 条上限；MP4/WebM/GIF 与 demo canvas 路径覆盖 | `test/n03-recording-hud.test.js`（扩展，本轮复跑 ✔）、`test/recording-export.test.js`（扩展 +456 行，含真实 ffmpeg 用例；本轮未复跑，避免与宿主负载竞争） | 真实项目“预览 vs 导出”三处帧对照（开始前/出现/消失，边界误差最多一个输出帧）；尺寸/总时长/音画同步；硬件编码器下的输出 |
| DEV-06 OCR stdin 二进制帧 | `implemented`（协议双轨） | `b0c16bc` | `ready` 宣告能力 `protocol.stdin-frame-v1`；双方支持时用有界头 + PNG 字节，旧侧车/旧主程序继续走 `imagePath` 回退；二进制路径临时 PNG 写入数为 0；半帧/进程退出丢弃在途请求并重新握手 | `test/ocr-service.test.js`（扩展 +355 行，本轮未复跑）、`native/ocr` Rust 协议测试（未复跑；需 `cargo test --locked --manifest-path native/ocr/Cargo.toml`） | 真实 OCR 模型 + 真实中文 4K/小图/空图对比文本、框、耗时与峰值；三向兼容矩阵（旧主/新侧车、新主/旧侧车、新/新）；临时文件计数复测 |
| DEV-07 Everything 目标复用 | `implemented` | `9fcd5f7` | 在 `native/everything-search/src/main.rs` 共享同一已解析 IPC 目标与失效逻辑；只缓存目标身份，`dbLoaded` 等就绪信息每次重读；同一 HWND 未就绪→就绪可及时返回；重建并提交跟踪的 `HighlighterEverything.exe` | `test/f04-everything-performance.test.js`（扩展，本轮复跑 ✔）+ `native/everything-search` cargo 测试（未复跑） | 真实 Everything 1.4/1.5 下重启、超时与实例切换后恢复；配合 V07 的逐字输入/120 s 空闲测量 |
| DEV-08 贴图真实像素差分 | `implemented（已采用）` | `4c9ec45`（原型）、`0ccc397`（接线 + 实测探针） | 实测通过采用门禁后接入产品：`scripts/probe-pin-screen-diff.js` 在真实屏采上测得自身命中 0/30 帧、正面对照 0.9856、移动后 0/0.9872、叠加双贴图顶部 0/底部 0.9325、负坐标原点 0/0.9782、受控对齐差 0、帧 776,872 B；主进程 `startRealPixelCompare` 仅在显式开启时持有 `setContentProtection(true)`（停止/关闭/隐藏/崩溃时恢复），1 Hz 单飞采样，帧只在内存；`pin/pin-diff-view.js` 在渲染层显示差异掩码与比例；既有闪烁/洋葱皮仍为默认，菜单其余模式不变 | `test/n05-pin-screen-diff.test.js`（扩展）、`test/n05-pin-diff-view.test.js`（新增）、`test/pin-domain.test.js`、`test/pin-copy-once.test.js`（本轮 100/100 ✔）；测量记录 `docs/plans/2026-11-28-dev08-screen-diff-measurement.md` | 真机：开启比对时跨 DPI 拖动（1 Hz 滞后）、锁屏/睡眠/RDP 停止行为（pin 域无 powerMonitor 钩子，靠失败上限收尾）、10 分钟 CPU/GPU/耗电曲线、真实 `WDA_MONITOR` 宿主应降级为“无法比对”而非黑屏差异、一次第三方录屏人工核对；回退=移除菜单入口与停止调用，闪烁/差分模式独立 |
| DEV-09 API Key 迁移边界 | `decision`（维持现行策略） | `836ca51`（测试）、`b25fb22`（决策+验收台账） | 不改变备份内容：明文模块包与 `.hlbackup.zip`（加密/未加密）均不含 API Key；换机恢复后重新填写。决策记录与用户指引落点见链接 | `test/data-root-backup.test.js`、`test/n06-config-search-backup.test.js` 新增 6 个 DEV-09 用例（本轮复跑 70/70 ✔）；`npm run check:review-evidence` ✔ | 安装候选上的 V09 真机往返（加密归档→新根恢复→错误密码/篡改→Ctrl+K→水印）；本记录不改变其“真机未验”状态 |
| DEV-10 内嵌终端 Ctrl+C 回退 | `implemented`（保守拒绝） | `33fc2ee` | 有序分类：编译内名单 → 终端 UIA/类标记 → 焦点身份 → 编辑器宿主 Edit 允许名单，其余保守不注入；只记录控件类型与判定计数，不落标题/内容；普通编辑器保留 UIA/MSAA 读选区 | `test/u04-selection-lock.test.js`（扩展 +208 行，本轮复跑 ✔）、`test/selection-native-build.test.js`（+21 行，未复跑）、`test/selection-keyboard-combos.test.js` 的原生自测桥（本轮复跑 ✔） | **真实 VS Code/Cursor 集成终端矩阵（手动，未声称通过）**：编辑区/集成终端/分屏/焦点快切/独立终端；安全测试命令持续运行且自动 Ctrl+C 注入计数 0；识别不可靠的宿主登记兼容范围 |

## 2. E 工单状态

| 单号 | 状态 | 事实 | 剩余条件 |
|---|---|---|---|
| E01 计时失败归因 | `attribution complete / CI pending` | 归因**负载引起**（非测试、非产品）：低负载 3/3 通过、summary p95 41–45 ms；16 CPU hog 满载时 2/2 失败、summary p95 169.6/177.4 ms（复现交接记录的 110–180 ms），各视图 p50/p95 同步膨胀 2.2–3.7 倍；15 个真实测试文件并行仍通过，只有全量套件的进程/侧车叠加能复现。可重复门禁 `scripts/run-perf-gate.js`（串行跑 `usage-query` + `capture-first-paint`，保留原断言与预算，输出 `PERF_GATE_RESULT=<json>`）两次验证通过；`package.json` 增加 `test:perf`，CI 在 `Run tests` 之后增加串行 perf 步骤与 `perf-gate.json` artifact；`npm test` 仍按原预算执行同一用例一次 | 关闭条件剩“目标提交 CI 中查到实际结果”：分支推送后需用 `workflow_dispatch` 跑一次 `windows-ci` 并记录 perf gate 输出；已知 flake 复验：`clipboard-coordination` 独跑 2/2 通过，但 `test:coverage` 的 c8 并发全量 3/3 次在 `Lease round 1/42/2` 失败（同命令串行同阈值 exit 0），按 E01 “全量红、单跑绿”保留两份记录并归因到 CPU 过载；`capture-first-paint` 独跑 2/2（首帧样本 176.9–274.6 ms，门限 600 ms） |
| E02 架构/IPC/三语预算 | `closed（本轮集成全绿）` | 最终树 `npm run check` 全绿：语法 627 文件；`main.js` **1204 行 / 上限 1205**、最长行 **158/160**、domains 11；i18n **TOTAL 602/606**（新增可见文案全部进 `shared/locales/*` 三语，pin/capture/record 扫描区无新增中文）；评审证据门禁 2 登记表/50 工单/9 必需 P0 通过。**无新增 IPC 通道**：`main/services/ipc-security.js`、`IPC_SURFACES`、registrar 均未改动——DEV-01/02/08 复用 `pin:context-menu` 有界命令信封，DEV-04 的采集配置走既有 `record:workbench-start` 载荷，新增的主→渲染消息不需要发送方策略；`ipc-security`/`ipc-module-contracts`/`architecture-gate`/`i18n` 契约测试在全量中通过 | — |
| E03 原生构建 | `closed（本轮集成全绿）` | 以逐条构建替代 `npm run build:native` 包装（包装首步 `stop:app` 会关闭用户正在运行的已安装程序，本次拆开执行同一批脚本）：smart-select、ocr、everything、selection（node-gyp）、clipboard、device-battery、shutter-sound、focused-window 全部 exit 0；跟踪的 `native/everything-search/bin/HighlighterEverything.exe` 由 `9fcd5f7` 重建入库。build-id/原生回归：`test:clipboard:native` **176/176**、`test/selection-native-build.test.js` 通过；`cargo test --locked`：ocr **10/10**、everything **16/16**、clipboard exit 0（两个需桌面的用例按设计 ignored） | — |

## 3. 提交对照表

| 提交 | 单号 | 内容摘要 |
|---|---|---|
| `c2e6003` | —（计划） | 2026-11-28 后续开发/验收批次计划与工单编号 |
| `b0c16bc` | DEV-06 | OCR stdin 二进制帧协商 + `imagePath` 回退 |
| `9fcd5f7` | DEV-07 | Everything 目标复用；重建并提交跟踪的 exe |
| `33fc2ee` | DEV-04（原生通道）、DEV-10 | `key-combo` 原生通道 + 终端安全复制回退 |
| `b25fb22` | DEV-09（决策） | 凭据迁移边界决策记录 + 5.1.1 验收台账 |
| `836ca51` | DEV-09（测试） | 两种归档类型的凭据边界回归 |
| `30ddf1d` | DEV-05 | 导出成片快捷键胶囊覆盖层 |
| `f0f5333` | DEV-04（JS/接线） | 全局快捷键采集：隐私过滤、事件轨、workbench 开关 |
| `7f6133b` | DEV-01、DEV-02 | 贴图矢量重标注快照 + 当前视图离屏导出 |
| `4c9ec45` | DEV-08（实验） | 真实像素差分原型（未接线、未采用） |
| `be11fa8` | E01、DEV-03 | 串行 perf 门禁 + CI 步骤；截图/SmartSelect 基线测量记录（无产品改动） |
| `d204885` | 契约测试 | 跟随 DEV-01 的 `pinEditable` 遮罩分支与 DEV-04 的载荷键 |
| `36da1fe` | e2e | 诊断预览改用 id 定位，消除备份预览按钮造成的严格模式歧义（既有缺陷） |
| `0ccc397` | DEV-08（采用） | 真实像素比对接入产品（显式可选）+ 屏采排除实测探针与测量记录 |

## 4. 证据登记表的收录约束（为什么有两组文件在表外）

`scripts/check-review-evidence.js` 对每一行做两件事：所列测试文件必须存在，且文件内必须出现该行工单号
（`\bU02\b` / `\bN03\b` / `\bN05\b`）。因此本轮登记表只收录“文件内带工单号”的回归：

- N03 行收录 `test/n03-recording-hud.test.js`、`test/recording-export.test.js`（均含 N03）；
  DEV-04 的 `test/n03-global-keystrokes.test.js`、`test/selection-keyboard-combos.test.js`、
  `test/recording-workbench-ui.test.js` 文件内只标了 DEV-04，**未**在登记表列出（否则门禁红），证据见本记录。
- U02 行收录 `test/u02-longpin-ux.test.js`、`test/u02-pin-reedit.test.js`、`test/u02-pin-view-export.test.js`
  （均含 U02）；提交 `7f6133b` 同时扩展的 `test/pin-copy-once.test.js`、`test/capture-pin-copy.test.js`
  文件内未标 U02，只在本记录引用。
- N05 行收录 `test/n05-pin-onion-snapshot.test.js`、`test/n05-pin-screen-diff.test.js`（均含 N05）。

若后续要把表外文件纳入登记表，需要在代码/测试提交里给这些文件补工单号标注（docs-owner 本轮按
“不改代码”约束未动测试文件）。

## 5. 本轮验证记录（docs-owner，2026-11-28）

```powershell
# 指令要求的四个 DEV 回归文件
node --test test/u02-pin-reedit.test.js test/u02-pin-view-export.test.js test/n05-pin-screen-diff.test.js test/n03-global-keystrokes.test.js
# → tests 49 / pass 49 / fail 0 / skipped 0

# 追加的 DEV 相关回归（低成本、纯 Node/VM）
node --test test/pin-copy-once.test.js test/capture-pin-copy.test.js test/n03-recording-hud.test.js test/selection-keyboard-combos.test.js test/recording-workbench-ui.test.js test/u04-selection-lock.test.js test/pointer-track-service.test.js test/f04-everything-performance.test.js
# → tests 142 / pass 142 / fail 0 / skipped 0

# DEV-09 备份契约
node --test test/data-root-backup.test.js test/n06-config-search-backup.test.js
# → tests 70 / pass 70 / fail 0

npm run check:architecture   # → main.js 1204/1205 行，最长行 158/160，domains 11
npm run check:i18n           # → TOTAL 602 / 606
node scripts/check-review-evidence.js   # → 见更新后的登记表（U02/N03/N05 三行）
```

**未执行、不得据本记录冒充：** 完整 `npm test` / `npm run check`、`npm run test:e2e`、真实 Electron
探针、`npm run build:native` 全量、`cargo test`（everything/ocr/clipboard/selection 原生构建）、
`test/recording-export.test.js`（含真实 ffmpeg 用例）、`test/ocr-service.test.js`、`test/selection-native-build.test.js`
以及所有真机步骤。

## 5.1 集成复跑（root，2026-11-28，本机）

以下为 root 在全部 dev 提交完成后、对集成树执行的门禁结果（环境按 `AGENTS.md`：清 `ELECTRON_RUN_AS_NODE`、
`TMP/TEMP/HIGHLIGHTER_E2E_DATA_ROOT_BASE` 指向仓内 `.tmp-work`、直接探针注入 `--no-sandbox`）：

```powershell
npm run check                    # ✔ 语法 627；架构 main.js 1204/1205、158/160、domains 11；i18n 602/606；证据门禁 ✔
npm test                         # ✔ 3353 tests / 3353 pass / 0 fail（基线 3237 + 本批 116；含 DEV-08 采用后新增用例）
npm run test:coverage            # ◐ 阈值全绿、组合脚本受文档化 lease flake 影响：loaded 串行同参数 93.47% lines（≥85，exit 0）；native 95.11%（ocr-service 94.12 / long-capture-session 98.64，各 ≥60 逐文件）；critical 三服务 93.76%（各 ≥90 逐文件）。`npm run test:coverage` 的并发 loaded 步骤 3/3 次在 `clipboard-coordination` 的已知 `Lease round N`（轮次 1/42/2）上退出 1；该用例独跑 2/2 通过、同一命令串行同阈值通过，按 E01/AGENTS 记为“全量红、单跑绿”的负载归因并保留两份记录，未开缺陷单。
npm run test:e2e                 # ✔ 末轮 21/21 通过（2.5 min）；首轮唯一失败是既有定位器歧义（预览备份包 vs 预览诊断），按最小改动修定位器（36da1fe）后全绿
npm run test:long-capture        # ✔ long capture tests passed
npm run test:runtime             # ✔ tests 2 / pass 2
npm run test:perf                # ✔ 串行 perf 门禁 OK：usage summary p95=44.41ms（预算 100）、daily 70.4（150）、breakdown 127.96（300）；capture-first-paint 1304ms；PERF_GATE_RESULT ok=true（E01 交付物）
npm run check:version            # ✔ 5.1.1
npm run audit:dependencies       # ✔（npm 官方 registry）0 强豁免 / 0 未豁免
node scripts/probe-pin-screen-diff.js   # ✔ DEV-08 采用门禁 {adopt:true, reasons:[]}（30 帧自身命中 0，正面对照 0.986，叠加/负坐标/移动通过）
```

说明：
- `npm test` 首次全量有 3 个既存契约用例需要跟随本批行为（`capture-magnifier-ui` / `occlusion-recognition-wiring`
  的 `if (documentEditor || pinEditable)` 源码形状、`recording-audio-preflight-ui` 的冻结载荷新增
  `demoKeystrokes` 键），修正见 `d204885`，修正后全绿。
- `test:e2e` 的 1 个失败是**本批之前既有**的定位器歧义（系统设置页同时存在“预览备份包”与“预览”诊断按钮），
  与本批产品改动无关，按最小改动修定位器（`36da1fe`）后通过；末轮全量 21/21 通过。
- `test:coverage` 的 loaded 步骤在 c8 插桩 + 全量并发下会命中仓库已记录的 `clipboard-coordination` lease
  flake（本轮 3 次分别为 `Lease round 1/42/2`；该用例独跑 2/2 通过；同命令加 `--test-concurrency=1`
  以相同阈值跑完 exit 0、覆盖率数值一致）。原生实现里每轮 lease 的握手/收尾各有约 100 ms 预算
  （`vendor/selection-hook/src/windows/lib/transient.cc`），CPU 过载时单轮可超时；按 E01 的“全量红、
  单跑绿保留两份记录”处理，未改断言、未开缺陷单。
- `npm run build:native` 未按包装执行：其首步 `npm run stop:app` 会关闭用户正在运行的已安装程序；本次按
  `E03` 逐条执行同一批构建脚本，结果等价（全部 exit 0）。
- `verify:package` / `verify:release` 未执行：本地无目标 tag 的已签名候选产物与隔离安装会话（R01–R03 见 §6）。

## 6. 剩余真机 / 发布门槛

- **V01–V10 全部仍未验**：状态与逐项步骤见 [5.1.1 后续验收台账](2026-11-28-follow-up-acceptance-status.md) §1；
  V10 编码器/慢盘/混合 DPI 仍为 `blocked-missing-hardware`。本批 DEV 实现只把“代码与自动化回归”补齐，
  不改变台账里任何 V 项的状态。
- **R01–R03 仍为 `not-run`**：签名候选、干净安装/升级/卸载、硬件矩阵证据仍待发布负责人。
- **DEV-08 已是显式可选功能（不是默认行为）**：默认仍是闪烁/洋葱皮；真实像素比对只在用户于贴图菜单显式
  开启时运行，且会将该贴图从屏采/录屏中排除（菜单文案已披露）。剩余真机项见 DEV-08 行。
- **DEV-03 已按测量结论关闭为“试验未达采用门槛”**：预热与 SmartSelect 复用均不采用，产品保持按需创建。
- **E01 关闭条件只剩目标提交的 CI 实际结果**：归因（负载引起）与可重复门禁已提交；CI 步骤已加到
  `.github/workflows/windows-ci.yml`（`Run tests` 之后串行 perf + artifact）。推送分支并以 `workflow_dispatch`
  跑一次 `windows-ci` 后在 CI 运行记录中填结果即可关闭。
- **DEV-04/DEV-05/DEV-06/DEV-07/DEV-10 的真机门槛**（真实键盘矩阵、真实项目导出对照、真实 OCR 模型、
  真实 Everything 1.4/1.5、VS Code/Cursor 集成终端）必须人工执行并附日志/截图，不能由本记录的自动化结果替代。
