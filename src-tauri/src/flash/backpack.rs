//! ExpressLRS **Backpack** firmware source + cross-type guard (M19, FR-FLASH-11*).
//!
//! A Backpack is the companion ESP device that rides alongside an ELRS radio:
//! the **TX Backpack** bridges telemetry/HID from the handset, and the **VRX
//! Backpack** drives channel/band switching on the goggles' video receiver.
//! They are a *separate* firmware family from the main ELRS RX/TX builds, hosted
//! in their own repository ([`BACKPACK_REPO`]).
//!
//! Crucially, a Backpack flashes over the **exact same WiFi-OTA transport** as a
//! plain ELRS device: it serves a self-AP at `10.0.0.1` with a `/update`
//! endpoint, so `engine::RealBackend::upload_wifi` is reused verbatim. The only
//! Backpack-specific pieces live here:
//!
//! * [`BackpackKind`] — the TX/VRX role, mirroring the TS
//!   `"tx-backpack" | "vrx-backpack"` union and `FlashRequestPayload.backpackKind`.
//! * [`check_backpack_compatibility`] — the FR-FLASH-10 guard that refuses to
//!   write a TX-Backpack image onto a connected VRX-Backpack device (and
//!   vice-versa), structurally identical to the TX/RX [`guard`](crate::flash::guard).
//! * [`backpack_firmware`] — the **offline mock/test** firmware source. To keep
//!   the flow dev-verifiable offline with no hardware (NFR-TEST-02), this returns
//!   a small bundled **placeholder** image rather than hitting the network,
//!   mirroring the tiles base-pack placeholder approach. It is used ONLY by
//!   `engine::MockBackend`; the real backend fails closed (see below) and never
//!   flashes it. The real artifact host is [`BACKPACK_REPO`].
//!
//! The production `engine::RealBackend::acquire_firmware` deliberately does NOT
//! fetch a Backpack image yet: the hardware-validated per-target release fetch is
//! unimplemented, so it returns a `backpackFirmwareUnavailable` error rather than
//! writing the placeholder to a real device (fail closed).

use serde::{Deserialize, Serialize};

use crate::flash::{ErrorCategory, FlashError};

/// Upstream source of real Backpack firmware binaries (HW path). This is a
/// *separate* repository from the main ExpressLRS firmware — the main-ELRS fetch
/// path in [`github`](crate::flash::github) deliberately does NOT cover it. A
/// future hardware-enabled build would download the per-target `repoAsset`
/// (see `data/targets/backpack.json`) from this repo's releases. Named in the
/// real backend's `backpackFirmwareUnavailable` fail-closed error until that HW
/// release fetch lands (M19 is [HW]).
pub const BACKPACK_REPO: &str = "https://github.com/ExpressLRS/Backpack";

/// The two Backpack roles. Mirrors the frontend `BackpackKind`
/// (`"tx-backpack" | "vrx-backpack"`) and `FlashRequestPayload.backpackKind`;
/// the serde renames keep the wire strings byte-identical across the boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackpackKind {
    /// TX-side Backpack (handset companion).
    #[serde(rename = "tx-backpack")]
    TxBackpack,
    /// VRX-side Backpack (video-receiver companion).
    #[serde(rename = "vrx-backpack")]
    VrxBackpack,
}

/// Ensure a Backpack `target` is compatible with the `connected` Backpack
/// device, if its role is known (FR-FLASH-10, the Backpack analogue of the TX/RX
/// [`guard`](crate::flash::guard::check_target_compatibility)).
///
/// * `connected == None` -> allowed (nothing to compare against, e.g. OTA to a
///   device whose role wasn't captured).
/// * roles equal -> allowed.
/// * roles differ -> `Err` categorised as a firmware mismatch, refusing to write
///   a TX-Backpack image onto a VRX-Backpack device (or vice-versa).
pub fn check_backpack_compatibility(
    connected: Option<BackpackKind>,
    target: BackpackKind,
) -> Result<(), FlashError> {
    match connected {
        Some(connected) if connected != target => Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "backpackCrossType",
            format!(
                "refusing to flash a {target:?} Backpack target onto a connected {connected:?} Backpack device"
            ),
        )),
        _ => Ok(()),
    }
}

/// The outer FR-FLASH-10 Backpack gate the engine calls **unconditionally**,
/// wrapping [`check_backpack_compatibility`].
///
/// The role comparison alone can only run once a Backpack *target* was picked,
/// so the engine used to call it behind `if let Some(target_kind) =
/// req.backpack_kind` — which left the cross-FAMILY case unguarded: a
/// WiFi-discovered Backpack can be selected as the OTA destination for a plain
/// main-ELRS firmware flash, and (its `connected_device_type` being `None` over
/// WiFi) the TX/RX guard abstains too, so nothing stopped main-ELRS bytes from
/// being written to a Backpack.
///
/// * both roles known -> the existing TX↔VRX role comparison.
/// * connected is a Backpack, image is main-ELRS -> `backpackCrossFamily`.
/// * connected role unknown -> allowed (abstain; nothing to compare against),
///   including a Backpack image aimed at a device whose role wasn't captured.
pub fn check_backpack_family(
    connected: Option<BackpackKind>,
    target: Option<BackpackKind>,
) -> Result<(), FlashError> {
    match (connected, target) {
        (Some(_), Some(target)) => check_backpack_compatibility(connected, target),
        (Some(connected), None) => Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "backpackCrossFamily",
            format!(
                "refusing to flash a main-ExpressLRS firmware image onto a connected {connected:?} \
                 Backpack device — Backpack firmware is a separate family"
            ),
        )),
        (None, _) => Ok(()),
    }
}

/// Magic prefix stamped into the placeholder image so a reader can tell the
/// bundled dev image apart from a real firmware binary.
///
/// Offline mock/test placeholder only: since the real backend now fails closed
/// (never sourcing this image), it is referenced solely by `backpack_firmware`,
/// which itself is only reached from `engine::MockBackend` + unit tests.
#[allow(dead_code)]
const PLACEHOLDER_MAGIC: &[u8] = b"OMNILINK-BACKPACK-PLACEHOLDER\0";

/// Obtain the **offline mock/test** Backpack firmware image for `kind`.
///
/// Returns a small, deterministic, **bundled placeholder** image — never read
/// from the network — so the Backpack flash pipeline is dev-verifiable offline
/// with no hardware, exactly like the tiles base-pack placeholder. The real
/// per-target binaries live at [`BACKPACK_REPO`] and would replace this in a
/// hardware-enabled build.
///
/// This is used ONLY by `engine::MockBackend::acquire_firmware`. The production
/// `engine::RealBackend` NEVER calls it: it fails closed with a
/// `backpackFirmwareUnavailable` error instead of writing these placeholder
/// bytes to a real device, so junk can never reach hardware.
///
/// The image embeds a role label, so the two kinds produce *different* bytes
/// (a test can tell them apart). Never panics and never returns empty.
///
/// `dead_code`-allowed because, with the real backend failing closed, its only
/// callers now live behind `#[cfg(test)]` (`engine::MockBackend` + the unit
/// tests below); it is intentionally kept for that offline mock/test path.
#[allow(dead_code)]
pub fn backpack_firmware(kind: BackpackKind) -> Result<Vec<u8>, FlashError> {
    let label: &[u8] = match kind {
        BackpackKind::TxBackpack => b"tx-backpack",
        BackpackKind::VrxBackpack => b"vrx-backpack",
    };

    // Header: magic + role label, then a small deterministic body padded so the
    // image is comfortably non-empty (and distinct per kind via the label byte).
    let mut image = Vec::with_capacity(PLACEHOLDER_MAGIC.len() + label.len() + 1 + 256);
    image.extend_from_slice(PLACEHOLDER_MAGIC);
    image.extend_from_slice(label);
    image.push(b'\0');
    // Deterministic body keyed on the role discriminator so the two kinds never
    // collide even if the labels were stripped.
    let seed: u8 = match kind {
        BackpackKind::TxBackpack => 0x1B,
        BackpackKind::VrxBackpack => 0x2B,
    };
    image.extend((0u16..256).map(|i| (i as u8).wrapping_add(seed)));

    Ok(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_when_no_device_connected() {
        assert!(check_backpack_compatibility(None, BackpackKind::TxBackpack).is_ok());
        assert!(check_backpack_compatibility(None, BackpackKind::VrxBackpack).is_ok());
    }

    #[test]
    fn allows_matching_kinds() {
        assert!(check_backpack_compatibility(
            Some(BackpackKind::TxBackpack),
            BackpackKind::TxBackpack
        )
        .is_ok());
        assert!(check_backpack_compatibility(
            Some(BackpackKind::VrxBackpack),
            BackpackKind::VrxBackpack
        )
        .is_ok());
    }

    #[test]
    fn rejects_tx_target_on_vrx_device() {
        let err =
            check_backpack_compatibility(Some(BackpackKind::VrxBackpack), BackpackKind::TxBackpack)
                .unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "backpackCrossType");
    }

    #[test]
    fn rejects_vrx_target_on_tx_device() {
        let err =
            check_backpack_compatibility(Some(BackpackKind::TxBackpack), BackpackKind::VrxBackpack)
                .unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "backpackCrossType");
    }

    #[test]
    fn family_guard_blocks_main_elrs_firmware_on_a_backpack_device() {
        // The structurally-dead case: no Backpack target, so the role comparison
        // never ran and a main-ELRS image could be OTA'd to a discovered Backpack.
        for connected in [BackpackKind::TxBackpack, BackpackKind::VrxBackpack] {
            let err = check_backpack_family(Some(connected), None)
                .expect_err("main-ELRS firmware must not be written to a Backpack device");
            assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
            assert_eq!(err.summary_key, "backpackCrossFamily");
        }
    }

    #[test]
    fn family_guard_delegates_and_abstains_like_the_role_check() {
        // Both roles known -> the existing role comparison, verbatim.
        assert!(check_backpack_family(
            Some(BackpackKind::TxBackpack),
            Some(BackpackKind::TxBackpack)
        )
        .is_ok());
        assert_eq!(
            check_backpack_family(
                Some(BackpackKind::VrxBackpack),
                Some(BackpackKind::TxBackpack)
            )
            .unwrap_err()
            .summary_key,
            "backpackCrossType"
        );
        // Connected role unknown -> abstain, both for a Backpack image and a
        // plain main-ELRS one (the overwhelmingly common request).
        assert!(check_backpack_family(None, Some(BackpackKind::TxBackpack)).is_ok());
        assert!(check_backpack_family(None, None).is_ok());
    }

    #[test]
    fn kind_serde_round_trips_to_exact_strings() {
        assert_eq!(
            serde_json::to_string(&BackpackKind::TxBackpack).unwrap(),
            "\"tx-backpack\""
        );
        assert_eq!(
            serde_json::to_string(&BackpackKind::VrxBackpack).unwrap(),
            "\"vrx-backpack\""
        );
        // And back.
        let tx: BackpackKind = serde_json::from_str("\"tx-backpack\"").unwrap();
        let vrx: BackpackKind = serde_json::from_str("\"vrx-backpack\"").unwrap();
        assert_eq!(tx, BackpackKind::TxBackpack);
        assert_eq!(vrx, BackpackKind::VrxBackpack);
    }

    #[test]
    fn firmware_is_non_empty_and_distinct_per_kind() {
        let tx = backpack_firmware(BackpackKind::TxBackpack).unwrap();
        let vrx = backpack_firmware(BackpackKind::VrxBackpack).unwrap();
        assert!(!tx.is_empty());
        assert!(!vrx.is_empty());
        assert_ne!(
            tx, vrx,
            "the two Backpack kinds must produce distinct images"
        );
    }
}
