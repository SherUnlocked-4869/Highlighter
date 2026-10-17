//! Image work is serial and runs only after CloseClipboard. The input, decoded
//! bitmap and encoded output have independent limits; no animation is retained.
use crate::limits;
use image::{ImageFormat, ImageReader, Limits};
use std::io::{Cursor, Write};

pub struct PreparedImage {
    pub png: Vec<u8>,
    pub thumbnail: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

struct BoundedOutput(Vec<u8>);
impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > limits::MAX_ENCODED_IMAGE_BYTES {
            return Err(std::io::ErrorKind::FileTooLarge.into());
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode(image: &image::DynamicImage) -> Result<Vec<u8>, &'static str> {
    use image::ImageEncoder;
    let mut output = BoundedOutput(Vec::new());
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(|_| "IMAGE_ENCODING_FAILED")?;
    Ok(output.0)
}

pub fn prepare(kind: &str, bytes: &[u8]) -> Result<PreparedImage, &'static str> {
    let mut bmp = Vec::new();
    let (input, format) = if kind == "png" {
        limits::png_dimensions(bytes).map_err(|_| "INVALID_IMAGE")?;
        // Reject APNG, including ancillary animation chunks before IDAT.
        let mut offset = 8usize;
        while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
            let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            if &bytes[offset + 4..offset + 8] == b"acTL" {
                return Err("ANIMATED_IMAGE");
            }
            offset = offset
                .checked_add(length)
                .and_then(|n| n.checked_add(12))
                .ok_or("INVALID_IMAGE")?;
        }
        (bytes, ImageFormat::Png)
    } else if kind == "dib" {
        limits::dib_dimensions(bytes).map_err(|_| "INVALID_IMAGE")?;
        let header = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        // V5 embedded colour profiles need a separate, qualified conversion.
        if header == 124 && (bytes[112..120].iter().any(|b| *b != 0)) {
            return Err("UNSUPPORTED_IMAGE");
        }
        let compression = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        let offset = 14
            + header
            + if header == 40 && compression == 3 {
                12
            } else {
                0
            };
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&((bytes.len() + 14) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&offset.to_le_bytes());
        bmp.extend_from_slice(bytes);
        (&bmp[..], ImageFormat::Bmp)
    } else {
        return Err("UNSUPPORTED_IMAGE");
    };
    let mut reader = ImageReader::with_format(Cursor::new(input), format);
    let mut budget = Limits::default();
    budget.max_image_width = Some(limits::MAX_DIMENSION);
    budget.max_image_height = Some(limits::MAX_DIMENSION);
    budget.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(budget);
    let decoded = reader.decode().map_err(|_| "INVALID_IMAGE")?;
    drop(bmp); // Do not retain the BMP container while allocating encoded PNG.
    let (width, height) =
        limits::dimensions(decoded.width(), decoded.height()).map_err(|_| "INVALID_IMAGE")?;
    // <=240x240 RGBA also fits the 256KiB protocol chunk in the worst case.
    let thumbnail = encode(&image::DynamicImage::ImageRgba8(
        decoded.thumbnail(240, 240).into_rgba8(),
    ))?;
    if thumbnail.len() > 256 * 1024 {
        return Err("IMAGE_ENCODING_FAILED");
    }
    let png = if kind == "png" {
        bytes.to_vec()
    } else {
        encode(&decoded)?
    };
    Ok(PreparedImage {
        png,
        thumbnail,
        width,
        height,
    })
}
