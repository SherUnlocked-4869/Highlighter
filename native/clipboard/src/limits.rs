//! Validation before decoding or allocating a potentially enormous bitmap, plus
//! the path-list rules shared by CF_HDROP capture, storage and clipboard writeback.
//! Everything here is pure so the file-list contract is unit-testable off a clipboard.
use std::collections::HashSet;

pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_ENCODED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DIB_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 16_000_000;
pub const MAX_DIMENSION: u32 = 32_768;

/// A clipboard file list is one user selection, not a directory listing.
pub const MAX_FILES: usize = 64;
/// The CF_HDROP global memory is bounded before copying it out of the clipboard.
pub const MAX_HDROP_BYTES: usize = 65_536;
/// One path stays well below the Win32 long-path ceiling; this only bounds memory.
pub const MAX_FILE_PATH_CHARS: usize = 8_192;
/// Payload mime for `files` rows: the LF-joined path list lives in `text_body`.
pub const FILES_MIME: &str = "application/x-highlighter-files;charset=utf-8";

const DROPFILES_HEADER_BYTES: usize = 20;

#[derive(Debug, PartialEq, Eq)]
pub enum Skip {
    Busy,
    Superseded,
    Private,
    Excluded,
    Unsupported,
    Oversized,
    InvalidEncoding,
    InvalidImage,
}

impl Skip {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Busy => "clipboard_busy",
            Self::Superseded => "superseded",
            Self::Private => "private",
            Self::Excluded => "excluded",
            Self::Unsupported => "unsupported",
            Self::Oversized => "oversized",
            Self::InvalidEncoding => "invalid_encoding",
            Self::InvalidImage => "invalid_image",
        }
    }
}

/// Decode one CF_HDROP global payload: a 20-byte DROPFILES header followed by a
/// wide path list (paths separated by NUL, the list ended by a second NUL).
///
/// Only the path strings are returned: file contents are never opened, links are
/// never dereferenced. The caller copies the global memory first, so this parser
/// only ever sees an already bounded byte slice.
pub fn parse_dropfiles(raw: &[u8]) -> Result<Vec<String>, Skip> {
    if raw.len() > MAX_HDROP_BYTES {
        return Err(Skip::Oversized);
    }
    if raw.len() < DROPFILES_HEADER_BYTES {
        return Err(Skip::Unsupported);
    }
    let offset = u32::from_le_bytes(raw[..4].try_into().unwrap()) as usize;
    if !(DROPFILES_HEADER_BYTES..=raw.len()).contains(&offset) {
        return Err(Skip::Unsupported);
    }
    // Legacy ANSI lists cannot be mapped back to reliable Unicode paths. Modern
    // Explorer and mainstream applications publish wide lists, so this is a skip.
    if i32::from_le_bytes(raw[16..20].try_into().unwrap()) == 0 {
        return Err(Skip::Unsupported);
    }
    let mut paths = Vec::new();
    let mut units = Vec::new();
    let mut cursor = offset;
    loop {
        if cursor + 2 > raw.len() {
            // A wide list ends with two NULs; a lone final terminator is malformed.
            return Err(Skip::InvalidEncoding);
        }
        let unit = u16::from_le_bytes([raw[cursor], raw[cursor + 1]]);
        cursor += 2;
        if unit != 0 {
            if units.len() == MAX_FILE_PATH_CHARS {
                return Err(Skip::Oversized);
            }
            units.push(unit);
            continue;
        }
        if units.is_empty() {
            // The NUL after the last path's terminator ends the list.
            if paths.is_empty() {
                return Err(Skip::Unsupported);
            }
            break;
        }
        paths.push(String::from_utf16(&units).map_err(|_| Skip::InvalidEncoding)?);
        units.clear();
    }
    validate_file_paths(paths)
}

/// Encode a path list as CF_HDROP bytes: `pFiles=20`, `pt=0`, `fNC=0`, `fWide=1`,
/// then UTF-16LE paths each NUL-terminated, with one more NUL closing the list.
/// The same validation as capture runs here, so an invalid body cannot be
/// published as a partial file list.
pub fn encode_dropfiles(paths: &[String]) -> Result<Vec<u8>, Skip> {
    let paths = validate_file_paths(paths.iter().cloned())?;
    let units: usize = paths.iter().map(|path| path.encode_utf16().count()).sum();
    let mut bytes = Vec::with_capacity(DROPFILES_HEADER_BYTES + 2 * (units + paths.len() + 1));
    bytes.extend_from_slice(&(DROPFILES_HEADER_BYTES as u32).to_le_bytes());
    bytes.extend_from_slice(&[0; 12]); // pt.x, pt.y, fNC
    bytes.extend_from_slice(&1i32.to_le_bytes()); // fWide
    for path in &paths {
        for unit in path.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    Ok(bytes)
}

/// Decode the stored LF-joined path list. Used by storage admission and again by
/// writeback so a body that bypassed the protocol validation never reaches the
/// clipboard unvalidated.
pub fn decode_file_list(body: &[u8]) -> Result<Vec<String>, Skip> {
    if body.len() > MAX_HDROP_BYTES {
        return Err(Skip::Oversized);
    }
    let text = std::str::from_utf8(body).map_err(|_| Skip::InvalidEncoding)?;
    validate_file_paths(text.split('\n').map(str::to_owned))
}

/// Validate a single path from a CF_HDROP list or a stored `files` body.
pub fn validate_file_path(path: &str) -> Result<(), Skip> {
    // NUL and every other control character would break the NUL-delimited list.
    if path.is_empty() || path.chars().any(|c| (c as u32) < 0x20) || !absolute_path(path) {
        return Err(Skip::Unsupported);
    }
    if path.encode_utf16().count() > MAX_FILE_PATH_CHARS {
        return Err(Skip::Oversized);
    }
    Ok(())
}

/// Validate, bound and case-insensitively de-duplicate a path list, keeping the
/// first-seen spelling and order. One bad path rejects the whole record: writing
/// back a truncated list would paste a different selection than the user copied.
pub fn validate_file_paths<I>(paths: I) -> Result<Vec<String>, Skip>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    // DROPFILES header + the final NUL; every kept path adds its own terminator.
    let mut encoded_bytes = DROPFILES_HEADER_BYTES + 2;
    for path in paths {
        validate_file_path(&path)?;
        if !seen.insert(path.to_lowercase()) {
            continue;
        }
        if kept.len() == MAX_FILES {
            return Err(Skip::Oversized);
        }
        encoded_bytes += 2 * path.encode_utf16().count() + 2;
        if encoded_bytes > MAX_HDROP_BYTES {
            return Err(Skip::Oversized);
        }
        kept.push(path);
    }
    if kept.is_empty() {
        return Err(Skip::Unsupported);
    }
    Ok(kept)
}

/// Only absolute paths are stored: drive-letter, UNC share, or the `\\?\` long
/// forms of both. Relative paths and `\\.\` device paths are rejected because
/// writeback could not round-trip them as a file list.
fn absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        return true;
    }
    let Some(rest) = path.strip_prefix("\\\\") else {
        return false;
    };
    if let Some(rest) = rest.strip_prefix("?\\") {
        // `\\?\` only disables path normalization; its tail must still be absolute.
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return unc_share(unc);
        }
        let tail = rest.as_bytes();
        return tail.len() >= 3
            && tail[0].is_ascii_alphabetic()
            && tail[1] == b':'
            && matches!(tail[2], b'\\' | b'/');
    }
    if rest.starts_with(".\\") {
        return false;
    }
    unc_share(rest)
}

fn unc_share(rest: &str) -> bool {
    let mut segments = rest.split(['\\', '/']);
    !segments.next().unwrap_or("").is_empty() && !segments.next().unwrap_or("").is_empty()
}

/// Preview is the first path's basename. Paths that end in a separator (`C:\`,
/// `\\server\share\`, directory copies) fall back to the full path; a blank
/// history row would hide that a file was recorded.
pub fn file_preview(path: &str) -> String {
    let basename = path.rsplit(['\\', '/']).next().unwrap_or("");
    let visible = if basename.is_empty() { path } else { basename };
    visible.chars().take(255).collect()
}

pub fn dimensions(width: u32, height: u32) -> Result<(u32, u32), Skip> {
    if width == 0 || height == 0 {
        return Err(Skip::InvalidImage);
    }
    if width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(Skip::Oversized);
    }
    Ok((width, height))
}

pub fn utf16_text(raw: &[u8]) -> Result<String, Skip> {
    if raw.len() > MAX_TEXT_BYTES * 2 + 2 {
        return Err(Skip::Oversized);
    }
    if !raw.len().is_multiple_of(2) {
        return Err(Skip::InvalidEncoding);
    }
    if !raw.chunks_exact(2).any(|pair| pair == [0, 0]) {
        return Err(Skip::InvalidEncoding);
    }
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect();
    let value = String::from_utf16(&units).map_err(|_| Skip::InvalidEncoding)?;
    if value.len() > MAX_TEXT_BYTES {
        return Err(Skip::Oversized);
    }
    Ok(value)
}

pub fn png_dimensions(raw: &[u8]) -> Result<(u32, u32), Skip> {
    if raw.len() > MAX_ENCODED_IMAGE_BYTES {
        return Err(Skip::Oversized);
    }
    if raw.len() < 33
        || &raw[..8] != b"\x89PNG\r\n\x1a\n"
        || &raw[12..16] != b"IHDR"
        || raw[8..12] != 13u32.to_be_bytes()
    {
        return Err(Skip::InvalidImage);
    }
    dimensions(
        u32::from_be_bytes(raw[16..20].try_into().unwrap()),
        u32::from_be_bytes(raw[20..24].try_into().unwrap()),
    )
}

pub fn dib_dimensions(raw: &[u8]) -> Result<(u32, u32), Skip> {
    if raw.len() > MAX_DIB_BYTES {
        return Err(Skip::Oversized);
    }
    if raw.len() < 40 {
        return Err(Skip::InvalidImage);
    }
    let header = u32::from_le_bytes(raw[..4].try_into().unwrap()) as usize;
    if !matches!(header, 40 | 108 | 124) || header > raw.len() {
        return Err(Skip::InvalidImage);
    }
    let width = i32::from_le_bytes(raw[4..8].try_into().unwrap());
    let height = i32::from_le_bytes(raw[8..12].try_into().unwrap());
    let planes = u16::from_le_bytes(raw[12..14].try_into().unwrap());
    let depth = u16::from_le_bytes(raw[14..16].try_into().unwrap());
    let compression = u32::from_le_bytes(raw[16..20].try_into().unwrap());
    if width <= 0
        || height == i32::MIN
        || planes != 1
        || !matches!(depth, 24 | 32)
        || !matches!(compression, 0 | 3)
    {
        return Err(Skip::InvalidImage);
    }
    let size = dimensions(width as u32, height.unsigned_abs())?;
    // BITMAPINFOHEADER with BI_BITFIELDS stores masks after the header.
    let offset = header
        + if header == 40 && compression == 3 {
            12
        } else {
            0
        };
    let stride = (u64::from(size.0) * u64::from(depth)).div_ceil(32) * 4;
    let required = stride
        .checked_mul(u64::from(size.1))
        .and_then(|n| n.checked_add(offset as u64))
        .ok_or(Skip::Oversized)?;
    if required > raw.len() as u64 {
        return Err(Skip::InvalidImage);
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_whitespace_and_rejects_surrogates() {
        let text = " \t中文\r\n ";
        let bytes: Vec<u8> = text
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(utf16_text(&bytes).unwrap(), text);
        assert_eq!(utf16_text(&[0, 0xd8]), Err(Skip::InvalidEncoding));
        assert_eq!(utf16_text(&[0]), Err(Skip::InvalidEncoding));
        assert_eq!(utf16_text(&[b'a', 0]), Err(Skip::InvalidEncoding));
    }
    #[test]
    fn rejects_dimension_bombs_before_decode() {
        assert_eq!(dimensions(u32::MAX, u32::MAX), Err(Skip::Oversized));
        assert_eq!(dimensions(1, 0), Err(Skip::InvalidImage));
        assert_eq!(dimensions(3840, 2160), Ok((3840, 2160)));
    }
    #[test]
    fn validates_dib_stride_and_required_bytes() {
        let mut raw = vec![0; 44];
        raw[..4].copy_from_slice(&40u32.to_le_bytes());
        raw[4..8].copy_from_slice(&1i32.to_le_bytes());
        raw[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        raw[12..14].copy_from_slice(&1u16.to_le_bytes());
        raw[14..16].copy_from_slice(&24u16.to_le_bytes());
        assert_eq!(dib_dimensions(&raw), Ok((1, 1)));
        raw.pop();
        assert_eq!(dib_dimensions(&raw), Err(Skip::InvalidImage));
    }

    /// Builds a CF_HDROP payload directly so malformed descriptors can be tested
    /// without the encoder's validation.
    fn wide_dropfiles(paths: &[&str], offset: usize, wide: bool) -> Vec<u8> {
        assert!(offset >= DROPFILES_HEADER_BYTES);
        let mut bytes = vec![0u8; offset];
        bytes[..4].copy_from_slice(&(offset as u32).to_le_bytes());
        bytes[16..20].copy_from_slice(&i32::from(wide).to_le_bytes());
        for path in paths {
            for unit in path.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes
    }

    #[test]
    fn parses_and_reencodes_wide_file_lists() {
        let paths = vec![
            "C:\\Users\\me\\a.txt".to_string(),
            "D:\\dir\\b.png".to_string(),
        ];
        let raw = encode_dropfiles(&paths).unwrap();
        assert_eq!(u32::from_le_bytes(raw[..4].try_into().unwrap()), 20);
        assert_eq!(raw[4..16], [0; 12]);
        assert_eq!(i32::from_le_bytes(raw[16..20].try_into().unwrap()), 1);
        assert_eq!(&raw[raw.len() - 2..], [0, 0]);
        assert_eq!(parse_dropfiles(&raw).unwrap(), paths);
    }

    #[test]
    fn parse_honours_the_pfiles_offset() {
        let raw = wide_dropfiles(&["C:\\a.txt"], 24, true);
        assert_eq!(parse_dropfiles(&raw).unwrap(), vec!["C:\\a.txt"]);
    }

    #[test]
    fn parse_rejects_malformed_descriptors() {
        let raw = encode_dropfiles(&["C:\\a.txt".to_string()]).unwrap();
        // Missing the second NUL that terminates the list.
        assert_eq!(
            parse_dropfiles(&raw[..raw.len() - 2]).unwrap_err(),
            Skip::InvalidEncoding
        );
        // Odd trailing byte instead of a whole UTF-16 unit.
        assert_eq!(
            parse_dropfiles(&raw[..raw.len() - 1]).unwrap_err(),
            Skip::InvalidEncoding
        );
        // A lone surrogate cannot become a Rust string.
        let mut lone = vec![0u8; DROPFILES_HEADER_BYTES];
        lone[..4].copy_from_slice(&(DROPFILES_HEADER_BYTES as u32).to_le_bytes());
        lone[16..20].copy_from_slice(&1i32.to_le_bytes());
        lone.extend_from_slice(&0xd800u16.to_le_bytes());
        lone.extend_from_slice(&0u16.to_le_bytes());
        lone.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(parse_dropfiles(&lone).unwrap_err(), Skip::InvalidEncoding);
        let mut ansi = raw.clone();
        ansi[16..20].copy_from_slice(&0i32.to_le_bytes());
        assert_eq!(parse_dropfiles(&ansi).unwrap_err(), Skip::Unsupported);
        assert_eq!(parse_dropfiles(&[0; 12]).unwrap_err(), Skip::Unsupported);
        let mut bad_offset = raw.clone();
        bad_offset[..4].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(parse_dropfiles(&bad_offset).unwrap_err(), Skip::Unsupported);
        let empty = wide_dropfiles(&[], 20, true);
        assert_eq!(parse_dropfiles(&empty).unwrap_err(), Skip::Unsupported);
        assert_eq!(
            parse_dropfiles(&vec![0; MAX_HDROP_BYTES + 2]).unwrap_err(),
            Skip::Oversized
        );
    }

    #[test]
    fn absolute_paths_only() {
        for path in [
            "C:\\a.txt",
            "c:/dir/file",
            "C:\\",
            "\\\\server\\share",
            "\\\\server\\share\\dir\\a.txt",
            "\\\\?\\C:\\dir\\a.txt",
            "\\\\?\\UNC\\server\\share\\a.txt",
        ] {
            assert!(validate_file_path(path).is_ok(), "{path:?}");
        }
        for path in [
            "",
            "relative\\a.txt",
            "C:",
            "C:relative",
            "\\a.txt",
            "\\\\.\\PhysicalDrive0",
            "\\\\server",
            "\\\\server\\",
            "\\\\?\\",
            "\\\\?\\foo\\bar",
            "C:\\bad\nname",
            "C:\\bad\0name",
        ] {
            assert_eq!(validate_file_path(path), Err(Skip::Unsupported), "{path:?}");
        }
    }

    #[test]
    fn rejects_lists_over_the_limits() {
        let many: Vec<String> = (0..=MAX_FILES).map(|i| format!("C:\\f{i}.txt")).collect();
        assert_eq!(validate_file_paths(many.clone()), Err(Skip::Oversized));
        assert_eq!(
            validate_file_paths(many[..MAX_FILES].to_vec()).unwrap().len(),
            MAX_FILES
        );
        // The path limit counts UTF-16 code units, not bytes.
        let longest = format!("C:\\{}", "a".repeat(MAX_FILE_PATH_CHARS - 3));
        assert!(validate_file_path(&longest).is_ok());
        let too_long = format!("C:\\{}", "a".repeat(MAX_FILE_PATH_CHARS - 2));
        assert_eq!(validate_file_path(&too_long), Err(Skip::Oversized));
        // The encoded DROPFILES buffer is bounded even below MAX_FILES distinct paths.
        let wide: Vec<String> = (0..9)
            .map(|i| format!("C:\\{}{i}", "b".repeat(3_900)))
            .collect();
        assert_eq!(validate_file_paths(wide), Err(Skip::Oversized));
    }

    #[test]
    fn dedupes_case_insensitively_keeping_first_spelling_and_order() {
        let paths = vec![
            "D:\\b.txt".to_string(),
            "C:\\A\\File.TXT".to_string(),
            "c:\\a\\file.txt".to_string(),
            "C:\\a.txt".to_string(),
        ];
        assert_eq!(
            validate_file_paths(paths).unwrap(),
            vec!["D:\\b.txt", "C:\\A\\File.TXT", "C:\\a.txt"]
        );
    }

    #[test]
    fn encode_rejects_invalid_or_empty_lists() {
        assert_eq!(encode_dropfiles(&[]).unwrap_err(), Skip::Unsupported);
        assert_eq!(
            encode_dropfiles(&["relative".to_string()]).unwrap_err(),
            Skip::Unsupported
        );
        assert_eq!(
            encode_dropfiles(&["C:\\ok.txt".to_string(), "\\\\.\\dev".to_string()]).unwrap_err(),
            Skip::Unsupported
        );
    }

    #[test]
    fn decodes_stored_bodies_with_the_same_rules() {
        assert_eq!(
            decode_file_list(b"C:\\a.txt\nD:\\b.txt").unwrap(),
            vec!["C:\\a.txt", "D:\\b.txt"]
        );
        assert_eq!(
            decode_file_list(b"C:\\A.txt\nc:\\a.txt").unwrap(),
            vec!["C:\\A.txt"]
        );
        assert_eq!(
            decode_file_list(b"C:\\a.txt\n").unwrap_err(),
            Skip::Unsupported
        );
        assert_eq!(decode_file_list(b"").unwrap_err(), Skip::Unsupported);
        assert_eq!(
            decode_file_list(&[0xff, 0xfe]).unwrap_err(),
            Skip::InvalidEncoding
        );
        assert_eq!(
            decode_file_list(&vec![b'C'; MAX_HDROP_BYTES + 1]).unwrap_err(),
            Skip::Oversized
        );
    }

    #[test]
    fn preview_falls_back_to_the_full_path_when_basename_is_empty() {
        assert_eq!(file_preview("C:\\dir\\a.txt"), "a.txt");
        assert_eq!(file_preview("C:/dir/a.txt"), "a.txt");
        assert_eq!(file_preview("C:\\"), "C:\\");
        assert_eq!(file_preview("\\\\server\\share"), "share");
        assert_eq!(file_preview("\\\\server\\share\\"), "\\\\server\\share\\");
        let long = format!("C:\\{}", "x".repeat(300));
        assert_eq!(file_preview(&long).chars().count(), 255);
    }
}
