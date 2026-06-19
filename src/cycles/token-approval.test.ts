/**
 * Tests for the token-approval cycle.
 *
 * All tests use a mock AppClient — no network.
 * Coverage:
 *   - evaluateTokenRequest: approve (subset) / deny (default) / manual (null)
 *   - flattenRequestPermissions + mapTokenRequest
 *   - buildDesired / fetchLive (paginated; 403/404 tolerated)
 *   - diff: decided requests → token-request UPDATE; manual → none
 *   - apply: POST approve/deny; foreign skip
 *   - runner integration: subset request auto-approved
 */

import { describe, it, expect } from "vitest";
import { tokenApprovalCycle, mapTokenRequest, flattenRequestPermissions } from "./token-approval.js";
import type { TokenApprovalScope } from "./token-approval.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff, evaluateTokenRequest } from "../reconcile/diff.js";
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
      if (method === "GET" && path.includes("/personal-access-token-requests")) return [] as T;
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

const scope: TokenApprovalScope = {};

// ---------------------------------------------------------------------------
// 1. evaluateTokenRequest
// ---------------------------------------------------------------------------

describe("evaluateTokenRequest", () => {
  const policy = { allowedPermissions: ["repository:contents", "repository:metadata"], default: "deny" as const };

  it("approves when all requested permissions are allowed", () => {
    expect(evaluateTokenRequest({ id: 1, permissions: ["repository:contents"] }, policy)).toBe("approve");
    expect(evaluateTokenRequest({ id: 1, permissions: [] }, policy)).toBe("approve");
  });

  it("denies a request with a disallowed permission when default=deny", () => {
    expect(evaluateTokenRequest({ id: 1, permissions: ["repository:administration"] }, policy)).toBe("deny");
  });

  it("leaves for manual review when default is manual (the default)", () => {
    expect(
      evaluateTokenRequest({ id: 1, permissions: ["repository:administration"] }, { allowedPermissions: [] }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. flattenRequestPermissions / mapTokenRequest
// ---------------------------------------------------------------------------

describe("flattenRequestPermissions", () => {
  it("flattens nested groups to group:scope names", () => {
    expect(
      flattenRequestPermissions({ repository: { contents: "write", metadata: "read" }, organization: { members: "read" } }),
    ).toEqual(["repository:contents", "repository:metadata", "organization:members"]);
  });

  it("handles null/empty", () => {
    expect(flattenRequestPermissions(null)).toEqual([]);
    expect(flattenRequestPermissions({ repository: null })).toEqual([]);
  });

  it("mapTokenRequest captures owner + permissions", () => {
    const req = mapTokenRequest({ id: 3, owner: { login: "alice" }, permissions: { repository: { contents: "write" } } });
    expect(req).toEqual({ id: 3, ownerLogin: "alice", permissions: ["repository:contents"] });
  });
});

// ---------------------------------------------------------------------------
// 3. buildDesired / fetchLive
// ---------------------------------------------------------------------------

describe("tokenApprovalCycle.buildDesired / fetchLive", () => {
  it("keeps only tokenApproval", () => {
    const orgConfig: OrgConfig = { tokenApproval: { default: "deny" }, members: [] };
    expect(tokenApprovalCycle.buildDesired(orgConfig, "test-org", scope)).toEqual({
      tokenApproval: { default: "deny" },
    });
  });

  it("lists pending requests", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/personal-access-token-requests?per_page=100&page=1": [
        { id: 1, owner: { login: "a" }, permissions: { repository: { contents: "read" } } },
      ],
    });
    const live = await tokenApprovalCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.tokenRequests).toHaveLength(1);
    expect(live.tokenRequests![0]!.permissions).toEqual(["repository:contents"]);
  });

  it("tolerates 404 as no requests", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 404: Not Found");
    };
    expect((await tokenApprovalCycle.fetchLive(client, "test-org", scope, makeBudget())).tokenRequests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. diff
// ---------------------------------------------------------------------------

describe("diff integration with token-approval cycle", () => {
  it("emits token-request UPDATEs for decided requests, none for manual", () => {
    const live: LiveOrgState = {
      tokenRequests: [
        { id: 1, ownerLogin: "a", permissions: ["repository:contents"] }, // approve
        { id: 2, ownerLogin: "b", permissions: ["repository:administration"] }, // deny
        { id: 3, ownerLogin: "c", permissions: ["organization:members"] }, // manual? allowed has it? no → deny
      ],
    };
    const desired = tokenApprovalCycle.buildDesired(
      { tokenApproval: { allowedPermissions: ["repository:contents"], default: "deny" } },
      "test-org",
      scope,
    );
    const cs = diff("test-org", desired, live);
    const decisions = Object.fromEntries(
      cs.entries.map((e) => [e.key, (e.after as { decision?: string }).decision]),
    );
    expect(cs.entries.every((e) => e.resourceType === "token-request" && e.kind === "update")).toBe(true);
    expect(decisions["1"]).toBe("approve");
    expect(decisions["2"]).toBe("deny");
  });

  it("leaves requests pending when default is manual", () => {
    const live: LiveOrgState = { tokenRequests: [{ id: 9, permissions: ["repository:administration"] }] };
    const desired = tokenApprovalCycle.buildDesired(
      { tokenApproval: { allowedPermissions: ["repository:contents"] } },
      "test-org",
      scope,
    );
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. apply
// ---------------------------------------------------------------------------

describe("tokenApprovalCycle.apply", () => {
  it("POSTs the decision action", async () => {
    const client = makeMockClient();
    await tokenApprovalCycle.apply(
      client,
      { kind: "update", resourceType: "token-request", key: "8", before: { id: 8 }, after: { decision: "approve" }, fields: [] },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("POST");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/personal-access-token-requests/8");
    expect(client.calls[0]!.body).toEqual({ action: "approve" });
  });

  it("ignores foreign resource types", async () => {
    const client = makeMockClient();
    await tokenApprovalCycle.apply(
      client,
      { kind: "update", resourceType: "token-grant", key: "1", after: { revoke: true } },
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

describe("tokenApprovalCycle via runReconcile", () => {
  it("apply: auto-approves a subset request", async () => {
    const config: GovernanceConfig = {
      orgs: { "test-org": { tokenApproval: { allowedPermissions: ["repository:contents"], default: "manual" } } },
    };
    const client = makeMockClient({
      "GET /orgs/test-org/personal-access-token-requests?per_page=100&page=1": [
        { id: 4, owner: { login: "dev" }, permissions: { repository: { contents: "read" } } },
      ],
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [tokenApprovalCycle],
      mode: "apply",
      allowGuardrailOverride: true,
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    const post = client.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/orgs/test-org/personal-access-token-requests/4");
    expect(post.body).toEqual({ action: "approve" });
  });
});
