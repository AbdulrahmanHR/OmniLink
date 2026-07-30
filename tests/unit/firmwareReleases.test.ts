import { describe, expect, it } from "vitest";
import {
  latestStableRelease,
  reconcileSelectedVersion,
  releaseChoices,
} from "@/lib/firmwareReleases";
import type { FirmwareRelease } from "@/lib/tauri";
import { isWizardStepValid } from "@/stores/wizard";

/**
 * FWCHK-2: the wizard used to map the fetched release list straight to tags and
 * badge `index === 0` as "Latest". GitHub's `/releases` is newest-**created**
 * first and includes pre-releases, so the day ExpressLRS cut a `3.6.0-RC1` a
 * beginner was shown a release candidate, at the top, labelled "Latest", with
 * nothing marking it as a beta.
 *
 * The list arrives here already sorted semver-descending by the Rust side
 * (`src-tauri/src/flash/github.rs`), which is what these fixtures reproduce.
 */
function rel(tag: string, prerelease = false): FirmwareRelease {
  return {
    tag,
    name: `ExpressLRS ${tag}`,
    changelog: "",
    publishedAt: "2025-01-02T00:00:00Z",
    prerelease,
  };
}

const tags = (choices: ReturnType<typeof releaseChoices>) =>
  choices.versions.map((v) => v.tag);

describe("releaseChoices", () => {
  it("hides pre-releases by default and badges the top STABLE release", () => {
    const live = [rel("3.6.0-RC1", true), rel("3.5.3"), rel("3.5.0")];
    const choices = releaseChoices(live, [], false);

    expect(tags(choices)).toEqual(["3.5.3", "3.5.0"]);
    expect(choices.latest).toBe("3.5.3");
    // The opt-in toggle is offered precisely because the list holds an RC.
    expect(choices.hasPrereleases).toBe(true);
  });

  it("reveals pre-releases on opt-in, still never badging one 'Latest'", () => {
    const live = [rel("3.6.0-RC1", true), rel("3.5.3"), rel("3.5.0")];
    const choices = releaseChoices(live, [], true);

    expect(tags(choices)).toEqual(["3.6.0-RC1", "3.5.3", "3.5.0"]);
    // Shown at the top (it IS the highest version) but marked as a pre-release…
    expect(choices.versions[0].prerelease).toBe(true);
    // …and "Latest" stays on the newest stable release, not on index 0.
    expect(choices.latest).toBe("3.5.3");
  });

  it("keeps 'Latest' on the highest version, not the most recently created", () => {
    // A patch backported onto an older branch (3.4.4) is created LAST, so GitHub
    // returns it first; the semver sort puts 3.5.3 back on top and "Latest" with
    // it. The list order the component renders is the sorted one, verbatim.
    const live = [rel("3.5.3"), rel("3.5.0"), rel("3.4.4")];
    const choices = releaseChoices(live, [], false);
    expect(tags(choices)).toEqual(["3.5.3", "3.5.0", "3.4.4"]);
    expect(choices.latest).toBe("3.5.3");
    expect(choices.hasPrereleases).toBe(false);
  });

  it("shows release candidates anyway when there is no stable release at all", () => {
    // Hiding them here would leave the grid empty and the user unable to
    // proceed. They are still badged as pre-releases, and nothing is "Latest".
    const live = [rel("3.6.0-RC2", true), rel("3.6.0-RC1", true)];
    const choices = releaseChoices(live, ["3.5.3"], false);

    expect(tags(choices)).toEqual(["3.6.0-RC2", "3.6.0-RC1"]);
    expect(choices.versions.every((v) => v.prerelease)).toBe(true);
    expect(choices.latest).toBeNull();
  });

  it("falls back to the bundled catalogue when the fetch yielded nothing", () => {
    // Offline with a cold cache: the curated catalogue is stable-only and
    // hand-ordered newest-first, so its first entry IS the latest.
    for (const live of [null, [] as FirmwareRelease[]]) {
      const choices = releaseChoices(live, ["3.5.3", "3.4.4"], false);
      expect(tags(choices)).toEqual(["3.5.3", "3.4.4"]);
      expect(choices.versions.every((v) => !v.prerelease)).toBe(true);
      expect(choices.latest).toBe("3.5.3");
      // No live list ⇒ nothing to opt into, so the toggle stays hidden.
      expect(choices.hasPrereleases).toBe(false);
    }
  });

  it("has no 'Latest' to badge when there are no versions at all", () => {
    const choices = releaseChoices(null, [], false);
    expect(choices.versions).toEqual([]);
    expect(choices.latest).toBeNull();
  });
});

/**
 * FWCHK-8: the AI-assisted wizard applies its suggestion straight to review, so
 * it never sees the firmware grid — it needs the same answer the "Latest" badge
 * gives, as a single tag, or `null` to fall back to the bundled catalogue.
 */
describe("latestStableRelease", () => {
  it("picks the highest stable release, never a newer pre-release", () => {
    expect(
      latestStableRelease([rel("3.6.0-RC1", true), rel("3.5.3"), rel("3.5.0")])
    ).toBe("3.5.3");
  });

  it("agrees with the badge the firmware grid renders", () => {
    // One rule, one answer: an automated pick and the human-visible "Latest"
    // badge can never disagree.
    const live = [rel("3.5.3"), rel("3.5.0"), rel("3.4.4")];
    expect(latestStableRelease(live)).toBe(releaseChoices(live, [], false).latest);
  });

  it("is null when there is nothing live and stable to pick", () => {
    // Fetch failed, empty list, or a list of nothing but release candidates —
    // the caller falls back to the catalogue rather than suggesting a beta.
    expect(latestStableRelease(null)).toBeNull();
    expect(latestStableRelease([])).toBeNull();
    expect(latestStableRelease([rel("3.6.0-RC1", true)])).toBeNull();
  });
});

/**
 * The firmware grid renders the bundled catalogue while the live fetch is still
 * in flight, so a tag picked in that window can drop out of the list when the
 * live releases land. The grid then showed NO selected tile and no changelog,
 * while the store still held the stale tag and let the user proceed to a flash
 * that 404s on an artifact that has aged out of the 20 newest releases.
 *
 * The invariant: a `firmwareVersion` in the store is always present in the
 * currently rendered choice list, or the step cannot proceed.
 */
describe("reconcileSelectedVersion", () => {
  const bundled = ["3.3.0", "3.2.1"];

  it("keeps a selection that is still on offer", () => {
    const choices = releaseChoices([rel("3.5.3"), rel("3.5.0")], bundled, false);
    expect(reconcileSelectedVersion("3.5.0", choices)).toBe("3.5.0");
  });

  it("re-selects the latest stable when a bundled tag aged out of the live list", () => {
    // The bug, exactly: 3.3.0 was clickable from the bundled catalogue during
    // `kind: "loading"`; the live list resolves without it.
    const loading = releaseChoices(null, bundled, false);
    expect(reconcileSelectedVersion("3.3.0", loading)).toBe("3.3.0");

    const live = releaseChoices([rel("3.5.3"), rel("3.5.0")], bundled, false);
    expect(reconcileSelectedVersion("3.3.0", live)).toBe("3.5.3");
  });

  it("re-selects the first entry when the live list is all release candidates", () => {
    // Nothing is badged "Latest" here, but the grid is not empty — so the
    // selection must still land on something the user can see.
    const choices = releaseChoices(
      [rel("3.6.0-RC2", true), rel("3.6.0-RC1", true)],
      bundled,
      false
    );
    expect(reconcileSelectedVersion("3.3.0", choices)).toBe("3.6.0-RC2");
  });

  it("rescues a pre-release stranded by switching the opt-in back off", () => {
    const live = [rel("3.6.0-RC1", true), rel("3.5.3"), rel("3.5.0")];
    const optedIn = releaseChoices(live, bundled, true);
    expect(reconcileSelectedVersion("3.6.0-RC1", optedIn)).toBe("3.6.0-RC1");

    // Unchecking the toggle hides the RC; the selection follows it out.
    const stableOnly = releaseChoices(live, bundled, false);
    expect(reconcileSelectedVersion("3.6.0-RC1", stableOnly)).toBe("3.5.3");
  });

  it("leaves an unmade choice alone rather than picking for the user", () => {
    const choices = releaseChoices([rel("3.5.3")], bundled, false);
    expect(reconcileSelectedVersion(null, choices)).toBeNull();
  });

  it("has nothing to move the selection to when the grid is empty", () => {
    const choices = releaseChoices(null, [], false);
    expect(choices.versions).toEqual([]);
    expect(reconcileSelectedVersion("3.3.0", choices)).toBeNull();
  });

  it("leaves the store agreeing with the rendered grid, so review cannot flash a vanished tag", () => {
    const base = {
      brandId: "b",
      modelId: "m",
      domain: "ISM2400",
      flashMethod: "uart",
      useTraditionalBinding: false,
      bindingPhrase: "",
      deviceIp: "10.0.0.1",
      localFirmwarePath: null,
      localFirmwareName: null,
    } as const;

    // Before reconciling: the step happily proceeds with a tag the grid no
    // longer offers — this is what StepReview used to flash.
    const live = releaseChoices([rel("3.5.3"), rel("3.5.0")], bundled, false);
    const stale = { ...base, firmwareVersion: "3.3.0" };
    expect(isWizardStepValid(stale, "frequency")).toBe(true);
    expect(live.versions.some((v) => v.tag === stale.firmwareVersion)).toBe(
      false
    );

    // After: the stored tag is one of the rendered choices, and still valid.
    const firmwareVersion = reconcileSelectedVersion(
      stale.firmwareVersion,
      live
    );
    const fixed = { ...base, firmwareVersion };
    expect(live.versions.some((v) => v.tag === fixed.firmwareVersion)).toBe(
      true
    );
    expect(isWizardStepValid(fixed, "frequency")).toBe(true);
  });
});
