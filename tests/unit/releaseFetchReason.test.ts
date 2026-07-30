import { describe, expect, it } from "vitest";
import { releaseFetchReason } from "@/lib/tauri";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";

/**
 * A GitHub 403 was presented to the user as "Offline".
 *
 * `fetch_from_network` correctly refuses to retry a rate-limit and returns the
 * reason, but StepFrequency's `.catch(() => setReleaseState({ kind: "error" }))`
 * threw it away and rendered the `releasesOffline` chip — telling someone whose
 * network is working perfectly to check their connection, when the actual
 * remedy is to wait out the 60-request/hour unauthenticated quota.
 *
 * The reason now crosses the seam as `{ kind, detail }` (Rust
 * `ReleaseFetchError`, camelCase). These cover the classifier and the copy it
 * selects; the Rust half of the seam is pinned in `flash/github.rs`.
 */
describe("releaseFetchReason", () => {
  it("recognises the typed rejection the Rust command sends", () => {
    expect(
      releaseFetchReason({
        kind: "rateLimited",
        detail: "GitHub release fetch failed: HTTP status client error (403)",
      })
    ).toBe("rateLimited");
    expect(
      releaseFetchReason({ kind: "offline", detail: "connect error" })
    ).toBe("offline");
    expect(releaseFetchReason({ kind: "unknown", detail: "bad JSON" })).toBe(
      "unknown"
    );
  });

  it("degrades to 'unknown' for anything it does not recognise", () => {
    // Older mocks reject with a bare string, and a thrown Error carries no
    // `kind` at all; neither may crash the wizard, and both keep the existing
    // offline copy rather than inventing a rate-limit that didn't happen.
    expect(releaseFetchReason("GitHub release fetch failed")).toBe("unknown");
    expect(releaseFetchReason(new Error("boom"))).toBe("unknown");
    expect(releaseFetchReason(null)).toBe("unknown");
    expect(releaseFetchReason(undefined)).toBe("unknown");
    expect(releaseFetchReason({ kind: "RateLimited" })).toBe("unknown");
  });

  it("degrades a refused redirect to 'unknown', never to 'offline'", () => {
    // FIX 9F: the Rust side now distinguishes a refused redirect (the pinned
    // policy declining to leave github.com) from a flaky network, so the log
    // names the real cause. There is no UI copy for it, and "offline" would be
    // the wrong advice — the network is fine and retrying cannot help — so it
    // must land in the same neutral bucket as a malformed body.
    expect(
      releaseFetchReason({
        kind: "redirectRefused",
        detail: "refused redirect to https://elsewhere.example/x",
      })
    ).toBe("unknown");
  });
});

describe("release fallback copy", () => {
  it("has a distinct rate-limited string in every locale", () => {
    for (const [lng, bundle] of [
      ["en", en],
      ["es", es],
    ] as const) {
      const freq = bundle.wizard.frequency as Record<string, string>;
      expect(freq.releasesRateLimited, lng).toBeTruthy();
      // It must not be the offline copy: the whole point is that the network
      // is fine, so "couldn't reach GitHub" would still be the wrong advice.
      expect(freq.releasesRateLimited, lng).not.toBe(freq.releasesOffline);
    }
  });
});
