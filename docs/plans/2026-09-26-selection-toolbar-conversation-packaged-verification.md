# 打包件真机验证报告：划词结果窗口的多轮对话（含第 4、5 步修复）

- 日期：2026-09-26
- 分支：`feature/selection-toolbar-conversation` @ `ae56e2d`（第 4、5 步）+ `5be6bb5`（文档）
- 上游报告：`docs/plans/2026-09-26-selection-toolbar-conversation-verification.md`（开发模式验证）
- 驱动方式：**Computer Use（CUA）驱动真实鼠标与键盘**；只有"初始划词"这一步用 OS 级真实拖选/拖拽完成，
  不是注入 `selection:text`
- 结论：**打包件 + 真实划词链路 + 真实键盘的核心链路已验证通过**；4 项因 CUA 能力边界未能验证，
  逐项列出原因与替代覆盖

---

## 1. 构建与安装

| 步骤 | 结果 |
|---|---|
| `npm run build:win` | **第一次失败**：makensis 报 `Can't open output file` → `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`，留下一个 290,605 B 的残件。清掉残件重跑即成功 → `dist/Highlighter-Setup-2.2.7.exe` **144,611,294 B** |
| 静默安装 | `Highlighter-Setup-2.2.7.exe /S` |
| 安装结果 | **就地升级** `D:\Program Files\Highlighter`：`Highlighter.exe` 2.2.6 → **2.2.7**，卸载项变为「Highlighter 2.2.7」，**未**新建 per-user 副本 |

## 2. 安装产物核验

| 项 | 结果 |
|---|---|
| `resources/app.asar` | 13,349,622 B（2026/9/26 19:15:18） |
| 新模块是否在包内 | ✓ `asar list` 含 `\main\services\action-conversation.js` |
| 新代码是否在包内 | ✓ 二进制内含 `reportCancelledTurn` ×5、`显示划词对话` ×1、`showActionWindow` ×2、`getActionWindow` ×3 |
| 数字签名 | `NotSigned`（本次构建的是 `npm run build:win` 基础配置，非 `verify:release` 那条线） |
| 打包入口 | **实测为 `main.js`**：带 `--highlighter-packaged-startup-probe` 启动后进程未退出，说明 release 配置的 `extraMetadata.main = main/packaged-entry.js` 与那套 fuses **不在**本产物内 |

## 3. 启动核验（真实数据根）

启动后读应用自身日志（`E:\document\highlighter\logs\app.log`）：

```
version: "2.2.7"   e2e: false
Selection hook started: startup
Everything sidecar ready / OCR ready ppocr-v4-ch
```

`e2e:false` 说明这不是 E2E 模式（打包件里该模式恒不生效），原生 selection hook 真的拉起来了。
整个验证期间应用始终存活（pid 2396，19:17:54 启动，验证结束时仍在），无崩溃、无 WER 报告、无 crash dump。

## 4. 已验证

### P1 真实划词 → 工具栏 → 结果窗口（含定位）

1. 在 Chrome 中用**真实鼠标拖拽**选中两段英文（Chrome 先被移到副屏，符合工作区约定）。
2. 应用日志：`Selection event diagnostic: {"reason":"shown","programName":"chrome.exe","textLength":323}`
   —— 323 = 两段原文 320 字符 + 2 个换行，**整段选区被完整读到**。
3. 工具栏窗口出现于选区下方：`bounds=[3840,278,530,56]`，a11y 树 5 个按钮
   （跳转/搜索/复制/解释/翻译）齐全，截图为真实浮动条。
4. 点击「译 翻译」→ 结果窗口「划词助手」出现在工具栏正下方 `bounds=[3840,338,475,676]`，
   渲染出头部（翻译 + 徽标 + 置顶）、原文、**真实供应商返回的两段中文译文**、底部输入区。

> dev 模式验证时这两处都是盲区：`lastToolbarPosition` 为 null 导致 `positionActionWindow` 从未生效、
> hook 整条链路被绕过。本次是真机真实路径。

### P2 真实键盘追问 + 上下文正确

- 真实点击输入框 → 真实 Ctrl+V → 真实 **Enter** 发送。第一次粘贴因 CUA 的剪贴板竞态粘进了旧内容
  （提示条里出现「Computer Use。」，属工具问题，非应用问题），改用 `setValue` + 真实 Enter 重发。
- 提问「原文第二段说的是什么？用中文一句话概括。」
- 回答：「原文第二段主要说明：旧系统（基于短语的统计机器翻译）虽然逐句翻译时语法正确，
  但会丢失句子之间的语篇连贯性（即上下文衔接）。」
- **该回答只可能来自锚点（原文 + 首轮结果），证明打包件中追问轮确实带上了首轮上下文。**
- 转录区同时显示用户气泡与助手回答，多轮结构正常；输入框按设计在发送后清空。
- 截图已落盘：`test-results/realdevice-pkg/02-followup-context.png`

### P3（部分）隐藏后的窗口可被重新显示

- 真实点击 Chrome → 结果窗口失焦 → 隐藏。用 Win32 `IsWindowVisible` 确认该窗口**确实隐藏**
  （不是被遮挡），会话仍在进程内。
- 随后新的划词动作使**同一个窗口**重新出现并按新选区重新定位（`[3840,338]` → `[2033,369]`），
  说明 `getOrCreateActionWindow()` / `show()` 这条路径在打包件上工作 —— 托盘项调用的正是
  `showActionWindow()`（同一个 `show()+focus()`）。

## 5. 未能验证（逐项原因）

1. **托盘菜单项「显示划词对话」的端到端点击**。本 CUA 构建**无法枚举或截图系统通知区域**：
   `list_windows(explorer)` 只返回 11 个非任务栏窗口（无任务栏尺寸窗口），且本构建的
   `computer.*` 工具集里**没有** `screenshot_display`（只有 target/list_apps/list_windows/
   get_app_state/left_click/scroll/left_click_drag/type/set_value/select_text/key/
   perform_action/paste/request_access/stop）。CUA 规则明确禁止对无法观测的 shell UI 猜测坐标点击，
   故未做。已覆盖：菜单模板单元测试（visible/enabled/label/回调）+ 管理器 `showActionWindow()` 实现
   + `main.js` 装配（均已提交）。
2. **首轮流式中断的界面表现（第 4 步修复）**。隐藏窗口被 CUA 直接拒绝观测
   （`capture_app: Windows UI Automation returned no tree ... no visible top-level window`），
   而重新显示它的唯一用户路径又是托盘（见第 1 条），故在打包件上无法观察该提示。已覆盖：
   `reportCancelledTurn` 的单元测试（含 5 种取消原因的分流）、两轮共用同一函数、
   以及该函数确实在打包 asar 内。
3. **停止按钮 / 追问 10 轮上限 / 仅翻译模型禁用 / D4 覆盖的视觉确认**。
   这四项在开发模式已逐项验证（S5/S7/S4/S8）；打包件上被下面的"遮挡"问题挡住，未重复。
4. **release 打包线**（fuses、`main/packaged-entry.js` 入口、代码签名）—— 见第 7 步，仍未验证。

## 6. 过程中踩到的两个测试环境陷阱（值得记录）

1. **遮挡会让 Electron 窗口停止绘制**：结果窗口落在与最大化 Chrome 同一块屏幕时被完全遮住，
   Chromium 不再出帧 —— CUA 截图全黑、a11y 树停在最后一次绘制状态（我一度误读为"新会话没生效"）。
   正确做法是把覆盖窗口移到另一块屏再截图（P1/P2 的截图就是这么拿到的）。
2. **`logSelectionDiagnosticOnce` 每个原因每会话只记一次**：我一度据"日志里没有新的 shown"判断
   钩子失效，实际是诊断被去重。判断钩子是否触发应看**工具栏窗口是否出现**，而不是看日志。

## 7. 与开发模式验证的覆盖差异（本次真正新增）

| 项 | 开发模式 | 打包件（本次） |
|---|---|---|
| 打包入口 / asar 布局 | ✗ | ✓ 新模块在包内；入口实测为 `main.js` |
| 原生 selection hook → 工具栏 | ✗（注入 `selection:text`） | ✓ 真实拖选，323 字符，工具栏出现在选区旁 |
| `positionActionWindow` 按选区定位 | ✗（`lastToolbarPosition` 为 null） | ✓ 两次均定位到选区下方 |
| OS 级鼠标 / 键盘 | ✗（DOM 事件） | ✓ 真实点击 / Ctrl+V / Enter（一次剪贴板竞态除外） |
| 真实数据根（真实设置与密钥） | ✗（临时副本） | ✓ `E:\document\highlighter` |
| 安全面（净化、CSP） | ✓（探针 + 单测） | —（未重复） |

## 8. 遗留

- 用户 Chrome 里多了一个测试标签页（`file:///C:/Users/MSN/AppData/Local/Temp/hl-verify/text.html`），
  临时文件仍在 `%TEMP%\hl-verify\`，建议手动关闭/删除；Chrome 窗口位置已还原为初始的主屏最大化。
- 打包件日志里的 `Shortcut registration failed` 自 2.2.5 起既存，与本次改动无关。
- 托盘项与首轮中断的端到端确认，需要人工点一次托盘，或换一个能截整块显示器的 CUA 构建。
- release 打包线（fuses / `packaged-entry.js` / 签名）仍未验证 = 第 7 步。
- 复现细节：本会话 `ZCODE_CUA_PLUGIN_ROOT` 未注入，CUA 客户端需从
  `.../zcode-plugins-official/computer-use/0.6.3/scripts/computer-use-client.mjs` 显式导入。
