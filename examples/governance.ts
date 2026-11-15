// The same policy as governance.yml, as data in TypeScript. The type gives
// completion and a compile error on a misspelt key; the preset is the part
// YAML cannot express without anchors. By default warden folds this file to
// its value without running it (--config-mode fold); it is typed JSON.
import type { GovernanceConfig } from "@intentius/github-warden";

// One review policy, several settings. When a field it sets drifts, the plan
// names the argument it came from and the line that argument is on.
const reviewPreset = (review: { approvals: number; checks: string[] }) => ({
  deleteBranchOnMerge: true,
  branchProtection: [
    {
      pattern: "main",
      requirePullRequestReviews: true,
      requiredApprovingReviewCount: review.approvals,
      requireStatusChecks: true,
      requiredStatusCheckContexts: review.checks,
    },
  ],
});

export default {
  orgs: {
    "my-org": {
      settings: {
        defaultRepositoryPermission: "read",
        membersCanCreatePublicRepositories: false,
      },
      repos: {
        "my-repo": {
          ...reviewPreset({ approvals: 1, checks: ["ci"] }),
          hasWiki: false,
          topics: ["service", "go"],
          security: {
            secretScanning: true,
            secretScanningPushProtection: true,
            vulnerabilityAlerts: true,
          },
        },
      },
    },
  },
} satisfies GovernanceConfig;
