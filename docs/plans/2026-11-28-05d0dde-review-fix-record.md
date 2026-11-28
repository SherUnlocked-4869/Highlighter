# 05d0dde 再评审修复记录

2026-11-28 · Windows / Electron · 分支 `feat/review-optimization-2026-11-26`

**结论：再评审的 6 项发现（3 个 P1、3 个 P2）均已修复，另校正上一轮交付记录中一处超出代码保证的回执措辞。** 本记录对应再评审文档 [2026-11-28-05d0dde-fix-delivery-re-review.md](../reviews/2026-11-28-05d0dde-fix-delivery-re-review.md)，基线为 `05d0ddedbc59eaf1aab59d1f88b51bfd4c737366`。每个 P1/P2 都有新增或改写过的回归用例；其中 P1-01/P1-02、P2-01、P2-02 的失败路径与评审复现一致，P1-03 的 provider 失败通过原生自测桥（替代 provider 证据）注入，P2-03 的静默实例由可控侧车响应驱动。

自动化门禁与本轮独立探针结果见 §4；真机/候选包仍未验证的项目见 §5。

## 1. 再评审 6 项逐条结论

| 再评审项 | 级别 | 根因（一句话） | 修复位置 | 回归用例 | 残余 |
|---|---|---|---|---|---|
| P1-01 选框关闭后仍在建控制窗 | P1 | 授权在 `getDesktopSource()` 之前快照，异步返回后不再核对请求是否仍有效 | `main/domains/record/index.js`、`main/domains/capture/index.js` | `test/record-domain.test.js`（枚举期间取消 0 窗、替换 A→B 各自配置、加载期间取消拆窗、失效请求 fail-closed） | 候选包真实选框交互 |
| P1-02 选框超期后按旧偏好重开音频 | P1 | 5 分钟 TTL 只让配置失效，请求仍可确认；主进程回退到持久化偏好 | `main/domains/record/index.js` | `test/record-domain.test.js`（到期前后都保留本次两路关麦/音质/模式/快捷键） | 候选包真实长停留 |
| P1-03 UI Automation 模式查询失败仍可能放行 | P1 | `GetCurrentPatternAs` 失败与 S_OK+NULL“确认不支持”同为 present=false；焦点句柄读取失败与成功空句柄同为 sameWindow=true | `vendor/selection-hook/src/windows/core/keyboard_focus.{h,cc}`、`selection_hook.cc`（自测桥）、`scripts/probe-keyboard-focus-context.js` | `test/n03-focus-context-contract.test.js`（三态注入 + 组合键 accepted=false + 源码契约）、探针 26 项断言 | 真实 UIA provider 故障注入、硬件键盘矩阵 |
| P2-01 同 ID 换位后差分交付旧屏像素 | P2 | 枚举后只比较显示器数量/目标 ID，裁剪仍用旧 `physicalRect` | `pin/pin-screen-diff.js`、`main/domains/pin/index.js` | `test/n05-pin-screen-diff.test.js`（等数量/同 ID 换位、目标缩放变化：过渡帧 retryable 无像素，下一帧标记与裁剪正确） | 物理拔插/真机热插拔 |
| P2-02 竖排拉丁字母导出方向错误 | P2 | 导出逐字素直立绘制，未保留浏览器 `text-orientation: mixed` 的侧排方向 | `shared/ocr-text-overlay.js`、`pin/pin-view-export.js`、`scripts/probe-pin-view-export.js` | `test/u02-pin-renderer-runtime.test.js` 新增 phase D（真实窗口渲染 vs PNG，单 `I`/中英混排/中文/ZWJ emoji 的逐字素方向、位置、列序、IoU）、`test/u02-pin-view-export.test.js`、`test/u02-ocr-vertical-orientation.test.js` | 非拉丁横排文字的塑形残留、真机字体差异 |
| P2-03 Everything JS 入口仍把静默实例标为就绪 | P2 | 状态协议只回展示快照，丢弃本轮 `answered`；JS 两个入口都用 `running && dbLoaded` | `native/everything-search/src/main.rs`、`main/services/everything-service.js` | `test/everything-service.test.js`（静默且已加载→等待、不写就绪缓存→应答空索引后才查询）、`test/f04-everything-performance.test.js` | 真实 UIPI 静默实例（本机实例正常应答） |

## 2. P1 明细

### P1-01 · 区域选框已经关闭，等待中的任务仍能创建控制窗

- **根因**：`createRecordWindow()` 在调用 `getDesktopSource()` 之前就把 `requestId` 与一次性配置快照进局部变量；`closed` 回调只结算回执并清登记表。`getDesktopSource()` 的 await 返回后代码不再核对请求身份，继续用局部配置创建帧窗/控制窗，于是工作台已收到 `{ok:true, created:false}`，却出现一个带 `demoKeystrokes=true` 与 `quality=ultra` 的活动控制窗。用 `regionRequestId` 传入已撤销/无关 ID 时也会回退持久化偏好建窗。
- **修复**：
  - 新增 `liveRegionCapture(requestId)`：请求必须同时存在登记表与它自己的 `pendingRegionCapture` 槽；`revokeRegionCapture()` 幂等撤销。
  - `createRecordWindow()` 拆成带错误兜底的入口 + `createRecordWindowInternal()`：入口在异常时撤销请求（避免 waiting 的 `workbenchStart` 永远挂起）；内部在 **入口**、**`getDesktopSource()` 之后（创建任何窗口之前）**、**`loadFile()` 之后（显示窗口/给回执之前）** 三个点复核 `liveRegionCapture()`。任一处失效即 `return null`，不建窗；已创建的窗在显示前拆掉。
  - 传了非空 `regionRequestId` 但请求不是 live 时 fail-closed：不建窗、不回退持久化偏好；替换/取消路径由 `closed` 结算为取消。
  - 重复入口（已有活动控制窗）聚焦后把本次区域请求结算为取消，不再让它悬挂。
  - 捕获域 `startRegionRecording()` 返回 `created !== null`，并在覆盖窗关闭时照旧关闭。
- **回归（先失败后通过）**：`test/record-domain.test.js` 新增/改写：
  - 枚举期间取消 A：A 的回执 `created:false`，`createRecordWindow` 返回 `null`，帧窗/控制窗数量 0，任务不活动；
  - 枚举期间 A 被 B 替换：A 取消且 0 窗，B 用 B 自己的 `quality=high`/`audio on`/`demoKeystrokes=false` 建窗，A 的 `ultra`/两路关麦/快捷键授权不泄漏；
  - 控制窗加载期间取消：本次创建的两个窗都在 `show` 前销毁、`shown===0`、回执仍为取消；
  - 无关/失效 requestId：返回 `null` 且不建窗（旧实现在这两例里会建窗）。
- **残余**：候选包内真实选框的取消/替换/慢枚举交互（V 系列真机步骤）仍需按 §5 执行。

### P1-02 · 选框停留超过五分钟后按旧设置重开音频

- **根因**：`REGION_PENDING_TTL_MS = 5 * 60 * 1000` 只控制“一次性配置是否还可用”，不影响请求本身：超期后同一选框仍可确认，`pendingRegion=null` 让 `resolveCaptureConfig()` 回落到持久化偏好，于是本次明确关闭的系统音频/麦克风被上次值重新打开，`quality`/`mode`/`demoKeystrokes` 也变回旧值。
- **修复**：删除时间 TTL。`pendingRegionCapture` 与请求同生命周期，直到 `created:true` 或取消/替换才清除；配置解析只做“工作台本次值 > 持久化值 > 默认值”的既有优先级。P1-01 的异步边界复核保证失效请求不会误用槽。
- **回归**：`test/record-domain.test.js` 对同一请求分别在 0 ms 与 +301 秒（覆盖旧 TTL）确认，断言回执 `created:true`，控制窗的 `record:init.audio` 为 `{system:false, microphone:false, ...}`、`mode:'region'`、`quality:'ultra'`、`demoKeystrokes:true`；持久化偏好设为相反值（两路开、`standard`、`display`）以确保回退会立刻暴露。另有源码契约断言不再存在 `REGION_PENDING_TTL_MS`/`pendingRegionCapture.at`。
- **残余**：候选包内真实“停留 >5 分钟再确认”的手工步骤。

### P1-03 · UI Automation 模式查询失败时原生策略仍可能允许快捷键

- **根因**：`ReadElementEvidence()` 把 `GetCurrentPatternAs()` 的两种结果混为一谈：`FAILED(hr)` 与 `SUCCEEDED + nullptr`（“确认不支持该模式”）都只留下 `*PatternPresent=false`。焦点、控件类型、密码属性读取成功、控件又不是 Edit/Document/Text 时，这组字段进入 `safe_focus` 接受分支。`ProbeFocusedElement()` 同样把 `get_CurrentNativeWindowHandle()` 的 `FAILED` 与“成功返回空句柄”都当作 `sameWindow=true`。
- **修复**：
  - 证据结构新增 `valuePatternQueryFailed` / `textPatternQueryFailed` / `focusHandleReadFailed`；`KeyboardFocusEvidence` 与采集用 `ElementEvidence` 同步。
  - 采集端只在 `FAILED(hr)` 置失败位；`SUCCEEDED + nullptr` 仍是“已确认不支持”，只有这种否定回答可以进入 `safe_focus`；`get_CurrentNativeWindowHandle()` 分三态：成功非空→比较窗口归属，成功为空→按进程证据（网页内容残差），失败→不能证明归属。
  - 策略在敏感类拒绝之后、焦点身份/只读接受之前 fail-closed 为 `unknown`，稳定原因 `value_pattern_query_failed` / `text_pattern_query_failed` / `focus_handle_read_failed`；密码/可写文本等既有优先级不变。
  - 原生自测桥接受三个对象字段与三个 shorthand，并回显；`__testClassifyKeyboardCombo` 用同一解析/策略，组合键结果 `accepted:false, context:"unknown"`（等价于最终 IPC/事件轨增量为 0）。重建原生件后 build-id 与源码哈希一致。
- **回归**：`test/n03-focus-context-contract.test.js` 新增策略/组合键回归与源码契约（FAILED 分支才置位、S_OK+NULL 不置位、`sameWindow` 不再默认 true、失败位穿过 `ElementFromHandle` 回退）；`scripts/probe-keyboard-focus-context.js` 增加 6 条证据断言 + 3 条组合键断言，真实窗口正例（只读文档安全、普通按钮安全、密码/可写富文本拒绝）保留。原生件 build-id `hl_a6250ccb789dcc6ca55c2bfd2d6eb1092b33e88a0e2c6906e2d763671f8b3b00`。
- **残余（明确登记）**：没有给真实 UIA provider 注入失败 HRESULT；失败路径用原生自测桥（评审使用的同一“替代 provider 证据”接缝）与源码契约验证。真实硬件键盘矩阵（演示页/文本框/密码框/IME/未知焦点）仍属真机步骤。

## 3. P2 明细

### P2-01 · 显示器数量、ID 都没变，布局互换时差分仍交付旧屏像素

- **根因**：`captureScreenUnderPin()` 在 `getSources()` 之后只做 `checkDisplayTopology()`（数量 + 目标 ID 存在），并且始终用第一次计算的 `plan.physicalRect` 裁剪。两块同 ID 屏幕交换系统坐标时两项检查都通过，第一帧把旧 `physicalRect` 从新拓扑的源里裁出，交付了另一块屏幕的像素。
- **修复**：新增纯函数 `revalidateScreenCapturePlan(plan, displaysAfter)`：保留原 `plan` 的 `pinBounds/imageBounds/rotation/maxPixels` 输入，用枚举后的显示器列表重算同一贴图区域的完整映射，要求目标显示器 ID、缩放、旋转、DIP 矩形、物理裁剪矩形、缩略图尺寸全部不变；任一变化（或重算失败）返回可重试拒绝，不交付像素。`plan` 成功结果新增 `pinBounds/imageBounds/maxPixels` 供重算；`normalizeDisplays()` 保留 `rotation` 参与判定。产品路径在既有 topology 检查之后调用它，返回 `TOPOLOGY_CHANGED` 且 `retryable:true`，下一 tick 按当前拓扑重新 plan。
- **回归**：`test/n05-pin-screen-diff.test.js` 新增单元用例（同 ID 换位、目标缩放、显示旋转、目标消失分别拒绝）与两个产品用例：
  - 两块 1920×1080、ID 1/2 在 `getSources()` 期间互换坐标：第一帧 `ok:false, code:'TOPOLOGY_CHANGED', retryable:true, pixels:undefined`，不发帧；下一帧 plan 到换位后位于贴图下方的显示器 2，标记 22、裁剪 400×200；
  - 目标屏缩放 1→2：过渡帧拒绝，下一帧裁剪 800×400、标记来自目标源。
- **残余**：物理拔插/真机热插拔与候选包内的屏幕差分探针。

### P2-02 · 竖排译文中的拉丁字母在 PNG 里转错了方向

- **根因**：pin.css 的竖排块用浏览器默认 `text-orientation: mixed`：竖排文字直立，横排文字（拉丁字母/数字等）整段侧排（顺时针 90°）。测量层只记录了每个字素的中心和盒子，导出层却逐字素直立 `fillText`，于是屏幕上宽扁的侧排 `I`（125% 下墨迹 21.6×2.4 CSS px）在 PNG 里变成窄高的直立 `I`（2.4×21.6）。
- **修复**：
  - 测量层（`shared/ocr-text-overlay.js`）内置 Unicode UAX #50 `Vertical_Orientation` 的直立区间表（默认 Rotated；`U`/`Tu` 直立，`Tr` 按旋转处理），按字素首码点判定 `sideways` 并写入测量载荷；只影响竖排块。
  - 导出层（`pin/pin-view-export.js`）对 `sideways` 字素在测量中心处旋转 90°（顺时针）绘制，并用 `measureText().actualBoundingBox*` 把墨迹居中到测量盒中心（消除旋转后约 3 CSS px 的横向偏差）；直立字素保持原绘制。另对“浏览器在竖排下无法竖直合字、把 ZWJ emoji 序列按槽位堆叠”的情况，按测量推进高度把序列拆成有序槽位绘制（`verticalUprightParts()`），让 ZWJ emoji 的堆叠与屏幕一致而不是塌缩成一行。
  - `scripts/probe-pin-view-export.js` 新增 phase D：隐藏窗口先显示在屏幕外（`showInactive` + 负坐标，不打扰用户/不抢焦点）再 `capturePage`，把真实渲染与“导出当前视图”的 PNG 在同一 125% 缩放下逐字素比较 bounds/中心/IoU。现有 A/B/C phase 在该缩放下继续通过。
- **回归**：`test/u02-pin-renderer-runtime.test.js` 的 phase D 断言（125% 下）：
  - 单 `I`：屏幕墨迹 21.6×2.4、导出 21.6×3.2 CSS px，两者都是“宽>>高”，中心偏差 <1 px、IoU≈0.70；
  - `中A文`：测量方向标记为 `[false,true,false]`，`A` 在导出中同为宽扁方向（21.6×20 vs 屏幕 21.6×19.2），中/文直立且列序一致；
  - 纯中文四字：逐字直立、同列、屏幕/导出中心一致；
  - ZWJ emoji：导出复现竖向堆叠（28.8×67.2 vs 屏幕 28.8×67.2，IoU≈0.82）。
  `test/u02-pin-view-export.test.js` 新增 plan 透传、旋转绘制顺序、ZWJ 槽位拆分单元用例；`test/u02-ocr-vertical-orientation.test.js` 单独钉住 UAX #50 分类（拉丁/数字/标点侧排；CJK/假名/谚文/全角/emoji/中文标点直立；组合簇按基字判定）与源码契约。
- **残余**：表数据来自 Unicode 18.0.0；Chromium 内置 ICU 版本略旧时极新码点可能有出入（已用真实渲染覆盖常见脚本）。非拉丁横排文字的侧排塑形按“逐字素旋转 + 浏览器实测中心”实现，不重建整段连字。

### P2-03 · Everything 的 Rust 等待接口已修复，JavaScript 正式入口仍可跳过查询应答检查

- **根因**：Rust 的 `status` 动作只回 `status_snapshot()` 展示快照（保留静默实例的 `running:true, dbLoaded:true`），丢弃 `status_sample()` 的本轮 `answered`；JS 的 `refreshStatus()` 与 `ensureReadyInternal()` 都按 `running && dbLoaded` 判就绪，于是查询静默但索引已加载的实例被标成 `ready` 并写入 2 秒就绪缓存，后续搜索直接发查询。`waitReady()` 也只看侧车的 `ready`，不核对状态。
- **修复**：
  - Rust 在协议边界新增 `protocol_status(snapshot, answered)`：只在此处插入 `queryAnswered`，`status` 动作与 `wait-ready` 内嵌的 `status` 对象都带该字段；展示快照 `status_snapshot()` 仍是轮次无关字段。新增 3 个 Rust 单测（静默已加载 → `queryAnswered:false` 且不 ready；应答空索引 → `queryAnswered:true` 且可 ready；`wait-ready` 内嵌状态携带本轮应答）。
  - JS 新增单一就绪条件 `snapshotIsReady(snapshot) = running===true && dbLoaded===true && queryAnswered===true`（缺字段 fail-closed），供 `refreshStatus()`、`ensureReadyInternal()`（含 2 秒缓存复核）、`waitReady()` 与 `query()` 发送前的再次断言共用；`applySidecarStatus()` 把 `queryAnswered` 写入发布状态，状态页/搜索页只看同一 `phase`。
  - 空索引的有效应答（`probeTotal:0` 且 `queryAnswered:true`）可以就绪；静默实例进入 `waiting`、不写 `lastReadyAt`，落到 `wait-ready` 等 Rust 重新选择能应答的实例。
  - Everything 侧车 exe 已重建并入库（大小 367,616 B；SHA-256 由 `EC45CDD…` 变为 `A51CFC2…`），真机协议冒烟：`status`/`wait-ready` 均返回 `queryAnswered:true`（本机 Everything 1.4.1.1032 应答）。
- **回归**：`test/everything-service.test.js` 新增共享谓词 fail-closed、无标志的 `wait-ready` fail-closed、以及再评审原场景（静默且已加载 → `refreshStatus` 为 `waiting`、`lastReadyAt` 未写、`ensureReady` 不 ready 且不发 query；切换为应答且 0 条 → `query()` 成功、真的发出 query、之后才写就绪缓存）。`test/f04-everything-performance.test.js` 增加协议字段与源码断言；相关 fixture 全部补 `queryAnswered`。cargo 26/26。
- **残余**：本机 Everything 实例正常应答，真实 UIPI/静默实例未复现；静默分支由 Rust 单测与可控 fake sidecar 驱动，真机双实例（1.4/1.5）仍属候选包验收。

## 4. 工作台回执措辞校正

再评审指出上一轮交付记录的表述超出了代码保证。实际情况：

- 区域流程成功：`{ok:true, created:true}`；取消/替换：`{ok:true, created:false}`；
- 显示器/窗口模式仍沿用旧的 `{ok:true}`（没有 `created` 字段）；
- 页面判定 `recordingStartCreatedRecording()` 只在 `ok:false`、`focused:true`、`created:false` 三种显式否定时保留选择，其他返回值（含空值）都视为已启动并消费一次性开关。

因此“页面只在显式收到 created:true 时消费”是不成立的。已更正：
- [上一轮修复记录的发现 1](2026-11-28-d7923ac-review-fix-record.md) 改为按上述真实语义描述；
- `config/routes/recording.js` 的 `recordingStartCreatedRecording()` 注释写明该谓词的准确保证与为什么不能改成“必须 created:true”；
- `test/recording-workbench-ui.test.js` 的对应注释同步校正（测试行为未变：显示器/窗口成功仍消费，区域取消/只聚焦保留）。

## 5. 验证范围与证据归属

环境按仓库 `AGENTS.md`：清 `ELECTRON_RUN_AS_NODE`；`TMP/TEMP/HIGHLIGHTER_E2E_DATA_ROOT_BASE` 指向仓内 `.tmp-test`；直接拉 Electron 的探针用 `.tmp-work/hook/no-sandbox.js` 把 `--no-sandbox` 放到脚本路径前；E2E 用 `HIGHLIGHTER_E2E_NO_SANDBOX=1`。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `npm run check` | ok（635 个 JS 文件；architecture ok，main.js 1204/1205；i18n 602/606；证据表 2 注册表 50 单 9 P0） |
| 全量测试 | `npm test` | **3448/3448 通过，0 失败 0 跳过**。首跑曾命中 `AGENTS.md` 已记录的 clipboard lease 计时 flake（`Lease round 95`）；按该约定先单跑 `test/clipboard-coordination.test.js` 4/4 两次通过，再复跑全量即为上述绿色结果 |
| 渲染层 E2E | `npm run test:e2e` | **21/21 通过**（2.7 min） |
| 长图 | `npm run test:long-capture` | 通过 |
| 覆盖率（loaded） | `npm run test:coverage:loaded` | 行/语句 **93.51%**（门限 85%），分支 78.88%，函数 90.31% |
| 覆盖率（native） | `npm run test:coverage:native` | ocr-service 行 96%（门限 60%），long-capture-session 98.64% |
| 覆盖率（critical） | `npm run test:coverage:critical` | 行/语句 93.76%（门限 90%） |
| 版本 | `npm run check:version` | 5.1.1 一致 |
| Everything 原生 | `cargo test --locked --manifest-path native/everything-search/Cargo.toml`；`npm run build:everything` | **26/26**（含 3 个新增 P2-03 单测）；exe 重建入库 |
| 选择钩子原生 | `npm run build:selection`；`node vendor/selection-hook/scripts/source-build-id.js` | build-id `hl_a6250cc…`，`test/selection-native-build.test.js` 通过 |

真实进程探针（本机复跑）：

| 探针 | 结果 |
|---|---|
| `scripts/probe-pin-view-export.js`（隐藏窗口 + 强制 125% 缩放，A/B/C/D 全部 phase） | 退出码 0，`report.ok=true`、`devicePixelRatio=1.25`：A 长图滚动带全绿、B 真差分“无差异”、C OCR 垂直/换行布局通过；D 四例全部导出成功——`I` 屏幕 21.6×2.4 / 导出 21.6×3.2、`中A文` 方向标记 `[false,true,false]` 且 `A` 导出宽扁、中文同列、ZWJ emoji 28.8×67.2 双向一致（IoU 0.70/0.70/0.81） |
| `scripts/probe-keyboard-focus-context.js` | 退出码 0，**23 PASS / 0 FAIL**、1 条已记录 provider 相关残留；新增 6 条证据 + 3 条组合键断言全过；真实窗口正例（只读文档/普通按钮 safe，密码/可写富文本拒绝）保留 |
| `scripts/probe-pin-screen-diff.js --frames 3` | 退出码 0；6 个 verdict 全 true（`screenCaptureWorks` / `exclusionProven` / `alignmentProven` / `stackedPinsProven` / `negativeCoordinatesProven` / `productionEntryProven`），`adopt:true` |
| Everything 真机协议冒烟 | 重建 exe 对真实 Everything 1.4.1.1032：`status`/`wait-ready` 均带 `queryAnswered:true`，`shutdown` 正常 |

## 6. 仍需真实设备 / 候选包验证

- V/R 系列、硬件键盘矩阵、真实模型断管、物理拔插/热插拔、Everything 1.4/1.5 双实例、签名安装升级：仍按候选验收清单执行，本轮未伪造通过。
- P1-03 的真实 UIA provider 故障注入与 P2-03 的真实静默/UIPI 实例：本机条件不具备，分别以原生自测桥（替代 provider 证据）和可控侧车响应覆盖，并在 §2/§3 明示。
- P2-02 的竖排侧排塑形对非拉丁横排文字只做逐字素旋转；真机字体差异与更复杂混排保留为已知残余。

## 7. 提交边界

与上一轮一致，交付拆成两个提交：

- `09d79ba fix(review): close the six 05d0dde re-review findings`：代码、测试、探针、Everything 侧车 exe 与选择钩子源码（选择钩子 `.node` 为 gitignore 的本地构建件，测试用 rebuild 后的本机构建）；
- 紧随其后的 `docs(evidence): record the 05d0dde re-review fix and correct the receipt wording` 提交：本记录、评审方原样入库的再评审文档 `docs/reviews/2026-11-28-05d0dde-fix-delivery-re-review.md`，以及上一轮修复记录中 §4 所述的措辞更正。

未推送远端。提交边界按“让下一轮评审能直接对 HEAD 复核”拆分，代码与证据可分别追溯。
