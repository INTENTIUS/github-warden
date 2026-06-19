/**
 * Tests for the repo-settings cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps managed settings, strips branchProtection, omits bare repos
 *   - fetchLive (via fetchLiveRepoSettings): maps GitHub repo response; 404 → skip
 *   - diff over the cycle: create / update / no-op / topics
 *   - apply: PATCH partial settings + PUT topics; ignores foreign / delete
 *   - runner integration: dry-run plan + apply
 */

import { describe, it, expect } from "vitest";
import { repoSettingsCycle, buildRepoPatchBody, fetchLiveRepoSettings } from "./repo-settings.js";
import type { RepoSettingsScope } from "./repo-settings.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import type { LiveOrgState } from "../reconcile/diff.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockCall {
  method: string;
  path: string;
  body?: unknown;
}

interface MockClient extends AppClient {
  calls: MockCall[];
  responses: Map<string, unknown>;
}

function makeMockClient(responses: Record<string, unknown> = {}): MockClient {
  const calls: MockCall[] = [];
  const responseMap = new Map(Object.entries(responses));
  return {
    calls,
    responses: responseMap,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (responseMap.has(key)) return responseMap.get(key) as T;
      return {} as T;
    },
  };
}

function makeBudget(initial = 100): RateBudget {
  let remaining = initial;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(n = 1) {
      if (remaining <= 0) throw new BudgetExhaustedError();
      remaining = Math.max(0, remaining - n);
    },
  };
}

const scope: RepoSettingsScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("repoSettingsCycle.buildDesired", () => {
  it("returns empty config when no repos are defined", () => {
    const desired = repoSettingsCycle.buildDesired({}, "test-org", scope);
    expect(desired.repos).toBeUndefined();
  });

  it("omits repos with no managed settings (e.g. only branchProtection)", () => {
    const orgConfig: OrgConfig = {
      repos: {
        "bp-only": { branchProtection: [{ pattern: "main", requirePullRequestReviews: true }] },
      },
    };
    const desired = repoSettingsCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.repos).toEqual({});
  });

  it("keeps managed settings and strips branchProtection", () => {
    const orgConfig: OrgConfig = {
      repos: {
        managed: {
          description: "svc",
          hasWiki: false,
          topics: ["api", "go"],
          branchProtection: [{ pattern: "main" }],
        },
      },
    };
    const desired = repoSettingsCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.repos!["managed"]).toEqual({
      description: "svc",
      hasWiki: false,
      topics: ["api", "go"],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. buildRepoPatchBody
// ---------------------------------------------------------------------------

describe("buildRepoPatchBody", () => {
  it("maps declared fields to GitHub PATCH keys and excludes topics", () => {
    const body = buildRepoPatchBody({
      description: "svc",
      websiteUrl: "https://x.test",
      private: true,
      hasIssues: false,
      hasProjects: false,
      hasWiki: true,
      defaultBranch: "main",
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      deleteBranchOnMerge: true,
      topics: ["a"],
    });
    expect(body).toEqual({
      description: "svc",
      homepage: "https://x.test",
      private: true,
      has_issues: false,
      has_projects: false,
      has_wiki: true,
      default_branch: "main",
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
    });
    expect(body).not.toHaveProperty("topics");
  });

  it("returns empty body when only topics declared", () => {
    expect(buildRepoPatchBody({ topics: ["a"] })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. fetchLiveRepoSettings — mapping
// ---------------------------------------------------------------------------

describe("fetchLiveRepoSettings", () => {
  it("maps the GitHub repo response to LiveRepoConfig", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/svc": {
        description: "service",
        homepage: "https://svc.test",
        private: true,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
        default_branch: "main",
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        delete_branch_on_merge: true,
        topics: ["api"],
      },
    });

    const live = await fetchLiveRepoSettings(
      client,
      "test-org",
      { svc: { description: "x" } },
      makeBudget(),
    );

    expect(live.repos!["svc"]).toEqual({
      description: "service",
      websiteUrl: "https://svc.test",
      private: true,
      hasIssues: true,
      hasProjects: false,
      hasWiki: false,
      defaultBranch: "main",
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      deleteBranchOnMerge: true,
      topics: ["api"],
    });
  });

  it("skips repos with no managed settings (zero API calls)", async () => {
    const client = makeMockClient();
    const live = await fetchLiveRepoSettings(
      client,
      "test-org",
      { "bp-only": { branchProtection: [{ pattern: "main" }] } },
      makeBudget(),
    );
    expect(live.repos).toEqual({});
    expect(client.calls).toHaveLength(0);
  });

  it("treats a 404 as no live entry", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 404: Not Found");
    };
    const live = await fetchLiveRepoSettings(
      client,
      "test-org",
      { ghost: { description: "x" } },
      makeBudget(),
    );
    expect(live.repos).toEqual({});
  });

  it("charges the budget one call per managed repo and stops when exhausted", async () => {
    const client = makeMockClient();
    const budget = makeBudget(1);
    await fetchLiveRepoSettings(
      client,
      "test-org",
      { a: { description: "x" }, b: { description: "y" } },
      budget,
    );
    expect(client.calls).toHaveLength(1);
    expect(budget.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with repo-settings cycle", () => {
  const desiredConfig: OrgConfig = {
    repos: { svc: { hasWiki: false, topics: ["api"] } },
  };

  it("emits create when no live repo exists", () => {
    const desired = repoSettingsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, { repos: {} });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.resourceType).toBe("repo");
    expect(cs.entries[0]!.key).toBe("svc");
  });

  it("emits update when a managed field or topics differ", () => {
    const live: LiveOrgState = { repos: { svc: { hasWiki: true, topics: ["old"] } } };
    const desired = repoSettingsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("update");
    const fieldNames = cs.entries[0]!.fields!.map((f) => f.field);
    expect(fieldNames).toContain("hasWiki");
    expect(fieldNames).toContain("topics");
  });

  it("emits no entries when live matches desired", () => {
    const live: LiveOrgState = { repos: { svc: { hasWiki: false, topics: ["api"] } } };
    const desired = repoSettingsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. apply — settings + topics
// ---------------------------------------------------------------------------

describe("repoSettingsCycle.apply", () => {
  it("PATCHes settings and PUTs topics for an update", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "update" as const,
      resourceType: "repo",
      key: "svc",
      after: { hasWiki: false, topics: ["api", "go"] },
    };
    await repoSettingsCycle.apply(client, entry, "my-org", scope, makeBudget());

    expect(client.calls).toHaveLength(2);
    const patch = client.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/repos/my-org/svc");
    expect(patch.body).toEqual({ has_wiki: false });
    const put = client.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/repos/my-org/svc/topics");
    expect(put.body).toEqual({ names: ["api", "go"] });
  });

  it("only PATCHes when no topics declared", async () => {
    const client = makeMockClient();
    await repoSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "repo", key: "svc", after: { private: true } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("PATCH");
    expect(client.calls[0]!.body).toEqual({ private: true });
  });

  it("only PUTs topics when no patchable settings declared", async () => {
    const client = makeMockClient();
    await repoSettingsCycle.apply(
      client,
      { kind: "create", resourceType: "repo", key: "svc", after: { topics: ["x"] } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/topics");
  });

  it("charges the budget per network call", async () => {
    const client = makeMockClient();
    const budget = makeBudget(5);
    await repoSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "repo", key: "svc", after: { private: true, topics: ["x"] } },
      "my-org",
      scope,
      budget,
    );
    expect(budget.remaining).toBe(3); // one PATCH + one PUT
  });

  it("ignores delete entries", async () => {
    const client = makeMockClient();
    await repoSettingsCycle.apply(
      client,
      { kind: "delete", resourceType: "repo", key: "svc", before: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });

  it("skips non-repo entries", async () => {
    const client = makeMockClient();
    await repoSettingsCycle.apply(
      client,
      { kind: "create", resourceType: "branch-protection", key: "svc/main", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Runner integration
// ---------------------------------------------------------------------------

describe("repoSettingsCycle via runReconcile", () => {
  const config: GovernanceConfig = {
    orgs: { "test-org": { repos: { svc: { hasWiki: false } } } },
  };

  it("dry-run: plan reports an update without mutating", async () => {
    const client = makeMockClient({ "GET /repos/test-org/svc": { has_wiki: true } });
    const scopeWithRepos: RepoSettingsScope = { repos: config.orgs["test-org"]!.repos };
    const result = await runReconcile({
      config,
      client,
      cycles: [repoSettingsCycle],
      scope: scopeWithRepos,
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
  });

  it("apply: PATCHes after fetching live", async () => {
    const client = makeMockClient({ "GET /repos/test-org/svc": { has_wiki: true } });
    const scopeWithRepos: RepoSettingsScope = { repos: config.orgs["test-org"]!.repos };
    const result = await runReconcile({
      config,
      client,
      cycles: [repoSettingsCycle],
      scope: scopeWithRepos,
      mode: "apply",
      allowGuardrailOverride: true, // no org members in fixture → adminFloor would block
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    const patch = client.calls.find((c) => c.method === "PATCH");
    expect(patch!.path).toBe("/repos/test-org/svc");
    expect(patch!.body).toEqual({ has_wiki: false });
  });
});
