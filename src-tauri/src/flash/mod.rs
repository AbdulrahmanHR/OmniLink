//! Firmware flashing engine (M8-API).
//!
//! This module holds the **pure, hardware-independent** flashing logic so it
//! can be unit-tested without a Tauri runtime or a real device:
//!
//! * [`cancel`] — the three-state cancellation token ([`cancel::FlashCancel`]):
//!   cancellable -> cancelling / writing, where "writing" is the point of no
//!   return past which a cancel is refused rather than bricking the device.
//! * [`github`] — fetch the ExpressLRS release list + changelog (FR-FLASH-01).
//! * [`options`] — build the ExpressLRS options block from the wizard's common
//!   selections and derive the binding UID (FR-FLASH-03 binary-patch inputs).
//! * [`patch`] — splice that options block into a pre-built `firmware.bin`
//!   with **no compilation** (Decision #3 Hybrid, the common case).
//! * [`guard`] — refuse to flash a TX target onto an RX device, or a target the
//!   connected device's own reported name contradicts (FR-FLASH-10).
//! * [`validate`] — pre-flash inspection of a user-selected local `.bin`
//!   (size/integrity + TX/RX class + target alignment) so a mismatched/corrupt
//!   file is blocked before any erase/write (M25).
//! * [`backup`] — snapshot the current config to an `.elrsp` before flashing
//!   (FR-FLASH-05, atomic write per NFR-ERR-04).
//! * [`msp`] — Betaflight/iNav MSP passthrough (FR-FLASH-09a–d).
//! * [`engine`] — the orchestrator that drives fetch -> erase -> write ->
//!   verify -> done, abstracted over a [`engine::FlashBackend`] and a
//!   [`engine::FlashSink`] so the real subprocess/serial/HTTP boundary is
//!   mocked in tests (NFR-TEST-02).
//!
//! The Tauri command surface (`commands/flash.rs`) is a thin wrapper: it owns
//! the worker thread + event emission and calls [`engine::run_flash`].

pub mod backpack;
pub mod backup;
pub mod bridge;
pub mod cancel;
pub mod engine;
pub mod github;
pub mod guard;
pub mod msp;
pub mod options;
pub mod patch;
pub mod validate;

use serde::{Deserialize, Serialize};

/// Whether a device/target is a transmitter or a receiver. Mirrors the
/// frontend `DeviceType` and the CRSF origin classification in `crsf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceType {
    #[serde(rename = "TX")]
    Tx,
    #[serde(rename = "RX")]
    Rx,
}

/// The three v1.0 flashing transports (Decision #3 Hybrid). Backpack
/// (FR-FLASH-11*) is v1.5 and intentionally absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlashMethod {
    /// WiFi HTTP OTA to the device's `/update` endpoint (FR-FLASH-09).
    Wifi,
    /// Direct USB serial (FR-FLASH-09).
    Uart,
    /// Betaflight/iNav MSP passthrough via a flight controller (FR-FLASH-09a).
    Betaflight,
}

/// Discrete progress stages reported to the UI. Mirrors `FlashStage` in
/// `src/stores/wizard.ts` (FR-FLASH-07).
///
/// **Declaration order is the pipeline order**, and the derived [`Ord`] relies
/// on it: `engine::escalate_after_write` compares the furthest stage a run
/// reached against [`FlashStage::Write`] to decide whether a failure could have
/// left a partially-written image on the device (FLASH-6). Never reorder these
/// variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FlashStage {
    Fetch,
    Erase,
    Write,
    Verify,
    Done,
}

impl FlashStage {
    /// Lower-case identifier matching the i18n key suffix
    /// (`wizard.flash.stages.<id>`).
    pub fn as_str(self) -> &'static str {
        match self {
            FlashStage::Fetch => "fetch",
            FlashStage::Erase => "erase",
            FlashStage::Write => "write",
            FlashStage::Verify => "verify",
            FlashStage::Done => "done",
        }
    }
}

/// Categorised failure class (FR-FLASH-08/12 (a)). Drives which human-readable
/// summary + recovery steps the UI shows. Serialised camelCase for the
/// `flash://error` payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCategory {
    /// Bad/again wiring, port busy, device not in bootloader.
    Wiring,
    /// Missing/blocked USB-serial driver.
    Driver,
    /// Target/device type mismatch or wrong binary (FR-FLASH-10).
    FirmwareMismatch,
    /// Network/HTTP timeout (fetch or WiFi OTA).
    NetworkTimeout,
    /// PlatformIO compile-from-source failure.
    CompilationError,
    /// Anything not otherwise classified.
    Unknown,
}

impl ErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCategory::Wiring => "wiring",
            ErrorCategory::Driver => "driver",
            ErrorCategory::FirmwareMismatch => "firmwareMismatch",
            ErrorCategory::NetworkTimeout => "networkTimeout",
            ErrorCategory::CompilationError => "compilationError",
            ErrorCategory::Unknown => "unknown",
        }
    }
}

/// A categorised flash failure carrying everything the UI needs to render
/// FR-FLASH-12: a category, a human-readable summary, recovery steps, and the
/// raw log captured so far.
#[derive(Debug, Clone)]
pub struct FlashError {
    pub category: ErrorCategory,
    /// Machine-stable summary key suffix; the UI looks up
    /// `wizard.flash.errors.<summaryKey>` for the localized headline.
    pub summary_key: String,
    /// Raw, untranslated detail (tool stderr line, IO error, …) shown verbatim
    /// in the collapsible log so nothing is hidden from the user.
    pub detail: String,
}

impl FlashError {
    pub fn new(
        category: ErrorCategory,
        summary_key: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            category,
            summary_key: summary_key.into(),
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for FlashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {}: {}",
            self.category.as_str(),
            self.summary_key,
            self.detail
        )
    }
}

impl std::error::Error for FlashError {}

// ---------------------------------------------------------------------------
// Shared HTTP hardening for the two firmware-provenance clients.
// ---------------------------------------------------------------------------

/// Redirect hops FOLLOWED before a fetch is refused, i.e. the 4th redirect is
/// the one that fails. The real hosts redirect at most once (host → CDN); ten
/// (reqwest's default) is a chain nobody audits.
///
/// Compared with `>` and not `>=` because `Attempt::previous()` counts the
/// ORIGINAL request URL as well as the redirects — reqwest's own
/// `Policy::limited` does the same, with the comment "The first URL in the
/// previous is the initial URL and not a redirection. It needs to be excluded."
/// With `>=` this constant refused the 3rd redirect and only two were ever
/// followed, which neither the name, this doc, nor the error text described.
pub const MAX_REDIRECT_HOPS: usize = 3;

/// Whether a redirect this deep is past [`MAX_REDIRECT_HOPS`].
///
/// `previous` is `Attempt::previous().len()`, which INCLUDES the original
/// request URL, so on the Nth redirect it is N — hence `>` and not `>=`.
///
/// Split out from [`pinned_redirect_policy`] for the same reason as
/// [`redirect_target_allowed`]: reqwest's `Attempt` has no public constructor,
/// so the policy closure cannot be called from a test and the counting rule
/// would otherwise be pinned by nothing.
pub fn redirect_hops_exhausted(previous: usize) -> bool {
    previous > MAX_REDIRECT_HOPS
}

/// Whether a redirect may be followed to `url`, given the domain the fetch is
/// pinned to.
///
/// `https` only, and the host must be `domain` itself or a subdomain of it —
/// `expresslrs.org` accepts `artifactory.expresslrs.org` but not
/// `expresslrs.org.attacker.net` and not `notexpresslrs.org`.
///
/// Split out from [`pinned_redirect_policy`] because reqwest's `Policy` cannot
/// be invoked from a test, and this predicate is the whole security decision.
pub fn redirect_target_allowed(url: &reqwest::Url, domain: &str) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    url.host_str()
        .is_some_and(|host| host == domain || host.ends_with(&format!(".{domain}")))
}

/// Redirect policy for a client that fetches bytes we cannot verify afterwards.
///
/// reqwest's default follows up to ten hops to **any** host and permits an
/// https→http downgrade. Neither the artifactory firmware asset nor the GitHub
/// release list carries a digest or a signature, so one
/// `302 Location: http://attacker/firmware.bin` from a compromised or merely
/// misconfigured origin is enough to put attacker-chosen bytes in front of
/// `validate::inspect_firmware` — heuristics a crafted image satisfies
/// trivially. Pin the scheme and the domain instead, and refuse (rather than
/// silently follow) anything else, so the failure names the redirect.
pub fn pinned_redirect_policy(domain: &'static str) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        let url = attempt.url().clone();
        // `previous()` includes the original request URL, so on the Nth redirect
        // its length is N — see [`redirect_hops_exhausted`].
        if redirect_hops_exhausted(attempt.previous().len()) {
            return attempt.error(format!(
                "refused redirect: more than {MAX_REDIRECT_HOPS} hops while fetching from {domain}"
            ));
        }
        if !redirect_target_allowed(&url, domain) {
            return attempt.error(format!(
                "refused redirect to {url}: only https on {domain} (or a subdomain) is allowed"
            ));
        }
        attempt.follow()
    })
}

#[cfg(test)]
mod redirect_tests {
    use super::*;

    fn allowed(url: &str, domain: &str) -> bool {
        redirect_target_allowed(&reqwest::Url::parse(url).unwrap(), domain)
    }

    #[test]
    fn a_redirect_may_not_downgrade_or_leave_the_pinned_domain() {
        // The host itself and its subdomains, over https, are the whole allow-list.
        assert!(allowed(
            "https://artifactory.expresslrs.org/ExpressLRS/3.5.3/T/firmware.bin",
            "expresslrs.org"
        ));
        assert!(allowed("https://expresslrs.org/x", "expresslrs.org"));
        assert!(allowed("https://api.github.com/repos", "github.com"));

        // Plaintext downgrade on the RIGHT host is still refused: firmware bytes
        // carry no digest, so an on-path rewrite would be undetectable.
        assert!(!allowed(
            "http://artifactory.expresslrs.org/firmware.bin",
            "expresslrs.org"
        ));
        // Off-domain, including the two classic suffix confusions.
        assert!(!allowed(
            "https://attacker.net/firmware.bin",
            "expresslrs.org"
        ));
        assert!(!allowed(
            "https://expresslrs.org.attacker.net/firmware.bin",
            "expresslrs.org"
        ));
        assert!(!allowed(
            "https://notexpresslrs.org/firmware.bin",
            "expresslrs.org"
        ));
        assert!(!allowed("https://api.github.com.evil.co/x", "github.com"));
    }

    #[test]
    fn the_hop_cap_follows_as_many_hops_as_it_names() {
        // FIX 9E: the check was `previous().len() >= MAX_REDIRECT_HOPS`, but
        // `previous()` counts the ORIGINAL request URL too, so the 3rd redirect
        // was refused and only two were ever followed — while the constant's
        // doc and the error text both said three.
        for previous in 1..=MAX_REDIRECT_HOPS {
            assert!(
                !redirect_hops_exhausted(previous),
                "redirect #{previous} is within the cap of {MAX_REDIRECT_HOPS} and must be \
                 followed"
            );
        }
        assert!(
            redirect_hops_exhausted(MAX_REDIRECT_HOPS + 1),
            "redirect #{} is one past the cap and must be refused",
            MAX_REDIRECT_HOPS + 1
        );
    }
}
