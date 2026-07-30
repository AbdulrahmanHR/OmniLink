import { describe, expect, it } from "vitest";
import { findTargetByName, resolveConnectedTarget } from "@/lib/elrsTargets";

/**
 * The connected-device half of the FR-FLASH-10 target guard.
 *
 * The Rust guard (`flash::guard::check_connected_target_name`) compares build
 * targets EXACTLY — it has to, because `BETAFPV_2400_TX` and
 * `BETAFPV_2400_TX_MICRO_1W` overlap but are different radios with different PA
 * tables. The CRSF handshake, however, reports a free-form DISPLAY name
 * ("BetaFPV 2400 TX"), so feeding that raw string to an exact comparison would
 * REFUSE correct, legitimate flashes — and a guard that blocks good flashes gets
 * disabled or worked around, which is worse than no guard.
 *
 * `resolveConnectedTarget` is the seam that keeps the two questions apart:
 *  - RESOLUTION (fuzzy, here): which catalogue model is this device?
 *  - COMPARISON (exact, in Rust): are these two build targets the same radio?
 *
 * Only a resolved catalogue target crosses the seam; anything unresolvable goes
 * over as `null`, on which the guard abstains. These cases pin that contract —
 * the guard's own outcomes are pinned in `src-tauri/src/flash/guard.rs`.
 */
describe("resolveConnectedTarget", () => {
  it("resolves a display name to its catalogue build target (guard can compare)", () => {
    // Normalization alone is enough here: "BetaFPV 2400 TX" ≈ BETAFPV_2400_TX.
    expect(resolveConnectedTarget("BetaFPV 2400 TX")).toBe("BETAFPV_2400_TX");
    expect(resolveConnectedTarget("RadioMaster Ranger 2400")).toBe(
      "RADIOMASTER_RANGER_2400"
    );
    // Already a build target (some builds report one verbatim) — unchanged.
    expect(resolveConnectedTarget("BETAFPV_2400_TX")).toBe("BETAFPV_2400_TX");
  });

  it("keeps the overlapping BetaFPV pair distinct when the name is precise", () => {
    // The exact pass runs across the WHOLE catalogue before the substring pass,
    // so the more specific 1W name can never be collapsed onto the 250mW target.
    expect(resolveConnectedTarget("BetaFPV 2400 TX Micro 1W")).toBe(
      "BETAFPV_2400_TX_MICRO_1W"
    );
    expect(resolveConnectedTarget("BETAFPV_2400_TX_MICRO_1W")).toBe(
      "BETAFPV_2400_TX_MICRO_1W"
    );
  });

  it("returns null for a display name the catalogue cannot map (guard abstains)", () => {
    // THE FALSE-BLOCK REGRESSION. A BetaFPV Nano TX reporting "BetaFPV Nano TX"
    // is a legitimate device for the BETAFPV_2400_TX target, but the strings
    // share no mappable form. Sending the raw name would have blocked the flash;
    // `null` means "no evidence" and the Rust guard lets it through.
    expect(resolveConnectedTarget("BetaFPV Nano TX")).toBeNull();
    // Generic / vendor-less names carry no evidence either.
    expect(resolveConnectedTarget("ELRS Device")).toBeNull();
    expect(resolveConnectedTarget("ExpressLRS")).toBeNull();
  });

  it("returns null for an absent or empty name", () => {
    expect(resolveConnectedTarget(null)).toBeNull();
    expect(resolveConnectedTarget(undefined)).toBeNull();
    expect(resolveConnectedTarget("")).toBeNull();
    // Nothing survives normalization -> no evidence.
    expect(resolveConnectedTarget("___")).toBeNull();
  });

  it("resolves a different device to a different target (guard blocks)", () => {
    // The case the guard exists for: a Ranger is connected, the wizard has a
    // BetaFPV Nano TX selected. Resolution yields a target that is NOT the
    // selected one, which is positive proof of different hardware — the Rust
    // guard turns that into `connectedTargetMismatch`.
    const connected = resolveConnectedTarget("RadioMaster Ranger 2400");
    expect(connected).toBe("RADIOMASTER_RANGER_2400");
    expect(connected).not.toBe("BETAFPV_2400_TX");
  });

  it("abstains on an imprecise in-family name rather than picking a sibling", () => {
    // These two are why resolution here is exact-only. Under a substring pass a
    // display name that is a strict superset of one catalogue target and matches
    // no other resolves to that SHORTER sibling — so a device that really is the
    // longer variant, whose owner correctly selects the longer target, gets a
    // legitimate flash refused. Abstaining costs nothing: the image-vs-target,
    // TX/RX and backpack guards all still run.
    expect(resolveConnectedTarget("BetaFPV 2400 TX Micro")).toBeNull();
    expect(resolveConnectedTarget("RadioMaster Ranger 2400 Nano")).toBeNull();
    // Spelled the catalogue's way, both resolve through the exact pass and the
    // guard has real evidence to work with.
    expect(resolveConnectedTarget("BetaFPV 2400 TX Micro 1W")).toBe(
      "BETAFPV_2400_TX_MICRO_1W"
    );
    expect(resolveConnectedTarget("RadioMaster Ranger Nano 2400")).toBe(
      "RADIOMASTER_RANGER_NANO_2400"
    );
  });
});

describe("findTargetByName", () => {
  it("returns the brand alongside the model for a resolvable name", () => {
    const match = findTargetByName("BetaFPV 2400 TX");
    expect(match?.brand.id).toBe("betafpv");
    expect(match?.model.id).toBe("betafpv-nano-tx-2400");
  });

  it("returns null rather than throwing on an unresolvable or absent name", () => {
    expect(findTargetByName("BetaFPV Nano TX")).toBeNull();
    expect(findTargetByName(null)).toBeNull();
    expect(findTargetByName(undefined)).toBeNull();
  });
});
