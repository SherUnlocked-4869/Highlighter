# C02 · 托盘冷启动 / 首帧 / 首次截图基线流程

来源：docs/reviews/2026-11-24-windows-product-architecture-review.md §C02。目标是在固定 Windows 机器上，用同一套流程比较改动前后：
登录启动到托盘可响应、手动启动到主窗首帧、首次及再次 F1 到可编辑，以及 5 轮 30 分钟托盘待机。

## 判定门槛（main/services/performance-budget.js）

| 指标 | 规则 |
|---|---|
| 启动 / 首次可编辑 P95 | 相对基线恶化 ≤10% |
| 待机末 5 分钟私有提交中位数 | 相对基线增长 ≤10% |
| 空闲 CPU 中位数 | ≤0.5% |
| 样本量 | 冷启 ≥20 次、待机 ≥5 轮；不足按失败处理，不能当作通过 |

## 冷启动采集

```powershell
# 1. 基线（改动前，同一台机器、同驱动、同包型、同数据量）
node scripts/startup-baseline.js --probe "npx electron --no-sandbox scripts/probe-startup.js" --ready HIGHLIGHTER_READY --runs 20 --out .tmp-perf/baseline-run.json
# 2. 改动后
node scripts/startup-baseline.js --probe "npx electron --no-sandbox scripts/probe-startup.js" --ready HIGHLIGHTER_READY --runs 20 --out .tmp-perf/current.json
# 3. 判定（失败时退出码非 0，可直接进 CI/发布脚本）
node scripts/startup-baseline.js --probe "npx electron --no-sandbox scripts/probe-startup.js" --ready HIGHLIGHTER_READY --runs 20 --out .tmp-perf/current.json --baseline .tmp-perf/baseline.json --idle-private-commit <bytes> --idle-cpu <pct>
```

说明：探针命令由调用方提供，所以同一脚本可测 NSIS、便携版或源码运行；`--ready` 是探针打印的就绪标记。
待机数字由 `node scripts/memory-snapshot.js --label tray-idle --samples 30 --interval 2000` 采集后，用 `--idle-private-commit` / `--idle-cpu` 传入（末 5 分钟取中位数）。

## 真机约定

- 可见窗口一律放副屏（AGENTS.md）。
- 记录包哈希、提交、Windows 版本、DPI、驱动、数据规模与样本数；缺 GPU/驱动样本的项在证据表标注待验，不写成通过。
- 超过门槛时复跑成对试验（同一会话内先后各 20 次），排除单次后台负载影响。

## 本机可验证与不可验证

- 可验证：百分位、样本充足性、三条门槛的判定逻辑（test/performance-budget.test.js）；采集脚本对就绪标记与超时的处理（冒烟用 `node -p HIGHLIGHTER_READY`）。
- 不可验证：真实 Electron 冷启动与 30 分钟待机的绝对数字——需要固定真机与显示会话；本仓库的 CI 只跑判定逻辑，不声称通过真机门槛。
