import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fork-safety invariants for `.github/workflows/` (M74).
 *
 * A pull request opened from a **fork** receives a **read-only**
 * `GITHUB_TOKEN` and **no repository secrets at all** — `${{ secrets.FOO }}`
 * expands to the empty string. So any job on the `pull_request` path that asks
 * for a write scope, or that needs a secret to succeed, fails for exactly the
 * people the CI is there to help: strangers opening their first PR against a
 * firmware-flashing tool.
 *
 * These tests are the enumeration that M74's acceptance asks for, kept
 * executable so it cannot rot. They are deliberately **stricter than GitHub**:
 * a secret mentioned *anywhere* in a `pull_request`-triggered workflow fails,
 * even if an `if:` guard would have skipped that step, because a mis-edited
 * guard is the exact failure mode worth being paranoid about.
 *
 * ## On not parsing YAML
 *
 * The repository has no YAML parser dependency and this file will not add one
 * for a lint. Instead it does two narrow, well-defined textual things:
 *
 *  - strips `#` comments (so the *prose explaining* a removed `actions: write`
 *    does not read as a request for it); and
 *  - reads the top-level `on:` block as the lines between `^on:` and the next
 *    line starting in column 0.
 *
 * Both hold for every workflow in this repository and for any conventionally
 * formatted Actions file. If a future workflow is written in a shape this
 * scanner misreads, these tests fail loudly rather than passing vacuously —
 * which is the correct direction for a safety check to fail in.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(here, "../../.github/workflows");

/** `GITHUB_TOKEN` is not a repository secret — it is minted per run. */
const AUTO_TOKEN = "GITHUB_TOKEN";

interface Workflow {
  /** Bare filename, e.g. `ci.yml`. */
  name: string;
  /** Whole file, comments stripped. */
  body: string;
  /** The top-level `on:` block, comments stripped. */
  triggerBlock: string;
}

/**
 * Drop `#` comments. Workflow values in this repository never contain a literal
 * `#`, so cutting at the first one per line is safe here and keeps the scanner
 * dependency-free. Shell comments inside `run: |` blocks are comments too, so
 * dropping them is also correct.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

/** Lines between `^on:` and the next column-0 line — the trigger declaration. */
function triggerBlockOf(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const WORKFLOWS: Workflow[] = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort()
  .map((name) => {
    const body = stripComments(readFileSync(path.join(WORKFLOW_DIR, name), "utf8"));
    return { name, body, triggerBlock: triggerBlockOf(body) };
  });

/** Workflows that a fork's pull request can start. */
const PR_WORKFLOWS = WORKFLOWS.filter((w) => /^\s{2}pull_request(_target)?:/m.test(w.triggerBlock));

/** Every `secrets.NAME` reference in a workflow, deduplicated. */
function secretsIn(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) found.add(m[1]);
  return [...found].sort();
}

/** The workflow-level `permissions:` block (column 0), if any. */
function workflowPermissionsOf(body: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^permissions:/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("workflow inventory", () => {
  it("finds the workflow directory and reads every file in it", () => {
    expect(WORKFLOWS.length).toBeGreaterThanOrEqual(5);
    expect(WORKFLOWS.map((w) => w.name)).toContain("ci.yml");
  });

  it("every workflow declares a trigger this scanner can read", () => {
    for (const w of WORKFLOWS) {
      expect(w.triggerBlock.trim(), `${w.name}: no readable top-level on: block`).not.toBe("");
    }
  });
});

describe("no secret is reachable from a pull request", () => {
  // The enumeration itself. Adding a `pull_request` trigger to a workflow that
  // touches a secret must be a deliberate, reviewed act — so the expected set
  // is written down, and widening it means editing this line.
  it("exactly one workflow runs on pull_request, and it is the CI suite", () => {
    expect(PR_WORKFLOWS.map((w) => w.name)).toEqual(["ci.yml"]);
  });

  it("no pull_request-triggered workflow references a repository secret", () => {
    for (const w of PR_WORKFLOWS) {
      const repoSecrets = secretsIn(w.body).filter((s) => s !== AUTO_TOKEN);
      expect(repoSecrets, `${w.name} references repository secrets`).toEqual([]);
    }
  });

  it("the three installer builds and the release pipeline stay off the PR path", () => {
    const signing = ["linux-build.yml", "macos-build.yml", "windows-build.yml", "release.yml"];
    for (const name of signing) {
      const w = WORKFLOWS.find((x) => x.name === name);
      expect(w, `${name} is missing`).toBeDefined();
      // Each of these needs TAURI_SIGNING_PRIVATE_KEY, so it must never be
      // startable by a fork's pull request.
      expect(secretsIn(w!.body)).toContain("TAURI_SIGNING_PRIVATE_KEY");
      expect(w!.triggerBlock, `${name} must not trigger on pull_request`).not.toMatch(
        /pull_request/
      );
    }
  });

  it("Crowdin sync stays manual-only — its token must never be on an automatic path", () => {
    const w = WORKFLOWS.find((x) => x.name === "crowdin-sync.yml");
    expect(w).toBeDefined();
    expect(secretsIn(w!.body)).toContain("CROWDIN_PERSONAL_TOKEN");
    expect(w!.triggerBlock).not.toMatch(/push|pull_request|schedule/);
    expect(w!.triggerBlock).toMatch(/workflow_dispatch/);
  });
});

describe("least privilege", () => {
  it("no workflow requests `actions: write` — the prune step is gone for good", () => {
    // The artifact-prune steps deleted at M74 were the only reason any workflow
    // asked for this scope. A fork's read-only token cannot grant it, so a
    // reappearance means a guaranteed red run on every fork PR.
    for (const w of WORKFLOWS) {
      expect(w.body, `${w.name} requests actions: write`).not.toMatch(/actions:\s*write/);
    }
  });

  it("no workflow deletes artifacts through the API", () => {
    for (const w of WORKFLOWS) {
      expect(w.body, `${w.name} still deletes artifacts`).not.toMatch(/-X\s+DELETE/);
    }
  });

  it("every pull_request-triggered workflow declares read-only permissions up front", () => {
    for (const w of PR_WORKFLOWS) {
      const perms = workflowPermissionsOf(w.body);
      expect(perms, `${w.name}: no workflow-level permissions: block`).not.toBeNull();
      expect(perms).toMatch(/contents:\s*read/);
      expect(perms, `${w.name}: workflow-level permissions grant a write scope`).not.toMatch(
        /:\s*write/
      );
    }
  });

  it("no job inside a pull_request-triggered workflow escalates to a write scope", () => {
    for (const w of PR_WORKFLOWS) {
      // Job-level `permissions:` are indented; the workflow-level one is not.
      const jobLevel = w.body.split("\n").filter((l) => /^\s+permissions:/.test(l));
      expect(jobLevel, `${w.name}: unexpected job-level permissions block`).toEqual([]);
    }
  });
});

describe("pinned test workers", () => {
  /**
   * Both suites flake under default worker counts on this project — the two
   * timing-sensitive ML specs (`mlInferenceBudget`, `v25PrivacyAudit`) and
   * Playwright's MapLibre/GPU contention. The pin lives in the two test
   * CONFIGS, not in the npm scripts, so every invocation path inherits it: the
   * npm scripts, a bare `vitest` / `npx playwright test`, an IDE runner, and CI.
   *
   * The npm script was tried first and rejected on evidence: vitest hard-errors
   * on a duplicated flag (`Expected a single value for option "--maxWorkers"`),
   * so `--maxWorkers=2` baked into `npm test` breaks the project's own
   * documented gate command `npm run test -- --maxWorkers=2`. A config value is
   * overridable by the CLI; a script flag collides with it.
   */
  const configOf = (file: string) => readFileSync(path.resolve(here, "../../", file), "utf8");

  it("vitest pins maxWorkers in its config", () => {
    expect(configOf("vitest.config.ts")).toMatch(/maxWorkers:\s*2/);
  });

  it("Playwright pins workers in its config", () => {
    expect(configOf("playwright.config.ts")).toMatch(/workers:\s*2/);
  });

  it("the npm scripts stay flag-free so an explicit override still works", () => {
    const pkg = JSON.parse(configOf("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).not.toMatch(/--maxWorkers/);
    expect(pkg.scripts.e2e).not.toMatch(/--workers/);
  });

  it("CI runs the suites through those scripts, so it inherits the pin", () => {
    const ci = WORKFLOWS.find((w) => w.name === "ci.yml")!.body;
    expect(ci).toMatch(/run:\s*npm test\b/);
    expect(ci).toMatch(/run:\s*npm run e2e\b/);
  });
});
