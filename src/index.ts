// Config types
export type {
  GovernanceConfig,
  OrgConfig,
  OrgSettings,
  TeamConfig,
  TeamMember,
  TeamRepo,
  TeamRole,
  TeamRepoPermission,
  MemberConfig,
  OrgMemberRole,
  RepoConfig,
  BranchProtectionConfig,
} from "./config/types.js";

// Config loader
export { loadGovernanceConfig, GovernanceConfigError } from "./config/load.js";

// GitHub App auth client
export type { MintOptions, InstallationToken, AppClientOptions, AppClient } from "./auth/app-client.js";
export { mintInstallationToken, createAppClient, AppAuthError } from "./auth/app-client.js";

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
  LiveOrgState,
} from "./reconcile/diff.js";
export { diff, summarizeChangeSet, renderChangeSet } from "./reconcile/diff.js";

// Reconcile: guardrails
export type {
  GuardrailDiagnostic,
  GuardrailResult,
  RemovalDeltaCapOptions,
  AdminFloorOptions,
  RequiredAdminsOptions,
  RequireSelfOptions,
  GuardrailConfig,
} from "./reconcile/guardrails.js";
export {
  resolveRenames,
  removalDeltaCap,
  adminFloor,
  requiredAdmins,
  requireSelf,
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
} from "./reconcile/runner.js";
export { runReconcile, BudgetExhaustedError } from "./reconcile/runner.js";

// Cycles
export { branchProtectionCycle, fetchLiveForOrg } from "./cycles/branch-protection.js";
export { orgSettingsCycle, buildOrgPatchBody } from "./cycles/org-settings.js";
export type { OrgSettingsScope } from "./cycles/org-settings.js";
export { repoSettingsCycle, buildRepoPatchBody, fetchLiveRepoSettings } from "./cycles/repo-settings.js";
export type { RepoSettingsScope } from "./cycles/repo-settings.js";
export { membershipCycle, listOrgMembers } from "./cycles/membership.js";
export type { MembershipScope } from "./cycles/membership.js";
export { teamsCycle, mapTeamRepoPermission } from "./cycles/teams.js";
export type { TeamsScope } from "./cycles/teams.js";

// Reconcile: dump (export live state to desired-state config)
export type { DumpOrgOptions, DumpResult } from "./reconcile/dump.js";
export { dumpOrg, serializeToYaml } from "./reconcile/dump.js";

// Pipeline emitter: governance CI workflow generator
export type { GovernancePipelineOptions, CycleFilter } from "./emit/pipeline.js";
export { governancePipeline } from "./emit/pipeline.js";
