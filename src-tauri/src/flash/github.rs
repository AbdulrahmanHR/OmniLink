//! ExpressLRS firmware release fetch (FR-FLASH-01).
//!
//! Pulls the release list (version tag + changelog) from the GitHub Releases
//! API for `ExpressLRS/ExpressLRS`. Results are cached in-process with a TTL so
//! repeated wizard opens don't re-hit the network; if a later fetch fails, the
//! cached list is served again rather than erroring (NFR-ERR-02). That cache is
//! **in-process only** ([`static@CACHE`]) — it is not persisted, so a cold start
//! with no network has nothing to serve and the wizard falls back to its bundled
//! catalogue. A list served after a failed fetch is flagged
//! [`ReleaseList::stale`] so the UI can say "cached, last updated …" instead of
//! claiming it is live (FWCHK-7).
//!
//! Requests use a short timeout and a bounded retry with backoff (NFR-ERR-01).
//! Only transport failures and 5xx are retried — a 404 or a 403 rate-limit is
//! terminal, and re-sending it would just burn more of the unauthenticated
//! 60-req/hr GitHub quota (FWCHK-9, [`should_retry`]). A failure crosses the
//! command seam as a typed [`ReleaseFetchError`] rather than a formatted string,
//! so the wizard can say "rate-limited, wait" instead of blaming the user's
//! network for a 403 ([`classify_failure`]).
//!
//! Parsing is split out from the HTTP call ([`parse_releases`]) so it can be
//! unit-tested against a captured API response with no network. The parsed list
//! is sorted by **semver descending** ([`compare_releases_desc`]) rather than
//! left in GitHub's newest-created-first order, so a patch backported onto an
//! older branch can't outrank a newer minor (FWCHK-2).

use std::cmp::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

const RELEASES_URL: &str =
    "https://api.github.com/repos/ExpressLRS/ExpressLRS/releases?per_page=20";
/// GitHub requires a User-Agent on every request.
const USER_AGENT: &str = "OmniLink-Configurator";
/// The only domain [`RELEASES_URL`] — and any redirect off it — may resolve to.
const RELEASES_DOMAIN: &str = "github.com";
/// Time allowed to establish the connection, separate from the body read so an
/// unreachable host fails fast without capping how long a slow body may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest gap allowed **between** reads of the response body — an idle window,
/// not a deadline for the whole transfer. See [`read_body_capped`].
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Hard ceiling on the release-list body. Twenty releases of changelog is tens
/// of KB; this only exists because dropping the total deadline means an endless
/// body would otherwise stream forever.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(60 * 30);
const MAX_RETRIES: u32 = 2;

/// One firmware release as presented to the wizard. camelCase for the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareRelease {
    /// Git tag, e.g. `"3.5.3"`.
    pub tag: String,
    /// Human display name (falls back to the tag).
    pub name: String,
    /// Release notes / changelog (Markdown).
    pub changelog: String,
    /// ISO-8601 publish timestamp.
    pub published_at: String,
    /// True for pre-release/beta tags. Set when GitHub flags the release OR the
    /// tag itself carries a semver pre-release suffix (`3.6.0-RC1`), so a
    /// maintainer who forgets to tick the box still can't have an RC presented
    /// to a beginner as a normal release.
    pub prerelease: bool,
}

/// A release list plus its provenance, as handed to the wizard.
///
/// `stale` is the honesty marker for FWCHK-7: `false` means these releases came
/// from a successful fetch (fresh, or cached within [`CACHE_TTL`]); `true` means
/// the network fetch FAILED and this is the last list we managed to retrieve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseList {
    pub releases: Vec<FirmwareRelease>,
    /// True when GitHub was unreachable and this list came out of the cache.
    pub stale: bool,
    /// Unix epoch milliseconds of the fetch that produced `releases`, so the UI
    /// can render "last updated …". `None` only if the system clock is before
    /// the epoch.
    pub fetched_at: Option<u64>,
}

/// Why a release fetch failed, coarse enough to pick one line of UI copy.
///
/// The wizard used to render every failure as "Offline — couldn't reach
/// ExpressLRS GitHub", because the only thing that crossed the seam was a
/// formatted string the frontend threw away. A 403 is the most common real
/// failure (unauthenticated GitHub allows 60 requests/hour/IP) and it is the one
/// where that advice is worst: the network is fine, the remedy is to wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchFailureKind {
    /// GitHub answered, refusing on quota (403/429).
    RateLimited,
    /// No answer at all — connect failure, timeout, DNS.
    Offline,
    /// GitHub answered, but pointed us off [`RELEASES_DOMAIN`] (or down to
    /// plaintext) and [`crate::flash::pinned_redirect_policy`] refused to
    /// follow. NOT a flaky network: retrying can only end the same way, so it
    /// must be distinguishable from [`Self::Offline`] and from the
    /// [`Self::Unknown`] bucket of malformed bodies.
    RedirectRefused,
    /// Anything else: a 4xx/5xx we don't split out, a malformed body, an empty
    /// release list.
    Unknown,
}

/// A failed release fetch as handed to the frontend. camelCase, so the
/// `invoke` rejection is `{ kind, detail }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseFetchError {
    pub kind: FetchFailureKind,
    /// Raw, untranslated detail for the log — never the user-facing copy.
    pub detail: String,
}

impl ReleaseFetchError {
    fn new(kind: FetchFailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for ReleaseFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.kind, self.detail)
    }
}

/// Coarse classification of a failed attempt, from the inputs [`should_retry`]
/// uses plus the redirect verdict. Pure, so the seam is unit-tested without a
/// socket.
///
/// `redirect_refused` is `reqwest::Error::is_redirect()`, i.e. the
/// [`crate::flash::pinned_redirect_policy`] said no. Such a failure carries no
/// status and is neither a timeout nor a connect error, so without this input it
/// landed in [`FetchFailureKind::Unknown`] — indistinguishable from a malformed
/// body — and the mirrored firmware path (`firmwareRedirectRefused`) reported
/// the same event precisely.
fn classify_failure(
    status: Option<u16>,
    transport_transient: bool,
    redirect_refused: bool,
) -> FetchFailureKind {
    // Checked first: a policy refusal is a settled answer whatever else the
    // error happens to carry.
    if redirect_refused {
        return FetchFailureKind::RedirectRefused;
    }
    match status {
        // 403 is GitHub's historical rate-limit answer and 429 its modern one;
        // both mean "come back later", not "your network is down".
        Some(403) | Some(429) => FetchFailureKind::RateLimited,
        Some(_) => FetchFailureKind::Unknown,
        None if transport_transient => FetchFailureKind::Offline,
        None => FetchFailureKind::Unknown,
    }
}

/// Parse the GitHub `/releases` JSON array into our DTO list, **sorted by semver
/// descending**.
///
/// Tolerant of missing optional fields: a release with no name falls back to
/// its tag; a missing body becomes an empty changelog. Entries without a tag
/// are skipped (can't flash an untagged release).
///
/// The API returns newest-*created* first, which is not version order: a patch
/// backported onto an older branch is created last but must not rank above a
/// newer minor, and a fresh `3.6.0-RC1` must not sit at index 0 where the wizard
/// would label it "Latest" (FWCHK-2). Sorting here (rather than in the UI) keeps
/// one ordering for every consumer. Unparseable tags keep their API order at the
/// end of the list — the sort is stable and never drops a release.
pub fn parse_releases(body: &str) -> Result<Vec<FirmwareRelease>, String> {
    let value: Value = serde_json::from_str(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "expected a JSON array of releases".to_string())?;

    let mut releases: Vec<FirmwareRelease> = arr
        .iter()
        .filter_map(|r| {
            let tag = r.get("tag_name")?.as_str()?.to_string();
            let name = r
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(&tag)
                .to_string();
            let flagged = r
                .get("prerelease")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let prerelease = flagged || parse_version(&tag).is_some_and(|v| v.pre.is_some());
            Some(FirmwareRelease {
                changelog: r
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                published_at: r
                    .get("published_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                tag,
                name,
                prerelease,
            })
        })
        .collect();
    releases.sort_by(compare_releases_desc);
    Ok(releases)
}

// ---------------------------------------------------------------------------
// Semver ordering (FWCHK-2).
// ---------------------------------------------------------------------------

/// A tag parsed into its semver parts: `3.6.0-RC1` → core `[3, 6, 0]`, pre
/// `Some("RC1")`. A leading `v` is tolerated (`v3.5.3`), as are 1- and 2-part
/// cores (`3.5` → `[3, 5, 0]`), because ELRS has shipped both shapes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Version {
    core: [u64; 3],
    /// `None` for a stable release; `Some(identifiers)` for a pre-release.
    pre: Option<String>,
}

/// Parse a release tag, or `None` if it isn't version-shaped at all.
fn parse_version(tag: &str) -> Option<Version> {
    let trimmed = tag.trim();
    let body = trimmed
        .strip_prefix(['v', 'V'])
        .filter(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(trimmed);
    // Build metadata (`+sha`) never affects precedence — drop it first.
    let body = body.split('+').next().unwrap_or(body);
    let (core_str, pre) = match body.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_string())),
        _ => (body, None),
    };

    let mut core = [0u64; 3];
    let mut parts = core_str.split('.');
    for slot in core.iter_mut() {
        match parts.next() {
            Some(p) => *slot = p.parse::<u64>().ok()?,
            None => break,
        }
    }
    // A 4th numeric component (or trailing junk) means this isn't a tag we can
    // rank; leave it to the unparseable tail rather than guess.
    if parts.next().is_some() {
        return None;
    }
    Some(Version { core, pre })
}

/// Semver precedence, ascending. Core numbers first; a pre-release sorts BELOW
/// its own release (`3.6.0-RC1` < `3.6.0`); pre-release identifiers compare
/// dot-part-wise, numerically when both parts are numeric (so `RC2` > `RC1`,
/// `RC10` > `RC9`).
fn compare_versions(a: &Version, b: &Version) -> Ordering {
    a.core.cmp(&b.core).then_with(|| match (&a.pre, &b.pre) {
        (None, None) => Ordering::Equal,
        // A stable release outranks any pre-release of the same core.
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => compare_prerelease(x, y),
    })
}

/// Compare two pre-release identifier strings (`RC1` vs `RC2`, `alpha.2` vs
/// `beta.1`) per semver: dot-separated parts, numeric parts numerically, and a
/// shorter identifier list ranks lower when the shared parts are equal.
fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let mut ap = a.split('.');
    let mut bp = b.split('.');
    loop {
        match (ap.next(), bp.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(xn), Ok(yn)) => xn.cmp(&yn),
                    // Numeric identifiers always rank below alphanumeric ones.
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    // `RC1` vs `RC2` with no dot: split the trailing digits off
                    // so `RC10` beats `RC9` instead of comparing "1" < "9".
                    (Err(_), Err(_)) => compare_alnum(x, y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

/// Compare `RC9`-style identifiers: alphabetic stem first, then any trailing
/// digits numerically.
fn compare_alnum(a: &str, b: &str) -> Ordering {
    let split = |s: &str| {
        let idx = s
            .find(|c: char| c.is_ascii_digit())
            .filter(|_| s.ends_with(|c: char| c.is_ascii_digit()));
        match idx {
            Some(i) => (s[..i].to_string(), s[i..].parse::<u64>().ok()),
            None => (s.to_string(), None),
        }
    };
    let (astem, anum) = split(a);
    let (bstem, bnum) = split(b);
    astem.cmp(&bstem).then_with(|| match (anum, bnum) {
        (Some(x), Some(y)) => x.cmp(&y),
        _ => a.cmp(b),
    })
}

/// Sort comparator: highest version FIRST. Tags we cannot parse keep their API
/// order at the end of the list (the caller's sort is stable).
fn compare_releases_desc(a: &FirmwareRelease, b: &FirmwareRelease) -> Ordering {
    match (parse_version(&a.tag), parse_version(&b.tag)) {
        (Some(x), Some(y)) => compare_versions(&y, &x),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

// ---------------------------------------------------------------------------
// Cache + fetch.
// ---------------------------------------------------------------------------

struct CacheEntry {
    fetched_at: Instant,
    /// Wall-clock stamp of the same fetch, for the UI's "last updated …".
    fetched_at_ms: Option<u64>,
    releases: Vec<FirmwareRelease>,
}

impl CacheEntry {
    fn to_list(&self, stale: bool) -> ReleaseList {
        ReleaseList {
            releases: self.releases.clone(),
            stale,
            fetched_at: self.fetched_at_ms,
        }
    }
}

/// Process-wide release cache. NOT persisted: it only survives for the lifetime
/// of the app process, so a cold start with no network has nothing to serve.
static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// Milliseconds since the Unix epoch, or `None` if the clock is before it.
fn now_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Fetch releases, preferring a fresh cache entry. On a network failure a stale
/// cache entry (if any) is returned so the wizard still works offline — flagged
/// `stale: true` so the UI never labels it "live" (FWCHK-7); only a failure with
/// no cache at all surfaces an error.
pub fn fetch_releases() -> Result<ReleaseList, ReleaseFetchError> {
    fetch_releases_with(CACHE_TTL, fetch_from_network)
}

/// [`fetch_releases`] with the cache TTL and the network round-trip injected, so
/// the cache/stale policy is unit-testable without a socket (a `ttl` of zero
/// forces the network path, exercising the stale-fallback branch).
fn fetch_releases_with<F>(ttl: Duration, fetch: F) -> Result<ReleaseList, ReleaseFetchError>
where
    F: FnOnce() -> Result<Vec<FirmwareRelease>, ReleaseFetchError>,
{
    // Serve a fresh cache hit without touching the network.
    if let Some(entry) = CACHE.lock().unwrap().as_ref() {
        if entry.fetched_at.elapsed() < ttl {
            return Ok(entry.to_list(false));
        }
    }

    // An EMPTY successful parse is not a usable list, so it must not take the
    // Ok branch below: caching `releases: vec![]` as FRESH destroys the last
    // good list and then serves the emptiness for the whole TTL, during which
    // the wizard silently shows its bundled catalogue and never retries. GitHub
    // really does answer `200 []` (and `parse_releases` skips entries with no
    // `tag_name`), so this is reachable without anything being "wrong".
    let fetched = match fetch() {
        Ok(releases) if releases.is_empty() => Err(ReleaseFetchError::new(
            FetchFailureKind::Unknown,
            "GitHub returned no usable releases",
        )),
        other => other,
    };

    match fetched {
        Ok(releases) => {
            let entry = CacheEntry {
                fetched_at: Instant::now(),
                fetched_at_ms: now_ms(),
                releases,
            };
            let list = entry.to_list(false);
            *CACHE.lock().unwrap() = Some(entry);
            Ok(list)
        }
        Err(net_err) => {
            // Offline: fall back to any cached copy, even if stale (NFR-ERR-02).
            if let Some(entry) = CACHE.lock().unwrap().as_ref() {
                tracing::warn!(target: "flash", "github fetch failed ({net_err}); serving cached releases");
                return Ok(entry.to_list(true));
            }
            Err(net_err)
        }
    }
}

/// Whether a failed attempt is worth re-sending (FWCHK-9).
///
/// Unauthenticated GitHub allows 60 requests/hour/IP, so a retry is only ever
/// spent where it can plausibly help: a transport failure (connect/timeout) or a
/// 5xx. A 403 (rate-limited / forbidden), a 404, or any other 4xx is the server's
/// settled answer — retrying it 3× burns three requests to get the same status.
fn should_retry(status: Option<u16>, transport_transient: bool) -> bool {
    match status {
        Some(code) => (500..600).contains(&code),
        None => transport_transient,
    }
}

/// Read a response body one `Read::read` at a time, with a hard size cap.
///
/// `Response::text()` awaits the WHOLE body under a single [`READ_TIMEOUT`]
/// deadline, so a list that is merely slow (a few hundred KB of changelogs down
/// a tether) is cut off mid-body and reported as "Offline" — and every retry
/// dies at the same place. reqwest's blocking `Read` impl applies the client
/// timeout to each read instead, so reading incrementally turns the same
/// duration into an idle window: a transfer that keeps making progress is never
/// killed. [`MAX_BODY_BYTES`] is the price of dropping the total deadline.
fn read_body_capped(resp: &mut reqwest::blocking::Response) -> Result<String, ReleaseFetchError> {
    use std::io::Read;
    let mut body = Vec::new();
    // A body that dies part-way through is a transport failure, not a bad
    // answer — the connection went away.
    resp.take(MAX_BODY_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| {
            ReleaseFetchError::new(
                FetchFailureKind::Offline,
                format!("failed to read body: {e}"),
            )
        })?;
    if body.len() > MAX_BODY_BYTES {
        return Err(ReleaseFetchError::new(
            FetchFailureKind::Unknown,
            format!("release list exceeds {MAX_BODY_BYTES} bytes"),
        ));
    }
    String::from_utf8(body).map_err(|e| {
        ReleaseFetchError::new(
            FetchFailureKind::Unknown,
            format!("release list is not valid UTF-8: {e}"),
        )
    })
}

/// One network round-trip with bounded retry + linear backoff (NFR-ERR-01).
fn fetch_from_network() -> Result<Vec<FirmwareRelease>, ReleaseFetchError> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT)
        // The release list decides which firmware the wizard offers, so a
        // redirect off GitHub (or down to plaintext) is refused, not followed.
        .redirect(crate::flash::pinned_redirect_policy(RELEASES_DOMAIN))
        .build()
        .map_err(|e| {
            ReleaseFetchError::new(
                FetchFailureKind::Unknown,
                format!("failed to build HTTP client: {e}"),
            )
        })?;

    let mut last_err = String::new();
    let mut last_kind = FetchFailureKind::Unknown;
    for attempt in 0..=MAX_RETRIES {
        match client
            .get(RELEASES_URL)
            .send()
            .and_then(|r| r.error_for_status())
        {
            Ok(mut resp) => {
                let body = read_body_capped(&mut resp)?;
                return parse_releases(&body)
                    .map_err(|e| ReleaseFetchError::new(FetchFailureKind::Unknown, e));
            }
            Err(e) => {
                let status = e.status().map(|s| s.as_u16());
                let transport_transient = e.is_timeout() || e.is_connect();
                let retryable = should_retry(status, transport_transient);
                last_kind = classify_failure(status, transport_transient, e.is_redirect());
                last_err = e.to_string();
                if !retryable {
                    break;
                }
                if attempt < MAX_RETRIES {
                    std::thread::sleep(Duration::from_millis(300 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(ReleaseFetchError::new(
        last_kind,
        format!("GitHub release fetch failed: {last_err}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
        {
            "tag_name": "3.5.3",
            "name": "ExpressLRS 3.5.3",
            "body": "Fixes\n- thing",
            "published_at": "2025-01-02T00:00:00Z",
            "prerelease": false
        },
        {
            "tag_name": "3.6.0-RC1",
            "name": "",
            "published_at": "2025-02-01T00:00:00Z",
            "prerelease": true
        },
        {
            "name": "untagged draft"
        }
    ]"#;

    /// Build a release list from `(tag, prerelease)` pairs, as the API would.
    fn sample_json(entries: &[(&str, bool)]) -> String {
        let items: Vec<String> = entries
            .iter()
            .map(|(tag, pre)| {
                format!(r#"{{"tag_name":"{tag}","name":"{tag}","prerelease":{pre}}}"#)
            })
            .collect();
        format!("[{}]", items.join(","))
    }

    fn tags(releases: &[FirmwareRelease]) -> Vec<&str> {
        releases.iter().map(|r| r.tag.as_str()).collect()
    }

    #[test]
    fn parses_releases_with_fallbacks() {
        let releases = parse_releases(SAMPLE).unwrap();
        // The untagged entry is skipped.
        assert_eq!(releases.len(), 2);

        // Sorted semver-descending, so the RC (3.6.0-RC1 > 3.5.3) leads here —
        // NOT because the API listed it first. Empty name falls back to the tag;
        // missing body -> empty changelog.
        assert_eq!(releases[0].tag, "3.6.0-RC1");
        assert_eq!(releases[0].name, "3.6.0-RC1");
        assert_eq!(releases[0].changelog, "");
        assert!(releases[0].prerelease);

        assert_eq!(releases[1].tag, "3.5.3");
        assert_eq!(releases[1].name, "ExpressLRS 3.5.3");
        assert!(releases[1].changelog.contains("Fixes"));
        assert!(!releases[1].prerelease);
    }

    #[test]
    fn sorts_semver_descending_not_by_creation_order() {
        // FWCHK-2: GitHub returns newest-CREATED first. A patch backported onto
        // an older branch (3.4.4) is created LAST but must not outrank 3.5.3,
        // and the just-cut 3.3.5 must not lead the list just because it is new.
        let body = sample_json(&[
            ("3.3.5", false), // newest created — a backport off the 3.3 branch
            ("3.5.3", false),
            ("3.4.4", false), // another backport
            ("3.5.0", false),
            ("3.10.0", false), // double-digit minor: numeric, not lexical
        ]);
        let releases = parse_releases(&body).unwrap();
        assert_eq!(
            tags(&releases),
            vec!["3.10.0", "3.5.3", "3.5.0", "3.4.4", "3.3.5"]
        );
    }

    #[test]
    fn a_prerelease_ranks_below_its_own_release_and_above_the_previous_one() {
        let body = sample_json(&[
            ("3.6.0-RC2", true),
            ("3.6.0", false),
            ("3.5.3", false),
            ("3.6.0-RC1", true),
            ("3.6.0-RC10", true),
        ]);
        let releases = parse_releases(&body).unwrap();
        assert_eq!(
            tags(&releases),
            // 3.6.0 outranks all of its RCs; RC10 > RC2 > RC1 numerically; every
            // RC still outranks the older stable 3.5.3.
            vec!["3.6.0", "3.6.0-RC10", "3.6.0-RC2", "3.6.0-RC1", "3.5.3"]
        );
    }

    #[test]
    fn a_prerelease_suffix_marks_the_release_even_when_github_did_not() {
        // A maintainer who forgets to tick "pre-release" must not get an RC
        // presented to a beginner as a normal release.
        let releases = parse_releases(&sample_json(&[("3.6.0-RC1", false)])).unwrap();
        assert!(releases[0].prerelease);
        // …and a stable tag is never mislabelled.
        let releases = parse_releases(&sample_json(&[("3.6.0", false)])).unwrap();
        assert!(!releases[0].prerelease);
    }

    #[test]
    fn v_prefixed_and_short_tags_still_sort() {
        let body = sample_json(&[("3.4", false), ("v3.5.3", false), ("v3.6.0", false)]);
        assert_eq!(
            tags(&parse_releases(&body).unwrap()),
            vec!["v3.6.0", "v3.5.3", "3.4"]
        );
    }

    #[test]
    fn unparseable_tags_keep_api_order_at_the_end() {
        // Never drop a release we can't rank — park it after everything we can.
        let body = sample_json(&[("nightly", false), ("3.5.3", false), ("weird-tag", false)]);
        assert_eq!(
            tags(&parse_releases(&body).unwrap()),
            vec!["3.5.3", "nightly", "weird-tag"]
        );
    }

    #[test]
    fn rejects_non_array() {
        assert!(parse_releases(r#"{"message":"Not Found"}"#).is_err());
        assert!(parse_releases("not json").is_err());
    }

    #[test]
    fn only_transport_failures_and_5xx_are_retried() {
        // FWCHK-9: unauthenticated GitHub gives 60 req/hr/IP. A 403 rate-limit or
        // a 404 is settled — retrying spends 3 requests for the same answer.
        assert!(!should_retry(Some(403), false), "rate-limited: don't retry");
        assert!(!should_retry(Some(404), false), "not found: don't retry");
        assert!(!should_retry(Some(401), false));
        assert!(!should_retry(Some(422), false));
        assert!(!should_retry(Some(429), false), "still a 4xx answer");
        // A transport failure carries no status, and 5xx is worth one more shot.
        assert!(should_retry(Some(500), false));
        assert!(should_retry(Some(503), false));
        assert!(should_retry(None, true), "connect/timeout: retry");
        // Statusless but NOT a connect/timeout (e.g. a decode failure): terminal.
        assert!(!should_retry(None, false));
        // A success status never reaches the retry decision, but be explicit.
        assert!(!should_retry(Some(200), false));
    }

    /// Serialises the tests that mutate the process-wide [`static@CACHE`], so
    /// they can't observe each other's state under cargo's parallel harness.
    static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn sentinel_releases(tag: &str) -> Vec<FirmwareRelease> {
        vec![FirmwareRelease {
            tag: tag.to_string(),
            name: "cache sentinel".to_string(),
            changelog: String::new(),
            published_at: String::new(),
            prerelease: false,
        }]
    }

    #[test]
    fn a_cache_served_after_a_failed_fetch_is_flagged_stale() {
        // FWCHK-7: the offline fallback used to be indistinguishable from a live
        // fetch, so the UI badged a month-old list "Live from ExpressLRS GitHub".
        // A zero TTL forces the network path; the injected fetch then fails.
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *CACHE.lock().unwrap() = None;
        let cached = sentinel_releases("0.0.0-stale-sentinel");
        *CACHE.lock().unwrap() = Some(CacheEntry {
            fetched_at: Instant::now(),
            fetched_at_ms: Some(1_700_000_000_000),
            releases: cached.clone(),
        });

        let list = fetch_releases_with(Duration::ZERO, || {
            Err(ReleaseFetchError::new(FetchFailureKind::Offline, "offline"))
        })
        .expect("a populated cache still serves the wizard offline");
        assert_eq!(list.releases, cached);
        assert!(list.stale, "a cache served after a failed fetch is stale");
        assert_eq!(
            list.fetched_at,
            Some(1_700_000_000_000),
            "the UI needs the ORIGINAL fetch time to say 'last updated …'"
        );

        // A successful fetch replaces it and is NOT stale.
        let fresh = sentinel_releases("9.9.9-fresh-sentinel");
        let list = fetch_releases_with(Duration::ZERO, {
            let fresh = fresh.clone();
            move || Ok(fresh)
        })
        .expect("a successful fetch is served");
        assert_eq!(list.releases, fresh);
        assert!(!list.stale);
        assert!(list.fetched_at.is_some());

        // …and a failure with NO cache at all is still an error, not an empty list.
        *CACHE.lock().unwrap() = None;
        assert!(fetch_releases_with(Duration::ZERO, || {
            Err(ReleaseFetchError::new(FetchFailureKind::Offline, "offline"))
        })
        .is_err());
        *CACHE.lock().unwrap() = None;
    }

    #[test]
    fn populated_cache_is_served_by_fetch_releases() {
        // GENUINE GAP: only `parse_releases` was unit-tested; the cache-serving path
        // in `fetch_releases` had no coverage. Seed the process cache with a
        // distinctive (synthetic) entry and confirm `fetch_releases` returns exactly
        // it — proving a populated cache is served (FR-FLASH-01 / NFR-ERR-02) rather
        // than re-derived. This is the FRESH branch (within TTL, no network touched),
        // so it must NOT be flagged stale; the failed-fetch branch is covered by
        // `a_cache_served_after_a_failed_fetch_is_flagged_stale`. The online/
        // on-hardware cache acceptance stays deferred per docs/v1.6.4_HW_VALIDATION.md.
        // Reset the process-wide cache before AND after so this test neither inherits
        // nor leaks `static CACHE` state.
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *CACHE.lock().unwrap() = None;
        let sentinel = sentinel_releases("0.0.0-cache-sentinel");
        *CACHE.lock().unwrap() = Some(CacheEntry {
            fetched_at: Instant::now(),
            fetched_at_ms: Some(1_700_000_000_000),
            releases: sentinel.clone(),
        });
        let got = fetch_releases().expect("a populated cache is served by fetch_releases");
        assert_eq!(got.releases, sentinel);
        assert!(!got.stale, "a within-TTL cache hit is not stale");
        assert_eq!(got.fetched_at, Some(1_700_000_000_000));
        *CACHE.lock().unwrap() = None;
    }

    #[test]
    fn an_empty_fetch_never_replaces_a_good_cache_and_is_never_served_fresh() {
        // A `200 []` (or a page where every entry lacks `tag_name`, which
        // `parse_releases` silently skips) used to take the Ok branch: it
        // REPLACED the cache with an empty list and served it `stale: false`,
        // so the wizard fell back to its bundled catalogue and did not touch the
        // network again for the full 30-minute TTL — with the last good list
        // destroyed. Emptiness is a fetch failure now.
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *CACHE.lock().unwrap() = None;
        let good = sentinel_releases("3.5.3-good-sentinel");
        *CACHE.lock().unwrap() = Some(CacheEntry {
            fetched_at: Instant::now(),
            fetched_at_ms: Some(1_700_000_000_000),
            releases: good.clone(),
        });

        let list = fetch_releases_with(Duration::ZERO, || Ok(Vec::new()))
            .expect("the prior good list still serves the wizard");
        assert_eq!(list.releases, good, "the good list must survive");
        assert!(
            list.stale,
            "an empty answer is a failure, so this is a cache"
        );

        // The cache itself was not overwritten, so the NEXT call still has it.
        let list = fetch_releases_with(Duration::ZERO, || Ok(Vec::new())).unwrap();
        assert_eq!(list.releases, good);

        // With no cache at all, emptiness is an error — never an empty Ok list
        // the frontend would have to guess about.
        *CACHE.lock().unwrap() = None;
        let err = fetch_releases_with(Duration::ZERO, || Ok(Vec::new()))
            .expect_err("no cache + no releases is an error");
        assert_eq!(err.kind, FetchFailureKind::Unknown);
        assert!(CACHE.lock().unwrap().is_none(), "emptiness is never cached");
        *CACHE.lock().unwrap() = None;
    }

    #[test]
    fn a_github_rate_limit_is_not_reported_as_offline() {
        // The wizard renders one chip per failure reason. A 403 (60 req/hr/IP
        // unauthenticated) used to arrive as an opaque string and be drawn as
        // "Offline — couldn't reach ExpressLRS GitHub", telling the user to fix
        // a network that is working; the remedy is to wait.
        assert_eq!(
            classify_failure(Some(403), false, false),
            FetchFailureKind::RateLimited
        );
        assert_eq!(
            classify_failure(Some(429), false, false),
            FetchFailureKind::RateLimited
        );
        // A real transport failure IS offline.
        assert_eq!(
            classify_failure(None, true, false),
            FetchFailureKind::Offline
        );
        // Everything else stays coarse rather than guessing.
        assert_eq!(
            classify_failure(Some(404), false, false),
            FetchFailureKind::Unknown
        );
        assert_eq!(
            classify_failure(Some(500), false, false),
            FetchFailureKind::Unknown
        );
        assert_eq!(
            classify_failure(None, false, false),
            FetchFailureKind::Unknown
        );
    }

    #[test]
    fn a_refused_redirect_is_not_reported_as_a_flaky_network() {
        // FIX 9F: `pinned_redirect_policy` refusing to leave github.com arrives
        // with no status and neither `is_timeout` nor `is_connect`, so it used
        // to land in `Unknown` — the same bucket as a malformed body or an empty
        // release list — while the mirrored firmware path already reported it
        // precisely as `firmwareRedirectRefused`. Retrying cannot help, so it
        // must be distinguishable.
        assert_eq!(
            classify_failure(None, false, true),
            FetchFailureKind::RedirectRefused
        );
        // A policy refusal is a settled answer whatever else the error happens
        // to carry — a refusal is never "come back later", so the redirect
        // verdict wins over any status reqwest may attach to it.
        assert_eq!(
            classify_failure(Some(302), false, true),
            FetchFailureKind::RedirectRefused
        );
        assert_eq!(
            classify_failure(Some(403), false, true),
            FetchFailureKind::RedirectRefused
        );
        // It is also not retried: nothing about the next attempt would differ.
        assert!(!should_retry(None, false));
        // The frontend's `releaseFetchReason` only knows `rateLimited` and
        // `offline`, so this must serialise to something it degrades to
        // "unknown" on — NOT to "offline", which would restore the very "check
        // your network" copy the kind exists to avoid.
        assert_eq!(
            serde_json::to_string(&FetchFailureKind::RedirectRefused).unwrap(),
            r#""redirectRefused""#
        );
    }

    #[test]
    fn the_failure_kind_serialises_camel_case_for_the_frontend() {
        // The frontend switches on this discriminant, so the wire spelling is
        // part of the contract.
        let json = serde_json::to_string(&ReleaseFetchError::new(
            FetchFailureKind::RateLimited,
            "HTTP status client error (403 Forbidden)",
        ))
        .unwrap();
        assert!(json.contains(r#""kind":"rateLimited""#), "{json}");
        assert!(json.contains(r#""detail":"#), "{json}");
        assert!(
            serde_json::to_string(&FetchFailureKind::Offline).unwrap() == r#""offline""#,
            "offline must not become \"Offline\""
        );
    }

    #[test]
    fn the_releases_url_is_on_the_pinned_redirect_domain() {
        // The redirect policy is only as good as the domain it pins; if the API
        // endpoint ever moves, this catches the pin going stale.
        let url = reqwest::Url::parse(RELEASES_URL).unwrap();
        assert!(crate::flash::redirect_target_allowed(&url, RELEASES_DOMAIN));
    }
}
