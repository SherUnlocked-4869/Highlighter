# main.js 源码文本断言盘点

- 日期：2026-09-10
- 分支：`feat/v2.3-architecture-debt`
- 关联：`docs/plans/2026-09-10-v2.3-architecture-roadmap.md` Phase A
- 统计方式：`rg -n "match\(main" --glob "*.js" test`
- 计数：**138** 处 `assert.match(main, …)` / `assert.doesNotMatch(main, …)`（`ipc-module-contracts` 的循环断言按 1 计）

## 1. 按测试文件

| 文件 | 条数 | 域 | 置换优先级 |
|---|---:|---|---|
| `data-root-ui-contract.test.js` | 28 | 数据目录 / 启动引导 | 中（迁移纪律敏感，先保留） |
| `capture-ocr-pin-ui.test.js` | 18 | 截图 UI + **pin** + OCR 贴图 | **高（pin 纯函数可抽）** |
| `selection-toolbar-resilience.test.js` | 13 | 划词钩子 / 流会话 | 中 |
| `game-mode-contract.test.js` | 12 | 游戏模式副作用 | 中 |
| `recording-ui-contract.test.js` | 11 | 录屏 | 中 |
| `update-ui-contract.test.js` | 8 | 更新服务懒加载 | 中 |
| `selection-toolbar-settings.test.js` | 8 | 划词设置 | 中 |
| `history-management-ui.test.js` | 6 | 历史 IPC | 低 |
| `model-config-ui-contract.test.js` | 6 | AI 模型配置 | 低 |
| `diagnostics-ui-contract.test.js` | 6 | 诊断 / crashReporter | 低 |
| `shortcut-ui-contract.test.js` | 4 | 快捷键 | 低 |
| `selection-toolbar-theme.test.js` | 4 | 外观广播 | 低 |
| `selection-toolbar-thinking.test.js` | 4 | AI thinking | 低 |
| `capture-init-handshake.test.js` | 3 | 截图初始化握手 | 低 |
| `capture-performance-contract.test.js` | 3 | 截图热路径 | 低 |
| `e2e-contract.test.js` | 2 | E2E 引导 | 低 |
| `ipc-module-contracts.test.js` | 1 | IPC 模块边界 | **保留（防回潮）** |
| `window-security.test.js` | 1 | 窗口安全 | **保留（红线）** |

## 2. 按域分组与置换策略

### 2.1 可立刻抽纯函数并单测（第一批）

| 断言位置 | 意图 | 策略 |
|---|---|---|
| `capture-ocr-pin-ui.test.js:57-64` | `getPixelAlignedPinSize` / zoom 钳制 | 抽到 `main/domains/pin/geometry.js`，改为真实单测 |
| `capture-ocr-pin-ui.test.js:35` | 无 `pin:set-opacity` 通道 | 保留文本断言（IPC 面契约，成本低） |
| `capture-ocr-pin-ui.test.js:36-37` | 透明度菜单结构 | 保留（Electron Menu 结构，E2E 过重） |

### 2.2 需行为契约 / 注入 fake（第二批）

| 域 | 涉及文件 | 策略 |
|---|---|---|
| pin 窗口生命周期 | `capture-ocr-pin-ui` | Phase B1 迁出时一并做 contract |
| 游戏模式扇出 | `game-mode-contract` | settings effects 表（Phase B6）后改为订阅契约 |
| 划词钩子 / 流 | `selection-toolbar-*` | 依赖已 DI 的 hook/stream，补 spy 测试后删文本 |
| 录屏 | `recording-ui-contract` | Phase B4 迁出时置换 |
| 更新懒加载 | `update-ui-contract` | 已较薄，可在 domain 迁出时合并 |

### 2.3 建议长期保留（低成本、高信号）

- `ipc-module-contracts.test.js`：禁止 main 直接 `ipcMain.handle('pin:…')` 等前缀
- `window-security.test.js`：`createLocalWindow` 必须走 `createSecureWindow`
- 各域「通道不存在」的 `doesNotMatch`（如 `pin:set-opacity`）

### 2.4 暂缓（迁移风险高）

- `data-root-ui-contract`（28 条）：数据目录 / 迁移 / quiesce 顺序，必须与 Phase B 后的装配代码同步设计，不可单独删。

## 3. 目标进度

| 阶段 | 目标条数 | 实际 | 说明 |
|---|---:|---:|---|
| 基线 | 138 | 138 | 本盘点 |
| A2 完成后 | ≤ 130 | **135** | pin 纯函数 → `test/pin-geometry.test.js`（−4 文本 +1 require 断言） |
| Phase B 全部完成 | ≤ 80 | — | 路线图门禁 |

## 4. 规则（防回潮）

1. 新增功能 **禁止** 对 `main.js` 使用 `assert.match` 源码文本断言。
2. 必须断言行为时：抽纯函数单测，或对 `main/domains/<domain>` 模块断言。
3. 例外仅限：IPC 前缀禁令、安全红线、通道 `doesNotMatch`。
