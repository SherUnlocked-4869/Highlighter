# 剪贴板历史：文件列表（V2）设计

日期：2026-10-27（Asia/Hong_Kong）

状态：实施中。本文是 2026-10-17 [剪贴板开发落地文档](2026-10-17-clipboard-implementation-plan.md)
§2.1 "V2 格式增强：文件路径列表" 的落地契约。

## 1. 触发与问题

用户在资源管理器里 Ctrl+C / 右键复制一个图片文件（或任意文件）后，剪贴板历史中
找不到该记录。根因是 V1 的显式边界：

- `native/clipboard/src/capture.rs` 在隐私标记之后、读取任何正文之前检查 `CF_HDROP`
  （格式 15），命中即 `Skip::Unsupported`；
- `items.kind` 的 CHECK 约束只有 `text/url/image`；`copy`/`paste` 也只发布
  `CF_UNICODETEXT`、PNG、DIB。

该边界的原因仍然成立：文件复制不是位图，资源管理器在文件复制时可能附带预览图标类
位图，不能把它记成"图片"；也不能为了"复制一个图片文件"去擅自读取整份文件内容。

本次交付 V2 的第一项：**把文件复制记录成独立的 `files` 条目，只保存路径列表，
不读取文件内容**；复制/粘贴回写 `CF_HDROP`，因此可以贴回资源管理器、聊天应用等
接受文件的目标。

## 2. 范围

包含：

- 原生采集 `CF_HDROP`（宽字符列表），有界校验后生成 `files` 快照；
- 存储 schema v2（`kind` CHECK 增加 `files`），v1 → v2 迁移保留全部既有记录；
- 历史面板的"文件"筛选、徽标、行预览、文件数元信息；
- 设置项"记录复制的文件（仅保存路径）"，默认开启；
- 复制与主动粘贴：发布 `CF_HDROP` + `Preferred DropEffect = DROPEFFECT_COPY`；
- 单元测试、迁移测试、UI 契约与 i18n 测试。

不包含（保持 V1 行为）：

- 不读取、解码或校验文件内容（包括图片文件）；不解引用符号链接/外壳项；
- 不记录文件拖放（只记录剪贴板复制）；
- 不发布 `CF_UNICODETEXT` 路径副本（避免向文本框粘贴时输出路径）；
- 不新增缩略图（文件条目没有缩略图；面板不为 `files` 请求 `thumbnail`）；
- 不实现 HTML/RTF、OLE 私有格式。

## 3. 契约

### 3.1 原生采集（`capture.rs` / `limits.rs`）

优先级（隐私标记与来源排除保持第一）：

1. 隐私标记 / 排除应用 / 来源无法识别而配置了排除 → 跳过（不变）；
2. `CF_HDROP` 存在 → 文件列表分支：
   - `rules.captureFiles == false` → `Skip::Unsupported`（与当前行为一致）；
   - 否则有界复制并校验，成功返回 `kind = "files"`；
3. `CF_UNICODETEXT` → 文本；
4. PNG / DIBV5 / DIB → 图片。

`CF_HDROP` 结构：`DROPFILES`（20 字节：`pFiles u32` / `pt.x i32` / `pt.y i32` /
`fNC i32` / `fWide i32`），随后 `fWide != 0` 时为 UTF-16LE、路径以 NUL 分隔、
双 NUL 结束。只支持宽字符列表；`fWide == 0` 的 ANSI 列表记 `Unsupported`
（现代资源管理器与主流应用均为宽字符，ANSI 属遗留路径，不在本次范围）。

限制（`limits.rs` 常量，命名可调整但数值不可放宽）：

| 常量 | 值 | 语义 |
|---|---|---|
| `MAX_FILES` | 64 | 单条记录最多文件数 |
| `MAX_HDROP_BYTES` | 65536 | `CF_HDROP` 全局内存上限（复制前检查） |
| `MAX_FILE_PATH_CHARS` | 8192 | 单条路径 UTF-16 code unit 上限 |

路径校验（采集、存储、写回三处共用一个校验函数，建议放 `limits.rs`）：

- 非空，无 `\0`，无 `< 0x20` 控制字符，无孤立代理项（`String::from_utf16` 失败即拒绝）；
- 绝对路径：`[A-Za-z]:\` / `[A-Za-z]:/`，或 `\\server\share...`（含 `\\?\` 长路径形式）；
  拒绝相对路径、`\\.\` 设备路径；
- 大小写不敏感去重，保留首次出现的原始大小写与顺序；
- 任一路径不合法 → **整条记录跳过**（绝不截断或只保存部分路径，否则粘贴语义错误）；
- 空列表 → `Skip::Unsupported`；超过 `MAX_FILES` / 原始字节超限 → `Skip::Oversized`。

快照：`kind = "files"`，`bytes = UTF-8`，内容为路径以 `\n` 连接；`width/height = None`。
`capture.rs` 里"文件复制不是位图"的注释要改成现状说明（不再声称 V1 整次跳过）。

### 3.2 原生规则与能力

- `storage::Rules` 增加 `capture_files: bool`（serde camelCase `captureFiles`，默认 true；
  `validate()` 不需要新范围检查）。
- `listener.rs` 调用 `read_snapshot_with_rules(sequence, capture_text, capture_images,
  capture_files, &excluded_apps)`。
- `initialize` 的 `capabilities` 增加 `"fileList": true`（父进程目前不校验，仅作版本说明）。

### 3.3 存储（`storage.rs`）

- `payloads`：`text_body` 保存路径列表（LF 连接），`mime` =
  `application/x-highlighter-files;charset=utf-8`，`byte_length` = UTF-8 字节数，
  `width = height = 0`，没有附件文件、没有缩略图。
- `items.kind = "files"`；`preview` = 首个路径的 basename（最后一个 `\` 或 `/`
  之后的部分；退化情况取完整路径，`chars().take(255)`）。
- `accept("files", bytes, source)`：UTF-8 解码 → 按 `\n` 切分 → 用 3.1 的校验函数
  再次校验（防协议绕过）→ 去重 → body。`capture_files == false` 时返回 `"unsupported"`。
- 去重：payload hash 沿用现有 `mime + bytes` 规则，同一路径列表再次复制只更新
  `copy_count/last_copied_at/sort_at`。
- FTS `item_search.text` = 路径列表（可按文件名/目录搜索）。
- `list`：`kind` 白名单增加 `"files"`；返回 JSON 增加 `"fileCount"`，用
  `text_body` 的换行数计算（`CASE WHEN i.kind='files' THEN 1 + length(p.text_body) -
  length(replace(p.text_body, char(10), '')) ELSE 0 END`，NULL 时 0）。
- `detail`：返回 `text` = 路径列表（沿用 64 KiB 截断）、`kind = "files"`。
- `payload(id, false)`：返回 files mime + body 字节；`payload(id, true)`（缩略图）→
  `UNSUPPORTED`（现有 `text_body` 分支已满足，勿为 files 生成缩略图）。

### 3.4 Schema v2 与迁移

- 新增 `native/clipboard/src/schema-v2.sql`：当前完整 schema，`kind CHECK` 为
  `('text','url','image','files')`，其余表/索引/FTS 不变。
- `Store::open`：`PRAGMA user_version`，`> 2` → `SCHEMA_TOO_NEW`；`0` → 直接建 v2
  schema 并写 `user_version=2`；`1` → 单事务迁移到 v2（SQLite 不能修改 CHECK，需要
  重建 `items` 表：新表 → 复制全部行 → 删除旧表 → 改名 → 重建两个索引），提交后
  `user_version=2`。迁移必须保留 `id/payload_id/kind/preview/source/created_at/
  last_copied_at/last_used_at/sort_at/is_pinned/pinned_order/copy_count/use_count`。
- 迁移测试：用 v1 schema 建库并写入文本/图片记录（含置顶），`Store::open` 后行数、
  字段、FTS、复制记录都在，且随后可 `accept("files", ...)`；迁移后的 `sqlite_master`
  DDL 与新装 v2 库一致（可用规范化字符串对比，防止两套 DDL 漂移）。

### 3.5 复制 / 主动粘贴（`writer.rs`、`paste.rs`）

- `writer::copy` 按 mime 分支增加 files：把 body 按 `\n` 切回路径，生成
  `DROPFILES` 字节（`pFiles=20`、`pt=0`、`fNC=0`、`fWide=1`，随后 UTF-16LE 路径
  逐个 NUL 结束，最后再加一个 NUL），用现有 `Global::generate` 分配，发布：
  - `CF_HDROP`（格式 15）；
  - 注册格式 `Preferred DropEffect`，4 字节 LE `DROPEFFECT_COPY = 1`。
- `verify_formats` 的派生格式分支：files 允许 `[15]`；注册格式已由 signature 校验覆盖。
- `paste.rs` 不需要格式特判：`paste.prepare` 发布 files 后走既有目标校验与单次
  Ctrl+V 注入；`copy` 按钮同样复用 `copy_item`。路径在写回前用 3.1 的校验函数
  再校验，不合法返回 `UNSUPPORTED`，不发布半份列表。

### 3.6 设置（JS）

- `DEFAULT_CLIPBOARD` 增加 `captureFiles: true`；`assertClipboardSettings` 要求布尔；
  `nativeRules` 自动透传（现有实现已把 `enabled/paused/releaseAfterMs` 之外的字段全部下发）。
- `normalizeClipboardSettings` 必须先兜底默认值再断言，避免旧存储缺少 `captureFiles`
  时整块 clipboard 设置被重置（那会关掉用户已启用的功能）。未知字段行为不变。
- 设置页 `config/routes/clipboard.js` 的布尔字段增加
  `['captureFiles', 'clipboard.capture-files']`。

### 3.7 面板（`clipboard/clipboard.js|html|css`、`shared/locales/clipboard.js`）

- 类型筛选 chips 顺序：全部 / 文本 / 链接 / 图片 / 文件（`data-kind="files"`）。
- `KIND_BADGE.files = 'FIL'`（保持三字母单色戳记）。
- `files` 是文本型行（不是缩略图网格）：`clipboard-layout.js` 无需改动（非 `image`
  一律按行布局），但测试要固化这点。
- 行 meta 在 `fileCount > 1` 时显示 `clipboard.file-count`；`previewText` 显示首个文件名。
- 详情沿用文本视图（每行一个完整路径）；"查看全文"对 `files` 可见（非 image 即可）。
- 不为 `files` 请求缩略图（现有按 `kind === 'image'` 的门控保持不变）。
- 新 i18n 键（三个语言文件同步）：
  - `clipboard.files`：文件 / Files / 檔案
  - `clipboard.capture-files`：记录复制的文件（仅保存路径） / Record copied files (paths only) / 記錄複製的檔案（僅儲存路徑）
  - `clipboard.file-count`：`{count} 个文件` / `{count} files` / `{count} 個檔案`
- 更新 `clipboard.description` / `clipboard.privacy` / `clipboard.search`，明确
  "文件复制只保存路径、不读取文件内容"，搜索也可搜文件名。

## 4. 测试与验收

原生（`cargo test`，全部在非交互环境）：

- `DROPFILES` 解析：正常两条、偏移、缺双 NUL、`fWide=0`、相对路径、设备路径、
  控制字符、>64 项、超长、大小写重复、空列表；
- 编码：`encode_dropfiles` 头字段/长度/双 NUL，与解析互逆；非法输入拒绝；
- 存储：files `accept` / list 过滤 / fileCount / detail / payload 往返 / 去重计数 /
  搜索命中文件名 / `captureFiles=false` 拒绝 / 非法路径拒绝；
- 迁移：v1 库种子数据迁移保留、可写 files、迁移 DDL 与新装 v2 一致；
- `cargo clippy --locked --manifest-path native/clipboard/Cargo.toml --all-targets -- -D warnings`。

JS（`node --test`）：

- `test/clipboard-ui-contract.test.js`：kind chips 含 `files`、KIND_BADGE、设置页字段；
- `test/clipboard-grid-layout.test.js`：`files` 按文本行布局（与 image 混排不改变既有几何）；
- `settings` 相关测试：旧存储缺 `captureFiles` 不重置其它字段；`nativeRules` 透传；
- `node scripts/check-i18n.js --max 606`、`node scripts/check-js.js`、
  `node scripts/check-architecture.js`。

真机（本机为受限自动化宿主，无法在不污染用户剪贴板的前提下验证）：复制资源管理器
文件 → 历史出现文件条目 → "复制"后可在资源管理器粘贴 → 主动粘贴到资源管理器/聊天
输入框。构建后由用户手工验收，不得在自动化里写入交互式剪贴板。

## 5. 隐私与边界

- 只保存路径字符串，不读文件、不解引用链接、不访问网络位置内容；与 V1 一样只在
  本机数据目录保存，排除应用/暂停/保留期/容量上限全部继续生效。
- 路径本身可能包含敏感名称；设置页文案必须说明"仅保存路径"。
- 文件被移动/删除后，历史仍保存原路径；粘贴回写的是同一路径（与原复制语义一致），
  不尝试修复或读取文件。
