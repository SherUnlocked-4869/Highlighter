//! Length-prefixed, bounded control and binary frames. No clipboard contents
//! are written to diagnostics or to a newline-delimited logging channel.
use serde_json::Value;
use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_HEADER: usize = 512 * 1024;
pub const MAX_CHUNK: usize = 256 * 1024;

#[derive(Debug)]
pub struct Frame {
    pub header: Value,
    pub payload: Vec<u8>,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid clipboard protocol frame",
    )
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut prefix = [0u8; 4];
    if reader.read(&mut prefix[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut prefix[1..])?;
    let size = u32::from_le_bytes(prefix) as usize;
    if !(5..=MAX_FRAME).contains(&size) {
        return Err(invalid());
    }
    // Read and validate the fixed header before allocating the advertised body.
    let mut fixed = [0u8; 5];
    reader.read_exact(&mut fixed)?;
    let kind = fixed[0];
    let header_size = u32::from_le_bytes(fixed[1..].try_into().unwrap()) as usize;
    if header_size > MAX_HEADER || header_size > size - 5 {
        return Err(invalid());
    }
    let payload_size = size - 5 - header_size;
    if !matches!(kind, 1 | 2) || (kind == 1 && payload_size != 0) || payload_size > MAX_CHUNK {
        return Err(invalid());
    }
    let mut json = vec![0u8; header_size];
    reader.read_exact(&mut json)?;
    let header: Value = serde_json::from_slice(&json).map_err(|_| invalid())?;
    if !header.is_object() {
        return Err(invalid());
    }
    let mut payload = vec![0u8; payload_size];
    reader.read_exact(&mut payload)?;
    Ok(Some(Frame { header, payload }))
}

pub fn write_frame(writer: &mut impl Write, header: &Value, payload: &[u8]) -> io::Result<()> {
    let json = serde_json::to_vec(header).map_err(|_| invalid())?;
    if !header.is_object() || json.len() > MAX_HEADER || payload.len() > MAX_CHUNK {
        return Err(invalid());
    }
    let size = 5 + json.len() + payload.len();
    if size > MAX_FRAME {
        return Err(invalid());
    }
    writer.write_all(&(size as u32).to_le_bytes())?;
    writer.write_all(&[if payload.is_empty() { 1 } else { 2 }])?;
    writer.write_all(&(json.len() as u32).to_le_bytes())?;
    writer.write_all(&json)?;
    writer.write_all(payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn concatenated_frames_and_binary_are_not_json_lines() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({"requestId":"1","text":"\n中文"}), &[]).unwrap();
        write_frame(&mut bytes, &json!({"streamId":"2"}), &[0, 10, 255]).unwrap();
        let mut input = Cursor::new(bytes);
        assert_eq!(
            read_frame(&mut input).unwrap().unwrap().header["requestId"],
            "1"
        );
        assert_eq!(
            read_frame(&mut input).unwrap().unwrap().payload,
            [0, 10, 255]
        );
        assert!(read_frame(&mut input).unwrap().is_none());
    }

    #[test]
    fn rejects_truncated_prefix_body_and_unbounded_lengths() {
        for bytes in [
            vec![1],
            (u32::MAX).to_le_bytes().to_vec(),
            vec![5, 0, 0, 0, 1],
        ] {
            assert!(read_frame(&mut Cursor::new(bytes)).is_err());
        }
        let mut header_only = vec![5, 0, 0, 0, 1];
        header_only.extend_from_slice(&(MAX_HEADER as u32 + 1).to_le_bytes());
        assert!(read_frame(&mut Cursor::new(header_only)).is_err());
    }

    #[test]
    fn rejects_payload_on_control_and_scalar_json() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({}), &[1]).unwrap();
        bytes[4] = 1;
        assert!(read_frame(&mut Cursor::new(bytes)).is_err());
        assert!(write_frame(&mut Vec::new(), &json!(5), &[]).is_err());
        assert!(write_frame(&mut Vec::new(), &json!({}), &vec![0; MAX_CHUNK + 1]).is_err());
    }
}
