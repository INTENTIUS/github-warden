/**
 * Tests for the teams cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - buildDesired: keeps teams only; omits when absent
 *   - mapTeamRepoPermission: role_name and permissions-boolean fallbacks
 *   - fetchLive: maps team list + members + repos (scope-gated sub-fetch)
 *   - diff over the cycle: team / team-member / team-repo entries
 *   - apply: team create (parent resolution) / update / delete; member; repo
 *   - guardrails: previously alias collapses a rename into an update
 *   - runner integration: dry-run plan
 */

import { describe, it, expect } from "vitest";
import { teamsCycle, mapTeamRepoPermission } from "./teams.js";
import type { TeamsScope } from "./teams.js";
import type { AppClient } from "../auth/app-client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import { runGuardrails, resolveRenames } from "../reconcile/guardrails.js";
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
      // Any unstubbed list endpoint returns an empty page.
      if (method === "GET" && (path.includes("?") || path.endsWith("/teams"))) return [] as T;
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

const scope: TeamsScope = {};

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("teamsCycle.buildDesired", () => {
  it("returns empty config when teams are absent", () => {
    expect(teamsCycle.buildDesired({ members: [] }, "test-org", scope).teams).toBeUndefined();
  });

  it("keeps only the teams map", () => {
    const orgConfig: OrgConfig = { teams: { backend: { privacy: "closed" } }, members: [] };
    expect(teamsCycle.buildDesired(orgConfig, "test-org", scope)).toEqual({
      teams: { backend: { privacy: "closed" } },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. mapTeamRepoPermission
// ---------------------------------------------------------------------------

describe("mapTeamRepoPermission", () => {
  it("prefers a valid role_name", () => {
    expect(mapTeamRepoPermission({ name: "r", role_name: "maintain" })).toBe("maintain");
  });
  it("falls back to the highest permission boolean", () => {
    expect(mapTeamRepoPermission({ name: "r", permissions: { push: true, pull: true } })).toBe("push");
    expect(mapTeamRepoPermission({ name: "r", permissions: { admin: true } })).toBe("admin");
  });
  it("defaults to pull when nothing is set", () => {
    expect(mapTeamRepoPermission({ name: "r" })).toBe("pull");
  });
});

// ---------------------------------------------------------------------------
// 3. fetchLive
// ---------------------------------------------------------------------------

describe("teamsCycle.fetchLive", () => {
  it("maps the team list and scope-managed sub-resources", async () => {
    const org = "test-org";
    const client = makeMockClient({
      [`GET /orgs/${org}/teams?per_page=100&page=1`]: [
        { slug: "backend", description: "Backend", privacy: "closed", parent: { slug: "eng" } },
      ],
      [`GET /orgs/${org}/teams/backend/members?role=maintainer&per_page=100&page=1`]: [{ login: "alice" }],
      [`GET /orgs/${org}/teams/backend/members?role=member&per_page=100&page=1`]: [{ login: "bob" }],
      [`GET /orgs/${org}/teams/backend/repos?per_page=100&page=1`]: [{ name: "svc", role_name: "push" }],
    });

    const scopeWithTeams: TeamsScope = {
      teams: { backend: { members: [], repos: [] } },
    };
    const live = await teamsCycle.fetchLive(client, org, scopeWithTeams, makeBudget());

    expect(live.teams!["backend"]).toEqual({
      description: "Backend",
      privacy: "closed",
      parentTeamSlug: "eng",
      members: [
        { login: "alice", role: "maintainer" },
        { login: "bob", role: "member" },
      ],
      repos: [{ name: "svc", permission: "push" }],
    });
  });

  it("does not fetch sub-resources for teams not managing them", async () => {
    const org = "test-org";
    const client = makeMockClient({
      [`GET /orgs/${org}/teams?per_page=100&page=1`]: [{ slug: "backend", privacy: "secret" }],
    });
    // No scope.teams entry → only the team list call is made.
    const live = await teamsCycle.fetchLive(client, org, {}, makeBudget());
    expect(live.teams!["backend"]).toEqual({ privacy: "secret" });
    expect(client.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with teams cycle", () => {
  it("emits a single team create with members/repos embedded for a new team", () => {
    // The diff embeds members/repos in the team create entry for brand-new
    // teams (it does not emit separate child entries); applyTeam attaches them.
    const desired = teamsCycle.buildDesired(
      {
        teams: {
          backend: {
            privacy: "closed",
            members: [{ login: "alice", role: "maintainer" }],
            repos: [{ name: "svc", permission: "push" }],
          },
        },
      },
      "test-org",
      scope,
    );
    const cs = diff("test-org", desired, { teams: {} });
    expect(cs.entries).toHaveLength(1);
    const entry = cs.entries[0]!;
    expect(entry.resourceType).toBe("team");
    expect(entry.kind).toBe("create");
    const after = entry.after as { members?: unknown[]; repos?: unknown[] };
    expect(after.members).toEqual([{ login: "alice", role: "maintainer" }]);
    expect(after.repos).toEqual([{ name: "svc", permission: "push" }]);
  });

  it("emits separate team-member/team-repo entries for an existing team", () => {
    const live: LiveOrgState = { teams: { backend: { members: [], repos: [] } } };
    const desired = teamsCycle.buildDesired(
      {
        teams: {
          backend: {
            members: [{ login: "alice", role: "maintainer" }],
            repos: [{ name: "svc", permission: "push" }],
          },
        },
      },
      "test-org",
      scope,
    );
    const cs = diff("test-org", desired, live);
    const types = cs.entries.map((e) => `${e.resourceType}:${e.kind}`);
    expect(types).toContain("team-member:create");
    expect(types).toContain("team-repo:create");
    // canonical ordering: team-member before team-repo
    const order = cs.entries.map((e) => e.resourceType);
    expect(order.indexOf("team-member")).toBeLessThan(order.indexOf("team-repo"));
  });

  it("emits a team-member update when a role changes", () => {
    const live: LiveOrgState = {
      teams: { backend: { members: [{ login: "alice", role: "member" }] } },
    };
    const desired = teamsCycle.buildDesired(
      { teams: { backend: { members: [{ login: "alice", role: "maintainer" }] } } },
      "test-org",
      scope,
    );
    const cs = diff("test-org", desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("team-member");
    expect(cs.entries[0]!.kind).toBe("update");
  });
});

// ---------------------------------------------------------------------------
// 5. apply
// ---------------------------------------------------------------------------

describe("teamsCycle.apply", () => {
  it("creates a team, resolving parentTeamSlug to an id", async () => {
    const client = makeMockClient({ "GET /orgs/my-org/teams/eng": { id: 42 } });
    await teamsCycle.apply(
      client,
      {
        kind: "create",
        resourceType: "team",
        key: "backend",
        after: { description: "Backend", privacy: "closed", parentTeamSlug: "eng" },
      },
      "my-org",
      scope,
      makeBudget(),
    );
    const post = client.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/orgs/my-org/teams");
    expect(post.body).toEqual({
      name: "backend",
      description: "Backend",
      privacy: "closed",
      parent_team_id: 42,
    });
  });

  it("attaches embedded members and repos when creating a team", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      {
        kind: "create",
        resourceType: "team",
        key: "backend",
        after: {
          privacy: "closed",
          members: [{ login: "alice", role: "maintainer" }],
          repos: [{ name: "svc", permission: "push" }],
        },
      },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("POST");
    const member = client.calls.find((c) => c.path.includes("/memberships/"))!;
    expect(member.method).toBe("PUT");
    expect(member.path).toBe("/orgs/my-org/teams/backend/memberships/alice");
    expect(member.body).toEqual({ role: "maintainer" });
    const repo = client.calls.find((c) => c.path.includes("/repos/"))!;
    expect(repo.path).toBe("/orgs/my-org/teams/backend/repos/my-org/svc");
    expect(repo.body).toEqual({ permission: "push" });
  });

  it("does not write the previously hint to GitHub on create", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "create", resourceType: "team", key: "platform", after: { previously: "infra", privacy: "secret" } },
      "my-org",
      scope,
      makeBudget(),
    );
    const post = client.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "platform", privacy: "secret" });
    expect(post.body).not.toHaveProperty("previously");
  });

  it("PATCHes declared fields on update", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "update", resourceType: "team", key: "backend", after: { description: "new" }, fields: [] },
      "my-org",
      scope,
      makeBudget(),
    );
    const patch = client.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/orgs/my-org/teams/backend");
    expect(patch.body).toEqual({ description: "new" });
  });

  it("clears the parent when parentTeamSlug is empty", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "update", resourceType: "team", key: "backend", after: { parentTeamSlug: "" }, fields: [] },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.body).toEqual({ parent_team_id: null });
  });

  it("deletes a team", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "delete", resourceType: "team", key: "old", before: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("DELETE");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/teams/old");
  });

  it("adds/roles and removes team members", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "create", resourceType: "team-member", key: "backend/alice", after: { login: "alice", role: "maintainer" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/teams/backend/memberships/alice");
    expect(client.calls[0]!.body).toEqual({ role: "maintainer" });

    await teamsCycle.apply(
      client,
      { kind: "delete", resourceType: "team-member", key: "backend/bob", before: { login: "bob", role: "member" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[1]!.method).toBe("DELETE");
    expect(client.calls[1]!.path).toBe("/orgs/my-org/teams/backend/memberships/bob");
  });

  it("sets and removes team repo permissions", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "update", resourceType: "team-repo", key: "backend/svc", after: { name: "svc", permission: "admin" } },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe("/orgs/my-org/teams/backend/repos/my-org/svc");
    expect(client.calls[0]!.body).toEqual({ permission: "admin" });
  });

  it("ignores foreign resource types", async () => {
    const client = makeMockClient();
    await teamsCycle.apply(
      client,
      { kind: "create", resourceType: "member", key: "alice", after: {} },
      "my-org",
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(0);
  });

  it("throws on a malformed team-member key", async () => {
    const client = makeMockClient();
    await expect(
      teamsCycle.apply(
        client,
        { kind: "create", resourceType: "team-member", key: "no-slash", after: { login: "x" } },
        "my-org",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow("malformed team-member key");
  });
});

// ---------------------------------------------------------------------------
// 6. Rename-without-loss (guardrail collapse)
// ---------------------------------------------------------------------------

describe("teams rename-without-loss", () => {
  it("collapses delete(previously)+create(slug) into an update and spares removalDeltaCap", () => {
    // Live has 4 teams; config renames one (infra → platform) and keeps the rest.
    const live: LiveOrgState = {
      teams: {
        infra: { privacy: "closed" },
        backend: { privacy: "closed" },
        frontend: { privacy: "closed" },
        data: { privacy: "closed" },
      },
    };
    const desired = teamsCycle.buildDesired(
      {
        teams: {
          platform: { privacy: "closed", previously: "infra" },
          backend: { privacy: "closed" },
          frontend: { privacy: "closed" },
          data: { privacy: "closed" },
        },
      },
      "test-org",
      scope,
    );
    // Ownership enabled so the old slug is eligible for deletion.
    const cs = diff("test-org", desired, live, { isOwned: () => true });

    // Raw change set: one create(platform) + one delete(infra).
    expect(cs.entries.some((e) => e.kind === "create" && e.key === "platform")).toBe(true);
    expect(cs.entries.some((e) => e.kind === "delete" && e.key === "infra")).toBe(true);

    // resolveRenames collapses them into a single update; no deletes remain.
    const resolved = resolveRenames(cs);
    expect(resolved.entries.some((e) => e.kind === "delete")).toBe(false);
    expect(resolved.entries.some((e) => e.kind === "update" && e.key === "platform")).toBe(true);

    // The rename therefore does NOT trip removalDeltaCap. (adminFloor still
    // trips on this memberless fixture, so assert the specific guardrail.)
    const gr = runGuardrails(cs, live);
    const tripped = gr.ok ? [] : gr.diagnostics.map((d) => d.guardrail);
    expect(tripped).not.toContain("removalDeltaCap");
  });
});

// ---------------------------------------------------------------------------
// 7. Runner integration
// ---------------------------------------------------------------------------

describe("teamsCycle via runReconcile", () => {
  it("dry-run: reports a team create plan", async () => {
    const org = "test-org";
    const client = makeMockClient({
      [`GET /orgs/${org}/teams?per_page=100&page=1`]: [],
    });
    const config: GovernanceConfig = {
      orgs: { [org]: { teams: { backend: { privacy: "closed" } } } },
    };
    const result = await runReconcile({ config, client, cycles: [teamsCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
