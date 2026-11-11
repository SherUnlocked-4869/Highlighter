//! GDI BitBlt 采集（显示器/区域/窗口三种目标）。
//!
//! 与 WGC 的差异（R0 证据文档 §5 逐项列出）：
//! - GDI 从屏幕 DC 逐帧拷贝到内存位图，整帧 CPU 内存拷贝（无 GPU 读回），
//!   高分辨率高帧率下 CPU 显著更高、更容易掉帧；
//! - 不含鼠标光标（未 DrawIcon）；WGC 可用 `SetIsCursorCaptureEnabled(true)`；
//! - 对 D3D 全屏独占/硬件叠加层（视频播放器、部分游戏）可能采到黑块/旧内容；
//!   WGC 走 DWM 合成结果，没有该限制；
//! - 无隐私指示边框/权限语义（WGC 有系统采集指示）；
//! - 屏幕 DC 坐标是虚拟桌面坐标（主屏原点 (0,0)，上/左显示器为负），
//!   进程必须是 per-monitor DPI aware v2，否则拿到 DPI 虚拟化后的逻辑像素。
//!
//! 暂停：每帧前检查 `PauseController`，暂停期间不 BitBlt/不送帧；媒体时钟由
//! `FramePusher` 扣除暂停时长，恢复后槽位连续。

use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ, SRCCOPY,
};

use super::{CaptureStats, CaptureTarget, FramePusher, WindowRuntime};
use crate::ffmpeg::Frame;
use crate::pause::PauseController;
use crate::util::human_bytes;

const CAPTUREBLT: u32 = 0x4000_0000;

pub struct GdiRun {
    pub stats: CaptureStats,
    pub window: Option<WindowRuntime>,
}

// 说明：GetDIBits 版本在 32bpp + 负高度时同样是 top-down BGRA，但需要额外一次
// 位图 → DIB 的拷贝；直接用 CreateDIBSection 让 BitBlt 写进可读 DIB 缓冲区，
// 少一次整帧拷贝，也避免 GetDIBits 的 DPI/拉伸路径。
#[allow(clippy::too_many_arguments)]
pub fn run(
    target: &mut CaptureTarget,
    seconds: f64,
    fps: u32,
    max_fill: u64,
    tx: std::sync::mpsc::SyncSender<Frame>,
    t0: Instant,
    pause: Option<Arc<PauseController>>,
    captureblt: bool,
) -> Result<GdiRun, String> {
    let (out_width, out_height) = target.output_size();
    let width = out_width as i32;
    let height = out_height as i32;
    let byte_len = width as usize * height as usize * 4;

    let mut pusher = FramePusher::new(tx, fps, t0, max_fill);
    let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);

    let screen_dc: HDC = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err("GetDC(NULL) failed".to_string());
    }
    let mem_dc: HDC = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if mem_dc.is_invalid() {
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err("CreateCompatibleDC failed".to_string());
    }

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down，与 WGC BGRA 行序一致
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: byte_len as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let dib = match unsafe {
        CreateDIBSection(Some(screen_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
    } {
        Ok(b) => b,
        Err(e) => {
            unsafe {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
            }
            return Err(format!("CreateDIBSection failed: {e}"));
        }
    };
    if bits.is_null() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("CreateDIBSection returned null bits".to_string());
    }
    let old_obj: HGDIOBJ = unsafe { SelectObject(mem_dc, HGDIOBJ(dib.0)) };
    if old_obj.is_invalid() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("SelectObject(DIBSection) failed".to_string());
    }

    let rop = if captureblt {
        windows::Win32::Graphics::Gdi::ROP_CODE(SRCCOPY.0 | CAPTUREBLT)
    } else {
        windows::Win32::Graphics::Gdi::ROP_CODE(SRCCOPY.0)
    };
    let mut next_tick = Instant::now();
    let mut frames = 0u64;
    let mut grab_errors = 0u64;
    let mut first_error: Option<String> = None;
    let mut window_events: Vec<(f64, String)> = Vec::new();
    let mut last_error_log = Instant::now() - Duration::from_secs(5);
    let mut errored = false;

    loop {
        if let Some(p) = &pause {
            if p.wait_if_due(&mut pusher) {
                next_tick = Instant::now() + interval;
            }
            if p.media_now(Instant::now()) >= seconds {
                break;
            }
        } else if (Instant::now() - t0).as_secs_f64() >= seconds {
            break;
        }
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
        // 先推进节拍再抓帧：抓帧耗时不会累积成周期性漏槽（掉队时下一次会立即抓，靠
        // FramePusher 的同槽丢弃把节拍拉回 fps）。
        next_tick += interval;

        // 暂停可能在 sleep 期间开始：再检查一次，暂停期间不抓帧。
        if let Some(p) = &pause {
            if p.is_paused() {
                continue;
            }
        }

        let media_s = {
            let paused = pusher.paused_total().as_secs_f64();
            (Instant::now() - t0).as_secs_f64() - paused
        };
        let grab_ok = match target {
            CaptureTarget::Screen(rect) => {
                let copied = unsafe {
                    BitBlt(
                        mem_dc,
                        0,
                        0,
                        width,
                        height,
                        Some(screen_dc),
                        rect.left,
                        rect.top,
                        rop,
                    )
                };
                match copied {
                    Ok(()) => true,
                    Err(e) => {
                        grab_errors += 1;
                        if first_error.is_none() {
                            first_error = Some(format!(
                                "BitBlt(rect={:?}) failed: {e:?}",
                                windows::Win32::Foundation::RECT {
                                    left: rect.left,
                                    top: rect.top,
                                    right: rect.left + rect.width as i32,
                                    bottom: rect.top + rect.height as i32,
                                }
                            ));
                        }
                        false
                    }
                }
            }
            CaptureTarget::Window(source) => {
                let outcome = source.grab(mem_dc, screen_dc, bits, byte_len);
                for ev in &outcome.events {
                    window_events.push((media_s, ev.clone()));
                }
                if let Some(err) = &outcome.error {
                    grab_errors += 1;
                    if first_error.is_none() {
                        first_error = Some(err.clone());
                    }
                }
                outcome.ok
            }
        };
        if !grab_ok {
            if last_error_log.elapsed() >= Duration::from_secs(2) {
                logln!(
                    "[gdi] grab error #{grab_errors} at media={media_s:.3}s: {}",
                    first_error.clone().unwrap_or_default()
                );
                last_error_log = Instant::now();
            }
            continue;
        }

        // SAFETY: DIB 缓冲区大小为 width*height*4，DIB 生命周期覆盖本次拷贝。
        let slice = unsafe { std::slice::from_raw_parts(bits as *const u8, byte_len) };
        let frame = slice.to_vec();
        frames += 1;
        let arrival = Instant::now();
        pusher.push(frame, arrival);
        if let Some(p) = &pause {
            if p.media_now(Instant::now()) >= seconds {
                break;
            }
        }
        if pusher.stats.error.is_some() {
            errored = true;
            break;
        }
        if frames == 1 {
            logln!(
                "[gdi] first frame copied: target={} {}x{} bytes={}",
                target.describe(),
                width,
                height,
                human_bytes(byte_len as u64)
            );
        }
    }

    if grab_errors > 0 {
        if let Some(err) = first_error {
            logln!("[gdi] grab errors={grab_errors} first={err}");
            if !errored && pusher.stats.send_errors == 0 {
                pusher.stats.error.get_or_insert(err);
                errored = true;
            }
        }
    }
    let _ = errored;

    // 清理 GDI 资源。
    unsafe {
        let _ = SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
    }

    let window = match target {
        CaptureTarget::Window(source) => Some(WindowRuntime {
            stats: source.stats.clone(),
            events: window_events,
            initial: source.initial.describe(),
        }),
        CaptureTarget::Screen(_) => None,
    };
    let stats = pusher.finish();
    logln!(
        "[gdi] done: target={} delivered={} written={} wall={:.3}s media={:.3}s paused={:.3}s grab_errors={}",
        target.describe(),
        stats.delivered,
        stats.written,
        stats.wall_s(),
        stats.media_s(),
        stats.paused_total_s,
        grab_errors
    );
    Ok(GdiRun { stats, window })
}
