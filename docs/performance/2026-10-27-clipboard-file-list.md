# 剪贴板历史：文件列表（V2）执行记录

日期：2026-10-27（Asia/Hong_Kong）

基准：`926e4c9`（master）；本轮改动作为独立提交落地（`feat(clipboard): record copied files as path-only history entries`）。

设计契约：[2026-10-27 文件列表设计](../plans/2026-10-27-clipboard-file-list-design.md)。

## 1. 触发与根因

用户报告：在资源管理器 Ctrl+C / 右键复制图片文件后，剪贴板历史里找不到。

根因是 V1 的显式能力边界，不是回归：

- `native/clipboard/src/capture.rs` 在隐私标记之后、读取正文之前检查 `CF_HDROP`（格式 15），
  命中即 `Skip::Unsupported`（原注释："File lists are outside the G0 capability"）；
- `items.kind` 的 CHECK 只有 `text/url/image`，复制/粘贴也只发布文本 / PNG / DIB；
- 设置与 README 都只承诺"文本、链接、静态图片"。

该边界原意仍要保留：文件复制不是位图（资源管理器可能附带预览图标位图），不能记成图片；
也不能因为复制了一个图片文件就去读取文件内容。因此本次把文件复制做成独立的 `files`
记录：**只保存路径列表，不读取文件内容**，复制/粘贴回写 `CF_HDROP`。

## 2. 交付

### 2.1 原生（Rust，`native/clipboard`）

| 文件 | 内容 |
|---|---|
| `src/limits.rs` | 纯函数 `parse_dropfiles` / `encode_dropfiles` / `decode_file_list` / `validate_file_path(s)` / `file_preview`；常量 `MAX_FILES=64`、`MAX_HDROP_BYTES=65536`、`MAX_FILE_PATH_CHARS=8192`、`FILES_MIME` |
| `src/capture.rs` | 隐私标记/排除应用之后 `CF_HDROP` 优先于 text/image；`captureFiles=false` → `Skip::Unsupported`；关闭剪贴板后再解析，`kind="files"`、LF 连接路径 |
| `src/storage.rs` | `Rules.capture_files`（camelCase `captureFiles`，默认 true，旧父进程缺字段也可用）；`accept("files")` 二次校验/去重/preview/body；`list` 接受 `files` 并返回 `fileCount`；detail/payload 复用 text_body；v0→v2 建库、v1→v2 单事务迁移、>2 → `SCHEMA_TOO_NEW` |
| `src/schema-v2.sql` | 新 schema：`kind CHECK IN ('text','url','image','files')`，其余同 v1 |
| `src/writer.rs` | `files` mime → 生成 `DROPFILES`，发布 `CF_HDROP(15)` + `Preferred DropEffect = DROPEFFECT_COPY`；`verify_formats` 派生格式允许 15 |
| `src/listener.rs` / `src/main.rs` | 传入 `capture_files`；`initialize.capabilities.fileList=true` |
| `tests/files_storage.rs`（新） | 7 项：往返、fileCount 过滤、去重 copy_count、开关、非法列表拒绝、搜索、Rules 默认 |
| `tests/schema_migration.rs`（新） | v1 种子（text/url/image/置顶+FTS+附件）迁移完整、可写 files、迁移 DDL 与新装 v2 规范化一致、>2 拒绝 |
| `tests/isolated_capture.rs` | `#[ignore]` 私有 Window Station 用例语义更新：非法 DROPFILES 仍 skip；合法宽列表 → `files` 且优先于文本；开关关闭时不采集 |

迁移实现：单事务内 `删索引 → items 改名 items_v1 → 按 v2 原文建新 items → 复制全部行 → 删 items_v1 → 重建索引 → user_version=2`；
SQLite 不能修改 CHECK，所以必须重建表。测试强制两套 DDL 规范化后逐 token 一致，防止 `schema-v2.sql` 与迁移 SQL 漂移。

### 2.2 JS / 面板 / 设置

| 文件 | 内容 |
|---|---|
| `main/services/clipboard-settings.js` | `captureFiles:true` 默认；布尔校验；`normalizeClipboardSettings` 先按默认键集补缺/丢弃未知键再断言（旧存储不重置其它字段，未知键不会触发原生 `deny_unknown_fields`）；`nativeRules` 透传 |
| `main/ipc/clipboard-ipc.js` | `list` 的 kind 白名单加入 `files` |
| `config/routes/clipboard.js` | 设置页布尔项"记录复制的文件（仅保存路径）" |
| `clipboard/clipboard.html` | 第 5 个类型 chip：全部 / 文本 / 链接 / 图片 / 文件 |
| `clipboard/clipboard.js` | `KIND_BADGE.files='FIL'`；`fileCount>1` 时行 meta 显示 `clipboard.file-count`；files 走文本行/文本详情、不请求缩略图、过滤值透传 |
| `shared/locales/clipboard.js` | 三语补 `files` / `capture-files` / `file-count`；description/privacy/search 明确"只存路径、不读内容、可搜文件名" |
| `test/clipboard-ui-contract.test.js` | chips/徽标/fileCount/IPC 白名单/设置字段/三语文案断言 |
| `test/clipboard-grid-layout.test.js` | files 与 text/image 混排按文本行布局，且与等价 text 列表几何完全一致 |
| `test/settings-normalize.test.js` | 旧存储缺 `captureFiles` 保留全部其它字段 + 未知键丢弃；`nativeRules` 透传与剥离 |

## 3. 验证证据（Lead 在本机复跑）

| 门禁 | 结果 |
|---|---|
| `cargo test --locked --manifest-path native/clipboard/Cargo.toml` | 绿：19 unit + 7 `files_storage` + 2 `schema_migration` + 既有集成用例；3 个既有 ignored |
| `cargo clippy --locked --all-targets -- -D warnings` | 绿 |
| `node scripts/build-clipboard-native.js`（经 MSVC 环境） | 成功；`nativeBuildId = hl_34cf714e6e2bd7dead6ed34fad6b15f80eed55cb48a81747e52ee09d36951b84`，与当前源码哈希一致；`bin/build-info.json` 已更新 |
| `node --test test/clipboard-*.test.js` | 98/98 通过（含真实 Electron 的 `clipboard-grid-runtime`） |
| `node scripts/test-selection-clipboard-native.js`（MSVC 环境） | 通过：`Clipboard restore policy: 100 interleaving rounds and native input checks passed`（本次未改 selection addon，作环境/门禁回归确认） |
| `npm run check` | 绿：447 个 JS 语法通过；architecture main.js 1329/1330；i18n 三语各 1466 键、symmetric ok、296 used / 0 missing、TOTAL 592（--max 606） |
| 全量 `npm test` | 见下方 §3.1 |

构建/测试环境提示（本机）：`cargo` 需要 MSVC（`vcvars64.bat`），`cl.exe` 需要可写 `TMP/TEMP`；
但给 **npm run-script 本身**覆盖 `TMP/TEMP` 会让本机 npm 100% CPU 挂起，因此全量测试用
仓库外 spawn hook 只给 Electron 子进程注入 `--no-sandbox` 和 `TMP/TEMP`（`.tmp-lead/spawn-hook.js`，不提交）。

### 3.1 全量 npm test

本机 npm 11.17 在 `TMP/TEMP` 被覆盖时会给 `npm run-script` 自身 100% CPU 挂起（空项目可复现），
所以按 `package.json` 的同一入口绕开 npm、直接跑测试运行器（`npm test` 等价于
`node --test test/*.test.js`），并保留 AGENTS.md 要求的四个环境修正：

```bash
env -u ELECTRON_RUN_AS_NODE \
  TMP="D:/workspace/Highlighter/.tmp-lead/tmp" \
  TEMP="D:/workspace/Highlighter/.tmp-lead/tmp" \
  HIGHLIGHTER_E2E_DATA_ROOT_BASE="D:/workspace/Highlighter/.tmp-lead/t" \
  NODE_OPTIONS="--require D:/workspace/Highlighter/.tmp-lead/spawn-hook.js" \
  node --test test/*.test.js
#   → ℹ tests 1833   ℹ pass 1833   ℹ fail 0   duration ≈ 32.6 s
```

对比基线（2026-10-26 handoff 记录 1829 例）新增 4 例：UI 契约 1、grid layout 1、
settings normalize 2。本次运行已知的 clipboard lease 100 轮 flake 未出现。
spawn hook 是仓库外/临时文件：给 Electron 子进程注入 `--no-sandbox` 与仓库内
`TMP/TEMP`（AGENTS.md 陷阱 1/2/3），不提交。

提交前在同一工作树复跑：`1833/1833 pass`、`npm run check` 绿、cargo test/clippy 绿。
其中一次复跑出现 `1832/1833`：唯一失败是 `test/usage-query.test.js` 的
`summary p95 103.21ms > 100ms` 预算用例，属 handoff §1.2 记录的负载型假失败
（当时同机在并行编译 sqlite）；单独重跑该文件 20/20 通过，与本次剪贴板改动无关。

## 4. 未验证项与边界

- **真实剪贴板端到端未验证**：本机受限宿主无法创建私有 Window Station（历史 `CreateWindowStationW`
  返回 `E_ACCESSDENIED`），且不能在自动化里读写用户交互式剪贴板。以下需人工验收：
  1. 资源管理器复制 1 个图片文件 → 面板出现 `FIL` 记录（预览为文件名）；
  2. 多选复制 → 行 meta 显示"N 个文件"，详情每行一个完整路径；
  3. 面板"复制"后到资源管理器 Ctrl+V，文件被复制一份；
  4. 选中记录"粘贴"到资源管理器/微信等接受文件的目标；目标不支持时按现有降级提示；
  5. 关闭"记录复制的文件"开关后再复制文件 → 不产生新记录。
- `writer` 的 files 发布分支只经过编译/clippy + DROPFILES 编解码互逆单测，未在真实剪贴板上
  执行 `verify_formats`（现有 publication 用例同样是 ignored，需要私有 station）。
- 已知边界（设计里固定）：>64 个文件、DROPFILES 原始全局内存 >64 KiB、ANSI（`fWide=0`）列表、
  相对路径、`\\.\` 设备路径、`\\?\Volume{...}` 形式一律整条跳过（不截断、不部分保存）。
- 文件在使用历史记录前被移动/删除时，粘贴回写的是原路径（与原复制语义一致），不尝试修复。
- README 的剪贴板截图（`docs/images/clipboard.png`）仍是无"文件"筛选的旧图，属可选的后续截图刷新。
