import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  uploadFile,
} from "./_helpers";

/**
 * M40 — Personalized Local Trends & Setup Suggestions (v2.0.2).
 *
 * Drives the real `/trends` page fully headlessly. It reads the user's OWN
 * accumulated diagnostic history (the persisted `omnilink-diagnostics-history`
 * store) and renders per-device trends + conservative setup suggestions. The
 * honest-mock contract is asserted end to end: with no history the page shows an
 * honest empty state (never a fabricated trend); seeded real history renders
 * per-device trend cards + suggestions and the reset control genuinely clears it;
 * and the real import pipeline accumulates history the trends surface then shows.
 *
 * Anti-false-positive throughout: each populated assertion is paired with an
 * absent-before / present-after check so it can only pass when the store→engine→UI
 * path actually ran.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIAG_FIXTURES = path.resolve(here, "../../data/fixtures/diagnostics");

/**
 * Three DL2 fixtures with genuinely distinct sample counts (300 / 280 / 200) so
 * their content signatures differ — three separate history records, never deduped.
 */
const FIXTURE_A = path.join(DIAG_FIXTURES, "failsafe", "failsafe-deep-03.csv");
const FIXTURE_B = path.join(DIAG_FIXTURES, "warning", "warning-packet-jitter-03.csv");
const FIXTURE_C = path.join(DIAG_FIXTURES, "healthy", "healthy-short-hop-11.csv");

const HISTORY_KEY = "omnilink-diagnostics-history";

/** One persisted history record matching {@link DiagnosticHistoryRecord} exactly. */
interface SeedRecord {
  signature: string;
  source: "blackbox" | "omnilog";
  sampleCount: number;
  durationMs: number;
  healthScore: number;
  countsBySeverity: { info: number; warning: number; critical: number };
  ruleCounts: Record<string, number>;
  patternIds: string[];
  packetRate: number | null;
  recordedAt: number;
  deviceKey: string | null;
  deviceLabel: string | null;
}

/** Build a device record recurring rssi-floor + a weak 500 Hz RF mode. */
function seedRecord(over: Partial<SeedRecord>): SeedRecord {
  return {
    signature: "seed-sig",
    source: "omnilog",
    sampleCount: 120,
    durationMs: 4800,
    healthScore: 55,
    countsBySeverity: { info: 0, warning: 1, critical: 1 },
    ruleCounts: { "rssi-floor": 2 },
    patternIds: ["heading-degradation"],
    packetRate: 500,
    recordedAt: 1,
    deviceKey: "SpeedyBee F7|BF 4.5",
    deviceLabel: "SpeedyBee F7",
    ...over,
  };
}

/** Seed the persisted history store before navigation (zustand-persist shape). */
async function seedHistory(page: Page, records: SeedRecord[]): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [HISTORY_KEY, JSON.stringify({ state: { records }, version: 0 })] as const
  );
}

test.describe("Personalized local trends (M40)", () => {
  test.use({ reducedMotion: "reduce" });

  test("fresh install → honest empty state, no fabricated trends", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/trends");

    await expect(page.getByTestId("trends-page")).toBeVisible();
    // Honest empty state: no device cards, no suggestions invented from nothing.
    await expect(page.getByTestId("diagnostics-trend-device")).toHaveCount(0);
    await expect(page.getByTestId("diagnostics-suggestion")).toHaveCount(0);
    await expect(page.getByText("No trends yet")).toBeVisible();
    // No reset control when there is no history to reset.
    await expect(page.getByTestId("diagnostics-history-reset")).toHaveCount(0);
  });

  test("1–2 recorded sessions → not-enough state, no device cards or suggestions", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await seedHistory(page, [
      seedRecord({ signature: "s1", recordedAt: 1 }),
      seedRecord({ signature: "s2", recordedAt: 2 }),
    ]);
    await gotoApp(page, "/trends");

    await expect(page.getByTestId("trends-page")).toBeVisible();
    // Below MIN_SESSIONS_FOR_TRENDS: the distinct not-enough note, never a trend.
    await expect(page.getByTestId("diagnostics-trend-device")).toHaveCount(0);
    await expect(page.getByTestId("diagnostics-suggestion")).toHaveCount(0);
    await expect(
      page.getByText("2 of 3 sessions recorded", { exact: false })
    ).toBeVisible();
  });

  test("enough total history but every device has one session → honest no-trendable state", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    // Three single-session devices: total ≥ 3 but no device can be trended.
    await seedHistory(page, [
      seedRecord({ signature: "s1", recordedAt: 1, deviceKey: "A|1", deviceLabel: "A" }),
      seedRecord({ signature: "s2", recordedAt: 2, deviceKey: "B|1", deviceLabel: "B" }),
      seedRecord({ signature: "s3", recordedAt: 3, deviceKey: "C|1", deviceLabel: "C" }),
    ]);
    await gotoApp(page, "/trends");

    await expect(page.getByTestId("trends-page")).toBeVisible();
    await expect(page.getByTestId("diagnostics-trend-device")).toHaveCount(0);
    await expect(page.getByTestId("diagnostics-suggestion")).toHaveCount(0);
    await expect(
      page.getByText("No device has 2 or more recorded sessions", { exact: false })
    ).toBeVisible();
  });

  test("seeded history → per-device trends + suggestions, then reset clears it", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await seedHistory(page, [
      seedRecord({ signature: "s1", recordedAt: 1, healthScore: 55 }),
      seedRecord({ signature: "s2", recordedAt: 2, healthScore: 60 }),
      seedRecord({ signature: "s3", recordedAt: 3, healthScore: 50 }),
    ]);
    await gotoApp(page, "/trends");

    // A per-device trend card renders with the device label + health sparkline.
    const deviceCard = page.getByTestId("diagnostics-trend-device");
    await expect(deviceCard.first()).toBeVisible();
    await expect(deviceCard).toHaveCount(1);
    await expect(deviceCard.first()).toContainText("SpeedyBee F7");
    // The health-over-time sparkline exposes its role="img" landmark.
    await expect(deviceCard.getByRole("img").first()).toBeVisible();

    // At least one conservative setup suggestion is derived from the real trend.
    await expect(page.getByTestId("diagnostics-suggestion").first()).toBeVisible();

    // Reset history → confirm → returns to the honest empty state.
    await page.getByTestId("diagnostics-history-reset").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByTestId("diagnostics-history-reset-confirm").click();

    await expect(page.getByTestId("diagnostics-trend-device")).toHaveCount(0);
    await expect(page.getByTestId("diagnostics-suggestion")).toHaveCount(0);
    await expect(page.getByText("No trends yet")).toBeVisible();
  });

  test("real pipeline: importing distinct sessions accumulates trend history", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/trends");

    // Before any analysis there is no recorded history.
    await expect(page.getByTestId("diagnostics-trend-device")).toHaveCount(0);
    await expect(page.getByText("No trends yet")).toBeVisible();

    // Analyze three genuinely distinct sessions through the real import on-ramp;
    // each records one history entry (deduped by content signature).
    await gotoApp(page, "/analysis");
    for (const fixture of [FIXTURE_A, FIXTURE_B, FIXTURE_C]) {
      await uploadFile(page, "logs-import-input", fixture);
      await expect(
        page.getByTestId("diagnostics-health-panel").first()
      ).toBeVisible();
      await page.getByRole("button", { name: "Load another log" }).click();
      await expect(page.getByTestId("logs-import-input")).toBeVisible();
    }

    // The /trends surface now shows the accumulated history (unknown-device bucket,
    // since imported CSVs carry no device metadata).
    await gotoApp(page, "/trends");
    await expect(page.getByTestId("trends-page")).toBeVisible();
    await expect(
      page.getByTestId("diagnostics-trend-device").first()
    ).toBeVisible();
  });

  test("populated trends page is axe-clean", async ({ page }) => {
    await installTauriMock(page, {});
    await seedHistory(page, [
      seedRecord({ signature: "s1", recordedAt: 1 }),
      seedRecord({ signature: "s2", recordedAt: 2 }),
      seedRecord({ signature: "s3", recordedAt: 3 }),
    ]);
    await gotoApp(page, "/trends");

    await expect(
      page.getByTestId("diagnostics-trend-device").first()
    ).toBeVisible();
    await expect(page.getByTestId("diagnostics-suggestion").first()).toBeVisible();
    await expectNoSeriousA11y(page);
  });
});
