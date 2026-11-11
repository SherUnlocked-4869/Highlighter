//! 两路音源（系统 loopback vs 第二音源/麦克风）的对齐测量。
//!
//! 方法：把两路 s16 LE 交错 PCM 各自降混成单声道，再按整数因子降采样到约 8 kHz，
//! 在较短的窗口上做归一化互相关，搜索 ±`max_lag_ms` 内的最大相关峰。
//!
//! 语义边界：
//! - 只有在两路包含**同一物理/混音声源**时才有意义（例如把测试音同时渲染到扬声器并由
//!   麦克风拾音）；两路内容不相关时输出低相关峰，必须如实报告 `correlation` 值而不是只看 lag；
//! - 输出 lag 为 `mic` 相对 `loopback` 的延迟（正 = 第二音源更晚）；
//! - 8 kHz 降采样后的分辨率约 0.125 ms，报告按 0.1 ms 取整；
//! - 声学路径延迟（扬声器→麦克风）本身就是被测量对象，不是错误。

#[derive(Clone, Copy, Debug, Default)]
pub struct SyncLag {
    /// 第二路相对第一路的延迟（毫秒，正数表示第二路更晚）。
    pub lag_ms: f64,
    /// 归一化相关系数峰值（-1..1，越接近 1 越可信）。
    pub correlation: f64,
    /// 参与相关计算的样点数（降采样后）。
    pub samples: usize,
    /// 降采样因子。
    pub downsample: usize,
    pub sample_rate: u32,
}

/// 交错 s16 LE → 单声道 f64，同时按 `factor` 做整数抽取（带块内平均抗混叠）。
fn mono_downsampled(pcm: &[u8], channels: usize, factor: usize) -> Vec<f64> {
    let channels = channels.max(1);
    let frames = pcm.len() / (2 * channels);
    if frames == 0 || factor == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(frames / factor + 1);
    let mut acc = 0.0f64;
    let mut n = 0usize;
    for f in 0..frames {
        let mut sum = 0.0f64;
        for c in 0..channels {
            let off = (f * channels + c) * 2;
            if off + 1 >= pcm.len() {
                break;
            }
            let v = i16::from_le_bytes([pcm[off], pcm[off + 1]]) as f64;
            sum += v;
        }
        acc += sum / channels as f64;
        n += 1;
        if n == factor {
            out.push(acc / factor as f64);
            acc = 0.0;
            n = 0;
        }
    }
    out
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

/// 在 `segment` 上做归一化互相关：返回 (best_lag_samples, peak_corr)。
fn best_lag(a: &[f64], b: &[f64], max_lag: usize, min_overlap: usize) -> (i64, f64) {
    let n = a.len().min(b.len());
    if n == 0 || max_lag == 0 {
        return (0, 0.0);
    }
    let full_mean_a = mean(&a[..n]);
    let full_mean_b = mean(&b[..n]);
    let mut best = (0i64, f64::NEG_INFINITY);
    for lag in -(max_lag as i64)..=(max_lag as i64) {
        let (mut sa, mut sb) = (0.0f64, 0.0f64);
        let (mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0f64);
        let mut count = 0usize;
        let start_b = lag.max(0) as usize;
        let start_a = (-lag).max(0) as usize;
        let overlap = n.saturating_sub(start_b.max(start_a));
        if overlap < min_overlap {
            continue;
        }
        for k in 0..overlap {
            let va = a[start_a + k] - full_mean_a;
            let vb = b[start_b + k] - full_mean_b;
            sa += va;
            sb += vb;
            saa += va * va;
            sbb += vb * vb;
            sab += va * vb;
            count += 1;
        }
        if count < min_overlap || saa <= 0.0 || sbb <= 0.0 {
            continue;
        }
        // 去均值后的归一化相关（减掉窗口内均值影响）。
        let cov = sab / count as f64 - (sa / count as f64) * (sb / count as f64);
        let va = saa / count as f64 - (sa / count as f64).powi(2);
        let vb = sbb / count as f64 - (sb / count as f64).powi(2);
        if va <= 0.0 || vb <= 0.0 {
            continue;
        }
        let corr = cov / (va.sqrt() * vb.sqrt());
        if corr > best.1 {
            best = (lag, corr);
        }
    }
    best
}

/// 计算第二路相对第一路的时间差。`pcm_a`/`pcm_b` 均为 s16 LE 交错，`channels` 相同，
/// 采样率均为 `sample_rate`。
pub fn measure_lag(
    pcm_a: &[u8],
    pcm_b: &[u8],
    channels: usize,
    sample_rate: u32,
    max_lag_ms: f64,
    window_seconds: f64,
) -> Option<SyncLag> {
    if pcm_a.len() < 4 || pcm_b.len() < 4 || sample_rate == 0 {
        return None;
    }
    let target_hz = 8000.0;
    let factor = ((sample_rate as f64 / target_hz).round() as usize).max(1);
    let rate = sample_rate as f64 / factor as f64;
    let a_full = mono_downsampled(pcm_a, channels, factor);
    let b_full = mono_downsampled(pcm_b, channels, factor);
    let n = a_full.len().min(b_full.len());
    if n < 16 {
        return None;
    }
    // 取中间一段（避免起止静音影响），窗口不足以覆盖最大 lag 时自动收缩。
    let want = ((window_seconds * rate) as usize).clamp(16, n);
    let start = (n - want) / 2;
    let a = &a_full[start..start + want];
    let b = &b_full[start..start + want];
    let max_lag = ((max_lag_ms / 1000.0 * rate).ceil() as usize).max(1);
    let min_overlap = (want / 2).max(16);
    let (lag_samples, corr) = best_lag(a, b, max_lag, min_overlap);
    if !corr.is_finite() || corr <= -1.0 {
        // 退化输入（任一路恒定/全静音/长度不足）：没有可解释的相关峰。
        return None;
    }
    Some(SyncLag {
        lag_ms: lag_samples as f64 / rate * 1000.0,
        correlation: corr,
        samples: want,
        downsample: factor,
        sample_rate,
    })
}

/// 统计 s16 交错 PCM 的峰值幅度与 RMS（用于判断“第二路是否有真实声音”）。
pub fn levels(pcm: &[u8]) -> (i32, f64, u64) {
    let count = pcm.len() / 2;
    if count == 0 {
        return (0, 0.0, 0);
    }
    let mut peak = 0i32;
    let mut sum_sq = 0.0f64;
    let mut nonzero = 0u64;
    for i in 0..count {
        let v = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]) as i32;
        let a = v.abs();
        if a > peak {
            peak = a;
        }
        sum_sq += (v as f64) * (v as f64);
        if v != 0 {
            nonzero += 1;
        }
    }
    (peak, (sum_sq / count as f64).sqrt(), nonzero)
}

/// 在 s16 交错 PCM 中找“静音 → 非静音”的第一个包络起点（毫秒）。
/// 用于把合成测试音的起点换算到音频媒体时间轴，该点晚于 `skip_ms` 才被检查。
pub fn detect_onset_ms(
    pcm: &[u8],
    channels: usize,
    sample_rate: u32,
    threshold: i32,
) -> Option<f64> {
    let channels = channels.max(1);
    let frames = pcm.len() / (2 * channels);
    if frames == 0 || sample_rate == 0 {
        return None;
    }
    for f in 0..frames {
        let mut hit = true;
        for c in 0..channels {
            let off = (f * channels + c) * 2;
            if off + 1 >= pcm.len() {
                hit = false;
                break;
            }
            let v = i16::from_le_bytes([pcm[off], pcm[off + 1]]) as i32;
            if v.abs() < threshold {
                hit = false;
                break;
            }
        }
        if hit {
            return Some(f as f64 / sample_rate as f64 * 1000.0);
        }
    }
    None
}
