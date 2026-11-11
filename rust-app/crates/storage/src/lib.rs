//! 存储原语（计划 §3.1 `storage`）。
//!
//! R0 只实现两块可独立验证的纯逻辑：原子 JSON/字节写入（`atomic_json`）与开发/灰度
//! 隔离数据根 locator（`data_root`）。真实的设置/凭据/SQLite/数据根迁移属于 R2。
//!
//! 依赖方向（计划 §3.2）：storage 是叶子存储层，不依赖窗口/平台/code crate；
//! 用例层（core）通过接口访问存储，而不是相反。
#![forbid(unsafe_code)]

pub mod atomic_json;
pub mod data_root;

pub use atomic_json::{
    read_json, read_json_with_limit, write_atomic, write_json_atomic, StorageError, MAX_JSON_BYTES,
};
pub use data_root::{
    default_base_directory, default_data_root, ensure_not_nested, is_legacy_locator_name,
    load_locator, locator_path, resolve_data_root, store_locator, switch_data_root,
    validate_data_root, DataRootChannel, DataRootLocator, LocatorError, LEGACY_LOCATOR_FILE,
    LOCATOR_KIND, LOCATOR_SCHEMA_VERSION, MAX_LOCATOR_BYTES,
};
