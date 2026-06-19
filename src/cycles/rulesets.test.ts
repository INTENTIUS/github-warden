/**
 * Tests for the rulesets cycle (repo + org).
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps org + repo rulesets; omits bare repos
 *   - fetchRulesets: list + detail mapping; 404 → empty; budget
 *   - diff over the cycle: org-ruleset + repo-ruleset create/update/delete
 *   - apply: POST create; PUT update by id; DELETE by id; foreign skip
 *   - runner integration: dry-run plan
 */

import { describe, it, expect } from "vitest";
import {
  rulesetsCycle,
  fetchRulesets,
  buildRulesetBody,
  mapRulesetToLive,
} from "./rulesets.js";
import type { RulesetsScope } from "./rulesets.js";
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
      if (method === "GET" && path.includes("/rulesets?")) return [] as T;
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

const scope: RulesetsScope = {};

const sampleRule = { type: "pull_request", parameters: { required_approving_review_count: 1 } };

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("rulesetsCycle.buildDesired", () => {
  it("keeps org rulesets and repo rulesets, omitting repos without them", () => {
    const orgConfig: OrgConfig = {
      rulesets: [{ name: "org-main", enforcement: "active" }],
      repos: {
        svc: { rulesets: [{ name: "svc-main", enforcement: "active" }], description: "x" },
        bare: { description: "no rulesets" },
      },
    };
    const desired = rulesetsCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.rulesets).toEqual([{ name: "org-main", enforcement: "active" }]);
    expect(desired.repos!["svc"]).toEqual({ rulesets: [{ name: "svc-main", enforcement: "active" }] });
    expect(desired.repos).not.toHaveProperty("bare");
  });
});

// ---------------------------------------------------------------------------
// 2. fetchRulesets / mapRulesetToLive
// ---------------------------------------------------------------------------

describe("fetchRulesets", () => {
  it("lists then fetches detail and maps to LiveRuleset", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/rulesets?per_page=100&page=1": [{ id: 7, name: "org-main" }],
      "GET /orgs/test-org/rulesets/7": {
        id: 7,
        name: "org-main",
        target: "branch",
        enforcement: "active",
        bypass_actors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }],
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [sampleRule],
      },
    });
    const live = await fetchRulesets(client, "/orgs/test-org/rulesets", makeBudget());
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({
      id: 7,
      name: "org-main",
      target: "branch",
      enforcement: "active",
      bypassActors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [sampleRule],
    });
  });

  it("returns empty on a 404", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 404: Not Found");
    };
    const live = await fetchRulesets(client, "/repos/test-org/ghost/rulesets", makeBudget());
    expect(live).toEqual([]);
  });

  it("charges the budget: one list page + one detail per ruleset", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/rulesets?per_page=100&page=1": [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
      "GET /orgs/test-org/rulesets/1": { id: 1, name: "a" },
      "GET /orgs/test-org/rulesets/2": { id: 2, name: "b" },
    });
    const budget = makeBudget(10);
    await fetchRulesets(client, "/orgs/test-org/rulesets", budget);
    expect(budget.remaining).toBe(7); // 1 list + 2 detail
  });

  it("maps a minimal detail (only id + name)", () => {
    expect(mapRulesetToLive({ id: 3, name: "x" })).toEqual({ id: 3, name: "x" });
  });
});

// ---------------------------------------------------------------------------
// 3. buildRulesetBody
// ---------------------------------------------------------------------------

describe("buildRulesetBody", () => {
  it("maps declared fields to the GitHub body shape", () => {
    expect(
      buildRulesetBody({
        name: "main",
        target: "branch",
        enforcement: "active",
        bypassActors: [{ actor_id: 5 }],
        conditions: { ref_name: { include: ["main"], exclude: [] } },
        rules: [sampleRule],
      }),
    ).toEqual({
      name: "main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [{ actor_id: 5 }],
      conditions: { ref_name: { include: ["main"], exclude: [] } },
      rules: [sampleRule],
    });
  });

  it("emits only name when nothing else declared", () => {
    expect(buildRulesetBody({ name: "x" })).toEqual({ name: "x" });
  });
});

// ---------------------------------------------------------------------------
// 4. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with rulesets cycle", () => {
  it("emits org-ruleset and repo-ruleset creates", () => {
    const desired = rulesetsCycle.buildDesired(
      {
        rulesets: [{ name: "org-main", enforcement: "active" }],
        repos: { svc: { rulesets: [{ name: "svc-main", enforcement: "active" }] } },
      },
      "test-org",
      scope,
    );
    // live has the repo (so the ruleset diff runs) but no rulesets yet
    const live: LiveOrgState = { rulesets: [], repos: { svc: { rulesets: [] } } };
    const cs = diff("test-org", desired, live);
    const byType = cs.entries.map((e) => `${e.resourceType}:${e.key}`);
    expect(byType).toContain("org-ruleset:org-main");
    expect(byType).toContain("repo-ruleset:svc/svc-main");
  });

  it("emits update when a ruleset field differs", () => {
    const desired = rulesetsCycle.buildDesired(
      { rulesets: [{ name: "org-main", enforcement: "active" }] },
      "test-org",
      scope,
    );
    const live: LiveOrgState = { rulesets: [{ id: 9, name: "org-main", enforcement: "disabled" }] };
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("update");
    expect((cs.entries[0]!.before as { id?: number }).id).toBe(9);
  });

  it("does not diff the live id (no spurious update)", () => {
    const desired = rulesetsCycle.buildDesired(
      { rulesets: [{ name: "org-main", enforcement: "active" }] },
      "test-org",
      scope,
    );
    const live: LiveOrgState = { rulesets: [{ id: 9, name: "org-main", enforcement: "active" }] };
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
  });

  it("emits ownership-gated delete for an unmanaged org ruleset", () => {
    const desired = rulesetsCycle.buildDesired(
      { rulesets: [{ name: "keep", enforcement: "active" }] },
      "test-org",
      scope,
    );
    const live: LiveOrgState = {
      rulesets: [
        { id: 1, name: "keep", enforcement: "active" },
        { id: 2, name: "stray", enforcement: "active" },
      ],
    };
    expect(diff("test-org", desired, live).entries).toHaveLength(0); // no predicate
    const owned = diff("test-org", desired, live, { isOwned: (_t, k) => k === "stray" });
    const del = owned.entries.find((e) => e.kind === "delete")!;
    expect(del.resourceType).toBe("org-ruleset");
    expect((del.before as { id?: number }).id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. apply
// ---------------------------------------------------------------------------

describe("rulesetsCycle.apply", () => {
  it("POSTs an org-ruleset create", async () => {
    const client = makeMockClient();
    await rulesetsCycle.apply(
      client,
      { kind: "create", resourceType: "org-ruleset", key: "org-main", after: { name: "org-main", enforcement: "active" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("POST");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/rulesets");
    expect(client.calls[0]!.body).toEqual({ name: "org-main", enforcement: "active" });
  });

  it("PUTs an org-ruleset update by live id", async () => {
    const client = makeMockClient();
    await rulesetsCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "org-ruleset",
        key: "org-main",
        before: { id: 11, name: "org-main" },
        after: { name: "org-main", enforcement: "active" },
        fields: [],
      },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/rulesets/11");
  });

  it("DELETEs an org-ruleset by live id", async () => {
    const client = makeMockClient();
    await rulesetsCycle.apply(
      client,
      { kind: "delete", resourceType: "org-ruleset", key: "stray", before: { id: 22, name: "stray" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("DELETE");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/rulesets/22");
  });

  it("routes repo-ruleset to the repo path", async () => {
    const client = makeMockClient();
    await rulesetsCycle.apply(
      client,
      { kind: "create", resourceType: "repo-ruleset", key: "svc/svc-main", after: { name: "svc-main", enforcement: "active" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/rulesets");
    expect(client.calls[0]!.body).toEqual({ name: "svc-main", enforcement: "active" });
  });

  it("throws when an update is missing the live id", async () => {
    const client = makeMockClient();
    await expect(
      rulesetsCycle.apply(
        client,
        { kind: "update", resourceType: "org-ruleset", key: "x", after: { name: "x" }, fields: [] },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("missing the live ruleset id");
  });

  it("throws on a malformed repo-ruleset key", async () => {
    const client = makeMockClient();
    await expect(
      rulesetsCycle.apply(
        client,
        { kind: "create", resourceType: "repo-ruleset", key: "no-slash", after: { name: "x" } },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("malformed repo-ruleset key");
  });

  it("ignores foreign resource types", async () => {
    const client = makeMockClient();
    await rulesetsCycle.apply(
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

describe("rulesetsCycle via runReconcile", () => {
  it("dry-run: reports an org-ruleset create plan", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/rulesets?per_page=100&page=1": [],
    });
    const config: GovernanceConfig = {
      orgs: { "test-org": { rulesets: [{ name: "org-main", enforcement: "active" }] } },
    };
    const result = await runReconcile({ config, client, cycles: [rulesetsCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("apply: POSTs the org-ruleset after listing", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/rulesets?per_page=100&page=1": [],
    });
    const config: GovernanceConfig = {
      orgs: { "test-org": { rulesets: [{ name: "org-main", enforcement: "active" }] } },
    };
    const result = await runReconcile({
      config,
      client,
      cycles: [rulesetsCycle],
      mode: "apply",
      allowGuardrailOverride: true, // no members in fixture → adminFloor would block
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    expect(client.calls.find((c) => c.method === "POST")!.path).toBe("/orgs/test-org/rulesets");
  });
});
