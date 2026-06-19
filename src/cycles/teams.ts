/**
 * Teams cycle.
 *
 * Reconciles organization teams — the team tree (privacy, parent), team
 * membership/roles, and team→repo permissions.
 *
 *   GET    /orgs/{org}/teams                                  — list teams
 *   GET    /orgs/{org}/teams/{slug}                           — resolve parent id
 *   POST   /orgs/{org}/teams                                  — create team
 *   PATCH  /orgs/{org}/teams/{slug}                           — update team
 *   DELETE /orgs/{org}/teams/{slug}                           — delete team
 *   GET    /orgs/{org}/teams/{slug}/members?role=...          — list members
 *   PUT    /orgs/{org}/teams/{slug}/memberships/{user}        — add/role member
 *   DELETE /orgs/{org}/teams/{slug}/memberships/{user}        — remove member
 *   GET    /orgs/{org}/teams/{slug}/repos                     — list team repos
 *   PUT    /orgs/{org}/teams/{slug}/repos/{owner}/{repo}      — set repo perm
 *   DELETE /orgs/{org}/teams/{slug}/repos/{owner}/{repo}      — remove repo
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * The diff emits three resource types for teams — `team`, `team-member`, and
 * `team-repo` — in that canonical order, so a newly-created team exists before
 * its members and repos are attached. This cycle's `apply` dispatches on all
 * three.
 *
 * ## Scope and sub-resource fetch
 *
 * Like branch-protection/repo-settings, sub-resources (members, repos) are
 * fetched only for teams present in `scope.teams` that manage them. The team
 * list itself is always fetched so team creates/updates/deletes are detected.
 *
 * ## Rename-without-loss
 *
 * A `TeamConfig.previously` slug marks a rename. Its effect is at the GUARDRAIL
 * layer: `resolveRenames` collapses a `delete(previously)` + `create(slug)`
 * pair into a single update so the rename does not count against
 * `removalDeltaCap` (a rename is not a mass-deletion). The delete half only
 * exists when the old slug is owned (`DiffOptions.isOwned`); with the safe
 * default (no ownership predicate) a renamed team is emitted purely as a
 * create, leaving the old team in place — nothing is deleted, so nothing is
 * lost. `previously` is a reconcile-time hint and is never written to GitHub.
 *
 * NOTE: the runner applies the raw (non-resolved) change set, so it does not
 * yet perform a single atomic GitHub rename. Atomic apply-time rename (PATCH
 * the old team's name in place) is a runner-level follow-up; this cycle wires
 * up the config field and guardrail support that it builds on.
 *
 * ## Team name vs slug
 *
 * Teams are keyed by slug in config; `TeamConfig` carries no separate display
 * name. On create the slug is sent as the `name` (GitHub re-slugifies it). On
 * update the name is not sent, so an existing team's slug is never disturbed.
 */

import type { AppClient } from "../auth/app-client.js";
import type {
  OrgConfig,
  TeamConfig,
  TeamMember,
  TeamRepo,
  TeamRepoPermission,
} from "../config/types.js";
import type {
  ChangeSetEntry,
  LiveOrgState,
  LiveTeamConfig,
  LiveTeamMember,
  LiveTeamRepo,
} from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the teams cycle. Pass `teams` (typically `orgConfig.teams`) so
 * `fetchLive` knows which teams' members/repos to fetch. The org login is
 * supplied per-org by the runner as `orgLogin`, not via scope.
 */
export interface TeamsScope {
  teams?: Record<string, TeamConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhTeam {
  slug: string;
  name?: string;
  description?: string | null;
  privacy?: string | null;
  parent?: { slug?: string } | null;
}

interface GhTeamMember {
  login: string;
}

interface GhTeamRepo {
  name: string;
  role_name?: string | null;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  } | null;
}

const PER_PAGE = 100;

const VALID_PRIVACY = new Set(["secret", "closed"]);
const VALID_TEAM_PERMISSIONS: TeamRepoPermission[] = ["admin", "maintain", "push", "triage", "pull"];

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

/**
 * Page through a list endpoint, charging the budget per page and stopping when
 * a short page is returned or the budget is exhausted. `makePath(page)` builds
 * the request path for a given 1-based page number.
 */
async function paginate<T>(
  client: AppClient,
  makePath: (page: number) => string,
  budget: RateBudget,
): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    if (budget.exhausted) break;
    budget.use(1);
    const batch = await client.request<T[]>("GET", makePath(page));
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
    page++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live-state mapping helpers
// ---------------------------------------------------------------------------

/** Map a team repo's GitHub permission shape to our permission enum. */
export function mapTeamRepoPermission(repo: GhTeamRepo): TeamRepoPermission {
  if (repo.role_name && (VALID_TEAM_PERMISSIONS as string[]).includes(repo.role_name)) {
    return repo.role_name as TeamRepoPermission;
  }
  const p = repo.permissions ?? {};
  if (p.admin) return "admin";
  if (p.maintain) return "maintain";
  if (p.push) return "push";
  if (p.triage) return "triage";
  return "pull";
}

/** Fetch the maintainer/member roster for one team. */
async function fetchTeamMembers(
  client: AppClient,
  org: string,
  slug: string,
  budget: RateBudget,
): Promise<LiveTeamMember[]> {
  const maintainers = await paginate<GhTeamMember>(
    client,
    (page) => `/orgs/${org}/teams/${slug}/members?role=maintainer&per_page=${PER_PAGE}&page=${page}`,
    budget,
  );
  const members = await paginate<GhTeamMember>(
    client,
    (page) => `/orgs/${org}/teams/${slug}/members?role=member&per_page=${PER_PAGE}&page=${page}`,
    budget,
  );
  return [
    ...maintainers.map((m) => ({ login: m.login, role: "maintainer" as const })),
    ...members.map((m) => ({ login: m.login, role: "member" as const })),
  ];
}

/** Fetch the repo permissions for one team. */
async function fetchTeamRepos(
  client: AppClient,
  org: string,
  slug: string,
  budget: RateBudget,
): Promise<LiveTeamRepo[]> {
  const repos = await paginate<GhTeamRepo>(
    client,
    (page) => `/orgs/${org}/teams/${slug}/repos?per_page=${PER_PAGE}&page=${page}`,
    budget,
  );
  return repos.map((r) => ({ name: r.name, permission: mapTeamRepoPermission(r) }));
}

// ---------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------

/**
 * Build the create/update body for a team. Resolves `parentTeamSlug` to a
 * `parent_team_id` (one extra GET) when declared. `includeName` adds the slug
 * as the team name (create only).
 */
async function buildTeamBody(
  client: AppClient,
  org: string,
  slug: string,
  desired: TeamConfig,
  includeName: boolean,
  budget: RateBudget,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (includeName) body.name = slug;
  if (desired.description !== undefined) body.description = desired.description;
  if (desired.privacy !== undefined) body.privacy = desired.privacy;
  if (desired.parentTeamSlug !== undefined) {
    if (desired.parentTeamSlug === "") {
      body.parent_team_id = null;
    } else {
      budget.use(1);
      const parent = await client.request<{ id: number }>(
        "GET",
        `/orgs/${org}/teams/${desired.parentTeamSlug}`,
      );
      body.parent_team_id = parent.id;
    }
  }
  return body;
}

function splitKey(key: string, resourceType: string): [string, string] {
  const idx = key.indexOf("/");
  if (idx === -1) {
    throw new Error(`teams: malformed ${resourceType} key "${key}" — expected "<slug>/<child>"`);
  }
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// teamsCycle — implements Cycle<TeamsScope>
// ---------------------------------------------------------------------------

export const teamsCycle: Cycle<TeamsScope> = {
  name: "teams",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: TeamsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const ghTeams = await paginate<GhTeam>(
      client,
      (page) => `/orgs/${orgLogin}/teams?per_page=${PER_PAGE}&page=${page}`,
      budget,
    );

    const teams: Record<string, LiveTeamConfig> = {};
    for (const t of ghTeams) {
      if (!t || typeof t.slug !== "string") continue;
      const live: LiveTeamConfig = {};
      if (t.description != null) live.description = t.description;
      if (t.privacy != null && VALID_PRIVACY.has(t.privacy)) {
        live.privacy = t.privacy as LiveTeamConfig["privacy"];
      }
      if (t.parent?.slug) live.parentTeamSlug = t.parent.slug;

      // Fetch sub-resources only for teams whose config manages them.
      const scopeTeam = scope.teams?.[t.slug];
      if (scopeTeam?.members !== undefined && !budget.exhausted) {
        live.members = await fetchTeamMembers(client, orgLogin, t.slug, budget);
      }
      if (scopeTeam?.repos !== undefined && !budget.exhausted) {
        live.repos = await fetchTeamRepos(client, orgLogin, t.slug, budget);
      }

      teams[t.slug] = live;
    }

    return { teams };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: TeamsScope): OrgConfig {
    if (!orgConfig.teams) return {};
    return { teams: orgConfig.teams };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: TeamsScope,
    budget: RateBudget,
  ): Promise<void> {
    switch (entry.resourceType) {
      case "team":
        return applyTeam(client, entry, orgLogin, budget);
      case "team-member":
        return applyTeamMember(client, entry, orgLogin, budget);
      case "team-repo":
        return applyTeamRepo(client, entry, orgLogin, budget);
      default:
        // Not ours — ignore.
        return;
    }
  },
};

async function applyTeam(
  client: AppClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const slug = entry.key;

  if (entry.kind === "delete") {
    budget.use(1);
    await client.request("DELETE", `/orgs/${org}/teams/${slug}`);
    return;
  }

  const desired = entry.after as TeamConfig;

  if (entry.kind === "create") {
    const body = await buildTeamBody(client, org, slug, desired, true, budget);
    budget.use(1);
    await client.request("POST", `/orgs/${org}/teams`, body);

    // For a brand-new team the diff embeds members/repos in this create entry
    // (it does not emit separate team-member/team-repo entries), so attach them
    // here. Existing teams get their members/repos reconciled as their own
    // entries by applyTeamMember/applyTeamRepo.
    for (const m of desired.members ?? []) {
      budget.use(1);
      await client.request(
        "PUT",
        `/orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(m.login)}`,
        { role: m.role ?? "member" },
      );
    }
    for (const r of desired.repos ?? []) {
      budget.use(1);
      await client.request("PUT", `/orgs/${org}/teams/${slug}/repos/${org}/${r.name}`, {
        permission: r.permission,
      });
    }
    return;
  }

  // update — PATCH only the declared top-level fields.
  const body = await buildTeamBody(client, org, slug, desired, false, budget);
  if (Object.keys(body).length === 0) return;
  budget.use(1);
  await client.request("PATCH", `/orgs/${org}/teams/${slug}`, body);
}

async function applyTeamMember(
  client: AppClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const [slug, login] = splitKey(entry.key, "team-member");
  const path = `/orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(login)}`;

  if (entry.kind === "delete") {
    budget.use(1);
    await client.request("DELETE", path);
    return;
  }

  const after = entry.after as TeamMember;
  budget.use(1);
  await client.request("PUT", path, { role: after.role ?? "member" });
}

async function applyTeamRepo(
  client: AppClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const [slug, repo] = splitKey(entry.key, "team-repo");
  const path = `/orgs/${org}/teams/${slug}/repos/${org}/${repo}`;

  if (entry.kind === "delete") {
    budget.use(1);
    await client.request("DELETE", path);
    return;
  }

  const after = entry.after as TeamRepo;
  budget.use(1);
  await client.request("PUT", path, { permission: after.permission });
}
