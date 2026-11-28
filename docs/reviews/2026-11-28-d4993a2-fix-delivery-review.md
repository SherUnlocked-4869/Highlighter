# d4993a2 修复交付复核

2026-11-28 · Windows / Electron 43.8.3 · `feat/review-optimization-2026-11-26`

**建议暂缓候选验收。** 上一轮 6 项都有通过的原始回归用例。这次沿正式入口补测后，仍有 **2 个 P1 和 3 个 P2**。优先修录制窗口的创建与回滚：已回执取消的区域控制窗仍能启动项目，已经开始写入的全屏录制也可能被较早的区域请求夺走控制权。

评审区间为 `05d0dde..d4993a2`，共 2 个提交、28 个文件。产品、测试及原生件变更在 `09d79ba`；`d4993a2` 追加交付证据并校正措辞。以下区分上一轮的特定反例、相邻路径的缺陷，以及需要候选包验证的事项。[上一轮评审](2026-11-28-05d0dde-fix-delivery-re-review.md) · [开发交付记录](../plans/2026-11-28-05d0dde-review-fix-record.md)

## 上一轮 6 项逐项裁定

| 上轮项 | 独立复核结果 | 裁定 |
|---|---|---|
| P1-01 区域选框撤销 | 桌面源枚举期间取消或替换 A，A 建窗数为 0；在加载期间取消并让两个页面正常加载完，也能拆窗。加载拒绝、重复确认和并发入口另见本轮发现 1、2。 | 保持打开 |
| P1-02 五分钟后恢复旧音频偏好 | 同一请求立即确认或延后 301 秒，均保留区域模式、`ultra`、本次快捷键开关和明确关闭的两路音频，回执 `created:true`。 | 关闭 |
| P1-03 UIA 获取模式或句柄失败 | 三类失败证据在本机原生件中均拒绝组合键，JS 过滤回归通过。另以真实 WinForms 按钮 HWND 验证允许正例。 | 关闭已报告的失败分支；硬件及 provider 故障注入待验 |
| P2-01 屏幕 ID 不变时互换布局 | 上轮固定贴图的换位与缩放反例通过，过渡帧不交付像素，后续取到标记 22 或正确的 800×400 裁剪。贴图自己移动或缩放的反例见发现 3。 | 原拓扑反例关闭 |
| P2-02 竖排译文方向 | 单个 `I` 的 90° 方向错误已修复，仓库的中英混排、中文列序和 ZWJ 表情样例通过。普通竖排标点、带下伸笔画的拉丁字母仍偏离屏幕，见发现 4。 | 单字母方向关闭，导出一致性保持打开 |
| P2-03 Everything 查询静默 | 冷启动收到静默快照会等待，未命中缓存的查询不会提前发出，应答的空索引可就绪。已有侧车时的状态刷新见发现 5。 | 原搜索入口反例关闭，状态页仍有缺口 |

**回执措辞已校正。** 区域返回 `created:true/false`；显示器和窗口模式沿用 `{ok:true}`。页面在 `ok:false`、`focused:true`、`created:false` 时保留一次性选择，其余返回值会消费选择。开发记录与页面实现相符。[页面判定](../../config/routes/recording.js#L303) · [交付记录校正](../plans/2026-11-28-05d0dde-review-fix-record.md#L93)

## P1 · 录制授权与会话所有权

### 1. 页面加载失败后，已撤销的区域控制窗仍可启动录制项目

区域 A 开启麦克风和全局快捷键。让控制页加载成功、帧页加载保持等待，关闭选框，工作台收到 `{ok:true,created:false}`。随后让帧页的 `loadFile()` 拒绝。正式录制域仍报告 `isTaskActive() === true`，帧窗和控制窗都存活。再以“两路选项均关”的配置启动全屏录制，只得到 `focused:true`，并显示原区域控制窗。以该窗调用正式 `startSession()` 能创建区域项目 `project-1`；其配置仍为 `demoKeystrokes:true`、`audio.microphone:true`。实测使用仓库的窗口和存储夹具，未采集麦克风或硬件输入。[提前发布活动窗口](../../main/domains/record/index.js#L2306) · [页面加载及撤销检查](../../main/domains/record/index.js#L2429) · [创建会话](../../main/domains/record/index.js#L2891)

加载拒绝会绕过 `Promise.all` 后面的拆窗逻辑。外层捕获只撤销请求登记。即使加载最终成功，取消回执发出后、帧页完成前，再点“快速区域录制”，也会经 `focusActive()` 对这扇待拆控制窗调用 `show()`。现有用例在取消后直接放行成功加载，缺少这两个时序。[异常处理](../../main/domains/record/index.js#L2188) · [聚焦逻辑](../../main/domains/record/index.js#L1357) · [已有加载期取消测试](../../test/record-domain.test.js#L1575)

**修复验收。** 将正在加载的窗口保留在创建请求内，授权有效且两个页面就绪后再发布为活动窗口。任一页面失败、请求撤销或窗口提前关闭，都应清理该请求的帧窗、控制窗及其注册的媒体处理器。分别让帧页与控制页拒绝，并在加载悬停时取消后立即重试。断言旧窗不能显示、不能启动项目，下一次录制只拿到自己的配置。

### 2. 区域请求和全屏入口并发，可让已开录的窗口无法继续写入

暂停区域 A 的桌面源枚举，通过全屏入口创建 B 并调用 `startSession()`。B 的第一个 3 字节数据块得到 `committedBytes:3, sequence:1`。此时恢复 A，工作台对 A 返回 `created:true`，两套帧窗和控制窗共 **4 扇**仍然存活。B 已失去所有权，同一发送者、同一会话提交第二块即报 **“无效的录制窗口”**。用 `05d0dde` 的录制域重放也得到相同结果。这是本轮仍未覆盖的并发缺陷，可能中断正在录制的素材。[全屏快捷入口](../../main/services/function-router.js#L108) · [入口仲裁](../../main/domains/record/index.js#L2206) · [建窗前检查](../../main/domains/record/index.js#L2258) · [写入发送者校验](../../main/domains/record/index.js#L2468)

同一请求也可重入。区域控制页已创建、帧页仍在加载时再次确认同一选框，第二个调用会聚焦临时控制窗并撤销自己的请求。实测第二个调用拿到窗口，工作台回执却为 `created:false`，首次创建最终返回 `null`，两扇窗均被关闭。截图页的录制按钮在这次 IPC 返回前可以再次触发。[录制按钮异步分支](../../capture/capture.js#L5168) · [选框收到建窗结果](../../main/domains/capture/index.js#L1416)

**修复验收。** 在第一个异步步骤前仲裁所有录制入口，对同一请求复用正在进行的创建；不同入口须遵守已有录制优先的规则。原请求恢复时还应检查当前会话所有者。测试需同时验证窗口数、两个调用者的回执，以及获准开录的一方能持续追加第二块并完成收尾。附录给出两个 P1 的可运行样例。

## P2 · 屏幕差分、译文输出与搜索状态

### 3. 采集时移动贴图会交付旧屏像素，缩小贴图后还会持续采集旧尺寸

固定两块显示器的布局，在生产 `startRealPixelCompare()` 中仅移动贴图。枚举桌面源期间将贴图从 `x=100` 移到另一屏的 `x=2020`。夹具在差分 IPC 发送端收到的首帧仍携带旧矩形和标记 **11**，下一次采样才得到新位置的标记 **22**。另测在同一会话将内容窗口从 400×200 缩到 100×80，两次超过采样间隔的采样仍各发出 **400×200** 像素，持续包含缩小后窗口之外的区域。这里使用两屏带标记的像素和可变的窗口边界，未抓取用户屏幕内容。[首次规划](../../main/domains/pin/index.js#L1174) · [枚举后复核](../../main/domains/pin/index.js#L1226) · [会话保存尺寸](../../main/domains/pin/index.js#L1307) · [正式缩放入口](../../main/domains/pin/index.js#L3315)

**修复验收。** 现有重算只更新显示器列表，继续使用第一次的 `pinBounds`、`imageBounds`；会话宽高也只读取一次。每次采样应读取当前内容矩形，枚举返回后再次核对窗口、显示器和裁剪映射。测试跨屏移动的过渡帧无像素交付，下一帧为 22；再测试缩小后连续两帧都只交付 100×80。[重算输入](../../pin/pin-screen-diff.js#L340) · [IPC 交付](../../main/domains/pin/index.js#L1334)

### 4. 逐字居中无法还原竖排标点位置和西文基线

沿用仓库 D 阶段的真实贴图、`capturePage()`、导出 IPC 和像素比较器，增加下列输入。在副屏 125% 的同一窗口取样，实测字号约 24.05 CSS px。表中 IoU 是整个文字框内两张图深色像素的交并比；0 表示墨迹完全不相交。[正式比较器](../../scripts/probe-pin-view-export.js#L333) · [原有方向断言](../../test/u02-pin-renderer-runtime.test.js#L286)

| 输入 | 屏幕与导出 PNG 的差异 | IoU |
|---|---|---:|
| `I` 对照 | 两边墨迹均宽 18.4、高 2.4 CSS px，方向一致 | 0.917 |
| `。` | 两边各 33 个深色像素，导出质心向左偏 13.36、向下偏 4.99 CSS px | 0 |
| `、` | 屏幕与导出的墨迹也完全分离，横向偏移约 13.49 CSS px | 0 |
| `g` | 两边均为 169 个深色像素，外接框同为 19.2×12.8，导出整体向右偏 6.4 CSS px | 0.257 |

直立分支调用普通横排 Canvas 的 `fillText`，缺少浏览器竖排字形与标点位置；侧排分支又把每个字符的墨迹单独移到盒子中心，使 `g` 的下伸笔画失去同一文字段的基线。建议在导出时复用能保留浏览器竖排字形的渲染结果，或分别保留竖排字形与侧排整段基线。将上述三种失败样本加入现有 D 阶段，同时断言墨迹重叠与质心偏移，继续保留 `I`、中文及 emoji 正例。[方向测量](../../shared/ocr-text-overlay.js#L208) · [侧排逐字居中](../../pin/pin-view-export.js#L529) · [直立绘字](../../pin/pin-view-export.js#L557)

### 5. Everything 侧车仍运行时，状态页绕过五秒刷新间隔，继续发布旧状态

通过正式 `EverythingService.refreshStatus()` 和仓库的可控侧车，先取得一次成功应答，再把查询通道切为静默。将时钟推进到 **6.1 秒、12.2 秒** 后各刷新一次，仍得到 `phase:"ready", queryAnswered:true`；侧车总共只收到最初的一条 `status`。反向测试中，初始静默后恢复应答，刷新仍返回 `waiting`。单独调用搜索就绪入口会重新检查，静默时不会发送查询，恢复后能进入 `ready`。观察到的问题限于状态刷新。[状态 IPC](../../main/ipc/search-ipc.js#L5) · [正式入口](../../main/domains/search/index.js#L807) · [提前返回](../../main/services/everything-service.js#L128)

**修复验收。** `sidecarActive || probedRecently` 把“桥接侧车活着”作为复用旧样本的充分条件；该捷径已存在于评审基线。保留五秒内的合并与节流，超过时限的显式刷新应复用现有侧车发出一次 `status`。分别测试就绪→静默、静默→就绪；要求状态更新，且只增加一次轻量状态请求，不启动内置 Everything。[现有缓存测试](../../test/everything-service.test.js#L385) · [共享就绪谓词](../../main/services/everything-service.js#L51)

## 验证记录与边界

| 本轮独立执行 | 结果 |
|---|---|
| 变更的全部 10 个 Node 测试文件 | `node --test --test-concurrency=2` **229/229**，0 失败、0 跳过；另跑选择钩子 build-id 测试 **1/1**。 |
| 原生件 | Everything 的 `cargo test --locked` **26/26**。选择钩子加载件与源 build-id 同为 `hl_a6250ccb789dcc6ca55c2bfd2d6eb1092b33e88a0e2c6906e2d763671f8b3b00`。入库侧车 SHA-256 为 `A51CFC2DFA1D24F0CCA3BFA2DB52FE5C4AE79F2EDB5F106CB13A84740887FE24`。 |
| 副屏与真实进程 | 屏幕差分 `--frames 3` 的六项判定均为 true，含 `productionEntryProven`；键盘焦点探针 **23 PASS**；真实 Everything **1.4.1.1032** 的 `status` 与 `wait-ready.status` 均返回 `queryAnswered:true`。竖排补测使用真实 Electron 合成及 PNG 输出。 |
| 工程门禁 | `npm run check` 通过（635 个 JS 文件），`check:version` 确认 5.1.1，`test:long-capture` 通过。 |
| Git、CI | 开始评审时工作树干净，本地 HEAD 为 `d4993a292e07b04139113d7b3c9c871fb6474469`。直接查询远端分支仍为 `b84eeba05f66b51f68a4894f0b7aecc92efb6fad`，按完整 HEAD 查询 Actions 得到空列表。 |

两处证据措辞值得区分。仓库焦点探针的非文本正例实际传入的是 WinForms **窗体 HWND**；本轮另换为普通 **Button 控件自身 HWND**，实测 `safe_focus`。关于“仅 `S_OK + NULL`”的表述，源码判断用的是 `SUCCEEDED/FAILED`。微软为该方法定义的成功返回值为 `S_OK`，而 `SUCCEEDED` 本身接受全部非负 HRESULT。本轮确认了已报告的三个失败分支，未观察到 provider 返回其他成功码导致放行。[探针目标](../../scripts/probe-keyboard-focus-context.js#L189) · [原生判断](../../vendor/selection-hook/src/windows/core/keyboard_focus.cc#L179) · [微软方法契约](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-getcurrentpatternas) · [微软宏定义](https://learn.microsoft.com/en-us/windows/win32/api/winerror/nf-winerror-succeeded)

全量 **3448/3448**、E2E **21/21**、三组覆盖率及 clipboard lease 首跑和重试记录来自开发交付，本轮未独立重跑。真实 UIA provider 故障、硬件键盘矩阵、UIPI 静默、物理拔插与 V/R 发布候选验收仍待执行。[开发门禁与候选边界](../plans/2026-11-28-05d0dde-review-fix-record.md#L106)

## 附录 · 两个 P1 的复跑命令

在仓库根目录用 PowerShell 和 Node 24 运行。样例复用仓库的窗口、录制和存储替身，加载正式录制域，在独立 Node 进程内执行。当前 HEAD 输出的三行分别为“取消后仍聚焦、仍活动”“第一块已提交 3 字节”“第二块被拒绝”。

```powershell
@'
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const file = path.resolve('test/record-domain.test.js')
const fixture = new Module(file, module)
fixture.filename = file
fixture.paths = Module._nodeModulePaths(path.dirname(file))
const originalRequire = fixture.require.bind(fixture)
fixture.require = id => id === 'node:test' ? () => {} : originalRequire(id)
fixture._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = createProjectHarness', file)

async function region(h) {
  const receipt = h.controller.workbenchStart(null, {
    mode: 'region', config: { demoKeystrokes: true, audioMicrophone: true }
  })
  await h.tick()
  const args = { regionRequestId: h.regionSelections[0].regionRequestId, display: h.display,
    selectionBounds: { x: 30, y: 20, width: 120, height: 80 } }
  return { receipt, args }
}

async function review() {
  const loading = Promise.withResolvers(), loadStarted = Promise.withResolvers()
  const h = fixture.exports({ loadFile(page) {
    if (path.basename(page) === 'frame.html') { loadStarted.resolve(); return loading.promise }
  } })
  const a = await region(h)
  const creation = h.domain.createRecordWindow(a.args).catch(e => e.message)
  await loadStarted.promise
  h.regionOverlays[0].emitClosed()
  const cancelled = await a.receipt
  loading.reject(new Error('frame load failed'))
  await creation
  const retry = await h.controller.workbenchStart(null, {
    mode: 'display', config: { demoKeystrokes: false, audioMicrophone: false }
  })
  console.log('rollback', cancelled, retry, h.domain.isTaskActive())

  const sources = Promise.withResolvers(), entered = Promise.withResolvers()
  let calls = 0
  const k = fixture.exports({ deferScreenSources() {
    if (++calls === 1) { entered.resolve(); return sources.promise }
  } })
  const pending = await region(k)
  const createA = k.domain.createRecordWindow(pending.args)
  await entered.promise
  const b = await k.domain.createRecordWindow({ display: k.display, mode: 'display' })
  const sender = k.eventFor(b)
  const session = await k.controller.startSession(sender)
  const chunk = sequence => k.controller.appendChunk(sender, {
    sessionId: session.id, sequence, bytes: 3, arrayBuffer: Buffer.from([1, 2, 3])
  })
  console.log('before', await chunk(1))
  sources.resolve()
  await createA
  console.log('after', await chunk(2).catch(e => e.message))
}
review().catch(e => { console.error(e); process.exitCode = 1 })
'@ | node
```
