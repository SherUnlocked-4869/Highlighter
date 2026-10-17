//! Opt-in native evidence using synthetic content only. A failed private
//! station setup never falls back to the user's interactive clipboard.
#![cfg(windows)]
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::*,
        System::{DataExchange::*, Memory::*, StationsAndDesktops::*, Threading::*},
        UI::WindowsAndMessaging::*,
    },
};

#[test]
#[ignore = "writes synthetic clipboard content; private station required unless explicitly opted into interactive validation"]
fn records_close_and_owner_destruction_sequences() {
    unsafe {
        let interactive =
            std::env::var("HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE").as_deref() == Ok("1");
        let original_station = GetProcessWindowStation().unwrap();
        let original_desktop = GetThreadDesktop(GetCurrentThreadId()).unwrap();
        let mut isolation = None;
        if !interactive {
            let name: Vec<u16> = format!("HighlighterPublicationProbe-{}\0", std::process::id())
                .encode_utf16()
                .collect();
            let access = (WINSTA_ENUMDESKTOPS
                | WINSTA_READATTRIBUTES
                | WINSTA_ACCESSCLIPBOARD
                | WINSTA_CREATEDESKTOP) as u32;
            let station = CreateWindowStationW(PCWSTR(name.as_ptr()), 0, access, None)
                .expect("private station required; no clipboard write performed");
            SetProcessWindowStation(station).unwrap();
            let desktop = CreateDesktopW(
                w!("PublicationProbe"),
                PCWSTR::null(),
                None,
                DESKTOP_CONTROL_FLAGS(0),
                0x1ff,
                None,
            )
            .unwrap();
            SetThreadDesktop(desktop).unwrap();
            assert_ne!(station, original_station);
            isolation = Some((station, desktop));
        }
        let owner = CreateWindowExW(
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
        let bytes: Vec<u8> = "Highlighter synthetic publication probe\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let before = GetClipboardSequenceNumber();
        OpenClipboard(Some(owner)).unwrap();
        EmptyClipboard().unwrap();
        let memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()).unwrap();
        let pointer = GlobalLock(memory);
        assert!(!pointer.is_null());
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast(), bytes.len());
        let _ = GlobalUnlock(memory);
        SetClipboardData(13, Some(HANDLE(memory.0))).unwrap();
        // Keep synthetic probe text out of the running user's history.
        let privacy = highlighter_clipboard::capture::named_format(
            "ExcludeClipboardContentFromMonitorProcessing",
        )
        .unwrap();
        let privacy_memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, 4).unwrap();
        SetClipboardData(privacy, Some(HANDLE(privacy_memory.0))).unwrap();
        let before_close = GetClipboardSequenceNumber();
        CloseClipboard().unwrap();
        let after_close = GetClipboardSequenceNumber();
        assert!(IsClipboardFormatAvailable(13).is_ok());
        DestroyWindow(owner).unwrap();
        let after_owner_release = GetClipboardSequenceNumber();
        println!(
            "{}",
            serde_json::json!({"interactive":interactive,"before":before,"beforeClose":before_close,"afterClose":after_close,"afterOwnerRelease":after_owner_release,"oldWriterSequenceStillCurrent":before_close == after_owner_release})
        );
        if let Some((station, desktop)) = isolation {
            SetProcessWindowStation(original_station).unwrap();
            SetThreadDesktop(original_desktop).unwrap();
            CloseDesktop(desktop).unwrap();
            CloseWindowStation(station).unwrap();
        }
    }
}
