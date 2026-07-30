//! WiFi device discovery commands (M18, the unbuilt half of FR-DISC-02).
//!
//! Two discovery channels feed one [`WifiDeviceDto`] stream emitted on
//! `wifi://discovered`:
//!
//!  - **self-AP SSID scan** — a *fresh* WiFi-mode ELRS device broadcasts its own
//!    access point (SSID like `"ExpressLRS TX"` / `"ExpressLRS RX"`). Its HTTP
//!    config API always lives at the captive-portal address `10.0.0.1`. We scan
//!    visible SSIDs with the platform WiFi tool (`nmcli` / `netsh` / `airport`)
//!    and classify each one with the SAME rule as the pure TS classifier in
//!    `src/lib/wifiDiscovery.ts`.
//!  - **mDNS LAN scan** — a device already joined to the LAN advertises an HTTP
//!    service over mDNS; we browse `_http._tcp.local.` and reach it at its
//!    resolved IPv4.
//!
//! NO PANICS: every command returns `Result<_, String>` and every degraded path
//! (missing WiFi adapter, missing scan tool, no devices, mDNS init failure)
//! logs and yields *no devices* rather than erroring. A probe of an offline
//! device is a normal outcome (`reachable:false`), not a command failure.
//!
//! The record→DTO / SSID→DTO / stdout→SSID transforms are factored into pure,
//! network-free functions so the classification + parsing logic is unit-tested
//! without a live adapter (see the `tests` module at the bottom). The M18/M19
//! boundary (reject Backpack/VRX SSIDs — those belong to the M19 scanner) is
//! enforced in [`classify_ssid`], mirroring `classifyElrsSsid` in the frontend.

use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Captive-portal HTTP API address every ELRS self-AP serves from.
const AP_ADDRESS: &str = "10.0.0.1";
/// mDNS service type ELRS WiFi devices advertise their web config UI under.
const MDNS_SERVICE: &str = "_http._tcp.local.";
/// How long the mDNS browse runs before the worker tears the daemon down. The
/// loop also exits early the moment the cancel flag is set.
const MDNS_SCAN_DURATION: Duration = Duration::from_secs(6);
/// Per-`recv` block while browsing mDNS — short so the cancel flag + the overall
/// deadline stay responsive.
const MDNS_RECV_TIMEOUT: Duration = Duration::from_millis(300);
/// Per-request timeout for [`probe_wifi_device`]. Short: an unreachable device
/// is the expected case and must not hang the UI.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------------------
// DTOs shared with the frontend (camelCase, mirror `lib/tauri.ts` +
// `lib/wifiDiscovery.ts`).
// ---------------------------------------------------------------------------

/// A discovered WiFi device, emitted on `wifi://discovered`. Mirrors
/// `WifiDevice` in `src/lib/wifiDiscovery.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiDeviceDto {
    /// Stable id: `ap:{ssid}` (self-AP) or `mdns:{address}` (LAN).
    pub id: String,
    /// SSID (AP) or mDNS instance name.
    pub name: String,
    /// Host to reach the HTTP API (`10.0.0.1` for AP; resolved IPv4 for mDNS).
    pub address: String,
    /// `"ap"` or `"mdns"`.
    pub source: String,
    /// `"tx"`, `"rx"` or `"unknown"`.
    pub kind: String,
}

/// Identity read back from a device's HTTP API by [`probe_wifi_device`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiDeviceIdentityDto {
    pub name: String,
    /// `"TX"` or `"RX"`.
    pub device_type: String,
    pub firmware_version: Option<String>,
    /// `false` when the device did not answer the probe (offline — not an error).
    pub reachable: bool,
}

/// Per-domain failure category for `wifi://error`. The frontend renders
/// `t("wifi.errors.categories.${category}")` as the fallback when it has no
/// string for a specific `summaryKey`. Mirrors the categorized-error model
/// shipped in `commands/logs.rs`.
///
/// `Adapter` and `Unknown` complete the taxonomy (and are exercised by the
/// enum→string unit test) but have no genuine-failure construction site yet —
/// the degraded adapter/tool paths log via [`log_wifi`] without raising an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum WifiErrorCategory {
    /// WiFi adapter / platform tooling unavailable (degraded; logged, not an event).
    Adapter,
    /// SSID scan tool (`nmcli`/`iw`/`netsh`/`airport`) missing or failed
    /// (degraded; logged, not an event).
    ScanTool,
    /// mDNS browse subsystem (`ServiceDaemon`) — its init failure is the one
    /// genuine error event this surface raises.
    Mdns,
    /// HTTP probe of a discovered device (offline is expected; logged, not an event).
    Probe,
    /// Anything uncategorized.
    Unknown,
}

impl WifiErrorCategory {
    /// The camelCase category string the frontend keys i18n off of.
    fn as_str(self) -> &'static str {
        match self {
            WifiErrorCategory::Adapter => "adapter",
            WifiErrorCategory::ScanTool => "scanTool",
            WifiErrorCategory::Mdns => "mdns",
            WifiErrorCategory::Probe => "probe",
            WifiErrorCategory::Unknown => "unknown",
        }
    }
}

/// Payload for the `wifi://error` event — serializes to
/// `{ "category": .., "summaryKey": .., "detail": .. }` (camelCase). Mirrors the
/// `ErrorDto` shape in `commands/logs.rs`: `summaryKey` is an i18n suffix the
/// frontend renders as `t("wifi.errors.${summaryKey}")` with
/// `t("wifi.errors.categories.${category}")` as the fallback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WifiErrorDto {
    category: String,
    summary_key: String,
    detail: String,
}

impl WifiErrorDto {
    fn new(category: WifiErrorCategory, summary_key: &str, detail: String) -> Self {
        WifiErrorDto {
            category: category.as_str().to_string(),
            summary_key: summary_key.to_string(),
            detail,
        }
    }
}

/// Payload for the `wifi://done` event — serializes to `{ "generation": N }`.
/// Carries the frontend-supplied scan generation back so the store can ignore a
/// stale `done` from a cancelled older worker (cross-generation scan race).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WifiScanDoneDto {
    generation: u64,
}

/// A resolved mDNS service record — the subset we consume, decoupled from the
/// `mdns-sd` API so [`mdns_record_to_device`] is pure + testable without a live
/// network. Mirrors `MdnsRecord` in `src/lib/wifiDiscovery.ts`.
#[derive(Debug, Clone)]
struct MdnsRecord {
    instance_name: String,
    host: String,
    addresses: Vec<String>,
    #[allow(dead_code)]
    port: u16,
}

// ---------------------------------------------------------------------------
// Managed scan state.
// ---------------------------------------------------------------------------

/// Tauri-managed handle to the in-flight scan's cancel flag. Mirrors the
/// `Mutex<Option<Arc<AtomicBool>>>` pattern in `device.rs` / `tiles.rs`.
#[derive(Default)]
pub struct WifiManager {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl WifiManager {
    /// Cancel any prior scan and install a fresh flag for a new one. Returns the
    /// new flag for the worker. Idempotent `start`: a second call signals the
    /// previous worker to exit rather than leaking an uncancellable thread.
    fn install_fresh(&self) -> Arc<AtomicBool> {
        let mut guard = self.cancel.lock().unwrap();
        if let Some(prev) = guard.take() {
            prev.store(true, Ordering::SeqCst);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *guard = Some(flag.clone());
        flag
    }

    /// Signal the active scan worker (if any) to stop.
    fn cancel(&self) {
        if let Some(flag) = self.cancel.lock().unwrap().take() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// Start the WiFi discovery scan (self-AP SSID + mDNS LAN). Idempotent: cancels
/// any prior worker, installs a fresh cancel flag, then spawns one worker that
/// emits `wifi://discovered` per device and `wifi://error` on a hard failure.
/// Returns once the worker is spawned.
#[tauri::command]
pub fn start_wifi_scan(
    app: AppHandle,
    manager: State<'_, WifiManager>,
    generation: u64,
) -> Result<(), String> {
    let cancel = manager.install_fresh();
    std::thread::Builder::new()
        .name("wifi-scan".into())
        .spawn(move || scan_worker(app, cancel, generation))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stop the WiFi scan by setting the cancel flag; the worker exits at its next
/// checkpoint.
#[tauri::command]
pub fn stop_wifi_scan(manager: State<'_, WifiManager>) -> Result<(), String> {
    manager.cancel();
    Ok(())
}

/// Probe a discovered device's HTTP API to confirm reachability + read identity.
///
/// A blocking GET of `http://{address}/` with a short timeout. On a reply we
/// parse the body best-effort. On ANY network failure we return
/// `Ok(reachable:false)` — an offline device is an expected outcome, not a
/// command error — so the UI never sees a thrown error for a device that simply
/// isn't there.
///
/// `(async)` — the GET is a BLOCKING round-trip that only gives up after
/// [`PROBE_TIMEOUT`], and an unreachable device is the *expected* case. Tauri
/// runs a plain `pub fn` command on the main/webview thread, so as written that
/// would freeze the UI for the full timeout every time a probe misses; the
/// attribute moves the body to the async runtime (FWCHK-1).
#[tauri::command(async)]
pub fn probe_wifi_device(address: String) -> Result<WifiDeviceIdentityDto, String> {
    // Defense-in-depth (SSRF): this command exists to probe LAN-local ELRS
    // devices (the captive-portal AP `10.0.0.1`, mDNS `.local` hosts). Refuse
    // any public/routable target so it cannot be turned into a probe of an
    // arbitrary internal/external HTTP endpoint. Reject (not `reachable:false`)
    // since a non-local address is a misuse, not an offline device.
    if !is_probe_target_allowed(&address) {
        return Err(format!("refusing to probe non-local address: {address}"));
    }
    let url = probe_url(&address);
    let client = reqwest::blocking::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    match client.get(&url).send() {
        Ok(resp) => {
            // The device answered (any HTTP status): reachable. Parse what we can.
            let body = resp.text().unwrap_or_default();
            Ok(parse_identity(&body, &address))
        }
        Err(e) => {
            // Offline is the expected case, not a command failure: log only, no
            // `wifi://error` event, and report `reachable:false`.
            log_wifi(
                WifiErrorCategory::Probe,
                &format!("probe {url} unreachable: {e}"),
            );
            Ok(WifiDeviceIdentityDto {
                name: address.clone(),
                device_type: "TX".to_string(),
                firmware_version: None,
                reachable: false,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Scan worker.
// ---------------------------------------------------------------------------

/// One scan pass: the self-AP SSID scan (one-shot) followed by a bounded mDNS
/// browse. Both honor `cancel`. Nothing here errors the command — degraded
/// environments simply emit fewer (or no) `wifi://discovered` events.
///
/// This single-pass worker has no other terminal signal, so it emits exactly one
/// `wifi://done` on EVERY exit path (normal completion AND cancel-triggered early
/// return) so the frontend always learns the scan ended and clears `scanning`.
/// The `done` carries `generation` so completion AND cancel both let the store
/// correlate the event to its originating scan.
fn scan_worker(app: AppHandle, cancel: Arc<AtomicBool>, generation: u64) {
    run_scan_pass(&app, &cancel);
    emit_or_log(&app, "wifi://done", WifiScanDoneDto { generation });
}

/// The scan body, factored out so [`scan_worker`] can emit `wifi://done` after it
/// returns via any path.
fn run_scan_pass(app: &AppHandle, cancel: &AtomicBool) {
    let mut seen: HashSet<String> = HashSet::new();

    // --- self-AP SSID scan -------------------------------------------------
    for ssid in scan_ssids() {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        // A given SSID is either a plain ELRS AP (M18) OR a Backpack AP (M19),
        // never both: `ssid_to_device` rejects backpack/vrx, `backpack_ssid_to_device`
        // requires expresslrs+backpack. Test both; `seen` dedups by id.
        if let Some(dto) = ssid_to_device(&ssid) {
            if seen.insert(dto.id.clone()) {
                emit_or_log(app, "wifi://discovered", dto);
            }
        }
        if let Some(dto) = backpack_ssid_to_device(&ssid) {
            if seen.insert(dto.id.clone()) {
                emit_or_log(app, "wifi://discovered", dto);
            }
        }
    }

    // --- serial-attached Backpack (FR-FLASH-11a, best-effort) --------------
    // HARDWARE-PENDING: empty in dev (no attached Backpack), never errors.
    for dto in detect_serial_backpack() {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        if seen.insert(dto.id.clone()) {
            emit_or_log(app, "wifi://discovered", dto);
        }
    }

    // --- mDNS LAN browse ---------------------------------------------------
    mdns_browse(app, cancel, &mut seen);
}

/// Browse `_http._tcp.local.` for [`MDNS_SCAN_DURATION`], emitting one
/// `wifi://discovered` per newly-resolved instance that passes the ELRS gate
/// ([`is_elrs_mdns`]) — the generic `_http._tcp` haystack (printers, Chromecasts,
/// NAS, routers…) is filtered out. A `ServiceDaemon::new` failure is the one
/// genuinely-unexpected case (the mDNS subsystem could not initialize): it emits
/// `wifi://error` and returns. The caller still emits `wifi://done` afterwards so
/// `scanning` clears.
fn mdns_browse(app: &AppHandle, cancel: &AtomicBool, seen: &mut HashSet<String>) {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            // The one genuine failure on this surface: the mDNS subsystem could
            // not initialize. Emit a categorized `wifi://error` (and log).
            emit_error(
                app,
                WifiErrorCategory::Mdns,
                "mdnsInitFailed",
                format!("mDNS subsystem failed to initialize: {e}"),
            );
            return;
        }
    };
    let receiver = match daemon.browse(MDNS_SERVICE) {
        Ok(r) => r,
        Err(e) => {
            // Browse refused after a successful init: degrade to no mDNS devices
            // (log only, no error event — the SSID scan results still stand).
            log_wifi(WifiErrorCategory::Mdns, &format!("mDNS browse failed: {e}"));
            let _ = daemon.shutdown();
            return;
        }
    };

    let deadline = Instant::now() + MDNS_SCAN_DURATION;
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // The daemon owns the sender for as long as it is alive (this scope), so
        // `recv_timeout` only ever yields `Timeout` here, never `Disconnected` —
        // no busy-spin. We re-loop on any error to re-check the deadline + flag.
        match receiver.recv_timeout(MDNS_RECV_TIMEOUT) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let rec = MdnsRecord {
                    instance_name: instance_name_from_fullname(&info.fullname, &info.ty_domain),
                    host: info.host.clone(),
                    addresses: info
                        .addresses
                        .iter()
                        .map(|a| a.to_ip_addr().to_string())
                        .collect(),
                    port: info.port,
                };
                // ELRS gate: keep printers/Chromecasts/NAS/routers out of the
                // device list before mapping + emitting.
                if !is_elrs_mdns(&rec.instance_name, &rec.host) {
                    continue;
                }
                let dto = mdns_record_to_device(&rec);
                if seen.insert(dto.id.clone()) {
                    emit_or_log(app, "wifi://discovered", dto);
                }
            }
            Ok(_) => {}
            Err(_) => continue,
        }
    }

    let _ = daemon.shutdown();
}

// ---------------------------------------------------------------------------
// Pure classification + mapping (shared rule with `src/lib/wifiDiscovery.ts`).
// ---------------------------------------------------------------------------

/// Collapse whitespace runs to single spaces, trim, lower-case — matches the TS
/// `normalize`.
fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Detect TX/RX role from a normalized name as whole-word tokens, WITHOUT any
/// Backpack/VRX gating. TX takes precedence over RX (mirrors the TS regex
/// order). Returns `"unknown"` when neither token is present.
fn detect_kind(normalized: &str) -> &'static str {
    let has_token = |needle: &str| normalized.split(' ').any(|t| t == needle);
    if has_token("tx") {
        return "tx";
    }
    if has_token("rx") {
        return "rx";
    }
    "unknown"
}

/// Classify a scanned SSID as an ELRS self-AP and infer its role. Mirrors
/// `classifyElrsSsid`: rejects Backpack/VRX FIRST (M19 boundary), then requires
/// an `expresslrs` token plus a TX/RX role. Returns `(is_elrs, kind)`.
fn classify_ssid(ssid: &str) -> (bool, &'static str) {
    let normalized = normalize(ssid);

    // M19 boundary: reject Backpack/VRX before any TX/RX accept.
    if normalized.contains("backpack") || normalized.contains("vrx") {
        return (false, "unknown");
    }
    if !normalized.contains("expresslrs") {
        return (false, "unknown");
    }
    let kind = detect_kind(&normalized);
    if kind == "unknown" {
        return (false, "unknown");
    }
    (true, kind)
}

/// Map a self-AP SSID to a [`WifiDeviceDto`], or `None` when the SSID is not an
/// ELRS self-AP (including all M19 Backpack/VRX SSIDs). The address is always
/// the captive-portal [`AP_ADDRESS`].
fn ssid_to_device(ssid: &str) -> Option<WifiDeviceDto> {
    let (is_elrs, kind) = classify_ssid(ssid);
    if !is_elrs {
        return None;
    }
    Some(WifiDeviceDto {
        id: format!("ap:{ssid}"),
        name: ssid.to_string(),
        address: AP_ADDRESS.to_string(),
        source: "ap".to_string(),
        kind: kind.to_string(),
    })
}

// ---------------------------------------------------------------------------
// M19 Backpack classification + mapping (shared rule with `classifyBackpackSsid`
// in `src/lib/backpack.ts`). This is a PARALLEL channel to the M18
// [`classify_ssid`] above: that one rejects Backpack/VRX (M18/M19 boundary),
// this one REQUIRES it. A given SSID matches at most one — they are disjoint by
// construction (M18 needs no `backpack`/`vrx`; M19 needs `expresslrs`+`backpack`).
// ---------------------------------------------------------------------------

/// Classify a scanned SSID as an ExpressLRS *Backpack* AP and infer its role.
/// Mirrors `classifyBackpackSsid`: the normalized SSID must contain BOTH
/// `expresslrs` AND `backpack`; then a whole-word `vrx` token (well, substring
/// here) yields a VRX backpack, else a whole-word `tx` token yields a TX
/// backpack, else `None`. Anything lacking the `expresslrs`+`backpack` pair is
/// `None`. Returns `Some("vrx-backpack")` / `Some("tx-backpack")` / `None`.
///
/// Note this deliberately ACCEPTS exactly the SSIDs the M18 [`classify_ssid`]
/// REJECTS (which bails on any `backpack`/`vrx`), so the two never both match.
fn classify_backpack_ssid(ssid: &str) -> Option<&'static str> {
    let normalized = normalize(ssid);

    // Both literals required: a Backpack AP always advertises "ExpressLRS … Backpack".
    if !normalized.contains("expresslrs") || !normalized.contains("backpack") {
        return None;
    }
    // VRX backpack first (a VRX backpack may also carry no "tx" token at all).
    if normalized.contains("vrx") {
        return Some("vrx-backpack");
    }
    // Whole-word "tx" token (same split logic as `detect_kind`) ⇒ TX backpack.
    if normalized.split(' ').any(|t| t == "tx") {
        return Some("tx-backpack");
    }
    None
}

/// Map a self-AP SSID to a Backpack [`WifiDeviceDto`], or `None` when the SSID is
/// not an ExpressLRS Backpack AP. The address is always the captive-portal
/// [`AP_ADDRESS`]; `kind` is the distinct `"tx-backpack"` / `"vrx-backpack"`.
fn backpack_ssid_to_device(ssid: &str) -> Option<WifiDeviceDto> {
    let kind = classify_backpack_ssid(ssid)?;
    Some(WifiDeviceDto {
        id: format!("ap:{ssid}"),
        name: ssid.to_string(),
        address: AP_ADDRESS.to_string(),
        source: "ap".to_string(),
        kind: kind.to_string(),
    })
}

/// Best-effort detection of a Backpack attached to a connected TX over serial
/// (FR-FLASH-11a). HARDWARE-PENDING: with no attached Backpack — the only case
/// we can exercise in dev (no hardware) — this returns an empty list and NEVER
/// errors. When a connected TX reports an attached Backpack over its serial
/// passthrough, this is where that Backpack would be turned into a
/// [`WifiDeviceDto`] (reusing `source:"ap"` + [`AP_ADDRESS`], so no new
/// event/source enum is introduced). Absent ⇒ nothing emitted.
fn detect_serial_backpack() -> Vec<WifiDeviceDto> {
    // No hardware in dev: graceful-empty. A real implementation would query the
    // attached TX's serial passthrough and map any reported Backpack here.
    Vec::new()
}

/// The ELRS gate for mDNS records (mirrors `isElrsMdnsRecord` in
/// `src/lib/wifiDiscovery.ts`): true when the lower-cased instance name / host
/// contains `"elrs"` OR `"expresslrs"`. Applied before emitting so the generic
/// `_http._tcp.local.` haystack (printers, Chromecasts, NAS, routers…) stays out.
///
/// BOTH literals are required: "elrs" is NOT a substring of "expresslrs"
/// (e-x-p-r-e-s-s-l-r-s has no consecutive e-l-r-s). M19 may broaden this.
fn is_elrs_mdns(instance_name: &str, host: &str) -> bool {
    let haystack = format!("{instance_name} {host}").to_lowercase();
    haystack.contains("elrs") || haystack.contains("expresslrs")
}

/// Map a resolved mDNS record to a [`WifiDeviceDto`]. Address selection: first
/// usable IPv4 dotted-quad in `addresses`, falling back to `host`. Id is
/// `mdns:{address}`; the role is inferred from the instance name. The M19
/// Backpack/VRX exclusion does NOT apply here (mDNS records are already ELRS LAN
/// devices) — mirrors `mdnsRecordToDevice` in the frontend.
fn mdns_record_to_device(rec: &MdnsRecord) -> WifiDeviceDto {
    let address = rec
        .addresses
        .iter()
        .find(|a| a.parse::<Ipv4Addr>().is_ok())
        .cloned()
        // Strip the mDNS trailing dot (e.g. "elrs-rx.local.") so the host
        // fallback yields an address `isValidDeviceIp` accepts — mirrors the TS
        // twin `rec.host.replace(/\.$/, "")` in `src/lib/wifiDiscovery.ts`.
        .unwrap_or_else(|| rec.host.trim_end_matches('.').to_string());
    WifiDeviceDto {
        id: format!("mdns:{address}"),
        name: rec.instance_name.clone(),
        kind: detect_kind(&normalize(&rec.instance_name)).to_string(),
        address,
        source: "mdns".to_string(),
    }
}

/// Strip the `.{ty_domain}` suffix from an mDNS fullname to recover the instance
/// label (e.g. `"MyTX._http._tcp.local."` + `"_http._tcp.local."` → `"MyTX"`).
fn instance_name_from_fullname(fullname: &str, ty_domain: &str) -> String {
    fullname
        .strip_suffix(&format!(".{ty_domain}"))
        .unwrap_or(fullname)
        .to_string()
}

// ---------------------------------------------------------------------------
// HTTP probe helpers (pure URL build + identity parse).
// ---------------------------------------------------------------------------

/// Build the probe URL for a device address.
fn probe_url(address: &str) -> String {
    format!("http://{address}/")
}

/// Allow/deny classifier for a [`probe_wifi_device`] target (SSRF guard). A probe
/// must target a device on the local link, never an arbitrary public host.
/// Returns `true` only when `address` is:
///  - a private / link-local / loopback IPv4 — `10/8`, `172.16/12`, `192.168/16`
///    (private), `169.254/16` (link-local) and `127/8` (loopback), which covers
///    the ELRS captive-portal default `10.0.0.1`; or
///  - an mDNS `.local` hostname (link-local by definition, resolved over
///    multicast on the local network only).
///
/// Everything else — public/routable IPv4s and hosts, and any address carrying an
/// embedded path, port, credential or query (which breaks both checks) — is
/// rejected.
fn is_probe_target_allowed(address: &str) -> bool {
    if let Ok(ip) = address.parse::<Ipv4Addr>() {
        return ip.is_private() || ip.is_loopback() || ip.is_link_local();
    }
    is_local_mdns_host(address)
}

/// True for an mDNS `.local` hostname made up solely of hostname characters
/// (alphanumeric, `-`, `.`). The character allow-list rejects any embedded path
/// (`/`), credential (`@`), port (`:`) or query (`?`/`#`) so only a bare
/// link-local mDNS name is accepted.
fn is_local_mdns_host(address: &str) -> bool {
    let host = address.to_ascii_lowercase();
    host.len() > ".local".len()
        && host.ends_with(".local")
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

/// Best-effort identity from a probe response body. ELRS web servers vary (HTML
/// or JSON); we parse JSON when present, else fall back to the address as the
/// name and a `TX` default.
///
/// `reachable` is true ONLY when the body shows a recognizable ELRS marker — a
/// lower-cased `"elrs"`/`"expresslrs"` literal, or an ELRS-identity JSON object
/// with a TX/RX role field. A bare HTTP 200 from a non-ELRS server (a router or
/// printer admin page) is NOT the device we want, so it returns
/// `reachable:false`.
fn parse_identity(body: &str, address: &str) -> WifiDeviceIdentityDto {
    let mut name = address.to_string();
    let mut device_type = "TX".to_string();
    let mut firmware_version = None;

    let lower = body.to_lowercase();
    let mut is_elrs = lower.contains("elrs") || lower.contains("expresslrs");

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(n) = first_str(
            &value,
            &["name", "target_name", "product_name", "deviceName"],
        ) {
            name = n;
        }
        if let Some(t) = first_str(&value, &["type", "device_type", "deviceType", "mode"]) {
            let role = t.to_lowercase();
            if role.contains("rx") || role.contains("tx") {
                // An ELRS-style identity object (explicit TX/RX role) is itself a
                // marker, even when the body never spells out "elrs".
                is_elrs = true;
                device_type = if role.contains("rx") {
                    "RX".to_string()
                } else {
                    "TX".to_string()
                };
            }
        }
        firmware_version = first_str(
            &value,
            &["version", "firmware_version", "firmwareVersion", "fw"],
        );
    }

    WifiDeviceIdentityDto {
        name,
        device_type,
        firmware_version,
        reachable: is_elrs,
    }
}

/// First non-empty string value among `keys` on a top-level JSON object.
fn first_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Platform SSID scan (self-AP discovery). Missing tool ⇒ log + empty, never err.
// ---------------------------------------------------------------------------

/// Scan visible WiFi SSIDs via the platform tool. Returns an empty list (after
/// logging) when no adapter / tool is available.
fn scan_ssids() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        scan_ssids_linux()
    }
    #[cfg(target_os = "windows")]
    {
        scan_ssids_windows()
    }
    #[cfg(target_os = "macos")]
    {
        scan_ssids_macos()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// Linux: `nmcli -t -f SSID dev wifi`, falling back to `iw ... scan` when nmcli
/// is unavailable (NetworkManager not installed).
#[cfg(target_os = "linux")]
fn scan_ssids_linux() -> Vec<String> {
    match std::process::Command::new("nmcli")
        .args(["-t", "-f", "SSID", "dev", "wifi"])
        .output()
    {
        Ok(out) if out.status.success() => parse_nmcli_ssids(&String::from_utf8_lossy(&out.stdout)),
        Ok(out) => {
            log_wifi(
                WifiErrorCategory::ScanTool,
                &format!("nmcli exited {} — trying iw fallback", out.status),
            );
            iw_scan_ssids()
        }
        Err(e) => {
            log_wifi(
                WifiErrorCategory::ScanTool,
                &format!("nmcli unavailable ({e}) — trying iw fallback"),
            );
            iw_scan_ssids()
        }
    }
}

/// Linux fallback: enumerate wireless interfaces with `iw dev`, then `iw dev
/// <iface> scan` each. Best-effort: a missing `iw`, or a scan that needs root,
/// just yields an empty list.
#[cfg(target_os = "linux")]
fn iw_scan_ssids() -> Vec<String> {
    let dev_out = match std::process::Command::new("iw").arg("dev").output() {
        Ok(out) if out.status.success() => out.stdout,
        Ok(_) | Err(_) => {
            log_wifi(WifiErrorCategory::ScanTool, "iw unavailable — no SSID scan");
            return Vec::new();
        }
    };
    let mut ssids = Vec::new();
    for iface in parse_iw_dev_interfaces(&String::from_utf8_lossy(&dev_out)) {
        if let Ok(out) = std::process::Command::new("iw")
            .args(["dev", &iface, "scan"])
            .output()
        {
            if out.status.success() {
                for ssid in parse_iw_ssids(&String::from_utf8_lossy(&out.stdout)) {
                    if !ssids.contains(&ssid) {
                        ssids.push(ssid);
                    }
                }
            }
        }
    }
    ssids
}

/// Windows: `netsh wlan show networks`.
#[cfg(target_os = "windows")]
fn scan_ssids_windows() -> Vec<String> {
    match std::process::Command::new("netsh")
        .args(["wlan", "show", "networks"])
        .output()
    {
        Ok(out) if out.status.success() => parse_netsh_ssids(&String::from_utf8_lossy(&out.stdout)),
        Ok(out) => {
            log_wifi(
                WifiErrorCategory::ScanTool,
                &format!("netsh exited {} — no SSID scan", out.status),
            );
            Vec::new()
        }
        Err(e) => {
            log_wifi(
                WifiErrorCategory::ScanTool,
                &format!("netsh unavailable ({e}) — no SSID scan"),
            );
            Vec::new()
        }
    }
}

/// macOS: the Apple80211 `airport -s` scan.
#[cfg(target_os = "macos")]
fn scan_ssids_macos() -> Vec<String> {
    const AIRPORT: &str =
        "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";
    match std::process::Command::new(AIRPORT).arg("-s").output() {
        Ok(out) if out.status.success() => {
            parse_airport_ssids(&String::from_utf8_lossy(&out.stdout))
        }
        Ok(out) => {
            log_wifi(
                WifiErrorCategory::ScanTool,
                &format!("airport exited {} — no SSID scan", out.status),
            );
            Vec::new()
        }
        Err(e) => {
            log_wifi(
                WifiErrorCategory::ScanTool,
                &format!("airport unavailable ({e}) — no SSID scan"),
            );
            Vec::new()
        }
    }
}

// --- Pure stdout→SSID parsers (compiled on their target OS or under test). ---

/// Parse `nmcli -t -f SSID dev wifi` output: one SSID per line, `\:`-escaped
/// colons, blank lines for hidden networks. Drops blanks + duplicates,
/// preserving first-seen order.
#[cfg(any(target_os = "linux", test))]
fn parse_nmcli_ssids(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let ssid = line.replace("\\:", ":");
        let ssid = ssid.trim();
        if ssid.is_empty() || ssid == "--" {
            continue;
        }
        if !out.iter().any(|s| s == ssid) {
            out.push(ssid.to_string());
        }
    }
    out
}

/// Parse `iw dev <iface> scan` output: `\tSSID: <name>` lines (blank for
/// hidden). Dedups, preserving order.
#[cfg(any(target_os = "linux", test))]
fn parse_iw_ssids(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("SSID:") {
            let ssid = rest.trim();
            if !ssid.is_empty() && !out.iter().any(|s| s == ssid) {
                out.push(ssid.to_string());
            }
        }
    }
    out
}

/// Parse interface names from `iw dev` output (`\tInterface <name>` lines).
#[cfg(any(target_os = "linux", test))]
fn parse_iw_dev_interfaces(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("Interface ") {
            let iface = rest.trim();
            if !iface.is_empty() && !out.iter().any(|s| s == iface) {
                out.push(iface.to_string());
            }
        }
    }
    out
}

/// Parse `netsh wlan show networks` output: `SSID <n> : <name>` lines (the
/// numeric index distinguishes them from `BSSID <n>` rows). Dedups, preserving
/// order.
#[cfg(any(target_os = "windows", test))]
fn parse_netsh_ssids(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        // "SSID 1 : Name" — but NOT "BSSID 1 : ..." (strip_prefix rejects it).
        let Some(rest) = trimmed.strip_prefix("SSID ") else {
            continue;
        };
        let Some((index, name)) = rest.split_once(':') else {
            continue;
        };
        let index = index.trim();
        if index.is_empty() || !index.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let name = name.trim();
        if !name.is_empty() && !out.iter().any(|s| s == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// Parse `airport -s` output: a header row then one network per line, the SSID
/// being the text before the BSSID MAC column. Best-effort.
#[cfg(any(target_os = "macos", test))]
fn parse_airport_ssids(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, line) in stdout.lines().enumerate() {
        if i == 0 || line.trim().is_empty() {
            continue; // header row / blanks
        }
        // SSID is right-aligned text up to the BSSID (xx:xx:xx:xx:xx:xx).
        if let Some(idx) = find_bssid_start(line) {
            let ssid = line[..idx].trim();
            if !ssid.is_empty() && !out.iter().any(|s| s == ssid) {
                out.push(ssid.to_string());
            }
        }
    }
    out
}

/// Byte offset of the first `xx:xx:xx:xx:xx:xx` MAC in a line, if any.
#[cfg(any(target_os = "macos", test))]
fn find_bssid_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    // A MAC is 17 chars: HH:HH:HH:HH:HH:HH. `str::get` yields `None` on an
    // out-of-range OR non-char-boundary window, so a non-ASCII SSID (accented
    // Latin, CJK, emoji, or a U+FFFD from `from_utf8_lossy`) can never panic the
    // byte-index slice — honoring the module's NO-PANICS contract.
    for start in 0..bytes.len().saturating_sub(16) {
        if let Some(window) = line.get(start..start + 17) {
            if is_mac(window) {
                return Some(start);
            }
        }
    }
    None
}

#[cfg(any(target_os = "macos", test))]
fn is_mac(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 17 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let ok = if (i + 1) % 3 == 0 {
            *b == b':'
        } else {
            b.is_ascii_hexdigit()
        };
        if !ok {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Shared.
// ---------------------------------------------------------------------------

/// Emit a Tauri event, logging (rather than silently discarding) a failure.
/// Best-effort: a failed emit must never crash the scan worker.
fn emit_or_log<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "wifi", "failed to emit {event}: {e}");
    }
}

/// Consistent structured stderr log for a categorized WiFi condition:
/// `[wifi] {category}: {msg}`. Used for BOTH genuine error events (alongside the
/// emit) and graceful/degraded no-op paths (missing adapter / missing tool / no
/// devices) — the latter log ONLY, they never emit a `wifi://error` event.
fn log_wifi(category: WifiErrorCategory, msg: &str) {
    tracing::warn!(target: "wifi", "{}: {msg}", category.as_str());
}

/// Emit a categorized `wifi://error` event (genuine failures only). Also logs the
/// same condition via [`log_wifi`] so stderr and the UI agree.
fn emit_error(app: &AppHandle, category: WifiErrorCategory, summary_key: &str, detail: String) {
    log_wifi(category, &detail);
    emit_or_log(
        app,
        "wifi://error",
        WifiErrorDto::new(category, summary_key, detail),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wifi_error_category_maps_to_camel_case_strings() {
        assert_eq!(WifiErrorCategory::Adapter.as_str(), "adapter");
        assert_eq!(WifiErrorCategory::ScanTool.as_str(), "scanTool");
        assert_eq!(WifiErrorCategory::Mdns.as_str(), "mdns");
        assert_eq!(WifiErrorCategory::Probe.as_str(), "probe");
        assert_eq!(WifiErrorCategory::Unknown.as_str(), "unknown");
    }

    #[test]
    fn wifi_error_dto_serializes_to_structured_camel_case() {
        let dto = WifiErrorDto::new(
            WifiErrorCategory::Mdns,
            "mdnsInitFailed",
            "boom".to_string(),
        );
        let json = serde_json::to_string(&dto).unwrap();
        assert_eq!(
            json,
            r#"{"category":"mdns","summaryKey":"mdnsInitFailed","detail":"boom"}"#
        );
    }

    #[test]
    fn mdns_init_failure_maps_to_mdns_init_failed() {
        // The one genuine-failure event this surface raises: category "mdns",
        // summaryKey "mdnsInitFailed", detail carrying the underlying error.
        let dto = WifiErrorDto::new(
            WifiErrorCategory::Mdns,
            "mdnsInitFailed",
            "mDNS subsystem failed to initialize: no route".to_string(),
        );
        assert_eq!(dto.category, "mdns");
        assert_eq!(dto.summary_key, "mdnsInitFailed");
        assert!(dto.detail.contains("mDNS subsystem failed to initialize"));
    }

    #[test]
    fn scan_done_dto_serializes_with_generation() {
        let json = serde_json::to_string(&WifiScanDoneDto { generation: 7 }).unwrap();
        assert_eq!(json, r#"{"generation":7}"#);
    }

    #[test]
    fn ssid_matcher_accepts_elrs_tx_rx() {
        assert_eq!(classify_ssid("ExpressLRS TX"), (true, "tx"));
        assert_eq!(classify_ssid("ExpressLRS RX 01"), (true, "rx"));
        assert_eq!(classify_ssid("expresslrs tx"), (true, "tx"));
    }

    #[test]
    fn ssid_matcher_rejects_backpack_vrx_and_noise() {
        // Backpack/VRX are M19 — rejected even with a TX/RX token present.
        assert_eq!(classify_ssid("ExpressLRS TX Backpack"), (false, "unknown"));
        assert_eq!(classify_ssid("ExpressLRS VRX Backpack"), (false, "unknown"));
        assert_eq!(classify_ssid("ExpressLRS VRX"), (false, "unknown"));
        assert_eq!(classify_ssid("MyHomeWiFi"), (false, "unknown"));
        assert_eq!(classify_ssid(""), (false, "unknown"));
    }

    #[test]
    fn ssid_to_device_shape() {
        let dto = ssid_to_device("ExpressLRS RX 01").expect("elrs ssid");
        assert_eq!(dto.id, "ap:ExpressLRS RX 01");
        assert_eq!(dto.name, "ExpressLRS RX 01");
        assert_eq!(dto.address, "10.0.0.1");
        assert_eq!(dto.source, "ap");
        assert_eq!(dto.kind, "rx");
        assert!(ssid_to_device("MyHomeWiFi").is_none());
        assert!(ssid_to_device("ExpressLRS TX Backpack").is_none());
    }

    #[test]
    fn mdns_record_maps_to_dto_with_ipv4() {
        let rec = MdnsRecord {
            instance_name: "ExpressLRS RX".to_string(),
            host: "elrs-rx.local.".to_string(),
            // IPv6 first, then a usable IPv4 — the mapper must pick the IPv4.
            addresses: vec!["fe80::1".to_string(), "192.168.1.50".to_string()],
            port: 80,
        };
        let dto = mdns_record_to_device(&rec);
        assert_eq!(dto.source, "mdns");
        assert_eq!(dto.address, "192.168.1.50");
        assert_eq!(dto.id, "mdns:192.168.1.50");
        assert_eq!(dto.name, "ExpressLRS RX");
        assert_eq!(dto.kind, "rx");
    }

    #[test]
    fn mdns_record_falls_back_to_host_without_ipv4() {
        let rec = MdnsRecord {
            instance_name: "node".to_string(),
            host: "elrs.local.".to_string(),
            addresses: vec!["fe80::abcd".to_string()],
            port: 80,
        };
        let dto = mdns_record_to_device(&rec);
        // The trailing mDNS dot is stripped so the address matches the TS twin
        // and passes `isValidDeviceIp`.
        assert_eq!(dto.address, "elrs.local");
        assert_eq!(dto.kind, "unknown");
    }

    #[test]
    fn mdns_host_fallback_strips_trailing_dot() {
        // Regression: an IPv6-only record falls back to `host`, which carries the
        // mDNS trailing dot. The mapper must strip it so the emitted address is
        // dot-free (matching `mdnsRecordToDevice` and passing `isValidDeviceIp`).
        let rec = MdnsRecord {
            instance_name: "ExpressLRS RX".to_string(),
            host: "elrs-rx.local.".to_string(),
            addresses: vec!["fe80::1".to_string()],
            port: 80,
        };
        let dto = mdns_record_to_device(&rec);
        assert_eq!(dto.address, "elrs-rx.local");
        assert_eq!(dto.id, "mdns:elrs-rx.local");
    }

    #[test]
    fn instance_name_strips_service_suffix() {
        assert_eq!(
            instance_name_from_fullname("MyTX._http._tcp.local.", "_http._tcp.local."),
            "MyTX"
        );
        // No suffix match → unchanged.
        assert_eq!(
            instance_name_from_fullname("bare", "_http._tcp.local."),
            "bare"
        );
    }

    #[test]
    fn probe_url_build() {
        assert_eq!(probe_url("10.0.0.1"), "http://10.0.0.1/");
        assert_eq!(probe_url("192.168.1.50"), "http://192.168.1.50/");
    }

    #[test]
    fn probe_target_allows_only_local_and_blocks_ssrf() {
        // SSRF guard: probe_wifi_device must accept only LAN-local targets and
        // refuse any public/routable host so it can't be turned into a probe of
        // an arbitrary HTTP endpoint.
        // Allowed: private / link-local / loopback IPv4 + bare `.local` mDNS.
        for ok in [
            "10.0.0.1",       // ELRS captive-portal default
            "192.168.1.50",   // 192.168/16 private
            "172.16.0.1",     // 172.16/12 lower bound
            "172.31.255.255", // 172.16/12 upper bound
            "169.254.1.1",    // link-local
            "127.0.0.1",      // loopback
            "elrs-rx.local",  // mDNS link-local name
            "FOO.LOCAL",      // case-insensitive `.local`
            // A public-IP-shaped `.local` name is still only a link-local mDNS
            // name (resolved via multicast on the local link, never the public
            // 8.8.8.8), so it is safe to allow.
            "8.8.8.8.local",
        ] {
            assert!(is_probe_target_allowed(ok), "{ok} should be allowed");
        }
        // Rejected: public IPs/hosts, the 172.16/12 boundary miss, and any
        // address carrying an embedded path / port / credential / query (which
        // also defeats the parser-differential bypass class), plus IPv6 and
        // non-canonical IPv4 encodings the strict parser refuses.
        for bad in [
            "8.8.8.8",              // public
            "1.1.1.1",              // public
            "172.32.0.1",           // just outside 172.16/12
            "example.com",          // public host
            "10.0.0.1:80",          // embedded port
            "10.0.0.1/admin",       // embedded path
            "user@10.0.0.1",        // embedded credential
            "10.0.0.1?x=1",         // embedded query
            "010.0.0.1",            // octal — strict parser rejects
            "0x0a000001",           // hex dword
            "2130706433",           // decimal dword (127.0.0.1)
            "::1",                  // IPv6 loopback
            "2001:4860:4860::8888", // IPv6 public
            ".local",               // too short to be a real name
        ] {
            assert!(!is_probe_target_allowed(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn identity_parse_from_json_body() {
        let body = r#"{ "name": "ELRS RX", "type": "RX", "version": "3.4.0" }"#;
        let id = parse_identity(body, "10.0.0.1");
        assert_eq!(id.name, "ELRS RX");
        assert_eq!(id.device_type, "RX");
        assert_eq!(id.firmware_version.as_deref(), Some("3.4.0"));
        assert!(id.reachable);
    }

    #[test]
    fn identity_parse_falls_back_for_html_body() {
        let id = parse_identity("<html><body>ExpressLRS</body></html>", "10.0.0.1");
        assert_eq!(id.name, "10.0.0.1"); // no JSON → address as name
        assert_eq!(id.device_type, "TX");
        assert!(id.firmware_version.is_none());
        assert!(id.reachable); // an ELRS-marked reply means reachable
    }

    #[test]
    fn identity_parse_handles_malformed_json_via_body_marker() {
        // M29: a truncated/garbled probe body is common (slow device, partial
        // read). serde fails to parse it, so identity falls back to the raw-body
        // ELRS marker check: a marked body is still `reachable` (name stays the
        // address, since no JSON name could be extracted)...
        let marked = parse_identity(r#"{ "name": "ELRS RX", "type": "#, "10.0.0.1");
        assert!(
            marked.reachable,
            "an ELRS marker in the body means reachable"
        );
        assert_eq!(marked.name, "10.0.0.1", "no JSON parsed ⇒ address as name");
        // ...and malformed JSON with NO ELRS marker at all is not our device.
        let unmarked = parse_identity(r#"{ "status": "ok"#, "192.168.1.1");
        assert!(!unmarked.reachable);
    }

    #[test]
    fn mdns_collision_and_multi_ipv4_preference() {
        // M29: the discovered-device id is keyed on the ADDRESS, not the instance
        // name. Two differently-named records resolving to the same IPv4 collapse
        // to one id, so the scan worker's `seen` HashSet dedups them to a single
        // device (no duplicate entries for one physical box).
        let a = mdns_record_to_device(&MdnsRecord {
            instance_name: "ExpressLRS TX".to_string(),
            host: "a.local.".to_string(),
            addresses: vec!["192.168.1.50".to_string()],
            port: 80,
        });
        let b = mdns_record_to_device(&MdnsRecord {
            instance_name: "ExpressLRS RX".to_string(),
            host: "b.local.".to_string(),
            addresses: vec!["192.168.1.50".to_string()],
            port: 80,
        });
        assert_eq!(a.id, b.id, "same address ⇒ same id (dedup key)");
        assert_eq!(a.id, "mdns:192.168.1.50");

        // The FIRST usable IPv4 is chosen, skipping a leading IPv6 (and not the
        // later IPv4) — pins the address-selection order.
        let multi = mdns_record_to_device(&MdnsRecord {
            instance_name: "ExpressLRS RX".to_string(),
            host: "x.local.".to_string(),
            addresses: vec![
                "fe80::1".to_string(),
                "10.0.0.7".to_string(),
                "192.168.1.9".to_string(),
            ],
            port: 80,
        });
        assert_eq!(multi.address, "10.0.0.7");
        assert_eq!(multi.id, "mdns:10.0.0.7");
    }

    #[test]
    fn identity_parse_rejects_non_elrs_200() {
        // A bare 200 from a random web server (router/printer admin page) shows
        // no ELRS marker → not the device we want.
        let html = parse_identity("<html><title>Router Login</title></html>", "192.168.1.1");
        assert!(!html.reachable);
        // Generic JSON without an ELRS marker or TX/RX role is also rejected.
        let json = parse_identity(r#"{ "status": "ok", "uptime": 42 }"#, "192.168.1.1");
        assert!(!json.reachable);
    }

    #[test]
    fn is_elrs_mdns_accepts_elrs_and_rejects_generic() {
        // Accept: "elrs" or "expresslrs" (both literals — neither contains the
        // other) in either the instance name or the host.
        assert!(is_elrs_mdns("ExpressLRS RX", "node.local."));
        assert!(is_elrs_mdns("elrs_rx", "host.local."));
        assert!(is_elrs_mdns("printer", "elrs-tx.local."));
        // Reject: generic LAN services + empty.
        assert!(!is_elrs_mdns("Brother HL-2270DW", "printer.local."));
        assert!(!is_elrs_mdns("Chromecast", "chromecast.local."));
        assert!(!is_elrs_mdns("My NAS", "nas.local."));
        assert!(!is_elrs_mdns("", ""));
    }

    #[test]
    fn nmcli_parser_extracts_ssids() {
        let stdout = "ExpressLRS TX\nMyHomeWiFi\n\nNeighbor\\:Net\nMyHomeWiFi\n";
        let ssids = parse_nmcli_ssids(stdout);
        assert_eq!(
            ssids,
            vec![
                "ExpressLRS TX".to_string(),
                "MyHomeWiFi".to_string(),
                "Neighbor:Net".to_string(), // \: unescaped, dup MyHomeWiFi dropped
            ]
        );
    }

    #[test]
    fn netsh_parser_extracts_ssids() {
        let stdout = "\
Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : ExpressLRS TX
    Network type            : Infrastructure
    Authentication          : Open
    BSSID 1                 : aa:bb:cc:dd:ee:ff
SSID 2 : MyHomeWiFi
    Network type            : Infrastructure
";
        let ssids = parse_netsh_ssids(stdout);
        assert_eq!(
            ssids,
            vec!["ExpressLRS TX".to_string(), "MyHomeWiFi".to_string()]
        );
    }

    #[test]
    fn iw_parsers_extract_interfaces_and_ssids() {
        let dev = "phy#0\n\tInterface wlan0\n\t\tifindex 3\n\tInterface wlan1\n";
        assert_eq!(
            parse_iw_dev_interfaces(dev),
            vec!["wlan0".to_string(), "wlan1".to_string()]
        );
        let scan =
            "BSS aa:bb:cc:dd:ee:ff\n\tSSID: ExpressLRS TX\nBSS 11:22:33:44:55:66\n\tSSID: \n";
        assert_eq!(parse_iw_ssids(scan), vec!["ExpressLRS TX".to_string()]);
    }

    #[test]
    fn airport_parser_extracts_ssids() {
        let stdout = "\
                            SSID BSSID             RSSI CHANNEL
                   ExpressLRS TX aa:bb:cc:dd:ee:ff  -40 1
                      MyHomeWiFi 11:22:33:44:55:66  -60 6
";
        let ssids = parse_airport_ssids(stdout);
        assert_eq!(
            ssids,
            vec!["ExpressLRS TX".to_string(), "MyHomeWiFi".to_string()]
        );
    }

    #[test]
    fn airport_parser_handles_non_ascii_ssids_without_panic() {
        // Regression: WiFi SSIDs routinely carry non-ASCII bytes (accented Latin,
        // CJK, emoji). The byte-index window slide in `find_bssid_start` must never
        // land a `&str` slice on a non-char boundary and panic the scan worker.
        let stdout = "\
                            SSID BSSID             RSSI CHANNEL
                        Café-Net aa:bb:cc:dd:ee:ff  -40 1
                          网络TX 11:22:33:44:55:66  -60 6
                       emoji🚁RX 22:33:44:55:66:77  -55 11
";
        let ssids = parse_airport_ssids(stdout);
        assert_eq!(
            ssids,
            vec![
                "Café-Net".to_string(),
                "网络TX".to_string(),
                "emoji🚁RX".to_string(),
            ]
        );
    }

    // --- M19 Backpack classifier --------------------------------------------

    #[test]
    fn backpack_ssid_accepts_tx_and_vrx() {
        assert_eq!(
            classify_backpack_ssid("ExpressLRS TX Backpack"),
            Some("tx-backpack")
        );
        assert_eq!(
            classify_backpack_ssid("ExpressLRS VRX Backpack"),
            Some("vrx-backpack")
        );
        // Case / whitespace-run variants normalize the same way.
        assert_eq!(
            classify_backpack_ssid("expresslrs  tx  backpack"),
            Some("tx-backpack")
        );
        // Trailing index suffix does not break the whole-word "tx" token.
        assert_eq!(
            classify_backpack_ssid("ExpressLRS TX Backpack 02"),
            Some("tx-backpack")
        );
    }

    #[test]
    fn backpack_ssid_rejects_non_backpack() {
        // Missing the "backpack" literal ⇒ None even with a TX/RX role token.
        assert_eq!(classify_backpack_ssid("ExpressLRS TX"), None);
        assert_eq!(classify_backpack_ssid("ExpressLRS RX 01"), None);
        assert_eq!(classify_backpack_ssid("MyHomeWiFi"), None);
        assert_eq!(classify_backpack_ssid(""), None);
    }

    #[test]
    fn backpack_and_elrs_classifiers_are_disjoint() {
        // "ExpressLRS TX Backpack": M18 still rejects, M19 accepts — prove both ways.
        assert_eq!(classify_ssid("ExpressLRS TX Backpack"), (false, "unknown"));
        assert_eq!(
            classify_backpack_ssid("ExpressLRS TX Backpack"),
            Some("tx-backpack")
        );
        // "ExpressLRS TX": M18 accepts, M19 rejects — the mirror case.
        assert_eq!(classify_ssid("ExpressLRS TX"), (true, "tx"));
        assert_eq!(classify_backpack_ssid("ExpressLRS TX"), None);
    }

    #[test]
    fn backpack_ssid_to_device_shape() {
        let dto = backpack_ssid_to_device("ExpressLRS VRX Backpack").expect("backpack ssid");
        assert_eq!(dto.id, "ap:ExpressLRS VRX Backpack");
        assert_eq!(dto.name, "ExpressLRS VRX Backpack");
        assert_eq!(dto.address, "10.0.0.1");
        assert_eq!(dto.source, "ap");
        assert_eq!(dto.kind, "vrx-backpack");
        // A non-backpack SSID maps to nothing on this channel.
        assert!(backpack_ssid_to_device("ExpressLRS TX").is_none());
    }

    #[test]
    fn detect_serial_backpack_is_empty_without_hardware() {
        // HARDWARE-PENDING: graceful-empty in dev, never an error.
        assert!(detect_serial_backpack().is_empty());
    }
}
