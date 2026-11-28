# Highlighter 修复交付评审 · d7923ac

2026-11-28 · Windows / Electron · 分支 `feat/review-optimization-2026-11-26` · 评审区间 `b84eeba..d7923ac`

**结论：建议保留这批修复，重开 8 个原复核项。** 11 项中，桌面差分首帧、重标注确认、长贴图滚动导出这 3 项达到本轮代码验收条件。其余 8 项的原始样例大多已通过，但补充检查发现 **3 个 P1、7 个 P2**。优先处理取消区域录制后授权串到下一次录制、OCR 断管触发主进程未处理异常、原生焦点证据不足仍放行。三个问题均可在开发树上补回归。[原复核要求](2026-11-28-review-optimization-follow-up-delivery-review.md) · [被评审的修复记录](../plans/2026-11-28-review-follow-up-fix-record.md)

## 逐项结论

| 原项 | 本轮判定 | 已验证的改善与剩余问题 |
|---|---|---|
| P1-01 · 差分首帧 | 代码验收通过 | 副屏上的真实 Electron 域入口取得 531×355 首帧，来源 ID 匹配，会话交付 2 帧，手动停止后恢复内容保护。候选菜单入口待验。 |
| P1-02 · 敏感焦点 | 重开 | 缺少 `context` 的载荷已被 JS 丢弃。原生层仍可能给无法确定是否可写的对象签发 `safe`，见发现 3。 |
| P1-03 · 重标注确认 | 代码验收通过 | 隐藏 Electron 窗口加载正式截图页与 preload，Enter、复制、双击、贴图四个替换入口均携带可编辑快照。实际窗口二次编辑的 DPI 矩阵待验。 |
| P1-04 · OCR 管道 | 重开 | 显式注入迟到写错时，代际守卫能取消排队帧。真实断管和停读后恢复还有两条失败路径，见发现 2、4。 |
| P2-01 · 一次性开关 | 重开，上调 P1 | 同页连续两次正常开录的开关复位已通过。取消区域选框后，下一次快捷入口可继承授权，见发现 1。 |
| P2-02 · 长贴图滚动 | 代码验收通过 | 真实贴图页的顶部、中段分别导出红、绿。补测滚到底部时 `body.scrollTop=5430`，导出首行与末行采样均为蓝色。 |
| P2-03 · 来源身份 | 重开 | 多屏列表稳定时会拒绝错误来源。两次枚举所见拓扑不一致时仍可选错，见发现 5。 |
| P2-04 · OCR 导出排版 | 重开 | 中文竖排、窄框换行样例通过。组合字符绘制错误，裁掉的文字还能绕过测量次数上限，见发现 6、7。 |
| P2-05 · 快捷键成片 | 重开 | 300 个重复标签的成片尾帧和 78 种标签的披露通过。合法项目轨超过 500 条时，选区内的损失仍可完全漏报，见发现 8。 |
| P2-06 · 双源去重 | 重开 | 单来源间隔 90 ms 的两次按键能保留。两源完整上报仍可能把两次物理按键合成三条，见发现 9。 |
| P2-07 · Everything 轮询 | 重开 | 全静默实例已触发有界重选。状态命令成功、查询探针超时时，等待接口仍会提前报告就绪，见发现 10。 |

归因上，发现 1 的主进程暂存槽、发现 2 的逐次移除流监听器、发现 8 的编辑器读取上限在 `b84eeba` 中已存在。本次评审将它们列为原工单修复不完整。其中发现 1 的界面开关提前复位出自本批提交。下文优先级按最终版本对用户的影响评定。

## P1 · 发布候选前应修复

### 1. 取消区域录制后，另一次快捷录制会继承全局按键采集授权

工作台开启“仅本次”，点击区域录制。主进程把配置放进五分钟有效的 `pendingRegionCapture`，打开选框即返回 `{ok:true}`。页面随即把开关画成关闭。取消这个选框，再从“快速区域录制”选取另一个区域；新的入口没有传工作台配置，`createRecordWindow` 却会取走旧槽中的授权。本轮以仓库的录制域测试夹具驱动两个正式入口，第一次返回成功时控制窗数为 **0**，第二次创建的控制窗上 `_recordCaptureConfig.demoKeystrokes === true`。该字段会在开始录制时启用全局快捷键轨。另测仅聚焦已有录制的 `{ok:true, focused:true}` 也会消费页面开关。[工作台复位](../../config/routes/recording.js#L1420) · [暂存区域授权](../../main/domains/record/index.js#L3333) · [消费暂存配置](../../main/domains/record/index.js#L2137) · [录制域开关](../../main/domains/record/index.js#L1785)

**修复与验收。** 把授权绑定到发起它的选框或请求 ID，取消、关闭、替换选框时作废。工作台收到对应新录制已创建的回执后再消费选择。覆盖“取消 A → 快捷入口 B”，断言 B 的全局采集为关；覆盖“只聚焦”“选框取消”“真正创建 A → 再开 B”三个工作台状态转换。

### 2. OCR 子进程在写帧期间退出，可触发父进程未处理的流错误

`writeFrame` 的写回调和流的 `error` 事件共用 `finish`。写回调先报错时，`finish` 移除唯一的流错误监听器；Node 随后仍会在同一条 stdin 上派发 `error`。本轮从正式 `OcrService.recognize()` 发起识别，用真实 Windows 子进程代替模型侧车：子进程发送二进制协议就绪行，停读并在 250 ms 后退出。父进程写入 8 MiB 时得到 **`Unhandled 'error' event / write EOF`，退出码 1**，外层已安装识别 Promise 的拒绝处理器。标准 `Writable` 报 `EPIPE` 时也重现。仓库新用例直接调用替代的写回调，跳过了随后的流事件。此处实测为 Node 宿主，Electron 主进程的异常呈现仍待候选验证。[流监听器生命周期](../../main/services/ocr-service.js#L386) · [代际回收入口](../../main/services/ocr-service.js#L471) · [现有故障注入](../../test/ocr-service.test.js#L759)

**修复与验收。** 给每代 stdin 安装覆盖其整个生命周期的错误处理器，写回调与流事件共用幂等回收。用会真实关闭管道的子进程回归，断言父进程存活、该代只回收一次、后续调用在新握手后成功。

### 3. 原生层把缺失的可写性证据当作安全焦点

`get_CurrentControlType` 与 `get_CurrentIsPassword` 成功后，元素就被标为可用。即使已拿到 ValuePattern、读取其只读属性却失败，只要其他敏感标志均为假，策略仍返回 `safe`。另一路在拿不到匹配的焦点元素时，会改读焦点 HWND 对应的元素；对于承载虚拟子控件的宿主，这可能只证明容器的属性。原生自测输入“前台有效、元素可用、无可写或只读证据”，`Ctrl+V` 得到 **`accepted:true, context:'safe'`**。副屏 WinForms 补测中，密码子控件判为 `password`，其父窗体按句柄查询判为 `safe`。后者验证了选错层级的后果；本轮未用硬件键盘采集敏感输入。风险内容为快捷键标签。[属性读取](../../vendor/selection-hook/src/windows/core/keyboard_focus.cc#L161) · [HWND 回退](../../vendor/selection-hook/src/windows/core/keyboard_focus.cc#L287) · [默认接受分支](../../vendor/selection-hook/src/windows/core/keyboard_focus.h#L185)

**修复与验收。** 区分“已确认非文本控件”“已确认只读”和“属性读取失败或焦点身份不确定”。后者返回 `unknown`。在允许的演示页上保留正例，并对属性读取失败、只能取得容器、虚拟密码子控件分别断言 IPC 和事件轨新增数为 0。现有探针对可写富文本同时接受 `text` 和 `safe`，应收紧该断言。[探针预期](../../scripts/probe-keyboard-focus-context.js#L156)

## P2 · 恢复、内容一致性与性能

### 4. OCR 请求超时后，仍排队的旧帧会在恢复通畅时写出

两个 `requestFrame` 使用 25 ms 截止时间，第一帧写回调暂缓。两个调用均超时后，实测 `pending.size=0`、`ready=true`、写入次数为 1；让第一帧写回调成功，写入次数变成 **2**，仍是原子进程。第二张已经无人等待的图片继续占用识别资源；若写回调持续不返回，后续请求会继续排在同一条链上。代际校验覆盖了进程替换，缺少对单个排队请求过期的检查。[排队帧守卫](../../main/services/ocr-service.js#L408) · [请求截止处理](../../main/services/ocr-service.js#L464)

**修复与验收。** 跟踪未开始写、写入中、已完整写入三个状态。写前跳过已过期的请求，为持续停滞的在途写设置回收期限。覆盖“全帧已写但推理慢”和“半帧停写”两种时序，前者保留正常结果超时语义，后者恢复后不再写排队的过期帧。

### 5. 单屏回退接受相冲突的来源 ID 和多条匿名来源

显示器列表在 `await getSources()` 前取得。热插拔或驱动重枚举时，列表与随后返回的来源可能属于不同拓扑。直接调用生产 `pickScreenSource`，目标 ID 为 A、`singleDisplay:true`、唯一来源明确标为 B，得到 **`ok:true, matched:false` 并返回 B**；两条匿名来源也会返回第一条。调用方随后按 A 的坐标裁剪。此项是对生产选择器的确定性验证，物理拔插仍待验。[两次枚举](../../main/domains/pin/index.js#L1168) · [单屏回退](../../pin/pin-screen-diff.js#L286) · [现有单屏样例](../../test/n05-pin-screen-diff.test.js#L789)

**修复与验收。** 排除法限于拓扑仍为单屏、只有一条可用来源且该来源缺 ID 的情况。有冲突 ID 或多条匿名来源时跳过帧并重试。覆盖上述两组反例，并断言目标 ID 恢复后只有目标屏像素送达。

### 6. 按 Unicode 码点单独绘制，拆散了 OCR 译文中的组合字符

在隐藏 Electron 的正式贴图页渲染“测试👩‍💻”，浏览器认定有 3 个字素。导出测量和画布实际产生 5 次文字绘制，其中“👩”、连接符和“💻”三次都落在相同的 x、y 坐标。PNG 无法保留浏览器塑形得到的那个组合字形。现有逐行墨迹边界测试可在相同边界内继续通过。[DOM 分割](../../shared/ocr-text-overlay.js#L181) · [画布逐项绘字](../../pin/pin-view-export.js#L474)

**修复与验收。** 水平行按浏览器已排定的文字段整体塑形，竖排至少保留完整字素和方向。对含 ZWJ 表情、组合音标及需连写文字的译文，对照可见叠层与 PNG 字形，并继续验证原有中文竖排与窄框换行。

### 7. OCR 测量预算只计算保留的字符，裁剪区外仍逐字读取布局

循环以 `glyphs.length` 限制工作量；每次先调用 `Range.getClientRects()`，之后才判越界并 `continue`。在正式贴图页给窄框放入 3,000 字原文，实测只保留 **3** 个字形，却同步读取布局 **3,000** 次，超过所声明的每块 512 字预算。多个此类块会把成本叠加到贴图渲染线程。本轮测得的是读取次数，未外推具体卡顿时长。[逐字读布局](../../shared/ocr-text-overlay.js#L187) · [越界跳过](../../shared/ocr-text-overlay.js#L200) · [全局扣减](../../shared/ocr-text-overlay.js#L293)

**修复与验收。** 用已尝试测量的次数消耗每块和全局预算，并显式处理未完整测量的块。对长窄框和多块裁剪语料断言 DOM 读取次数上限，同时核对可见区域内的导出文字。

### 8. 录屏轨先截到 500 条再应用剪辑选区，尾部有效按键会全部消失

录制域与项目允许 2,000 条快捷键。编辑器在读取轨道时先取前 500 条，新的截断提示只统计随后进入导出规划器的事件。以 600 秒、每秒一次 `Ctrl+S` 的合法项目复验：全片计划 500 条，`truncated=false`；只保留最后 100 秒，选区中明明有 100 条，**计划为 0，`dropped=null`**。预览和成片会一起空白，用户看不到原因。500 条读取上限已存在于基线，本轮“精确披露”遗漏了这一层。[项目轨上限](../../main/services/recording-project-service.js#L60) · [读取时截断](../../record/trim-controller.js#L126) · [随后才投影选区](../../record/trim-controller.js#L668)

**修复与验收。** 在项目轨已有上限内保留原始事件，先按选区投影，再对确实需要渲染的事件应用预算。同一份 600 条样例剪到尾段应保留 100 条；全片若保留 500 条上限，确认前应准确披露其余 100 条及源时间范围。

### 9. 就近配对可能让两次完整双报的按键变成三条

两次 `Ctrl+Z` 的全局时间为 `[1000,1090]` ms，控制条两次均晚 110 ms，为 `[1110,1200]`。每个同次双报都在 120 ms 窗口内。生产函数却把第一条控制条事件与第二次全局事件配对，返回 **`[1000,1090,1200]`**。两源均无漏报，区别于原交付已登记的“两个来源各漏一次”。控制条在处理 DOM 事件时取 `Date.now()`，渲染线程延迟会进入这个时间差。[控制条打点](../../record/record.js#L370) · [就近配对](../../main/domains/record/index.js#L313)

**修复与验收。** 对同标签的两条按时间排序的来源做保持先后次序的一对一匹配，优先保留可匹配的两对。测上述时序、单源连击及一侧漏报，分别断言条数与事件时间。

### 10. Everything 查询已超时，等待接口仍可能报告就绪

实例可回答版本和 `IPC_IS_DB_LOADED`，同时不回应查询。生产错误分支保留 `db_loaded=true`，`status_from_cache` 取出展示快照，`wait_ready` 又仅以 `running && dbLoaded` 判就绪。用生产 Rust 的状态与轮询函数、相同的就绪谓词注入“数据库已加载＋查询超时”，得到 **`ready:true, elapsedMs:0, probeTotal:0`**。这会在查询通道可用之前结束等待。另外，真实候选排名仅把 `send-failed` 视为探针失败，`timeout` 仍可能与可应答的空索引实例打平。[探针错误快照](../../native/everything-search/src/main.rs#L897) · [等待判据](../../native/everything-search/src/main.rs#L983) · [候选排名](../../native/everything-search/src/main.rs#L444)

**修复与验收。** 内部保留本轮查询是否应答，展示可继续反映运行状态。就绪判定要求查询通道应答，重选时优先选能回答的候选。对“旧实例状态正常但查询超时、新实例查询成功并返回 0 条”驱动真实排名逻辑，验证选中新实例后才结束等待。

## 验证范围与交付声明

| 证据 | 本轮结果 |
|---|---|
| Git 与 CI | 开始评审时工作树干净，HEAD 为 `d7923ac1a00bf5e19852c1b585e7c935a9d98578`。区间含 14 个提交、49 个文件。直接查询远端分支仍为 `b84eeba`；按完整 HEAD 查询 Actions 返回空列表。最近的分支绿灯属于 `25ee84c`。将来若有红灯，须按该次任务和失败断言归因。[最近一次分支 Windows CI](https://github.com/SherUnlocked-4869/Highlighter/actions/runs/46106195872) |
| 本轮自动化 | 将区间内变更的全部 16 个 `test/*.test.js` 交给 `node --test --test-concurrency=2`，**303/303**，0 跳过。Everything 的 `cargo test --locked` **20/20**。选择钩子源与本地二进制 build-id 一致，均为 `hl_7a937464fd5df17d8a22d083cbfe8f89e5e2490398473e6ce20141ac120ff584`。另跑修复记录 §4 的录屏五文件组为 **171/171**，属于上述 303 例的子集；§7 仍提到 174/174。 |
| 本轮真实进程 | 副屏屏幕差分探针 `productionEntryProven:true`，显式采样成功 1 次，会话共交付 2 帧，保护调用为 `[true,false]`。焦点探针原有 6 个句柄用例均满足其现行预期，可写富文本本次实判 `text`。真实 FFmpeg 探针 **19/19**，300 次重复的 29.9 s 尾帧亮度 69.48。另行实测的断管、排版等反例见各发现。 |
| 原交付登记的门禁 | 全量 `npm test` 3391/3391、E2E 21/21、长图 64/64、静态检查，以及 loaded 93.5%、native 96.09%、critical 93.76% 均为开发记录数字。本轮独立重跑范围见上两行。loaded 成功口径为串行，默认并发流程曾命中 clipboard lease 抖动。[原门禁记录](../plans/2026-11-28-review-follow-up-fix-record.md#L205) |
| Windows 导出边界 | 用同一 500 事件、64 标签样例分别生成基线与 HEAD 的真实 argv。HEAD 最长素材路径为 158 字符时，参数以单空格拼接为 35,111 字符，实际创建进程返回 `ENAMETOOLONG`，基线同样失败。此样例验证了 Windows 启动编码器的边界。 |
| 候选与真机 | 当前 HEAD 尚无同 SHA 的构建、签名或安装验收结果。V01–V10、R01–R03 对本候选仍待执行，尤其是物理拔插、真实硬件键盘、ONNX 侧车、Everything 1.4/1.5 和安装升级。上一候选的 unsigned 包与本次开发树分开登记。[候选验收台账](../plans/2026-11-28-follow-up-acceptance-status.md) |

### 重现 OCR 父进程异常

在仓库根目录的 PowerShell 运行下列样例。它使用独立 Node 父子进程和内存中的测试数据，实际走就绪握手、帧编码和 Windows 管道。当前 HEAD 在 Node 24.22.1 下打印 `write EOF`，随后 `$LASTEXITCODE` 为 1。修复后应由识别请求收到受控错误，父进程正常结束。

```powershell
@'
const { spawn } = require('node:child_process')
const { OcrService } = require('./main/services/ocr-service')
const service = new OcrService({ tempDir: '.', idleTimeoutMs: 0 })
service.validateFiles = () => {}
const childScript = [
  'console.log(JSON.stringify({type:"ready",protocol:{imageTransfer:"stdin-frame-v1"}}))',
  'setTimeout(() => process.exit(0), 250)'
].join('\n')
service.spawnSidecar = () => spawn(process.execPath, ['-e', childScript], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
})
service.recognize(Buffer.alloc(8 * 1024 * 1024))
  .catch(error => console.log('recognition rejected', error.code || error.message))
'@ | node
$LASTEXITCODE
```

建议先将发现 1–3 的反例纳入回归，随后按发现 4–10 验收各原项。进入候选验证时，把修复 SHA、重建原生件、包哈希和 CI run 关联到同一条记录。
