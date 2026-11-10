# highlighter-windows-platform（R0）

计划 §3.1 的 Windows 能力层。R0 只交付**纯算术**的 DPI/几何原语；Win32 捕获、焦点、
快捷键、凭据与真机 DPI 矩阵属于 R3。

## R0 交付

- `ScaleFactor`：DPI（96 = 100%）与缩放因子互转，拒绝 0/负/NaN/∞。
- `dip_to_physical` / `physical_to_dip`：整数像素转换，**半数远离零**舍入并饱和到
  `i32`（不 panic、不回绕）。
- `DipPoint`/`PhysicalPoint`、`DipRect`/`PhysicalRect`：矩形的每个边独立舍入（避免
  `scale * width` 在负坐标/副屏上累积偏移）；`right()`/`bottom()` 用 `i64` 防溢出。
- `MonitorGeometry`：物理 bounds/work area + scale，可转到 DIP；拒绝 work area 越出 bounds。

## 舍入规则（R3 真机对照前只是**候选实现**）

- DIP → 物理：`round(dip * scale)`，`.5` 远离零；饱和到 `i32`。
- 物理 → DIP：`round(physical / scale)`，同上。
- 矩形：left/top、right/bottom 分别舍入后再算宽高（不是直接缩放 width/height）。
  Windows/Chromium 在 100/150/200%、负坐标副屏上的实际取整由 R3 用真实窗口对照后冻结；
  R0 **不宣称**与 Electron/Chromium 完全一致。

## 明确不做

- 不链接 Win32（无 `windows-sys` 依赖）；不做窗口/焦点/捕获/快捷键/凭据（R3）。
- 不做 UIA、选择、回贴；不做多显示器拓扑枚举（R3-05）。
