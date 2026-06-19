/**
 * Token governance cycle (scheduled sweep).
 *
 * Inventories the org's fine-grained PAT grants and revokes the ORG ACCESS of
 * any grant that violates the token policy (expired, over max lifetime, or idle
 * too long). Time-based — nothing fires an event for an aging token — so this
 * is a scheduled sweep.
 *
 *   GET  /orgs/{org}/personal-access-tokens           — list active grants
 *   POST /orgs/{org}/personal-access-tokens/{pat_id}  — revoke a grant's access
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## PLATFORM WALL (documented in code)
 *
 * User PATs cannot be created or rotated on a user's behalf via the API. warden
 * can only: enforce lifetime/idle policy by REVOKING org access, inventory
 * grants, and gate approval (the separate #16 cycle). These token APIs are
 * callable ONLY by a GitHub App (warden's auth).
 *
 * ## Modeling
 *
 * A violation is emitted by the diff as an UPDATE on a "token-grant" resource
 * (meaning "revoke org access"), not a delete — so a routine revocation sweep
 * does not trip the removalDeltaCap guardrail. The violation logic itself lives
 * in `evaluateTokenViolation` (pure, in diff.ts) and is exercised against the
 * `nowMs` the runner injects.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveTokenGrant } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/** Scope for the token-governance cycle. The org is identified by `orgLogin`. */
export type TokenGovernanceScope = Record<string, never>;

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhTokenGrant {
  id: number;
  owner?: { login?: string };
  token_expired?: boolean;
  token_expires_at?: string | null;
  token_last_used_at?: string | null;
  access_granted_at?: string | null;
}

const PER_PAGE = 100;

function toMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Map a GitHub PAT-grant list item to the `LiveTokenGrant` diff shape. */
export function mapTokenGrant(raw: GhTokenGrant): LiveTokenGrant {
  const grant: LiveTokenGrant = { id: raw.id };
  if (raw.owner?.login) grant.ownerLogin = raw.owner.login;
  if (typeof raw.token_expired === "boolean") grant.expired = raw.token_expired;
  const exp = toMs(raw.token_expires_at);
  if (exp !== undefined) grant.expiresAtMs = exp;
  const last = toMs(raw.token_last_used_at);
  if (last !== undefined) grant.lastUsedAtMs = last;
  const granted = toMs(raw.access_granted_at);
  if (granted !== undefined) grant.grantedAtMs = granted;
  return grant;
}

// ---------------------------------------------------------------------------
// tokenGovernanceCycle — implements Cycle<TokenGovernanceScope>
// ---------------------------------------------------------------------------

export const tokenGovernanceCycle: Cycle<TokenGovernanceScope> = {
  name: "token-governance",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    _scope: TokenGovernanceScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const grants: LiveTokenGrant[] = [];
    let page = 1;
    for (;;) {
      if (budget.exhausted) break;
      budget.use(1);
      let batch: GhTokenGrant[];
      try {
        batch = await client.request<GhTokenGrant[]>(
          "GET",
          `/orgs/${orgLogin}/personal-access-tokens?per_page=${PER_PAGE}&page=${page}`,
        );
      } catch (err) {
        // No fine-grained PAT grants / no access → nothing to govern.
        if (err instanceof Error && (err.message.includes("404") || err.message.includes("403"))) {
          return { tokenGrants: [] };
        }
        throw err;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const g of batch) if (g && typeof g.id === "number") grants.push(mapTokenGrant(g));
      if (batch.length < PER_PAGE) break;
      page++;
    }

    return { tokenGrants: grants };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: TokenGovernanceScope): OrgConfig {
    if (!orgConfig.tokenPolicy) return {};
    return { tokenPolicy: orgConfig.tokenPolicy };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: TokenGovernanceScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "token-grant") return;
    // Only the revoke (update) action is produced by the diff.
    if (entry.kind !== "update") return;

    const patId = entry.key;
    budget.use(1);
    await client.request("POST", `/orgs/${orgLogin}/personal-access-tokens/${patId}`, {
      action: "revoke",
    });
  },
};
