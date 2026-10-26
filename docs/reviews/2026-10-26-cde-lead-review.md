# C/D/E 代码评审 —— Lead 侧记录（2026-10-26）

> 背景：`docs/plans/2026-10-25-feature-CDE-handoff.md` §7.1 把"代码评审未完成"列为接手后第一优先项
> （上一轮的 Codex 子智能体以 `exit code 3221225786` 异常退出、零产出）。
> 本文件记录本轮 Lead 侧**实际做过并复现过**的评审结论。
> 子智能体的独立报告分别在 `docs/reviews/2026-10-26-cde-privacy-review.md` 与
> `docs/reviews/2026-10-26-cde-export-review.md`。
>
> **口径**：本文件只写"我读了代码并且验证过"的内容。没验证的不写结论，只标未覆盖。

---

## 1. 结论

**本轮修复了 6 个严重缺陷（3 个隐私 + 3 个导出），另有 1 个严重宽度缺陷也在此前修复。
修复后本地门禁全绿（1819/1819 + `npm run check` exit 0）。**

上一轮交接把"没有第三方评审"列为第一优先。本轮两路对抗式评审落地：
- 隐私路径：`docs/reviews/2026-10-26-cde-privacy-review.md`（3 critical / 1 high / 3 medium / 2 low / 2 nit）
- 导出路径：`docs/reviews/2026-10-26-cde-export-review.md`（3 critical / 5 high / 4 medium / 3 low）

**评审的核心结论是"功能在主路径上是对的，但文档编辑器这一条分支上有整块隐私失效"** ——
这正是"看起来能跑"与"真的能用"的差别，也是上一轮真机探针没覆盖到的组合。
本文件记录 Lead 侧**修了什么、怎么验证的、还剩什么**。

---

## 2. 已修复的缺陷（6 个严重 + 1 个高）

| ID | 严重度 | 缺陷 | 修复 | 回归测试 |
|---|---|---|---|---|
| **F1** | critical | 文档编辑器的识别遮罩用 `documentCrop()` 当 plan 原点，但识别画布是**整张底图**。crop=(100,80) 时遮罩整体偏移 (−100,−80)，用户马赛克只有 **11.2% 被遮**，88.8% 明文进模型 | `annotationsForMask` 文档分支改用 `crop:{0,0,baseW,baseH}` | `occlusion-recognition-wiring.test.js` 新增行为断言 + 反向对照 |
| **F2** | critical | `magnifierInSourceSpace` 在文档编辑器里 `return magnifier`，但 `restoreDocumentEditor` 把标注转成了**视口 CSS**。镜头采样偏移 **541 px**，实测镜头画布全黑 | 删掉短路，改走 `magnifierFromViewportSpace()`（用共享模块的 `annotationsFromViewport` 逆投影） | 见 F3 的往返测试（同一投影） |
| **F3** | high | `clipRestoredMagnifiers` 用源像素 crop 判视口 CSS 对象 → 合法镜头被**裁小或在打开时删除**，且不在撤销栈里 | 先 `annotationsFromViewport` → `clipToCrop` → `annotationsToViewport`，保留 id | `capture-magnifier-ui.test.js` 新增真数值往返测试 + 旧调用必须失败的对照 |
| **F4** | high | 镜头遮罩宽度"先缩放后量化"，比实际画的马赛克窄（preset 8 @ 3× 每侧窄 60 源像素） | `annotationsForSampling` 不预乘宽度；新增 `buildOccludersForSampling()` **先量化后缩放** | `capture-magnifier-ui.test.js`：21 组行为断言 + 反向对照 |
| **E-01** | critical | 导出按钮在任务运行时被 `disabled`，而它同时是**唯一**的取消控件 → 用户**完全无法取消**导出 | `disabled = !canExport && !canCancel` | `recording-trim-ui.test.js`：模拟**遵守 disabled** 的点击（旧 harness 不遵守，所以从没发现） |
| **E-02** | critical | 在 `verify()` 期间到达的取消被**吞掉**并报成 `verify-failed`（`cancelTask` 已回过 `cancelling`） | 取消检查点移到失败分支**之前** | `recording-export.test.js`：闸门式探针，确认任务确实停在 verify 内再取消 |
| **E-03** | critical | `submit()` 不拒绝"目标 == 录制源文件" → 用裁剪结果**覆盖唯一的源录制**，还报成功 | `submit()` 增加 `samePath` 守卫（含大小写折叠），返回 `target-unavailable` | `recording-export.test.js`：源字节不变 + 大小写变体也被拒 |

**另外两个顺手修的中/高项**：

| ID | 修复 |
|---|---|
| **E-07** | 准入竞争：限制检查在任何 `await` 之前 → 5 个并发提交都被接纳（plan 允许 3）。改为**同步预留槽位**（`reservedSlots`），预算按"总未完成数 = 1 running + 2 waiting"计。同时：取消**等待中**任务立刻从 `queued` 摘除（原来要等下一次 pump，导致后续提交假 `rate-limited`） |
| **E-10 / E-13** | `publish-in-progress` 不再标红（它是状态不是错误）；新增 `record.trim.cancelling` 三语键，取消时按钮显示"正在取消…"而不是继续显示"正在导出…" |

---

## 3. F1/F2/F3 的关键证据（为什么这些是"整块失效"而不是边角）

F1 的实测（纯函数复算，与评审者的 Electron 逐像素一致）：

```
文档编辑器：底图 900×700，crop=(100,80,640,420)
识别画布        : 900×700（整张底图，getSourcePixelRect 在文档模式返回全图）
plan 用的 crop  : (100,80,640,420)   ← 错误
遮罩 op 落点    : (218,198)  正确应为 (318,278)  偏移 (-100,-80)
20×10 的秘密区  : 只有 2 244 / 20 000 px = 11.2% 被遮
                 17 756 px = 88.8% 原始亮色像素进模型
```

F2 的机理：`restoreDocumentEditor` 执行 `annotations = annotationsFromDocument(...)`，
即 `annotationsToViewport` —— **活动数组是视口 CSS**。而 `drawAnnotation(ctx, item)`
本来就吃视口 CSS。原注释"文档编辑器已经是源像素"是错的：
**磁盘上的向量对象**是源像素，**内存里的活动数组**不是。
删掉短路后，zoom=1 且 offset=0 时投影是恒等，所以不会伤害短路原本想服务的情形。

> **教训**：`test/magnifier-runtime.test.js` 的 `window.__mag` 探针**直接改写 `annotations`
> 数组并塞入字面量**，绕过了 `annotationsToViewport` —— 它测的是"采样器本身对不对"，
> 测不到"渲染层喂进来的坐标对不对"。这是"探针自己构造了理想输入"的经典盲区。


---

## 2. 【已修复】严重：镜头采样遮罩比绘制出的马赛克窄

### 2.1 现象

用户用马赛克笔刷盖住敏感内容后，放大镜（D）可能把**盖住的内容原样放大出来**。
这不是"画错位置"（那个缺陷上一轮已修），而是**画对了位置、但比马赛克窄**，两侧各留一条
未被遮住的原始像素带。

### 2.2 量化（实测）

| 预设（CSS px） | 缩放 | 绘制宽度（源 px） | 修复前遮罩宽度 | 每侧泄漏 |
|---:|---:|---:|---:|---:|
| 2 | 1 | 18 | 18 | 0 |
| 2 | 1.5 | 27 | 18 | **4.5** |
| 4 | 1.25 | 30 | 24 | **3** |
| 4 | 2.5 | 60 | 24 | **18** |
| 8 | 1.5 | 72 | 24 | **24** |
| 8 | 2 | 96 | 24 | **36** |
| **8** | **3** | **144** | **24** | **60** |

**16/21 个组合偏窄**。最坏情况 preset 8 / 3× 每侧漏 **60 源像素** —— 16px 的字高约 16 源像素，
所以这条带足以露出**整行文字**。

### 2.3 根因

`shared/occlusion-mask.js` 的 `brushStrokeWidth()` 会把它收到的宽度**量化到 {2,4,8} 预设表**
并夹到 18px 下限：

```js
function brushStrokeWidth(width) {
  const presets = { 2: 2, 4: 4, 8: 8 }
  const resolved = presets[Math.round(finiteOr(width, 4))] || 4
  return Math.max(18, resolved * 6)
}
```

两条路径给它的输入不同：

| 路径 | 顺序 | 结果 |
|---|---|---|
| **绘制**（`capture.js:639`） | `blurBrushWidth(item.width) * deviceScale` | **先量化，后缩放** → 正确 |
| **识别遮罩**（`transformOccluder`） | `buildOccluders(css)` 再 `width *= max(scaleX,scaleY)` | **先量化，后缩放** → 正确 |
| **镜头采样遮罩**（修复前的 `annotationsForSampling`） | `width = item.width * widthScale` 再交给 `buildOccluders` | **先缩放，后量化** → **错** |

任何 `scale != 1` 都会让缩放后的数值落在预设之间（例如 `4 × 1.5 = 6`），
`Math.round(6)` 得到 6、不在 `{2,4,8}` 里，于是回落到 `|| 4` 的默认分支…
更关键的是 `presets[...] || 4` 的**落空回退**让宽度与真实缩放**完全脱钩**：
无论 `widthScale` 是 1.5 还是 3，遮罩宽度都被钉在同一个值上。

> 为什么上一轮的真机像素探针没抓到：`test/magnifier-runtime.test.js` 的同款断言用的是
> **DPR 1.5 的窗口**，但它的 blur 覆盖区是**一整块实心矩形**（`BLUR_RECT` 240×160），
> 镜头源区完全落在矩形内部 —— 窄 60px 的遮罩依然覆盖镜头中心的采样区，所以断言通过。
> 缺陷只在"镜头源区贴着马赛克边缘"时暴露。

### 2.4 修复

`capture/capture.js`：
1. `annotationsForSampling()` **不再**预乘宽度，把 CSS 预设宽度原样交给量化器；
2. 新增 `buildOccludersForSampling()`：**先** `buildOccluders()` 量化，**再**乘以 `widthScale`，
   与绘制侧同序；
3. `ensureSampleBase()` 改用 `buildOccludersForSampling()`。

### 2.5 验证

- 独立探针（21 组合）：修复后**0/21 偏窄**，遮罩宽度与绘制宽度**逐值相等**；
- **反向对照**：同一探针对修复前的公式报告 120 源像素（60/侧）缺口 → 证明探针真的能测出这个 bug；
- 新增回归测试 `test/capture-magnifier-ui.test.js` →
  "§7.2 the lens mask width is never narrower than the mosaic the user actually sees"，
  包含：21 组合行为断言 + 反向对照 + **调用点接线守卫**（防止有人把 `ensureSampleBase` 改回旧调用、
  而纯数学断言仍然通过）；
- 人为回退验证：把 `annotationsForSampling` 改回预乘宽度后，新测试**失败**；
  恢复后 **1813/1813 全绿**。

### 2.6 这次的教训（写进这里，避免再犯）

1. **"同源公式"断言只覆盖 scale = 1 是没有意义的。** 旧测试
   `test/magnifier-geometry.test.js` 的断言是
   `brushStrokeWidth(w) === blurBrushWidth(w)`，两边都不缩放 —— 恰好绕过了唯一会出错的维度。
   新测试把缩放维度显式列进来（1/1.25/1.5/1.75/2/2.5/3）。
2. **"整块矩形中采样"的探针无法发现边缘泄漏。** 要覆盖"贴着边缘"的情况，否则遮罩窄一半也过。

---

## 3. E（录屏导出）：我核对过的分支

读码核对了 `main/services/recording-export-service.js` 的 `runTask` / `encode` / `verify` /
`publish` / `cancelTask` / `finishCancelled` / `dispose`，以及
`shared/recording-export-options.js` 的 `taskTransition` 表。**结论：主路径自洽**，具体：

| 检查点 | 结论 | 依据 |
|---|---|---|
| 发布点之前的取消 | ✅ 生效，不替换目标 | `runTask` 在 `verify` 之后、`publish` 之前有独立检查点；检查与转移同步，无 await 间隔 |
| 发布之后的取消 | ✅ 不删成品、不改报 cancelled | `cancelTask` 对 `succeeded` 返回 `late: true`；对 `publishing` 返回 `publish-in-progress` 且**不改状态** |
| 取消时未退出子进程 | ✅ 先 kill 再删临时文件 | `cancelTask` 只 kill；`finishCancelled` 在 child 退出后才 `cleanupTemp` |
| 失败只删自己的临时文件 | ✅ | `cleanupTemp` 只碰 `task.tempPath`；`publish` 的三个失败分支都只 `cleanupTemp` |
| 原子替换 | ✅ 同目录 + 同卷 `rename` | `tempPathFor` 用 `path.dirname(targetPath)`；不是"先删后改名" |
| 目标被并发修改 | ✅ `target-changed` 拒绝 | `snapshotTarget` 比较 exists/size/mtimeMs |
| 源引用租约 | ✅ `finally` 里 release | `task.lease = null; lease.release()` 在 `finally`，覆盖 encode/verify/publish 全部抛出路径 |
| shutdown 有活跃任务 | ✅ 取消而不发布 | `dispose()` 对 `queued`/`running` 调 `cancelTask` 并等待 child 退出 |
| 用户导出不会被误遮 | ✅ `mask: false` | `capture.js:4016-4020`：`composedActions = !pixelOnlyActions`、`maskedActions = pixelOnlyActions` |
| 识别入口一定被遮 | ✅ 5 个动作全覆盖 | `recognitionActions = ['ocr','translate','table','qr','convert']`；全部出现在 `performAction(...)` 绑定里 |

### 3.1 仍然存疑（诚实标注，未定性）

**`publish()` 的快照比对与 `rename` 之间有一个 `await` 窗口。** 代码是：

```js
current = await this.snapshotTarget(task.targetPath)   // await
...比较...
await this.fs.rename(task.tempPath, task.targetPath)   // await
```

两个 await 之间目标文件仍可能被外部程序改写，此时导出会覆盖一个"刚刚被改过"的文件。
**但我认为这是可接受的**，理由是语义上这就是"最后写入者获胜"，且先删后改名才是危险的做法
（本实现用的是原子 rename，失败时旧文件仍可读）。**这是一个 known limitation，不是缺陷** ——
若要彻底消除，需要在 rename 前持有目标文件的独占句柄，代价是与其他写入者互斥。
**建议**：在文档里把它记为已知限制，不要当作 bug 修。

**另一个不对称（低）**：`publish()` 在 rename 成功后调用 `transition(task,'succeed')`；若此时
任务已被标记为 `cancelling`（理论上 `publishing` 不能转 `cancelling`，转移表也禁止），
`transition` 会返回 false 而任务状态停在 `publishing`。**核对转移表后确认不可达**
（`publishing` 只允许 `succeed`/`fail`），因此不是缺陷；但 `transition` 的返回值在 `publish`
里被忽略，未来若放宽转移表会静默产生"卡在 publishing"的任务。**建议加一行断言或注释**，
优先级 low。

---

## 4. 我**没有**覆盖的部分（不得当作已评审）

- **对抗式并发穷举**：我做了读码 + 转移表枚举 + 针对 6 个缺陷的故障注入回归测试，但**没有**
  把 cancel/complete/publish 的所有交错穷举一遍。`export-reviewer` 的报告里还有 E-04..E-15
  未修（见 §6）。
- **schema v1→v2→v3 迁移无损性的完整往返**：我读了迁移链结构，**没有**独立构造 v1/v2 文档做
  "打开不变脏"的指纹比对。`privacy-reviewer` 的 F5（`normalizeRect` 的地板）指出
  2 099/2 856 组文档往返会改指纹 —— **这条未修，见 §6**。
- **真实识别模型端到端**（OCR/翻译/表格/QR 服务）：未跑，与交接文档口径一致。
- **实机矩阵**（副屏/跨 DPI/屏幕重排/真实录制）：本机单屏，**无法**验证。
- **`clipMagnifiersToCrop` 载入帧不可撤销**：F3 修的是坐标系错配；"载入帧移除不可撤销"
  这个**设计**选择本身未改（交接文档 §7.5 已把它登记为有意为之）。

---

## 5. 本轮动作清单

| 动作 | 状态 |
|---|---|
| 修复 F1 文档编辑器识别遮罩错位（隐私 P0） | ✅ 完成 |
| 修复 F2 文档编辑器镜头采样错区（隐私 P0） | ✅ 完成 |
| 修复 F3 打开时裁小/删除合法镜头 | ✅ 完成 |
| 修复 F4 镜头遮罩宽度不足 | ✅ 完成 |
| 修复 E-01 无法取消导出 | ✅ 完成 |
| 修复 E-02 verify 期取消被吞 | ✅ 完成 |
| 修复 E-03 目标==源导致丢录制 | ✅ 完成 |
| 修复 E-07 准入竞争 + 假 rate-limited | ✅ 完成 |
| 修复 E-10 / E-13 取消相关 UI | ✅ 完成 |
| 新增回归测试（每个修复都有，含反向对照） | ✅ 完成 |
| 全量测试 | ✅ **1819/1819** |
| `npm run check` | ✅ exit 0（447 文件） |
| 覆盖率 `test:coverage:loaded` | ✅ 92.02% lines（阈值 85%） |
| 覆盖率 `test:coverage:critical` | ✅ 93.46% lines（阈值 90%） |
| 性能样本（C/D/E） | ✅ `docs/plans/2026-10-26-cde-performance-samples.md` |
| 三账（本地/CI/安装包/实机）重记 | ✅ 更新到交接文档 §7.2 |
| 子智能体独立评审报告 | ✅ 两份均已落地 |

---

## 6. **仍未修**的评审发现（诚实清单，不得当作已解决）

按"是否影响发布"排序。**这些都没有修**，交接时不要读成"评审已完成且全部关闭"。

### 6.1 隐私侧（来自 privacy-review）

| ID | 严重度 | 问题 | 为什么不本轮修 |
|---|---|---|---|
| **F5** | medium | `normalizeRect` 的 `MIN_SOURCE_EDGE_PX=4` 地板在**两个坐标空间**都生效：`normalizeRect({w:0.8}).w === 4`。文档往返 2 099/2 856 组改变内容指纹 → 破坏"打开不变脏"；且漂移值仍能通过 `validateMagnifier` | 修法明确（与 `stroke.widthPx` 同款：normalize 不夹范围，范围归 `validateMagnifier`），但它会改变**已落盘数据**的读取结果，需要单独的迁移/兼容判断。**优先级最高的未修项**。 |
| **F6** | medium | 采样缓存键用 `${naturalWidth}x${naturalHeight}` 当底图身份 → **两张同尺寸不同图碰撞**，同窗口换底图（pin 重标注/同尺寸 A→B）会命中旧缓存 | 键碰撞 CONFIRMED，端到端触发 SUSPECTED。修法：用 `initData.baseImage.sha256` 或 assetId。改动小但需要确认 `initData` 里该字段在**所有**入口都可靠存在。 |
| **F7** | medium | crop 外有 blur 时 `planOcclusion` 裁剪掉所有 op → `masked=false` → fail-closed 全画布涂黑（隐私安全，但用户会看到"全黑"/`mask-unavailable`） | F1 修好后症状大幅缓解（画布不再是 crop）；"blur 完全在 crop 外应视为无需遮"这个语义判断需要产品确认。 |
| **F8** | low | `sampleMagnifier` 的 `drawImage` 源矩形不 clamp，源区贴边时读越界（平台相关透明/拉伸边缘，**非隐私问题**，遮罩已画在底图上） | 低风险，需要真机看边缘表现再定。 |
| **F9** | low | `ensureSampleBase` 的 catch 不清 `sampleBaseKey`/不 `reset()`，失败瞬间同帧第二个镜头会用旧底图 | 概率低；一行修复，但需要确认不会与缓存失效逻辑打架。 |
| **F10/F11** | nit | 每帧多次 `normalizeMagnifier`；`sourceRect` 未量化（F5 的表述） | 性能/整洁，非正确性。 |

### 6.2 导出侧（来自 export-review，我修了 E-01/02/03/07/10/13，以下未修）

| ID | 严重度 | 问题 | 备注 |
|---|---|---|---|
| **E-04** | high | `dispose()` 在任务处于 `publish()` 时**不等待**就返回，任务随后仍会发布；`before-quit` 不 `preventDefault` | 评审者已用 900ms rename 证明。修法要动退出协议（`recordDomain.shutdown` + `main.js`），**不属于本文件的小改**。 |
| **E-05** | high | 快照复查 → rename 之间有 TOCTOU（证明可被竞争写入覆盖并报成功） | 无法用 `stat`+`rename` 彻底关闭；建议**记录为已知限制**并文档化 §8.4 的措辞（评审者也建议 (b) 单飞守卫）。**不要假装已修。** |
| **E-06** | high | `export-timeout` 可能残留 0 字节 `.part`（3 次实测 2 次）；且 `export-timeout` 码永远到不了渲染层（被报成 `encode-failed`） | 修法明确（await child close 再 cleanup；把错误码透传），但需要小心不要在超时路径上无限等。 |
| **E-08** | high | 被 `writerCoordinator` 拒绝的任务**已经启动了 ffmpeg** 才报失败（真实子进程被拉起） | 需要在 `track()` 之前做准入；会改动 `pump()` 结构与数据迁移协调，风险中等。 |
| **E-09** | medium | `succeeded` 但 receipt 为 null 时控制器按 `encode-failed` 处理 → 文件已写出却报错，重试还会产生第二个文件 | 产品语义要先决定（降级成功 vs 报错）。 |
| **E-11** | medium | 音频短于选区时 `hasAudio` 仍为 true → `atrim` 无包 → 校验拒绝一个**本来有效**的 MP4 | 真实场景（录屏中途静音）。修法：把音频期望当作"上限"而不是"必须"。 |
| **E-12** | medium | `verify` **从不检查容器/编解码**（probe 读出来了却被忽略）；GIF fps 有回退但 `expected.fps` 不参与校验 | 防御纵深；当前 `normalizeExportRequest` 会先拒坏 fps，所以不是活 bug。 |
| **E-14** | low | `tempPathFor` 可能超过 `MAX_PATH`，且每次 submit 烧一次 mkdir/open/rm | 需要 Windows 长路径设置确认。 |
| **E-15** | low | 深探测 stdout 上限 512 KiB，约 12.8 天才可能截断 | 实际不可达，仅记录。 |

### 6.3 结构性问题（评审者的重要观察）

> **`resolveOcclusionPlan` 与 `clipMagnifiersToCrop` 在 `shared/capture-document.js` 里
> 没有任何生产调用方。** 渲染层的两条隐私路径（识别遮罩、镜头采样）各自独立构建 plan，
> 而主进程那份"权威" plan 从未被使用。**这是 F1/F2 能同时存在的结构性原因**：
> 没有单一入口，两处就各错各的。

本轮修了两处的**行为**，但没有合并成单一入口 —— 那是一次跨层重构，需要主进程与渲染层
共用同一 plan 生产者，超出"修复评审发现"的范围。**建议下一轮优先做这件事**，
否则同类坐标错配还会以别的形式回来。

---

## 7. 这次评审给出的方法论教训（值得写进 AGENTS）

1. **纯正则断言钉不住行为。** `test/occlusion-recognition-wiring.test.js:62-64` 的
   `assert.match(..., /mask\.buildOccluders\(input\.annotations\)/)` **匹配的正是那行有 bug 的代码**；
   `test/capture-magnifier-ui.test.js` 同样用正则。两处都在 F1/F2 存在时继续通过。
2. **测试 double 忽略 `disabled` 会让"按钮不可点"这类 bug 永久隐身。**
   `test/recording-trim-ui.test.js` 的 `FakeElement.dispatch` 直接调监听器，
   所以 E-01（取消按钮永远 disable）在 1810 个绿测试下存在了很久。
   新测试显式检查 `button.disabled !== true` 再派发。
3. **探针自己构造理想输入 = 测不到接线错误。** `magnifier-runtime.test.js` 绕过
   `annotationsToViewport` 直接写字面量，所以 F2 在它眼皮底下。
4. **"整块矩形中采样"发现不了边缘泄漏。** F4 的同款真机探针用大矩形模糊块，
   遮罩窄 60px 仍然覆盖中心采样区。

