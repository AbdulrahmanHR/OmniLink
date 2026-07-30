/**
 * D17 pack-update seam for the trusted knowledge registry (M49).
 *
 * D17 resolves the refresh cadence as: BUNDLE a fresh pack per release (the
 * default — every source is shipped current and usable offline) PLUS support an
 * ON-DEMAND pack update whose fetched result is cached and stays usable offline.
 *
 * This is the clean seam for that on-demand update. There is NO real server in
 * M49 (adding an outbound path is out of scope), so `updatePack` currently
 * resolves against the bundled/cached content and reports it up to date. The
 * place a real network fetch will live is fenced behind {@link isTauri} — the
 * app runtime — and is deliberately deferred; the browser/test path never
 * attempts a fetch. Whatever the outcome, the cached (bundled) source is always
 * returned so offline use is never broken by an update attempt.
 */

import type { KnowledgeSource } from "./types";
import { loadAllowedSources } from "./allowlist";

/**
 * True inside the Tauri desktop runtime (vs a browser/test). Mirrors the
 * inline check used elsewhere (`components/logs/ImportDropzone.tsx`,
 * `components/map/map-style.ts`) — the app has no shared helper, so the D17
 * network fence uses the same detection.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Outcome of an on-demand pack update attempt. */
export type PackUpdateStatus =
  /** The bundled/cached content is already the freshest available. */
  | "up-to-date"
  /** A newer pack was fetched and cached (reserved; real fetch is deferred). */
  | "updated"
  /** No such allowlisted source — nothing to update. */
  | "unavailable";

export interface PackUpdateResult {
  id: string;
  status: PackUpdateStatus;
  /**
   * The source after the attempt. For a known source this is the cached
   * (bundled) {@link KnowledgeSource}, still usable offline; `null` only when
   * the id is not an allowlisted source.
   */
  source: KnowledgeSource | null;
}

/**
 * Attempt an on-demand update of one source (D17).
 *
 * Resolves the source from the composed allowed set. When the id is unknown the
 * result is `unavailable`. Otherwise the bundled-fresh content is returned as
 * `up-to-date`: with no real server in M49 the cached pack IS the freshest, and
 * it remains offline-usable. The real network refresh slots in behind the
 * {@link isTauri} fence below without changing this contract.
 */
export async function updatePack(id: string): Promise<PackUpdateResult> {
  const source = loadAllowedSources().find((s) => s.metadata.id === id);
  if (source === undefined) {
    return { id, status: "unavailable", source: null };
  }

  if (isTauri()) {
    // DEFERRED (M49 adds no outbound path): a real on-demand fetch of the
    // upstream pack + re-cache would run here, guarded to the desktop runtime.
    // Until then we fall through to the bundled-fresh result so the cached
    // source stays usable offline regardless.
  }

  return { id, status: "up-to-date", source };
}
