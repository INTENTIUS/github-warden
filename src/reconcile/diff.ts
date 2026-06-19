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
  RepoBaselineConfig,
  TokenPolicyConfig,
  TokenApprovalPolicy,
} from "../config/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// The provider-agnostic change-set model lives in the reconcile core; re-export
// it here so existing `import { ChangeSet, ... } from "./diff.js"` keeps working.
import type {
  FieldChange,
  ChangeKind,
  ChangeSetEntry,
  ChangeSet,
  DiffOptions,
} from "./core.js";
import { diffFields, diffCollection, summarizeChangeSet, renderChangeSet } from "./core.js";
export type { FieldChange, ChangeKind, ChangeSetEntry, ChangeSet, DiffOptions } from "./core.js";
export { summarizeChangeSet, renderChangeSet } from "./core.js";

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
  tokenGrants?: LiveTokenGrant[];
  tokenRequests?: LiveTokenRequest[];
}

/** Live snapshot of a pending fine-grained PAT request. */
export interface LiveTokenRequest {
  /** Request id (used to approve/deny). */
  id: number;
  /** Login of the requester. */
  ownerLogin?: string;
  /** Flattened permission scope names the request asks for. */
  permissions: string[];
}

/** Live snapshot of a fine-grained PAT grant on the org (timestamps in epoch ms). */
export interface LiveTokenGrant {
  /** Grant id (used to revoke). */
  id: number;
  /** Login of the token owner. */
  ownerLogin?: string;
  /** Whether GitHub reports the token as expired. */
  expired?: boolean;
  /** Expiry time (epoch ms), if any. */
  expiresAtMs?: number;
  /** Last-used time (epoch ms), if known. */
  lastUsedAtMs?: number;
  /** When org access was granted (epoch ms). */
  grantedAtMs?: number;
}

// ---------------------------------------------------------------------------
// Resource type ordering — stable output across runs
// ---------------------------------------------------------------------------

const RESOURCE_TYPE_ORDER = [
  "org-settings",
  "org-ruleset",
  "org-secret",
  "org-variable",
  "token-grant",
  "token-request",
  "repo-baseline",
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
  diffRepoBaselines(desired.repoBaselines, live.repos ?? {}, entries);
  diffTokenGrants(desired.tokenPolicy, live.tokenGrants ?? [], opts, entries);
  diffTokenRequests(desired.tokenApproval, live.tokenRequests ?? [], entries);
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

  const role = (dm: TeamMember) => dm.role ?? "member";
  diffCollection<TeamMember, LiveTeamMember>({
    resourceType: "team-member",
    keyPrefix: `${teamSlug}/`,
    desired: new Map(desired.map((m) => [m.login, m])),
    live: new Map(live.map((m) => [m.login, m])),
    compareFields: (dm, lm) =>
      lm.role !== role(dm) ? [{ field: "role", before: lm.role, after: role(dm) }] : [],
    createAfter: (login, dm) => ({ login, role: role(dm) }),
    updateAfter: (login, dm) => ({ login, role: role(dm) }),
    opts,
    out,
  });
}

function diffTeamRepos(
  teamSlug: string,
  desired: TeamRepo[] | undefined,
  live: LiveTeamRepo[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  diffCollection<TeamRepo, LiveTeamRepo>({
    resourceType: "team-repo",
    keyPrefix: `${teamSlug}/`,
    desired: new Map(desired.map((r) => [r.name, r])),
    live: new Map(live.map((r) => [r.name, r])),
    compareFields: (dr, lr) =>
      lr.permission !== dr.permission
        ? [{ field: "permission", before: lr.permission, after: dr.permission }]
        : [],
    opts,
    out,
  });
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

  const role = (dm: MemberConfig) => dm.role ?? "member";
  diffCollection<MemberConfig, LiveMemberConfig>({
    resourceType: "member",
    desired: new Map(desired.map((m) => [m.login, m])),
    live: new Map(live.map((m) => [m.login, m])),
    compareFields: (dm, lm) =>
      lm.role !== role(dm) ? [{ field: "role", before: lm.role, after: role(dm) }] : [],
    createAfter: (login, dm) => ({ login, role: role(dm) }),
    updateAfter: (login, dm) => ({ login, role: role(dm) }),
    opts,
    out,
  });
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

  diffCollection<RulesetConfig, LiveRuleset>({
    resourceType,
    keyPrefix,
    desired: new Map(desired.map((r) => [r.name, r])),
    live: new Map(live.map((r) => [r.name, r])),
    compareFields: (dr, lr) =>
      diffObjectKeys(
        dr as unknown as Record<string, unknown>,
        lr as unknown as Record<string, unknown>,
        RULESET_FIELDS,
      ),
    opts,
    out,
  });
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

  diffCollection<EnvironmentConfig, LiveEnvironment>({
    resourceType: "environment",
    keyPrefix: `${repoName}/`,
    desired: new Map(desired.map((e) => [e.name, e])),
    live: new Map(live.map((e) => [e.name, e])),
    compareFields: (de, le) =>
      diffObjectKeys(
        de as unknown as Record<string, unknown>,
        le as unknown as Record<string, unknown>,
        ENVIRONMENT_FIELDS,
      ),
    opts,
    out,
  });
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

  // Presence-only: never an update (values are unreadable). compareFields → [].
  diffCollection<SecretConfig, LiveSecret>({
    resourceType,
    keyPrefix,
    desired: new Map(desired.map((s) => [s.name, s])),
    live: new Map(live.map((s) => [s.name, s])),
    compareFields: () => [],
    opts,
    out,
  });
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

  diffCollection<VariableConfig, LiveVariable>({
    resourceType,
    keyPrefix,
    desired: new Map(desired.map((v) => [v.name, v])),
    live: new Map(live.map((v) => [v.name, v])),
    // Presence + value: only declared values are compared.
    compareFields: (dv, lv) =>
      dv.value !== undefined && dv.value !== lv.value
        ? [{ field: "value", before: lv.value, after: dv.value }]
        : [],
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Token governance
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Evaluate a single token grant against the policy. Returns a short violation
 * reason (e.g. "expired", "exceeds-max-lifetime", "idle") or null when the
 * grant is compliant. Pure — age/idle checks require `nowMs` (skipped when
 * undefined); the expiry check is clock-free (uses GitHub's `expired` flag).
 */
export function evaluateTokenViolation(
  grant: LiveTokenGrant,
  policy: TokenPolicyConfig,
  nowMs?: number,
): string | null {
  if (policy.revokeExpired !== false && grant.expired === true) return "expired";

  if (
    policy.maxLifetimeDays != null &&
    nowMs != null &&
    grant.grantedAtMs != null &&
    (nowMs - grant.grantedAtMs) / MS_PER_DAY > policy.maxLifetimeDays
  ) {
    return "exceeds-max-lifetime";
  }

  if (
    policy.maxIdleDays != null &&
    nowMs != null &&
    grant.lastUsedAtMs != null &&
    (nowMs - grant.lastUsedAtMs) / MS_PER_DAY > policy.maxIdleDays
  ) {
    return "idle";
  }

  return null;
}

/**
 * Diff org token grants against the governance policy. A violating grant is
 * emitted as an UPDATE (resource type "token-grant", key = grant id) meaning
 * "revoke org access" — modelled as an update, not a delete, so a routine
 * revocation sweep does not trip the removalDeltaCap guardrail.
 */
function diffTokenGrants(
  policy: TokenPolicyConfig | undefined,
  grants: LiveTokenGrant[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (policy === undefined) return;

  for (const grant of grants) {
    const reason = evaluateTokenViolation(grant, policy, opts.nowMs);
    if (!reason) continue;
    out.push({
      kind: "update",
      resourceType: "token-grant",
      key: String(grant.id),
      before: grant,
      after: { revoke: true, reason, ownerLogin: grant.ownerLogin },
      fields: [{ field: "access", before: "granted", after: `revoked (${reason})` }],
    });
  }
}

// ---------------------------------------------------------------------------
// Token approval
// ---------------------------------------------------------------------------

/**
 * Decide a single pending PAT request against the approval policy. Returns
 * "approve" (all requested permissions are allowed), "deny" (not approvable and
 * the policy auto-denies), or null (leave pending for a human). Pure.
 */
export function evaluateTokenRequest(
  request: LiveTokenRequest,
  policy: TokenApprovalPolicy,
): "approve" | "deny" | null {
  const allowed = new Set(policy.allowedPermissions ?? []);
  const approvable = request.permissions.every((p) => allowed.has(p));
  if (approvable) return "approve";
  return policy.default === "deny" ? "deny" : null;
}

/**
 * Diff pending PAT requests against the approval policy. Each auto-decided
 * request is emitted as a "token-request" UPDATE carrying the decision; requests
 * left for manual review produce no entry.
 */
function diffTokenRequests(
  policy: TokenApprovalPolicy | undefined,
  requests: LiveTokenRequest[],
  out: ChangeSetEntry[],
): void {
  if (policy === undefined) return;

  for (const request of requests) {
    const decision = evaluateTokenRequest(request, policy);
    if (!decision) continue;
    out.push({
      kind: "update",
      resourceType: "token-request",
      key: String(request.id),
      before: request,
      after: { decision, ownerLogin: request.ownerLogin },
      fields: [{ field: "decision", before: "pending", after: decision }],
    });
  }
}

// ---------------------------------------------------------------------------
// Repository baseline / provisioning
// ---------------------------------------------------------------------------

/**
 * Diff declared repo baselines against the live org repos. Resource type
 * "repo-baseline", key = repo name. Existence-only: emits a create when a
 * declared repo is missing from the org; never updates or deletes (settings
 * are reconciled by the per-repo cycles, and baselines never remove a repo).
 */
function diffRepoBaselines(
  desired: RepoBaselineConfig[] | undefined,
  liveRepos: Record<string, LiveRepoConfig>,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  for (const baseline of desired) {
    if (!Object.prototype.hasOwnProperty.call(liveRepos, baseline.name)) {
      out.push({ kind: "create", resourceType: "repo-baseline", key: baseline.name, after: baseline });
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
// Object-level field diffing helpers (thin adapters over the core primitive)
// ---------------------------------------------------------------------------

/** Diff every key present in `desired` against `live`. See `core.diffFields`. */
function diffObject(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
): FieldChange[] {
  return diffFields(desired, live);
}

/** Diff only the listed keys (if present in `desired`) against `live`. */
function diffObjectKeys(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  keys: string[],
): FieldChange[] {
  return diffFields(desired, live, keys);
}
