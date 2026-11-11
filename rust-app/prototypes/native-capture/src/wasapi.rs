//! WASAPI 音频源（系统 loopback / 麦克风等 capture 端点）与合成测试音渲染。
//!
//! 本文件是 R0-05 扩展后的版本，支持：
//! 1. **端点枚举**：render/capture 两个方向的 ACTIVE 端点、默认端点标记、混音格式；
//! 2. **任意 capture 端点**：第二音源（麦克风/虚拟设备），与 loopback 同一套采样/写盘逻辑；
//! 3. **暂停语义**：暂停期间继续从设备取包但丢弃，计入 `discarded_paused_frames`，
//!    保证音频媒体时间轴与视频一样**不包含暂停时长**；
//! 4. **WAV 流式写盘**：长录（30 分钟）时不再把整段 PCM 留在内存（避免内存峰值失真），
//!    短录可加 `keep_pcm` 便于混音/对齐/起点检测；
//! 5. **合成测试音**：向指定 render 端点渲染正弦音（可极低幅度/0 幅度），用于在没有
//!    外部播放器的情况下让 loopback 有确定内容、并作为音频媒体时钟的已知标记。
//!
//! 语义边界（写进证据文档）：
//! - loopback 采的是**该 render 端点的混音**，不是麦克风；系统无播放且无本进程渲染流时
//!   可能一个包都没有（本机默认端点是虚拟设备，实测 0 包）；
//! - 混音只取混音格式前 2 声道；>2 声道设备不满足 R5 的多声道要求；
//! - 暂停边界由 5 ms 轮询决定，音频样点归属误差最多约一个轮询周期；
//! - 不处理设备热插拔/默认端点切换（R5 才做）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{IUnknown, GUID, HSTRING, PCWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eRender, IAudioCaptureClient, IAudioClient,
    IAudioRenderClient, IMMDevice, IMMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, StructuredStorage, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};

use crate::pause::PauseGate;

const CLSID_MMDEVICE_ENUMERATOR: GUID = GUID::from_u128(0xBCDE_0395_E52F_467C_8E3D_C457_9291_692E);
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00AA_0038_9B71);
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x0000_0003_0000_0010_8000_00AA_0038_9B71);
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
/// PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c_254e_df1c_4efd_8020_67d1_46a8_50e0),
    pid: 14,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioKind {
    /// 系统 loopback（render 端点的回环）。
    RenderLoopback,
    /// 普通 capture 端点（麦克风/虚拟麦克风/立体声混音等）。
    CaptureDevice,
}

impl AudioKind {
    pub fn flow_name(&self) -> &'static str {
        match self {
            Self::RenderLoopback => "render-loopback",
            Self::CaptureDevice => "capture",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleKind {
    F32,
    I16,
    I32,
    U8,
}

impl SampleKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::F32 => "float32",
            Self::I16 => "pcm16",
            Self::I32 => "pcm32",
            Self::U8 => "pcm8",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MixFormat {
    pub kind: SampleKind,
    pub channels: u16,
    pub sample_rate: u32,
    pub block_align: u16,
    pub bits: u16,
    pub tag: u16,
}

#[derive(Clone, Debug)]
pub struct EndpointInfo {
    pub id: String,
    pub name: String,
    pub flow: &'static str,
    pub default_console: bool,
    pub default_communications: bool,
    pub mix: Option<MixFormat>,
}

/// 端点枚举结果与原始错误（枚举到部分端点时仍返回已枚举项）。
pub struct EnumerateResult {
    pub endpoints: Vec<EndpointInfo>,
    pub errors: Vec<String>,
}

fn ensure_com() {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            logln!(
                "[wasapi] CoInitializeEx(MTA) returned {:?} (continuing; may already be initialized)",
                hr
            );
        }
    }
}

fn device_id(device: &IMMDevice) -> String {
    unsafe { device.GetId() }
        .map(|p| {
            let s = unsafe { p.to_string() }.unwrap_or_default();
            unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
            s
        })
        .unwrap_or_else(|_| "(unknown)".to_string())
}

fn device_friendly_name(device: &IMMDevice) -> String {
    let store = match unsafe { device.OpenPropertyStore(STGM_READ) } {
        Ok(s) => s,
        Err(_) => return "(unknown)".to_string(),
    };
    let mut pv = match unsafe { store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME) } {
        Ok(v) => v,
        Err(_) => return "(unknown)".to_string(),
    };
    let mut buf = [0u16; 256];
    let ok = unsafe { StructuredStorage::PropVariantToString(&pv, &mut buf) }.is_ok();
    unsafe {
        let _ = StructuredStorage::PropVariantClear(&mut pv);
    }
    if !ok {
        return "(unknown)".to_string();
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn default_endpoint_id(
    enumerator: &IMMDeviceEnumerator,
    flow: windows::Win32::Media::Audio::EDataFlow,
    role: windows::Win32::Media::Audio::ERole,
) -> Option<String> {
    unsafe { enumerator.GetDefaultAudioEndpoint(flow, role) }
        .ok()
        .map(|d| device_id(&d))
}

/// 枚举 render + capture 两个方向的 ACTIVE 端点（含默认标记与混音格式）。
pub fn enumerate_endpoints() -> EnumerateResult {
    let mut result = EnumerateResult {
        endpoints: Vec::new(),
        errors: Vec::new(),
    };
    ensure_com();
    let enumerator: IMMDeviceEnumerator = match unsafe {
        CoCreateInstance(&CLSID_MMDEVICE_ENUMERATOR, None::<&IUnknown>, CLSCTX_ALL)
    } {
        Ok(e) => e,
        Err(e) => {
            result
                .errors
                .push(format!("CoCreateInstance(MMDeviceEnumerator) failed: {e}"));
            return result;
        }
    };
    let def_render_console = default_endpoint_id(&enumerator, eRender, eConsole);
    let def_render_comm = default_endpoint_id(&enumerator, eRender, eCommunications);
    let def_capture_console = default_endpoint_id(&enumerator, eCapture, eConsole);
    let def_capture_comm = default_endpoint_id(&enumerator, eCapture, eCommunications);
    for (flow, flow_name, def_console, def_comm) in [
        (eRender, "render", &def_render_console, &def_render_comm),
        (eCapture, "capture", &def_capture_console, &def_capture_comm),
    ] {
        let collection = match unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) } {
            Ok(c) => c,
            Err(e) => {
                result
                    .errors
                    .push(format!("EnumAudioEndpoints({flow_name}) failed: {e}"));
                continue;
            }
        };
        let count = unsafe { collection.GetCount() }.unwrap_or(0);
        for i in 0..count {
            let device = match unsafe { collection.Item(i) } {
                Ok(d) => d,
                Err(e) => {
                    result.errors.push(format!(
                        "IMMDeviceCollection::Item({flow_name},{i}) failed: {e}"
                    ));
                    continue;
                }
            };
            let id = device_id(&device);
            let name = device_friendly_name(&device);
            let mix = match unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) } {
                Ok(client) => match unsafe { client.GetMixFormat() } {
                    Ok(ptr) => {
                        let parsed = detect_format(ptr);
                        unsafe { CoTaskMemFree(Some(ptr as *const core::ffi::c_void)) };
                        parsed.ok()
                    }
                    Err(_) => None,
                },
                Err(_) => None,
            };
            result.endpoints.push(EndpointInfo {
                default_console: def_console.as_deref() == Some(id.as_str()),
                default_communications: def_comm.as_deref() == Some(id.as_str()),
                id,
                name,
                flow: flow_name,
                mix,
            });
        }
    }
    result
}

/// 把端点枚举结果写成文本证据。
pub fn write_endpoint_report(path: &Path, enumeration: &EnumerateResult) {
    let mut text = String::new();
    text.push_str(
        "# WASAPI ACTIVE endpoints (render + capture), enumerated by native-capture --list-audio\n",
    );
    text.push_str("# flags: default-console / default-communications; mix = device mix format\n");
    for e in &enumeration.endpoints {
        let mix = e
            .mix
            .map(|m| {
                format!(
                    "{} {}ch {}Hz bits={} block_align={}",
                    m.kind.name(),
                    m.channels,
                    m.sample_rate,
                    m.bits,
                    m.block_align
                )
            })
            .unwrap_or_else(|| "(unavailable)".to_string());
        text.push_str(&format!(
            "{}\t{}\t{}\t{}\tmix={}\n",
            e.flow,
            e.name,
            e.id,
            if e.default_console {
                "default-console"
            } else if e.default_communications {
                "default-communications"
            } else {
                ""
            },
            mix
        ));
    }
    for err in &enumeration.errors {
        text.push_str(&format!("error\t{err}\n"));
    }
    let _ = std::fs::write(path, text);
    logln!("[wasapi] wrote {}", path.display());
}

#[derive(Debug, Default)]
pub struct AudioOutcome {
    pub label: String,
    pub kind: &'static str,
    pub device_id: String,
    pub device_name: String,
    pub mix: Option<MixFormat>,
    /// 保留的帧数（不含暂停期间丢弃的帧）。
    pub frames: u64,
    /// 暂停期间从设备取出但丢弃的帧数。
    pub discarded_paused_frames: u64,
    /// 观察到的暂停窗口数（音频侧）。
    pub pause_windows_seen: u64,
    pub out_bytes: u64,
    pub wav_bytes: u64,
    pub silent_packets: u64,
    pub packets: u64,
    pub max_amplitude: i32,
    pub nonzero_samples: u64,
    pub start_instant: Option<Instant>,
    pub stop_instant: Option<Instant>,
    pub error: Option<String>,
    /// 第一个/最后一个数据包相对 `start_instant` 的秒数（诊断取包空洞）。
    pub first_packet_offset_s: f64,
    pub last_packet_offset_s: f64,
    /// 相邻两次取到包的最大墙钟间隔（毫秒，诊断 loopback 断流）。
    pub max_packet_gap_ms: f64,
    /// 仅 `keep_pcm=true` 时填充（短录分析用）。
    pub pcm: Vec<u8>,
}

impl AudioOutcome {
    pub fn duration_s(&self) -> f64 {
        match &self.mix {
            Some(m) if m.sample_rate > 0 => self.frames as f64 / m.sample_rate as f64,
            _ => 0.0,
        }
    }
    pub fn wall_s(&self) -> f64 {
        match (self.start_instant, self.stop_instant) {
            (Some(a), Some(b)) => (b - a).as_secs_f64(),
            _ => 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AudioSourceSpec {
    pub label: String,
    pub kind: AudioKind,
    pub endpoint_id: Option<String>,
    pub endpoint_name_hint: Option<String>,
    pub wav_path: Option<PathBuf>,
    pub keep_pcm: bool,
}

impl AudioSourceSpec {
    pub fn loopback(wav_path: Option<PathBuf>, keep_pcm: bool) -> Self {
        Self {
            label: "loopback".to_string(),
            kind: AudioKind::RenderLoopback,
            endpoint_id: None,
            endpoint_name_hint: None,
            wav_path,
            keep_pcm,
        }
    }

    pub fn second_source(wav_path: Option<PathBuf>, keep_pcm: bool) -> Self {
        Self {
            label: "second".to_string(),
            kind: AudioKind::CaptureDevice,
            endpoint_id: None,
            endpoint_name_hint: None,
            wav_path,
            keep_pcm,
        }
    }
}

pub struct AudioHandle {
    stop: Arc<AtomicBool>,
    start_time: Arc<Mutex<Option<Instant>>>,
    outcome: Arc<Mutex<Option<AudioOutcome>>>,
    error: Arc<Mutex<Option<String>>>,
    join: Option<JoinHandle<()>>,
    pub kind: &'static str,
}

impl AudioHandle {
    /// 启动采集线程并等待设备 `Start()`（最长 5 s）。`pause` 为共享暂停控制器（可选）。
    pub fn start(spec: AudioSourceSpec, pause: Option<PauseGate>) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let start_time = Arc::new(Mutex::new(None));
        let outcome = Arc::new(Mutex::new(None));
        let error = Arc::new(Mutex::new(None));
        let (stop_t, start_t, outcome_t, error_t) = (
            stop.clone(),
            start_time.clone(),
            outcome.clone(),
            error.clone(),
        );
        let kind_name = spec.kind.flow_name();
        let join = std::thread::Builder::new()
            .name(format!("wasapi-{}", spec.label))
            .spawn(move || {
                let result = capture_thread(&stop_t, &start_t, &spec, pause);
                match result {
                    Ok(mut out) => {
                        out.stop_instant = Some(Instant::now());
                        if let Ok(mut slot) = outcome_t.lock() {
                            *slot = Some(out);
                        }
                    }
                    Err(err) => {
                        logln!("[wasapi:{}] FAILED (raw error): {err}", spec.label);
                        if let Ok(mut slot) = error_t.lock() {
                            *slot = Some(err);
                        }
                    }
                }
            })
            .map_err(|e| format!("spawn wasapi thread failed: {e}"))?;

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(err) = error.lock() {
                if let Some(err) = err.clone() {
                    let _ = join.join();
                    return Err(err);
                }
            }
            if let Ok(t) = start_time.lock() {
                if t.is_some() {
                    break;
                }
            }
            if Instant::now() > deadline {
                let _ = join.join();
                return Err(format!(
                    "WASAPI source '{}' did not reach Start() within 5s",
                    kind_name
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(Self {
            stop,
            start_time,
            outcome,
            error,
            join: Some(join),
            kind: kind_name,
        })
    }

    pub fn start_instant(&self) -> Option<Instant> {
        self.start_time.lock().ok().and_then(|t| *t)
    }

    pub fn stop(mut self) -> AudioOutcome {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        let slot = self.outcome.lock().ok().and_then(|mut s| s.take());
        match slot {
            Some(o) => o,
            None => {
                let err = self.error.lock().ok().and_then(|e| e.clone());
                AudioOutcome {
                    label: "unknown".to_string(),
                    kind: self.kind,
                    error: err.or_else(|| Some("wasapi thread ended without outcome".to_string())),
                    start_instant: self.start_instant(),
                    ..Default::default()
                }
            }
        }
    }
}

fn detect_format(format: *const WAVEFORMATEX) -> Result<MixFormat, String> {
    if format.is_null() {
        return Err("GetMixFormat returned null".to_string());
    }
    let base: WAVEFORMATEX = unsafe { std::ptr::read_unaligned(format) };
    let tag_raw = base.wFormatTag;
    let channels = base.nChannels;
    let sample_rate = base.nSamplesPerSec;
    let block_align = base.nBlockAlign;
    let bits_per_sample = base.wBitsPerSample;
    let ext_subformat = if tag_raw == WAVE_FORMAT_EXTENSIBLE {
        Some(unsafe {
            std::ptr::addr_of!((*(format as *const WAVEFORMATEXTENSIBLE)).SubFormat)
                .read_unaligned()
        })
    } else {
        None
    };
    let (kind, tag) = match tag_raw {
        WAVE_FORMAT_PCM => match bits_per_sample {
            16 => (SampleKind::I16, tag_raw),
            32 => (SampleKind::I32, tag_raw),
            8 => (SampleKind::U8, tag_raw),
            bits => return Err(format!("unsupported PCM bit depth: {bits}")),
        },
        WAVE_FORMAT_IEEE_FLOAT => {
            if bits_per_sample != 32 {
                return Err(format!(
                    "unsupported float bit depth: {bits_per_sample} (only float32)"
                ));
            }
            (SampleKind::F32, tag_raw)
        }
        WAVE_FORMAT_EXTENSIBLE => {
            let sub = ext_subformat.ok_or_else(|| "missing extensible SubFormat".to_string())?;
            if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                (SampleKind::F32, tag_raw)
            } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
                match bits_per_sample {
                    16 => (SampleKind::I16, tag_raw),
                    32 => (SampleKind::I32, tag_raw),
                    8 => (SampleKind::U8, tag_raw),
                    bits => return Err(format!("unsupported extensible PCM bit depth: {bits}")),
                }
            } else {
                return Err(format!(
                    "unsupported WAVEFORMATEXTENSIBLE SubFormat {sub:?}"
                ));
            }
        }
        tag => return Err(format!("unsupported wFormatTag: 0x{tag:04X}")),
    };
    Ok(MixFormat {
        kind,
        channels,
        sample_rate,
        block_align,
        bits: bits_per_sample,
        tag,
    })
}

#[inline]
fn read_sample(data: &[u8], kind: SampleKind, index: usize) -> i16 {
    match kind {
        SampleKind::F32 => {
            let off = index * 4;
            if off + 3 >= data.len() {
                return 0;
            }
            let v = f32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            (v.clamp(-1.0, 1.0) * 32767.0) as i16
        }
        SampleKind::I16 => {
            let off = index * 2;
            if off + 1 >= data.len() {
                return 0;
            }
            i16::from_le_bytes([data[off], data[off + 1]])
        }
        SampleKind::I32 => {
            let off = index * 4;
            if off + 3 >= data.len() {
                return 0;
            }
            let v = i32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            (v >> 16) as i16
        }
        SampleKind::U8 => {
            if index >= data.len() {
                return 0;
            }
            ((data[index] as i16) - 128) << 8
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn append_packet(
    mut out: Option<&mut Vec<u8>>,
    wav: &mut Option<WavWriter>,
    data: &[u8],
    frames: usize,
    mix: &MixFormat,
    out_channels: u16,
    max_amp: &mut i32,
    nonzero: &mut u64,
) {
    let src_ch = mix.channels as usize;
    let out_ch = out_channels as usize;
    if out_ch == 0 {
        return;
    }
    let mut block = Vec::with_capacity(frames * out_ch * 2);
    for f in 0..frames {
        for c in 0..out_ch {
            let src_c = c.min(src_ch.saturating_sub(1));
            let idx = f * src_ch + src_c;
            let sample = read_sample(data, mix.kind, idx);
            let amp = (sample as i32).abs();
            if amp > *max_amp {
                *max_amp = amp;
            }
            if sample != 0 {
                *nonzero += 1;
            }
            block.extend_from_slice(&sample.to_le_bytes());
        }
    }
    if let Some(w) = wav.as_mut() {
        if let Err(e) = w.append(&block) {
            logln!("[wasapi] WAV append failed: {e}");
        }
    }
    if let Some(out) = out.as_mut() {
        out.extend_from_slice(&block);
    }
}

fn capture_thread(
    stop: &AtomicBool,
    start_time: &Mutex<Option<Instant>>,
    spec: &AudioSourceSpec,
    pause: Option<PauseGate>,
) -> Result<AudioOutcome, String> {
    ensure_com();
    let result = capture_impl(stop, start_time, spec, pause);
    unsafe { CoUninitialize() };
    result
}

fn resolve_device(
    enumerator: &IMMDeviceEnumerator,
    spec: &AudioSourceSpec,
) -> Result<(IMMDevice, String, AudioKind), String> {
    if let Some(id) = &spec.endpoint_id {
        let wide = HSTRING::from(id.as_str());
        let device = unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
            .map_err(|e| format!("IMMDeviceEnumerator::GetDevice({id}) failed: {e}"))?;
        let resolved_id = device_id(&device);
        return Ok((device, resolved_id, spec.kind));
    }
    if let Some(hint) = &spec.endpoint_name_hint {
        let flow = match spec.kind {
            AudioKind::RenderLoopback => eRender,
            AudioKind::CaptureDevice => eCapture,
        };
        if let Ok(collection) = unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }
        {
            let count = unsafe { collection.GetCount() }.unwrap_or(0);
            for i in 0..count {
                if let Ok(device) = unsafe { collection.Item(i) } {
                    let name = device_friendly_name(&device);
                    if name.to_lowercase().contains(&hint.to_lowercase()) {
                        let resolved_id = device_id(&device);
                        logln!(
                            "[wasapi] matched endpoint by name hint {:?}: {} ({})",
                            hint,
                            name,
                            resolved_id
                        );
                        return Ok((device, resolved_id, spec.kind));
                    }
                }
            }
        }
        logln!(
            "[wasapi] no ACTIVE {} endpoint matched name hint {:?}; falling back to default",
            spec.kind.flow_name(),
            hint
        );
    }
    let device = match spec.kind {
        AudioKind::RenderLoopback => {
            unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
                .map_err(|e| format!("GetDefaultAudioEndpoint(eRender,eConsole) failed: {e}"))?
        }
        AudioKind::CaptureDevice => {
            match unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) } {
                Ok(d) => d,
                Err(_) => unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) }
                    .map_err(|e| format!("GetDefaultAudioEndpoint(eCapture,...) failed: {e}"))?,
            }
        }
    };
    let id = device_id(&device);
    Ok((device, id, spec.kind))
}

fn capture_impl(
    stop: &AtomicBool,
    start_time: &Mutex<Option<Instant>>,
    spec: &AudioSourceSpec,
    pause: Option<PauseGate>,
) -> Result<AudioOutcome, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&CLSID_MMDEVICE_ENUMERATOR, None::<&IUnknown>, CLSCTX_ALL) }
            .map_err(|e| format!("CoCreateInstance(MMDeviceEnumerator) failed: {e}"))?;
    let (device, device_id_string, _kind) = resolve_device(&enumerator, spec)?;
    let device_name = device_friendly_name(&device);
    logln!(
        "[wasapi:{}] {} endpoint id={} name={:?}",
        spec.label,
        spec.kind.flow_name(),
        device_id_string,
        device_name
    );

    let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|e| format!("IMMDevice::Activate(IAudioClient) failed: {e}"))?;
    let mix_ptr = unsafe { audio_client.GetMixFormat() }
        .map_err(|e| format!("IAudioClient::GetMixFormat failed: {e}"))?;
    let mix = match detect_format(mix_ptr) {
        Ok(m) => m,
        Err(e) => {
            unsafe { CoTaskMemFree(Some(mix_ptr as *const core::ffi::c_void)) };
            return Err(e);
        }
    };
    logln!(
        "[wasapi:{}] mix format: tag=0x{:04X} kind={} channels={} rate={} bits={} block_align={}",
        spec.label,
        mix.tag,
        mix.kind.name(),
        mix.channels,
        mix.sample_rate,
        mix.bits,
        mix.block_align
    );
    let stream_flags = match spec.kind {
        AudioKind::RenderLoopback => AUDCLNT_STREAMFLAGS_LOOPBACK,
        AudioKind::CaptureDevice => 0,
    };
    let init = unsafe {
        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            stream_flags,
            10_000_000, // 1s buffer
            0,
            mix_ptr,
            None,
        )
    };
    unsafe { CoTaskMemFree(Some(mix_ptr as *const core::ffi::c_void)) };
    init.map_err(|e| {
        format!(
            "IAudioClient::Initialize({}) failed: {e}",
            spec.kind.flow_name()
        )
    })?;
    let capture: IAudioCaptureClient = unsafe { audio_client.GetService() }
        .map_err(|e| format!("IAudioClient::GetService(IAudioCaptureClient) failed: {e}"))?;

    let out_channels = mix.channels.min(2);
    let mut wav = match &spec.wav_path {
        Some(path) => Some(
            WavWriter::open(path, mix.sample_rate, out_channels)
                .map_err(|e| format!("open WAV {} failed: {e}", path.display()))?,
        ),
        None => None,
    };
    let mut out: Vec<u8> = if spec.keep_pcm {
        Vec::with_capacity((mix.sample_rate as usize * out_channels as usize * 2 * 15).max(4096))
    } else {
        Vec::new()
    };
    let mut outcome = AudioOutcome {
        label: spec.label.clone(),
        kind: spec.kind.flow_name(),
        device_id: device_id_string,
        device_name,
        mix: Some(mix),
        ..Default::default()
    };
    let keep_pcm = spec.keep_pcm;

    unsafe { audio_client.Start() }.map_err(|e| format!("IAudioClient::Start failed: {e}"))?;
    let started = Instant::now();
    if let Ok(mut slot) = start_time.lock() {
        *slot = Some(started);
    }

    let mut max_amp = 0i32;
    let mut nonzero = 0u64;
    let mut read_error: Option<String> = None;
    let mut was_paused = false;
    let mut last_packet_at: Option<Instant> = None;
    let mut max_packet_gap_ms = 0.0f64;
    let mut first_packet_offset_s = -1.0f64;
    let mut last_packet_offset_s = -1.0f64;
    while !stop.load(Ordering::Relaxed) {
        let paused = pause.as_ref().map(|p| p.is_paused()).unwrap_or(false);
        if paused && !was_paused {
            outcome.pause_windows_seen += 1;
        }
        was_paused = paused;
        loop {
            let pending = match unsafe { capture.GetNextPacketSize() } {
                Ok(n) => n,
                Err(e) => {
                    read_error = Some(format!(
                        "IAudioCaptureClient::GetNextPacketSize failed: {e}"
                    ));
                    break;
                }
            };
            if pending == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            let mut device_pos: u64 = 0;
            let mut qpc_pos: u64 = 0;
            let got = unsafe {
                capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut device_pos),
                    Some(&mut qpc_pos),
                )
            };
            if let Err(e) = got {
                read_error = Some(format!("IAudioCaptureClient::GetBuffer failed: {e}"));
                break;
            }
            if frames == 0 {
                break;
            }
            outcome.packets += 1;
            let now = Instant::now();
            let offset = (now - started).as_secs_f64();
            if first_packet_offset_s < 0.0 {
                first_packet_offset_s = offset;
            }
            if let Some(prev) = last_packet_at {
                let gap_ms = (now - prev).as_secs_f64() * 1000.0;
                if gap_ms > max_packet_gap_ms {
                    max_packet_gap_ms = gap_ms;
                }
            }
            last_packet_at = Some(now);
            last_packet_offset_s = offset;
            if paused {
                // 暂停期间继续释放设备缓冲，但不写媒体时间轴。
                outcome.discarded_paused_frames += frames as u64;
                if let Err(e) = unsafe { capture.ReleaseBuffer(frames) } {
                    read_error = Some(format!("IAudioCaptureClient::ReleaseBuffer failed: {e}"));
                    break;
                }
                continue;
            }
            let silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;
            if silent || data.is_null() {
                outcome.silent_packets += 1;
                let zeros = frames as usize * out_channels as usize * 2;
                let block = vec![0u8; zeros];
                if let Some(w) = wav.as_mut() {
                    let _ = w.append(&block);
                }
                if keep_pcm {
                    out.extend_from_slice(&block);
                }
            } else {
                let bytes = frames as usize * mix.block_align as usize;
                let slice = unsafe { std::slice::from_raw_parts(data, bytes) };
                append_packet(
                    if keep_pcm { Some(&mut out) } else { None },
                    &mut wav,
                    slice,
                    frames as usize,
                    &mix,
                    out_channels,
                    &mut max_amp,
                    &mut nonzero,
                );
            }
            outcome.frames += frames as u64;
            if let Err(e) = unsafe { capture.ReleaseBuffer(frames) } {
                read_error = Some(format!("IAudioCaptureClient::ReleaseBuffer failed: {e}"));
                break;
            }
        }
        if read_error.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let _ = unsafe { audio_client.Stop() };
    outcome.stop_instant = Some(Instant::now());
    outcome.out_bytes = out.len() as u64;
    if let Some(w) = wav {
        match w.finish() {
            Ok(bytes) => outcome.wav_bytes = bytes,
            Err(e) => logln!("[wasapi:{}] WAV finalize failed: {e}", spec.label),
        }
    }
    outcome.max_amplitude = max_amp;
    outcome.nonzero_samples = nonzero;
    outcome.error = read_error;
    outcome.start_instant = Some(started);
    outcome.first_packet_offset_s = first_packet_offset_s;
    outcome.last_packet_offset_s = last_packet_offset_s;
    outcome.max_packet_gap_ms = max_packet_gap_ms;
    outcome.pcm = out;
    logln!(
        "[wasapi:{}] done: device={:?} frames={} discarded_paused={} packets={} silent={} wav={}B duration={:.3}s wall={:.3}s",
        spec.label,
        outcome.device_name,
        outcome.frames,
        outcome.discarded_paused_frames,
        outcome.packets,
        outcome.silent_packets,
        outcome.wav_bytes,
        outcome.duration_s(),
        outcome.wall_s()
    );
    Ok(outcome)
}

/// 流式 WAV 写入器：先写占位头，收尾时回填 RIFF/data 大小。
pub struct WavWriter {
    file: std::fs::File,
    data_bytes: u64,
}

impl WavWriter {
    pub fn open(path: &Path, rate: u32, channels: u16) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {e}"))?;
        }
        use std::io::Write;
        let mut file =
            std::fs::File::create(path).map_err(|e| format!("create wav failed: {e}"))?;
        let byte_rate = rate * channels as u32 * 2;
        let block_align = channels * 2;
        let mut header = Vec::with_capacity(44);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&0u32.to_le_bytes()); // patched on finish
        header.extend_from_slice(b"WAVE");
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes()); // PCM
        header.extend_from_slice(&channels.to_le_bytes());
        header.extend_from_slice(&rate.to_le_bytes());
        header.extend_from_slice(&byte_rate.to_le_bytes());
        header.extend_from_slice(&block_align.to_le_bytes());
        header.extend_from_slice(&16u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&0u32.to_le_bytes()); // patched on finish
        file.write_all(&header)
            .map_err(|e| format!("write wav header failed: {e}"))?;
        Ok(Self {
            file,
            data_bytes: 0,
        })
    }

    pub fn append(&mut self, pcm: &[u8]) -> Result<(), String> {
        use std::io::Write;
        self.file
            .write_all(pcm)
            .map_err(|e| format!("write wav pcm failed: {e}"))?;
        self.data_bytes += pcm.len() as u64;
        Ok(())
    }

    pub fn data_bytes(&self) -> u64 {
        self.data_bytes
    }

    pub fn finish(mut self) -> Result<u64, String> {
        use std::io::{Seek, SeekFrom, Write};
        let data = self.data_bytes.min(u32::MAX as u64) as u32;
        let riff = 36u32.saturating_add(data);
        self.file
            .seek(SeekFrom::Start(4))
            .and_then(|_| self.file.write_all(&riff.to_le_bytes()))
            .map_err(|e| format!("patch RIFF size failed: {e}"))?;
        self.file
            .seek(SeekFrom::Start(40))
            .and_then(|_| self.file.write_all(&data.to_le_bytes()))
            .map_err(|e| format!("patch data size failed: {e}"))?;
        self.file
            .flush()
            .map_err(|e| format!("flush wav failed: {e}"))?;
        Ok(44 + self.data_bytes)
    }
}

/// 整段内存 PCM 写 WAV（混音输出等短数据用）。返回文件字节数。
pub fn write_wav(path: &Path, rate: u32, channels: u16, pcm: &[u8]) -> Result<u64, String> {
    let mut w = WavWriter::open(path, rate, channels)?;
    w.append(pcm)?;
    w.finish()
}

/// 读取 16-bit PCM WAV（只支持本原型自己写的格式），返回 (rate, channels, pcm)。
pub fn read_wav(path: &Path) -> Result<(u32, u16, Vec<u8>), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{} is not a RIFF/WAVE file", path.display()));
    }
    let mut pos = 12usize;
    let mut rate = 0u32;
    let mut channels = 0u16;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let fmt = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
            channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
            rate = u32::from_le_bytes([
                bytes[body + 4],
                bytes[body + 5],
                bytes[body + 6],
                bytes[body + 7],
            ]);
            let bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            if fmt != 1 || bits != 16 {
                return Err(format!(
                    "unsupported WAV format in {}: fmt={fmt} bits={bits}",
                    path.display()
                ));
            }
        } else if id == b"data" {
            let end = (body + size).min(bytes.len());
            return Ok((rate, channels, bytes[body..end].to_vec()));
        }
        pos = body.saturating_add(size);
    }
    Err(format!("{}: no data chunk found", path.display()))
}

/// 两路 s16 立体声 PCM 混音（饱和相加）。返回 (pcm, clipped_samples, peak)。
pub fn mix_pcm(a: &[u8], b: &[u8]) -> (Vec<u8>, u64, i32) {
    let frames = (a.len().min(b.len())) / 2;
    let mut out = Vec::with_capacity(frames * 2);
    let mut clipped = 0u64;
    let mut peak = 0i32;
    for i in 0..frames {
        let va = i16::from_le_bytes([a[i * 2], a[i * 2 + 1]]) as i32;
        let vb = i16::from_le_bytes([b[i * 2], b[i * 2 + 1]]) as i32;
        let mut sum = va + vb;
        if sum > i16::MAX as i32 {
            sum = i16::MAX as i32;
            clipped += 1;
        } else if sum < i16::MIN as i32 {
            sum = i16::MIN as i32;
            clipped += 1;
        }
        let amp = sum.abs();
        if amp > peak {
            peak = amp;
        }
        out.extend_from_slice(&(sum as i16).to_le_bytes());
    }
    (out, clipped, peak)
}

/// 线性插值重采样（仅当两路采样率不同时使用；R0 只用于合成数据）。
pub fn resample_linear(pcm: &[u8], channels: u16, from_rate: u32, to_rate: u32) -> Vec<u8> {
    if from_rate == to_rate || from_rate == 0 || to_rate == 0 {
        return pcm.to_vec();
    }
    let ch = channels.max(1) as usize;
    let in_frames = pcm.len() / (2 * ch);
    if in_frames == 0 {
        return Vec::new();
    }
    let out_frames = (in_frames as f64 * to_rate as f64 / from_rate as f64)
        .round()
        .max(1.0) as usize;
    let mut out = Vec::with_capacity(out_frames * ch * 2);
    for f in 0..out_frames {
        let pos = f as f64 * from_rate as f64 / to_rate as f64;
        let i0 = pos.floor() as usize;
        let frac = pos - i0 as f64;
        let i1 = (i0 + 1).min(in_frames - 1);
        for c in 0..ch {
            let s = |idx: usize| -> f64 {
                let off = (idx * ch + c) * 2;
                if off + 1 >= pcm.len() {
                    0.0
                } else {
                    i16::from_le_bytes([pcm[off], pcm[off + 1]]) as f64
                }
            };
            let v = s(i0) * (1.0 - frac) + s(i1) * frac;
            let v = v.clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 合成测试音渲染（让 loopback 在没有外部播放器时也有确定内容）
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ToneOutcome {
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub mix: Option<MixFormat>,
    pub frames_written: u64,
    pub duration_s: f64,
    pub amplitude: f64,
    pub frequency_hz: f64,
    pub start_instant: Option<Instant>,
    pub stop_instant: Option<Instant>,
    pub error: Option<String>,
}

pub struct ToneHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    outcome: Arc<Mutex<Option<ToneOutcome>>>,
    pub start_instant: Option<Instant>,
}

impl ToneHandle {
    /// 向 render 端点渲染正弦音。`amplitude` 为 0..1 的线性幅度（0 表示静音流）。
    pub fn start(
        endpoint_id: Option<String>,
        endpoint_name_hint: Option<String>,
        frequency_hz: f64,
        amplitude: f64,
        seconds: f64,
        delay_ms: u64,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let outcome = Arc::new(Mutex::new(None));
        let (stop_t, outcome_t) = (stop.clone(), outcome.clone());
        let (tx, rx) = std::sync::mpsc::channel::<Result<Instant, String>>();
        let join = std::thread::Builder::new()
            .name("wasapi-tone".into())
            .spawn(move || {
                let result = tone_thread(
                    &stop_t,
                    endpoint_id.as_deref(),
                    endpoint_name_hint.as_deref(),
                    frequency_hz,
                    amplitude,
                    seconds,
                    delay_ms,
                    &tx,
                );
                match result {
                    Ok(mut out) => {
                        out.stop_instant = Some(Instant::now());
                        if let Ok(mut slot) = outcome_t.lock() {
                            *slot = Some(out);
                        }
                    }
                    Err(e) => {
                        logln!("[wasapi:tone] FAILED (raw error): {e}");
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| format!("spawn tone thread failed: {e}"))?;
        let start_instant = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(t)) => Some(t),
            Ok(Err(e)) => {
                let _ = join.join();
                return Err(e);
            }
            Err(e) => {
                let _ = join.join();
                return Err(format!("tone renderer did not start within 5s: {e}"));
            }
        };
        Ok(Self {
            stop,
            join: Some(join),
            outcome,
            start_instant,
        })
    }

    pub fn stop(mut self) -> ToneOutcome {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        self.outcome
            .lock()
            .ok()
            .and_then(|mut s| s.take())
            .unwrap_or_default()
    }
}

#[allow(clippy::too_many_arguments)]
fn tone_thread(
    stop: &AtomicBool,
    endpoint_id: Option<&str>,
    endpoint_name_hint: Option<&str>,
    frequency_hz: f64,
    amplitude: f64,
    seconds: f64,
    delay_ms: u64,
    tx: &std::sync::mpsc::Sender<Result<Instant, String>>,
) -> Result<ToneOutcome, String> {
    ensure_com();
    let spec = AudioSourceSpec {
        label: "tone".to_string(),
        kind: AudioKind::RenderLoopback,
        endpoint_id: endpoint_id.map(|s| s.to_string()),
        endpoint_name_hint: endpoint_name_hint.map(|s| s.to_string()),
        wav_path: None,
        keep_pcm: false,
    };
    let result = (|| -> Result<ToneOutcome, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&CLSID_MMDEVICE_ENUMERATOR, None::<&IUnknown>, CLSCTX_ALL) }
                .map_err(|e| format!("CoCreateInstance(MMDeviceEnumerator) failed: {e}"))?;
        // 渲染端点也用 GetDefaultAudioEndpoint(eRender) 或显式 id；复用 resolve_device 的显式 id 分支。
        let (device, id, _) = resolve_device(&enumerator, &spec)?;
        let name = device_friendly_name(&device);
        logln!(
            "[wasapi:tone] render endpoint id={} name={:?} freq={:.1}Hz amp={:.4} seconds={:.3}",
            id,
            name,
            frequency_hz,
            amplitude,
            seconds
        );
        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| format!("IMMDevice::Activate(IAudioClient) failed: {e}"))?;
        let mix_ptr = unsafe { client.GetMixFormat() }
            .map_err(|e| format!("IAudioClient::GetMixFormat failed: {e}"))?;
        let mix = match detect_format(mix_ptr) {
            Ok(m) => m,
            Err(e) => {
                unsafe { CoTaskMemFree(Some(mix_ptr as *const core::ffi::c_void)) };
                return Err(e);
            }
        };
        let init =
            unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10_000_000, 0, mix_ptr, None) };
        unsafe { CoTaskMemFree(Some(mix_ptr as *const core::ffi::c_void)) };
        init.map_err(|e| format!("IAudioClient::Initialize(render tone) failed: {e}"))?;
        let render: IAudioRenderClient = unsafe { client.GetService() }
            .map_err(|e| format!("IAudioClient::GetService(IAudioRenderClient) failed: {e}"))?;
        let buffer_size = unsafe { client.GetBufferSize() }
            .map_err(|e| format!("IAudioClient::GetBufferSize failed: {e}"))?;
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        unsafe { client.Start() }
            .map_err(|e| format!("IAudioClient::Start(render tone) failed: {e}"))?;
        let started = Instant::now();
        let _ = tx.send(Ok(started));
        let mut outcome = ToneOutcome {
            endpoint_id: id,
            endpoint_name: name,
            mix: Some(mix),
            amplitude,
            frequency_hz,
            start_instant: Some(started),
            ..Default::default()
        };
        let frames_total = (seconds.max(0.0) * mix.sample_rate as f64).max(0.0) as u64;
        let mut written = 0u64;
        let mut phase = 0.0f64;
        let write_chunk = (buffer_size / 4).clamp(64, 1024);
        let mut write_error: Option<String> = None;
        while written < frames_total && !stop.load(Ordering::Relaxed) {
            let available = match unsafe { client.GetCurrentPadding() } {
                Ok(padding) => buffer_size.saturating_sub(padding),
                Err(e) => {
                    write_error = Some(format!("GetCurrentPadding failed: {e}"));
                    break;
                }
            };
            if available == 0 {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            let frames = available
                .min(write_chunk)
                .min((frames_total - written) as u32);
            if frames == 0 {
                break;
            }
            let ptr = match unsafe { render.GetBuffer(frames) } {
                Ok(p) => p,
                Err(e) => {
                    write_error = Some(format!("IAudioRenderClient::GetBuffer failed: {e}"));
                    break;
                }
            };
            let bytes = frames as usize * mix.block_align as usize;
            let slice = unsafe { std::slice::from_raw_parts_mut(ptr, bytes) };
            let ch = mix.channels as usize;
            let step = 2.0 * std::f64::consts::PI * frequency_hz / mix.sample_rate as f64;
            for f in 0..frames as usize {
                let v = (phase.sin() * amplitude).clamp(-1.0, 1.0);
                phase += step;
                if phase > std::f64::consts::TAU {
                    phase -= std::f64::consts::TAU;
                }
                for c in 0..ch {
                    match mix.kind {
                        SampleKind::F32 => {
                            let off = (f * ch + c) * 4;
                            if off + 3 < slice.len() {
                                slice[off..off + 4].copy_from_slice(&(v as f32).to_le_bytes());
                            }
                        }
                        SampleKind::I16 => {
                            let off = (f * ch + c) * 2;
                            if off + 1 < slice.len() {
                                let s = (v * 32767.0) as i16;
                                slice[off..off + 2].copy_from_slice(&s.to_le_bytes());
                            }
                        }
                        SampleKind::I32 => {
                            let off = (f * ch + c) * 4;
                            if off + 3 < slice.len() {
                                let s = (v * (i32::MAX as f64)) as i32;
                                slice[off..off + 4].copy_from_slice(&s.to_le_bytes());
                            }
                        }
                        SampleKind::U8 => {
                            let off = f * ch + c;
                            if off < slice.len() {
                                slice[off] = ((v * 127.0) as i16 + 128) as u8;
                            }
                        }
                    }
                }
            }
            if let Err(e) = unsafe { render.ReleaseBuffer(frames, 0) } {
                write_error = Some(format!("IAudioRenderClient::ReleaseBuffer failed: {e}"));
                break;
            }
            written += frames as u64;
        }
        let _ = unsafe { client.Stop() };
        outcome.frames_written = written;
        outcome.duration_s = written as f64 / mix.sample_rate as f64;
        outcome.error = write_error;
        outcome.stop_instant = Some(Instant::now());
        logln!(
            "[wasapi:tone] done: frames={} duration={:.3}s endpoint={:?}",
            written,
            outcome.duration_s,
            outcome.endpoint_name
        );
        Ok(outcome)
    })();
    unsafe { CoUninitialize() };
    result
}

/// 从端点枚举里挑一个可用的第二音源（默认 capture console，其次名称含“麦克风/mic”的项）。
pub fn choose_second_source_endpoint(enumeration: &EnumerateResult) -> Option<EndpointInfo> {
    let captures: Vec<&EndpointInfo> = enumeration
        .endpoints
        .iter()
        .filter(|e| e.flow == "capture")
        .collect();
    if captures.is_empty() {
        return None;
    }
    if let Some(e) = captures.iter().find(|e| e.default_console) {
        return Some((*e).clone());
    }
    if let Some(e) = captures.iter().find(|e| {
        let n = e.name.to_lowercase();
        n.contains("麦克风") || n.contains("mic") || n.contains("microphone")
    }) {
        return Some((*e).clone());
    }
    Some(captures[0].clone())
}
