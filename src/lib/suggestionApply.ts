/**
 * Apply a reviewed AI suggestion through the app's SINGLE config-apply path
 * (M54). This deliberately does NOT introduce a new apply mechanism: it
 * materializes the reviewed `after` settings as a candidate profile via the
 * existing `importProfile` store action and then makes it active via the
 * existing `applyProfile` store action — exactly the "external candidate →
 * review → apply" flow the community-preset import (M46) and `.elrsp` import
 * (M17) already use. There is no AI-only write and no second differ.
 *
 * Pure aside from `Date.now()` (the profile timestamp), so the composition is
 * unit-testable against the real Zustand store without React.
 */

import { ELRSP_SCHEMA_VERSION, type ElrspDocument } from "@/lib/elrsp";
import type { ProfileSettings } from "@/lib/profileSettings";

/** The two EXISTING profiles-store actions the apply flow routes through. */
export interface SuggestionApplyActions {
  /** Existing store action — stages a candidate profile from a document. */
  importProfile: (doc: ElrspDocument) => string;
  /** Existing store action — the single write that sets `activeSettings`. */
  applyProfile: (id: string) => void;
}

/**
 * Persist the reviewed `after` settings as a named candidate profile and apply
 * it as the active config. Returns the new profile id. Routes through
 * `importProfile` → `applyProfile` ONLY — no new apply path.
 */
export function applySuggestedProfile(
  after: ProfileSettings,
  name: string,
  actions: SuggestionApplyActions
): string {
  const doc: ElrspDocument = {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name,
    settings: { ...after },
    updatedAt: Date.now(),
  };
  const id = actions.importProfile(doc);
  actions.applyProfile(id);
  return id;
}
