/**
 * Tests for the secrets & variables cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps org + repo secrets/variables
 *   - fetchLive: lists org + repo secrets (names) and variables (name+value)
 *   - diff: secret presence (create/delete, no update); variable create/update/delete
 *   - apply: secret delete; secret create reports (never writes values);
 *            variable POST/PATCH/DELETE; value-required guards
 *   - runner integration: dry-run; never-values invariant under apply
 */

import { describe, it, expect } from "vitest";
import { secretsVariablesCycle } from "./secrets-variables.js";
import type { SecretsVariablesScope } from "./secrets-variables.js";
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
      if (method === "GET" && path.includes("/secrets")) return { secrets: [] } as T;
      if (method === "GET" && path.includes("/variables")) return { variables: [] } as T;
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

const scope: SecretsVariablesScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("secretsVariablesCycle.buildDesired", () => {
  it("keeps org and repo secrets/variables, stripping unrelated repo fields", () => {
    const orgConfig: OrgConfig = {
      secrets: [{ name: "ORG_TOKEN" }],
      variables: [{ name: "ORG_ENV", value: "prod" }],
      repos: {
        svc: { secrets: [{ name: "DEPLOY_KEY" }], description: "x" },
        bare: { description: "nothing" },
      },
    };
    const desired = secretsVariablesCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.secrets).toEqual([{ name: "ORG_TOKEN" }]);
    expect(desired.variables).toEqual([{ name: "ORG_ENV", value: "prod" }]);
    expect(desired.repos!["svc"]).toEqual({ secrets: [{ name: "DEPLOY_KEY" }] });
    expect(desired.repos).not.toHaveProperty("bare");
  });
});

// ---------------------------------------------------------------------------
// 2. fetchLive
// ---------------------------------------------------------------------------

describe("secretsVariablesCycle.fetchLive", () => {
  it("lists org secrets (names) and variables (name+value)", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/actions/secrets?per_page=100&page=1": {
        secrets: [{ name: "ORG_TOKEN" }, { name: "OTHER" }],
      },
      "GET /orgs/test-org/actions/variables?per_page=100&page=1": {
        variables: [{ name: "ORG_ENV", value: "prod" }],
      },
    });
    const live = await secretsVariablesCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.secrets).toEqual([{ name: "ORG_TOKEN" }, { name: "OTHER" }]);
    expect(live.variables).toEqual([{ name: "ORG_ENV", value: "prod" }]);
  });

  it("tolerates a 403 on org endpoints as empty", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 403: Resource not accessible by integration");
    };
    const live = await secretsVariablesCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.secrets).toEqual([]);
    expect(live.variables).toEqual([]);
  });

  it("fetches repo secrets/variables only for repos that declare them", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/svc/actions/secrets?per_page=100&page=1": { secrets: [{ name: "DEPLOY_KEY" }] },
    });
    const scopeWithRepos: SecretsVariablesScope = {
      repos: { svc: { secrets: [{ name: "DEPLOY_KEY" }] }, other: { description: "no secrets" } },
    };
    const live = await secretsVariablesCycle.fetchLive(client, "test-org", scopeWithRepos, makeBudget());
    expect(live.repos!["svc"]!.secrets).toEqual([{ name: "DEPLOY_KEY" }]);
    expect(live.repos).not.toHaveProperty("other");
    // No GET for the repo's variables (not declared).
    expect(client.calls.some((c) => c.path.includes("/svc/actions/variables"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. diff
// ---------------------------------------------------------------------------

describe("diff integration with secrets/variables cycle", () => {
  it("secrets diff by presence only — create for missing, no update", () => {
    const desired = secretsVariablesCycle.buildDesired(
      { secrets: [{ name: "A" }, { name: "B" }] },
      "test-org",
      scope,
    );
    const live: LiveOrgState = { secrets: [{ name: "A" }] };
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.resourceType).toBe("org-secret");
    expect(cs.entries[0]!.key).toBe("B");
  });

  it("secret delete is ownership-gated", () => {
    const desired = secretsVariablesCycle.buildDesired({ secrets: [{ name: "A" }] }, "test-org", scope);
    const live: LiveOrgState = { secrets: [{ name: "A" }, { name: "STRAY" }] };
    expect(diff("test-org", desired, live).entries).toHaveLength(0); // no predicate
    const owned = diff("test-org", desired, live, { isOwned: (_t, k) => k === "STRAY" });
    expect(owned.entries.find((e) => e.kind === "delete")!.key).toBe("STRAY");
  });

  it("variable diff emits update when value differs", () => {
    const desired = secretsVariablesCycle.buildDesired(
      { variables: [{ name: "ENV", value: "prod" }] },
      "test-org",
      scope,
    );
    const live: LiveOrgState = { variables: [{ name: "ENV", value: "staging" }] };
    const cs = diff("test-org", desired, live);
    expect(cs.entries[0]!.kind).toBe("update");
    expect(cs.entries[0]!.resourceType).toBe("org-variable");
    expect(cs.entries[0]!.fields).toEqual([{ field: "value", before: "staging", after: "prod" }]);
  });

  it("presence-only variable (no value) emits no update", () => {
    const desired = secretsVariablesCycle.buildDesired({ variables: [{ name: "ENV" }] }, "test-org", scope);
    const live: LiveOrgState = { variables: [{ name: "ENV", value: "staging" }] };
    expect(diff("test-org", desired, live).entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. apply
// ---------------------------------------------------------------------------

describe("secretsVariablesCycle.apply", () => {
  it("never writes secret values — a secret create is reported as an error", async () => {
    const client = makeMockClient();
    await expect(
      secretsVariablesCycle.apply(
        client,
        { kind: "create", resourceType: "org-secret", key: "TOKEN", after: { name: "TOKEN" } },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("provision its value out-of-band");
    expect(client.calls).toHaveLength(0); // no write attempted
  });

  it("DELETEs a secret (repo scope)", async () => {
    const client = makeMockClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "delete", resourceType: "repo-secret", key: "svc/STRAY", before: { name: "STRAY" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("DELETE");
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/actions/secrets/STRAY");
  });

  it("POSTs an org variable with visibility, PATCHes an update, DELETEs", async () => {
    const client = makeMockClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "create", resourceType: "org-variable", key: "ENV", after: { name: "ENV", value: "prod" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("POST");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/actions/variables");
    expect(client.calls[0]!.body).toEqual({ name: "ENV", value: "prod", visibility: "all" });

    await secretsVariablesCycle.apply(
      client,
      { kind: "update", resourceType: "org-variable", key: "ENV", before: { name: "ENV", value: "x" }, after: { name: "ENV", value: "prod" }, fields: [] },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[1]!.method).toBe("PATCH");
    expect(client.calls[1]!.path).toBe("/orgs/my-org/actions/variables/ENV");
    expect(client.calls[1]!.body).toEqual({ value: "prod" });

    await secretsVariablesCycle.apply(
      client,
      { kind: "delete", resourceType: "org-variable", key: "ENV", before: { name: "ENV" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[2]!.method).toBe("DELETE");
  });

  it("POSTs a repo variable without visibility", async () => {
    const client = makeMockClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "create", resourceType: "repo-variable", key: "svc/ENV", after: { name: "ENV", value: "prod" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.path).toBe("/repos/my-org/svc/actions/variables");
    expect(client.calls[0]!.body).toEqual({ name: "ENV", value: "prod" });
  });

  it("errors when creating a variable without a value", async () => {
    const client = makeMockClient();
    await expect(
      secretsVariablesCycle.apply(
        client,
        { kind: "create", resourceType: "org-variable", key: "ENV", after: { name: "ENV" } },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("declared without a value");
  });
});

// ---------------------------------------------------------------------------
// 5. Runner integration
// ---------------------------------------------------------------------------

describe("secretsVariablesCycle via runReconcile", () => {
  it("dry-run: reports a missing secret + a variable update", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/actions/secrets?per_page=100&page=1": { secrets: [] },
      "GET /orgs/test-org/actions/variables?per_page=100&page=1": { variables: [{ name: "ENV", value: "staging" }] },
    });
    const config: GovernanceConfig = {
      orgs: {
        "test-org": {
          secrets: [{ name: "TOKEN" }],
          variables: [{ name: "ENV", value: "prod" }],
        },
      },
    };
    const result = await runReconcile({ config, client, cycles: [secretsVariablesCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(1); // missing secret
    expect(cr.counts.update).toBe(1); // variable value
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("apply: a missing secret surfaces as a reported failure, never a value write", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/actions/secrets?per_page=100&page=1": { secrets: [] },
      "GET /orgs/test-org/actions/variables?per_page=100&page=1": { variables: [] },
    });
    const config: GovernanceConfig = {
      orgs: { "test-org": { secrets: [{ name: "TOKEN" }] } },
    };
    const result = await runReconcile({
      config,
      client,
      cycles: [secretsVariablesCycle],
      mode: "apply",
      allowGuardrailOverride: true,
    });
    const cr = result.cycles[0]!;
    expect(cr.applied).toHaveLength(0);
    expect(cr.failed).toHaveLength(1);
    expect(cr.failed[0]!.error).toContain("provision its value out-of-band");
    // No PUT/POST against the secrets endpoint.
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
