//! tauri-build 入口：生成 Tauri 上下文/权限 schema，并在 Windows 上编译资源文件。
//!
//! 本原型不注册应用命令 ACL（`app_manifest`），因此 `invoke_handler` 命令默认对所有窗口
//! 可用——这是文档里登记的原型隔离缺口（计划 §4.3）；窗口归属校验在命令入口与
//! 自定义协议处理器里用 webview label 做纵深防御，详见 docs/plans/rust-migration/r0-resource-channel.md。
fn main() {
    tauri_build::build();
}
