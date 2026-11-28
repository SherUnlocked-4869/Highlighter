# 2026-11-27 截图历史 OCR / 标签交互问题修复方案

> 来源：5.1.0 发布候选的真机验证。用户在主窗口「截图历史」页发现三个交互问题，
> 均属于 N02（历史截图 OCR 索引 + 标签）后半段首次上真机后暴露的缺陷。
> 本文记录复现结论、根因、修复设计与验收；实现与回归证据见
> [2026-11-26 评审证据登记表](../evidence/2026-11-26-review-optimization-evidence.md)。

## 1. 中文输入法输入时搜索框被整页重绘打断

**现象**　在搜索框输入中文时，每敲一个拼音字母就触发一次搜索，页面闪一下；
候选词窗口被中断，最后搜索框里只剩输入过的英文字母。

**根因（已按代码确认）**

1. `config/routes/history.js` 的 `searchInput.oninput` 对每个 `input` 事件都
   `historyQuery = searchInput.value` 并在 220 ms 后调用 `renderHistory()`。
   Chromium 在 IME 组字期间会为每个拼音按键派发 `input`（`isComposing === true`），
   因此组字过程中就会排队触发搜索。
2. `renderHistory()` 是**整页重建**：先 `view.innerHTML = …正在加载…`，再重新拉取并渲染
   统计、筛选、批量栏与结果网格。重建会替换正在组字的 `<input>` 节点，组合会话随 DOM
   节点一起被销毁；新节点用 `historyQuery`（此时是未提交的拼音字母）回填 value，
   于是呈现为“只剩输入的字、中文没上屏”。
3. 同一路径也让每次搜索都先闪一下加载态——即使不涉及 IME，整页重建也是不必要的。

**修复**

- IME 感知：`compositionstart` 清空并暂停防抖、置 `historySearchComposing`；
  组字期间的 `input`（`event.isComposing`）直接忽略；`compositionend` 用已提交的值搜索；
  Enter 在组字中（`isComposing` / `keyCode === 229`）不触发搜索。
- 搜索/来源/标签筛选只走**结果区更新**：新增 `historyApplyFilters()`，只重新查询
  `history:list` 并用 `historyRenderFilteredResults()` 通过既有卡片 diff（`historyPatchCards`）
  换结果网格；统计卡、筛选栏、批量栏、搜索框节点和焦点/光标全部保留，页面不再闪加载态。
- 卡片 diff 复用未变化记录的元素与已加载缩略图，增量搜索时不会每敲一个字母重载全部缩略图。

**验收**　`e2e/highlighter.spec.js` 的真实 Electron 用例在组字期间派发
`compositionstart` + `isComposing` 的 `input`，断言 500 ms（旧防抖的两倍多）后输入框仍是
同一 DOM 节点且值保留；`test/n02-history-ocr-ux.test.js` 固定上述接线。

## 2. 无法确认 OCR 是否识别完成

**现象**　搜索图中文字没有结果时，无法判断是“图中确实没有文字”还是“这条截图还没做过
OCR / OCR 还没跑完”，只能猜。

**根因（已按代码确认）**

- 后台索引器只写 `ocrText`：识别成功才有字段，空结果和失败都不留痕；旧记录、关闭 OCR
  时保存的记录、队列满被丢弃的记录、应用中途退出的记录都没有任何状态。
- 卡片不渲染任何识别状态；`HistoryService.toListItem` 还特意把 `ocrText` 排除在列表投影
  之外（避免每页传 800 KiB 文本），所以渲染层连“有没有文本”都无从判断。
- 没有手动重试入口：`failed` 记录（或历史旧记录）永远不会再被自动索引，搜索不到也没有出路。

**修复**

- 记录增加显式 OCR 状态：`pending`（排队/进行中）、`done`（有文本）、`empty`（识别完成但
  无文字）、`failed`（重试后仍失败）、`skipped`（用户关闭 OCR/历史导致任务被丢弃）。
  `pending` **不落盘**：由索引器内存队列派生（`HistoryService.ocrStatusOf()` 询问
  `indexer.isActive()`），接受任务时只发一次不写库的 `history:changed`，避免在截图保存路径上
  再整表写一次历史；成功走 `updateOcrText()`（同时写 `done`+时间），空结果写 `empty`，最终
  失败写 `failed`，因开关关闭被丢弃写 `skipped`。
- 状态推导 `HistoryService.ocrStatusOf()`：持久化的 `pending` 只有当前索引器仍持有该 id
  才算“进行中”；重启后的陈旧 `pending` 视为未索引。第一个 N02 版本只写了 `ocrText` 的旧
  记录无需迁移，直接按 `done` 读取。
- 列表投影增加 `ocrStatus` 与 `ocrTextLength`（不传正文）；卡片缩略图左下角显示状态徽标
  （已识别 N 字 / 无文字 / 识别中… / 识别失败 / 未识别），并进入卡片签名，后台完成后原地刷新。
- 页面级状态条：`history:list` 命令信封新增 `{op:'ocr-state'}`，返回内存统计
  （`ocrSummary()`）与索引器队列快照；有任务时显示“正在识别…待处理 N 条”，空闲但有缺口时
  显示“N 条截图还没有文字索引”并提供「识别未索引项」按钮，全部就绪时隐藏。
- 手动入口：命令信封 `{op:'index-ocr', ids|all}`。单卡“识别文字 / 重新识别”经索引器
  `force` 路径清掉失败条目重排；页面级一次为所有缺索引记录排队（批量只发一次队列通知，
  接受任务不写库）。用户主动批量为右显式动作，允许越过自动队列上限 40；`empty`（已识别且
  无文字）与文件已丢失的记录不再重复排队，`{op:'index-ocr'}` 缺少 ids/all 时直接报错而不是
  默认全量识别。
- 索引器不再把“空识别”混同为“识别失败”：`recognizeText` 返回 `{ok, text}`，卡片能区分
  “识别完成但无文字”和“识别失败”。

**验收**　`test/n02-history-ocr-ux.test.js` 覆盖状态归一化、`pending/done/empty/failed/skipped`
写入、重启后陈旧 `pending` 视为未索引、旧数据兼容、失败后显式重试、开关关闭写 `skipped`、
队列 `activeId` 快照、页面状态条优先级（进行中 > 缺口 > 隐藏/不可用）与卡片签名变化；
`e2e/highlighter.spec.js` 断言空历史时状态条隐藏（无噪声）。

## 3. 标签只能手动输入搜索，没有下拉框

**现象**　搜索框的占位文案说可以搜标签，但用户只能凭记忆把标签文本打进自由搜索框；
筛选项里也没有“按标签筛选”。

**根因（已按代码确认）**

- `HistoryService.matchesHistoryFilter` 只做 `query` 的字符串包含匹配（标签只是可搜索文本的
  一部分），`normalizeHistoryFilter` 也没有标签维度。
- 页面没有“已存在标签”的数据源：`history:list` 只返回分页记录，`history:sources` 只返回来源；
  卡片虽然能编辑标签（N02 前半段），但没有任何聚合读数。

**修复**

- `HistoryService.listTags()`：内存遍历历史，按大小写不敏感聚合 `{ tag, count }`，按使用次数
  降序、同次数按名称排序。刻意不做逐条磁盘存在性探测——它在每次 `history:changed` 推送后都会
  被读取，逐条探测会重现 F01 已消除的整库磁盘扫描。
- 过滤维度：`normalizeHistoryFilter` 增加 `tag`；`matchesHistoryFilter` 对标签做**精确**
  大小写不敏感匹配（避免选 `invoice` 时命中 `invoice-2024`）。自由文本 `query` 仍保留对标签
  的包含匹配，兼容既有习惯。
- 命令信封 `{op:'list-tags'}` 提供下拉数据；筛选栏新增 `<select id="historyTag">`
  （`全部标签` + “标签 (条数)”），选择即按标签过滤，走与搜索相同的结果区更新路径。
- 标签增删后 `history:changed` 推送会重读下拉数据；当前选中的标签随最后一条记录消失时自动
  回落“全部标签”并重查列表，避免下拉与结果不一致。

**验收**　`test/n02-history-ocr-ux.test.js` 覆盖精确匹配/大小写/子串不命中、计数排序、
内存读无磁盘探测、命令信封路由；`test/history-service.test.js` 更新过滤器形状断言。

## 4. 实现复核修正（独立评审发现）

实现完成后做了一轮独立代码评审，修正了修复本身引入或遗留的问题；这些问题都不在最初的
三条现象里，但会直接影响同一条交互链路的可用性：

| 问题 | 影响 | 修正 |
|---|---|---|
| “加载更多”在搜索/筛选后失效 | 筛选会更新列表版本，而分页闭包仍比较整页渲染时的旧版本；一次按键后分页永远不动，且按钮停在禁用态 | 分页改用 `state.version` 列表代际比较，`finally` 中恢复按钮；真实 Electron 用例覆盖“搜索后加载第二页” |
| 缩略图被误判为不可用 | 结果区更新会让在途缩略图 IPC 的旧版本号失配，被当作加载失败并永久打上“不可用” | 只有真的拿不到缩略图才标不可用；版本失配但节点仍在文档中时照常写入 `src` |
| 组字状态标志可能卡住 | 若某些路径没有收到 `compositionend`，标志会一直吞掉后续普通输入 | 新建输入框时复位、`blur` 复位、`input` 事件 `isComposing=false` 时自愈；Enter 仍受 IME 保护 |
| 标签读取失败会清空标签筛选 | 可选的 `list-tags` 读取失败被当成“标签已消失”，静默清掉用户筛选 | 失败返回 `null`，只有确认标签列表存在且不含所选标签时才回落；失败时保留下拉里的所选标签 |
| 标签重置后的二次等待缺少守卫 | 标签重置会二次请求列表，期间离开页面或开始新渲染时仍写旧 DOM | 第二次 `await` 之后重新检查路由与渲染代际 |
| `index-ocr` 缺目标时默认全量识别 | 渲染层拼错载荷可能触发整库 OCR | 命令层要求 `ids` 或 `all`，否则报错 |
| 全量补索引重复处理空结果/失效文件 | `empty` 记录和文件已丢失的记录被反复排队，状态条永远提示可重试 | 只重排未索引/失败/跳过；文件丢失的记录跳过；`empty` 视为终态 |
| 截图保存路径多一次整表写入 | `enqueue()` 为此前写 `pending` 会同步重写整个历史数组 | `pending` 改为内存派生 + 不写库的队列通知；批量补索引只发一次通知 |

## 5. 验证与回退

- 自动化：`test/n02-history-ocr-ux.test.js`（新增，22 项）、既有 history/N02 用例、
  `npm run check`（语法 / 架构 / 三语 i18n / 评审证据）、真实 Electron 的
  `e2e/highlighter.spec.js` IME 用例与 `e2e/main-window-ui.spec.js` 分页用例。
- 真机门槛（仍需发布候选上人工确认）：微软拼音/搜狗输入法实际输入中文、真实 OCR 模型下
  徽标状态与“识别未索引项”的进度、标签下拉在浅色/深色与窄窗下的布局。
- 回退粒度：三个修复互不依赖；标签下拉与状态条均通过既有 `history:list` 命令信封扩展，
  不新增 IPC 通道，回退到旧版本 preload/主进程时列表契约保持不变。
