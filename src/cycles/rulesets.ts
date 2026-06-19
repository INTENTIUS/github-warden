/**
 * Rulesets cycle (repo + org).
 *
 * Reconciles organization and repository rulesets — the modern replacement for
 * classic branch protection, a SEPARATE REST API. Rulesets are identified by
 * name within their scope; GitHub assigns a numeric id used to address them for
 * update/delete.
 *
 *   GET    /orgs/{org}/rulesets                       — list org rulesets
 *   GET    /orgs/{org}/rulesets/{id}                  — org ruleset detail
 *   POST   /orgs/{org}/rulesets                       — create org ruleset
 *   PUT    /orgs/{org}/rulesets/{id}                  — update org ruleset
 *   DELETE /orgs/{org}/rulesets/{id}                  — delete org ruleset
 *   …and the analogous /repos/{owner}/{repo}/rulesets endpoints.
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## RMW: preserve undeclared rules
 *
 * The ruleset PUT is a full replacement of the ruleset body, but
 * selective-by-omission here operates at the WHOLE-RULESET granularity: a
 * ruleset absent from config is never touched, and within a managed ruleset the
 * declared `rules`/`conditions`/`bypassActors` lists are the source of truth
 * for that ruleset. We send the declared body verbatim; we do not merge
 * individual rules from live (a ruleset is authored as a unit). Undeclared
 * rulesets — the thing selective-by-omission protects — are left entirely alone.
 *
 * ## Scope
 *
 * Org rulesets are fetched by `orgLogin`. Repo rulesets are fetched for the
 * repos in `scope.repos` that declare `rulesets` (the branch-protection scope
 * pattern). Each ruleset costs one list page plus one detail GET so the diff
 * can compare full `rules`/`conditions`/`bypassActors`.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, RepoConfig, RulesetConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveRuleset } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the rulesets cycle. Pass `repos` (typically `orgConfig.repos`) so
 * repo rulesets are fetched for repos that declare them. Org rulesets are
 * always fetched via `orgLogin`.
 */
export interface RulesetsScope {
  repos?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhRulesetSummary {
  id: number;
  name: string;
}

interface GhRulesetDetail {
  id: number;
  name: string;
  target?: string | null;
  enforcement?: string | null;
  bypass_actors?: Array<Record<string, unknown>> | null;
  conditions?: Record<string, unknown> | null;
  rules?: Array<Record<string, unknown>> | null;
}

const PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Live-state fetch
// ---------------------------------------------------------------------------

/**
 * Fetch all rulesets under a base path (`/orgs/{org}/rulesets` or
 * `/repos/{o}/{r}/rulesets`): list (paginated) then GET each ruleset's detail
 * so `rules`/`conditions`/`bypassActors` are populated for diffing. Charges the
 * budget per request and stops when exhausted. A 404 (rulesets unsupported /
 * repo missing) yields an empty list.
 */
export async function fetchRulesets(
  client: AppClient,
  basePath: string,
  budget: RateBudget,
): Promise<LiveRuleset[]> {
  // 1. List (paginated).
  const summaries: GhRulesetSummary[] = [];
  let page = 1;
  for (;;) {
    if (budget.exhausted) break;
    budget.use(1);
    let batch: GhRulesetSummary[];
    try {
      batch = await client.request<GhRulesetSummary[]>(
        "GET",
        `${basePath}?per_page=${PER_PAGE}&page=${page}`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return [];
      throw err;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    summaries.push(...batch);
    if (batch.length < PER_PAGE) break;
    page++;
  }

  // 2. Detail per ruleset.
  const out: LiveRuleset[] = [];
  for (const s of summaries) {
    if (!s || typeof s.id !== "number") continue;
    if (budget.exhausted) break;
    budget.use(1);
    const detail = await client.request<GhRulesetDetail>("GET", `${basePath}/${s.id}`);
    out.push(mapRulesetToLive(detail));
  }

  return out;
}

/** Map a GitHub ruleset detail response to the `LiveRuleset` diff shape. */
export function mapRulesetToLive(raw: GhRulesetDetail): LiveRuleset {
  const live: LiveRuleset = { id: raw.id, name: raw.name };
  if (raw.target != null) live.target = raw.target;
  if (raw.enforcement != null) live.enforcement = raw.enforcement;
  if (raw.bypass_actors != null) live.bypassActors = raw.bypass_actors;
  if (raw.conditions != null) live.conditions = raw.conditions;
  if (raw.rules != null) live.rules = raw.rules;
  return live;
}

// ---------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------

/** Build the create/update body for a ruleset from declared fields. */
export function buildRulesetBody(desired: RulesetConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { name: desired.name };
  if (desired.target !== undefined) body.target = desired.target;
  if (desired.enforcement !== undefined) body.enforcement = desired.enforcement;
  if (desired.bypassActors !== undefined) body.bypass_actors = desired.bypassActors;
  if (desired.conditions !== undefined) body.conditions = desired.conditions;
  if (desired.rules !== undefined) body.rules = desired.rules;
  return body;
}

/** Apply one ruleset change against a base path. */
async function applyRuleset(
  client: AppClient,
  entry: ChangeSetEntry,
  basePath: string,
  budget: RateBudget,
): Promise<void> {
  if (entry.kind === "delete") {
    const id = (entry.before as LiveRuleset | undefined)?.id;
    if (id === undefined) {
      throw new Error(`rulesets: delete entry "${entry.key}" is missing the live ruleset id`);
    }
    budget.use(1);
    await client.request("DELETE", `${basePath}/${id}`);
    return;
  }

  const desired = entry.after as RulesetConfig;
  const body = buildRulesetBody(desired);

  if (entry.kind === "create") {
    budget.use(1);
    await client.request("POST", basePath, body);
    return;
  }

  // update — address the ruleset by its live id.
  const id = (entry.before as LiveRuleset | undefined)?.id;
  if (id === undefined) {
    throw new Error(`rulesets: update entry "${entry.key}" is missing the live ruleset id`);
  }
  budget.use(1);
  await client.request("PUT", `${basePath}/${id}`, body);
}

// ---------------------------------------------------------------------------
// rulesetsCycle — implements Cycle<RulesetsScope>
// ---------------------------------------------------------------------------

export const rulesetsCycle: Cycle<RulesetsScope> = {
  name: "rulesets",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: RulesetsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const orgRulesets = await fetchRulesets(client, `/orgs/${orgLogin}/rulesets`, budget);

    const repos: NonNullable<LiveOrgState["repos"]> = {};
    for (const [name, repoConfig] of Object.entries(scope?.repos ?? {})) {
      if (repoConfig.rulesets === undefined) continue;
      if (budget.exhausted) break;
      const rs = await fetchRulesets(client, `/repos/${orgLogin}/${name}/rulesets`, budget);
      repos[name] = { rulesets: rs };
    }

    return { rulesets: orgRulesets, repos };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: RulesetsScope): OrgConfig {
    const out: OrgConfig = {};
    if (orgConfig.rulesets) out.rulesets = orgConfig.rulesets;

    if (orgConfig.repos) {
      const repos: Record<string, RepoConfig> = {};
      for (const [name, repoConfig] of Object.entries(orgConfig.repos)) {
        if (repoConfig.rulesets && repoConfig.rulesets.length > 0) {
          repos[name] = { rulesets: repoConfig.rulesets };
        }
      }
      out.repos = repos;
    }

    return out;
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: RulesetsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType === "org-ruleset") {
      return applyRuleset(client, entry, `/orgs/${orgLogin}/rulesets`, budget);
    }

    if (entry.resourceType === "repo-ruleset") {
      // key format: "<repo>/<ruleset-name>"
      const slashIdx = entry.key.indexOf("/");
      if (slashIdx === -1) {
        throw new Error(
          `rulesets: malformed repo-ruleset key "${entry.key}" — expected "<repo>/<name>"`,
        );
      }
      const repo = entry.key.slice(0, slashIdx);
      return applyRuleset(client, entry, `/repos/${orgLogin}/${repo}/rulesets`, budget);
    }

    // Not ours — ignore.
  },
};
