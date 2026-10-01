import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGovernanceConfig } from "../config/load.js";
import { lifecycleRuleset, parseStatusDocument, readLifecycle } from "./lifecycle.js";

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    contract: 1,
    chant: "0.100.0",
    env: "prod",
    compareTo: null,
    lifecycle: { ref: "chant/lifecycle", commit: "a".repeat(40) },
    workspace: { name: "demo", root: ".", file: "chant.workspace.json" },
    members: [
      {
        name: "api",
        dir: "packages/api",
        environments: [{ env: "prod", ledger: { layout: "members", path: "_members/api/prod/releases.jsonl", shared: false }, releases: [], reason: null }],
        gateLedger: { layout: "members", path: "_members/api/_gates", shared: false, malformed: 0, reason: null },
      },
      {
        name: "docs",
        dir: "docs",
        environments: [{ env: "prod", ledger: { layout: "flat", path: "prod/releases.jsonl", shared: true }, releases: [], reason: null }],
        gateLedger: { layout: "flat", path: "_gates", shared: true, malformed: 0, reason: null },
      },
    ],
    summary: {},
    ...over,
  });

describe("parseStatusDocument", () => {
  it("reads the branch, its tip and each member's ledger paths", () => {
    const lc = parseStatusDocument(status());
    expect(lc.ref).toBe("chant/lifecycle");
    expect(lc.commit).toBe("a".repeat(40));
    expect(lc.members[0]).toEqual({
      name: "api",
      releases: [{ env: "prod", layout: "members", path: "_members/api/prod/releases.jsonl" }],
      gates: { layout: "members", path: "_members/api/_gates" },
    });
    expect(lc.members[1]!.releases[0]!.layout).toBe("flat");
  });
  it("refuses another contract, a failure and a bad document", () => {
    expect(() => parseStatusDocument(status({ contract: 2 }))).toThrow(/contract 2/);
    expect(() => parseStatusDocument(JSON.stringify({ contract: 1, error: { code: "environment-invalid", message: "x" } }))).toThrow(/environment-invalid/);
    expect(() => parseStatusDocument(status({ lifecycle: undefined }))).toThrow(/lacks lifecycle/);
    expect(() => parseStatusDocument("no")).toThrow(/did not print JSON/);
  });
  it("runs status for the environment", async () => {
    const calls: unknown[] = [];
    await readLifecycle("/r", "prod", async (_c, args, cwd) => {
      calls.push([args, cwd]);
      return { stdout: status(), stderr: "", code: 0 };
    });
    expect(calls).toEqual([[["workspace", "status", "prod", "--json"], "/r"]]);
  });
});

describe("lifecycleRuleset", () => {
  it("blocks deletion and force pushes on the branch the contract names", () => {
    expect(lifecycleRuleset("chant/lifecycle")).toEqual({
      name: "chant-lifecycle",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/chant/lifecycle"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    });
  });
});

describe("the ruleset in a governance config", () => {
  it("passes the config loader as a repo ruleset", () => {
    const cfg = loadGovernanceConfig({ orgs: { acme: { repos: { site: { rulesets: [lifecycleRuleset("chant/lifecycle")] } } } } });
    expect(cfg.orgs["acme"]!.repos!["site"]!.rulesets![0]!.rules).toHaveLength(2);
  });
});

describe("against a real chant workspace", () => {
  it("reads the lifecycle from `chant workspace status --json`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warden-lc-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "docs"));
    writeFileSync(
      join(dir, "chant.workspace.json"),
      JSON.stringify({ schema: 1, name: "demo", members: [{ name: "docs", kind: "other", dir: "docs", because: "the docs" }] }),
    );
    const lc = await readLifecycle(dir, "prod");
    expect(lc.ref).toBe("chant/lifecycle");
    expect(lc.members[0]!.releases[0]!.path).toBe("prod/releases.jsonl");
  }, 60_000);
});
