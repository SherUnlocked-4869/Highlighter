//! 进程 CPU 时间采样：本进程（采集+哈希+管道写入）与 ffmpeg 子进程（编码）。
//!
//! 只统计 CPU 时间（user+kernel，100ns 精度），不依赖性能计数器服务，
//! 因此在受限桌面会话中也可用。

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Clone, Copy, Debug, Default)]
pub struct CpuTimes {
    pub user_s: f64,
    pub kernel_s: f64,
}

impl CpuTimes {
    pub fn total_s(&self) -> f64 {
        self.user_s + self.kernel_s
    }
}

fn filetime_to_u64(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

fn sample(handle: HANDLE) -> Option<CpuTimes> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).ok()?;
    }
    Some(CpuTimes {
        user_s: filetime_to_u64(&user) as f64 / 1e7,
        kernel_s: filetime_to_u64(&kernel) as f64 / 1e7,
    })
}

/// 当前进程的 CPU 时间采样器。
#[derive(Debug)]
pub struct SelfCpuCounter {
    start: Option<CpuTimes>,
}

impl SelfCpuCounter {
    pub fn start() -> Self {
        let start = unsafe { sample(GetCurrentProcess()) };
        Self { start }
    }

    /// 返回自 start 以来的 CPU 时间。
    pub fn elapsed(&self) -> CpuTimes {
        let now = unsafe { sample(GetCurrentProcess()) };
        match (self.start, now) {
            (Some(a), Some(b)) => CpuTimes {
                user_s: (b.user_s - a.user_s).max(0.0),
                kernel_s: (b.kernel_s - a.kernel_s).max(0.0),
            },
            _ => CpuTimes::default(),
        }
    }
}

/// 按 PID 打开的进程 CPU 计时器；进程退出后句柄仍可读到最终 CPU 时间。
pub struct ProcessCpuCounter {
    handle: HANDLE,
}

// 只在本进程内跨线程使用；HANDLE 是进程对象句柄，读写由 OS 保证。
unsafe impl Send for ProcessCpuCounter {}

impl ProcessCpuCounter {
    pub fn open(pid: u32) -> Option<Self> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        Some(Self { handle })
    }

    pub fn sample(&self) -> Option<CpuTimes> {
        sample(self.handle)
    }
}

impl Drop for ProcessCpuCounter {
    fn drop(&mut self) {
        if !self.handle.0.is_null() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}
