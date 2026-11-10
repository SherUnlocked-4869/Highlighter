//! WASAPI loopback 系统声音采集 → 16-bit PCM WAV。
//!
//! 流程（MTA 线程内）：
//! `CoCreateInstance(CLSID_MMDeviceEnumerator)` → `GetDefaultAudioEndpoint(eRender, eConsole)`
//! → `IMMDevice::Activate(IAudioClient)` → `GetMixFormat` → `Initialize(SHARED, LOOPBACK, 1s, 0)`
//! → `GetService(IAudioCaptureClient)` → `Start()` → 轮询 `GetNextPacketSize/GetBuffer`。
//!
//! 语义边界（写进证据文档）：
//! - loopback 采集的是默认渲染端点的**系统混音**，不是麦克风；
//! - 采样率为设备混音格式（本机 48kHz），本原型统一转 16-bit PCM；
//! - 系统无音频播放时，音频引擎可能不产出包（或产出 SILENT 包），字节数会明显小于
//!   `秒数 × 采样率 × 声道 × 2`，必须如实报告，不得用静音数据冒充有效采样；
//! - 不处理设备热插拔/默认端点切换（R5 才做）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{IUnknown, GUID, HSTRING, PCWSTR};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

const CLSID_MMDEVICE_ENUMERATOR: GUID = GUID::from_u128(0xBCDE_0395_E52F_467C_8E3D_C457_9291_692E);
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00AA_0038_9B71);
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x0000_0003_0000_0010_8000_00AA_0038_9B71);
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

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

#[derive(Debug, Default)]
pub struct AudioOutcome {
    pub device_id: String,
    pub mix: Option<MixFormat>,
    pub frames: u64,
    pub out_bytes: u64,
    pub silent_packets: u64,
    pub packets: u64,
    pub max_amplitude: i32,
    pub nonzero_samples: u64,
    pub start_instant: Option<Instant>,
    pub stop_instant: Option<Instant>,
    pub error: Option<String>,
    /// 16-bit PCM（输出声道数；>2 声道设备截取前两声道）。
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

pub struct LoopbackHandle {
    stop: Arc<AtomicBool>,
    start_time: Arc<Mutex<Option<Instant>>>,
    outcome: Arc<Mutex<Option<AudioOutcome>>>,
    error: Arc<Mutex<Option<String>>>,
    join: Option<JoinHandle<()>>,
}

impl LoopbackHandle {
    pub fn start(endpoint_id: Option<&str>) -> Result<Self, String> {
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
        let endpoint = endpoint_id.map(|s| s.to_string());
        let join = std::thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || {
                let result = capture_thread(&stop_t, &start_t, &endpoint);
                match result {
                    Ok(mut out) => {
                        out.stop_instant = Some(Instant::now());
                        if let Ok(mut slot) = outcome_t.lock() {
                            *slot = Some(out);
                        }
                    }
                    Err(err) => {
                        logln!("[wasapi] FAILED (raw error): {err}");
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
                return Err("reserved: WASAPI did not reach Start() within 5s".to_string());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(Self {
            stop,
            start_time,
            outcome,
            error,
            join: Some(join),
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
        let mut slot = self.outcome.lock().ok().and_then(|mut s| s.take());
        if slot.is_none() {
            // 线程失败时把错误搬运到 outcome，保证调用方能看到原始错误。
            let err = self.error.lock().ok().and_then(|e| e.clone());
            slot = Some(AudioOutcome {
                error: err.or_else(|| Some("wasapi thread ended without outcome".to_string())),
                start_instant: self.start_instant(),
                ..Default::default()
            });
        }
        slot.unwrap()
    }
}

fn detect_format(format: *const WAVEFORMATEX) -> Result<MixFormat, String> {
    if format.is_null() {
        return Err("GetMixFormat returned null".to_string());
    }
    // WAVEFORMATEX / WAVEFORMATEXTENSIBLE 是 repr(C, packed(1))：不能形成对字段的
    // 引用，用 read_unaligned 先按值取出，再匹配。
    let base: WAVEFORMATEX = unsafe { std::ptr::read_unaligned(format) };
    // 先按值取出标量字段：WAVEFORMATEX 是 packed struct，直接 match/借用字段会触发
    // E0793（unaligned reference）。
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
            let v = f32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            let clamped = v.clamp(-1.0, 1.0);
            (clamped * 32767.0) as i16
        }
        SampleKind::I16 => {
            let off = index * 2;
            i16::from_le_bytes([data[off], data[off + 1]])
        }
        SampleKind::I32 => {
            let off = index * 4;
            let v = i32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            (v >> 16) as i16
        }
        SampleKind::U8 => ((data[index] as i16) - 128) << 8,
    }
}

/// 把设备混音格式的一包样本转成输出声道数（<=2，>2 时截取前两声道）的 s16 LE。
fn append_packet(
    out: &mut Vec<u8>,
    data: &[u8],
    frames: usize,
    mix: &MixFormat,
    out_channels: u16,
    max_amp: &mut i32,
    nonzero: &mut u64,
) {
    let src_ch = mix.channels as usize;
    let out_ch = out_channels as usize;
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
            out.extend_from_slice(&sample.to_le_bytes());
        }
    }
}

fn capture_thread(
    stop: &AtomicBool,
    start_time: &Mutex<Option<Instant>>,
    endpoint_id: &Option<String>,
) -> Result<AudioOutcome, String> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            logln!(
                "[wasapi] CoInitializeEx(MTA) returned {:?} (continuing)",
                hr
            );
        }
    }
    let result = capture_impl(stop, start_time, endpoint_id);
    unsafe { CoUninitialize() };
    result
}

fn capture_impl(
    stop: &AtomicBool,
    start_time: &Mutex<Option<Instant>>,
    endpoint_id: &Option<String>,
) -> Result<AudioOutcome, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&CLSID_MMDEVICE_ENUMERATOR, None::<&IUnknown>, CLSCTX_ALL) }
            .map_err(|e| format!("CoCreateInstance(MMDeviceEnumerator) failed: {e}"))?;

    let device = match endpoint_id {
        Some(id) => {
            let wide = HSTRING::from(id.as_str());
            logln!("[wasapi] using explicit endpoint id {id}");
            unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
                .map_err(|e| format!("IMMDeviceEnumerator::GetDevice({id}) failed: {e}"))?
        }
        None => unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|e| format!("GetDefaultAudioEndpoint(eRender,eConsole) failed: {e}"))?,
    };

    let device_id = unsafe { device.GetId() }
        .map(|p| {
            let s = unsafe { p.to_string() }.unwrap_or_default();
            unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
            s
        })
        .unwrap_or_else(|_| "(unknown)".to_string());
    logln!("[wasapi] default render endpoint id={device_id}");

    let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|e| format!("IMMDevice::Activate(IAudioClient) failed: {e}"))?;

    let mix_ptr = unsafe { audio_client.GetMixFormat() }
        .map_err(|e| format!("IAudioClient::GetMixFormat failed: {e}"))?;
    let mix = detect_format(mix_ptr);
    let mix = match mix {
        Ok(m) => m,
        Err(e) => {
            unsafe { CoTaskMemFree(Some(mix_ptr as *const core::ffi::c_void)) };
            return Err(e);
        }
    };
    logln!(
        "[wasapi] mix format: tag=0x{:04X} kind={} channels={} rate={} bits={} block_align={}",
        mix.tag,
        mix.kind.name(),
        mix.channels,
        mix.sample_rate,
        mix.bits,
        mix.block_align
    );

    let init = unsafe {
        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            10_000_000, // 1s buffer
            0,
            mix_ptr,
            None,
        )
    };
    unsafe { CoTaskMemFree(Some(mix_ptr as *const core::ffi::c_void)) };
    init.map_err(|e| format!("IAudioClient::Initialize(LOOPBACK) failed: {e}"))?;

    let capture: IAudioCaptureClient = unsafe { audio_client.GetService() }
        .map_err(|e| format!("IAudioClient::GetService(IAudioCaptureClient) failed: {e}"))?;

    let out_channels = mix.channels.min(2);
    let mut out: Vec<u8> =
        Vec::with_capacity((mix.sample_rate as usize * out_channels as usize * 2 * 15).max(4096));
    let mut outcome = AudioOutcome {
        device_id,
        mix: Some(mix),
        ..Default::default()
    };

    unsafe { audio_client.Start() }.map_err(|e| format!("IAudioClient::Start failed: {e}"))?;
    let started = Instant::now();
    if let Ok(mut slot) = start_time.lock() {
        *slot = Some(started);
    }

    let mut max_amp = 0i32;
    let mut nonzero = 0u64;
    let mut read_error: Option<String> = None;
    while !stop.load(Ordering::Relaxed) {
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
            let silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;
            if silent || data.is_null() {
                outcome.silent_packets += 1;
                let zeros = frames as usize * out_channels as usize * 2;
                out.resize(out.len() + zeros, 0);
            } else {
                let bytes = frames as usize * mix.block_align as usize;
                // SAFETY: GetBuffer 返回该包 bytes 字节的有效数据，ReleaseBuffer 前有效。
                let slice = unsafe { std::slice::from_raw_parts(data, bytes) };
                append_packet(
                    &mut out,
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
    outcome.max_amplitude = max_amp;
    outcome.nonzero_samples = nonzero;
    outcome.error = read_error;
    outcome.start_instant = Some(started);
    outcome.pcm = out;
    Ok(outcome)
}

/// 写 16-bit PCM WAV（单/双声道）。返回文件字节数。
pub fn write_wav(path: &Path, rate: u32, channels: u16, pcm: &[u8]) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {e}"))?;
    }
    let data_len = pcm.len() as u32;
    let byte_rate = rate * channels as u32 * 2;
    let block_align = channels * 2;
    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + data_len).to_le_bytes());
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
    header.extend_from_slice(&data_len.to_le_bytes());
    let mut file = std::fs::File::create(path).map_err(|e| format!("create wav failed: {e}"))?;
    use std::io::Write;
    file.write_all(&header)
        .and_then(|_| file.write_all(pcm))
        .map_err(|e| format!("write wav failed: {e}"))?;
    Ok((header.len() + pcm.len()) as u64)
}
