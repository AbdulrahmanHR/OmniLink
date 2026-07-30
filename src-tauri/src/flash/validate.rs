//! Local firmware-file pre-flash validation (M25).
//!
//! When the user picks a firmware `.bin` off disk (instead of a GitHub release),
//! we cannot trust that it matches the connected hardware — flashing a TX image
//! onto an RX (or a corrupt/foreign file) can brick the device. This module
//! holds the **pure, hardware-independent** inspection + compatibility decision
//! so it is fully unit-testable with no Tauri runtime and no device:
//!
//! * [`inspect_firmware`] — size/sanity + integrity (is this an ExpressLRS image
//!   at all?) + best-effort extraction of the embedded build-target string.
//! * [`check_local_firmware_compatibility`] — the TX-vs-RX class + target-name
//!   alignment decision against the connected/selected hardware.
//! * [`validate_local_firmware`] — the combined gate the engine calls in the
//!   *fetch* stage, **before** any erase/write reaches the device.
//!
//! Every rejection is a categorised [`FlashError`] reusing the same
//! `{category, summaryKey, detail}` shape as the rest of the flash engine, so
//! the UI renders a localised, actionable message (e.g. `targetMismatch`).
//!
//! Target identification is necessarily heuristic — a pre-built ELRS binary
//! embeds its build-target name as an ASCII string, but there is no formal
//! header we can rely on. The heuristics here are deliberately conservative:
//! they only *reject* when we can positively prove a mismatch (a clearly
//! classifiable TX/RX target that conflicts with the hardware), and otherwise
//! fall through to the existing TX/RX guard. This avoids false rejections of
//! legitimate images we simply cannot fully fingerprint.

use crate::flash::patch::OPTIONS_DELIMITER;
use crate::flash::{DeviceType, ErrorCategory, FlashError};

/// Lower sanity bound for a firmware image. Anything smaller is a truncated
/// download or a wrong file (a real ELRS `firmware.bin` is hundreds of KiB);
/// kept modest so it only ever catches obviously-broken inputs.
const MIN_FIRMWARE_BYTES: usize = 1024;

/// Upper sanity bound. ESP32/ESP8285 application images are a few MiB at most;
/// a far larger file is not a single-target firmware binary.
///
/// Public because the *download* has to enforce the same ceiling **while** the
/// body streams in — checking it here, after the whole response is already in
/// RAM, is too late (see `engine::RealBackend::acquire_firmware`).
pub const MAX_FIRMWARE_BYTES: usize = 16 * 1024 * 1024;

/// Minimum length for an ASCII run to be considered a build-target candidate.
const MIN_TARGET_LEN: usize = 6;

/// What [`inspect_firmware`] could learn about a local `.bin`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirmwareInfo {
    /// Size in bytes (already range-checked when this is returned).
    pub size: usize,
    /// Whether the ExpressLRS options-region delimiter is present (i.e. this
    /// looks like a genuine pre-built ELRS image).
    pub has_options_region: bool,
    /// Best-effort embedded build-target string (e.g. `"BETAFPV_2400_TX"`), or
    /// `None` when no target-shaped ASCII run could be found.
    pub target_name: Option<String>,
    /// Device class inferred from [`Self::target_name`], when unambiguous.
    pub device_type: Option<DeviceType>,
}

/// Normalize a target string for comparison: lowercase + alphanumerics only.
/// Mirrors the frontend `normalizeTarget` so `"Jumper AION 2400 TX"` and
/// `"JUMPER_AION_2400_TX"` compare equal.
fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Classify a target name as TX or RX. ELRS targets carry a `TX`/`RX` token;
/// when both or neither are present the class is ambiguous (`None`) and the
/// caller falls back to the connected-device guard.
fn classify_device_type(target: &str) -> Option<DeviceType> {
    let up = target.to_ascii_uppercase();
    match (up.contains("TX"), up.contains("RX")) {
        (true, false) => Some(DeviceType::Tx),
        (false, true) => Some(DeviceType::Rx),
        _ => None,
    }
}

/// Whether two target names refer to the same hardware: an exact match after
/// [`normalize`], and nothing looser.
///
/// This used to also accept one name being a *substring* of the other, which
/// silently defeated the gate: the catalogue ships both `BETAFPV_2400_TX` and
/// `BETAFPV_2400_TX_MICRO_1W`, normalizing to `betafpv2400tx` and
/// `betafpv2400txmicro1w`, so the 1W image (different PA tables) passed the
/// alignment check for the 250mW target and was written to the hardware.
/// Overlapping-but-unequal names are positive proof of a DIFFERENT target, so
/// they must fail. Abstention lives in the *callers* — they only reach here once
/// both names are known — so tightening this never turns an unknown into a
/// rejection.
///
/// Deliberately stricter than the frontend `findTargetByName`, which is a UI
/// pre-selection guess and explicitly not a safety gate.
pub fn targets_align(a: &str, b: &str) -> bool {
    let (na, nb) = (normalize(a), normalize(b));
    !na.is_empty() && na == nb
}

/// True if `s` looks like an ELRS build target: has a `_` separator, an
/// alphabetic character, and a recognizable `TX`/`RX` class token. Restricting
/// to classifiable runs keeps random embedded ASCII (JSON keys, paths) from
/// being mistaken for a target.
fn looks_like_target(s: &str) -> bool {
    s.len() >= MIN_TARGET_LEN
        && s.contains('_')
        && s.chars().any(|c| c.is_ascii_alphabetic())
        && classify_device_type(s).is_some()
}

/// Best-effort scan for the embedded build-target string. Walks maximal runs of
/// the target charset (`[A-Z0-9_]`) and returns the longest one that
/// [`looks_like_target`]. Returns `None` when nothing target-shaped is found —
/// a non-fatal outcome (the caller still applies the connected-device guard).
fn extract_target_name(bytes: &[u8]) -> Option<String> {
    let mut best: Option<String> = None;
    let mut cur = String::new();

    let consider = |cur: &mut String, best: &mut Option<String>| {
        if looks_like_target(cur) && best.as_ref().is_none_or(|b| cur.len() > b.len()) {
            *best = Some(cur.clone());
        }
        cur.clear();
    };

    for &b in bytes {
        if b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' {
            cur.push(b as char);
        } else {
            consider(&mut cur, &mut best);
        }
    }
    consider(&mut cur, &mut best);
    best
}

/// Naive substring search (firmware images are small enough that this is fine);
/// mirrors the helper in [`crate::flash::patch`].
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack.len() >= needle.len()
        && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Inspect a local firmware image: size/sanity + integrity + target extraction.
///
/// Returns a categorised [`FlashError`] (never panics) when the file is empty,
/// implausibly small/large, or carries no ExpressLRS options region (i.e. it is
/// not a recognizable ELRS image and must not be flashed).
pub fn inspect_firmware(bytes: &[u8]) -> Result<FirmwareInfo, FlashError> {
    if bytes.len() < MIN_FIRMWARE_BYTES {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "firmwareTooSmall",
            format!(
                "file is {} bytes — too small to be a valid firmware image (min {MIN_FIRMWARE_BYTES})",
                bytes.len()
            ),
        ));
    }
    if bytes.len() > MAX_FIRMWARE_BYTES {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "firmwareTooLarge",
            format!(
                "file is {} bytes — too large to be a valid firmware image (max {MAX_FIRMWARE_BYTES})",
                bytes.len()
            ),
        ));
    }
    let has_options_region = contains_subslice(bytes, &OPTIONS_DELIMITER);
    if !has_options_region {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "notElrsFirmware",
            "file has no ExpressLRS options region — it is not a recognizable ELRS firmware image",
        ));
    }
    let target_name = extract_target_name(bytes);
    let device_type = target_name.as_deref().and_then(classify_device_type);
    Ok(FirmwareInfo {
        size: bytes.len(),
        has_options_region,
        target_name,
        device_type,
    })
}

/// Decide whether an inspected image is safe to flash onto the target hardware.
///
/// Two positive-proof rejections (both categorised `FirmwareMismatch` with the
/// `targetMismatch` summary so the UI shows one localized safety warning):
///
/// 1. **TX-vs-RX class** — when the image embeds a classifiable TX/RX target,
///    its class must match the *connected* device (when known) or otherwise the
///    *selected* target's class. A TX image on an RX device is blocked here.
/// 2. **Target-name alignment** — when the image embeds a target name, it must
///    align with the wizard-selected build target.
///
/// When the image is not confidently identifiable, neither check fires and the
/// flash is allowed (the connected-device guard still applies upstream).
pub fn check_local_firmware_compatibility(
    info: &FirmwareInfo,
    expected_target: &str,
    expected_device_type: DeviceType,
    connected_device_type: Option<DeviceType>,
) -> Result<(), FlashError> {
    if let Some(bin_type) = info.device_type {
        let against = connected_device_type.unwrap_or(expected_device_type);
        if bin_type != against {
            return Err(FlashError::new(
                ErrorCategory::FirmwareMismatch,
                "targetMismatch",
                format!(
                    "local firmware is a {bin_type:?} image but the device is a {against:?} — refusing to flash"
                ),
            ));
        }
    }
    if let Some(name) = &info.target_name {
        if !targets_align(name, expected_target) {
            return Err(FlashError::new(
                ErrorCategory::FirmwareMismatch,
                "targetMismatch",
                format!(
                    "local firmware target '{name}' does not match the selected target '{expected_target}'"
                ),
            ));
        }
    }
    Ok(())
}

/// Combined pre-flash gate the engine runs against the bytes it is about to
/// flash. `Ok` (with the inspected [`FirmwareInfo`]) means the image is a
/// plausible ELRS image that matches the hardware; an `Err` is a categorised,
/// localizable refusal that the engine returns **before** touching the device.
///
/// Named for its original caller (the M25 user-selected local `.bin`), but it
/// is now the gate for DOWNLOADED images too (FLASH-2/FWCHK-5): with no asset
/// digest published anywhere the code reads, these heuristics plus the HTTP
/// `Content-Length` check are the strongest verification available, and bytes
/// off the network deserve at least the scrutiny a file off disk gets. The
/// compile-from-source and Backpack paths are deliberately exempt — see the
/// call site in [`crate::flash::engine::run_flash`].
pub fn validate_local_firmware(
    bytes: &[u8],
    expected_target: &str,
    expected_device_type: DeviceType,
    connected_device_type: Option<DeviceType>,
) -> Result<FirmwareInfo, FlashError> {
    let info = inspect_firmware(bytes)?;
    check_local_firmware_compatibility(
        &info,
        expected_target,
        expected_device_type,
        connected_device_type,
    )?;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic ELRS-like image: leading non-ASCII "code", the embedded
    /// build-target string, the options-region delimiter + a small zeroed region,
    /// and padding so the whole thing clears [`MIN_FIRMWARE_BYTES`].
    fn synthetic_firmware(target: &str) -> Vec<u8> {
        let cap: u16 = 256;
        let mut fw = vec![0xAAu8; 64]; // leading "code" (non-ASCII)
        fw.extend_from_slice(target.as_bytes()); // embedded build target
        fw.push(0x00); // string terminator
        fw.extend_from_slice(&OPTIONS_DELIMITER);
        fw.extend_from_slice(&cap.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, cap as usize));
        // Pad past the sanity floor so size never falsely fails these tests.
        fw.resize(MIN_FIRMWARE_BYTES + 512, 0xFF);
        fw
    }

    #[test]
    fn valid_tx_bin_on_tx_device_passes() {
        let fw = synthetic_firmware("BETAFPV_2400_TX");
        let info =
            validate_local_firmware(&fw, "BETAFPV_2400_TX", DeviceType::Tx, Some(DeviceType::Tx))
                .expect("a matching TX image on a TX device must pass");
        assert!(info.has_options_region);
        assert_eq!(info.target_name.as_deref(), Some("BETAFPV_2400_TX"));
        assert_eq!(info.device_type, Some(DeviceType::Tx));
    }

    #[test]
    fn valid_rx_bin_on_rx_device_passes() {
        let fw = synthetic_firmware("RADIOMASTER_RP1_2400_RX");
        let info = validate_local_firmware(
            &fw,
            "RADIOMASTER_RP1_2400_RX",
            DeviceType::Rx,
            Some(DeviceType::Rx),
        )
        .expect("a matching RX image on an RX device must pass");
        assert_eq!(info.device_type, Some(DeviceType::Rx));
    }

    #[test]
    fn tx_bin_on_rx_device_is_rejected() {
        // A TX firmware image, but an RX is physically connected.
        let fw = synthetic_firmware("BETAFPV_2400_TX");
        let err =
            validate_local_firmware(&fw, "BETAFPV_2400_TX", DeviceType::Tx, Some(DeviceType::Rx))
                .expect_err("flashing a TX image onto an RX device must be blocked");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "targetMismatch");
    }

    #[test]
    fn target_name_mismatch_is_rejected() {
        // Right device class (TX), but the file is for a different model.
        let fw = synthetic_firmware("BETAFPV_2400_TX");
        let err = validate_local_firmware(&fw, "RADIOMASTER_RANGER_2400", DeviceType::Tx, None)
            .expect_err("a TX image for the wrong model must be blocked");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "targetMismatch");
    }

    #[test]
    fn overlapping_target_names_are_rejected_in_both_directions() {
        // The hole the old substring rule left open, with the real overlapping
        // pair the catalogue ships (`src/lib/elrsTargets.ts`): `BETAFPV_2400_TX`
        // (250mW) and `BETAFPV_2400_TX_MICRO_1W` (1W). Their normalized forms are
        // prefix-related, so `na.contains(&nb)` accepted the 1W image for the
        // 250mW target — wrong PA tables written to real hardware. Both
        // directions must now be positive-proof mismatches. The existing
        // `target_name_mismatch_is_rejected` uses a non-overlapping pair and so
        // never saw this.
        let micro = synthetic_firmware("BETAFPV_2400_TX_MICRO_1W");
        let err = validate_local_firmware(&micro, "BETAFPV_2400_TX", DeviceType::Tx, None)
            .expect_err("a 1W image must not pass the gate for the 250mW target");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "targetMismatch");

        let nano = synthetic_firmware("BETAFPV_2400_TX");
        let err = validate_local_firmware(&nano, "BETAFPV_2400_TX_MICRO_1W", DeviceType::Tx, None)
            .expect_err("a 250mW image must not pass the gate for the 1W target");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "targetMismatch");
    }

    #[test]
    fn unextractable_target_name_still_abstains() {
        // Tightening `targets_align` must not turn ABSTENTION into rejection: an
        // image whose build target could not be extracted carries no proof of a
        // mismatch, so the name check has to stay silent no matter which target
        // is selected (the upstream TX/RX guard is what still applies).
        let info = FirmwareInfo {
            size: MIN_FIRMWARE_BYTES,
            has_options_region: true,
            target_name: None,
            device_type: None,
        };
        check_local_firmware_compatibility(&info, "BETAFPV_2400_TX", DeviceType::Tx, None)
            .expect("an unextractable target name must abstain, not reject");
        check_local_firmware_compatibility(
            &info,
            "BETAFPV_2400_TX_MICRO_1W",
            DeviceType::Tx,
            Some(DeviceType::Tx),
        )
        .expect("an unextractable target name must abstain, not reject");
    }

    #[test]
    fn class_block_uses_selected_target_when_no_device_connected() {
        // GENUINE GAP: the existing class-mismatch test uses a *connected* device
        // (Some(Rx)); the name-mismatch test has a matching class. Neither
        // exercises the `connected.unwrap_or(expected_device_type)` fallback for
        // the CLASS check. A WiFi-OTA flow has no connected device, only the
        // wizard-SELECTED target — a TX image picked against a selected RX target
        // must still be blocked. The embedded name aligns, so the CLASS branch is
        // what fires here (via the selected-target fallback), not the name branch.
        // On-hardware confirmation of this local-file safety gate is deferred to
        // docs/v1.6.4_HW_VALIDATION.md §(b).
        let fw = synthetic_firmware("BETAFPV_2400_TX");
        let err = validate_local_firmware(&fw, "BETAFPV_2400_TX", DeviceType::Rx, None).expect_err(
            "a TX image must be blocked against a selected RX target with no device connected",
        );
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "targetMismatch");
    }

    #[test]
    fn truncated_bin_is_rejected() {
        // A few stray bytes — clearly not a firmware image.
        let err = inspect_firmware(&[0xDE, 0xAD, 0xBE, 0xEF])
            .expect_err("a truncated file must be rejected");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "firmwareTooSmall");
    }

    #[test]
    fn empty_bin_is_rejected() {
        let err = inspect_firmware(&[]).expect_err("an empty file must be rejected");
        assert_eq!(err.summary_key, "firmwareTooSmall");
    }

    #[test]
    fn garbage_bin_without_options_region_is_rejected() {
        // Large enough to pass the size floor, but no ELRS options region.
        let fw = vec![0x5Au8; MIN_FIRMWARE_BYTES + 256];
        let err =
            inspect_firmware(&fw).expect_err("a file with no ELRS options region must be rejected");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "notElrsFirmware");
    }

    #[test]
    fn oversized_bin_is_rejected() {
        // Allocate just over the cap; content is irrelevant (size fails first).
        let fw = vec![0u8; MAX_FIRMWARE_BYTES + 1];
        let err = inspect_firmware(&fw).expect_err("an oversized file must be rejected");
        assert_eq!(err.summary_key, "firmwareTooLarge");
    }

    #[test]
    fn unidentifiable_image_is_allowed_when_class_matches_guard() {
        // A valid ELRS image whose target can't be fingerprinted: no positive
        // mismatch proof, so it passes (the connected-device guard still applies
        // upstream). The "code" region carries no target-shaped ASCII run.
        let cap: u16 = 64;
        let mut fw = vec![0x11u8; 128];
        fw.extend_from_slice(&OPTIONS_DELIMITER);
        fw.extend_from_slice(&cap.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, cap as usize));
        fw.resize(MIN_FIRMWARE_BYTES + 64, 0x22);

        let info = validate_local_firmware(&fw, "SOME_TARGET_TX", DeviceType::Tx, None)
            .expect("an unfingerprintable but valid ELRS image is allowed");
        assert_eq!(info.target_name, None);
        assert_eq!(info.device_type, None);
    }

    #[test]
    fn longest_classifiable_target_run_wins() {
        // M29: when several target-shaped ASCII runs are embedded, the longest
        // (most specific) classifiable one is chosen — a short generic run must
        // not shadow the real build target.
        let mut fw = vec![0xAAu8; 32];
        fw.extend_from_slice(b"ABC_TX"); // short classifiable run (6 chars)
        fw.push(0x00);
        fw.extend_from_slice(b"BETAFPV_2400_TX"); // longer, more specific run
        fw.push(0x00);
        fw.extend_from_slice(&OPTIONS_DELIMITER);
        fw.extend_from_slice(&64u16.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, 64));
        fw.resize(MIN_FIRMWARE_BYTES + 128, 0xFF);

        let info = inspect_firmware(&fw).expect("valid ELRS image");
        assert_eq!(info.target_name.as_deref(), Some("BETAFPV_2400_TX"));
        assert_eq!(info.device_type, Some(DeviceType::Tx));
    }

    #[test]
    fn interrupted_target_header_does_not_cause_a_false_mismatch() {
        // M29 (malformed/truncated header): a build-target string broken by a
        // non-charset byte yields two runs — "BETAFPV_2400" (no TX/RX class) and a
        // too-short "TX" — so NEITHER is a classifiable target. The image is a
        // valid ELRS binary, so it must be ALLOWED (no positive mismatch proof),
        // not wrongly rejected. The upstream connected-device guard still applies.
        let mut fw = vec![0x11u8; 32];
        fw.extend_from_slice(b"BETAFPV_2400"); // unclassifiable on its own
        fw.push(b' '); // a non-[A-Z0-9_] byte splits the run
        fw.extend_from_slice(b"TX"); // too short to be a target alone
        fw.push(0x00);
        fw.extend_from_slice(&OPTIONS_DELIMITER);
        fw.extend_from_slice(&64u16.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, 64));
        fw.resize(MIN_FIRMWARE_BYTES + 128, 0xFF);

        let info =
            validate_local_firmware(&fw, "BETAFPV_2400_TX", DeviceType::Tx, Some(DeviceType::Tx))
                .expect("a valid ELRS image with an unfingerprintable target is allowed");
        assert_eq!(info.target_name, None);
        assert_eq!(info.device_type, None);
    }

    #[test]
    fn classify_and_align_helpers() {
        assert_eq!(
            classify_device_type("BETAFPV_2400_TX"),
            Some(DeviceType::Tx)
        );
        assert_eq!(
            classify_device_type("HAPPYMODEL_EP_2400_RX"),
            Some(DeviceType::Rx)
        );
        // No class token -> ambiguous.
        assert_eq!(classify_device_type("RADIOMASTER_RANGER_2400"), None);
        // Normalization-insensitive alignment.
        assert!(targets_align("JUMPER_AION_2400_TX", "Jumper AION 2400 TX"));
        assert!(!targets_align("BETAFPV_2400_TX", "RADIOMASTER_RANGER_2400"));
        // Overlapping but unequal is a MISMATCH, not a match.
        assert!(!targets_align(
            "BETAFPV_2400_TX",
            "BETAFPV_2400_TX_MICRO_1W"
        ));
        assert!(!targets_align(
            "BETAFPV_2400_TX_MICRO_1W",
            "BETAFPV_2400_TX"
        ));
        // An empty/unnormalizable name is never an alignment.
        assert!(!targets_align("", "BETAFPV_2400_TX"));
        assert!(!targets_align("BETAFPV_2400_TX", "___"));
    }
}
