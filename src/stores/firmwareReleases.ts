import { create } from "zustand";
import { findModel } from "@/lib/elrsTargets";
import {
  liveReleaseList,
  reconcileSelectedVersion,
  releaseChoices,
  type ReleaseState,
} from "@/lib/firmwareReleases";
import { fetchFirmwareReleases, releaseFetchReason } from "@/lib/tauri";
import { useWizardStore } from "@/stores/wizard";

// ---------------------------------------------------------------------------
// FR-FLASH-01 / FWCHK-2: the live ExpressLRS release list, plus the pre-release
// opt-in that decides how much of it the wizard offers.
//
// A store rather than `useState` inside StepFrequency, because the RECONCILE
// that keeps the wizard's selected tag inside the rendered list has to outlive
// that step — see `reconcileWizardVersion`.
// ---------------------------------------------------------------------------

interface FirmwareReleasesState {
  /** Lifecycle of the live fetch; `loading` until the first one resolves. */
  state: ReleaseState;
  /**
   * The user's explicit opt-in to beta/RC builds (FWCHK-2). Lives here rather
   * than in the step so flipping it reconciles the stored selection exactly the
   * way a landing release list does.
   */
  showPrereleases: boolean;
  /**
   * Fetch the release list. Idempotent: concurrent callers share one request,
   * and a list that has already landed is not re-fetched — navigating back to
   * the firmware step must not spend another of GitHub's 60 requests/hour/IP.
   */
  load: () => Promise<void>;
  setShowPrereleases: (value: boolean) => void;
}

/** The in-flight fetch, shared by concurrent `load()` callers. */
let inFlight: Promise<void> | null = null;

/**
 * Keep the wizard's selected firmware tag inside the list the grid is actually
 * rendering — whatever step happens to be mounted (FWCHK-2).
 *
 * The grid is filled from the bundled catalogue while the live fetch is in
 * flight, so a tag picked in that window can drop out of the list the moment the
 * live releases land: no tile selected, no changelog, yet the store still held
 * the stale tag and the step still let the user proceed.
 *
 * This used to run in a `useEffect` on StepFrequency — a component that
 * UNMOUNTS as soon as the user navigates. Pick a bundled tag while the fetch is
 * still running, click Next twice before it resolves, and the reconcile never
 * happened at all: the stale tag reached the flash request and 404'd on an
 * artifact that had aged out, which is the exact failure the reconcile was added
 * to prevent. It therefore runs where the release list LANDS.
 */
function reconcileWizardVersion(
  state: ReleaseState,
  showPrereleases: boolean
): void {
  const wizard = useWizardStore.getState();
  // Nothing selected → nothing to move. (`selectFirmware` also clears a local
  // `.bin` source, but the two are mutually exclusive already: a non-null
  // `firmwareVersion` means no local file is selected.)
  if (wizard.firmwareVersion === null) return;
  const tag = reconcileSelectedVersion(
    wizard.firmwareVersion,
    releaseChoices(
      liveReleaseList(state)?.releases ?? null,
      findModel(wizard.brandId, wizard.modelId)?.firmwareVersions ?? [],
      showPrereleases
    )
  );
  if (tag !== null && tag !== wizard.firmwareVersion) wizard.selectFirmware(tag);
}

export const useFirmwareReleasesStore = create<FirmwareReleasesState>()(
  (set, get) => ({
    state: { kind: "loading" },
    showPrereleases: false,

    load: () => {
      if (inFlight) return inFlight;
      if (get().state.kind === "ready") return Promise.resolve();
      const apply = (state: ReleaseState) => {
        inFlight = null;
        set({ state });
        reconcileWizardVersion(state, get().showPrereleases);
      };
      inFlight = fetchFirmwareReleases().then(
        (list) => apply({ kind: "ready", list }),
        // Keep the reason: a GitHub rate-limit must not be reported as "your
        // network is down", because waiting — not reconnecting — is the fix.
        (e: unknown) => apply({ kind: "error", reason: releaseFetchReason(e) })
      );
      return inFlight;
    },

    setShowPrereleases: (showPrereleases) => {
      set({ showPrereleases });
      // Switching the opt-in back off strands a selected RC exactly the way a
      // landing release list strands a bundled tag.
      reconcileWizardVersion(get().state, showPrereleases);
    },
  })
);
