//! Cancellation state for one flash run (FLASH-4).
//!
//! A flash can be abandoned safely right up to the moment the device's flash
//! memory starts being rewritten — and **not one instant later**: killing
//! esptool (or dropping an OTA POST) mid erase/write leaves a half-written
//! image, which is exactly how a radio gets bricked. So cancellation has three
//! states, not two:
//!
//! ```text
//!   Running ──request()─────▶ Cancelling   cancel accepted; the worker aborts
//!      │                                   at its next step boundary
//!      └──enter_write()─────▶ Writing      point of no return; every later
//!                                          cancel is REFUSED
//! ```
//!
//! Both transitions are compare-exchanges out of `Running` on a single atomic
//! word, so **exactly one of them can win**. That is the whole reason this type
//! exists instead of the plain `Arc<AtomicBool>` it replaces: with a bool, "may
//! I cancel?" and "may I start writing?" are two independent load/store pairs
//! that interleave, so a cancel accepted microseconds before the write begins
//! still reaches the cancel-watcher in [`crate::platformio::run_streaming`] and
//! kills esptool mid-erase. With one CAS'd state word the loser of that race is
//! told it lost — the canceller gets `false` from [`FlashCancel::request`] (the
//! UI is told the flash is past the point of no return), or the writer gets
//! `false` from [`FlashCancel::enter_write`] and aborts *before* touching the
//! device.
//!
//! Everything below the engine (the `run_streaming` watcher, the compile path)
//! keeps observing a single "should I stop?" predicate, [`FlashCancel::is_cancelled`],
//! so the policy about *when* a cancel may be raised lives in exactly one place.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::flash::{ErrorCategory, FlashError};

/// The flash is running and may still be cancelled.
const RUNNING: u8 = 0;
/// A cancel was accepted; the pipeline aborts at its next step boundary.
const CANCELLING: u8 = 1;
/// The point of no return: the device's flash is being rewritten.
const WRITING: u8 = 2;

/// Shared cancellation state for one flash run. Held by the worker (through the
/// engine + backends) and by `commands::flash::FlashManager`.
#[derive(Debug)]
pub struct FlashCancel {
    state: AtomicU8,
}

impl Default for FlashCancel {
    fn default() -> Self {
        Self::new()
    }
}

impl FlashCancel {
    /// A fresh, cancellable run.
    pub fn new() -> Self {
        Self {
            state: AtomicU8::new(RUNNING),
        }
    }

    /// Ask to cancel.
    ///
    /// * `true` — accepted (or already pending): the worker aborts at its next
    ///   step boundary and the command layer emits `flash://cancelled`.
    /// * `false` — **refused**: the write already began, so stopping now would
    ///   leave a half-written image. The flash deliberately runs to completion.
    pub fn request(&self) -> bool {
        match self
            .state
            .compare_exchange(RUNNING, CANCELLING, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => true,
            // Idempotent: a second cancel while one is pending is still a cancel.
            Err(CANCELLING) => true,
            // WRITING — past the point of no return.
            Err(_) => false,
        }
    }

    /// Enter the point of no return, immediately before the device's flash is
    /// modified (esptool spawn / OTA POST).
    ///
    /// * `true` — go ahead; every later [`request`](Self::request) is refused.
    /// * `false` — a cancel was accepted first. The caller MUST abort **without
    ///   touching the device** and return [`cancelled_error`].
    ///
    /// Idempotent for the remainder of the write.
    pub fn enter_write(&self) -> bool {
        match self
            .state
            .compare_exchange(RUNNING, WRITING, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => true,
            // Already writing (e.g. Betaflight's second uploader call).
            Err(WRITING) => true,
            // CANCELLING — the canceller won the race.
            Err(_) => false,
        }
    }

    /// Whether an accepted cancel is pending. The single "should I stop?"
    /// predicate for every layer below the engine.
    pub fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::SeqCst) == CANCELLING
    }

    /// Whether the run has passed the point of no return (cancel refused).
    pub fn is_writing(&self) -> bool {
        self.state.load(Ordering::SeqCst) == WRITING
    }
}

/// The ONE representation of "the user cancelled this flash".
///
/// `commands::flash::run_worker` turns a failed run into `flash://cancelled`
/// (instead of `flash://error`) by asking [`FlashCancel::is_cancelled`], so this
/// error is what every abort path must return — inventing another shape would
/// surface a cancel as a spurious flashing failure.
pub fn cancelled_error() -> FlashError {
    FlashError::new(
        ErrorCategory::Unknown,
        "cancelled",
        "flash cancelled by user",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_fresh_run_is_cancellable() {
        let cancel = FlashCancel::new();
        assert!(!cancel.is_cancelled());
        assert!(!cancel.is_writing());
        assert!(cancel.request());
        assert!(cancel.is_cancelled());
        // Idempotent — a second click is still an accepted cancel.
        assert!(cancel.request());
    }

    #[test]
    fn cancel_is_refused_once_the_write_has_begun() {
        let cancel = FlashCancel::new();
        assert!(cancel.enter_write());
        assert!(cancel.is_writing());
        // Refused: killing esptool here is what bricks hardware.
        assert!(!cancel.request());
        assert!(!cancel.is_cancelled(), "a refused cancel must not latch");
        // Still writing, and re-entering the write stage stays fine.
        assert!(cancel.enter_write());
    }

    #[test]
    fn a_pending_cancel_blocks_the_write_from_starting() {
        let cancel = FlashCancel::new();
        assert!(cancel.request());
        // The uploader is told to abort BEFORE the device is touched.
        assert!(!cancel.enter_write());
        assert!(cancel.is_cancelled());
        assert!(!cancel.is_writing());
    }

    #[test]
    fn exactly_one_of_cancel_and_write_wins_under_contention() {
        // The reason this is a CAS'd state word and not two booleans: whatever
        // the interleaving, we never end up "cancelling AND writing" — i.e. the
        // watcher can never kill a child the uploader believes it may run.
        for _ in 0..200 {
            let cancel = Arc::new(FlashCancel::new());
            let writer = {
                let cancel = cancel.clone();
                std::thread::spawn(move || cancel.enter_write())
            };
            let canceller = {
                let cancel = cancel.clone();
                std::thread::spawn(move || cancel.request())
            };
            let wrote = writer.join().unwrap();
            let cancelled = canceller.join().unwrap();
            assert!(
                wrote != cancelled,
                "exactly one of enter_write/request must win"
            );
            assert_eq!(cancel.is_writing(), wrote);
            assert_eq!(cancel.is_cancelled(), cancelled);
        }
    }

    #[test]
    fn the_cancelled_error_is_the_shared_representation() {
        let err = cancelled_error();
        assert_eq!(err.summary_key, "cancelled");
        assert_eq!(err.category, ErrorCategory::Unknown);
    }
}
