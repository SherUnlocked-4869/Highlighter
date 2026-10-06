# 验证报告：划词工具栏与截图工具栏的图标替换

- 日期：2026-10-06
- 分支：`master`（工作区改动，未提交）
- 基线：`4203c85`（`package.json` 2.3.0）
- 设计文档：[2026-10-06-toolbar-icon-replacement-design.md](2026-10-06-toolbar-icon-replacement-design.md)
- 范围：**源码树 + 无头浏览器渲染验证**。未构建安装包、未安装、未运行打包件
- 结论：**设计文档 §6 全部落地；受影响测试 48/48 通过；全量 629 项中 7 项失败，经比对为环境性失败（基线同样失败，见 §4）**

---

## 1. 交付内容

### 1.1 资产（29 个新/改 + 2 个 LICENSE）

| 位置 | 内容 |
| --- | --- |
| `toolbar/icons/` | **新建**：`copy / search / translate / lightbulb / box-arrow-up-right / stars` + `LICENSE` |
| `capture/icons/` | 就地替换 22 个；**新增** `line-tool.svg` + `LICENSE`；`line.svg` 按设计**未改动** |

全部归一化为 `viewBox="0 0 16 16" fill="#000"` 单行格式（`line.svg` 除外，它是刻意保留的例外）。

### 1.2 代码（15 个文件）

| 文件 | 改动 |
| --- | --- |
| `toolbar/toolbar-action-meta.js` | `icon` 由显示符号改为资产名（+ 契约说明） |
| `toolbar/toolbar-utils.js` | 新增 `CUSTOM_ACTION_ICON = 'stars'` 并导出；宽度基数 `42 → 46` |
| `toolbar/toolbar.js` | 按钮改为 `图标 span + 标签 span`；新增资产名白名单与兜底 |
| `toolbar/toolbar.html` | 新增 `.toolbar-icon` mask 规则与 `.label` 省略号规则 |
| `capture/capture.html` | 直线工具改用 `icons/line-tool.svg` |
| `capture/capture.css` | `.toolbar-icon` 18px → 17px |
| `config/config.js` | 自定义功能图标 → `stars`；新增 `toolbarIconMarkup()`；排序列表改用 mask 图标 |
| `config/config.css` | 新增 `.toolbar-order-icon .svg-icon{width:16px;height:16px;color:var(--primary-text)}` |
| `action/action.js` | 删除 `textContent = data.icon` 分支（该窗口 `img-src 'none'`，只能用内联 SVG） |
| `preload-action.js` | `icon` 上界 16 → 64（`box-arrow-up-right` 是 19 字符） |
| `design-demos/tools/capture-electron.js` | 演示注入的图标改为资产名 |
| `scripts/probe-action-security.js` | 探针载荷 `icon: '✦'` → `'stars'` |
| `test/toolbar-icons.test.js` | **新增**契约测试（资产存在性 / 归一化格式 / 渲染路径 / 无孤儿资产） |
| `test/capture-toolbar-icons.test.js` | 期望 `'line'` → `'line-tool'` |
| `test/toolbar-utils.test.js` | 图标期望值；宽度 `100→104`、`343→359`；预算测试改为按实测自然宽 66 校验 |
| `test/selection-toolbar-thinking.test.js` | `open` 图标 → `box-arrow-up-right`，替换过时注释 |

---

## 2. 自动化验证

```
npm run check                  -> Syntax check passed for 229 JavaScript files.
                                  architecture-check: ok (main.js 1298 lines, ceiling 1300, domains 9)
npm test                       -> tests 629 | pass 622 | fail 7（见 §4）
node --test <受影响 7 个文件>   -> tests 48  | pass 48  | fail 0
```

## 3. 渲染验证（无头浏览器跑**真实**的 markup / CSS / 渲染器）

验证脚本 `.tmp/icon-review/verify-render.js`：起一个只监听回环的静态服务器，根指向仓库，
用**虚拟路径** `/capture/__verify.html` 与 `/toolbar/__verify.html` 提供页面，使 `url('icons/…')`
的相对解析与打包后完全一致；`toolbar.js` 是**直接加载的真实文件**，只把 `toolbarAPI` 换成桩。
不向仓库写入任何文件，也不打开任何可见窗口（AGENTS.md）。

| 检查项 | 结果 |
| --- | --- |
| 截图工具栏 23 个图标解析 | **0 个空白**；单个图标最少绘制 **1224** 个不透明像素 |
| 划词工具栏（4 种组合） | **0 个空白**；图标盒保持 **15px**；**无溢出**（`scrollWidth ≤ clientWidth`） |
| 资产名解析 | `icons/copy.svg`、`icons/box-arrow-up-right.svg`、`icons/stars.svg` … 全部命中 |
| 超长自定义名（12 字） | 图标不被挤掉，标签出现省略号（设计预期；改动前是硬裁切、无省略号） |

产物：`.tmp/icon-review/verify-capture-toolbar.png`、`verify-toolbar-{defaults,withOpen,withCustom,longCustomName}.png`、
`verify-config-icons.png`。

设置页（`config/config.js` 的两个 helper 从源码原样抽出求值 + 真实 `config.css`/`tokens.css`）：

- 6 个布局图标全部渲染为 30×30 主色底片 + 16px 主色图标；
- 非法输入 `../etc/passwd`、`C:\windows`、`''` **全部兜底到 `stars`**，白名单生效。

## 4. 7 项失败均为环境性（已验证基线同样失败）

失败项全部是 **spawn Electron 的运行时测试**（`action-security-runtime`、`diagnostics-runtime`、
`electron-runtime`、`model-config-runtime`、`recording-preview-runtime`、`update-rehearsal`、
`window-security-runtime`），报错为 `TypeError: Cannot read properties of undefined (reading 'setPath')`
——即 Electron 以 Node 身份启动。

根因：本会话环境设置了 `ELECTRON_RUN_AS_NODE=1`，测试里 `spawnSync(..., { env: { ...process.env } })`
把它传给了子进程。

**基线比对**（`git stash push -u` 后在 HEAD 上跑同样的两个测试）：

```
✖ Electron loads Node-API modules and resolves packaged native components
✖ every remaining renderer loads under the locked Electron sandbox
ℹ tests 3 | pass 1 | fail 2
```

与带改动时的失败集合一致，故与本次改动无关。**这 7 项在本次未获真机验证。**

## 5. 环境修复

`core.autocrlf=true` 使 `git stash pop` 把工作区重写成 CRLF，一开始让两条新的资产格式断言失败。
断言已改为容忍 `\r?\n`（blob 仍是 LF，应用侧不受影响）。

## 6. 未覆盖 / 待真机确认

1. 上述 7 个 Electron 运行时测试（环境限制）。
2. **真机界面观感**：设计文档 §10.2 的六项人工实测需要在真实应用里各点一遍——本报告只证明了
   相同 markup/CSS/渲染器在浏览器中的渲染结果，未覆盖 Electron 真实窗口的合成、CSP 实际生效
   情况与浅/深色主题切换。
3. 主色按钮上的图标反色（`currentColor = --primary-ink`）在浏览器中已确认，真机同样需一眼确认。
4. 区域截图 → 标注 → 导出链路未跑（本次只改图标资产与工具栏样式，未触碰 `capture.js`）。

---

## 7. 打包与静默安装

### 7.1 构建

```
npm run build:win     -> exit 0
```

即 `prebuild:win`（`stop:app` + smart-select / OCR / Everything 三个原生组件）→
`electron-builder --win nsis --x64`。产物：

| 项 | 值 |
| --- | --- |
| 安装包 | `dist\Highlighter-Setup-2.3.0.exe` |
| 大小 | 144,641,153 字节 |
| 构建时间 | 2026-10-06 21:15:01 |
| SHA256 | `AE9BE4B3F4528EF603F164794F632CDA8FABA173221A6C6287519E680FCE0F9F` |

### 7.2 装包前先验证资产确实进包（读 `dist\win-unpacked\resources\app.asar`）

| 检查 | 结果 |
| --- | --- |
| `toolbar/icons/` 6 个资产在 asar 内 | ✅ |
| `capture/icons/line-tool.svg` 在 asar 内 | ✅ |
| `capture/icons/line.svg` 仍是 48×48 IconPark | ✅ 未被误改 |
| `toolbar/toolbar.js` 用 `--icon` 拼 `icons/<name>.svg` | ✅ |
| `toolbar-action-meta.js` 的 `icon` 全是资产名 | ✅ |
| asar 内已无 `⧉ ⌕ ✦ ⇗` | ✅ |

### 7.3 静默安装

```
Highlighter-Setup-2.3.0.exe /S /D=D:\Program Files\Highlighter      -> INSTALLER_EXIT=0
```

`/D=` 通过 `.cmd` 直写命令行传参（NSIS 要求 `/D=` 必须是最后一个参数且**不能带引号**，
PowerShell 的实参引用会给它加引号，所以绕开）。安装到**原有**位置，未新建重复安装。

| 检查 | 安装前 | 安装后 |
| --- | --- | --- |
| `resources\app.asar` SHA256 | `46D2C59E9EA4B1A6…` | **`E9DE0EFB98C5DD7B…`（与 `dist\win-unpacked` 完全一致）** |
| `Highlighter.exe` SHA256 | `9A29645D1B3EF1F0…` | `07A16CD5BED8B695…` |
| 注册表 `DisplayVersion` | 2.3.0 | 2.3.0（HKCU `513c5e9d-…`，指向 `D:\Program Files\Highlighter`） |
| 误建带引号目录 | — | 无 |
| 安装后自动启动 | — | **未启动**（无可见窗口弹出） |

对**已安装**的 `resources\app.asar` 再读一遍：`toolbar/icons/` 6 个 + `capture/icons/line-tool.svg`
等 10 个资产全部归一化正确，`line.svg` 保持原样，`capture.html` 指向 `line-tool.svg`，
元数据里无残留字符图标。

### 7.4 仍未覆盖

真机**界面观感**仍未确认：本次只证明了"新代码已进入安装目录且文件内容正确"，
没有启动应用去点一遍工具栏（用户未要求启动，安装后也未自动启动）。

