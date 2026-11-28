# d4993a2 交付评审修复记录

2026-11-28 · Windows / Electron 43.8.3 · 分支 `feat/review-optimization-2026-11-26`

**结论：交付评审的 2 个 P1 与 3 个 P2 均已修复。** 本记录对应评审文档 [2026-11-28-d4993a2-fix-delivery-review.md](../reviews/2026-11-28-d4993a2-fix-delivery-review.md)，基线为 `d4993a292e07b04139113d7b3c9c871fb6474469`。每项都有新增的“先失败、后通过”回归用例；两个 P1 的评审附录复跑脚本在适配夹具后的等价行为见 §2.5，原始脚本在修复后仍会失败的一行是夹具自身的复用了同一拒绝的 `loadFile` promise（见 §2.1 末注）。

全量门禁、探针与覆盖率证据见 §4；仍需真机/候选包验证的项目见 §5。本文编号 `P1-01`…`P2-03` 沿用前几轮修复记录的序号，依次对应评审发现的 1、2、3、4、5 项。

## 1. 五项逐条结论

| 评审项 | 级别 | 根因（一句话） | 修复位置 | 回归用例 | 残余 |
|---|---|---|---|---|---|
| P1-01 取消后加载失败的控制窗仍能开录 | P1 | 帧/控制窗在 `loadFile()` 之前就发布为模块级 `recordWindow`；加载拒绝只撤销请求登记，不拆窗、不清所有权 | `main/domains/record/index.js` | `test/record-domain.test.js`（帧页拒绝/控制页拒绝/加载中取消后立即重试/加载中窗口被关：均 0 活动 take、旧窗不能 `startSession`、下一次录制只拿自己的配置） | 候选包真实选框交互 |
| P1-02 并发入口夺走已开录窗口的写路由 | P1 | 创建流程在 `getDesktopSource()` 恢复后不核对“当前 take 所有者”，直接覆盖 `recordWindow`；同一请求可重入并各自建窗/互相撤销 | `main/domains/record/index.js` | `test/record-domain.test.js`（全屏先发布后追加第 2 块并收尾；区域先发布后聚焦不被替换；同请求第二次确认共享同一创建与同一回执） | 候选包内真实快捷键/选框竞态 |
| P2-01 贴图移动/缩小后仍交付旧区域像素 | P2 | 会话开始只快照一次内容矩形；`getSources()` 后只复核显示器列表/映射，不复核窗口本身；`revalidateScreenCapturePlan` 只用计划时输入 | `main/domains/pin/index.js`、`pin/pin-screen-diff.js` | `test/n05-pin-screen-diff.test.js`（枚举期跨屏移动：过渡帧无像素、下一帧标记 22；缩窗后连续两帧 100×80；revalidate 移动/缩放拒绝） | 物理拖动/热插拔 |
| P2-02 竖排 `。`、`、` 与侧排 `g` 导出墨迹错位 | P2 | 导出直立分支用横排 Canvas `fillText`，丢浏览器竖排字形/标点位置；侧排分支逐字按自身墨迹居中，丢整段基线 | `pin/pin-view-export.js`、`shared/ocr-text-overlay.js` | `scripts/probe-pin-view-export.js` phase D 新增 `。`/`、`/`g` 样本；`test/u02-pin-renderer-runtime.test.js` 真实 Electron 墨迹 IoU/质心断言；`test/u02-pin-view-export.test.js` 单测 | 真机字体差异 |
| P2-03 侧车存活时状态页超过间隔仍复用旧状态 | P2 | `refreshStatus()` 把 `sidecarActive` 当作可复用旧快照的充分条件，与 5 秒节流并列 | `main/services/everything-service.js` | `test/everything-service.test.js`（就绪→静默 6.1s/12.2s 各刷新一次均更新且各只加一次 `status`；静默→就绪更新；5 秒内仍节流；不 spawn 内置 Everything） | 真实 UIPI/静默实例 |

## 2. P1 明细

### P1-01 · 已撤销请求的帧页加载失败后，控制窗仍可启动项目

- **根因**：`createRecordWindowInternal()` 在 `frameWindow.loadFile()` / `controlWindow.loadFile()` 之前就把两扇窗赋给模块级 `recordWindow`/`recordFrameWindow` 并注册 display-media handler。`Promise.all([...loadFile()])` 拒绝时，外层 catch 只 `revokeRegionCapture()` 撤销请求登记，既不关窗也不清所有权；`isTaskActive()`/`focusActive()`/`requireRecordSender()` 只看这两个模块级变量，于是工作台已收到 `{ok:true,created:false}`，旧区域控制窗仍被当成活动窗口：下一次“明确关麦、关快捷键”的全屏请求只聚焦它，对它调用 `startSession()` 还能创建带原请求 `demoKeystrokes:true`、`audio.microphone:true` 授权的项目。
- **修复**（`main/domains/record/index.js`）：
  - **创建事务化**：窗口创建后先放入 `stagedCreations`（hidden、未发布），`recordWindow`/`recordFrameWindow`/`isTaskActive()`/`requireRecordSender()` 在整个加载期间都看不到它们；只有 `publishStagedCreation()` 在“两页都加载成功 + 请求仍 live + 当前没有存活的 take”三个条件同时成立时，才同步提升为活动窗口。
  - **失败/取消清理**：`disposeStagedCreation()` 关闭本次创建的帧窗、控制窗，并且只在本次创建仍拥有共享 session 的 display-media handler 时注销它（新增 `displayMediaHandlerOwner`，防止输家清掉赢家的 handler）。加载用 `Promise.allSettled` 等两页都结算后再拆窗，避免另一半 load 的未处理拒绝。
  - **撤销即时拆窗**：`settleRegionCaptureRequest(id, false)`（取消/替换/关闭/退出）先 `cancelStagedCreationsForRequest(id)` 再结算回执，因此“加载悬停时取消”无需等 `loadFile()` 结算就已经释放两扇窗。
  - **提前关窗**：`closed` 回调在 staged 阶段把创建标记为 `closedEarly` 并走同一清理；已发布阶段才执行原有 session/项目/媒体句柄清理。
  - **init 推送**：控制窗的 `record:ready` IPC 在未发布时会被 `authorizeIpcRole`（`ownsControlWindow === true`）拦下，所以发布路径主动 `sendRecordInitOnce()` 推送 `record:init`，并向帧窗推送初始 annotation 命令；`ready` 处理器用同一幂等函数修复“ready 在发布之后才被处理”的竞态。
  - **发布会话兜底**：发布后的 show/init 若抛错，`teardownPublishedCreation()` 先清所有权再拆窗，不会留下“半活动”的 take。
- **回归**（`test/record-domain.test.js`，4 个新用例，基线 d4993a2 全部失败）：
  - 帧页拒绝：两窗销毁、`shown===0`、`isTaskActive()===false`、旧控制窗 `startSession` 抛“无效的录制窗口”、下一次显式关麦/关快捷键的 display 录制拿到自己的配置并成功追加第 1 块；
  - 控制页拒绝：同上（回执 `created:false`）；
  - 加载悬停时取消后**立即**重试：取消时两窗已销毁（不等 load 结算），重试 take 显示并持有所有权，旧 load 之后结算也不会清掉新 take；
  - 加载中控制窗自行关闭：创建返回 `null`、回执取消、无活动 take。
- **评审复跑脚本注**：评审附录脚本的 `loadFile` 夹具对**所有** `frame.html` 返回同一个已被 reject 的 promise；修复后“下一次录制”会真正创建新帧窗并再次加载它，因此该脚本原样运行会打印 `start-failed`（夹具副作用），而不是旧实现里“聚焦旧窗”的假成功。§2.5 给出只对第一次 frame 加载注入失败的等价脚本，修复后输出见该节。

### P1-02 · 并发入口让已开录窗口无法继续写入，同一请求还可重入

- **根因**：
  - (a) 只有同步入口检查 `recordWindow`。区域请求 A 在 `await getDesktopSource()` 期间，全屏入口 B 完成创建并 `startSession()`、追加第 1 块；A 恢复后不核对当前所有者，直接覆盖 `recordWindow`，B 的第二块被 `requireRecordSender()` 判为“无效的录制窗口”，两套窗口（4 扇）并存。
  - (b) 同一区域请求的第二次确认会走同步入口的 `focusActive()` 分支：它聚焦尚未加载完的控制窗并把**自己的请求**结算为取消；随后第一次创建在 load 结束后发现请求已取消，拆掉两窗返回 `null`，第二次调用拿到窗口但工作台回执是 `created:false`，最终两扇窗都被关闭。
- **修复**（同一处 `createRecordWindow` 入口）：
  - **同请求复用进行中的创建**：`regionCreations`（requestId → promise）在创建的第一个 await 之前同步登记；第二次确认直接返回同一个 promise，不建第二套窗、不撤销请求，两个调用者拿到同一个控制窗与同一次 `created:true` 回执。创建结束后（无论成败）清理登记。
  - **先发布者获胜（修正后为“存活 take 优先”）**：`publishStagedCreation()` 的发布检查同步执行，唯一阻止发布的归属条件是 `recordWindow` 仍存活；已发布并已关闭的竞态 take 不再阻塞本创建（独立复核发现的 S6 边缘，见下）。两个进行中的入口不会同时成为活动 take：先发布者占住 `recordWindow`，后到者在发布点或下一异步边界聚焦/取消；已关闭的 take 已不拥有写路由，慢创建可以正常发布。
  - **最后异步边界复核**：`getDesktopSource()` 返回后、建窗之前再次检查请求 live 与当前活动窗口；发布检查前再同步复核一次，避免把“开始创建时刻”与“发布时刻”之间的窗口归属变化漏掉。
  - **handler 所有权**：display-media handler 改为发布时才安装（`installDisplayMediaHandler()`），关闭时仅当 `displayMediaHandlerOwner` 仍是该控制窗才注销，避免并发创建互相覆盖/清空共享 session 的 handler。
- **回归**（`test/record-domain.test.js`，基线 d4993a2 全部失败）：
  - 全屏 B 在 A 的枚举期间发布：B 第 1 块 `committedBytes:3/sequence:1`，A 恢复后 A 创建返回 `null`、回执 `created:false`、窗口总数仍为 2、B 第 2 块 `committedBytes:6/sequence:2`、`finishSession()` 成功；
  - A 先发布：后恢复的 B 返回 A 的控制窗、A 被 focus、窗口数仍为 2；
  - 同一请求第二次确认：返回同一控制窗、只建 2 扇窗、回执只有一次 `created:true`、take 可正常 `startSession`/`appendChunk`。
  - **独立复核 S6 边缘（本轮修正 + 新回归）**：早期实现用 take epoch 判负——若竞态 B 先发布、开始录制后又关闭，A 恢复时会因 epoch 已变被静默丢弃（0 窗、`created:false`）。发布规则已改为只拦“存活 take”，新增用例“racing take that already closed does not strand the slower region creation”：B 发布→写第 1 块→关闭后 A 恢复仍能发布自己的 take（`created:true`、配置保留、可正常建 session 追加 chunk）。
- **仲裁语义（明示）**：同步阶段先检查活动 take（有则聚焦/取消本次区域请求）；同一 `regionRequestId` 复用进行中的创建；不同入口在“尚无活动 take”时可并行创建，但**只有第一个发布者成为活动 take**，其余在发布检查或下一异步边界退让；已关闭的 take 不阻止后续创建发布。这样既不会中断已经开始写入的窗口，也不会出现两套活动窗口，且不会把已确认的慢请求静默丢掉。

### 2.5 两个 P1 的修复后复跑

**评审附录脚本原样运行**（一个脚本，两个场景）修复后的三行为：

```
rollback { ok: true, created: false } { ok: false, code: 'start-failed' } false
before { committedBytes: 3, sequence: 1, lastChunkSequence: 1 }
after { committedBytes: 6, sequence: 2, lastChunkSequence: 2 }
```

- `before`/`after` 两行直接证明 P1-02 的修复：已开录的全屏窗口不再被恢复的区域请求夺权，第二块继续提交（旧实现是 `无效的录制窗口`），区域回执为 `created:false`、窗口数收敛为一套。
- 第一行里 `start-failed` 是**夹具副作用**，不是回归：该脚本的 `loadFile` 对**所有** `frame.html` 返回同一个已被 reject 的 promise，修复后“下一次显式关麦/关快捷键的录制”会真正创建自己的帧窗并再次加载它，于是加载到同一个已拒绝的 promise；旧实现这一行之所以是 `focused:true`，恰恰因为它没有创建新窗口而是聚焦了本应被拆掉的旧窗（P1-01 缺陷本体）。

**等价修正脚本**（只让第一次 `frame.html` 加载失败，其余正常；在仓库根目录 Node 24 下运行）修复后的输出：

```
creation -> null | old windows destroyed: [ true, true ] | active: false
rollback {"ok":true,"created":false} {"ok":true} active: true cfg: {"keystrokes":false,"mic":false,"shown":true}
old startSession -> 无效的录制窗口
new session {"id":"session-1","projectId":"project-1"} chunk {"committedBytes":3,"sequence":1,"lastChunkSequence":1}
```

即：帧页加载失败后旧 create 返回 `null`、两扇旧窗销毁、任务不活动；下一次录制 `{ok:true}`、显示并成为唯一活动窗口、配置是它自己的“两路关闭 + 快捷键关闭”；旧控制窗调用 `startSession()` 被 `requireRecordSender()` 拒绝；新 take 正常建项目并追加第 1 块。

## 3. P2 明细

### P2-01 · 采集时移动贴图会交付旧屏像素，缩小贴图后持续采集旧尺寸

- **根因**：`startRealPixelCompare()` 在会话开始时读一次 `win.getContentBounds()` 存入 `session.imageBounds`，之后每个采样 tick 都用这个陈旧尺寸规划（缩窗后仍交付 400×200）；`captureScreenUnderPin()` 用 `win.getBounds()` 规划后 `await getSources()`，返回后只复核显示器数量/ID/映射（`checkDisplayTopology` + `revalidateScreenCapturePlan(plan, displaysAfter)`），没有重读窗口矩形，枚举期间跨屏移动后首帧仍按旧位置裁剪并交付旧屏像素（标记 11），下一 tick 才得到标记 22。
- **修复**：
  - `main/domains/pin/index.js`：新增 `readPinContentBounds()`；`startRealPixelCompare()` 只保留调用方显式传入的相对偏移（`session.imageOffset`），**不再快照尺寸**；每次采样 tick 读取当前内容矩形构造 `imageBounds`。`captureScreenUnderPin()` 在 `getSources()` 返回后重读窗口与内容矩形，把 post-await 事实传给 revalidate；窗口矩形或内容框任一变化 → `retryable:true` 过渡帧，不交付像素、不发送 `pin:screen-diff-frame`，下一 tick 用当前几何重新规划。1 Hz/单飞/失败上限语义与 P2-01/P2-5 拓扑检查均未放宽。
  - `pin/pin-screen-diff.js`：`revalidateScreenCapturePlan(plan, displaysAfter, currentInputs = null)` 新增可选 post-await 输入（`pinBounds`/`imageBounds`/`rotation`），先比对窗口/内容几何，再在 post-await 显示器列表上重算并比较 display 身份、scale、display rotation、`dipRect`、`physicalRect`、`thumbnail`；省略 `currentInputs` 时行为与 P2-01 完全一致。
- **回归**（`test/n05-pin-screen-diff.test.js`，+4 用例；先失败后通过，fail-before 为 3 个新用例失败）：
  - 枚举期间把贴图从 x=100 移到另一屏 x=2020：首帧 `ok:false, retryable:true, code:'TOPOLOGY_CHANGED'`、无 `pin:screen-diff-frame`；下一帧 400×200、`dipRect.x=2020`、像素标记 22；
  - 会话中把内容窗 400×200 缩到 100×80：之后连续两帧都只交付 100×80（像素长度 32000、`dipRect {x:100,y:50,width:100,height:80}`）；
  - 显式 image offset 保持相对语义并随当前内容尺寸缩放；
  - `revalidateScreenCapturePlan` 对移动/缩放/内容框变化/无效矩形拒绝，未变窗口通过，显示侧变化仍为 `TOPOLOGY_CHANGED`。
- **真实探针**：`scripts/probe-pin-screen-diff.js --frames 3` 在副屏实跑，六项判定全 true（`screenCaptureWorks / exclusionProven / alignmentProven / stackedPinsProven / negativeCoordinatesProven / productionEntryProven`），`productionEntry` 首帧成功、交付 2 帧、`protectionRestored:true`。
- **残余**：枚举期间的移动/缩放由确定性 node 夹具覆盖（Electron 探针中的窗口是静止的）；物理拖动/拔插竞态仍属真机验收。

### P2-02 · 竖排标点与侧排基线导出错位

- **根因**：
  - 直立分支：`pin/pin-view-export.js::drawOcrBlock` 对 measured 竖排块的直立 grapheme 直接用横排 Canvas `fillText`（`textAlign:center`/`textBaseline:middle`）。浏览器在 vertical-rl 中对 UAX #50 的 **Tu（Transformed Upright）** 字符会启用 OpenType `vert`，换成竖排变体字形并放到字体垂直度量决定的位置；Canvas 2D 没有竖排布局。实测屏幕竖排 `。` 的墨迹在 em 单元中心右侧约 +8 CSS px，横排 canvas `。` 的墨迹在中心左下 (−9.1,+7.1)，与评审的 13.36/4.99 同量级，IoU=0。
  - 侧排分支：旧代码对每个 sideways grapheme 用自身 `measureText` 墨迹居中（`inkOffset=(descent-ascent)/2`）。对 `I`/`A` 近似正确，但对带下伸部的 `g` 等于把含 descender 的墨迹质心摆到 box 中心，破坏同一侧排段的共享字母基线：导出右偏 6.5 CSS px（评审 6.4），IoU 0.257。
- **方案选择**：先实测验证 SVG `<foreignObject>` data URL 光栅（复用浏览器竖排渲染）——CSP 允许 `data:`、canvas 未被 taint、能复现竖排标点位置；但 (1) SVG-as-image 的字体解析与页面不同，ZWJ emoji 堆叠间距复现失败（屏幕墨迹高 67.2 CSS px vs 光栅 50.4），会破坏既有 emoji 正例；(2) 图像解码本质异步，而导出管线 `drawViewExport` → `canvas.toBlob()` 是同步的，采纳必须改 `pin/pin.js`（超出本项写范围）；(3) 仍有约 1.2 px 像素相位差与额外解码/内存成本。因此采用保守替代：全部在既有同步管线内，用可测量事实推导。
- **修复**：
  - `shared/ocr-text-overlay.js`：新增 Unicode 竖排变体兼容映射 `VERTICAL_FORM_PAIRS`（1:1 `<vertical>`，仅收 9 个经真机验证“墨迹在 em cell 内居中”的标点：`、`→`︑`、`。`→`︒`、`，`→`︐`、`！`→`︕`、`（`→`︵`、`）`→`︶`、`：`→`︓`、`；`→`︔`、`？`→`︖`），`verticalFormFor()` 只对单码点 cluster 生效；`verticalTextIsSideways()` 不再把 Tu 字符判为 sideways；measured glyph 载荷新增 `verticalForm`。角括号/引号括号（浏览器锚定 cell 端部而非墨迹居中）不纳入，保持原旋转绘制。
  - `pin/pin-view-export.js`：plan 透传 `verticalForm`；侧排分支改为“整段共享字母基线”——Range box 跨列宽度正好是 `fontBoundingBoxAscent+Descent`（字体盒），因此在旋转 frame 中把 alphabetic baseline 放在 `(fontAscent-fontDescent)/2`，`textBaseline='alphabetic'` 绘制，不再逐字墨迹居中（`I`/`A` 位置仅变化约 0.07 CSS px，`g` 修正 6.4 px）；直立 Tu 分支绘制 Unicode 竖排变体并用 `measureText` 的 ink 度量把变体墨迹在 em cell 内垂直居中，变体字形不可用（advance≤0）或旧测量缺 `verticalForm` 时回退原绘制（不吞字）。横排整行 shaped run、ZWJ 堆叠、grapheme、预算、pin 旋转/长截图映射均未改动。
  - `scripts/probe-pin-view-export.js`：phase D 的 `VERTICAL_GLYPH_CASES` 新增 `。`、`、`、`g`，保留 `I`/`中A文`/`中文竖排`/ZWJ emoji 正例，报告 JSON 结构不变。
- **回归**（`test/u02-pin-renderer-runtime.test.js` phase D 新增断言 IoU≥0.6、质心差≤2 CSS px、尺寸容差 2；`test/u02-pin-view-export.test.js` 新增竖排变体与共享基线单测、原侧排单测加 alphabetic baseline 断言；正例阈值未降低）：
  - `test/u02-pin-view-export.test.js test/u02-ocr-vertical-orientation.test.js test/u02-pin-renderer-runtime.test.js` → **38/38 通过**（内嵌真实 Electron 探针）。
- **真实 Electron 探针**（`scripts/probe-pin-view-export.js`，`force-device-scale-factor=1.25`，fontSize 28.7148 CSS，导出 500×528 device px；本记录独立复跑）：

  | 样本 | glyph | sideways | IoU（修复前→后） | 屏幕→导出质心差 |
  |---|---|---|---:|---:|
  | full-stop | `。` | false | 0 → **1.0000** | **0.000** CSS px（评审 13.36/4.99） |
  | comma | `、` | false | 0 → **1.0000** | **0.000**（评审约 13.49） |
  | latin-g | `g` | true | 0.257 → **0.8973** | **0.342**（评审 6.4） |
  | latin-i（正例） | `I` | true | 0.7500 | 0.400 |
  | mixed-zh-en（正例） | 中/A/文 | – | 0.3463 / 0.8761 / 0.1725 | 2.223 / 0.491 / 2.196 |
  | cjk（正例） | 中/文/竖/排 | – | 0.3558 / 0.1652 / 0.2105 / 0.3865 | 均 ≤2.35 |
  | emoji（正例） | `👩‍💻` | false | 0.8148 | 2.057 |

  另以真机管线补测变体表其余标点：`，` 1.0、`：` 0.568、`；` 0.592、`！` 0.802、`？` 0.621、`（`/`）` 0.518/0.524（旧路径这些为横排/旋转绘制 IoU≈0–0.01）。
- **残余**：竖排变体依赖系统字体提供 U+FE10–FE16；缺失时回退原横排绘制（不吞字，但该字回到旧缺陷），Windows 目标机实测命中；角/引号括号未纳入（非本次评审样本）；CJK 直立字仍用 middle-baseline（本项未改，质心差 0.8–2.35 CSS px 在既有阈值内）。

### P2-03 · 侧车存活时状态页超过刷新间隔仍发布旧状态

- **根因**：`refreshStatus()` 用 `sidecarActive || probedRecently` 决定复用旧快照。`sidecarActive` 在 JSON-lines 桥接侧车进程存活期间恒为 true（侧车背后的 Everything 静默/恢复不会让进程退出），于是首次成功 `status` 之后显式刷新永远不再探测：就绪→静默后仍返回 `phase:"ready", queryAnswered:true`，静默→就绪后仍返回 `waiting`，侧车只收到最初一条 `status`。
- **修复**（`main/services/everything-service.js`）：删除 `sidecarActive` 捷径，只保留 5 秒节流（`probedRecently`）与 `refreshPromise` 合并；超过时限的显式刷新走原 probe 路径——`ensureStarted()`（侧车活着立即返回，不重启；冷路径仍只启动 JSON-lines 桥，不启动内置 Everything）→ 发一次轻量 `{action:'status'}` → `applySidecarStatus()` + 共享 `snapshotIsReady` 谓词更新 `phase/queryAnswered` → 记录 `lastStatusProbeAt` → `scheduleIdleStop()`。`e2eQuery` 短路径、错误降级、P2-03 的 queryAnswered 语义与 `ensureReady`/`waitReady` 均未改动。
- **回归**（`test/everything-service.test.js`，+3 用例与 1 个旧测试改写；基线上 3 个新用例失败）：
  - 就绪→静默：首次 ready 后时钟推进到 1_006_100 ms、1_012_200 ms 各刷新一次，每次 `status` 计数 +1，状态变为 `waiting / queryAnswered:false`；
  - 静默→就绪：初始 waiting，+6.1 s 恢复应答后刷新变为 `phase:ready / queryAnswered:true`，只增加一次 `status`；
  - 并发超窗刷新只产生一次 `status`（refreshPromise 去重）；5 秒内仍节流；断言内置 Everything 从未被启动。
  - 旧测试 “refreshStatus reuses the recent probe while the sidecar stays active” 改名并收窄为“5 秒内合并刷新”，因为“侧车存活即可复用”正是评审认定的缺陷。
- **残余**：真实 UIPI/静默实例双 Everything 场景仍属候选包验收（服务层由可控侧车与假时钟覆盖）。

## 4. 验证范围与证据

环境按仓库 `AGENTS.md`：清 `ELECTRON_RUN_AS_NODE`；`TMP/TEMP/HIGHLIGHTER_E2E_DATA_ROOT_BASE` 指向仓内 `.tmp-test`；真实 Electron 探针用 `--no-sandbox` 且在脚本路径之前。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `npm run check` | ok（635 个 JS 文件；architecture `main.js 1204/1205`；i18n `602/606`；review-evidence `2 registries / 50 tickets / 9 required P0`） |
| 全量测试 | `npm test` | **3465/3465 通过，0 失败 0 跳过**（基线 3448 + 本轮新增 17 个回归） |
| 渲染层 E2E | `npm run test:e2e` | **21/21 通过**（2.7 min） |
| 长图 | `npm run test:long-capture` | 通过 |
| 覆盖率（loaded） | `npm run test:coverage:loaded` | 行/语句 **93.51%**（门限 85%），分支 78.88%，函数 90.31% |
| 覆盖率（native） | `npm run test:coverage:native` | ocr-service 行 **96%**（门限 60%），long-capture-session 98.64% |
| 覆盖率（critical） | `npm run test:coverage:critical` | 行/语句 **93.76%**（门限 90%），分支 70.5%，函数 87.34% |
| 版本 | `npm run check:version` | 5.1.1 一致 |
| Everything 原生 | 本轮未改动 Rust/侧车 exe | 无变更（上一轮 26/26 结论仍适用） |
| 选择钩子原生 | 本轮未改动 | 无变更 |

真实进程探针（本机复跑）：

| 探针 | 结果 |
|---|---|
| `scripts/probe-pin-view-export.js`（phase A–D，强制 125% 缩放） | 退出码 0、`report.ok=true`、`dpr=1.25`：A 长图滚动带、B 真差分、C OCR 布局继续通过；D 阶段 `。` IoU **1.0000**/质心差 0，`、` **1.0000**/0，`g` **0.8973**/0.342 CSS px，`I` 0.7500、中英/中文/emoji 正例全过（见 §3 P2-02 表） |
| `scripts/probe-pin-screen-diff.js --frames 3` | 副屏实跑，六项判定全 true（`screenCaptureWorks / exclusionProven / alignmentProven / stackedPinsProven / negativeCoordinatesProven / productionEntryProven`），首帧成功、交付 2 帧、`protectionRestored:true` |

定向测试（集成后独立复跑）：`test/record-domain.test.js` 82/82、`test/n05-pin-screen-diff.test.js` 39/39、`test/pin-domain.test.js` 13/13、`test/everything-service.test.js` 33/33、`test/u02-pin-view-export.test.js` + `test/u02-ocr-vertical-orientation.test.js` + `test/u02-pin-renderer-runtime.test.js` 38/38（含真实 Electron 探针）。

**独立复核（另一代理、对抗视角，独立写脚本并对基线 d4993a2 做 fail-before 对照）**：5 项全部 PASS（无 FAIL、无新 P1/P0）；定向测试与间接相关套件合计 **229/229 + 346/346**；真实探针与修复记录数字一致；唯一新发现是修复自身引入的 P2 边缘（take-epoch 过判，见 §2 P1-02 的 S6），已在本轮修掉并补回归。复核还确认 P2-4 的阈值（IoU≥0.6 / 质心≤2 CSS px）能拦下基线缺陷（基线 `。`/`、` IoU=0、质心 −17.03/6.88 与 −16.47/7.60，`g` IoU 0.2633、偏移 6.62），且正例数值无退化。

## 5. 仍需真实设备 / 候选包验证

- V/R 系列、硬件键盘矩阵、真实模型断管、物理拔插/热插拔、Everything 1.4/1.5 双实例、签名安装升级：仍按候选验收清单执行，本轮未伪造通过。
- P1 两项：真实选框在慢枚举/加载失败/取消-重试、真实全局快捷键与全屏入口并发，需在候选包内按评审场景复核；本轮以正式入口 + 仓库窗口夹具覆盖。
- P2-01：枚举期间物理拖动贴图/缩放窗口的竞态由确定性夹具覆盖，真机手工步骤保留。
- P2-02：真机字体差异与更复杂中英混排保留为已知残余。

## 6. 提交边界

与上一轮一致，交付拆成两个提交：

- `fix(review): close the d4993a2 delivery-review findings`：代码、测试、探针样本；
- 紧随其后的 `docs(evidence): record the d4993a2 delivery-review fix`：本记录、评审方原样入库的评审文档 `docs/reviews/2026-11-28-d4993a2-fix-delivery-review.md`。

未推送远端。提交边界按“让下一轮评审能直接对 HEAD 复核”拆分。
