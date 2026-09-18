# 代码评审结论 · commit `33365bd`

## 一、评审对象

| 项 | 内容 |
| --- | --- |
| Commit | `33365bd8ae81b9b5a7ff4af7cdd49e58af817683` |
| 标题 | `design(ui): finish Nightshift accent fidelity and polish toolbar/history` |
| 作者 | Sherunlocked `<2453257924@qq.com>` |
| 日期 | 2026-09-17 16:35:14 +0800 |
| 变更范围 | 17 个文件，+644 / −58 |
| 基线 | 上一提交 `fda21b6`（Nightshift 语言应用到各渲染层） |

变更内容概括：为 Nightshift 重设计收尾。核心是新增 `main/services/appearance-migration.js`，把旧版 Ant Design 蓝主色从持久化设置 `mainColor` 迁移到 Nightshift 琥珀色 `#e5a44c`，并接入 store 迁移链与 `normalizeSettings`；同时重绘划词工具栏（状态 LED + 单一实心主色按钮）、识别结果窗（状态徽标）、配置页历史网格（缩略图底片、悬停显现操作），并补充设计稿与测试。

## 二、评审方式与可信度

- 工具：`alibaba/open-code-review`（`ocr` CLI），LLM provider `deepseek` / model `deepseek-flash`，`ocr llm test` 连接正常。
- 命令：`ocr review --audience agent --commit 33365bd -b "<业务上下文>"`
- 规模：12 个文件进入评审（二进制 PNG 未评审），137 次工具调用，约 200 万 tokens，耗时 2 分 55 秒。
- **原始输出 10 条评论，其中 4 条实为 2 组重复，去重后 8 个独立问题。**
- 本结论中的每一条均已由我回到源码独立复核，而非直接采信工具输出。复核手段包括：`git log -S` 历史追溯、窗口宽度算式逐步复算、CSS 绘制层级确认、token 定义存在性检查。凡复核不成立或需降级者，均在第五节注明。

## 三、总体结论

> **结论：需修改后合入（Request changes）**

- **主要问题**：本次提交在**默认配置**下把工具栏的宽度预算撑破了。需要更正的是：实测**没有发生裁切**——6px 内边距把溢出的 9px 吸收了，真正被吃掉的是设计内边距本身，两端内缩从设计值 **9/7px** 变成 **3.5/1.5px**，条带显得局促且左右失衡；5 个动作（开启可选「跳转」）时 LED 的 3px 光晕被切掉 1px、末按钮与外框齐平。功能性损伤出现在动作数更多时：满配 17 个动作下 **17 个按钮中有 12 个标签被省略号截断**（改动前为 0/17）。详见第四节实测数据。
- **无安全类问题，无数据损坏类问题。** 主色迁移逻辑方向正确，仅有一个成员取值缺乏依据（Medium-3）。
- **其余为交互与视觉缺陷**：失败态徽标仍显示成功绿（Medium-1）、悬停才出现的操作按钮其实一直可点击且包含删除（Medium-2）、历史缩略图发丝边框被图片遮挡（Medium-4）。
- **8 项中 5 项影响出厂界面，3 项仅影响 `design-demos/` 参考稿。** 综合风险等级：**中低**。

## 四、问题清单

| # | 优先级 | 位置 | 问题 | 复核 |
| --- | --- | --- | --- | --- |
| High-1 | **Medium**（原判 High，实测后下调） | `toolbar/toolbar.js:27-30`、`toolbar/toolbar.html:26-30` | 新增 LED 与间距超出宽度预算：默认下吃掉内边距（内缩 3.5/1.5 而非 9/7），满配时 12/17 个标签被截断 | ✅ 成立（表述已修正） |
| Medium-1 | Medium | `recognition/recognition.js:26`、`recognition/recognition.css:66-68` | 识别失败时徽标仍是成功绿 | ✅ 成立 |
| Medium-2 | Medium | `config/config.css:179-180` | `opacity:0` 的隐藏操作按钮仍可点击，含破坏性「删除」 | ✅ 成立 |
| Medium-3 | Medium | `main/services/appearance-migration.js:17` | `#1687ff` 并非历史主色，会静默改写合法的用户自定义色 | ✅ 成立 |
| Medium-4 | Medium | `config/config.css:170` | `box-shadow: inset` 发丝边框被绝对定位的 `img` 遮挡 | ✅ 成立 |
| Low-1 | Low | `recognition/recognition.css:126-128,163` | 顶栏与内容区各画一条边框，叠成 2px 接缝 | ✅ 成立 |
| Low-2 | Low | `design-demos/toolbar-history-redesign.html:22` | 日间主题 `--primary-ink` 翻成近白，实心色块对比度约 2:1 | ✅ 成立（仅设计稿） |
| Low-3 | Low | `design-demos/toolbar-history-redesign.html:117` | 选择器为死代码，且缺 `:focus-within`，按钮键盘不可达 | ✅ 成立（仅设计稿） |

### High-1（现 Medium）· 工具栏宽度预算被撑破

> **实测修正**：本条原始表述称 LED 与首尾按钮"会被裁掉"，**该说法不成立**。用 Chromium 在真实关键宽度下实测（见第五节实测记录），6px 内边距把溢出完全吸收，元素并未被窗口裁切。真实症状是内边距被吃掉导致的局促失衡，以及动作数多时的标签截断。优先级由 High 下调为 **Medium**；ID 保留 `High-1` 仅为与修复方案对照。

**证据（已复算）**

窗口宽度由 `getToolbarWidth()`（`toolbar/toolbar-utils.js:213`）决定，`main.js:1044` 将其直接传给 `showToolbarSelection({ width: toolbarWidth })`，故窗口宽度就是该值；`test/toolbar-utils.test.js:145` 亦断言 4 个默认动作（各 2 字，`42 + 2×14 = 70`）等于 **300px**。

新增样式下的最小内容宽度：

```
边框 2 + 内边距 12 + LED(6 + 左2/右5 外边距) 13
+ 4 × min-width:62px                        248
+ 3 × 分隔线(1px + 左右各 2px)               15
+ 7 × flex gap 3px                           21
= 311px  >  300px 窗口
```

改动前为 `18 + 248 + 3 + 24 = 293px`，**恰好放得下**——因此内容盒溢出确为本次提交引入。但 300px 窗口的内容盒只有 `300 − 2(边框) − 12(内边距) = 286px`：溢出 11px 中有 2px 落在 LED 的左边距上，其余 9px 被左右各 6px 的内边距完全吸收，**窗口级裁切量为 0**。按钮为 `flex: 1 1 62px; min-width: 62px`，无法收缩；`justify-content:center` 使溢出在两侧均分。

**实测症状**（Chromium，真实 `DEFAULT_SELECTION_TOOLBAR` payload）：

| 动作数 | 预算 | 窗口级裁切 | 光晕裁切 | 左/右内缩（设计值 9/7） | 标签截断 |
| --- | --- | --- | --- | --- | --- |
| 4（默认） | 300 | 0 | 0 | **3.5 / 1.5** | 0/4 |
| 5（+跳转） | 370 | 0 | **1px** | **2 / 0** | 0/5 |
| 6（+1 自定义） | 454 | 0 | 0 | 7.5 / 5.5 | 1/6 |
| 17（满配） | 1378 | 0 | 0 | 9 / 7 | **12/17** |

改动前（旧 CSS + 旧预算）四个动作数的内缩均为 **9 / 9**，截断为 0/4、0/5、**1/6**、**0/17**。两相比较，本次提交的实际影响是：默认下条带局促失衡；5 动作时光晕被切 1px、末按钮与外框齐平；**满配 17 动作时 12/17 个标签被截断**——这是唯一的功能性损伤（6 动作那 1 例改动前就存在，非本次引入）。

**建议**：把 LED 纳入宽度预算——将 `getToolbarWidth()` 的 `20` 基线提到约 `36`（4 动作 300→316，5 动作 370→386），并同步更新 `test/toolbar-utils.test.js:145` 的断言；或放宽 `.btn` 的 `min-width` / 内边距。

### Medium-1 · 失败态徽标显示成功色

`showError()` 把 `badge.textContent` 改为「识别失败」，但未改变 class；而 `.badge` 硬编码 `color: var(--ok); background: var(--ok-soft)`。于是识别失败时，报错视图旁边挂着一枚绿色的失败徽标，状态语义自相矛盾。

**建议**：新增 `.badge.is-error { color: var(--danger); background: var(--danger-soft) }`，并在成功/失败路径切换该 class（`--danger`、`--danger-soft` 在 `shared/tokens.css:60,95,136,153` 均已定义）。

### Medium-2 · 隐藏的历史操作按钮仍可点击

`opacity: 0` 不会移除命中测试，按钮虽不可见却仍占据布局并可被点击，其中包含破坏性的「删除」。在不悬停的场景下，点击看似空白的卡片区域可能误触删除；`.16s` 淡出过程中同样存在窗口期。

**建议**：`.history-actions` 加 `pointer-events:none`，在显现规则中恢复 `pointer-events:auto`。`pointer-events` 不影响键盘焦点，故 `:focus-within` 的键盘可达性不受损。

### Medium-3 · `#1687ff` 会静默改写合法自定义主色

文件注释称迁移目标是「已知的重设计前主色」，但追溯历史后：

- 重设计前的默认主色**只有** `#1677ff`（`git show fda21b6^:main.js` 可证）；`#1890ff` 在本仓库历史中从未作为 `mainColor` 默认值出现。
- `#1687ff` 是**录屏标注色的蓝色**（`record/annotation-utils.js:3` 的 `ANNOTATION_COLORS`、`record/record.html:36` 的色板按钮），`git log -S'1687ff'` 显示它只经由标注功能与该提交进入仓库，从未作为主色默认值。

由于 `resolveMainColor` 在 `normalizeSettings` 中无条件生效，自定义主色恰为 `#1687ff` 的用户会被无提示地改写成琥珀色——这是对持久化设置的单向静默变更。

**建议**：除非能确认 `#1687ff` 曾是出厂默认，否则从 `LEGACY_MAIN_COLORS` 中移除；保留 `#1677ff`（如需覆盖 AntD v4，可保留 `#1890ff`）。

### Medium-4 · 缩略图发丝边框被图片遮挡

`box-shadow: inset` 属背景绘制阶段，位于后代内容之下；`img { position:absolute; inset:0 }` 铺满整块底片，`object-fit:contain` 时图片内容贴到的那两条边（通常是左右）会把 1px 边框盖掉，视觉上边框只出现在另两侧、像是断的。值得注意的是，本提交的设计稿反而做对了——`toolbar-history-redesign.html:112` 用 `.plate::after` 伪元素叠加，落在图片之上。

**建议**：改用真实 `border: 1px solid var(--line)`（全局 `box-sizing:border-box`，`inset:0` 相对 padding box 解析，边框仍可见），或采用设计稿的 `::after` 叠加方案。

### Low 级

- **Low-1**：`.topbar` 保留 `border-bottom`，而新增的 `.table-view` / `.qr-view` 又各自加了 `border-top`，两行相邻叠成 2px 接缝；参考设计只画一条。删掉内容区的 `border-top` 即可。
- **Low-2**：`body.day` 把 `--primary-ink` 翻成 `#fff8ec`，却未覆盖继承自 `:root` 的 `--primary:#e5a44c`，日间主题下实心色块为近白字压琥珀底，实测对比度约 2.04:1。出厂 token 体系里 `--primary-ink` 由 `--primary` 推导且刻意不参与主题覆盖，设计稿应与之对齐。**仅影响设计稿，不影响出厂界面。**
- **Low-3**：`.h-card:hover .h-a .acts` 中 `.h-card` 与 `.h-a` 是同一节点（`toolbar-history-redesign.html:234` 为 `class="h-card h-a"`），该选择器永不匹配；且无 `:focus-within` 分支，变体 A 的操作按钮键盘不可达。**仅影响设计稿。**

## 五、独立复核记录

**确认成立**：上述 8 项全部经源码复核。其中 High-1 的**表述经实测修正、优先级下调**（见下）。

**实测复核（High-1）**：仅靠源码算术不足以下"被裁切"的判断，因此用 Chromium（Playwright，headless）加载真实 `toolbar/toolbar.html`，注入 `toolbarAPI` 桩后派发 `DEFAULT_SELECTION_TOOLBAR` 的真实动作载荷，在关键宽度下测量子元素相对**窗口边界**（而非内容盒）的位置，并检查每个按钮的 `scrollWidth > clientWidth` 以判定标签截断。结论：窗口级裁切在所有情形下均为 0，原表述的"裁掉 LED 与首尾按钮"不成立；真实症状是内边距被吃掉与满配时的标签截断。据此将 High-1 下调为 Medium。完整数据见第四节表格与修复方案第八节。

**与工具原始判定的差异（本结论的调整）**

- 工具把工具栏宽度标为 `bug · medium` 并称"clipped"；本结论先上调为 High，**实测后回调为 Medium**——工具对症状的描述（clipping）与实测不符，但预算缺陷本身真实存在。
- 工具把 Medium-3（`#1687ff`）标为 `bug · low`，本结论**上调至 Medium**：它静默改写用户持久化设置，且注释中的立论依据经历史追溯不成立。
- 工具把两条设计稿问题标为 Medium，本结论**下调至 Low**：`design-demos/` 不随产品发布，不影响用户。
- 工具的 10 条评论含 2 组重复（工具栏宽度、徽标失败态），已合并为 2 项。

**复核通过、确认无问题的部分**

- `main.js` 中迁移链的包装写法正确：`migrateAppearanceSettings(ai.settings)` 以 AI 迁移的输出为输入，`changed` 用 `||` 正确合并，`{ settings, changed }` 返回形状符合 store 约定。
- `record/record.css` 移除 `--blue: var(--primary)` 别名后，全文已无 `--blue` 残留引用；原 `rgba(22,135,255,.16)` 光晕正确替换为 `var(--primary-soft)`。
- `recognition.css` / `toolbar.html` / `config.css` 新引用的 token 全部存在：`--ink`、`--ok`、`--ok-soft`、`--primary-ink`、`--primary-soft`、`--font-display`、`--font-mono`、`--shadow-1`、`--radius-pill`、`--focus-ring`。
- 主色取值一律按 `/^#[0-9a-f]{6}$/i` 校验，`appearance-migration.js` 的 6 位十六进制限制与 `selection-window-manager.js:242`、`preload-action.js:19`、`toolbar/toolbar.js:10` 的既有约定一致，未引入新的格式不兼容。
- 迁移与 `resolveMainColor` 的分工合理：前者落盘一次，后者兜住运行时，且新增测试覆盖了三种旧蓝、自定义色保留与空值回退。

## 六、行动清单

**已落地（P0 + P1，2026-09-17）**

- [x] 修复工具栏宽度预算：`getToolbarWidth()` 改为逐动作计入外框（`chrome + buttons`）。注意**不是**把基线 `20` 抬到 `36`——那只能覆盖到 5 个动作。同步更新 `test/toolbar-utils.test.js` 两处断言并新增 n=1..17 覆盖用例。实测结果：内缩恢复 9/7，4/5/6/17 动作全部 0 截断。
- [x] 徽标增加 `.is-error` 变体，并在 `recognition.js` 以 `setBadge(text, failed)` 统一切换，避免文字与色调再次漂移。已在**真实 Electron**（真实 preload/IPC + 锁定沙箱偏好）中验证成功与失败 × 明暗共四阶段：计算色与背景分别精确等于 `--ok`/`--danger` 与对应 soft 值，帧内徽标区像素红/绿占优方向正确，四帧互不相同，console 错误 0。
- [x] `.history-actions` 补 `pointer-events:none`，显现规则恢复 `auto`。

**可随后处理（P2）**

- [ ] 复核并移除 `LEGACY_MAIN_COLORS` 中的 `#1687ff`。
- [ ] `.history-image` 发丝边框改用 `border` 或 `::after`。
- [ ] 移除 `.table-view` / `.qr-view` 多余的 `border-top`。

**可选（P3，仅设计稿）**

- [ ] 修正 `toolbar-history-redesign.html` 日间主题的 `--primary-ink`。
- [ ] 修正该文件第 117 行的死选择器并补 `:focus-within`。

## 七、说明与遗留

1. **`ocr review` 退出码为 1，但评审本身已完成**（12 文件、10 条发现、2m55s）。失败点是最后一步把会话日志写入 `C:\Users\MSN\.opencodereview\sessions\F_workspace-Highlighter\*.jsonl` 时被文件沙箱拒绝（该路径在工作区之外）。若希望后续评审正常落盘会话记录，需放开该路径的写权限。
2. **评审阶段未修改任何源码**（结论文件是当时唯一新增产物）。后续按第六节行动清单落地了 P0 + P1，共改动 5 个产品文件（`toolbar/toolbar-utils.js`、`test/toolbar-utils.test.js`、`recognition/recognition.js`、`recognition/recognition.css`、`config/config.css`），详见修复方案。
3. **评审范围仅限 `33365bd`。** 评审时工作区存在与该提交无关的未提交改动（`main/services/selection-hook-service.js`、`package.json`、`test/selection-hook-service.test.js`、`test/shortcut-ui-contract.test.js` 及 selection-hook patch 相关文件的删除与新增），未纳入本次结论。
4. 复核基于 `HEAD = 33365bd` 的源码状态。
