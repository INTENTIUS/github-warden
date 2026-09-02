/**
 * Reconcile guardrails.
 *
 * Pure functions that inspect a computed ChangeSet and reject dangerous applies
 * before any mutation. Run between diff and apply; if any trips, the apply is
 * refused with a structured result.
 *
 * None of these functions throw. Every check returns structured diagnostics.
 *
 * ## Rename-without-loss
 * A member or resource may carry a `previously` alias field in the desired
 * config. When a delete+create pair is found where the created entry's
 * `previously` matches the deleted entry's key, the pair is treated as a
 * rename (update) rather than a mass-deletion signal.
 *
 * ## Configurable thresholds (defaults)
 * - `removalLiveCap.maxFraction` — 0.25 (25 % of live managed entries)
 * - `adminFloor.min`             — 2 (at least 2 admins must remain)
 */

import type { ChangeSet, LiveMemberConfig, LiveOrgState } from "./diff.js";
// The provider-agnostic guardrail framework lives in the reconcile core; this
// module composes the member-aware (GitHub-specific) guardrails on top. The
// generic pieces are re-exported so existing imports from "./guardrails.js"
// keep resolving.
import type { GuardrailDiagnostic, GuardrailResult, RemovalDeltaCapOptions } from "./core.js";
import { resolveRenames, removalDeltaCap } from "./core.js";
export type { GuardrailDiagnostic, GuardrailResult, RemovalDeltaCapOptions } from "./core.js";
export { resolveRenames, removalDeltaCap } from "./core.js";

/** Config for `removalLiveCap`. */
export interface RemovalLiveCapOptions {
  /** Max fraction of live managed entries that may be deleted. Must be in (0,1]. Default 0.25. */
  maxFraction?: number;
}

/** Config for `adminFloor`. */
export interface AdminFloorOptions {
  /**
   * Minimum number of org admins that must remain after the apply.
   * Default: 2.
   */
  min?: number;
}

/** Config for `requiredAdmins`. */
export interface RequiredAdminsOptions {
  /**
   * Logins that must remain as admins after the apply.
   */
  logins: string[];
}

/** Config for `requireSelf`. */
export interface RequireSelfOptions {
  /**
   * Login of the managing identity. The apply is refused if this user would
   * lose org membership or admin role.
   */
  selfLogin: string;
}

/** Full guardrail config passed to `runGuardrails`. */
export interface GuardrailConfig {
  /** Options for the live-denominator removal cap. */
  removalLiveCap?: RemovalLiveCapOptions;
  /**
   * Legacy alias for `removalLiveCap` (same `maxFraction` shape). Honoured when
   * `removalLiveCap` is not set, so existing programmatic configs keep working.
   */
  removalDeltaCap?: RemovalDeltaCapOptions;
  adminFloor?: AdminFloorOptions;
  requiredAdmins?: RequiredAdminsOptions;
  requireSelf?: RequireSelfOptions;
}

// `resolveRenames` and chant's `removalDeltaCap` are the provider-agnostic
// guardrails — they live in `core.ts` and are imported + re-exported above. The
// member-aware guardrails below build on the same change-set model.

// ---------------------------------------------------------------------------
// removalLiveCap — warden-local removal cap over the LIVE denominator
// ---------------------------------------------------------------------------

/**
 * Refuse if deletes exceed `maxFraction` of the LIVE managed entries.
 *
 * Chant's `removalDeltaCap` divides deletes by the PLAN's updates+deletes, so
 * one stale delete in an otherwise converged cycle reads as a 100 % removal and
 * trips the cap. This check uses the live denominator instead:
 * `liveManagedTotal` is the count of live entries in the collections the org's
 * policy declares for the cycle (the same declared-slice condition the diff
 * uses — see `countLiveManaged` in `diff.ts`), so one stale delete out of ten
 * live entries is 10 %, not 100 %.
 *
 * When `liveManagedTotal` is 0 (nothing live in any declared collection, or the
 * caller could not compute it) the check delegates to chant's `removalDeltaCap`
 * so the plan-denominator safety net still applies.
 *
 * CONTRACT: pass a RENAME-RESOLVED change set (see `resolveRenames`).
 */
export function removalLiveCap(
  changeSet: ChangeSet,
  liveManagedTotal: number,
  opts: RemovalLiveCapOptions = {},
): GuardrailDiagnostic | null {
  if (liveManagedTotal === 0) return removalDeltaCap(changeSet, opts);

  const maxFraction = opts.maxFraction ?? 0.25;
  const deletes = changeSet.entries.filter((e) => e.kind === "delete").length;
  const fraction = deletes / liveManagedTotal;
  if (liveManagedTotal > 0 && fraction > maxFraction) {
    return {
      guardrail: "removalLiveCap",
      message:
        `${deletes} of ${liveManagedTotal} live managed entries (${Math.round(fraction * 100)}%) would be deleted, ` +
        `exceeding the ${Math.round(maxFraction * 100)}% threshold. ` +
        `Check for typos in config or raise maxFraction to proceed.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Individual guardrails (member-aware, GitHub-specific)
// ---------------------------------------------------------------------------

/**
 * Refuse if the apply would leave fewer than `min` org admins.
 *
 * Computes the post-apply admin count from the live snapshot and the ChangeSet.
 *
 * Default `min`: 2.
 */
export function adminFloor(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: AdminFloorOptions = {},
): GuardrailDiagnostic | null {
  const min = opts.min ?? 2;
  const liveMembers = live.members ?? [];

  // Build effective post-apply admin set
  const postApplyAdmins = computePostApplyAdmins(changeSet, liveMembers);
  const count = postApplyAdmins.size;

  if (count < min) {
    return {
      guardrail: "adminFloor",
      message:
        `Apply would leave ${count} org admin(s), below the required minimum of ${min}. ` +
        `Ensure at least ${min} admin(s) remain in the desired config.`,
    };
  }

  return null;
}

/**
 * Refuse if any of the required admin logins would be removed or demoted.
 */
export function requiredAdmins(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: RequiredAdminsOptions,
): GuardrailDiagnostic | null {
  if (opts.logins.length === 0) return null;

  const liveMembers = live.members ?? [];
  const postApplyAdmins = computePostApplyAdmins(changeSet, liveMembers);

  const missing = opts.logins.filter((login) => !postApplyAdmins.has(login));

  if (missing.length > 0) {
    return {
      guardrail: "requiredAdmins",
      message:
        `The following required admin(s) would be removed or demoted: ${missing.join(", ")}. ` +
        `These logins must remain as org admins after the apply.`,
    };
  }

  return null;
}

/**
 * Refuse if the managing identity (`selfLogin`) would lose org access.
 *
 * Trips when the ChangeSet would delete or demote the self login from any org
 * member role. The managing bot must not lock itself out.
 */
export function requireSelf(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: RequireSelfOptions,
): GuardrailDiagnostic | null {
  const { selfLogin } = opts;
  const liveMembers = live.members ?? [];

  // Compute post-apply membership (any role) for selfLogin
  const liveByLogin = new Map(liveMembers.map((m) => [m.login, m]));
  let role: string | null = liveByLogin.get(selfLogin)?.role ?? null;

  for (const e of changeSet.entries) {
    if (e.resourceType !== "member" || e.key !== selfLogin) continue;
    if (e.kind === "delete") {
      role = null;
    } else if (e.kind === "create" || e.kind === "update") {
      const after = e.after as { role?: string } | undefined;
      role = after?.role ?? role;
    }
  }

  if (role === null) {
    return {
      guardrail: "requireSelf",
      message:
        `The managing identity "${selfLogin}" would be removed from the org. ` +
        `Self-lockout is not allowed. Add "${selfLogin}" back to the desired config.`,
    };
  }

  // Stricter than membership alone: also refuse if self would be demoted out of
  // admin. The managing bot must keep admin access, not merely org membership.
  if (role !== "admin") {
    return {
      guardrail: "requireSelf",
      message:
        `The managing identity "${selfLogin}" would be demoted from admin to "${role}". ` +
        `Self-lockout is not allowed. Keep "${selfLogin}" as an org admin in the desired config.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

/**
 * Run all configured guardrails against the ChangeSet and live snapshot.
 *
 * Returns `{ ok: true }` when no guardrail trips, or
 * `{ ok: false, diagnostics }` with every tripped guardrail's message.
 *
 * Rename aliases are resolved ONCE here before any check runs. All individual
 * guardrail functions (`removalLiveCap`, `adminFloor`, etc.) receive the
 * pre-resolved ChangeSet and MUST NOT call `resolveRenames` themselves.
 * This guarantees a single traversal and a consistent view of renames across
 * all checks — a rename is collapsed to an update exactly once.
 *
 * `liveManagedTotal` is the live-entry count for the declared collections of
 * the cycle being checked (see `countLiveManaged` in `diff.ts`); the runner
 * captures it from the diff call that produced `changeSet`. When 0 or omitted,
 * `removalLiveCap` falls back to chant's plan-denominator `removalDeltaCap`.
 */
export function runGuardrails(
  changeSet: ChangeSet,
  live: LiveOrgState,
  config: GuardrailConfig = {},
  liveManagedTotal = 0,
): GuardrailResult {
  // Resolve renames once; all checks receive the pre-resolved set.
  const resolved = resolveRenames(changeSet);

  const diagnostics: GuardrailDiagnostic[] = [];

  const cap = removalLiveCap(
    resolved,
    liveManagedTotal,
    config.removalLiveCap ?? config.removalDeltaCap,
  );
  if (cap) diagnostics.push(cap);

  // The member-aware guardrails only make sense for a change set with member
  // visibility: a live member roster, or member entries in the plan. A cycle
  // that never reads or writes membership (branch-protection, rulesets, …)
  // cannot change the admin count, and evaluating the floor against its
  // member-less live snapshot would read as "0 admins" and block every apply.
  const memberAware =
    live.members !== undefined || resolved.entries.some((e) => e.resourceType === "member");

  if (memberAware) {
    const floor = adminFloor(resolved, live, config.adminFloor);
    if (floor) diagnostics.push(floor);

    if (config.requiredAdmins) {
      const req = requiredAdmins(resolved, live, config.requiredAdmins);
      if (req) diagnostics.push(req);
    }

    if (config.requireSelf) {
      const self = requireSelf(resolved, live, config.requireSelf);
      if (self) diagnostics.push(self);
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the set of admin logins that would exist after applying the ChangeSet.
 */
function computePostApplyAdmins(
  changeSet: ChangeSet,
  liveMembers: LiveMemberConfig[],
): Set<string> {
  const liveAdmins = new Map<string, string>(
    liveMembers.filter((m) => m.role === "admin").map((m) => [m.login, m.role]),
  );

  const result = new Set(liveAdmins.keys());

  for (const e of changeSet.entries) {
    if (e.resourceType !== "member") continue;

    if (e.kind === "delete") {
      result.delete(e.key);
    } else if (e.kind === "create" || e.kind === "update") {
      const after = e.after as { login?: string; role?: string } | undefined;
      const login = after?.login ?? e.key;

      // A rename is collapsed into an update whose resulting login differs from
      // the prior login (carried in `before`/`key`). Drop the prior login so a
      // renamed-away admin no longer counts as surviving — otherwise the ghost
      // would keep adminFloor/requiredAdmins fail-open.
      if (e.kind === "update") {
        const before = e.before as { login?: string } | undefined;
        const priorLogin = before?.login ?? e.key;
        if (priorLogin !== login) result.delete(priorLogin);
      }

      if (after?.role === "admin") {
        result.add(login);
      } else {
        // create/update to member role → not an admin
        result.delete(login);
      }
    }
  }

  return result;
}
