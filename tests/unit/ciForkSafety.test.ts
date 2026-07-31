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

/** The three workflows that build and sign installers off the PR path. */
const INSTALLER_WORKFLOWS = ["linux-build.yml", "macos-build.yml", "windows-build.yml"];

/** This repository, as the fork guards spell it. */
const UPSTREAM_REPO = "AbdulrahmanHR/OmniLink";

/**
 * Triggers that hand a workflow **write access and full secrets while running
 * code or context an outsider controls**. Unlike `pull_request` — which runs a
 * fork's code with a read-only token and no secrets — every one of these runs
 * in the *upstream* trust context:
 *
 *  - `pull_request_target` — fork's PR, upstream's secrets and write token;
 *  - `workflow_run` — same, chained off another workflow's completion;
 *  - `issue_comment` — fires on any stranger's comment;
 *  - `repository_dispatch` — fires on an API call.
 *
 * None belongs in this repository at any privilege level, so the ban is flat
 * and unconditional rather than a property of the `PR_WORKFLOWS` grouping.
 */
const FORBIDDEN_TRIGGERS = [
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "repository_dispatch",
];

/** Every `uses:` reference in a workflow, in file order. */
function usesIn(body: string): string[] {
  return [...body.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
}

/**
 * Every `run:` script in a workflow. Handles both the inline form (`run: cmd`)
 * and the block form (`run: |`), whose body is every following line indented
 * past the `run:` key itself.
 */
function runBlocksOf(body: string): string[] {
  const lines = body.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyColumn = lines[i].indexOf("run:");
    const inline = m[1].trim();
    if (!/^[|>]/.test(inline)) {
      blocks.push(inline);
      continue;
    }
    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        collected.push("");
        continue;
      }
      if (line.length - line.trimStart().length <= keyColumn) break;
      collected.push(line);
    }
    blocks.push(collected.join("\n"));
  }
  return blocks;
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

describe("no workflow runs in an outsider-controlled trust context", () => {
  /**
   * This is the load-bearing check, and it is deliberately NOT expressed in
   * terms of `PR_WORKFLOWS`.
   *
   * `PR_WORKFLOWS` is selected by `/^\s{2}pull_request(_target)?:/m`, which
   * lumps the two triggers into one class. Every other test in this file then
   * reasons about that class on the assumption that a fork PR gets a read-only
   * token and no secrets — true for `pull_request`, FALSE for
   * `pull_request_target`, which runs in the upstream context with full secrets
   * and a write token. Flipping `ci.yml` to `pull_request_target:` therefore
   * satisfies every grouped test while handing a stranger's branch the keys.
   *
   * So this test scans all workflows for the literal trigger names and does not
   * consult the grouping at all. Comments are stripped first, so prose *about*
   * these triggers (including the paragraph you are reading, were it ever
   * copied into a workflow) does not trip it — only a real declaration does.
   */
  it.each(FORBIDDEN_TRIGGERS)("no workflow declares %s, anywhere, ever", (trigger) => {
    for (const w of WORKFLOWS) {
      expect(w.body, `${w.name} declares the ${trigger} trigger`).not.toMatch(
        new RegExp(`\\b${trigger}\\b`)
      );
    }
  });

  it("the only automatic outside-contributor path is plain pull_request", () => {
    // Belt and braces for the test above: whatever the grouping regex decides,
    // the set of workflows reachable from an outsider stays exactly {ci.yml}.
    const reachable = WORKFLOWS.filter((w) => /pull_request/.test(w.triggerBlock));
    expect(reachable.map((w) => w.name)).toEqual(["ci.yml"]);
    for (const w of reachable) {
      expect(w.triggerBlock, `${w.name}: must be plain pull_request`).toMatch(
        /^\s{2}pull_request:/m
      );
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

describe("the installer builds refuse to run in a fork", () => {
  /**
   * Each of these three runs on `push:` to `main`/`v3` and needs the signing
   * key. A fork inherits the workflow files, so without a repository guard a
   * stranger who forks and pushes gets an immediately-red build they cannot fix
   * — on macOS and Windows runners, billed at 10× and 2× the Linux minute rate
   * against their own free allowance.
   *
   * The guard is one `if:` line per file and nothing else referenced it: before
   * these tests, `AbdulrahmanHR` appeared ZERO times in this suite, so all three
   * could be deleted with every test still green.
   */
  it.each(INSTALLER_WORKFLOWS)("%s guards on the upstream repository", (name) => {
    const w = WORKFLOWS.find((x) => x.name === name);
    expect(w, `${name} is missing`).toBeDefined();
    expect(w!.body, `${name}: missing the github.repository fork guard`).toMatch(
      new RegExp(`github\\.repository\\s*==\\s*'${UPSTREAM_REPO}'`)
    );
  });

  it.each(INSTALLER_WORKFLOWS)("%s declares read-only permissions up front", (name) => {
    const w = WORKFLOWS.find((x) => x.name === name)!;
    const perms = workflowPermissionsOf(w.body);
    expect(perms, `${name}: no workflow-level permissions: block`).not.toBeNull();
    expect(perms, `${name}: workflow-level permissions must grant contents: read`).toMatch(
      /contents:\s*read/
    );
  });
});

describe("least privilege", () => {
  it("every workflow declares a workflow-level permissions block", () => {
    // Without one, a workflow inherits the repository default, which can be
    // read/write for the whole GITHUB_TOKEN. Stating the floor in every file
    // means a newly added job starts with no write scope unless its author
    // deliberately overrides it — and the override is then visible in review.
    for (const w of WORKFLOWS) {
      expect(
        workflowPermissionsOf(w.body),
        `${w.name}: no column-0 permissions: block`
      ).not.toBeNull();
    }
  });

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

describe("supply chain", () => {
  /**
   * A third-party action referenced by tag or branch is a promise, not a
   * pointer: `@stable` and `@v0` are mutable refs the upstream owner can
   * repoint at any commit, and a compromised upstream then executes inside a
   * job holding the release signing key. Four of the five workflows that use
   * one of these actions hand it exactly that key, and the app's auto-updater
   * trusts whatever it signs — so the blast radius of a moved tag is every
   * installed copy of the app silently updating to an attacker's build.
   *
   * `actions/*` is exempt: it is GitHub's own namespace, published from the
   * same trust boundary that runs the workflow, and pinning it buys nothing a
   * compromise of that boundary would not already give away.
   */
  const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}$/;

  it("every third-party action is pinned to a full commit SHA", () => {
    const offenders: string[] = [];
    for (const w of WORKFLOWS) {
      for (const ref of usesIn(w.body)) {
        if (ref.startsWith("actions/")) continue;
        if (!PINNED.test(ref)) offenders.push(`${w.name}: ${ref}`);
      }
    }
    expect(offenders, "third-party actions must be pinned to a 40-char commit SHA").toEqual([]);
  });

  it("finds third-party actions to check, so the pin test cannot pass vacuously", () => {
    const thirdParty = WORKFLOWS.flatMap((w) => usesIn(w.body)).filter(
      (r) => !r.startsWith("actions/")
    );
    expect(thirdParty.length).toBeGreaterThan(0);
  });

  it("no workflow runs on a self-hosted runner", () => {
    // A self-hosted runner is a persistent machine: one poisoned job leaves
    // state behind for the next, and this repository's next job may be holding
    // the signing key. GitHub-hosted runners are destroyed after every run.
    for (const w of WORKFLOWS) {
      expect(w.body, `${w.name} uses a self-hosted runner`).not.toMatch(
        /runs-on:.*self-hosted/
      );
    }
  });
});

describe("no script injection into a run: block", () => {
  /**
   * `${{ ... }}` is substituted into the shell script as raw text *before* the
   * shell sees it, so interpolating an attacker-supplied field — a PR title, a
   * branch name, an issue body — is direct command execution in the job. The
   * safe form is to pass the value through `env:` and reference it as a shell
   * variable, which the shell then treats as data.
   */
  const DANGEROUS = [/\$\{\{\s*github\.event\./, /\$\{\{[^}]*github\.head_ref/];

  it("no run: block interpolates github.event.* or github.head_ref", () => {
    const offenders: string[] = [];
    for (const w of WORKFLOWS) {
      for (const block of runBlocksOf(w.body)) {
        if (DANGEROUS.some((re) => re.test(block))) offenders.push(`${w.name}: ${block.trim()}`);
      }
    }
    expect(offenders, "interpolate untrusted context via env:, not directly into run:").toEqual(
      []
    );
  });

  it("the run: scanner actually finds the scripts it is meant to scan", () => {
    // Guards the test above against a silent regression in runBlocksOf: if the
    // extractor stopped matching, the injection check would pass vacuously.
    const ci = WORKFLOWS.find((w) => w.name === "ci.yml")!;
    const blocks = runBlocksOf(ci.body);
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks.some((b) => /npm ci/.test(b))).toBe(true);
    expect(blocks.some((b) => /apt-get install/.test(b))).toBe(true);
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
