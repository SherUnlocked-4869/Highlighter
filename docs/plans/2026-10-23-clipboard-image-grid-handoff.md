# 剪贴板历史图片缩略图网格 —— 交接文档

- 日期：2026-10-23（Asia/Hong_Kong）
- 分支 / 基线：`master` @ `fd229a2`（版本 4.1.0；Electron 43.8.3 / Node 24.22.1）
- 状态：**代码已完成并通过本机全部门禁；尚未在真机做交互验收，尚未合并/发布。**
- 设计与调研：[2026-10-22-clipboard-image-thumbnail-grid-design.md](./2026-10-22-clipboard-image-thumbnail-grid-design.md)（1147 行，含 §17 实施记录、§18 评审回归修复）
- 上游调研笔记：`.tmp/clipboard-image-grid/t1-render-research.md`、`t2-pipeline-research.md`、`t3-gates-research.md`（`.tmp/` 已 gitignore，**不随提交**）

---

## 1. 一句话交接

> 剪贴板历史里的**图片记录从「64px 文本行」改成「缩略图网格」**，图片格**不带任何可见文案**，**点选不再自动弹出下方详情**（详情改为可关闭的浮层，不再挤压列表）。配套把取图链路从「一次一张、先清后设」改成**批量 `previews(ids)` + 有界令牌 + 并发池 8 + 主进程 LRU**。原生侧零改动。

用户三条需求与落法（详见设计文档 §0.3）：

| 需求 | 实现 |
| --- | --- |
| 图片直接显示缩略图 | 网格化，默认 480 面板 4 列 / 单格 106×92 DIP / 一屏约 16 格，`object-fit: contain` |
| 图片不再有文案 | 格内无任何可见文字，也不加 `title`；信息只进 `aria-label` |
| 移除「点击下方弹详情」 | 选中 = 纯选中、零布局变化；全文改为页脚按钮 / `Space` 打开的可关闭浮层 |

**唯一与字面需求的偏差**（已获用户确认）：保留了「查看全文」入口。删掉它会让文本记录无法在复制前确认全文。

---

## 2. 改动清单（17 个文件）

### 2.1 新增（6）

| 文件 | 作用 | 行数 |
| --- | --- | --- |
| `clipboard/clipboard-layout.js` | 布局纯函数：`layout/rowAt/topOf/clamp/computeColumns/MAX_COLS/SOURCE_EDGE`。UMD，无 DOM、无 i18n | 132 |
| `main/services/clipboard-thumbnail-cache.js` | 缩略图 LRU（8 MiB / 128 条），纯 Node | ~70 |
| `test/clipboard-grid-layout.test.js` | 布局模型 7 组不变量 + 列数公式 5 组 | ~500 |
| `test/clipboard-layout-trim.test.js` | 150 条裁剪锚定 4 个用例（含防漂移守卫） | ~85 |
| `test/clipboard-preview-batch.test.js` | 批量预览协议 20 个用例 | ~440 |
| `docs/plans/2026-10-22-...-design.md` | 设计文档 + 实施记录 + 评审修复记录 | 1147 |

### 2.2 修改（11）

| 文件 | 改动要点 |
| --- | --- |
| `clipboard/clipboard.js` | 242 → ~600 行：读 CSS 几何、布局模型驱动渲染、二维键盘、150 条锚定、rAF 节流、批量取图、缩略图三态、全文浮层、DPR 分档监听 |
| `clipboard/clipboard.css` | `#list` 声明 6 个几何变量 + 2 条 DPR 媒体查询 + `scrollbar-gutter`；新增 `.grid-row` / `.tile`（含 loading/failed/pinned 态）；`.detail` 改 absolute overlay；页脚 30 → 45 DIP 动作栏；删 `.detail-actions` |
| `clipboard/clipboard.html` | `#list` 包进 `.list-wrap`；`#detail` 移入浮层容器；动作按钮移入 `<footer>`；新增 `#view`；加载 `clipboard-layout.js` |
| `main/domains/clipboard/index.js` | `preview` → `previews`（批量取字节 + 池 8 + LRU + 有界 token + `cacheEpoch`）；`on('history')` 改清 LRU 保留 token |
| `main/ipc/clipboard-ipc.js` | 通道改名 + `ids` 入参校验（1–64 / UUID / 去重 / 拒绝多余键） |
| `main/services/ipc-security.js` | **仅 `:67` 一行**（白名单同步） |
| `preload-clipboard.js` | **仅 `:13` 一行**（`previews`） |
| `shared/locales/clipboard.js` | 三语各 +2 键：`clipboard.view-text`、`clipboard.thumbnail-unavailable`（82 → 84） |
| `test/clipboard-ui-contract.test.js` | 「行高锁步」→「几何单一真源」；新增 4 组护栏（13 → 17 用例） |
| `test/clipboard-paste-renderer.test.js` | vm 沙箱补齐 `dataset`/选择器引擎/`getComputedStyle`/`matchMedia`/`previews`；1 → 9 用例 |
| — | （其余为本文档与上述测试，无产品代码遗漏） |

**原生、`main.js`、`package.json`、CI 工作流：零改动。** `main.js` 仍是 1327 行（上限 1330），这是硬约束——装配只能留在 `main/domains/clipboard/index.js` 内部。

---

## 3. 关键设计决策（后续维护必读）

| # | 决策 | 不这么做会怎样 |
| --- | --- | --- |
| D1 | **几何单一真源 = `#list` 上的 CSS 变量**，JS 只 `getPropertyValue` 读取 | 6 个几何量双写会漂移；旧的「行高锁步」断言已不可能存在（混排无单一 pitch） |
| D2 | **按「行」虚拟化**，不是 `index * pitch` | 图片行与文本行不同高，索引算术失效 |
| D3 | **`previews(ids)` 在主进程内完成「取字节 → 缓存 → 签 token」** | 若只签 URL，逐项 `NOT_FOUND` 无法同步返回，会退化成 `<img>` 静默 404 |
| D4 | **`on('history')` 清 LRU、不清 token** | 不清 LRU → 后台 `maintain()` 删记录后旧 token 仍能从缓存读到已删图片 |
| D5 | **`cacheEpoch` 守卫缓存写入** | 迟到的原生读会把刚失效的缓存写回去 |
| D6 | **`thumbInFlight` 无条件释放 + `thumbFailed` 参与跳过 + 分批补齐** | 前者导致永久空白，后者导致第 65 张起永久空白 |
| D7 | **网格禁止 masonry / 按宽高比变高** | 行高随内容变会让「追加分页不位移」和裁剪锚定不可推导 |
| D8 | **持有 `<img>` 的 `src` 只在拿到真实 URL 后设置** | 窗口安全探针把 `ERR_UNKNOWN_URL_SCHEME` 当失败 |

---

## 4. 验证证据（本机实跑，2026-10-23 复验）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全量单测 | `node --test test/*.test.js` | **1337 / 1337 pass，0 fail** |
| 语法 | `node scripts/check-js.js` | 394 文件通过 |
| 架构 | `node scripts/check-architecture.js` | `main.js 1327 / 1330` |
| i18n | `node scripts/check-i18n.js --max 606` | `TOTAL 585`、`clipboard 0`、三语对称 |
| 覆盖率（载入） | `npm run test:coverage:loaded` | **91.58%** lines（阈值 85） |
| 覆盖率（native） | `npm run test:coverage:native` | **82.89%**（阈值 60/文件） |
| 覆盖率（critical） | `npm run test:coverage:critical` | **93.46%**（阈值 90/文件） |
| 窗口安全探针 | `test/window-security-runtime.test.js` | **pass**（真实 Electron；`consoleMessages: []`、`blocked: []`） |
| long-capture | `node tests/long-capture.test.js` | pass |
| 版本 | `node scripts/check-version.js` | `4.1.0` |

### 4.1 本机跑门禁的环境前置（否则会得到假失败）

```bash
env -u ELECTRON_RUN_AS_NODE \
  TMP="F:/workspace/Highlighter/.tmp-test" \
  TEMP="F:/workspace/Highlighter/.tmp-test" \
  node --test test/*.test.js
```

- `ELECTRON_RUN_AS_NODE` 必须清掉，否则 Electron 探针全部 `app is undefined`；
- `TMP`/`TEMP` 必须指向**已存在**的 checkout 内目录（子进程写不了 `%LOCALAPPDATA%\Temp`，会 `EPERM` 后挂到超时）。目录要先 `mkdir -p`。
- 跑完记得删 `.tmp-test/`。

### 4.2 一个既有的不稳定项（不是本次引入）

`test/clipboard-coordination.test.js` 的「native addon authenticates leases」在**高并发全量跑**时偶发 `Lease round N` 失败；单跑稳定通过。它测的是原生 `selection-hook` 租约往返，相关文件（`native/**`、该测试、`scripts/probe-clipboard-native.js`）本次**均未改动**。修复它需要动原生超时语义，超出本次范围。**看到它红先单跑一次确认。**

---

## 5. 尚未验证（不要当成已通过）

1. **真机交互**：面板真实渲染观感、滚动是否跳位、断图兜底的人眼确认；
2. **DPR 各档清晰度**：100/125/150/175/200/225/250/300%，尤其 **300% + 窄窗**（算术上有 0.88–1.00× 轻微上采样，见设计 §3.2）；
3. **A11y 树**：`role="presentation"` 包 `role="option"` 是否按预期把 option 上提为 listbox 的 owned child（设计 §8.3 标为待验证）；需 DevTools Accessibility 或 Playwright `accessibility.snapshot()`；
4. **380 DIP 窄窗页脚排版**：六个控件是否溢出/被裁（B5 的修复是 CSS 算术结论，未目测）；
5. **`captureBusyMs` 冷缓存压测**：一屏全 MISSING 时自愈解码是否逼近 3000 ms 红线（设计 §5.6）；
6. `test:e2e` 未跑（且它本就不覆盖剪贴板面板）；
7. `design-demos/tools/capture-electron.js` 的截图夹具**未同步**（设计 §9.5 列了 4 处改动；非门禁，但会让既有截图产物 probe 输出失真）。

建议真机验收按 **副屏** 进行（根 `AGENTS.md` 要求）。

---

## 6. 后续可做（按价值排序）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| P1 | 同步截图夹具 | `capture-electron.js` 的假桥加 `previews`、probe 改读 tile 几何、`protocol.handle` 按 id 返回不同 PNG、夹具补到 6 张图 |
| P1 | 真机验收 + 补 A11y 断言 | 见 §5 的 1–4 项 |
| P2 | WebP 缩略图（独立一期） | 收益真实（384 噪声 30.9 KiB = PNG 的 1/16），但有 4 个连锁陷阱：`Cargo.lock` 缺 `image-webp`、build-id 不同步会 `INCOMPATIBLE_BACKEND`、缩略图 mime 恒为 `image/png` 会让改后全 404 且无日志、存量 `.png` 与新格式并存触发同步自愈。**必须独立提交、独立回滚** |
| P3 | 非致命逐项超时 | 现超时走 `failChild()` 会杀整个 sidecar。正确做法：`clearTimeout` + 从 `pending` 删除 + reject，迟到响应会被 `requestId` 匹配丢弃 |
| P3 | `main.js` 行数债 | 1327/1330，只剩 3 行。任何新装配都得先减行 |

---

## 7. 变更时的注意事项（最容易被踩的 5 条）

1. **`main.js` 一行都不能加。** 只剩 3 行余量，架构门禁会红。新依赖在 `main/domains/clipboard/index.js` 内部构造。
2. **`clipboard/**` 下写中文注释会让 i18n 门禁变红。** 扫描器逐行匹配 CJK 且**不区分注释**，该目录必须保持 0 行，总预算只剩 21 行。
3. **IPC 三处必须同批改**：`ipc-security.js:67` 白名单、`clipboard-ipc.js` 注册、`preload-clipboard.js` 暴露。漏任一处：`main.js` 的 `assertComplete()` 启动即抛。
4. **`clipboard.css` 禁止**：`:root{}`、任何十六进制色值、`url(...)`、emoji 图标。改完跑 `test/design-tokens.test.js`。
5. **改渲染层结构后，`test/clipboard-paste-renderer.test.js` 的 DOM stub 可能不够用。** 该 stub 只实现面板真正用到的方法，**新增 DOM API 必须显式加进 stub**——这是刻意的，缺了会让断言变真空。选择器引擎遇到无法解析的选择器会**抛错**，不会静默返回空。

---

## 8. 提交信息

本次提交（17 个文件）：

```
feat(clipboard): render image records as a thumbnail grid

Image records used to be 64px text rows showing "Image W × H", and selecting
any record opened a detail sheet below the list that squeezed the history and
could not be dismissed. Image records are now thumbnail plates in a grid with
no visible copy, and selecting is a pure selection: full text opens on demand
as an overlay that never reflows the list.

- clipboard-layout.js: pure row model for the mixed text/image list, plus the
  DPR-aware column formula (keeps a 240px native thumbnail from being upscaled)
- geometry has one source: #list declares --row-h/--cell-h/--grid-gap/... and
  the renderer reads them; the old rowHeight constant and its lockstep test are
  replaced by a single-source invariant
- clipboard:previews(ids) replaces the one-at-a-time preview: the old handler
  cleared every token before issuing one, so N concurrent tiles kept only the
  last token and the rest 404'd deterministically. Bytes are now read and cached
  behind a bounded token table (128 / 300s), an 8-wide pool and an 8 MiB LRU.
- history events invalidate the byte cache but keep issued tokens, so a copy in
  another app no longer blanks the grid, while a record pruned by retention stops
  being readable from cache; cacheEpoch stops late reads from repopulating a
  cleared cache
- thumbnail plates retry once (hiding the panel revokes tokens) and fall back to
  a drawn placeholder that says "thumbnail unavailable" to a screen reader
- native side untouched; main.js line count unchanged (1327/1330)

Gates: node --test test/*.test.js 1337/1337; check-js 394 files;
check-architecture ok; check-i18n 585/0; coverage 91.58/82.89/93.46;
window-security probe passes in real Electron with an empty console and no
blocked requests. Not yet verified on device: interaction feel, DPR buckets,
accessibility tree shape, 380 DIP footer fit.
```

---

## 9. 本次工作方式记录（供参考）

- 三轮并行调研（渲染层 / 缩略图链路 / 门禁横切面，各约 400–700 行笔记）→ 设计文档 → 两轮独立评审（Codex）。
- **第一轮评审针对文档**，指出 8 条阻断项，其中 5 条是文档本身的技术错误（例如 `previews` 无法同步返回错误、`MISSING 自愈并发 ≤2` 做不到、列数公式自相矛盾），已修正。
- **第二轮评审针对实现代码**，指出 6 条阻断项 + 4 条建议，**全部属实**并已修复（详见设计文档 §18）。其中「`thumbInFlight` 泄漏」「只取前 64 张」「只监听 1dppx」三条属**门禁全绿但真机会坏**的类型。
- 实施期还自查出 4 个 bug，最重要的是「缩略图批量请求在节点挂载前就触发，`querySelectorAll` 永远扫不到 tile」——由新加的「首个渲染应合成一次 previews 调用」用例抓出。
