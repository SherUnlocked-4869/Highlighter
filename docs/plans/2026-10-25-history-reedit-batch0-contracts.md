# 批次 0 契约冻结：历史「继续编辑」改造

> 上级方案：`docs/plans/2026-10-25-history-reedit-redesign.md`（下称"方案"）。
> 本文是方案 §9.1 的 **B0 交付物**，把 §6.2.1 / §6.5.1–6.5.3 / §6.5.4 / §6.5.6 里
> 分散的约束收成**唯一一套**可实现的接口含义。
>
> 状态：**契约已冻结，批次 1 据此实现**。批次 0 不独立发布。
> 生效载体：`shared/capture-document.js`（坐标/schema/校验/指纹，已实现并有 15 条用例）、
> 本文（身份/提交/动作路由/关闭协商/生命周期）。
>
> 凡本文与方案冲突，**以本文为准**并回头修方案；凡本文未覆盖，以方案为准。

---

## 0. 一句话

一条历史记录 = 一个**文档**（稳定 `documentId`）+ 若干**不可变版本**（`revisionId`）。
编辑器打开的是"文档当前版本"，保存默认=**追加新版本并移动 head**，不是新建记录。
导出给外部的永远是"某个已提交版本的**结果图**"，底图只供重建编辑。

---

## 1. 身份模型（§6.5.1 落地）

| 字段 | 生产者 | 含义与不变量 |
|---|---|---|
| `documentId` | 主进程（首次建档时 `createId()`） | 列表卡片、选择、删除、分页游标的身份。**稳定，永不复用**。兼容期 `item.id === item.documentId`。 |
| `revisionId` | 主进程（每次成功提交生成） | 不可变版本身份。内容有变化才产生新值；`unchanged` 不产生。 |
| `parentRevisionId` | 主进程 | 同一文档内的直接前驱；首版为 `null`。**不用于推导文档分组**。 |
| `headRevisionId` | 主进程 | 文档当前版本。只在所有文件就绪后随索引事务一起切换。 |
| `version` | 主进程 | 从 1 开始的人读版次（= 该文档已有 revision 数）。列表显示"N 个版本"用它。 |
| `derivedFrom` | 主进程 | 仅"另存为新记录"的首版带 `{documentId, revisionId}`。来源删除不影响副本。 |
| `expectedRevisionId` | 渲染层（会话打开/最近一次成功提交时看到的 head） | 主进程在**最终提交前**比较；不一致返回 `conflict`。 |

**硬规则**

1. 渲染层**从不**提交 `documentId`/`revisionId`/路径/资源 id —— 只提交 `sessionId` 与 `expectedRevisionId`；归属由主进程按会话绑定解析。
2. `intent='update'` 只允许改会话绑定的那个文档；`intent='save-copy'` 创建**新文档**（独立首版，`derivedFrom` 记来源）；`intent='create'` 仅用于首次截图建档。
3. 文档被删除后提交返回 `deleted`，**不复活**。
4. `derivedFrom` 不合并卡片、不影响分组、不级联删除。

---

## 2. 文档格式（§6.5.3 落地）

已由 `shared/capture-document.js` 实现，实现即契约：

- `schemaVersion: 1`、`coordinateSpace: 'source-pixel'`。
- 磁盘硬上限 **16 MiB**；`parseDocument()` **先按字节限流再 parse**；`serializeDocument()` / `assertWithinDocumentBudget()` 走同一个守卫，超限抛 `code:'document-too-large'`。
- 顶层字段白名单 `DOCUMENT_FIELDS`：未知字段 → `unknown-field`（**不静默透传**）。
- 标注类型白名单 = 10 个已实现的绘图对象（`rect/ellipse/arrow/line/pen/highlight/blur/text/serial/watermark`）。未知类型 → `unknown-annotation-type`（未来版本写的对象必须显式报损坏，不能被画错）。
- 点数预算：单条 ≤ 10000（与 `capture/annotation-geometry.js` 的 `MAX_PEN_POINTS` 同源）、总量 ≤ 200000、标注数 ≤ 5000。
- `crop` 必须整数像素且完整落在底图内（`fractional-crop` / `crop-out-of-bounds`）。
- 未知 `schemaVersion` → `unsupported-schema`，**不猜字段**；只有登记在 `MIGRATIONS` 表里的迁移才升级。
- `view`（`zoomMultiplier/centerX/centerY`）是会话偏好：不进内容指纹、不产生 revision。

### 2.1 坐标与像素（§6.2.1 落地，摘要）

- 文档单位 = **底图源像素**。`crop`、对象 `x/y/x2/y2/points`、笔宽、字号、圆角、序号半径、马赛克单元全用同一单位。
- 视口：`cssX = offsetX + (sourceX - crop.x) * zoom`（`sourceToViewport`），逆变换 `viewportToSource` 严格互逆。
- 导出：`outX = sourceX - crop.x`（`sourceRectToExport`），**只减一次**，不重采样；导出尺寸 = crop 整数像素。
- `resizeCanvas`/跨屏 DPI/恢复 view 只更新投影，**不得**重置 crop、重写对象坐标或产生撤销步骤。
- 捕获 DPI 存 `captureMetadata.sourceScaleFactor`（缺失旧图默认 1），视口 zoom 不得覆写。

---

## 3. 内容指纹与 dirty（§6.5.3 末条 / §6.5.6）

- `documentFingerprint(doc)` 覆盖 `CONTENT_FIELDS`：`schemaVersion / coordinateSpace / baseImage / crop / annotations / captureAttachments / captureMetadata`。
- **不覆盖**：`documentId`、`revisionId`、`parentRevisionId`、`createdAt`、`source`、`view`、以及标注的 `id`（会话内身份，重开会重编号 → 若计入则每次重开假 dirty）。
- 标注数组**顺序即 z 序**，是内容：换序必须换指纹。
- `isDocumentDirty(doc, cleanFingerprint)`：无基线 → dirty。撤销回基线 → clean；撤销到旧内容 → dirty。**不依赖撤销栈下标**（栈淘汰后下标无意义）。

---

## 4. 提交协议（§6.5.4 落地）

### 4.1 通道与形状

新增 **`capture:commit-document`**（invoke/handle）。渲染层载荷：

```js
{
  sessionId,          // 主进程创建编辑器时下发，绑定发送窗口 + 文档/head + 允许的资源
  requestId,          // 幂等键；与"冻结的 snapshot + resultBuffer"绑定
  intent,             // 'create' | 'update' | 'save-copy'
  expectedRevisionId, // update 必填；create/save-copy 为 null
  snapshot,           // Uint8Array —— shared/captureDocument.serializeDocument() 的 UTF-8 字节
  resultBuffer,       // Buffer/Uint8Array —— PNG，尺寸必须等于 snapshot.crop
  newBaseBuffer,      // 仅 create 的首次建档：确认选区的底图 PNG
  attachmentBuffers   // 可选：{ cursor: Buffer }
}
```

返回值（**至少**区分这四种）：

| `status` | 附带字段 | 语义与客户端动作 |
|---|---|---|
| `committed` | `documentId, revisionId, version, headRevisionId, contentFingerprint, resources{baseAssetId, resultPath?...}` | 先接受主进程分配的资源/版本身份，**再**建立 clean 基线（否则临时 id 变化会造成假 dirty）。 |
| `unchanged` | `documentId, headRevisionId, version, contentFingerprint` | 指纹与当前 head 相同：不增版次、不写文件；客户端同样进入 clean。 |
| `conflict` | `documentId, headRevisionId, version` | 会话 head 已旧。保留现场与 dirty，提供"重载 / 另存"，**禁止无提示覆盖**。 |
| `failed` | `code, retryable` | 保留现场与 dirty，可重试。`code` 至少含 `deleted`、`document-too-large`、`invalid-document`、`io-failed`、`session-expired`、`expired`、`not-writable`、`history-disabled`。 |

补充状态：`deleted`（文档已不可见）、`expired`（requestId 超出生效窗口，**不得**再次执行）、`historyStatus:'disabled'`（历史写入被设置关闭 —— 明确返回，不得显示"已保存"）。

### 4.2 幂等

- `requestId` 与**冻结的 snapshot + resultBuffer** 绑定；超时重试**同一 requestId** 返回同一个提交结果（从持久化回执读），**不新增版本**。
- 改了内容必须换新 `requestId`。
- 回执保留覆盖活跃会话 + 约定重试窗口，有容量/期限上限；淘汰 revision 不能让未确认的 requestId 被当成新的 create。
- 同一 `requestId` 的并发点击只执行一次；保存按钮在请求期间防重复。

### 4.3 发布顺序（§6.5.5 落地）

**索引切换是版本可见性的唯一提交点。** 单文件 rename 不等于保存完成。

1. 收口编辑并**冻结**内容态、编码 `result`；保存期间禁止内容变更。文档校验失败则**不开始写入**。
2. 同一文档的提交/删除/保留裁剪**串行化**（互斥队列）；另存同时固定来源快照。
3. 在受控历史根目录创建**同卷 staging**，写事务 manifest（`requestId`、预期 head、资源列表/大小/哈希）。
4. 写入并关闭新底图/附件（如有）、doc、result、thumb；校验大小/哈希/可解码尺寸。平台能力可用时执行必要 flush —— 但**不把普通 rename 描述成断电持久性保证**。
5. 发布到唯一不可变正式路径；**重新检查** `expectedRevisionId`、文档是否已删除、写权限。冲突则不更新 head、不复活已删文档。
6. 用可恢复的**原子索引替换**一次性发布新 revision + head + 兼容路径 + 幂等记录；索引失败恢复旧索引。旧 head 的文件在此之前**不能删除**。
7. 成功后返回确认并广播 `{documentId, revisionId, changeType}`；通知失败不回滚已提交版本。

启动恢复：索引已引用且文件完整 ⇒ 已提交；未引用的 staging/正式文件在无活跃事务时回收；索引引用不完整 ⇒ 从可用备份恢复上一完整 head，或标记损坏并提示。**绝不以未标注 base 顶替缺失 result。**

---

## 5. 文件布局与资源归属（§6.5.2 落地）

```text
history/documents/<documentId>/
  base/<baseImageId>.png                # 初始确认选区的底图，不覆盖
  assets/<assetId>.png                  # 可选捕获光标等附件
  revisions/<revisionId>.doc.json       # 该版本的可编辑内容
  revisions/<revisionId>.result.png     # 该版本完整合成结果，**必需**
  revisions/<revisionId>.thumb.png      # 从 result 生成，可重建
```

- 路径由主进程从**受控根目录 + 文档/版本/资源 id** 推导；manifest 用相对路径；doc 里只存资源 id。
- `filePath` 是**当前已提交 result 的兼容别名**，永远指向它；`width/height` 是该结果尺寸。
- 缩略图从 **result** 生成，不从 base 生成。
- 另存：首批**物理复制**底图与附件（消除跨文档删除依赖），暂不做跨文档去重。
- 旧命名兼容：`isOwnedHistoryFile` 目前只认旧 PNG 命名，需扩展到新布局；未引用**且确认本应用拥有**的文件才可 GC。

### 5.1 `resolveCommittedResult(documentId, revisionId?)`

所有对外图片消费者**必须**走这一个入口：历史打开、复制、地址、图片导出、PDF 导出、`selectExportItems`。
禁止各处在缺失文件时自行回退到 base。缺失时按 §6.5.7 降级（显式提示），**不显示 base 冒充截图**。

---

## 6. 动作路由表（§6.5.4 落地）

| 用户动作 | 历史/文档行为 | 外部副作用与关闭规则 |
|---|---|---|
| 历史编辑 `Ctrl+S` / 保存 | 提交 `update`，成功后原卡片原地更新 | **无 PNG 目录对话框**；普通保存留在编辑器，"保存并关闭"确认成功后才关 |
| `Ctrl+Shift+S` / 另存为新记录 | 提交 `save-copy`，新文档独立首版 | 不等同于选择外部导出目录；成功后会话切到副本 |
| 新截图保存 | 历史启用时提交 `create`，建立首个可编辑版本 | 保留原有 fast/dialog 外部 PNG 导出意图；分别返回历史提交与外部导出结果，**部分成功不得伪装成全部失败** |
| 复制 / 贴图 | 新图按当前策略 `create` 一次；历史会话有未提交内容则 `update` 一次；无变化不新增 | 与文档共用同一冻结结果；副作用完成且要求的提交成功后关闭。历史失败时保留现场，可重试或明确选择"仅完成复制/贴图并离开" |
| OCR / 翻译 / 表格 / QR / 转文档 | 识别输入走 §6.4 遮罩合成（见 §8），**不能**把遮罩版输入当编辑底图或保存结果 | 识别不自动保存历史会话改动。需要切窗/转贴图时先走 dirty 保护 |
| 导出 PNG / PDF | 只导出当前快照，**不**因导出自动创建另一个文档 | 取消或失败保留窗口与 dirty；明确显示"导出"结果，不把导出成功当文档已保存 |

**收敛要求**：`copy/save/pin/pinReannotate/openRecognition` 现在各自调用 `persistHistory`（`main/domains/capture/index.js:556-643`），必须收敛到上表路由；**不能**在动作末尾再追加 `recordHistory` 形成第二次落盘。保留兼容通道时只转接统一服务，不绕过会话/幂等/原子发布校验。

历史关闭时：新截图的复制/贴图/外部导出仍可完成，返回 `historyStatus:'disabled'`，**不得**显示"已保存历史"；已有历史文档的更新在入口明确提示写入受设置禁用，可继续编辑和仅导出，**不能默默新增记录**。只读/迁移中同样返回明确状态，不能绕过 `assertWritable`。

---

## 7. 会话与关闭协商（§6.5.6 落地）

### 7.1 会话绑定

主进程在创建编辑器时生成 `sessionId`，绑定：发送窗口、编辑来源、文档/head、允许的资源集合。渲染层提交只带 `sessionId`，不带路径。

### 7.2 dirty

- 首次新截图在确认选区并建好内容初态后，**不**因临时截图本身反复提示；用户改标注/裁剪后进入 dirty。
- 历史文档以**最近一次成功提交的内容指纹**作为 clean 基线。
- 视口、选中对象、识别面板状态**不**改变 dirty。

### 7.3 统一退出路径

所有退出都必须进同一个 `requestClose(reason)`：关闭按钮、Esc 最终退出、原生关闭、快捷键创建下一张截图、从另一条历史替换当前编辑器、OCR 自动关闭、识别转贴图。

- `dirty` ⇒ 三选一 `[保存并关闭] [放弃改动] [继续编辑]`；选"继续编辑"时**取消新会话创建**（不能先把旧窗口销毁）。
- `saving` ⇒ 等待可确认结果；失败回到 dirty；`conflict` 提供重载/另存且不能未经同意丢内容。
- clean ⇒ 直接关闭。
- 主进程的 `close` 事件必须执行**同样**的协商（不能只拦渲染器按钮）；`createCaptureWindow` 现在直接 `close()` 旧窗口（`capture/index.js:341`）必须先完成协商。
- 焦点只在用户**完成该编辑会话**后还给发起窗口；程序退出或下一会话接管时不强制抢回。

---

## 8. 识别隐私（E1，P0 独立修复）

所有识别入口（OCR/翻译/表格/QR/转文档）统一使用**专用识别合成函数**：

1. 取**当前 crop** 的底图；
2. 对仍存在的 blur 对象覆盖区域应用**不透明**遮罩（覆盖矩形或整条笔刷实际几何，含半线宽/端帽/边缘保守扩展）；
3. **在任何缩放之前**施加遮罩，再预缩放。

- highlight **不**视为遮密工具；不直接复用原图路径。
- 显示透明度预览（橡皮擦）**不**解除识别保护；只有显式确认删除该 blur 对象才解除。
- 所有识别入口消费同一份快照；缓存键包含遮罩后的输入与选项。
- 测试在模型/侧车调用边界**截获像素**，断言遮罩内没有源文字像素；用已知文本与二维码补充验证 —— **不能**仅断言某次 OCR 恰好没认出来。
- 旧位图里的历史马赛克已不可分离，UI 与验收须区分此边界。

---

## 9. 生命周期（§6.6 落地）

| 场景 | 规则 |
|---|---|
| 删除文档 / 批量删除 / 清空 | 先通过**可恢复索引事务**去掉可见引用，再回收该文档全部 revisions/base/附件/thumb/草稿；失败进可重试 GC 清单并返回真实失败项。**不能从索引消失就宣称磁盘清理完成**。 |
| 删除某一旧版本 | 不删其它版本仍引用的底图/附件；**禁止直接删 head**；显式恢复旧版须生成新 revision；父版本被淘汰时时间线显示截断。 |
| 保留策略 | `screenshot.historyLimit` 继续**按文档数**计数（不因多次编辑挤掉其它截图）；新增 `screenshot.historyRevisionLimit` 初值 **20**，每文档至少保留 head；淘汰最旧**非 head** 版本；不淘汰活跃会话依赖的版本。 |
| 空间统计/缺失检测 | 去重统计所有被引用的 base/doc/result/thumb/附件/草稿与待回收文件，分别报告文档数、版本数、不可编辑/不可导出状态。**不能只统计 `filePath` 和 thumb**。 |
| 孤儿清理 | 从当前索引 + 有效恢复备份 + 事务 + 活跃会话构建引用集合；备份代数与保留期有界；删除事务同步使已删记录的恢复引用失效；同时识别**旧命名与新受控布局**；未引用且确认为本应用拥有的文件才可删。 |
| 数据根目录迁移 | 停止新的历史写入/GC，先处理 dirty 会话；复制并**校验完整资源与索引**，切换成功后才清旧目录；`data-root-migration.js:80-96` 扩展所有兼容路径与新增字段；doc 内资源 id/相对引用**不含旧盘符**；校验须**解析每个保留 revision 的资源可达性**，不能只比文件数。 |
| 外部自定义历史目录 | 根目录迁移不擅自搬走；保留受控解析关系并检查可达性；用户单独变更 `historyDirectory` 时旧记录仍按各自持久路径解析。 |

删除/迁移**不能**与索引切换竞争。编辑期间记录被删或 head 改变时，下次提交必须返回 `deleted`/`conflict`，由用户选择另存，**不静默复活**。

---

## 10. 损坏与降级（§6.5.7 落地）

| 情形 | 行为 |
|---|---|
| doc 缺失/损坏/版本不支持，**result 完整** | 标记"仅位图恢复"并明确提示无法修改旧对象；用户确认后以该 result 作新扁平底图创建**下一 revision**；旧 revision 与资源保留。 |
| **result 缺失**，doc+base 可重建同版内容 | 优先重建。 |
| result 缺失且无法重建 / 校验失败 | 显示**损坏/不可用**。**不显示、不导出 base。** |
| 底图丢失但 result 完整 | 同上"仅位图恢复"。 |

任何恢复都不能静默清空标注、扩张 crop，或把新文档误判成原生旧位图。用显式存储格式标记区分 `legacy-bitmap` / `editable-v1` / `bitmap-only`。

---

## 11. 常量与上限（批次 1 实现时引用本表）

| 名称 | 值 | 出处 |
|---|---|---|
| 文档字节上限 | 16 MiB | `MAX_DOCUMENT_BYTES` |
| 单条标注点数 | 10000 | `MAX_POINTS_PER_ANNOTATION`（= `MAX_PEN_POINTS`） |
| 总点数 | 200000 | `MAX_TOTAL_POINTS` |
| 标注条数 | 5000 | `MAX_ANNOTATIONS` |
| 撤销栈预算 | 20 万点 / 96 MiB / 60 步 | 方案 §6.3 U2（批次 2 实现） |
| 版本保留 | 每文档 20（至少保留 head） | `screenshot.historyRevisionLimit` |
| 图片外层上限 | 边长 65535 / 8000 万像素 | `main.js:1119`、`long-capture/index.js:244`（既有） |
| `main.js` 行数上限 | 1330 | `scripts/check-architecture.js:31` |

---

## 12. 新增 IPC 通道清单（批次 1 必须同步的 5 处）

新增通道**必须同时**改：① 注册（`main/ipc/capture-ipc.js`）、② preload（`preload-capture.js`）、
③ 角色 allowlist（`main/services/ipc-security.js` 的 `capture` surface）、④ 通道契约测试
（`test/ipc-module-contracts.test.js` 的 `assert.deepEqual` 顺序断言）、⑤ 安全探针
（`test/ipc-security.test.js`）。**不能**为了绕开顺序断言而复用不匹配的接口 —— 改断言是允许的，
绕开断言不允许。

| 通道 | 种类 | 用途 |
|---|---|---|
| `capture:commit-document` | handle | 统一提交（§4） |
| `capture:commit-status` | handle | 按 `sessionId + requestId` 查询回执（确认丢失后重试，§4.2） |
| `capture:document` | handle | 编辑器载入时按会话取回文档（或由 `capture:init` 内联下发，见下） |

> 备注：若文档随 `capture:init` 内联下发（体积受 16 MiB 约束、且是可信主进程产出），
> 则 `capture:document` 可不单独开通；本条由批次 1 实现时二选一并同步测试。
> `capture:record-history` 是**未使用通道**（方案 F1）：不启用为第二写入口，批次 1 收敛后
> 只能转接统一服务，或确认无调用方后移除。

---

## 13. 批次 0 出口条件核对

| 方案 §9.1 B0 要求 | 状态 |
|---|---|
| B0.1 固定坐标/schema/身份/文件职责；合法与非法文档夹具、坐标正逆变换示例 | ✅ `shared/capture-document.js` + `test/capture-document.test.js`（15 例，含非法夹具） |
| B0.2 固定动作路由、提交返回状态、幂等/冲突、close 协商 | ✅ 本文 §4/§6/§7 |
| B0.3 明确 owned 资源、版本保留、旧图升级、目录迁移 | ✅ 本文 §5/§9/§10 |
| "接口与数据格式只有一套含义" | ✅ 身份/坐标/指纹/提交各自只有一份定义，且都有实现或本文明文 |
| **不独立发布** | ✅ 本文与模块均无用户可见行为变化 |

**存储能力待验证**（方案 §12 未验证项，批次 1 补）：`electron-store` 的写入原子性与故障恢复能力
需在批次 1 用**故障注入**验证；能力不足则由历史服务增加备份与恢复层。普通 rename **不等于**
多文件事务或断电持久化保证。

---

## 14. 与方案的差异记录

| 项 | 方案原写法 | 本文/实现 | 理由 |
|---|---|---|---|
| 标注类型数 | "11 类标注" | 白名单 10 类（`select` 不是对象） | 与 `capture/capture.html` 的 10 个绘图工具 + 选择工具一致 |
| 指纹算法 | 只要求"包含哪些字段" | FNV-1a 双累加器 → 16 位十六进制 | 两端可算、不依赖 `node:crypto`；仅用于 dirty 判定，不作安全哈希 |
| `view` 默认值 | 未规定 | `{zoomMultiplier:1, centerX:w/2, centerY:h/2}` | 恢复时按当前工作区重新 fit，center 只是源像素提示 |
| crop 的 0 宽高 | 未规定 | 视为"未设置"，回落整图 | 避免把图裁成 1×1 这种不可逆的坏状态 |

---

## 15. 实施记录（批次 0 + 批次 1 已完成，2026-10-25）

### 15.1 新增文件

| 文件 | 行数 | 职责 | 用例 |
|---|---|---|---|
| `shared/capture-document.js` | 797 | **双端共享契约**：源像素坐标、crop 归一化、视口正逆变换、导出变换、schema 校验、字节/点数预算、内容指纹、旧图惰性升级、`annotationsToViewport/FromViewport` | `test/capture-document.test.js`（15） |
| `shared/editor-layout.js` | 234 | **紧凑编辑器几何**：从 pin 抽取的算式 + 六个契约常量（1040/34/30/14/22/1088），`resolveEditorLayout` / `scaleFactorFor`。UMD，不依赖 Electron | `test/editor-layout.test.js`（15，含 pin 改造前算式的 oracle 逐值比对） |
| `main/services/capture-document-service.js` | 1092 | **文档/版本持久化与提交**：per-document 串行锁、会话表、`commit`（create/update/save-copy）、幂等回执、冲突、原子索引发布 + 备份恢复、保留裁剪、`resolveCommittedResult`、`loadDocument`（含降级）、`documentStats`、`deleteDocumentFiles` | `test/capture-document-service.test.js`（25） |

### 15.2 修改的关键文件

| 文件 | 改动 |
|---|---|
| `main.js` | `editItem` 委托 `captureDomain.editHistoryDocument`（真实返回值，不再恒 `true`）；`initializeStore` 里建服务；**1329/1330 行**（架构门禁内） |
| `main/domains/capture/index.js` | 新增 `createDocumentEditorWindow`（复用 `resolveEditorLayout`、`transparent`、crop 尺寸适配、会话绑定）、`editHistoryDocument`、`commitDocument`/`commitStatus`/`loadDocument` 三个 controller；`_captureInit.documentEditor` 下发 |
| `main/domains/pin/index.js` | `startPinReannotation` 改调共享几何，删掉本地算式与常量（**行为逐像素不变**，oracle 测试锁定） |
| `main/ipc/capture-ipc.js` + `main/services/ipc-security.js` | 3 个新通道注册 + `capture` role allowlist（契约要求的 5 处同步：注册/preload/allowlist/契约断言/安全探针） |
| `preload-capture.js` | `commitDocument` / `commitStatus` / `loadDocument` |
| `main/services/history-service.js` | `list()` 增加 `toListItem()` 投影：`documentId` / `revisionId` / `headRevisionId` / `version`（旧条目回退 `documentId=id`、`version=1`） |
| `main/services/settings-defaults.js` | 新增 `screenshot.historyRevisionLimit: 20` |
| `capture/capture.js` | 文档编辑器：载入/恢复（换会话 + 清撤销栈）、视口适配、**背景按 crop 切片绘制**、`refreshDocumentDirty`（指纹驱动）、`commitDocumentEditor`、`handleCommitResponse`（四种状态）、`requestCloseDocumentEditor`（三选一协商）、Ctrl+S / Ctrl+Shift+S |
| `capture/capture.html` / `capture.css` | `#documentInfo` 信息区（26px，与 `DOCUMENT_EDITOR_INFO_HEIGHT` 由测试互锁）、`capture-document.js` script 引入 |
| `capture/capture.js`（undo 钩子） | `snapshotAnnotations` 与 `restoreAnnotations` 两处都重算 dirty（撤销回基线即 clean） |
| `config/routes/history.js` | 拆成 `renderHistory`（完整渲染）+ `refreshHistoryOnChange`/`refreshHistoryList`（原地增量）；按 `documentId` 打补丁、签名不变的元素原样保留；已加载页数/滚动/勾选/缩略图缓存跨刷新存活；编辑失败可见（toast + 防连点）；longCapture 无编辑按钮但给 i18n 说明 |
| `config/config.js` | `onHistoryChanged` → `refreshHistoryOnChange()` |
| `shared/locales/{capture,config}.js` | 新增 13 个 key × 三语（文档编辑器 10 个 + 列表 4 个） |

### 15.3 测试与门禁结果（全部实际执行）

```
npm test        → 1461 tests / 1461 pass / 0 fail
npm run check   → exit 0
                  check:js         405 files OK
                  check:architecture main.js 1329 ≤ 1330
                  check:i18n       TOTAL 585（= HEAD 基线，余量 21）
```

新增/扩展用例合计 **+90**：契约 15、服务 25、几何 15、渲染层契约 15、列表 UI 19、列表服务投影 1。

**真实 Electron 验证**（本机可跑，非纯 Node）：
- `test/diagnostics-runtime.test.js` —— 真拉主进程 + 设置窗口，预览/导出 ZIP。**本轮曾因缺陷挂死在此**，见 §15.4。
- `test/capture-document-editor-runtime.test.js`（**新增**）—— 真 Electron 窗口跑生产 `capture.html` + `preload-capture.js`，以 `documentEditor` 载荷打开：断言信息区可见且高 26px、显示文件名与版次、文档恢复后 overlay 真的画出像素、Ctrl+S 产生**恰好一次** `capture:commit-document`（含 sessionId/intent/expectedRevisionId/快照/结果图，且**无任何路径字段**）、提交成功后 dirty 消失且版次推进、clean 文档关窗不弹协商。
- `test/capture-renderer-runtime.test.js` —— 既有捕获渲染层契约仍绿。

### 15.4 本轮修掉的真实缺陷（非测试问题）

1. **启动阻塞**：`main.js` 引用了 `createCaptureDocumentService`，但服务模块只导出了 `CaptureDocumentService` 类。`initializeStore()` 因此抛 `TypeError`，主进程在 `app.ready` 后**事件循环停摆**（连 `setInterval` 都不再触发），表现为所有 Electron 运行时探针挂满超时而不是报错。已在服务模块补出工厂，并加一条不依赖 Electron 的回归断言。
2. **内容指纹假阳性**：head 文档里的 `baseImage.sha256` 由主进程算，渲染层快照永远不带它，导致同一份内容每次都被判成"有变化"（假 dirty / 每次保存都增版）。改为在写入前统一底图引用再比对。
3. **`save-copy` 底图丢失**：另存时目标文档 id 是新的，若按它查条目则找不到底图。改为从**会话来源文档**取底图并物理复制。
4. **旧图惰性升级无底图**：旧扁平条目没有 `baseImageId`，首次升级必须以原 result PNG 作底图。已补 `readLegacyBase()`。
5. **幂等缺口**：`create`/`save-copy` 在索引提交前还没有条目可挂回执，同 `requestId` 重试会多出版本。补进程内 `sessionId+requestId` 幂等表。
6. **文档模式背景渲染错**：`drawBackground` 原先把**整张底图**塞进只为 **crop** 预留的 `imageBounds`，而标注是按 crop→box 映射的 —— 背景被压扁且与导出结果不一致。改为按 crop 切片绘制。

### 15.5 已知边界与未验证项（**不得当作已验证**）

| 项 | 状态 |
|---|---|
| 窗口"好不好看"：条带是否真的不再压图像、透明留白观感、信息区与工具条叠加后是否拥挤 | **需真机副屏验收**。`resolveEditorLayout` 的数值有测试锁定，视觉无。 |
| 跨 DPI（100/150/200%）与负坐标副屏打开同一文档的漂移 | **需真机**。纯函数层有正逆变换往返断言，真实窗口未测。 |
| 焦点归还：关闭编辑器后 config 窗口是否回到最前 | **需真机**。代码路径存在（`closed` → `bringPinToFront`），本轮**未**为 history 单独补焦点还原。 |
| 磁盘满 / rename 失败 / 索引写失败 / 进程中途退出的故障注入 | 只有**索引写失败回滚**一条有用例（`index-publish-failed`）。其余未注入。 |
| `electron-store` 写入原子性 | 已确认底层 `conf → atomically`（临时文件 + rename），但 **Windows 上 conf 在 EXDEV 会回退成非原子写**；服务层因此额外维护索引备份 + `recoverIndex()`。真正的断电持久性**不保证**，与方案口径一致。 |
| 数据根目录迁移（含新布局的 base/doc/result/thumb 可达性） | **未实现**（§9 迁移行仍待做；现有 `data-root-migration.js` 只重写 `filePath`/`thumbnailPath`）。 |
| 版本时间线 UI、显式恢复旧版、列表双击/详情面板 | 批次 2/3，未做。 |
| 裁剪工具、对象橡皮擦、视口缩放平移、脏区重绘、mosaic LRU | 批次 2/4，未做。 |
| 识别隐私遮罩（方案前置的 E1 hotfix） | **未实现**，仍按方案列为独立 P0。 |
| `historyRevisionLimit` 的设置页 UI | 键已进 `settings-defaults`（即校验白名单）并被服务读取，但设置页**没有**对应输入控件。 |
| `capture:record-history` 未使用通道 | 仍存在（方案 F1）。本轮未启用为第二写入口，也**未移除**。 |
