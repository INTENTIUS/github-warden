import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  annotatePlan,
  configPath,
  driftOrigins,
  formatOrigin,
  formatOrigins,
  originAt,
  type FieldOrigin,
  type PolicyProvenance,
} from "./origin.js";
import { diff, renderChangeSet } from "./diff.js";
import { runReconcile } from "./runner.js";
import { repoSettingsCycle } from "../cycles/repo-settings.js";
import { branchProtectionCycle } from "../cycles/branch-protection.js";
import type { AppClient } from "../auth/app-client.js";
import { loadGovernancePolicy } from "../config/policy.js";
import type { GovernanceConfig } from "../config/types.js";

const at = (line: number, column: number) => ({ file: "policy.ts", line, column });

const PARAM: FieldOrigin = {
  kind: "composite-parameter",
  composite: "reviewPreset",
  parameters: ["approvals"],
  call: at(30, 14),
  arguments: { approvals: at(30, 41) },
};
const LITERAL: FieldOrigin = { kind: "composite-literal", composite: "reviewPreset", call: at(30, 14), literal: at(10, 24) };
const DIRECT: FieldOrigin = { kind: "direct" };
const UNKNOWN: FieldOrigin = { kind: "unknown", reason: "host-call" };

const config: GovernanceConfig = {
  orgs: {
    "my-org": {
      settings: { description: "Engineering" },
      members: [{ login: "alice", role: "admin" }],
      teams: {
        platform: { description: "Platform", members: [{ login: "bob" }], repos: [{ name: "api", permission: "push" }] },
      },
      rulesets: [{ name: "org-main", target: "branch", enforcement: "active" }],
      variables: [{ name: "ORG_REGION", value: "eu" }],
      repos: {
        api: {
          deleteBranchOnMerge: true,
          hasWiki: false,
          description: "api",
          topics: ["service", "api"],
          branchProtection: [{ pattern: "release/*" }, { pattern: "main", requiredApprovingReviewCount: 2 }],
          rulesets: [{ name: "main", target: "branch", enforcement: "active" }],
          security: { secretScanning: true },
          environments: [{ name: "prod", waitTimer: 5 }],
          variables: [{ name: "REGION", value: "eu" }],
          dependabot: { content: "version: 2\n" },
        },
      },
    },
  },
};

const prov: PolicyProvenance = {
  paths: {
    'orgs["my-org"].settings.description': DIRECT,
    'orgs["my-org"].repos.api.deleteBranchOnMerge': LITERAL,
    'orgs["my-org"].repos.api.hasWiki': DIRECT,
    'orgs["my-org"].repos.api.description': UNKNOWN,
    'orgs["my-org"].repos.api.topics[0]': DIRECT,
    'orgs["my-org"].repos.api.topics[1]': UNKNOWN,
    'orgs["my-org"].repos.api.branchProtection[1].requiredApprovingReviewCount': PARAM,
  },
};

describe("configPath", () => {
  it("maps each resource type's field to its path in the policy, joining list members on their key", () => {
    const p = (t: string, k: string, f: string) => configPath(config, "my-org", t, k, f);
    expect(p("org-settings", "org-settings", "description")).toBe('orgs["my-org"].settings.description');
    expect(p("member", "alice", "role")).toBe('orgs["my-org"].members[0].role');
    expect(p("team", "platform", "description")).toBe('orgs["my-org"].teams.platform.description');
    expect(p("team-member", "platform/bob", "role")).toBe('orgs["my-org"].teams.platform.members[0].role');
    expect(p("team-repo", "platform/api", "permission")).toBe('orgs["my-org"].teams.platform.repos[0].permission');
    expect(p("org-ruleset", "org-main", "enforcement")).toBe('orgs["my-org"].rulesets[0].enforcement');
    expect(p("org-variable", "ORG_REGION", "value")).toBe('orgs["my-org"].variables[0].value');
    expect(p("repo", "api", "hasWiki")).toBe('orgs["my-org"].repos.api.hasWiki');
    expect(p("branch-protection", "api/main", "requiredApprovingReviewCount")).toBe(
      'orgs["my-org"].repos.api.branchProtection[1].requiredApprovingReviewCount',
    );
    expect(p("branch-protection", "api/release/*", "allowForcePushes")).toBe('orgs["my-org"].repos.api.branchProtection[0].allowForcePushes');
    expect(p("repo-ruleset", "api/main", "rules")).toBe('orgs["my-org"].repos.api.rulesets[0].rules');
    expect(p("repo-security", "api", "secretScanning")).toBe('orgs["my-org"].repos.api.security.secretScanning');
    expect(p("environment", "api/prod", "waitTimer")).toBe('orgs["my-org"].repos.api.environments[0].waitTimer');
    expect(p("repo-variable", "api/REGION", "value")).toBe('orgs["my-org"].repos.api.variables[0].value');
    expect(p("dependabot", "api", "content")).toBe('orgs["my-org"].repos.api.dependabot.content');
    expect(p("branch-protection", "api/missing", "requiredApprovingReviewCount")).toBeUndefined();
    expect(p("token-grant", "42", "access")).toBeUndefined();
    expect(configPath(config, "other-org", "repo", "api", "hasWiki")).toBeUndefined();
  });
});

describe("originAt", () => {
  it("an exact leaf, a list's distinct element origins, a path under a reported leaf, and nothing", () => {
    expect(originAt(prov, 'orgs["my-org"].repos.api.deleteBranchOnMerge')).toEqual([LITERAL]);
    expect(originAt(prov, 'orgs["my-org"].repos.api.topics')).toEqual([DIRECT, UNKNOWN]);
    expect(originAt(prov, 'orgs["my-org"].repos.api.hasWiki.deeper[0]')).toEqual([DIRECT]);
    expect(originAt(prov, 'orgs["my-org"].repos.api.websiteUrl')).toEqual([]);
  });
});

describe("formatOrigin", () => {
  it("names the preset argument and its line, the preset body line, direct, and unknown with its reason", () => {
    expect(formatOrigin(PARAM)).toBe("reviewPreset(...) argument approvals at policy.ts:30:41");
    expect(formatOrigin(LITERAL)).toBe("reviewPreset(...) sets it in its body at policy.ts:10:24, called at policy.ts:30:14");
    expect(formatOrigin(DIRECT)).toBe("direct");
    expect(formatOrigin(UNKNOWN)).toBe("unknown (host-call)");
  });

  it("a parameter whose default applied has no argument to point at, so the call is named", () => {
    const o: FieldOrigin = { kind: "composite-parameter", composite: "reviewPreset", parameters: ["approvals"], call: at(30, 14) };
    expect(formatOrigin(o)).toBe("reviewPreset(...) parameter approvals (default applied), called at policy.ts:30:14");
  });

  it("nothing reported is unknown, never direct", () => {
    expect(formatOrigins([])).toBe("unknown (not reported)");
  });
});

describe("annotatePlan", () => {
  it("writes each drifted field's origin under its plan line, for all four kinds", () => {
    const cs = diff(
      "my-org",
      { repos: { api: { ...config.orgs["my-org"].repos!.api, rulesets: undefined, security: undefined, environments: undefined, variables: undefined, dependabot: undefined } } },
      {
        repos: {
          api: {
            deleteBranchOnMerge: false,
            hasWiki: true,
            description: "drifted",
            topics: ["service", "api"],
            branchProtection: [{ pattern: "release/*" }, { pattern: "main", requiredApprovingReviewCount: 1 }],
          },
        },
      },
    );
    const drift = driftOrigins(cs, config, prov);
    expect(drift.map((d) => [d.resourceType, d.field, d.origins.map((o) => o.kind)])).toEqual([
      ["repo", "description", ["unknown"]],
      ["repo", "hasWiki", ["direct"]],
      ["repo", "deleteBranchOnMerge", ["composite-literal"]],
      ["branch-protection", "requiredApprovingReviewCount", ["composite-parameter"]],
    ]);
    const plan = annotatePlan(renderChangeSet(cs), drift);
    expect(plan).toContain(
      [
        "  [repo] api",
        "    description: drifted → api",
        "      <- unknown (host-call)",
        "    hasWiki: true → false",
        "      <- direct",
        "    deleteBranchOnMerge: false → true",
        "      <- reviewPreset(...) sets it in its body at policy.ts:10:24, called at policy.ts:30:14",
      ].join("\n"),
    );
    expect(plan).toContain(
      [
        "  [branch-protection] api/main",
        "    requiredApprovingReviewCount: 1 → 2",
        "      <- reviewPreset(...) argument approvals at policy.ts:30:41",
      ].join("\n"),
    );
  });

  it("a plan with no drift is returned as it was", () => {
    expect(annotatePlan("Plan for x: 0 to create, 0 to update, 0 to delete\nNo changes.", [])).toBe(
      "Plan for x: 0 to create, 0 to update, 0 to delete\nNo changes.",
    );
  });
});

/** A mock AppClient answering GETs from a table; anything else answers `{}`. */
function makeClient(responses: Record<string, unknown>): AppClient {
  return {
    async request<T = unknown>(method: string, path: string): Promise<T> {
      const key = `${method} ${path}`;
      if (key in responses) return responses[key] as T;
      throw new Error(`404 Not Found: ${key}`);
    },
  } as AppClient;
}

describe("the example policy's preset, folded", () => {
  const policy = "examples/governance.ts";
  const source = readFileSync(resolve(policy), "utf-8").split("\n");
  const lineOf = (needle: string): number => source.findIndex((l) => l.includes(needle)) + 1;
  const presetCall = "reviewPreset({ approvals: 1, checks: [\"ci\"] })";

  it("a preset-set field resolves to the preset argument on the line the preset is applied", async () => {
    const { provenance } = await loadGovernancePolicy(policy, "fold");
    expect(provenance).toBeDefined();
    const line = lineOf(presetCall);
    const [approvals] = originAt(provenance!, 'orgs["my-org"].repos["my-repo"].branchProtection[0].requiredApprovingReviewCount');
    expect(approvals).toMatchObject({
      kind: "composite-parameter",
      composite: "reviewPreset",
      parameters: ["approvals"],
      arguments: { approvals: { file: policy, line } },
    });
    const [deleteBranch] = originAt(provenance!, 'orgs["my-org"].repos["my-repo"].deleteBranchOnMerge');
    expect(deleteBranch).toMatchObject({ kind: "composite-literal", literal: { file: policy, line: lineOf("deleteBranchOnMerge: true") } });
    expect(originAt(provenance!, 'orgs["my-org"].repos["my-repo"].hasWiki')).toEqual([{ kind: "direct" }]);
  });

  it("run mode and YAML carry no provenance", async () => {
    expect((await loadGovernancePolicy(policy, "run")).provenance).toBeUndefined();
    expect((await loadGovernancePolicy("examples/governance.yml")).provenance).toBeUndefined();
  });

  it("a dry-run against drifted live state names the preset argument and the direct field in the plan", async () => {
    const { config: cfg, provenance } = await loadGovernancePolicy(policy, "fold");
    const client = makeClient({
      // Wiki turned on (direct) and branch auto-delete turned off (the preset's body), out of band.
      "GET /repos/my-org/my-repo": { has_wiki: true, delete_branch_on_merge: false, topics: ["service", "go"] },
      // Two required approvals live, against the preset's argument of one.
      "GET /repos/my-org/my-repo/branches/main/protection": {
        required_pull_request_reviews: { required_approving_review_count: 2 },
        required_status_checks: { contexts: ["ci"], strict: false },
      },
    });
    const result = await runReconcile({
      config: cfg,
      client,
      cycles: [repoSettingsCycle, branchProtectionCycle],
      mode: "dry-run",
      provenance,
    });
    const line = lineOf(presetCall);
    const col = source[line - 1].indexOf("approvals: 1") + "approvals: ".length + 1;
    const [repos, bps] = result.cycles;
    expect(repos!.plan).toContain(
      [
        "  [repo] my-repo",
        "    hasWiki: true → false",
        "      <- direct",
        "    deleteBranchOnMerge: false → true",
        `      <- reviewPreset(...) sets it in its body at ${policy}:${lineOf("deleteBranchOnMerge: true")}:24, called at ${policy}:${line}:14`,
      ].join("\n"),
    );
    expect(bps!.plan).toContain(
      [
        "  [branch-protection] my-repo/main",
        "    requiredApprovingReviewCount: 2 → 1",
        `      <- reviewPreset(...) argument approvals at ${policy}:${line}:${col}`,
      ].join("\n"),
    );
    expect(result.cycles[0]!.origins?.find((o) => o.field === "hasWiki")?.origins[0]?.kind).toBe("direct");
  });

  it("without provenance the plan is chant's, unannotated", async () => {
    const cfg: GovernanceConfig = { orgs: { o: { repos: { r: { hasWiki: false } } } } };
    const client = makeClient({ "GET /repos/o/r": { has_wiki: true } });
    const result = await runReconcile({ config: cfg, client, cycles: [repoSettingsCycle], mode: "dry-run" });
    expect(result.cycles[0]!.plan).toContain("hasWiki: true → false");
    expect(result.cycles[0]!.plan).not.toContain("<-");
    expect(result.cycles[0]!.origins).toBeUndefined();
  });
});
