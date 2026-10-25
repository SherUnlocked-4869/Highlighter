# R0 前置收口记录（A/B 批次入口）

> 上级方案：[2026-10-25 snow 功能增补开发文档](F:/workspace/Highlighter/docs/plans/2026-10-25-snow-apps-feature-development-plan.md)（下称"方案"）§2 R0。
> 本文件是方案 §2 R0.1–R0.5 的**证据记录**，不是新契约。契约仍以
> [历史编辑契约](F:/workspace/Highlighter/docs/plans/2026-10-25-history-reedit-batch0-contracts.md)（下称"契约"）为准。
>
> 日期：2026-10-25（Asia/Hong_Kong）
> 状态：R0.1–R0.4 已核对；R0.5 记录本轮实际执行的门禁。**未跑项一律标"未验证"**。

---

## R0.1 状态核对

| 项 | 实测值 |
|---|---|
| HEAD commit | `66f333c21ebe3e5fa8f496d2df4d42f7fbb79521`（`chore(design): remove third-party icon binaries from the repository`） |
| 分支 | `master` |
| 工作区版本 | `highlighter-snowshot` `4.1.4` |
| 未提交改动 | 24 个已跟踪文件 + 14 个未跟踪文件（含契约/方案文档与批次 1 新模块） |
| 差异规模 | `git diff --stat`：24 files changed, 1403 insertions(+), 241 deletions(-) |
| Node / Electron | `v24.22.1` / `electron 43.8.3`（`devDependencies`） |
| 主机 | Windows，本机会话（详见 §R0.5 环境变量处理） |

**结论**：方案 §2 描述的"包含未提交的历史编辑改造"仍然成立，本轮开发必须在其之上
增量叠加，不得覆盖或回退。批次 0 + 批次 1 的产物（`shared/capture-document.js`、
`main/services/capture-document-service.js`、`shared/editor-layout.js` 及 5 个新测试文件）
均在未跟踪列表里，属于**既有工作**。

### 文档服务实际实现范围（已读码确认，非仅按文档声称）

`main/services/capture-document-service.js`（1090 行）已实现：
`commit`（create/update/save-copy）、幂等回执表、`expectedRevisionId` 冲突、
per-document 串行锁、原子索引发布 + 备份恢复、保留裁剪、
`resolveCommittedResult`、`loadDocument`（含降级）、`documentStats`、`deleteDocumentFiles`。

`shared/capture-document.js`（797 行）已实现：`schemaVersion=1`、
`coordinateSpace:'source-pixel'`、字段/标注类型白名单、16 MiB 字节守卫、
点数预算、`crop` 整数与边界校验、内容指纹、视口正逆变换、标注投影/逆投影、
`MIGRATIONS` 迁移表（当前为空，v1 是唯一版本）。

---

## R0.2 文档闭环验收

| 场景 | 证据 | 状态 |
|---|---|---|
| 新截图建档 / 历史更新 / 另存 / 冲突 | `test/capture-document-service.test.js`（25 例，含 `committed/unchanged/conflict/failed`、幂等、原子索引回滚） | ✅ 通过 |
| 取消导出 | `test/image-file-save.test.js`（null 返回 = 未写盘） | ✅ 通过 |
| 失败重试 / 删除后提交 | 服务层 `deleted` / `retryable` 分支用例 | ✅ 通过 |
| 关闭协商 / dirty | `test/capture-document-editor-runtime.test.js`（真 Electron：clean 文档关窗不弹协商） | ✅ 通过 |
| 旧 PNG 兼容 | `test/capture-document.test.js`（旧图惰性升级、`readLegacyBase`） | ✅ 通过 |
| 不重复创建历史记录 | 服务层 `unchanged` 不增版 + 幂等回执 | ✅ 通过 |

本轮实测（2026-10-25，本机）：

```
node --test test/capture-document.test.js \
             test/capture-document-service.test.js \
             test/capture-annotation-geometry.test.js \
             test/image-file-save.test.js \
             test/settings-validation.test.js \
             test/settings-normalize.test.js
→ tests 138 / pass 138 / fail 0
```

真实 Electron（非纯 Node）：

```
node --test test/capture-document-editor-runtime.test.js
→ ✔ a real Electron history editor restores the document, commits on Ctrl+S and closes clean
→ tests 1 / pass 1 / fail 0
```

---

## R0.3 生命周期

| 要求 | 现状 | 状态 |
|---|---|---|
| head / 旧版本 / 底图保留删除关系 | `capture-document-service.deleteDocumentFiles` + `historyRevisionLimit`（默认 20，至少保留 head） | ✅ 实现存在，用例覆盖保留裁剪 |
| 对外出口只用成品、不用底图顶替 | `resolveCommittedResult` 是唯一对外入口；`loadDocument` 的降级信号区分 `legacy-bitmap`/`editable-v1`/`bitmap-only` | ✅ |
| 数据根目录迁移含新布局 | **未实现**。`data-root-migration.js` 目前只重写 `filePath`/`thumbnailPath`，不处理 `documents/<id>/base|assets|revisions` | ❌ **未验证/未做**（契约 §15.5 已列明） |
| 孤儿清理识别新布局 | **未实现**。`isOwnedHistoryFile` 只认旧 PNG 命名 | ❌ **未验证/未做** |

**结论**：R0.3 的"保留/删除/迁移关系"只完成了文档层，**磁盘布局层未闭环**。
本批次（A/B）不新增持久资产、不改历史目录布局，因此不阻塞 A/B；
但 **C（成品预设）与 D（放大镜）落新资产前必须先补这两项**，不能吞进 A/B 的完成标准。

---

## R0.4 遮挡输入（契约 §8 识别隐私遮罩）

| 要求 | 现状 |
|---|---|
| 所有识别入口统一走专用识别合成函数（crop 底图 → 不透明遮罩 → 再缩放） | **未实现** |
| highlight 不视为遮密工具 | 未实现（当前无区分） |
| 显示透明度预览不解除保护 | 未实现 |
| 测试在模型/侧车调用边界截获像素 | 未实现（现有测试不断言遮罩像素） |

核对方式：`grep` 全部识别入口（`capture:ocr`/`capture:translate`/`capture:table`/`capture:qr`/
`capture:convert-image` 与 recognition 域），没有任何一处对 blur 对象做遮罩合成；
识别路径直接消费渲染层上传的像素。

**结论**：契约 §8 仍是**独立 P0 未完成项**。它在方案里是"最迟在 D 开始前交付"的前置，
**不算放大镜附赠行为**。本批次（A/B）不触碰识别输入，不阻塞；
但 D 的前置条件必须显式登记，不能以"放大镜自带"糊过去。

- [ ] 登记为独立修复任务（归属：批次 2/4，方案 §2 R0.4 要求）
- [ ] 该任务交付前，任何"识别不会读到被遮挡内容"的说法都不成立

---

## R0.5 基准与门禁（本轮实际执行）

### 执行环境（按根 AGENTS 排除四个陷阱）

```bash
env -u ELECTRON_RUN_AS_NODE \
  TMP="F:/workspace/Highlighter/.tmp-test" \
  TEMP="F:/workspace/Highlighter/.tmp-test" \
  HIGHLIGHTER_E2E_DATA_ROOT_BASE="F:/workspace/Highlighter/.tmp-test" \
  <command>
```

四个陷阱均按 AGENTS 处理：清除 `ELECTRON_RUN_AS_NODE`；`--no-sandbox` 放在脚本之前
（本批次未跑自定义探针）；TMP/TEMP 与 E2E 数据根落在仓库 `.tmp-test/`；
本批次未跑 `npm audit`。

### 结果

> 下表是 **R0 开始时（开发前）** 的基线。A/B 完成后的最终数字见
> [A 交接](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-A-handoff.md) §4 与
> [B 交接](F:/workspace/Highlighter/docs/plans/2026-10-25-feature-B-handoff.md) §4。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 单元/集成测试 | `npm test` | **1460 pass / 1 fail / 1461 total**，见下方"已知失败" |
| 静态检查 | `npm run check` | **exit 0**：`check:js` 405 files OK；`check:architecture` main.js 1329 ≤ 1330；`check:i18n` TOTAL 585（= HEAD 基线，余量 21/606） |
| 文档编辑器真机（本机 Electron） | `node --test test/capture-document-editor-runtime.test.js` | **pass** |
| 覆盖率 / E2E / 长截图 / fuses | — | **未验证**（本批次未跑；不由单测推断） |
| 安装包 / 实机副屏矩阵 | — | **未验证**（需真实桌面会话，不属于本批次） |

### 已知失败（归因明确，非本轮回归）

`test/clipboard-coordination.test.js` → "native addon authenticates leases, finishes 100 rounds
and rejects bad credentials"，本轮失败于 `Lease round 49`。
这是根 AGENTS 已记录的**已知 flake**（原生 lease 同步往返在负载下偶发错过窗口），
与任何源码改动无关。按 AGENTS 处理：先单独重跑两次再判断，不通过放宽断言"修"它。

### CI 状态

`gh run list --limit 5`：HEAD `66f333c` 的 `Windows CI`（run `40100354103`）为 **success**，
上一条 `8a8a32f`（`40098013021`）success。
注意根 AGENTS 的口径：**本地通过、CI 通过、安装包通过、实机通过分别记账**，
本文件只登记前两项，后两项在本批次一律"未验证"。

### 本轮结论

- 基线是**可继续开发的**：1461 例里只有 1 例已知 flake 失败，`npm run check` 全绿。
- 阻塞 A/B 的唯一硬约束是 `main.js` 1330 行上限（实测 1329），A/B 的装配行必须
  先腾出空间 —— 已登记为独立任务（提取纯装配块到模块，**不提高上限**）。
- 契约 §8（识别遮罩）与契约 §9（新布局迁移/孤儿清理）是**后续批次的前置**，
  不属本批次，且不得在交接记录里写成"已完成"。

---

## 附：R0 出口条件核对

| 方案 §2 R0 要求 | 状态 |
|---|---|
| R0.1 记录 commit / 未提交改动 / 服务实现范围 / 测试来源 | ✅ 本文 §R0.1 |
| R0.2 验证建档、更新、另存、取消、重试、冲突、删除、关闭、旧图 | ✅ 本文 §R0.2（138 + 1 例实测） |
| R0.3 验证 head / 旧版 / 底图保留删除迁移 | ⚠️ 文档层 ✅，**磁盘布局迁移/孤儿清理 ❌ 未做**，已登记 |
| R0.4 核对契约 §8 识别遮罩是否落地 | ✅ 已核对，结论：**未落地**，登记为独立 P0 |
| R0.5 记录基线性能、测试结果、已知失败、CI | ✅ 本文 §R0.5（性能样本本批次未采，标未验证） |
