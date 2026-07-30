import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11y, gotoApp, installTauriMock } from "./_helpers";

/**
 * The v2.5 / M56c **ML lab**: session labeling + the data-readiness verdict, gated
 * behind the OFF-by-default `mlLab` feature flag.
 *
 * Three things this spec must prove, and does:
 *  1. **Absent when the flag is OFF.** Not disabled — *absent*. A shipped build has
 *     the flag off, so a normal user's Settings page has no lab section at all.
 *  2. **Real when the flag is ON.** Toggled through the SAME dev-flags panel
 *     `dev-flags.spec.ts` uses (no source edit, no bespoke test hook), the panel
 *     lists a stored session, labels it through the genuine `session-labels.ts`
 *     SQLite seam, and the readiness report updates.
 *  3. **The verdict is honest.** 36 of 1 500 labeled sessions, the 36 named as
 *     OmniLink's bundled fixtures rather than the user's recordings, and the
 *     shortfall stated plainly — with zero serious/critical a11y violations.
 *
 * ## The SQLite mock
 * `installTauriMock` gives every command one static return value, which is not
 * enough here: the panel issues two different SELECTs (sessions, then labels) and an
 * INSERT whose effect the next SELECT must see. So this spec layers a **stateful**
 * `plugin:sql|*` router over the shared mock — it dispatches on the SQL text and
 * keeps the inserted label rows in memory — and sets `window.isTauri`, which is what
 * `@tauri-apps/api`'s `isTauri()` reads to decide the DB seams are live. The app code
 * under test is entirely unchanged: it runs the real `tauri-plugin-sql` client.
 */

/** A recorded session the mocked `telemetry_sessions` table hands back. */
const STORED_SESSION = {
  session_id: "sess-e2e-1",
  started_at: 1_720_000_000_000,
  ended_at: 1_720_000_060_000,
  target_name: "ELRS RX",
  firmware: "3.4.0",
  name: null,
  frame_count: 1_500,
};

/** Baseline IPC handlers (present so nothing on the Settings page rejects noisily). */
const HANDLERS = {
  "plugin:sql|load": "sqlite:omnilink.db",
  "plugin:sql|select": [],
  "plugin:sql|execute": [0, 0],
  "plugin:sql|close": true,
  load_profiles: [],
  ai_has_api_key: false,
};

/**
 * Install the stateful SQLite router + mark the page as a Tauri runtime. Must run
 * AFTER `installTauriMock` (it wraps the invoke that mock installs) and BEFORE
 * navigation.
 */
async function installSqlMock(page: Page, session: unknown): Promise<void> {
  await page.addInitScript((storedSession) => {
    (window as unknown as { isTauri: boolean }).isTauri = true;

    interface Internals {
      invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
    }
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals })
      .__TAURI_INTERNALS__;
    const base = internals.invoke.bind(internals);

    // The in-memory `session_labels` table. Append-only, exactly like the real one.
    const labelRows: Record<string, unknown>[] = [];

    internals.invoke = async (cmd, args = {}) => {
      const query = String(args.query ?? "");
      const values = (args.values ?? []) as unknown[];

      if (cmd === "plugin:sql|select") {
        if (query.includes("FROM telemetry_sessions")) return [storedSession];
        if (query.includes("FROM session_labels")) {
          if (query.includes("WHERE session_id = $1")) {
            return labelRows.filter((r) => r.session_id === values[0]);
          }
          return labelRows;
        }
        return [];
      }

      if (cmd === "plugin:sql|execute") {
        if (query.startsWith("INSERT INTO session_labels")) {
          const [sessionId, label, revision, labeledAt] = values;
          labelRows.push({
            session_id: sessionId,
            label,
            revision,
            labeled_at: labeledAt,
          });
        }
        return [1, labelRows.length];
      }

      return base(cmd, args);
    };
  }, session);
}

/** Flip a dev feature flag through the dev-only Preview-features panel. */
async function enableFlag(page: Page, flag: string): Promise<void> {
  await gotoApp(page, "/settings");
  await page.getByTestId(`dev-flag-${flag}`).click();
  // The panel persists the override and reloads; the switch comes back ON.
  await expect(page.getByTestId(`dev-flag-${flag}`)).toHaveAttribute(
    "aria-checked",
    "true",
  );
}

test.describe("ML lab (mlLab flag)", () => {
  test.use({ reducedMotion: "reduce" });

  test("is ABSENT from Settings when the flag is off (the ship default)", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await installSqlMock(page, STORED_SESSION);
    await gotoApp(page, "/settings");

    // The dev panel confirms the ship default really is OFF...
    await expect(page.getByTestId("dev-flag-mlLab")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // ...and with it off the surface does not exist — no panel, no readiness
    // report, no label control. Not "present but disabled".
    await expect(page.getByTestId("ml-lab-panel")).toHaveCount(0);
    await expect(page.getByTestId("ml-lab-readiness")).toHaveCount(0);
    await expect(
      page.getByTestId(`ml-label-select-${STORED_SESSION.session_id}`),
    ).toHaveCount(0);
  });

  test("labels a stored session and states the honest readiness verdict", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await installSqlMock(page, STORED_SESSION);
    await enableFlag(page, "mlLab");

    const panel = page.getByTestId("ml-lab-panel");
    await expect(panel).toBeVisible();

    // The verdict does not soften the number: 36 of the 1,500 the bar requires.
    const verdict = page.getByTestId("ml-lab-verdict");
    await expect(verdict).toContainText("Not enough data to train");
    await expect(verdict).toContainText("36");
    await expect(verdict).toContainText("1,500");

    // ...and it says what that means for anything a model in this release reports.
    await expect(page.getByTestId("ml-lab-meaning")).toContainText(
      "indicative only",
    );

    // The 36 are named as OmniLink's fixtures, and the user's own count (0) is
    // reported separately — a reader cannot mistake the fixtures for their data.
    const provenance = page.getByTestId("ml-lab-provenance");
    await expect(provenance).toContainText("bundled reference fixtures");
    await expect(provenance).toContainText("not your recordings");
    await expect(provenance).toContainText(
      "Sessions you have labeled on this device: 0",
    );

    // The stored session is listed through the EXISTING listStoredSessions seam,
    // and starts unlabeled.
    const select = page.getByTestId(`ml-label-select-${STORED_SESSION.session_id}`);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("");

    // Label it → the append-only INSERT lands and the panel re-reads the DB.
    await select.selectOption("failsafe");
    await expect(select).toHaveValue("failsafe");

    // The readiness report now counts ONE user-labeled failsafe session — and the
    // fixture column is untouched, because the two are never merged.
    const failsafeRow = page.getByRole("row").filter({ hasText: "Failsafe" });
    await expect(failsafeRow).toContainText("292"); // shortfall: 300 − (7 + 1)
    await expect(page.getByTestId("ml-lab-provenance")).toContainText(
      "Sessions you have labeled on this device: 1",
    );

    // Relabeling appends a new revision (it never destroys the prior assertion) and
    // the displayed label follows the newest one.
    await select.selectOption("antennaSuspicion");
    await expect(select).toHaveValue("antennaSuspicion");
    await expect(page.getByTestId("ml-lab-provenance")).toContainText(
      "Sessions you have labeled on this device: 1",
    );

    // Nothing leaves the device: the panel says so, and no network call exists.
    await expect(page.getByTestId("ml-lab-privacy")).toContainText(
      "stay on this device",
    );

    // a11y: zero serious/critical violations on the new surface.
    await expectNoSeriousA11y(page);
  });
});
