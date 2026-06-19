/**
 * Repository baseline / templating cycle.
 *
 * Ensures every repo declared in `repoBaselines` EXISTS in the org, creating a
 * missing repo — optionally from a template. This is the provisioning backstop:
 * run on a schedule, it guarantees declared repos exist. It does NOT reconcile
 * a repo's settings (description, visibility, branch protection, …) — those are
 * owned by the per-repo cycles via the `repos` map.
 *
 *   GET  /orgs/{org}/repos                              — list existing repos
 *   POST /orgs/{org}/repos                              — create an empty repo
 *   POST /repos/{tmplOwner}/{tmplRepo}/generate         — create from a template
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Why a periodic backstop (not a webhook)
 *
 * GitHub repo creation is not a state this cycle can "reconcile" continuously
 * from a single source — but a scheduled run that ensures declared repos exist
 * (creating the missing ones) is a clean fit for the existing `Cycle`/runner
 * model and needs no webhook-delivery infrastructure. An event-driven
 * `repository.created` template-provisioner is a possible future complement.
 *
 * ## Existence-only
 *
 * Emits only "repo-baseline" creates (for missing declared repos); never
 * updates or deletes a repo. Deleting repos is intentionally out of scope.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, RepoBaselineConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveRepoConfig } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the repo-baseline cycle. The org is identified by `orgLogin`; the
 * full org repo list is fetched to determine which declared repos are missing.
 */
export type RepoBaselineScope = Record<string, never>;

// ---------------------------------------------------------------------------
// GitHub REST API response shapes
// ---------------------------------------------------------------------------

interface GhRepoSummary {
  name: string;
}

const PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Live-state fetch
// ---------------------------------------------------------------------------

/** List existing org repo names (paginated), as a presence map. */
export async function listOrgRepoNames(
  client: AppClient,
  orgLogin: string,
  budget: RateBudget,
): Promise<Record<string, LiveRepoConfig>> {
  const repos: Record<string, LiveRepoConfig> = {};
  let page = 1;
  for (;;) {
    if (budget.exhausted) break;
    budget.use(1);
    const batch = await client.request<GhRepoSummary[]>(
      "GET",
      `/orgs/${orgLogin}/repos?per_page=${PER_PAGE}&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const r of batch) {
      if (r && typeof r.name === "string") repos[r.name] = {};
    }
    if (batch.length < PER_PAGE) break;
    page++;
  }
  return repos;
}

// ---------------------------------------------------------------------------
// repoBaselineCycle — implements Cycle<RepoBaselineScope>
// ---------------------------------------------------------------------------

export const repoBaselineCycle: Cycle<RepoBaselineScope> = {
  name: "repo-baseline",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    _scope: RepoBaselineScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }
    return { repos: await listOrgRepoNames(client, orgLogin, budget) };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: RepoBaselineScope): OrgConfig {
    if (!orgConfig.repoBaselines) return {};
    return { repoBaselines: orgConfig.repoBaselines };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: RepoBaselineScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "repo-baseline") return;
    // Existence-only: the diff never emits update/delete for this type.
    if (entry.kind !== "create") return;

    const baseline = entry.after as RepoBaselineConfig;
    const isPrivate = baseline.private ?? true;

    budget.use(1);
    if (baseline.template) {
      const slashIdx = baseline.template.indexOf("/");
      if (slashIdx === -1) {
        throw new Error(
          `repo-baseline: malformed template "${baseline.template}" — expected "owner/repo"`,
        );
      }
      const tmplOwner = baseline.template.slice(0, slashIdx);
      const tmplRepo = baseline.template.slice(slashIdx + 1);
      await client.request("POST", `/repos/${tmplOwner}/${tmplRepo}/generate`, {
        owner: orgLogin,
        name: baseline.name,
        private: isPrivate,
      });
      return;
    }

    await client.request("POST", `/orgs/${orgLogin}/repos`, {
      name: baseline.name,
      private: isPrivate,
    });
  },
};
