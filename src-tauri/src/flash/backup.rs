//! Pre-flash config backup (FR-FLASH-05, §5).
//!
//! Before any flash we snapshot what we know about the currently-connected
//! device to a timestamped `.elrsp` file in `AppData/omnilink/backups/`. The
//! write is **atomic** (write to a temp file in the same dir, then rename) so a
//! crash mid-write can never leave a truncated backup (NFR-ERR-04).
//!
//! # What this artifact does and does not contain (FLASH-5)
//!
//! It captures the device IDENTITY that is genuinely known at flash time —
//! build target, TX/RX class, the firmware version the CRSF handshake reported,
//! and the serial port — plus a baseline `settings` block, and it is a **real,
//! importable `.elrsp`**: the shape written here is exactly what
//! `src/lib/elrsp.ts` (`parseElrsp` / `migrateElrsp`) accepts, so the user can
//! import it from the Profiles page like any other profile. It used to write
//! `{"user_defines": {}}` with no `schemaVersion`, no `settings` and no
//! `updatedAt`, which the app's own importer rejected outright — a file that
//! could not be restored by anything, for which the engine nonetheless refused
//! to flash when it could not be written.
//!
//! It does NOT capture the device's LIVE parameter values: reading those needs
//! the CRSF parameter-read path (FR-CFG), which does not exist yet. The
//! `settings` block therefore holds ExpressLRS defaults
//! ([`baseline_settings`], mirroring `RECOVERY_PROFILE_SETTINGS` in
//! `src/stores/wizard.ts`), and the document says so in its `description` rather
//! than passing defaults off as a reading of the radio.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// `.elrsp` schema version this writer emits. MUST track `ELRSP_SCHEMA_VERSION`
/// in `src/lib/elrsp.ts` — a document with a higher version than the importer
/// knows is rejected as "unsupported schema version".
pub const ELRSP_SCHEMA_VERSION: u32 = 1;

/// Identity of the device being backed up, as known from the CRSF handshake.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    pub target_name: String,
    /// The device's reported firmware version, or `None` when it reported none
    /// (see [`crate::crsf::DeviceInfo::firmware_version`]). Recorded as `null`
    /// rather than a fabricated `"0.0.0"`, so a snapshot never claims a version
    /// the device never sent.
    #[serde(default)]
    pub firmware_version: Option<String>,
    /// `"TX"` / `"RX"`, or `None` when the CRSF handshake could not classify the
    /// device (CONN-5) — recorded as `null` rather than a guessed class, so the
    /// snapshot never claims an identity the app never established.
    #[serde(default)]
    pub device_type: Option<String>,
    /// Serial port the device was talking on, when there was one (a WiFi-OTA
    /// flash has none). Part of the identity a user needs to recognise which
    /// device a snapshot came from.
    #[serde(default)]
    pub port: Option<String>,
}

/// The neutral ExpressLRS defaults written into `settings`.
///
/// These are NOT read from the device — see the module docs. Mirrors
/// `RECOVERY_PROFILE_SETTINGS` in `src/stores/wizard.ts`, which does the same
/// thing for the local-file recovery profile, so both recovery artifacts start
/// the user from the same known baseline. Every one of the ten keys
/// `parseSettings` requires is present and correctly typed; a missing or
/// mistyped one makes the whole document unimportable.
fn baseline_settings() -> Value {
    json!({
        "packetRate": 250,
        "telemetryRatio": "1:64",
        "switchMode": "Hybrid",
        "txPower": 100,
        "dynamicPower": false,
        "modelMatch": false,
        "modelId": 0,
        "bindingPhrase": "",
        "antennaMode": "Diversity",
        "fanThreshold": 250
    })
}

/// Human-readable statement of the snapshot's provenance, carried in the
/// document's `description` so the import preview tells the user exactly what
/// they are restoring — identity read from the device, settings NOT.
fn describe(target: &BackupTarget) -> String {
    let class = target.device_type.as_deref().unwrap_or("unclassified");
    let firmware = target.firmware_version.as_deref().unwrap_or("not reported");
    let port = target
        .port
        .as_deref()
        .map(|p| format!(" on {p}"))
        .unwrap_or_default();
    format!(
        "Automatic snapshot taken before flashing {} ({class}, firmware {firmware}){port}. \
         The device's live settings cannot be read yet, so the values below are \
         ExpressLRS defaults — the identity above is what was actually read from \
         the device.",
        target.target_name
    )
}

/// Build the `.elrsp` document for a backup, in the shape `src/lib/elrsp.ts`
/// parses (FLASH-5).
///
/// `timestamp_ms` is passed in rather than read from the clock so the document
/// is a pure function of its inputs (and `updatedAt` matches the file name the
/// snapshot is written under).
pub fn build_backup_document(target: &BackupTarget, timestamp_ms: u128) -> Value {
    json!({
        // The four fields the importer REQUIRES. `settings` is validated
        // key-by-key by `parseSettings`, and a document without `schemaVersion`
        // is treated as a legacy v0 doc and migrated — which then failed,
        // because there was no `settings` object to migrate.
        "schemaVersion": ELRSP_SCHEMA_VERSION,
        "name": format!("Auto-backup — {}", target.target_name),
        "description": describe(target),
        "tags": ["auto-backup"],
        "firmwareVersion": target.firmware_version,
        "settings": baseline_settings(),
        "updatedAt": timestamp_ms as u64,
        // Device identity, kept alongside the importable payload. The importer
        // ignores unknown top-level keys, so this rides along for the user (and
        // for a future config-read path) without breaking the parse.
        "device": {
            "target": target.target_name,
            "deviceType": target.device_type,
            "firmwareVersion": target.firmware_version,
            "port": target.port,
        }
    })
}

/// Atomically write `document` as a timestamped `.elrsp` into `backups_dir`,
/// creating the directory if needed. Returns the final path.
pub fn write_backup(
    backups_dir: &Path,
    document: &Value,
    timestamp_ms: u128,
) -> std::io::Result<PathBuf> {
    fs::create_dir_all(backups_dir)?;
    let final_path = backups_dir.join(format!("backup-{timestamp_ms}.elrsp"));
    let tmp_path = backups_dir.join(format!(".backup-{timestamp_ms}.elrsp.tmp"));

    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Write fully + fsync the temp file, then rename over the final name. The
    // rename is atomic on a single filesystem, so a reader sees either the old
    // file or the complete new one — never a partial write.
    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp_path, &final_path)?;
    Ok(final_path)
}

/// Remove every pre-flash device-config `.elrsp` backup for the GDPR-style
/// "Delete all my data" erase (NFR-PRIV-02) by wiping the whole backups
/// directory. The `.elrsp` files carry the user's own device config = personal
/// data. A missing directory is a clean no-op (nothing was ever backed up); the
/// dir is recreated by [`write_backup`] on the next flash.
pub fn clear_backups_dir(backups_dir: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(backups_dir) {
        Ok(()) => Ok(()),
        // Never backed up anything yet — a clean no-op, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "omnilink-backup-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        p
    }

    /// The identity the shipped fixture (`tests/fixtures/preflash-backup.elrsp`)
    /// was generated from. Both the Rust and the TypeScript round-trip tests
    /// read that one file, so the two languages cannot drift apart silently.
    fn fixture_target() -> BackupTarget {
        BackupTarget {
            target_name: "BETAFPV_2400_TX".into(),
            firmware_version: Some("3.5.2".into()),
            device_type: Some("TX".into()),
            port: Some("/dev/ttyUSB0".into()),
        }
    }

    /// Timestamp the fixture was generated with (2025-01-01T00:00:00Z).
    const FIXTURE_TS: u128 = 1_735_689_600_000;

    #[test]
    fn document_carries_everything_the_importer_requires() {
        // FLASH-5 regression marker. The written document used to be
        // `{"_schema": …, "target": …, "user_defines": {}}` — no schemaVersion,
        // no settings, no updatedAt — which the app's OWN importer
        // (`src/lib/elrsp.ts`) rejected at `missing schemaVersion`, and whose
        // migration path then died on `invalid settings: not an object`. Every
        // field `parseElrsp`/`parseSettings` demands must be present and
        // correctly typed.
        let doc = build_backup_document(&fixture_target(), FIXTURE_TS);

        assert_eq!(doc["schemaVersion"], ELRSP_SCHEMA_VERSION);
        assert!(doc["name"].is_string());
        assert_eq!(doc["updatedAt"], FIXTURE_TS as u64);
        assert_eq!(doc["firmwareVersion"], "3.5.2");

        // All ten settings keys, with the types `parseSettings` enforces.
        let settings = &doc["settings"];
        for key in [
            "packetRate",
            "txPower",
            "modelId",
            "fanThreshold",
            "telemetryRatio",
            "switchMode",
            "bindingPhrase",
            "antennaMode",
            "dynamicPower",
            "modelMatch",
        ] {
            assert!(!settings[key].is_null(), "settings.{key} must be present");
        }
        assert!(settings["packetRate"].is_number());
        assert!(settings["telemetryRatio"].is_string());
        assert!(settings["dynamicPower"].is_boolean());

        // …and the identity that IS genuinely known at flash time.
        assert_eq!(doc["device"]["target"], "BETAFPV_2400_TX");
        assert_eq!(doc["device"]["deviceType"], "TX");
        assert_eq!(doc["device"]["port"], "/dev/ttyUSB0");
        // The description is explicit that the settings are not a read-back.
        assert!(doc["description"]
            .as_str()
            .unwrap()
            .contains("ExpressLRS defaults"));
    }

    #[test]
    fn document_matches_the_shared_round_trip_fixture() {
        // The other half of the cross-language gate: `tests/unit/backupElrsp.test.ts`
        // imports this exact file through the REAL `migrateElrsp`/`parseElrsp`.
        // If this writer's shape changes, this assertion fails and the fixture
        // has to be regenerated — at which point the TypeScript test proves the
        // new shape still imports.
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/preflash-backup.elrsp"
        ))
        .expect("the shared fixture must be valid JSON");
        assert_eq!(
            build_backup_document(&fixture_target(), FIXTURE_TS),
            fixture,
            "tests/fixtures/preflash-backup.elrsp is stale — regenerate it from \
             build_backup_document"
        );
    }

    #[test]
    fn an_unclassified_device_without_a_port_still_produces_an_importable_document() {
        // CONN-5: the handshake could not classify the device, and a WiFi OTA has
        // no serial port. Neither may make the snapshot unimportable.
        let doc = build_backup_document(
            &BackupTarget {
                target_name: "UNKNOWN_TARGET".into(),
                firmware_version: None,
                device_type: None,
                port: None,
            },
            0,
        );
        assert_eq!(doc["schemaVersion"], ELRSP_SCHEMA_VERSION);
        assert!(doc["settings"]["packetRate"].is_number());
        // Recorded as null rather than a guessed class/port/version — a device
        // that reported no firmware word must not be snapshotted as "0.0.0".
        assert!(doc["device"]["deviceType"].is_null());
        assert!(doc["device"]["port"].is_null());
        assert!(doc["device"]["firmwareVersion"].is_null());
        assert!(doc["firmwareVersion"].is_null());
        assert!(doc["description"]
            .as_str()
            .unwrap()
            .contains("firmware not reported"));
    }

    #[test]
    fn writes_file_atomically_and_reparses() {
        let dir = temp_dir("write");
        let doc = build_backup_document(
            &BackupTarget {
                target_name: "RX1".into(),
                firmware_version: Some("3.5.3".into()),
                device_type: Some("RX".into()),
                port: None,
            },
            1234567890,
        );
        let path = write_backup(&dir, &doc, 1234567890).unwrap();
        assert!(path.exists());
        assert_eq!(path.file_name().unwrap(), "backup-1234567890.elrsp");
        // No leftover temp file.
        assert!(!dir.join(".backup-1234567890.elrsp.tmp").exists());
        // Round-trips as valid JSON.
        let read: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(read["device"]["target"], "RX1");
        assert_eq!(read["schemaVersion"], ELRSP_SCHEMA_VERSION);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_backups_removes_all_files() {
        let dir = temp_dir("clear");
        let doc = build_backup_document(
            &BackupTarget {
                target_name: "T".into(),
                firmware_version: Some("3.5.3".into()),
                device_type: Some("TX".into()),
                port: None,
            },
            1,
        );
        write_backup(&dir, &doc, 1).unwrap();
        write_backup(&dir, &doc, 2).unwrap();
        assert!(dir.join("backup-1.elrsp").exists());
        assert!(dir.join("backup-2.elrsp").exists());

        clear_backups_dir(&dir).unwrap();

        // Every backup is gone.
        assert!(!dir.exists(), "backups dir must be wiped");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_backups_missing_dir_is_noop() {
        let dir = temp_dir("clear-missing");
        assert!(!dir.exists());
        // A never-backed-up install must not error.
        clear_backups_dir(&dir).expect("missing backups dir is a clean no-op");
    }
}
