# R0 宿主合同与跨语言夹具格式（草案 v1）

日期：2026-11-10。状态：**R0 实施规格草案；G0 前可修改，冻结后升版 schemaVersion**。

上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md)（下称"计划"）§3.1、§4、§5.1、§9.1、§10，以及[可行性调研](../../research/2026-11-10-rust-migration-feasibility.md)。本文件只规定 R0-02/R0-06 的机器可读产物格式和校验方式，不构成对现有 Electron 实现的修改依据。

## 1. 目的与边界

1. 把计划 §4.1 的 13 个页面角色/API、`IPC_SURFACES` 权限面、错误码、§9.1 的硬限制和 §5.1 的存储 schema 版本冻结成**机器可读清单**，供 Rust 侧消费与双端对照。
2. 用**现有 JS 实现**生成合成夹具（synthetic fixtures），Rust 测试读取同一批夹具，证明合同与行为对齐；不复制用户数据，不读取真实凭据。
3. 清单和夹具都是 R0 证据，不是生产协议。生产协议的冻结由 R1 的角色能力登记和 R2 的存储合同接手。

非目标：

- 不生成 TypeScript 类型定义，也不以 `serde` 类型取代运行时校验（计划 §4.2）。
- 不包含计划 §4.2 的**拟新增内部接口**（`WindowHost`、`CaptureBackend` 等）；那些由 Rust crate 定义，本目录只登记现有外部表面。
- 不修改 `main/`、`preload*.js`、`shared/` 的生产行为。发现实现与计划不一致时写进差异清单，不改旧代码。

## 2. 产出文件与所有权

| 路径 | 内容 | 生成/校验 |
|---|---|---|
| `contracts/host/host-contracts.json` | 角色/API/通道/错误码/资源限制/schema 版本 | `node scripts/rust/extract-host-contracts.js --check` |
| `contracts/host/README.md` | 本格式的消费说明（简短） | 文档 |
| `test/fixtures/host-parity/manifest.json` | 夹具索引 + 每个 case 的 sha256 | `node scripts/rust/generate-host-fixtures.js --check` |
| `test/fixtures/host-parity/<group>/<case>.json` | 合成夹具 case | 同上 |
| `scripts/rust/extract-host-contracts.js` | 从现有源码提取清单；`--write` / `--check` | 直接运行 |
| `scripts/rust/generate-host-fixtures.js` | 调用现有 JS 模块生成夹具；`--write` / `--check` | 直接运行 |
| `test/host-contracts.test.js` | Node 测试：清单完整性、夹具可再现、限制值不漂移 | `node --test test/host-contracts.test.js` |

两个生成脚本都必须满足：

- 从仓库根目录运行，无网络、无 Electron、无真实用户数据；`require` 现有共享模块或使用 `vm` 桩模拟 `electron` 只读导入。
- `--write` 写入确定性内容；`--check` 与磁盘内容逐字节比较，不一致时打印差异摘要并以非零码退出。不写时间戳、绝对路径、主机名、随机 ID。
- 输出 UTF-8、LF、2 空格缩进、对象键按插入顺序固定、数组按稳定键排序，文件以单个换行结尾。
- 发现无法自动解析的方法/常量时，写入 `knownGaps` 数组（含原因和源码位置），不得静默丢弃。

## 3. `host-contracts.json` 结构

```jsonc
{
  "schemaVersion": 1,
  "kind": "highlighter.host-contracts",
  "status": "r0-draft",
  "baseline": {
    "appVersion": "4.2.0",              // package.json version
    "gitCommit": "3df7129...",          // 计划声明的源码基线；提取时以 git rev-parse HEAD 记录实际值并打印提示
    "electron": "43.8.3",
    "node": "24.22.1"
  },
  "roles": [
    {
      "role": "main",
      "page": "config/config.html",
      "preload": "preload.js",
      "globalObject": "electronAPI",
      "methods": [
        {
          "name": "getSettings",
          "kind": "invoke",             // invoke | send | subscribe
          "channel": "settings:get",
          "call": "( )",                // 从 preload 源码记录，参数名可省略
          "returns": "Promise<unknown>",// invoke=Promise，send=void，subscribe=退订函数
          "source": "preload.js:11",
          "tests": []                   // 现有测试相对路径；没有就空数组，不得编造
        }
      ],
      "surface": {
        "handles": ["settings:get"],
        "listeners": []
      },
      "knownGaps": []                   // 无法解析的 preload 方法/权限差异
    }
  ],
  "errorCodes": [
    {
      "code": "window-owner-mismatch",
      "source": "main/services/ipc-security.js",
      "direction": "deny",
      "meaning": "调用窗口不是该通道登记的所属窗口"
    }
  ],
  "resourceLimits": [
    {
      "id": "clipboard.protocol",
      "value": { "maxFrameBytes": 1048576, "maxHeaderBytes": 524288, "maxPayloadChunkBytes": 262144 },
      "source": "shared/clipboard-protocol.js",
      "symbols": ["MAX_FRAME", "MAX_HEADER", "MAX_CHUNK"]
    }
  ],
  "sharedSchemas": [
    {
      "document": "capture-document",
      "path": "shared/capture-document.js",
      "version": 3,
      "versionSymbol": "SCHEMA_VERSION",
      "tests": ["test/capture-document.test.js"]
    }
  ]
}
```

提取规则：

1. `roles`：来自 `require('./main/services/ipc-security').IPC_SURFACES`（13 个，按 role 排序）与 `preload*.js` 中 `contextBridge.exposeInMainWorld('<global>', {...})` 的并集。`preload`/`globalObject` 的映射由页面路径和文件命名确定，必须逐项核对，不猜。**补查临时打印窗口、辅助窗口等 IPC_SURFACES 之外暴露的 preload**（计划 R0-02）。
2. `methods`：以 `vm` 桩模拟 `electron`，真实执行每个 preload，调用暴露对象上的每个方法并记录 `ipcRenderer.invoke/send/on` 的 channel；无法执行的记录到 `knownGaps`。`kind` 由实际调用方式判定。
3. `surface`：直接记录 `IPC_SURFACES` 的 `handles`/`listeners`。一致性规则（测试执行）：每个 `kind=invoke` 的 channel 必须在该 role 的 `handles` 中，每个 `kind=send` 的 channel 必须在该 role 的 `listeners` 中；`subscribe` 的 channel（main→renderer 推送）不要求登记，但要在 `surface.receives` 中列出。这条规则用于 R1-04 的命令权限映射。
4. `errorCodes`：从 `main/services/ipc-security.js` 的 deny 分支和 `main/services/window-security.js` 提取字符串码，记录源码位置；重复码合并。
5. `resourceLimits`：计划 §9.1 的 8 项全部登记，值以源码常量为准；测试要能回读源码常量核对（防止 JS 改了清单没改）。未能 import 的模块用静态常量提取并记录 `symbols`。
6. `sharedSchemas`：计划 §5.1 的对象（截图 v3、录屏 v1、剪贴板 DB v2、用量 DB v1、数据根 marker v3、settings normalize）逐项登记版本与证据文件。SQLite 版本从 SQL/常量文本提取，记录 `user_version`。

## 4. 夹具清单与 case 格式

`test/fixtures/host-parity/manifest.json`：

```json
{
  "schemaVersion": 1,
  "generator": "scripts/rust/generate-host-fixtures.js",
  "groups": [
    {
      "id": "clipboard-protocol",
      "format": "clipboard-protocol.v1",
      "generatedFrom": ["shared/clipboard-protocol.js"],
      "cases": [
        { "id": "single-frame", "file": "clipboard-protocol/single-frame.json", "sha256": "…" }
      ]
    }
  ]
}
```

`sha256` 覆盖 case 文件的完整字节。case 文件统一外壳：

```json
{
  "schemaVersion": 1,
  "caseId": "<group>/<id>",
  "format": "clipboard-protocol.v1",
  "source": ["shared/clipboard-protocol.js"],
  "expect": "valid"
}
```

`expect` 取 `valid` 或 `invalid`；invalid 用例必须给出 `reason`（机器码，供 Rust 断言）。各 group 的附加字段：

### 4.1 `capture-document`（format `capture-document.v3`）

```json
{
  "document": { /* shared/capture-document.js 产出的 v3 文档，字段完整 */ },
  "invariants": {
    "schemaVersion": 3,
    "documentId": "fixture-doc-001",
    "revision": 1,
    "sourceWidth": 800,
    "sourceHeight": 600,
    "outputWidth": 800,
    "outputHeight": 600
  }
}
```

至少 3 个 case：全新 v3 有效文档、旧版本载入升级后的 v3、`expect=invalid` 的未知 schemaVersion 或缺失身份。生成时用固定 ID/时间/尺寸，不得出现本机路径。`outputStyle` 的边距/阴影成品尺寸要与当前 v3 几何规则一致（计划 §5.1）。

### 4.2 `recording-project`（format `recording-project.v1`）

```json
{
  "project": { /* shared/recording-project-schema.js 产出的 v1 项目 */ },
  "invariants": { "schemaVersion": 1, "projectId": "fixture-project-001", "keepRanges": [[0, 1000], [2000, 2500]] }
}
```

至少 3 个 case：正常项目、空 `keepRanges`（整段）、损坏/缺字段的 invalid 项目。毫秒半开区间语义不变（计划 §5.1）。

### 4.3 `clipboard-protocol`（format `clipboard-protocol.v1`）

```json
{
  "kind": "valid",                       // valid | invalid
  "chunks": ["<base64 原始字节，按顺序喂给 decoder>"],
  "expectedFrames": [
    { "header": { "type": "hello" }, "payloadBase64": "" }
  ],
  "expectedError": null                  // invalid: "invalid-frame"
}
```

至少覆盖：单帧无 payload、单帧带 payload、跨 chunk 分片、一次 feed 多帧、`finish()` 截断、非法 `kind`、`headerBytes > MAX_HEADER`、`payloadBytes > MAX_CHUNK`、`size < 5`、`size > MAX_FRAME`、header 非 JSON 对象。JSON 字符串 key 顺序不稳定时，`expectedFrames.header` 由生成脚本按实际解析结果规范化写出。

### 4.4 `recording-export-options`（format `recording-export-options.v1`）

```json
{
  "kind": "limits",
  "expectedLimits": {
    "queue": { "maxConcurrentEncodes": 1, "maxPending": 2 },
    "gif": { "maxDurationMs": 60000, "maxLongEdge": 1280, "maxFrames": 1200, "fps": [10, 15, 20] },
    "segments": { "maxSegments": 20, "minSegmentMs": 100 }
  }
}
```

值从 `shared/recording-export-options.js` 提取；另可包含 `kind: "normalize"` 的输入/期望输出 case（如 GIF 参数裁剪）。

### 4.5 `settings`（format `settings.normalize.v1`，可选）

仅在 settings normalize 模块可无 Electron 加载时生成；否则在 manifest 中省略该 group 并在差异清单登记原因。

## 5. Rust 侧消费约定

- `rust-app/crates/contracts` 读取 `contracts/host/host-contracts.json` 和夹具，只解析 `serde_json`，不依赖 Node。
- `rust-app/crates/service-host` 用 `clipboard-protocol` group 做解码一致性测试（有效帧逐字段相等，无效帧必须报同一种错误）。
- 其他 crate 按需读取对应 group；**不得复制夹具内容到 Rust 源码作为第二份真相**。
- 测试失败信息必须指出 case id 与字段。夹具暂缺的 group 用 `#[ignore]` 或显式 skip 并在报告中登记，不得伪造通过。

## 6. 校验命令（本分支 CI 入口）

```bash
node scripts/rust/extract-host-contracts.js --check
node scripts/rust/generate-host-fixtures.js --check
node --test test/host-contracts.test.js
cargo test --manifest-path rust-app/Cargo.toml --locked
```

`test/host-contracts.test.js` 必须覆盖：清单对 13 个角色和每个 preload 暴露对象无遗漏；通道权限一致性；§9.1 八项限制存在且回读源码一致；manifest 中每个 case 的 sha256 正确；两个 `--check` 入口返回 0。测试不依赖网络和 Electron。

## 7. 差异与限制登记

实现后写 `docs/plans/rust-migration/host-contract-inventory.md`，至少包含：

- 从源码提取的 13 角色/API 清单与计划 §4.1 表格的差异（计划列的方法数 vs 实际暴露方法数）。
- `IPC_SURFACES` 之外仍暴露的 preload/窗口（如存在）。
- 无法自动解析而登记为 `knownGaps` 的项及原因。
- 未生成或暂缺的夹具 group 及原因（如 settings 依赖 Electron）。
- 与计划 §4.1 "13 个角色"说法不一致之处。

以上内容只陈述证据，不改旧代码，也不把 R0 草案当生产合同。
