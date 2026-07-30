import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignFileNames,
  contentFingerprint,
  diffFolderSync,
  isActionable,
  isValidProfileFileName,
  keepBothFileName,
  keepBothProfileName,
  parseFolderSyncError,
  profileFileName,
  sameContent,
  summarizeFolderSync,
  type FolderFileSide,
  type LocalProfileSide,
} from "@/lib/folderSync";
import {
  ELRSP_SCHEMA_VERSION,
  parseElrsp,
  serializeElrsp,
  type ElrspDocument,
} from "@/lib/elrsp";
import type { ProfileSettings } from "@/lib/profileSettings";

/**
 * M71 — user-owned folder sync (decision D37).
 *
 * Two halves:
 *  1. the PURE model (`lib/folderSync.ts`) — file naming, content identity, the
 *     four-way classification, keep-both naming, error parsing;
 *  2. the folder-backed source in `stores/profiles.ts`, driven through an
 *     in-memory stand-in for the six `folder-sync` Rust commands, which is where
 *     the round-trip and never-silently-overwrite acceptances are proven.
 *
 * No filesystem, no clock and no network are touched: the pure module has no I/O
 * at all, and the store half talks to the fake seam below.
 */

const SETTINGS: ProfileSettings = {
  packetRate: 500,
  telemetryRatio: "1:64",
  switchMode: "Wide",
  txPower: 250,
  dynamicPower: true,
  modelMatch: false,
  modelId: 3,
  bindingPhrase: "my-quad",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

function doc(overrides: Partial<ElrspDocument> = {}): ElrspDocument {
  return {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name: "Race 250",
    settings: { ...SETTINGS },
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function local(
  id: string,
  name: string,
  overrides: Partial<ElrspDocument> = {}
): LocalProfileSide {
  return { id, name, doc: doc({ name, ...overrides }) };
}

function folder(
  fileName: string,
  overrides: Partial<ElrspDocument> = {}
): FolderFileSide {
  return {
    fileName,
    doc: doc({ name: fileName.replace(/\.elrsp$/, ""), ...overrides }),
    modifiedAt: 1_700_000_100_000,
  };
}

// ---------------------------------------------------------------------------
// 1. File naming — the folder must stay legible AND portable.
// ---------------------------------------------------------------------------

describe("profileFileName", () => {
  it("keeps an ordinary profile name readable", () => {
    expect(profileFileName("Race 250 Hz (EU)")).toBe("Race 250 Hz (EU).elrsp");
    expect(profileFileName("Añejo — vuelo suave")).toBe(
      "Añejo — vuelo suave.elrsp"
    );
  });

  it("neutralises every character that could name a path", () => {
    expect(profileFileName("../../etc/passwd")).toBe("-etc-passwd.elrsp");
    expect(profileFileName("C:\\Windows\\System32")).toBe(
      "C-Windows-System32.elrsp"
    );
    expect(profileFileName("a/b")).toBe("a-b.elrsp");
    expect(profileFileName("..")).toBe("-.elrsp");
    expect(profileFileName("with\u0000nul")).toBe("with-nul.elrsp");
  });

  it("refuses to produce a hidden file, an empty name or a trailing dot/space", () => {
    expect(profileFileName(".hidden")).toBe("hidden.elrsp");
    expect(profileFileName("   ")).toBe("profile.elrsp");
    expect(profileFileName("")).toBe("profile.elrsp");
    expect(profileFileName("trailing.")).toBe("trailing.elrsp");
    expect(profileFileName("trailing ")).toBe("trailing.elrsp");
  });

  it("prefixes a Windows reserved device name instead of dropping it", () => {
    expect(profileFileName("CON")).toBe("_CON.elrsp");
    expect(profileFileName("nul")).toBe("_nul.elrsp");
    expect(profileFileName("LPT9.backup")).toBe("_LPT9.backup.elrsp");
  });

  it("does not double the extension for a profile literally named *.elrsp", () => {
    expect(profileFileName("Race.elrsp")).toBe("Race.elrsp");
  });

  it("truncates to the byte cap the Rust guard enforces", () => {
    const name = profileFileName("é".repeat(200));
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(128);
    expect(isValidProfileFileName(name)).toBe(true);
  });

  it("NEVER produces a name the backend guard would refuse", () => {
    // The TS side generates and the Rust side verifies; if these two ever
    // disagree, a push fails with `invalid-name` instead of writing a file.
    // `isValidProfileFileName` mirrors `folder_sync::validate_file_name`.
    const hostile = [
      "../../etc/passwd",
      "/etc/passwd",
      "..\\escape",
      "C:escape",
      "\\\\server\\share\\x",
      "Race.elrsp:hidden",
      "CON",
      "aux.elrsp",
      "trailing. ",
      ".",
      "..",
      "...",
      "",
      "    ",
      "\u0000\u001f",
      "x".repeat(500),
      "é".repeat(300),
      "a|b?c*d<e>f\"g",
      "tab\tnewline\n",
    ];
    for (const name of hostile) {
      expect(
        isValidProfileFileName(profileFileName(name)),
        `profileFileName(${JSON.stringify(name)}) produced a name the guard refuses`
      ).toBe(true);
    }
  });
});

describe("isValidProfileFileName", () => {
  it("accepts exactly what the Rust guard accepts", () => {
    expect(isValidProfileFileName("Race 250 Hz (EU).elrsp")).toBe(true);
    expect(isValidProfileFileName("Race.v2.elrsp")).toBe(true);
  });

  it("refuses traversal, absolute, reserved and non-.elrsp names", () => {
    for (const name of [
      "",
      "../escape.elrsp",
      "..",
      "a/b.elrsp",
      "a\\b.elrsp",
      "C:x.elrsp",
      "x.elrsp:ads.elrsp",
      ".elrsp",
      ".hidden.elrsp",
      "Race.json",
      "Race.ELRSP",
      "Race.elrsp.bak",
      "CON.elrsp",
      "Race .elrsp",
      "Race..elrsp",
      "Race\u0000.elrsp",
      `${"x".repeat(130)}.elrsp`,
    ]) {
      expect(
        isValidProfileFileName(name),
        `${JSON.stringify(name)} should be refused`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Content identity.
// ---------------------------------------------------------------------------

describe("contentFingerprint / sameContent", () => {
  it("ignores updatedAt — two machines saving the same profile are not a conflict", () => {
    expect(
      sameContent(doc({ updatedAt: 1 }), doc({ updatedAt: 999_999 }))
    ).toBe(true);
  });

  it("notices any settings difference", () => {
    expect(
      sameContent(doc(), doc({ settings: { ...SETTINGS, txPower: 500 } }))
    ).toBe(false);
  });

  it("notices metadata differences (name, description, tags, firmware)", () => {
    expect(sameContent(doc(), doc({ name: "Other" }))).toBe(false);
    expect(sameContent(doc(), doc({ description: "note" }))).toBe(false);
    expect(sameContent(doc(), doc({ tags: ["race"] }))).toBe(false);
    expect(sameContent(doc(), doc({ firmwareVersion: "3.5.3" }))).toBe(false);
  });

  it("is the on-disk bytes with the timestamp zeroed (one serialiser, not two)", () => {
    expect(contentFingerprint(doc({ updatedAt: 42 }))).toBe(
      serializeElrsp(doc({ updatedAt: 0 }))
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The four-way diff.
// ---------------------------------------------------------------------------

describe("diffFolderSync", () => {
  it("classifies all four states", () => {
    const entries = diffFolderSync(
      [
        local("p1", "Only Local"),
        local("p2", "Both Same"),
        local("p3", "Both Different"),
      ],
      [
        folder("Both Same.elrsp", { name: "Both Same" }),
        folder("Both Different.elrsp", {
          name: "Both Different",
          settings: { ...SETTINGS, packetRate: 250 },
        }),
        folder("Only Folder.elrsp"),
      ]
    );

    const byName = new Map(entries.map((e) => [e.fileName, e]));
    expect(byName.get("Only Local.elrsp")?.status).toBe("local-only");
    expect(byName.get("Only Folder.elrsp")?.status).toBe("folder-only");
    expect(byName.get("Both Same.elrsp")?.status).toBe("same");
    expect(byName.get("Both Different.elrsp")?.status).toBe("conflict");

    // A conflict carries BOTH sides, so the UI can show them side by side —
    // this is what makes "never silently overwrite" possible at all.
    const conflict = byName.get("Both Different.elrsp");
    expect(conflict?.local?.id).toBe("p3");
    expect(conflict?.folder?.doc.settings.packetRate).toBe(250);
    expect(conflict?.local?.doc.settings.packetRate).toBe(500);
  });

  it("is total: every profile and every file appears exactly once", () => {
    const locals = [local("p1", "A"), local("p2", "B"), local("p3", "C")];
    const files = [folder("B.elrsp", { name: "B" }), folder("D.elrsp")];
    const entries = diffFolderSync(locals, files);

    expect(entries).toHaveLength(4); // A, B, C, D
    expect(entries.filter((e) => e.local !== null)).toHaveLength(3);
    expect(entries.filter((e) => e.folder !== null)).toHaveLength(2);
    expect(new Set(entries.map((e) => e.fileName)).size).toBe(4);
  });

  it("matches case-insensitively, because Windows and macOS do", () => {
    const entries = diffFolderSync([local("p1", "Race")], [folder("race.elrsp", { name: "Race" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("same");
    // The folder's spelling wins for display: it is what is actually on disk.
    expect(entries[0]?.fileName).toBe("race.elrsp");
  });

  it("is sorted by file name so the list does not jump between refreshes", () => {
    const entries = diffFolderSync(
      [local("p1", "zulu"), local("p2", "Alpha"), local("p3", "mike")],
      []
    );
    expect(entries.map((e) => e.fileName)).toEqual([
      "Alpha.elrsp",
      "mike.elrsp",
      "zulu.elrsp",
    ]);
  });

  it("gives two identically-named local profiles distinct files", () => {
    const entries = diffFolderSync([local("p1", "Race"), local("p2", "Race")], []);
    expect(entries.map((e) => e.fileName).sort()).toEqual([
      "Race (2).elrsp",
      "Race.elrsp",
    ]);
    // Neither profile is dropped — a case-insensitive filesystem would
    // otherwise merge them and silently lose one.
    expect(new Set(entries.map((e) => e.local?.id))).toEqual(
      new Set(["p1", "p2"])
    );
  });

  it("assigns file names deterministically in library order", () => {
    const assigned = assignFileNames([
      local("p1", "Race"),
      local("p2", "Race"),
      local("p3", "Race"),
    ]);
    expect(assigned.get("p1")).toBe("Race.elrsp");
    expect(assigned.get("p2")).toBe("Race (2).elrsp");
    expect(assigned.get("p3")).toBe("Race (3).elrsp");
  });

  it("summarises and flags what still needs a decision", () => {
    const entries = diffFolderSync(
      [local("p1", "A"), local("p2", "B")],
      [folder("B.elrsp", { name: "B" }), folder("C.elrsp")]
    );
    expect(summarizeFolderSync(entries)).toEqual({
      "local-only": 1,
      "folder-only": 1,
      same: 1,
      conflict: 0,
    });
    expect(entries.filter(isActionable)).toHaveLength(2);
  });
});

describe("keep-both naming", () => {
  it("picks the first free numbered file name", () => {
    expect(keepBothFileName("Race.elrsp", [])).toBe("Race (2).elrsp");
    expect(keepBothFileName("Race.elrsp", ["Race (2).elrsp"])).toBe(
      "Race (3).elrsp"
    );
    // Case-insensitive, like the filesystems it has to survive.
    expect(keepBothFileName("Race.elrsp", ["race (2).elrsp"])).toBe(
      "Race (3).elrsp"
    );
  });

  it("picks the first free numbered profile name", () => {
    expect(keepBothProfileName("Race", ["Race"])).toBe("Race (2)");
    expect(keepBothProfileName("Race", ["Race", "race (2)"])).toBe("Race (3)");
  });
});

describe("parseFolderSyncError", () => {
  it("splits the backend `<code>: <detail>` contract", () => {
    expect(parseFolderSyncError("invalid-name: '../x': nope")).toEqual({
      code: "invalid-name",
      detail: "'../x': nope",
    });
    expect(parseFolderSyncError("not-granted: no folder has been granted")).toEqual({
      code: "not-granted",
      detail: "no folder has been granted",
    });
  });

  it("degrades an unrecognised message to `io` without swallowing it", () => {
    const parsed = parseFolderSyncError("Command plugin:folder-sync|read not allowed by ACL");
    expect(parsed.code).toBe("io");
    expect(parsed.detail).toBe("Command plugin:folder-sync|read not allowed by ACL");
  });
});

// ---------------------------------------------------------------------------
// 4. The folder-backed source, over an in-memory stand-in for the Rust plugin.
// ---------------------------------------------------------------------------

const core = vi.hoisted(() => ({ isTauriValue: true }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => core.isTauriValue,
  invoke: vi.fn(() => Promise.reject(new Error("no tauri in test"))),
}));

/**
 * A stand-in for the six `folder-sync` commands: one `Map` playing the part of
 * the granted directory. It enforces the two properties the Rust side enforces
 * that the store depends on — nothing is reachable before a grant, and a name
 * the guard would refuse is refused here too.
 */
const fake = vi.hoisted(() => {
  const files = new Map<string, { contents: string; modifiedAt: number }>();
  const state = { granted: null as string | null, clock: 1_700_000_000_000 };
  return { files, state };
});

vi.mock("@/lib/tauri", async () => {
  const { isValidProfileFileName } = await import("@/lib/folderSync");
  const requireGrant = () => {
    if (fake.state.granted === null) {
      throw new Error("not-granted: no folder has been granted");
    }
  };
  const requireName = (name: string) => {
    if (!isValidProfileFileName(name)) {
      throw new Error(`invalid-name: '${name}': refused by the guard`);
    }
  };
  return {
    // Local profile persistence (unused here beyond being callable).
    saveProfile: vi.fn(() => Promise.resolve()),
    deleteStoredProfile: vi.fn(() => Promise.resolve()),
    loadProfiles: vi.fn(() => Promise.resolve([])),
    // Folder sync.
    grantSyncFolder: vi.fn((path: string) => {
      fake.state.granted = path;
      return Promise.resolve({ path, fileCount: fake.files.size });
    }),
    revokeSyncFolder: vi.fn(() => {
      fake.state.granted = null;
      return Promise.resolve();
    }),
    listSyncFolder: vi.fn(() => {
      requireGrant();
      return Promise.resolve(
        [...fake.files.entries()]
          .map(([name, f]) => ({
            name,
            modifiedAt: f.modifiedAt,
            size: f.contents.length,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1))
      );
    }),
    readSyncFolderFile: vi.fn((name: string) => {
      requireGrant();
      requireName(name);
      const file = fake.files.get(name);
      if (!file) return Promise.reject(new Error(`io: ${name} not found`));
      return Promise.resolve(file.contents);
    }),
    writeSyncFolderFile: vi.fn((name: string, contents: string) => {
      requireGrant();
      requireName(name);
      fake.state.clock += 1000;
      fake.files.set(name, { contents, modifiedAt: fake.state.clock });
      return Promise.resolve({
        name,
        modifiedAt: fake.state.clock,
        size: contents.length,
      });
    }),
    deleteSyncFolderFile: vi.fn((name: string) => {
      requireGrant();
      requireName(name);
      fake.files.delete(name);
      return Promise.resolve();
    }),
  };
});

const { useProfilesStore, selectFolderEntries } = await import("@/stores/profiles");

/** The store, reset to a bare library with no folder configured. */
function resetStore(): void {
  useProfilesStore.setState({
    userProfiles: [],
    profiles: useProfilesStore.getState().profiles.filter((p) => p.builtin),
    folderPath: null,
    folderFiles: [],
    folderUnreadable: [],
    folderPhase: "idle",
    folderError: null,
    folderBusy: null,
  });
}

/** Create a user profile with the given settings and return its id. */
function makeProfile(name: string, settings: ProfileSettings): string {
  useProfilesStore.setState({ activeSettings: { ...settings } });
  return useProfilesStore.getState().saveCurrentAsProfile(name);
}

const store = () => useProfilesStore.getState();
const entryFor = (fileName: string) =>
  selectFolderEntries(store()).find((e) => e.fileName === fileName);

beforeEach(() => {
  core.isTauriValue = true;
  fake.files.clear();
  fake.state.granted = null;
  fake.state.clock = 1_700_000_000_000;
  resetStore();
});

describe("the folder-backed source is inert until a folder is chosen", () => {
  it("starts idle with no folder, no files and no error", () => {
    expect(store().folderPath).toBeNull();
    expect(store().folderPhase).toBe("idle");
    expect(store().folderFiles).toEqual([]);
    expect(selectFolderEntries(store())).toEqual([]);
  });

  it("every folder action is a no-op with no folder configured", async () => {
    const id = makeProfile("Race", SETTINGS);
    await store().refreshFolder();
    await store().pushToFolder("Race.elrsp", id);
    await store().pullFromFolder("Race.elrsp");
    await store().removeFromFolder("Race.elrsp");
    await store().keepBothFromFolder("Race.elrsp");

    expect(fake.files.size).toBe(0);
    expect(fake.state.granted).toBeNull();
    expect(store().folderPhase).toBe("idle");
    expect(store().folderError).toBeNull();
    // The local library is exactly what it was.
    expect(store().userProfiles.map((p) => p.name)).toEqual(["Race"]);
  });

  it("presets are never mirrored into the folder — only user profiles are", async () => {
    await store().chooseFolder("/sync");
    // The library has factory presets but no user profiles.
    expect(store().profiles.some((p) => p.builtin)).toBe(true);
    expect(selectFolderEntries(store())).toEqual([]);
  });
});

describe("round-trip through the folder", () => {
  it("push → delete locally → pull back yields BYTE-IDENTICAL settings", async () => {
    const id = makeProfile("Race 250", SETTINGS);
    const original = store().userProfiles.find((p) => p.id === id);
    const originalSettingsJson = JSON.stringify(original?.settings);

    await store().chooseFolder("/sync");
    expect(store().folderPhase).toBe("ready");
    expect(entryFor("Race 250.elrsp")?.status).toBe("local-only");

    // 1. Push.
    await store().pushToFolder("Race 250.elrsp", id);
    const onDisk = fake.files.get("Race 250.elrsp")?.contents ?? "";
    expect(onDisk).not.toBe("");
    expect(entryFor("Race 250.elrsp")?.status).toBe("same");

    // 2. Delete locally. The folder file is NOT touched by a local delete.
    store().deleteProfile(id);
    expect(store().userProfiles).toHaveLength(0);
    expect(fake.files.get("Race 250.elrsp")?.contents).toBe(onDisk);

    await store().refreshFolder();
    expect(entryFor("Race 250.elrsp")?.status).toBe("folder-only");

    // 3. Pull it back.
    await store().pullFromFolder("Race 250.elrsp");
    const restored = store().userProfiles.find((p) => p.name === "Race 250");
    expect(restored).toBeDefined();

    // Byte-identical settings, three ways: against the original profile, against
    // the bytes that are still on disk, and unchanged bytes after the pull.
    expect(JSON.stringify(restored?.settings)).toBe(originalSettingsJson);
    expect(JSON.stringify(parseElrsp(onDisk).settings)).toBe(originalSettingsJson);
    expect(restored?.settings).toEqual(SETTINGS);
    expect(fake.files.get("Race 250.elrsp")?.contents).toBe(onDisk);
    expect(entryFor("Race 250.elrsp")?.status).toBe("same");
  });

  it("the file on disk is the pretty `.elrsp` document, nothing wrapped around it", async () => {
    const id = makeProfile("Race 250", SETTINGS);
    await store().chooseFolder("/sync");
    await store().pushToFolder("Race 250.elrsp", id);

    const onDisk = fake.files.get("Race 250.elrsp")?.contents ?? "";
    const parsed = parseElrsp(onDisk);
    expect(parsed.name).toBe("Race 250");
    expect(parsed.schemaVersion).toBe(ELRSP_SCHEMA_VERSION);
    // Human-readable: 2-space-indented JSON, i.e. exactly `serializeElrsp`.
    expect(onDisk).toBe(serializeElrsp(parsed));
    expect(onDisk).toContain('\n  "settings"');
    // No index, no manifest, no database — one file, and that is all.
    expect([...fake.files.keys()]).toEqual(["Race 250.elrsp"]);
  });
});

describe("a conflict is never resolved silently", () => {
  /** Local "Race" ≠ folder "Race.elrsp" — the same name, different content. */
  async function stageConflict(): Promise<string> {
    const id = makeProfile("Race", SETTINGS);
    fake.files.set("Race.elrsp", {
      contents: serializeElrsp(
        doc({
          name: "Race",
          settings: { ...SETTINGS, packetRate: 50, txPower: 25 },
          updatedAt: 1_700_000_500_000,
        })
      ),
      modifiedAt: 1_700_000_500_000,
    });
    await store().chooseFolder("/sync");
    return id;
  }

  it("detecting one changes neither side", async () => {
    const id = await stageConflict();
    const before = fake.files.get("Race.elrsp")?.contents;

    const entry = entryFor("Race.elrsp");
    expect(entry?.status).toBe("conflict");
    // Both sides are present for the UI to show, with their timestamps.
    expect(entry?.local?.doc.settings.packetRate).toBe(500);
    expect(entry?.folder?.doc.settings.packetRate).toBe(50);
    expect(entry?.folder?.modifiedAt).toBe(1_700_000_500_000);

    // A refresh (the only automatic-looking step) resolves nothing.
    await store().refreshFolder();
    expect(entryFor("Race.elrsp")?.status).toBe("conflict");
    expect(fake.files.get("Race.elrsp")?.contents).toBe(before);
    expect(
      store().userProfiles.find((p) => p.id === id)?.settings.packetRate
    ).toBe(500);
  });

  it("keep-mine overwrites only the folder side, on an explicit push", async () => {
    const id = await stageConflict();
    await store().pushToFolder("Race.elrsp", id);
    expect(parseElrsp(fake.files.get("Race.elrsp")!.contents).settings.packetRate).toBe(500);
    expect(entryFor("Race.elrsp")?.status).toBe("same");
  });

  it("keep-theirs overwrites only the local side, on an explicit pull", async () => {
    const id = await stageConflict();
    const before = fake.files.get("Race.elrsp")?.contents;
    await store().pullFromFolder("Race.elrsp");
    expect(store().userProfiles.find((p) => p.id === id)?.settings.packetRate).toBe(50);
    // Pull is not a write: the file is untouched.
    expect(fake.files.get("Race.elrsp")?.contents).toBe(before);
    expect(entryFor("Race.elrsp")?.status).toBe("same");
    // …and it upserted rather than duplicated.
    expect(store().userProfiles).toHaveLength(1);
  });

  it("keep-both loses nothing and converges: two files, two profiles, no conflict", async () => {
    await stageConflict();
    await store().keepBothFromFolder("Race.elrsp");

    // Two files in the folder and two profiles locally.
    expect([...fake.files.keys()].sort()).toEqual([
      "Race (2).elrsp",
      "Race.elrsp",
    ]);
    expect(store().userProfiles.map((p) => p.name).sort()).toEqual([
      "Race",
      "Race (2)",
    ]);
    // The suffixed side holds MY version, the original holds theirs — both
    // survive, and nothing was overwritten.
    expect(
      parseElrsp(fake.files.get("Race (2).elrsp")!.contents).settings.packetRate
    ).toBe(500);
    expect(
      parseElrsp(fake.files.get("Race.elrsp")!.contents).settings.packetRate
    ).toBe(50);

    await store().refreshFolder();
    const entries = selectFolderEntries(store());
    expect(entries.map((e) => e.status)).toEqual(["same", "same"]);
    expect(summarizeFolderSync(entries).conflict).toBe(0);
  });
});

describe("failures surface as codes, never as silent no-ops", () => {
  it("reports a refused file name without touching the folder", async () => {
    const id = makeProfile("Race", SETTINGS);
    await store().chooseFolder("/sync");
    await store().pushToFolder("../escape.elrsp", id);

    expect(store().folderError?.code).toBe("invalid-name");
    expect(store().folderBusy).toBeNull();
    expect(fake.files.size).toBe(0);

    store().clearFolderError();
    expect(store().folderError).toBeNull();
  });

  it("keeps the chosen path when a grant fails, so the user can retry", async () => {
    await store().chooseFolder("/sync");
    expect(store().folderPath).toBe("/sync");

    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.grantSyncFolder).mockRejectedValueOnce(
      new Error("io: resolve folder: No such file or directory")
    );
    await store().chooseFolder("/sync");

    expect(store().folderPhase).toBe("error");
    expect(store().folderError?.code).toBe("io");
    expect(store().folderPath).toBe("/sync");
  });

  it("reports an unparseable file instead of hiding or deleting it", async () => {
    fake.files.set("Broken.elrsp", { contents: "{ not json", modifiedAt: 1 });
    await store().chooseFolder("/sync");

    expect(store().folderUnreadable.map((f) => f.fileName)).toEqual([
      "Broken.elrsp",
    ]);
    expect(store().folderFiles).toEqual([]);
    // Still on disk: never delete the user's own file.
    expect(fake.files.has("Broken.elrsp")).toBe(true);
    // A readable file alongside it still syncs.
    fake.files.set("Fine.elrsp", {
      contents: serializeElrsp(doc({ name: "Fine" })),
      modifiedAt: 2,
    });
    await store().refreshFolder();
    expect(store().folderFiles.map((f) => f.fileName)).toEqual(["Fine.elrsp"]);
    expect(store().folderUnreadable).toHaveLength(1);
  });

  it("forgetting the folder revokes the grant and clears the derived state", async () => {
    makeProfile("Race", SETTINGS);
    await store().chooseFolder("/sync");
    expect(fake.state.granted).toBe("/sync");

    await store().forgetFolder();
    expect(store().folderPath).toBeNull();
    expect(store().folderPhase).toBe("idle");
    expect(store().folderFiles).toEqual([]);
    expect(fake.state.granted).toBeNull();
    // The local library is untouched by forgetting — every entry is back to
    // being local-only, with no folder side at all.
    const entries = selectFolderEntries(store());
    expect(entries.map((e) => e.status)).toEqual(["local-only"]);
    expect(entries.every((e) => e.folder === null)).toBe(true);
  });

  it("removing a file from the folder leaves the local profile alone", async () => {
    const id = makeProfile("Race", SETTINGS);
    await store().chooseFolder("/sync");
    await store().pushToFolder("Race.elrsp", id);
    expect(fake.files.size).toBe(1);

    await store().removeFromFolder("Race.elrsp");
    expect(fake.files.size).toBe(0);
    expect(store().userProfiles.find((p) => p.id === id)).toBeDefined();
    expect(entryFor("Race.elrsp")?.status).toBe("local-only");
  });
});
