# Highlighter 内存优化方案（承接 2026-10-26 调研）

- 日期：2026-10-26（Asia/Hong_Kong）
- 性质：**方案梳理，不含实现**。本文只定义目标、工作项、依赖、验收口径与排期，不修改任何代码；本次未运行 benchmark、未启动可见窗口、未做真机验收。
- 上游文档：`docs/research/2026-10-26-memory-and-architecture-assessment.md`（下称"调研"）。
- 复核基准：`926e4c9`，`package.json` 4.1.6。调研写于 4.1.5、`ee08225`，行号已漂移 3–6 行；本文行号均为**复核后实测**，以函数名/符号为准更稳。
- 给读者的第一句话：**先建观测与基线，再做"可回收"改造；本轮能拿到的收益主要来自隐藏窗口与空闲服务，不是来自 React/Tauri。** 任何"降低 X MiB / 百分之多少"的承诺都要等 §3 的基线出来。

---

## 0. 一页摘要

| 组 | 工作项 | 目标 | 估算（人日，未评审） | 依赖 |
| --- | --- | --- | ---: | --- |
| **M0 观测** | W0 窗口角色映射 + 原生进程补齐 + 基线报告；W15 启动分段埋点 | 任何优化前后可比；能区分"没回收"和"本来就小" | 3.5–6 | 无 |
| **M1 低风险回收** | W1 OCR 热启动回收；W2 usage worker / cursor helper 空闲退出；W3 截图初始化缓冲释放 | 关闭三条"永不回收"的服务路径 + 释放截图常驻引用 | 3–4.5 | 可与 M0 并行 |
| **M2 有状态回收** | W4 回收框架；W5 搜索窗口；W6 主窗口（托盘策略 + 有状态销毁）；W7 划词结果未固定窗口 | 隐藏窗口不再长期持渲染器 | 10–15 | M0、W4 |
| **M3 图片与预算** | W9 贴图资源化；W10 长截图峰值；W11 缓存预算统一；W12 历史缩略图路径 | 压 4K/8K 峰值与常驻图片副本 | 8–13 | M0；W9 与 W10 相互独立 |
| **M4 启动与懒加载** | W13 AI SDK 懒加载；W14 渲染器路由/语言包按需 | 只改善冷启动与未用功能，不改常驻平台 | 5–8（条件性） | 需先改架构/测试规则 |
| **决策门** | P4 同功能宿主原型（Tauri / Windows 原生常驻核心） | 仅当 M1–M3 后仍不达目标才启动 | 10–15（原型） | 全部 M0–M3 |

**合计（M0–M3）约 25–39 人日**；M4 与决策门按条件触发。估算只用于排序，不进对外承诺。

**明确不做（详见 §9）**：不用 React 替换 Electron；不在 M1–M3 完成前启动 Tauri 迁移；不重复实现剪贴板/OCR/Everything 已有的回收机制；不把清空工作集（EmptyWorkingSet）当作优化；不承诺固定 MiB 或百分比。

---

## 1. 从调研到方案：复核后的口径

### 1.1 调研结论复核

对调研的每条源码主张做了只读复核（22 条）：**12 条确认、9 条需修正、1 条未复核**。修正不改变结论方向，但改变实施细节与引用位置。完整表见附录 A；影响方案的六条：

1. **OCR 缺口确认，但有两个"反向缺口"调研没写**：`hotStart` 从 true 改 false 时不会停止已在跑的服务；`idleTimeoutMs` 在构造时快照，改设置不生效。见 `main/services/ocr-service.js:82`、`main/domains/settings-effects/index.js:48-62`、`main.js:256`。
2. **OCR `stop()` 有在途请求竞态**：`stop():283` 先置 `process=null`，`handleExit:179` 因守卫早退，在途识别不即时 reject，只能等自带的 120 s 超时；迁移流程的 `allSettled` 会被拖住。这条比"热启动不回收"更容易造成用户可见的"迁移卡住"。
3. **贴图不是"隐藏窗口"，而是关闭即销毁**（`pin:close`→`close()`，`main/domains/pin/index.js:612`）。调研把它与"只隐藏"并列会误导。贴图的真问题是**主进程常驻 data URL + 无字节预算**（§3.3），不是窗口生命周期。
4. **"Node utility 无法确定"已可关闭**：全仓只有两个 `utilityProcess.fork`，都带 `serviceName`（`usage-worker-client.js:25`、`selection-hook-service.js:96`）；Electron 43.8.3 的 `ProcessMetric` 已含 `pid/name/serviceName/creationTime`。观测不需要新基建，只需要不丢字段。
5. **图片缓存的位置与调研不符**：马赛克 16 MiB 在 `capture/capture.js:265`（不在 `annotation-geometry.js`）；放大镜 32 MiB 在 `capture/magnifier-sampler.js:39`（不在 `shared/`）；`initData` 落点在 `capture/capture.js:4337-4353`（不是 4190）。长截图"2 亿像素"只是保存路径上限，复制/贴图先被 8e7 px 拒绝（`long-capture/index.js:246`）。
6. **"设置页加载所有路由"低估了范围**：主窗口与设置页是**同一个** `config/config.html`（`main.js:826`），34 个静态 script，首屏 `route=home` 却已解析 ≈256 KB 路由脚本 + 177 KB 语言包 ≈ 430 KB 非首屏字节。但收益是**启动/解析**，不是常驻。

### 1.2 复核口径（写死在验收里）

- Working Set（含共享驻留页，逐进程相加会重复计数）、Private Bytes（私有提交）、私有工作集、GPU 显存**分别报**；只报一项视为未测。
- 单机单次是量级，不是结论；每格标样本数，不足 15 不称 P95。
- Release 构建、关闭 DevTools、相同数据与功能开关；见 §3.4。
- 不把"清空工作集后的瞬时下降"当作优化收益；不把 `app.getAppMetrics()` 当全部（它看不到任何 `spawn()` 出来的 sidecar）。
- **功能不回归优先于内存数字**：丢草稿、丢贴图、掉划词延迟，都是方案失败，不是权衡。

### 1.3 调研诉求 → 工作项映射（确认没有漏项）

| 调研诉求 | 调研位置 | 本方案 |
| --- | --- | --- |
| 主窗口空闲销毁；自启动仅托盘 | §3.1、§6 一.3 | **W6a**（托盘策略）、**W6b**（有状态回收） |
| 划词工具条：对比按需创建/空闲回收/原生化 | §3.1、§6 一.5 | **W8**（先测，再决定） |
| 搜索窗口延迟释放 | §3.1 | **W5** |
| 划词结果未固定窗口回收 | §3.1 | **W7** |
| OCR 热启动后的空闲生命周期 | §3.1、§6 一.2 | **W1**（另含 stop 竞态与设置联动） |
| usage worker 空闲退出 | §3.1 | **W2**（另含 cursor helper） |
| 图片初始化引用、data URL→资源 ID、总量预算 | §3.3、§6 二.1–3 | **W3**、**W9**、**W10**、**W11** |
| 历史缩略图/缓存只限项数问题 | §3.3 | **W11**、**W12**（先测） |
| `sharp`/AI SDK/路由懒加载 | §6 二.4 | **W13**、**W14**（条件性，先改规则） |
| 观测、基线、验收口径 | §2、§6 一.1、§7 | **M0（§3）** 与 **W15** |
| Tauri / 原生常驻核心选型 | §5、§6 三 | **§10 决策门**（仅条件触发） |
| React 的定位 | §4 | **§11**（明确不做宿主替换） |

**调研未覆盖、复核新增的 4 条**（已并入上面工作项）：OCR `stop()` 的在途请求竞态与 `hotStart=false`/`idleTimeoutMs` 不生效（W1）；`cursor-provider` 的 `SmartSelect.exe` 首次查询后常驻（W2）；历史缩略图"每次读盘 + base64"而非常驻缓存（W12）；Node utility 与 benchmark 进程归属其实可辨（M0，见附录 A A18/A21/A22）。

---

## 2. 目标

不设固定百分比，设五项可判定的目标（具体数值待 §3 基线填入）：

| 层 | 目标 | 判定方式 |
| --- | --- | --- |
| G1 可观测 | 任意时刻能回答"哪个窗口/角色占了哪个 PID 多少内存" | §3.1 的映射能力 + 快照脚本 |
| G2 不累积 | 重复"打开—关闭/隐藏—再打开"30 次后，平台值与进程数回到基线噪声内 | 30 次循环的前后差、回归斜率 |
| G3 回收到位 | 已定义为可回收的隐藏窗口/空闲服务，在策略超时后**进程或渲染器确实退出** | 单测（注入时钟）+ 真实快照双证 |
| G4 体验不退化 | 首次划词、截图可交互、重开主窗口的中位数/P95 在基线预算内 | `main-window.reopen`、`main-window.ready`、首次划词探针 |
| G5 峰值受控 | 4K/8K 截图、20 贴图、长图导出有明确字节预算且超限有可见失败路径 | 峰值探针 + 预算断言 |

**注意 G3 与 G4 的冲突**：主窗口/搜索窗口从"隐藏复用"改为"销毁重建"必然增加重开延迟。所以主窗口回收默认取保守值（隐藏 5 分钟后才销毁 + 托盘常驻策略），且**只在对用户无感的时刻销毁**；体验预算优先于多回收一个渲染器。

---

## 3. M0：观测、基线与门禁（最先做，1 周内可交付）

没有这一层，后面所有数字都无法归因。调研 §2 的 9 进程快照已明确"不是基线"，且**没有窗口→PID 映射**；复核时另取一次同机快照（附录 B）与调研相差约 2.9 倍，进一步说明必须先有口径。

### 3.1 W0-1 窗口 → 角色 → PID 映射（新能力）

- 现状：全仓 0 处 `webContents.getOSProcessId()`（API 存在，`electron.d.ts:18251`）；只有 `mainWindow` 变量与 `getAllWindows()`，没有窗口注册表。`performance-monitor.js:20-44` 按 `type` 分桶，**丢弃 `pid/name/serviceName/creationTime`**；`app.getAppMetrics()` 只覆盖 Chromium 进程（type 枚举无 sidecar 类别）。
- 设计：新增 `main/services/window-registry.js`（装配层只加 1 个 require + 1 句注册；`main.js` 只剩 2 行余量，需先按项目惯例从主进程抽走等价行数）：
  - `register({ role, window, feature })` → 记录 `webContents.id`、`getOSProcessId()`、可见性、URL；
  - `snapshot()` → `[{ role, pid, visible, workingSetMiB, privateMiB, cpu }]`，按 pid 与 `app.getAppMetrics()` 对上；
  - 角色枚举至少：`main`、`search`、`selection-toolbar`、`selection-result:<id>`、`pin:<id>`、`clipboard-panel`、`record-frame`、`capture-editor`、`long-capture-preview`。
- 验收：快照能区分主窗口/搜索/工具条各自 PID；窗口销毁后条目消失；单测覆盖注册、销毁、pid 缺失降级。

### 3.2 W0-2 原生进程补齐

`getAppMetrics()` 看不到的 5 类原生进程（剪贴板 `HighlighterClipboard.exe`、OCR `HighlighterOcrSidecar.exe`、Everything `HighlighterEverything.exe`/自管的 `Everything.exe`、`SmartSelect.exe`、ffmpeg）必须由外部采样覆盖；另有两个 `utilityProcess`（usage-scan / selection-hook，带 `serviceName`），可经 `child-process-gone` 与 `ProcessMetric.serviceName` 识别。

- 交付：扩展 `scripts/benchmark-performance.js` 的进程筛选（当前只筛 `Highlighter` 与 `HighlighterOcrSidecar`，且 `advisoryOnly`；会漏 Everything/Clipboard/SmartSelect/ffmpeg），或新增只读采样脚本，按**可执行文件路径**归属进程树。
- 验收：一次快照能列出全部 9+ 类进程；脚本在无副屏/受限会话下不弹窗（`show:false`，遵循 AGENTS.md）。

### 3.3 W0-3 基线场景与报告模板

固定机器、Release、无 DevTools、相同设置。至少覆盖调研 §7 的表格，并补充调研未覆盖的 4 类场景（表中标 **新增** 者）：

| 场景 | 采样点 | 指标 |
| --- | --- | --- |
| 冷启动只驻托盘：30 s / 2 min / 6 min | 每点 30 次采样 | 全进程 WS/Private/私有工作集、CPU、进程数 |
| **新增**：首次划词工具条显示；截图热键→可交互 | 各 30 次 | 显示/可交互 P50/P95（G4 的依据） |
| 主窗口 / 搜索 / 划词结果各开关 30 次 | 每轮后 + 空闲 60 s | 平台值、回归斜率、`main-window.reopen` P50/P95、状态恢复正确性 |
| 热启动 OCR 后不识别；识别结束后 | 超时前后 | sidecar 是否退出、冷/热识别 P50/P95 |
| 4K / 8K 截图、20 贴图、长图编辑与导出 | 峰值与结束后 60 s | 峰值、GPU、结束后回落 |
| 剪贴板 + 划词 + 录屏 8 小时 | 每小时 | 趋势、唤醒/CPU、功能丢失 |
| **新增**：搜索窗口 60 次隐藏不销毁 | 每次 | 每次是否新增渲染器/内存增量 |
| **新增**：主窗口销毁重建 20 次 | 每次 | 重开 P50/P95、草稿/路由恢复 |
| **新增**：`require` 重型模块前后 | 单次 | 主进程 RSS 增量（判定 W13 是否值得） |

报告写 `docs/performance/2026-XX-memory-baseline.md`，明确标注每格样本数与"不可比"项。

### 3.4 W0-4 门禁形态

**内存数字不做 CI 硬门禁**（GPU/光栅/机器差异会制造假红；参考 `AGENTS.md` 记录的 `capture-brush-render` 在无 GPU runner 上恒红这一教训）。门禁分两类：

- **自动化（可在受限环境跑）**：单测用注入时钟断言"隐藏 N ms 后销毁""租约未释放时不销毁""reopen 取消计时"；架构检查；`npm test`。这是策略正确性的硬门禁。
- **报告制（固定机 + 人工）**：§3.3 的场景表，每次里程碑复测一次，数值写进报告并给出门禁建议（基线 + 噪声 3σ 或 ≤ 基线 ×1.1，取宽者）。阈值在 M0 结束时定稿，**不预先编造**。

### 3.5 复现方式（沿用 CDE 探针纪律）

- 隐藏窗探针：`show:false`，不占屏；结束进程，不留可见窗口（AGENTS.md 要求可见测试窗放副屏，无副屏不得开可见窗）。
- 探针"计时后必须 `getImageData(0,0,1,1)` 强制光栅化"、"每一步一次 `executeJavaScript` 往返"两条教训直接沿用 `docs/plans/2026-10-26-cde-performance-samples.md` §5，不重复踩。
- 全进程快照脚本（W0-2 交付后）按固定参数采样：`node scripts/memory-snapshot.js --label tray-idle --samples 30 --interval 2000`，输出 JSON + 报告表格；脚本本身不入 CI 门禁。

---

## 4. M1：低风险回收（不改变用户可见交互）

三项都是"路径已存在、只差一句话/一个计时器"的缺口，可独立交付、独立回滚。

### 4.1 W1 OCR 热启动回收（最高性价比，先做）

- 现状（已逐行复核）：全仓只有两处排空闲计时——`ocr-service.js:240`（缓存命中）、`:253`（识别 finally）；`start()` 的 ready 分支 `:124-130` 只置就绪；启动链 `main.js:1245` → `ensureStarted():82` **无条件 `clearIdleTimer()`**，随后无人排计时 ⇒ 只热启动不识别时**永不回收**。生效空闲期是 `300000 ms`（`settings-defaults.js:116` → `main.js:256`）；`ocr-service.js:28` 的 30000 只是类默认（测试/probe 用），`:68` 注释"after 30s"是陈旧注释。
- 改动（4 点，位置级）：
  1. `ensureStarted()` 成功返回后排一次 idle stop（`:87-90` 的 finally 之后，或 ready 分支 `:124-130`）；根因在 `:82` 的无条件清除，应在"启动由谁发起"上区分——热启动也是启动，就必须武装计时。
  2. `stop()` 时对在途请求立即 reject（带 `OCR_STOPPED` 类错误），不要等 `:211` 的 120 s 请求超时；否则 `data-root` 的 `allSettled` 会被拖住。
  3. `settings-effects` 补 `hotStart=false` → 停止已运行服务；`idleTimeoutMs` 变更后让服务重配（当前构造时快照）。
  4. 产品语义二选一并在设置里写明：**"热启动后空闲即回收"（默认）** vs "永久预热"（显式开关，代价是常驻 sidecar）。不做到"两者都默认"，否则又回到不可判定。
- 验收：热启动后无识别，sidecar 在 `idleTimeoutMs + 30 s` 内退出；紧接着的第一次识别冷启动延迟有记录，P95 不超基线预算；迁移流程不再被 120 s 超时拖住；`test/ocr-service.test.js` 增补三条（回收、stop 竞态、设置切换）。
- 风险与回滚：冷识别延迟上升 → 调大默认 idle（5 min 已不小）或提供永久预热开关；回滚只需去掉计时器武装，不改协议。

### 4.2 W2 usage worker 与 cursor helper 的空闲退出（调研漏项）

- 现状：usage worker 懒建（`usage-feature.js:99` → `usage-worker-client.js:25`），完成后常驻；只有 `cancel/dispose/quiesce`（`usage-feature.js:274-280` 仅迁移用），无 idle 退出、无 quit 钩子。`cursor-provider.js:212` 的 `SmartSelect.exe` 也是首次查询后常驻，无空闲计时（现有 setTimeout 只是查询超时）。
- 改动：`usage-worker-client` 增加 `idleTimeoutMs`：最后一个 pending settle 后武装，触发即 `child.kill()` + `child=null`（下次 `ensureChild()` 重新 fork；`handleExit:85-94` 已会 settle 全部 pending，迟到回调安全）。默认值由 `diagnostics.lastColdStartMs` 决定（先测再定，60–300 s 区间）。cursor helper 同法，但**必须先测**"冷启动 helper 的首帧延迟"，截图链路对延迟敏感。
- 验收：扫描结束 N 秒后 utility 进程消失；下一次扫描重新 fork 且结果正确；迁移期间不触发退出（`quiesce` 优先）；单测用假 child 断言 fork 次数与退出时机。

### 4.3 W3 截图初始化缓冲释放（调研 §3.3 第一条）

- 现状：主进程在 `capture/index.js:676` 已把 `_captureInit.imageBuffer` 置空，但 IPC 已在其前发出（`:312-323`）；渲染器 `capture/capture.js:4340` 把含 `imageBuffer` 的整个对象存进 `initData`，`:4353` 用它建 Blob，`:4351` 只 `revokeObjectURL`，**从不清 `initData.imageBuffer`** ⇒ 渲染器在整个窗口生命周期持一份 PNG 字节 + 已解码位图。
- 复核结论：**可以安全清除**。渲染器唯一使用点就是首次解码（`:4353`）；导出走 canvas 重编码（`:4137`）；提交只传 `resultBuffer + snapshot`（`:3885-3892`）；历史继续编辑由主进程从磁盘重读（`:365`）。清除后四条路径都不坏，缺的只是"没有代码做"。
- 改动：`image.onload` 后 `initData.imageBuffer = null`（保留对象其他字段）；补一个真实 Electron 隐藏窗探针，断言大图解码后渲染器内存回落；同函数 `:365` 一次性读全尺寸底图是另一处峰值，评估能否改为按需流式。
- 验收：4K 截图解码后渲染器 RSS 相对当前有可测回落（探针记录）；"再编辑 / 复制 / 保存 / 贴图"四条路径功能测试通过。
- 风险：低。若历史续编辑实际依赖某条未发现的引用，会在功能测试暴露，回滚即恢复该行。

---

## 5. M2：有状态回收框架与窗口迁移

### 5.1 为什么需要框架，而不是每处各写一个计时器

现有三套"回收"各写各的：剪贴板的 `releaseTimer`（`clipboard/index.js:52,94-120`，隐藏后 `destroy()` + 协议 `unhandle`，默认 60 s，档位 0/60/300 s）；OCR 与 Everything 的 `scheduleIdleStop()`（`ocr-service.js:195-201`、`everything-service.js:159-167`）；usage worker 什么都没有。直接复制第四、第五套计时器会带来同类竞态（reopen、失焦、流式、退出、电源）。

**可以复用的样板是剪贴板面板**：它是全仓唯一"懒创建 + 隐藏后延时销毁 + 重建无状态"的完整实现（`release()` 94-108、`hide()` 109-120、`show()` 清计时器 174、`dispose()` 345）。它之所以能安全销毁，是因为**面板没有用户状态**；主窗口/搜索/划词结果都有状态，不能直接套用。框架的价值就是把这层差异显式化。

### 5.2 W4 框架设计（先抽象，再迁移）

新增两个小模块（避开 `main.js` 增行：线数上限 1330，当前 1328，只剩 2 行），窗口侧只留薄胶水：

1. `main/services/idle-reclaimer.js` — `createIdleReclaimer({ name, timeoutMs, shouldReclaim, onReclaim, logger, clock })`
   - 单计时器、`unref()`、`arm()/disarm()/isArmed()`、到期时**重查谓词**（不是"到期即销毁"）；
   - 电源事件：suspend 主动 disarm，resume 后按剩余时间重排（避免挂起恢复瞬间集中触发）；
   - 审计：`logger.event('reclaim', { name, action: armed|fired|skipped|disarmed, reason, hiddenForMs, leases })`——回收必须可解释；
   - 注入 `clock`，单测可快进，不依赖真实等待。
2. `main/services/window-leases.js` — 任务租约：`acquire(reason)` 返回 release；`heldReasons()`；谓词 `idle`。
   - 用途：数据迁移、录制 session（`record/index.js` 的 `win._recordSessionId`）、导出、正在写草稿；**有租约就不销毁**。
3. 窗口侧只保留薄胶水：`hideAndSchedule(win, timeoutMs)`、`reclaimNow(win, reason)`、状态快照/恢复回调。

**必须处理的竞态清单**（写进单测）：

| 竞态 | 处理 |
| --- | --- |
| 计时器到期时窗口已重新可见 | 谓词重查 `isVisible()`，放弃回收 |
| 用户在回收瞬间 reopen | `disarm()` + generation 递增；旧计时器回调按 generation 作废 |
| 隐藏期间开始迁移/录制 | 租约阻止；租约释放后重新 arm |
| 应用退出 | 所有 reclaimer `dispose()`；`before-quit` 已有剪贴板/录屏/长图/OCR 清理，框架只做幂等兜底 |
| 电源挂起/恢复 | suspend disarm、resume 重排 |
| 流式会话正在输出 | 划词结果窗口：hide 时已有 `cancelStreamForWindow`（`main.js:1180`），回收前再确认 lease 为空 |
| 渲染器无响应/崩溃 | 快照请求带超时；超时则**不销毁**（宁可多占一个渲染器，不能丢状态） |

### 5.3 W5 搜索窗口有状态回收

- 现状：`blur` → hide（`search/index.js:100-102`）、关闭 → hide（`:150`）；全文件无 `destroy()`、无计时器，只有 `closed` 置空（`:103`）。查询词与结果只在渲染器（`search/search.js:232,264`），主进程每次 show 只重发设置 payload（`search/index.js:34-41`）。
- 设计：隐藏后 60 s（可配置 0/60/300，复用剪贴板档位）回收；销毁前把**查询词 + 分类/排序**镜像到主进程（渲染器在输入时 debounce 上报，别等回收时再问），重建后恢复查询并重跑搜索。结果不恢复（重新查 Everything 成本可测且正确性更好）。
- 验收：隐藏 60 s 后渲染进程消失；重开 P50 ≤ 冷建窗 P50 + 一次查询耗时（记录基线）；查询词与分类恢复；游戏模式/自动化窗口定位路径不回归。
- 测试影响：`test/game-mode-contract.test.js:20` 用源码文本断言 `searchDomain.hideSearchWindow()`，需随实现更新断言（不是放宽）。

### 5.4 W6 主窗口：先做托盘策略，再做有状态回收

**W6a（先做，风险最低、收益直接）：自启动仅托盘。**
现状：`startApplication` 无条件 `createMainWindow('home')`（`main.js:1237`）。若本次启动来自开机自启（或用户选择"启动到托盘"），**不创建主窗口**，托盘/双击/第二实例再按需创建（重开路径已幂等，`main.js:814-820`；入口有 tray 双击 `:876`、second-instance `:1268`、activate `:1304`）。"是否来自自启"可用 `app.getLoginItemSettings().wasOpenedAtLogin` 判定（现有 `setLoginItemSettings` 在 `main.js:1247`），或新增一个显式偏好项，二选一在实现时定。这直接省掉一个渲染器与 34 脚本 + 430 KB 的解析，且**不引入任何销毁/恢复风险**。
- 验收：自启动后无主窗口渲染进程；托盘双击/快捷键打开行为与现在一致；`window-all-closed => {}`（`:1305`）保持。

**W6b（再做）：隐藏后延时销毁 + 状态快照。**
- 现状：`window:close` → `hide()`（`main.js:1178-1182`，发送方只有 `preload.js:70`，且只挂主窗口），`window-all-closed` 空实现，隐藏后仍持续收主进程推送（`:190,389,977`）。
- 设计：隐藏后 5 min 回收（保守；可配置 0/5/30 min）。销毁前经 IPC 请求渲染器快照（超时 500 ms，超时则不销毁）：当前 route、各设置页草稿（分类草稿 `config/routes/local-search.js:5,33-34`；provider 编辑器草稿 `models-provider.js:83-88`）、滚动位置；重建后 `app:restore` 注入。快照只存主进程内存（不落盘），与今天"关闭即隐藏、退出即丢"的行为边界一致。
- 阻塞点（必须显式处理，否则会丢数据）：草稿全在渲染器且**当前无 beforeunload 之类协议**；迁移中（`main.js:1188-1223`）、录制中、导出中不可销毁——用 W4 租约。贴图不受影响（贴图是独立窗口，且本身已是"关闭即销毁"）。
- 验收：隐藏 5 min 后主窗口渲染进程消失；重开恢复 route 与草稿；迁移/录制/导出期间不回收；`main-window.reopen`/`ready` 事件继续产出；销毁重建 20 次不累积。
- 风险：最大的一项（丢草稿是产品事故）。缓解：默认 5 min、超时不销毁、先做 W6a、灰度设置项、失败即回滚到"只隐藏"。

### 5.5 W7 划词结果窗口（未固定）

- 现状：失焦且 `!_isPinned` 才 hide（`selection-window-manager.js:185-190`）；固定窗口另建（`:196-205`），不复用；会话 Map 在主进程（`selection/index.js:495`），只有 `persist=true` 才落 JSON（`conversation-store.js`）。hide 前必须 `cancelStreamForWindow`（`main.js:1180`）——Electron hide 不触发 `visibilitychange`，渲染器无法自愈，只能靠 `stream:error` 上报（`action-conversation.js:188-193,200-202`）。
- 设计：**只回收未固定窗口**，隐藏 120 s 后销毁；会话留在主进程 Map（实现前须确认该 Map 不持有已销毁窗口或 stream 的强引用，否则销毁窗口后会话仍泄漏），重建时回灌；窗口尺寸已有保存（`:248-271`）。固定窗口完全不动——用户"固定"就是要它留着。
- 验收：未固定窗口隐藏 2 min 后渲染进程消失；再次划词可打开并有历史；固定窗口 100% 保留；流式输出中不回收（租约）。
- 测试影响：`test/selection-window-manager.test.js:190-197,415`、`test/action-conversation-stream.test.js:122-130,196,211` 锁定当前 hide 行为，需成组更新并保留"隐藏时 visible=false"的原断言。

### 5.6 W8 划词工具条：先测，再决定是否改

- 现状：启动预建隐藏窗口（`main.js:1240`），`show:false` 即 `loadFile`，`did-finish-load` 置就绪并预推 appearance；首次 show 只做 geometry + `showInactive` + `selection:text`（`selection-window-manager.js:108-148,295-300`）；无心跳；`focusable: !isWindows` 故无 blur 处理。
- 做法：**不先改**。先测"预热 vs 按需创建"的首次显示 P50/P95（隐藏窗探针），若差值小于体验预算，再提供"快速响应/节省内存"两档；若差值大，保留预热，把省内存目标让给别的窗口。避免为省一个渲染器把划词延迟做坏。

---

## 6. M3：图片峰值与预算

原则：**先分"峰值"与"常驻平台"，再谈预算**。4K RGBA ≈ 31.6 MiB，8K ≈ 126.6 MiB；PNG 小不代表编辑时省内存。换宿主（Tauri/原生）不会改变像素成本，分块/低分辨率预览/及时释放才是直接手段。

### 6.1 W9 贴图资源化 + 字节预算（常驻问题最重）

- 现状：主进程 `win._pinData.dataUrl` 是唯一副本（`pin/index.js:288`，更新 `:339`），除显式保存（`:617-619`）不落盘；`pin:init` 再发渲染器（`:597`），渲染器 `image.src=dataUrl` ⇒ 主进程字符串 + 渲染器字符串 + 全尺寸解码位图；窗口尺寸被 clamp 到工作区 0.55（`:251-252`），**只缩显示不缩存储**；`createFromDataURL` 在 `:245,526,549,615,702` 反复全解码。上限只有 `MAX_PINNED=20` 条目（`:46`），无字节/像素预算。4K 选区 PNG≈8 MB → base64≈11 MB，主+渲染≈22 MB + 解码≈33 MB ≈ **55 MB/窗**，20 窗 ≈ **1.1 GB 量级**（估算，待实测）。
- 设计（分两步，可独立交付）：
  1. **去 base64**：主进程保存 PNG `Buffer`（或落临时文件 + 路径），窗口持有 `bufferId`；注册只读自定义协议（照抄剪贴板 `handleResource` 的"可见性 + owner + generation"三重门，`clipboard/index.js:187`），渲染器 `<img src="highlighter-pin://id">`。省掉 33% 字符串膨胀与一份渲染器字符串副本。
  2. **字节预算**：`settings.pinned.maxTotalMiB`（初值建议 64–128，待基线）+ 单图像素上限；超限时给**可见**失败文案（"贴图总内存已达上限，请关闭部分贴图"），不静默降质。显示分辨率按需解码、缩放再解码留作后续（会牺牲放大画质，需产品确认）。
- 验收：20 窗峰值远低于当前估算；关闭窗口后 buffer 释放（引用可断言）；复制/保存/透明度/穿透/旋转/重标注全路径功能测试；协议无越权读取（只认 token 表）。
- 风险：自定义协议与窗口安全策略（`window-security.js`）要先过一遍；`clickThrough`/`setIgnoreMouseEvents` 与协议无关，不受影响。

### 6.2 W10 长截图峰值

- 现状：条带写临时文件、不驻留（好）；`MAX_PIXELS=2e8` 只做累计校验（`long-capture-session.js:70`）；峰值全在 `render()`：`sharp` 以 `limitInputPixels:false` 建全尺寸 4 通道（`:100-104`）≈ **762 MiB 单平面**，带裁剪时再对 `composite.png` 全尺寸解码一次（`:111`）；`render` 只在 finish 调一次（`long-capture/index.js:208`），不并发——这点是好消息。另：复制/贴图路径先被 8e7 px 拒绝（`long-capture/index.js:246`），但 `createFromPath` 全解码 + `toDataURL`（`:247-251`）≈ 305 MiB 位图 + base64。
- 设计：渲染前做**显式字节预算检查**（像素 × 4 × 并发系数 ≤ 配置上限，建议初值 512 MiB），超限走可见失败而不是 OOM；去掉二次全尺寸解码（裁剪放在同一次解码内）；渲染期间禁止预览重绘走全尺寸路径；`render` 保持"仅 finish 一次"的纪律并加注释/测试防回归。8e7 px 路径在 W9 协议化后不再 `toDataURL`。
- 验收：2e8 px 上限下不再出现"整平面"分配；超预算时是明确错误码 + 文案；长图复制/贴图/保存功能测试通过；探针记录 `render()` 峰值。

### 6.3 W11 缓存预算统一 + W12 历史缩略图

- 现状（复核后的真实清单）：

| 缓存 | 位置 | 上限类型 | 单项风险 | 淘汰 |
| --- | --- | --- | --- | --- |
| 马赛克 | `capture/capture.js:265` | 字节 16 MiB | 单 patch 数 MiB | 字节预算 |
| 放大镜采样 | `capture/magnifier-sampler.js:39` | 字节 32 MiB | ≈9.4 MiB/条 | LRU |
| 剪贴板缩略图 | `clipboard-thumbnail-cache.js:10-11` | 字节 8 MiB + 128 条 | 入缓存前校验 ≤256 KiB | 双限 LRU |
| OCR 结果 | `ocr-service.js:25` | 12 条 | 纯文本，低风险 | FIFO |
| 贴图 | `pin/index.js` `_pinData` | **只有 20 条** | **55 MB/窗** | 无 |
| 长截图 | `long-capture-session.js` | 2e8 px | 762 MiB 单平面 | 无（一次性） |
| 历史缩略图 | `history-service.js:161` | **无内存缓存** | 逐项 `readFileSync`→base64 | 无 |

- 结论：**只有贴图是真正的"只限条目不限字节"高风险项**（W9 解决）；OCR 属低风险；其余已有字节预算。因此 W11 不做大规模重构，只做两件事：把"预算声明"变成可测断言（新增 `test/memory-budgets.test.js`，断言每个缓存的字节上限与超限行为）；给贴图预算补测试。
- W12（条件性）：历史缩略图是"每次读盘 + base64 跨进程"，不是常驻 Buffer 泄漏；先测 30 项列表的瞬时峰值与帧时间，只有确实成为峰值来源才做批量化/流式。**不预先优化**。

---

## 7. M4：启动与懒加载（条件性，先改规则再做）

调研 §6 第二阶段的第 4 条方向正确，但**改造成本被低估**：项目有 3 道检查会直接挡住懒加载，必须先改规则（这也是为什么把它放在 M4）。

### 7.1 硬约束（改造前必须先处理）

| 约束 | 位置 | 影响 |
| --- | --- | --- |
| `MAIN_LINE_CEILING = 1330`，`main.js` 已 1328 | `scripts/check-architecture.js:25,96-98` | 任何主进程新增都要先腾挪；懒 getter 3–5 行放不进去 |
| 强制 `main.js` 字面 require 10 个 domain 与 `./main/services/ai` | `check-architecture.js:90-94` | **AI SDK 懒化直接红** |
| 断言 `config.html` 加载 `config/routes/` 每一个文件、固定顺序、禁内联脚本 | `test/config-routes.test.js:44-74` | 路由动态 import 直接红 |
| 每个 `shared/locales/*.js` 必须被加载且三语齐全 | `scripts/check-i18n.js:14-23` | 语言包拆分/按需直接红 |
| 只有 `node --check` 语法检查，无 require 排序/禁动态 require 规则 | `scripts/check-js.js:41-44` | 这项顾虑不存在 |

### 7.2 W13 AI SDK 懒加载

- 现状：`main.js:109 require('./main/services/ai')` → `ai/index.js:3` → `ai/client.js:1` 直接拉入 openai SDK；现成懒样板很多：`initializeStore:155`、`getOcrService:247`、`getRecordingService:281`、`initializeUpdateService:366`+`resolveUpdateService:396`、`getEverythingService:941`、注入式 loader `ffmpeg-path.js:7`、`main.js:371` 的 try/catch 动态 require。
- 注意：**sharp 不是有效目标**。只懒化 `main.js:88` 无效，因为 `main.js:94` 的 `LongCaptureSession` 仍顶层 require 它（`long-capture-session.js:3`）。
- 改动顺序：先改 `check-architecture.js:90-94` 的规则（允许 getter 内 require 并保留"必须存在调用点"的断言）→ 再包 getter → 测 `require` 前后主进程 RSS 增量决定是否继续。
- 验收：首次使用 AI 功能正常（含错误路径）；`npm run check:architecture` 通过；RSS 增量有记录。

### 7.3 W14 渲染器按需加载（分两阶段，先做语言包）

- 现状：`main.js:826` → `config/config.html` 既是主窗口也是设置页；34 个静态 script；`config/` 下无任何 `import(`/`require(`；路由 18 个文件共 284,864 B，首屏 `home` 却已加载 ≈256 KB（usage 103.2 KB、settings 38.7 KB、history 32.4 KB、models-* 45.5 KB、selection-toolbar 21.6 KB、local-search 7.5 KB、clipboard 4.8 KB 等）+ `shared/locales/config.js` 177 KB ≈ **430 KB 非首屏字节**（已解析未执行）。
- 阶段 1（先做，风险小）：语言包按语言拆分，运行时按 `settings.language` 加载，热切换时按需拉另一语言；同步改 `check-i18n.js` 的"必须被静态加载"断言为"每个语言的键集合齐全 + 运行时可达"。
- 阶段 2（后做，风险大）：路由改为清单 + 动态 import，改 `test/config-routes.test.js` 的契约（从"全部被 script 标签加载"改为"清单与分派表一致 + 所有路由可加载"）。这一步动的是主窗口启动骨架，**必须排在 W6b 之后**，否则两个改动互相干扰。
- 何时做：M0 基线若显示冷启动/渲染器内存是痛点且 M1–M3 收益不足，再启动；否则不做。收益口径就是"冷启动 + 首屏解析"，不改常驻平台。

### 7.4 W15 启动分段埋点

- 现状：启动相关埋点只有 3 个事件（`startup.services-ready:1194`、`main-window.ready:822`、`main-window.reopen:819`），其余是 `history.*`/`capture.*`/`record.*` 的功能耗时；`mainModuleStartedAt:2` 只在 `:848/:1256` 各用一次，**模块 require 阶段零埋点**。
- 改动：`main.js:88/:109` 前后各一个 token；`:124` 后加 module-load-complete 分段；`startApplication` 内细分 store/diagnostics/主窗口/托盘段；`performance-monitor.js:117` 加启动后 60 s 的空闲快照（判"未使用功能驻留"）；`config/config.js:86` 的 `renderRoute` 前后按 route 打点。

---

## 8. 排期、里程碑与出口标准

| 里程碑 | 内容 | 出口标准（全部满足才进下一阶段） |
| --- | --- | --- |
| **M0**（≈1 周） | W0-1/2/3/4、W15 | 快照能按窗口角色归属 PID；5 类原生 sidecar + 2 个 utility 可见；基线报告落盘；门禁阈值定稿；`npm test` 绿 |
| **M1**（≈1 周） | W1、W2、W3 | 三条"永不回收"路径有单测 + 真实快照双证；OCR 冷识别延迟有记录；W3 探针显示回落 |
| **M2**（≈3–4 周） | W4、W5、W6a→W6b、W7、W8 测量 | 隐藏窗口按策略真正销毁；30 次开关不累积；草稿/会话/尺寸恢复正确；固定窗口/固定贴图不回归 |
| **M3**（≈2–3 周） | W9、W10、W11、W12 测量 | 贴图有字节预算与可见失败路径；长图不再整平面分配；20 贴图/长图/4K 峰值报告 |
| **M4**（条件，≈1–2 周） | W13、W14、W15 收尾 | 规则先改后过检查；AI 首次使用正常；语言包按需；启动分段可读 |
| **决策门**（条件，≈2–3 周） | P4 宿主原型 | 见 §10 |

**M2 内部顺序**：W4 → W5（最小状态面，验证框架）→ W6a（无风险收益）→ W7 → W6b（最大风险放最后，前面已有两轮框架实战）。W8 测量可与 W4 并行。

---

## 9. 风险与回滚

| 风险 | 触发点 | 缓解 | 回滚 |
| --- | --- | --- | --- |
| 丢草稿/丢会话 | W6b、W7 | 快照超时不销毁；租约；灰度设置项；恢复失败即回退为"只隐藏" | 关闭回收开关（保留代码） |
| 首次划词/截图延迟变差 | W7、W8、W1 冷启动 | 预算门禁（G4）；先测后改；W8 只测不改 | 恢复预热/延长 idle |
| 流式输出被截断 | W7 | 复用现有 `cancelStreamForWindow`；回收前查租约；`window-hidden` 文案测试保留 | 禁止未固定窗口回收 |
| 测试大面积变红 | 所有 hide→destroy | 按 §5.5/§5.3 列出的测试成组更新，保留"隐藏时不可见"断言，只替换"永不销毁"假设 | 分批合入，先框架后迁移 |
| 架构检查变红 | W13、W14 | 先改规则再改代码；规则改动单独 PR 评审 | 规则与代码同回滚 |
| 贴图协议越权/读任意文件 | W9 | token 表 + 可见性 + owner + generation（照抄剪贴板）；安全测试 | 撤回协议，回 data URL |
| 主进程行数超限 | 所有主进程改动 | 一律抽模块；`main.js` 只留 1 require + 1 调用 | 抬上限需单独评审 |
| 数字不可比 | M0 不足 | 固定机 + Release + 无 DevTools + 每格样本数 | 报告标注不可比，不作结论 |
| 迁移宿主收益落空 | 决策门之前 | 不做空白应用 benchmark；不承诺百分比；原型同功能 | 保持 Electron，不回滚已做优化 |

---

## 10. 架构决策门（P4）：何时才考虑 Tauri / 原生常驻核心

**触发条件（三者同时满足才启动）**：
1. M1–M3 完成，托盘待机与截图峰值仍**稳定**超过产品设定的资源目标（目标在 M0 基线后由产品确定）；
2. 已排除"还有窗口/服务未回收"这类可修项（G1–G3 全部达标）；
3. 有同功能原型预算（≈10–15 人日）与 4K/多屏/多贴图真机验证条件。

**原型范围（不接受设置页/空白窗演示）**：托盘 + 快捷键 + 划词监听稳定待机；真实 4K 截图、透明选区、基本标注、复制/保存；5 张贴图置顶/缩放/关闭回收；接入现有 OCR 与剪贴板服务；主辅屏不同 DPI、负坐标、全屏应用下的焦点与快捷键。

**比较对象**：优先"Tauri 2 + Rust + 现有 Web 界面"与"Windows 原生常驻核心 + 按需 WebView2"中的**一条**，不同时重写两个完整应用；React 不是候选宿主（见 §11）。

**判定**：原型在目标场景下托盘待机与截图峰值是否实质低于优化后的 Electron，且功能/体验不回退。不达标 → 保留 Electron，把结论写回调研文档。

---

## 11. 明确不做

1. **不用 React 替换 Electron**。React 是 UI 库；宿主、窗口、系统集成仍在 Electron/Tauri。Electron+React 不会必然降内存，Tauri+React 是同时换两层、难归因。
2. **不在 M1–M3 完成前迁移 Tauri**。调研 §5 列的适配面（IPC 权限、透明窗/焦点/DPI、selection-hook、sharp/screenshot-desktop/AI SDK、electron-store/safeStorage/更新器、录屏/PDF/快捷键/E2E）都是真成本；迁移必须与 UI 重构分开验证。
3. **不重复实现已有优化**：剪贴板 60 s 销毁与 8 MiB/128 项缩略图缓存、OCR 结果缓存与识别后回收、Everything 120 s 空闲、截图主进程初始化 Buffer 清空、马赛克/放大镜字节预算、长图条带落盘——这些已验证存在，只做"复用/迁移到框架"或"验证生效"，不另起一套。
4. **不把 `app.getAppMetrics()` 当全部内存**；不把清空工作集当优化；不拿单次快照下结论。
5. **不承诺"降低 X MiB / 百分之多少"**，直到 M0 基线 + 里程碑复测给出可复现数字。
6. **不为省一个进程**把划词钩子搬回主进程（保留其崩溃隔离与粘贴协调），也不为内存目标牺牲 4K 编辑能力（改为分块/预览降采样除外）。
7. **不预先优化**历史缩略图、语言包、路由加载——先测，成为峰值或启动痛点再做。

---

## 附录 A：调研结论复核表（22 条：12 确认 / 9 修正 / 1 未复核）

| # | 调研结论（§3） | 复核 | 证据（复核后行号） |
| --- | --- | --- | --- |
| A1 | 主窗口关闭只隐藏，启动即创建 | 确认 | `main.js:1178-1182`（唯一发送方 `preload.js:70`，只挂主窗口）、`:1237`、`:814-820`、`:1305` |
| A2 | 划词工具条启动预建隐藏窗口复用 | 确认 | `main.js:1240`、`selection-window-manager.js:108-148,295-300`；无心跳；`focusable:!isWindows` |
| A3 | 搜索窗口 blur/关闭只 hide，无空闲销毁 | 确认 | `search/index.js:100-102,150`；仅 `closed` 置空 `:103`；无 destroy/计时器 |
| A4 | 划词结果失焦隐藏、支持多固定窗口 | 确认 | `selection-window-manager.js:185-190,196-205`；会话 `selection/index.js:495` |
| A5 | 贴图最多 20 个窗口（与"只隐藏"并列） | **修正**：贴图是 close→销毁，hide 只是显隐 | `pin/index.js:46,612,323-327,546,590` |
| A6 | 剪贴板面板 60 s 销毁、缩略图 8 MiB/128 项 | 确认 | `clipboard/index.js:94-120`（调研引 `:49`，实为工厂签名）、`clipboard-settings.js:3`（调研引 `:2`） |
| A7 | OCR 热启动后永不空闲停止 | 确认 | 仅 `ocr-service.js:240,253` 排计时；`:82` 无条件清；`main.js:1245` |
| A8 | OCR 生效空闲期 30 s（或 5 min 不确定） | **修正**：生效 300000 ms | `settings-defaults.js:116` → `main.js:256`；30000 只是 `ocr-service.js:28` 类默认 |
| A9 | usage worker 完成后常驻 | 确认 | `usage-feature.js:99`、`usage-worker-client.js:25`；无 idle 退出 |
| A10 | Everything 默认空闲 120 s、24 项缓存 | 确认 | `everything-service.js:27,71,159-167`；`main.js:949` 未传参 |
| A11 | 截图为初始化对象保留 imageBuffer | **修正**：主进程已清（`:676`），渲染器 `initData` 未清 | `capture/capture.js:4337-4353`（非 4190） |
| A12 | 贴图主进程 `_pinData` 保留 data URL | 确认 | `pin/index.js:288,339`（非 `:243`）；无字节预算 |
| A13 | 长截图允许 2 亿像素 | 确认（限定：2e8 只是保存路径上限） | `long-capture-session.js:70`；复制/贴图先被 8e7 px 拒（`long-capture/index.js:246`） |
| A14 | 马赛克缓存 16 MiB 在 annotation-geometry | **修正**：在 `capture/capture.js:265` | 字节预算 + WeakMap（`:702`） |
| A15 | 放大镜采样缓存 32 MiB 在 shared | **修正**：在 `capture/magnifier-sampler.js:39` | LRU，≈9.4 MiB/条 |
| A16 | 撤销 60 帧存标注结构非 PNG | **未复核**（沿用调研，本次未重测） | 调研 §3.2；本轮未分配核查 |
| A17 | 主进程顶层加载多个模块、设置页加载所有路由 | **修正**：范围被低估 | `main.js` 80 个 require；`main.js:826` 主窗口与设置页同一 `config.html`；34 静态 script |
| A18 | Node utility 具体服务无法确定 | **修正**：可辨 | 两个 `utilityProcess.fork` 带 `serviceName`（`usage-worker-client.js:25`、`selection-hook-service.js:96`）；`ProcessMetric` 有 `pid/serviceName` |
| A19 | Everything 进程归属未证实 | **修正**：可归属 | `everything-service.js:483-493` 自管/外部区分 + 镜像路径校验 + `taskkill` |
| A20 | OCR 有 powerMonitor 挂起恢复 | **修正**：OCR 无 | powerMonitor 只挂 selection/clipboard |
| A21 | 没有受控基线、无窗口→PID 映射 | 确认 | 全仓 0 处 `getOSProcessId`；`performance-monitor.js:20-44` 丢 pid/serviceName |
| A22 | benchmark 进程筛选可能不完整 | 确认 | `benchmark-performance.js:177` 只筛 2 类，`:193` advisoryOnly |

**建议**：A5/A8/A11/A14/A15/A17/A18/A19/A20 与行号漂移建议回填调研文档（本次未改该文件）。

---

## 附录 B：复核时的运行实例快照（只读，仅作口径说明）

复核时本机运行着安装版 4.1.5（`D:\Program Files\Highlighter\Highlighter.exe`），9 个进程：

| 进程角色（按可执行路径推断） | 进程数 | Working Set 合计（MiB，粗算） |
| --- | ---: | ---: |
| `Highlighter.exe`（主/GPU/渲染/utility，未区分） | 7 | ≈2006 |
| `HighlighterClipboard.exe` | 1 | ≈16 |
| `HighlighterOcrSidecar.exe` | 1 | ≈57 |

- 合计 Working Set ≈2.03 GiB，而调研 §2 的同机快照合计 717.7 MiB，相差约 2.9 倍。两次快照的窗口状态、功能开关、空闲时长、是否 DevTools 都不同，**不可比**——这正说明窗口角色映射与空闲基线（M0）是前提，而不是可选项。
- 本次未取得窗口→PID 映射，未区分主进程/渲染进程，未测空闲 CPU；数字不得引用为基线。

---

## 附录 C：与已有文档的关系

- 上游：`docs/research/2026-10-26-memory-and-architecture-assessment.md`（本方案的事实来源，差异见附录 A）。
- 复用：`docs/plans/2026-10-26-cde-performance-samples.md` 的测量纪律（计时后强制光栅化、单探针一次往返、字节预算实测）；剪贴板面板的"懒创建 + 延时销毁"实现；OCR/Everything 的 `scheduleIdleStop` 模式。
- 不替代：`docs/plans/2026-10-25-snow-apps-feature-development-plan.md` 的功能排期；本方案只处理资源生命周期，不新增用户功能。
- 维护：M0 基线出来后，回填 §3.4 的门禁阈值、§2 的体验预算与本文件的估算区间；每完成一个里程碑，用实测替换对应"待实测/建议初值"。

---

## 附录 D：M0/M1 实施记录（2026-10-26）

状态：**M0 观测基础 + M1 三项低风险回收已落地（未 commit）**；M2 未开始。工作树改动 = 15 个已有文件 + 4 个新文件，`git diff --stat` 约 +611/-23（不含新增文件）。

| 项 | 改动 | 测试 |
| --- | --- | --- |
| **W1** OCR | `ocr-service.js`：`ensureStarted()` 成功后武装空闲回收（setImmediate 规避 recognize 竞态）；空闲到期 busy 时**重排**而非永久失联；`stop()` 立即 reject 在途请求（`code=OCR_STOPPED`）；新增 `isBusy/stopIfIdle/setIdleTimeoutMs`。`settings-effects`：hotStart 单独变更即刻生效、关闭时只停空闲服务、`ocr.idleTimeoutMs` 热更新 | `test/ocr-service.test.js` +6、`test/settings-effects.test.js` +2、effect id 契约同步 |
| **W2** usage worker | `usage-worker-client.js`：`idleTimeoutMs`（默认 0 禁用；应用传 120000），最后一个 pending settle 后 unref 计时，到期 kill + `lastIdleExitAt`；`ensureChild/dispose/cancel/handleExit` 清计时；**迟到 exit 的 owner 校验**（旧 worker 不误杀新 worker）。`usage-feature.js` 接线并暴露 `workerIdleTimeoutMs` 诊断字段 | `test/usage-worker-client.test.js` +7、`test/usage-feature.test.js` +1、诊断键契约更新 1 处 |
| **W3** capture | `capture/capture.js`：基础 `image.onload` 首行 `initData.imageBuffer=null`（+4/-1；documentEditor 包装路径同样生效） | `test/capture-performance-contract.test.js` +1 源码契约 |
| **M0a** 观测 | 新增 `main/services/window-registry.js`（241 行）：role→窗口→PID→`getAppMetrics` 关联；`window-security.js` 解构 role/feature（不透传 BrowserWindow）并自动注册；`performance-monitor.js` 的 snapshot 增加 `processes`（保留 pid/name/serviceName/creationTime）与 `windows`；11 类窗口标注 role | `test/window-registry.test.js`（6）+ monitor/security 测试扩展 |
| **M0b** 采样 | 新增 `scripts/memory-snapshot.js`（584 行）：外部只读采样原生 sidecar + Chromium 进程，按角色输出 WS/Private/CPU，`--samples/--interval/--app-dir/--out`，默认写 `.tmp-memory/` | `test/memory-snapshot.test.js`（15）；实机 smoke 见下 |

**验证（本机，同一会话）**

- `npm test`：**1869/1869 通过**，连续 3 轮绿（另有 1 轮出现 `AGENTS.md` 已记录的 clipboard lease flake，该项单独复跑 2/2 绿，未触碰相关代码）。
- `npm run check`：architecture ok（main.js 1330/1330）、451 个 JS 语法 ok、i18n ok。
- `npm run test:coverage`：exit 0，三档门禁通过（Lines 92.18%）。
- `node scripts/memory-snapshot.js --label m0-check --samples 1`：13 进程 / WS 1153.6 MiB / Private 826.8 MiB；其中 `everything-external` 3 进程含**用户自装** Everything（见下）。

**未验证 / 风险（不得省略）**

1. **真实运行实例未验**：OCR 空闲回收、usage worker 退出、渲染器内存回落的实际数字都未采集；本轮只有单测 + 源码契约。按 §3.3 用 `memory-snapshot.js` 与日志里的 `performance-snapshot` 补验。
2. **`main.js` 已顶格**：check 口径 1330/1330（`wc -l` 1329），净余 0 行；任何后续改动必须先把装配代码抽到模块（建议 M2 前抽 `createLocalWindow`）。
3. **role 覆盖不全**：recognition 窗与 pdf-export 打印窗未标 role；`record-control` 是实施时按"至少"补充的，需在 §3.1 枚举回填。
4. **Everything 归属**：`everything-external` 名称白名单会把用户自装 Everything 计入（本机 3 个中 1 个是自装），基线报表需按路径细分或人工剔除。
5. W3 探针未做，4K 内存回落未实测；已知 flake 仍在（与本批无关，见 `AGENTS.md`）。

---

## 附录 E：M2 实施记录（2026-10-26，同一工作日）

状态：**M2 已交付 W4 / W5 / W6a / W7 / W6b(保守 v1)**；W8（划词工具条 A/B 测量）未做，保留预热现状。工作树仍未 commit。

| 项 | 实现 | 关键行为 | 测试 |
| --- | --- | --- | --- |
| **W4** 框架 | 新增 `main/services/idle-reclaimer.js`、`main/services/window-leases.js`；`createLocalWindow` 抽到 `window-security.js` 的 `createLocalWindowFactory` | 统一"隐藏 N ms → 谓词重查 → 回收/跳过"；任务租约；可注入时钟与计时器；每次转换写日志 | idle-reclaimer 7 例、window-leases 4 例 |
| **W5** 搜索窗口 | `main/domains/search/index.js` + `search-ipc.js` + `preload-search.js` + `search/search.js`；IPC 表面新增 `search:state` | 隐藏 60 s 销毁；查询词/分类/排序/matchPath 由渲染器 debounce 镜像，重建后恢复并重跑搜索；`windowReleaseMs:0` 可关 | `test/search-domain.test.js` 9 例 |
| **W6a** 自启动仅托盘 | 新增 `main/services/tray-only-launch.js`；main.js 跳过主窗口创建；两处 `setLoginItemSettings` 统一带 `--start-to-tray` | 登录启动只驻托盘，窗口按需创建；e2e 始终开窗；旧注册无标记时保持旧行为 | `test/tray-only-launch.test.js` 4 例（含 main.js 源码契约） |
| **W7** 未固定划词结果 | `selection-window-manager.js` + `selection/index.js` | blur 隐藏 120 s 后销毁；销毁前 `ActionConversation.serialize()` 存域级快照，`hasConversation()`/`showOrRestoreConversation()` 可恢复；pinned 永不回收；流式进行中不回收 | manager +5、domain 端到端 +1（合计 38/38） |
| **W6b** 主窗口保守回收 | 新增 `main/services/main-window-reclaimer.js`、`main/ipc/window-reclaim-ipc.js`；`preload.js`/`config/config.js`/`local-search.js`/`models-provider.js` 上报 route/dirty | 隐藏 5 min 且 **dirty≠true + route∈SAFE_ROUTES + 无租约 + 主进程不忙** 才销毁；重建恢复路由；设置页/models/local-search 等一律不销毁；不落盘草稿、不恢复滚动 | `test/main-window-reclaimer.test.js` 13 例、IPC 契约 +2 |
| **W8** 工具条 | 仅决策记录，未改代码 | 保留预热（首次划词优先）；A/B 需真实 Electron 探针，留待下一轮 | — |

**验证（M2 结束时）**

- `npm test`：**1917/1917 通过**（M2 过程中出现过一次 `AGENTS.md` 已知的 clipboard lease flake，复跑即绿，与本批无关）。
- `npm run check`：architecture ok（main.js **1330/1330**）、461 个 JS 语法 ok、i18n ok。
- `npm run test:coverage`：三档单独复跑均通过（loaded Lines 92.30% ≥ 85；native exit 0；critical 中 window-security 93.24% ≥ 90）。整链一次运行时曾因 `AGENTS.md` 已知的 clipboard lease flake 在 loaded 档中断（该档覆盖率本身 92.30% 已达标），复跑即过，与本批改动无关。
- 过程中发现并修复的真实回归：W6b 的 `window:renderer-state` 最初放在 `main/services/`，逃过了 IPC 覆盖测试的扫描 → 已迁到 `main/ipc/` 并改为字面量注册；覆盖率门禁因 `window-security.js` 新增工厂掉到 88.51% → 补工厂测试后 93.24%。

**M2 未验证 / 风险（不得省略）**

1. **真实 Electron 未跑**：5 min 主窗口回收、60 s 搜索回收、120 s 结果窗回收的实际时序、IPC 鉴权、`preload` 上报、销毁后托盘恢复全部只有单测与 fake 窗口证据。
2. **W6b 是保守 v1**：dirty 完全依赖渲染器主动上报（无 beforeunload），用 SAFE_ROUTES 窄名单兜底；设置页即使 clean 也不销毁；不保存草稿内容、不恢复滚动位置；导出中"忙"未接 lease（只留 API）。
3. **`main.js` 仍顶格**：1330/1330，零余量。W6a/W6b 用完了 W4 腾出的行数；下一步任何 main.js 改动都必须先抽模块（建议抽 startApplication 的托盘/服务段）。
4. **W8 未测**：工具条预热的实际收益未量化，仍按"保留预热"执行。
5. W5 渲染器 restore/保存时序、W7 真实 destroy 后的托盘入口未实测；已知 flake 仍在。

**后续开发流程**：阶段划分、真机验证清单、M3/M4 顺序、门禁速查与发布流程见 `docs/plans/2026-10-27-follow-up-development-flow.md`（本文件的实施记录到此为止，后续里程碑在该流程文档中跟踪）。

