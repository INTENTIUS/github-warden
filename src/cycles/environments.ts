/**
 * Environments & deployment-protection cycle.
 *
 * Reconciles repository deployment environments — required reviewers, wait
 * timers, self-review prevention, and deployment branch policies.
 *
 *   GET    /repos/{o}/{r}/environments          — list environments
 *   PUT    /repos/{o}/{r}/environments/{env}    — create / update (RMW)
 *   DELETE /repos/{o}/{r}/environments/{env}    — delete
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Read-modify-write: preserve undeclared protection
 *
 * The environment PUT replaces the configuration it is given, so — like
 * branch-protection — `apply` seeds the request body from the LIVE environment
 * (carried on the change-set `before`, or re-fetched if absent) and overlays
 * ONLY the fields the config declares. A config that sets `waitTimer` therefore
 * does not wipe required reviewers or the branch policy.
 *
 * ## Scope
 *
 * Live state is fetched for repos in `scope.repos` that declare `environments`
 * (the branch-protection scope pattern).
 */

import type { AppClient } from "../auth/app-client.js";
import type {
  OrgConfig,
  RepoConfig,
  EnvironmentConfig,
  EnvironmentReviewer,
  DeploymentBranchPolicy,
} from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveEnvironment } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/** Scope for the environments cycle. Pass `repos` (typically `orgConfig.repos`). */
export interface EnvironmentsScope {
  repos?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhProtectionRule {
  type: string;
  wait_timer?: number;
  prevent_self_review?: boolean;
  reviewers?: Array<{ type: "User" | "Team"; reviewer?: { id?: number } }>;
}

interface GhDeploymentBranchPolicy {
  protected_branches?: boolean;
  custom_branch_policies?: boolean;
}

interface GhEnvironment {
  name: string;
  protection_rules?: GhProtectionRule[];
  deployment_branch_policy?: GhDeploymentBranchPolicy | null;
}

interface GhEnvironmentsList {
  environments?: GhEnvironment[];
}

// ---------------------------------------------------------------------------
// Live-state mapping
// ---------------------------------------------------------------------------

/** Map a GitHub environment response to the `LiveEnvironment` diff shape. */
export function mapEnvironmentToLive(raw: GhEnvironment): LiveEnvironment {
  const live: LiveEnvironment = { name: raw.name };

  for (const rule of raw.protection_rules ?? []) {
    if (rule.type === "wait_timer" && typeof rule.wait_timer === "number") {
      live.waitTimer = rule.wait_timer;
    } else if (rule.type === "required_reviewers") {
      if (typeof rule.prevent_self_review === "boolean") {
        live.preventSelfReview = rule.prevent_self_review;
      }
      live.reviewers = (rule.reviewers ?? [])
        .filter((r) => typeof r.reviewer?.id === "number")
        .map((r) => ({ type: r.type, id: r.reviewer!.id! }));
    }
  }

  if (raw.deployment_branch_policy === null) {
    live.deploymentBranchPolicy = null;
  } else if (raw.deployment_branch_policy) {
    live.deploymentBranchPolicy = {
      protectedBranches: raw.deployment_branch_policy.protected_branches ?? false,
      customBranchPolicies: raw.deployment_branch_policy.custom_branch_policies ?? false,
    };
  }

  return live;
}

// ---------------------------------------------------------------------------
// Apply body builder (read-modify-write)
// ---------------------------------------------------------------------------

function dbpToApi(dbp: DeploymentBranchPolicy | null): unknown {
  if (dbp === null) return null;
  return {
    protected_branches: dbp.protectedBranches ?? false,
    custom_branch_policies: dbp.customBranchPolicies ?? false,
  };
}

function reviewersToApi(reviewers: EnvironmentReviewer[]): unknown {
  return reviewers.map((r) => ({ type: r.type, id: r.id }));
}

/**
 * Build the environment PUT body: seed every field from `live` (so the
 * full-replacement PUT preserves undeclared protection), then overlay only the
 * fields the config declares. For a create (`live` null) only declared fields
 * are sent.
 */
export function buildEnvironmentBody(
  desired: EnvironmentConfig,
  live?: LiveEnvironment | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (live) {
    if (live.waitTimer !== undefined) body.wait_timer = live.waitTimer;
    if (live.preventSelfReview !== undefined) body.prevent_self_review = live.preventSelfReview;
    if (live.reviewers !== undefined) body.reviewers = reviewersToApi(live.reviewers);
    if (live.deploymentBranchPolicy !== undefined) {
      body.deployment_branch_policy = dbpToApi(live.deploymentBranchPolicy);
    }
  }

  if (desired.waitTimer !== undefined) body.wait_timer = desired.waitTimer;
  if (desired.preventSelfReview !== undefined) body.prevent_self_review = desired.preventSelfReview;
  if (desired.reviewers !== undefined) body.reviewers = reviewersToApi(desired.reviewers);
  if (desired.deploymentBranchPolicy !== undefined) {
    body.deployment_branch_policy = dbpToApi(desired.deploymentBranchPolicy);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Live-state fetch
// ---------------------------------------------------------------------------

/** Fetch live environments for one repo (one list call). */
async function fetchRepoEnvironments(
  client: AppClient,
  org: string,
  repo: string,
  budget: RateBudget,
): Promise<LiveEnvironment[]> {
  budget.use(1);
  let data: GhEnvironmentsList;
  try {
    data = await client.request<GhEnvironmentsList>("GET", `/repos/${org}/${repo}/environments`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return [];
    throw err;
  }
  return (data.environments ?? []).map(mapEnvironmentToLive);
}

// ---------------------------------------------------------------------------
// environmentsCycle — implements Cycle<EnvironmentsScope>
// ---------------------------------------------------------------------------

export const environmentsCycle: Cycle<EnvironmentsScope> = {
  name: "environments",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: EnvironmentsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const repos: NonNullable<LiveOrgState["repos"]> = {};
    for (const [name, repoConfig] of Object.entries(scope?.repos ?? {})) {
      if (repoConfig.environments === undefined) continue;
      if (budget.exhausted) break;
      repos[name] = { environments: await fetchRepoEnvironments(client, orgLogin, name, budget) };
    }

    return { repos };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: EnvironmentsScope): OrgConfig {
    if (!orgConfig.repos) return {};
    const repos: Record<string, RepoConfig> = {};
    for (const [name, repoConfig] of Object.entries(orgConfig.repos)) {
      if (repoConfig.environments && repoConfig.environments.length > 0) {
        repos[name] = { environments: repoConfig.environments };
      }
    }
    return { repos };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: EnvironmentsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "environment") return;

    // key format: "<repo>/<env>"
    const slashIdx = entry.key.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(
        `environments: malformed entry key "${entry.key}" — expected "<repo>/<env>"`,
      );
    }
    const repo = entry.key.slice(0, slashIdx);
    const env = entry.key.slice(slashIdx + 1);
    const path = `/repos/${orgLogin}/${repo}/environments/${encodeURIComponent(env)}`;

    if (entry.kind === "delete") {
      budget.use(1);
      await client.request("DELETE", path);
      return;
    }

    // create or update — PUT is idempotent. For an update, seed from live so
    // the full-replacement PUT preserves undeclared protection.
    const desired = entry.after as EnvironmentConfig;
    let live: LiveEnvironment | null = null;
    if (entry.kind === "update") {
      live = (entry.before as LiveEnvironment | undefined) ?? null;
      if (!live) {
        const fetched = await fetchRepoEnvironments(client, orgLogin, repo, budget);
        live = fetched.find((e) => e.name === env) ?? null;
      }
    }

    const body = buildEnvironmentBody(desired, live);
    budget.use(1);
    await client.request("PUT", path, body);
  },
};
