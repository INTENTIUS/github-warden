/**
 * Tests for the repo-baseline cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps repoBaselines
 *   - listOrgRepoNames: pagination → presence map
 *   - diff: create only for missing repos; no entry when present; no delete
 *   - apply: POST create (empty) / template generate / private default
 *   - runner integration: dry-run plan
 */

import { describe, it, expect } from "vitest";
import { repoBaselineCycle, listOrgRepoNames } from "./repo-baseline.js";
import type { RepoBaselineScope } from "./repo-baseline.js";
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
      if (method === "GET" && path.includes("/repos?")) return [] as T;
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

const scope: RepoBaselineScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("repoBaselineCycle.buildDesired", () => {
  it("returns empty when repoBaselines absent", () => {
    expect(repoBaselineCycle.buildDesired({ repos: {} }, "test-org", scope).repoBaselines).toBeUndefined();
  });

  it("keeps only repoBaselines", () => {
    const orgConfig: OrgConfig = { repoBaselines: [{ name: "svc" }], members: [] };
    expect(repoBaselineCycle.buildDesired(orgConfig, "test-org", scope)).toEqual({
      repoBaselines: [{ name: "svc" }],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. listOrgRepoNames
// ---------------------------------------------------------------------------

describe("listOrgRepoNames", () => {
  it("paginates and returns a presence map", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `r${i}` }));
    const client = makeMockClient({
      "GET /orgs/test-org/repos?per_page=100&page=1": full,
      "GET /orgs/test-org/repos?per_page=100&page=2": [{ name: "last" }],
    });
    const repos = await listOrgRepoNames(client, "test-org", makeBudget());
    expect(Object.keys(repos)).toHaveLength(101);
    expect(repos).toHaveProperty("last");
  });
});

// ---------------------------------------------------------------------------
// 3. diff
// ---------------------------------------------------------------------------

describe("diff integration with repo-baseline cycle", () => {
  const desiredConfig: OrgConfig = { repoBaselines: [{ name: "svc" }, { name: "new-repo" }] };

  it("emits create only for the missing repo", () => {
    const live: LiveOrgState = { repos: { svc: {} } };
    const desired = repoBaselineCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("repo-baseline");
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.key).toBe("new-repo");
  });

  it("emits nothing when all declared repos exist", () => {
    const live: LiveOrgState = { repos: { svc: {}, "new-repo": {} } };
    const desired = repoBaselineCycle.buildDesired(desiredConfig, "test-org", scope);
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. apply
// ---------------------------------------------------------------------------

describe("repoBaselineCycle.apply", () => {
  it("POSTs a new empty private repo by default", async () => {
    const client = makeMockClient();
    await repoBaselineCycle.apply(
      client,
      { kind: "create", resourceType: "repo-baseline", key: "svc", after: { name: "svc" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("POST");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/repos");
    expect(client.calls[0]!.body).toEqual({ name: "svc", private: true });
  });

  it("honours an explicit private:false", async () => {
    const client = makeMockClient();
    await repoBaselineCycle.apply(
      client,
      { kind: "create", resourceType: "repo-baseline", key: "svc", after: { name: "svc", private: false } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.body).toEqual({ name: "svc", private: false });
  });

  it("generates from a template when declared", async () => {
    const client = makeMockClient();
    await repoBaselineCycle.apply(
      client,
      { kind: "create", resourceType: "repo-baseline", key: "svc", after: { name: "svc", template: "my-org/tmpl" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.path).toBe("/repos/my-org/tmpl/generate");
    expect(client.calls[0]!.body).toEqual({ owner: "my-org", name: "svc", private: true });
  });

  it("throws on a malformed template", async () => {
    const client = makeMockClient();
    await expect(
      repoBaselineCycle.apply(
        client,
        { kind: "create", resourceType: "repo-baseline", key: "svc", after: { name: "svc", template: "no-slash" } },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("malformed template");
  });

  it("ignores foreign resource types", async () => {
    const client = makeMockClient();
    await repoBaselineCycle.apply(
      client,
      { kind: "create", resourceType: "repo", key: "svc", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Runner integration
// ---------------------------------------------------------------------------

describe("repoBaselineCycle via runReconcile", () => {
  it("dry-run: reports a create for the missing repo", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/repos?per_page=100&page=1": [{ name: "existing" }],
    });
    const config: GovernanceConfig = {
      orgs: { "test-org": { repoBaselines: [{ name: "existing" }, { name: "fresh" }] } },
    };
    const result = await runReconcile({ config, client, cycles: [repoBaselineCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
