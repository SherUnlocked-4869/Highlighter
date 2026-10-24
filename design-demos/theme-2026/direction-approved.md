# direction-approved.md

> 这道 gate 在用户选定方向**之后**写。当前状态：**已选定**。

## 用户的选择

> **「我选B1方向」** —— 2026-10-24

选定 **B1 · 浮层优先 FILM**（`dir-2.html`）。没有混搭，是完整选定。

## 已展示的内容（选定前）

- 评审台：`design-demos/theme-2026/index.html`
- 三张完整版整页截图：`shots/index-tab0.png`、`index-tab1.png`、`index-tab2.png`
- 只截主窗口的图：`shots/dir-{1,2,3}-win-{light,dark}.png`
- 六格缩略图（含三个未选中的备选）：`shots/thumbs.png`
- 六张方向卡：`directions.md`（单页版 `cards/`）
- **真实产品窗口里的三个方向**：`shots/landing/`（30 张，见下）
- 参考板：`refs/cleanshot-home.png`、`refs/things-home.png`、`refs/SOURCES.md`

## 展示的三个方向

| 文件 | 方向 | 材料 | 骨架 | 默认明暗 | 来源 |
|---|---|---|---|---|---|
| `dir-1.html` | A1 哑光器物 | 阳极氧化冷银 + 细砂 | 设备面板 | 亮 | 深泽直人 / without thought |
| **`dir-2.html`** | **B1 浮层优先（已选）** | **暖中性磨砂玻璃** | **无边框窗口 + 浮面高度 z0–z3** | **亮** | **CleanShot X** |
| `dir-3.html` | C2 珐琅铭牌 | 暖棕珐琅 + 黄铜装裱 | 铭牌拼贴 + 左上单光源 | 暗 | 香港街招（只取刻字与牌面） |

## 选定前的落地验证

选定之前，三个方向都先在**真实 Electron 渲染器**里跑过一遍
（`tools/landing-preview.js`，真实窗口、真实安全配置 `contextIsolation:true + sandbox:true`、
真实配置页路由、真实截图浮层/划词条/剪贴板）：**三个方向各 10/10 表面通过，0 处新增低对比度文字**。

这一步不是走过场，它决定了 B1 落地时不需要返工：调色、圆角、阴影配方都已经是验证过的值。

## 未选中的三个备选（留档）

- A2 一体成型（Apple unibody / 倒角高光）
- B2 原生精修（Things 3 / 纯排版）
- C1 斜切流光（秒数轮盘 14 号 / 刻意过头，用来标边界）

## 落地状态

B1 已落进产品（详见 `TOKENS-PLAN.md` §6）：`shared/tokens.css`、`main/services/window-backdrop.js`、
`main/services/settings-defaults.js`、`config/config.css`、`toolbar/toolbar.html`、
`clipboard/clipboard.css`（注释）、`config/routes/usage.js`（注释）。
`npm test` 1361/1361，`npm run check` 通过，全部 44 个窗口表面真实渲染无报错。

### 2026-10-24 晚 · 主窗口不透明化（第一次落地后的返修）

第一版落地把主设置窗做成了**透明窗口 + 磨砂玻璃**（`transparent:true`、页面自绘阴影、
`MAIN_WINDOW_FRAME_INSET` / `--win-frame-inset` / `--win-shadow`、主窗不进 backdrop 注册表）。
用户连续否了两次：

> "有点太透了，反而影响页面内容的识别。我想要的其实是磨砂的那种质感"
> "磨砂的质感还是太透了，算了，你把磨砂也去掉吧。和你的设计稿 HTML，主界面保持一致"

结论是**主设置窗不透明**，和设计稿 `#appWin` 的观感一致（它在画出来的桌面上 alpha .93，看起来本来就是实心的）：

- `main.js`：主窗 `transparent`/`hasShadow` 撤掉，恢复 `backgroundColor: windowBackdropColor(...)`，
  回到 `trackWindowBackdrop(win)` 的注册表，尺寸回到 1120×760（不再外扩）。
- `config/config.css`：页面自绘 `--bg`、`.window-shell{position:absolute;inset:0;background:var(--bg)}`，
  保留窗内光晕与玻璃台阶（`--glass-*` 仍在**不透明底**上分层，`backdrop-filter` 模糊的是窗内长阶而不是桌面）。
- 删除脚手架：`MAIN_WINDOW_FRAME_INSET`、`--win-frame-inset`、`--win-shadow`；
  `test/window-backdrop.test.js` 里 5 条守护透明窗口的断言反向改为守护不透明契约。
- 浮层窗口不受影响：划词条等仍是 `transparent:true` 的真实玻璃（`--glass-3` + 窗内没有可模糊内容时退回半透明底面）。

验收：`npm test` 1369/1370（唯一失败是已知的租约 flake，单独跑 4/4，连跑两次都过）、
`npm run check` 通过、44 个真实窗口表面 0 console error / 无横向溢出、`verify-release.ps1` 全部通过。

## 什么**没有**做（如实记录）

- **A1 / C2 没有删**：`dir-1.html`、`dir-3.html` 与它们的方向卡原样留在 `design-demos/theme-2026/`。
  它们是这轮设计过程的证据，也是将来换风格时的备选。没有一行产品代码引用它们。
- **没有迁移用户已存的 `borderRadius`**：老安装保持原值（用户动过滑块，那是他的选择），
  只有全新安装拿到 B1 的 13px。`mainColor` 的历史蓝迁移逻辑继续有效，未动。
- **没有重做动效**：`--dur-*` / `--ease-*` 已在 token 层就位，但各窗口仍使用自己的 `.13s`–`.22s`。
  逐窗替换是下一步，不在本轮范围内。
