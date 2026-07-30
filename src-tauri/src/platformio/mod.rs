//! External-tool subprocess management + streaming command runner (FR-FLASH-06).
//!
//! Two responsibilities:
//!
//! * [`run_streaming`] — spawn an external process, stream its stdout/stderr
//!   line-by-line into a [`crate::flash::engine::FlashSink`] in real time, and
//!   map progress onto a `[start, end]` percentage band. Used by the
//!   esptool write + read-back-verify passes of the serial uploader.
//! * [`program_exists`] / [`resolve_program`] — the pre-flight probe that
//!   answers "is the flashing tool installed, and under which name?" before the
//!   engine commits to a flash (FLASH-12).
//!
//! The compile-from-source path this module was originally written for is gone:
//! it targeted a source checkout nothing ever created, and its `build_only`
//! request field was never set by any caller (FLASH-13).

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::flash::cancel::{cancelled_error, FlashCancel};
use crate::flash::engine::FlashSink;
use crate::flash::{ErrorCategory, FlashError, FlashStage};

/// How often the cancel watcher polls the cancel flag before killing the child.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Run `program args...`, streaming output to `sink` as it arrives.
///
/// stdout/stderr lines are forwarded to [`FlashSink::log`]; the progress bar is
/// advanced linearly from `start_pct` toward `end_pct` as lines arrive (the
/// external tools don't emit a parseable percentage, so this is a best-effort
/// monotonic creep that never reaches `end_pct` until the process exits 0).
///
/// `cancel` lets the worker abort: when an accepted cancel is pending we kill
/// the child and return a wiring-categorised error. This runner deliberately
/// does NOT decide *whether* a cancel is allowed — a device-destroying stage
/// takes the point of no return via [`FlashCancel::enter_write`] at its call
/// site (see `engine::RealBackend::upload_uart`), after which no cancel can be
/// accepted and this watcher can never fire.
pub fn run_streaming(
    program: &str,
    args: &[String],
    stage: FlashStage,
    start_pct: f32,
    end_pct: f32,
    sink: &dyn FlashSink,
    cancel: &Arc<FlashCancel>,
) -> Result<(), FlashError> {
    // Announce the stage BEFORE the child exists, so the UI never lags the
    // process it is describing (and a spawn failure is reported against the
    // stage the user was told about).
    sink.progress(stage, start_pct);

    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error(program, &e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Drain stderr on a side thread so a chatty stderr can't deadlock against a
    // full stdout pipe (and vice-versa).
    let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_handle = stderr.map(|err| {
        let collected = stderr_lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                collected.lock().unwrap().push(line);
            }
        })
    });

    // Hand the child to a watcher thread that kills it as soon as the cancel
    // flag is set. Checking the flag only between stdout lines (the old
    // behaviour) never fires for a silent/stderr-only/hung process, so cancel
    // would block `cancel_and_join` indefinitely. The watcher polls
    // independently and calls `.kill()`, which closes the pipes and unblocks the
    // readers below. We hold the child behind a `Mutex` so only the brief
    // `kill()` / final `wait()` need the lock.
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    let watcher = {
        let child = child.clone();
        let cancel = cancel.clone();
        let finished = finished.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if cancel.is_cancelled() {
                    let _ = child.lock().unwrap().kill();
                    return;
                }
                std::thread::sleep(CANCEL_POLL_INTERVAL);
            }
        })
    };

    if let Some(out) = stdout {
        let mut pct = start_pct;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if cancel.is_cancelled() {
                break;
            }
            sink.log(&line, false);
            // Creep ~halfway to end on each line; asymptotic, never overshoots.
            pct += (end_pct - pct) * 0.15;
            sink.progress(stage, pct);
        }
    }

    if let Some(h) = stderr_handle {
        let _ = h.join();
    }
    // Stop the watcher (a no-op if it already killed the child) and join it.
    finished.store(true, Ordering::SeqCst);
    let _ = watcher.join();

    // Surface stderr to the log panel verbatim (FR-FLASH-08 raw log).
    let errs = stderr_lines.lock().unwrap();
    for line in errs.iter() {
        sink.log(line, true);
    }

    let status = child
        .lock()
        .unwrap()
        .wait()
        .map_err(|e| FlashError::new(ErrorCategory::Unknown, "waitFailed", e.to_string()))?;

    // A cancel kills the child, which exits non-zero; report it as a cancel
    // rather than a tool failure so the worker emits `flash://cancelled`.
    if cancel.is_cancelled() {
        return Err(cancelled_error());
    }
    if !status.success() {
        return Err(categorize_tool_failure(program, &errs));
    }
    sink.progress(stage, end_pct);
    Ok(())
}

/// Whether `program` can be spawned at all (FLASH-12).
///
/// The probe runs `program --version` with all three stdio handles on
/// `/dev/null` and throws the result away: only the *spawn* outcome matters, so
/// a tool that rejects the argument (or exits non-zero) still counts as
/// present. `NotFound` — the one error kind [`spawn_error`] classifies as "not
/// installed" — is the only outcome treated as missing; any other spawn error
/// (a permission problem, say) is a different failure that must surface with
/// its own message later rather than being reported as "not installed".
pub fn program_exists(program: &str) -> bool {
    match Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// First spawnable name among `candidates`, or `None` if none resolve.
///
/// Upstream ships the ESP flasher under more than one name (`esptool` on newer
/// installs, `esptool.py` on the classic pip/`pip install esptool` layout), so
/// the caller passes both and uses whichever answers (FLASH-12).
pub fn resolve_program(candidates: &[&'static str]) -> Option<&'static str> {
    candidates.iter().copied().find(|p| program_exists(p))
}

fn spawn_error(program: &str, e: &std::io::Error) -> FlashError {
    if e.kind() == std::io::ErrorKind::NotFound {
        FlashError::new(
            ErrorCategory::Driver,
            "toolNotFound",
            format!("required tool `{program}` was not found on PATH"),
        )
    } else {
        FlashError::new(
            ErrorCategory::Unknown,
            "spawnFailed",
            format!("failed to start `{program}`: {e}"),
        )
    }
}

/// Map a non-zero tool exit onto a user-facing category using its stderr.
pub fn categorize_tool_failure(program: &str, stderr: &[String]) -> FlashError {
    let joined = stderr.join("\n").to_lowercase();
    let category =
        if program == "pio" || joined.contains("compilation") || joined.contains("error:") {
            ErrorCategory::CompilationError
        } else if joined.contains("permission") || joined.contains("access is denied") {
            ErrorCategory::Driver
        } else if joined.contains("no serial data")
            || joined.contains("failed to connect")
            || joined.contains("timed out")
            || joined.contains("could not open")
        {
            ErrorCategory::Wiring
        } else {
            ErrorCategory::Unknown
        };
    FlashError::new(
        category,
        "toolFailed",
        if stderr.is_empty() {
            format!("`{program}` exited with a non-zero status")
        } else {
            stderr.join("\n")
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Sink that discards everything — for subprocess-control tests.
    struct NullSink;
    impl FlashSink for NullSink {
        fn progress(&self, _: FlashStage, _: f32) {}
        fn log(&self, _: &str, _: bool) {}
    }

    #[test]
    #[cfg(unix)]
    fn cancel_kills_silent_child_promptly() {
        // A silent, long-running child emits no stdout lines, so the old
        // between-lines cancel check never fired. The watcher must kill it.
        // (The run has NOT taken the point of no return — `enter_write` is the
        // uploader's call, not this runner's — so the cancel is accepted.)
        let cancel = Arc::new(FlashCancel::new());
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            assert!(flag.request(), "cancel must be accepted for this run");
        });

        let started = Instant::now();
        let err = run_streaming(
            "sleep",
            &["30".to_string()],
            FlashStage::Write,
            0.0,
            100.0,
            &NullSink,
            &cancel,
        )
        .unwrap_err();

        assert_eq!(err.summary_key, "cancelled");
        // Killed promptly, not after the full 30s sleep.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel should kill the child promptly"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_cancel_after_the_write_began_never_kills_the_child() {
        // FLASH-4 acceptance: once the uploader has taken the point of no return
        // (`enter_write`), a cancel is REFUSED — the watcher must not kill the
        // child, because a half-written flash is a bricked device. The child runs
        // to completion and the call succeeds.
        let cancel = Arc::new(FlashCancel::new());
        assert!(cancel.enter_write(), "the write must be allowed to start");

        let flag = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.request()
        });

        let started = Instant::now();
        run_streaming(
            "sleep",
            &["1".to_string()],
            FlashStage::Write,
            0.0,
            100.0,
            &NullSink,
            &cancel,
        )
        .expect("a refused cancel must leave the write running to completion");

        assert!(!canceller.join().unwrap(), "the cancel must be refused");
        // Not killed at ~100ms: the child ran its full second.
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "the child must not be killed mid-write"
        );
        assert!(!cancel.is_cancelled());
        assert!(cancel.is_writing());
    }

    #[test]
    fn categorizes_compilation_error() {
        let err = categorize_tool_failure("pio", &["error: undefined reference".into()]);
        assert_eq!(err.category, ErrorCategory::CompilationError);
    }

    #[test]
    fn categorizes_wiring_from_esptool_stderr() {
        let err = categorize_tool_failure(
            "esptool",
            &["A fatal error occurred: Failed to connect to ESP32".into()],
        );
        assert_eq!(err.category, ErrorCategory::Wiring);
    }

    #[test]
    fn categorizes_permission_as_driver() {
        let err = categorize_tool_failure(
            "esptool",
            &["could not open port: Permission denied".into()],
        );
        // "permission" is checked before the "could not open" wiring hint.
        assert_eq!(err.category, ErrorCategory::Driver);
    }

    #[test]
    fn spawn_error_missing_tool_is_driver() {
        let e = std::io::Error::new(std::io::ErrorKind::NotFound, "nope");
        assert_eq!(spawn_error("esptool", &e).category, ErrorCategory::Driver);
    }

    #[test]
    fn program_exists_detects_a_missing_tool() {
        // FLASH-12: the pre-flight probe. A name that cannot exist on PATH must
        // report missing…
        assert!(!program_exists("omnilink-definitely-not-a-real-tool"));
        // …and a program that certainly does must report present, even though
        // it does not necessarily understand `--version` (only the SPAWN
        // outcome is inspected).
        #[cfg(unix)]
        assert!(program_exists("sh"));
        #[cfg(windows)]
        assert!(program_exists("cmd"));
    }

    #[test]
    fn resolve_program_picks_the_first_name_that_resolves() {
        // The real call site passes `["esptool", "esptool.py"]`: whichever of the
        // upstream names is installed wins, in order.
        #[cfg(unix)]
        let real = "sh";
        #[cfg(windows)]
        let real = "cmd";

        assert_eq!(
            resolve_program(&["omnilink-definitely-not-a-real-tool", real]),
            Some(real),
            "a later candidate must be used when the first is missing"
        );
        assert_eq!(
            resolve_program(&["omnilink-definitely-not-a-real-tool"]),
            None,
            "no candidate resolving must be reported as missing, not guessed"
        );
    }
}
