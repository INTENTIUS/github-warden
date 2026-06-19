/**
 * Tests for the environments cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps repos with environments
 *   - mapEnvironmentToLive: protection_rules + deployment_branch_policy mapping
 *   - buildEnvironmentBody: RMW seed-from-live + overlay declared
 *   - diff over the cycle: environment create / update / ownership-gated delete
 *   - apply: PUT (create + RMW update) / DELETE
 *   - runner integration: dry-run plan
 */

import { describe, it, expect } from "vitest";
import {
  environmentsCycle,
  mapEnvironmentToLive,
  buildEnvironmentBody,
} from "./environments.js";
import type { EnvironmentsScope } from "./environments.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import type { LiveOrgState, LiveEnvironment } from "../reconcile/diff.js";
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

const scope: EnvironmentsScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("environmentsCycle.buildDesired", () => {
  it("keeps only repos that declare environments", () => {
    const orgConfig: OrgConfig = {
      repos: {
        svc: { environments: [{ name: "prod" }], description: "x" },
        bare: { description: "no envs" },
      },
    };
    const desired = environmentsCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.repos!["svc"]).toEqual({ environments: [{ name: "prod" }] });
    expect(desired.repos).not.toHaveProperty("bare");
  });
});

// ---------------------------------------------------------------------------
// 2. mapEnvironmentToLive
// ---------------------------------------------------------------------------

describe("mapEnvironmentToLive", () => {
  it("maps protection rules and branch policy", () => {
    const live = mapEnvironmentToLive({
      name: "prod",
      protection_rules: [
        { type: "wait_timer", wait_timer: 30 },
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [
            { type: "User", reviewer: { id: 1 } },
            { type: "Team", reviewer: { id: 2 } },
          ],
        },
      ],
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });
    expect(live).toEqual({
      name: "prod",
      waitTimer: 30,
      preventSelfReview: true,
      reviewers: [
        { type: "User", id: 1 },
        { type: "Team", id: 2 },
      ],
      deploymentBranchPolicy: { protectedBranches: true, customBranchPolicies: false },
    });
  });

  it("maps a null branch policy to null", () => {
    const live = mapEnvironmentToLive({ name: "staging", deployment_branch_policy: null });
    expect(live.deploymentBranchPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. buildEnvironmentBody (RMW)
// ---------------------------------------------------------------------------

describe("buildEnvironmentBody", () => {
  it("sends only declared fields on create", () => {
    expect(buildEnvironmentBody({ name: "prod", waitTimer: 15 })).toEqual({ wait_timer: 15 });
  });

  it("seeds from live and overlays declared fields on update (RMW)", () => {
    const live: LiveEnvironment = {
      name: "prod",
      waitTimer: 30,
      preventSelfReview: true,
      reviewers: [{ type: "User", id: 1 }],
      deploymentBranchPolicy: { protectedBranches: true, customBranchPolicies: false },
    };
    // Config changes ONLY the wait timer.
    const body = buildEnvironmentBody({ name: "prod", waitTimer: 5 }, live);
    expect(body).toEqual({
      wait_timer: 5, // overlaid
      prevent_self_review: true, // preserved
      reviewers: [{ type: "User", id: 1 }], // preserved
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, // preserved
    });
  });

  it("maps a null branch policy through to null", () => {
    expect(buildEnvironmentBody({ name: "p", deploymentBranchPolicy: null })).toEqual({
      deployment_branch_policy: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with environments cycle", () => {
  const desiredConfig: OrgConfig = {
    repos: { svc: { environments: [{ name: "prod", waitTimer: 10 }] } },
  };

  it("emits create when the environment is absent live", () => {
    const desired = environmentsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, { repos: { svc: { environments: [] } } });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("environment");
    expect(cs.entries[0]!.key).toBe("svc/prod");
    expect(cs.entries[0]!.kind).toBe("create");
  });

  it("emits update when a declared field differs", () => {
    const live: LiveOrgState = { repos: { svc: { environments: [{ name: "prod", waitTimer: 30 }] } } };
    const desired = environmentsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries[0]!.kind).toBe("update");
    expect(cs.entries[0]!.fields!.map((f) => f.field)).toEqual(["waitTimer"]);
  });

  it("emits ownership-gated delete for an unmanaged environment", () => {
    const live: LiveOrgState = {
      repos: { svc: { environments: [{ name: "prod", waitTimer: 10 }, { name: "stray" }] } },
    };
    const desired = environmentsCycle.buildDesired(desiredConfig, "test-org", scope);
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
    const owned = diff("test-org", desired, live, { isOwned: (_t, k) => k === "svc/stray" });
    expect(owned.entries.find((e) => e.kind === "delete")!.key).toBe("svc/stray");
  });
});

// ---------------------------------------------------------------------------
// 5. apply
// ---------------------------------------------------------------------------

describe("environmentsCycle.apply", () => {
  it("PUTs a create with only declared fields", async () => {
    const client = makeMockClient();
    await environmentsCycle.apply(
      client,
      { kind: "create", resourceType: "environment", key: "svc/prod", after: { name: "prod", waitTimer: 10 } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/environments/prod");
    expect(client.calls[0]!.body).toEqual({ wait_timer: 10 });
  });

  it("PUTs an RMW update preserving undeclared protection", async () => {
    const client = makeMockClient();
    const before: LiveEnvironment = {
      name: "prod",
      waitTimer: 30,
      reviewers: [{ type: "Team", id: 9 }],
      deploymentBranchPolicy: { protectedBranches: true },
    };
    await environmentsCycle.apply(
      client,
      { kind: "update", resourceType: "environment", key: "svc/prod", before, after: { name: "prod", waitTimer: 5 }, fields: [] },
      "my-org",
      scope,
      makeBudget(),
    );
    const body = client.calls[0]!.body as Record<string, unknown>;
    expect(body.wait_timer).toBe(5);
    expect(body.reviewers).toEqual([{ type: "Team", id: 9 }]);
    expect(body.deployment_branch_policy).toEqual({ protected_branches: true, custom_branch_policies: false });
  });

  it("re-fetches live when an update entry lacks before", async () => {
    const client = makeMockClient({
      "GET /repos/my-org/svc/environments": {
        environments: [{ name: "prod", protection_rules: [{ type: "wait_timer", wait_timer: 60 }] }],
      },
    });
    const budget = makeBudget(5);
    await environmentsCycle.apply(
      client,
      { kind: "update", resourceType: "environment", key: "svc/prod", after: { name: "prod", preventSelfReview: true }, fields: [] },
      "my-org",
      scope,
      budget,
    );
    // one GET (re-fetch) + one PUT
    expect(budget.remaining).toBe(3);
    const put = client.calls.find((c) => c.method === "PUT")!;
    const body = put.body as Record<string, unknown>;
    expect(body.wait_timer).toBe(60); // preserved from re-fetched live
    expect(body.prevent_self_review).toBe(true); // declared
  });

  it("DELETEs an environment", async () => {
    const client = makeMockClient();
    await environmentsCycle.apply(
      client,
      { kind: "delete", resourceType: "environment", key: "svc/old", before: { name: "old" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("DELETE");
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/environments/old");
  });

  it("ignores foreign entries and throws on a malformed key", async () => {
    const client = makeMockClient();
    await environmentsCycle.apply(
      client,
      { kind: "create", resourceType: "repo", key: "svc", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
    await expect(
      environmentsCycle.apply(
        client,
        { kind: "create", resourceType: "environment", key: "no-slash", after: { name: "x" } },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("malformed entry key");
  });
});

// ---------------------------------------------------------------------------
// 6. Runner integration
// ---------------------------------------------------------------------------

describe("environmentsCycle via runReconcile", () => {
  it("dry-run: reports a create plan", async () => {
    const config: GovernanceConfig = {
      orgs: { "test-org": { repos: { svc: { environments: [{ name: "prod", waitTimer: 10 }] } } } },
    };
    const client = makeMockClient({
      "GET /repos/test-org/svc/environments": { environments: [] },
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [environmentsCycle],
      scope: { repos: config.orgs["test-org"]!.repos } satisfies EnvironmentsScope,
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
