#![windows_subsystem = "windows"]

use std::{ffi::c_void, process::ExitCode, ptr};

static SHUTTER: &[u8] = include_bytes!("../../assets/shutter.wav");

#[link(name = "winmm")]
extern "system" {
    fn PlaySoundW(sound: *const u16, module: *mut c_void, flags: u32) -> i32;
}

fn main() -> ExitCode {
    const SND_MEMORY: u32 = 0x0004;
    const SND_NODEFAULT: u32 = 0x0002;
    // Synchronous playback keeps the helper and its embedded WAV alive until the click finishes.
    let played = unsafe {
        PlaySoundW(
            SHUTTER.as_ptr().cast(),
            ptr::null_mut(),
            SND_MEMORY | SND_NODEFAULT,
        )
    };
    if played == 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
