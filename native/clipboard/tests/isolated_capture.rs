//! This test changes only the clipboard of a private, non-interactive window
//! station. Failure to create that isolation aborts before any clipboard write.
#![cfg(windows)]
use highlighter_clipboard::capture::{named_format, read_snapshot, read_snapshot_with_rules};
use highlighter_clipboard::limits::Skip;
use highlighter_clipboard::listener::Monitor;
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::*;
use windows::Win32::System::StationsAndDesktops::*;
use windows::Win32::UI::WindowsAndMessaging::*;

unsafe fn publish(owner: HWND, formats: &[(u32, &[u8])]) -> u32 {
    OpenClipboard(Some(owner)).unwrap();
    EmptyClipboard().unwrap();
    for (format, bytes) in formats {
        let allocation = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).unwrap();
        let pointer = GlobalLock(allocation);
        assert!(!pointer.is_null());
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast(), bytes.len());
        let _ = GlobalUnlock(allocation);
        // Clipboard owns the allocation on success; no borrowed pointers escape.
        SetClipboardData(*format, Some(HANDLE(allocation.0))).unwrap();
    }
    CloseClipboard().unwrap();
    GetClipboardSequenceNumber()
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !condition() {
        assert!(Instant::now() < deadline, "isolated listener timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "requires permission to create a private Windows window station; never uses the interactive clipboard"]
fn capture_and_restart_on_private_window_station() {
    unsafe {
        let original_station = GetProcessWindowStation().unwrap();
        let original_desktop =
            GetThreadDesktop(windows::Win32::System::Threading::GetCurrentThreadId()).unwrap();
        let name: Vec<u16> = format!("HighlighterClipboardTest-{}\0", std::process::id())
            .encode_utf16()
            .collect();
        let access = (WINSTA_ENUMDESKTOPS
            | WINSTA_READATTRIBUTES
            | WINSTA_ACCESSCLIPBOARD
            | WINSTA_CREATEDESKTOP) as u32;
        let station = CreateWindowStationW(PCWSTR(name.as_ptr()), 0, access, None)
            .expect("private station required");
        SetProcessWindowStation(station).expect("private station required");
        let desktop = CreateDesktopW(
            w!("ClipboardTest"),
            PCWSTR::null(),
            None,
            DESKTOP_CONTROL_FLAGS(0),
            0x1ff,
            None,
        )
        .expect("private desktop required");
        SetThreadDesktop(desktop).expect("private desktop required");
        assert_ne!(GetProcessWindowStation().unwrap(), original_station);
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

        let text = " \t合成测试\r\n🙂 ";
        let bytes: Vec<u8> = text
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        let sequence = publish(owner, &[(13, &bytes)]);
        let snapshot = read_snapshot(sequence).unwrap();
        assert_eq!(snapshot.kind, "text");
        assert_eq!(snapshot.bytes, text.as_bytes());
        assert_eq!(
            read_snapshot(sequence.wrapping_sub(1)).unwrap_err(),
            Skip::Superseded
        );

        for privacy in [
            "ExcludeClipboardContentFromMonitorProcessing",
            "Clipboard Viewer Ignore",
            "CanIncludeInClipboardHistory",
        ] {
            let sequence = publish(
                owner,
                &[
                    (13, &bytes),
                    (named_format(privacy).unwrap(), &0u32.to_le_bytes()),
                ],
            );
            assert_eq!(read_snapshot(sequence).unwrap_err(), Skip::Private);
        }
        // A malformed CF_HDROP descriptor stays a skip even with files enabled.
        let sequence = publish(owner, &[(13, &bytes), (15, &[0; 24])]);
        assert_eq!(read_snapshot(sequence).unwrap_err(), Skip::Unsupported);
        // A valid wide file list becomes a path-only `files` snapshot and wins over
        // the text format that an Explorer-like copy may also publish.
        let paths = [
            "C:\\合成\\a.txt".to_string(),
            "D:\\dir\\b.png".to_string(),
        ];
        let dropfiles = highlighter_clipboard::limits::encode_dropfiles(&paths).unwrap();
        let sequence = publish(owner, &[(13, &bytes), (15, dropfiles.as_slice())]);
        let snapshot = read_snapshot(sequence).unwrap();
        assert_eq!(snapshot.kind, "files");
        assert_eq!(snapshot.bytes, paths.join("\n").as_bytes());
        assert_eq!((snapshot.width, snapshot.height), (None, None));
        // Disabling file capture keeps CF_HDROP unsupported for a valid list too.
        let sequence = publish(owner, &[(15, dropfiles.as_slice())]);
        assert_eq!(
            read_snapshot_with_rules(sequence, true, true, false, &[]).unwrap_err(),
            Skip::Unsupported
        );

        for _ in 0..3 {
            let mut monitor = Monitor::start().unwrap();
            assert_eq!(monitor.status()["enabled"], false);
            monitor.configure(true).unwrap();
            publish(owner, &[(13, &bytes)]);
            wait_until(|| monitor.status()["accepted"].as_u64().unwrap() == 1);
            monitor.configure(false).unwrap();
            publish(owner, &[(13, &bytes)]);
            monitor.stop().unwrap();
            assert_eq!(monitor.status()["accepted"], 1);
        }
        DestroyWindow(owner).unwrap();
        SetThreadDesktop(original_desktop).unwrap();
        SetProcessWindowStation(original_station).unwrap();
        CloseDesktop(desktop).unwrap();
        CloseWindowStation(station).unwrap();
    }
}
