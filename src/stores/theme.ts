import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "dark" | "light" | "system" | "carbon";

interface ThemeState {
  mode: ThemeMode;
  /** The resolved theme (what's actually applied to the DOM) */
  resolved: "dark" | "light" | "carbon";
  setMode: (mode: ThemeMode) => void;
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(mode: ThemeMode): "dark" | "light" | "carbon" {
  return mode === "system" ? getSystemTheme() : mode;
}

function applyTheme(resolved: "dark" | "light" | "carbon") {
  const root = document.documentElement;
  root.classList.remove("dark", "carbon");
  if (resolved !== "light") {
    root.classList.add(resolved);
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: "dark" as ThemeMode,
      resolved: "dark" as const,
      setMode: (mode: ThemeMode) => {
        const resolved = resolveTheme(mode);
        applyTheme(resolved);
        set({ mode, resolved });
      },
    }),
    {
      name: "omnilink-theme",
      onRehydrateStorage: () => (state) => {
        if (state) {
          const resolved = resolveTheme(state.mode);
          applyTheme(resolved);
          state.resolved = resolved;
        }
      },
    }
  )
);

// Listen for OS theme changes when mode is "system"
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const state = useThemeStore.getState();
      if (state.mode === "system") {
        state.setMode("system");
      }
    });
}
