/**
 * Tests for the membership & roles cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps members only; omits when absent
 *   - fetchLive: lists admins + members across pagination → LiveMemberConfig[]
 *   - diff over the cycle: create / update (role) / ownership-gated delete
 *   - apply: PUT membership for add/role; DELETE for removal; foreign skip
 *   - runner integration: dry-run plan; adminFloor & removalDeltaCap trip
 */

import { describe, it, expect } from "vitest";
import { membershipCycle, listOrgMembers } from "./membership.js";
import type { MembershipScope } from "./membership.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import { runGuardrails } from "../reconcile/guardrails.js";
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
      // Member listing defaults to an empty page (terminates pagination).
      if (method === "GET" && path.includes("/members?")) return [] as T;
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

const scope: MembershipScope = {};

const adminPage = (org: string, page = 1) =>
  `GET /orgs/${org}/members?role=admin&per_page=100&page=${page}`;
const memberPage = (org: string, page = 1) =>
  `GET /orgs/${org}/members?role=member&per_page=100&page=${page}`;

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("membershipCycle.buildDesired", () => {
  it("returns empty config when members are absent", () => {
    const desired = membershipCycle.buildDesired({ teams: {} }, "test-org", scope);
    expect(desired.members).toBeUndefined();
  });

  it("keeps only the members array", () => {
    const orgConfig: OrgConfig = {
      members: [{ login: "alice", role: "admin" }],
      teams: { backend: {} },
    };
    const desired = membershipCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired).toEqual({ members: [{ login: "alice", role: "admin" }] });
  });
});

// ---------------------------------------------------------------------------
// 2. fetchLive / listOrgMembers
// ---------------------------------------------------------------------------

describe("membershipCycle.fetchLive", () => {
  it("lists admins and members and tags roles", async () => {
    const client = makeMockClient({
      [adminPage("test-org")]: [{ login: "alice" }, { login: "bob" }],
      [memberPage("test-org")]: [{ login: "carol" }],
    });
    const live = await membershipCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.members).toEqual([
      { login: "alice", role: "admin" },
      { login: "bob", role: "admin" },
      { login: "carol", role: "member" },
    ]);
  });

  it("follows pagination until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ login: `u${i}` }));
    const client = makeMockClient({
      [adminPage("test-org", 1)]: fullPage,
      [adminPage("test-org", 2)]: [{ login: "last" }],
      [memberPage("test-org", 1)]: [],
    });
    const logins = await listOrgMembers(client, "test-org", "admin", makeBudget());
    expect(logins).toHaveLength(101);
    expect(logins[100]).toBe("last");
  });

  it("charges the budget per page", async () => {
    const client = makeMockClient({
      [adminPage("test-org")]: [{ login: "a" }],
      [memberPage("test-org")]: [{ login: "b" }],
    });
    const budget = makeBudget(10);
    await membershipCycle.fetchLive(client, "test-org", scope, budget);
    // one admin page + one member page
    expect(budget.remaining).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 3. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with membership cycle", () => {
  it("emits create for a new member and update for a role change", () => {
    const live: LiveOrgState = {
      members: [{ login: "alice", role: "member" }],
    };
    const desired = membershipCycle.buildDesired(
      { members: [{ login: "alice", role: "admin" }, { login: "bob", role: "member" }] },
      "test-org",
      scope,
    );
    const cs = diff("test-org", desired, live);
    const byKind = Object.fromEntries(cs.entries.map((e) => [e.key, e.kind]));
    expect(byKind["alice"]).toBe("update");
    expect(byKind["bob"]).toBe("create");
  });

  it("only emits delete for unmanaged members when ownership predicate allows", () => {
    const live: LiveOrgState = {
      members: [{ login: "alice", role: "member" }, { login: "ghost", role: "member" }],
    };
    const desired = membershipCycle.buildDesired(
      { members: [{ login: "alice", role: "member" }] },
      "test-org",
      scope,
    );
    // No predicate → no deletes.
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
    // Predicate → ghost deleted.
    const owned = diff("test-org", desired, live, { isOwned: (_t, k) => k === "ghost" });
    const del = owned.entries.find((e) => e.kind === "delete");
    expect(del!.key).toBe("ghost");
  });
});

// ---------------------------------------------------------------------------
// 4. apply
// ---------------------------------------------------------------------------

describe("membershipCycle.apply", () => {
  it("PUTs membership with the desired role for create/update", async () => {
    const client = makeMockClient();
    await membershipCycle.apply(
      client,
      { kind: "create", resourceType: "member", key: "alice", after: { login: "alice", role: "admin" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/memberships/alice");
    expect(client.calls[0]!.body).toEqual({ role: "admin" });
  });

  it("defaults role to member when unset", async () => {
    const client = makeMockClient();
    await membershipCycle.apply(
      client,
      { kind: "create", resourceType: "member", key: "bob", after: { login: "bob" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.body).toEqual({ role: "member" });
  });

  it("DELETEs membership for a delete entry", async () => {
    const client = makeMockClient();
    await membershipCycle.apply(
      client,
      { kind: "delete", resourceType: "member", key: "ghost", before: { login: "ghost", role: "member" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("DELETE");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/memberships/ghost");
  });

  it("skips non-member entries", async () => {
    const client = makeMockClient();
    await membershipCycle.apply(
      client,
      { kind: "create", resourceType: "team", key: "backend", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Runner integration + guardrails
// ---------------------------------------------------------------------------

describe("membershipCycle via runReconcile", () => {
  it("dry-run: reports add + role-change plan", async () => {
    const client = makeMockClient({
      [adminPage("test-org")]: [{ login: "alice" }],
      [memberPage("test-org")]: [],
    });
    const config: GovernanceConfig = {
      orgs: {
        "test-org": {
          members: [
            { login: "alice", role: "admin" },
            { login: "dave", role: "member" },
          ],
        },
      },
    };
    const result = await runReconcile({ config, client, cycles: [membershipCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(1); // dave
    expect(cr.counts.update).toBe(0); // alice already admin
  });

  it("apply: adminFloor blocks an apply that would drop below 2 admins", async () => {
    // Live: two admins. Desired demotes one → only 1 admin would remain.
    const client = makeMockClient({
      [adminPage("test-org")]: [{ login: "alice" }, { login: "bob" }],
      [memberPage("test-org")]: [],
    });
    const config: GovernanceConfig = {
      orgs: {
        "test-org": {
          members: [
            { login: "alice", role: "member" }, // demote
            { login: "bob", role: "admin" },
          ],
        },
      },
    };
    const result = await runReconcile({
      config,
      client,
      cycles: [membershipCycle],
      mode: "apply",
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    expect(cr.applied).toHaveLength(0);
    expect(cr.guardrails.ok).toBe(false);
    if (!cr.guardrails.ok) {
      expect(cr.guardrails.diagnostics.some((d) => d.guardrail === "adminFloor")).toBe(true);
    }
    // No mutating calls were made.
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("removalDeltaCap trips when too many members would be removed", () => {
    const live: LiveOrgState = {
      members: Array.from({ length: 10 }, (_, i) => ({ login: `u${i}`, role: "member" as const })),
    };
    const desired = membershipCycle.buildDesired(
      { members: [{ login: "u0", role: "member" }] },
      "test-org",
      scope,
    );
    // All live members owned → 9 deletes against 10 pre-existing → 90% > 25%.
    const cs = diff("test-org", desired, live, { isOwned: () => true });
    const gr = runGuardrails(cs, live);
    expect(gr.ok).toBe(false);
    if (!gr.ok) {
      expect(gr.diagnostics.some((d) => d.guardrail === "removalDeltaCap")).toBe(true);
    }
  });
});
