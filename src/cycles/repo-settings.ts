/**
 * Repo-settings cycle.
 *
 * Reconciles per-repository settings — description, website, visibility,
 * feature toggles (issues/projects/wiki), merge settings, default branch, and
 * topics — to match the declared config.
 *
 *   GET   /repos/{owner}/{repo}          — read live settings
 *   PATCH /repos/{owner}/{repo}          — update declared settings (partial)
 *   PUT   /repos/{owner}/{repo}/topics   — replace topics (full replacement)
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Scope and creation
 *
 * This cycle reconciles settings of EXISTING repos; it never creates a repo —
 * repository provisioning/templating is the remit of #10. As with
 * branch-protection, live state is fetched only for repos passed in
 * `scope.repos`; with no scope (e.g. the current CLI wiring) `fetchLive`
 * returns empty and every declared repo is emitted as a create, which `apply`
 * services with a PATCH (idempotent against an existing repo). A PATCH against
 * a genuinely non-existent repo 404s and is recorded as a failed entry rather
 * than silently creating anything.
 *
 * ## Why PATCH needs no RMW merge
 *
 * `PATCH /repos/{owner}/{repo}` is a *partial* update — GitHub touches only the
 * keys in the body. Selective-by-omission therefore holds by sending only
 * declared fields. Topics, however, use a full-replacement PUT, so the topics
 * list is sent verbatim from config (it is managed as a whole list, not merged).
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, RepoConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveRepoConfig } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the repo-settings cycle.
 *
 * Pass `repos` (typically `orgConfig.repos`) to enable accurate live-fetch.
 * Omit it for the fast path where every declared repo is treated as a create.
 * The org login is supplied per-org by the runner as `orgLogin`, not via scope.
 */
export interface RepoSettingsScope {
  repos?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shape (only the fields we read)
// ---------------------------------------------------------------------------

/** Minimal shape of the `GET /repos/{owner}/{repo}` response we care about. */
interface GhRepo {
  description?: string | null;
  homepage?: string | null;
  private?: boolean | null;
  has_issues?: boolean | null;
  has_projects?: boolean | null;
  has_wiki?: boolean | null;
  default_branch?: string | null;
  allow_squash_merge?: boolean | null;
  allow_merge_commit?: boolean | null;
  allow_rebase_merge?: boolean | null;
  delete_branch_on_merge?: boolean | null;
  topics?: string[] | null;
}

/**
 * Settings keys this cycle manages (everything in `RepoConfig` except
 * `branchProtection`, which is owned by the branch-protection cycle).
 */
const MANAGED_REPO_KEYS: Array<keyof RepoConfig> = [
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
  "topics",
];

/** True when a repo config declares at least one managed setting. */
function hasManagedRepoSettings(repo: RepoConfig): boolean {
  return MANAGED_REPO_KEYS.some((k) => repo[k] !== undefined);
}

// ---------------------------------------------------------------------------
// Live-state mapping
// ---------------------------------------------------------------------------

/** Map the GitHub repo GET response to the `LiveRepoConfig` diff shape. */
function mapRepoToLive(raw: GhRepo): LiveRepoConfig {
  const live: LiveRepoConfig = {};

  if (raw.description != null) live.description = raw.description;
  if (raw.homepage != null) live.websiteUrl = raw.homepage;
  if (typeof raw.private === "boolean") live.private = raw.private;
  if (typeof raw.has_issues === "boolean") live.hasIssues = raw.has_issues;
  if (typeof raw.has_projects === "boolean") live.hasProjects = raw.has_projects;
  if (typeof raw.has_wiki === "boolean") live.hasWiki = raw.has_wiki;
  if (raw.default_branch != null) live.defaultBranch = raw.default_branch;
  if (typeof raw.allow_squash_merge === "boolean") live.allowSquashMerge = raw.allow_squash_merge;
  if (typeof raw.allow_merge_commit === "boolean") live.allowMergeCommit = raw.allow_merge_commit;
  if (typeof raw.allow_rebase_merge === "boolean") live.allowRebaseMerge = raw.allow_rebase_merge;
  if (typeof raw.delete_branch_on_merge === "boolean") live.deleteBranchOnMerge = raw.delete_branch_on_merge;
  if (Array.isArray(raw.topics)) live.topics = raw.topics;

  return live;
}

// ---------------------------------------------------------------------------
// PATCH body builder
// ---------------------------------------------------------------------------

/**
 * Build the `PATCH /repos/{owner}/{repo}` body from the declared settings.
 * Only declared keys are emitted; `topics` is excluded (handled by a separate
 * PUT). Returns an empty object when nothing patchable is declared.
 */
export function buildRepoPatchBody(desired: RepoConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (desired.description !== undefined) body.description = desired.description;
  if (desired.websiteUrl !== undefined) body.homepage = desired.websiteUrl;
  if (desired.private !== undefined) body.private = desired.private;
  if (desired.hasIssues !== undefined) body.has_issues = desired.hasIssues;
  if (desired.hasProjects !== undefined) body.has_projects = desired.hasProjects;
  if (desired.hasWiki !== undefined) body.has_wiki = desired.hasWiki;
  if (desired.defaultBranch !== undefined) body.default_branch = desired.defaultBranch;
  if (desired.allowSquashMerge !== undefined) body.allow_squash_merge = desired.allowSquashMerge;
  if (desired.allowMergeCommit !== undefined) body.allow_merge_commit = desired.allowMergeCommit;
  if (desired.allowRebaseMerge !== undefined) body.allow_rebase_merge = desired.allowRebaseMerge;
  if (desired.deleteBranchOnMerge !== undefined) body.delete_branch_on_merge = desired.deleteBranchOnMerge;

  return body;
}

// ---------------------------------------------------------------------------
// repoSettingsCycle — implements Cycle<RepoSettingsScope>
// ---------------------------------------------------------------------------

/**
 * Governance cycle for repository settings.
 *
 * Reconciles the non-branch-protection fields of each repo in the config's
 * `repos` map. Repos and fields absent from config are left untouched.
 */
export const repoSettingsCycle: Cycle<RepoSettingsScope> = {
  name: "repo-settings",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: RepoSettingsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const repos = scope.repos;
    if (!repos || Object.keys(repos).length === 0) {
      return { repos: {} };
    }

    return fetchLiveRepoSettings(client, orgLogin, repos, budget);
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: RepoSettingsScope): OrgConfig {
    if (!orgConfig.repos) return {};

    const repos: Record<string, RepoConfig> = {};
    for (const [name, repoConfig] of Object.entries(orgConfig.repos)) {
      if (!hasManagedRepoSettings(repoConfig)) continue;
      // Keep only managed settings keys — strip branchProtection (other cycle).
      const stripped: RepoConfig = {};
      for (const key of MANAGED_REPO_KEYS) {
        if (repoConfig[key] !== undefined) {
          (stripped as Record<string, unknown>)[key] = repoConfig[key];
        }
      }
      repos[name] = stripped;
    }

    return { repos };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: RepoSettingsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "repo") {
      // Safety: this cycle only handles repo-settings entries.
      return;
    }

    // This cycle never deletes repos (deletion is destructive and out of scope).
    if (entry.kind === "delete") return;

    const repoName = entry.key;
    const desired = entry.after as RepoConfig;

    // 1. PATCH the partial settings body (if anything patchable is declared).
    const body = buildRepoPatchBody(desired);
    if (Object.keys(body).length > 0) {
      budget.use(1);
      await client.request("PATCH", `/repos/${orgLogin}/${repoName}`, body);
    }

    // 2. Topics are a separate full-replacement PUT.
    if (desired.topics !== undefined) {
      budget.use(1);
      await client.request("PUT", `/repos/${orgLogin}/${repoName}/topics`, {
        names: desired.topics,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// fetchLiveRepoSettings — low-level helper (also used directly in tests)
// ---------------------------------------------------------------------------

/**
 * Fetch live settings for a set of repos. One API call per repo that declares
 * at least one managed setting; repos with no managed settings are skipped
 * (zero API calls). A 404 yields no entry for that repo (treated as a create).
 * The budget is checked before each call and the partial result is returned
 * when exhausted mid-loop.
 */
export async function fetchLiveRepoSettings(
  client: AppClient,
  orgLogin: string,
  repos: Record<string, RepoConfig>,
  budget: RateBudget,
): Promise<LiveOrgState> {
  const liveRepos: LiveOrgState["repos"] = {};

  for (const [name, repoConfig] of Object.entries(repos)) {
    if (!hasManagedRepoSettings(repoConfig)) continue;
    if (budget.exhausted) break;

    budget.use(1);
    let raw: GhRepo;
    try {
      raw = await client.request<GhRepo>("GET", `/repos/${orgLogin}/${name}`);
    } catch (err) {
      // 404 → repo not found live; emit no entry (diff will treat as create).
      if (err instanceof Error && err.message.includes("404")) continue;
      throw err;
    }

    liveRepos[name] = mapRepoToLive(raw);
  }

  return { repos: liveRepos };
}
