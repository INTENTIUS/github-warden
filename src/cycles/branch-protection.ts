/**
 * Classic branch-protection cycle.
 *
 * Covers GitHub's CLASSIC branch protection only
 * (PUT /repos/{owner}/{repo}/branches/{branch}/protection). Repository
 * rulesets are a separate REST API and are NOT implemented here — they will be
 * a separate follow-up.
 *
 * This is the TEMPLATE cycle — the first concrete implementation of the `Cycle`
 * interface. Every subsequent cycle should follow this four-part structure:
 *
 *   1. Config shape   — what the caller declares in `GovernanceConfig`
 *   2. fetchLive      — read live state from the GitHub API (budget-aware)
 *   3. buildDesired   — map config → the diff's `OrgConfig` shape (pure)
 *   4. apply          — create / update / delete one `ChangeSetEntry` (budget-aware)
 *
 * See `src/cycles/README.md` for the copy-paste guide.
 *
 * GitHub API endpoints used:
 *   GET  /repos/{owner}/{repo}/branches/{branch}/protection
 *   PUT  /repos/{owner}/{repo}/branches/{branch}/protection
 *   DELETE /repos/{owner}/{repo}/branches/{branch}/protection
 *
 * Selective-by-omission: repos absent from config are never touched. Fields
 * absent from a `BranchProtectionConfig` entry are not reconciled.
 *
 * ## Scope
 *
 * `TScope` is `BranchProtectionScope` — a plain object with only an optional
 * `repos` map. The org login is NOT part of the scope; it is supplied to each
 * cycle method as `orgLogin` by the runner (one call per org in the config).
 * When `repos` is present, `fetchLive` fetches the live branch protection state
 * for those repos. When absent, `fetchLive` returns an empty state (all desired
 * entries will appear as creates).
 *
 * Typical usage with the runner:
 *
 * ```ts
 * await runReconcile({
 *   config,
 *   client,
 *   cycles: [branchProtectionCycle],
 *   scope: {
 *     repos: config.orgs["my-org"]!.repos,
 *   },
 *   mode: "apply",
 * });
 * ```
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, BranchProtectionConfig, RepoConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveBranchProtectionConfig } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the branch-protection cycle.
 *
 * Pass `repos` to enable accurate live-fetch (fetches branch protection state
 * for each configured repo). Omit `repos` to get fast-path behaviour where all
 * desired rules are treated as creates (useful when you only need to push new
 * rules and do not care about detecting drift).
 *
 * Note: the org login is NOT part of the scope — it is passed to each cycle
 * method as `orgLogin` by the runner. This means a single scope object can be
 * shared across all org iterations in a multi-org config.
 */
export interface BranchProtectionScope {
  /**
   * Subset of repos to fetch live protection for. Typically set to
   * `orgConfig.repos` for the relevant org. Absent → no live fetch (all
   * desired rules will be emitted as creates).
   *
   * When using a multi-org config, leave this unset and let the runner supply
   * `orgLogin`; the cycle will read repos from the per-org config automatically.
   */
  repos?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we use)
// ---------------------------------------------------------------------------

/** Minimal shape of the branch protection GET response we care about. */
interface GhBranchProtection {
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
  } | null;
  required_status_checks?: {
    contexts?: string[];
    strict?: boolean;
  } | null;
  restrictions?: {
    users: unknown[];
    teams: unknown[];
  } | null;
  enforce_admins?: { enabled: boolean } | boolean | null;
  allow_force_pushes?: { enabled: boolean } | null;
  allow_deletions?: { enabled: boolean } | null;
  required_linear_history?: { enabled: boolean } | null;
}

// ---------------------------------------------------------------------------
// Live-state fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the branch protection rule for one branch pattern.
 * Returns null when the branch/protection does not exist (404).
 */
async function fetchBranchProtection(
  client: AppClient,
  owner: string,
  repo: string,
  branch: string,
  budget: RateBudget,
): Promise<LiveBranchProtectionConfig | null> {
  budget.use(1);
  let raw: GhBranchProtection;
  try {
    raw = await client.request<GhBranchProtection>(
      "GET",
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
    );
  } catch (err) {
    // 404 means no protection rule — not an error, just no live state.
    if (
      err instanceof Error &&
      (err.message.includes("404") || err.message.includes("Branch not protected"))
    ) {
      return null;
    }
    throw err;
  }

  const live: LiveBranchProtectionConfig = { pattern: branch };

  if (raw.required_pull_request_reviews !== undefined && raw.required_pull_request_reviews !== null) {
    live.requirePullRequestReviews = true;
    live.requiredApprovingReviewCount =
      raw.required_pull_request_reviews.required_approving_review_count ?? 0;
    live.dismissStaleReviews = raw.required_pull_request_reviews.dismiss_stale_reviews ?? false;
    live.requireCodeOwnerReviews =
      raw.required_pull_request_reviews.require_code_owner_reviews ?? false;
  } else {
    live.requirePullRequestReviews = false;
  }

  if (raw.required_status_checks !== undefined && raw.required_status_checks !== null) {
    live.requireStatusChecks = true;
    live.requiredStatusCheckContexts = raw.required_status_checks.contexts ?? [];
    live.requireBranchesToBeUpToDate = raw.required_status_checks.strict ?? false;
  } else {
    live.requireStatusChecks = false;
  }

  live.restrictPushes = raw.restrictions !== undefined && raw.restrictions !== null;
  live.allowForcePushes = raw.allow_force_pushes?.enabled ?? false;
  live.allowDeletions = raw.allow_deletions?.enabled ?? false;
  live.requireLinearHistory = raw.required_linear_history?.enabled ?? false;
  // enforce_admins comes back as { enabled } on GitHub's GET response; tolerate
  // a bare boolean too. Captured so the apply path can preserve it.
  live.enforceAdmins =
    typeof raw.enforce_admins === "boolean"
      ? raw.enforce_admins
      : raw.enforce_admins?.enabled ?? false;

  return live;
}

// ---------------------------------------------------------------------------
// BranchProtection API write helpers
// ---------------------------------------------------------------------------

/**
 * Build the GitHub API request body for PUT /branches/{branch}/protection.
 *
 * CRITICAL: the GitHub branch-protection PUT endpoint is a FULL-REPLACEMENT
 * operation — every top-level key omitted from the body is reset to its
 * disabled/default value. A naive body that nulls undeclared fields would
 * silently disable PR-review enforcement, let admins bypass protection, etc.
 *
 * To honour selective-by-omission in the apply path we do a read-modify-write:
 *   1. Seed the body from the LIVE protection state (`live`), so every field
 *      currently set on the branch is echoed back unchanged.
 *   2. Overlay ONLY the fields the config actually declares (`desired`).
 *
 * Net invariant: applying a config that declares field X changes ONLY X; every
 * other live setting — including `enforce_admins` and
 * `required_pull_request_reviews` — is preserved at its live value.
 *
 * For a CREATE (no `live`) the body contains only declared fields; the four
 * GitHub-required nullable keys (`required_status_checks`, `enforce_admins`,
 * `required_pull_request_reviews`, `restrictions`) are filled with GitHub's
 * documented safe defaults when not declared — never null-to-disable a field
 * the caller asked to enable.
 *
 * @param desired - The branch-protection fields the config declares.
 * @param live - Live protection snapshot (`before`) for an update, or null/
 *   undefined for a create.
 */
function buildProtectionBody(
  desired: BranchProtectionConfig,
  live?: LiveBranchProtectionConfig | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // ── Seed from LIVE state (update path) ───────────────────────────────────
  // Echo back every field GitHub's PUT would otherwise reset. The four keys
  // below are required by the endpoint and are nullable; the rest are optional
  // booleans that default to false when absent.
  if (live) {
    body.required_pull_request_reviews =
      live.requirePullRequestReviews === true
        ? {
            required_approving_review_count: live.requiredApprovingReviewCount ?? 0,
            dismiss_stale_reviews: live.dismissStaleReviews ?? false,
            require_code_owner_reviews: live.requireCodeOwnerReviews ?? false,
          }
        : null;

    body.required_status_checks =
      live.requireStatusChecks === true
        ? {
            strict: live.requireBranchesToBeUpToDate ?? false,
            contexts: live.requiredStatusCheckContexts ?? [],
          }
        : null;

    // enforce_admins is not exposed in our config — preserve the live value.
    body.enforce_admins = live.enforceAdmins ?? false;
    body.restrictions = live.restrictPushes === true ? { users: [], teams: [] } : null;
    body.allow_force_pushes = live.allowForcePushes ?? false;
    body.allow_deletions = live.allowDeletions ?? false;
    body.required_linear_history = live.requireLinearHistory ?? false;
  } else {
    // ── CREATE path: GitHub-required keys at safe defaults ─────────────────
    // null here means "feature not enabled", which is the safe default for a
    // brand-new rule — it does not downgrade any existing setting.
    body.required_pull_request_reviews = null;
    body.required_status_checks = null;
    body.enforce_admins = false;
    body.restrictions = null;
  }

  // ── Overlay ONLY declared fields ─────────────────────────────────────────
  // PR reviews: declared → build from declared sub-fields, falling back to the
  // live sub-value (then a safe default) for any sub-field not declared.
  if (desired.requirePullRequestReviews !== undefined) {
    if (desired.requirePullRequestReviews === true) {
      body.required_pull_request_reviews = {
        required_approving_review_count:
          desired.requiredApprovingReviewCount ?? live?.requiredApprovingReviewCount ?? 1,
        dismiss_stale_reviews:
          desired.dismissStaleReviews ?? live?.dismissStaleReviews ?? false,
        require_code_owner_reviews:
          desired.requireCodeOwnerReviews ?? live?.requireCodeOwnerReviews ?? false,
      };
    } else {
      body.required_pull_request_reviews = null;
    }
  } else if (
    body.required_pull_request_reviews !== null &&
    typeof body.required_pull_request_reviews === "object"
  ) {
    // Not declared, but live had reviews enabled — allow declared sub-fields
    // to refine the echoed object without flipping the enabled state.
    const prr = body.required_pull_request_reviews as Record<string, unknown>;
    if (desired.requiredApprovingReviewCount !== undefined) {
      prr.required_approving_review_count = desired.requiredApprovingReviewCount;
    }
    if (desired.dismissStaleReviews !== undefined) {
      prr.dismiss_stale_reviews = desired.dismissStaleReviews;
    }
    if (desired.requireCodeOwnerReviews !== undefined) {
      prr.require_code_owner_reviews = desired.requireCodeOwnerReviews;
    }
  }

  // Status checks: declared → build from declared sub-fields, falling back to
  // live for undeclared sub-fields.
  if (desired.requireStatusChecks !== undefined) {
    if (desired.requireStatusChecks === true) {
      body.required_status_checks = {
        strict: desired.requireBranchesToBeUpToDate ?? live?.requireBranchesToBeUpToDate ?? false,
        contexts:
          desired.requiredStatusCheckContexts ?? live?.requiredStatusCheckContexts ?? [],
      };
    } else {
      body.required_status_checks = null;
    }
  } else if (
    body.required_status_checks !== null &&
    typeof body.required_status_checks === "object"
  ) {
    const rsc = body.required_status_checks as Record<string, unknown>;
    if (desired.requireBranchesToBeUpToDate !== undefined) {
      rsc.strict = desired.requireBranchesToBeUpToDate;
    }
    if (desired.requiredStatusCheckContexts !== undefined) {
      rsc.contexts = desired.requiredStatusCheckContexts;
    }
  }

  // Restrictions: only when declared.
  if (desired.restrictPushes !== undefined) {
    body.restrictions = desired.restrictPushes === true ? { users: [], teams: [] } : null;
  }

  // Optional boolean flags: only set when declared. When undeclared the value
  // already carries the live setting (update) or is left unset (create, where
  // GitHub treats absence as the documented default).
  if (desired.allowForcePushes !== undefined) {
    body.allow_force_pushes = desired.allowForcePushes;
  }
  if (desired.allowDeletions !== undefined) {
    body.allow_deletions = desired.allowDeletions;
  }
  if (desired.requireLinearHistory !== undefined) {
    body.required_linear_history = desired.requireLinearHistory;
  }

  return body;
}

// ---------------------------------------------------------------------------
// BranchProtectionCycle — implements Cycle<BranchProtectionScope>
// ---------------------------------------------------------------------------

/**
 * Governance cycle for repository branch-protection rules.
 *
 * Reconciles the `branchProtection` array under each repo in the config's
 * `repos` map. Creates, updates, or deletes branch protection rules on GitHub
 * to match desired state.
 *
 * The cycle leaves repos, branches, and fields absent from the config entirely
 * untouched (selective-by-omission).
 */
export const branchProtectionCycle: Cycle<BranchProtectionScope> = {
  name: "branch-protection",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: BranchProtectionScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const repos = scope.repos;
    if (!repos || Object.keys(repos).length === 0) {
      // No repos in scope: return empty state. The diff will emit creates for
      // all desired rules. Useful when pushing new rules without checking drift.
      return { repos: {} };
    }

    // Use orgLogin (supplied by the runner) — not scope — for GitHub API paths.
    // This is critical for multi-org configs where the runner iterates orgs and
    // calls this method once per org: scope is shared, orgLogin is per-org.
    return fetchLiveForOrg(client, orgLogin, repos, budget);
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: BranchProtectionScope): OrgConfig {
    // Keep only the repos that have branchProtection config. Repo-level fields
    // (description, visibility, etc.) are handled by a separate cycle.
    if (!orgConfig.repos) return {};

    const repos: Record<string, RepoConfig> = {};
    for (const [repoName, repoConfig] of Object.entries(orgConfig.repos)) {
      if (repoConfig.branchProtection && repoConfig.branchProtection.length > 0) {
        repos[repoName] = { branchProtection: repoConfig.branchProtection };
      }
    }

    return { repos };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: BranchProtectionScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "branch-protection") {
      // Safety: this cycle only handles branch-protection entries.
      return;
    }

    // key format: "<repo>/<branch-pattern>" (set by diff.ts)
    const slashIdx = entry.key.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(
        `branch-protection: malformed entry key "${entry.key}" — expected "<repo>/<branch>"`,
      );
    }
    const repoName = entry.key.slice(0, slashIdx);
    const branchPattern = entry.key.slice(slashIdx + 1);
    // Use orgLogin (supplied by the runner) — not scope — for GitHub API paths.
    const owner = orgLogin;

    const url = `/repos/${owner}/${repoName}/branches/${encodeURIComponent(branchPattern)}/protection`;

    if (entry.kind === "delete") {
      budget.use(1);
      await client.request("DELETE", url);
      return;
    }

    // create or update — both use PUT (idempotent on GitHub's side).
    const desired = entry.after as BranchProtectionConfig;

    // For an update, GitHub's PUT is a FULL REPLACEMENT, so we must echo back
    // every undeclared live field. Prefer the change-set entry's `before`
    // snapshot (the diff already carries it). If it is missing — e.g. the entry
    // was produced without a live fetch — fetch live protection now and charge
    // the budget for it, so we never null-to-disable an undeclared field.
    let live: LiveBranchProtectionConfig | null = null;
    if (entry.kind === "update") {
      live = (entry.before as LiveBranchProtectionConfig | undefined) ?? null;
      if (!live) {
        live = await fetchBranchProtection(client, owner, repoName, branchPattern, budget);
      }
    }

    const body = buildProtectionBody(desired, live);
    budget.use(1);
    await client.request("PUT", url, body);
  },
};

// ---------------------------------------------------------------------------
// fetchLiveForOrg — low-level helper (also used by the cycle internally)
// ---------------------------------------------------------------------------

/**
 * Fetch live branch-protection state for a specific set of repos.
 *
 * Each branch in each repo's `branchProtection` config costs one API call.
 * The budget is checked before each iteration; when exhausted the
 * partially-fetched state is returned so the runner can record deferred work.
 *
 * Repos with no `branchProtection` config are skipped (zero API calls).
 * A 404 for a specific branch means no protection rule is live for it —
 * returned as an absent entry (not an error).
 */
export async function fetchLiveForOrg(
  client: AppClient,
  orgLogin: string,
  repos: Record<string, RepoConfig>,
  budget: RateBudget,
): Promise<LiveOrgState> {
  const liveRepos: LiveOrgState["repos"] = {};

  for (const [repoName, repoConfig] of Object.entries(repos)) {
    if (!repoConfig.branchProtection || repoConfig.branchProtection.length === 0) continue;

    if (budget.exhausted) break;

    const liveBranchProtections: LiveBranchProtectionConfig[] = [];

    for (const bp of repoConfig.branchProtection) {
      if (budget.exhausted) break;
      const live = await fetchBranchProtection(client, orgLogin, repoName, bp.pattern, budget);
      if (live) liveBranchProtections.push(live);
    }

    liveRepos[repoName] = { branchProtection: liveBranchProtections };
  }

  return { repos: liveRepos };
}
