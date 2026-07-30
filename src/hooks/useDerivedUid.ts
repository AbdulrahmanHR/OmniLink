import { useEffect, useState } from "react";
import { deriveUid } from "@/lib/tauri";

/** Format 6 UID bytes as the canonical "AB,CD,EF,01,23,45" display string. */
export function formatUid(bytes: number[]): string {
  return bytes
    .map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0"))
    .join(",");
}

/**
 * Resolve the *real* ExpressLRS binding UID for a phrase (debounced).
 *
 * Calls the Rust `derive_uid` command (MD5 of the phrase) so the preview equals
 * exactly what gets flashed (FR-FLASH-03), replacing the old cosmetic FNV hash.
 * Returns the formatted UID string, or `null` while empty/loading/disabled (the
 * caller renders a placeholder). When `enabled` is false (e.g. traditional
 * binding) no derivation happens.
 */
export function useDerivedUid(phrase: string, enabled = true): string | null {
  // Keyed by the phrase the result was derived for, so a stale result is never
  // shown after the phrase changes (the value is derived, not set eagerly).
  const [resolved, setResolved] = useState<{
    phrase: string;
    uid: string | null;
  } | null>(null);

  const trimmed = phrase.trim();

  useEffect(() => {
    if (!enabled || !trimmed) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      deriveUid(trimmed)
        .then((bytes) => {
          if (!cancelled) setResolved({ phrase: trimmed, uid: formatUid(bytes) });
        })
        .catch(() => {
          // Backend unavailable (e.g. running outside Tauri) — show nothing
          // rather than a stale/fake value.
          if (!cancelled) setResolved({ phrase: trimmed, uid: null });
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed, enabled]);

  if (!enabled || !trimmed) return null;
  return resolved && resolved.phrase === trimmed ? resolved.uid : null;
}
