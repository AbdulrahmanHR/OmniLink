//! Flash-safety guard (FR-FLASH-10).
//!
//! Refuses to flash a TX target onto an RX device (and vice-versa). The
//! comparison is between the *target's* declared device type (from the wizard
//! catalogue) and the *connected device's* type (from the live CRSF handshake).
//! When no device is connected (e.g. a WiFi OTA to a device on the network) we
//! can't compare, so we allow it — there's nothing to brick by mismatch.
//!
//! [`check_connected_target_name`] closes the hole the class check leaves open:
//! TX-vs-RX is a two-value comparison, so every TX target passes it on every TX
//! device. The connected device also reports its own *name*, and until now that
//! name only ever titled the pre-flash backup document — so picking a different
//! TX model in the wizard let a Ranger image be written to a BetaFPV Nano TX
//! with both the class check and the image-vs-selected-target check satisfied.

use crate::flash::{DeviceType, ErrorCategory, FlashError};

/// Ensure `target_type` is compatible with the `connected_type`, if known.
///
/// * `connected_type == None` -> allowed (nothing to compare against).
/// * types equal -> allowed.
/// * types differ -> `Err` categorised as a firmware mismatch.
pub fn check_target_compatibility(
    connected_type: Option<DeviceType>,
    target_type: DeviceType,
) -> Result<(), FlashError> {
    match connected_type {
        Some(connected) if connected != target_type => Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "txRxMismatch",
            format!(
                "refusing to flash a {target_type:?} firmware target onto a connected {connected:?} device"
            ),
        )),
        _ => Ok(()),
    }
}

/// Ensure the wizard-SELECTED build target is the same hardware the connected
/// device resolved to (FR-FLASH-10).
///
/// `connected_target` is a **catalogue build target**, not the raw CRSF name:
/// the handshake reports a free-form display string ("BetaFPV 2400 TX") and this
/// comparison is exact, so the frontend resolves the name through the target
/// catalogue before it crosses the seam (`resolveConnectedTarget` in
/// `src/lib/elrsTargets.ts`) and sends `None` when it maps to nothing. That
/// split is deliberate: RESOLVING a display name to a model is a fuzzy question,
/// COMPARING two build targets is not, and
/// [`crate::flash::validate::targets_align`] must stay exact so overlapping
/// targets (`BETAFPV_2400_TX` vs `BETAFPV_2400_TX_MICRO_1W`) still count as
/// different radios. Never "unify" the two by loosening `targets_align`.
///
/// * either side unknown (absent or blank) -> allowed. An unflashed board, a
///   device in the bootloader, a WiFi OTA and a display name the catalogue could
///   not map all land here; "unknown" is never proof of a mismatch, so this
///   guard abstains exactly like [`check_target_compatibility`] does on
///   `connected_type == None`.
/// * same target -> allowed.
/// * different target -> `Err` categorised as a firmware mismatch. Only reached
///   on positive proof: the device resolved to a model, and it is not the one
///   the wizard selected.
pub fn check_connected_target_name(
    connected_target: Option<&str>,
    selected_target: &str,
) -> Result<(), FlashError> {
    let Some(connected) = connected_target.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(());
    };
    let selected = selected_target.trim();
    if selected.is_empty() || crate::flash::validate::targets_align(connected, selected) {
        return Ok(());
    }
    Err(FlashError::new(
        ErrorCategory::FirmwareMismatch,
        "connectedTargetMismatch",
        format!(
            "refusing to flash the selected target '{selected}' onto a connected device \
             identified as '{connected}'"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_matching_types() {
        assert!(check_target_compatibility(Some(DeviceType::Tx), DeviceType::Tx).is_ok());
        assert!(check_target_compatibility(Some(DeviceType::Rx), DeviceType::Rx).is_ok());
    }

    #[test]
    fn allows_when_no_device_connected() {
        assert!(check_target_compatibility(None, DeviceType::Tx).is_ok());
        assert!(check_target_compatibility(None, DeviceType::Rx).is_ok());
    }

    #[test]
    fn rejects_tx_target_on_rx_device() {
        let err = check_target_compatibility(Some(DeviceType::Rx), DeviceType::Tx).unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "txRxMismatch");
    }

    #[test]
    fn rejects_rx_target_on_tx_device() {
        let err = check_target_compatibility(Some(DeviceType::Tx), DeviceType::Rx).unwrap_err();
        assert_eq!(err.summary_key, "txRxMismatch");
    }

    #[test]
    fn connected_name_abstains_when_either_side_is_unknown() {
        // No device, no name, or a display name the catalogue could not resolve
        // (the frontend sends `None` for that) is NOT proof of a mismatch.
        assert!(check_connected_target_name(None, "BETAFPV_2400_TX").is_ok());
        assert!(check_connected_target_name(Some(""), "BETAFPV_2400_TX").is_ok());
        assert!(check_connected_target_name(Some("   "), "BETAFPV_2400_TX").is_ok());
        assert!(check_connected_target_name(Some("BETAFPV_2400_TX"), "").is_ok());
    }

    #[test]
    fn connected_name_allows_the_same_hardware() {
        // The seam sends a resolved catalogue target; normalization additionally
        // tolerates a producer that spells it out in display form.
        assert!(check_connected_target_name(Some("BETAFPV_2400_TX"), "BETAFPV_2400_TX").is_ok());
        assert!(check_connected_target_name(Some("BetaFPV 2400 TX"), "BETAFPV_2400_TX").is_ok());
    }

    #[test]
    fn rejects_a_different_model_of_the_same_class() {
        // The TX/RX class check passes here (both TX), which is exactly why this
        // guard exists: a Ranger image must not reach a BetaFPV Nano TX.
        let err = check_connected_target_name(Some("BETAFPV_2400_TX"), "RADIOMASTER_RANGER_2400")
            .unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "connectedTargetMismatch");
    }

    #[test]
    fn rejects_an_overlapping_variant_of_the_same_model() {
        // The catalogue's real overlapping pair — different PA tables, so the
        // substring-tolerant comparison this guard reuses had to become exact.
        let err = check_connected_target_name(Some("BETAFPV_2400_TX"), "BETAFPV_2400_TX_MICRO_1W")
            .unwrap_err();
        assert_eq!(err.summary_key, "connectedTargetMismatch");
    }
}
