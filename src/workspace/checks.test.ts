import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGovernanceConfig } from "../config/load.js";
import { memberChecks, requiredChecksRuleset } from "./checks.js";
import { parseLsDocument, readWorkspace, type Workspace } from "./members.js";

const ws: Workspace = {
  name: "demo",
  root: ".",
  chant: "0.101.0",
  members: [
    { name: "api", dir: "api", kind: "other", readable: true, reason: null, generated: [
      { path: ".github/workflows/chant-api-prod.yml", command: "c", env: "prod", jobs: ["build", "Deploy to prod"] },
      { path: ".github/workflows/chant-api-stg.yml", command: "c", env: "stg", jobs: ["build"] },
      { path: ".gitlab/ci/x.gitlab-ci.yml", command: "c", env: null, jobs: ["gl"] },
    ] },
    { name: "web", dir: "web", kind: "other", readable: true, reason: null, generated: [
      { path: ".github/workflows/chant-web-prod.yml", command: "c", env: "prod", jobs: null },
    ] },
    { name: "docs", dir: "docs", kind: "other", readable: true, reason: null, generated: [] },
  ],
};

describe("memberChecks", () => {
  it("collects GitHub job names per member, once each", () => {
    const r = memberChecks(ws);
    expect(r.members).toEqual([
      { member: "api", files: [".github/workflows/chant-api-prod.yml", ".github/workflows/chant-api-stg.yml"], contexts: ["build", "Deploy to prod"] },
    ]);
    expect(r.skipped.map((s) => s.member)).toEqual(["web", "docs"]);
    expect(r.skipped[0]!.reason).toMatch(/unreadable/);
  });
  it("limits to named members and rejects unknown ones", () => {
    expect(memberChecks(ws, ["docs"]).members).toEqual([]);
    expect(() => memberChecks(ws, ["nope"])).toThrow(/no member "nope"/);
  });
  it("reads generated from an ls document, empty when the field is absent", () => {
    const doc = (generated?: unknown) =>
      JSON.stringify({ contract: 1, chant: "0.101.0", workspace: { name: "d", root: "." }, members: [{ name: "a", dir: "a", kind: "other", readable: true, reason: null, ...(generated ? { generated } : {}) }] });
    expect(parseLsDocument(doc()).members[0]!.generated).toEqual([]);
    expect(parseLsDocument(doc([{ path: ".github/workflows/x.yml", command: "c", env: null, jobs: ["j"] }])).members[0]!.generated[0]!.jobs).toEqual(["j"]);
  });
});

describe("requiredChecksRuleset", () => {
  it("requires each check on the default branch and loads as a repo ruleset", () => {
    const rs = requiredChecksRuleset(memberChecks(ws));
    expect(rs.conditions).toEqual({ ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } });
    expect(rs.rules).toEqual([
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "build" }, { context: "Deploy to prod" }] } },
    ]);
    const cfg = loadGovernanceConfig({ orgs: { acme: { repos: { site: { rulesets: [rs] } } } } });
    expect(cfg.orgs["acme"]!.repos!["site"]!.rulesets).toHaveLength(1);
  });
  it("names a branch as a ref", () => {
    expect(requiredChecksRuleset({ members: [], skipped: [] }, "release").conditions).toEqual({ ref_name: { include: ["refs/heads/release"], exclude: [] } });
  });
});

describe("against a real chant workspace", () => {
  it("reads job names from `chant workspace ls --json`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warden-ck-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "api/.chant"), { recursive: true });
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ schema: 1, name: "demo", members: [{ name: "api", kind: "other", dir: "api", because: "the api" }] }));
    writeFileSync(join(dir, "api/.chant/generated.json"), JSON.stringify({ schema: 1, files: [{ path: ".github/workflows/chant-api-prod.yml", command: "c", env: "prod" }] }));
    writeFileSync(join(dir, ".github/workflows/chant-api-prod.yml"), "jobs:\n  build:\n    runs-on: x\n  deploy:\n    name: Deploy\n    runs-on: x\n");
    const checks = memberChecks(await readWorkspace(dir));
    expect(checks.members).toEqual([{ member: "api", files: [".github/workflows/chant-api-prod.yml"], contexts: ["build", "Deploy"] }]);
  }, 60_000);
});
