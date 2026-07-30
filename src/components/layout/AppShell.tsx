import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { DeviceBar } from "./DeviceBar";
import { AIChatButton, ChatPanel } from "@/components/ai";
import { LiveAlertHost } from "@/components/alerts";

/** Centered spinner shown while a lazily-loaded page chunk resolves. */
function RouteFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center py-24">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none" />
    </div>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Skip link: first tab stop, visually hidden until focused, so keyboard
          users can jump past the sidebar/device bar straight to the page body. */}
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {t("a11y.skipToContent")}
      </a>

      {/* Sidebar (left) */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* DeviceBar (top) */}
        <DeviceBar />

        {/* MainContent (router outlet). tabIndex={-1} makes it a valid skip-link
            target so activating the skip link moves focus here (not just scroll). */}
        <main
          id="main-content"
          tabIndex={-1}
          className="relative flex-1 overflow-auto p-6 outline-none"
        >
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* AI assistant — floating launcher + overlay panel (fixed, outside flow) */}
      <AIChatButton />
      <ChatPanel />

      {/* Live telemetry alerts (M26) — single app-wide subscription + toast stack. */}
      <LiveAlertHost />
    </div>
  );
}
