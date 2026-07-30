import type { TFunction } from "i18next";
import type { ConfigProfile } from "./mockProfiles";

/**
 * Resolve a profile's display name. Built-in presets carry an i18n `nameKey`;
 * user-created profiles carry a literal `name`.
 */
export function profileName(profile: ConfigProfile, t: TFunction): string {
  if (profile.nameKey) return t(profile.nameKey);
  return profile.name ?? t("profiles.untitled");
}

/** Resolve a profile's description (i18n key for presets, literal otherwise). */
export function profileDescription(
  profile: ConfigProfile,
  t: TFunction
): string {
  if (profile.descriptionKey) return t(profile.descriptionKey);
  return profile.description ?? "";
}
