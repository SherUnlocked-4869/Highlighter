#![cfg(windows)]
use highlighter_clipboard::listener::Monitor;

#[test]
fn paused_listener_stops_and_restarts_without_reading_payloads() {
    for _ in 0..3 {
        let mut monitor = Monitor::start().unwrap();
        assert_eq!(monitor.status()["enabled"], false);
        assert_eq!(monitor.status()["accepted"], 0);
        monitor.stop().unwrap();
        monitor.stop().unwrap();
    }
}
