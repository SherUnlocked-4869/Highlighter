# 长截图真实语料采集与基准

- 日期：2026-09-09
- 关联：`docs/plans/2026-09-09-ci-ocr-capture-dedup-design.md` 第 4 项
- 目的：为长截图匹配算法优化提供真实数据，避免对合成数据过拟合

## 1. 为什么需要真实语料

现有基准 `scripts/benchmark-performance.js` 的 `createShiftedFrame` 用**两个独立 LCG 随机流**构造帧对：已滚动区域从上一帧拷贝，新露出区域填入另一条随机流。

这与真实滚动内容有本质差异：

- 真实文本/列表在滚动轴上高度自相关，相邻行像素差异小；随机流几乎不相关。
- 真实内容含固定元素（表头、页脚、工具栏、滚动条、光标），会产生稳定的重复纹理。
- 真实抗锯齿与亚像素滚动会产生非整数位移。

因此合成基准只能测**上界性能**，无法暴露匹配失败与歧义拒绝的真实分布。团队已在 `docs/performance/2026-08-16-optimization-round.md` 第 36 行记录该结论并推迟算法优化。

## 2. 语料格式

```
<corpus-dir>/
  <case-name>/
    case.json
    frame-000.rgba
    frame-001.rgba
    ...
```

`case.json`：

```json
{
  "width": 96,
  "height": 2160,
  "axis": "vertical",
  "shifts": [360, 420]
}
```

- `width` / `height` 是**灰度分析帧**的尺寸，须与 `long-capture.js` 实际送入匹配器的尺寸一致（滚动轴保持原生分辨率，交叉轴封顶 96px）。
- `axis` 为 `vertical` 或 `horizontal`。
- `shifts` 是每个帧对的**期望位移**（第 i 项对应 frame-i → frame-(i+1)）。长度不足时基准只报检测值、不判定 mismatch。
- `frame-NNN.rgba` 是 `width * height` 字节的**灰度**数据，即 `LongCaptureMatcher.toGrayscale(rgba)` 的输出形态。存灰度而非 RGBA 可让语料体积降到 1/4，且匹配器入口不变。

## 3. 采集方法

1. 启动应用，进入长截图，框选目标区域。
2. 在渲染进程打开 DevTools，于 `uploadStrip` 处断点或在 `drawCurrentFrame` 后插入一次性导出：把 `analysisCanvas` 的 `getImageData` 转灰度后经 `longCaptureAPI` 或直接 `fs` 写出 `frame-NNN.rgba`。
3. 每滚动一次记录一次期望位移（可用 `longCaptureAPI.addStrip` 的返回值或人工标注）。
4. 覆盖以下五类场景，每类至少 2 个用例：

| 场景 | 要点 |
|---|---|
| 纯文本（文档/网页正文） | 滚动轴上强自相关 |
| 长列表（文件管理器/表格） | 行结构重复，易触发歧义 |
| 图文混排 | 大块平坦区域 + 局部细节 |
| 双向滚动 | `axis` 分别为 vertical / horizontal 各一 |
| 含固定元素 | 表头/页脚/滚动条/光标，考验静止检测与歧义判定 |

## 4. 运行

```powershell
npm run bench:performance -- --corpus <corpus-dir> --output docs/performance/corpus-result.json
```

输出在 `longCaptureCorpus` 字段，每个用例给出：

- `pairs`：帧对数量
- `statuses` / `detectedShifts` / `expectedShifts`：逐帧状态与位移
- `shiftMismatches`：期望与实际不一致的数量（`shifts` 长度匹配时才有值）
- `minMs` / `medianMs` / `p95Ms` / `maxMs`：每次匹配的耗时分布

## 5. 当前状态

- 工具已就绪：`--corpus` 参数、`readCorpusCase`、`benchmarkCorpus`，测试见 `test/performance-benchmark.test.js`。
- 真实语料**尚未采集**。在语料到位并记录 before/after 之前，**不修改 `matcher.js` 算法核心**（金字塔/粗到精）。
- 已知合成基准数据（供对照）：垂直 4K 56.83ms、水平 4K 86.00ms，门槛 50ms P95。

## 6. 一处已实测排除的优化

`long-capture.js` 的 `appendPreview` 曾被怀疑为 O(n²)（超过 1200px 后每帧全量重缩放）。Chrome canvas 实测结果否定了该判断：

| 累计段数 | 单次追加耗时 | 预览尺寸 |
|---:|---:|---|
| 100 | 0.107 ms | 160×1000 |
| 500 | 0.100 ms | 38×1151 |
| 1000 | 0.080 ms | 19×1077 |
| 3000 | 0.058 ms | 3×1077 |

预览被 1200px 上限约束，峰值像素恒为约 192k，且随预览缩小单帧成本**下降**。因此不做改动（收益不足 10% 且增加复杂度）。

附带发现（未修改，待评估）：`appendPreview` 的纵向分支在缩放后 `addition` 仍按缩放前宽度计算，导致预览宽度随段数增长持续塌缩（1000 段后宽仅 19px），宽高比失真。这是显示问题而非性能问题，且属于既有行为，需产品确认是否期望修正。
