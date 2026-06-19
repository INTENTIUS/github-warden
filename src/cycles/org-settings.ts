/**
 * Org-settings cycle.
 *
 * Reconciles organization-level settings — default repository permission,
 * member repository-creation privileges, public org metadata (description,
 * email, website), and the surfaced 2FA-requirement flag.
 *
 *   GET   /orgs/{org}   — read live org settings
 *   PATCH /orgs/{org}   — update declared settings
 *
 * Follows the four-part `Cycle` structure established by the branch-protection
 * template (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Why this cycle does NOT do a read-modify-write merge
 *
 * Unlike the branch-protection PUT (a FULL replacement, which forces an RMW to
 * avoid nulling undeclared fields), `PATCH /orgs/{org}` is a *partial* update:
 * GitHub touches only the keys present in the request body and leaves every
 * other org setting untouched. So selective-by-omission is honoured simply by
 * sending only the fields the config declares — there is no undeclared-field to
 * preserve, hence no live re-fetch in `apply`.
 *
 * ## Scope
 *
 * Org settings are addressed entirely by `orgLogin` (supplied per-org by the
 * runner). There is no per-repo or per-resource scope, so `OrgSettingsScope` is
 * an empty object kept only for template/type symmetry with other cycles.
 *
 * ## Platform note: two-factor enforcement
 *
 * `requireTwoFactorAuthentication` (`two_factor_requirement_enabled`) is
 * surfaced from the GET response so dry-runs can report drift, and is forwarded
 * in the PATCH body when declared. GitHub treats this key as read-only on most
 * plans (2FA enforcement is toggled via org security settings, not this
 * endpoint); where that is the case GitHub ignores the key rather than erroring.
 * Hardened 2FA / security-feature enforcement is the remit of the
 * security-feature cycle (#13), not this one.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, OrgSettings } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveOrgSettings } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the org-settings cycle.
 *
 * Org settings have no sub-resource selector — the org is identified by
 * `orgLogin`, supplied per-org by the runner. This empty object exists only for
 * symmetry with the other cycles' typed scopes.
 */
export type OrgSettingsScope = Record<string, never>;

// ---------------------------------------------------------------------------
// GitHub REST API response shape (only the fields we read)
// ---------------------------------------------------------------------------

/** Minimal shape of the `GET /orgs/{org}` response we care about. */
interface GhOrg {
  description?: string | null;
  email?: string | null;
  /** GitHub stores the org website URL under `blog`. */
  blog?: string | null;
  default_repository_permission?: string | null;
  members_can_create_public_repositories?: boolean | null;
  members_can_create_private_repositories?: boolean | null;
  members_can_create_internal_repositories?: boolean | null;
  two_factor_requirement_enabled?: boolean | null;
}

const VALID_DEFAULT_PERMISSIONS = new Set(["none", "read", "write", "admin"]);

// ---------------------------------------------------------------------------
// Live-state mapping
// ---------------------------------------------------------------------------

/**
 * Map the GitHub org GET response to the `LiveOrgSettings` shape used by the
 * diff. Only the fields this cycle manages are mapped; absent/null fields are
 * left unset so the diff treats them as "not present live".
 */
function mapOrgToLive(raw: GhOrg): LiveOrgSettings {
  const live: LiveOrgSettings = {};

  if (raw.description != null) live.description = raw.description;
  if (raw.email != null) live.email = raw.email;
  if (raw.blog != null) live.websiteUrl = raw.blog;

  if (raw.default_repository_permission != null && VALID_DEFAULT_PERMISSIONS.has(raw.default_repository_permission)) {
    live.defaultRepositoryPermission = raw.default_repository_permission as LiveOrgSettings["defaultRepositoryPermission"];
  }

  if (typeof raw.members_can_create_public_repositories === "boolean") {
    live.membersCanCreatePublicRepositories = raw.members_can_create_public_repositories;
  }
  if (typeof raw.members_can_create_private_repositories === "boolean") {
    live.membersCanCreatePrivateRepositories = raw.members_can_create_private_repositories;
  }
  if (typeof raw.members_can_create_internal_repositories === "boolean") {
    live.membersCanCreateInternalRepositories = raw.members_can_create_internal_repositories;
  }
  if (typeof raw.two_factor_requirement_enabled === "boolean") {
    live.requireTwoFactorAuthentication = raw.two_factor_requirement_enabled;
  }

  return live;
}

// ---------------------------------------------------------------------------
// PATCH body builder
// ---------------------------------------------------------------------------

/**
 * Build the `PATCH /orgs/{org}` request body from the declared settings.
 *
 * Only keys present in `desired` are emitted (selective-by-omission). Because
 * the GitHub PATCH is a partial update, undeclared org settings are left
 * untouched by GitHub — no live merge required.
 */
export function buildOrgPatchBody(desired: OrgSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (desired.description !== undefined) body.description = desired.description;
  if (desired.email !== undefined) body.email = desired.email;
  if (desired.websiteUrl !== undefined) body.blog = desired.websiteUrl;
  if (desired.defaultRepositoryPermission !== undefined) {
    body.default_repository_permission = desired.defaultRepositoryPermission;
  }
  if (desired.membersCanCreatePublicRepositories !== undefined) {
    body.members_can_create_public_repositories = desired.membersCanCreatePublicRepositories;
  }
  if (desired.membersCanCreatePrivateRepositories !== undefined) {
    body.members_can_create_private_repositories = desired.membersCanCreatePrivateRepositories;
  }
  if (desired.membersCanCreateInternalRepositories !== undefined) {
    body.members_can_create_internal_repositories = desired.membersCanCreateInternalRepositories;
  }
  // Forwarded best-effort; GitHub may treat this as read-only (see file header).
  if (desired.requireTwoFactorAuthentication !== undefined) {
    body.two_factor_requirement_enabled = desired.requireTwoFactorAuthentication;
  }

  return body;
}

// ---------------------------------------------------------------------------
// orgSettingsCycle — implements Cycle<OrgSettingsScope>
// ---------------------------------------------------------------------------

/**
 * Governance cycle for organization-level settings.
 *
 * Reconciles the `settings` block of each org in the config. Leaves the
 * `settings` block — and every individual field within it — untouched when
 * absent from config (selective-by-omission).
 */
export const orgSettingsCycle: Cycle<OrgSettingsScope> = {
  name: "org-settings",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    _scope: OrgSettingsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    budget.use(1);
    let raw: GhOrg;
    try {
      raw = await client.request<GhOrg>("GET", `/orgs/${orgLogin}`);
    } catch (err) {
      // A missing org (404) means there is nothing live to diff against — the
      // diff will emit a create. Surfacing it as empty rather than throwing
      // keeps the run going for other orgs/cycles.
      if (err instanceof Error && err.message.includes("404")) {
        return {};
      }
      throw err;
    }

    return { settings: mapOrgToLive(raw) };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: OrgSettingsScope): OrgConfig {
    // Only the org settings are managed by this cycle; strip everything else so
    // the diff focuses on the org-settings domain.
    if (!orgConfig.settings) return {};
    return { settings: orgConfig.settings };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: OrgSettingsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "org-settings") {
      // Safety: this cycle only handles org-settings entries.
      return;
    }

    // Org settings are never deleted — the diff only ever emits create/update
    // for this resource type. Ignore a delete defensively.
    if (entry.kind === "delete") return;

    const desired = entry.after as OrgSettings;
    const body = buildOrgPatchBody(desired);

    // Nothing declared → nothing to do (avoids an empty PATCH).
    if (Object.keys(body).length === 0) return;

    budget.use(1);
    await client.request("PATCH", `/orgs/${orgLogin}`, body);
  },
};
