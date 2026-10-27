# Highlighter 后续开发流程（承接内存优化 M0–M2）

- 日期：2026-10-27（Asia/Hong_Kong）
- 性质：**流程文档，不是新方案**。它定义"接下来按什么顺序、用什么门禁、怎么交付"，方案内容仍以 `docs/plans/2026-10-26-memory-optimization-plan.md` 为准。
- 当前基线：`master @ f5ef6df`，工作树干净；M0/M1/M2 已按 10 个 commit 落地；`dist/Highlighter-Setup-4.1.6.exe` 已构建并通过 `npm run verify:package`（未签名本地线）。
- 给读者的第一句话：**先做真机验证（阶段 0），再动 M3 的图片预算，最后才是 M4 与架构决策门。** 没跑过真实 Electron 的回收策略，不要当作已完成。

---

## 0. 当前状态与硬约束（一页）

**已交付（单测/静态门禁证据）**：M0 观测（窗口注册表、role 标注、`memory-snapshot.js`、performance-monitor 增强）；M1（OCR 热启动回收、usage worker 空闲退出、截图 init 缓冲释放）；M2（W4 回收框架、W5 搜索窗、W6a 自启仅托盘、W7 划词结果窗、W6b 主窗保守回收）。详见主方案附录 D/E。

**尚未验证（阶段 0 要补的账）**：真实 Electron 下的 5 min / 60 s / 120 s 回收时序、IPC 鉴权、preload 上报、销毁后托盘恢复；W3 的 4K 回落探针；W8 工具条预热收益。

**硬约束（违反就会返工）**：

| 约束 | 现状 | 处理 |
| --- | --- | --- |
| `main.js` 行数上限 | `check-architecture` 1330/1330（`wc -l` 1329），**零余量** | 任何 main.js 改动前先抽模块（建议抽 `startApplication` 的托盘/服务段） |
| 已知 flake | `test/clipboard-coordination.test.js` 的 lease round | 先单独复跑 2 次；通过则不是回归，不要"修"断言 |
| 内存数字口径 | 单机单次不是结论 | Working Set / Private / 私有工作集 / GPU 分开报；每格标样本数 |
| 未签名构建线 | `electron-builder.local-fuses.cjs` | 正式发布另走签名线，不把本地产物当可分发签名包 |
| `dist/` | 已 gitignore | 构建产物不进提交 |

---

## 1. 每个工作项的固定循环

所有后续项（M3/M4/W8/修复）都走同一条闭环，不允许"先写代码再想验收"：

1. **定基线**：先测（真实 Electron 或探针），写清 P50/P95、峰值字节或"进程是否消失"的判定方式；没有基线的项不进入实现。
2. **设计**：小 diff、可回滚、失败路径可见；新逻辑一律放 `main/services/` 或 `main/ipc/`，`main.js` 只做装配。跨文件（main.js、`ipc-security.js`、settings 默认值/规范化）由 Lead 统一改。
3. **实现 + 测试**：策略正确性用**注入时钟/注入 fake child/fake window** 做确定性单测；真实计时只出现在探针，不出现在门禁。
4. **本地门禁**（顺序固定）：
   ```bash
   node --check <改动文件>
   env -u ELECTRON_RUN_AS_NODE TMP=.tmp-test TEMP=.tmp-test node --test <定向测试>
   npm test                     # 全量；先排除已知 flake
   npm run check                # check-js + check-architecture + check-i18n
   npm run test:coverage        # 触碰 main/services 关键文件或新增模块时必跑
   ```
5. **提交**：Conventional Commits，**一个工作项一个 commit**；commit 必须自包含（新模块与其引用同属一个 commit）；hunk 跨项时先重构把交叉点挪开，不混提交。
6. **构建/打包**（影响运行时行为或安装包时）：按 §6 的构建线出包并 `verify:package`。
7. **记录**：在主方案对应里程碑追加"实施记录 + 未验证项 + 风险"；内存类改动同时写 `docs/performance/` 报告。

**禁止**：跳过门禁直接提交；把单次快照当结论；为过检查放宽断言；在 `main.js` 顶格时硬塞行数；在没有渲染器 clean 上报时销毁主窗口（会丢草稿）。

---

## 2. 阶段 0：真机验证（最高优先，约 1–2 天）

目的：把 M1/M2 的 fake 窗口证据升级为**真实 Electron 证据**；发现的问题先补测试再修（走 §1 循环）。

| # | 场景 | 操作 | 通过标准 |
| --- | --- | --- | --- |
| V0-1 | 安装与启动 | 安装 `dist/Highlighter-Setup-4.1.6.exe`（或直接跑 `dist/win-unpacked/Highlighter.exe`） | 正常启动、托盘存在、单实例、fuses 生效（无 DevTools/Node 入口） |
| V0-2 | OCR 热启动回收 | 启动后不识别，等 ≥ idleTimeout（默认 5 min） | `HighlighterOcrSidecar.exe` 退出；随后识别可冷启动并记录耗时 |
| V0-3 | usage worker 退出 | 打开 usage 页扫描一次，等 120 s | `usage-scan-utility` 进程消失；再次扫描可用 |
| V0-4 | 搜索窗回收与恢复 | 打开搜索→输入词→失焦隐藏→等 60 s→再打开 | 渲染进程消失而后重建；查询词/分类/排序恢复并自动重跑 |
| V0-5 | 划词结果窗回收 | 未固定窗口失焦→等 120 s；再点托盘"恢复最近会话" | 窗口消失；会话可按快照恢复；**固定窗口不消失** |
| V0-6 | 主窗口保守回收 | 留在 `home/history/usage/translation/chat/about` 之一，点关闭→等 5 min | 渲染进程消失；重开恢复路由；切到设置页/有草稿（分类、provider 编辑器）时**不**回收；迁移/录屏/导出期间不回收 |
| V0-7 | 基线报告 | 按主方案 §3.3 场景采 30 min 托盘待机 + 30 次开关 | 报告落 `docs/performance/2026-XX-memory-baseline.md`，每格标样本数 |

**工具**：
```bash
# 全进程角色快照（只读，不启动窗口）
node scripts/memory-snapshot.js --label v0-tray-idle --samples 30 --interval 2000
# 日志里的 performance-snapshot 事件（role→pid→内存）
# 兜底：Get-Process / 任务管理器按可执行文件名
```
**出口**：每个 V0 项都有真实证据（截图/JSON/日志）＋基线报告；发现不达标 → 回到 §1 循环修，修复项单独立项，不夹带。

---

## 3. 阶段 1：M3 图片峰值与预算（约 8–13 人日）

顺序固定，先做常驻问题最重的贴图。

### W9 贴图资源化 + 字节预算（约 4–6 天）
1. 基线：20 窗 × 4K 的 WS/Private（`memory-snapshot` + `_pinData` 引用计数日志）。
2. 设计：主进程只存 PNG Buffer/临时文件 + `bufferId`；注册只读协议（照抄剪贴板 `handleResource` 的"可见性+owner+generation"三重门）；渲染器 `<img src="highlighter-pin://id">`；`createFromDataURL` 的 5 处全解码改为 PNG 头解析/按需。
3. 预算：`settings.pinned.maxTotalMiB`（初值 64–128，基线后定）+ 单图像素上限；超限给**可见**失败文案，不静默降质。
4. 测试：单图 4K、20 窗、关闭释放、复制/保存/透明度/穿透/旋转/重标注全路径；协议越权测试。
5. 验收：20 窗峰值远低于当前估算（≈55 MB/窗）；关闭窗口后 buffer 可释放；协议读不到任意文件。

### W10 长截图峰值（约 3–5 天）
- 渲染前字节预算（像素×4×并发系数 ≤ 上限，建议初值 512 MiB），超限走可见失败而非 OOM；
- 去掉裁剪时的二次全尺寸解码（同一次解码内 extract）；保持"render 只在 finish 一次"并加回归测试；
- 8e7 px 的复制/贴图路径在 W9 协议化后不再 `toDataURL`。

### W11 缓存预算审计（约 1–2 天，可与 W9 并行）
- 新增 `test/memory-budgets.test.js`：断言各缓存（马赛克 16 MiB、放大镜 32 MiB、剪贴板缩略图 8 MiB/128、OCR 12 条、贴图预算）的上限与超限行为；
- 结论应可复核：只有贴图是"只限条目不限字节"的风险项。

### W12 历史缩略图（条件，约 1 天先测）
- 先测 30 项列表的帧时间与瞬时峰值；只有确实成为峰值来源才做批量化/流式。**不预先优化**。

**出口**：4K/8K/20 贴图/长图导出峰值报告 + 预算断言 + 功能回归全绿。

---

## 4. 阶段 2：M4 启动与懒加载（条件触发，约 5–8 人日）

前提：阶段 0 基线显示冷启动/首屏解析确实是痛点，且 M3 收益不足。**先改规则，再改代码。**

1. **W13 AI SDK 懒加载**（1–2 天）：先改 `scripts/check-architecture.js:90-94` 的"必须字面 require"规则（允许 getter 内 require 且仍校验调用点）→ 包 getter → 用 `node -e` 测 require 前后 RSS 决定是否继续。
   - 注意：**`sharp` 不是有效目标**——`LongCaptureSession` 仍顶层依赖它（`long-capture-session.js:3`）。
2. **W14 渲染器按需**（3–5 天，分两阶段）：
   - 阶段 1：`shared/locales/config.js`（177 KB）按语言拆分，同步改 `check-i18n.js` 断言；
   - 阶段 2：路由改清单 + 动态 import，同步改 `test/config-routes.test.js` 契约；必须在 W6b 之后（已满足）。
3. **W15 启动分段埋点**（0.5–1 天，可提前独立做）：`main.js:88/:109` 前后 token、module-load-complete 段、`startApplication` 细分、启动后 60 s 空闲快照。

**出口**：冷启动各段可解释；未使用功能不解析；`npm run check` 与全量测试全绿。

---

## 5. 阶段 3：W8 工具条测量（可穿插，约 1 天）

真实 Electron 隐藏窗探针（`show:false`，遵循 AGENTS.md）：预热 vs 按需创建的首次显示 P50/P95。若差值小于体验预算 → 提供"快速响应/节省内存"两档设置；若差值大 → 保留预热，把省内存目标让给其它窗口。产出 `docs/performance/` 记录，不先改代码。

---

## 6. 决策门：Tauri / Windows 原生常驻核心（条件，原型 10–15 人日）

同时满足才启动：① M1–M3 完成且托盘待机/截图峰值仍稳定超目标；② G1–G3（可观测/不累积/回收到位）达标，排除"还有窗口没回收"；③ 有同功能原型预算与 4K/多屏真机条件。
原型范围与判定见主方案 §10；**只验证一条路线**，不并行重写两个应用，不接受空白窗/设置页演示。

---

## 7. 发布与构建流程（影响打包时执行）

```bash
# 1) 版本一致性
#    改 package.json / package-lock 后：
npm run check:version

# 2) 原生有改动才重建（会 stop:app，先确认没有用户会话在用）
npm run build:native

# 3) 本地未签名构建线（fuses 加固）
npx electron-builder --config electron-builder.local-fuses.cjs --win nsis portable --x64 --publish never

# 4) 打包校验（含 fuses、win-unpacked/portable 启动探针、manifest、SBOM）
#    SBOM 用重定向生成，避免 PowerShell 管道损坏 JSON：
npm sbom --sbom-format cyclonedx > dist/sbom.cdx.json
npm run verify:package
```

- 正式发布：`scripts/prepare-release-signing.ps1` + `electron-builder.release.cjs` + `npm run verify:release`（需要签名证书；CI 见 `.github/workflows/release.yml`）。
- 产物清单：`Highlighter-Setup-<ver>.exe`、`Highlighter-<ver>-portable.exe`、`.blockmap`、`latest.yml`、`sbom.cdx.json`、`SHA256SUMS.txt`。
- 历史教训：`makensis` 偶发 `Can't open output file`，清掉残件重跑即可；本地通过的打包检查不代表签名线通过。

---

## 8. 并行与分工约定（Agent Teams）

| 场景 | 做法 |
| --- | --- |
| 单个工作项 | Lead 直接实现，或 1 个 teammate |
| 多文件并行 | 按**写作用域**拆（示例：W9 拆"主进程协议"与"渲染器/预算"两条线；W3/W5/W7 都曾这样拆） |
| 交叉文件 | `main.js`、`ipc-security.js`、settings 默认值/规范化、架构/契约测试由 Lead 统一改；teammate 只提交"需要什么通道/字段"的最小诉求 |
| teammate 交付格式 | 改动文件 + 关键行为 + 执行的命令与通过数 + 未验证项 + 风险；禁止"没跑过说跑过" |
| Lead 收尾 | diff review → 全量测试 → check（必要时 coverage）→ 按工作项拆 commit → 构建（如需）→ 更新主方案附录 |

新增 IPC 通道时固定动作：注册放 `main/ipc/` → `ipc-security.js` 对应 role 的 handles/listeners → 同步 `test/ipc-module-contracts.test.js` → 跑 `test/ipc-security.test.js`（它扫描 `main.js`/`main/ipc`/`main/domains` 的字面量注册，别把注册藏在 services）。

---

## 9. 门禁速查

| 命令 | 何时必跑 |
| --- | --- |
| `node --check <file>` | 每次改 JS |
| `node --test <定向文件>` | 每次改实现或测试 |
| `npm test` | 每个工作项提交前 |
| `npm run check` | 每个工作项提交前（main.js 行数/语法/i18n） |
| `npm run test:coverage` | 新增 `main/services`/`main/ipc` 模块，或改 window-security/update/diagnostics |
| `npm run verify:package` | 改动影响打包产物后 |
| `node scripts/memory-snapshot.js ...` | 每个内存类工作项的前后对比 |

已知 flake：`test/clipboard-coordination.test.js`「100 rounds」在负载高时会失败；先单独 `node --test test/clipboard-coordination.test.js` 复跑 2 次，通过即非回归。

---

## 10. 需要先决策的开放问题

1. OCR 热启动默认语义：**5 min 空闲回收**（当前）还是"永久预热"选项？需要产品拍板默认值。
2. 主窗口 W6b v2：是否允许在设置页也回收（需要草稿快照协议）？v1 只回收 6 个只读路由。
3. 贴图预算默认值（64 / 128 MiB）与超限文案；是否允许牺牲放大画质做显示分辨率解码。
4. 是否投入 10–15 人日做宿主原型（Tauri 或 Windows 原生核心）。
5. 安装包签名证书 / SmartScreen 处理（影响分发体验）。

---

## 11. 交付索引

- 主方案（含 M0–M2 实施记录）：`docs/plans/2026-10-26-memory-optimization-plan.md`（附录 D/E）。
- 调研与复核差异：`docs/research/2026-10-26-memory-and-architecture-assessment.md`。
- 测量纪律（探针写法/字节预算）：`docs/plans/2026-10-26-cde-performance-samples.md` §5。
- 本次安装包与校验：`dist/Highlighter-Setup-4.1.6.exe`、`dist/SHA256SUMS.txt`。
