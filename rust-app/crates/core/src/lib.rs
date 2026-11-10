//! 用例/状态机 crate（计划 §3.1 `core`）。
//!
//! R0 只有 [`registry`] 操作注册表原型：验证计划 §4.2 的窗口实例 + generation +
//! 取消信号 + 清理函数不变量。文档/项目/配置等用例与状态机属于 R4/R5/R2。
//!
//! 依赖方向（计划 §3.2）：core 只依赖 contracts 的 DTO；存储/平台/媒体通过接口注入，
//! 不直接依赖其实现 crate（`tests/dependency_direction.rs` 在 contracts 中检查）。
#![forbid(unsafe_code)]

pub mod registry;

pub use registry::{
    CancellationToken, Invalidation, OperationRegistry, RegisteredOperation, RegistryError,
};
