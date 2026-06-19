/**
 * Tests for the token-governance cycle.
 *
 * All tests use a mock AppClient + explicit nowMs — no network, no real clock.
 * Coverage:
 *   - evaluateTokenViolation: expired / lifetime / idle / compliant
 *   - mapTokenGrant: ISO → epoch ms
 *   - buildDesired: keeps tokenPolicy
 *   - fetchLive: lists grants (paginated); 403/404 tolerated
 *   - diff: violators emitted as token-grant UPDATE (revoke), not delete
 *   - apply: POST revoke; foreign skip
 *   - runner integration: expired grant revoked (clock-free)
 */

import { describe, it, expect } from "vitest";
import { tokenGovernanceCycle, mapTokenGrant } from "./token-governance.js";
import type { TokenGovernanceScope } from "./token-governance.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff, evaluateTokenViolation } from "../reconcile/diff.js";
import type { LiveOrgState, LiveTokenGrant } from "../reconcile/diff.js";
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
      if (method === "GET" && path.includes("/personal-access-tokens")) return [] as T;
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

const scope: TokenGovernanceScope = {};
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 1. evaluateTokenViolation
// ---------------------------------------------------------------------------

describe("evaluateTokenViolation", () => {
  it("flags an expired grant (clock-free)", () => {
    expect(evaluateTokenViolation({ id: 1, expired: true }, {})).toBe("expired");
  });

  it("respects revokeExpired:false", () => {
    expect(evaluateTokenViolation({ id: 1, expired: true }, { revokeExpired: false })).toBeNull();
  });

  it("flags a grant over the max lifetime", () => {
    const grant: LiveTokenGrant = { id: 1, grantedAtMs: NOW - 40 * DAY };
    expect(evaluateTokenViolation(grant, { maxLifetimeDays: 30 }, NOW)).toBe("exceeds-max-lifetime");
    expect(evaluateTokenViolation(grant, { maxLifetimeDays: 60 }, NOW)).toBeNull();
  });

  it("flags an idle grant", () => {
    const grant: LiveTokenGrant = { id: 1, lastUsedAtMs: NOW - 100 * DAY };
    expect(evaluateTokenViolation(grant, { maxIdleDays: 90 }, NOW)).toBe("idle");
  });

  it("skips lifetime/idle checks without nowMs", () => {
    const grant: LiveTokenGrant = { id: 1, grantedAtMs: 0, lastUsedAtMs: 0 };
    expect(evaluateTokenViolation(grant, { maxLifetimeDays: 1, maxIdleDays: 1 })).toBeNull();
  });

  it("returns null for a compliant grant", () => {
    expect(evaluateTokenViolation({ id: 1, expired: false }, { maxLifetimeDays: 30 }, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. mapTokenGrant
// ---------------------------------------------------------------------------

describe("mapTokenGrant", () => {
  it("maps owner + ISO timestamps to epoch ms", () => {
    const grant = mapTokenGrant({
      id: 7,
      owner: { login: "alice" },
      token_expired: false,
      token_expires_at: "2024-01-01T00:00:00Z",
      token_last_used_at: "2023-06-01T00:00:00Z",
      access_granted_at: "2023-01-01T00:00:00Z",
    });
    expect(grant.id).toBe(7);
    expect(grant.ownerLogin).toBe("alice");
    expect(grant.expiresAtMs).toBe(Date.parse("2024-01-01T00:00:00Z"));
    expect(grant.grantedAtMs).toBe(Date.parse("2023-01-01T00:00:00Z"));
  });

  it("omits unparseable / null timestamps", () => {
    const grant = mapTokenGrant({ id: 1, token_last_used_at: null });
    expect(grant.lastUsedAtMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. buildDesired / fetchLive
// ---------------------------------------------------------------------------

describe("tokenGovernanceCycle.buildDesired / fetchLive", () => {
  it("keeps only tokenPolicy", () => {
    const orgConfig: OrgConfig = { tokenPolicy: { maxLifetimeDays: 90 }, members: [] };
    expect(tokenGovernanceCycle.buildDesired(orgConfig, "test-org", scope)).toEqual({
      tokenPolicy: { maxLifetimeDays: 90 },
    });
  });

  it("lists grants and maps them", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/personal-access-tokens?per_page=100&page=1": [
        { id: 1, owner: { login: "a" }, token_expired: true },
        { id: 2, owner: { login: "b" }, token_expired: false },
      ],
    });
    const live = await tokenGovernanceCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.tokenGrants).toHaveLength(2);
    expect(live.tokenGrants![0]!.ownerLogin).toBe("a");
  });

  it("tolerates 403 as no grants", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 403: Resource not accessible by integration");
    };
    const live = await tokenGovernanceCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.tokenGrants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. diff
// ---------------------------------------------------------------------------

describe("diff integration with token-governance cycle", () => {
  it("emits a token-grant UPDATE (revoke) for a violator, not a delete", () => {
    const live: LiveOrgState = {
      tokenGrants: [
        { id: 10, ownerLogin: "a", expired: true },
        { id: 11, ownerLogin: "b", expired: false },
      ],
    };
    const desired = tokenGovernanceCycle.buildDesired({ tokenPolicy: {} }, "test-org", scope);
    const cs = diff("test-org", desired, live, { nowMs: NOW });
    expect(cs.entries).toHaveLength(1);
    const e = cs.entries[0]!;
    expect(e.resourceType).toBe("token-grant");
    expect(e.kind).toBe("update"); // not delete → won't trip removalDeltaCap
    expect(e.key).toBe("10");
    expect((e.after as { reason?: string }).reason).toBe("expired");
  });

  it("emits nothing when no policy is declared", () => {
    const live: LiveOrgState = { tokenGrants: [{ id: 1, expired: true }] };
    const cs = diff("test-org", {}, live, { nowMs: NOW });
    expect(cs.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. apply
// ---------------------------------------------------------------------------

describe("tokenGovernanceCycle.apply", () => {
  it("POSTs a revoke for a token-grant update", async () => {
    const client = makeMockClient();
    await tokenGovernanceCycle.apply(
      client,
      { kind: "update", resourceType: "token-grant", key: "42", before: { id: 42 }, after: { revoke: true }, fields: [] },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("POST");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/personal-access-tokens/42");
    expect(client.calls[0]!.body).toEqual({ action: "revoke" });
  });

  it("ignores foreign resource types", async () => {
    const client = makeMockClient();
    await tokenGovernanceCycle.apply(
      client,
      { kind: "update", resourceType: "member", key: "alice", after: {} },
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

describe("tokenGovernanceCycle via runReconcile", () => {
  it("apply: revokes an expired grant (clock-free)", async () => {
    const config: GovernanceConfig = {
      orgs: { "test-org": { tokenPolicy: { revokeExpired: true } } },
    };
    const client = makeMockClient({
      "GET /orgs/test-org/personal-access-tokens?per_page=100&page=1": [
        { id: 5, owner: { login: "stale" }, token_expired: true },
      ],
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [tokenGovernanceCycle],
      mode: "apply",
      allowGuardrailOverride: true, // no members → adminFloor would block
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    const post = client.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/orgs/test-org/personal-access-tokens/5");
    expect(post.body).toEqual({ action: "revoke" });
  });
});
