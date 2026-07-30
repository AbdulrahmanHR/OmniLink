import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y, gotoApp, installTauriMock } from "./_helpers";

/**
 * v1.7.3 — Flashing discoverability. Pins that the wizard's frequency step makes
 * the two previously-hidden affordances OBVIOUS: (1) firmware versions are LIVE
 * from ExpressLRS GitHub (with an offline-cache fallback), and (2) a local-`.bin`
 * file can be flashed. The underlying flash/fetch paths are real and verified by
 * Rust unit/integration tests; on-device flash acceptance is deferred to
 * docs/v1.6.4_HW_VALIDATION.md §(b). These specs only pin the user-visible
 * discoverability surface (no map canvas → no MapLibre flake).
 */
async function gotoFrequencyStep(page: import("@playwright/test").Page) {
  await gotoApp(page, "/flash");
  await page.getByRole("button", { name: /BetaFPV/ }).first().click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /Nano TX/ }).first().click();
  await page.getByRole("button", { name: "Next" }).click();
}

/**
 * The wizard's release payload, in the provenance-carrying shape
 * `fetch_firmware_releases` returns (`{ releases, stale, fetchedAt }`).
 * `releases` arrives sorted semver-descending from the backend.
 */
function releasePayload(
  releases: {
    tag: string;
    prerelease: boolean;
  }[],
  provenance: { stale: boolean; fetchedAt?: number } = { stale: false }
) {
  return {
    releases: releases.map((r) => ({
      tag: r.tag,
      name: `ExpressLRS ${r.tag}`,
      changelog: "Fixes",
      publishedAt: "2025-01-02T00:00:00Z",
      prerelease: r.prerelease,
    })),
    stale: provenance.stale,
    fetchedAt: provenance.fetchedAt ?? null,
  };
}

test.describe("Flashing discoverability", () => {
  test("surfaces live ExpressLRS GitHub releases + the local-file option", async ({
    page,
  }) => {
    await installTauriMock(page, {
      fetch_firmware_releases: releasePayload([
        { tag: "3.5.3", prerelease: false },
      ]),
    });
    await gotoFrequencyStep(page);

    const main = page.locator("main");
    // (1) provenance is explicit: the live release list is labelled as coming
    // from ExpressLRS GitHub (not a silent list).
    const source = main.getByTestId("firmware-source");
    await expect(source).toBeVisible();
    await expect(source).toContainText("Live from ExpressLRS GitHub");
    // the live tag is actually rendered as a selectable version.
    await expect(main.getByRole("button", { name: /3\.5\.3/ })).toBeVisible();
    // (2) the local-`.bin` option is visibly offered with its lead-in label.
    await expect(main.getByTestId("local-firmware-button")).toBeVisible();
    await expect(
      main.getByText("Or flash a firmware file from your computer")
    ).toBeVisible();

    await expectNoSeriousA11y(page);
  });

  test("hides pre-releases by default and never labels one 'Latest'", async ({
    page,
  }) => {
    // FWCHK-2: GitHub lists newest-CREATED first, so a fresh 3.6.0-RC1 used to
    // land at index 0 and get badged "Latest" to a beginner with no RC marking.
    await installTauriMock(page, {
      fetch_firmware_releases: releasePayload([
        { tag: "3.6.0-RC1", prerelease: true },
        { tag: "3.5.3", prerelease: false },
      ]),
    });
    await gotoFrequencyStep(page);

    const main = page.locator("main");
    // The RC is not offered at all until it is asked for…
    await expect(main.getByRole("button", { name: /3\.6\.0-RC1/ })).toHaveCount(
      0
    );
    // …and "Latest" sits on the highest STABLE release.
    const latest = main.getByRole("button", { name: /3\.5\.3/ });
    await expect(latest).toBeVisible();
    await expect(latest).toContainText("Latest");

    // Opting in reveals the RC — clearly badged, and still not "Latest".
    await main.getByTestId("show-prereleases-toggle").check();
    const rc = main.getByRole("button", { name: /3\.6\.0-RC1/ });
    await expect(rc).toBeVisible();
    await expect(rc).toContainText("Pre-release");
    await expect(rc).not.toContainText("Latest");
    await expect(
      main.getByRole("button", { name: /3\.5\.3/ })
    ).toContainText("Latest");

    await expectNoSeriousA11y(page);
  });

  test("labels a cache served after a failed fetch as cached, not live", async ({
    page,
  }) => {
    // FWCHK-7: on a network failure with a populated cache the backend still
    // serves the list — flagged `stale`. Badging that "Live from ExpressLRS
    // GitHub" was a straight lie about how current the versions are.
    await installTauriMock(page, {
      fetch_firmware_releases: releasePayload(
        [{ tag: "3.5.3", prerelease: false }],
        { stale: true, fetchedAt: Date.UTC(2025, 0, 2, 3, 4) }
      ),
    });
    await gotoFrequencyStep(page);

    const source = page.locator("main").getByTestId("firmware-source");
    await expect(source).toBeVisible();
    await expect(source).toContainText("Cached");
    await expect(source).not.toContainText("Live from ExpressLRS GitHub");

    await expectNoSeriousA11y(page);
  });

  test("falls back to a clearly-labelled offline cache when GitHub is unreachable", async ({
    page,
  }) => {
    // Empty release list = GitHub unreachable with a cold cache; the UI must
    // label the fallback as the bundled catalogue (not silently show a list of
    // unknown provenance).
    await installTauriMock(page, {
      fetch_firmware_releases: releasePayload([]),
    });
    await gotoFrequencyStep(page);

    const main = page.locator("main");
    const source = main.getByTestId("firmware-source");
    await expect(source).toBeVisible();
    await expect(source).toContainText("Offline");
    // bundled fallback versions still render so the user can proceed offline: the
    // version grid marks its first entry "Latest".
    await expect(main.getByText("Latest")).toBeVisible();
    await expect(main.getByTestId("local-firmware-button")).toBeVisible();

    await expectNoSeriousA11y(page);
  });
});
