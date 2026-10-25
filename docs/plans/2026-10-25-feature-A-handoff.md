# 功能批次 A 交接记录：保存结果快捷操作与表格直接打开

> 上级方案：[2026-10-25 snow 功能增补开发文档](F:/workspace/Highlighter/docs/plans/2026-10-25-snow-apps-feature-development-plan.md) §4（下称"方案"）。
> 前置记录：[R0 基线](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-r0-baseline.md)。
> 日期：2026-10-25（Asia/Hong_Kong）
> 状态：**代码完成，本地门禁通过**。安装包与实机副屏矩阵**未验证**（见 §7）。

---

## 1. 最终范围

方案 §4 的 A1–A3 全部落地，**没有**超出范围：

| 方案任务 | 交付 |
|---|---|
| A1 结果登记 / 过期 / 归属校验 / 系统动作 | `main/services/export-result-service.js` |
| A2 `export:perform-action` 通道 + preload 接线 + 接入图片/表格/PDF 导出 | `main/ipc/export-ipc.js`、`main/ipc/export-action-controller.js`、`preload-capture.js`、`preload-recognition.js` |
| A3 编辑器/识别结果条、托盘最近导出、表格保存并打开、locale | `capture/export-result-bar.js`、`recognition/recognition.js`/`.html`、`main/services/tray-menu.js`、`shared/locales/*` |

**明确未做**（方案里属于 A 的排除项，不是遗漏）：
- 文件对象剪贴板（方案 §4.1「首版不实现文件对象剪贴板」）。
- 任务中心 / 常驻结果窗口（方案要求复用现有托盘，不新增常驻窗口）。

---

## 2. 文件与接口变化

### 2.1 新增

| 文件 | 行数 | 职责 |
|---|---:|---|
| `main/services/export-result-service.js` | 429 | 产物登记表：`register` / `perform` / `latestFor` / `list` / `revokeOwner` / `dispose`；TTL 15 分钟、上限 50 条、归属校验、动作前重新检查文件与扩展名 |
| `main/ipc/export-ipc.js` | 21 | 只注册 `export:perform-action` |
| `main/ipc/export-action-controller.js` | 118 | 把发送方归因为 `web-contents:<id>` owner；载荷只放行 `resultId` + 三个动作名；窗口销毁时 `revokeOwner` |
| `capture/export-result-bar.js` | 232 | 双窗口共用的结果条：打开 / 地址 / 打开文件夹 / 关闭；错误按 code 映射到 locale key；语言切换后重译 |
| `main/services/feature-services-bootstrap.js` | 58 | A/B 两个服务的构造（main.js 行数上限内） |
| `test/export-result-service.test.js` | 772 | 34 例 |
| `test/feature-ab-integration.test.js` | 500 | 12 例（A 的 controller / bar；B 的 display/region controller） |

### 2.2 修改

| 文件 | 改动 |
|---|---|
| `main/services/ipc-security.js` | `export:perform-action` 加到 `capture` 与 `recognition` 两个 surface（同一策略条目，两个角色） |
| `preload-capture.js` / `preload-recognition.js` | `exportAction(resultId, action)` |
| `main/domains/capture/index.js` | `exportPdf` 与 `save` 的产物经 `registerExportResult()` 包装；未注入服务时返回旧路径形状 |
| `main/domains/recognition/index.js` | `recognitionExportExcel` / `recognitionExportPdf` 同上 |
| `main/services/tray-menu.js` | 新增可选 `recentExport` / `openRecentExport`，有回执时才追加**一条**菜单项 |
| `main.js` | 服务构造、IPC 注册、托盘接线、两个域的服务解析器注入 |
| `capture/capture.js` / `capture.html` / `capture.css` | 结果条挂载与 `showExportResult()` |
| `recognition/recognition.js` / `.html` | 结果条、「保存并打开」按钮、导出后展示回执 |
| `shared/locales/{zh-CN,en-US,zh-TW}.js` | 结果条 10 个 key（**跨窗口表**，两个窗口都加载它） |
| `shared/locales/main.js` | `main.tray.recent-export` × 3 语 |
| `shared/locales/recognition.js` | `recognition.action.save-and-open` × 3 语 |

### 2.3 契约（实现即契约）

```ts
// 主进程 -> 渲染层。**不含 filePath**：结果按 resultId 寻址，路径不跨进程。
type ExportReceipt = { status: 'saved'; resultId: string; fileName: string; kind: 'png'|'pdf'|'xlsx'|'mp4'|'gif' }

// 渲染层 -> 主进程。只接受这两个字段；带路径的载荷会被丢弃。
type ExportAction = { resultId: string; action: 'open'|'copy-path'|'reveal' }

// 返回：{ status:'done' } | { status:'failed', code }
// code ∈ result-expired | file-missing | invalid-owner | open-failed | unknown-action
```

**归属模型**：owner = `web-contents:<webContents.id>`。渲染层无法选择或伪造；窗口销毁时
`revokeOwner` 撤销其全部引用。托盘是主进程内部调用方，只能操作 `latestFor()` 交给它的那一条。

---

## 3. 兼容与迁移

- **无新 schema、无磁盘迁移、无新持久资产**。结果登记表只在内存，进程退出即消失。
- 三个产出处原本返回「路径或 null」。现在：注入服务时返回回执，**未注入时原样返回路径**，
  因此任何只接了一部分的宿主都不会改变旧行为。
- `null`（取消对话框）永不产生回执，因此**取消不会出现结果条**。
- 旧调用方若把返回值当路径用，需要改成读 `receipt.resultId`；本仓库全部调用方已迁移。
- 托盘菜单项是**条件追加**，没有回执时菜单结构与改动前完全一致（`test/i18n-main.test.js` 锁定）。

---

## 4. 测试命令与结果（全部实际执行）

```bash
# 本机，按根 AGENTS 处理四个陷阱
env -u ELECTRON_RUN_AS_NODE \
  TMP="F:/workspace/Highlighter/.tmp-test" \
  TEMP="F:/workspace/Highlighter/.tmp-test" \
  HIGHLIGHTER_E2E_DATA_ROOT_BASE="F:/workspace/Highlighter/.tmp-test" \
  npm test
→ tests 1601 / pass 1600 / fail 1

npm run check
→ check:js          421 files OK
→ check:architecture main.js 1316 ≤ 1330
→ check:i18n        TOTAL 585（= HEAD 基线，未变）

node --test test/export-result-service.test.js          → 34/34
node --test test/feature-ab-integration.test.js         → 12/12
node --test test/i18n-contract.test.js test/capture-i18n.test.js → 22/22
npm run test:coverage:critical                          → 93.46% lines ≥ 90%
npm run test:coverage:loaded                            → 92.03% lines ≥ 85%
```

### 唯一的失败是已知 flake，不是本批次回归

`test/clipboard-coordination.test.js` → "native addon authenticates leases, finishes 100 rounds
and rejects bad credentials"。这是根 AGENTS 记录在案的已知 flake（原生 lease 同步往返在负载下
偶发错过窗口）。按 AGENTS 要求单独重跑**两次**：

```
node --test test/clipboard-coordination.test.js  → run 1: 4/4 pass；run 2: 4/4 pass
```

两次全绿即判定为 flake，**不是**本批次 diff 引入的。未按"放宽断言"的方式掩盖。

### 本轮修掉的真实缺陷（不是测试问题）

1. **`export-result-bar.js` 在浏览器里抛 `module is not defined`**：该文件同时被
   `require()`（测试）和 `<script>` 加载（窗口）。`module.exports` 未加守卫时，渲染层整个脚本
   报错 → `test/capture-brush-render.test.js` 的「页面不得记录错误」断言把它抓住。
   已改为双端分别守卫。
2. **`feature-services-bootstrap.js` 引用路径错误**：`require('./region-ipc-controller')`，
   实际在 `main/ipc/`。真 Electron 启动探针（`test/diagnostics-runtime.test.js`）直接失败
   （`Cannot find module`），单测发现不了。
3. **结果回执泄漏绝对路径**：首版 `toReceipt()` 带 `filePath`，违反方案 §4.2「不接受路径」的
   方向。已收窄为 `{status, resultId, fileName, kind}`，并加断言逐面检查（含 JSON 序列化）。
4. **`revokeOwner` 未清理 requestId 幂等索引**：撤销后同 requestId 重试会命中死 resultId。
   已随撤销一起按 owner 前缀清理，并补两条用例。
5. **i18n 键放在 capture 域表里**：识别窗口不加载该表 → `i18n-contract` 报「窗口解析了
   未加载的键」。结果条是两个窗口共用的组件，其文案已移入**跨窗口表**
   `shared/locales/{zh-CN,en-US,zh-TW}.js`。
6. **托盘条目用 `visible:false`**：部分平台菜单仍占位，且让标签顺序断言失真。改为条件追加。
7. **Feature A/B 的 IPC 注册捕获了 `null` 服务**：`registerXxxIpc` 在 main.js **模块加载时**执行，
   而两个服务在 `initializeStore()`（`startApplication()` 内）才创建。首版把服务实例直接传入
   `registerExportFeatureIpc`，于是注册时永远是 `null` —— 所有动作在运行时都会失败。
   真 Electron 启动探针（`test/diagnostics-runtime.test.js`）抛出
   `Export feature IPC requires the export result service` 把它抓住。
   已改为**传解析器**（`getExportResultService` / `getRegionPreferences`），注册时只捕获闭包，
   调用时才取服务。这正是方案 §3.1 "事件订阅提供取消函数；窗口销毁后停止发送并释放监听" 的
   同类问题：装配顺序不能靠"恰好先初始化"。

---

## 5. 验收场景对照（方案 §4.3）

| 场景 | 自动化证据 | 状态 |
|---|---|---|
| 取消保存 | 回执为 null → 不出现结果条（`export-result-bar` 用例） | ✅ |
| 连续保存不同文件 | 登记表可并存，`latestFor` 取最新；`maxEntries` 淘汰最旧 | ✅ |
| 文件移走 | `perform` 重新检查存在性 → `file-missing` | ✅ |
| 无表格关联应用 | `shell.openPath` 返回非空 → `open-failed`；结果条保留并提示 | ✅ |
| 历史关闭 | 本功能不依赖历史服务 | ✅（未接线） |
| 文档提交成功但导出失败 | 两者分别返回：提交走既有 `capture:commit-document`，导出走回执 | ✅ 结构上分离 |
| 外部文件成功但打开失败 | 同上：`saved` 回执 + `open-failed` 分别报告 | ✅ |
| 跨窗口伪造 resultId | 错误 owner → `invalid-owner` | ✅ |
| 过期 resultId | 惰性过期 → `result-expired` | ✅ |
| 窗口销毁后继续操作 | `revokeOwner` 后引用消失 | ✅ |

---

## 6. 性能样本

本批次**未采集**性能样本。新增开销是常数级的：登记表最多 50 条内存对象、无定时器、
无磁盘写入、无子进程。按方案 §10.2 的口径，这一项应为 A 批次补测；**不得**写成已测。

---

## 7. 已知限制 / 未验证项（不得当作已验证）

| 项 | 状态 |
|---|---|
| 默认应用行为、取消对话框、文件移动、焦点归还 | **需真机**。逻辑层有用例，真实系统对话框与应用关联未测 |
| 实机副屏矩阵 | **未验证**（本批次不含屏幕几何） |
| 安装包（`verify:package`） | **未验证**，需完整 electron-builder 产物与静默安装 |
| `mp4` / `gif` 回执 | 类型已支持，**无生产者**（属 E 批次） |
| 结果条的视觉观感与位置 | **需真机副屏验收**；纯 DOM 有用例，观感无 |
| `test:coverage:loaded` | 见 §4；A 的新服务在 `--include=main/services/**` 桶内，覆盖率由 `test/feature-ab-integration.test.js` 与 `test/export-result-service.test.js` 覆盖 |

---

## 8. 下一步

1. 真机副屏验收本批次的六个验收场景（§5 右侧一列）。
2. E 批次（录屏裁剪）复用本批次的回执能力：`mp4`/`gif` 已有 kind，只需生产者接线。
3. 方案 §2 R0.3 的磁盘布局迁移与孤儿清理仍未做，**C/D 落新资产前必须先补**。
