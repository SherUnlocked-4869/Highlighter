# 5.1.x 复核结论修复交付记录（P1-01…P2-07）

2026-11-28 · Windows / Electron · 复核对象 `b84eeba05f66b51f68a4894f0b7aecc92efb6fad`（分支
`feat/review-optimization-2026-11-26`）· 修复提交 `26cbfc8..289b195`（8 个提交）
· 原始结论 [复核记录](../reviews/2026-11-28-review-optimization-follow-up-delivery-review.md)

**结论：复核提出的 11 项（P1×4、P2×7）已全部实现修复，每项都带能在旧提交上失败的回归；4 个 P1
另有入口级（真实 Electron 渲染层/主进程/原生载荷）证据。自动化门禁全绿：全量 3389/3389、E2E 21/21、
长图通过、check 通过、覆盖率三项通过、原生自测与探针通过。真机 V/R、候选包、签名、真实硬件键盘矩阵
仍未执行，按复核 §“下一候选的验收顺序”留在验收台账。**

本记录沿用执行记录的写法：只登记“修复提交 / 回归测试 / 自动化结果 / 剩余设备条件”，不把真机项
写成本机通过。复核逐段输入、触发时序与验收条件见原始结论；本记录只回填实现与证据位置。

## 1. 提交对照与逐项状态

| 复核项 | 工单 | 修复提交 | 入口级/行为回归 | 自动化结果（本机，修复树） | 剩余真机条件 |
|---|---|---|---|---|---|
| P1-01 正式入口取不到第一帧 | DEV-08 | `26cbfc8` | 不注入采集器的生产默认接线回归 + 真实 Electron 生产入口探针 | 定向 67/67；探针 `productionEntryProven:true` | 候选包贴图菜单开启→首帧→连续更新→手动关闭 |
| P1-02 密码框/未知焦点组合键仍被记录 | DEV-04 | `4380bea` | 原生焦点分类自测 + 生产载荷跨层（过滤→IPC→合并→轨）回归 | 定向 174/174；焦点探针 5/5 类；原生 build-id 匹配 | 真实硬件键盘矩阵（控制条/演示页/文本框/密码框/IME/未知焦点） |
| P1-03 Enter/复制确认拍平矢量 | DEV-01 | `d502de9` | 真实 capture.html+preload：Enter/复制按钮/双击/贴图按钮四条入口回归 | 定向 67/67；旧提交下入口探针 2/2 失败 | 真实窗口“编辑→确认→再次打开”后旧矩形可选/可移/可删（100%/150% DPI） |
| P1-04 帧写超时后仍写失效管道 | DEV-06 | `0950910` | 假侧车停读时序回归（超时→迟到写错→回收→下次握手） | 定向 35/35；ocr-service 行覆盖 95.43% | 真实 `native/ocr` 侧车 + ONNX 模型的物理破管恢复 |
| P2-01 一次性开关延续到下一次 | DEV-04 | `d2e1b98` | 同页连续开录/启动失败保留选择的 UI 回归 | 28/28 + 相邻 69/69 | 候选工作台实际连续开录 A/B |
| P2-02 长贴图滚动后导出顶部 | DEV-02 | `1387df7` | 显式可见矩形计划回归 + 真实 pin.html 滚动导出运行时探针 | 定向 91/91；运行时探针绿带/顶部/差分三例 | 真实可见窗口、真实 DPI/多屏与滚动条外观 |
| P2-03 副屏来源缺失取到主屏像素 | DEV-08 | `26cbfc8` | 多屏身份确认/单屏排除法/临时不可用可恢复回归 | 定向 n05 全部通过（含 600×300 副屏裁剪） | 运行中物理拔插副屏后不交付主屏像素并能续采 |
| P2-04 竖排/多行译文导出成单行 | DEV-02 | `1387df7` | 实测 DOM 排版共享 + 逐字/逐列绘制回归；运行时探针逐行比对 | 定向 91/91；运行时探针逐行/逐列/裁剪块全部匹配 | 真实 DPI/多屏视觉对照；旋转贴图实机对照 |
| P2-05 成片少于预览中的快捷键 | DEV-05 | `289b195` | 300 重复标签/78 标签计划回归 + 编辑器截断披露回归 | 167/167；真实编码探针 19/19（尾帧 69.48<120 可见） | 64 标签×多区间密集素材的逐帧成本；候选编辑器确认流程 |
| P2-06 连续同快捷键被误去重 | DEV-04 | `4380bea` | 同来源两次→两条、双来源同一次→一条的合并回归 | 定向 174/174（含跨层记录数） | 真实键盘同源连击/控制条+全局双报同一次按键 |
| P2-07 无响应实例黏住状态轮询 | DEV-07 | `621f399` | 静默缓存+新实例切换、wait-ready 恢复、纯静默有界重选 | `cargo test` 20/20；Node 定向 51/51 | Everything 1.4/1.5 重启与迟到回执 V07 真机 |

## 2. P1 修复明细与验收证据

### P1-01 · 正式入口取不到第一帧（`26cbfc8`）

- **根因**：`main/domains/pin/index.js` 默认分支 `injectedDesktopCapturer || (() => require('electron').desktopCapturer)`
  返回的是“取采集器的函数”，下一行却按采集器对象调用 `getSources`；`main.js` 不注入该依赖，生产默认路径必然
  `CAPTURE_THREW`，连续三次失败后停止。
- **修复**：新增 `resolveDesktopCapturer()`，默认解析真实 `require('electron').desktopCapturer` 对象；解析失败返回
  可重试 `CAPTURER_UNAVAILABLE` 而不是伪装成采集失败。既有注入 seam 保留。
- **回归（不注入测试采集器）**：`test/n05-pin-screen-diff.test.js` 用 `require.cache` 假 electron 模块走生产默认分支，
  断言 `captureScreenUnderPin` 返回真实帧；另有用例断言采集器缺失时的类型化错误。旧提交上该组失败（`captureScreenUnderPin`
  直返 `CAPTURE_THREW`）。
- **生产入口探针**：`scripts/probe-pin-screen-diff.js` 新增“production entry”检查——不注入
  `screenDiffDesktopCapturer`，用真实 `createPinDomain` + 真实 `desktopCapturer`，在副屏可见窗口上取首帧、连续两次
  更新并手动关闭。本机结果：

  ```text
  node_modules/electron/dist/electron.exe --no-sandbox scripts/probe-pin-screen-diff.js --frames 3 \
    --out .tmp-work/probe/out/review-pin-screen-diff.json
  RESULT={"status":"measured","verdict":{"screenCaptureWorks":true,"exclusionProven":true,
  "alignmentProven":true,"stackedPinsProven":true,"negativeCoordinatesProven":true,
  "productionEntryProven":true},"adoption":{"adopt":true,"reasons":[]}}
  ```

  首帧 531×355、`sourceMatched:true`，2 次 1 Hz 更新送达，手动停止，内容保护 `[true,false]` 成对恢复。
- **剩余真机**：从候选包贴图菜单开启“真实像素比对”，确认首帧、连续更新与手动关闭（V04 附带项）。

### P1-02 · 密码框和未知焦点中的组合键仍可被记录（`4380bea`）

- **根因**：原生 `key-combo` 载荷只有时间/键码/扫描码/修饰键/标签；JS 只对部分裸键要求安全焦点，组合键无焦点字段
  也通过，复核用“与原生契约一致、无焦点字段的 Ctrl+V”复现 `ok:true`。
- **修复（原生采集边界取得可信分类）**：
  - LL 键盘钩子回调内只做廉价快照（`GetForegroundWindow` / `GetWindowThreadProcessId` / `GetGUIThreadInfo`），
    **不在钩子线程调用 UIA**；
  - JS 线程派发前用有界 `IUIAutomation2`（连接/事务各 250 ms + 500 ms 总预算）分类：`IsPassword`→password、
    可写 ValuePattern 或 Edit 控件→text、活动 IME 组字→ime、无前台/焦点已变/本进程/UIA 失败或超时→unknown；
    只有正面确认的非文本应用表面→safe；
  - 载荷新增 `context`（仅 safe 会被 JS 接受）；`vendor/selection-hook/index.js` 只做契约校验与转发；
  - JS `main/domains/record/keystroke-capture.js` 对**每一条**事件都要求 `context === 'safe'`，缺字段
    （旧原生件/伪造载荷）→ `missing-focus-context`，敏感/未知→0 事件；错误码稳定。
  - 原生件已重建：`sourceBuildId === nativeBuildId === hl_183188e28808a2d417dc9329d2a6ed0185f53727909054ad90f0bf1df6fd3772`;
    `imm32.lib` 与新源文件随 `binding.gyp` 入库。
- **回归**：`test/n03-global-keystrokes.test.js`（生产载荷带 safe 通过；无焦点 Ctrl+V 拒绝；password/text/ime/unknown
  与旧类 drop flag 均 0；跨层“原生自测载荷→过滤→pointer host IPC→合并→轨”允许场景恰 1 条、敏感类 0 条）、
  `test/n03-focus-context-contract.test.js`（原生策略逐类、N-API 自测桥、钩子线程不跑 UIA 的源码契约）、
  `test/selection-native-build.test.js`（build-id 与原生自测契约）。旧提交上：无焦点 Ctrl+V 被接受、同源两次被并成 1。
- **探针**：`node scripts/probe-keyboard-focus-context.js` → 文本输入 `text`、密码框 `password`、非文本表单 `safe`、
  非法句柄 `unknown`、当前前台 `safe`，`classifierAvailable:true`，全程不按键。
- **剩余真机**：真实硬件键盘矩阵（合成输入按设计被 `LLKHF_INJECTED` 拒绝，不能替代）。IMM 组字上下文跨进程不可读，
  实际由“可写文本控件→text”规则与 `VK_PROCESSKEY` 拒绝兜底；非文本表面内组字属真机复核项，无可用 UIA 的应用
  按 fail-closed 记为受限应用。

### P1-03 · 按 Enter 确认重标注会拍平矢量（`d502de9`）

- **根因**：Enter、复制按钮、启用后的双击都走 `performAction('copy')`；编辑既有贴图时该动作提交回原贴图窗口，但
  只有 `pin`/`pin-copy` 构造 `meta.pinEditable`。主进程替换显示图时释放旧快照，下次重标注读到平铺位图。
- **修复**：`capture/capture.js` 抽出唯一判定 `pinConfirmReplacesPin(action)`（`pin`、`pin-copy`、`editPin` 会话下的
  `copy`），所有“替换原贴图”的确认入口共用同一快照构造点；隐私（`skipHistory`/脱敏）、16 MiB/标注数上限与
  “纯位图降级”条件原样保留，新贴图路径不变。
- **回归（入口级）**：`test/u02-pin-reedit-entry.test.js` 在真实（隐藏）Electron 窗口中加载生产 `capture.html` +
  preload，逐条驱动 Enter、复制按钮、双击、贴图按钮，断言送到 `capture:pin` 的 `meta.pinEditable` 为 schema 1、
  含旧矩形 `x=10,y=12` 与底图 PNG；普通复制（非 editPin）断言不带快照。旧提交上 2/2 失败
  （`enter must attach meta.pinEditable when it replaces the pin image`）。域侧半程在 `test/u02-pin-reedit.test.js`：
  确认同时替换显示图+快照、再次打开载荷仍带旧矩形、无快照更新退化为位图且不泄漏。
- **剩余真机**：真实窗口 100%/150% DPI 下“编辑→确认→再次打开”，在画布上实际选择/移动/删除旧矩形。

### P1-04 · 帧写入超时后仍向失效管道发送请求（`0950910`）

- **根因**：识别结果超时会 `pending.delete(id)`；稍后的帧写错误回调因找不到 id 提前返回，跳过 `discardProcess`，
  旧进程保持 `ready`，下一帧继续写入边界不可信的管道。
- **修复**：帧写引入“子进程代际”：`queueFrame` 在排队时记录代际、写入前复核 `process === child && generation`
  一致，否则以稳定 `OCR_SIDECAR_RECYCLED` 取消；**任何**帧写失败（无论请求是否已超时）都按代际回收：kill 一次、
  丢弃 `ready`/能力协商、以 `OCR_SIDECAR_RECYCLED` 拒绝残余 pending、忽略旧子进程迟到输出/退出；下次识别重新握手。
  识别结果超时的调用方语义不变。
- **回归**：`test/ocr-service.test.js` 两条新用例复跑复核时序。独立探针（真实管道 + 注入迟到写错）对照：
  旧码 `framesWrittenToOldPipe:2, serviceReady:true, killCount:0, nextRecognition:EPIPE, starts:1`；
  修复后 `framesWrittenToOldPipe:1, processNull:true, killCount:1, pendingSize:0, nextRecognition:ok, starts:2`。
- **剩余真机**：真实 `native/ocr` 侧车 + ONNX 模型上制造物理破管/半帧后确认下一次识别在新握手后成功。

## 3. P2 修复明细与验收证据

### P2-01 · “仅本次录制”会延续到下一次（`d2e1b98`）

`config/routes/recording.js`：成功真正创建录制后通过纯函数 `choicesAfterRecordingStart()` 消费一次性
`demoKeystrokes`，并原地重绘开关（不整页重渲染、不改变已提交 payload）；失败启动保留用户刚做的选择；
`demoEnhance` 保持原契约。回归改写 `test/recording-workbench-ui.test.js`：开→A 真→开关立即 false→同页 B 假→
失败保留 true；旧代码下新断言失败（27/28）。剩余：候选工作台实际连续 A/B 开录。

### P2-02 · 长贴图滚动后仍导出顶部（`1387df7`）

长图滚动容器是 `body`（`document.scrollingElement` 是 HTML），两处原先读 `scrollingElement.scrollTop` 恒 0。
`pin/pin.js` 新增唯一 `measureVisibleSurfaceRect()`（surface `getBoundingClientRect`），视图导出与真实差分视图都传
显式 `visibleRect`；`pin/pin-view-export.js` 支持显式可见矩形并保留确定性 `scrollTop` 回退。回归：
`test/u02-pin-view-export.test.js`（显式矩形计划 + 首行采样）、`test/n05-pin-diff-view.test.js`（差分入口同一测量）、
`test/u02-pin-renderer-runtime.test.js`（真实 pin.html+CSS：颜色分段长图滚动 600 px 后导出首行为绿色中段；
滚回 0 为红色顶部；差分同图徽标“与下方屏幕无差异”）。旧渲染层上同探针报 `expected rgb(0,255,0) got rgba(255,0,0,255)
at (146,3)`、`bodyScrollTop:600`、`scrollingElementScrollTop:0`。剩余：真实可见窗口/DPI/多屏与滚动条外观。

### P2-03 · 副屏来源缺失时可能取到主屏像素（`26cbfc8`）

`pin/pin-screen-diff.js::pickScreenSource(sources, displayId, {singleDisplay})` 不再“缺 ID 就取第一个可用来源”：
多屏只在身份确认时交付；单屏可按排除法使用唯一来源；否则返回类型化 `NO_SOURCES` / `DISPLAY_UNAVAILABLE` /
`SOURCE_UNIDENTIFIED` 且标记可重试。`main/domains/pin/index.js` 传入显示数，采样器把可重试失败与真实采集失败分开，
不触发 3 次失败停止，目标屏恢复后自动续采。回归（`test/n05-pin-screen-diff.test.js`）：副屏缺失/ID 缺失时不交付
主屏像素、恢复后恢复交付、交付帧为 600×300 副屏裁剪而非 1280×720 主屏；旧回归“接受回退”的断言已按新契约更新。
剩余：运行中物理拔插副屏。

### P2-04 · 竖排 OCR 和多行译文导出后变成单行（`1387df7`）

`shared/ocr-text-overlay.js` 新增 `measureLayout(host)`：从已渲染的叠层 DOM 用 `Range.getClientRects()` 逐字读回
换行行盒、`writing-mode:vertical-rl` 列盒、逐字框与旋转角（有界：200 块 / 4096 字 / 512 行 / 512 字符，裁剪掉
`overflow:hidden` 外的字），只读、同步、测完恢复 transform。`pin/pin.js::currentViewExportOcr()` 把实测 layout 交给
`pin/pin-view-export.js`：方案按实测行/列/字号生成，绘制逐行/逐列/逐字（竖排中文正立、列从右到左），未实测调用方保留
原确定性回退；被裁掉文本只导出可见块。回归：`test/u02-pin-view-export.test.js`（实测竖排/换行映射含旋转、逐字绘制、
裁剪块、字预算）+ 运行时探针逐行比对实测行盒与导出墨迹（竖排译文 3 列、换行译文 2 行、裁剪块 0 墨迹；旧渲染层
`layoutAvailable:false` 时竖排仅 2 px 单行）。剩余：真实 DPI/多屏视觉对照、旋转贴图实机对照；另登记一处**范围外**
观察：可见叠层里竖排 *原文* 块的 `line-height=blockHeight` 会把列推出边框（现导出忠实复刻可见结果），如需修可见层
应另开工单。

### P2-05 · 成片少于预览中的快捷键（`289b195`）

编辑器接受 500 条，导出另限 240 显示区间 / 64 标签且不告知。修复：`shared/recording-export-options.js` 改为
“预览与导出同一可见序列”——渲染窗口上限提升到编辑器同值 500；ffmpeg 素材按**标签**批处理（每个不同标签 1 个
循环 PNG 输入 + 1 个覆盖节点，节点 `enable` 取该标签半开区间并集），300 次同一快捷键只消耗 1 个输入/1 个节点；
保留的 64 标签上限（输入/节点/每帧 PNG 解码预算）通过 `plan.keystrokeOverlay.{truncated,total,dropped{items,labels,
firstSourceMs,lastSourceMs}}` 精确暴露，`record/trim-controller.js` 用同一规范化函数规划并让 HUD 只播放该计划，
`record/editor.js` 在确认导出前显示 `recording.editor.keystrokes.truncated`（三语）：“最多保留 64 种标签：N 个胶囊
（M 种标签，mm:ss–mm:ss）将不会出现在成片中”。回归：`test/shared-recording-export-options.test.js`、
`test/recording-export.test.js`、`test/recording-editor-ui.test.js`、`test/recording-trim-ui.test.js`（300 重复→
计划 300 条且 `truncated=false`；78 标签→保留 64、`dropped` 精确区间、编辑器确认前渲染披露；裁剪投影与主进程重算一致）。
**真实编码探针** `scripts/probe-keystroke-overlay-film.js`（生产 normalize/asset/argv + 真实 ffmpeg-static 编码）：
`node scripts/probe-keystroke-overlay-film.js --out .tmp-overlay/evidence` → 19/19 PASS，`tempCleaned:true`；
30 s 素材 300×Ctrl+S 的**尾帧 29.9 s 亮度 69.48**（<120 可见），78 标签素材保留标签 5.0 s 亮度 70.36、被丢弃标签
10.0/11.9 s 亮度 240.27（空）；素材 `labelInputs:1, overlayNodes:1, splitNodes:0`。旧提交上该探针编码失败
（旧逐窗口覆盖链 240 节点）。剩余：64 标签×多区间密集素材的逐帧成本未端到端测量（仅 300 窗口/单标签实测），
标签上限为有意保留的能力边界、现已在确认前披露。

### P2-06 · 连续按同一快捷键被误去重（`4380bea`）

`main/domains/record/index.js::mergeKeystrokeSources` 保留来源身份：只有“控制条 + 全局钩子”对同一次物理按键的
上报在 120 ms 窗口内、同标签、一对一（就近）才合并成一条；同来源连续两次永不合并。返回仍为 `{at, combo}` 且有界。
回归：同来源间隔 90 ms 的两次 Ctrl+Z → 2 条；双来源同一次 → 1 条；交错/多次序列；跨层“原生 safe 载荷→过滤→合并”
允许场景恰 1 条。旧提交上同源两次被并成 1。

### P2-07 · 状态轮询可一直黏在无响应实例上（`621f399`）

`refresh_status` 的探针结果现在是可单测的决策：`send-failed`/`timeout` → 携带“仍在运行”快照的通信失败；
`bad-reply`（确实应答了）保持缓存。`status_from_cache` 把携带快照照常展示，缓存执行**有界**重选（首个失败立即重选，
持续静默按 0,1,1,2,4,8,8 次调用退避），正常可响应路径仍只解析一次。回归（`native/everything-search/src/main.rs`
内 4 条新 Rust 用例）：静默缓存 + 新实例→一次重选切到可响应实例；`wait-ready` 立即恢复；纯静默 24 次轮询只重选
≤8 次且状态仍 `running:true`。`cargo test --locked --manifest-path native/everything-search/Cargo.toml` 20/20；
`native/everything-search/bin/HighlighterEverything.exe` 已重建入库（359424→367104 B）；`test/f04-everything-performance.test.js`
更新源码契约与用例清单。剩余：Everything 1.4/1.5 重启、迟到回执真机 V07。

## 4. 集成门禁结果（修复树，本机）

环境按仓库 `AGENTS.md`：清 `ELECTRON_RUN_AS_NODE`，`TMP/TEMP/HIGHLIGHTER_E2E_DATA_ROOT_BASE` 指向仓内
`.tmp-work/…`；直接拉 Electron 的探针用临时 `NODE_OPTIONS=--require .tmp-work/hook/no-sandbox.js` 把
`--no-sandbox` 放到脚本路径前；E2E 用 `HIGHLIGHTER_E2E_NO_SANDBOX=1`。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `npm run check` | ok（632/633 JS 文件、main.js 1204/1205 行、i18n 602/606、证据表 2 注册表 50 单 9 P0） |
| 全量测试 | `npm test` | **3389/3389 通过，0 失败 0 跳过**（复核树 `b84eeba` 时 3340 例，新增 49 例） |
| 渲染层 E2E | `npm run test:e2e` | **21/21 通过**（2.6 min） |
| 长图 | `npm run test:long-capture` | 通过（64/64） |
| 覆盖率（默认并发） | `npm run test:coverage:loaded` | 行 93.5%（门限 85%） |
| 覆盖率（原生/关键） | `npm run test:coverage:native`、`test:coverage:critical` | native 96.09%（ocr-service 95.43%/分支 88.63%）；critical 93.76% |
| 版本 | `npm run check:version` | 5.1.1 一致 |
| Everything 原生 | `cargo test --locked --manifest-path native/everything-search/Cargo.toml` | 20/20；`npm run build:everything` 重建入库 |
| 选择钩子原生 | `npm run build:selection`；`node --test test/selection-native-build.test.js` | 构建/自测通过，源与二进制 build-id 一致 |
| 复核 43 例 | `node --test test/n03-global-keystrokes.test.js test/n05-pin-screen-diff.test.js test/u02-pin-view-export.test.js` | 43/43 通过（新契约下扩展后更多） |

定向复跑（按修复分组）：

```powershell
node --test test/n05-pin-screen-diff.test.js test/u02-pin-reedit.test.js test/u02-pin-reedit-entry.test.js `
  test/capture-pin-copy.test.js test/pin-domain.test.js
node --test test/u02-pin-view-export.test.js test/n05-pin-diff-view.test.js test/u02-pin-renderer-runtime.test.js `
  test/capture-ocr-pin-ui.test.js test/n05-pin-onion-snapshot.test.js
node --test test/n03-global-keystrokes.test.js test/n03-focus-context-contract.test.js `
  test/selection-native-build.test.js test/selection-keyboard-combos.test.js test/n03-recording-hud.test.js `
  test/pointer-track-service.test.js test/record-domain.test.js test/selection-hook-host.test.js
node --test test/ocr-service.test.js test/ocr-ipc.test.js
node --test test/recording-workbench-ui.test.js test/shared-recording-export-options.test.js `
  test/recording-trim-ui.test.js test/recording-editor-ui.test.js test/recording-export.test.js
node --test test/f04-everything-performance.test.js test/everything-service.test.js test/h04-everything-dwid.test.js
```

真实进程探针（证据均写入 `.tmp*/`，未入库原始 JSON）：

```powershell
# P1-01 + P2-03 生产入口与多屏身份
.\node_modules\electron\dist\electron.exe --no-sandbox scripts\probe-pin-screen-diff.js `
  --frames 3 --out .tmp-work\probe\out\review-pin-screen-diff.json
# P1-02 焦点分类（不按键）
node scripts\probe-keyboard-focus-context.js
# P2-05 真实编码成片尾段（19 项检查）
node scripts\probe-keystroke-overlay-film.js --out .tmp-overlay\evidence
# P2-02 / P2-04 / P1-03 的运行时证据随 npm test 中的 u02-pin-renderer-runtime / u02-pin-reedit-entry 运行
```

## 5. 未执行项与下一候选验收顺序

1. **真机 V/R 未执行**：V01–V10、R01–R03 仍按[验收台账](2026-11-28-follow-up-acceptance-status.md)执行；本机
   只交付自动化与探针证据，未做安装包、签名、隔离安装或硬件矩阵。
2. **新增/变化的真机复核点**（按复核 §“下一候选的验收顺序”）：
   - P1-01：候选包贴图菜单开启真实像素比对→首帧、连续更新、手动关闭；
   - P1-03：候选真实窗口 Enter/复制按钮/双击/贴图四条入口“编辑→确认→再次打开”后旧矩形可选/可移/可删；
   - P1-02：真实硬件键盘在控制条/演示页/文本框/密码框/拼音组字/未知焦点间切换，允许 1 条、排除 0 条、暂停 0 条；
   - P1-04：真实 OCR 模型上制造破管，下一次识别在新握手后成功；
   - P2-01：候选工作台同页连续开录 A/B；P2-02/P2-04：真实 DPI/多屏、旋转贴图与滚动条视觉对照；
   - P2-03：运行中物理拔插副屏；P2-05：64 标签×多区间密集素材；P2-06：真实同源连击/双源同一次按键；
   - P2-07：Everything 1.4/1.5 重启与迟到回执。
3. **候选绑定**：下一候选必须包含 `26cbfc8..289b195`（文档提交另计）并重建原生件：选择钩子（`npm run build:selection`）、
   Everything 侧车（`npm run build:everything`，仓库内已入库重建 exe）。候选包哈希、CI run、签名状态按 R01 绑定到同
   一份验收记录后再开展隔离安装与硬件矩阵。
4. **未运行而非被修复的门禁**：`verify:package` / `verify:release`（需完整 electron-builder 产物与签名）、真实模型
   OCR、真实双屏拔插、真实硬件键盘矩阵、Everything 真机重启——这些属于真机/发布范围，不得由本记录表示通过。

## 6. 与复核结论的对应关系

| 复核结论中的要求 | 本记录 |
|---|---|
| 先关闭 4 个 P1，并在修复提交上保留曾失败的入口级回归 | §2 四项均带旧提交失败、修复树通过的入口/时序回归 |
| 按功能复验 P2，并回填修复 SHA、输入样本、结果与剩余设备条件 | §3 每项含提交、样本、结果、剩余条件 |
| 用修复后的实际候选执行 V/R | 未执行；§5 列出候选绑定与新增复核点 |
| 远端/CI/签名/候选证据口径 | 未变更；本记录未新增候选或 CI run 声明 |

文档提交在修复提交之后生成，因此本记录中的修复 SHA 固定指向代码提交；若后续有补充提交，以 `git log` 中
对应 ticket 的提交说明为准。
