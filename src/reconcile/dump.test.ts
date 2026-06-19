/**
 * Tests for dumpOrg and serializeToYaml.
 *
 * All tests use a mock AppClient — no network calls.
 * Coverage:
 *   - dumpOrg: produces a GovernanceConfig that passes loadGovernanceConfig
 *   - dumpOrg: round-trip no-op — diff(dumped, live) yields zero changes
 *   - dumpOrg: omits repos with no supported resources
 *   - dumpOrg: accepts an explicit repos list (no extra list call)
 *   - serializeToYaml: basic YAML shape correctness
 */

import { describe, it, expect } from "vitest";
import { dumpOrg, serializeToYaml } from "./dump.js";
import { diff } from "./diff.js";
import type { LiveOrgState } from "./diff.js";
import { fetchLiveForOrg } from "../cycles/branch-protection.js";
import { loadGovernanceConfig } from "../config/load.js";
import type { AppClient } from "../auth/app-client.js";
import type { RepoConfig } from "../config/types.js";
import type { RateBudget } from "./runner.js";
import { BudgetExhaustedError } from "./runner.js";

/**
 * Derive the live snapshot from the SAME mock client used for the dump, by
 * running the cycle's real fetch path (`fetchLiveForOrg` →
 * `fetchBranchProtection`). This yields the actual — possibly sparse — shape
 * GitHub responses normalize to in production, instead of a hand-populated
 * fixture with every sub-field set. Round-trip tests MUST use this so they
 * can't mask normalization drift between dump and the cycle.
 */
async function fetchLiveFromMock(
  client: AppClient,
  org: string,
  repoBranches: Record<string, string[]>,
): Promise<LiveOrgState> {
  const repoStubs: Record<string, RepoConfig> = {};
  for (const [repo, branches] of Object.entries(repoBranches)) {
    repoStubs[repo] = { branchProtection: branches.map((pattern) => ({ pattern })) };
  }
  return fetchLiveForOrg(client, org, repoStubs, makeBudget());
}

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
      // Strip query params for lookup to support paginated calls
      const baseKey = `${method} ${path.split("?")[0]!}`;
      const fullKey = `${method} ${path}`;
      if (responseMap.has(fullKey)) return responseMap.get(fullKey) as T;
      if (responseMap.has(baseKey)) return responseMap.get(baseKey) as T;
      // Default: return empty array for list endpoints, {} for others
      if (path.includes("/branches") && !path.includes("/protection")) return [] as unknown as T;
      if (path.includes("/repos?")) return [] as unknown as T;
      return {} as T;
    },
  };
}

function makeBudget(initial = 500): RateBudget {
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
// 1. dumpOrg: config validates under loadGovernanceConfig
// ---------------------------------------------------------------------------

describe("dumpOrg — config validates under loadGovernanceConfig", () => {
  it("produces a valid GovernanceConfig when a repo has branch protection", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/repos": [{ name: "my-repo" }],
      "GET /repos/test-org/my-repo/branches": [{ name: "main" }],
      "GET /repos/test-org/my-repo/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
        },
        required_status_checks: {
          contexts: ["ci/build", "ci/lint"],
          strict: true,
        },
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: true },
        enforce_admins: { enabled: true },
      },
    });

    const result = await dumpOrg(client, "test-org", { budget: makeBudget() });

    // Must not throw
    const loaded = loadGovernanceConfig(result.config);
    expect(loaded).toBeDefined();
    expect(loaded.orgs["test-org"]).toBeDefined();
  });

  it("produces a valid GovernanceConfig even when no repos have protection", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/repos": [{ name: "bare-repo" }],
      // branches returns empty → nothing to probe
      "GET /repos/test-org/bare-repo/branches": [],
    });

    const result = await dumpOrg(client, "test-org", { budget: makeBudget() });
    const loaded = loadGovernanceConfig(result.config);
    expect(loaded.orgs["test-org"]).toBeDefined();
    // No repos to manage
    expect(loaded.orgs["test-org"]!.repos).toBeUndefined();
  });

  it("produces a valid GovernanceConfig when repos list is provided explicitly", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/api/branches": [{ name: "main" }],
      "GET /repos/test-org/api/branches/main/protection": {
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: false },
      },
    });

    const result = await dumpOrg(client, "test-org", {
      repos: ["api"],
      budget: makeBudget(),
    });

    // No org list call made
    expect(client.calls.some((c) => c.path.includes("/orgs/test-org/repos"))).toBe(false);

    const loaded = loadGovernanceConfig(result.config);
    expect(loaded).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trip no-op: diff(dump, live) === empty
// ---------------------------------------------------------------------------

describe("dumpOrg — round-trip no-op", () => {
  // These tests derive `live` from the SAME mock client via the cycle's real
  // `fetchLiveForOrg`/`fetchBranchProtection` path — NOT from hand-populated
  // fixtures. This guarantees the comparison uses the real (possibly-sparse)
  // shape GitHub responses normalize to, so the tests cannot mask drift between
  // dump's normalization and the cycle's normalization.

  it("full protection rule: diff is empty after dump", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/my-repo/branches": [{ name: "main" }],
      "GET /repos/test-org/my-repo/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
        },
        required_status_checks: {
          contexts: ["ci/build", "ci/lint"],
          strict: true,
        },
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: true },
        enforce_admins: { enabled: true },
      },
    });

    const live = await fetchLiveFromMock(client, "test-org", { "my-repo": ["main"] });

    const { config } = await dumpOrg(client, "test-org", {
      repos: ["my-repo"],
      budget: makeBudget(),
    });

    const orgConfig = config.orgs["test-org"]!;
    const changeSet = diff("test-org", orgConfig, live);

    expect(changeSet.entries).toHaveLength(0);
  });

  it("branch with NO PR-review requirement: diff is empty after dump (regression for #454)", async () => {
    // required_pull_request_reviews is null — the majority case. The live
    // snapshot from fetchBranchProtection leaves requiredApprovingReviewCount,
    // dismissStaleReviews, and requireCodeOwnerReviews UNDEFINED. dump must NOT
    // emit those sub-fields (as `0`/`false`), or the diff would compare e.g.
    // `0` vs `undefined` and produce a spurious update for every such branch.
    const client = makeMockClient({
      "GET /repos/test-org/simple-repo/branches": [{ name: "develop" }],
      "GET /repos/test-org/simple-repo/branches/develop/protection": {
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: true },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: false },
      },
    });

    // Live is the REAL sparse shape — requiredApprovingReviewCount etc. absent.
    const live = await fetchLiveFromMock(client, "test-org", { "simple-repo": ["develop"] });

    const liveBp = live.repos!["simple-repo"]!.branchProtection![0]!;
    // Sanity-guard the fixture: the cycle must leave these undefined so this
    // test actually exercises the 0-vs-undefined regression path.
    expect(liveBp.requirePullRequestReviews).toBe(false);
    expect(liveBp).not.toHaveProperty("requiredApprovingReviewCount");
    expect(liveBp.requireStatusChecks).toBe(false);
    expect(liveBp).not.toHaveProperty("requiredStatusCheckContexts");

    const { config } = await dumpOrg(client, "test-org", {
      repos: ["simple-repo"],
      budget: makeBudget(),
    });

    const orgConfig = config.orgs["test-org"]!;
    const changeSet = diff("test-org", orgConfig, live);

    expect(changeSet.entries).toHaveLength(0);
  });

  it("multiple repos and multiple branches: diff is empty after dump", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/repo-a/branches": [{ name: "main" }, { name: "develop" }],
      "GET /repos/test-org/repo-a/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
        },
        required_status_checks: {
          contexts: ["ci/build", "ci/lint"],
          strict: true,
        },
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: true },
        enforce_admins: { enabled: true },
      },
      "GET /repos/test-org/repo-a/branches/develop/protection": {
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: true },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: false },
      },
      "GET /repos/test-org/repo-b/branches": [{ name: "main" }],
      "GET /repos/test-org/repo-b/branches/main/protection": {
        required_pull_request_reviews: null,
        required_status_checks: {
          contexts: ["lint", "test"],
          strict: false,
        },
        restrictions: { users: ["alice"], teams: [] },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: false },
      },
    });

    const live = await fetchLiveFromMock(client, "test-org", {
      "repo-a": ["main", "develop"],
      "repo-b": ["main"],
    });

    const { config } = await dumpOrg(client, "test-org", {
      repos: ["repo-a", "repo-b"],
      budget: makeBudget(),
    });

    const orgConfig = config.orgs["test-org"]!;
    const changeSet = diff("test-org", orgConfig, live);

    expect(changeSet.entries).toHaveLength(0);
  });

  it("unprotected repo: not emitted, no diff entries", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/protected/branches": [{ name: "main" }],
      "GET /repos/test-org/protected/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
        },
        required_status_checks: {
          contexts: ["ci/build", "ci/lint"],
          strict: true,
        },
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: true },
        enforce_admins: { enabled: true },
      },
      "GET /repos/test-org/unprotected/branches": [{ name: "main" }],
      // protection returns 404 → fetchBranchProtection returns null → skipped
    });

    // Override mock to return 404 for unprotected branch
    const origRequest = client.request.bind(client);
    client.request = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      if (path.includes("unprotected") && path.includes("/protection")) {
        client.calls.push({ method, path, body });
        throw new Error(`GET ${path} returned 404: Branch not protected`);
      }
      return origRequest(method, path, body);
    };

    // Live derived from the same mock: "protected" has a rule, "unprotected"
    // 404s → no live rule for it.
    const live = await fetchLiveFromMock(client, "test-org", {
      "protected": ["main"],
      "unprotected": ["main"],
    });

    const { config } = await dumpOrg(client, "test-org", {
      repos: ["protected", "unprotected"],
      budget: makeBudget(),
    });

    // "unprotected" has no protection rules → not in the dump
    expect(config.orgs["test-org"]!.repos).not.toHaveProperty("unprotected");

    // Diff against live: the "protected" repo matches; "unprotected" is not
    // in the desired config, so selective-by-omission applies — no deletes.
    const changeSet = diff("test-org", config.orgs["test-org"]!, live);
    expect(changeSet.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. dumpOrg: omission and selective behaviour
// ---------------------------------------------------------------------------

describe("dumpOrg — selective-by-omission", () => {
  it("emits only repos that have supported live resources", async () => {
    const client = makeMockClient({
      "GET /orgs/test-org/repos": [{ name: "active" }, { name: "idle" }],
      "GET /repos/test-org/active/branches": [{ name: "main" }],
      "GET /repos/test-org/active/branches/main/protection": {
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: false,
          require_code_owner_reviews: false,
        },
        required_status_checks: null,
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: false },
      },
      "GET /repos/test-org/idle/branches": [], // no branches
    });

    const { config } = await dumpOrg(client, "test-org", { budget: makeBudget() });

    const repos = config.orgs["test-org"]!.repos ?? {};
    expect(Object.keys(repos)).toContain("active");
    expect(Object.keys(repos)).not.toContain("idle");
  });

  it("enforceAdmins is NOT in the emitted config (not a config field)", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/my-repo/branches": [{ name: "main" }],
      "GET /repos/test-org/my-repo/branches/main/protection": {
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: true }, // captured live but not a config field
      },
    });

    const { config } = await dumpOrg(client, "test-org", {
      repos: ["my-repo"],
      budget: makeBudget(),
    });

    const bp = config.orgs["test-org"]!.repos!["my-repo"]!.branchProtection![0]!;
    expect(bp).not.toHaveProperty("enforceAdmins");
  });

  it("explicit repos list skips the org repo-list API call", async () => {
    const client = makeMockClient({
      "GET /repos/test-org/specific-repo/branches": [{ name: "main" }],
      "GET /repos/test-org/specific-repo/branches/main/protection": {
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: false },
        enforce_admins: { enabled: false },
      },
    });

    await dumpOrg(client, "test-org", {
      repos: ["specific-repo"],
      budget: makeBudget(),
    });

    const orgListCalls = client.calls.filter((c) =>
      c.method === "GET" && c.path.includes("/orgs/test-org/repos"),
    );
    expect(orgListCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. serializeToYaml
// ---------------------------------------------------------------------------

describe("serializeToYaml", () => {
  it("produces YAML with orgs top-level key", () => {
    const config = {
      orgs: {
        "my-org": {},
      },
    };
    const yaml = serializeToYaml(config);
    expect(yaml).toContain("orgs:");
    expect(yaml).toContain("my-org:");
  });

  it("includes branchProtection rules in YAML output", () => {
    const config = {
      orgs: {
        "my-org": {
          repos: {
            "api": {
              branchProtection: [
                {
                  pattern: "main",
                  requirePullRequestReviews: true,
                  requiredApprovingReviewCount: 2,
                  dismissStaleReviews: false,
                  requireCodeOwnerReviews: false,
                  requireStatusChecks: false,
                  requiredStatusCheckContexts: [],
                  requireBranchesToBeUpToDate: false,
                  restrictPushes: false,
                  allowForcePushes: false,
                  allowDeletions: false,
                  requireLinearHistory: false,
                },
              ],
            },
          },
        },
      },
    };
    const yaml = serializeToYaml(config);
    expect(yaml).toContain("branchProtection:");
    expect(yaml).toContain("pattern: main");
    expect(yaml).toContain("requirePullRequestReviews: true");
    expect(yaml).toContain("requiredApprovingReviewCount: 2");
  });

  it("serializes status check contexts as a list", () => {
    const config = {
      orgs: {
        "my-org": {
          repos: {
            "svc": {
              branchProtection: [
                {
                  pattern: "main",
                  requirePullRequestReviews: false,
                  requiredApprovingReviewCount: 0,
                  dismissStaleReviews: false,
                  requireCodeOwnerReviews: false,
                  requireStatusChecks: true,
                  requiredStatusCheckContexts: ["ci/build", "ci/test"],
                  requireBranchesToBeUpToDate: false,
                  restrictPushes: false,
                  allowForcePushes: false,
                  allowDeletions: false,
                  requireLinearHistory: false,
                },
              ],
            },
          },
        },
      },
    };
    const yaml = serializeToYaml(config);
    expect(yaml).toContain("requiredStatusCheckContexts:");
    expect(yaml).toContain("- ci/build");
    expect(yaml).toContain("- ci/test");
  });

  it("serializes empty status check contexts as inline []", () => {
    const config = {
      orgs: {
        "my-org": {
          repos: {
            "svc": {
              branchProtection: [
                {
                  pattern: "main",
                  requirePullRequestReviews: false,
                  requiredApprovingReviewCount: 0,
                  dismissStaleReviews: false,
                  requireCodeOwnerReviews: false,
                  requireStatusChecks: false,
                  requiredStatusCheckContexts: [],
                  requireBranchesToBeUpToDate: false,
                  restrictPushes: false,
                  allowForcePushes: false,
                  allowDeletions: false,
                  requireLinearHistory: false,
                },
              ],
            },
          },
        },
      },
    };
    const yaml = serializeToYaml(config);
    expect(yaml).toContain("requiredStatusCheckContexts: []");
  });

  it("YAML result string is parseable back to the same structure (basic sanity)", () => {
    const config = {
      orgs: {
        "my-org": {
          repos: {
            "api": {
              branchProtection: [
                {
                  pattern: "main",
                  requirePullRequestReviews: true,
                  requiredApprovingReviewCount: 1,
                  dismissStaleReviews: false,
                  requireCodeOwnerReviews: false,
                  requireStatusChecks: false,
                  requiredStatusCheckContexts: [],
                  requireBranchesToBeUpToDate: false,
                  restrictPushes: false,
                  allowForcePushes: false,
                  allowDeletions: false,
                  requireLinearHistory: false,
                },
              ],
            },
          },
        },
      },
    };
    const yaml = serializeToYaml(config);
    // The YAML should at minimum contain all the expected keys
    expect(yaml).toContain("orgs:");
    expect(yaml).toContain("my-org:");
    expect(yaml).toContain("repos:");
    expect(yaml).toContain("api:");
    expect(yaml).toContain("branchProtection:");
    expect(yaml).toContain("pattern: main");
    expect(yaml).toContain("requirePullRequestReviews: true");
    expect(yaml).toContain("requiredApprovingReviewCount: 1");
    expect(yaml).toContain("dismissStaleReviews: false");
    expect(yaml).toContain("requireStatusChecks: false");
    expect(yaml).toContain("requiredStatusCheckContexts: []");
  });
});
