/**
 * Tests for the branch-protection cycle.
 *
 * All tests use a mock AppClient — no network calls.
 * Test coverage:
 *   - buildDesired: omits repos without branchProtection, filters to BP-only shape
 *   - fetchLive (via fetchLiveForOrg): maps GitHub API response to LiveOrgState
 *   - diff over the cycle: create / update / delete entries produced correctly
 *   - apply: correct HTTP calls for create, update, delete
 *   - runner integration: dry-run plan and guardrail cap via runReconcile
 */

import { describe, it, expect } from "vitest";
import { branchProtectionCycle, fetchLiveForOrg } from "./branch-protection.js";
import type { BranchProtectionScope } from "./branch-protection.js";
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
  /** Inject a response for a specific path (looked up in order). */
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
      // Default: return an empty object (simulates 200 with no body needed)
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

// ---------------------------------------------------------------------------
// 1. buildDesired
// ---------------------------------------------------------------------------

describe("branchProtectionCycle.buildDesired", () => {
  const defaultScope: BranchProtectionScope = {};

  it("returns empty config when no repos are defined", () => {
    const orgConfig: OrgConfig = {};
    const desired = branchProtectionCycle.buildDesired(orgConfig, "test-org", defaultScope);
    expect(desired.repos).toBeUndefined();
  });

  it("omits repos with no branchProtection", () => {
    const orgConfig: OrgConfig = {
      repos: {
        "no-bp-repo": { description: "no branch protection config" },
      },
    };
    const desired = branchProtectionCycle.buildDesired(orgConfig, "test-org", defaultScope);
    expect(desired.repos).toEqual({});
  });

  it("omits repos with an empty branchProtection array", () => {
    const orgConfig: OrgConfig = {
      repos: {
        "empty-bp-repo": { branchProtection: [] },
      },
    };
    const desired = branchProtectionCycle.buildDesired(orgConfig, "test-org", defaultScope);
    expect(desired.repos).toEqual({});
  });

  it("keeps repos that have branchProtection rules", () => {
    const orgConfig: OrgConfig = {
      repos: {
        "managed-repo": {
          description: "should be stripped",
          branchProtection: [{ pattern: "main", requirePullRequestReviews: true }],
        },
        "unmanaged-repo": { description: "no bp" },
      },
    };
    const desired = branchProtectionCycle.buildDesired(orgConfig, "test-org", defaultScope);
    expect(desired.repos).toHaveProperty("managed-repo");
    expect(desired.repos).not.toHaveProperty("unmanaged-repo");
    // Only branchProtection is retained — other repo fields stripped
    expect(desired.repos!["managed-repo"]).toEqual({
      branchProtection: [{ pattern: "main", requirePullRequestReviews: true }],
    });
  });

  it("keeps all branch protection entries for a repo", () => {
    const orgConfig: OrgConfig = {
      repos: {
        "multi-bp": {
          branchProtection: [
            { pattern: "main", requirePullRequestReviews: true },
            { pattern: "release/*", requireStatusChecks: true, requiredStatusCheckContexts: ["ci"] },
          ],
        },
      },
    };
    const desired = branchProtectionCycle.buildDesired(orgConfig, "test-org", defaultScope);
    expect(desired.repos!["multi-bp"]!.branchProtection).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. fetchLiveForOrg — live-fetch mapping
// ---------------------------------------------------------------------------

describe("fetchLiveForOrg", () => {
  it("returns empty repos when no repos have branchProtection config", async () => {
    const client = makeMockClient();
    const live = await fetchLiveForOrg(
      client,
      "test-org",
      { "no-bp": { description: "unmanaged" } },
      makeBudget(),
    );
    expect(live.repos).toEqual({});
    expect(client.calls).toHaveLength(0);
  });

  it("maps full GitHub protection response to LiveBranchProtectionConfig", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/my-repo/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
        },
        required_status_checks: {
          contexts: ["ci/build", "ci/test"],
          strict: true,
        },
        restrictions: { users: [], teams: ["infra"] },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: true },
      },
    });

    const live = await fetchLiveForOrg(
      client,
      "test-org",
      { "my-repo": { branchProtection: [{ pattern: "main" }] } },
      makeBudget(),
    );

    const bp = live.repos!["my-repo"]!.branchProtection![0]!;
    expect(bp.pattern).toBe("main");
    expect(bp.requirePullRequestReviews).toBe(true);
    expect(bp.requiredApprovingReviewCount).toBe(2);
    expect(bp.dismissStaleReviews).toBe(true);
    expect(bp.requireCodeOwnerReviews).toBe(false);
    expect(bp.requireStatusChecks).toBe(true);
    expect(bp.requiredStatusCheckContexts).toEqual(["ci/build", "ci/test"]);
    expect(bp.requireBranchesToBeUpToDate).toBe(true);
    expect(bp.restrictPushes).toBe(true); // restrictions object present
    expect(bp.allowForcePushes).toBe(false);
    expect(bp.allowDeletions).toBe(false);
    expect(bp.requireLinearHistory).toBe(true);
  });

  it("treats 404 as no protection (returns no entry for that branch)", async () => {
    const client: MockClient = makeMockClient();
    // Override to throw a 404
    client.request = async <T = unknown>(method: string, path: string): Promise<T> => {
      client.calls.push({ method, path });
      throw new Error("GET ... returned 404: Branch not protected");
    };

    const live = await fetchLiveForOrg(
      client,
      "test-org",
      { "unprotected": { branchProtection: [{ pattern: "main" }] } },
      makeBudget(),
    );

    // 404 → no entry in branchProtection (just an empty array)
    expect(live.repos!["unprotected"]!.branchProtection).toHaveLength(0);
  });

  it("charges the budget — one call per branch pattern", async () => {
    const client = makeMockClient();
    const budget = makeBudget(10);

    await fetchLiveForOrg(
      client,
      "test-org",
      {
        "repo-a": { branchProtection: [{ pattern: "main" }, { pattern: "develop" }] },
        "repo-b": { branchProtection: [{ pattern: "main" }] },
      },
      budget,
    );

    // 3 branches → 3 API calls → budget reduced by 3
    expect(budget.remaining).toBe(7);
    expect(client.calls).toHaveLength(3);
  });

  it("stops fetching when budget is exhausted mid-way", async () => {
    const client = makeMockClient();
    const budget = makeBudget(1); // only 1 request allowed

    await fetchLiveForOrg(
      client,
      "test-org",
      {
        "repo-a": { branchProtection: [{ pattern: "main" }] },
        "repo-b": { branchProtection: [{ pattern: "main" }] },
      },
      budget,
    );

    // Only one branch fetched before budget ran out
    expect(client.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. diff over the cycle
// ---------------------------------------------------------------------------

describe("diff integration with branch-protection cycle", () => {
  const desiredOrgConfig: OrgConfig = {
    repos: {
      "my-repo": {
        branchProtection: [
          {
            pattern: "main",
            requirePullRequestReviews: true,
            requiredApprovingReviewCount: 2,
          },
        ],
      },
    },
  };
  const scope: BranchProtectionScope = {};

  it("emits create when no live protection exists", () => {
    const live: LiveOrgState = { repos: { "my-repo": { branchProtection: [] } } };
    const desired = branchProtectionCycle.buildDesired(desiredOrgConfig, "test-org", scope);
    const changeSet = diff("test-org", desired, live);

    expect(changeSet.entries).toHaveLength(1);
    expect(changeSet.entries[0]!.kind).toBe("create");
    expect(changeSet.entries[0]!.resourceType).toBe("branch-protection");
    expect(changeSet.entries[0]!.key).toBe("my-repo/main");
  });

  it("emits update when a field differs from live", () => {
    const live: LiveOrgState = {
      repos: {
        "my-repo": {
          branchProtection: [
            {
              pattern: "main",
              requirePullRequestReviews: true,
              requiredApprovingReviewCount: 1, // desired wants 2
            },
          ],
        },
      },
    };
    const desired = branchProtectionCycle.buildDesired(desiredOrgConfig, "test-org", scope);
    const changeSet = diff("test-org", desired, live);

    expect(changeSet.entries).toHaveLength(1);
    expect(changeSet.entries[0]!.kind).toBe("update");
    expect(changeSet.entries[0]!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "requiredApprovingReviewCount",
          before: 1,
          after: 2,
        }),
      ]),
    );
  });

  it("emits no entries when live matches desired", () => {
    const live: LiveOrgState = {
      repos: {
        "my-repo": {
          branchProtection: [
            {
              pattern: "main",
              requirePullRequestReviews: true,
              requiredApprovingReviewCount: 2,
            },
          ],
        },
      },
    };
    const desired = branchProtectionCycle.buildDesired(desiredOrgConfig, "test-org", scope);
    const changeSet = diff("test-org", desired, live);

    expect(changeSet.entries).toHaveLength(0);
  });

  it("emits delete for live rules owned by chant and absent from desired", () => {
    const live: LiveOrgState = {
      repos: {
        "my-repo": {
          branchProtection: [
            { pattern: "main", requirePullRequestReviews: true, requiredApprovingReviewCount: 2 },
            { pattern: "develop", requirePullRequestReviews: false }, // not in desired
          ],
        },
      },
    };
    const desired = branchProtectionCycle.buildDesired(desiredOrgConfig, "test-org", scope);
    const changeSet = diff("test-org", desired, live, {
      isOwned: (_type, key) => key === "my-repo/develop",
    });

    const deleteEntry = changeSet.entries.find((e) => e.kind === "delete");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.key).toBe("my-repo/develop");
  });
});

// ---------------------------------------------------------------------------
// 4. apply — create / update / delete
// ---------------------------------------------------------------------------

describe("branchProtectionCycle.apply", () => {
  it("sends PUT request for a create entry", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "create" as const,
      resourceType: "branch-protection",
      key: "my-repo/main",
      after: {
        pattern: "main",
        requirePullRequestReviews: true,
        requiredApprovingReviewCount: 2,
        dismissStaleReviews: false,
        requireCodeOwnerReviews: false,
        requireStatusChecks: false,
        allowForcePushes: false,
        allowDeletions: false,
        requireLinearHistory: false,
      },
    };

    await branchProtectionCycle.apply(client, entry, "test-org", {}, makeBudget());

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe(
      "/repos/test-org/my-repo/branches/main/protection",
    );
    expect(client.calls[0]!.body).toMatchObject({
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
      },
      allow_force_pushes: false,
      allow_deletions: false,
      required_linear_history: false,
    });
  });

  it("sends PUT request for an update entry", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "update" as const,
      resourceType: "branch-protection",
      key: "api-service/release/1.0",
      before: { pattern: "release/1.0", requiredApprovingReviewCount: 1 },
      after: { pattern: "release/1.0", requiredApprovingReviewCount: 2, requirePullRequestReviews: true },
      fields: [{ field: "requiredApprovingReviewCount", before: 1, after: 2 }],
    };

    await branchProtectionCycle.apply(client, entry, "my-org", {}, makeBudget());

    // Branch pattern with slash should be URL-encoded
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe(
      "/repos/my-org/api-service/branches/release%2F1.0/protection",
    );
  });

  it("preserves undeclared live fields on update (no silent downgrade)", async () => {
    // SECURITY INVARIANT: GitHub's PUT is full-replacement. A config that
    // tightens ONE field must not disable PR-review enforcement or let admins
    // bypass protection. Applying a config that declares field X must change
    // ONLY X; every other live setting is echoed back unchanged.
    const client = makeMockClient();

    // Live state: PR reviews enforced (2 approvals, code-owner reviews) AND
    // enforce_admins=true. The `before` snapshot is what the diff carries.
    const before = {
      pattern: "main",
      requirePullRequestReviews: true,
      requiredApprovingReviewCount: 2,
      dismissStaleReviews: true,
      requireCodeOwnerReviews: true,
      requireStatusChecks: true,
      requiredStatusCheckContexts: ["ci/build"],
      requireBranchesToBeUpToDate: true,
      restrictPushes: true,
      allowForcePushes: false,
      allowDeletions: false,
      requireLinearHistory: true,
      enforceAdmins: true,
    };

    // Config tightens ONLY allowForcePushes (true → false is already false;
    // declare allowDeletions=false as the single intended change).
    const entry = {
      kind: "update" as const,
      resourceType: "branch-protection",
      key: "secure-repo/main",
      before,
      after: { pattern: "main", allowDeletions: false },
      fields: [{ field: "allowDeletions", before: false, after: false }],
    };

    await branchProtectionCycle.apply(client, entry, "test-org", {}, makeBudget());

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("PUT");
    expect(client.calls[0]!.path).toBe(
      "/repos/test-org/secure-repo/branches/main/protection",
    );
    const body = client.calls[0]!.body as Record<string, unknown>;

    // PR-review enforcement preserved (not nulled).
    expect(body.required_pull_request_reviews).toEqual({
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
    });
    // Admin enforcement preserved (not reset to false).
    expect(body.enforce_admins).toBe(true);
    // Status checks preserved.
    expect(body.required_status_checks).toEqual({
      strict: true,
      contexts: ["ci/build"],
    });
    // Restrictions preserved.
    expect(body.restrictions).toEqual({ users: [], teams: [] });
    // Other live booleans preserved.
    expect(body.allow_force_pushes).toBe(false);
    expect(body.required_linear_history).toBe(true);
    // The one declared field is set as declared.
    expect(body.allow_deletions).toBe(false);
  });

  it("fetches live protection on update when before snapshot is absent", async () => {
    // If a change-set entry lacks `before`, apply must read live state (and
    // charge the budget) rather than null-to-disable undeclared fields.
    const client = makeMockClient({
      "GET /repos/test-org/secure-repo/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 3,
          dismiss_stale_reviews: false,
          require_code_owner_reviews: true,
        },
        enforce_admins: { enabled: true },
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: false },
      },
    });
    const budget = makeBudget(5);

    const entry = {
      kind: "update" as const,
      resourceType: "branch-protection",
      key: "secure-repo/main",
      // no `before`
      after: { pattern: "main", allowDeletions: true },
      fields: [{ field: "allowDeletions", before: false, after: true }],
    };

    await branchProtectionCycle.apply(client, entry, "test-org", {}, budget);

    // One GET (live fetch) + one PUT (apply) → budget charged twice.
    expect(budget.remaining).toBe(3);
    const put = client.calls.find((c) => c.method === "PUT")!;
    const body = put.body as Record<string, unknown>;
    expect(body.required_pull_request_reviews).toEqual({
      required_approving_review_count: 3,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: true,
    });
    expect(body.enforce_admins).toBe(true);
    expect(body.allow_deletions).toBe(true);
  });

  it("create entry sets only declared fields with safe defaults (no live)", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "create" as const,
      resourceType: "branch-protection",
      key: "new-repo/main",
      after: { pattern: "main", requirePullRequestReviews: true },
    };

    await branchProtectionCycle.apply(client, entry, "test-org", {}, makeBudget());

    // No GET — creates have no live to preserve.
    expect(client.calls).toHaveLength(1);
    const body = client.calls[0]!.body as Record<string, unknown>;
    expect(body.required_pull_request_reviews).toEqual({
      required_approving_review_count: 1,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
    });
    // Required nullable keys present at safe defaults (not enabling anything
    // the caller did not ask for).
    expect(body.required_status_checks).toBeNull();
    expect(body.enforce_admins).toBe(false);
    expect(body.restrictions).toBeNull();
  });

  it("sends DELETE request for a delete entry", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "delete" as const,
      resourceType: "branch-protection",
      key: "old-repo/develop",
      before: { pattern: "develop" },
    };

    await branchProtectionCycle.apply(client, entry, "my-org", {}, makeBudget());

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe("DELETE");
    expect(client.calls[0]!.path).toBe(
      "/repos/my-org/old-repo/branches/develop/protection",
    );
  });

  it("charges the budget once per apply", async () => {
    const client = makeMockClient();
    const budget = makeBudget(5);
    const entry = {
      kind: "delete" as const,
      resourceType: "branch-protection",
      key: "repo/main",
      before: { pattern: "main" },
    };

    await branchProtectionCycle.apply(client, entry, "my-org", {}, budget);

    expect(budget.remaining).toBe(4);
    // orgLogin must resolve into the URL — passing undefined would produce
    // "/repos/undefined/...".
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.path).toBe(
      "/repos/my-org/repo/branches/main/protection",
    );
  });

  it("skips non-branch-protection entries", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "create" as const,
      resourceType: "team",
      key: "some-team",
      after: { description: "a team" },
    };

    await branchProtectionCycle.apply(client, entry, "my-org", {}, makeBudget());

    expect(client.calls).toHaveLength(0);
  });

  it("throws on malformed key", async () => {
    const client = makeMockClient();
    const entry = {
      kind: "create" as const,
      resourceType: "branch-protection",
      key: "no-slash-here",
      after: { pattern: "main" },
    };

    await expect(
      branchProtectionCycle.apply(client, entry, "my-org", {}, makeBudget()),
    ).rejects.toThrow("malformed entry key");
  });
});

// ---------------------------------------------------------------------------
// 5. Runner integration
// ---------------------------------------------------------------------------

describe("branchProtectionCycle via runReconcile", () => {
  it("dry-run: plan shows correct create count (no live protection)", async () => {
    // Mock client returns 404-style errors for GET protection → no live rules
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      client.calls.push({ method, path, body });
      if (method === "GET" && path.includes("/protection")) {
        throw new Error("GET ... returned 404: Branch not protected");
      }
      return {} as T;
    };

    const config: GovernanceConfig = {
      orgs: {
        "test-org": {
          repos: {
            "my-repo": {
              branchProtection: [
                { pattern: "main", requirePullRequestReviews: true },
                { pattern: "develop", requireStatusChecks: true },
              ],
            },
          },
        },
      },
    };

    // scope includes repos so fetchLive fetches live state (404 → empty → creates)
    const scope: BranchProtectionScope = {
      repos: config.orgs["test-org"]!.repos,
    };
    const result = await runReconcile({
      config,
      client,
      cycles: [branchProtectionCycle],
      scope,
      mode: "dry-run",
    });

    expect(result.mode).toBe("dry-run");
    expect(result.completed).toBe(true);
    // fetchLive made API calls (GET /protection) but no mutations
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);

    const cr = result.cycles[0]!;
    expect(cr.name).toBe("branch-protection");
    expect(cr.counts.create).toBe(2);
    expect(cr.counts.update).toBe(0);
    expect(cr.counts.delete).toBe(0);
    expect(cr.plan).toContain("2 to create");
  });

  it("apply: sends one PUT per branch protection rule", async () => {
    // fetchLive returns 404 (no live protection) → desired rule is a create
    // apply then sends a PUT to create the protection rule
    const client: MockClient = makeMockClient();
    client.request = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      client.calls.push({ method, path, body });
      if (method === "GET" && path.includes("/protection")) {
        throw new Error("GET ... returned 404: Branch not protected");
      }
      return {} as T;
    };

    const config: GovernanceConfig = {
      orgs: {
        "test-org": {
          repos: {
            "my-repo": {
              branchProtection: [
                { pattern: "main", requirePullRequestReviews: true, requiredApprovingReviewCount: 2 },
              ],
            },
          },
        },
      },
    };

    const scope: BranchProtectionScope = {
      repos: config.orgs["test-org"]!.repos,
    };

    const result = await runReconcile({
      config,
      client,
      cycles: [branchProtectionCycle],
      scope,
      mode: "apply",
      // allowGuardrailOverride because there are no org members in this test
      // fixture — adminFloor would otherwise block the apply. The adminFloor
      // guardrail is not what this test covers; a dedicated guardrail test
      // verifies removalDeltaCap trips correctly.
      allowGuardrailOverride: true,
    });

    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    // One GET (fetchLive) + one PUT (apply)
    expect(client.calls).toHaveLength(2);
    const putCall = client.calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    expect(putCall!.path).toContain("/protection");
  });

  it("guardrail cap: removing many rules trips removalDeltaCap", async () => {
    const client = makeMockClient();

    // Config: one managed repo, but with an empty branchProtection → cycle
    // builds desired with no bp entries. The live state (injected via a wrapper
    // cycle) has 10 existing rules → 10 deletes.
    //
    // We test the guardrail by constructing the ChangeSet directly (the cycle's
    // fetchLive returns empty state, so a direct diff lets us inject live).
    const live: LiveOrgState = {
      repos: {
        "big-repo": {
          branchProtection: Array.from({ length: 10 }, (_, i) => ({
            pattern: `feature-${i}`,
            requirePullRequestReviews: false,
          })),
        },
      },
    };

    // desired: big-repo has only 1 bp rule — rest are absent from config
    const desiredConfig: OrgConfig = {
      repos: {
        "big-repo": {
          branchProtection: [{ pattern: "main", requirePullRequestReviews: true }],
        },
      },
    };
    const desired = branchProtectionCycle.buildDesired(desiredConfig, "test-org", {});

    // Apply an ownership predicate so all live patterns are owned
    const changeSet = diff("test-org", desired, live, {
      isOwned: () => true,
    });

    // 1 create + 10 deletes; removalDeltaCap(0.25) trips: 10/10 = 100% > 25%
    const { runGuardrails } = await import("../reconcile/guardrails.js");
    const gr = runGuardrails(changeSet, live);
    expect(gr.ok).toBe(false);
    if (!gr.ok) {
      expect(gr.diagnostics.some((d) => d.guardrail === "removalDeltaCap")).toBe(true);
    }
  });

  it("selective-by-omission: repos not in config produce no entries", async () => {
    const client = makeMockClient();
    const config: GovernanceConfig = {
      orgs: {
        "test-org": {
          // repos is absent entirely
        },
      },
    };

    const result = await runReconcile({
      config,
      client,
      cycles: [branchProtectionCycle],
      scope: {} satisfies BranchProtectionScope,
      mode: "dry-run",
    });

    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(0);
    expect(cr.counts.update).toBe(0);
    expect(cr.counts.delete).toBe(0);
  });
});
