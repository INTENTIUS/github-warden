/**
 * Membership & roles cycle.
 *
 * Reconciles organization membership and roles — who is a member, who is an
 * admin.
 *
 *   GET    /orgs/{org}/members?role=admin   — live admins (paginated)
 *   GET    /orgs/{org}/members?role=member  — live members (paginated)
 *   PUT    /orgs/{org}/memberships/{user}   — add / set role (create + update)
 *   DELETE /orgs/{org}/memberships/{user}   — remove from org (delete)
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Scope: org members & roles (not outside collaborators)
 *
 * The shared config model (`MemberConfig` = `{ login, role: member|admin }`)
 * describes org membership and role. Outside collaborators are a distinct,
 * per-repo concept that the config does not model, so they are intentionally
 * out of scope for this cycle and tracked as future inventory work.
 *
 * ## Safety: deletes are ownership-gated
 *
 * `diffMembers` only emits a `delete` for a live member absent from config when
 * the caller supplies an ownership predicate (`DiffOptions.isOwned`). With the
 * default runner wiring (no predicate) this cycle only ADDS or re-roles
 * declared members and never removes anyone — the safe default. When removals
 * ARE enabled, the `adminFloor`, `requiredAdmins`, `requireSelf`, and
 * `removalDeltaCap` guardrails (all member-aware) gate the apply.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, MemberConfig, OrgMemberRole } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveMemberConfig } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the membership cycle. Org members are addressed by `orgLogin`
 * (supplied per-org by the runner); there is no sub-resource selector.
 */
export type MembershipScope = Record<string, never>;

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

/** One entry in the `GET /orgs/{org}/members` list response. */
interface GhUser {
  login: string;
}

/** Page size for member listing. GitHub caps this at 100. */
const PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Live-state fetch helpers
// ---------------------------------------------------------------------------

/**
 * List org members filtered by role, following pagination. One API call per
 * page; the budget is charged per page and pagination stops when exhausted.
 */
export async function listOrgMembers(
  client: AppClient,
  orgLogin: string,
  role: "admin" | "member",
  budget: RateBudget,
): Promise<string[]> {
  const logins: string[] = [];
  let page = 1;

  for (;;) {
    if (budget.exhausted) break;
    budget.use(1);
    const path = `/orgs/${orgLogin}/members?role=${role}&per_page=${PER_PAGE}&page=${page}`;
    const batch = await client.request<GhUser[]>("GET", path);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const u of batch) {
      if (u && typeof u.login === "string") logins.push(u.login);
    }
    if (batch.length < PER_PAGE) break;
    page++;
  }

  return logins;
}

// ---------------------------------------------------------------------------
// membershipCycle — implements Cycle<MembershipScope>
// ---------------------------------------------------------------------------

/**
 * Governance cycle for org membership and roles.
 *
 * Reconciles the `members` array of each org in the config. Members absent from
 * config are left untouched unless an ownership predicate enables removal.
 */
export const membershipCycle: Cycle<MembershipScope> = {
  name: "membership",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    _scope: MembershipScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const admins = await listOrgMembers(client, orgLogin, "admin", budget);
    const members = await listOrgMembers(client, orgLogin, "member", budget);

    const live: LiveMemberConfig[] = [
      ...admins.map((login) => ({ login, role: "admin" as const })),
      ...members.map((login) => ({ login, role: "member" as const })),
    ];

    return { members: live };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: MembershipScope): OrgConfig {
    if (!orgConfig.members) return {};
    return { members: orgConfig.members };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: MembershipScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "member") {
      // Safety: this cycle only handles org-member entries.
      return;
    }

    const login = encodeURIComponent(entry.key);

    if (entry.kind === "delete") {
      budget.use(1);
      await client.request("DELETE", `/orgs/${orgLogin}/memberships/${login}`);
      return;
    }

    // create or update — both set the desired role via the memberships PUT,
    // which invites a non-member and updates an existing member's role.
    const after = entry.after as MemberConfig;
    const role: OrgMemberRole = after.role ?? "member";
    budget.use(1);
    await client.request("PUT", `/orgs/${orgLogin}/memberships/${login}`, { role });
  },
};
