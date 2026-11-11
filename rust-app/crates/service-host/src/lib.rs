//! sidecar 协议与生命周期 crate（计划 §3.1 `service-host`）。
//!
//! R0 只实现 `shared/clipboard-protocol.js` 的帧编解码移植与跨语言夹具对照骨架；
//! SidecarSupervisor、进程管理、握手、日志脱敏、取消/重启语义属于 R2-03。
//!
//! 依赖方向（计划 §3.2）：service-host 不依赖窗口/平台/存储 crate；后续通过固定程序
//! 协议接入既有 helper，不反向依赖 core。
#![forbid(unsafe_code)]

pub mod clipboard_protocol;
