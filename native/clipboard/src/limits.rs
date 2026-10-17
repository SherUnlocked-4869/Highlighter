//! Validation before decoding or allocating a potentially enormous bitmap.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_ENCODED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DIB_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 16_000_000;
pub const MAX_DIMENSION: u32 = 32_768;

#[derive(Debug, PartialEq, Eq)]
pub enum Skip {
    Busy,
    Superseded,
    Private,
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
            Self::Unsupported => "unsupported",
            Self::Oversized => "oversized",
            Self::InvalidEncoding => "invalid_encoding",
            Self::InvalidImage => "invalid_image",
        }
    }
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
}
