//! Publishes concrete owned formats without restoring old clipboard content.
//! Allocation/encoding occurs before opening. Paste orchestration lives separately.
use crate::{
    barrier::Barrier,
    capture::named_format,
    publication::{PublicationProof, PublicationTrace, WriterContext},
};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::{HANDLE, HGLOBAL, HWND},
    System::{DataExchange::*, Memory::*},
};

struct Global {
    handle: HGLOBAL,
    length: usize,
    digest: [u8; 32],
}
struct Signature {
    format: u32,
    length: usize,
    digest: [u8; 32],
}
impl Global {
    fn new(bytes: &[u8]) -> Result<Self, &'static str> {
        Self::generate(bytes.len(), |buffer| buffer.copy_from_slice(bytes))
    }
    fn generate(length: usize, fill: impl FnOnce(&mut [u8])) -> Result<Self, &'static str> {
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, length)
                .map_err(|_| "ALLOCATION_FAILED")?;
            let mut allocation = Self {
                handle,
                length,
                digest: [0; 32],
            };
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                return Err("ALLOCATION_FAILED");
            }
            let buffer = std::slice::from_raw_parts_mut(ptr.cast::<u8>(), length);
            fill(buffer);
            allocation.digest = Sha256::digest(buffer).into();
            let _ = GlobalUnlock(handle);
            Ok(allocation)
        }
    }
    unsafe fn publish(mut self, format: u32) -> Result<(), &'static str> {
        SetClipboardData(format, Some(HANDLE(self.handle.0)))
            .map_err(|_| "COPY_OUTCOME_UNKNOWN")?;
        self.handle = HGLOBAL::default();
        Ok(())
    }
}
impl Drop for Global {
    fn drop(&mut self) {
        if !self.handle.0.is_null() {
            unsafe {
                let _ = windows::Win32::Foundation::GlobalFree(Some(self.handle));
            }
        }
    }
}
pub fn copy_item(
    barrier: &Barrier,
    context: &WriterContext,
    store: &std::sync::Mutex<crate::storage::Store>,
    id: &str,
    op: &str,
) -> Result<(), &'static str> {
    // Drain capture before loading/decoding the original: capture and history
    // image conversion must not multiply one another's peak memory.
    let epoch = barrier.begin_local(Duration::from_millis(100))?;
    let owned_sequence = std::cell::Cell::new(barrier.baseline());
    let result = (|| {
        let data = {
            let mut locked = store.lock().map_err(|_| "STORAGE_FAILED")?;
            let payload = locked.payload(id, false)?;
            if locked.begin_copy(id, op)? {
                Some(payload)
            } else {
                None
            }
        };
        if let Some((mime, bytes)) = data {
            let proof = copy(context, &mime, &bytes)?;
            owned_sequence.set(proof.sequence);
            store
                .lock()
                .map_err(|_| "COPY_OUTCOME_UNKNOWN")?
                .finish_copy(id, op)
                .map_err(|_| "COPY_OUTCOME_UNKNOWN")?;
        }
        Ok(())
    })();
    let ended = barrier.end(0, epoch, owned_sequence.get());
    result.and(ended)
}

pub enum PasteWrite {
    Published(PublicationProof),
    Completed(serde_json::Value),
}

pub fn prepare_paste(
    barrier: &Barrier,
    context: &WriterContext,
    store: &std::sync::Mutex<crate::storage::Store>,
    id: &str,
    op: &str,
) -> Result<PasteWrite, &'static str> {
    let epoch = barrier.begin_local(Duration::from_millis(100))?;
    let sequence = std::cell::Cell::new(barrier.baseline());
    let result = (|| {
        let (mime, bytes) = {
            let mut locked = store.lock().map_err(|_| "STORAGE_FAILED")?;
            if let Some(prior) = locked.begin_paste(id, op)? {
                return Ok(PasteWrite::Completed(prior));
            }
            locked.payload(id, false)?
        };
        let proof = copy(context, &mime, &bytes).map_err(|code| {
            if code == "COPY_OUTCOME_UNKNOWN" {
                "PASTE_OUTCOME_UNKNOWN"
            } else {
                code
            }
        })?;
        sequence.set(proof.sequence);
        Ok(PasteWrite::Published(proof))
    })();
    let ended = barrier.end(0, epoch, sequence.get());
    result.and_then(|value| ended.map(|()| value))
}

/// The three Windows formats that keep a publication out of clipboard history and out of
/// monitor/cloud processing. Their presence (the first two) or a DWORD 0 (the third) is what
/// Windows honors; capture.rs already treats them as "Skip::Private". They are published
/// INSIDE the same OpenClipboard call and BEFORE the pixels, so a failure here can never
/// publish an image whose exclusion the user relied on.
fn exclusion_markers() -> Result<Vec<(u32, Global)>, &'static str> {
    Ok(vec![
        (
            named_format("ExcludeClipboardContentFromMonitorProcessing")
                .map_err(|_| "EXCLUSION_UNAVAILABLE")?,
            Global::new(&1u32.to_le_bytes())?,
        ),
        (
            named_format("Clipboard Viewer Ignore").map_err(|_| "EXCLUSION_UNAVAILABLE")?,
            Global::new(&1u32.to_le_bytes())?,
        ),
        (
            named_format("CanIncludeInClipboardHistory").map_err(|_| "EXCLUSION_UNAVAILABLE")?,
            Global::new(&0u32.to_le_bytes())?,
        ),
    ])
}

/// Builds the image formats (PNG + CF_DIB) from encoded PNG bytes. Decoding happens before
/// the clipboard is opened, exactly like the history copy path.
fn image_formats(bytes: &[u8]) -> Result<Vec<(u32, Global)>, &'static str> {
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("INVALID_IMAGE");
    }
    let mut formats = Vec::new();
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let bitmap = reader.decode().map_err(|_| "INVALID_IMAGE")?.into_rgba8();
    crate::limits::dimensions(bitmap.width(), bitmap.height()).map_err(|_| "INVALID_IMAGE")?;
    let dib = Global::generate(124 + bitmap.len(), |dib| {
        dib[..4].copy_from_slice(&124u32.to_le_bytes());
        dib[4..8].copy_from_slice(&(bitmap.width() as i32).to_le_bytes());
        dib[8..12].copy_from_slice(&(-(bitmap.height() as i32)).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[16..20].copy_from_slice(&3u32.to_le_bytes());
        for (offset, value) in [
            (40, 0x00ff0000u32),
            (44, 0x0000ff00),
            (48, 0x000000ff),
            (52, 0xff000000),
            (56, 0x73524742),
        ] {
            dib[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (rgba, bgra) in bitmap.chunks_exact(4).zip(dib[124..].chunks_exact_mut(4)) {
            bgra.copy_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
        }
    })?;
    formats.push((
        named_format("PNG").map_err(|_| "COPY_FAILED")?,
        Global::new(bytes)?,
    ));
    formats.push((17, dib));
    Ok(formats)
}

/// Publishes one fresh image that does not exist in history. `private` adds the exclusion
/// markers before the pixels, so the publication can never land in clipboard history,
/// monitor processing or the app's own capture.
pub fn publish_image(
    context: &WriterContext,
    bytes: &[u8],
    private: bool,
) -> Result<PublicationProof, &'static str> {
    let started = Instant::now();
    let mut formats = Vec::new();
    // Markers first: if one of them cannot be prepared, nothing is published at all.
    if private {
        formats.extend(exclusion_markers()?);
    }
    formats.extend(image_formats(bytes)?);
    publish_formats(context, formats, "image/png", started)
}

fn copy(
    context: &WriterContext,
    mime: &str,
    bytes: &[u8],
) -> Result<PublicationProof, &'static str> {
    let started = Instant::now();
    let mut formats = Vec::new();
    if mime.starts_with("text/plain") {
        let text = std::str::from_utf8(bytes).map_err(|_| "INVALID_ENCODING")?;
        let unicode: Vec<u8> = text
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        formats.push((13, Global::new(&unicode)?));
    } else if mime == crate::limits::FILES_MIME {
        // Re-validate the body before publishing: an invalid list never becomes a
        // partial clipboard file list. Only paths are written, never file contents.
        let paths = crate::limits::decode_file_list(bytes).map_err(|_| "UNSUPPORTED")?;
        let dropfiles = crate::limits::encode_dropfiles(&paths).map_err(|_| "UNSUPPORTED")?;
        formats.push((15, Global::new(&dropfiles)?));
        // CF_HDROP alone makes Explorer offer "Cut" in some targets; the registered
        // drop effect pins the pasted operation to a copy.
        formats.push((
            named_format("Preferred DropEffect").map_err(|_| "COPY_FAILED")?,
            Global::new(&1u32.to_le_bytes())?,
        ));
    } else if mime == "image/png" {
        formats = image_formats(bytes)?;
    } else {
        return Err("UNSUPPORTED");
    }
    publish_formats(context, formats, mime, started)
}

/// Opens the clipboard ONCE, publishes the prepared formats in order, verifies what landed
/// and returns the proof. Shared by the history copy and the direct private publish so both
/// paths obey the same interruption/busy/verification rules.
fn publish_formats(
    context: &WriterContext,
    formats: Vec<(u32, Global)>,
    mime: &str,
    started: Instant,
) -> Result<PublicationProof, &'static str> {
    let original_sequence = unsafe { GetClipboardSequenceNumber() };
    let mut trace = PublicationTrace::default();
    let result = (|| unsafe {
        let owner = context.window()?;
        let mut opened = Open::new(owner)?;
        if GetClipboardSequenceNumber() != original_sequence {
            return Err("COPY_INTERRUPTED");
        }
        EmptyClipboard().map_err(|_| "COPY_FAILED")?;
        let mut signatures = Vec::with_capacity(formats.len());
        for (format, data) in formats {
            signatures.push(Signature {
                format,
                length: data.length,
                digest: data.digest,
            });
            data.publish(format)?;
        }
        let generation = context.generation();
        trace.before_close = GetClipboardSequenceNumber();
        opened.close()?;
        trace.after_close = GetClipboardSequenceNumber();
        trace.publish_micros = started.elapsed().as_micros() as u64;
        let verifying = Instant::now();
        let candidate = trace.after_close;
        // A candidate is not a baseline. Reject an intervening copy rather than
        // adopting its sequence, even when its payload might look identical.
        let mut verification = None;
        for wait in [0, 5, 15, 30] {
            if wait != 0 {
                std::thread::sleep(Duration::from_millis(wait));
            }
            if !context.unchanged(generation) || GetClipboardSequenceNumber() != candidate {
                return Err("CLIPBOARD_CHANGED");
            }
            if let Ok(opened) = Open::new(owner) {
                verification = Some(opened);
                break;
            }
        }
        let mut verification = verification.ok_or("CLIPBOARD_BUSY")?;
        trace.owner_is_ours = context.unchanged(generation);
        if !trace.owner_is_ours || GetClipboardSequenceNumber() != candidate {
            return Err("CLIPBOARD_CHANGED");
        }
        verify_formats(&signatures, mime, verifying + Duration::from_millis(500))?;
        trace.content_matched = true;
        if !context.unchanged(generation) || GetClipboardSequenceNumber() != candidate {
            return Err("CLIPBOARD_CHANGED");
        }
        verification.close()?;
        trace.verify_micros = verifying.elapsed().as_micros() as u64;
        if !context.unchanged(generation) || GetClipboardSequenceNumber() != candidate {
            return Err("CLIPBOARD_CHANGED");
        }
        trace.verified_sequence = candidate;
        Ok(context.proof(candidate, generation))
    })();
    result
}


struct Open(bool);
impl Open {
    unsafe fn new(owner: HWND) -> Result<Self, &'static str> {
        OpenClipboard(Some(owner)).map_err(|_| "CLIPBOARD_BUSY")?;
        Ok(Self(true))
    }
    unsafe fn close(&mut self) -> Result<(), &'static str> {
        CloseClipboard().map_err(|_| "COPY_OUTCOME_UNKNOWN")?;
        self.0 = false;
        Ok(())
    }
}
impl Drop for Open {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
}

unsafe fn verify_formats(
    signatures: &[Signature],
    mime: &str,
    deadline: Instant,
) -> Result<(), &'static str> {
    let mut format = 0;
    let mut count = 0;
    loop {
        format = EnumClipboardFormats(format);
        if format == 0 {
            break;
        }
        count += 1;
        let derived = if mime.starts_with("text/plain") {
            [1, 7, 16].contains(&format)
        } else if mime == crate::limits::FILES_MIME {
            [15].contains(&format)
        } else {
            [2, 8, 9].contains(&format)
        };
        if count > 8 || (!derived && !signatures.iter().any(|entry| entry.format == format)) {
            return Err("PUBLICATION_UNVERIFIED");
        }
    }
    for expected in signatures {
        if Instant::now() >= deadline {
            return Err("PUBLICATION_UNVERIFIED");
        }
        let handle = GetClipboardData(expected.format).map_err(|_| "PUBLICATION_UNVERIFIED")?;
        let memory = HGLOBAL(handle.0);
        let size = GlobalSize(memory);
        if size < expected.length || size > expected.length.saturating_add(65536) {
            return Err("PUBLICATION_UNVERIFIED");
        }
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            return Err("PUBLICATION_UNVERIFIED");
        }
        let checked = (|| {
            let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), size);
            let mut digest = Sha256::new();
            for chunk in bytes[..expected.length].chunks(65536) {
                if Instant::now() >= deadline {
                    return Err("PUBLICATION_UNVERIFIED");
                }
                digest.update(chunk);
            }
            if <[u8; 32]>::from(digest.finalize()) != expected.digest
                || bytes[expected.length..].iter().any(|byte| *byte != 0)
            {
                return Err("PUBLICATION_UNVERIFIED");
            }
            Ok(())
        })();
        let _ = GlobalUnlock(memory);
        checked?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // B01 (plan item 05): the three exclusion formats are prepared as DWORD payloads and
    // are published BEFORE the pixels. This is the invariant the capture domain relies on:
    // a marker that cannot be prepared fails the publication instead of degrading it.
    #[test]
    fn exclusion_markers_are_three_dword_flags() {
        let markers = exclusion_markers().expect("markers must be preparable");
        assert_eq!(markers.len(), 3);
        for (_, data) in &markers {
            assert_eq!(data.length, 4);
        }
    }

    // A non-PNG never reaches the clipboard: validation happens before the decode and
    // before any clipboard call.
    #[test]
    fn image_formats_reject_non_png_before_touching_the_clipboard() {
        assert_eq!(image_formats(b"").err(), Some("INVALID_IMAGE"));
        assert_eq!(image_formats(b"not a png at all").err(), Some("INVALID_IMAGE"));
        // A valid signature with a broken body still fails at the decoder, not at publication.
        let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
        broken.extend_from_slice(&[0u8; 8]);
        assert!(image_formats(&broken).is_err());
    }
}
