//! 计划 §4.2 的内部 DTO。类型与字段名和 TS 草案一一对应；serde 使用 camelCase。

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// 页面角色。序列化名与 `contracts/host/host-contracts.json` 的 `role` 字符串、
/// 以及计划 §4.1 的表格一致（kebab-case）。
///
/// 变体顺序与计划 §4.1 表格一致；`ALL` 是唯一来源，禁止在别处再抄一份字符串数组。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowRole {
    /// `main`：`electronAPI`。
    Main,
    /// `clipboard`：`clipboardAPI`。
    Clipboard,
    /// `toolbar`：`toolbarAPI`。
    Toolbar,
    /// `action`：`actionAPI`。
    Action,
    /// `capture`：`captureAPI`。
    Capture,
    /// `long-capture`：`longCaptureAPI`。
    LongCapture,
    /// `long-overlay`：`longOverlayAPI`。
    LongOverlay,
    /// `pin`：`pinAPI`。
    Pin,
    /// `recognition`：`recognitionAPI`。
    Recognition,
    /// `search`：`searchAPI`。
    Search,
    /// `record`：`recordAPI`。
    Record,
    /// `record-editor`：`recordEditorAPI`。
    RecordEditor,
    /// `record-frame`：`recordFrameAPI`。
    RecordFrame,
}

impl WindowRole {
    /// 计划 §4.1 冻结的 13 个角色，顺序与表格一致。
    pub const ALL: [WindowRole; 13] = [
        WindowRole::Main,
        WindowRole::Clipboard,
        WindowRole::Toolbar,
        WindowRole::Action,
        WindowRole::Capture,
        WindowRole::LongCapture,
        WindowRole::LongOverlay,
        WindowRole::Pin,
        WindowRole::Recognition,
        WindowRole::Search,
        WindowRole::Record,
        WindowRole::RecordEditor,
        WindowRole::RecordFrame,
    ];

    /// 合同 JSON / IPC 中使用的稳定字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            WindowRole::Main => "main",
            WindowRole::Clipboard => "clipboard",
            WindowRole::Toolbar => "toolbar",
            WindowRole::Action => "action",
            WindowRole::Capture => "capture",
            WindowRole::LongCapture => "long-capture",
            WindowRole::LongOverlay => "long-overlay",
            WindowRole::Pin => "pin",
            WindowRole::Recognition => "recognition",
            WindowRole::Search => "search",
            WindowRole::Record => "record",
            WindowRole::RecordEditor => "record-editor",
            WindowRole::RecordFrame => "record-frame",
        }
    }
}

impl fmt::Display for WindowRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 无法识别的角色字符串（来自旧/新合同或伪造输入）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownWindowRole(pub String);

impl fmt::Display for UnknownWindowRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unknown window role: {}", self.0)
    }
}

impl std::error::Error for UnknownWindowRole {}

impl FromStr for WindowRole {
    type Err = UnknownWindowRole;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        WindowRole::ALL
            .into_iter()
            .find(|role| role.as_str() == value)
            .ok_or_else(|| UnknownWindowRole(value.to_owned()))
    }
}

/// 由宿主为一次调用生成的身份，**不接受页面传入**（计划 §4.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostContext {
    /// 窗口实例 ID；重建窗口后旧实例的完成/取消必须失效。
    pub window_instance_id: String,
    /// 调用窗口的角色。
    pub role: WindowRole,
    /// 宿主 generation；旧 generation 的操作结果不得回流到新实例。
    pub generation: u64,
}

impl HostContext {
    /// 构造一个宿主生成的调用上下文。
    pub fn new(window_instance_id: impl Into<String>, role: WindowRole, generation: u64) -> Self {
        Self {
            window_instance_id: window_instance_id.into(),
            role,
            generation,
        }
    }
}

/// 长任务引用：注册表用 operationId + generation 识别一次操作（计划 §4.2）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRef {
    /// 不可猜测的操作 ID（由宿主分配）。
    pub operation_id: String,
    /// 注册该操作的 generation。
    pub generation: u64,
}

/// 二进制资源引用；后端分配不可猜测的 ID（计划 §4.3）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    /// 不可猜测的资源 ID。
    pub resource_id: String,
    /// MIME 类型。
    pub mime: String,
    /// 字节数。
    pub byte_length: u64,
}

/// 跨宿主/页面边界的操作错误（计划 §4.2）。
///
/// `messageKey` 是本地化键而不是正文；日志/前端不得凭它泄露凭据或正文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    /// 机器可读错误码。
    pub code: String,
    /// 是否允许调用方按各自回执协议重试（有副作用操作不能由通用 transport 自动重试）。
    pub retryable: bool,
    /// 本地化消息键。
    pub message_key: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_round_trip_between_string_and_serde() {
        let mut seen = Vec::new();
        for role in WindowRole::ALL {
            let text = role.as_str();
            assert!(!seen.contains(&text), "duplicate role {text}");
            seen.push(text);
            assert_eq!(role.to_string(), text);
            assert_eq!(text.parse::<WindowRole>(), Ok(role));

            let json = serde_json::to_string(&role).expect("serialize role");
            assert_eq!(json, format!("\"{text}\""), "serde name drifts for {text}");
        }
        assert_eq!(WindowRole::ALL.len(), 13);
        assert_eq!(seen.len(), 13);
    }

    #[test]
    fn role_strings_match_plan_section_4_1() {
        // 计划 §4.1 表格里的角色名（手写一遍是**测试期望**，不是生产第二真相）。
        let expected = [
            "main",
            "clipboard",
            "toolbar",
            "action",
            "capture",
            "long-capture",
            "long-overlay",
            "pin",
            "recognition",
            "search",
            "record",
            "record-editor",
            "record-frame",
        ];
        for (role, text) in WindowRole::ALL.into_iter().zip(expected) {
            assert_eq!(role.as_str(), text);
        }
    }

    #[test]
    fn unknown_role_is_rejected_with_the_input() {
        let error = "nope".parse::<WindowRole>().expect_err("must reject");
        assert_eq!(error, UnknownWindowRole("nope".to_owned()));
        assert!(error.to_string().contains("nope"));
    }

    #[test]
    fn host_context_uses_camel_case_on_the_wire() {
        let context = HostContext::new("instance-1", WindowRole::RecordEditor, 7);
        let value = serde_json::to_value(&context).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "windowInstanceId": "instance-1",
                "role": "record-editor",
                "generation": 7
            })
        );
        let back: HostContext = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back, context);
    }

    #[test]
    fn operation_and_resource_refs_are_camel_case() {
        let reference = OperationRef {
            operation_id: "op-1".to_owned(),
            generation: 3,
        };
        assert_eq!(
            serde_json::to_value(&reference).expect("serialize"),
            serde_json::json!({ "operationId": "op-1", "generation": 3 })
        );

        let resource = ResourceRef {
            resource_id: "res-1".to_owned(),
            mime: "image/png".to_owned(),
            byte_length: 2048,
        };
        assert_eq!(
            serde_json::to_value(&resource).expect("serialize"),
            serde_json::json!({ "resourceId": "res-1", "mime": "image/png", "byteLength": 2048 })
        );
    }

    #[test]
    fn operation_error_matches_plan_fields() {
        let error = OperationError {
            code: "window-owner-mismatch".to_owned(),
            retryable: false,
            message_key: "error.windowOwnerMismatch".to_owned(),
        };
        let value = serde_json::to_value(&error).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "code": "window-owner-mismatch",
                "retryable": false,
                "messageKey": "error.windowOwnerMismatch"
            })
        );
        let back: OperationError = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back, error);
    }
}
