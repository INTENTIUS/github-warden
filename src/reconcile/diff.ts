/**
 * Governance plan/diff primitive.
 *
 * Given a desired-state config and a fetched live snapshot of the same
 * resources, compute a typed change set (creates / updates / deletes).
 *
 * Selective-by-omission: a field absent from desired is never a diff. A
 * managed collection emits deletes ONLY for entries the caller declares it
 * owns via an explicit ownership predicate — never blanket deletion.
 *
 * Pure, deterministic, no I/O.
 */
import type {
  OrgConfig,
  OrgSettings,
  TeamConfig,
  TeamMember,
  TeamRepo,
  MemberConfig,
  RepoConfig,
  BranchProtectionConfig,
  RulesetConfig,
  RepoSecurityConfig,
  EnvironmentConfig,
  EnvironmentReviewer,
  DeploymentBranchPolicy,
  SecretConfig,
  VariableConfig,
  DependabotConfig,
} from "../config/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single field-level change: what the old value was and what it will become. */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** The kind of operation this change represents. */
export type ChangeKind = "create" | "update" | "delete";

/** A single entry in the change set. */
export interface ChangeSetEntry {
  kind: ChangeKind;
  /**
   * High-level resource category (e.g. "org-settings", "team", "member",
   * "repo", "team-member", "team-repo", "branch-protection").
   */
  resourceType: string;
  /**
   * Unique key identifying this resource within its type.
   * - For top-level resources: "org-settings", a team slug, a member login, a
   *   repo name.
   * - For nested resources: "<parent>/<child>" (e.g. "backend/alice" for a
   *   team member, "my-repo/main" for a branch protection rule).
   */
  key: string;
  /** The live value before the change (absent for creates). */
  before?: unknown;
  /** The desired value after the change (absent for deletes). */
  after?: unknown;
  /**
   * Field-level diff, populated for `update` entries. Each entry describes
   * one field that differs between desired and live.
   */
  fields?: FieldChange[];
}

/** The full set of changes to reconcile for one org. */
export interface ChangeSet {
  /** GitHub org login this change set applies to. */
  org: string;
  /** All proposed changes, in stable order (see `RESOURCE_TYPE_ORDER`). */
  entries: ChangeSetEntry[];
}

/** Options controlling diff behaviour. */
export interface DiffOptions {
  /**
   * Ownership predicate for collection entries (team members, team repos,
   * org members, branch protection rules, etc.).
   *
   * When the desired config declares a collection (e.g. `team.members`), the
   * diff considers deleting live entries not found in desired. An entry is
   * only emitted as `delete` when this predicate returns `true` for it.
   *
   * If omitted, deletes are never emitted for collection entries — equivalent
   * to "assume nothing is owned".
   *
   * @param resourceType - The resource type string (same as `ChangeSetEntry.resourceType`).
   * @param key - The entry key (same as `ChangeSetEntry.key`).
   * @returns `true` if chant owns this entry and may delete it.
   */
  isOwned?: (resourceType: string, key: string) => boolean;
}

// ---------------------------------------------------------------------------
// Live snapshot types
// ---------------------------------------------------------------------------

/**
 * Live snapshot of a single org's state. Every sub-type mirrors the desired
 * config shape but uses concrete (non-optional) values.
 */
export interface LiveOrgSettings {
  description?: string;
  email?: string;
  websiteUrl?: string;
  membersCanCreatePublicRepositories?: boolean;
  membersCanCreatePrivateRepositories?: boolean;
  membersCanCreateInternalRepositories?: boolean;
  defaultRepositoryPermission?: "none" | "read" | "write" | "admin";
  requireTwoFactorAuthentication?: boolean;
}

export interface LiveTeamMember {
  login: string;
  role: "member" | "maintainer";
}

export interface LiveTeamRepo {
  name: string;
  permission: "pull" | "triage" | "push" | "maintain" | "admin";
}

export interface LiveTeamConfig {
  description?: string;
  privacy?: "secret" | "closed";
  parentTeamSlug?: string;
  members?: LiveTeamMember[];
  repos?: LiveTeamRepo[];
}

export interface LiveMemberConfig {
  login: string;
  role: "member" | "admin";
}

export interface LiveBranchProtectionConfig {
  pattern: string;
  requirePullRequestReviews?: boolean;
  requiredApprovingReviewCount?: number;
  dismissStaleReviews?: boolean;
  requireCodeOwnerReviews?: boolean;
  requireStatusChecks?: boolean;
  requiredStatusCheckContexts?: string[];
  requireBranchesToBeUpToDate?: boolean;
  restrictPushes?: boolean;
  allowForcePushes?: boolean;
  allowDeletions?: boolean;
  requireLinearHistory?: boolean;
  /**
   * Whether admins are subject to the protection. Not exposed in the desired
   * config (so never diffed) but captured live so the apply path can preserve
   * it across a full-replacement PUT.
   */
  enforceAdmins?: boolean;
}

/**
 * Live snapshot of a single ruleset. Mirrors `RulesetConfig` plus the GitHub
 * numeric `id` (not a desired field, so never diffed) which the apply path
 * needs to address the ruleset for update/delete.
 */
export interface LiveRuleset {
  /** GitHub-assigned ruleset id. Captured for apply (PUT/DELETE), never diffed. */
  id?: number;
  name: string;
  target?: string;
  enforcement?: string;
  bypassActors?: Array<Record<string, unknown>>;
  conditions?: Record<string, unknown>;
  rules?: Array<Record<string, unknown>>;
}

export interface LiveRepoConfig {
  description?: string;
  websiteUrl?: string;
  private?: boolean;
  hasIssues?: boolean;
  hasProjects?: boolean;
  hasWiki?: boolean;
  defaultBranch?: string;
  allowSquashMerge?: boolean;
  allowMergeCommit?: boolean;
  allowRebaseMerge?: boolean;
  deleteBranchOnMerge?: boolean;
  branchProtection?: LiveBranchProtectionConfig[];
  topics?: string[];
  rulesets?: LiveRuleset[];
  security?: LiveRepoSecurity;
  environments?: LiveEnvironment[];
  secrets?: LiveSecret[];
  variables?: LiveVariable[];
  dependabot?: LiveDependabot;
}

/**
 * Live snapshot of a repo's `.github/dependabot.yml`. `sha` is the GitHub blob
 * sha (needed to update the file via the Contents API); it is never diffed.
 */
export interface LiveDependabot {
  content?: string;
  sha?: string;
}

/** Live snapshot of an Actions secret — name only (values are never readable). */
export interface LiveSecret {
  name: string;
}

/** Live snapshot of an Actions variable (values ARE readable). */
export interface LiveVariable {
  name: string;
  value?: string;
}

/** Live snapshot of a deployment environment. Mirrors `EnvironmentConfig`. */
export interface LiveEnvironment {
  name: string;
  waitTimer?: number;
  preventSelfReview?: boolean;
  reviewers?: EnvironmentReviewer[];
  deploymentBranchPolicy?: DeploymentBranchPolicy | null;
}

/** Live snapshot of a repo's security-feature toggles. Mirrors `RepoSecurityConfig`. */
export interface LiveRepoSecurity {
  advancedSecurity?: boolean;
  secretScanning?: boolean;
  secretScanningPushProtection?: boolean;
  vulnerabilityAlerts?: boolean;
  dependabotSecurityUpdates?: boolean;
}

export interface LiveOrgState {
  settings?: LiveOrgSettings;
  teams?: Record<string, LiveTeamConfig>;
  members?: LiveMemberConfig[];
  repos?: Record<string, LiveRepoConfig>;
  rulesets?: LiveRuleset[];
  secrets?: LiveSecret[];
  variables?: LiveVariable[];
}

// ---------------------------------------------------------------------------
// Resource type ordering — stable output across runs
// ---------------------------------------------------------------------------

const RESOURCE_TYPE_ORDER = [
  "org-settings",
  "org-ruleset",
  "org-secret",
  "org-variable",
  "team",
  "team-member",
  "team-repo",
  "member",
  "repo",
  "repo-security",
  "environment",
  "branch-protection",
  "repo-ruleset",
  "repo-secret",
  "repo-variable",
  "dependabot",
] as const;

// ---------------------------------------------------------------------------
// diff — top-level entry point
// ---------------------------------------------------------------------------

/**
 * Compute a typed change set for one org.
 *
 * @param org - GitHub org login.
 * @param desired - Desired state from the governance config.
 * @param live - Live snapshot fetched from the GitHub API.
 * @param opts - Diff options (ownership predicate, etc.).
 */
export function diff(
  org: string,
  desired: OrgConfig,
  live: LiveOrgState,
  opts: DiffOptions = {},
): ChangeSet {
  const entries: ChangeSetEntry[] = [];

  diffSettings(desired.settings, live.settings, entries);
  diffRulesets("", "org-ruleset", desired.rulesets, live.rulesets ?? [], opts, entries);
  diffSecrets("", "org-secret", desired.secrets, live.secrets ?? [], opts, entries);
  diffVariables("", "org-variable", desired.variables, live.variables ?? [], opts, entries);
  diffTeams(desired.teams, live.teams ?? {}, opts, entries);
  diffMembers(desired.members, live.members ?? [], opts, entries);
  diffRepos(desired.repos, live.repos ?? {}, opts, entries);

  // Sort into canonical order
  const typeIndex = (t: string): number => {
    const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
    return i === -1 ? RESOURCE_TYPE_ORDER.length : i;
  };
  entries.sort((a, b) => {
    const ti = typeIndex(a.resourceType) - typeIndex(b.resourceType);
    if (ti !== 0) return ti;
    return a.key.localeCompare(b.key);
  });

  return { org, entries };
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

function diffSettings(
  desired: OrgSettings | undefined,
  live: LiveOrgSettings | undefined,
  out: ChangeSetEntry[],
): void {
  // Org settings are not managed when absent
  if (desired === undefined) return;

  if (live === undefined) {
    out.push({ kind: "create", resourceType: "org-settings", key: "org-settings", after: desired });
    return;
  }

  const fields = diffObject(desired as Record<string, unknown>, live as Record<string, unknown>);
  if (fields.length > 0) {
    out.push({
      kind: "update",
      resourceType: "org-settings",
      key: "org-settings",
      before: live,
      after: desired,
      fields,
    });
  }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function diffTeams(
  desired: Record<string, TeamConfig> | undefined,
  live: Record<string, LiveTeamConfig>,
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  // Creates and updates
  for (const [slug, desiredTeam] of Object.entries(desired)) {
    const liveTeam = live[slug];
    if (!liveTeam) {
      out.push({ kind: "create", resourceType: "team", key: slug, after: desiredTeam });
      continue;
    }
    // Diff top-level team fields (exclude members/repos — handled separately)
    const teamFields = diffObjectKeys(
      desiredTeam as Record<string, unknown>,
      liveTeam as Record<string, unknown>,
      ["description", "privacy", "parentTeamSlug"],
    );
    if (teamFields.length > 0) {
      out.push({
        kind: "update",
        resourceType: "team",
        key: slug,
        before: liveTeam,
        after: desiredTeam,
        fields: teamFields,
      });
    }

    // Team members
    diffTeamMembers(slug, desiredTeam.members, liveTeam.members ?? [], opts, out);

    // Team repos
    diffTeamRepos(slug, desiredTeam.repos, liveTeam.repos ?? [], opts, out);
  }

  // Deletes: live teams not in desired
  for (const slug of Object.keys(live)) {
    if (!Object.prototype.hasOwnProperty.call(desired, slug)) {
      const key = slug;
      if (opts.isOwned?.("team", key)) {
        out.push({ kind: "delete", resourceType: "team", key, before: live[slug] });
      }
    }
  }
}

function diffTeamMembers(
  teamSlug: string,
  desired: TeamMember[] | undefined,
  live: LiveTeamMember[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return; // not managed

  const desiredByLogin = new Map(desired.map((m) => [m.login, m]));
  const liveByLogin = new Map(live.map((m) => [m.login, m]));

  // Creates and updates
  for (const [login, dm] of desiredByLogin) {
    const lm = liveByLogin.get(login);
    const effectiveRole = dm.role ?? "member";
    if (!lm) {
      out.push({
        kind: "create",
        resourceType: "team-member",
        key: `${teamSlug}/${login}`,
        after: { login, role: effectiveRole },
      });
    } else if (lm.role !== effectiveRole) {
      out.push({
        kind: "update",
        resourceType: "team-member",
        key: `${teamSlug}/${login}`,
        before: lm,
        after: { login, role: effectiveRole },
        fields: [{ field: "role", before: lm.role, after: effectiveRole }],
      });
    }
  }

  // Deletes: ownership-gated
  for (const [login, lm] of liveByLogin) {
    if (!desiredByLogin.has(login)) {
      const key = `${teamSlug}/${login}`;
      if (opts.isOwned?.("team-member", key)) {
        out.push({ kind: "delete", resourceType: "team-member", key, before: lm });
      }
    }
  }
}

function diffTeamRepos(
  teamSlug: string,
  desired: TeamRepo[] | undefined,
  live: LiveTeamRepo[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByName = new Map(desired.map((r) => [r.name, r]));
  const liveByName = new Map(live.map((r) => [r.name, r]));

  for (const [name, dr] of desiredByName) {
    const lr = liveByName.get(name);
    if (!lr) {
      out.push({
        kind: "create",
        resourceType: "team-repo",
        key: `${teamSlug}/${name}`,
        after: dr,
      });
    } else if (lr.permission !== dr.permission) {
      out.push({
        kind: "update",
        resourceType: "team-repo",
        key: `${teamSlug}/${name}`,
        before: lr,
        after: dr,
        fields: [{ field: "permission", before: lr.permission, after: dr.permission }],
      });
    }
  }

  for (const [name, lr] of liveByName) {
    if (!desiredByName.has(name)) {
      const key = `${teamSlug}/${name}`;
      if (opts.isOwned?.("team-repo", key)) {
        out.push({ kind: "delete", resourceType: "team-repo", key, before: lr });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Org members
// ---------------------------------------------------------------------------

function diffMembers(
  desired: MemberConfig[] | undefined,
  live: LiveMemberConfig[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByLogin = new Map(desired.map((m) => [m.login, m]));
  const liveByLogin = new Map(live.map((m) => [m.login, m]));

  for (const [login, dm] of desiredByLogin) {
    const lm = liveByLogin.get(login);
    const effectiveRole = dm.role ?? "member";
    if (!lm) {
      out.push({
        kind: "create",
        resourceType: "member",
        key: login,
        after: { login, role: effectiveRole },
      });
    } else if (lm.role !== effectiveRole) {
      out.push({
        kind: "update",
        resourceType: "member",
        key: login,
        before: lm,
        after: { login, role: effectiveRole },
        fields: [{ field: "role", before: lm.role, after: effectiveRole }],
      });
    }
  }

  for (const [login, lm] of liveByLogin) {
    if (!desiredByLogin.has(login)) {
      const key = login;
      if (opts.isOwned?.("member", key)) {
        out.push({ kind: "delete", resourceType: "member", key, before: lm });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

function diffRepos(
  desired: Record<string, RepoConfig> | undefined,
  live: Record<string, LiveRepoConfig>,
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  for (const [name, dr] of Object.entries(desired)) {
    const lr = live[name];
    if (!lr) {
      out.push({ kind: "create", resourceType: "repo", key: name, after: dr });
      continue;
    }
    const repoFields = diffObjectKeys(
      dr as Record<string, unknown>,
      lr as Record<string, unknown>,
      [
        "description", "websiteUrl", "private", "hasIssues", "hasProjects",
        "hasWiki", "defaultBranch", "allowSquashMerge", "allowMergeCommit",
        "allowRebaseMerge", "deleteBranchOnMerge",
      ],
    );
    // Topics: compare as sorted arrays if desired has topics
    if (dr.topics !== undefined) {
      const desiredTopics = [...dr.topics].sort().join(",");
      const liveTopics = [...(lr.topics ?? [])].sort().join(",");
      if (desiredTopics !== liveTopics) {
        repoFields.push({ field: "topics", before: lr.topics ?? [], after: dr.topics });
      }
    }
    if (repoFields.length > 0) {
      out.push({
        kind: "update",
        resourceType: "repo",
        key: name,
        before: lr,
        after: dr,
        fields: repoFields,
      });
    }

    // Branch protection rules
    diffBranchProtection(name, dr.branchProtection, lr.branchProtection ?? [], opts, out);

    // Repository rulesets
    diffRulesets(`${name}/`, "repo-ruleset", dr.rulesets, lr.rulesets ?? [], opts, out);

    // Repository security features
    diffRepoSecurity(name, dr.security, lr.security, out);

    // Deployment environments
    diffEnvironments(name, dr.environments, lr.environments ?? [], opts, out);

    // Actions secrets & variables
    diffSecrets(`${name}/`, "repo-secret", dr.secrets, lr.secrets ?? [], opts, out);
    diffVariables(`${name}/`, "repo-variable", dr.variables, lr.variables ?? [], opts, out);

    // Dependabot config file
    diffDependabot(name, dr.dependabot, lr.dependabot, out);
  }

  for (const name of Object.keys(live)) {
    if (!Object.prototype.hasOwnProperty.call(desired, name)) {
      if (opts.isOwned?.("repo", name)) {
        out.push({ kind: "delete", resourceType: "repo", key: name, before: live[name] });
      }
    }
  }
}

function diffBranchProtection(
  repoName: string,
  desired: BranchProtectionConfig[] | undefined,
  live: LiveBranchProtectionConfig[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByPattern = new Map(desired.map((r) => [r.pattern, r]));
  const liveByPattern = new Map(live.map((r) => [r.pattern, r]));

  const bpFields: Array<keyof BranchProtectionConfig> = [
    "requirePullRequestReviews",
    "requiredApprovingReviewCount",
    "dismissStaleReviews",
    "requireCodeOwnerReviews",
    "requireStatusChecks",
    "requireBranchesToBeUpToDate",
    "restrictPushes",
    "allowForcePushes",
    "allowDeletions",
    "requireLinearHistory",
  ];

  for (const [pattern, db] of desiredByPattern) {
    const lb = liveByPattern.get(pattern);
    const key = `${repoName}/${pattern}`;
    if (!lb) {
      out.push({ kind: "create", resourceType: "branch-protection", key, after: db });
      continue;
    }
    const fields = diffObjectKeys(
      db as unknown as Record<string, unknown>,
      lb as unknown as Record<string, unknown>,
      bpFields as string[],
    );
    // Special-case: requiredStatusCheckContexts (array comparison)
    if (db.requiredStatusCheckContexts !== undefined) {
      const ds = [...db.requiredStatusCheckContexts].sort().join(",");
      const ls = [...(lb.requiredStatusCheckContexts ?? [])].sort().join(",");
      if (ds !== ls) {
        fields.push({
          field: "requiredStatusCheckContexts",
          before: lb.requiredStatusCheckContexts ?? [],
          after: db.requiredStatusCheckContexts,
        });
      }
    }
    if (fields.length > 0) {
      out.push({
        kind: "update",
        resourceType: "branch-protection",
        key,
        before: lb,
        after: db,
        fields,
      });
    }
  }

  for (const [pattern, lb] of liveByPattern) {
    if (!desiredByPattern.has(pattern)) {
      const key = `${repoName}/${pattern}`;
      if (opts.isOwned?.("branch-protection", key)) {
        out.push({ kind: "delete", resourceType: "branch-protection", key, before: lb });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rulesets (org + repo)
// ---------------------------------------------------------------------------

const RULESET_FIELDS: string[] = ["target", "enforcement", "bypassActors", "conditions", "rules"];

/**
 * Diff a list of rulesets (org-level or repo-level), keyed by ruleset name.
 *
 * @param keyPrefix - "" for org rulesets, "<repo>/" for repo rulesets.
 * @param resourceType - "org-ruleset" or "repo-ruleset".
 *
 * The live `id` is not part of `RULESET_FIELDS`, so it is never diffed; it is
 * carried on the `before` snapshot for the apply path. Deletes are ownership-
 * gated like every other managed collection.
 */
function diffRulesets(
  keyPrefix: string,
  resourceType: "org-ruleset" | "repo-ruleset",
  desired: RulesetConfig[] | undefined,
  live: LiveRuleset[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByName = new Map(desired.map((r) => [r.name, r]));
  const liveByName = new Map(live.map((r) => [r.name, r]));

  for (const [name, dr] of desiredByName) {
    const lr = liveByName.get(name);
    const key = `${keyPrefix}${name}`;
    if (!lr) {
      out.push({ kind: "create", resourceType, key, after: dr });
      continue;
    }
    const fields = diffObjectKeys(
      dr as unknown as Record<string, unknown>,
      lr as unknown as Record<string, unknown>,
      RULESET_FIELDS,
    );
    if (fields.length > 0) {
      out.push({ kind: "update", resourceType, key, before: lr, after: dr, fields });
    }
  }

  for (const [name, lr] of liveByName) {
    if (!desiredByName.has(name)) {
      const key = `${keyPrefix}${name}`;
      if (opts.isOwned?.(resourceType, key)) {
        out.push({ kind: "delete", resourceType, key, before: lr });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Repository security features
// ---------------------------------------------------------------------------

/**
 * Diff a repo's security-feature toggles. Single object per repo, keyed by
 * repo name, resource type "repo-security". Selective-by-omission: only
 * declared flags are compared; an absent `security` block is not managed.
 */
function diffRepoSecurity(
  repoName: string,
  desired: RepoSecurityConfig | undefined,
  live: LiveRepoSecurity | undefined,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  if (live === undefined) {
    out.push({ kind: "create", resourceType: "repo-security", key: repoName, after: desired });
    return;
  }

  const fields = diffObject(desired as Record<string, unknown>, live as Record<string, unknown>);
  if (fields.length > 0) {
    out.push({
      kind: "update",
      resourceType: "repo-security",
      key: repoName,
      before: live,
      after: desired,
      fields,
    });
  }
}

// ---------------------------------------------------------------------------
// Deployment environments
// ---------------------------------------------------------------------------

const ENVIRONMENT_FIELDS: string[] = [
  "waitTimer",
  "preventSelfReview",
  "reviewers",
  "deploymentBranchPolicy",
];

/**
 * Diff a repo's deployment environments, keyed by environment name. Resource
 * type "environment", key "<repo>/<env>". Deletes are ownership-gated.
 *
 * `reviewers` and `deploymentBranchPolicy` are compared structurally
 * (deep-equal). The live `id` of each reviewer is part of the comparison, so
 * authored reviewers must use the same numeric ids the API returns.
 */
function diffEnvironments(
  repoName: string,
  desired: EnvironmentConfig[] | undefined,
  live: LiveEnvironment[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByName = new Map(desired.map((e) => [e.name, e]));
  const liveByName = new Map(live.map((e) => [e.name, e]));

  for (const [name, de] of desiredByName) {
    const le = liveByName.get(name);
    const key = `${repoName}/${name}`;
    if (!le) {
      out.push({ kind: "create", resourceType: "environment", key, after: de });
      continue;
    }
    const fields = diffObjectKeys(
      de as unknown as Record<string, unknown>,
      le as unknown as Record<string, unknown>,
      ENVIRONMENT_FIELDS,
    );
    if (fields.length > 0) {
      out.push({ kind: "update", resourceType: "environment", key, before: le, after: de, fields });
    }
  }

  for (const [name, le] of liveByName) {
    if (!desiredByName.has(name)) {
      const key = `${repoName}/${name}`;
      if (opts.isOwned?.("environment", key)) {
        out.push({ kind: "delete", resourceType: "environment", key, before: le });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Actions secrets & variables
// ---------------------------------------------------------------------------

/**
 * Diff Actions secrets by NAME only — values are never readable, so a secret is
 * either present or not. Emits creates for declared-but-missing secrets (the
 * apply path reports these; warden never writes values) and ownership-gated
 * deletes for undeclared live secrets. There are no updates.
 */
function diffSecrets(
  keyPrefix: string,
  resourceType: "org-secret" | "repo-secret",
  desired: SecretConfig[] | undefined,
  live: LiveSecret[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByName = new Map(desired.map((s) => [s.name, s]));
  const liveByName = new Map(live.map((s) => [s.name, s]));

  for (const [name, ds] of desiredByName) {
    if (!liveByName.has(name)) {
      out.push({ kind: "create", resourceType, key: `${keyPrefix}${name}`, after: ds });
    }
  }

  for (const [name, ls] of liveByName) {
    if (!desiredByName.has(name)) {
      const key = `${keyPrefix}${name}`;
      if (opts.isOwned?.(resourceType, key)) {
        out.push({ kind: "delete", resourceType, key, before: ls });
      }
    }
  }
}

/**
 * Diff Actions variables by name + value. Emits creates for missing variables,
 * updates when a declared value differs, and ownership-gated deletes for
 * undeclared live variables. A variable with no declared `value` is presence-
 * only (no update emitted on value).
 */
function diffVariables(
  keyPrefix: string,
  resourceType: "org-variable" | "repo-variable",
  desired: VariableConfig[] | undefined,
  live: LiveVariable[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  const desiredByName = new Map(desired.map((v) => [v.name, v]));
  const liveByName = new Map(live.map((v) => [v.name, v]));

  for (const [name, dv] of desiredByName) {
    const lv = liveByName.get(name);
    const key = `${keyPrefix}${name}`;
    if (!lv) {
      out.push({ kind: "create", resourceType, key, after: dv });
      continue;
    }
    if (dv.value !== undefined && dv.value !== lv.value) {
      out.push({
        kind: "update",
        resourceType,
        key,
        before: lv,
        after: dv,
        fields: [{ field: "value", before: lv.value, after: dv.value }],
      });
    }
  }

  for (const [name, lv] of liveByName) {
    if (!desiredByName.has(name)) {
      const key = `${keyPrefix}${name}`;
      if (opts.isOwned?.(resourceType, key)) {
        out.push({ kind: "delete", resourceType, key, before: lv });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dependabot config file
// ---------------------------------------------------------------------------

/**
 * Diff a repo's `.github/dependabot.yml` against the desired content. Resource
 * type "dependabot", key = repo name. Create when the file is absent, update
 * when content differs. Never deletes (managing presence/consistency, not
 * removal). The live `sha` is carried on `before` for the apply commit.
 */
function diffDependabot(
  repoName: string,
  desired: DependabotConfig | undefined,
  live: LiveDependabot | undefined,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  if (live === undefined || live.content === undefined) {
    out.push({ kind: "create", resourceType: "dependabot", key: repoName, after: desired });
    return;
  }

  if (desired.content !== live.content) {
    out.push({
      kind: "update",
      resourceType: "dependabot",
      key: repoName,
      before: live,
      after: desired,
      fields: [{ field: "content", before: live.content, after: desired.content }],
    });
  }
}

// ---------------------------------------------------------------------------
// Object-level field diffing helpers
// ---------------------------------------------------------------------------

/**
 * Diff only the keys present in `desired` against `live`. Returns one
 * FieldChange per key where the values differ (using deep equality via JSON).
 * Keys absent from `desired` are not compared — selective-by-omission.
 */
function diffObject(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
): FieldChange[] {
  const fields: FieldChange[] = [];
  for (const key of Object.keys(desired)) {
    const dv = desired[key];
    const lv = live[key];
    if (!deepEqual(dv, lv)) {
      fields.push({ field: key, before: lv, after: dv });
    }
  }
  return fields;
}

/**
 * Diff only the listed keys (if present in desired) against live.
 */
function diffObjectKeys(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  keys: string[],
): FieldChange[] {
  const fields: FieldChange[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(desired, key)) continue;
    const dv = desired[key];
    const lv = live[key];
    if (!deepEqual(dv, lv)) {
      fields.push({ field: key, before: lv, after: dv });
    }
  }
  return fields;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

/**
 * Count entries per change kind.
 */
export function summarizeChangeSet(cs: ChangeSet): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { create: 0, update: 0, delete: 0 };
  for (const e of cs.entries) counts[e.kind]++;
  return counts;
}

/**
 * Human-readable plan summary for dry-run output. Pure — returns a string.
 */
export function renderChangeSet(cs: ChangeSet): string {
  const counts = summarizeChangeSet(cs);
  const header = `Plan for ${cs.org}: ${counts.create} to create, ${counts.update} to update, ${counts.delete} to delete`;

  if (cs.entries.length === 0) return `${header}\nNo changes.`;

  const lines: string[] = [header];

  const byKind: Record<ChangeKind, ChangeSetEntry[]> = { create: [], update: [], delete: [] };
  for (const e of cs.entries) byKind[e.kind].push(e);

  const ORDER: ChangeKind[] = ["create", "update", "delete"];
  for (const kind of ORDER) {
    const group = byKind[kind];
    if (group.length === 0) continue;
    lines.push(`\n${kind.toUpperCase()}:`);
    for (const e of group) {
      lines.push(`  [${e.resourceType}] ${e.key}`);
      for (const f of e.fields ?? []) {
        lines.push(`    ${f.field}: ${fmt(f.before)} → ${fmt(f.after)}`);
      }
    }
  }

  return lines.join("\n");
}

function fmt(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}
