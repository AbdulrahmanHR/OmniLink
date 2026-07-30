import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  uploadFile,
} from "./_helpers";

/**
 * M37 — Local link diagnostics (v2.0.0).
 *
 * Drives the real Session Analysis page (`/analysis`) fully headlessly: a labelled
 * DL2 fixture CSV is imported through the genuine pure-browser on-ramp
 * (`logs-import-input`), `analyzeSession` runs against the loaded log, and the
 * Signal Health panel + findings list + diagnostic chart markers render off the
 * engine's already-computed report. The Tauri IPC/event bridge is mocked
 * ({@link installTauriMock}) so the production Zustand stores resolve unchanged
 * under the same seam every other spec uses — the import itself is pure-browser.
 *
 * Anti-false-positive throughout: the diagnostics surfaces exist ONLY after a log
 * is parsed, and the fixtures are deterministic (`failsafe-single-01` → two
 * critical findings; `warning-lq-dips-01` → warning-only; `wiring-multi-drop-04`
 * → a finding count that genuinely shifts with the sensitivity preset), so each
 * assertion proves the engine→store→UI path actually ran.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIAG_FIXTURES = path.resolve(here, "../../data/fixtures/diagnostics");

/** Failsafe DL2 fixture: a sustained LQ→0 / RSSI-floor collapse → two criticals. */
const FAILSAFE_CSV = path.join(DIAG_FIXTURES, "failsafe", "failsafe-single-01.csv");
/** Warning DL2 fixture: recurring LQ dips → warning-level findings, never critical. */
const WARNING_CSV = path.join(DIAG_FIXTURES, "warning", "warning-lq-dips-01.csv");
/**
 * Wiring DL2 fixture: four intermittent drops. Its finding count is preset-
 * sensitive (beginner detects fewer than intermediate/advanced), so it proves a
 * preset switch re-runs the analysis and updates the rendered findings.
 */
const PRESET_DELTA_CSV = path.join(DIAG_FIXTURES, "wiring", "wiring-multi-drop-04.csv");
/**
 * A genuinely short (10-sample) session — below the M38 pattern-detection minimum,
 * so the patterns panel must render the honest "not enough evidence" state.
 */
const SHORT_CSV = path.join(DIAG_FIXTURES, "patterns", "short-session-01.csv");
/**
 * A healthy DL2 fixture: a clean cruise. Its Signal-Health factor readout renders
 * the values GREEN (nominal), exercising the good-status text contrast.
 */
const HEALTHY_CSV = path.join(DIAG_FIXTURES, "healthy", "healthy-clean-cruise-01.csv");

test.describe("Local link diagnostics (M37)", () => {
  // Reduced motion → axe reads the settled state, never a mid-animation frame.
  // Clipboard permissions → the "Copy Diagnostic Summary" round-trip can read back.
  test.use({
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });

  test("import failsafe session → health panel, score, critical findings, chart markers", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");

    // Before the import: no diagnostics surface (proves the real flow drives it).
    await expect(page.getByTestId("diagnostics-health-panel")).toHaveCount(0);

    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    // Signal Health panel renders with a numeric score in [0, 100].
    await expect(page.getByTestId("diagnostics-health-panel").first()).toBeVisible();
    const scoreText = await page
      .getByTestId("diagnostics-health-score")
      .first()
      .textContent();
    const score = Number((scoreText ?? "").trim());
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);

    // Findings list populates; the failsafe fixture yields ≥1 finding, and the
    // top finding (engine sorts critical-first) carries the Critical badge.
    const findingsList = page.getByTestId("diagnostics-findings-list");
    await expect(findingsList).toBeVisible();
    const findings = page.getByTestId("diagnostics-finding");
    await expect(findings.first()).toBeVisible();
    expect(await findings.count()).toBeGreaterThanOrEqual(1);
    await expect(findings.first()).toContainText("Critical");
    await expect(
      findings.filter({ hasText: "Critical" }).first()
    ).toBeVisible();

    // The synchronized timeline charts render the diagnostic evidence-window
    // markers off the same report.
    await expect(page.getByTestId("logs-timeline-charts")).toBeVisible();
    const markers = page.getByTestId("diagnostics-chart-marker");
    expect(await markers.count()).toBeGreaterThanOrEqual(1);
  });

  test("warning fixture yields warning-level findings (no critical)", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", WARNING_CSV);

    const findings = page.getByTestId("diagnostics-finding");
    await expect(findings.first()).toBeVisible();
    // At least one Warning-badged finding…
    await expect(findings.filter({ hasText: "Warning" }).first()).toBeVisible();
    // …and the warning fixture never escalates to a Critical badge.
    await expect(findings.filter({ hasText: "Critical" })).toHaveCount(0);
  });

  test("Copy Diagnostic Summary → identifier-free clipboard text", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    const copy = page.getByTestId("diagnostics-copy-summary");
    await expect(copy).toBeVisible();
    await copy.click();

    // Fallback signal: the button enters its "Copied" confirmation state.
    await expect(copy).toContainText("Copied");

    // Primary check: read the clipboard back and assert a readable, GPS-free
    // summary — the health score line + a localized rule label, and crucially NO
    // coordinate-shaped text or lat/lon tokens (the safety contract).
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("Signal health:");
    expect(text).toMatch(/\b\d{1,3}\s*\/\s*100\b/);
    expect(text.toLowerCase()).toContain("rssi at the floor");
    expect(text).not.toMatch(/\b(lat|lon|lng|latitude|longitude|gps)\b/i);
    // No decimal-degrees coordinate (e.g. 47.1234): the engine emits only
    // integer/one-decimal non-identifying numbers.
    expect(text).not.toMatch(/-?\d{1,3}\.\d{4,}/);
  });

  test("sensitivity preset switch re-analyzes and updates the rendered findings", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", PRESET_DELTA_CSV);

    await expect(page.getByTestId("diagnostics-findings-list")).toBeVisible();
    const findings = page.getByTestId("diagnostics-finding");
    await expect(findings.first()).toBeVisible();
    const defaultCount = await findings.count(); // intermediate preset
    expect(defaultCount).toBeGreaterThan(0);

    // Open the diagnostics settings sheet.
    await page.getByTestId("diagnostics-settings-open").click();
    await expect(page.getByTestId("diagnostics-settings-sheet")).toBeVisible();

    // Beginner (more cautious) → strictly fewer findings on this fixture, proving
    // the preset re-runs the analysis and the list re-renders off the new report.
    await page.getByTestId("diagnostics-preset-beginner").click();
    await expect(page.getByTestId("diagnostics-preset-beginner")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect.poll(async () => findings.count()).toBeLessThan(defaultCount);
    const beginnerCount = await findings.count();

    // Advanced (most sensitive) → strictly more findings than beginner.
    await page.getByTestId("diagnostics-preset-advanced").click();
    await expect(page.getByTestId("diagnostics-preset-advanced")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect.poll(async () => findings.count()).toBeGreaterThan(beginnerCount);
  });

  test("post-flight patterns: most-likely summary + pattern chart markers (M38)", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");

    // Before the import: no patterns surface (proves the real flow drives it).
    await expect(page.getByTestId("diagnostics-patterns")).toHaveCount(0);

    // The multi-drop wiring fixture trips ≥3 lq-collapse findings, so the M38
    // detector raises `repeated-lq-drops` (verified in the unit corpus test).
    await uploadFile(page, "logs-import-input", PRESET_DELTA_CSV);

    // The patterns panel renders with the most-likely block populated.
    await expect(page.getByTestId("diagnostics-patterns").first()).toBeVisible();
    await expect(
      page.getByTestId("diagnostics-pattern-mostlikely")
    ).toBeVisible();
    await expect(page.getByTestId("diagnostics-pattern-evidence")).toBeVisible();
    await expect(
      page.getByTestId("diagnostics-pattern-checkfirst")
    ).toBeVisible();

    // The timeline charts render the distinct session-pattern evidence markers.
    await expect(page.getByTestId("logs-timeline-charts")).toBeVisible();
    const patternMarkers = page.getByTestId("diagnostics-pattern-marker");
    await expect.poll(async () => patternMarkers.count()).toBeGreaterThanOrEqual(1);
  });

  test("short session shows the honest 'not enough evidence' pattern state (M38)", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");

    // A 10-sample session is below the pattern-detection minimum, so the patterns
    // panel must render the honest "not enough evidence" copy — never a fabricated
    // pattern, and never a most-likely block.
    await uploadFile(page, "logs-import-input", SHORT_CSV);
    const patterns = page.getByTestId("diagnostics-patterns");
    await expect(patterns.first()).toBeVisible();
    await expect(patterns.first()).toContainText(
      "Not enough evidence in this session"
    );
    await expect(page.getByTestId("diagnostics-pattern-mostlikely")).toHaveCount(0);
  });

  test("diagnostics panels (and the settings sheet) are axe-clean", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    // Anchor the scan to a fully-populated diagnostics surface: gauge + factor
    // breakdown + a real findings list with severity badges + expandable cards.
    await expect(page.getByTestId("diagnostics-health-panel").first()).toBeVisible();
    await expect(page.getByTestId("diagnostics-findings-list")).toBeVisible();
    await expect(page.getByTestId("diagnostics-finding").first()).toBeVisible();
    await expectNoSeriousA11y(page);

    // Open the settings sheet and scan the modal subtree (preset buttons,
    // category switches, advanced threshold inputs). Scoped to the dialog so the
    // intentionally-dimmed backdrop scrim isn't a false positive (matches a11y.spec).
    await page.getByTestId("diagnostics-settings-open").click();
    await expect(page.getByTestId("diagnostics-settings-sheet")).toBeVisible();
    await expectNoSeriousA11y(page, '[role="dialog"]');
  });

  test("M38 pattern cards + chart markers are axe-clean (M41)", async ({ page }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");

    // The multi-drop wiring fixture raises the M38 `repeated-lq-drops` pattern, so
    // the pattern summary cards + the dashed pattern chart markers actually render
    // (the M41 a11y gap the launch gate closes — the earlier axe test scans only the
    // failsafe fixture, which raises no patterns).
    await uploadFile(page, "logs-import-input", PRESET_DELTA_CSV);

    // Anchor a fully-populated patterns surface: the most-likely / evidence /
    // check-first blocks AND at least one pattern evidence marker on the charts.
    await expect(page.getByTestId("diagnostics-patterns").first()).toBeVisible();
    await expect(page.getByTestId("diagnostics-pattern-mostlikely")).toBeVisible();
    await expect(page.getByTestId("diagnostics-pattern-evidence")).toBeVisible();
    await expect(page.getByTestId("diagnostics-pattern-checkfirst")).toBeVisible();
    await expect(page.getByTestId("logs-timeline-charts")).toBeVisible();
    await expect
      .poll(async () => page.getByTestId("diagnostics-pattern-marker").count())
      .toBeGreaterThanOrEqual(1);

    await expectNoSeriousA11y(page);
  });

  test("the M38 'not enough evidence' pattern state is axe-clean (M41)", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");

    // A 10-sample session is below the pattern-detection minimum, so the patterns
    // panel renders the honest "not enough evidence" state — scan it for a11y too.
    await uploadFile(page, "logs-import-input", SHORT_CSV);
    const patterns = page.getByTestId("diagnostics-patterns");
    await expect(patterns.first()).toBeVisible();
    await expect(patterns.first()).toContainText("Not enough evidence in this session");
    await expectNoSeriousA11y(page);
  });

  test("LIGHT theme: the critical severity badge is axe-clean (M41)", async ({
    page,
  }) => {
    // Every other axe scan runs in the DEFAULT DARK theme, so a light-theme-only
    // contrast regression (the severity Badge's critical text on its `bg-status-
    // critical/15` tint was 3.74:1 on the light card — a WCAG AA fail) slips past
    // them. Seed the persisted theme store to LIGHT before the app mounts, then scan
    // the M38 patterns surface: the multi-drop fixture's `repeated-lq-drops` pattern
    // is CRITICAL, so its most-likely block carries the critical severity badge —
    // the exact element the light contrast fix targets. (The finding-card badge is
    // an unreliable anchor: axe inconsistently leaves its background indeterminate,
    // so it never trips the scan. The pattern badge is reliably evaluated.)
    await installTauriMock(page, {});
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [
        "omnilink-theme",
        JSON.stringify({ state: { mode: "light", resolved: "light" }, version: 0 }),
      ] as const
    );
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", PRESET_DELTA_CSV);

    // Prove the light theme actually applied (no dark/carbon class on <html>), so a
    // pass is genuinely a LIGHT-theme pass, not a silently-dark one.
    const isLight = await page.evaluate(
      () =>
        !document.documentElement.classList.contains("dark") &&
        !document.documentElement.classList.contains("carbon")
    );
    expect(isLight).toBe(true);

    // The critical pattern renders its Critical severity badge in the most-likely
    // block — the exact element whose text contrast on the light `/15` tint this
    // guards.
    await expect(page.getByTestId("diagnostics-pattern-mostlikely")).toBeVisible();
    await expect(
      page.getByTestId("diagnostics-pattern-mostlikely").filter({ hasText: "Critical" })
    ).toBeVisible();

    // Scoped to the patterns surface (which hosts the critical badge this guards).
    // Fails on the base critical badge (3.73:1) before the fix; passes after.
    await expectNoSeriousA11y(page, '[data-testid="diagnostics-patterns"]');
  });

  test("LIGHT theme: the Signal-Health good factor readout is axe-clean (M41)", async ({
    page,
  }) => {
    // Green is high-luminance, so `text-status-good` as a small factor-readout value
    // measured only ~2.67:1 on the near-white light card — a WCAG AA fail on a
    // DIAGNOSTIC PANEL. A healthy fixture renders those factor values GREEN, so this
    // light-theme scan of the Signal-Health panel guards that class of failure
    // (paired with the critical-badge scan above so both status-text colors are
    // gated in light).
    await installTauriMock(page, {});
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [
        "omnilink-theme",
        JSON.stringify({ state: { mode: "light", resolved: "light" }, version: 0 }),
      ] as const
    );
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", HEALTHY_CSV);

    const isLight = await page.evaluate(
      () =>
        !document.documentElement.classList.contains("dark") &&
        !document.documentElement.classList.contains("carbon")
    );
    expect(isLight).toBe(true);

    // The Signal-Health panel with its (green, nominal) factor readout is on screen.
    await expect(page.getByTestId("diagnostics-health-panel").first()).toBeVisible();

    // Scoped to the health panel that hosts the green factor values. Fails on the
    // base good green (~2.67:1) before the fix; passes after.
    await expectNoSeriousA11y(page, '[data-testid="diagnostics-health-panel"]');
  });
});

/**
 * M39a — BYOK AI explanations for diagnostics (v2.0.1).
 *
 * Drives the real "Explain this finding" / "Ask Omnia about this session" actions:
 * they stage the sanitized aggregate as one-shot evidence, prefill the composer
 * with a short localized question, and open the assistant — NOT auto-send, so the
 * preview-before-send stays usable. The local finding stays fully visible whether a
 * BYOK key is present, absent, or the AI call fails. The Tauri AI commands are
 * mocked (`ai_has_api_key`, `ai_send_message`, `ai_preview_payload`).
 */
test.describe("BYOK AI explanations for diagnostics (M39a)", () => {
  test.use({ reducedMotion: "reduce" });

  test("Explain a finding opens the assistant with the drafted question; finding stays visible", async ({
    page,
  }) => {
    await installTauriMock(page, {
      ai_has_api_key: true,
      ai_send_message: { content: "ok", suggestion: null },
      // A sanitized-shape preview payload (what `ai_preview_payload` returns).
      ai_preview_payload: {
        targetName: null,
        telemetry: null,
        diagnostics: { scope: "finding", findings: [], patterns: [] },
      },
    });
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    const findings = page.getByTestId("diagnostics-finding");
    await expect(findings.first()).toBeVisible();

    const explain = page.getByTestId("diagnostics-explain-finding").first();
    await expect(explain).toBeVisible();
    await explain.click();

    // The assistant panel opens with the prefilled question in the composer.
    await expect(page.getByRole("dialog")).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message Omnia" });
    await expect(composer).toHaveValue(/Explain this link-diagnostics finding/);

    // NOT auto-sent (preview-before-send stays usable): no assistant reply yet, and
    // the local finding remains fully visible behind the panel.
    await expect(findings.first()).toBeVisible();
  });

  test("Ask Omnia about the session opens the assistant with the session question", async ({
    page,
  }) => {
    await installTauriMock(page, {
      ai_has_api_key: true,
      ai_send_message: { content: "ok", suggestion: null },
      ai_preview_payload: { diagnostics: { scope: "session", findings: [], patterns: [] } },
    });
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    const ask = page.getByTestId("diagnostics-ask-session");
    await expect(ask).toBeVisible();
    await ask.click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Omnia" })).toHaveValue(
      /Explain my session's link diagnostics/
    );
    await expect(page.getByTestId("diagnostics-findings-list")).toBeVisible();
  });

  test("no key: explain then send keeps the finding visible and shows the no-key bubble", async ({
    page,
  }) => {
    await installTauriMock(page, {
      ai_has_api_key: false,
      ai_send_message: { content: "ok", suggestion: null },
      ai_preview_payload: {},
    });
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    const findings = page.getByTestId("diagnostics-finding");
    await expect(findings.first()).toBeVisible();

    await page.getByTestId("diagnostics-explain-finding").first().click();

    // Send the drafted question — with no key configured the send degrades honestly.
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await send.click();

    // Graceful degradation: the honest no-key bubble appears…
    await expect(
      page.getByText("I need an API key to answer.", { exact: false })
    ).toBeVisible();
    // …and the local finding remains fully visible (never blocked by the AI path).
    await expect(findings.first()).toBeVisible();
  });

  test("the diagnostics AI actions keep the surface axe-clean", async ({ page }) => {
    await installTauriMock(page, {
      ai_has_api_key: true,
      ai_send_message: { content: "ok", suggestion: null },
      ai_preview_payload: { diagnostics: { scope: "finding", findings: [], patterns: [] } },
    });
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", FAILSAFE_CSV);

    // The new Explain / Ask buttons carry accessible names on the findings surface.
    await expect(page.getByTestId("diagnostics-explain-finding").first()).toBeVisible();
    await expect(page.getByTestId("diagnostics-ask-session")).toBeVisible();
    await expectNoSeriousA11y(page);

    // Open the assistant via Explain and scan the dialog subtree.
    await page.getByTestId("diagnostics-explain-finding").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoSeriousA11y(page, '[role="dialog"]');
  });
});
