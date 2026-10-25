# Highlighter 功能增补开发文档

日期：2026-10-25（Asia/Hong_Kong）
最近更新：2026-10-25 19:20（Asia/Hong_Kong）—— R0 + A + B 已实施

状态：**R0 / A / B 已实施并跑绿本地门禁；C–E 仍是方案，未实施。**
本文原为"尚未实施"的纯方案；§1.1 记录实际交付范围与偏差，其余章节保留原始设计口径
（未实施部分的"拟新增"仍然只是拟议，不代表现有能力）。

依据：[功能增补分析报告](F:/workspace/Highlighter/docs/plans/2026-10-25-snow-apps-feature-recommendations.md)。

## 1. 交付范围与开发顺序

本方案把分析报告的 A–K 转为任务和验收要求。近期交付 A–E，F–J 保留为后续独立批次，K 仅做探索。

| 阶段 | 范围 | 完成标志 | 分析阶段估算 | 实际状态 |
|---|---|---|---|---:|
| R0 前置收口 | 历史继续编辑契约、基础验收、资源基线 | 文档提交和生命周期可复用；差异清单明确 | 单独核算 | ✅ 已交付（见 [R0 基线](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-r0-baseline.md)） |
| R1 高频操作 | A 保存结果快捷操作；B 上次区域与尺寸预设 | 两个目标可分别交付 | 5–9 人日 | ✅ A、B 均已交付（见 §1.1） |
| R2 截图表达 | C 成品预设；D 放大镜 | 保存重开可编辑，所有出口一致 | 9–15 人日 | ⬜ 未开始 |
| R3 录屏处理 | E 头尾裁剪与 MP4/GIF 导出 | 真实媒体验收、取消和重复导出完成 | 8–13 人日 | ⬜ 未开始 |
| R4 可选增强 | F 拼图/切分、G 贴图工作组、H 识别纠错、I 自动滚动、J 录屏动作提示 | 每项独立立项和验收 | 沿用分析报告单项粗估 | ⬜ 未开始 |
| R5 探索 | K 本地 MCP 小范围验证 | 有具体自动化场景和协议设计 | 2–3 人日仅限探索 | ⬜ 未开始 |

实施顺序为 `R0 → A → B → C → D → E`。这是默认排期，不要求功能捆绑发布。A/B 不依赖新的文档 schema；D 按本方案依赖 C 的 schema 升级和遮挡采样基础；E 可在独立批次开发，但复用 A 的导出结果能力。

分析报告的 A–E 合计 22–37 人日，含约 30% 余量为 29–49 人日。**这仍是粗估，不是排期承诺**：R0 若发现现有提交/迁移/遮罩尚未完成，相关工作另行计入；C 的 schema 升级和 E 的媒体探测方案确认后须更新单项估算，不能把新增工作吞进原数字。

### 1.1 本轮实施记录（A + B，2026-10-25）

**交付范围**：方案 §4（A）与 §5（B）全部任务，**未超范围**。逐项交接见
[A 交接](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-A-handoff.md) 与
[B 交接](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-B-handoff.md)。

| 方案任务 | 实际落点 |
|---|---|
| A1 结果登记/过期/归属/系统动作 | `main/services/export-result-service.js`（429 行） |
| A2 `export:perform-action` + preload + 接入图片/表格/PDF 导出 | `main/ipc/export-ipc.js`、`main/ipc/export-action-controller.js`、两个 preload |
| A3 编辑器/识别结果条、托盘最近导出、表格保存并打开、locale | `capture/export-result-bar.js`、`recognition/`、`main/services/tray-menu.js` |
| B1 `region-presets` + `region-preferences` + 设置存取迁移 | `shared/region-presets.js`（592 行）、`main/services/region-preferences.js`（349 行）、4 个设置文件 |
| B2 capture/record 域调用公共解析 + IPC/preload/allowlist | `main/ipc/region-ipc.js`、`main/ipc/region-ipc-controller.js`、`main/domains/record/index.js` |
| B3 宽高/比例/复用上次/预设管理入口 | `capture/capture.{html,js,css}` |

**门禁结果（本机实测，2026-10-25）**：

```
npm test        → 1602 / 1602 pass, 0 fail
npm run check   → exit 0
                  check:js 421 files OK
                  check:architecture main.js 1316 ≤ 1330（未抬高上限）
                  check:i18n TOTAL 585（= HEAD 基线，零增长）
test:coverage:loaded   → 92.03% lines（限 85%）
test:coverage:critical → 93.46% lines（限 90%）
```

新增测试 **141 例**（结果服务 34 + A/B 集成 13 + 区域预设 60 + 设置迁移 23 + 窗口动作 11）。

**与原文的偏差（三条，均已记录在交接文档）**：

1. **§4.2 回执形状收紧**：原文示例只要求 `{status, resultId, fileName, kind}`；实现进一步
   确认**不得**携带 `filePath` —— 渲染层只应持有 resultId，路径不跨进程。已按这个更严的口径
   实现并用测试逐面钉住（含 JSON 序列化泄漏检查）。
2. **§5.1 比例锁**：原文只写"固定比例只联动尺寸"；实现补齐了自由/16:9/16:10/4:3/1:1/9:16
   六个预设，并明确**不触碰文档 crop**、应用尺寸时**保留左上锚点**。
3. **§3.1 分层**：为守住 `main.js` 1330 行上限，新增
   `main/services/feature-services-bootstrap.js` 承载 A/B 两个服务的构造与 IPC 装配。
   `main.js` 只留调用行，装配代码仍不在 `main.js` 里。

**仍未做（不得当作已完成）**：

- 安装包与实机副屏矩阵 —— A/B 交接文档里逐项标「未验证」。
- 契约 §8 识别遮罩、契约 §9 新布局迁移与孤儿清理 —— 仍是后续批次的**前置条件**（见 §2 R0.3/R0.4）。
- C/D/E 未开始；本文其余章节对这些功能仍是方案口径。

## 2. 当前工程事实与前置任务

本次复核基线仍为 Highlighter HEAD `66f333c`，工作区版本 `4.1.4`，包含未提交的历史编辑改造。现有修改属于既有工作，本方案实施时必须先重新确认状态，不覆盖或混入其他目标。

现有身份、提交与关闭语义以[历史编辑契约](F:/workspace/Highlighter/docs/plans/2026-10-25-history-reedit-batch0-contracts.md)为准。该契约写明的目标不自动等于已经验证的运行行为。

| 已核对的事实 | 对开发的直接约束 |
|---|---|
| `shared/capture-document.js` 当前 `schemaVersion=1`，字段和标注类型采用白名单 | 新增样式和放大镜必须升级 schema、迁移、校验与指纹，不能只往 JSON 塞字段（C/D 仍待做） |
| `capture-document-service.js` 当前要求结果图宽高等于 `crop.w/h` | C 增加边框/留白会改变结果尺寸，需要版本化扩展此契约 |
| 文档提交、纯导出、复制/贴图具有不同动作语义 | 不能把"导出成功"当"文档已保存"，也不能每个按钮各自新增历史（A 已按此落地） |
| 录屏 `saveMp4` 成功后清理会话，渲染器随后关闭 | E 必须先拆开导出与结束会话，才能重复导出及重试 |
| `settings-validation.js` 对设置字段按模板校验，但数组未逐元素做领域校验 | B 的预设数组必须补专用校验，不能仅加入默认设置（**已补**：`null` 叶规则 + `{domainValidators}` 钩子） |
| `scripts/check-architecture.js` 限制 `main.js` 为 1330 行 | 新逻辑进入 domain/service/shared 模块；不能为功能直接提高上限（A/B 实测 1316，未抬高） |

**A/B 实施后对第 1 行约束的补充**：`schemaVersion` 仍是 1 —— A/B **没有**改动文档格式，
因为两者都不新增持久化文档内容。schema 升级仍然是 C 的入口条件。

### R0 任务清单

- [x] **R0.1 状态核对**：记录当前 commit、未提交改动、文档服务实际实现范围，以及既有测试结果的日期和来源。
      → 见 [R0 基线](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-r0-baseline.md) §R0.1。
- [x] **R0.2 文档闭环**：验证新截图建档、历史更新、另存、取消导出、失败重试、冲突、删除后提交、关闭协商、旧 PNG 兼容。不得重复创建历史记录。
      → 138 例契约测试 + 1 例真实 Electron 编辑器用例通过（R0 基线 §R0.2）。
- [ ] **R0.3 生命周期**：验证当前 head、旧版本和底图的保留/删除/迁移关系；对外出口只用正确的成品，不用底图替代丢失结果。
      → **部分完成**：`resolveCommittedResult` 与保留裁剪已有用例；**磁盘布局迁移与孤儿清理未实现**
      （`data-root-migration.js` 只重写 `filePath`/`thumbnailPath`，`isOwnedHistoryFile` 只认旧命名）。
      这是 C/D 落新资产前的**硬前置**，不能算 A/B 的完成标准。
- [ ] **R0.4 遮挡输入**：核对既有契约 §8 的识别遮罩是否落地。若未完成，登记为原改造的独立修复任务；最迟在 D 开始前交付，不把它算成放大镜附赠行为。
      → **已核对，结论：未落地**。全部识别入口（OCR/翻译/表格/QR/转文档）直接消费渲染层像素，
      没有 blur 遮罩合成。已登记为独立 P0，**D 开始前必须交付**。
- [x] **R0.5 基准与门禁**：记录基线性能、所需测试结果、已知失败及 CI 状态。未通过项明确归因，不能宣称本轮已修复。
      → R0 基线 §R0.5 记录基线 1461 例、已知 clipboard lease flake 与 CI success；性能样本**未采集**（标未验证）。

R0 不要求完成旧方案所有远期优化；它只冻结后续功能必需的身份、坐标、提交与资源契约。每个功能开始前列出其依赖的 R0 条目及证据。

## 3. 共用工程约束

### 3.1 分层与接口规则

渲染层负责交互与受限参数；shared 放纯几何、文档模型和参数归一化；domain 负责窗口/会话归属；service 负责文件、持久化、导出和任务；`main.js` 只装配。

每个新增 IPC 同步更新注册模块、对应 preload、`ipc-security` 的角色 allowlist、通道契约测试与安全测试。不能仅凭 `sessionId/resultId/taskId` 授权，还必须验证发送窗口属于该会话。事件订阅提供取消函数；窗口销毁后停止发送并释放监听。

以下通道名是拟定契约，实施前核对命名冲突。旧接口若仍有调用方，先在服务层适配，再单独迁移调用方；不能静默改变旧返回类型。

### 3.2 数据、保存与失败语义

- 保留 `documentId/revisionId/expectedRevisionId/requestId` 语义与不可变版本。对文档的 update、另存和删除仍走现有串行提交机制。
- 新设置补齐默认值、归一化、严格入口校验、持久化迁移与 UI。旧设置缺字段时使用明确默认值；不能容忍 NaN、无穷大和无界数组。
- 所有路径由主进程从保存对话框结果或受控资源解析。跨进程参数不接受任意输出路径、FFmpeg 参数或 shell 命令。
- 导出结果、文档提交结果和后续“打开文件”结果分别报告。例如“文档已保存，外部导出失败”与“文件已保存，打开失败”都不是全部失败。
- 临时文件写完并校验后再发布。取消/编码失败只删除本任务临时文件，不能删除用户原有目标文件。
- 新增持久资产必须接入数据目录迁移、清理、空间统计；临时任务与 GC/迁移互斥关系明确。

### 3.3 初始资源护栏

下表是**拟定的 MVP 工程限制，不是测得的最优值**。通过 R0/E0 基准可调小或调大，但要记录依据，并保留集中常量、服务端校验与边界测试。

| 对象 | 初始限制 | 生命周期 |
|---|---|---|
| 导出结果登记 | 全局最多 50 条、每条 15 分钟；托盘只展示最近 1 条 | 只存元数据，失效不删除外部文件 |
| 自定义尺寸预设 | 最多 20 项，名称最多 40 字符 | 保存在配置；不保存图片 |
| 放大镜 | 每文档最多 8 个；局部采样缓存总量最多 32 MiB | 编辑器关闭释放；按字节计费而非只按项数 |
| 视频导出 | 全局 1 个编码任务，最多 2 个排队任务 | 子进程在成功/失败/取消后退出 |
| GIF | 所选时长不超过 60 秒；不放大源图；长边不超过 1280 px；帧率 10/15/20；不超过 1200 帧 | 提交前预估；超限要求缩短或降低规格 |

**A/B 的实际落点（2026-10-25 实施后核对）**：

| 对象 | 实现常量 | 落点 |
|---|---|---|
| 导出结果登记 | `DEFAULT_MAX_ENTRIES=50`、`DEFAULT_TTL_MS=15min` | `main/services/export-result-service.js` |
| 结果动作种类 | `EXPORT_ACTIONS=['open','copy-path','reveal']`、`EXPORT_KINDS=['png','pdf','xlsx','mp4','gif']` | 同上 |
| 自定义尺寸预设 | `LIMITS.MAX_PRESETS=20`、`MAX_NAME_LENGTH=40`、`MIN_EDGE_PX=16`、`MAX_EDGE_PX=10000`、`MAX_TOTAL_PIXELS=80_000_000` | `shared/region-presets.js`（集中定义，主进程与渲染层共用） |
| 通道名 | `export:perform-action`、`region:resolve/get-preferences/save-preset/delete-preset` | `main/services/ipc-security.js`（`capture` + `recognition` 两个角色） |

方案原表中"托盘只展示最近 1 条"已实现：`latestFor()` 无 owner 时返回最新一条，
托盘菜单**条件追加**单条入口（无回执时菜单结构与改动前逐项一致）。

像素预算沿用当前各入口的有效上限并在分配前验证**装饰后的尺寸**，不能拿长截图 2 亿像素上限直接套到编辑器。上述限制不替代内存峰值、CPU、临时磁盘与任务结束后回落的实测。

## 4. A：保存结果快捷操作与表格直接打开

### 4.1 用户行为

普通截图的快捷复制/保存继续遵守原有关闭设置，不强迫用户停留在全屏浮层。历史编辑器、识别结果页在原窗口内展示结果条；已关闭截图的最近一次文件导出可从托盘“最近导出”访问，复用现有托盘，不新增常驻窗口。

结果条操作为“打开”“地址”“打开文件夹”。“地址”始终复制完整路径；“打开文件夹”才负责定位文件。编辑器的“继续编辑”只是关闭结果条、回到当前会话，不重新读图或重建文档。

表格增加“保存并打开”，保存 `.xlsx` 后调用系统默认应用。取消保存不打开任何东西；默认应用缺失时保留文件并报告打开失败。PDF、PNG 和将来的 MP4/GIF 复用结果操作；首版不实现文件对象剪贴板。

### 4.2 拟新增契约

```ts
type ExportReceipt =
  | { status: 'saved'; resultId: string; fileName: string; kind: 'png'|'pdf'|'xlsx'|'mp4'|'gif' }
  | { status: 'cancelled' }
  | { status: 'failed'; code: string; retryable: boolean };

// 仅针对主进程刚登记的产物，不接受路径。
type ExportAction = { resultId: string; action: 'open'|'copy-path'|'reveal' };
```

拟新增 `export:perform-action`，返回 `{status:'done'}` 或 `{status:'failed',code}`。主进程登记 resultId、绝对路径、类型、来源、时间和 owner；发送方必须属于被允许的结果消费者。托盘通过内部方法消费最近产物，不把内部调用伪装成 renderer IPC。

窗口销毁时撤销其 IPC 能力；托盘的单条内部引用可保留至过期。清理登记项只移除引用。执行动作时重新检查文件存在与类型，错误码包括 `result-expired/file-missing/invalid-owner/open-failed`。

现有 `saveImageBuffer()` 与 `recognition:export-excel` 返回路径或空值。首步在外层包装成 receipt，保留旧调用方适配，完成迁移后再收口。`saved` 只表示文件成功写入，文档是否提交由原提交返回值表示。

### 4.3 任务与出口

| 任务 | 实现内容 | 必须验证 | 状态 |
|---|---|---|---|
| A1 | `main/services/export-result-service.js`，登记/过期/归属校验/系统动作 | 跨窗口伪造、过期、文件丢失、打开失败 | ✅ 34 例 |
| A2 | `main/ipc/export-ipc.js` + `export-action-controller.js` 与对应 preload 接线；接入图片/表格/PDF 导出 | 路径返回适配，取消与失败不出现成功结果 | ✅ 集成 13 例中的 controller 部分 |
| A3 | 编辑器/识别结果条、托盘最近导出、表格保存并打开；补 locale | 快捷流程不多一步，导出完成不抢焦点 | ✅ 代码完成；**观感需真机** |

验收场景：取消保存、连续保存不同文件、文件移走、无表格关联应用、历史关闭、文档提交成功但导出失败、外部文件成功但打开失败。A1–A3 完成前，不对用户暴露半接线按钮。

**实施结果（2026-10-25）**：A1–A3 全部落地，逐场景证据见
[A 交接 §5](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-A-handoff.md)。
回执形状收紧为 `{status, resultId, fileName, kind}`（**不含 filePath**），并加了三处实现期缺陷修复记录。

## 5. B：区域复用与尺寸预设

### 5.1 坐标决策

预设表示**输出像素宽高**，上次区域表示**某个显示器上的位置和尺寸**，二者分开存。第一版限定单显示器，完整历史区域浏览和跨屏统一画布不在范围内。

拟增加 `screenshot.regionPreferences`：

```ts
{
  schemaVersion: 1,
  lastByMode: { capture: null, record: null }, // 非空时为下面的 LastRegion
  presets: [{ id, name, widthPx, heightPx }]
}
type LastRegion = {
  displayKey: string,
  displayBoundsDip: {x:number,y:number,width:number,height:number},
  displayPixelSize: {width:number,height:number},
  rectDisplayPx: {x:number,y:number,width:number,height:number},
  capturedScaleFactor: number
};
```

`displayKey` 是匹配线索，不假定系统显示器 ID 跨重启稳定。记录只由主进程根据已确认区域构建；不允许设置页提交伪造桌面坐标。

解析时先找当前屏幕并使用当前捕获图像的实际像素宽高，分别计算 X/Y 像素到 DIP 的映射；不能把显示缩放与编辑器 zoom 混用。匹配屏幕失效或几何变化时，在用户当前屏幕居中放置并标示“区域已调整”，再让用户确认。尺寸超出当前屏幕时明确夹紧/提示实际尺寸，不静默声称保持了原预设。

尺寸锁保留拖拽锚点、就近合法像素取整；固定比例只联动尺寸，不自动改动文档 crop。截图确认并执行有效操作时更新 capture 的最近区域；录屏成功开始时更新 record 的最近区域。取消框选不覆盖记录，录制开始后禁用区域切换。录屏编码要求导致尺寸对齐时，在开始前显示最终有效尺寸。

### 5.2 接口与设置校验

拟新增 `region:get-preferences`、`region:save-preset`、`region:delete-preset`、`region:resolve`；最后一个按模式与 presetId/last 返回主进程校验后的区域和 `adjusted` 原因。最近区域写入是 domain 内部动作，不暴露任意写入通道。

自定义数组逐项检查 ID、去重、名称、整数尺寸、像素预算和未知字段。规范化旧配置时丢弃非法项并记录诊断；新 IPC 输入错误应明确拒绝，不能悄悄改成别的尺寸。缺省 `lastByMode` 与空数组不应被当前模板类型验证误拒绝，需要专用领域校验及迁移测试。

### 5.3 任务与验收

| 任务 | 实现内容 | 必须验证 | 状态 |
|---|---|---|---|
| B1 | `shared/region-presets.js` 与 `main/services/region-preferences.js`；设置存取和迁移 | 负坐标、非整数、超大尺寸、重复 ID、非法配置 | ✅ 60 + 23 例 |
| B2 | capture/record 域调用公共区域解析；补 IPC/preload/allowlist | 单屏与混合 DPI；历史关闭也能复用 | ✅ 纯函数层全绿；**真机 DPI 矩阵未验证** |
| B3 | 宽高、比例、复用上次、预设管理入口；保持现有 Esc 语义 | 连续截图尺寸一致；显示器拔出/重排仍可操作 | ✅ 代码完成；**观感需真机** |

至少覆盖 100%/150%/200% DPI、主副屏左右布局与负坐标、屏幕旋转、输入框焦点时快捷键不抢输入，以及录制期间无法切换区域。

**实施结果（2026-10-25）**：B1–B3 落地，证据见
[B 交接 §5](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-B-handoff.md)。
比例锁补齐六个预设且**不触碰文档 crop**；DIP→物理像素的转换集中到
`recordFromDisplaySelection(space:'dip')`，避免各调用点复现"200% 屏上区域翻倍"的陷阱。

## 6. C：截图成品预设与文档 schema v2

### 6.1 范围与统一合成

提供原图、浅色卡片、深色卡片三个预设；用户可调留白、背景、圆角、简单阴影和边框。首版外部图片保持 PNG，JPEG 不新增入口；已有 PDF 使用同一成品图。纯图像导出预设不影响 OCR 输入，也不改变原始底图。

拟新增 `shared/capture-output-style.js`（默认值、校验、几何）和 `capture/output-compositor.js`（浏览器图像合成）。编辑预览与导出共用参数与合成实现，禁止 CSS-only 阴影作为导出依据。UI 控件、选择框、放大镜源区提示不进入成品。

固定组合顺序：裁剪底图 → 标注/捕获附件 → 对内容做圆角裁切 → 成品背景/阴影/边框与留白布局。D 引入的遮挡安全采样在内容层内部处理，不改变外层布局。首版不设计画布效果手柄或背景素材库。

### 6.2 版本化扩展

schema v2 在内容字段中增加：

```ts
outputStyle: {
  enabled: boolean,
  paddingPx: number,
  background: { color: string, alpha: number },
  cornerRadiusPx: number,
  border: { widthPx: number, color: string },
  shadow: { enabled: boolean, blurPx: number, offsetXPx: number, offsetYPx: number,
            color: string, alpha: number }
}
```

所有长度均为源像素；所有数字有限且有集中上限。presetId 只是 UI 偏好，产物由完整解析参数决定。原图模式禁用效果，其几何必须与 v1 完全相同。

**本节是对旧契约“结果尺寸等于 crop”的拟议扩展，只有 C 的实现和迁移测试完成后才生效；本次不修改旧契约文件。**

统一函数 `resolveOutputGeometry(doc)` 输出 `{width,height,contentOffsetX,contentOffsetY}`。阴影扩展采用可计算的有限边界，背景/透明区覆盖该边界；先计算预算再分配画布。预览与导出使用同一有限阴影核/裁切边界，不能依赖无限外扩假设。

映射规则：`outputX = sourceX - crop.x + contentOffsetX`，Y 同理。标注与 crop 仍在底图像素坐标中；不把外框留白反写进 crop，也不把底图尺寸改成成品尺寸。

主进程对 v1 继续验证结果尺寸为 crop，对 v2 按 `resolveOutputGeometry()` 校验 PNG 可解码尺寸；历史卡片宽高记成品尺寸，缩略图来自成品。所有复制/保存/贴图/PDF 入口复用同一冻结内容与结果。

### 6.3 迁移与撤销

登记 `1 → 2` 迁移：添加禁用效果的默认参数。打开时在内存归一化，不能仅因升级就新增 revision 或变成 dirty；服务端和渲染器必须用同一归一化版本计算 clean 指纹，不能拿旧 schema 指纹直接与新指纹比较。

旧 revision 和已有幂等回执保留原字节/语义，真实内容变更后才写新版本；不得原地重写历史资源。v2 未知字段仍拒绝，旧客户端打开新版本保持既有“仅位图恢复”边界并显式提示，不能静默抹掉效果。回滚应用前先验证能否保留/访问结果图，不自动降写新文档。

一次拖动滑块只产生一个撤销步骤；恢复“原图”可撤销。参数变化纳入内容指纹；仅切换预览缩放不产生新版本。重开、反复保存和贴图再编辑均不能累计叠加外框。

### 6.4 任务与验收

| 任务 | 实现内容 | 必须验证 |
|---|---|---|
| C1 | v2 字段/迁移/指纹；提交结果尺寸规则；同步旧契约扩展说明 | v1 打开不变脏、旧回执仍幂等、超像素拒绝 |
| C2 | 共享成品合成、撤销、预设面板 | 圆角 alpha、阴影边界、原图等价、滑块手势撤销 |
| C3 | 复制/保存/贴图/PDF/历史缩略图接线 | 重开保留样式；相同快照不同出口一致 |

像素验证使用确定性几何与容差策略；涉及硬件/软件光栅差异时先建立基线，不机械添加无法在 CI 成立的逐像素断言。明确检查透明背景、极小图片、4K 图、边界大图和 DPI 切换。

## 7. D：局部放大镜标注与 schema v3

### 7.1 交互与对象

选择工具后先框定采样区，再放置镜头；镜头为矩形，倍率 2×/3×/4×，可调简单边框和引线开关。源区和镜头可分别拖动，一次手势一次撤销；镜头不嵌套，不支持旋转。镜头超出 crop 的部分按正常标注裁掉，不自动扩展底图。

新增 `magnifier` 对象，其持久化结构拟为：

```ts
{
  id, type: 'magnifier',
  sourceRect: { x, y, w, h }, // 底图像素坐标，必须在当前 crop 内
  lensOrigin: { x, y },       // 同一坐标系
  factor: 2 | 3 | 4,
  stroke: { color, widthPx },
  connector: 'none' | 'line'
}
```

镜头内容宽高由 `sourceRect.w/h × factor` 推导，禁止同时持久化互相矛盾的镜头尺寸。裁剪导致源区越界时，使用统一规则求与 crop 的交集；交集为空则在该裁剪变更中移除对象并允许撤销恢复，不能悄悄采样 crop 外内容。倍率变更以镜头中心为锚点。

拟新增 `capture/magnifier.js` 与共享几何函数。扩展 `capture/annotation-geometry.js` 的命中、选择、移动和包围盒逻辑，以及文档投影/逆投影中的嵌套矩形处理；不能只修改当前顶层 `x/y/width` 转换。

### 7.2 安全采样与缓存

依赖 R0.4 的遮挡规则。建立镜头专用采样底图：原底图加全部当前 blur 覆盖区域的不透明遮罩，不含放大镜、普通说明标注和成品外框。镜头只从该图取样，不能按 z 顺序绕过后来加上的 blur。普通底图的马赛克显示效果保持原有语义。

遮罩需覆盖笔刷半宽、端帽和保守边界，先遮挡再缩放。删除 blur 后才允许下一次内容渲染解除保护；取消编辑或临时透明预览不解除。该机制防止新功能暴露未遮挡底图，但不宣称能修复历史位图中已烘焙的不充分马赛克。

缓存键至少包括底图内容标识、crop、遮罩内容指纹、源区与采样尺度。移动镜头位置不重新采样底图；改变源区、blur 或底图必须失效。缓存超预算淘汰冷项，关闭编辑器释放。测试截取传给采样器的像素，不能只观察 OCR 是否恰好读不出来。

### 7.3 schema 和任务

在 C 的 v2 基础上升级 v3，登记 `2 → 3` 无损迁移并扩展标注类型白名单；v1 通过迁移链进入 v3。沿用 C 的“打开不增版、不变脏、旧 revision 不覆盖”规则。旧客户端不能识别对象时显式降为结果图访问，不能丢弃 magnifier 后覆盖保存。

| 任务 | 实现内容 | 必须验证 |
|---|---|---|
| D1 | schema v3、几何、嵌套坐标投影、对象预算、裁剪相交规则 | 不合法倍率/源区拒绝，裁剪撤销恢复，迁移链 |
| D2 | 采样底图、遮罩复用、32 MiB 缓存预算 | 遮挡顺序、失效、边缘像素、缓存释放 |
| D3 | 工具交互、倍率/引线、命中与撤销 | 拖动/缩放/DPI 后位置正确，手势一步撤销 |
| D4 | 文档保存、复制/PDF/贴图等输出、历史重开 | 放大镜仍可编辑，所有成品出口一致 |

验收至少包含文字与二维码被 blur 覆盖、多个镜头共享源区、源区位于图片边缘、裁剪后源区消失、撤销到原状态、保存重开与跨 DPI 编辑。达到上限时给可理解提示，不继续无界分配。

## 8. E：录屏裁剪与 MP4/GIF 导出

### 8.1 E0 技术验证先行

现有 FFmpeg 编码器能力已在分析阶段检查，但应用未捆绑可直接假定存在的 `ffprobe`。先用项目实际可分发组件验证媒体探测方案：WebM 可能缺少可直接读取的 duration/seek 索引，需要处理缺失索引和有限的索引修复。

E0 交付一个主进程探测适配器方案及无声/有声 WebM 样本结果，输出实际时长、宽高、音轨存在性和时间基准。不能以渲染器传来的 `durationMs` 作为唯一可信依据；它只用于 UI 初值。探测无法得到可靠边界时明确失败或进入可取消准备阶段，不能传入无穷大/猜测时长。

若现有组件无法可靠完成探测，再单独选择、评估并记录新增依赖；该决定会影响包体、成本与构建，不由本文预先假定。E0 是 E2 的入口条件，不妨碍先做 E1 会话生命周期拆分。

### 8.2 交互范围

停止录制后进入预览，显示整段时长和头尾两个裁剪点，支持输入时间与拖动，选择范围为源时间的半开区间 `[startMs, endMs)`。播放从 start 开始，到 end 暂停；拖动播放头不改变裁剪范围。导出期间冻结提交参数，当前任务绑定该快照。

格式提供 MP4 和 GIF。MP4 保留当前音轨策略，并根据**文件实际存在的音轨**构建参数；GIF 清楚标示不含音频。GIF 尺寸与帧率受 §3.3 限制，显示选区时长与预计帧数；不编造精确文件体积。变速、多段剪辑、摄像头、HEVC、APNG/WebP 均留到后续。

导出成功后保持预览和源文件，可修改范围再次导出；显示 A 的结果条。重新录制或关闭预览时才结束源会话。UI 不再调用成功即清理源文件的旧路径。

### 8.3 会话与任务分离

录制会话：`capturing → finalizing → ready → closing → closed`，录制失败为 `failed`。导出任务：`queued → running → publishing → succeeded`，失败进入 `failed`；取消通过 `cancelling → cancelled`，等待子进程真正退出后才允许回收临时文件。

拟增加 `main/services/recording-export-service.js`、`shared/recording-export-options.js` 与 `record/trim-controller.js`。源文件由 `RecordingService` 持有，导出服务只持有该源的任务引用；原有 `managedRecordingWriters` 必须追踪新写任务，迁移/退出仍能等待或阻止写入。

```ts
// 源路径与目标路径不由 renderer 提交。
type RecordingExportRequest = {
  sessionId: string,
  requestId: string,
  range: { startMs: number; endMs: number },
  format: 'mp4'|'gif',
  gif?: { maxEdgePx: number; fps: 10|15|20; loop: true }
};
// 主进程弹保存对话框并冻结目标，接受后返回 taskId。
// 取消选择目标返回 cancelled，不创建任务。
```

拟新增通道：

| 通道 | 方向 | 行为 |
|---|---|---|
| `record:export` | invoke | 校验归属、文件元数据、范围与预算，选择目标，登记不可变任务 |
| `record:export-status` | invoke | 根据 taskId 或同会话 requestId 查询状态，补偿丢失回执 |
| `record:cancel-export` | invoke | 取消任务，保留源文件和裁剪范围 |
| `record:export-progress` | 主 → 渲染 | `{taskId,state,progress?,error?,receipt?}`；未知进度用不确定态 |

同 requestId+同参数复用任务；同键不同参数返回 `request-mismatch`。已过期回执返回 `expired`，不能隐式重新导出。新一轮导出使用新 requestId。单窗口当前任务期间禁用重复提交，服务端仍负责限流。

旧 `record:save-mp4` 保留到所有生产调用方迁移完成；适配不得在新任务仍引用源时触发 `cleanupSession`。退出流程与 `_recordSessionId` 释放须同步修改，避免“UI 留在预览但源已被删除”。

### 8.4 文件发布、取消与关闭

目标来自主进程保存对话框。FFmpeg 写入目标同目录的唯一临时文件，校验可解码、格式、尺寸及所选时长后再发布。覆盖已有文件遵循明确覆盖意图；发布前再次检查竞争修改，必要时重新确认/另选路径。任何失败不允许先删除旧目标，普通 rename 也不当作断电持久性保证。

发布与取消按任务串行裁决：发布点之前收到取消则不替换目标；目标已成功发布则返回 succeeded 和结果回执，晚到的取消不再删除成品，也不能把任务改报 cancelled。取消按钮在最终发布阶段显示“正在完成”，状态查询用于消除回执竞争。

第一版不提供无窗口后台导出。用户关闭时若仍有任务，提供“取消导出并关闭 / 继续等待”；取消完成、子进程退出、源引用归零后再清理。普通取消导出返回 ready，保留源供重试。系统退出与窗口意外销毁执行取消和有界回收，不将未校验文件报告成功。

应用异常退出后，启动清理只识别自己的录制目录/事务标记；不扫描删除用户普通文件。首版不承诺崩溃后恢复未保存录制，UI/文档如实说明。数据目录迁移等待活跃任务结束或明确取消后再进行。

### 8.5 编码与验证要求

主进程通过白名单参数构建 argv 并直接 spawn，`windowsHide:true`，不经过 shell。裁剪的视频和音频都以相同源区间处理并重新建立输出时间戳。非关键帧边界需解码裁剪，不能用简单流复制冒充精确裁剪。GIF 使用有界调色板生成/应用流程，宽高等比、禁止放大，循环输出。

时间参数只接受有限值且 `0 ≤ start < end ≤ duration`；先明确取整到实际帧/音频样本边界的规则，预览和导出一致。AAC 编码延迟与可变帧率样本需记录容差来源，不能为通过测试随意放宽。进度来自编码进度与冻结范围；只有成功发布后才报告 100%。

| 任务 | 内容 | 验收重点 |
|---|---|---|
| E0 | 实际 WebM 探测/索引验证、取消与耗时样本 | 文件真实边界，不依赖 renderer 单方面时长 |
| E1 | 会话/导出服务拆分、源引用、退出与迁移协调 | 成功不删源，重复导出，窗口关闭和取消竞争 |
| E2 | 时间范围、MP4/GIF 参数、任务队列、临时输出/发布 | 真媒体解码、旧目标保全、无声/有声、非关键帧 |
| E3 | 裁剪 UI、范围播放、格式预设、结果条、旧入口迁移 | 播放范围/导出一致，错误可重试，无重复编码 |
| E4 | 资源与实机矩阵、文档/发布说明 | 长录制、磁盘故障、退出、编码后无残留子进程 |

## 9. F–K 后续开发入口

以下保持分析报告的功能 ID。可以独立拆开发文档，但不得未经范围调整就并入 A–E 的完成标准和工期。

| ID | 第一版任务拆分 | 必要依赖与数据决策 | 独立验收 |
|---|---|---|---|
| F1 拼图 | 历史多选顺序 → 横/纵布局预览 → 主进程合成 → 结果操作 | 输入固定为已提交 revision，任务期间保留资源引用；只传预览缩略图；校验总像素 | 输入尺寸混合、等宽/等高、排序、取消、失败不污染原图 |
| F2 长图切分 | 固定像素高度/页高 → 分片编号和重叠 → 图片或多页 PDF | 复用长截图结果和 PDF 出口；与现有“一图一页”区分 | 无缺行、顺序稳定、重叠符合设置、末页无空白页 |
| G 贴图工作组 | 保存/命名组 → 资产持久化 → 手动切组/恢复 → 删除与迁移 | 首版组拥有图片副本，避免引用历史清理后失效；只恢复当前组且保持现有 20 窗口上限 | 重启、历史原图删除、缺失资产、多屏重排、反复切组不泄漏 |
| H 识别纠错 | OCR 行选择/阅读序 → 单元格编辑 → 统一格式重建 | 单一结构化模型生成全部复制/导出格式；复杂合并和公式编辑不做 | 前导零、长数字、引号/换行、空值、取消编辑、一致 XLSX |
| I 自动滚动 | 容器/目标绑定 → 方向/速度/暂停 → 帧稳定性/背压 → 停止原因 | 复用长截图会话；首次注入验证目标，焦点/目标丢失立即停；缓存有界 | 浏览器/聊天/设置列表、固定页头、懒加载、用户打断、到底识别 |
| J 动作提示 | 事件订阅 → 有界源时间序列 → 点击/滚轮/快捷键组合层 | 依赖 E 时间轴；只在显式开启且录制时订阅，不保存普通文本；暂停不记入媒体时间 | 暂停恢复、裁剪边界、DPI、快捷键输入、停录后监听释放 |
| K MCP | 真实场景脚本 → 五类接口原型 → 所有权/版本/取消实验 → 决定是否产品化 | 状态、区域截图、OCR、保存、取消；默认关闭，复用业务服务而非任意 IPC 转发 | stale revision、会话竞争、超时、用户接管、输出路径与取消 |

F/G/H 都有独立持久化或临时资源变化，需继承 §3 的清理/迁移规则。G 组副本与历史文件解耦会增加磁盘占用，必须展示统计和删除效果。J 首版可按用户开启状态烘焙效果，但事件时间模型仍以源时间为准；不承诺导出后还能去除已烘焙提示。

“截图 OCR 内容搜索”仍只是衍生方向，未纳入 H：若后续开发，默认复用用户主动识别结果，并先定义保存、删除与索引生命周期，不新增默认全库后台 OCR。

## 10. 测试、实机与性能验收

### 10.1 功能测试矩阵

测试围绕实际风险，不用只检查实现字符串的断言代替行为验证。拟新增测试文件随对应模块创建；下表列出的现有文件可作为入口，不等于本次已执行。

| 范围 | 自动化验证 | 实机/产物验证 |
|---|---|---|
| A | result 归属/TTL/错误；现有 `image-file-save`、recognition、history IPC 测试回归 | 默认应用、取消对话框、文件移动、焦点 |
| B | 区域变换往返、预设逐项校验、设置升级、会话限制 | 混合 DPI、负坐标、屏幕拔插与重排 |
| C | v1→v2、指纹、输出几何、透明像素、提交尺寸、回执兼容 | PNG/剪贴板/贴图/PDF、硬件与软件光栅、重开 |
| D | v1→v2→v3、源区/镜头几何、遮罩边界像素、缓存淘汰、撤销 | 多镜头拖动、缩放/DPI、二维码/文字遮挡、长时间编辑 |
| E | 参数、源引用、任务竞争、文件发布故障注入、真实编码解码 | 有声/无声、短/长录制、非关键帧、取消、覆盖旧文件 |

可复用的主要现有测试：`test/capture-document.test.js`、`test/capture-document-service.test.js`、`test/capture-document-editor-runtime.test.js`、`test/capture-annotation-geometry.test.js`、`test/image-file-save.test.js`、`test/settings-validation.test.js`、`test/settings-normalize.test.js`、`test/recording-service.test.js`、`test/recording-preview-runtime.test.js`、`test/ipc-module-contracts.test.js`、`test/ipc-security.test.js`。实施时确认文件仍存在及其覆盖范围。

### 10.2 性能证据

R0 固定测试机器、屏幕布局/DPI、版本、输入样本与采样方式。普通截图、4K 图、多笔刷/镜头、大图和录屏各有冷/热样本；报告样本数和 p50/p95，不把一两次手测当统计结论。

至少记录：首次打开时间、交互帧耗时、导出耗时、Electron 全进程与 FFmpeg 峰值内存、CPU、临时磁盘峰值、完成后回落、活跃窗口/监听/任务数。可以复用现有 `performance-monitor`，但它不自动覆盖所有原生子进程。

验收预算在 R0 的基线文件中冻结后再比较。无论预算如何设定，以下硬条件不变：无新增空闲编码子进程、无默认全库 OCR、缓存/队列不超配置上限、重复打开关闭不持续累积资源、任务结束后可解释并清理临时文件。

### 10.3 环境与门禁

日常任务先运行相关测试及 `npm run check` 中适用检查；集成/发布前执行 `npm test`、覆盖率、E2E、长截图、版本和 fuses 等仓库要求，记录命令与结果。仅编写本开发文档不需要运行产品测试。

运行 Electron 门禁前按根目录 AGENTS 排除四个环境因素：清除 `ELECTRON_RUN_AS_NODE`；需要时把 `--no-sandbox` 放在脚本之前；TMP/TEMP 与 E2E 数据根放仓库 `.tmp*/`；审计使用 npm 官方 registry。临时 spawn hook 放仓库外，不提交；scratch 在提交前清理。

剪贴板 lease 用例若失败，先按 AGENTS 单独重跑两次判断已知 flake。像素测试本地绿但 CI 红时检查该用例历史 CI 记录与光栅环境，不能先放宽断言。**本地通过、CI 通过、安装包通过、实机通过分别记账。**

所有可见自动化和实机测试窗口默认放副屏；无副屏先确认。安装包验证只在具备相应桌面/安装条件时执行，不从单测推断；安装和发布不属于本文档编写范围。

## 11. 提交、交接与完成标准

### 11.1 提交边界

每个目标单独创建可审计提交，不将 A–E 或现有未提交的历史改造揉成一次提交。复杂目标可分多个内部提交，但每个提交保持调用方/契约一致；新 schema 不能在读写链未完整接线时向用户写入。

| 提交组 | 建议边界 | 禁止混入 |
|---|---|---|
| R0 | 现有改造验收/必要修复；文档、遮罩修复分别记录 | A–K 新功能 |
| A | 结果登记与系统操作；各入口接线与 UI 可分提交 | 文件对象剪贴板、任务中心 |
| B | 区域数据/几何；截图/录屏入口与设置 | 跨屏画布、完整区域历史浏览 |
| C | schema/尺寸契约；合成；交互和出口 | D 放大镜、其他图片格式 |
| D | 对象模型；遮挡采样；交互与持久化接线 | 智能擦除、任意形状镜头 |
| E | 源会话生命周期；任务编码；裁剪 UI；兼容入口清理 | 摄像头、HEVC、多段剪辑 |

提交前检查暂存范围，保留工作区其他修改和无关未跟踪文件。涉及既有共享文件时先协调改动归属；不要用整仓库暂存把其他目标带入。本文不自动创建提交或分支。

### 11.2 每批交接记录

实施时新增 `docs/plans/<日期>-feature-<A/B/C/D/E>-handoff.md`，包含：最终范围、commit、文件/接口变化、兼容与迁移、测试命令和结果、性能样本、实机矩阵、已知限制、下一步。

**已创建**：`2026-10-25-feature-A-handoff.md`、`2026-10-25-feature-B-handoff.md`、
`2026-10-25-feature-r0-baseline.md`（R0 证据记录）。C/D/E 的交接文档待各自批次创建。

若发生范围改变，更新本开发文档对应章节和估算；不只在评论里保留决定。只有完成后才勾选任务，未跑项标明"未验证"，不可把测试文件存在当成通过。

### 11.3 Definition of Done

> 下方对照针对**本轮已交付的 A + B**。未勾选项一律是真实缺口，不是待办口气的占位。

- [x] 用户入口可用，常见路径无多余强制步骤，空/错误/取消/繁忙状态完整。
      → A：结果条仅在成功回执后出现，取消不产生条；B：尺寸面板默认隐藏，不增加强制步骤。
- [x] 数据与 IPC 校验、窗口所有权、异步竞争、错误恢复都覆盖实际行为测试。
      → 跨窗口伪造 → `invalid-owner`；过期 → `result-expired`；窗口销毁 → `revokeOwner`；
        B 的写入路径严格校验、读取路径归一化丢弃。
- [x] 新文档格式与旧记录兼容；保存重开、撤销、复制/导出/贴图语义一致。
      → A/B **不引入新文档格式**；旧 store 缺 `regionPreferences`/`lastByMode`/`presets` 均合法。
- [x] 无未使用设置、无未接线按钮；支持现有界面语言，更新必要说明。
      → 新增键均在三语表且有 `check-i18n` 双向校验（无死键、无漏标记）。
- [ ] 缓存、任务、文件、窗口与监听生命周期有界；性能与实机证据满足已冻结预算。
      → 生命周期有界（50 条/15 分钟/无常驻定时器）；**性能样本未采集、实机矩阵未跑**。
- [ ] 相关门禁通过；CI/安装包/设备验证分别列出，未完成项不能报完成。
      → 本地 `npm test` 1602/1602 与 `npm run check` 通过；**CI、安装包、设备验证未完成**。
- [x] 独立提交与交接记录完整，发布范围只包含实际已验收能力。
      → 两份交接文档已建；**未创建 git 提交**（工作区其他改造归属未定，按 §11.1 不擅自提交）。

## 12. 关键工程入口

下列均为现有文件（A/B 交付后已存在）。C/D/E 的"拟新增"文件尚不存在。

| 领域 | 入口 |
|---|---|
| 分析与既有契约 | [功能分析](F:/workspace/Highlighter/docs/plans/2026-10-25-snow-apps-feature-recommendations.md)、[历史编辑契约](F:/workspace/Highlighter/docs/plans/2026-10-25-history-reedit-batch0-contracts.md) |
| 文档模型/提交 | [capture-document.js](F:/workspace/Highlighter/shared/capture-document.js)、[capture-document-service.js](F:/workspace/Highlighter/main/services/capture-document-service.js) |
| 截图交互/域 | [capture.js](F:/workspace/Highlighter/capture/capture.js)、[capture domain](F:/workspace/Highlighter/main/domains/capture/index.js) |
| 导出/识别 | [image-file-save.js](F:/workspace/Highlighter/main/services/image-file-save.js)、[recognition domain](F:/workspace/Highlighter/main/domains/recognition/index.js)、[pdf-export.js](F:/workspace/Highlighter/main/services/pdf-export.js) |
| **A：结果登记与动作** | [export-result-service.js](F:/workspace/Highlighter/main/services/export-result-service.js)、[export-ipc.js](F:/workspace/Highlighter/main/ipc/export-ipc.js)、[export-action-controller.js](F:/workspace/Highlighter/main/ipc/export-action-controller.js)、[export-result-bar.js](F:/workspace/Highlighter/capture/export-result-bar.js) |
| **B：区域与预设** | [region-presets.js](F:/workspace/Highlighter/shared/region-presets.js)、[region-preferences.js](F:/workspace/Highlighter/main/services/region-preferences.js)、[region-ipc.js](F:/workspace/Highlighter/main/ipc/region-ipc.js)、[region-ipc-controller.js](F:/workspace/Highlighter/main/ipc/region-ipc-controller.js) |
| **A/B 装配** | [feature-services-bootstrap.js](F:/workspace/Highlighter/main/services/feature-services-bootstrap.js)、[window-actions.js](F:/workspace/Highlighter/main/services/window-actions.js) |
| 区域/设置 | [capture-geometry.js](F:/workspace/Highlighter/main/services/capture-geometry.js)、[settings-defaults.js](F:/workspace/Highlighter/main/services/settings-defaults.js)、[settings-validation.js](F:/workspace/Highlighter/main/services/settings-validation.js) |
| 录屏 | [recording-service.js](F:/workspace/Highlighter/main/services/recording-service.js)、[recording-utils.js](F:/workspace/Highlighter/record/recording-utils.js)、[record domain](F:/workspace/Highlighter/main/domains/record/index.js) |
| IPC/迁移/资源 | [ipc-security.js](F:/workspace/Highlighter/main/services/ipc-security.js)、[data-root-migration.js](F:/workspace/Highlighter/main/services/data-root-migration.js)、[performance-monitor.js](F:/workspace/Highlighter/main/services/performance-monitor.js) |

---

## 13. 本轮交付的验证与发布状态

**本地门禁（2026-10-25 实测）**

| 门禁 | 命令 | 结果 |
|---|---|---|
| 单元/集成测试 | `npm test` | 1602 / 1602 pass，0 fail |
| 静态检查 | `npm run check` | exit 0（js 421 files / architecture 1316 ≤ 1330 / i18n 585 = 基线） |
| 覆盖率（主进程） | `npm run test:coverage:loaded` | 92.03% lines ≥ 85% |
| 覆盖率（关键服务） | `npm run test:coverage:critical` | 93.46% lines ≥ 90% |
| 真实 Electron 探针 | `test/diagnostics-runtime.test.js`、`test/capture-document-editor-runtime.test.js` | pass |

**按方案 §10.3 要求分别记账，不得合并**：

| 项 | 状态 |
|---|---|
| 本地通过 | ✅ 见上表 |
| CI 通过 | ⬜ 未验证（未推送、未触发） |
| 安装包通过 | ✅ **4.1.5 已构建并验证**（见 §13.1）；静默安装到系统**未验证** |
| 实机通过（副屏 / 混合 DPI / 默认应用 / 观感） | ⬜ 未验证 |

唯一一次 `npm test` 失败来自 `test/clipboard-coordination.test.js` 的已知 lease flake，
按根 AGENTS 单独重跑两次均 4/4 通过，判定为 flake，非本轮 diff 引入。

### 13.1 安装包构建记录（4.1.5）

**版本决策**：`dist/` 原有一个 13:49 构建的 `Highlighter-Setup-4.1.4.exe`（**早于 A/B 功能**）。
为不覆盖也无法区分旧产物，版本升到 **4.1.5**（`package.json` + `package-lock.json` 同步，
`npm run check:version` 通过）。

**构建方式**：`electron-builder --config electron-builder.local-fuses.cjs --win --x64 --publish never`

这是仓库文档 §1 指定的"本机能构建的最接近发布的产物"口径 —— 继承 release 配置、有 fuses
硬化、只关掉 `forceCodeSigning`（开发机无证书）。**首次误用了日常配置
（`--win nsis`），产物 fuse 校验 6 项失败**；已按 `electron-builder.local-fuses.cjs` 重建。

**产物**：

| 文件 | 大小 | 说明 |
|---|---:|---|
| `dist/Highlighter-Setup-4.1.5.exe` | 149,856,841 B | NSIS 安装包 |
| `dist/Highlighter-4.1.5-portable.exe` | 149,569,410 B | 便携版 |
| `dist/Highlighter-Setup-4.1.5.exe.blockmap` | — | 增量更新块 |
| `dist/latest.yml` | — | version/size/sha512 与实际产物一致（已交叉核对） |
| `dist/SHA256SUMS.txt` | — | 4 项，已按 4.1.5 重新生成 |

**发布门禁（`scripts/verify-release.ps1 -DistDir dist -SkipSbom`，exit 0）**：

```json
{"version":"4.1.5","signed":false,"setup":"Highlighter-Setup-4.1.5.exe",
 "portable":"Highlighter-4.1.5-portable.exe","manifests":["latest.yml"],
 "checksums":"SHA256SUMS.txt"}
```

- `Electron fuses verified: RunAsNode=off, EnableCookieEncryption=on,
  EnableNodeOptionsEnvironmentVariable=off, EnableNodeCliInspectArguments=off,
  EnableEmbeddedAsarIntegrityValidation=on, OnlyLoadAppFromAsar=on,
  LoadBrowserProcessSpecificV8Snapshot=off, GrantFileProtocolExtraPrivileges=on` —— 8/8
- `Packaged Electron startup verified: Highlighter.exe`
- `Packaged Electron startup verified: Highlighter-4.1.5-portable.exe`

**A/B 代码确实在产物里**（不是只看文件名）：解包
`dist/win-unpacked/resources/app.asar` 后确认 `EXPORT_ACTIONS`（3 处）、
`MAX_PRESETS`（5 处）、`createExportResultBar`（3 处）均存在；
`main/packaged-entry.js` 入口就位。

**未做 / 未验证**：

- **静默安装到系统未验证**：`scripts/verify-release.ps1` 的安装步骤被跳过（`-SkipSbom`
  只跳过 SBOM）。完整 `verify:package` 需要实际安装到系统，会替换用户机器上正在运行的
  4.1.4，本机未执行。用户机上的 `D:\Program Files\Highlighter` **仍是 4.1.4，且应用正在运行**，
  本批次**未触碰**。
- **代码签名未验证**：`signed: false` —— 开发机无证书，属预期。
- **SBOM 未重建**：`-SkipSbom`，`dist/sbom.cdx.json` 仍是 4.1.4 时期的。发布前必须重建。
- 原生二进制（SmartSelect / OCR / Everything / clipboard / selection-hook）复用 2026-10-17
  的既有产物：本批次**没有**改动任何 `native/` 源码，因此未重跑 `build:native`
  （那会先 `stop:app` 停掉用户正在运行的应用）。
- 4.1.4 的旧产物仍在 `dist/` 里（未删除，避免误删用户可能要的东西）。
