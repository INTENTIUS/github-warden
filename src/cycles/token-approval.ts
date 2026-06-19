/**
 * Token approval cycle.
 *
 * Auto-decides pending fine-grained PAT requests against policy: a request whose
 * every permission is in `allowedPermissions` is approved; otherwise the policy
 * `default` applies (auto-deny, or leave pending for a human). Poll/event-driven
 * on pending requests.
 *
 *   GET  /orgs/{org}/personal-access-token-requests           — list pending
 *   POST /orgs/{org}/personal-access-token-requests/{id}      — approve / deny
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Platform wall
 *
 * These request endpoints are callable ONLY by a GitHub App. Admins can approve
 * or deny a request but cannot change the repo scope the creator chose — so the
 * policy decides approve/deny only.
 *
 * Decisions are modeled as "token-request" UPDATE entries (the pure decision
 * logic is `evaluateTokenRequest` in diff.ts). Mock-tested; verify against a
 * real App/test-org before relying on it.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveTokenRequest } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/** Scope for the token-approval cycle. The org is identified by `orgLogin`. */
export type TokenApprovalScope = Record<string, never>;

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhTokenRequest {
  id: number;
  owner?: { login?: string };
  /** Nested permission groups, e.g. { repository: { contents: "write" } }. */
  permissions?: Record<string, Record<string, unknown> | null | undefined> | null;
}

const PER_PAGE = 100;

/** Flatten the nested request permissions to `group:scope` names. */
export function flattenRequestPermissions(
  permissions: GhTokenRequest["permissions"],
): string[] {
  const out: string[] = [];
  if (!permissions) return out;
  for (const [group, scopes] of Object.entries(permissions)) {
    if (!scopes || typeof scopes !== "object") continue;
    for (const scope of Object.keys(scopes)) out.push(`${group}:${scope}`);
  }
  return out;
}

/** Map a GitHub PAT-request list item to the `LiveTokenRequest` diff shape. */
export function mapTokenRequest(raw: GhTokenRequest): LiveTokenRequest {
  const req: LiveTokenRequest = { id: raw.id, permissions: flattenRequestPermissions(raw.permissions) };
  if (raw.owner?.login) req.ownerLogin = raw.owner.login;
  return req;
}

// ---------------------------------------------------------------------------
// tokenApprovalCycle — implements Cycle<TokenApprovalScope>
// ---------------------------------------------------------------------------

export const tokenApprovalCycle: Cycle<TokenApprovalScope> = {
  name: "token-approval",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    _scope: TokenApprovalScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const requests: LiveTokenRequest[] = [];
    let page = 1;
    for (;;) {
      if (budget.exhausted) break;
      budget.use(1);
      let batch: GhTokenRequest[];
      try {
        batch = await client.request<GhTokenRequest[]>(
          "GET",
          `/orgs/${orgLogin}/personal-access-token-requests?per_page=${PER_PAGE}&page=${page}`,
        );
      } catch (err) {
        if (err instanceof Error && (err.message.includes("404") || err.message.includes("403"))) {
          return { tokenRequests: [] };
        }
        throw err;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) if (r && typeof r.id === "number") requests.push(mapTokenRequest(r));
      if (batch.length < PER_PAGE) break;
      page++;
    }

    return { tokenRequests: requests };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: TokenApprovalScope): OrgConfig {
    if (!orgConfig.tokenApproval) return {};
    return { tokenApproval: orgConfig.tokenApproval };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: TokenApprovalScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "token-request") return;
    if (entry.kind !== "update") return;

    const requestId = entry.key;
    const decision = (entry.after as { decision?: string }).decision;
    if (decision !== "approve" && decision !== "deny") return;

    budget.use(1);
    await client.request("POST", `/orgs/${orgLogin}/personal-access-token-requests/${requestId}`, {
      action: decision,
    });
  },
};
