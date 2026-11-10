# highlighter-service-host（R0）

sidecar 协议与生命周期 crate。R0 只交付**剪贴板帧协议**的 Rust 移植与夹具对照骨架；
完整的 `SidecarSupervisor`（固定程序、启动参数、握手、request/cancel/stop、重启后拒绝
旧响应）属于计划 R2-03。

## R0 交付

- `clipboard_protocol`：`shared/clipboard-protocol.js` 的 `encodeFrame`/
  `FrameDecoder` 语义移植。
  - 9 字节固定头：`size`(u32 LE) + `kind`(u8) + `headerBytes`(u32 LE)；`kind` 1=控制帧、
    2=二进制帧；payload 必须为空时 kind=1。
  - 边界与计划 §9.1 一致：frame ≤ 1 MiB、header ≤ 512 KiB、payload chunk ≤ 256 KiB。
  - 流式解码：header/payload 可跨任意 feed 边界；一次 feed 可产出多帧；`finish()` 只接受
    帧边界状态；**任意非法帧返回同一个 `InvalidFrame`**（机器码 `invalid-frame`）。
  - `feed` 失败后 decoder 永久失败（与 JS `failed` 标志一致），旧帧不会"半恢复"。
- 单元测试为手写字节级用例（不依赖夹具）；`tests/clipboard_protocol_fixtures.rs` 对
  `test/fixtures/host-parity/clipboard-protocol/` 的 12 个 case 做严格对照：valid 逐帧
  header/payload 字节相等；invalid 按 `failAt=feed|finish` 在同一阶段失败且错误码为
  `invalid-frame`。夹具缺失即失败，不再 skip。

## 明确不做

- 不做剪贴板业务：lease/epoch/前台授权/回贴/协调（R3-02/R3-03）。
- 不做 I/O 读循环、背压、进程管理、日志脱敏（R2-03）。
- 不把夹具内容复制进 Rust 源码；测试失败信息带 case id 与字段名。

## 后续批次

R2-03 在本 crate 增加 sidecar supervisor 与协议握手；R3 增加剪贴板业务状态机。
