//! Binary options-patch (FR-FLASH-03, Decision #3 "Hybrid" common case).
//!
//! ExpressLRS 3.0+ pre-built binaries embed a fixed-capacity, delimited region
//! that holds the device options as JSON. The configurator overwrites that
//! region in place — no compilation. This module reproduces that splice.
//!
//! Region layout in the firmware image (little-endian), as used by the ELRS
//! `binary_configurator.py`:
//!
//! ```text
//! [ 8-byte magic ][ u16 capacity ][ capacity bytes: JSON, zero-padded ]
//! ```
//!
//! The magic [`OPTIONS_DELIMITER`] is the single integration point with a real
//! firmware build; the splice itself (locate -> length-check -> overwrite ->
//! zero-pad) is fully exercised by the tests below against synthetic images.

use crate::flash::{ErrorCategory, FlashError};

/// 8-byte sentinel marking the start of the ELRS options region. Matches the
/// constant ExpressLRS embeds ahead of the JSON options buffer.
pub const OPTIONS_DELIMITER: [u8; 8] = [0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE, 0xF0, 0x0D];

/// Locate the options region and return `(json_start, capacity)`.
fn locate_region(firmware: &[u8]) -> Result<(usize, usize), FlashError> {
    let pos = find_subslice(firmware, &OPTIONS_DELIMITER).ok_or_else(|| {
        FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "noOptionsRegion",
            "firmware image has no ExpressLRS options region (delimiter not found)",
        )
    })?;
    let len_at = pos + OPTIONS_DELIMITER.len();
    if firmware.len() < len_at + 2 {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "truncatedOptionsRegion",
            "firmware ends before the options-region length field",
        ));
    }
    let capacity = u16::from_le_bytes([firmware[len_at], firmware[len_at + 1]]) as usize;
    let json_start = len_at + 2;
    if firmware.len() < json_start + capacity {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "truncatedOptionsRegion",
            "firmware ends before the end of the declared options region",
        ));
    }
    Ok((json_start, capacity))
}

/// Splice `options_json` into `firmware`'s options region in place.
///
/// Fails (without mutating) if the region is missing or the JSON doesn't fit —
/// never leaves a half-written image (NFR-REL-01).
pub fn patch_binary(firmware: &mut [u8], options_json: &[u8]) -> Result<(), FlashError> {
    let (json_start, capacity) = locate_region(firmware)?;
    if options_json.len() > capacity {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "optionsTooLarge",
            format!(
                "options JSON is {} bytes but the firmware region only holds {capacity}",
                options_json.len()
            ),
        ));
    }
    firmware[json_start..json_start + options_json.len()].copy_from_slice(options_json);
    // Zero-pad the remainder so a previous, longer patch can't leave trailing
    // bytes that corrupt the JSON the device parses.
    for b in &mut firmware[json_start + options_json.len()..json_start + capacity] {
        *b = 0;
    }
    Ok(())
}

/// Read back the JSON currently stored in the options region (trimmed of the
/// zero padding). Used to verify a patch round-trips and by the engine tests.
#[allow(dead_code)] // verification/round-trip helper; exercised by tests
pub fn read_options(firmware: &[u8]) -> Result<Vec<u8>, FlashError> {
    let (json_start, capacity) = locate_region(firmware)?;
    let region = &firmware[json_start..json_start + capacity];
    let end = region.iter().position(|&b| b == 0).unwrap_or(capacity);
    Ok(region[..end].to_vec())
}

/// Naive substring search (firmware images are small enough that this is fine).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic firmware image with an options region of `capacity`
    /// bytes, surrounded by arbitrary "code".
    fn synthetic(capacity: u16) -> Vec<u8> {
        let mut fw = vec![0xAAu8; 32]; // leading "code"
        fw.extend_from_slice(&OPTIONS_DELIMITER);
        fw.extend_from_slice(&capacity.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, capacity as usize));
        fw.extend_from_slice(&[0x55u8; 16]); // trailing "code"
        fw
    }

    #[test]
    fn patches_and_reads_back() {
        let mut fw = synthetic(128);
        let json = br#"{"uid":[1,2,3,4,5,6]}"#;
        patch_binary(&mut fw, json).unwrap();
        assert_eq!(read_options(&fw).unwrap(), json);
    }

    #[test]
    fn leading_and_trailing_code_untouched() {
        let mut fw = synthetic(64);
        let before_lead = fw[..32].to_vec();
        let trailing = fw[fw.len() - 16..].to_vec();
        patch_binary(&mut fw, br#"{"domain":3}"#).unwrap();
        assert_eq!(&fw[..32], &before_lead[..]);
        assert_eq!(&fw[fw.len() - 16..], &trailing[..]);
    }

    #[test]
    fn shorter_patch_zero_pads_previous() {
        let mut fw = synthetic(64);
        patch_binary(&mut fw, br#"{"a":111111111}"#).unwrap();
        patch_binary(&mut fw, br#"{"b":1}"#).unwrap();
        // The trailing bytes of the longer first write must be gone.
        assert_eq!(read_options(&fw).unwrap(), br#"{"b":1}"#);
    }

    #[test]
    fn rejects_oversized_options_without_mutating() {
        let mut fw = synthetic(8);
        let before = fw.clone();
        let err = patch_binary(&mut fw, br#"{"this":"is too long for 8 bytes"}"#).unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "optionsTooLarge");
        assert_eq!(fw, before, "image must be unchanged on failure");
    }

    #[test]
    fn rejects_missing_region() {
        let mut fw = vec![0u8; 100];
        let err = patch_binary(&mut fw, b"{}").unwrap_err();
        assert_eq!(err.summary_key, "noOptionsRegion");
    }

    #[test]
    fn exact_fit_options_succeed_and_read_back_fully() {
        // M29 boundary: options JSON exactly filling the region (len == capacity)
        // must succeed and read back byte-for-byte with no truncation.
        let json = br#"{"d":3}"#; // 7 bytes
        let mut fw = synthetic(json.len() as u16);
        patch_binary(&mut fw, json).unwrap();
        assert_eq!(read_options(&fw).unwrap(), json);
    }

    #[test]
    fn one_byte_over_capacity_is_rejected_without_mutating() {
        // M29 boundary: a single byte past the region capacity is the first failing
        // case — it must be refused (optionsTooLarge) and leave the image untouched.
        let mut fw = synthetic(8);
        let before = fw.clone();
        let json = b"123456789"; // 9 bytes into an 8-byte region
        let err = patch_binary(&mut fw, json).unwrap_err();
        assert_eq!(err.summary_key, "optionsTooLarge");
        assert_eq!(fw, before, "must not mutate on a one-byte overflow");
    }
}
