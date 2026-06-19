/**
 * Dump mode: export live GitHub org state into a desired-state GovernanceConfig.
 *
 * Adoption starts from reality, not a blank file. The operator trims the
 * emitted config to declare only the resources they want chant to own.
 *
 * ## Round-trip property
 * `diff(dumpOrg(client, org), sameLive)` yields zero changes — dumping then
 * reconciling is a no-op. This holds because every field the diff engine
 * compares is emitted with the exact live value.
 *
 * ## Extension pattern
 * Each supported cycle exposes a `dumpXxx` helper below. To add dump support
 * for a new cycle: add a `dumpXxx` function, call it in `dumpOrg`, include
 * the result in the assembled `OrgConfig`. The structure mirrors the cycle
 * pattern from `src/cycles/README.md`.
 *
 * ## What is emitted
 * Only resources that chant currently supports (branch protection). Resources
 * from the live org that chant has no cycle for are omitted — omission means
 * "unmanaged", consistent with selective-by-omission.
 */

import type { AppClient } from "../auth/app-client.js";
import type {
  GovernanceConfig,
  OrgConfig,
  BranchProtectionConfig,
  RepoConfig,
} from "../config/types.js";
import { fetchLiveForOrg } from "../cycles/branch-protection.js";
import type { LiveOrgState, LiveBranchProtectionConfig } from "./diff.js";
import type { RateBudget } from "./runner.js";
import { BudgetExhaustedError } from "./runner.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Options for `dumpOrg`. */
export interface DumpOrgOptions {
  /**
   * Rate budget to share across all API calls made during the dump.
   * Defaults to 500 requests when omitted.
   */
  budget?: RateBudget;
  /**
   * Repositories to include in the dump. When provided, only these repos are
   * fetched; when absent, all repos discovered via the GitHub API are included.
   *
   * Passing an explicit list avoids the extra paginated list call and is
   * recommended when the caller already knows which repos to manage.
   */
  repos?: string[];
}

/** Result of `dumpOrg` — a valid GovernanceConfig plus a serialized YAML. */
export interface DumpResult {
  /** Fully-typed desired-state config. Passes `loadGovernanceConfig`. */
  config: GovernanceConfig;
  /**
   * YAML serialization of `config` suitable for committing to a repository.
   * Imports no YAML library — hand-serialized to keep the package dependency-free.
   */
  yaml: string;
}

// ---------------------------------------------------------------------------
// Budget helper
// ---------------------------------------------------------------------------

function makeBudget(n: number): RateBudget {
  let remaining = n;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(count = 1) {
      if (remaining <= 0) throw new BudgetExhaustedError();
      remaining = Math.max(0, remaining - count);
    },
  };
}

// ---------------------------------------------------------------------------
// GitHub REST: list repos for org (paginated)
// ---------------------------------------------------------------------------

interface GhRepo {
  name: string;
}

/**
 * Fetch all repository names for `orgLogin` via the GitHub API.
 * Paginates until exhausted or budget runs out.
 */
async function listOrgRepos(
  client: AppClient,
  orgLogin: string,
  budget: RateBudget,
): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  const perPage = 100;

  while (!budget.exhausted) {
    budget.use(1);
    const repos = await client.request<GhRepo[]>(
      "GET",
      `/orgs/${orgLogin}/repos?type=all&per_page=${perPage}&page=${page}`,
    );
    for (const r of repos) names.push(r.name);
    if (repos.length < perPage) break;
    page++;
  }

  return names;
}

// ---------------------------------------------------------------------------
// Branch-protection dump helper
// ---------------------------------------------------------------------------

/**
 * Map a live branch-protection snapshot to a BranchProtectionConfig that will
 * diff as no-op against the same live state.
 *
 * CRITICAL — zero normalization drift: this MUST emit EXACTLY the shape that
 * `fetchBranchProtection` (in `../cycles/branch-protection.ts`) produces. The
 * round-trip no-op property (`diff(dump(...), live)` is empty) only holds when
 * the dumped desired shape matches the live shape field-for-field. The diff
 * engine compares each key PRESENT in desired against live (`diffObjectKeys`),
 * so emitting a key that `fetchBranchProtection` leaves undefined (e.g.
 * `requiredApprovingReviewCount: 0` when PR reviews are off) produces a
 * SPURIOUS update (`0` vs `undefined`).
 *
 * `fetchBranchProtection` sets the review sub-fields ONLY when the parent group
 * is enabled:
 *   - `requiredApprovingReviewCount` / `dismissStaleReviews` /
 *     `requireCodeOwnerReviews` only when `requirePullRequestReviews` is true;
 *   - `requiredStatusCheckContexts` / `requireBranchesToBeUpToDate` only when
 *     `requireStatusChecks` is true.
 * We mirror that conditional emission precisely below.
 *
 * `enforceAdmins` is captured live but is NOT in BranchProtectionConfig
 * (selective-by-omission for an unmanaged field) — it is intentionally omitted.
 */
function normalizeLiveBranchProtection(
  live: LiveBranchProtectionConfig,
): BranchProtectionConfig {
  const bp: BranchProtectionConfig = {
    pattern: live.pattern,
    requirePullRequestReviews: live.requirePullRequestReviews ?? false,
    requireStatusChecks: live.requireStatusChecks ?? false,
    restrictPushes: live.restrictPushes ?? false,
    allowForcePushes: live.allowForcePushes ?? false,
    allowDeletions: live.allowDeletions ?? false,
    requireLinearHistory: live.requireLinearHistory ?? false,
  };

  // PR-review sub-fields: emit ONLY when the parent group is enabled, mirroring
  // `fetchBranchProtection` (which leaves them undefined otherwise).
  if (live.requirePullRequestReviews === true) {
    bp.requiredApprovingReviewCount = live.requiredApprovingReviewCount ?? 0;
    bp.dismissStaleReviews = live.dismissStaleReviews ?? false;
    bp.requireCodeOwnerReviews = live.requireCodeOwnerReviews ?? false;
  }

  // Status-check sub-fields: emit ONLY when the parent group is enabled.
  if (live.requireStatusChecks === true) {
    bp.requiredStatusCheckContexts = live.requiredStatusCheckContexts ?? [];
    bp.requireBranchesToBeUpToDate = live.requireBranchesToBeUpToDate ?? false;
  }

  return bp;
}

/**
 * Build a minimal RepoConfig map containing only branch protection state for
 * the supplied repo names, using the live snapshot already fetched.
 *
 * Repos with no live protection rules are omitted (nothing to manage).
 */
function buildBranchProtectionRepos(
  repoNames: string[],
  live: LiveOrgState,
): Record<string, Pick<RepoConfig, "branchProtection">> {
  const repos: Record<string, Pick<RepoConfig, "branchProtection">> = {};

  for (const name of repoNames) {
    const liveRepo = live.repos?.[name];
    if (!liveRepo?.branchProtection || liveRepo.branchProtection.length === 0) continue;
    repos[name] = {
      branchProtection: liveRepo.branchProtection.map(normalizeLiveBranchProtection),
    };
  }

  return repos;
}

// ---------------------------------------------------------------------------
// YAML serializer (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Serialize a GovernanceConfig to YAML.
 *
 * Hand-written to keep the package free of YAML-library dependencies. Produces
 * clean, deterministic YAML suitable for committing. Values are scalars, arrays
 * of scalars, or nested objects — no multi-line strings in the config shape.
 */
export function serializeToYaml(config: GovernanceConfig): string {
  const lines: string[] = ["orgs:"];

  for (const [orgName, orgConfig] of Object.entries(config.orgs)) {
    lines.push(`  ${yamlKey(orgName)}:`);
    serializeOrgConfig(orgConfig, lines, "    ");
  }

  return lines.join("\n") + "\n";
}

function yamlKey(key: string): string {
  // Quote keys that contain special YAML characters
  if (/[:{}\[\],&*#?|<>=!%@`\s]/.test(key) || key === "") {
    return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return key;
}

function yamlScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Quote strings that could be misinterpreted as YAML values
    if (
      value === "" ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      /[:{}\[\],&*#?|<>=!%@`]/.test(value) ||
      /^\s|\s$/.test(value) ||
      // Purely-numeric or decimal-like strings would round-trip as numbers
      // (e.g. a status-check context "1234" or a branch pattern "1.x").
      /^\d+$/.test(value) ||
      /^\d+\.\d+$/.test(value)
    ) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

function serializeOrgConfig(orgConfig: OrgConfig, lines: string[], indent: string): void {
  if (orgConfig.repos !== undefined) {
    lines.push(`${indent}repos:`);
    for (const [repoName, repoConfig] of Object.entries(orgConfig.repos)) {
      lines.push(`${indent}  ${yamlKey(repoName)}:`);
      serializeRepoConfig(repoConfig, lines, `${indent}    `);
    }
  }
}

function serializeRepoConfig(repoConfig: RepoConfig, lines: string[], indent: string): void {
  const scalarFields: Array<keyof RepoConfig> = [
    "description",
    "websiteUrl",
    "private",
    "hasIssues",
    "hasProjects",
    "hasWiki",
    "defaultBranch",
    "allowSquashMerge",
    "allowMergeCommit",
    "allowRebaseMerge",
    "deleteBranchOnMerge",
  ];

  for (const field of scalarFields) {
    const val = repoConfig[field];
    if (val !== undefined) {
      lines.push(`${indent}${field}: ${yamlScalar(val)}`);
    }
  }

  if (repoConfig.topics !== undefined) {
    lines.push(`${indent}topics:`);
    for (const t of repoConfig.topics) {
      lines.push(`${indent}  - ${yamlScalar(t)}`);
    }
  }

  if (repoConfig.branchProtection !== undefined && repoConfig.branchProtection.length > 0) {
    lines.push(`${indent}branchProtection:`);
    for (const bp of repoConfig.branchProtection) {
      serializeBranchProtection(bp, lines, `${indent}  `);
    }
  }
}

function serializeBranchProtection(
  bp: BranchProtectionConfig,
  lines: string[],
  indent: string,
): void {
  // First entry uses "- " list marker; subsequent fields in the same object
  // use the same indent but are part of the same mapping.
  lines.push(`${indent}- pattern: ${yamlScalar(bp.pattern)}`);
  const fieldIndent = `${indent}  `;

  const boolFields: Array<keyof BranchProtectionConfig> = [
    "requirePullRequestReviews",
    "dismissStaleReviews",
    "requireCodeOwnerReviews",
    "requireStatusChecks",
    "requireBranchesToBeUpToDate",
    "restrictPushes",
    "allowForcePushes",
    "allowDeletions",
    "requireLinearHistory",
  ];

  for (const f of boolFields) {
    const val = bp[f];
    if (val !== undefined) {
      lines.push(`${fieldIndent}${f}: ${yamlScalar(val)}`);
    }
  }

  if (bp.requiredApprovingReviewCount !== undefined) {
    lines.push(`${fieldIndent}requiredApprovingReviewCount: ${bp.requiredApprovingReviewCount}`);
  }

  if (bp.requiredStatusCheckContexts !== undefined) {
    if (bp.requiredStatusCheckContexts.length === 0) {
      lines.push(`${fieldIndent}requiredStatusCheckContexts: []`);
    } else {
      lines.push(`${fieldIndent}requiredStatusCheckContexts:`);
      for (const ctx of bp.requiredStatusCheckContexts) {
        lines.push(`${fieldIndent}  - ${yamlScalar(ctx)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// dumpOrg — public entry point
// ---------------------------------------------------------------------------

/**
 * Fetch the live state for `orgName` and return a GovernanceConfig that:
 *   - Passes `loadGovernanceConfig` validation.
 *   - When diffed against the same live state, yields zero changes (round-trip
 *     no-op).
 *   - Only emits resources that chant's current cycles support (branch
 *     protection). Unsupported live resources are omitted.
 *
 * @param client - Authed GitHub App client.
 * @param orgName - GitHub org login to dump.
 * @param opts - Optional repos list and rate budget.
 */
export async function dumpOrg(
  client: AppClient,
  orgName: string,
  opts: DumpOrgOptions = {},
): Promise<DumpResult> {
  const budget = opts.budget ?? makeBudget(500);

  // ── 1. Discover repos ────────────────────────────────────────────────────
  let repoNames: string[];
  if (opts.repos && opts.repos.length > 0) {
    repoNames = opts.repos;
  } else {
    if (budget.exhausted) throw new BudgetExhaustedError();
    repoNames = await listOrgRepos(client, orgName, budget);
  }

  // ── 2. Fetch live branch-protection state ────────────────────────────────
  // fetchLiveForOrg from the branch-protection cycle requires a
  // Record<string, RepoConfig>. Build a minimal stub so it knows which repos +
  // branches to query. Since we are dumping ALL branches, we need to discover
  // branch protection rules for each repo. GitHub's classic branch-protection
  // API doesn't offer a "list all rules for a repo" endpoint. We use a
  // two-step: list the repo's branches, then probe each for protection.
  // To keep the implementation simple, we call our own helper that mirrors
  // what fetchLiveForOrg does but without needing a pre-known branch list.
  const liveState = await fetchAllBranchProtection(client, orgName, repoNames, budget);

  // ── 3. Assemble OrgConfig ────────────────────────────────────────────────
  const bpRepos = buildBranchProtectionRepos(repoNames, liveState);

  // Merge repos: union of repos that have any supported resource
  const allRepoNames = new Set([...Object.keys(bpRepos)]);
  const repos: Record<string, RepoConfig> = {};
  for (const name of allRepoNames) {
    repos[name] = {
      ...bpRepos[name],
    };
  }

  const orgConfig: OrgConfig = {};
  if (Object.keys(repos).length > 0) {
    orgConfig.repos = repos;
  }

  const config: GovernanceConfig = {
    orgs: { [orgName]: orgConfig },
  };

  return { config, yaml: serializeToYaml(config) };
}

// ---------------------------------------------------------------------------
// fetchAllBranchProtection
// ---------------------------------------------------------------------------

/**
 * Fetch classic branch-protection rules for each repo by:
 *   1. Listing the repo's branches (GET /repos/{org}/{repo}/branches).
 *   2. Calling `fetchLiveForOrg` with a RepoConfig stub seeded with those branches.
 *
 * This mirrors how the branch-protection cycle's `fetchLive` works, but discovers
 * all branches rather than limiting to config-declared ones.
 *
 * ## KNOWN LIMITATION — wildcard branch patterns are not discovered
 *
 * The classic branch-protection REST API
 * (`GET /repos/{owner}/{repo}/branches/{branch}/protection`) accepts only a
 * literal branch name, not a wildcard pattern. This function probes protection
 * by iterating over the repo's actual branch names (step 1 above). A rule set
 * with a wildcard pattern such as `release/*` exists as a protection rule on
 * GitHub but is NOT attached to any individual branch returned by the branch
 * list. It is therefore invisible to this probe and will be SILENTLY OMITTED
 * from the dump output.
 *
 * Consequence: a later `runReconcile` diff between the dumped config and the
 * live state will PROPOSE DELETING the wildcard rule (because the config never
 * declared it), breaking the round-trip no-op guarantee for repos that use
 * wildcard patterns.
 *
 * Resolution path: GitHub's repository-ruleset API
 * (GET /repos/{owner}/{repo}/rulesets) supports wildcard and regex patterns and
 * is the recommended replacement for classic branch protection. A rulesets cycle
 * is tracked in issue #462. Until that cycle ships, operators should manually
 * add any wildcard-pattern rules to the emitted config after running `dump`.
 */
async function fetchAllBranchProtection(
  client: AppClient,
  orgLogin: string,
  repoNames: string[],
  budget: RateBudget,
): Promise<LiveOrgState> {
  if (repoNames.length === 0) return { repos: {} };

  // Build a RepoConfig stub: each repo lists all its branches so
  // fetchLiveForOrg will probe protection for each.
  const repoStubs: Record<string, RepoConfig> = {};

  for (const repoName of repoNames) {
    if (budget.exhausted) break;
    const branches = await listRepoBranches(client, orgLogin, repoName, budget);
    if (branches.length > 0) {
      repoStubs[repoName] = {
        branchProtection: branches.map((b) => ({ pattern: b })),
      };
    }
  }

  if (Object.keys(repoStubs).length === 0) return { repos: {} };

  // fetchLiveForOrg will probe each branch for protection rules.
  return fetchLiveForOrg(client, orgLogin, repoStubs, budget);
}

interface GhBranch {
  name: string;
}

/**
 * List all branch names for a repo. Paginates until exhausted or budget runs out.
 */
async function listRepoBranches(
  client: AppClient,
  orgLogin: string,
  repoName: string,
  budget: RateBudget,
): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  const perPage = 100;

  while (!budget.exhausted) {
    budget.use(1);
    let branches: GhBranch[];
    try {
      branches = await client.request<GhBranch[]>(
        "GET",
        `/repos/${orgLogin}/${repoName}/branches?per_page=${perPage}&page=${page}`,
      );
    } catch (err) {
      // 404 = repo not found or no access; skip silently
      if (err instanceof Error && err.message.includes("404")) break;
      throw err;
    }
    for (const b of branches) names.push(b.name);
    if (branches.length < perPage) break;
    page++;
  }

  return names;
}
