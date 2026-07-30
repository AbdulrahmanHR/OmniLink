import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The component only needs `t` to resolve keys; render the key itself so the
// assertions below are about WHICH copy is shown, not about the translation.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FlashProgress } from "@/components/wizard/FlashProgress";
import type { FlashStage, FlashStatus } from "@/stores/wizard";

/**
 * FLASH-11: `cancelFlash` existed in the store, the Tauri seam and the Rust
 * command, but no component ever called it — a hung flash (unreachable OTA
 * host, dead FC handshake) left killing the app as the only way out, because
 * the wizard locks navigation while `flash.status === "running"`.
 *
 * FLASH-4 is the other half: the control must vanish once the write has begun,
 * because from that point the backend REFUSES to cancel (stopping esptool
 * mid-erase is what bricks a radio). The gate is the stage, matching
 * `FlashCancel::enter_write` in `src-tauri/src/flash/cancel.rs`.
 */
function render(
  stage: FlashStage,
  status: FlashStatus = "running",
  withHandler = true
) {
  return renderToStaticMarkup(
    <FlashProgress
      status={status}
      percent={50}
      stage={stage}
      etaSeconds={12}
      log={["Downloading firmware"]}
      onCancel={withHandler ? () => {} : undefined}
    />
  );
}

describe("FlashProgress cancel control", () => {
  it("renders a cancel control while the flash can still be stopped", () => {
    for (const stage of ["fetch", "erase"] as const) {
      const html = render(stage);
      expect(html).toContain('data-testid="flash-cancel"');
      expect(html).toContain("wizard.flash.cancel");
      expect(html).not.toContain('data-testid="flash-cancel-unavailable"');
    }
  });

  it("replaces it with the do-not-disconnect notice from the write stage on", () => {
    for (const stage of ["write", "verify"] as const) {
      const html = render(stage);
      expect(html).not.toContain('data-testid="flash-cancel"');
      expect(html).toContain('data-testid="flash-cancel-unavailable"');
      expect(html).toContain("wizard.flash.cancelUnavailable");
    }
  });

  it("shows neither once the flash is no longer running", () => {
    const html = render("done", "done");
    expect(html).not.toContain('data-testid="flash-cancel"');
    expect(html).not.toContain('data-testid="flash-cancel-unavailable"');
  });

  it("shows nothing when no cancel handler is wired", () => {
    const html = render("fetch", "running", false);
    expect(html).not.toContain('data-testid="flash-cancel"');
    expect(html).not.toContain('data-testid="flash-cancel-unavailable"');
  });
});
