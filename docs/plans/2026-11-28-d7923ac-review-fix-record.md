# 5.1.x d7923ac 交付评审修复记录（发现 1–10）

2026-11-28 · Windows / Electron · 评审对象 `d7923ac1a00bf5e19852c1b585e7c935a9d98578`
（分支 `feat/review-optimization-2026-11-26`）· 代码修复提交 `e4cc247`
· 评审结论 [d7923ac 交付评审](../reviews/2026-11-28-d7923ac-fix-delivery-review.md)
· 上一轮修复记录 [复核修复交付记录](2026-11-28-review-follow-up-fix-record.md)

**结论：评审重开的 10 项（P1×3、P2×7）全部实现修复，每项都先在未修复代码上运行回归并记录
fail-before，再在修复树上复跑通过。三处 P1 反例（取消区域录制后授权串到下一次、OCR 断管触发
主进程未处理异常、原生焦点证据不足仍放行）都已被逐条钉死。自动化门禁在本机全绿：全量 `npm test`
**3430/3430**、E2E **21/21**、长图 64/64、`npm run check`、覆盖率三项、`cargo test` 23/23，
选择钩子与 Everything 侧车原生件已重建；真实进程探针（生产入口屏幕差分、焦点分类、成片编码）
复跑通过。真机 V/R、候选包、签名与硬件键盘矩阵仍未执行，按 §5 保留。**

本记录沿用上一轮的写法：只登记“修复提交 / 回归测试 / 自动化结果 / 剩余设备条件”，不把真机项写成
本机通过；评审给出的复现时序与验收条件只回填实现与证据位置。

## 1. 逐项状态与证据索引

| 评审发现 | 级别 | 修复位置 | 回归（fail-before → 修复后） | 本机结果 | 剩余设备条件 |
|---|---|---|---|---|---|
| 1 取消区域录制后快捷入口继承授权 | P1 | `config/routes/recording.js`、`main/domains/record/index.js`、`main/domains/capture/index.js` | `test/record-domain.test.js`（取消/只聚焦/替换/回执 4 例）、`test/capture-domain.test.js`（请求 ID 传递）、`test/recording-workbench-ui.test.js`（三态开关） | 取消 A → 快捷 B 的 `demoKeystrokes=false`；“只聚焦”与“取消”均不消费开关 | 候选工作台实际取消/连续开录 |
| 2 OCR 子进程写帧退出触发未处理流错误 | P1 | `main/services/ocr-service.js` | `test/ocr-service.test.js`（真实破管子进程、legacy 行写流错误、幂等回收） | 评审原脚本：`recognition rejected OCR_SIDECAR_RECYCLED`、父进程 EXIT=0 | 真实 `native/ocr` 侧车 + ONNX 模型物理断管 |
| 3 原生层把缺失可写性证据当作安全焦点 | P1 | `vendor/selection-hook/src/windows/core/keyboard_focus.{h,cc}`、`selection_hook.cc`、`scripts/probe-keyboard-focus-context.js` | `test/n03-focus-context-contract.test.js`、`test/n03-global-keystrokes.test.js`（策略 + 跨层 0 IPC/0 事件） | 评审输入（前台有效、元素可用、无可写/只读证据）→ `accepted:false, context:unknown`；可写富文本不再判 safe | 真实硬件键盘矩阵、真实演示页正例（策略/探针级已覆盖） |
| 4 请求超时后排队旧帧仍写出 | P2 | `main/services/ocr-service.js` | `test/ocr-service.test.js`（全帧已写/半帧停写/停滞回收 3 例） | 超时后过期的排队帧写前跳过；停滞写在回收期限后回收；下次识别新握手成功 | 真实模型推理时长标定 |
| 5 单屏回退接受冲突 ID / 多条匿名来源 | P2 | `pin/pin-screen-diff.js`、`main/domains/pin/index.js` | `test/n05-pin-screen-diff.test.js`（冲突 ID、双匿名、拓扑变化、恢复后只交付目标屏） | 目标 A + 唯一来源 B → `DISPLAY_UNAVAILABLE`；双匿名 → `SOURCE_UNIDENTIFIED`；目标恢复后交付 600×300 副屏裁剪 | 运行中物理拔插副屏 |
| 6 按码点绘制拆散组合字符 | P2 | `shared/ocr-text-overlay.js`、`pin/pin-view-export.js` | `test/u02-pin-view-export.test.js`、`test/u02-pin-renderer-runtime.test.js`（隐藏 Electron 真实 pin.html） | `测试👩‍💻` 实测 3 个字素；水平行“每行一次整行 fillText”，阿拉伯文整行塑形；竖排逐完整字素 | 真实 DPI/多屏/旋转贴图视觉对照 |
| 7 测量预算只计入保留字符 | P2 | `shared/ocr-text-overlay.js` | 同上（fake DOM + 运行时探针） | 6×3000 字窄框：总 DOM 读取 3072 ≤4096，每块 ≤512，`complete=false`，可见前缀正确导出 | 真实长窄框语料视觉抽查 |
| 8 轨道先截 500 再投影选区 | P2 | `record/trim-controller.js`、`shared/recording-export-options.js`、`record/editor.js`、`shared/locales/recording-editor.js` | `test/recording-trim-ui.test.js`、`test/shared-recording-export-options.test.js`、`test/recording-editor-ui.test.js` | 600×1Hz：全片 500/truncated、dropped 100（500500–599500）；尾段 100/truncated=false；>1000 条尾部选区保留 | 候选编辑器真实确认流程 |
| 9 就近配对把两次双报变成三条 | P2 | `main/domains/record/index.js` | 新增 `test/n03-keystroke-pairing.test.js`（评审时序/单源连击/一侧漏报） | 评审时序 [1000,1090] 双报 + 控制条 [1110,1200] → 恰 2 条 `{1000,1090}` | 真实键盘同源连击/双源同一次按键 |
| 10 查询超时仍报告就绪 | P2 | `native/everything-search/src/main.rs`、重建 `bin/HighlighterEverything.exe` | Rust 新增 3 例 + `test/f04-everything-performance.test.js` | `answered && running && dbLoaded` 才 ready；纯排名让应答空索引（2000 分）压过查询静默但 IPC 正常的实例（200 分） | Everything 1.4/1.5 真实双实例/UIPI |

## 2. P1 发现明细

### 发现 1 · 取消区域录制后，另一次快捷录制继承全局按键采集授权

- **根因**：`pendingRegionCapture` 只是带 5 分钟 TTL 的“一次性槽”，且 `createRecordWindow()`
  在创建任何区域录制时都会取走它；取消选框只让页面开关提前复位，槽本身仍存活。于是“取消 A → 快捷
  录制 B”的 B 没有传工作台配置，却取走了 A 的 `demoKeystrokes`。此外 `{ok:true, focused:true}`
  只聚焦已有录制时，页面也把一次性开关画成已消费。
- **修复**：
  - `workbenchStart(mode:'region')` 为本次选框生成 `requestId`，把配置与 `requestId` 绑定；
    `createRecordWindow()` 只消费 `options.regionRequestId` 与之匹配的槽，并在**控制窗真正创建后**
    才清除槽、向工作台回执 `{ok:true, created:true}`。
  - 选框 `closed`（取消/被新截图替换/渲染超时关闭）或 `openSelection` 无法给出窗口时，以
    `created:false` 结算并作废旧槽；退出路径（`disposeRecordingResources`）结算未完成请求。
  - 捕获域把请求 ID 存在覆盖窗对象上（不经渲染层，不可伪造），区域确认时随 `selectionBounds`
    传给录制域；快捷入口没有 ID，因此永远不会继承别人的授权。
  - 工作台只在收到 created 回执后消费一次性开关；`focused:true` 与 `created:false` 都保留选择。
- **回归（先失败后通过）**：`test/record-domain.test.js` 新增 4 例（取消→快捷入口、创建回执恰好
  一次、无关请求 ID 不消费、替换旧选框只作废旧请求）；`test/capture-domain.test.js` 断言工作台窗
  携带 `regionRequestId`、快捷入口传空 ID；`test/recording-workbench-ui.test.js` 覆盖
  “只聚焦 / 选框取消 / 真正创建 A → 再开 B”三个状态转换与纯函数回执判定。旧代码下这些用例
  分别以“B 的 `demoKeystrokes===true`”“消耗了页面开关”失败。
- **剩余真机**：候选包工作台实际取消一次区域选框、再从快捷入口开录，确认全局采集保持关闭；
  同页连续开录 A/B 的开关复位。

### 发现 2 · OCR 子进程在写帧期间退出，触发父进程未处理流错误

- **根因**：`writeFrame` 每次写都临时安装 stdin `'error'` 监听器，写回调先到时就移除唯一监听器；
  Node 随后仍会在同一条 stdin 上派发 `'error'`，无人处理即 `Unhandled 'error' event / write EOF`。
- **修复**：每代子进程 spawn 后立即安装覆盖整代生命周期的 stdin 错误处理器；写回调与流事件共用
  幂等回收 `discardProcess`（首个失败回收一次，迟到事件在代际不匹配时被吞掉）。legacy JSON 行写
  同样被该处理器覆盖。`writeFrame` 不再增删流监听器。
- **回归**：`test/ocr-service.test.js` 用**真实 Windows 子进程 + 真实管道**：发送 ready 后停止读并
  退出，父进程写 8 MiB；断言父进程存活、该代只回收一次、下一次识别在新握手后成功。另测 legacy
  行写在流错误后不再抛出未处理异常。评审文档自带复现脚本在修复后输出
  `recognition rejected OCR_SIDECAR_RECYCLED`、`EXIT=0`（修复前为 `write EOF`、EXIT=1）。
- **剩余真机**：真实 `native/ocr` 侧车 + ONNX 模型的物理破管/半帧恢复。

### 发现 3 · 原生层把缺失的可写性证据当作安全焦点

- **根因**：`ReadElementEvidence` 在 `get_CurrentControlType`/`get_CurrentIsPassword` 成功后即把
  元素标为可用；ValuePattern 存在但 `IsReadOnly` 读取失败、TextPattern 存在但
  `UIA_IsReadOnlyAttributeId` 读取失败时都保持“无敏感标志” → 策略落到 `safe`。HWND 回退取到的
  元素可能只是承载虚拟子控件的容器，其属性不能证明真实焦点。
- **修复**：
  - 证据结构区分 `focusIdentityConfirmed`（仅匹配的 `GetFocusedElement` / 显式探针句柄为真）、
    `isTextControlType`、`valuePatternPresent/valueReadOnlyKnown/valueReadOnly`、
    `textPatternPresent/textPatternReadOnlyKnown/textPatternReadOnly`。
  - 策略顺序：既有 fail-closed → password/IME/可写文本 → **焦点身份不确定 → Unknown** →
    **pattern 存在但只读属性读取失败 → Unknown** → 已确认只读 → `safe` → 已确认非文本控件 →
    `safe` → 其余 `unknown`（Document/Text 控件无只读证据也不再默认 safe）。
  - 自测桥暴露新证据字段与 shorthand（`containerOnly`、`valueReadOnlyUnknown`、
    `textReadOnlyUnknown`、`virtualPasswordSubcontrol` 等），探针把可写富文本允许集从
    `['text','safe']` 收紧为 `['text','unknown']`（不再含 safe），只读富文本保留 provider
    依赖的 `safe|unknown` 并显式登记残余。
- **回归**：`test/n03-focus-context-contract.test.js` 覆盖属性读取失败、容器回退、虚拟密码子控件、
  无只读证据的 Document/Text 控件、只读正例与 shorthand；`test/n03-global-keystrokes.test.js`
  跨层断言这些类“原生不接受 → JS 过滤丢弃 → pointer host 0 条 IPC → 合并/事件轨 0 条”，并对
  只读文档正例断言整条链恰好 1 条。评审输入“前台有效、元素可用、无可写或只读证据”现在得到
  `accepted:false, context:unknown, reason:unconfirmed_focus_identity`。原生件已重建，
  `sourceBuildId === nativeBuildId === hl_ed63a2cc7abaa935d45e58ba1f8481df264b4e33e6754d037a2a2c76a44dec63`。
- **剩余真机**：真实硬件键盘矩阵（演示页允许 1 条、文本框/密码/IME/未知焦点 0 条）。失败关闭后的
  接受面变窄：provider 不回答只读属性的 Document/Text 控件、只能取得容器的回退都记为 unknown，
  这是评审要求的隐私方向（残余见 §6）。

## 3. P2 发现明细

### 发现 4 · 识别超时后，仍排队的旧帧会在恢复通畅时写出

- **修复**：每个帧请求带 `queued → writing → written` 状态；写前复核进程/代际，且请求已超时
  （离开 pending）时以 `OCR_FRAME_EXPIRED` 跳过、不写管道、不回收进程；已开始写的帧记入
  `writingFrames` 参与 `isBusy()`（空闲停进程不会在写中杀侧车），持续停滞的在途写由
  `frameWriteStallTimeoutMs`（默认 120 s，测试可注入）回收该代。结果超时语义不变：帧已全写完
  只是推理慢时只拒绝结果，不回收进程、迟到回包被忽略。
- **回归**：`test/ocr-service.test.js` 覆盖评审的“两帧 25 ms 截止、第一帧写回调暂缓”时序
  （释放第一帧写回调后第二帧不再写出）、全帧已写但推理慢、半帧停写后的回收与下一次新握手。

### 发现 5 · 单屏回退接受相冲突的来源 ID 和多条匿名来源

- **修复**：`pickScreenSource` 的排除法只在 caller 声明单屏、恰好 1 条可用来源且该来源**缺
  display_id** 时生效；来源明确标了别的 ID → `DISPLAY_UNAVAILABLE`，多条匿名/歧义 →
  `SOURCE_UNIDENTIFIED`，均为可重试拒绝。`captureScreenUnderPin` 在 `await getSources()` 之后
  重新枚举显示器，新增 `checkDisplayTopology` 要求数量不变且目标 display id 仍存在，否则不交付帧
  并重试；单屏判定用重新枚举后的计数。
- **回归**：`test/n05-pin-screen-diff.test.js` 增加产品级反例（目标 A + 唯一来源 B、两条匿名、
  两次枚举数量变化、同数量但目标 ID 消失）与恢复后“只交付目标屏 600×300 裁剪”的断言；原有
  “多屏身份确认/单屏排除法/临时不可用可恢复”用例保留。

### 发现 6 · 按 Unicode 码点单独绘制，拆散了组合字符

- **修复**：测量按**字素簇**迭代（`Intl.Segmenter 'grapheme'`，附有界 fallback：组合符、变体
  选择符、emoji 修饰符、ZWJ、区域指示符、CRLF；单簇最多 32 UTF-16 单元且不切断代理对），并取整簇
  的 `getClientRects` 并集作为一个字框。导出时水平行按浏览器已排定的整行文本**一次 `fillText`**
  （阿拉伯文等连写、ZWJ 字形不再被拆），竖排逐完整字素绘制、列保持从右到左；`glyph.text` 的
  4 单元截断放宽到 32 单元且不切代理对。DOM 索引断裂（被裁剪的中间段）会拆成多个连续 run，避免把
  不可见文字重新绘回。
- **回归**：`test/u02-pin-view-export.test.js` 的 fake DOM 用例断言 ZWJ/组合音标/阿拉伯文的字素
  完整、水平“每行一次整行 `fillText`”、竖排逐字素；`test/u02-pin-renderer-runtime.test.js` 新增
  隐藏 Electron 真实 pin.html 运行时用例（内嵌探针）：`测试👩‍💻` 的 layout 为 3 glyphs
  `['测','试','👩‍💻']`、单行整行文本、可见叠层墨迹与导出墨迹在容差内一致；原有中文竖排、窄框换行、
  裁剪块 0 墨迹用例继续通过。

### 发现 7 · OCR 测量预算只计算保留的字符

- **修复**：每块与全局预算改为按**已尝试测量次数**扣减（每次 `Range.getClientRects` 前计数）：
  每块 512、全局 4096；被预算截断的块显式返回 `attempts/complete=false`，导出只画实测到的可见
  前缀；完全未测的块不产出 layout，保留“实测优先、无实测确定性回退”的既有契约。
- **回归**：fake DOM 用例用 3000 字窄框与多块裁剪语料断言 DOM 读取次数 ≤ 每块 512、全局 ≤4096、
  `complete=false` 且可见前缀正确导出；运行时探针用 6×3000 字窄框实测总读取 3072 ≤4096、每块
  ≤512，并核对每块可见前缀与导出一致。

### 发现 8 · 录屏轨先截到 500 条再应用剪辑选区

- **修复**：编辑器读取不再做渲染截断——`KEYSTROKE_SOURCE_LIMIT` 取共享
  `MAX_SOURCE_ITEMS=2000`（与项目持久化上限一致）；`normalizeKeystrokeOverlay` 的读入 slice 从
  `MAX_ITEMS*2=1000` 提升到 2000；仍是“先按选区投影，再对需要渲染的窗口应用 500 窗口 / 64 标签
  预算”，`dropped` 精确给出条数、标签数与首末源时间。导出请求携带完整源序列（≤2000），主进程用
  同一函数重算。截断披露文案同时给出显示窗口与标签两个上限，不再把窗口上限导致的损失归因到标签上限。
- **回归**：共享模块/编辑器的 600×1Hz 全片 → plan 500、`truncated:true`、
  `dropped={items:100,labels:1,firstSourceMs:500500,lastSourceMs:599500}`；同一输入
  `segments=[{500000,600000}]` → plan 100、`truncated:false`；>1000 条源事件的尾部选区保留
  尾部 100 条；trim UI 断言 `count=600`/plan 与提交请求一致；editor UI 断言确认前渲染披露、
  开关关闭时不显示、剪到尾段后隐藏。

### 发现 9 · 就近配对可能让两次完整双报的按键变成三条

- **修复**：`mergeKeystrokeSources` 改为按 combo 分组、对两源时间序列做**保序一对一**匹配
  （贪心双指针，先配对最早可配的一对），同来源连击永不合并；跨源同 combo 且落在 120 ms 窗口内才
  成对，合并时保留较早的墙钟时间。不同 combo 不会互相影响配对顺序。
- **回归**：新增 `test/n03-keystroke-pairing.test.js`：评审时序（全局 [1000,1090]、控制条
  [1110,1200]）→ 恰 2 条 `{1000,1090}`（旧实现 3 条）；单源 90 ms 连击保持 2 条；一侧漏报时
  另一条保留；120 ms 边界；交错序列不交叉配对；输出保持时间升序。`test/n03-global-keystrokes.test.js`
  的源码契约同步更新为新实现标记。

### 发现 10 · Everything 查询已超时，等待接口仍可能报告就绪

- **修复**：探针结果类型化为 `Answered(total)/BadReply/SendFailed/Timeout`；
  `apply_probe_result`/`refresh_status`/`status_from_cache` 内部返回“本轮查询通道是否应答”，
  展示快照照旧反映运行状态（静默实例仍 `running:true`、携带旧 `dbLoaded`），但 `wait-ready`
  改用 `answered && running && dbLoaded`；应答空索引不再被静默实例拖住。候选排名抽成纯函数
  `candidate_score/rank_candidates`：有内容 > 应答空索引 > bad-reply 应答 > 查询静默但 IPC/db
  可答 > 仅版本可答 > 完全静默（进 silent_fallback），`timeout` 与 `send-failed` 同样算未应答。
- **回归**：新增 3 条 Rust 用例（应答空索引压过查询静默实例、静默时 wait-ready 不提前 ready、
  切换到应答实例后的首次重选即结束等待），既有 20 条按新签名更新；`test/f04-everything-performance.test.js`
  增加 source 契约与用例清单。`cargo test --locked` **23/23**；侧车 exe 重建
  （367104 → 367616 B，SHA256 `EC45CDD2C8C0FB89C87BE84F2E369767FBF4080586A6167BCED20780D52DD95C`），
  本机真实 Everything 1.4.1.1032 冒烟 status/probe-all/query/wait-ready/shutdown 均正常。

## 4. 集成门禁（本机，修复树）

环境按仓库 `AGENTS.md`：清 `ELECTRON_RUN_AS_NODE`；`TMP/TEMP/HIGHLIGHTER_E2E_DATA_ROOT_BASE`
指向仓内 `.tmp-test`；直接拉 Electron 的探针用 `.tmp-work/hook/no-sandbox.js` 把 `--no-sandbox`
放到脚本路径前；E2E 用 `HIGHLIGHTER_E2E_NO_SANDBOX=1`。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `npm run check` | ok（634 个 JS 文件、main.js 1204/1205 行、i18n 602/606、证据表 2 注册表 50 单 9 P0） |
| 全量测试 | `npm test` | **3430/3430 通过，0 失败 0 跳过**（上一轮修复树 3391；本轮 +39 例） |
| 渲染层 E2E | `npm run test:e2e` | **21/21 通过**（2.6 min） |
| 长图 | `npm run test:long-capture` | 通过（64/64） |
| 覆盖率（loaded） | `npm run test:coverage:loaded` | 行/语句 93.51%（门限 85%），分支 78.82%，函数 90.27% |
| 覆盖率（native） | `npm run test:coverage:native` | ocr-service 行 96%（门限 60%），long-capture-session 98.64% |
| 覆盖率（critical） | `npm run test:coverage:critical` | 93.76%（门限 90%） |
| 版本 | `npm run check:version` | 5.1.1 一致 |
| Everything 原生 | `cargo test --locked --manifest-path native/everything-search/Cargo.toml`；`npm run build:everything` | 23/23；exe 重建入库 |
| 选择钩子原生 | `npm run build:selection`；`node --test test/selection-native-build.test.js` | 构建/自测通过，源与二进制 build-id 一致 |
| 未运行/不适用 | `verify:fuses`、`verify:package`、`verify:release` | 需完整 electron-builder 产物/签名，属候选验证 |

定向复跑（最终树，实际计数）：

```powershell
# 焦点/合并/原生件
node --test test/n03-global-keystrokes.test.js test/n03-focus-context-contract.test.js `
  test/selection-native-build.test.js test/selection-keyboard-combos.test.js test/n03-keystroke-pairing.test.js   # 45/45
# OCR 服务
node --test test/ocr-service.test.js test/ocr-ipc.test.js test/data-root.test.js                                  # 75/75
# 录屏快捷键/编辑器/导出
node --test test/recording-trim-ui.test.js test/shared-recording-export-options.test.js `
  test/recording-editor-ui.test.js test/recording-export.test.js                                                  # 148/148
# 贴图来源
node --test test/n05-pin-screen-diff.test.js test/n05-pin-diff-view.test.js test/pin-domain.test.js               # 52/52
# OCR 叠层导出（含真实 pin.html 运行时）
node --test test/u02-pin-view-export.test.js test/u02-pin-renderer-runtime.test.js                                # 31/31
# Everything
node --test test/f04-everything-performance.test.js test/everything-service.test.js test/h04-everything-dwid.test.js  # 47/47
# 区域录制授权/工作台
node --test test/record-domain.test.js test/capture-domain.test.js test/recording-workbench-ui.test.js            # 116/116
```

真实进程探针（证据写入 `.tmp*/`，未入库原始 JSON）：

```powershell
# 发现 3：焦点分类（不按键）
node scripts/probe-keyboard-focus-context.js
# → exit 0：文本输入 text、密码框 password、非文本窗体 safe、只读富文本 safe、可写富文本 text
#   （writable_value_focus，不再是 safe）、非法句柄 unknown；新增容器/属性读取失败 → unknown、
#   虚拟密码子控件 → password、只读文档 → safe 等 evidence 类全部 PASS
# 发现 5：生产入口屏幕差分（真实 Electron）
./node_modules/electron/dist/electron.exe --no-sandbox scripts/probe-pin-screen-diff.js `
  --frames 3 --out .tmp-work/probe/out/d7923ac-pin-screen-diff.json
# → status=measured，verdict 全 true（含 productionEntryProven:true）
# 发现 8：真实 ffmpeg 成片
node scripts/probe-keystroke-overlay-film.js --out .tmp-overlay/d7923ac-evidence
# → 19/19 PASS：300×Ctrl+S 尾帧 29.9 s 亮度 69.48；78 标签保留 64（dropped 区间精确）
```

## 5. 未执行项与下一候选验收顺序

1. **真机 V/R 未执行**：V01–V10、R01–R03 仍按[验收台账](2026-11-28-follow-up-acceptance-status.md)
   执行；本机只交付自动化与探针证据，未做安装包、签名、隔离安装或硬件矩阵。
2. **本轮新增/变化的真机复核点**：
   - 发现 1：候选工作台“仅本次”区域录制 → 取消 → 快捷区域录制，确认全局采集关闭；同页
     A 开录成功 → B 默认关闭；只聚焦已有录制不消费开关。
   - 发现 2/4：真实 `native/ocr` 侧车 + ONNX 模型上制造物理破管/半帧停写，下一次识别在新握手后
     成功；停滞写回收期限按真实推理时长观察。
   - 发现 3：真实硬件键盘在演示页/文本框/密码框/拼音组字/未知焦点间切换（允许 1 条、其余 0 条）。
   - 发现 5：运行中物理拔插副屏后不交付主屏像素并能续采。
   - 发现 6/7：真实 DPI/多屏、旋转贴图与长窄框语料的视觉对照。
   - 发现 8：候选编辑器确认流程与 64 标签×多区间密集素材；Windows argv 长边界另见 §6。
   - 发现 9：真实同源连击/控制条+全局双报同一次按键。
   - 发现 10：Everything 1.4/1.5 重启、旧实例查询超时 + 新实例应答的切换（V07）。
3. **候选绑定**：下一候选必须包含 `e4cc247` 与本次文档提交，并重建原生件：选择钩子
   （`npm run build:selection`）、Everything 侧车（`npm run build:everything`，仓库内已入库重建
   exe）。候选包哈希、CI run、签名状态按 R01 绑定到同一份验收记录后再开展隔离安装与硬件矩阵。
4. **未运行而非被修复的门禁**：`verify:package` / `verify:release`（需完整 electron-builder 产物
   与签名）、真实模型 OCR、真实双屏拔插、真实硬件键盘矩阵、Everything 真机重启。

## 6. 残余风险与有意保留的限制

| # | 项 | 说明 | 影响 / 处置 |
|---|---|---|---|
| 1 | P1-3 接受面变窄 | provider 不回答 `UIA_IsReadOnlyAttributeId` 的 Document/Text 控件、只能取得容器回退的焦点、以及 `UIA_TextControlTypeId` 的纯展示面现在都是 unknown；这是评审要求的 fail-closed 方向 | 真机键盘矩阵记录“受限应用”；如某类安全面需要恢复，应为该 provider 增加可证明的正面证据，而不是放宽默认 |
| 2 | P1-3 真实演示页正例 | 正例由策略自测（只读 Document → safe）与探针（真实 UIA provider 的只读富文本文档 → safe）覆盖；真实 Chromium 前台页的分类需真机前台环境（自动化进程受 Windows 前台锁限制，未取得前台） | 归入真机键盘矩阵；不把绕开前台锁的合成输入当作证据 |
| 3 | P1-2 破管语义 | `bad-reply` 视为“已应答”（载荷不可用），与既有缓存语义一致；真实 Electron 主进程下异常呈现未单独演练 | 复核后风险低；真机模型破管时观察 |
| 4 | P2-6 水平整行塑形 | 水平行以实测行盒中心一次 `fillText` 整行文本，逐字墨迹位置不再逐个复刻；单行超过 512 UTF-16 单元按字素边界截断；全局预算耗尽后的块走确定性回退 | 视觉抽查；超长单行属极端语料 |
| 5 | P2-6 竖排 emoji | 竖排列序/字素完整性已断言，未做逐像素列盒对照；无 `Intl.Segmenter` 的 fallback 不完整实现 Indic/Hangul | 现代 Chromium 均有 Segmenter；真机视觉抽查 |
| 6 | P2-8 Windows argv 长边界 | 64 标签×500 窗口 + 深层目标目录可超过 32,767 字符（上一轮已登记，非本轮回归）；本轮修的是“读取截断导致尾部选区丢光”，未改 argv 编码方式 | 后续可改 `-filter_complex_script` 或导出前长度预检 |
| 7 | P2-10 排名副作用 | 可应答的空索引会优先于“查询静默但状态正常”的实例（评审要求的排序）；若该空实例是无关/无权限实例，可能被选中直到不再应答 | 真机 V07 观察；展示仍反映运行状态 |
| 8 | P2-10 wait-ready 节奏 | 真实 300 ms 轮询节奏未单独计时；Rust 用例注入 1 ms 间隔验证逻辑 | 真机 Everything 重启观察 |
| 9 | 探针与硬件边界 | 屏幕差分探针在本机副屏通过；物理拔插、真实硬件键盘、真实 OCR 模型、64 标签密集成片的逐帧成本、真实 DPI/旋转贴图仍属真机范围 | 见 §5，均未执行 |
| 10 | 前台锁 | 自动化进程无法可靠取得 Windows 前台，原生焦点探针的“当前前台”诊断行只能说明当次宿主环境 | 不作为通过证据，也不影响策略级/探针句柄级结论 |

## 7. 证据性质说明

- **fail-before**：各回归先在未修复代码上运行并记录真实断言失败（OCR 的未处理流错误在旧代码上直接
  以 `write EOF` 退出；焦点策略旧值 `safe` vs 期望 `unknown`；区域录制旧槽被快捷入口取走；
  快捷键轨道旧读入停在 500；就近配对旧实现给出 3 条；Everything 旧就绪谓词给出 `ready:true`）。
  为避免多个并行代理在同一工作树互相覆盖，代理把 HEAD 版本复制到 `.tmp*/` 或经只读
  `git show` 注入，不执行任何改 git 状态的命令。
- **独立复核**：lead 在最终树上复跑了全量、E2E、覆盖率、`cargo test`、原生件 build-id、三个真实
  进程探针、评审 OCR 复现脚本，并逐组重跑定向用例；计数均为最终树的实际输出。
- **提交边界**：代码/测试/原生件在 `e4cc247`；评审文档与本记录随文档提交入库。二者拆分是为了让
  修复 SHA 指向产品代码。
