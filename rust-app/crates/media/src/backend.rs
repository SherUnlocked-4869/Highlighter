//! R5 边界：录屏采集与导出调度的 **trait 骨架**（R0 只声明形状，不实现）。
//!
//! 这些 trait 刻意保持最小：R0 不预设采集后端（WebView2 还是原生采集由 R0-05 的 ADR
//! 决定），也不预设编码器/FFmpeg 的装配方式。R5 才冻结：
//!
//! - 目标/音源枚举、权限提示、预检（R5-01）；
//! - 裁剪/缩放、系统音+麦克风、暂停时间、写入背压与 checkpoint（R5-02）；
//! - 源会话/持久项目/导出任务三种生命周期（计划 §5.2）；
//! - FFmpeg argv 白名单、验证后发布、取消/重试（R5-05）。
//!
//! 语义约束（R0 就要求实现方遵守，写在这里防止被后续实现遗忘）：
//!
//! - 失效目标必须明确失败，不静默换屏/换窗口。
//! - 同一媒体时钟；`finish` 与 `abort` 不混用；暂停不产生时间漂移。
//! - 编码成功不等于发布成功；部分产物不能登记为成功。

/// 采集目标。R0 只给占位形状；R5 决定是否需要目标 token/显示器 ID。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordingTarget {
    /// 单显示器（按显示器 ID，而不是"当前主屏"）。
    Display {
        /// 系统显示器标识。
        display_id: String,
    },
    /// 单个窗口（按窗口句柄/窗口 ID，不使用易失效的标题）。
    Window {
        /// 系统窗口标识。
        window_id: String,
    },
    /// 屏幕区域（物理像素，`[x, y, width, height]`）。
    Region {
        /// 区域左上角 x（物理像素）。
        x: i32,
        /// 区域左上角 y（物理像素）。
        y: i32,
        /// 宽（物理像素）。
        width: u32,
        /// 高（物理像素）。
        height: u32,
    },
}

/// 音源选择：系统回放 + 麦克风可独立开关；关闭的音源不得被偷偷采集。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AudioSources {
    /// 采集系统回放音。
    pub system: bool,
    /// 采集麦克风。
    pub microphone: bool,
}

/// 开始录制的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRecordingRequest {
    /// 采集目标。
    pub target: RecordingTarget,
    /// 音源。
    pub audio: AudioSources,
    /// 是否采集鼠标指针（R5-06 的事件轨依赖它）。
    pub capture_pointer: bool,
}

/// 已开始的录制会话句柄。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingHandle {
    /// 宿主分配的源会话 ID（不可猜测）。
    pub session_id: String,
}

/// 正常 finish 后的产物描述（原片引用 + 时长），不包含编码产物。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedRecording {
    /// 源会话 ID。
    pub session_id: String,
    /// 实际媒体时长（毫秒，媒体时钟）。
    pub duration_ms: u64,
    /// 原始容器（如 `webm`）；编码在 R5 导出阶段完成。
    pub container: String,
}

/// 采集后端（R5-01/R5-02 实现）。R0 只声明，避免提前绑定 WebView/原生方案。
pub trait RecordingBackend {
    /// 后端错误类型（R5 决定是否统一为 OperationError）。
    type Error;

    /// 开始录制；同一时刻活动录制数沿用基线（计划 §5.2）。
    fn start(&mut self, request: StartRecordingRequest) -> Result<RecordingHandle, Self::Error>;

    /// 暂停（媒体时钟继续推进，但录制内容不含暂停段）。
    fn pause(&mut self, handle: &RecordingHandle) -> Result<(), Self::Error>;

    /// 继续。
    fn resume(&mut self, handle: &RecordingHandle) -> Result<(), Self::Error>;

    /// 正常收尾；与 `abort` 不混用，失败不得登记为成功。
    fn finish(&mut self, handle: RecordingHandle) -> Result<FinishedRecording, Self::Error>;

    /// 异常/取消收尾并清理临时资源。
    fn abort(&mut self, handle: RecordingHandle) -> Result<(), Self::Error>;
}

/// 导出任务 ID（宿主分配，不可猜测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportTaskId {
    /// 任务 ID。
    pub task_id: String,
}

/// 导出任务状态（计划 §5.2 的导出任务集合；R5-05 实现状态机）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportTaskState {
    /// 排队等待。
    Queued,
    /// 编码中。
    Running,
    /// 发布临界区（临时文件已验证，尚未替换目标）。
    Publishing,
    /// 已成功发布。
    Succeeded,
    /// 失败（不得登记成品）。
    Failed,
    /// 取消中。
    Cancelling,
    /// 已取消。
    Cancelled,
}

/// 导出请求（R5-05 只接受白名单字段；R0 仅占位）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportTaskRequest {
    /// 项目/源会话 ID。
    pub project_id: String,
    /// 幂等请求 ID：重复 requestId 不重复导出。
    pub request_id: String,
    /// 目标格式（mp4/gif/webm，R5 校验）。
    pub format: String,
}

/// 导出调度器（R5-05 实现）：入队、取消、查询状态。
///
/// 容量语义见 [`crate::export::ExportQueueLimits`]：同时 1 个编码任务，最多 2 个等待；
/// `queued/running/cancelling` 都参与容量与清理。
pub trait ExportScheduler {
    /// 调度器错误类型。
    type Error;

    /// 入队（拒绝非法请求/容量已满）；返回稳定任务 ID。
    fn enqueue(&mut self, request: ExportTaskRequest) -> Result<ExportTaskId, Self::Error>;

    /// 取消；发布临界区内的取消不替换目标，也不报告 cancelled（计划 §5.2）。
    fn cancel(&mut self, id: &ExportTaskId) -> Result<(), Self::Error>;

    /// 查询状态；未知 ID 返回 `None`。
    fn status(&self, id: &ExportTaskId) -> Option<ExportTaskState>;
}
