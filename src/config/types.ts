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
