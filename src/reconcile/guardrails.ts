/**
 * Reconcile guardrails.
 *
 * Pure functions that inspect a computed ChangeSet and reject dangerous applies
 * before any mutation. Run between diff and apply; if any trips, the apply is
 * refused with a structured result.
 *
 * A tripped guardrail returns structured diagnostics. Misconfiguration, by
 * contrast, THROWS — `runGuardrails` refuses an unknown `GuardrailConfig` key
 * (a stale key must fail closed, not silently drop a safety option), and
 * chant's `removalDeltaCap` throws on a `maxFraction` outside (0,1].
 *
 * ## Rename-without-loss
 * A member or resource may carry a `previously` alias field in the desired
 * config. When a delete+create pair is found where the created entry's
 * `previously` matches the deleted entry's key, the pair is treated as a
 * rename (update) rather than a mass-deletion signal.
 *
 * ## Configurable thresholds (defaults)
 * - `removalDeltaCap.maxFraction` — 0.25 (25 % per resource type, measured
 *   against that type's live managed entries — `ChangeSet.managedCounts`)
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
  /**
   * Options for chant's removal cap, forwarded to `removalDeltaCap` verbatim.
   * The per-type live denominators normally come from the change set itself
   * (`ChangeSet.managedCounts`, stamped by warden's `diff`); options given
   * here follow chant's own precedence — e.g. `managedTotals` overrides the
   * change set's counts, and `maxFraction` tightens or loosens the cap.
   */
  removalDeltaCap?: RemovalDeltaCapOptions;
  adminFloor?: AdminFloorOptions;
  requiredAdmins?: RequiredAdminsOptions;
  requireSelf?: RequireSelfOptions;
}

/** The GuardrailConfig keys `runGuardrails` accepts. */
const KNOWN_GUARDRAIL_CONFIG_KEYS = new Set<string>([
  "removalDeltaCap",
  "adminFloor",
  "requiredAdmins",
  "requireSelf",
]);

// `resolveRenames` and the removal cap are the provider-agnostic guardrails —
// chant's `removalDeltaCap` reads the per-type live denominators warden's
// `diff` stamps on the change set (`managedCounts`), so warden carries no
// removal-cap logic of its own. The member-aware guardrails below build on the
// same change-set model.

// ---------------------------------------------------------------------------
// Post-apply membership view (shared by the member-aware guardrails)
// ---------------------------------------------------------------------------

/**
 * The org membership as it would look after applying the ChangeSet. Computed
 * once per `runGuardrails` call and shared by `adminFloor`, `requiredAdmins`,
 * and `requireSelf`.
 */
export interface PostApplyMembers {
  /** login → post-apply org role. A login absent here loses membership. */
  roles: Map<string, string>;
  /** Logins whose post-apply role is "admin". */
  admins: Set<string>;
}

/**
 * Compute the post-apply membership view from the live roster and the
 * (rename-resolved) ChangeSet. A rename collapsed into an update whose
 * resulting login differs from the prior login drops the prior login, so a
 * renamed-away admin no longer counts as surviving — otherwise the ghost
 * would keep the member-aware guardrails fail-open.
 */
export function computePostApplyMembers(
  changeSet: ChangeSet,
  liveMembers: LiveMemberConfig[],
): PostApplyMembers {
  const roles = new Map<string, string>(liveMembers.map((m) => [m.login, m.role]));

  for (const e of changeSet.entries) {
    if (e.resourceType !== "member") continue;

    if (e.kind === "delete") {
      roles.delete(e.key);
    } else if (e.kind === "create" || e.kind === "update") {
      const after = e.after as { login?: string; role?: string } | undefined;
      const login = after?.login ?? e.key;

      if (e.kind === "update") {
        const before = e.before as { login?: string } | undefined;
        const priorLogin = before?.login ?? e.key;
        if (priorLogin !== login) roles.delete(priorLogin);
      }

      // The diff always stamps a role on member entries; default to the org
      // default ("member") if one is ever absent — fail closed, never a
      // phantom admin.
      roles.set(login, after?.role ?? "member");
    }
  }

  const admins = new Set<string>();
  for (const [login, role] of roles) {
    if (role === "admin") admins.add(login);
  }

  return { roles, admins };
}

// ---------------------------------------------------------------------------
// Individual guardrails (member-aware, GitHub-specific)
// ---------------------------------------------------------------------------

/**
 * Refuse if the apply would leave fewer than `min` org admins.
 *
 * Computes the post-apply admin count from the live snapshot and the ChangeSet
 * (or reuses a precomputed `postApply` view when the caller has one).
 *
 * Default `min`: 2.
 */
export function adminFloor(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: AdminFloorOptions = {},
  postApply?: PostApplyMembers,
): GuardrailDiagnostic | null {
  const min = opts.min ?? 2;
  const { admins } = postApply ?? computePostApplyMembers(changeSet, live.members ?? []);
  const count = admins.size;

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
  postApply?: PostApplyMembers,
): GuardrailDiagnostic | null {
  if (opts.logins.length === 0) return null;

  const { admins } = postApply ?? computePostApplyMembers(changeSet, live.members ?? []);

  const missing = opts.logins.filter((login) => !admins.has(login));

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
  postApply?: PostApplyMembers,
): GuardrailDiagnostic | null {
  const { selfLogin } = opts;
  const { roles } = postApply ?? computePostApplyMembers(changeSet, live.members ?? []);
  const role = roles.get(selfLogin) ?? null;

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
 * Throws on an unknown `config` key: a stale option (e.g. the removed
 * `removalLiveCap`) must fail closed rather than silently loosen the run.
 *
 * Rename aliases are resolved ONCE here before any check runs. All individual
 * guardrail functions (`removalDeltaCap`, `adminFloor`, etc.) receive the
 * pre-resolved ChangeSet and MUST NOT call `resolveRenames` themselves.
 * This guarantees a single traversal and a consistent view of renames across
 * all checks — a rename is collapsed to an update exactly once. The post-apply
 * membership view is likewise computed once and shared by the member-aware
 * checks.
 *
 * `config.removalDeltaCap` is forwarded to chant's `removalDeltaCap` verbatim;
 * with no options the cap reads the change set's own per-type live counts
 * (`ChangeSet.managedCounts`, stamped by warden's `diff`) and only falls back
 * to plan-relative counting for a change set carrying none.
 */
export function runGuardrails(
  changeSet: ChangeSet,
  live: LiveOrgState,
  config: GuardrailConfig = {},
): GuardrailResult {
  for (const key of Object.keys(config)) {
    if (!KNOWN_GUARDRAIL_CONFIG_KEYS.has(key)) {
      throw new Error(
        `runGuardrails: unknown GuardrailConfig key "${key}" ` +
          `(known keys: ${[...KNOWN_GUARDRAIL_CONFIG_KEYS].join(", ")}). ` +
          `Refusing to run with an unrecognized guardrail option — a stale key ` +
          `must not silently weaken the apply.`,
      );
    }
  }

  // Resolve renames once; all checks receive the pre-resolved set.
  const resolved = resolveRenames(changeSet);

  const diagnostics: GuardrailDiagnostic[] = [];

  // Forward the caller's cap options VERBATIM: chant owns the precedence
  // (options managedTotals → change-set managedCounts → pooled → plan-relative)
  // and rebuilding the object field-by-field would drop future options.
  const cap = removalDeltaCap(resolved, { ...config.removalDeltaCap });
  if (cap) diagnostics.push(cap);

  // The member-aware guardrails only make sense for a change set with member
  // visibility: a live member roster, or member entries in the plan. A cycle
  // that never reads or writes membership (branch-protection, rulesets, …)
  // cannot change the admin count, and evaluating the floor against its
  // member-less live snapshot would read as "0 admins" and block every apply.
  const memberAware =
    live.members !== undefined || resolved.entries.some((e) => e.resourceType === "member");

  if (memberAware) {
    const postApply = computePostApplyMembers(resolved, live.members ?? []);

    const floor = adminFloor(resolved, live, config.adminFloor, postApply);
    if (floor) diagnostics.push(floor);

    if (config.requiredAdmins) {
      const req = requiredAdmins(resolved, live, config.requiredAdmins, postApply);
      if (req) diagnostics.push(req);
    }

    if (config.requireSelf) {
      const self = requireSelf(resolved, live, config.requireSelf, postApply);
      if (self) diagnostics.push(self);
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true };
}
