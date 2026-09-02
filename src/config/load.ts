import type {
  GovernanceConfig,
  OrgConfig,
  OrgSettings,
  TeamConfig,
  TeamMember,
  TeamRepo,
  MemberConfig,
  RepoConfig,
  BranchProtectionConfig,
  RulesetConfig,
  SecretConfig,
  VariableConfig,
  EnvironmentConfig,
  EnvironmentReviewer,
  DeploymentBranchPolicy,
  RepoSecurityConfig,
  DependabotConfig,
  RepoBaselineConfig,
  TokenPolicyConfig,
  TokenApprovalPolicy,
} from "./types.js";

/**
 * Thrown when `loadGovernanceConfig` receives a value that does not match the
 * expected shape of a `GovernanceConfig`.
 */
export class GovernanceConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`[governance-config] invalid config at "${field}": ${message}`);
    this.name = "GovernanceConfigError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Internal validators
// ---------------------------------------------------------------------------

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GovernanceConfigError(field, `expected an object, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new GovernanceConfigError(field, `expected a string, got ${typeof value}`);
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new GovernanceConfigError(field, `expected a boolean, got ${typeof value}`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GovernanceConfigError(field, `expected a finite number, got ${typeof value}`);
  }
  return value;
}

function assertArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new GovernanceConfigError(field, `expected an array, got ${typeof value}`);
  }
  return value;
}

function assertEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const s = assertString(value, field);
  if (!allowed.includes(s as T)) {
    throw new GovernanceConfigError(field, `expected one of [${allowed.join(", ")}], got "${s}"`);
  }
  return s as T;
}

// ---------------------------------------------------------------------------
// Field-level normalizers (each returns undefined when the field is absent)
// ---------------------------------------------------------------------------

function normalizeOrgSettings(raw: unknown, field: string): OrgSettings | undefined {
  if (raw === undefined) return undefined;
  const obj = assertObject(raw, field);
  const result: OrgSettings = {};

  if (obj.description !== undefined) result.description = assertString(obj.description, `${field}.description`);
  if (obj.email !== undefined) result.email = assertString(obj.email, `${field}.email`);
  if (obj.websiteUrl !== undefined) result.websiteUrl = assertString(obj.websiteUrl, `${field}.websiteUrl`);
  if (obj.membersCanCreatePublicRepositories !== undefined) result.membersCanCreatePublicRepositories = assertBoolean(obj.membersCanCreatePublicRepositories, `${field}.membersCanCreatePublicRepositories`);
  if (obj.membersCanCreatePrivateRepositories !== undefined) result.membersCanCreatePrivateRepositories = assertBoolean(obj.membersCanCreatePrivateRepositories, `${field}.membersCanCreatePrivateRepositories`);
  if (obj.membersCanCreateInternalRepositories !== undefined) result.membersCanCreateInternalRepositories = assertBoolean(obj.membersCanCreateInternalRepositories, `${field}.membersCanCreateInternalRepositories`);
  if (obj.defaultRepositoryPermission !== undefined) result.defaultRepositoryPermission = assertEnum(obj.defaultRepositoryPermission, `${field}.defaultRepositoryPermission`, ["none", "read", "write", "admin"] as const);
  if (obj.requireTwoFactorAuthentication !== undefined) result.requireTwoFactorAuthentication = assertBoolean(obj.requireTwoFactorAuthentication, `${field}.requireTwoFactorAuthentication`);

  return result;
}

function normalizeTeamMember(raw: unknown, field: string): TeamMember {
  const obj = assertObject(raw, field);
  if (obj.login === undefined) throw new GovernanceConfigError(`${field}.login`, "required field missing");
  const member: TeamMember = { login: assertString(obj.login, `${field}.login`) };
  if (obj.role !== undefined) member.role = assertEnum(obj.role, `${field}.role`, ["member", "maintainer"] as const);
  return member;
}

function normalizeTeamRepo(raw: unknown, field: string): TeamRepo {
  const obj = assertObject(raw, field);
  if (obj.name === undefined) throw new GovernanceConfigError(`${field}.name`, "required field missing");
  if (obj.permission === undefined) throw new GovernanceConfigError(`${field}.permission`, "required field missing");
  return {
    name: assertString(obj.name, `${field}.name`),
    permission: assertEnum(obj.permission, `${field}.permission`, ["pull", "triage", "push", "maintain", "admin"] as const),
  };
}

function normalizeTeamConfig(raw: unknown, field: string): TeamConfig {
  const obj = assertObject(raw, field);
  const team: TeamConfig = {};

  if (obj.description !== undefined) team.description = assertString(obj.description, `${field}.description`);
  if (obj.privacy !== undefined) team.privacy = assertEnum(obj.privacy, `${field}.privacy`, ["secret", "closed"] as const);
  if (obj.parentTeamSlug !== undefined) team.parentTeamSlug = assertString(obj.parentTeamSlug, `${field}.parentTeamSlug`);
  if (obj.previously !== undefined) team.previously = assertString(obj.previously, `${field}.previously`);

  if (obj.members !== undefined) {
    const arr = assertArray(obj.members, `${field}.members`);
    team.members = arr.map((m, i) => normalizeTeamMember(m, `${field}.members[${i}]`));
  }

  if (obj.repos !== undefined) {
    const arr = assertArray(obj.repos, `${field}.repos`);
    team.repos = arr.map((r, i) => normalizeTeamRepo(r, `${field}.repos[${i}]`));
  }

  return team;
}

function normalizeTeams(raw: unknown, field: string): Record<string, TeamConfig> | undefined {
  if (raw === undefined) return undefined;
  const obj = assertObject(raw, field);
  const result: Record<string, TeamConfig> = {};
  for (const [slug, teamRaw] of Object.entries(obj)) {
    result[slug] = normalizeTeamConfig(teamRaw, `${field}.${slug}`);
  }
  return result;
}

function normalizeMemberConfig(raw: unknown, field: string): MemberConfig {
  const obj = assertObject(raw, field);
  if (obj.login === undefined) throw new GovernanceConfigError(`${field}.login`, "required field missing");
  const member: MemberConfig = { login: assertString(obj.login, `${field}.login`) };
  if (obj.role !== undefined) member.role = assertEnum(obj.role, `${field}.role`, ["member", "admin"] as const);
  return member;
}

function normalizeMembers(raw: unknown, field: string): MemberConfig[] | undefined {
  if (raw === undefined) return undefined;
  const arr = assertArray(raw, field);
  return arr.map((m, i) => normalizeMemberConfig(m, `${field}[${i}]`));
}

function normalizeBranchProtection(raw: unknown, field: string): BranchProtectionConfig {
  const obj = assertObject(raw, field);
  if (obj.pattern === undefined) throw new GovernanceConfigError(`${field}.pattern`, "required field missing");
  const bp: BranchProtectionConfig = { pattern: assertString(obj.pattern, `${field}.pattern`) };

  if (obj.requirePullRequestReviews !== undefined) bp.requirePullRequestReviews = assertBoolean(obj.requirePullRequestReviews, `${field}.requirePullRequestReviews`);
  if (obj.requiredApprovingReviewCount !== undefined) bp.requiredApprovingReviewCount = assertNumber(obj.requiredApprovingReviewCount, `${field}.requiredApprovingReviewCount`);
  if (obj.dismissStaleReviews !== undefined) bp.dismissStaleReviews = assertBoolean(obj.dismissStaleReviews, `${field}.dismissStaleReviews`);
  if (obj.requireCodeOwnerReviews !== undefined) bp.requireCodeOwnerReviews = assertBoolean(obj.requireCodeOwnerReviews, `${field}.requireCodeOwnerReviews`);
  if (obj.requireStatusChecks !== undefined) bp.requireStatusChecks = assertBoolean(obj.requireStatusChecks, `${field}.requireStatusChecks`);
  if (obj.requiredStatusCheckContexts !== undefined) {
    const arr = assertArray(obj.requiredStatusCheckContexts, `${field}.requiredStatusCheckContexts`);
    bp.requiredStatusCheckContexts = arr.map((c, i) => assertString(c, `${field}.requiredStatusCheckContexts[${i}]`));
  }
  if (obj.requireBranchesToBeUpToDate !== undefined) bp.requireBranchesToBeUpToDate = assertBoolean(obj.requireBranchesToBeUpToDate, `${field}.requireBranchesToBeUpToDate`);
  if (obj.restrictPushes !== undefined) bp.restrictPushes = assertBoolean(obj.restrictPushes, `${field}.restrictPushes`);
  if (obj.allowForcePushes !== undefined) bp.allowForcePushes = assertBoolean(obj.allowForcePushes, `${field}.allowForcePushes`);
  if (obj.allowDeletions !== undefined) bp.allowDeletions = assertBoolean(obj.allowDeletions, `${field}.allowDeletions`);
  if (obj.requireLinearHistory !== undefined) bp.requireLinearHistory = assertBoolean(obj.requireLinearHistory, `${field}.requireLinearHistory`);

  return bp;
}

function normalizeRuleset(raw: unknown, field: string): RulesetConfig {
  const obj = assertObject(raw, field);
  if (obj.name === undefined) throw new GovernanceConfigError(`${field}.name`, "required field missing");
  const ruleset: RulesetConfig = { name: assertString(obj.name, `${field}.name`) };

  if (obj.target !== undefined) ruleset.target = assertEnum(obj.target, `${field}.target`, ["branch", "tag", "push"] as const);
  if (obj.enforcement !== undefined) ruleset.enforcement = assertEnum(obj.enforcement, `${field}.enforcement`, ["active", "evaluate", "disabled"] as const);

  // GitHub-native (snake_case) payload fragments — shape-checked, forwarded verbatim.
  if (obj.bypassActors !== undefined) {
    const arr = assertArray(obj.bypassActors, `${field}.bypassActors`);
    ruleset.bypassActors = arr.map((a, i) => assertObject(a, `${field}.bypassActors[${i}]`));
  }
  if (obj.conditions !== undefined) ruleset.conditions = assertObject(obj.conditions, `${field}.conditions`);
  if (obj.rules !== undefined) {
    const arr = assertArray(obj.rules, `${field}.rules`);
    ruleset.rules = arr.map((r, i) => assertObject(r, `${field}.rules[${i}]`));
  }

  return ruleset;
}

function normalizeRulesets(raw: unknown, field: string): RulesetConfig[] {
  const arr = assertArray(raw, field);
  return arr.map((r, i) => normalizeRuleset(r, `${field}[${i}]`));
}

function normalizeSecret(raw: unknown, field: string): SecretConfig {
  const obj = assertObject(raw, field);
  if (obj.name === undefined) throw new GovernanceConfigError(`${field}.name`, "required field missing");
  const secret: SecretConfig = { name: assertString(obj.name, `${field}.name`) };
  if (obj.rotationRef !== undefined) secret.rotationRef = assertString(obj.rotationRef, `${field}.rotationRef`);
  return secret;
}

function normalizeSecrets(raw: unknown, field: string): SecretConfig[] {
  const arr = assertArray(raw, field);
  return arr.map((s, i) => normalizeSecret(s, `${field}[${i}]`));
}

function normalizeVariable(raw: unknown, field: string): VariableConfig {
  const obj = assertObject(raw, field);
  if (obj.name === undefined) throw new GovernanceConfigError(`${field}.name`, "required field missing");
  const variable: VariableConfig = { name: assertString(obj.name, `${field}.name`) };
  if (obj.value !== undefined) variable.value = assertString(obj.value, `${field}.value`);
  if (obj.visibility !== undefined) variable.visibility = assertEnum(obj.visibility, `${field}.visibility`, ["all", "private", "selected"] as const);
  return variable;
}

function normalizeVariables(raw: unknown, field: string): VariableConfig[] {
  const arr = assertArray(raw, field);
  return arr.map((v, i) => normalizeVariable(v, `${field}[${i}]`));
}

function normalizeEnvironmentReviewer(raw: unknown, field: string): EnvironmentReviewer {
  const obj = assertObject(raw, field);
  if (obj.type === undefined) throw new GovernanceConfigError(`${field}.type`, "required field missing");
  if (obj.id === undefined) throw new GovernanceConfigError(`${field}.id`, "required field missing");
  return {
    type: assertEnum(obj.type, `${field}.type`, ["User", "Team"] as const),
    id: assertNumber(obj.id, `${field}.id`),
  };
}

function normalizeDeploymentBranchPolicy(raw: unknown, field: string): DeploymentBranchPolicy | null {
  if (raw === null) return null; // declared null disables the policy
  const obj = assertObject(raw, field);
  const policy: DeploymentBranchPolicy = {};
  if (obj.protectedBranches !== undefined) policy.protectedBranches = assertBoolean(obj.protectedBranches, `${field}.protectedBranches`);
  if (obj.customBranchPolicies !== undefined) policy.customBranchPolicies = assertBoolean(obj.customBranchPolicies, `${field}.customBranchPolicies`);
  return policy;
}

function normalizeEnvironment(raw: unknown, field: string): EnvironmentConfig {
  const obj = assertObject(raw, field);
  if (obj.name === undefined) throw new GovernanceConfigError(`${field}.name`, "required field missing");
  const env: EnvironmentConfig = { name: assertString(obj.name, `${field}.name`) };

  if (obj.waitTimer !== undefined) env.waitTimer = assertNumber(obj.waitTimer, `${field}.waitTimer`);
  if (obj.preventSelfReview !== undefined) env.preventSelfReview = assertBoolean(obj.preventSelfReview, `${field}.preventSelfReview`);
  if (obj.reviewers !== undefined) {
    const arr = assertArray(obj.reviewers, `${field}.reviewers`);
    env.reviewers = arr.map((r, i) => normalizeEnvironmentReviewer(r, `${field}.reviewers[${i}]`));
  }
  if (obj.deploymentBranchPolicy !== undefined) {
    env.deploymentBranchPolicy = normalizeDeploymentBranchPolicy(obj.deploymentBranchPolicy, `${field}.deploymentBranchPolicy`);
  }

  return env;
}

function normalizeEnvironments(raw: unknown, field: string): EnvironmentConfig[] {
  const arr = assertArray(raw, field);
  return arr.map((e, i) => normalizeEnvironment(e, `${field}[${i}]`));
}

function normalizeRepoSecurity(raw: unknown, field: string): RepoSecurityConfig {
  const obj = assertObject(raw, field);
  const security: RepoSecurityConfig = {};

  if (obj.advancedSecurity !== undefined) security.advancedSecurity = assertBoolean(obj.advancedSecurity, `${field}.advancedSecurity`);
  if (obj.secretScanning !== undefined) security.secretScanning = assertBoolean(obj.secretScanning, `${field}.secretScanning`);
  if (obj.secretScanningPushProtection !== undefined) security.secretScanningPushProtection = assertBoolean(obj.secretScanningPushProtection, `${field}.secretScanningPushProtection`);
  if (obj.vulnerabilityAlerts !== undefined) security.vulnerabilityAlerts = assertBoolean(obj.vulnerabilityAlerts, `${field}.vulnerabilityAlerts`);
  if (obj.dependabotSecurityUpdates !== undefined) security.dependabotSecurityUpdates = assertBoolean(obj.dependabotSecurityUpdates, `${field}.dependabotSecurityUpdates`);

  return security;
}

function normalizeDependabot(raw: unknown, field: string): DependabotConfig {
  const obj = assertObject(raw, field);
  if (obj.content === undefined) throw new GovernanceConfigError(`${field}.content`, "required field missing");
  return { content: assertString(obj.content, `${field}.content`) };
}

function normalizeRepoBaseline(raw: unknown, field: string): RepoBaselineConfig {
  const obj = assertObject(raw, field);
  if (obj.name === undefined) throw new GovernanceConfigError(`${field}.name`, "required field missing");
  const baseline: RepoBaselineConfig = { name: assertString(obj.name, `${field}.name`) };
  if (obj.template !== undefined) baseline.template = assertString(obj.template, `${field}.template`);
  if (obj.private !== undefined) baseline.private = assertBoolean(obj.private, `${field}.private`);
  return baseline;
}

function normalizeRepoBaselines(raw: unknown, field: string): RepoBaselineConfig[] {
  const arr = assertArray(raw, field);
  return arr.map((b, i) => normalizeRepoBaseline(b, `${field}[${i}]`));
}

function normalizeMachineUsers(raw: unknown, field: string): string[] {
  const arr = assertArray(raw, field);
  return arr.map((u, i) => assertString(u, `${field}[${i}]`));
}

function normalizeTokenPolicy(raw: unknown, field: string): TokenPolicyConfig {
  const obj = assertObject(raw, field);
  const policy: TokenPolicyConfig = {};

  if (obj.revokeExpired !== undefined) policy.revokeExpired = assertBoolean(obj.revokeExpired, `${field}.revokeExpired`);
  if (obj.maxLifetimeDays !== undefined) policy.maxLifetimeDays = assertNumber(obj.maxLifetimeDays, `${field}.maxLifetimeDays`);
  if (obj.maxIdleDays !== undefined) policy.maxIdleDays = assertNumber(obj.maxIdleDays, `${field}.maxIdleDays`);

  return policy;
}

function normalizeTokenApproval(raw: unknown, field: string): TokenApprovalPolicy {
  const obj = assertObject(raw, field);
  const policy: TokenApprovalPolicy = {};

  if (obj.allowedPermissions !== undefined) {
    const arr = assertArray(obj.allowedPermissions, `${field}.allowedPermissions`);
    policy.allowedPermissions = arr.map((p, i) => assertString(p, `${field}.allowedPermissions[${i}]`));
  }
  if (obj.default !== undefined) policy.default = assertEnum(obj.default, `${field}.default`, ["deny", "manual"] as const);

  return policy;
}

function normalizeRepoConfig(raw: unknown, field: string): RepoConfig {
  const obj = assertObject(raw, field);
  const repo: RepoConfig = {};

  if (obj.description !== undefined) repo.description = assertString(obj.description, `${field}.description`);
  if (obj.websiteUrl !== undefined) repo.websiteUrl = assertString(obj.websiteUrl, `${field}.websiteUrl`);
  if (obj.private !== undefined) repo.private = assertBoolean(obj.private, `${field}.private`);
  if (obj.hasIssues !== undefined) repo.hasIssues = assertBoolean(obj.hasIssues, `${field}.hasIssues`);
  if (obj.hasProjects !== undefined) repo.hasProjects = assertBoolean(obj.hasProjects, `${field}.hasProjects`);
  if (obj.hasWiki !== undefined) repo.hasWiki = assertBoolean(obj.hasWiki, `${field}.hasWiki`);
  if (obj.defaultBranch !== undefined) repo.defaultBranch = assertString(obj.defaultBranch, `${field}.defaultBranch`);
  if (obj.allowSquashMerge !== undefined) repo.allowSquashMerge = assertBoolean(obj.allowSquashMerge, `${field}.allowSquashMerge`);
  if (obj.allowMergeCommit !== undefined) repo.allowMergeCommit = assertBoolean(obj.allowMergeCommit, `${field}.allowMergeCommit`);
  if (obj.allowRebaseMerge !== undefined) repo.allowRebaseMerge = assertBoolean(obj.allowRebaseMerge, `${field}.allowRebaseMerge`);
  if (obj.deleteBranchOnMerge !== undefined) repo.deleteBranchOnMerge = assertBoolean(obj.deleteBranchOnMerge, `${field}.deleteBranchOnMerge`);

  if (obj.branchProtection !== undefined) {
    const arr = assertArray(obj.branchProtection, `${field}.branchProtection`);
    repo.branchProtection = arr.map((bp, i) => normalizeBranchProtection(bp, `${field}.branchProtection[${i}]`));
  }

  if (obj.topics !== undefined) {
    const arr = assertArray(obj.topics, `${field}.topics`);
    repo.topics = arr.map((t, i) => assertString(t, `${field}.topics[${i}]`));
  }

  if (obj.rulesets !== undefined) repo.rulesets = normalizeRulesets(obj.rulesets, `${field}.rulesets`);
  if (obj.security !== undefined) repo.security = normalizeRepoSecurity(obj.security, `${field}.security`);
  if (obj.environments !== undefined) repo.environments = normalizeEnvironments(obj.environments, `${field}.environments`);
  if (obj.secrets !== undefined) repo.secrets = normalizeSecrets(obj.secrets, `${field}.secrets`);
  if (obj.variables !== undefined) repo.variables = normalizeVariables(obj.variables, `${field}.variables`);
  if (obj.dependabot !== undefined) repo.dependabot = normalizeDependabot(obj.dependabot, `${field}.dependabot`);

  return repo;
}

function normalizeRepos(raw: unknown, field: string): Record<string, RepoConfig> | undefined {
  if (raw === undefined) return undefined;
  const obj = assertObject(raw, field);
  const result: Record<string, RepoConfig> = {};
  for (const [name, repoRaw] of Object.entries(obj)) {
    result[name] = normalizeRepoConfig(repoRaw, `${field}.${name}`);
  }
  return result;
}

function normalizeOwned(raw: unknown, field: string): boolean | string[] {
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) {
    return raw.map((t, i) => assertString(t, `${field}[${i}]`));
  }
  throw new GovernanceConfigError(field, `expected a boolean or an array of strings, got ${typeof raw}`);
}

function normalizeOrgConfig(raw: unknown, field: string): OrgConfig {
  const obj = assertObject(raw, field);
  const org: OrgConfig = {};

  if (obj.owned !== undefined) org.owned = normalizeOwned(obj.owned, `${field}.owned`);
  if (obj.settings !== undefined) org.settings = normalizeOrgSettings(obj.settings, `${field}.settings`);
  if (obj.teams !== undefined) org.teams = normalizeTeams(obj.teams, `${field}.teams`);
  if (obj.members !== undefined) org.members = normalizeMembers(obj.members, `${field}.members`);
  if (obj.repos !== undefined) org.repos = normalizeRepos(obj.repos, `${field}.repos`);
  if (obj.rulesets !== undefined) org.rulesets = normalizeRulesets(obj.rulesets, `${field}.rulesets`);
  if (obj.secrets !== undefined) org.secrets = normalizeSecrets(obj.secrets, `${field}.secrets`);
  if (obj.variables !== undefined) org.variables = normalizeVariables(obj.variables, `${field}.variables`);
  if (obj.repoBaselines !== undefined) org.repoBaselines = normalizeRepoBaselines(obj.repoBaselines, `${field}.repoBaselines`);
  if (obj.machineUsers !== undefined) org.machineUsers = normalizeMachineUsers(obj.machineUsers, `${field}.machineUsers`);
  if (obj.tokenPolicy !== undefined) org.tokenPolicy = normalizeTokenPolicy(obj.tokenPolicy, `${field}.tokenPolicy`);
  if (obj.tokenApproval !== undefined) org.tokenApproval = normalizeTokenApproval(obj.tokenApproval, `${field}.tokenApproval`);

  return org;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a governance config object.
 *
 * `input` is typically the result of parsing a YAML/JSON/TS config file. It
 * must be a plain object with an `orgs` key mapping org names to `OrgConfig`
 * objects.
 *
 * Throws `GovernanceConfigError` with a descriptive `field` path on invalid
 * shape. Returns a fully-typed `GovernanceConfig` on success.
 *
 * Selective-by-omission: fields absent from the input are absent from the
 * returned config, meaning they will not be reconciled against live GitHub
 * state.
 */
export function loadGovernanceConfig(input: unknown): GovernanceConfig {
  const root = assertObject(input, "<root>");

  if (root.orgs === undefined) {
    throw new GovernanceConfigError("<root>.orgs", "required field missing");
  }

  const orgsRaw = assertObject(root.orgs, "<root>.orgs");
  const orgs: Record<string, OrgConfig> = {};

  for (const [orgName, orgRaw] of Object.entries(orgsRaw)) {
    orgs[orgName] = normalizeOrgConfig(orgRaw, `orgs.${orgName}`);
  }

  return { orgs };
}
