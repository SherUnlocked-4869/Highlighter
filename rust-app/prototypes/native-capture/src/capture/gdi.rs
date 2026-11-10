//! GDI BitBlt 桌面采集回退路径。
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

use std::time::{Duration, Instant};

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ, SRCCOPY,
};

use super::{CaptureStats, FramePusher, MonitorInfo};
use crate::ffmpeg::Frame;
use crate::util::human_bytes;

const CAPTUREBLT: u32 = 0x4000_0000;

// 说明：GetDIBits 版本在 32bpp + 负高度时同样是 top-down BGRA，但需要额外一次
// 位图 → DIB 的拷贝；直接用 CreateDIBSection 让 BitBlt 写进可读 DIB 缓冲区，
// 少一次整帧拷贝，也避免 GetDIBits 的 DPI/拉伸路径。
pub fn run(
    monitor: &MonitorInfo,
    seconds: f64,
    fps: u32,
    max_fill: u64,
    tx: std::sync::mpsc::SyncSender<Frame>,
    t0: Instant,
) -> Result<CaptureStats, String> {
    let width = monitor.width() as i32;
    let height = monitor.height() as i32;
    let byte_len = width as usize * height as usize * 4;

    let mut pusher = FramePusher::new(tx, fps, t0, max_fill);
    let width_usize = width as usize;
    let height_usize = height as usize;

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
        // SelectObject 失败
        unsafe {
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("SelectObject(DIBSection) failed".to_string());
    }

    let rop = windows::Win32::Graphics::Gdi::ROP_CODE(SRCCOPY.0 | CAPTUREBLT);
    let start = Instant::now();
    let deadline = start + Duration::from_secs_f64(seconds.max(0.05));
    let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let mut next_tick = start;
    let mut frames = 0u64;
    let mut bitblt_errors = 0u64;
    let mut first_error: Option<String> = None;

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
        next_tick += interval;
        // 掉队时不要攒 burst：把节拍追到当前时刻之后，交给 FramePusher 记为缺口。
        let now = Instant::now();
        if next_tick < now {
            next_tick = now + interval;
        }

        let copied = unsafe {
            BitBlt(
                mem_dc,
                0,
                0,
                width,
                height,
                Some(screen_dc),
                monitor.rect.left,
                monitor.rect.top,
                rop,
            )
        };
        match copied {
            Ok(()) => {}
            Err(e) => {
                bitblt_errors += 1;
                if first_error.is_none() {
                    first_error = Some(format!(
                        "BitBlt(rect={:?}) failed: {e:?}",
                        RECT {
                            left: monitor.rect.left,
                            top: monitor.rect.top,
                            right: monitor.rect.right,
                            bottom: monitor.rect.bottom,
                        }
                    ));
                }
                continue;
            }
        }

        // SAFETY: DIB 缓冲区大小为 width*height*4，DIB 生命周期覆盖本次拷贝。
        let slice = unsafe { std::slice::from_raw_parts(bits as *const u8, byte_len) };
        let frame = slice.to_vec();
        frames += 1;
        let arrival = Instant::now();
        pusher.push(frame, arrival);
        if pusher.stats.error.is_some() {
            break;
        }
        if frames == 1 {
            logln!(
                "[gdi] first frame copied: {}x{} bytes={}",
                width_usize,
                height_usize,
                human_bytes(byte_len as u64)
            );
        }
    }

    if bitblt_errors > 0 {
        if let Some(err) = first_error {
            logln!("[gdi] BitBlt errors={bitblt_errors} first={err}");
            pusher.stats.error.get_or_insert(err);
        }
    }

    // 清理 GDI 资源。
    unsafe {
        let _ = SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
    }

    let stats = pusher.finish();
    logln!(
        "[gdi] done: captured_attempts={frames} delivered={} written={} wall={:.3}s errors={}",
        stats.delivered,
        stats.written,
        stats.wall_s(),
        bitblt_errors
    );
    Ok(stats)
}
