//! `shared/clipboard-protocol.js` 的 Rust 移植：长度前缀帧的编码与流式解码。
//!
//! 语义必须与 JS 完全一致（计划 §9.1 剪贴板协议行；夹具格式见
//! `docs/plans/rust-migration/contract-format.md` §4.3）：
//!
//! - 帧布局：`size`(u32 LE，含自身 5 字节 + header + payload)、`kind`(u8，1=控制帧、
//!   2=二进制帧)、`headerBytes`(u32 LE)、header JSON、payload。
//! - 边界：`size` ≤ 1 MiB、`headerBytes` ≤ 512 KiB、payload ≤ 256 KiB；`kind=1` 时
//!   payload 必须为空。
//! - 任意非法帧统一返回 [`InvalidFrame`]（对应 JS 的单一 `Error('Invalid clipboard
//!   protocol frame')`，机器码 `invalid-frame`）。
//! - 流式：header/payload 可跨任意 `feed` 边界；一次 `feed` 可产出多帧；`finish()` 只接受
//!   恰好停在帧边界的状态。`feed` 失败后 decoder 永久失败（JS 的 `failed` 标志），
//!   不允许从半帧状态"恢复"。
//!
//! R0 边界：只覆盖共享帧编解码。lease/epoch/前台授权/回贴等业务在 R3；读循环、进程
//! 生命周期、日志脱敏在 R2-03 的 SidecarSupervisor。

use std::fmt;

use serde_json::Value;

/// 单帧最大字节数（计划 §9.1：1 MiB）。
pub const MAX_FRAME: usize = 1024 * 1024;
/// JSON header 最大字节数（计划 §9.1：512 KiB）。
pub const MAX_HEADER: usize = 512 * 1024;
/// 二进制 payload 单 chunk 最大字节数（计划 §9.1：256 KiB）。
pub const MAX_CHUNK: usize = 256 * 1024;

/// 固定前缀长度：`size`(4) + `kind`(1) + `headerBytes`(4)。对应 JS 的 `Buffer.alloc(9)`。
pub const FRAME_FIXED_BYTES: usize = 9;
/// `size` 字段覆盖的前缀长度：`size` 自身（4）+ `kind`（1）。对应 JS `size = 5 + ...`。
const SIZE_PREFIX_AND_KIND: usize = 5;
/// 控制帧：无 payload。
pub const KIND_CONTROL: u8 = 1;
/// 二进制帧：带 payload。
pub const KIND_BINARY: u8 = 2;

/// 所有非法帧共用的错误（JS 的 `invalid()`）；不区分具体违规原因，避免把解码细节
/// 暴露给对端，也保证双端对照只需比较同一种错误语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidFrame;

impl InvalidFrame {
    /// 机器码：与夹具 `expect=invalid` 用例的 `expectedError` 对齐（contract-format.md §4.3）。
    pub const CODE: &'static str = "invalid-frame";

    /// 机器码（实例形式，便于在断言/日志里统一取值）。
    #[must_use]
    pub fn code(self) -> &'static str {
        Self::CODE
    }
}

impl fmt::Display for InvalidFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid clipboard protocol frame")
    }
}

impl std::error::Error for InvalidFrame {}

/// 解码出的一帧。`header` 已按 UTF-8 严格解码并确认是 JSON object。
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// JSON 对象 header。
    pub header: Value,
    /// 二进制 payload；控制帧为空。
    pub payload: Vec<u8>,
}

/// 编码一帧。参数校验顺序与 `shared/clipboard-protocol.js` 的 `encodeFrame` 一致：
/// header 必须是 JSON object、payload 不超过 [`MAX_CHUNK`]，serialize 后 header 不超过
/// [`MAX_HEADER`]、整帧 `size` 不超过 [`MAX_FRAME`]。
pub fn encode_frame(header: &Value, payload: &[u8]) -> Result<Vec<u8>, InvalidFrame> {
    if !header.is_object() || payload.len() > MAX_CHUNK {
        return Err(InvalidFrame);
    }
    let json = serde_json::to_vec(header).map_err(|_| InvalidFrame)?;
    if json.len() > MAX_HEADER {
        return Err(InvalidFrame);
    }
    let size = SIZE_PREFIX_AND_KIND + json.len() + payload.len();
    if size > MAX_FRAME {
        return Err(InvalidFrame);
    }

    let mut frame = Vec::with_capacity(4 + size);
    frame.extend_from_slice(&(size as u32).to_le_bytes());
    frame.push(if payload.is_empty() {
        KIND_CONTROL
    } else {
        KIND_BINARY
    });
    frame.extend_from_slice(&(json.len() as u32).to_le_bytes());
    frame.extend_from_slice(&json);
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// 流式帧解码器（对应 JS `FrameDecoder`）。
///
/// 状态机与 JS 逐字段对应：`fixed`/`fixedBytes` 累积 9 字节固定前缀，`body`/`bodyBytes`
/// 累积 `size - 5` 字节的 header+payload 区，`failed` 表示不可恢复的协议错误。
#[derive(Debug, Default)]
pub struct FrameDecoder {
    fixed: [u8; FRAME_FIXED_BYTES],
    fixed_bytes: usize,
    body: Option<Vec<u8>>,
    body_bytes: usize,
    /// 当前 body 中 JSON header 的字节数。必须跨 `feed` 保留（对应 JS `this.headerBytes`），
    /// 否则固定前缀在一次 feed 解析完、body 在下次 feed 收齐时会把 header 切错。
    body_header_bytes: usize,
    failed: bool,
}

impl FrameDecoder {
    /// 新建解码器。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否已因协议错误永久失败。失败后所有 `feed`/`finish` 都返回 [`InvalidFrame`]。
    #[must_use]
    pub fn is_failed(&self) -> bool {
        self.failed
    }

    /// 当前缓冲的未完帧字节数（诊断/资源上限用；不代表已解析帧）。
    #[must_use]
    pub fn buffered_bytes(&self) -> usize {
        self.fixed_bytes + self.body_bytes
    }

    /// 喂入一个 chunk，返回本次解析出的完整帧（可能为 0 或多帧）。
    ///
    /// 任意错误都会让 decoder 进入永久失败状态；错误本身与 JS 一样不区分原因。
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, InvalidFrame> {
        if self.failed {
            return Err(InvalidFrame);
        }
        match self.feed_inner(chunk) {
            Ok(frames) => Ok(frames),
            Err(error) => {
                // 对应 JS catch：this.failed = true; this.body = null; throw invalid()
                self.failed = true;
                self.body = None;
                Err(error)
            }
        }
    }

    /// 校验流在帧边界结束；截断即为非法帧（对应 JS `finish`）。
    ///
    /// 注意：与 JS 一致，`finish()` 本身**不**设置 `failed`；只有 `feed` 出错才会永久失败。
    pub fn finish(&self) -> Result<(), InvalidFrame> {
        if self.failed || self.fixed_bytes != 0 || self.body.is_some() {
            Err(InvalidFrame)
        } else {
            Ok(())
        }
    }

    fn feed_inner(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, InvalidFrame> {
        let mut frames = Vec::new();
        let mut offset = 0;

        while offset < chunk.len() {
            if self.body.is_none() {
                let needed = FRAME_FIXED_BYTES - self.fixed_bytes;
                let count = needed.min(chunk.len() - offset);
                self.fixed[self.fixed_bytes..self.fixed_bytes + count]
                    .copy_from_slice(&chunk[offset..offset + count]);
                self.fixed_bytes += count;
                offset += count;

                if self.fixed_bytes >= 4 {
                    let size = u32::from_le_bytes([
                        self.fixed[0],
                        self.fixed[1],
                        self.fixed[2],
                        self.fixed[3],
                    ]) as usize;
                    if !(SIZE_PREFIX_AND_KIND..=MAX_FRAME).contains(&size) {
                        return Err(InvalidFrame);
                    }
                }
                if self.fixed_bytes < FRAME_FIXED_BYTES {
                    continue;
                }

                let size = u32::from_le_bytes([
                    self.fixed[0],
                    self.fixed[1],
                    self.fixed[2],
                    self.fixed[3],
                ]) as usize;
                let kind = self.fixed[4];
                let header_bytes = u32::from_le_bytes([
                    self.fixed[5],
                    self.fixed[6],
                    self.fixed[7],
                    self.fixed[8],
                ]) as i64;
                // size >= 5 已在 4 字节处校验过，因此 size - 5 不会下溢。
                let payload_bytes = size as i64 - SIZE_PREFIX_AND_KIND as i64 - header_bytes;
                if !matches!(kind, KIND_CONTROL | KIND_BINARY)
                    || header_bytes > MAX_HEADER as i64
                    || payload_bytes < 0
                    || payload_bytes > MAX_CHUNK as i64
                    || (kind == KIND_CONTROL && payload_bytes != 0)
                {
                    return Err(InvalidFrame);
                }
                self.body_header_bytes = header_bytes as usize;
                self.body = Some(vec![0u8; size - SIZE_PREFIX_AND_KIND]);
                self.body_bytes = 0;
            }

            let body_len = self.body.as_ref().ok_or(InvalidFrame)?.len();
            let count = (body_len - self.body_bytes).min(chunk.len() - offset);
            if let Some(body) = self.body.as_mut() {
                body[self.body_bytes..self.body_bytes + count]
                    .copy_from_slice(&chunk[offset..offset + count]);
            }
            self.body_bytes += count;
            offset += count;

            if self.body_bytes == body_len {
                let body = self.body.take().ok_or(InvalidFrame)?;
                let header_text = std::str::from_utf8(&body[..self.body_header_bytes])
                    .map_err(|_| InvalidFrame)?;
                let header: Value = serde_json::from_str(header_text).map_err(|_| InvalidFrame)?;
                if !header.is_object() {
                    return Err(InvalidFrame);
                }
                frames.push(Frame {
                    header,
                    payload: body[self.body_header_bytes..].to_vec(),
                });
                self.body = None;
                self.body_bytes = 0;
                self.fixed_bytes = 0;
                self.body_header_bytes = 0;
            }
        }

        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 按 JS 二进制布局手工构造帧；故意不做参数自洽校验，供非法帧用例使用。
    fn raw_frame(size: u32, kind: u8, header_bytes: u32, body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(FRAME_FIXED_BYTES + body.len());
        bytes.extend_from_slice(&size.to_le_bytes());
        bytes.push(kind);
        bytes.extend_from_slice(&header_bytes.to_le_bytes());
        bytes.extend_from_slice(body);
        bytes
    }

    fn encoded(header: Value, payload: &[u8]) -> Vec<u8> {
        encode_frame(&header, payload).expect("encode frame")
    }

    fn assert_frames(actual: &[Frame], expected: &[(Value, Vec<u8>)]) {
        assert_eq!(
            actual.len(),
            expected.len(),
            "decoded frame count mismatch: {actual:?}"
        );
        for (index, (frame, (header, payload))) in actual.iter().zip(expected).enumerate() {
            assert_eq!(&frame.header, header, "frame {index} header");
            assert_eq!(&frame.payload, payload, "frame {index} payload");
        }
    }

    #[test]
    fn limits_are_frozen_by_plan_section_9_1() {
        assert_eq!(MAX_FRAME, 1024 * 1024);
        assert_eq!(MAX_HEADER, 512 * 1024);
        assert_eq!(MAX_CHUNK, 256 * 1024);
    }

    #[test]
    fn encoded_layout_matches_the_js_binary_format() {
        let frame = encoded(json!({"type": "hello"}), &[]);
        let header = br#"{"type":"hello"}"#;
        let size = 5 + header.len();
        assert_eq!(frame.len(), 4 + size);
        assert_eq!(frame[0..4], (size as u32).to_le_bytes()[..]);
        assert_eq!(frame[4], KIND_CONTROL);
        assert_eq!(frame[5..9], (header.len() as u32).to_le_bytes()[..]);
        assert_eq!(&frame[9..], header);

        let with_payload = encoded(json!({"streamId": "2"}), &[0, 10, 255]);
        assert_eq!(with_payload[4], KIND_BINARY);
    }

    #[test]
    fn decodes_single_control_frame() {
        let bytes = encoded(json!({"type": "hello"}), &[]);
        let mut decoder = FrameDecoder::new();
        let frames = decoder.feed(&bytes).expect("valid frame");
        assert_frames(&frames, &[(json!({"type": "hello"}), Vec::new())]);
        decoder.finish().expect("ends on frame boundary");
    }

    #[test]
    fn decodes_binary_payload_without_transformation() {
        let payload = vec![0u8, 10, 13, 255, b'\n', 0xe4, 0xb8, 0xad];
        let bytes = encoded(json!({"streamId": "2", "done": false}), &payload);
        let mut decoder = FrameDecoder::new();
        let frames = decoder.feed(&bytes).expect("valid frame");
        assert_frames(
            &frames,
            &[(json!({"streamId": "2", "done": false}), payload)],
        );
    }

    #[test]
    fn decodes_across_every_possible_chunk_boundary() {
        let first_header = json!({"type": "hello"});
        let first_payload = vec![9u8, 8, 7];
        let second_header = json!({"type": "bye", "count": 2});
        let second_payload: Vec<u8> = (0..=255).collect();
        let mut stream = encoded(first_header.clone(), &first_payload);
        stream.extend(encoded(second_header.clone(), &second_payload));

        for split in 0..=stream.len() {
            let mut decoder = FrameDecoder::new();
            let mut frames = decoder.feed(&stream[..split]).expect("first part");
            frames.extend(decoder.feed(&stream[split..]).expect("second part"));
            decoder.finish().expect("frame boundary");
            assert_frames(
                &frames,
                &[
                    (first_header.clone(), first_payload.clone()),
                    (second_header.clone(), second_payload.clone()),
                ],
            );
        }
    }

    #[test]
    fn decodes_one_byte_at_a_time_and_keeps_partial_state() {
        let bytes = encoded(json!({"text": "中文\n"}), &[1, 2, 3]);
        let mut decoder = FrameDecoder::new();
        let mut frames = Vec::new();
        for index in 0..bytes.len() {
            let produced = decoder.feed(&bytes[index..index + 1]).expect("byte");
            if index + 1 < bytes.len() {
                assert!(
                    produced.is_empty(),
                    "frame completed before the last byte at {index}"
                );
            }
            frames.extend(produced);
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, [1, 2, 3]);
        assert_eq!(decoder.buffered_bytes(), 0);
        decoder.finish().expect("clean");
    }

    #[test]
    fn decodes_multiple_frames_from_one_feed() {
        let mut stream = Vec::new();
        for index in 0..3u8 {
            stream.extend(encoded(json!({ "index": index }), &[index]));
        }
        let mut decoder = FrameDecoder::new();
        let frames = decoder.feed(&stream).expect("three frames");
        assert_eq!(frames.len(), 3);
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.header["index"], json!(index));
            assert_eq!(frame.payload, [index as u8]);
        }
        decoder.finish().expect("clean");
    }

    #[test]
    fn empty_chunk_is_a_no_op() {
        let mut decoder = FrameDecoder::new();
        assert!(decoder.feed(&[]).expect("empty feed").is_empty());
        decoder.finish().expect("clean");
        let bytes = encoded(json!({"a": 1}), &[]);
        decoder.feed(&bytes).expect("frame");
        assert!(decoder
            .feed(&[])
            .expect("empty feed after frame")
            .is_empty());
        decoder.finish().expect("clean");
    }

    #[test]
    fn finish_rejects_truncation_without_poisoning_the_decoder() {
        // 截断在固定前缀里。
        let bytes = encoded(json!({"type": "hello"}), &[]);
        let mut decoder = FrameDecoder::new();
        assert!(decoder
            .feed(&bytes[..7])
            .expect("partial prefix")
            .is_empty());
        assert_eq!(decoder.finish(), Err(InvalidFrame));
        let frames = decoder.feed(&bytes[7..]).expect("rest of prefix");
        assert_eq!(frames.len(), 1);
        decoder.finish().expect("clean");

        // 截断在 body 里（header+payload 尚未收齐）。JS 的 finish() 不置 failed。
        let payload = vec![1u8, 2, 3, 4];
        let bytes = encoded(json!({"streamId": "x"}), &payload);
        let mut decoder = FrameDecoder::new();
        let fixed_and_some_body = FRAME_FIXED_BYTES + 2;
        assert!(decoder
            .feed(&bytes[..fixed_and_some_body])
            .expect("partial body")
            .is_empty());
        assert_eq!(decoder.finish(), Err(InvalidFrame));
        let frames = decoder.feed(&bytes[fixed_and_some_body..]).expect("rest");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, payload);
        decoder.finish().expect("clean");
    }

    #[test]
    fn rejects_size_below_five_and_above_max_frame() {
        for bytes in [
            raw_frame(4, KIND_CONTROL, 0, &[]),
            raw_frame(0, KIND_CONTROL, 0, &[]),
            raw_frame(MAX_FRAME as u32 + 1, KIND_CONTROL, 0, &[]),
            raw_frame(u32::MAX, KIND_CONTROL, 0, &[]),
        ] {
            let mut decoder = FrameDecoder::new();
            assert_eq!(decoder.feed(&bytes), Err(InvalidFrame), "bytes={bytes:?}");
            assert!(decoder.is_failed());
        }
    }

    #[test]
    fn rejects_header_larger_than_max_header() {
        let size = (SIZE_PREFIX_AND_KIND + MAX_HEADER + 1) as u32;
        let bytes = raw_frame(size, KIND_CONTROL, MAX_HEADER as u32 + 1, &[]);
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.feed(&bytes), Err(InvalidFrame));
        assert!(decoder.is_failed());
    }

    #[test]
    fn rejects_payload_larger_than_max_chunk() {
        let header_bytes = 2u32;
        let payload_bytes = MAX_CHUNK + 1;
        let size = (SIZE_PREFIX_AND_KIND + header_bytes as usize + payload_bytes) as u32;
        let bytes = raw_frame(size, KIND_BINARY, header_bytes, b"{}");
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.feed(&bytes), Err(InvalidFrame));
    }

    #[test]
    fn rejects_invalid_kinds_and_control_frames_with_payload() {
        // kind 0 / 3 不属于 1,2。
        for kind in [0u8, 3u8, 255u8] {
            let bytes = raw_frame(9, kind, 4, b"{}");
            let mut decoder = FrameDecoder::new();
            assert_eq!(decoder.feed(&bytes), Err(InvalidFrame), "kind={kind}");
        }
        // kind=1 但带 payload。
        let bytes = raw_frame(SIZE_PREFIX_AND_KIND as u32 + 4 + 1, KIND_CONTROL, 4, b"{}X");
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.feed(&bytes), Err(InvalidFrame));
    }

    #[test]
    fn rejects_non_object_and_malformed_headers() {
        let bodies: [&[u8]; 6] = [b"[]", b"5", b"null", b"\xff", b"{", b""];
        for body in bodies {
            let size = (SIZE_PREFIX_AND_KIND + body.len()) as u32;
            let bytes = raw_frame(size, KIND_CONTROL, body.len() as u32, body);
            let mut decoder = FrameDecoder::new();
            assert_eq!(decoder.feed(&bytes), Err(InvalidFrame), "body={body:?}");
            assert!(decoder.is_failed());
        }
    }

    #[test]
    fn rejects_header_bytes_that_exceed_the_frame() {
        // size=5 但 headerBytes=10：payload 计算为负 → 非法。
        let bytes = raw_frame(SIZE_PREFIX_AND_KIND as u32, KIND_BINARY, 10, &[]);
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.feed(&bytes), Err(InvalidFrame));
    }

    #[test]
    fn accepts_boundary_sizes_for_header_and_payload() {
        // header JSON 恰好 MAX_HEADER 字节：{"x":"aaaa..."} = 8 字节骨架 + n 个 'a'。
        let filler = "a".repeat(MAX_HEADER - 8);
        let header = json!({ "x": filler });
        let frame = encode_frame(&header, &[]).expect("header at limit is legal");
        let mut decoder = FrameDecoder::new();
        let frames = decoder.feed(&frame).expect("decode header at limit");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].header["x"], json!("a".repeat(MAX_HEADER - 8)));

        // payload 恰好 MAX_CHUNK 字节。
        let payload = vec![7u8; MAX_CHUNK];
        let frame = encode_frame(&json!({"streamId": "max"}), &payload).expect("payload at limit");
        let mut decoder = FrameDecoder::new();
        let mut frames = Vec::new();
        let split = frame.len() / 2;
        frames.extend(decoder.feed(&frame[..split]).expect("first half"));
        frames.extend(decoder.feed(&frame[split..]).expect("second half"));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload.len(), MAX_CHUNK);
        decoder.finish().expect("clean");
    }

    #[test]
    fn encode_rejects_invalid_arguments() {
        for header in [json!(5), json!([1, 2]), json!(null), json!("text")] {
            assert_eq!(encode_frame(&header, &[]), Err(InvalidFrame));
        }
        assert_eq!(
            encode_frame(&json!({}), &vec![0u8; MAX_CHUNK + 1]),
            Err(InvalidFrame)
        );
        let oversized_header = json!({ "x": "a".repeat(MAX_HEADER) });
        assert_eq!(encode_frame(&oversized_header, &[]), Err(InvalidFrame));
    }

    #[test]
    fn feed_failure_permanently_poisons_the_decoder() {
        let mut decoder = FrameDecoder::new();
        assert_eq!(
            decoder.feed(&raw_frame(4, KIND_CONTROL, 0, &[])),
            Err(InvalidFrame)
        );
        assert!(decoder.is_failed());
        // 之后喂入完全合法的帧也必须失败（旧失败状态不可恢复）。
        let valid = encoded(json!({"type": "hello"}), &[]);
        assert_eq!(decoder.feed(&valid), Err(InvalidFrame));
        assert_eq!(decoder.finish(), Err(InvalidFrame));
    }

    #[test]
    fn out_of_range_header_bytes_are_rejected_before_allocating_body() {
        // 断言「超限不分配巨图/巨缓冲」的 R0 语义：headerBytes 超界时在固定头阶段失败，
        // 不依赖后续 body 是否到达。
        let size = (SIZE_PREFIX_AND_KIND + MAX_HEADER + 1) as u32;
        let mut decoder = FrameDecoder::new();
        let fixed_only = raw_frame(size, KIND_CONTROL, MAX_HEADER as u32 + 1, &[]);
        assert_eq!(
            decoder.feed(&fixed_only[..FRAME_FIXED_BYTES]),
            Err(InvalidFrame)
        );
    }

    #[test]
    fn buffered_bytes_track_partial_frames() {
        let bytes = encoded(json!({"streamId": "x"}), &[1, 2, 3]);
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.buffered_bytes(), 0);
        decoder.feed(&bytes[..3]).expect("prefix");
        assert_eq!(decoder.buffered_bytes(), 3);
        decoder.feed(&bytes[3..12]).expect("rest of prefix");
        assert_eq!(decoder.buffered_bytes(), 12);
        let frames = decoder.feed(&bytes[12..]).expect("body");
        assert_eq!(frames.len(), 1);
        assert_eq!(decoder.buffered_bytes(), 0);
    }
}
