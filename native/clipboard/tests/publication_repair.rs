//! Explicit opt-in only: synthetic publication, no key injection or user data.
#![cfg(windows)]
use highlighter_clipboard::{
    barrier::Barrier,
    listener::Monitor,
    storage::{Filter, Store},
    writer::{prepare_paste, PasteWrite},
};
use std::sync::{Arc, Mutex};
use windows::{
    core::w,
    Win32::{
        Foundation::*,
        System::{DataExchange::*, Memory::*},
        UI::WindowsAndMessaging::*,
    },
};

fn enabled() {
    assert_eq!(
        std::env::var("HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE").as_deref(),
        Ok("1"),
        "explicit synthetic clipboard opt-in required"
    );
}
unsafe fn foreign_copy(owner: HWND) {
    OpenClipboard(Some(owner)).unwrap();
    EmptyClipboard().unwrap();
    let bytes: Vec<u8> = "Highlighter synthetic external copy\0"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()).unwrap();
    let pointer = GlobalLock(memory);
    assert!(!pointer.is_null());
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast(), bytes.len());
    let _ = GlobalUnlock(memory);
    SetClipboardData(13, Some(HANDLE(memory.0))).unwrap();
    CloseClipboard().unwrap();
}
#[test]
#[ignore = "explicitly writes synthetic text/image; no user clipboard read or restoration"]
fn verified_text_image_and_external_change() {
    enabled();
    let root =
        std::env::temp_dir().join(format!("highlighter-publication-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(Mutex::new(Store::open(&root).unwrap()));
    let barrier = Arc::new(Barrier::default());
    let mut runtime = Monitor::start_with_store(barrier.clone(), Some(store.clone())).unwrap();
    let context = runtime.writer();
    assert_eq!(runtime.status()["captureWorker"], false);
    let mut images = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(64, 32, image::Rgba([20, 50, 90, 128]))
        .write_to(&mut images, image::ImageFormat::Png)
        .unwrap();
    for (kind, bytes) in [
        ("text", "Synthetic text 中文\r\n🙂 ".as_bytes().to_vec()),
        ("png", images.into_inner()),
    ] {
        store
            .lock()
            .unwrap()
            .accept(kind, bytes, "synthetic.exe")
            .unwrap();
        let id = store.lock().unwrap().list(Filter::default()).unwrap()["items"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let operation = uuid::Uuid::new_v4().to_string();
        let PasteWrite::Published(proof) =
            prepare_paste(&barrier, &context, &store, &id, &operation).unwrap()
        else {
            panic!("expected new publication")
        };
        assert!(proof.current());
        assert_eq!(proof.sequence, unsafe { GetClipboardSequenceNumber() });
        println!(
            "{}",
            serde_json::json!({"kind":kind,"diagnostics":context.diagnostics()})
        );
        unsafe {
            let other = CreateWindowExW(
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
            .unwrap();
            foreign_copy(other);
            assert!(
                !proof.current(),
                "external copy must invalidate the exact proof"
            );
            DestroyWindow(other).unwrap();
        }
    }
    runtime.stop().unwrap();
    assert!(context.window().is_err());
    drop(runtime);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
