//! 运行环境取证：进程完整性级别（Integrity Level）。
//!
//! 背景（2026-11-11）：仓库工作区目录树带有 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`
//! 继承，工作区内编译出的 exe 因此以 **Low IL** 运行（可用复制 whoami.exe 对照复现）。
//! Low IL 会受 UIPI/No-Write-Up 限制，可能影响 WGC/窗口采集等依赖权限的能力，
//! 因此每次运行都把本进程 IL 写入 `run.log`，供“修复 ACL 后重验”对照。
//!
//! 实现：OpenProcessToken(TOKEN_QUERY) → GetTokenInformation(TokenIntegrityLevel) →
//! 手工解析 SID（revision / subauthority count / 48-bit authority / 子授权），
//! 取最后一个子授权 RID 映射到 Untrusted/Low/Medium/High/System。

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TokenIntegrityLevel, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// 返回进程完整性级别名称（例如 `Low(0x1000)`）；查询失败返回 `unknown`。
pub fn process_integrity_level() -> String {
    unsafe {
        let process_token = GetCurrentProcess();
        let mut token = HANDLE::default();
        if OpenProcessToken(process_token, TOKEN_QUERY, &mut token).is_err() {
            return "unknown".to_string();
        }
        let mut needed: u32 = 0;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
        let mut buf = vec![0u8; (needed.max(32)) as usize];
        let ok = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            needed,
            &mut needed,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return "unknown".to_string();
        }
        // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes } }
        let sid_ptr = (buf.as_ptr() as *const *const u8).read_unaligned();
        if sid_ptr.is_null() {
            return "unknown".to_string();
        }
        let revision = sid_ptr.read();
        let subauth_count = sid_ptr.add(1).read();
        if revision != 1 || subauth_count == 0 {
            return format!("invalid-sid(rev={revision},count={subauth_count})");
        }
        // 48-bit identifier authority（大端），用于区分 NT AUTHORITY(0x10)/其它。
        let mut authority: u64 = 0;
        for i in 2..8 {
            authority = (authority << 8) | sid_ptr.add(i).read() as u64;
        }
        // 最后一个子授权（小端）。
        let off = 8 + (subauth_count as usize - 1) * 4;
        let mut rid: u32 = 0;
        for i in (0..4).rev() {
            rid = (rid << 8) | sid_ptr.add(off + i).read() as u32;
        }
        if authority != 0x10 {
            return format!("other-il(auth=0x{authority:X},rid=0x{rid:X})");
        }
        let name = match rid {
            0x0000..=0x0FFF => "Untrusted",
            0x1000..=0x1FFF => "Low",
            0x2000..=0x2FFF => "Medium",
            0x3000..=0x3FFF => "High",
            _ => "System",
        };
        format!("{name}(0x{rid:X})")
    }
}
