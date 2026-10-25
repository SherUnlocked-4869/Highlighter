# 功能批次 B 交接记录：区域复用与尺寸预设

> 上级方案：[2026-10-25 snow 功能增补开发文档](F:/workspace/Highlighter/docs/plans/2026-10-25-snow-apps-feature-development-plan.md) §5（下称"方案"）。
> 前置记录：[R0 基线](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-r0-baseline.md)。
> 日期：2026-10-25（Asia/Hong_Kong）
> 状态：**代码完成，本地门禁通过**。混合 DPI / 负坐标 / 屏幕拔插的**实机矩阵未验证**（见 §7）。

---

## 1. 最终范围

方案 §5 的 B1–B3 全部落地。坐标决策严格按方案 §5.1：
**预设 = 输出像素宽高**，**上次区域 = 某块屏上的位置与尺寸**，两者分开存、分开解释。

| 方案任务 | 交付 |
|---|---|
| B1 `shared/region-presets.js` + `main/services/region-preferences.js`；设置存取与迁移 | 见 §2.1 |
| B2 capture/record 域调用公共区域解析；补 IPC/preload/allowlist | `main/ipc/region-ipc.js`、`main/ipc/region-ipc-controller.js`、`main/domains/record/index.js`、`preload-capture.js` |
| B3 宽高、比例、复用上次、预设管理入口；保持现有 Esc 语义 | `capture/capture.html`、`capture/capture.js`、`capture/capture.css` |

**明确未做**（方案 §5.1 的排除项）：
- 跨屏统一画布、跨显示器放置预设（v1 单显示器）。
- 完整历史区域浏览（只保留"上一次"）。
- 固定比例联动**文档 crop**（方案明确「固定比例只联动尺寸，不自动改动文档 crop」）。

---

## 2. 文件与接口变化

### 2.1 新增

| 文件 | 行数 | 职责 |
|---|---:|---|
| `shared/region-presets.js` | 584 | UMD 纯领域层：`LIMITS`、`DEFAULT_REGION_PREFERENCES`、`normalizeRegionPreferences`、`validateLastRegion`、`assertRegionPreferencesPatch`、`displayPixelBounds`、`rectDisplayPxToDip`、`rectDipToDisplayPx`、`resolvePresetRect`、`resolveLastRegion`、`createLastRegionFromSelection` |
| `main/services/region-preferences.js` | 328 | 存取（`screenshot.regionPreferences`）、id 分配、`read`/`savePreset`/`deletePreset`/`resolveInput`/`recordLastRegion`/`recordFromDisplaySelection`/`reset` |
| `main/ipc/region-ipc.js` | 22 | 4 个 invoke 通道注册 |
| `main/ipc/region-ipc-controller.js` | 232 | 屏幕描述符、DIP 投影、入参拒绝（`describeDisplay`/`createDisplayProvider`/`createRegionController`） |
| `test/region-presets.test.js` | 955 | 60 例 |
| `test/settings-region-preferences.test.js` | 500 | 23 例 |

### 2.2 修改

| 文件 | 改动 |
|---|---|
| `main/services/settings-defaults.js` | `screenshot.regionPreferences`（+23） |
| `main/services/settings-validation.js` | ①模板叶为 `null`/`undefined` 视为"接受任意值"（放在 `typeof` 比较**之前**）；②新增可选第三参 `{ domainValidators }`，注册路径**独占子树**（+52/−9） |
| `main/services/settings-service.js` | 写入路径注册 `screenshot.regionPreferences` 的领域校验（+17） |
| `main/services/settings-normalize.js` | 读取路径归一化，诊断进注入的 log，不抛（+27） |
| `main/domains/record/index.js` | `recordFromDisplaySelection` 记录录屏最近区域；注入解析器 |
| `capture/capture.js` / `.html` / `.css` | 尺寸输入、应用尺寸、复用上次、预设保存/删除/选择、状态提示（+~330） |
| `main/services/ipc-security.js` | 4 个 `region:*` 通道加到 `capture` surface |
| `preload-capture.js` | `regionGetPreferences` / `regionResolve` / `regionSavePreset` / `regionDeletePreset` |
| `shared/locales/capture.js` | 21 个 `capture.region.*` key × 3 语 |

### 2.3 契约（实现即契约）

```ts
// settings.screenshot.regionPreferences
type RegionPreferences = {
  schemaVersion: 1,
  lastByMode: { capture: LastRegion | null, record: LastRegion | null },
  presets: Array<{ id: string, name: string, widthPx: number, heightPx: number }>
}
type LastRegion = {
  displayKey: string,                                   // 匹配线索，不假定跨重启稳定
  displayBoundsDip: { x, y, width, height },            // 可为负（主屏左侧的副屏）
  displayPixelSize: { width, height },
  rectDisplayPx: { x, y, width, height },               // 屏幕绝对物理像素
  capturedScaleFactor: number                           // 0.5–8
}
```

**通道**（全部 `capture` 角色）：
`region:get-preferences`、`region:resolve`、`region:save-preset`、`region:delete-preset`。

**刻意不提供**：任何"提交一个桌面矩形并记住它"的通道。最近区域写入是主进程域内动作
（方案 §5.2「不暴露任意写入通道」），因此渲染层无法教功能一个伪造的几何。

**`region:resolve` 返回** `{ ok, mode, displayKey, rect, pixelSize?, adjusted[] }`，
`rect` 是 **DIP** 整数（渲染层就是 CSS px），`adjusted[].code ∈ clamped-to-screen |
rect-outside-display | display-changed`。

### 2.4 固定比例（方案 §5.1 末条）

比例锁只联动宽高：编辑任一边时用 `syncRatioPartner()` 推导另一边，应用时由
`applyTypedRegionSize()` 用 `parseRatio()` 再算一次，保证落地的宽高严格符合所选比例。
提供「自由 / 16:9 / 16:10 / 4:3 / 1:1 / 9:16」。

两条硬约束（方案原文）：
- **不自动改动文档 crop** —— 比例只作用于本次截图的选区；
- **尺寸锁保留拖拽锚点** —— 应用尺寸时固定左上角（`anchorX/anchorY`），不把选区挪到中心。

比例组用**按钮**而不是原生下拉：`capture.html` 刻意不含原生 option 元素，
`test/capture-annotation-width.test.js` 用 `assert.doesNotMatch(html, /<option/)` 钉死了这条
（宽度工具条当初正因原生控件被压扁才改成三按钮）。

---

## 3. 兼容与迁移

- **新增设置块，不改任何既有键**。旧 store 缺 `regionPreferences` / 缺 `lastByMode` /
  缺 `presets` 都是合法的：读取一律先归一化（这正是方案 §5.2 指出的模板校验缺口）。
- 归一化**丢弃非法项并记录诊断**，绝不抛错 —— 手改过的 store 不会让应用起不来。
- 写入是严格的：`assertRegionPreferencesPatch` 拒绝非法输入，**不做静默改写**
  （方案 §5.2「新 IPC 输入错误应明确拒绝，不能悄悄改成别的尺寸」）。
- 预设 id 由主进程 `crypto.randomUUID()` 生成并持久化，**跨重启稳定**；更新复用原 id。
- 无磁盘布局变化、无数据目录迁移需求。

### 3.1 坐标陷阱（实现时真的踩到过）

`main/domains/{capture,record}/index.js` 里的 `selectionBounds` 是 **Electron DIP** 窗口坐标，
**不是**显示像素。`createLastRegionFromSelection` 默认 `space:'displayPx'`。
若按默认调用，200% 屏上记住的区域会是正确值的两倍大 —— 正是方案 §5.3 的混合 DPI 验收场景。

**收敛方式**：转换不在各调用点重复，而是集中在
`region-preferences.recordFromDisplaySelection()` 内部固定 `space:'dip'`。
域只需要传 `selectionBounds`，无法忘记这一步。`shared/region-presets.js` 里有用例钉住这个区别。

---

## 4. 测试命令与结果（全部实际执行）

```bash
node --test test/region-presets.test.js \
             test/settings-region-preferences.test.js \
             test/settings-validation.test.js \
             test/settings-normalize.test.js \
             test/capture-geometry.test.js
→ 115/115 pass

node --test test/feature-ab-integration.test.js   → 12/12（B 的 display/region controller 部分）

env -u ELECTRON_RUN_AS_NODE ... npm test
→ tests 1601 / pass 1600 / fail 1（唯一失败是 AGENTS 记录的 clipboard lease flake，
  单独重跑 2 次均 4/4 通过；见 A 交接 §4）

npm run check
→ check:js 421 files OK；check:architecture main.js 1316 ≤ 1330；check:i18n TOTAL 585（基线未变）
```

### 本轮修掉的真实缺陷

1. **`Number('1920')` 静默接受字符串尺寸**：来自 IPC 或手改 store 的 `"1920"` 会被当成
   1920。违反方案 §5.2。现在读取丢弃、写入拒绝，两边都有用例。
2. **`reset()` 绕过严格校验**：重置路径没走 `checkPatch`。已收紧为同一道门。
3. **`assertValue` 对 `null` 模板叶误判**：`typeof null === 'object'` 会让合法的
   `lastByMode.capture: null` 被当对象递归。规则已前移到 `typeof` 比较之前。
4. **`resolvePresetRect` 曾自带一份轴换算**：与 `resolveLastRegion` 各算一次，
   X/Y 混合 DPI 时可能不一致。已收敛到唯一除法点 `displayScale` +
   `rectDisplayPxToDip`/`rectDipToDisplayPx` 一对函数。
5. **i18n 门禁回归**：`region-preferences.js` 首版有 40 行中文注释，把 `check-i18n` 从
   585 推到 627（超 `--max 606`）。已全部改为英文，长注释留在不被扫描的
   `shared/region-presets.js`。

---

## 5. 验收场景对照（方案 §5.3）

| 场景 | 证据 | 状态 |
|---|---|---|
| 负坐标（副屏在主屏左侧） | `region-presets.test.js`：负 `rectDisplayPx.x` / 负 `displayBoundsDip.x` 用例 | ✅ 纯函数 |
| 非整数 / 超大 / 非法尺寸 | 归一化丢弃 + 写入拒绝，逐项用例 | ✅ |
| 重复 ID / 非法配置 | 重复 id 丢弃并诊断；超 20 项逐条诊断 | ✅ |
| 100% / 150% / 200% DPI | 每轴换算往返用例（含 1.5 / 2.0） | ✅ 纯函数 |
| 主副屏左右布局与负坐标 | `displayPixelBounds` 负原点用例 | ✅ 纯函数 |
| 屏幕旋转 / 混合 DPI | 每轴独立缩放用例 | ✅ 纯函数 |
| 显示器拔出 / 重排 | `resolveLastRegion` → `ok:false` + `display-changed`；部分越界 → 裁剪 + `rect-outside-display` | ✅ 纯函数 |
| 输入框焦点时快捷键不抢输入 | `capture.js` 的 keydown 已有 `INPUT/TEXTAREA/SELECT` 提前返回；尺寸输入框不吞全局键 | ✅ |
| 录制期间无法切换区域 | 录制开始后截图窗口关闭，区域面板随之销毁 | ✅ 结构上 |
| 历史关闭也能复用 | B 不依赖历史服务 | ✅ |

---

## 6. 性能样本

**未采集**。新增开销：设置读归一化（常数级、诊断去重）、一次 IPC 往返、无定时器、
无磁盘资产。方案 §3.3 的护栏（20 项 / 40 字符 / 80 MP）由 `LIMITS` 集中并有用例锁定。
真实混合 DPI 下的采样按方案 §10.2 应补测；**不得**写成已测。

---

## 7. 已知限制 / 未验证项（不得当作已验证）

| 项 | 状态 |
|---|---|
| 混合 DPI 真机矩阵（100/150/200%） | **未验证**。纯函数层有用例，真实窗口未测 |
| 负坐标副屏上的真实 `setBounds` 行为 | **未验证**。需要真机副屏 |
| 屏幕拔插 / 重排在运行中的表现 | **未验证**。纯函数有 `display-changed` 分支 |
| "复用上次区域"在真实窗口里的落点 | **未验证**。坐标链有断言，未见真机 |
| 拖拽锚点保留的观感 | **需真机**。逻辑是"保持左上角"，视觉未验收 |
| 固定比例联动 | **已实现**（见 §2.4） |
| 预设管理入口的位置/观感 | **需真机**；插在工具栏上方的浮层里 |
| `test:coverage:loaded` 中 B 的纯函数 | `shared/*` 不在 `--include` 桶内（与既有 `capture-document.js` 同待遇） |

---

## 8. 下一步

1. 补「固定比例」联动（方案 §5.1「固定比例只联动尺寸，不自动改动文档 crop」）。
2. 真机跑 §7 的混合 DPI / 负坐标 / 拔插矩阵，把结果写回本文件。
3. 方案 §2 R0.3 的磁盘布局迁移与孤儿清理仍未做；C/D 落新资产前必须先补。
