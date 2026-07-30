import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";

/**
 * Registered locales (M27). English is the source-of-truth / fallback; Spanish
 * is a complete second locale held at exact key-parity by the i18n gate in
 * `tests/unit/translationStrings.test.ts`. Add a locale here AND to `LANGUAGES`
 * in `@/stores/language` to expand the set.
 */
const resources = {
  en: { translation: en },
  es: { translation: es },
} as const;

/**
 * localStorage key the language store persists under — must match
 * `LANGUAGE_STORAGE_KEY` in `@/stores/language`. Duplicated here (rather than
 * imported) so `@/lib/i18n` stays free of a store→i18n→store import cycle: the
 * store imports this module to drive runtime switches, so this module must not
 * import the store.
 */
const LANGUAGE_STORAGE_KEY = "omnilink-language";

/**
 * Resolve the startup language from the persisted language store
 * (`omnilink-language`, written by `useLanguageStore`) so the very first render
 * is already in the operator's chosen language — never a hardcoded `lng`. Falls
 * back to English for a missing/garbage value or an unregistered code, and
 * tolerates a non-DOM (test/SSR) environment where `localStorage` is absent.
 */
function getInitialLanguage(): keyof typeof resources {
  try {
    const raw = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    if (!raw) return "en";
    const code = (JSON.parse(raw) as { state?: { language?: string } })?.state
      ?.language;
    return code && code in resources ? (code as keyof typeof resources) : "en";
  } catch {
    return "en";
  }
}

i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // React already escapes
  },
  // NFR-I18N-03: Number/date/unit formatting uses the Intl API
  // (handled at component level, not in i18next config)
});

export default i18n;
