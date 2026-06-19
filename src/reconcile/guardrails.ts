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
 * - `removalDeltaCap.maxFraction` — 0.25 (25 % of managed entries)
 * - `adminFloor.min`              — 2 (at least 2 admins must remain)
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
  removalDeltaCap?: RemovalDeltaCapOptions;
  adminFloor?: AdminFloorOptions;
  requiredAdmins?: RequiredAdminsOptions;
  requireSelf?: RequireSelfOptions;
}

// `resolveRenames` and `removalDeltaCap` are the provider-agnostic guardrails —
// they live in `core.ts` and are imported + re-exported above. The member-aware
// guardrails below build on the same change-set model.

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
 * guardrail functions (`removalDeltaCap`, `adminFloor`, etc.) receive the
 * pre-resolved ChangeSet and MUST NOT call `resolveRenames` themselves.
 * This guarantees a single traversal and a consistent view of renames across
 * all checks — a rename is collapsed to an update exactly once.
 */
export function runGuardrails(
  changeSet: ChangeSet,
  live: LiveOrgState,
  config: GuardrailConfig = {},
): GuardrailResult {
  // Resolve renames once; all checks receive the pre-resolved set.
  const resolved = resolveRenames(changeSet);

  const diagnostics: GuardrailDiagnostic[] = [];

  const cap = removalDeltaCap(resolved, config.removalDeltaCap);
  if (cap) diagnostics.push(cap);

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
