// The policy's types, for `satisfies GovernanceConfig` in a `.ts` policy.
export type * from "./config/types.js";

// Config loader. `loadGovernanceConfig` validates a parsed policy value;
// `loadGovernancePolicy` reads a YAML, JSON or `.ts` policy file and folds,
// runs or checks a `.ts` one (`satisfies GovernanceConfig` types it).
export { loadGovernanceConfig, GovernanceConfigError } from "./config/load.js";
export { loadGovernancePolicy } from "./config/policy.js";
export type { ConfigMode, LoadedPolicy } from "./config/policy.js";

// Where a drifted field was written, when the policy was folded.
export { originAt, formatOrigin, driftOrigins, annotatePlan } from "./reconcile/origin.js";
export type { FieldOrigin, SourceLocation, PolicyProvenance, DriftOrigin } from "./reconcile/origin.js";

// GitHub App auth client
export type { MintOptions, InstallationToken, AppClientOptions, AppClient } from "./auth/app-client.js";
export { mintInstallationToken, createAppClient, AppAuthError } from "./auth/app-client.js";

// Reconcile: provider-agnostic core primitive (the seam intended for #20).
export type {
  DiffCollectionParams,
  GuardrailCheck,
} from "./reconcile/core.js";
export {
  deepEqual,
  diffFields,
  diffCollection,
  runGuardrailChecks,
} from "./reconcile/core.js";

// Reconcile: plan/diff primitive
export type {
  ChangeKind,
  ChangeSetEntry,
  ChangeSet,
  FieldChange,
  DiffOptions,
  LiveOrgSettings,
  LiveTeamMember,
  LiveTeamRepo,
  LiveTeamConfig,
  LiveMemberConfig,
  LiveBranchProtectionConfig,
  LiveRepoConfig,
  LiveRuleset,
  LiveRepoSecurity,
  LiveEnvironment,
  LiveSecret,
  LiveVariable,
  LiveDependabot,
  LiveTokenGrant,
  LiveTokenRequest,
  LiveOrgState,
} from "./reconcile/diff.js";
export { diff, normalizeRulesetConditions, summarizeChangeSet, renderChangeSet, evaluateTokenViolation, evaluateTokenRequest } from "./reconcile/diff.js";

// Reconcile: guardrails
export type {
  GuardrailDiagnostic,
  GuardrailResult,
  RemovalDeltaCapOptions,
  AdminFloorOptions,
  RequiredAdminsOptions,
  RequireSelfOptions,
  GuardrailConfig,
  PostApplyMembers,
} from "./reconcile/guardrails.js";
export {
  resolveRenames,
  removalDeltaCap,
  adminFloor,
  requiredAdmins,
  requireSelf,
  computePostApplyMembers,
  runGuardrails,
} from "./reconcile/guardrails.js";

// Reconcile: runner (orchestrator)
export type {
  Cycle,
  RateBudget,
  CycleResult,
  DeferredWork,
  ReconcileResult,
  RunReconcileOptions,
  WardenCycleResult,
  WardenReconcileResult,
} from "./reconcile/runner.js";
export { runReconcile, BudgetExhaustedError } from "./reconcile/runner.js";

// Cycles
export type { CycleNote } from "./cycles/notes.js";
export { notePermissionGated, drainNotes, isForbidden, isNotFound } from "./cycles/notes.js";
export { branchProtectionCycle, fetchLiveForOrg } from "./cycles/branch-protection.js";
export { orgSettingsCycle, buildOrgPatchBody } from "./cycles/org-settings.js";
export type { OrgSettingsScope } from "./cycles/org-settings.js";
export { repoSettingsCycle, buildRepoPatchBody, fetchLiveRepoSettings } from "./cycles/repo-settings.js";
export type { RepoSettingsScope } from "./cycles/repo-settings.js";
export { membershipCycle, listOrgMembers } from "./cycles/membership.js";
export type { MembershipScope } from "./cycles/membership.js";
export { teamsCycle, mapTeamRepoPermission } from "./cycles/teams.js";
export type { TeamsScope } from "./cycles/teams.js";
export { rulesetsCycle, fetchRulesets, buildRulesetBody, mapRulesetToLive } from "./cycles/rulesets.js";
export type { RulesetsScope } from "./cycles/rulesets.js";
export { securityFeaturesCycle, fetchRepoSecurity, buildSecurityAnalysisBody } from "./cycles/security-features.js";
export type { SecurityFeaturesScope } from "./cycles/security-features.js";
export { environmentsCycle, mapEnvironmentToLive, buildEnvironmentBody } from "./cycles/environments.js";
export type { EnvironmentsScope } from "./cycles/environments.js";
export { secretsVariablesCycle } from "./cycles/secrets-variables.js";
export type { SecretsVariablesScope } from "./cycles/secrets-variables.js";
export { dependencyHygieneCycle, fetchDependabot } from "./cycles/dependency-hygiene.js";
export type { DependencyHygieneScope } from "./cycles/dependency-hygiene.js";
export { repoBaselineCycle, listOrgRepoNames } from "./cycles/repo-baseline.js";
export type { RepoBaselineScope } from "./cycles/repo-baseline.js";
export { tokenGovernanceCycle, mapTokenGrant } from "./cycles/token-governance.js";
export type { TokenGovernanceScope } from "./cycles/token-governance.js";
export { tokenApprovalCycle, mapTokenRequest, flattenRequestPermissions } from "./cycles/token-approval.js";
export type { TokenApprovalScope } from "./cycles/token-approval.js";

// Reconcile: dump (export live state to desired-state config)
export type { DumpOrgOptions, DumpResult } from "./reconcile/dump.js";
export { dumpOrg, serializeToYaml } from "./reconcile/dump.js";

// Pipeline emitter: governance CI workflow generator
export type { GovernancePipelineOptions, CycleFilter } from "./emit/pipeline.js";
export { governancePipeline } from "./emit/pipeline.js";

// Compliance reporting (aggregator)
export type {
  ComplianceReport,
  CycleComplianceEntry,
  AuditCompliance,
  ComplianceError,
} from "./report/compliance.js";
export { buildComplianceReport, renderComplianceReport, complianceArtifact } from "./report/compliance.js";
export type { IdentityReport, InstalledApp, RawInstallation } from "./report/identity.js";
export { buildIdentityReport, renderIdentityReport } from "./report/identity.js";
