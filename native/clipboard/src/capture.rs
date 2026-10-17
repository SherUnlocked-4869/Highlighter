//! Clipboard handles are borrowed only inside OpenClipboard/CloseClipboard.
//! Every returned payload owns its bytes; text decoding happens after close.
use crate::limits::{self, Skip};
use windows::core::PCWSTR;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

#[derive(Debug)]
pub struct Snapshot {
    pub kind: &'static str,
    pub bytes: Vec<u8>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

struct OpenGuard;
impl Drop for OpenGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

pub fn named_format(name: &str) -> Result<u32, Skip> {
    let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let id = unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) };
    if id == 0 {
        Err(Skip::Private)
    } else {
        Ok(id)
    }
}

unsafe fn copy_global(
    format: u32,
    maximum: usize,
    validate: impl FnOnce(&[u8]) -> Result<(), Skip>,
) -> Result<Vec<u8>, Skip> {
    let handle = GetClipboardData(format).map_err(|_| Skip::Busy)?;
    let global = HGLOBAL(handle.0);
    let size = GlobalSize(global);
    if size == 0 {
        return Err(Skip::Unsupported);
    }
    if size > maximum {
        return Err(Skip::Oversized);
    }
    let pointer = GlobalLock(global);
    if pointer.is_null() {
        return Err(Skip::Busy);
    }
    // Do not let validation errors bypass unlocking a borrowed system handle.
    let result = (|| {
        let raw = std::slice::from_raw_parts(pointer.cast::<u8>(), size);
        validate(raw)?;
        Ok(raw.to_vec())
    })();
    let _ = GlobalUnlock(global);
    result
}

pub fn read_snapshot(expected_sequence: u32) -> Result<Snapshot, Skip> {
    let (kind, bytes, image_size) = unsafe {
        OpenClipboard(None).map_err(|_| Skip::Busy)?;
        let _open = OpenGuard;
        if GetClipboardSequenceNumber() != expected_sequence {
            return Err(Skip::Superseded);
        }
        for name in [
            "ExcludeClipboardContentFromMonitorProcessing",
            "Clipboard Viewer Ignore",
        ] {
            if IsClipboardFormatAvailable(named_format(name)?).is_ok() {
                return Err(Skip::Private);
            }
        }
        let include = named_format("CanIncludeInClipboardHistory")?;
        if IsClipboardFormatAvailable(include).is_ok() {
            let marker = copy_global(include, 4, |raw| {
                if raw.len() == 4 {
                    Ok(())
                } else {
                    Err(Skip::Private)
                }
            })
            .map_err(|_| Skip::Private)?;
            if u32::from_le_bytes(marker.try_into().unwrap()) == 0 {
                return Err(Skip::Private);
            }
        }
        // File copies are not bitmaps: Explorer's preview icon must not become
        // an image history record. File lists are outside the G0 capability.
        if IsClipboardFormatAvailable(15).is_ok() {
            return Err(Skip::Unsupported);
        }
        let data = if IsClipboardFormatAvailable(13).is_ok() {
            (
                "text",
                copy_global(13, limits::MAX_TEXT_BYTES * 2 + 2, |_| Ok(()))?,
                None,
            )
        } else {
            let png = named_format("PNG")?;
            if IsClipboardFormatAvailable(png).is_ok() {
                let bytes = copy_global(png, limits::MAX_ENCODED_IMAGE_BYTES, |raw| {
                    limits::png_dimensions(raw).map(|_| ())
                })?;
                let size = limits::png_dimensions(&bytes)?;
                ("png", bytes, Some(size))
            } else {
                let format = if IsClipboardFormatAvailable(17).is_ok() {
                    17
                } else {
                    8
                };
                if IsClipboardFormatAvailable(format).is_err() {
                    return Err(Skip::Unsupported);
                }
                let bytes = copy_global(format, limits::MAX_DIB_BYTES, |raw| {
                    limits::dib_dimensions(raw).map(|_| ())
                })?;
                let size = limits::dib_dimensions(&bytes)?;
                ("dib", bytes, Some(size))
            }
        };
        if GetClipboardSequenceNumber() != expected_sequence {
            return Err(Skip::Superseded);
        }
        data
    };
    // The OpenGuard is already dropped. No clipboard lock is held while Rust
    // validates UTF-16 or creates the UTF-8 string.
    let bytes = if kind == "text" {
        let text = limits::utf16_text(&bytes)?;
        if text.is_empty() {
            return Err(Skip::Unsupported);
        }
        text.into_bytes()
    } else {
        bytes
    };
    Ok(Snapshot {
        kind,
        bytes,
        width: image_size.map(|s| s.0),
        height: image_size.map(|s| s.1),
    })
}
