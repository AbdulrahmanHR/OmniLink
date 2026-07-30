/**
 * Turning a fetched ExpressLRS release list into what the wizard's firmware grid
 * actually renders (FWCHK-2).
 *
 * Kept out of `StepFrequency.tsx` because the rules here are the whole point and
 * they are pure: which versions a beginner is offered, and which single one may
 * wear the "Latest" badge. The old component did neither — it mapped the list
 * straight to tags and badged `index === 0`, so the moment ExpressLRS cut a
 * `3.6.0-RC1` the wizard offered a release candidate, at the top, labelled
 * "Latest", with nothing marking it as a beta.
 *
 * The backend (`src-tauri/src/flash/github.rs`) hands us the list already sorted
 * **semver-descending**, so "first" here means highest version — not GitHub's
 * newest-*created*-first order, in which a patch backported onto an older branch
 * outranks a newer minor. This module trusts that order and never re-sorts, so
 * there is exactly one ordering across the app.
 */
import type {
  FirmwareRelease,
  FirmwareReleaseList,
  ReleaseFetchReason,
} from "@/lib/tauri";

/** Loading / fetch state for the live GitHub firmware release list. */
export type ReleaseState =
  | { kind: "loading" }
  | { kind: "ready"; list: FirmwareReleaseList }
  /** `reason` picks the fallback chip's copy — see {@link ReleaseFetchReason}. */
  | { kind: "error"; reason: ReleaseFetchReason };

/**
 * The live list to render, or `null` when the bundled catalogue is in use —
 * still loading, the fetch failed, or GitHub answered with nothing at all.
 *
 * One definition, shared by the grid and by the reconcile below, so "what the
 * user is looking at" and "what the stored selection is validated against" can
 * never diverge.
 */
export function liveReleaseList(
  state: ReleaseState
): FirmwareReleaseList | null {
  return state.kind === "ready" && state.list.releases.length > 0
    ? state.list
    : null;
}

/** One selectable firmware version, with the badge facts the grid renders. */
export interface VersionOption {
  tag: string;
  /** Pre-release/beta (`3.6.0-RC1`) — never eligible for the "Latest" badge. */
  prerelease: boolean;
}

/** Everything the firmware grid needs, derived from one release list. */
export interface ReleaseChoices {
  /** Versions to render, in display order. */
  versions: VersionOption[];
  /**
   * The single tag that wears the "Latest" badge, or `null` when nothing
   * qualifies (a list of nothing but release candidates).
   */
  latest: string | null;
  /**
   * True when the live list holds at least one pre-release, i.e. the opt-in
   * toggle is worth offering. False for a stable-only list (and for the bundled
   * catalogue), so the common case stays uncluttered.
   */
  hasPrereleases: boolean;
}

/**
 * Derive the firmware grid's contents.
 *
 * @param live      Live releases (semver-descending), or `null` when the fetch
 *                  failed/returned nothing and the bundled catalogue is in use.
 * @param fallback  The model's bundled version tags — curated, stable-only.
 * @param showPrereleases  The user's explicit opt-in to beta/RC builds.
 *
 * Pre-releases are hidden by default: this wizard is the beginner path, and an
 * RC cut yesterday is the newest release but the wrong answer for someone
 * flashing their first receiver. The one exception is a live list with **no**
 * stable release at all — hiding them there would leave nothing to pick, so they
 * are shown (still badged as pre-releases, and still with no "Latest").
 */
export function releaseChoices(
  live: FirmwareRelease[] | null,
  fallback: string[],
  showPrereleases: boolean
): ReleaseChoices {
  if (!live || live.length === 0) {
    return {
      versions: fallback.map((tag) => ({ tag, prerelease: false })),
      // The bundled catalogue is hand-ordered newest-first and stable-only.
      latest: fallback[0] ?? null,
      hasPrereleases: false,
    };
  }

  const stable = live.filter((r) => !r.prerelease);
  const shown = showPrereleases || stable.length === 0 ? live : stable;
  return {
    versions: shown.map((r) => ({ tag: r.tag, prerelease: r.prerelease })),
    // Highest STABLE version, by the backend's semver sort — never an index.
    latest: stable[0]?.tag ?? null,
    hasPrereleases: stable.length < live.length,
  };
}

/**
 * Keep a stored firmware tag inside the list the grid is actually rendering.
 *
 * The grid is populated from the bundled catalogue while the live fetch is still
 * in flight, so a tag picked in that window can simply vanish when the live
 * releases land: no tile ends up selected and the changelog panel disappears,
 * yet the store still holds the stale tag and the step still lets the user
 * proceed — into a flash that 404s on an artifact that has aged out. Switching
 * the pre-release opt-in back off with an RC selected strands it the same way.
 *
 * @returns the tag that should be selected — `selected` when it is still on
 * offer, otherwise the tag wearing "Latest" (falling back to the first entry
 * when the list is all release candidates). `null` means "leave the store
 * alone": either nothing is selected yet, or the list is empty and there is
 * nothing to move the selection to.
 */
export function reconcileSelectedVersion(
  selected: string | null,
  choices: ReleaseChoices
): string | null {
  if (selected === null) return null;
  if (choices.versions.some((v) => v.tag === selected)) return selected;
  return choices.latest ?? choices.versions[0]?.tag ?? null;
}

/**
 * The one version a path that picks FOR the user should pick (FWCHK-8).
 *
 * The AI-assisted wizard applies its suggestion straight to review, skipping the
 * firmware grid entirely — so it has no badge to read and used to hand the flash
 * request a frozen catalogue constant. This is that badge's rule, reused rather
 * than re-derived: the highest **stable** live release.
 *
 * `null` means "nothing live to pick" (fetch failed, empty list, or a list of
 * nothing but release candidates) and is the caller's cue to fall back to the
 * bundled catalogue — never to guess a pre-release on the user's behalf.
 */
export function latestStableRelease(
  live: FirmwareRelease[] | null
): string | null {
  return releaseChoices(live, [], false).latest;
}
