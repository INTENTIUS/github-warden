import { describe, test, expect } from "vitest";
import { loadGovernanceConfig, GovernanceConfigError } from "./load.js";
import type { GovernanceConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Valid load
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — valid input", () => {
  test("minimal config with empty orgs", () => {
    const result = loadGovernanceConfig({ orgs: {} });
    expect(result).toEqual({ orgs: {} });
  });

  test("full config with all optional fields present", () => {
    const input = {
      orgs: {
        "my-org": {
          settings: {
            description: "My org",
            email: "info@example.com",
            websiteUrl: "https://example.com",
            defaultRepositoryPermission: "read",
            requireTwoFactorAuthentication: true,
            membersCanCreatePublicRepositories: false,
            membersCanCreatePrivateRepositories: true,
            membersCanCreateInternalRepositories: false,
          },
          teams: {
            backend: {
              description: "Backend engineers",
              privacy: "closed",
              members: [
                { login: "alice", role: "maintainer" },
                { login: "bob" },
              ],
              repos: [
                { name: "api", permission: "push" },
              ],
            },
          },
          members: [
            { login: "carol", role: "admin" },
            { login: "dave" },
          ],
          repos: {
            "api": {
              description: "API service",
              private: true,
              hasIssues: true,
              hasProjects: false,
              hasWiki: false,
              defaultBranch: "main",
              allowSquashMerge: true,
              allowMergeCommit: false,
              allowRebaseMerge: false,
              deleteBranchOnMerge: true,
              topics: ["api", "backend"],
              branchProtection: [
                {
                  pattern: "main",
                  requirePullRequestReviews: true,
                  requiredApprovingReviewCount: 1,
                  dismissStaleReviews: true,
                  requireCodeOwnerReviews: true,
                  requireStatusChecks: true,
                  requiredStatusCheckContexts: ["ci/build"],
                  requireBranchesToBeUpToDate: true,
                  restrictPushes: true,
                  allowForcePushes: false,
                  allowDeletions: false,
                  requireLinearHistory: true,
                },
              ],
            },
          },
        },
      },
    };

    const result = loadGovernanceConfig(input);
    const org = result.orgs["my-org"];

    expect(org.settings?.description).toBe("My org");
    expect(org.settings?.defaultRepositoryPermission).toBe("read");
    expect(org.teams?.["backend"].members).toHaveLength(2);
    expect(org.teams?.["backend"].members?.[0].role).toBe("maintainer");
    expect(org.teams?.["backend"].members?.[1].role).toBeUndefined();
    expect(org.members).toHaveLength(2);
    expect(org.repos?.["api"].private).toBe(true);
    expect(org.repos?.["api"].branchProtection?.[0].pattern).toBe("main");
    expect(org.repos?.["api"].topics).toEqual(["api", "backend"]);
  });

  test("returns a normalized GovernanceConfig type", () => {
    const result: GovernanceConfig = loadGovernanceConfig({
      orgs: { "test-org": {} },
    });
    expect(result.orgs["test-org"]).toEqual({});
  });

  test("multiple orgs", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "org-a": { settings: { description: "A" } },
        "org-b": { members: [{ login: "alice" }] },
      },
    });
    expect(Object.keys(result.orgs)).toHaveLength(2);
    expect(result.orgs["org-a"].settings?.description).toBe("A");
    expect(result.orgs["org-b"].members?.[0].login).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// Selective-by-omission: absent fields are not managed
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — selective-by-omission", () => {
  test("absent top-level org fields are undefined in output", () => {
    const result = loadGovernanceConfig({ orgs: { "my-org": {} } });
    const org = result.orgs["my-org"];
    expect(org.settings).toBeUndefined();
    expect(org.teams).toBeUndefined();
    expect(org.members).toBeUndefined();
    expect(org.repos).toBeUndefined();
  });

  test("absent OrgSettings fields are undefined in output", () => {
    const result = loadGovernanceConfig({
      orgs: { "my-org": { settings: { description: "Only description" } } },
    });
    const settings = result.orgs["my-org"].settings;
    expect(settings?.description).toBe("Only description");
    expect(settings?.email).toBeUndefined();
    expect(settings?.requireTwoFactorAuthentication).toBeUndefined();
  });

  test("team with no members key leaves membership unmanaged", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          teams: {
            "infra": { description: "Infra team" },
          },
        },
      },
    });
    const team = result.orgs["my-org"].teams?.["infra"];
    expect(team?.description).toBe("Infra team");
    expect(team?.members).toBeUndefined();
    expect(team?.repos).toBeUndefined();
  });

  test("repo with no branchProtection key leaves protection unmanaged", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          repos: {
            "frontend": { private: false },
          },
        },
      },
    });
    const repo = result.orgs["my-org"].repos?.["frontend"];
    expect(repo?.private).toBe(false);
    expect(repo?.branchProtection).toBeUndefined();
    expect(repo?.topics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid input rejection
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — invalid input rejection", () => {
  test("rejects null input", () => {
    expect(() => loadGovernanceConfig(null)).toThrow(GovernanceConfigError);
  });

  test("rejects string input", () => {
    expect(() => loadGovernanceConfig("not an object")).toThrow(GovernanceConfigError);
  });

  test("rejects array input", () => {
    expect(() => loadGovernanceConfig([])).toThrow(GovernanceConfigError);
  });

  test("rejects missing orgs field", () => {
    expect(() => loadGovernanceConfig({})).toThrow(GovernanceConfigError);
    expect(() => loadGovernanceConfig({})).toThrow(/orgs.*required/);
  });

  test("rejects orgs as array", () => {
    expect(() => loadGovernanceConfig({ orgs: [] })).toThrow(GovernanceConfigError);
  });

  test("rejects invalid defaultRepositoryPermission value", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            settings: { defaultRepositoryPermission: "superadmin" },
          },
        },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects team member missing login", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            teams: {
              backend: { members: [{ role: "member" }] },
            },
          },
        },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects team repo with invalid permission", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            teams: {
              backend: {
                repos: [{ name: "api", permission: "owner" }],
              },
            },
          },
        },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects org member missing login", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { members: [{ role: "admin" }] } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects branch protection missing pattern", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            repos: {
              "api": {
                branchProtection: [{ requirePullRequestReviews: true }],
              },
            },
          },
        },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("error contains meaningful field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            teams: {
              backend: { members: [{ role: "member" }] },
            },
          },
        },
      });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toContain("members");
    expect(caught?.message).toContain("login");
  });

  test("rejects non-boolean value for boolean field", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            repos: { "api": { private: "yes" } },
          },
        },
      })
    ).toThrow(GovernanceConfigError);
  });
});
