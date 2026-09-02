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
// `owned` — per-org ownership declaration
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — owned", () => {
  test("forwards owned: true", () => {
    const result = loadGovernanceConfig({ orgs: { "my-org": { owned: true } } });
    expect(result.orgs["my-org"].owned).toBe(true);
  });

  test("forwards owned: false", () => {
    const result = loadGovernanceConfig({ orgs: { "my-org": { owned: false } } });
    expect(result.orgs["my-org"].owned).toBe(false);
  });

  test("forwards owned as a resource-type list", () => {
    const result = loadGovernanceConfig({
      orgs: { "my-org": { owned: ["team", "repo"] } },
    });
    expect(result.orgs["my-org"].owned).toEqual(["team", "repo"]);
  });

  test("absent owned stays undefined (no deletes planned)", () => {
    const result = loadGovernanceConfig({ orgs: { "my-org": {} } });
    expect(result.orgs["my-org"].owned).toBeUndefined();
  });

  test("rejects owned as a string", () => {
    expect(() =>
      loadGovernanceConfig({ orgs: { "my-org": { owned: "yes" } } })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects owned as an object", () => {
    expect(() =>
      loadGovernanceConfig({ orgs: { "my-org": { owned: { team: true } } } })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a non-string entry in the owned list with the field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({ orgs: { "my-org": { owned: ["team", 42] } } });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toBe("orgs.my-org.owned[1]");
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

// ---------------------------------------------------------------------------
// Team rename hint — `previously`
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — team previously", () => {
  test("forwards the previously rename hint", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          teams: { platform: { previously: "platform-be" } },
        },
      },
    });
    expect(result.orgs["my-org"].teams?.["platform"].previously).toBe("platform-be");
  });

  test("rejects a non-string previously with the field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({
        orgs: { "my-org": { teams: { platform: { previously: 42 } } } },
      });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toBe("orgs.my-org.teams.platform.previously");
  });
});

// ---------------------------------------------------------------------------
// Rulesets — org and repo
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — rulesets", () => {
  const ruleset = {
    name: "main-protection",
    target: "branch",
    enforcement: "active",
    bypassActors: [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
  };

  test("forwards org rulesets verbatim", () => {
    const result = loadGovernanceConfig({ orgs: { "my-org": { rulesets: [ruleset] } } });
    expect(result.orgs["my-org"].rulesets).toEqual([ruleset]);
  });

  test("forwards repo rulesets verbatim", () => {
    const result = loadGovernanceConfig({
      orgs: { "my-org": { repos: { api: { rulesets: [ruleset] } } } },
    });
    expect(result.orgs["my-org"].repos?.["api"].rulesets).toEqual([ruleset]);
  });

  test("rejects a ruleset missing name", () => {
    expect(() =>
      loadGovernanceConfig({ orgs: { "my-org": { rulesets: [{ enforcement: "active" }] } } })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects an invalid enforcement value", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { rulesets: [{ name: "r", enforcement: "strict" }] } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects an invalid target value", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { rulesets: [{ name: "r", target: "commit" }] } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a non-object rule entry with the field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({
        orgs: { "my-org": { rulesets: [{ name: "r", rules: ["pull_request"] }] } },
      });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toBe("orgs.my-org.rulesets[0].rules[0]");
  });

  test("rejects non-array bypassActors", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { rulesets: [{ name: "r", bypassActors: {} }] } },
      })
    ).toThrow(GovernanceConfigError);
  });
});

// ---------------------------------------------------------------------------
// Actions secrets & variables — org and repo
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — secrets and variables", () => {
  test("forwards org secrets with rotationRef", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          secrets: [{ name: "DEPLOY_KEY", rotationRef: "TICKET-42" }, { name: "NPM_TOKEN" }],
        },
      },
    });
    expect(result.orgs["my-org"].secrets).toEqual([
      { name: "DEPLOY_KEY", rotationRef: "TICKET-42" },
      { name: "NPM_TOKEN" },
    ]);
  });

  test("forwards repo secrets and variables", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          repos: {
            api: {
              secrets: [{ name: "API_KEY" }],
              variables: [{ name: "NODE_ENV", value: "production" }],
            },
          },
        },
      },
    });
    const repo = result.orgs["my-org"].repos?.["api"];
    expect(repo?.secrets).toEqual([{ name: "API_KEY" }]);
    expect(repo?.variables).toEqual([{ name: "NODE_ENV", value: "production" }]);
  });

  test("forwards org variables with visibility", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          variables: [{ name: "REGION", value: "eu-west-1", visibility: "private" }],
        },
      },
    });
    expect(result.orgs["my-org"].variables).toEqual([
      { name: "REGION", value: "eu-west-1", visibility: "private" },
    ]);
  });

  test("rejects a secret missing name", () => {
    expect(() =>
      loadGovernanceConfig({ orgs: { "my-org": { secrets: [{ rotationRef: "x" }] } } })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a variable with invalid visibility", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { variables: [{ name: "V", visibility: "public" }] } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a variable missing name with the field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({
        orgs: { "my-org": { repos: { api: { variables: [{ value: "x" }] } } } },
      });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toBe("orgs.my-org.repos.api.variables[0].name");
  });
});

// ---------------------------------------------------------------------------
// Deployment environments
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — environments", () => {
  test("forwards a full environment", () => {
    const env = {
      name: "production",
      waitTimer: 30,
      preventSelfReview: true,
      reviewers: [
        { type: "User", id: 123 },
        { type: "Team", id: 456 },
      ],
      deploymentBranchPolicy: { protectedBranches: true },
    };
    const result = loadGovernanceConfig({
      orgs: { "my-org": { repos: { api: { environments: [env] } } } },
    });
    expect(result.orgs["my-org"].repos?.["api"].environments).toEqual([env]);
  });

  test("forwards a declared-null deploymentBranchPolicy", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          repos: {
            api: { environments: [{ name: "staging", deploymentBranchPolicy: null }] },
          },
        },
      },
    });
    expect(result.orgs["my-org"].repos?.["api"].environments?.[0].deploymentBranchPolicy).toBeNull();
  });

  test("rejects an environment missing name", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { repos: { api: { environments: [{ waitTimer: 5 }] } } } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a reviewer with invalid type", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            repos: {
              api: {
                environments: [{ name: "prod", reviewers: [{ type: "Bot", id: 1 }] }],
              },
            },
          },
        },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a reviewer missing id with the field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({
        orgs: {
          "my-org": {
            repos: {
              api: { environments: [{ name: "prod", reviewers: [{ type: "User" }] }] },
            },
          },
        },
      });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toBe("orgs.my-org.repos.api.environments[0].reviewers[0].id");
  });
});

// ---------------------------------------------------------------------------
// Repo security features
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — repo security", () => {
  test("forwards all security toggles", () => {
    const security = {
      advancedSecurity: true,
      secretScanning: true,
      secretScanningPushProtection: false,
      vulnerabilityAlerts: true,
      dependabotSecurityUpdates: true,
    };
    const result = loadGovernanceConfig({
      orgs: { "my-org": { repos: { api: { security } } } },
    });
    expect(result.orgs["my-org"].repos?.["api"].security).toEqual(security);
  });

  test("rejects a non-boolean security toggle", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { repos: { api: { security: { secretScanning: "on" } } } } },
      })
    ).toThrow(GovernanceConfigError);
  });
});

// ---------------------------------------------------------------------------
// Dependabot config file
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — dependabot", () => {
  test("forwards the file content", () => {
    const content = "version: 2\nupdates: []\n";
    const result = loadGovernanceConfig({
      orgs: { "my-org": { repos: { api: { dependabot: { content } } } } },
    });
    expect(result.orgs["my-org"].repos?.["api"].dependabot).toEqual({ content });
  });

  test("rejects a dependabot block missing content", () => {
    expect(() =>
      loadGovernanceConfig({ orgs: { "my-org": { repos: { api: { dependabot: {} } } } } })
    ).toThrow(/content.*required/);
  });
});

// ---------------------------------------------------------------------------
// Repo baselines (provisioning)
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — repoBaselines", () => {
  test("forwards baselines with template and privacy", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          repoBaselines: [
            { name: "service-a", template: "my-org/service-template", private: true },
            { name: "service-b" },
          ],
        },
      },
    });
    expect(result.orgs["my-org"].repoBaselines).toEqual([
      { name: "service-a", template: "my-org/service-template", private: true },
      { name: "service-b" },
    ]);
  });

  test("rejects a baseline missing name", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { repoBaselines: [{ template: "org/tmpl" }] } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects a non-boolean private flag", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { repoBaselines: [{ name: "r", private: "yes" }] } },
      })
    ).toThrow(GovernanceConfigError);
  });
});

// ---------------------------------------------------------------------------
// Machine users
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — machineUsers", () => {
  test("forwards the login list", () => {
    const result = loadGovernanceConfig({
      orgs: { "my-org": { machineUsers: ["ci-bot", "deploy-bot"] } },
    });
    expect(result.orgs["my-org"].machineUsers).toEqual(["ci-bot", "deploy-bot"]);
  });

  test("rejects a non-string entry with the field path", () => {
    let caught: GovernanceConfigError | undefined;
    try {
      loadGovernanceConfig({ orgs: { "my-org": { machineUsers: ["ci-bot", 7] } } });
    } catch (err) {
      caught = err as GovernanceConfigError;
    }
    expect(caught).toBeInstanceOf(GovernanceConfigError);
    expect(caught?.field).toBe("orgs.my-org.machineUsers[1]");
  });
});

// ---------------------------------------------------------------------------
// Token governance & approval policies
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — tokenPolicy", () => {
  test("forwards all policy fields", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          tokenPolicy: { revokeExpired: true, maxLifetimeDays: 90, maxIdleDays: 30 },
        },
      },
    });
    expect(result.orgs["my-org"].tokenPolicy).toEqual({
      revokeExpired: true,
      maxLifetimeDays: 90,
      maxIdleDays: 30,
    });
  });

  test("rejects a non-number maxLifetimeDays", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { tokenPolicy: { maxLifetimeDays: "90" } } },
      })
    ).toThrow(GovernanceConfigError);
  });
});

describe("loadGovernanceConfig — tokenApproval", () => {
  test("forwards allowedPermissions and default", () => {
    const result = loadGovernanceConfig({
      orgs: {
        "my-org": {
          tokenApproval: { allowedPermissions: ["contents", "issues"], default: "deny" },
        },
      },
    });
    expect(result.orgs["my-org"].tokenApproval).toEqual({
      allowedPermissions: ["contents", "issues"],
      default: "deny",
    });
  });

  test("rejects an invalid default decision", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { tokenApproval: { default: "approve" } } },
      })
    ).toThrow(GovernanceConfigError);
  });

  test("rejects non-array allowedPermissions", () => {
    expect(() =>
      loadGovernanceConfig({
        orgs: { "my-org": { tokenApproval: { allowedPermissions: "contents" } } },
      })
    ).toThrow(GovernanceConfigError);
  });
});

// ---------------------------------------------------------------------------
// Maximal config round-trip — every typed slice survives the loader verbatim
// ---------------------------------------------------------------------------

describe("loadGovernanceConfig — maximal config round-trip", () => {
  test("loaded config deep-equals the input", () => {
    const input = {
      orgs: {
        "my-org": {
          owned: ["team", "repo", "org-variable"],
          settings: {
            description: "My org",
            email: "info@example.com",
            websiteUrl: "https://example.com",
            membersCanCreatePublicRepositories: false,
            membersCanCreatePrivateRepositories: true,
            membersCanCreateInternalRepositories: false,
            defaultRepositoryPermission: "read",
            requireTwoFactorAuthentication: true,
          },
          teams: {
            platform: {
              description: "Platform team",
              privacy: "closed",
              parentTeamSlug: "engineering",
              previously: "platform-be",
              members: [{ login: "alice", role: "maintainer" }, { login: "bob" }],
              repos: [{ name: "api", permission: "push" }],
            },
          },
          members: [{ login: "carol", role: "admin" }, { login: "dave" }],
          repos: {
            api: {
              description: "API service",
              websiteUrl: "https://api.example.com",
              private: true,
              hasIssues: true,
              hasProjects: false,
              hasWiki: false,
              defaultBranch: "main",
              allowSquashMerge: true,
              allowMergeCommit: false,
              allowRebaseMerge: false,
              deleteBranchOnMerge: true,
              branchProtection: [
                {
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
                },
              ],
              topics: ["api", "backend"],
              rulesets: [
                {
                  name: "main-ruleset",
                  target: "branch",
                  enforcement: "active",
                  bypassActors: [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }],
                  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
                  rules: [{ type: "deletion" }],
                },
              ],
              security: {
                advancedSecurity: true,
                secretScanning: true,
                secretScanningPushProtection: true,
                vulnerabilityAlerts: true,
                dependabotSecurityUpdates: true,
              },
              environments: [
                {
                  name: "production",
                  waitTimer: 30,
                  preventSelfReview: true,
                  reviewers: [{ type: "Team", id: 42 }],
                  deploymentBranchPolicy: { protectedBranches: true },
                },
              ],
              secrets: [{ name: "API_KEY", rotationRef: "TICKET-1" }],
              variables: [{ name: "NODE_ENV", value: "production" }],
              dependabot: { content: "version: 2\nupdates: []\n" },
            },
          },
          rulesets: [{ name: "org-wide", target: "tag", enforcement: "evaluate" }],
          secrets: [{ name: "ORG_DEPLOY_KEY" }],
          variables: [{ name: "REGION", value: "eu-west-1", visibility: "all" }],
          repoBaselines: [{ name: "service-a", template: "my-org/tmpl", private: true }],
          machineUsers: ["ci-bot"],
          tokenPolicy: { revokeExpired: true, maxLifetimeDays: 90, maxIdleDays: 30 },
          tokenApproval: { allowedPermissions: ["contents"], default: "manual" },
        },
      },
    };

    const result = loadGovernanceConfig(input);
    expect(result).toEqual(input);
  });
});
