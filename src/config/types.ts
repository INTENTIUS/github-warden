/**
 * Desired-state config types for GitHub org/repo governance.
 *
 * Selective-by-omission: every field is optional. An absent field means
 * "not managed" — chant will not read, diff, or modify that aspect of the
 * live GitHub state. Only fields that are explicitly present are reconciled.
 */

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

/** High-level org-level settings. Absent fields are not managed. */
export interface OrgSettings {
  /** Public description shown on the org profile page. */
  description?: string;
  /** Public email address for the org. */
  email?: string;
  /** URL of the org's website. */
  websiteUrl?: string;
  /** Whether the org's member list is publicly visible. */
  membersCanCreatePublicRepositories?: boolean;
  /** Whether members can create private repositories. */
  membersCanCreatePrivateRepositories?: boolean;
  /** Whether members can create internal repositories (Enterprise only). */
  membersCanCreateInternalRepositories?: boolean;
  /** Default repository permission granted to all members: none | read | write | admin. */
  defaultRepositoryPermission?: "none" | "read" | "write" | "admin";
  /** Whether two-factor authentication is required for all members. */
  requireTwoFactorAuthentication?: boolean;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Membership role within a team. */
export type TeamRole = "member" | "maintainer";

/** A member entry within a team. */
export interface TeamMember {
  /** GitHub login of the user. */
  login: string;
  /** Role in the team. Defaults to "member" when omitted. */
  role?: TeamRole;
}

/** Repository access level granted to a team. */
export type TeamRepoPermission = "pull" | "triage" | "push" | "maintain" | "admin";

/** A repository access entry within a team. */
export interface TeamRepo {
  /** Repository name (without org prefix). */
  name: string;
  /** Permission level the team gets on this repository. */
  permission: TeamRepoPermission;
}

/** Desired state for a single GitHub team. Absent fields are not managed. */
export interface TeamConfig {
  /** Human-readable team description. */
  description?: string;
  /** Team visibility: "secret" (default) or "closed" (visible to all org members). */
  privacy?: "secret" | "closed";
  /** Parent team slug, if this team is nested under another. */
  parentTeamSlug?: string;
  /**
   * Former slug of this team. When set, a rename is reconciled as an update
   * rather than a delete+create: the reconcile guardrails (`resolveRenames`)
   * collapse a `delete(previously)` + `create(<this slug>)` pair into a single
   * update, preserving the team's members, repos, and history.
   *
   * Not written to GitHub — it is a reconcile-time hint only.
   */
  previously?: string;
  /**
   * Team members and their roles.
   * Absent means membership is not managed by chant.
   */
  members?: TeamMember[];
  /**
   * Repositories the team has access to.
   * Absent means repo permissions are not managed by chant.
   */
  repos?: TeamRepo[];
}

// ---------------------------------------------------------------------------
// Org members
// ---------------------------------------------------------------------------

/** Membership role within the org. */
export type OrgMemberRole = "member" | "admin";

/** Desired state for a single org member. */
export interface MemberConfig {
  /** GitHub login of the user. */
  login: string;
  /** Role in the org. Defaults to "member" when omitted. */
  role?: OrgMemberRole;
}

// ---------------------------------------------------------------------------
// Token governance
// ---------------------------------------------------------------------------

/**
 * Org fine-grained PAT governance policy. Drives the token-governance cycle's
 * scheduled sweep: it revokes a token grant's ORG ACCESS when the grant
 * violates the policy.
 *
 * PLATFORM WALL: user PATs cannot be created or rotated on a user's behalf via
 * the API. warden can only inventory grants, gate approval (#16), and revoke
 * org access — these token APIs are callable ONLY by a GitHub App.
 */
export interface TokenPolicyConfig {
  /** Revoke org access for an expired grant still listed. Default true. */
  revokeExpired?: boolean;
  /** Maximum grant lifetime in days (1–366). Older grants are revoked. */
  maxLifetimeDays?: number;
  /** Maximum idle days since last use. Staler grants are revoked. */
  maxIdleDays?: number;
}

/**
 * Policy for auto-deciding pending fine-grained PAT requests (the token-approval
 * cycle). A request is auto-APPROVED when every permission it asks for is in
 * `allowedPermissions`; otherwise the `default` decision applies. These request
 * endpoints are callable ONLY by a GitHub App.
 *
 * Platform note: admins can only approve or deny a request — they cannot change
 * the repo scope a creator chose.
 */
export interface TokenApprovalPolicy {
  /**
   * Permission scope names that may be auto-approved. A request is approved only
   * when ALL of its requested permissions are in this list. Absent → no request
   * is auto-approved.
   */
  allowedPermissions?: string[];
  /**
   * Decision for a request that is not auto-approved: "deny" (auto-deny) or
   * "manual" (leave pending for a human). Default "manual".
   */
  default?: "deny" | "manual";
}

// ---------------------------------------------------------------------------
// Dependency hygiene (Dependabot config file)
// ---------------------------------------------------------------------------

/**
 * Desired state for a repo's `.github/dependabot.yml`. warden ensures the file
 * exists and matches `content` exactly; encode cooldown / external-code-
 * execution policy etc. in that content. Absent means the file is not managed.
 */
export interface DependabotConfig {
  /** Exact desired content of `.github/dependabot.yml`. */
  content: string;
}

// ---------------------------------------------------------------------------
// Actions secrets & variables
// ---------------------------------------------------------------------------

/**
 * An Actions secret declaration. warden manages a secret's PRESENCE only — it
 * NEVER reads or writes secret values (those are provisioned out-of-band). A
 * declared-but-missing secret is reported; its value must be supplied
 * separately. An undeclared live secret is only removed when ownership-gated.
 */
export interface SecretConfig {
  /** Secret name (the identity key within its scope). */
  name: string;
  /**
   * Optional informational rotation pointer (e.g. a ticket or KMS key ref).
   * Recorded for humans/automation; never sent to GitHub and never diffed.
   */
  rotationRef?: string;
}

/**
 * An Actions variable declaration. Unlike secrets, variable values are NOT
 * secret, so warden can reconcile them fully (create/update/delete).
 */
export interface VariableConfig {
  /** Variable name (the identity key within its scope). */
  name: string;
  /** Variable value. Required to create or update; absent → presence-only. */
  value?: string;
  /**
   * Visibility for ORG-level variables on create: "all" | "private" |
   * "selected". Ignored for repo-level variables. Defaults to "all".
   */
  visibility?: "all" | "private" | "selected";
}

// ---------------------------------------------------------------------------
// Deployment environments
// ---------------------------------------------------------------------------

/** A required reviewer for an environment (a user or a team, by numeric id). */
export interface EnvironmentReviewer {
  /** "User" or "Team". */
  type: "User" | "Team";
  /** GitHub numeric id of the user or team. */
  id: number;
}

/**
 * Deployment-branch policy for an environment. At most one of the two flags is
 * true. `null` (as a declared value) disables the policy entirely.
 */
export interface DeploymentBranchPolicy {
  /** Restrict deployments to branches matching the repo's protection rules. */
  protectedBranches?: boolean;
  /** Restrict deployments to branches matching custom name patterns. */
  customBranchPolicies?: boolean;
}

/** Desired state for a single deployment environment. Absent fields are not managed. */
export interface EnvironmentConfig {
  /** Environment name (the identity key within a repo). */
  name: string;
  /** Wait timer in minutes before a deployment can proceed (0–43200). */
  waitTimer?: number;
  /** Prevent a deployment's actor from approving their own run. */
  preventSelfReview?: boolean;
  /** Required reviewers for deployments to this environment. */
  reviewers?: EnvironmentReviewer[];
  /**
   * Deployment branch policy. An object configures it; `null` disables it.
   * Absent means the branch policy is not managed.
   */
  deploymentBranchPolicy?: DeploymentBranchPolicy | null;
}

// ---------------------------------------------------------------------------
// Repository security features
// ---------------------------------------------------------------------------

/**
 * Repository security-feature toggles. Absent fields are not managed.
 *
 * The first three map to the repo `security_and_analysis` object (set via
 * `PATCH /repos/{o}/{r}`); the last two use dedicated endpoints
 * (`vulnerability-alerts`, `automated-security-fixes`).
 *
 * License-gated note: GitHub Advanced Security features (`advancedSecurity`,
 * and secret scanning on private repos) require a GHAS license. Where a feature
 * is unavailable, GitHub rejects the enabling write; the cycle surfaces that as
 * a reported failed entry rather than crashing the run (see cycle header).
 */
export interface RepoSecurityConfig {
  /** GitHub Advanced Security (`security_and_analysis.advanced_security`). */
  advancedSecurity?: boolean;
  /** Secret scanning (`security_and_analysis.secret_scanning`). */
  secretScanning?: boolean;
  /** Secret scanning push protection (`security_and_analysis.secret_scanning_push_protection`). */
  secretScanningPushProtection?: boolean;
  /** Dependabot vulnerability alerts (`vulnerability-alerts` endpoint). */
  vulnerabilityAlerts?: boolean;
  /** Dependabot automated security fixes (`automated-security-fixes` endpoint). */
  dependabotSecurityUpdates?: boolean;
}

// ---------------------------------------------------------------------------
// Rulesets (repo + org)
// ---------------------------------------------------------------------------

/** What a ruleset targets. */
export type RulesetTarget = "branch" | "tag" | "push";

/** How a ruleset is enforced. */
export type RulesetEnforcement = "active" | "evaluate" | "disabled";

/**
 * A repository or organization ruleset — the modern replacement for classic
 * branch protection (a separate REST API). Identified within its scope by
 * `name`. Absent fields are not managed (selective-by-omission).
 *
 * `bypassActors`, `conditions`, and `rules` are passed through in GitHub's
 * native (snake_case) JSON shape — e.g. a rule is `{ type, parameters? }`, a
 * condition is `{ ref_name: { include, exclude } }`, a bypass actor is
 * `{ actor_id, actor_type, bypass_mode }`. Authoring these mirrors the GitHub
 * API request body so the cycle can forward them verbatim.
 */
export interface RulesetConfig {
  /** Ruleset name — the identity key within its scope (org or repo). */
  name: string;
  /** Target ref type. GitHub defaults to "branch" on create when omitted. */
  target?: RulesetTarget;
  /** Enforcement level. */
  enforcement?: RulesetEnforcement;
  /** Bypass actors, GitHub-native shape: `{ actor_id, actor_type, bypass_mode }`. */
  bypassActors?: Array<Record<string, unknown>>;
  /** Conditions, GitHub-native shape: `{ ref_name: { include, exclude }, ... }`. */
  conditions?: Record<string, unknown>;
  /** Rules, GitHub-native shape: `[{ type, parameters? }]`. */
  rules?: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Repository baseline / provisioning
// ---------------------------------------------------------------------------

/**
 * A repo that should EXIST in the org (provisioning, not pure reconcile). The
 * baseline cycle creates the repo when it is missing — optionally from a
 * template — so a periodic run guarantees declared repos exist. Per-repo
 * SETTINGS (description, visibility, branch protection, …) are reconciled by
 * the other cycles via the `repos` map; this only ensures existence.
 *
 * Existence-only: the baseline cycle never deletes a repo.
 */
export interface RepoBaselineConfig {
  /** Repository name (without the org prefix). */
  name: string;
  /**
   * Template repo to generate from, as "owner/repo". When set, a missing repo
   * is created via the template-generate endpoint; otherwise an empty repo is
   * created.
   */
  template?: string;
  /** Whether a newly-created repo is private. Defaults to true (safe default). */
  private?: boolean;
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

/** Branch protection rule for a single branch pattern. Absent fields are not managed. */
export interface BranchProtectionConfig {
  /** Branch name pattern (e.g. "main", "release/*"). */
  pattern: string;
  /** Require pull request reviews before merging. */
  requirePullRequestReviews?: boolean;
  /** Number of approving reviews required. */
  requiredApprovingReviewCount?: number;
  /** Dismiss stale reviews when new commits are pushed. */
  dismissStaleReviews?: boolean;
  /** Require review from code owners. */
  requireCodeOwnerReviews?: boolean;
  /** Require status checks to pass before merging. */
  requireStatusChecks?: boolean;
  /** List of required status check contexts. */
  requiredStatusCheckContexts?: string[];
  /** Require branches to be up to date before merging. */
  requireBranchesToBeUpToDate?: boolean;
  /** Restrict who can push to matching branches. */
  restrictPushes?: boolean;
  /** Allow force pushes. */
  allowForcePushes?: boolean;
  /** Allow branch deletions. */
  allowDeletions?: boolean;
  /** Require linear history (no merge commits). */
  requireLinearHistory?: boolean;
}

/** Desired state for a single repository. Absent fields are not managed. */
export interface RepoConfig {
  /** Repository description. */
  description?: string;
  /** URL of the repository's website. */
  websiteUrl?: string;
  /** Whether the repository is private. */
  private?: boolean;
  /** Whether issues are enabled. */
  hasIssues?: boolean;
  /** Whether projects are enabled. */
  hasProjects?: boolean;
  /** Whether the wiki is enabled. */
  hasWiki?: boolean;
  /** Default branch name (e.g. "main"). */
  defaultBranch?: string;
  /** Whether to allow squash merges. */
  allowSquashMerge?: boolean;
  /** Whether to allow merge commits. */
  allowMergeCommit?: boolean;
  /** Whether to allow rebase merges. */
  allowRebaseMerge?: boolean;
  /** Whether to automatically delete head branches after pull requests are merged. */
  deleteBranchOnMerge?: boolean;
  /**
   * Branch protection rules keyed by branch pattern.
   * Absent means branch protection is not managed by chant.
   */
  branchProtection?: BranchProtectionConfig[];
  /**
   * Repository topics (labels shown on the GitHub UI).
   * Absent means topics are not managed by chant.
   */
  topics?: string[];
  /**
   * Repository rulesets (the modern branch-protection replacement).
   * Absent means repo rulesets are not managed by chant.
   */
  rulesets?: RulesetConfig[];
  /**
   * Repository security features (GHAS, secret scanning, Dependabot).
   * Absent means security features are not managed by chant.
   */
  security?: RepoSecurityConfig;
  /**
   * Deployment environments and their protection rules.
   * Absent means environments are not managed by chant.
   */
  environments?: EnvironmentConfig[];
  /**
   * Repo-level Actions secrets (presence only — never values).
   * Absent means secrets are not managed by chant.
   */
  secrets?: SecretConfig[];
  /**
   * Repo-level Actions variables.
   * Absent means variables are not managed by chant.
   */
  variables?: VariableConfig[];
  /**
   * Dependabot config file (`.github/dependabot.yml`) management.
   * Absent means the file is not managed by chant.
   */
  dependabot?: DependabotConfig;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/**
 * Desired state for a single GitHub organization. Absent fields are not managed.
 *
 * Selective-by-omission applies at every level: if `teams` is absent, chant
 * will not touch teams. If a specific `TeamConfig.members` is absent, chant
 * will not touch that team's membership — even if the team itself is managed.
 */
export interface OrgConfig {
  /**
   * Org-level settings (description, email, default permissions, etc.).
   * Absent means org settings are not managed by chant.
   */
  settings?: OrgSettings;
  /**
   * Teams to manage, keyed by team slug.
   * Absent means teams are not managed by chant.
   */
  teams?: Record<string, TeamConfig>;
  /**
   * Org members to manage.
   * Absent means membership is not managed by chant.
   */
  members?: MemberConfig[];
  /**
   * Repositories to manage, keyed by repo name.
   * Absent means repositories are not managed by chant.
   */
  repos?: Record<string, RepoConfig>;
  /**
   * Organization-level rulesets.
   * Absent means org rulesets are not managed by chant.
   */
  rulesets?: RulesetConfig[];
  /**
   * Org-level Actions secrets (presence only — never values).
   * Absent means secrets are not managed by chant.
   */
  secrets?: SecretConfig[];
  /**
   * Org-level Actions variables.
   * Absent means variables are not managed by chant.
   */
  variables?: VariableConfig[];
  /**
   * Repositories that must exist in the org (provisioning/templating).
   * Absent means repo provisioning is not managed by chant.
   */
  repoBaselines?: RepoBaselineConfig[];
  /**
   * Known machine / service-account logins. The identity report flags any of
   * these that are seat-consuming org members and recommends migrating them to
   * GitHub Apps (Apps consume no seat). The API cannot reliably distinguish a
   * machine user from a person, so this list is operator-declared.
   */
  machineUsers?: string[];
  /**
   * Fine-grained PAT governance policy (scheduled sweep). Absent means token
   * grants are not governed by chant.
   */
  tokenPolicy?: TokenPolicyConfig;
  /**
   * Policy for auto-deciding pending fine-grained PAT requests. Absent means
   * PAT requests are not auto-decided by chant.
   */
  tokenApproval?: TokenApprovalPolicy;
}

/**
 * Top-level governance config. Contains one or more orgs to manage.
 *
 * Example:
 * ```ts
 * const config: GovernanceConfig = {
 *   orgs: {
 *     "my-org": {
 *       settings: { defaultRepositoryPermission: "read" },
 *       teams: {
 *         "backend": { members: [{ login: "alice" }] },
 *       },
 *       // repos omitted → repo state is not managed
 *     },
 *   },
 * };
 * ```
 */
export interface GovernanceConfig {
  /** Organizations to manage, keyed by org name (GitHub login). */
  orgs: Record<string, OrgConfig>;
}
