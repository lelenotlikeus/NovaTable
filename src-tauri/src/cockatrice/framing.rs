use thiserror::Error;

pub const DEFAULT_MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
const LEGACY_V14_PREAMBLE_SIZE: usize = 60;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("incoming frame is {actual} bytes; the configured maximum is {maximum}")]
    FrameTooLarge { actual: usize, maximum: usize },
}

pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > u32::MAX as usize {
        return Err(FrameError::FrameTooLarge {
            actual: payload.len(),
            maximum: u32::MAX as usize,
        });
    }

    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

#[derive(Debug)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    maximum_frame_size: usize,
    legacy_preamble_checked: bool,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FRAME_SIZE)
    }
}

impl FrameDecoder {
    pub fn new(maximum_frame_size: usize) -> Self {
        Self {
            buffer: Vec::new(),
            maximum_frame_size,
            legacy_preamble_checked: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        let mut decoded = Vec::new();

        if !self.legacy_preamble_checked {
            if self.buffer.len() < 4 {
                return Ok(decoded);
            }

            if self.buffer.starts_with(b"<?xm") {
                if self.buffer.len() < LEGACY_V14_PREAMBLE_SIZE {
                    return Ok(decoded);
                }
                self.buffer.drain(..LEGACY_V14_PREAMBLE_SIZE);
            }

            self.legacy_preamble_checked = true;
        }

        loop {
            if self.buffer.len() < 4 {
                break;
            }

            let payload_size =
                u32::from_be_bytes(self.buffer[..4].try_into().expect("four bytes")) as usize;
            if payload_size > self.maximum_frame_size {
                return Err(FrameError::FrameTooLarge {
                    actual: payload_size,
                    maximum: self.maximum_frame_size,
                });
            }

            let frame_size = 4 + payload_size;
            if self.buffer.len() < frame_size {
                break;
            }

            decoded.push(self.buffer[4..frame_size].to_vec());
            self.buffer.drain(..frame_size);
        }

        Ok(decoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_big_endian_length_prefix() {
        let frame = encode_frame(&[0xAA, 0xBB, 0xCC]).unwrap();
        assert_eq!(frame, vec![0, 0, 0, 3, 0xAA, 0xBB, 0xCC]);
    }

    #[test]
    fn decodes_fragmented_and_coalesced_frames() {
        let mut decoder = FrameDecoder::default();
        let mut wire = encode_frame(b"first").unwrap();
        wire.extend(encode_frame(b"second").unwrap());

        assert!(decoder.push(&wire[..3]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&wire[3..]).unwrap(),
            vec![b"first".to_vec(), b"second".to_vec()]
        );
    }

    #[test]
    fn skips_the_legacy_v14_xml_preamble() {
        let mut decoder = FrameDecoder::default();
        let mut wire = b"<?xml".to_vec();
        wire.resize(LEGACY_V14_PREAMBLE_SIZE, b' ');
        wire.extend(encode_frame(b"message").unwrap());

        assert_eq!(decoder.push(&wire).unwrap(), vec![b"message".to_vec()]);
    }

    #[test]
    fn rejects_frames_over_the_configured_limit() {
        let mut decoder = FrameDecoder::new(3);
        let error = decoder.push(&[0, 0, 0, 4]).unwrap_err();
        assert_eq!(
            error,
            FrameError::FrameTooLarge {
                actual: 4,
                maximum: 3
            }
        );
    }
}
