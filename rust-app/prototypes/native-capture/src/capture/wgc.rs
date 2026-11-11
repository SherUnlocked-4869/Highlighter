//! Windows.Graphics.Capture（WGC）桌面采集后端。
//!
//! 结构：
//! 1. D3D11 硬件设备（BGRA 支持）→ 通过 `CreateDirect3D11DeviceFromDXGIDevice`
//!    包装成 WinRT `IDirect3DDevice`；
//! 2. `RoGetActivationFactory("Windows.Graphics.Capture.GraphicsCaptureItem")`
//!    取得 `IGraphicsCaptureItemInterop`，用 `HMONITOR` 直接创建采集 item
//!    （不弹系统选源 UI）；
//! 3. `Direct3D11CaptureFramePool::CreateFreeThreaded` + `FrameArrived` 回调，
//!    回调里把 `IDirect3DSurface` 转成 `ID3D11Texture2D`，`CopyResource` 到
//!    CPU 可读 staging texture，Map 后逐行拷贝成 top-down BGRA；
//! 4. 帧带回调到达时间戳交给 `FramePusher` 做时间轴重采样与统计。
//!
//! 失败分支：D3D11 设备/WGC item/frame pool/StartCapture 任一步 HRESULT 都原样
//! 返回给调用方（不吞错），由 `capture::CaptureRequest::run` 决定回退或失败。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{IInspectable, Interface, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::RoGetActivationFactory;

use super::{CaptureStats, FramePusher, MonitorInfo};
use crate::ffmpeg::Frame;

/// 帧池缓冲数。2 是文档下限；3 给 30fps 下的编码/拷贝抖动留余量。
const FRAME_POOL_BUFFERS: i32 = 3;

struct WgcInner {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    staging_key: Option<(u32, u32, i32)>,
    width: u32,
    height: u32,
    pusher: FramePusher,
    error: Option<String>,
}

// SAFETY: WgcInner 只在 WGC 的 FrameArrived 回调线程与主线程之间通过 Mutex 共享，
// 所有访问都被串行化；D3D11 设备未使用 SINGLETHREADED 标志，本身可跨线程使用。
unsafe impl Send for WgcInner {}

fn copy_mapped(mapped: &D3D11_MAPPED_SUBRESOURCE, width: u32, height: u32) -> Vec<u8> {
    let row_bytes = width as usize * 4;
    let pitch = mapped.RowPitch as usize;
    let mut out = vec![0u8; row_bytes * height as usize];
    if mapped.pData.is_null() {
        return out;
    }
    let src = mapped.pData as *const u8;
    if pitch == row_bytes {
        // SAFETY: pitch*height 是 D3D11 Map 返回的有效可读区域。
        let slice = unsafe { std::slice::from_raw_parts(src, row_bytes * height as usize) };
        out.copy_from_slice(slice);
    } else {
        for row in 0..height as usize {
            // SAFETY: 每行从映射区拷贝 row_bytes，行首偏移 row*pitch 在映射范围内。
            let row_slice = unsafe { std::slice::from_raw_parts(src.add(row * pitch), row_bytes) };
            out[row * row_bytes..(row + 1) * row_bytes].copy_from_slice(row_slice);
        }
    }
    out
}

fn process_frame(
    inner: &mut WgcInner,
    frame: &Direct3D11CaptureFrame,
) -> windows::core::Result<()> {
    let arrival = Instant::now();
    let surface = frame.Surface()?;
    // IDirect3DSurface 不能直接 cast 到 ID3D11Texture2D（0550/0x80004002 E_NOINTERFACE）；
    // 标准做法是经 IDirect3DDxgiInterfaceAccess 取底层 DXGI 接口再 QI 到 ID3D11Texture2D。
    let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
    let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    let (width, height) = (desc.Width, desc.Height);
    if width == 0 || height == 0 {
        return Err(windows::core::Error::from_hresult(
            windows::Win32::Foundation::E_FAIL,
        ));
    }

    let key = (width, height, desc.Format.0);
    if inner.staging_key != Some(key) {
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe {
            inner
                .device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))?
        };
        inner.staging = staging;
        inner.staging_key = Some(key);
        inner.width = width;
        inner.height = height;
        logln!(
            "[wgc] staging texture created: {}x{} format={:?}",
            width,
            height,
            desc.Format
        );
    }
    let staging = inner
        .staging
        .as_ref()
        .ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
    unsafe { inner.context.CopyResource(staging, &texture) };

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        inner
            .context
            .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
    }
    let data = copy_mapped(&mapped, width, height);
    unsafe { inner.context.Unmap(staging, 0) };

    inner.pusher.push(data, arrival);
    if inner.pusher.stats.error.is_some() {
        return Err(windows::core::Error::from_hresult(
            windows::Win32::Foundation::E_FAIL,
        ));
    }
    Ok(())
}

/// 在任何编码器启动前探测 WGC 是否可用、以及采集内容的真实像素尺寸。
///
/// 只创建 `GraphicsCaptureItem`（不创建 D3D 设备/帧池），失败时把 HRESULT 原样返回；
/// `--capture auto` 据此决定是否回退 GDI，避免用错误尺寸启动 ffmpeg。
pub fn probe_size(monitor: &MonitorInfo, fault_hmon: Option<isize>) -> Result<(u32, u32), String> {
    let interop: IGraphicsCaptureItemInterop = unsafe {
        RoGetActivationFactory(&HSTRING::from(
            "Windows.Graphics.Capture.GraphicsCaptureItem",
        ))
    }
    .map_err(|e| format!("RoGetActivationFactory(GraphicsCaptureItem) failed: {e}"))?;
    let raw_hmon = fault_hmon.unwrap_or(monitor.hmon);
    if let Some(fake) = fault_hmon {
        logln!("[wgc] FAULT INJECTION: CreateForMonitor with invalid HMONITOR={fake}");
    }
    let hmon = HMONITOR(raw_hmon as *mut core::ffi::c_void);
    let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(hmon) }.map_err(|e| {
        format!("IGraphicsCaptureItemInterop::CreateForMonitor(hmon={raw_hmon}) failed: {e}")
    })?;
    let size = item
        .Size()
        .map_err(|e| format!("GraphicsCaptureItem::Size failed: {e}"))?;
    Ok((size.Width as u32, size.Height as u32))
}

/// WGC 可用性矩阵（诊断用，不采集）：逐个显示器 CreateForMonitor，
/// 再对前台窗口 CreateForWindow，原样打印每个 HRESULT。
pub fn probe_matrix(monitors: &[MonitorInfo]) {
    let interop: IGraphicsCaptureItemInterop = match unsafe {
        RoGetActivationFactory(&HSTRING::from(
            "Windows.Graphics.Capture.GraphicsCaptureItem",
        ))
    } {
        Ok(i) => i,
        Err(e) => {
            logln!("[probe] RoGetActivationFactory failed: {e}");
            return;
        }
    };
    logln!("[probe] WGC activation factory OK (IGraphicsCaptureItemInterop)");
    for m in monitors {
        let hmon = HMONITOR(m.hmon as *mut core::ffi::c_void);
        match unsafe { interop.CreateForMonitor::<GraphicsCaptureItem>(hmon) } {
            Ok(item) => {
                let size = item
                    .Size()
                    .map(|s| format!("{}x{}", s.Width, s.Height))
                    .unwrap_or_else(|e| format!("Size FAILED {e}"));
                logln!(
                    "[probe] CreateForMonitor #{} {} hmon={} -> OK size={}",
                    m.index,
                    m.device,
                    m.hmon,
                    size
                );
            }
            Err(e) => logln!(
                "[probe] CreateForMonitor #{} {} hmon={} -> FAIL raw_error={}",
                m.index,
                m.device,
                m.hmon,
                e
            ),
        }
    }
    let fg = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    if fg.0.is_null() {
        logln!("[probe] CreateForWindow: no foreground window");
    } else {
        match unsafe { interop.CreateForWindow::<GraphicsCaptureItem>(fg) } {
            Ok(item) => {
                let title = item
                    .DisplayName()
                    .map(|h| h.to_string())
                    .unwrap_or_default();
                let size = item
                    .Size()
                    .map(|s| format!("{}x{}", s.Width, s.Height))
                    .unwrap_or_else(|e| format!("Size FAILED {e}"));
                logln!(
                    "[probe] CreateForWindow(foreground={:?}) -> OK display_name={:?} size={}",
                    fg,
                    title,
                    size
                );
            }
            Err(e) => logln!(
                "[probe] CreateForWindow(foreground={:?}) -> FAIL raw_error={}",
                fg,
                e
            ),
        }
    }
    // GraphicsCaptureSession3 等能力探测略；这里只回答“能否创建采集 item”。
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    monitor: &MonitorInfo,
    seconds: f64,
    fps: u32,
    max_fill: u64,
    tx: std::sync::mpsc::SyncSender<Frame>,
    t0: Instant,
    expected_size: (u32, u32),
    fault_hmon: Option<isize>,
) -> Result<CaptureStats, String> {
    // 1) D3D11 设备。
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut feature_level = D3D_FEATURE_LEVEL::default();
    let levels = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    ];
    unsafe {
        D3D11CreateDevice(
            None::<&IDXGIAdapter>,
            windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            Some(&mut context),
        )
        .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
    }
    let device = device.ok_or_else(|| "D3D11CreateDevice returned null device".to_string())?;
    let context = context.ok_or_else(|| "D3D11CreateDevice returned null context".to_string())?;
    logln!("[wgc] D3D11 device created, feature_level={feature_level:?}");

    // 2) WinRT Direct3D 设备包装。
    let dxgi_device: IDXGIDevice = device
        .cast()
        .map_err(|e| format!("ID3D11Device -> IDXGIDevice cast failed: {e}"))?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
        .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice failed: {e}"))?;
    let winrt_device: IDirect3DDevice = inspectable
        .cast()
        .map_err(|e| format!("IInspectable -> IDirect3DDevice cast failed: {e}"))?;

    // 3) 由 HMONITOR 直接创建 GraphicsCaptureItem（不经过 GraphicsCapturePicker）。
    let interop: IGraphicsCaptureItemInterop = unsafe {
        RoGetActivationFactory(&HSTRING::from(
            "Windows.Graphics.Capture.GraphicsCaptureItem",
        ))
    }
    .map_err(|e| format!("RoGetActivationFactory(GraphicsCaptureItem) failed: {e}"))?;
    let raw_hmon = fault_hmon.unwrap_or(monitor.hmon);
    if let Some(fake) = fault_hmon {
        logln!("[wgc] FAULT INJECTION: CreateForMonitor with invalid HMONITOR={fake}");
    }
    let hmon = HMONITOR(raw_hmon as *mut core::ffi::c_void);
    let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(hmon) }.map_err(|e| {
        format!("IGraphicsCaptureItemInterop::CreateForMonitor(hmon={raw_hmon}) failed: {e}")
    })?;
    let item_size = item
        .Size()
        .map_err(|e| format!("GraphicsCaptureItem::Size failed: {e}"))?;
    logln!(
        "[wgc] item created for monitor #{} ({}), wgc_size={}x{}",
        monitor.index,
        monitor.device,
        item_size.Width,
        item_size.Height
    );
    let actual = (item_size.Width as u32, item_size.Height as u32);
    if actual != expected_size {
        return Err(format!(
            "WGC item size {}x{} != resolved size {}x{} (would corrupt rawvideo pipe)",
            actual.0, actual.1, expected_size.0, expected_size.1
        ));
    }

    // 4) 帧池 + 自由线程回调（无需 DispatcherQueue / 消息循环）。
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        FRAME_POOL_BUFFERS,
        item_size,
    )
    .map_err(|e| format!("Direct3D11CaptureFramePool::CreateFreeThreaded failed: {e}"))?;
    let session = pool
        .CreateCaptureSession(&item)
        .map_err(|e| format!("CreateCaptureSession failed: {e}"))?;

    // 光标与采集边框：失败不影响采集，但不是所有 Windows 版本都支持（Win10 2004 / Win11）。
    if let Err(e) = session.SetIsCursorCaptureEnabled(true) {
        logln!("[wgc] SetIsCursorCaptureEnabled(true) unsupported/failed: {e}");
    }
    if let Err(e) = session.SetIsBorderRequired(false) {
        logln!("[wgc] SetIsBorderRequired(false) unsupported/failed: {e}");
    }

    let pusher = FramePusher::new(tx, fps, t0, max_fill);
    let inner = Arc::new(Mutex::new(WgcInner {
        device: device.clone(),
        context,
        staging: None,
        staging_key: None,
        width: item_size.Width as u32,
        height: item_size.Height as u32,
        pusher,
        error: None,
    }));
    let stopped = Arc::new(AtomicBool::new(false));

    let handler = TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new({
        let inner = inner.clone();
        let stopped = stopped.clone();
        let pool_cb = pool.clone();
        move |_sender, _args| {
            if stopped.load(Ordering::Relaxed) {
                return Ok(());
            }
            let mut guard = match inner.lock() {
                Ok(g) => g,
                Err(_) => return Ok(()),
            };
            match pool_cb.TryGetNextFrame() {
                Ok(frame) => {
                    if let Err(e) = process_frame(&mut guard, &frame) {
                        if guard.error.is_none() {
                            guard.error = Some(format!("WGC frame processing failed: {e}"));
                        }
                        logln!("[wgc] frame processing error: {e}");
                    }
                    let _ = frame.Close();
                }
                Err(_) => {
                    // 回调触发但无可用帧：帧池被关闭或帧尚未就绪，忽略。
                }
            }
            Ok(())
        }
    });
    let token = pool
        .FrameArrived(&handler)
        .map_err(|e| format!("FrameArrived registration failed: {e}"))?;

    session
        .StartCapture()
        .map_err(|e| format!("GraphicsCaptureSession::StartCapture failed: {e}"))?;
    logln!("[wgc] capture started, target duration={seconds}s fps={fps}");

    // 5) 主线程按时长等待；回调线程负责送帧。
    let deadline = Instant::now() + Duration::from_secs_f64(seconds.max(0.05));
    let mut stats_err: Option<String> = None;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        if let Ok(g) = inner.lock() {
            if g.error.is_some() {
                stats_err = g.error.clone();
                break;
            }
        }
    }
    stopped.store(true, Ordering::Relaxed);
    // 给在途回调一点时间退出（回调在入口检查 stopped）。
    std::thread::sleep(Duration::from_millis(120));

    // 6) 关闭顺序：session → frame pool → handler。
    let _ = session.Close();
    let _ = pool.RemoveFrameArrived(token);
    let _ = pool.Close();
    drop(handler);
    drop(item);
    drop(pool);
    drop(session);
    std::thread::sleep(Duration::from_millis(80));

    let mut guard = inner
        .lock()
        .map_err(|_| "WGC inner state poisoned".to_string())?;
    if guard.error.is_some() {
        stats_err = guard.error.clone();
    }
    let stats = guard.pusher.finish();
    drop(guard);
    drop(inner);

    drop(winrt_device);
    drop(dxgi_device);
    drop(device);

    logln!(
        "[wgc] done: delivered={} written={} pacing_drops={} duplicated={} gaps={} backpressure_events={} wall={:.3}s",
        stats.delivered,
        stats.written,
        stats.pacing_drops,
        stats.duplicated,
        stats.arrival_gaps,
        stats.backpressure_events,
        stats.wall_s()
    );

    match stats_err {
        Some(e) if stats.delivered == 0 => Err(e),
        Some(e) => {
            logln!("[wgc] non-fatal frame errors recorded: {e}");
            Ok(stats)
        }
        None => Ok(stats),
    }
}
