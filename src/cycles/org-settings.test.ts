/**
 * Tests for the org-settings cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: strips non-settings fields; omits when settings absent
 *   - fetchLive: maps GitHub org GET response → LiveOrgSettings; 404 → empty
 *   - diff over the cycle: create / update / no-op entries
 *   - apply: PATCH with only declared fields; ignores foreign / delete entries
 *   - runner integration: dry-run plan + apply
 */

import { describe, it, expect } from "vitest";
import { orgSettingsCycle, buildOrgPatchBody } from "./org-settings.js";
import type { OrgSettingsScope } from "./org-settings.js";
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

const scope: OrgSettingsScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("orgSettingsCycle.buildDesired", () => {
  it("returns empty config when settings are absent", () => {
    const orgConfig: OrgConfig = { repos: { a: { description: "x" } } };
    const desired = orgSettingsCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired.settings).toBeUndefined();
    expect(desired.repos).toBeUndefined();
  });

  it("keeps only the settings block, stripping other domains", () => {
    const orgConfig: OrgConfig = {
      settings: { defaultRepositoryPermission: "read" },
      teams: { backend: {} },
      repos: { a: {} },
    };
    const desired = orgSettingsCycle.buildDesired(orgConfig, "test-org", scope);
    expect(desired).toEqual({ settings: { defaultRepositoryPermission: "read" } });
  });
});

// ---------------------------------------------------------------------------
// 2. buildOrgPatchBody
// ---------------------------------------------------------------------------

describe("buildOrgPatchBody", () => {
  it("maps declared fields to GitHub PATCH keys", () => {
    const body = buildOrgPatchBody({
      description: "desc",
      email: "ops@example.com",
      websiteUrl: "https://example.com",
      defaultRepositoryPermission: "read",
      membersCanCreatePublicRepositories: false,
      membersCanCreatePrivateRepositories: true,
      membersCanCreateInternalRepositories: false,
      requireTwoFactorAuthentication: true,
    });
    expect(body).toEqual({
      description: "desc",
      email: "ops@example.com",
      blog: "https://example.com",
      default_repository_permission: "read",
      members_can_create_public_repositories: false,
      members_can_create_private_repositories: true,
      members_can_create_internal_repositories: false,
      two_factor_requirement_enabled: true,
    });
  });

  it("omits undeclared fields (selective-by-omission)", () => {
    const body = buildOrgPatchBody({ defaultRepositoryPermission: "none" });
    expect(body).toEqual({ default_repository_permission: "none" });
  });

  it("returns an empty body when nothing is declared", () => {
    expect(buildOrgPatchBody({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. fetchLive — mapping
// ---------------------------------------------------------------------------

describe("orgSettingsCycle.fetchLive", () => {
  it("maps the GitHub org response to LiveOrgSettings", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org": {
        description: "Acme Corp",
        email: "ops@acme.test",
        blog: "https://acme.test",
        default_repository_permission: "write",
        members_can_create_public_repositories: false,
        members_can_create_private_repositories: true,
        members_can_create_internal_repositories: false,
        two_factor_requirement_enabled: true,
      },
    });

    const live = await orgSettingsCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.settings).toEqual({
      description: "Acme Corp",
      email: "ops@acme.test",
      websiteUrl: "https://acme.test",
      defaultRepositoryPermission: "write",
      membersCanCreatePublicRepositories: false,
      membersCanCreatePrivateRepositories: true,
      membersCanCreateInternalRepositories: false,
      requireTwoFactorAuthentication: true,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("GET");
    expect(client.calls[0]!.path).toBe("/orgs/test-org");
  });

  it("ignores null/absent fields and invalid permission values", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org": {
        description: null,
        blog: null,
        default_repository_permission: "bogus",
      },
    });
    const live = await orgSettingsCycle.fetchLive(client, "test-org", scope, makeBudget());
    expect(live.settings).toEqual({});
  });

  it("charges the budget once", async () => {
    const client = makeMockClient({ "GET /orgs/test-org": {} });
    const budget = makeBudget(5);
    await orgSettingsCycle.fetchLive(client, "test-org", scope, budget);
    expect(budget.remaining).toBe(4);
  });

  it("treats a 404 as empty live state", async () => {
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET /orgs/missing returned 404: Not Found");
    };
    const live = await orgSettingsCycle.fetchLive(client, "missing", scope, makeBudget());
    expect(live.settings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with org-settings cycle", () => {
  const desiredConfig: OrgConfig = {
    settings: { defaultRepositoryPermission: "read", membersCanCreatePublicRepositories: false },
  };

  it("emits create when no live settings exist", () => {
    const live: LiveOrgState = {};
    const desired = orgSettingsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.resourceType).toBe("org-settings");
  });

  it("emits update when a managed field differs", () => {
    const live: LiveOrgState = {
      settings: { defaultRepositoryPermission: "write", membersCanCreatePublicRepositories: false },
    };
    const desired = orgSettingsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("update");
    expect(cs.entries[0]!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "defaultRepositoryPermission", before: "write", after: "read" }),
      ]),
    );
  });

  it("emits no entries when live matches desired", () => {
    const live: LiveOrgState = {
      settings: { defaultRepositoryPermission: "read", membersCanCreatePublicRepositories: false },
    };
    const desired = orgSettingsCycle.buildDesired(desiredConfig, "test-org", scope);
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. apply — create / update / delete / foreign
// ---------------------------------------------------------------------------

describe("orgSettingsCycle.apply", () => {
  it("sends PATCH with only declared fields for an update", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "update" as const,
      resourceType: "org-settings",
      key: "org-settings",
      before: { defaultRepositoryPermission: "write" },
      after: { defaultRepositoryPermission: "read" },
      fields: [{ field: "defaultRepositoryPermission", before: "write", after: "read" }],
    };
    await orgSettingsCycle.apply(client, entry, "my-org", scope, makeBudget());

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("PATCH");
    expect(client.calls[0]!.path).toBe("/orgs/my-org");
    expect(client.calls[0]!.body).toEqual({ default_repository_permission: "read" });
  });

  it("sends PATCH for a create entry", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "create" as const,
      resourceType: "org-settings",
      key: "org-settings",
      after: { description: "new" },
    };
    await orgSettingsCycle.apply(client, entry, "my-org", scope, makeBudget());
    expect(client.calls[0]!.method).toBe("PATCH");
    expect(client.calls[0]!.body).toEqual({ description: "new" });
  });

  it("charges the budget once per apply", async () => {
    const client = makeMockClient();
    const budget = makeBudget(5);
    await orgSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "org-settings", key: "org-settings", after: { email: "x@y.z" } },
      "my-org",
      scope,
      budget,
    );
    expect(budget.remaining).toBe(4);
  });

  it("skips an empty-body apply (no declared writable fields)", async () => {
    const client = makeMockClient();
    await orgSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "org-settings", key: "org-settings", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });

  it("ignores delete entries", async () => {
    const client = makeMockClient();
    await orgSettingsCycle.apply(
      client,
      { kind: "delete", resourceType: "org-settings", key: "org-settings", before: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });

  it("skips non-org-settings entries", async () => {
    const client = makeMockClient();
    await orgSettingsCycle.apply(
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
// 6. Runner integration
// ---------------------------------------------------------------------------

describe("orgSettingsCycle via runReconcile", () => {
  const config: GovernanceConfig = {
    orgs: {
      "test-org": {
        settings: { defaultRepositoryPermission: "read" },
      },
    },
  };

  it("dry-run: plan reports the update without mutating", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org": { default_repository_permission: "admin" },
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [orgSettingsCycle],
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
    const cr = result.cycles[0]!;
    expect(cr.counts.update).toBe(1);
    expect(cr.plan).toContain("1 to update");
  });

  it("apply: sends one PATCH after a GET", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org": { default_repository_permission: "admin" },
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [orgSettingsCycle],
      mode: "apply",
      // No org members in this fixture → adminFloor would otherwise block.
      allowGuardrailOverride: true,
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    const patch = client.calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.path).toBe("/orgs/test-org");
    expect(patch!.body).toEqual({ default_repository_permission: "read" });
  });

  it("selective-by-omission: no settings in config → no entries", async () => {
    const client = makeMockClient({ "GET /orgs/test-org": { default_repository_permission: "admin" } });
    const result = await runReconcile({
      config: { orgs: { "test-org": {} } },
      client,
      cycles: [orgSettingsCycle],
      mode: "dry-run",
    });
    const cr = result.cycles[0]!;
    expect(cr.counts.create + cr.counts.update + cr.counts.delete).toBe(0);
  });
});
