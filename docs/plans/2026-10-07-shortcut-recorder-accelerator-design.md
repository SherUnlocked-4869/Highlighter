# 设计文档：热键录入的按键规范化与校验（IME「Process」事故）

- 状态：**待确认**（本文只做设计，不含代码改动）
- 关联事故：2026-10-07 排查划词工具栏时发现的独立缺陷
- 相关代码：[config/config.js](../../config/config.js)、[config/config.html](../../config/config.html)、[main/services/shortcut-service.js](../../main/services/shortcut-service.js)、[main/services/settings-validation.js](../../main/services/settings-validation.js)、[main/services/settings-service.js](../../main/services/settings-service.js)、[main.js](../../main.js)

## 0. 需求背景与目标

### 0.1 现象与实测日志

每次启动都出现（字段来自用户机器 `E:\document\highlighter\logs\app.log`）：

```
{"timestamp":"2026-10-07T13:27:50.127Z", ... "message":"Shortcut registration failed: Process Error processing argument at index 0, conversion failure from Process"}
```

对应用户配置（`E:\document\highlighter\config\config.json`）：

```json
"shortcuts": { ..., "chatSelectText": "Process", ... }
```

后果：**功能「对话框填入选中文本」的全局热键永远注册不上**，用户在热键设置页只会看到一个红色「快捷键格式无效」的 chip，且这条错误每次启动都写入日志。

### 0.2 脏值是怎么产生的

`"Process"` 不是用户想设的键名，而是中文输入法组合状态下浏览器给出的 `KeyboardEvent.key` 值。录制器（[config/config.js:305-341](../../config/config.js)）对它没有任何过滤：

```js
const handler = async (keyEvent) => {
  keyEvent.preventDefault(); keyEvent.stopPropagation()
  if (keyEvent.key === 'Escape') { …恢复文案…; cleanup(); return }
  if (['Control','Shift','Alt','Meta'].includes(keyEvent.key)) return   // 只挡了纯修饰键
  …
  let key = keyEvent.key.length === 1 ? keyEvent.key.toUpperCase() : keyEvent.key
  if (key === ' ') key = 'Space'
  parts.push(key)
  const accelerator = parts.join('+')      // → "Process"
  …
  await updateSettings({ shortcuts }, '') // ← 未校验即持久化
  …
}
```

要点：**录制结果直接落盘**，没有任何"这个 key 能不能当 accelerator"的判断，也没有把 DOM `key` 名称映射成 Electron accelerator 名称的步骤。

### 0.3 目标

- G1：非法按键不再写入设置（录制端拦截）。
- G2：主进程侧不再接受非法 accelerator（纵深防御，含手改配置文件的情况）。
- G3：存量脏值一次性修复，启动日志不再刷错误。
- G4：合法历史值（`Ctrl+1`、`Alt+F`、`Ctrl+Alt+E` 等）行为与显示保持不变。

### 0.4 非目标（本期明确不做）

- N1：不改热键冲突/被占用（`duplicate` / `unavailable`）的既有判定与展示。
- N2：不改 `explainClipboard`、`screenshot` 等功能的默认热键。
- N3：不做"跨键盘布局录制"（`event.code` 方案）——见 §8 Q4。

## 1. 关键事实（已核实）

### 1.1 注册侧现状

[main/services/shortcut-service.js:68-88](../../main/services/shortcut-service.js)：`globalShortcut.register` 抛异常时被 catch，写入 `{ registered:false, reason:'invalid', message }`，并 `log('Shortcut registration failed:', accelerator, message)`。也就是说：**注册侧已经能识别非法值，但只能事后报告，不能阻止它进入配置。**

`test/shortcut-service.test.js` 已有一条 `reports invalid accelerators without preventing later registrations` 覆盖该分支。

### 1.2 校验侧现状

[main/services/settings-validation.js](../../main/services/settings-validation.js) 只做"模板形状 + 类型 + 长度 + 禁用键"校验（`assertSettingsPatch`），**完全不校验 accelerator 语法**，因此 `updateSettings({shortcuts:{chatSelectText:'Process'}})` 会被正常接受并持久化。

`SettingsService.updateSettings`（[settings-service.js:138-148](../../main/services/settings-service.js)）的第一道门就是 `assertSettingsPatch`，这是最合适的纵深防御插入点（不改变调用方）。

### 1.3 展示侧现状

`shortcutPresentation`（[config/config.js:142-172](../../config/config.js)）：`reason === 'invalid'` → 文案「快捷键格式无效」+ `.set.unavailable` 红色 chip；`updateSettings` 后会自动 `refreshShortcutStatuses()`（[config.js:129-136](../../config/config.js)）。所以**UI 能显示问题，但显示的是"已经写坏的配置"**，用户仍需自己猜怎么修。

### 1.4 加载/迁移侧现状

`SettingsService` 构造时会跑注入的 `migrateSettings`（[settings-service.js:47-55](../../main/services/settings-service.js)），实参在 [main.js:136](../../main.js)；另有 `normalizeSettings`（[main.js:262-274](../../main.js)）做逐项规范化。已有先例 [main/services/appearance-migration.js](../../main/services/appearance-migration.js)：**纯函数 + `{settings, changed}` 返回值 + 独立单测**，本设计照此实现。

### 1.5 共享模块先例

渲染进程与主进程共用的纯模块已有成熟模式（UMD，挂 `window` 或 `module.exports`）：

- [toolbar/toolbar-action-meta.js](../../toolbar/toolbar-action-meta.js)（`config.html:50` 以 `<script>` 引入，主进程 `toolbar-utils.js:7` 以 `require` 引入）；
- [shared/coding-plan-presets.js](../../shared/coding-plan-presets.js)（`config.html:51`）。

本设计的按键映射/校验模块放在 `shared/`，双端复用，避免"UI 一套规则、主进程另一套规则"的漂移。

## 2. 详细需求点

| 编号 | 需求 | 验收 |
|---|---|---|
| D1 | 录制时忽略 IME/无关键（`Process`、`Unidentified`、`Dead`、`Compose`、`AltGraph`）与 `event.isComposing === true` 的按键：**保持"请按组合键…"状态继续等待**，不写入、不退出录入 | 单测（纯函数）+ 真机手测（中文输入法开启录制） |
| D2 | 纯修饰键（Control/Shift/Alt/Meta 及其左右变体）继续跳过，不产生 accelerator | 单测 |
| D3 | DOM key 名称 → Electron accelerator 名称做映射（`ArrowUp→Up`、`' '→Space`、`Escape→Esc`、`CapsLock→Capslock`、媒体键等），单字符统一大写 | 表驱动单测 |
| D4 | 规范化：修饰键顺序固定 `Ctrl+Alt+Shift+Super`、去重、大小写规范化、幂等（二次规范化不变） | 单测 |
| D5 | 语法校验：非空值必须是"至少一个键 + 合法修饰键"的合法 accelerator；不合法时**录制端拒收并 toast 中文原因，保留原值**，不写设置 | 单测 + 契约测试 |
| D6 | 主进程纵深防御：`updateSettings({shortcuts})` 中非空的非法值直接抛错（中文文案），不落盘 | `test/settings-validation.test.js` 追加 |
| D7 | 存量修复：启动迁移把非法值清空（写回一次、记日志），热键页显示"未设置" | 迁移单测（含 `"Process"` → 清空） |
| D8 | 注册前预校验：`ShortcutService.registerAll` 用同一模块判定 `invalid`，不再依赖 Electron 抛异常（catch 保留为兜底） | `test/shortcut-service.test.js` 追加 |
| D9 | 合法历史值不受影响；规范化若改变了存量值（如 `ctrl+enter` → `Ctrl+Enter`）走迁移写回并记日志 | 迁移单测 |

## 3. 技术设计

### 3.1 新增 `shared/shortcut-keys.js`（UMD 纯函数模块）

```
MODIFIER_KEYS           Control/Shift/Alt/Meta + 左右变体 + OS/AltGraph/Compose
IGNORED_KEYS            Process/Unidentified/Dead/Compose/Convert/NonConvert/…
MODIFIER_ALIASES        ctrl|control→Ctrl, cmd|command|meta|super→Super, option|alt→Alt, shift→Shift
KEY_ALIASES             DOM key → accelerator key（含大小写归一）
KEY_WHITELIST           允许作为主键的名称集合（F1–F24、媒体键、导航键、空格、单字符/标点、num* 等）

isIgnoredRecordingKey(eventLike)   // D1：key 在 IGNORED_KEYS 或 isComposing
isModifierOnlyKey(key)             // D2
domKeyToAcceleratorKey(key, { code, location })  // D3（含数字小键盘）
normalizeAccelerator(raw)          // D4：返回规范化字符串（不合法时原样返回或抛由调用方决定）
parseAccelerator(raw)              // { modifiers:[], key:'' , ok:boolean }
isValidAccelerator(raw)            // D5/D6/D8 共用的判定
describeShortcutRejection(raw)     // 中文拒绝原因，供 toast/日志
```

关键取舍：

- **主键名称表以 Electron accelerator 文档为准**（`Up/Down/Left/Right`、`Return/Enter/Escape/Esc`、`Space`、`Tab`、`Backspace`、`Delete`、`Insert`、`Home/End/PageUp/PageDown`、`F1–F24`、`VolumeUp/VolumeDown/VolumeMute`、`MediaNextTrack/MediaPreviousTrack/MediaStop/MediaPlayPause`、`PrintScreen`、`num0–num9/numdec/numadd/numsub/nummult/numdiv`）。
- 单字符（字母/数字/标点）保留原样并大写；`+` 这一类的歧义见 §8 Q3。
- 规范化的目标是"给 Electron 的字符串"，不是"给用户看的字符串"；展示沿用用户录入结果（本来就是规范化后的值）。

### 3.2 录制端改造（`config/config.js` `bindShortcutRecorders`）

```
1) 头部优先判断（顺序很重要）：
   if (keyEvent.isComposing || isIgnoredRecordingKey(keyEvent)) return   // 保持录入态，不写不退出
   if (keyEvent.key === 'Escape') { 还原按钮文案; cleanup(); return }
   if (isModifierOnlyKey(keyEvent.key)) return
2) 用 domKeyToAcceleratorKey + 修饰键状态拼出 accelerator → normalizeAccelerator
3) if (!isValidAccelerator(accelerator)) {
     toast(describeShortcutRejection(accelerator)); 还原按钮文案; cleanup(); return
   }
4) try { await updateSettings({ shortcuts }, '') } catch (error) { toast(errorMessage(error)); 还原; cleanup(); return }
5) 成功路径维持现状：renderRoute() + toast(presentation.message || '快捷键已更新')
```

同时补一条 UI 文案：录入提示改为「点击右侧按键框后录入组合键；无效按键（如输入法组合键）会被忽略」——只在 i18n 文案处改一行，不新增交互。

### 3.3 主进程纵深防御（`settings-validation.js`）

在 `assertValue` 的字符串分支之前加一条**路径感知**规则：

```js
if (path.startsWith('shortcuts.') && typeof value === 'string' && value.trim() && !isValidAccelerator(value)) {
  throw new Error(`快捷键格式无效：${value}`)
}
```

这样：手改 `config.json` 后经 `updateSettings` 写入会被拒绝；`resetSettings` 走默认值不受影响；IPC 错误信息会经 `errorMessage()` 原样显示在设置页 toast（[config.js:85-87](../../config/config.js)）。

### 3.4 存量修复（新增 `main/services/shortcut-migration.js`）

与 `appearance-migration.js` 同构：

```js
function migrateShortcutSettings(settings) {
  const shortcuts = settings?.shortcuts
  if (!shortcuts || typeof shortcuts !== 'object') return { settings, changed: false }
  const next = { ...shortcuts }
  let changed = false
  for (const [name, value] of Object.entries(shortcuts)) {
    const raw = String(value || '').trim()
    if (!raw) { if (value !== '') { next[name] = ''; changed = true } continue }
    if (!isValidAccelerator(raw)) { next[name] = ''; changed = true; continue }   // 记录被清理的键名，由调用方 log
    const normalized = normalizeAccelerator(raw)
    if (normalized !== value) { next[name] = normalized; changed = true }
  }
  return changed ? { settings: { ...settings, shortcuts: next }, changed: true, cleared: [...], normalized: [...] } : { settings, changed: false }
}
```

接线：`main.js:136` 的 `migrateSettings` 里与 appearance 迁移串联（先 appearance 再 shortcut，任一 changed 即整体 `changed: true`），并在迁移后 `log('Shortcut settings repaired:', { cleared, normalized })`。用户机器上的 `chatSelectText: "Process"` 会在首次启动时被清空，之后不再有启动错误。

### 3.5 注册侧预校验（`shortcut-service.js`）

`registerAll` 循环内，在 duplicate 判定之后、`globalShortcut.register` 之前插入：

```js
if (!isValidAccelerator(accelerator)) {
  statuses[name] = { accelerator, registered: false, reason: 'invalid' }
  this.log('Shortcut invalid:', accelerator)
  continue
}
```

原有 `catch` 保留（覆盖"语法合法但 Electron 仍抛异常"的情形），状态语义与 UI 展示完全不变。

### 3.6 文件改动清单（预估）

| 文件 | 改动 |
|---|---|
| `shared/shortcut-keys.js` | **新增**（UMD 纯函数模块） |
| `config/config.html` | 在 `config.js` 之前加 `<script src="../shared/shortcut-keys.js">` |
| `config/config.js` | `bindShortcutRecorders` 按 §3.2 改造；提示文案一行 |
| `main/services/settings-validation.js` | 追加 `shortcuts.*` 语法校验（require 共享模块） |
| `main/services/shortcut-migration.js` | **新增**（清空非法值 + 规范化存量值） |
| `main.js` | `migrateSettings` 串联 shortcut 迁移 + 修复日志 |
| `main/services/shortcut-service.js` | 注册前预校验（D8） |
| 测试 | `test/shortcut-keys.test.js`（新）、`test/shortcut-migration.test.js`（新）、`test/settings-validation.test.js`（追加）、`test/shortcut-service.test.js`（追加）、`test/shortcut-ui-contract.test.js`（追加契约：HTML 引入顺序、录制端使用忽略列表） |

## 4. 测试计划

### 4.1 纯函数单测（新 `test/shortcut-keys.test.js`，表驱动）

- IME/无关键：`Process`、`Unidentified`、`Dead`、`Compose`、`isComposing:true` → `isIgnoredRecordingKey === true`；
- 修饰键：`Control/Shift/Alt/Meta/AltGraph/OS` → `isModifierOnlyKey === true`；
- 映射：`ArrowUp→Up`、`ArrowLeft→Left`、`' '→Space`、`Escape→Esc`、`CapsLock→Capslock`、`AudioVolumeUp→VolumeUp`、numpad（`code:'Numpad1'`）→ `num1`；
- 规范化幂等：`'ctrl + alt+E'` → `'Ctrl+Alt+E'` → 再规范化不变；
- 合法性：`'Ctrl+1'`/`'Alt+F'`/`'F1'`/`'Super+Space'` 通过；`'Process'`/`''`/`'Ctrl+'`/`'+'`/`'Foo'` 拒绝；
- 拒绝原因文案非空且为中文。

### 4.2 迁移单测（新 `test/shortcut-migration.test.js`）

- `{chatSelectText:'Process'}` → `''` 且 `changed: true`、`cleared` 含 `chatSelectText`；
- `{screenshot:'ctrl+1'}` → `'Ctrl+1'`（只规范化，不清空）；
- `{localSearch:'Alt+F'}` 保持原值且 `changed: false`（幂等，避免每次启动写盘）；
- 非对象/缺字段输入返回 `changed: false` 且不抛。

### 4.3 主进程校验（追加 `test/settings-validation.test.js`）

- `updateSettings({shortcuts:{x:'Process'}})` 抛「快捷键格式无效」；
- `{shortcuts:{x:''}}` 通过（清空是合法操作）；
- 其它字段不受影响。

### 4.4 注册侧（追加 `test/shortcut-service.test.js`）

- 注入一个"语法合法"但 register 返回 false / 抛异常的假 `globalShortcut` → 仍按原语义报 `unavailable` / `invalid`；
- `'Process'` → `invalid`，且**不调用** `globalShortcut.register`。

### 4.5 契约测试（追加 `test/shortcut-ui-contract.test.js`）

- `config.html` 在 `config.js` 之前引入 `shared/shortcut-keys.js`；
- `config.js` 录制处理里出现 `isComposing` 与共享模块调用（防回退成"直接拼 key"）；
- `main.js` 的 `migrateSettings` 串联了 shortcut 迁移。

### 4.6 真机手测（必须做）

1. 中文输入法开启状态录制 `Ctrl+Alt+K`：第一次按键应表现为 IME 组合态（`Process`）→ 界面保持"请按组合键…"，不写值；继续按组合键应能正常录入；
2. 单键 `A`、`Ctrl+Shift+1`、`F1`、数字小键盘键各录一次，确认注册状态与展示；
3. 用旧配置（含 `"Process"`）启动一次安装包：确认启动日志不再出现 `Shortcut registration failed`，热键页该行显示"未设置"。

## 5. 兼容性与回滚

- **兼容**：合法历史值经 `normalizeAccelerator` 后若与本值一致则不写盘（幂等），不会造成"每次启动都改配置"；
- **回滚**：改动集中在 1 个新共享模块 + 1 个新迁移模块 + 4 处小改，可整体 revert；迁移只做"清空非法值/规范化大小写"，不做破坏性删除；
- **风险点**：名称表与 Electron 实际接受范围存在差异（如 `Super`、`PrintScreen`、`num*`），需要用真机手测（§4.6）兜住，必要时以"注册结果"为准动态修正名称表。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 白名单过严，把原本可用的组合判为非法 | 用户热键被清空（迁移）或录不进去 | 白名单按 Electron 文档全量覆盖；迁移只清"明确非法"（如 `Process`）；单键/标点等边界见 Q1/Q3 |
| 白名单过松，脏值仍能落盘 | 事故复现 | 注册侧预校验 + 主进程校验双保险 |
| 规范化改变展示文本（如 `ctrl+1`→`Ctrl+1`） | 用户困惑 | 视为修复，迁移日志记录 |
| 迁移误伤（对象形状异常） | 配置损坏 | 纯函数 + 形状校验 + 单测；缺字段直接 `changed:false` |

## 7. 分期与验收标准

| 阶段 | 内容 | 出口 |
|---|---|---|
| M1 | 共享模块 + 单测（`shortcut-keys`） | 纯函数用例全绿 |
| M2 | 录制端与主进程校验（D1~D6、D8）+ 契约测试 | `npm test` 全绿；真机 §4.6 第 1、2 条通过 |
| M3 | 存量迁移（D7/D9）+ 安装包内启动验证 | 启动日志无 `Shortcut registration failed`；旧配置被修复一次且不再重复写盘 |

验收：`npm test`、`npm run check` 全绿；真机手测三条通过；用户机器上 `chatSelectText` 由 `"Process"` 变为空。

## 8. 待确认清单

- **Q1**：是否禁止"没有任何修饰键的可打印单字符"热键（如单独的 `A`）？当前实现允许，风险是全局吞键。倾向：禁止，仅放行 `F1–F24`、媒体键、`PrintScreen` 等。
- **Q2**：存量非法值是**清空**还是**保留原值仅提示**？倾向：清空（否则启动错误会一直刷），并记日志。
- **Q3**：`Ctrl+Shift+1` 这类按键在不同布局下 DOM `key` 可能是 `'!'`。方案 A：按 `key` 记录（用户所见即所得，`'!'` 直接作为主键）；方案 B：按 `code` 记录并对 Shift 做反推。需你在真机上试一次再定（倾向 A + 白名单放行常见标点）。
- **Q4**：是否需要跨布局一致性（`event.code` 方案）？涉及已有热键语义变化，默认不做。
- **Q5**：名称表是否要覆盖 `MediaPlayPause` / `num*` 这类低频键，还是先按需最小集上线？

## 9. 实施结果与偏差（2026-10-07，分支 `feat/toolbar-lifecycle-and-hotkey-keys`）

### 9.1 已落地

- **新增 `shared/shortcut-keys.js`**（UMD，渲染进程与主进程复用）：IME/无关键忽略（`Process`/`Unidentified`/`Dead`/`Compose`/`Convert`/`NonConvert`/`KanaMode`/`KanjiMode`，含 `isComposing` 与 `keyCode === 229`）、修饰键识别、DOM key → accelerator 映射（方向键/空格/Escape/锁定键/媒体键/数字小键盘）、规范化（`Ctrl+Alt+Shift+Super` 顺序、幂等）、语法白名单、录制策略、中文拒绝原因。
- **录制端**（`config/config.js` `bindShortcutRecorders`）：忽略键保持录入态；无效 → toast + 保留原值；`updateSettings` 包 try/catch（主进程拒绝时提示而不是 unhandled rejection）；热键页说明文案更新。
- **主进程纵深防御**：`settings-validation.js` 对 `shortcuts.*` 做语法校验（空值仍合法）；`shortcut-service.js` 在 `registerAll` 注册前预校验，不再依赖 Electron 抛异常（catch 保留为兜底）。
- **存量修复**：新增 `main/services/shortcut-migration.js`（与 `appearance-migration.js` 同构），挂到 `main.js` 的 `migrateSettings`，与 appearance 迁移串联。

### 9.2 与设计稿的偏差（2 处）

1. **"禁止裸单键"落在录制策略而非语法校验**：设计 §8 Q1 倾向禁止裸可打印单键。实现拆成两层——`isValidAccelerator`（语法：主进程校验/迁移/注册共用）与 `isRecordableShortcut`（录制策略：无修饰键的可打印单键拒绝，`F1–F24`/媒体键/`PrintScreen` 放行）。这样既阻止新录入裸单键，又**不会把已有的裸单键配置判为非法并清空**，避免对存量用户造成破坏性变更。
2. **迁移日志由模块内部发出**（注入 `log`），而不是 main.js 迁移后另行 log：保持 main.js 接线只有一行。

### 9.3 门禁与真机

- `npm test`：**653/653 通过**；`npm run check` 通过。
- 真机（开发版，用户真实配置里 `chatSelectText: "Process"`）：启动日志出现
  `Shortcut settings repaired: {"cleared":["chatSelectText"],"normalized":[]}`；
  配置文件变为 `""`，其余 `Ctrl+1` / `Alt+F` / `Ctrl+Alt+E` 原样保留；该会话**不再出现** `Shortcut registration failed`（上一次出现在修复前的 13:27:50Z）。
- 未覆盖：中文输入法开启状态下的人工录入（需人工按键）；单测已覆盖忽略与规范化分支。

### 9.4 实施中暴露并修复的既有缺陷

见配套设计文档 [2026-10-07-selection-toolbar-window-lifecycle-design.md](2026-10-07-selection-toolbar-window-lifecycle-design.md) 的 §9.4：迁移在 `SettingsService` 构造期写日志会命中 `createAppLogger.isEnabled → getSettings()` → `settingsService` 尚未赋值 → 启动失败。本次改 `isEnabled` 直接读 store 后修复，并由真机启动验证。

### 9.5 对 §8 待确认清单的落地选择

- **Q1**：采用"录制期禁止 + 语法放行"的拆分（见 9.2），既有裸单键配置不被清空。
- **Q2**：存量非法值**清空**并记日志（已真机验证）。
- **Q3**：按 `key` 记录（用户所见即所得），标点进白名单；未做 `code` 反推。
- **Q4**：不做跨布局一致性（`event.code`）方案。
- **Q5**：名称表一次到位覆盖媒体键与 `num*`，避免后续再改语法层。
