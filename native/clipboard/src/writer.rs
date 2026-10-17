//! A history copy publishes concrete owned formats. It never sends keys or
//! restores old clipboard content. Allocation/encoding occurs before opening.
use crate::{barrier::Barrier, capture::named_format};
use std::time::Duration;
use windows::{
    core::w,
    Win32::{
        Foundation::{HANDLE, HGLOBAL, HWND},
        System::{DataExchange::*, Memory::*},
        UI::WindowsAndMessaging::*,
    },
};

struct Global(HGLOBAL);
impl Global {
    fn new(bytes: &[u8]) -> Result<Self, &'static str> {
        Self::generate(bytes.len(), |buffer| buffer.copy_from_slice(bytes))
    }
    fn generate(length: usize, fill: impl FnOnce(&mut [u8])) -> Result<Self, &'static str> {
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, length)
                .map_err(|_| "ALLOCATION_FAILED")?;
            let allocation = Self(handle);
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                return Err("ALLOCATION_FAILED");
            }
            fill(std::slice::from_raw_parts_mut(ptr.cast::<u8>(), length));
            let _ = GlobalUnlock(handle);
            Ok(allocation)
        }
    }
    unsafe fn publish(mut self, format: u32) -> Result<(), &'static str> {
        SetClipboardData(format, Some(HANDLE(self.0 .0))).map_err(|_| "COPY_OUTCOME_UNKNOWN")?;
        self.0 = HGLOBAL::default();
        Ok(())
    }
}
impl Drop for Global {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                let _ = windows::Win32::Foundation::GlobalFree(Some(self.0));
            }
        }
    }
}
struct Owner(HWND);
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

pub fn copy_item(
    barrier: &Barrier,
    store: &std::sync::Mutex<crate::storage::Store>,
    id: &str,
    op: &str,
) -> Result<(), &'static str> {
    // Drain capture before loading/decoding the original: capture and history
    // image conversion must not multiply one another's peak memory.
    let epoch = barrier.begin_local(Duration::from_millis(100))?;
    let owned_sequence = std::cell::Cell::new(unsafe { GetClipboardSequenceNumber() });
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
            copy(&mime, &bytes, &owned_sequence)?;
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

fn copy(
    mime: &str,
    bytes: &[u8],
    owned_sequence: &std::cell::Cell<u32>,
) -> Result<(), &'static str> {
    let mut formats = Vec::new();
    if mime.starts_with("text/plain") {
        let text = std::str::from_utf8(bytes).map_err(|_| "INVALID_ENCODING")?;
        let unicode: Vec<u8> = text
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        formats.push((13, Global::new(&unicode)?));
    } else if mime == "image/png" {
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
    } else {
        return Err("UNSUPPORTED");
    }
    let result = (|| unsafe {
        let owner = Owner(
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .map_err(|_| "COPY_FAILED")?,
        );
        OpenClipboard(Some(owner.0)).map_err(|_| "CLIPBOARD_BUSY")?;
        let mutated = std::cell::Cell::new(false);
        struct Close<'a>(&'a std::cell::Cell<u32>, &'a std::cell::Cell<bool>);
        impl Drop for Close<'_> {
            fn drop(&mut self) {
                unsafe {
                    if self.1.get() {
                        self.0.set(GetClipboardSequenceNumber());
                    }
                    let _ = CloseClipboard();
                }
            }
        }
        let _close = Close(owned_sequence, &mutated);
        if GetClipboardSequenceNumber() != owned_sequence.get() {
            return Err("COPY_INTERRUPTED");
        }
        EmptyClipboard().map_err(|_| "COPY_FAILED")?;
        mutated.set(true);
        for (format, data) in formats {
            data.publish(format)?;
        }
        Ok(())
    })();
    result
}
