import { useTranslation } from "react-i18next";
import {
  Home,
  Zap,
  Radio,
  FolderOpen,
  ScrollText,
  TrendingUp,
  Settings,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// v1.7.0: the former Logs (M14 flight-log import/analysis) and Simulator (M16
// telemetry replay) entries are consolidated into one Session Analysis entry.
// v2.5.0: the flat list is grouped — live device work (core), the post-flight
// read-only surfaces (analysis), and the app itself (system) — separated by a
// hairline so the nav scans in three beats instead of seven.
const navGroups = [
  {
    id: "core",
    items: [
      { key: "home", icon: Home, path: "/" },
      { key: "flash", icon: Zap, path: "/flash" },
      { key: "telemetry", icon: Radio, path: "/telemetry" },
    ],
  },
  {
    id: "analysis",
    items: [
      { key: "profiles", icon: FolderOpen, path: "/profiles" },
      { key: "analysis", icon: ScrollText, path: "/analysis" },
      { key: "trends", icon: TrendingUp, path: "/trends" },
    ],
  },
  {
    id: "system",
    items: [{ key: "settings", icon: Settings, path: "/settings" }],
  },
] as const;

export function Sidebar() {
  const { t } = useTranslation();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-card">
      {/* Logo area — the OmniLink oscilloscope waveform (the real brand mark). */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <svg
            viewBox="0 0 100 100"
            className="h-5 w-5 text-primary-foreground"
            aria-hidden="true"
          >
            <path
              d="M 15 50 Q 32.5 20, 50 50 T 85 50"
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              strokeLinecap="round"
            />
            <circle cx="15" cy="50" r="4" fill="currentColor" />
            <circle cx="50" cy="50" r="4" fill="currentColor" />
            <circle cx="85" cy="50" r="4" fill="currentColor" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-foreground">
          {t("app.name")}
        </span>
      </div>

      {/* Navigation — named so assistive tech can distinguish this landmark. */}
      <nav
        aria-label={t("a11y.primaryNav")}
        className="flex flex-1 flex-col gap-1 p-2"
      >
        {navGroups.map((group, gi) => (
          <div key={group.id}>
            {gi > 0 && <Separator className="my-2" />}
            <div className="flex flex-col gap-1">
              {group.items.map(({ key, icon: Icon, path }) => (
                <NavLink
                  key={key}
                  to={path}
                  // The active item carries a left-edge signal trace (green
                  // border + inset glow); the inactive one reserves the same
                  // 2px with a transparent border so nothing shifts on nav.
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150",
                      isActive
                        ? "border-l-2 border-primary bg-accent text-accent-foreground shadow-[inset_0_0_12px_-4px_var(--color-signal-glow)]"
                        : "border-l-2 border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )
                  }
                >
                  <Icon className="h-4 w-4" />
                  {t(`nav.${key}`)}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
