//! ExpressLRS "options block" construction (FR-FLASH-03, binary-patch path).
//!
//! Modern ELRS (3.0+) ships a pre-built `firmware.bin` containing a delimited
//! JSON options region. The configurator overwrites that region with the
//! user's common settings — **no compilation**. This module turns the wizard's
//! selections into exactly that JSON (the keys match the ELRS
//! `binary_configurator.py` options schema) and derives the binding UID the
//! same way the firmware does.
//!
//! See `data/elrs_options_schema.json` for the human-facing field metadata.

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The common, no-compile flash configuration collected by the wizard.
///
/// camelCase to deserialize straight from the frontend `FlashRequest`. Only the
/// fields the M4 wizard actually collects are required; the rest are optional
/// and omitted from the options block when `None` (the firmware keeps its
/// built-in default).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashOptions {
    /// Secret binding phrase; MD5-hashed into the 6-byte UID. SENSITIVE — never
    /// logged in full and never sent to the AI API (NFR-PRIV-01).
    #[serde(default)]
    pub binding_phrase: Option<String>,
    /// Explicit 6-byte UID; overrides `binding_phrase` when set.
    #[serde(default)]
    pub uid: Option<[u8; 6]>,
    /// When true the device uses button/3-way binding (no phrase, no UID).
    #[serde(default)]
    pub use_traditional_binding: bool,
    /// Sub-GHz regulatory domain index (ignored by 2.4GHz hardware).
    #[serde(default)]
    pub domain: Option<u8>,
    /// Telemetry report interval, ms (ELRS `tlm-interval`).
    #[serde(default)]
    pub tlm_interval_ms: Option<u32>,
    /// Home WiFi SSID for auto-join (ELRS `wifi-ssid`).
    #[serde(default)]
    pub wifi_ssid: Option<String>,
    /// Home WiFi password (SENSITIVE).
    #[serde(default)]
    pub wifi_password: Option<String>,
    /// Auto-WiFi timeout, seconds (ELRS `wifi-on-interval`).
    #[serde(default)]
    pub auto_wifi_interval_s: Option<u32>,
    /// RX<->FC baud (ELRS `rcvr-uart-baud`).
    #[serde(default)]
    pub rx_baud: Option<u32>,
}

/// Derive the ExpressLRS 6-byte binding UID from a phrase.
///
/// Matches the firmware/configurator scheme exactly: the UID is the first six
/// bytes of `MD5("-DMY_BINDING_PHRASE=\"<phrase>\"")`. Reproducing this byte
/// layout is what lets a TX and RX flashed from the same phrase actually bind.
pub fn derive_uid(phrase: &str) -> [u8; 6] {
    let mut hasher = Md5::new();
    hasher.update(format!("-DMY_BINDING_PHRASE=\"{phrase}\"").as_bytes());
    let digest = hasher.finalize();
    let mut uid = [0u8; 6];
    uid.copy_from_slice(&digest[..6]);
    uid
}

impl FlashOptions {
    /// Resolve the effective UID, if any: explicit `uid` wins, else derived from
    /// a non-empty `binding_phrase`, else `None` (traditional binding).
    pub fn resolved_uid(&self) -> Option<[u8; 6]> {
        if self.use_traditional_binding {
            return None;
        }
        if let Some(uid) = self.uid {
            return Some(uid);
        }
        match &self.binding_phrase {
            Some(p) if !p.trim().is_empty() => Some(derive_uid(p.trim())),
            _ => None,
        }
    }

    /// Build the ELRS options JSON object to splice into the binary.
    ///
    /// Only set keys are emitted, so the firmware's compiled-in defaults survive
    /// for anything the user left untouched. `flash-discriminator` is a random
    /// non-zero word ELRS uses to detect whether a patch was applied; we include
    /// it so a re-flash with identical options still differs on the wire.
    pub fn to_options_json(&self, discriminator: u32) -> Value {
        let mut map = Map::new();
        if let Some(uid) = self.resolved_uid() {
            map.insert("uid".into(), json!(uid.to_vec()));
        }
        if let Some(d) = self.domain {
            map.insert("domain".into(), json!(d));
        }
        if let Some(ms) = self.tlm_interval_ms {
            map.insert("tlm-interval".into(), json!(ms));
        }
        if let Some(s) = &self.wifi_ssid {
            if !s.is_empty() {
                map.insert("wifi-ssid".into(), json!(s));
            }
        }
        if let Some(p) = &self.wifi_password {
            if !p.is_empty() {
                map.insert("wifi-password".into(), json!(p));
            }
        }
        if let Some(s) = self.auto_wifi_interval_s {
            map.insert("wifi-on-interval".into(), json!(s));
        }
        if let Some(b) = self.rx_baud {
            map.insert("rcvr-uart-baud".into(), json!(b));
        }
        map.insert("flash-discriminator".into(), json!(discriminator));
        Value::Object(map)
    }

    /// A redacted, log-safe description of the options (no phrase, no password,
    /// UID shown as a short fingerprint). Used for the diagnostic report and
    /// structured logs (NFR-PRIV-01 / NFR-LOG-01).
    pub fn redacted_summary(&self) -> String {
        let uid = match self.resolved_uid() {
            Some(uid) => format!("{:02X}{:02X}..", uid[0], uid[1]),
            None => "none".into(),
        };
        format!(
            "uid={uid} domain={:?} tlm={:?} wifiSsid={} rxBaud={:?}",
            self.domain,
            self.tlm_interval_ms,
            self.wifi_ssid.as_deref().map(|_| "set").unwrap_or("unset"),
            self.rx_baud,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_is_deterministic_and_six_bytes() {
        let a = derive_uid("my secret");
        let b = derive_uid("my secret");
        assert_eq!(a, b);
        assert_eq!(a.len(), 6);
        // Different phrase -> different UID (overwhelmingly likely).
        assert_ne!(derive_uid("my secret"), derive_uid("other phrase"));
    }

    #[test]
    fn uid_matches_known_md5_prefix() {
        // Independently: md5("-DMY_BINDING_PHRASE=\"test\"") first 6 bytes.
        // Computed via the same RustCrypto Md5 over the documented input.
        let mut hasher = Md5::new();
        hasher.update(b"-DMY_BINDING_PHRASE=\"test\"");
        let full = hasher.finalize();
        assert_eq!(derive_uid("test"), full[..6]);
    }

    #[test]
    fn resolved_uid_precedence() {
        // Explicit UID wins over phrase.
        let o = FlashOptions {
            uid: Some([1, 2, 3, 4, 5, 6]),
            binding_phrase: Some("ignored".into()),
            ..Default::default()
        };
        assert_eq!(o.resolved_uid(), Some([1, 2, 3, 4, 5, 6]));

        // Traditional binding suppresses any UID.
        let o = FlashOptions {
            use_traditional_binding: true,
            binding_phrase: Some("phrase".into()),
            ..Default::default()
        };
        assert_eq!(o.resolved_uid(), None);

        // Empty/whitespace phrase -> no UID.
        let o = FlashOptions {
            binding_phrase: Some("   ".into()),
            ..Default::default()
        };
        assert_eq!(o.resolved_uid(), None);
    }

    #[test]
    fn options_json_omits_unset_and_includes_set() {
        let o = FlashOptions {
            binding_phrase: Some("freestyle".into()),
            domain: Some(3),
            tlm_interval_ms: Some(320),
            ..Default::default()
        };
        let v = o.to_options_json(0xABCD);
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("uid"));
        assert_eq!(obj["domain"], json!(3));
        assert_eq!(obj["tlm-interval"], json!(320));
        assert_eq!(obj["flash-discriminator"], json!(0xABCD));
        // Unset optionals are absent.
        assert!(!obj.contains_key("wifi-ssid"));
        assert!(!obj.contains_key("rcvr-uart-baud"));
    }

    #[test]
    fn redacted_summary_hides_secrets() {
        let o = FlashOptions {
            binding_phrase: Some("super secret phrase".into()),
            wifi_ssid: Some("HomeNet".into()),
            wifi_password: Some("hunter2".into()),
            ..Default::default()
        };
        let s = o.redacted_summary();
        assert!(!s.contains("super secret phrase"));
        assert!(!s.contains("HomeNet"));
        assert!(!s.contains("hunter2"));
    }
}
