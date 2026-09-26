# 设计文档：划词钩子卡死恢复——以进程回收替代原生补丁

- 日期：2026-09-17
- 基线：`master` @ `33365bd`（v2.2.6）
- 状态：**已实施并验证**（Phase 2–4 已落地：全量单测 514 项通过，覆盖率与 `check` 通过，误判边界已实测）
- 关联：`docs/superpowers/specs/2026-07-27-selection-toolbar-resilience-design.md`（本文件的第 6 节**取代**该文档「不使用周期性强制重启」的结论）
- 结论摘要：收紧 `SelectionHookService` 心跳参数，使卡死 host 在最坏约 4.25s 内被 kill 并重建；删除 `patches/selection-hook/` 原生补丁及其脚本

---

## 1. 背景与问题

划词钩子（`selection-hook`）运行在独立的 utility 进程中，由主进程的 `SelectionHookService` 监管：

- `main/services/selection-hook-service.js`：主进程侧监管者，负责启动/停止 host、心跳探测、电源事件与重建。
- `main/services/selection-hook-host.js`：运行在 utility 进程内，持有原生模块实例并转发事件。

原生模块通过 Windows UI Automation（UIA）同步读取当前选中文本。这些是**跨进程 COM 调用**，没有超时机制。当目标应用（尤其是 Chromium 系应用）的 UI 线程繁忙或被阻塞时，调用可能长时间不返回。

后果是 host 进程处于**「假活」**状态：进程存在、原生钩子线程仍在，但 Node 事件循环被同步调用占住，不再处理任何消息。用户看到的现象是划词功能静默失效——工具栏不再出现，没有任何报错。

这类故障与「进程崩溃」不同，无法靠 `onExit` 发现，只能靠主动探测。

## 2. 证据链：为什么 ping 超时能捕获这类卡死

这一节是方案成立的前提，结论是**「ping 无应答」确实等价于「事件循环被占住」**。

`ping` 在 host 侧的应答代码（`main/services/selection-hook-host.js:125-134`）：

```js
case 'ping':
  send({
    type: 'pong',
    hookRunning: !!hook && (() => {
      try { return !!hook.isRunning() } catch { return false }
    })(),
    lastInputAt: lastInputAt.value,
    pid: process.pid
  })
  break
```

消息由 `process.parentPort.on('message', handleMessage)`（同文件 `bindParent()`）投递，即**在 host 的 Node 事件循环上执行**。

而原生事件的派发路径是：原生钩子线程 → `Napi::ThreadSafeFunction::NonBlockingCall` → **Node 主线程的事件回调** → 回调内**同步**执行选区提取（`GetSelectedText` → UIA / COM / 剪贴板轮询 `Sleep`）。

两条路径共用同一个 Node 事件循环，因此：

- 一次卡死的同步原生调用会**同时**挡住 pong；
- 没有独立线程或原生层在替 pong 兜底（host 内不存在 `worker_threads`）。

所以「父进程在超时内收不到 pong」是「host 事件循环被占住」的可观测代理指标——这正是本方案成立的依据。

## 3. 现状延迟推导

现状参数（`main/services/selection-hook-service.js:5-14`）：

```
heartbeatIntervalMs: 30000
heartbeatTimeoutMs:    8000
maxHeartbeatFailures:     2
```

调用链：`armHeartbeat()`（`:234-239`）挂 30s 定时器 → 触发 `runHeartbeat()`（`:252-287`）→ 发 `ping` 并挂 8s 超时定时器（`:266-278`）→ 8s 内无 pong 则 `heartbeatFailures += 1`（`:270`）→ 未达 2 次则重新 `armHeartbeat()`，达到 2 次则 `forceHostRecreate('heartbeat-timeout')`（`:274`）。

**单次失败确认 = 30s + 8s = 38s**，需连续 2 次。第一次失败的耗时取决于卡死发生的相位 δ（距上一次成功 pong 的时间，健康状态下 δ 在 0–30s 间近似均匀）：

| 相位 | 第一次失败 | 第二次失败 | 合计 |
|---|---|---|---|
| δ→0（刚收到 pong 即卡死） | 30 + 8 = 38s | 30 + 8 = 38s | **76s（上界）** |
| δ→30（卡死时恰有 ping 在途） | 8s | 30 + 8 = 38s | **46s（下界）** |

第二次恒为 38s，变数只在第一次。故检测延迟**均匀落在 46–76s，平均约 61s**；另需加上 `forceHostRecreate` 的 400ms 重建延迟（`:289-294`）以及新 utility 进程 fork、原生模块加载、`start()` 到 `status:started` 的开销（通常数百毫秒至 1–2s）。

需要强调的限定：**该延迟只适用于「假活」这一类**。若 host 真正崩溃退出，走 `onExit → handleHostExit → forceHostRecreate`（`:409-417`），400ms 即重建，不依赖心跳。因此心跳慢的问题专门出在最难察觉的这一类故障上。

## 4. 方案对比与取舍

### 4.1 方案 A：原生补丁（已存在，拟删除）

`patches/selection-hook/selection_hook.cc` 把提取逻辑移到独立 worker 线程，设 `SELECTION_EXTRACT_TIMEOUT_MS = 750`，超时后 `worker.detach()` 并递增 `selection_epoch` 使迟到结果作废。

该补丁的**方向**是对的（把提取从共用实例移出、用代际号丢弃过期结果），也顺带修掉了一个真实隐患（原先 `is_processing.store(false)` 散落在各提前返回分支，遗漏任一路径会让 `is_processing` 永久为 true，静默禁用后续所有选区检测）。

但其核心声明不成立。源码注释称可防止卡住「hook host **and the target UI thread**」，前半句成立、后半句不成立：

- 放弃一个**客户端线程**并不会取消已经发出的跨进程 COM/RPC 调用。worker 是 `detach()` 的、线程仍存活，pending RPC 仍在，目标应用的 provider 线程照样被挡住。
- 反向效应更糟：每次点击都新建 detached 线程，各自持有 STA + `IUIAutomation` 实例与一个指向同一卡死服务端的 pending 调用，且**无并发上限**。在目标应用持续卡住时，可能比单次阻塞堆积得更多。
- 相比之下，原生路径虽然慢（46–76s），但最终会通过 `host.kill()` 结束进程、连带断开 RPC。

此外该补丁引入三处新问题：

1. **生命周期不安全**：`TimedTask` 持有裸指针 `SelectionHook *hook`，detach 后 worker 可能活过对象本身。目前靠集成层在 stop/dispose 时 `host.kill()` 带走整个进程来掩盖，正确性依赖外部销毁而非 C++ 自身；且 JS 侧 `cleanup()` 会把 `#instance` 置 null，GC 触发析构释放 `pUIAutomation` 时构成 use-after-free。
2. **并发竞态**：超时后清 `is_processing` 允许新的提取启动，被放弃的 worker 仍在写共享成员（如 `uia_control_type`）。
3. **无观测**：750ms 是硬编码常量，触发时不打日志、不计计数，无法判断线上是否真的生效。

工程层面还有两点：旧 `GetSelectedText` 变成死代码；`patches/selection-hook/selection_hook.cc` 是**整文件 2766 行副本**而非 diff，上游升级会整体回退，需手工重新对齐。

**最关键的一点**：该补丁从未接入任何构建流程——`patch:selection-hook` 未被 `build:native`、`prebuild:win` 或任何 GitHub workflow 调用。实测确认安装包内的 `selection-hook.node` 与本地上游预编译产物字节一致（SHA256 `979FBE9B…`，284160 字节），即发布产物**跑的是未打补丁的上游二进制**，750ms 那层保护从未生效。它当前是仓库里的**死资产**，真正的风险是让人误以为已经防住。

### 4.2 方案 B：进程回收（本方案）

保留并收紧现有的心跳 → 回收路径。核心论据：**进程死亡是唯一可靠的取消原语**——它同时断开卡死的跨进程 RPC，并连带销毁所有 detached 线程；且回收不丢配置，因为每次 `start()` 都会重发完整的 `this.startOptions`（`:131-138`），`startOptions` 在 kill 之间持久存在于服务实例上。

与方案 A 相比：无需编译 C++、无需 MSVC 工具链、不持有第三方源码副本、不引入生命周期与竞态缺陷。

## 5. 选定参数与推导

| 参数 | 现值 | 新值 | 说明 |
|---|---:|---:|---|
| `heartbeatIntervalMs` | 30000 | **1000** | 探测间隔 |
| `heartbeatTimeoutMs` | 8000 | **1500** | 单次探测超时 |
| `maxHeartbeatFailures` | 2 | 2 | 保留「连续两次才回收」 |
| `heartbeatConfirmDelayMs` | — | **250** | 新增：首次失败后的快速复检延迟 |

**为什么单次超时不能低于 ~1500ms**：host 事件循环内存在**合法**的长时间同步阻塞，最短也需要能容纳它，否则正常操作会被误判为卡死。最长的合法阻塞来自剪贴板回退路径（`GetTextViaClipboard`）：

- 按键轮询预处理：最多 5 次 × `Sleep(40)` ≈ 200ms
- `Ctrl+Insert` 轮询等待：最多 20 次 × `Sleep(5)` ≈ 100ms
- `Ctrl+C` 轮询等待：最多 36 次 × `Sleep(5)` ≈ 180ms + `Sleep(10)`
- 延迟读取应用的额外等待：`Sleep(135)`

合计约 **435–700ms**（具体取决于路径与「延迟读取列表」命中情况）。

**「单次探测超时」不等于「回收阈值」**——这是本参数表最容易被误读的一点。回收要求**连续两次探测均未收到 pong**，而一个迟到的 pong 会把失败计数清零，因此真实阈值是：

```
回收阈值 ≈ timeout + confirm + timeout = 1500 + 250 + 1500 = 3250ms
```

即：host 只要在 **约 3.25s 内**给出任一应答，就不会被回收（可能被记若干次失败，但不重建）；只有持续无应答超过该阈值才回收。相对 435–700ms 的合法阻塞，真实余量约 **4.6–7.5×**，而非单看 1500ms 得出的 2.1×。

该结论已用真实定时器实测（模拟 host 以不同延迟应答 pong，观察是否触发回收）：

| pong 延迟 | 回收次数 | 累计失败 |
|---:|---:|---:|
| 100ms | 0 | 0 |
| 700ms | 0 | 0 |
| 1600ms | 0 | 2 |
| 3250ms | 0 | 1 |
| 3400ms | 2 | 4 |
| 4000ms | 1 | 2 |

边界落在 3250ms 与 3400ms 之间，与上式推导一致。「慢但会应答」的 host 不会被回收，只有「被卡死的同步调用占住事件循环、根本不处理消息」才会。

**推导出的恢复时间（针对真正卡死、永不应答的 host）**：

- 典型（卡死落在探测窗口内）：`1500 + 250 + 1500 ≈ 3250ms`
- 最坏（刚收到 pong 后立即卡死）：`1000 + 1500 + 250 + 1500 ≈ 4250ms`

对比现状 46–76s（平均约 61s），提升约一个数量级。

## 6. 电源事件耦合（关键约束）

新的 `heartbeatTimeoutMs = 1500` 与 `powerDebounceMs = 1500` **相等**，会引入误判风险：

- 现状之所以安全，是因为「防抖 1500ms < 超时 8000ms」，`suspend()` 里的 `cancelHeartbeat()` 总能在探测超时之前生效。
- 一旦两者相等，休眠/Modern Standby 期间 host 本就不应应答（或已随系统挂起），在途探测的超时会被计入失败，可能触发一次无谓的重建。

**缓解机制（必须随参数调整一并实施）**：在 `notePowerEvent()`（`:181-192`）中，挂 `powerTimer` 之前先调用 `this.cancelHeartbeat()`。

理由：电源事件注定会导致 host 被回收（`suspend()` 停止，或 `scheduleRestart()` 重建），在途探测已无意义，其超时也绝不应被计入失败。取消后心跳链由 `scheduleRestart → start → status:started → armHeartbeat()` 自动恢复，无需额外状态。

保留 `suspend()` 中已有的 `cancelHeartbeat()`（`:216`）。同时修正一处既有小缺陷：`armHeartbeat()` 目前只检查 `disposed`、不检查 `desiredRunning`，导致 `suspend()` 之后迟到的 pong 仍能重新挂上一个空转的 interval（下一拍因 `runHeartbeat` 的 `!this.desiredRunning` 早退而自灭，非泄漏，但语义不清）。加 `!this.desiredRunning` 守卫后行为更明确，且因 `desiredRunning` 在 `start()` 中先置 true 再 `armHeartbeat()`，不影响正常启动。

## 7. 可观测性

这是判断本方案是否真在生效的唯一依据，因此必须随实现一起落地。

新增实例字段：

| 字段 | 含义 |
|---|---|
| `hostRecreateCount` | 累计 host 回收次数（跨 host 实例累加） |
| `heartbeatFailureCount` | 累计心跳失败次数（区别于表示「连续失败」的 `heartbeatFailures`） |
| `lastRecreateReason` | 最近一次回收原因（如 `heartbeat-timeout`） |
| `hostPid` | 当前 host 进程 pid，取自 pong 上报（`selection-hook-host.js:132`） |

改动点：

- `forceHostRecreate()`（`:289-294`）：自增 `hostRecreateCount`、记录 `lastRecreateReason`，日志追加结构化上下文（原因、累计失败、pid、序号）。
- `pong` 分支（`:328-337`）：记录 `this.hostPid = message.pid`。
- `stopHost()`：复位 `hostPid`（host 已不存在）。
- 新增 `getDiagnostics()`：返回上述计数、`heartbeatFailures`、`lastRecreateReason`、`hostPid`、`isRunning()` 及就绪标志，供测试与排查直接读取。

不改变 `main.js` 的注入方式（继续使用现有 `log`），不接入 `DiagnosticsService`。若后续需要随诊断包导出，可在 `getDiagnostics()` 之上加可选回调，无需改动本方案的结构。

## 8. 删除原生补丁的依据

删除以下内容：

- `patches/selection-hook/selection_hook.cc`（整目录）
- `scripts/apply-selection-hook-patch.js`
- `package.json` 中的 `patch:selection-hook` script
- `test/shortcut-ui-contract.test.js` 中锁定该补丁的测试（`'selection extraction native patch includes a UIA timeout'`）

依据：从未接入构建（死资产）；核心效果声明不成立（无法解开目标应用阻塞）；引入 UAF、竞态与零观测三处缺陷；持有整文件上游副本带来持续维护成本；其试图缓解的问题已由本方案的进程回收更可靠地解决。

删除后 `test/shortcut-ui-contract.test.js` 顶部的 `fs` / `path` 与其余 4 个测试仍在使用，需保留。`docs/plans/2026-09-10-mainjs-assert-inventory.md` 只统计 `assert.match(main, …)`，而被删测试断言的是补丁文件而非 `main.js`，故其计数不受影响。

## 9. 测试与验收

测试沿用 `test/selection-hook-service.test.js` 已有的依赖注入手法（注入 `setTimer` / `clearTimer` + `FakeHost`），不引入新框架。

给 `createScheduler()` 增加虚拟时间累计（每次 `runNext()` 累加该定时器的 `delay`），使「预算」可断言。

关键回归护栏：新的事件序列（`interval → timeout#1 → confirm → timeout#2`）与旧序列（`interval → timeout#1 → interval → timeout#2`）**步数相同**，因此现有 10 个用例中依赖 `runNext()` 次数的用例应原样通过。这是判断改动是否引入行为回归的第一道检查。

新增用例（实际新增 5 项，测试文件共 16 项）：

1. 首次心跳失败后按 `heartbeatConfirmDelayMs` 快速复检（断言 250ms 延迟出现、未回落到整间隔）。
2. 电源事件取消在途探测：`notePowerEvent` 后不发出 ping，且失败计数保持 0。
3. 一次失败后迟到的 pong 取消回收并恢复节奏（断言不重建、`hostPid` 已记录）。
4. 回收被计数并可从 `getDiagnostics()` 读出（`hostRecreateCount` / `lastRecreateReason` / `heartbeatFailureCount`）。
5. **预算用例**：使用生产默认参数，断言从卡死到 `forceHostRecreate` 的累计虚拟时间 ≤ 4300ms——直接钉住本次改动的真实目标（旧参数下为 46000ms，该用例会失败，故非空跑）。

遵守 `docs/plans/2026-09-10-mainjs-assert-inventory.md` 的规则：新增断言写在服务行为上，不对 `main.js` 加源码文本断言。

验收命令：

1. `npm test` — 全量单测，现有用例不回归
2. `npm run test:coverage` — `selection-hook-service.js` 仅属于 `main/services/**` 的 85% 聚合桶，无 per-file 门禁
3. `npm run check` — 语法与架构检查，确认删除 script 后无悬挂引用

**验证结果（2026-09-17）**：`npm test` 514 项全通过（0 失败）；`npm run test:coverage` 三级门禁（85% 聚合 / 60% / 90% per-file）全部通过；`npm run check` 通过（`main.js` 2045 行，domains 7；JS 文件数 200→199，与删除脚本一致）。

## 10. 风险与回滚

**残留风险：误判**。实测表明该风险低于直觉估计：冗余的「连续两次未应答」判据使回收阈值放宽到约 3250ms（见第 5 节实测表），因此单次慢调用、乃至持续约 3.2s 的迟缓应答都不会触发重建，只会累积失败计数。要发生误回收，需目标应用**持续**无应答超过约 3.25s——这在实践中已接近「真的卡住」而非「只是慢」。即便发生，代价是一次重建带来的约 1s 划词盲区（`unexpectedStopRestartDelayMs=400ms` + 进程 fork 与原生加载）。相较现状 46–76s 的静默失效，这是可接受的取舍。

**回滚**：恢复 `DEFAULTS` 中三个心跳参数为 30000 / 8000 / 2 即可回到原行为（`heartbeatConfirmDelayMs` 可保留，取值无害）；`getDiagnostics()` 与计数器为纯增量，不需回滚。`notePowerEvent` 中的 `cancelHeartbeat()` 与 `armHeartbeat` 的 `desiredRunning` 守卫是独立的行为修正，建议保留。

**已验证项**：

- 全量单测 514 项通过；覆盖率门禁通过；`check`（语法 + 架构）通过。
- 参数收敛性：同一「刚 pong 后立即卡死」场景下，旧参数需 46000ms 才回收，新参数 4250ms；`test/selection-hook-service.test.js` 的预算用例断言 ≤4300ms，旧参数会使该用例失败，故该断言非空跑。
- 真实定时器下的误判边界：见第 5 节实测表。
- 实机（从源码运行、真实 1s 探测节奏）连续运行 2 分钟以上，日志中 **0 条** `heartbeat timeout`、无新增回收；作为对照，该应用历史日志中从未出现过心跳超时记录。

**未验证项**：本设计的核心前提（卡死的同步原生调用会挡住 pong）由代码路径推得出，尚未用人工构造的真实卡死场景做端到端复现。落地后建议在 Chrome 上以长时间划词压测，验证回收计数（`getDiagnostics().hostRecreateCount`）是否与用户观察到的失效次数吻合。
