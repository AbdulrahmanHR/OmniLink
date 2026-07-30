/**
 * Pure WiFi-discovery model for the M18 WiFi-mode device scanner.
 *
 * Two discovery channels feed one {@link WifiDevice} list:
 *  - `"ap"`   — a fresh WiFi-mode ELRS device exposing its own self-AP
 *               (SSID like "ExpressLRS TX"). The HTTP config API always lives
 *               at the well-known captive-portal address `10.0.0.1`.
 *  - `"mdns"` — a device already joined to the LAN, advertised over mDNS; we
 *               reach it at its resolved IP.
 *
 * Everything here is PURE and deterministic: no clock, no randomness, no I/O.
 * The transforms are shared verbatim by the Rust scanner side, the WiFi store
 * (Agent C) and the unit tests (Agent D).
 *
 * M18/M19 BOUNDARY: the self-AP classifier deliberately REJECTS any SSID that
 * looks like a Backpack/VRX device ("...Backpack", "ExpressLRS VRX", ...).
 * Those belong to the Backpack scanner added in M19; admitting them here would
 * make M18 claim devices it cannot configure. The rejection is enforced in
 * {@link classifyElrsSsid} only — mDNS kind inference (M18 devices already on
 * the LAN) is unaffected.
 */

/** Where a discovered device was found: its own self-AP, or mDNS on the LAN. */
export type WifiSource = "ap" | "mdns";

/**
 * Coarse device role inferred from the SSID / mDNS instance name.
 *
 * M19 widens the union with the two Backpack roles. The M18 classifiers in this
 * file ({@link classifyElrsSsid}, {@link detectKind}) still only ever produce
 * `"tx"`/`"rx"`/`"unknown"` — the Backpack values are produced exclusively by
 * the parallel M19 classifier in `src/lib/backpack.ts`, so a Backpack SSID is
 * surfaced as a distinct kind here and is STILL rejected by
 * {@link classifyElrsSsid} (never leaks into the plain TX/RX list).
 */
export type WifiDeviceKind =
  | "tx"
  | "rx"
  | "unknown"
  | "tx-backpack"
  | "vrx-backpack";

/** A device the WiFi scanner can hand off to the HTTP config flow. */
export interface WifiDevice {
  /** Stable id: `${source}:${address}` (or `ap:${ssid}` for self-AP). */
  id: string;
  /** Human label: the SSID (AP) or the mDNS instance name. */
  name: string;
  /** Host to reach the HTTP API ("10.0.0.1" for AP; resolved IP for mDNS). */
  address: string;
  source: WifiSource;
  kind: WifiDeviceKind;
}

/** A single resolved mDNS service record (subset we consume). */
export interface MdnsRecord {
  instanceName: string;
  host: string;
  addresses: string[];
  port: number;
}

/** Captive-portal HTTP API address every ELRS self-AP serves from. */
const AP_ADDRESS = "10.0.0.1";

/** Collapse runs of whitespace to single spaces and trim, lower-cased. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Detect TX/RX role from a normalised name, WITHOUT any Backpack/VRX gating.
 *
 * Shared by {@link classifyElrsSsid} (after it has applied the M19 rejection)
 * and {@link mdnsRecordToDevice} (where records are already known ELRS LAN
 * devices, so only the role matters). Returns "unknown" when neither role
 * token is present.
 *
 * Matches the ExpressLRS token as a whole word so a trailing suffix/number is
 * tolerated ("ExpressLRS RX 01") but "txt"/"rxd" style noise is not.
 */
function detectKind(normalized: string): WifiDeviceKind {
  if (/(^|\s)tx(\s|$)/.test(normalized)) return "tx";
  if (/(^|\s)rx(\s|$)/.test(normalized)) return "rx";
  return "unknown";
}

/**
 * Classify a scanned SSID as an ELRS self-AP and infer its role.
 *
 * Accepts the self-AP names "ExpressLRS TX" / "ExpressLRS RX",
 * case-insensitively and whitespace-tolerantly (whitespace is collapsed), with
 * an optional trailing suffix/number ("ExpressLRS RX 01", "expresslrs tx").
 *
 * M19 EXCLUSION (checked FIRST): any SSID containing "Backpack" or "VRX"
 * (case-insensitive) is rejected as `{ isElrs:false, kind:"unknown" }`, even
 * when it also contains a TX/RX token ("ExpressLRS TX Backpack"). Backpack/VRX
 * devices are handled by the M19 scanner, not here.
 *
 * Any unrelated or empty SSID also yields `{ isElrs:false, kind:"unknown" }`.
 */
export function classifyElrsSsid(ssid: string): {
  isElrs: boolean;
  kind: WifiDeviceKind;
} {
  const normalized = normalize(ssid);

  // M19 boundary: reject Backpack/VRX before any TX/RX accept.
  if (normalized.includes("backpack") || normalized.includes("vrx")) {
    return { isElrs: false, kind: "unknown" };
  }

  // Must look like an ExpressLRS self-AP to be claimed by M18.
  if (!normalized.includes("expresslrs")) {
    return { isElrs: false, kind: "unknown" };
  }

  const kind = detectKind(normalized);
  if (kind === "unknown") {
    return { isElrs: false, kind: "unknown" };
  }
  return { isElrs: true, kind };
}

/**
 * Map a self-AP SSID to a {@link WifiDevice}, or `null` when the SSID is not an
 * ELRS self-AP per {@link classifyElrsSsid} (including all M19 Backpack/VRX
 * SSIDs). The id is keyed on the raw SSID (`ap:${ssid}`) and the address is
 * always the captive-portal {@link AP_ADDRESS}.
 */
export function ssidToDevice(ssid: string): WifiDevice | null {
  const { isElrs, kind } = classifyElrsSsid(ssid);
  if (!isElrs) return null;
  return {
    id: `ap:${ssid}`,
    name: ssid,
    address: AP_ADDRESS,
    source: "ap",
    kind,
  };
}

/**
 * The ELRS gate for mDNS records: true when the record plausibly belongs to an
 * ELRS device. Applied BEFORE emitting a `wifi://discovered`, this keeps the
 * generic `_http._tcp.local.` haystack (printers, Chromecasts, NAS, routers…)
 * out of the device list — the spec is an mDNS scan FOR ELRS devices.
 *
 * Heuristic: lower-case the instance name (and host) and require it to contain
 * `"elrs"` OR `"expresslrs"`. Both literals MUST be tested: "elrs" is NOT a
 * substring of "expresslrs" (e-x-p-r-e-s-s-l-r-s has no consecutive e-l-r-s), so
 * a device advertised only as "ExpressLRS …" would be missed by an "elrs" check
 * alone, and vice-versa.
 *
 * M19 may broaden this gate (e.g. to admit Backpack/VRX mDNS instances).
 */
export function isElrsMdnsRecord(rec: MdnsRecord): boolean {
  const haystack = `${rec.instanceName} ${rec.host}`.toLowerCase();
  return haystack.includes("elrs") || haystack.includes("expresslrs");
}

/** Dotted-quad IPv4 matcher (0-255 octets), used to pick a reachable address. */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Map a resolved mDNS record to a {@link WifiDevice}.
 *
 * Address selection: the first usable IPv4 dotted-quad in `rec.addresses`,
 * falling back to `rec.host` when the record carries no IPv4 (e.g. IPv6-only
 * or empty address set). The id is `mdns:${address}` and the role is inferred
 * from `instanceName` via the shared TX/RX detector (default "unknown").
 *
 * Note: the M19 Backpack/VRX exclusion does NOT apply here — mDNS records in
 * this flow are already ELRS LAN devices, so we only infer the role.
 */
export function mdnsRecordToDevice(rec: MdnsRecord): WifiDevice {
  const ipv4 = rec.addresses.find((addr) => IPV4_RE.test(addr));
  // mDNS hosts carry a trailing dot ("elrs-rx.local."); strip a single one so
  // the host fallback yields an address `isValidDeviceIp` accepts.
  const address = ipv4 ?? rec.host.replace(/\.$/, "");
  return {
    id: `mdns:${address}`,
    name: rec.instanceName,
    address,
    source: "mdns",
    kind: detectKind(normalize(rec.instanceName)),
  };
}

/** i18n key for a source label: "wifi.source.ap" / "wifi.source.mdns". */
export function wifiSourceLabelKey(source: WifiSource): string {
  return `wifi.source.${source}`;
}
