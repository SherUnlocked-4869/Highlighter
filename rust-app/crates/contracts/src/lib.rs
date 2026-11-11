//! Highlighter Rust 迁移 R0 宿主合同（contracts）。
//!
//! 本 crate 是计划 §4.2 "拟新增的内部合同" 的 Rust 侧数据层，并为
//! `contracts/host/host-contracts.json`（格式见 `docs/plans/rust-migration/contract-format.md`）
//! 提供只读视图。它**不**访问用户数据、时钟、窗口或宿主 API；除 serde/serde_json 外
//! 没有依赖，也不依赖 tauri/windows/sqlite/异步运行时（依赖方向见计划 §3.2）。
//!
//! R0 边界：
//!
//! - 只有 DTO 与合同文件解析；运行时校验、权限映射、命令入口二次校验属于 R1-04。
//! - `host_contracts` 读取的是仓库内的**生成产物**（不是用户数据）；测试对真实产物做
//!   严格校验（文件缺失即失败），不在 Rust 源码里复刻夹具/合同内容作为第二真相。
//!
//! 后续批次：R1 在此之上建立角色能力登记与命令权限；R2 接入存储合同。
#![forbid(unsafe_code)]

pub mod host_contracts;
pub mod types;

pub use host_contracts::{
    host_contracts_path, repo_root, Baseline, ContractError, ErrorCodeContract, HostContracts,
    MethodContract, ResourceLimitContract, RoleContract, SharedSchemaContract, SurfaceContract,
    CAPTURE_DOCUMENT_SCHEMA_VERSION, CLIPBOARD_DB_USER_VERSION, DATA_ROOT_MARKER_VERSION,
    HOST_CONTRACTS_KIND, HOST_CONTRACTS_SCHEMA_VERSION, HOST_CONTRACTS_STATUS,
    RECORDING_PROJECT_SCHEMA_VERSION, RESOURCE_LIMIT_COUNT, USAGE_DB_USER_VERSION,
    WINDOW_ROLE_COUNT,
};
pub use types::{
    HostContext, OperationError, OperationRef, ResourceRef, UnknownWindowRole, WindowRole,
};
