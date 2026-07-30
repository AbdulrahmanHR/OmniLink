//! Structured logging, daily log rotation, and crash capture (M10).
//!
//! Closes NFR-LOG-01/02/03:
//! * **NFR-LOG-01** — a real structured logging framework (`tracing`) replaces
//!   the scattered `eprintln!`s. [`init`] installs a global subscriber with an
//!   [`EnvFilter`] that defaults to `info` and is overridable via `RUST_LOG`.
//! * **NFR-LOG-02** — the subscriber writes to a **daily-rotating** file in the
//!   app's log directory (`tracing_appender::rolling` with `DAILY` rotation,
//!   **capped at 14 files** so old logs are pruned and disk use stays bounded),
//!   through a non-blocking writer so file I/O never stalls the caller.
//! * **NFR-LOG-03** — [`install_panic_hook`] captures every panic (thread,
//!   payload, location, backtrace) **synchronously**: it appends+flushes the
//!   record to a dedicated `omnilink-crash.log` and writes the same summary to
//!   stderr. Both writes happen inline on the panicking thread, so the record
//!   survives even a fatal panic that exits the process *before* the async file
//!   appender's background flush thread gets a chance to run — which the async
//!   rotating log cannot guarantee.
//!
//! Pure Rust, no C toolchain.

use std::backtrace::Backtrace;
use std::io::Write;
use std::panic::{self, PanicHookInfo};
use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;

/// Keeps the non-blocking appender's background flush thread alive for the whole
/// process lifetime.
///
/// **CRITICAL:** `tracing_appender::non_blocking` returns a [`WorkerGuard`] that
/// stops the flush thread when it drops — after which file logs are silently
/// discarded. Parking it in this `static` (set exactly once in [`init`]) makes
/// it live as long as the process, so steady-state file logging never silently
/// dies. (It is never dropped, so it also never flushes on shutdown — which is
/// exactly why the panic hook writes its crash record synchronously instead of
/// routing it through this async appender; see [`install_panic_hook`].)
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// The resolved log directory, recorded so the panic hook can write its
/// synchronous crash dump there. Set at the top of [`init`] — independent of
/// whether the async appender is built successfully — so a crash any time after
/// the directory is resolved can still find it.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Name of the synchronous crash-dump file, written by the panic hook. Kept
/// distinct from the rotating appender's `omnilink-app.*.log` prefix so the
/// `max_log_files` retention (which prunes files matching that prefix+suffix)
/// can never delete the durable crash record.
const CRASH_LOG_FILE: &str = "omnilink-crash.log";

/// Build the level filter: honour `RUST_LOG` when set, otherwise default to
/// `info` (NFR-LOG-01). Constructed per call because [`EnvFilter`] is not
/// cheaply cloneable and each layer needs its own.
fn env_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

/// Resolve the directory the rotating log file lives in, from the Tauri app
/// handle. Falls back to the OS temp dir if the platform log dir can't be
/// resolved, and best-effort-creates it, so init NEVER panics and we always get
/// *some* writable location.
fn resolve_log_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("omnilink").join("logs"));
    // Best-effort: if this fails the appender surfaces it on stderr, and the
    // stderr layer still works.
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Install the global tracing subscriber: a human-readable stderr layer (dev
/// visibility) plus a daily-rotating, non-blocking file layer in the app log
/// directory (NFR-LOG-01/02).
///
/// Must be called from Tauri `.setup(...)`, where the [`AppHandle`] — and thus
/// the resolved log directory — is available. Safe to call more than once: only
/// the first call installs the subscriber; later calls are a no-op (a global
/// subscriber can only be set once).
pub fn init(app: &AppHandle) {
    // The guard is set only after a successful install, so its presence means
    // we're already initialized — bail out before touching the global.
    if LOG_GUARD.get().is_some() {
        return;
    }

    let log_dir = resolve_log_dir(app);

    // Record the resolved dir up front — before (and independent of) building
    // the async appender — so the panic hook's synchronous crash dump can find
    // it even if the appender below fails to build.
    let _ = LOG_DIR.set(log_dir.clone());

    // Daily rotation satisfies NFR-LOG-02; `max_log_files(14)` prunes stale logs
    // so disk use stays bounded. The rotating files are named
    // `omnilink-app.<date>.log` — deliberately NOT the plain `omnilink` prefix,
    // so the retention (which deletes files matching prefix+suffix) never sees,
    // and never prunes, the crash dump `omnilink-crash.log` in the same dir.
    let file_appender = match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("omnilink-app")
        .filename_suffix("log")
        .max_log_files(14)
        .build(&log_dir)
    {
        Ok(appender) => appender,
        Err(e) => {
            // Couldn't build the rolling appender (e.g. an unwritable log dir).
            // Don't panic init: degrade to a stderr-only subscriber so logging
            // still works, just without the on-disk file.
            let stderr_only = fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(std::io::stderr)
                .with_filter(env_filter());
            let _ = tracing_subscriber::registry().with(stderr_only).try_init();
            let _ = writeln!(
                std::io::stderr(),
                "[logging] file logging disabled: could not build rolling appender in {}: {e}",
                log_dir.display()
            );
            return;
        }
    };

    // The non-blocking wrapper moves the actual file writes onto a background
    // thread whose lifetime is the returned `WorkerGuard` — which MUST outlive
    // the app (see `LOG_GUARD`).
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    // No ANSI colour codes in the file (they'd litter the on-disk log); keep
    // them off stderr too since it's frequently redirected/piped.
    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(file_writer)
        .with_filter(env_filter());

    let stderr_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(std::io::stderr)
        .with_filter(env_filter());

    // `try_init` (not `init`) so a double-install — e.g. a re-run under tests —
    // records the failure instead of panicking.
    let installed = tracing_subscriber::registry()
        .with(file_layer)
        .with(stderr_layer)
        .try_init()
        .is_ok();

    if installed {
        // Only park the guard (and keep the flush thread) if we actually own the
        // global subscriber; if `try_init` lost the race, the appender is unused
        // and the guard can drop harmlessly here.
        let _ = LOG_GUARD.set(guard);
        tracing::info!(
            target: "logging",
            log_dir = %log_dir.display(),
            "structured logging initialized"
        );
    }
}

/// Install a process-wide panic hook that captures the panicking thread name,
/// payload, location, and a full backtrace, and writes that record two ways —
/// both **synchronously, inline on the panicking thread** (NFR-LOG-03):
///
/// * appended + flushed to `omnilink-crash.log` in the resolved log dir (once
///   [`init`] has recorded that dir in `LOG_DIR`), and
/// * to stderr.
///
/// It deliberately does **not** log through `tracing`: the file appender is
/// non-blocking, so its background flush thread can be killed by a fatal panic
/// before it writes — a crash line routed through `tracing` could be lost from
/// the rotating log. The synchronous crash file + stderr are the authoritative
/// crash records; the rotating log is *not* claimed to hold panics.
///
/// Every write is failure-guarded, so the hook can never re-panic (a second
/// panic aborts the process). This does not change unwind behaviour: a custom
/// hook only *records*; whether the process unwinds or aborts is set by the
/// panic strategy, not the hook. Call early in `run()` (before the Tauri builder
/// does any work).
pub fn install_panic_hook() {
    panic::set_hook(Box::new(|info: &PanicHookInfo<'_>| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = panic_payload(info);
        // `force_capture` captures regardless of `RUST_BACKTRACE`.
        let backtrace = Backtrace::force_capture();

        let record = format!(
            "[panic] thread \"{thread_name}\" panicked at {location}: {payload}\n{backtrace}"
        );

        // (1) Durable, SYNCHRONOUS crash record. Appending + flushing inline (not
        // via the non-blocking `tracing` appender, whose worker thread may be
        // killed on a fatal exit before it writes) means the record survives even
        // a panic that immediately exits the process. `LOG_DIR` is set at the top
        // of `init`, independent of appender success, so it is available here.
        // Every step is guarded so a write error can't re-panic the hook.
        if let Some(dir) = LOG_DIR.get() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(CRASH_LOG_FILE))
            {
                let _ = writeln!(file, "{record}");
                let _ = file.flush();
            }
        }

        // (2) stderr copy — also synchronous, and the only record available if a
        // panic fires before `init` records `LOG_DIR`. A guarded `writeln!`
        // (never `eprintln!`, which panics on a broken-pipe write and would turn
        // this hook into a double panic → abort) matches the default hook's
        // tolerance of a failed stderr write.
        let _ = writeln!(std::io::stderr(), "{record}");
    }));
}

/// Extract a human-readable string from a panic payload (which is `&str` or
/// `String` for the common `panic!`/`.unwrap()`/`.expect()` paths).
fn panic_payload(info: &PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}
