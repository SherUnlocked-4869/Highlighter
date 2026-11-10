//! tauri-build 入口：生成 Tauri 上下文/权限 schema，并在 Windows 上编译资源文件。
//!
//! 本原型不注册应用命令 ACL（`app_manifest`），因此 `invoke_handler` 命令默认对所有
//! 窗口可用——这是文档里登记的原型隔离缺口，不是遗漏：R1-04 才做角色/命令权限映射。
fn main() {
    tauri_build::build();
}
