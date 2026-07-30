import { create } from "zustand";
import { persist } from "zustand/middleware";
import i18n from "@/lib/i18n";

/**
 * Persisted UI-language selection (M27, NFR-I18N).
 *
 * OmniLink ships a full second locale (Spanish) alongside English; this store
 * remembers the operator's chosen display language and drives the live
 * `i18next` instance so every `t()` call — and the component-level `Intl` date /
 * number formatting that keys off `i18n.language` — re-renders in that language.
 * The choice is persisted to localStorage (key `omnilink-language`) following
 * the same zustand `persist` convention as the theme / retention stores.
 *
 * Note on init: the *startup* language is resolved by `@/lib/i18n` reading this
 * same persisted key directly (so it can set `lng` before React mounts without
 * a store→i18n→store import cycle). This store owns runtime switches via
 * {@link LanguageState.setLanguage}; the two agree because they read/write one
 * localStorage key.
 */

/**
 * The set of shippable locales. `code` is the BCP-47 tag used both as the
 * `i18next` resource key (registered in `@/lib/i18n`) and the persisted value;
 * `label` is the language's own endonym, shown identically in every UI language
 * (the conventional way to render a language picker). Add a locale here AND
 * register its `translation.json` resource in `@/lib/i18n` to expand the set —
 * the key-parity gate (`tests/unit/translationStrings.test.ts`) then covers it
 * automatically.
 */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
] as const;

/** A supported UI-language code (`"en"` | `"es"`). */
export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/** localStorage key for the persisted language — mirrored by `@/lib/i18n`. */
export const LANGUAGE_STORAGE_KEY = "omnilink-language";

interface LanguageState {
  /** The active UI-language code. Defaults to English. */
  language: LanguageCode;
  /** Switch the UI language: applies it to `i18next` and persists the choice. */
  setLanguage: (code: LanguageCode) => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: "en",
      setLanguage: (code: LanguageCode) => {
        // Drive the live i18next instance first so the whole tree re-renders in
        // the new language, then persist (mirrors theme's `setMode` ordering).
        void i18n.changeLanguage(code);
        set({ language: code });
      },
    }),
    {
      name: LANGUAGE_STORAGE_KEY,
    }
  )
);
