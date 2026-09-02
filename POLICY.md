# Policy

Wardens are policy driven. The governance file is the policy: one YAML or JSON
file that declares the desired state of your GitHub organization(s), and
everything else (auth, the CLI, the cycles, the Action, the schedule) serves it.
It is the one file you must author.

- Loaded from the path given to `--config` on every subcommand
  (`reconcile`, `audit`, `report`). YAML or JSON, decided by file extension.
- Schema (authoritative): `src/config/types.ts`. Validation: `src/config/load.ts`
  (throws a `GovernanceConfigError` with the exact field path on bad shape).
- Selective-by-omission at every level: an absent field means "not managed".
  warden will not read, diff, or modify that aspect of live GitHub state. If
  `teams` is absent, teams are untouched; if one team's `members` is absent,
  that team's membership is untouched even though the team itself is managed.
- Deletes are ownership-gated. The diff only proposes deleting a live resource
  missing from the policy when that resource is marked owned. By default an
  org owns nothing, so a run never deletes anything it merely fails to find in
  the policy. Declaring `owned: true` on an org makes warden own every
  resource collection it reconciles there; `owned: [team, repo, ...]` limits
  ownership to the listed change-set resource types. A programmatic
  `diffOptions.isOwned` predicate, when supplied, overrides the declaration.
  Owned deletes still run the guardrails (`removalLiveCap` etc.) before any
  apply.

One authoring note: the CLI ships a small built-in YAML reader that handles
block-style mappings and sequences, string/bool/number scalars, and comments.
No flow style
(`{ }` / `[ ]`), no multi-line scalars (`|` / `>`), no anchors. For anything
richer, such as the multi-line `dependabot.content`, use JSON.

## A complete policy

Copy this, delete what you don't want managed, and edit it. Every field in the
schema is shown, and the loader validates and forwards every slice. Comments
name the cycle that consumes each slice.

```yaml
orgs:
  my-org:                                  # keyed by org login; one entry per org

    # ── Ownership ── consumed by the diff of every cycle ────────────────────
    # Gates deletes. Absent/false (default): nothing is owned, no deletes are
    # ever planned. true: every reconciled collection is owned; live resources
    # missing from this policy are planned for deletion. A list limits
    # ownership to those change-set resource types (e.g. team, repo, member,
    # branch-protection, org-variable). Guardrails still apply.
    owned: false

    # ── Org settings ── cycle: org-settings ─────────────────────────────────
    # PATCH /orgs/{org} is a partial update: only declared keys are sent.
    settings:
      description: Engineering org         # public org profile description
      email: eng@example.com               # public org email
      websiteUrl: https://example.com      # org website (GitHub's `blog` field)
      membersCanCreatePublicRepositories: false
      membersCanCreatePrivateRepositories: true
      membersCanCreateInternalRepositories: false   # Enterprise only
      defaultRepositoryPermission: read    # none | read | write | admin
      requireTwoFactorAuthentication: true # surfaced for drift; read-only on most plans

    # ── Org membership & roles ── cycle: membership ─────────────────────────
    # Adds / re-roles declared members. Removal of undeclared members is
    # ownership-gated (never happens from the CLI); when removals are enabled,
    # the member-aware guardrails (adminFloor etc.) gate the apply.
    members:
      - login: alice
        role: admin                        # member | admin; default member
      - login: bob

    # ── Teams ── cycle: teams ───────────────────────────────────────────────
    # Keyed by team slug. Emits team, team-member, and team-repo entries.
    teams:
      backend:
        description: Backend services team
        privacy: closed                    # secret (default) | closed
        parentTeamSlug: engineering        # nest under another team
        previously: platform-be            # rename hint: collapses
                                           # delete(platform-be)+create(backend)
                                           # into one update; never sent to GitHub
        members:                           # absent -> membership not managed
          - login: alice
            role: maintainer               # member (default) | maintainer
        repos:                             # absent -> repo access not managed
          - name: api
            permission: push               # pull | triage | push | maintain | admin

    # ── Repositories ── keyed by repo name (no org prefix) ──────────────────
    repos:
      api:
        # ── Repo settings ── cycle: repo-settings ───────────────────────────
        description: Public API service
        websiteUrl: https://api.example.com
        private: true
        hasIssues: true
        hasProjects: false
        hasWiki: false
        defaultBranch: main
        allowSquashMerge: true
        allowMergeCommit: false
        allowRebaseMerge: true
        deleteBranchOnMerge: true
        topics:                            # replaced as a whole list (PUT)
          - service
          - api

        # ── Classic branch protection ── cycle: branch-protection ───────────
        # One entry per branch pattern. The live-state probe only resolves
        # literal branch names; wildcard patterns exist on GitHub but are not
        # discovered (see the cycles doc).
        branchProtection:
          - pattern: main
            requirePullRequestReviews: true
            requiredApprovingReviewCount: 1
            dismissStaleReviews: true
            requireCodeOwnerReviews: false
            requireStatusChecks: true
            requiredStatusCheckContexts:
              - ci
            requireBranchesToBeUpToDate: true
            restrictPushes: false
            allowForcePushes: false
            allowDeletions: false
            requireLinearHistory: true

        # ── Repo rulesets ── cycle: rulesets ────────────────────────────────
        # The modern branch-protection replacement. bypassActors / conditions /
        # rules use GitHub's native snake_case API shape, forwarded verbatim.
        rulesets:
          - name: protect-main
            target: branch                 # branch | tag | push
            enforcement: active            # active | evaluate | disabled
            conditions:
              ref_name:
                include:
                  - "~DEFAULT_BRANCH"
                                           # an empty list (exclude: []) is flow
                                           # style — author it in JSON
            rules:
              - type: pull_request

        # ── Security features ── cycle: security-features ───────────────────
        # GHAS-gated features that your plan lacks surface as reported failed
        # entries, not a crashed run.
        security:
          advancedSecurity: false          # GHAS license required
          secretScanning: true
          secretScanningPushProtection: true
          vulnerabilityAlerts: true
          dependabotSecurityUpdates: true

        # ── Deployment environments ── cycle: environments ──────────────────
        environments:
          - name: production
            waitTimer: 10                  # minutes, 0-43200
            preventSelfReview: true
            reviewers:                     # users/teams by numeric GitHub id
              - type: Team                 # User | Team
                id: 42
            deploymentBranchPolicy:        # object configures; null disables;
              protectedBranches: true      # absent -> not managed
              customBranchPolicies: false

        # ── Repo Actions secrets/variables ── cycle: secrets-variables ──────
        secrets:                           # PRESENCE only; values never touched
          - name: DEPLOY_KEY
            rotationRef: OPS-123           # informational; never sent or diffed
        variables:                         # values are not secret: fully reconciled
          - name: SERVICE_TIER
            value: gold

        # ── Dependabot config file ── cycle: dependency-hygiene ─────────────
        # Ensures .github/dependabot.yml exists and matches `content` exactly.
        # content is multi-line and the built-in YAML reader has no multi-line
        # scalars (and does not process \n escapes) — author this slice in JSON.
        dependabot:
          content: "..."                   # exact file text; use JSON here

    # ── Org rulesets ── cycle: rulesets ─────────────────────────────────────
    rulesets:
      - name: org-default-protection
        target: branch
        enforcement: active
        conditions:
          ref_name:
            include:
              - "~DEFAULT_BRANCH"
        rules:
          - type: pull_request

    # ── Org Actions secrets/variables ── cycle: secrets-variables ───────────
    secrets:
      - name: ORG_DEPLOY_TOKEN             # presence only; provision out-of-band
    variables:
      - name: ENVIRONMENT
        value: production
        visibility: all                    # all (default) | private | selected
                                           # (org-level create only)

    # ── Repo provisioning ── cycle: repo-baseline ───────────────────────────
    # Ensures declared repos EXIST (creates missing ones, optionally from a
    # template). Never updates or deletes a repo.
    repoBaselines:
      - name: new-service
        template: my-org/service-template  # "owner/repo"; omit for an empty repo
        private: true                      # default true

    # ── Fine-grained PAT sweep ── cycle: token-governance ───────────────────
    # GitHub App auth required. Revokes a grant's ORG ACCESS on violation;
    # PATs themselves cannot be rotated or created via the API.
    tokenPolicy:
      revokeExpired: true                  # default true
      maxLifetimeDays: 90                  # 1-366; older grants revoked
      maxIdleDays: 60                      # staler grants revoked

    # ── Pending PAT requests ── cycle: token-approval ───────────────────────
    # GitHub App auth required. Approves a request only when EVERY requested
    # permission (flattened to group:scope) is allowed; otherwise `default`.
    tokenApproval:
      allowedPermissions:
        - repository:contents
        - repository:metadata
      default: manual                      # deny | manual (default manual)

    # ── Machine users ── consumed by `report --identity` ────────────────────
    # Operator-declared service-account logins; the identity report flags any
    # that consume an org seat and suggests migrating them to GitHub Apps.
    machineUsers:
      - ci-bot
      - deploy-bot
```

The smallest useful policy is one org with one managed slice, for example just
`settings.defaultRepositoryPermission`; everything else then stays unmanaged.

## Field reference

In the tables below, **Required / default** describes what the loader or cycle
enforces, and **Cycle** names the reconcile cycle (from `--cycles`) that
consumes the field.

### `orgs` (top level)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `orgs` | map of org login → org config | **required** | all | Organizations to manage. Each cycle runs once per org. |
| `orgs.<org>.owned` | bool or list of resource type strings | absent → nothing owned, no deletes planned | all (diff layer) | `true` = every reconciled collection in this org is owned and live resources missing from the policy are planned for deletion; a list (e.g. `[team, repo]`) owns only those change-set resource types. A programmatic `diffOptions.isOwned` overrides it. Guardrails still gate the apply. |

### `orgs.<org>.settings` (org settings)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `description` | string | not managed | org-settings | Public description on the org profile. |
| `email` | string | not managed | org-settings | Public org email. |
| `websiteUrl` | string | not managed | org-settings | Org website (GitHub's `blog` field). |
| `membersCanCreatePublicRepositories` | bool | not managed | org-settings | Whether members can create public repos. |
| `membersCanCreatePrivateRepositories` | bool | not managed | org-settings | Whether members can create private repos. |
| `membersCanCreateInternalRepositories` | bool | not managed | org-settings | Internal repos (Enterprise only). |
| `defaultRepositoryPermission` | `none` \| `read` \| `write` \| `admin` | not managed | org-settings | Base repo permission for all members. |
| `requireTwoFactorAuthentication` | bool | not managed | org-settings | Surfaced for drift reporting; GitHub treats the key as read-only on most plans. |

### `orgs.<org>.members[]` (org membership)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `login` | string | **required** | membership | GitHub login. |
| `role` | `member` \| `admin` | `member` | membership | Org role. |

### `orgs.<org>.teams{}` (teams, keyed by slug)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `description` | string | not managed | teams | Team description. |
| `privacy` | `secret` \| `closed` | not managed (GitHub default `secret`) | teams | Team visibility. |
| `parentTeamSlug` | string | not managed | teams | Parent team for nesting. |
| `previously` | string | not managed | teams | Former slug; a rename hint for the guardrail layer only, never written to GitHub. |
| `members[]` | list | absent → membership not managed | teams | `{ login (required), role: member (default) \| maintainer }`. |
| `repos[]` | list | absent → repo access not managed | teams | `{ name (required), permission (required): pull \| triage \| push \| maintain \| admin }`. |

### `orgs.<org>.repos{}` (repository settings, keyed by repo name)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `description` | string | not managed | repo-settings | Repo description. |
| `websiteUrl` | string | not managed | repo-settings | Repo website (GitHub's `homepage`). |
| `private` | bool | not managed | repo-settings | Repo visibility. |
| `hasIssues` / `hasProjects` / `hasWiki` | bool | not managed | repo-settings | Feature toggles. |
| `defaultBranch` | string | not managed | repo-settings | Default branch name. |
| `allowSquashMerge` / `allowMergeCommit` / `allowRebaseMerge` | bool | not managed | repo-settings | Allowed merge methods. |
| `deleteBranchOnMerge` | bool | not managed | repo-settings | Auto-delete head branches after merge. |
| `topics` | list of string | not managed | repo-settings | Replaced as a whole list (full-replacement PUT), not merged. |
| `branchProtection[]` | list | not managed | branch-protection | See next table. |
| `rulesets[]` | list | not managed | rulesets | Repo rulesets; see the rulesets table. |
| `security` | object | not managed | security-features | See the security table. |
| `environments[]` | list | not managed | environments | See the environments table. |
| `secrets[]` / `variables[]` | list | not managed | secrets-variables | Repo-level Actions secrets (presence only) / variables. |
| `dependabot` | object | not managed | dependency-hygiene | `{ content (required) }` — exact desired text of `.github/dependabot.yml`. |

### `repos.<name>.branchProtection[]` (classic branch protection)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `pattern` | string | **required** | branch-protection | Branch name. Live probing resolves literal names only; wildcard rules are not discovered. |
| `requirePullRequestReviews` | bool | not managed | branch-protection | Require PR reviews before merge. |
| `requiredApprovingReviewCount` | int | not managed (falls back to live, then 1) | branch-protection | Approvals required. |
| `dismissStaleReviews` | bool | not managed | branch-protection | Dismiss stale reviews on new commits. |
| `requireCodeOwnerReviews` | bool | not managed | branch-protection | Require code-owner review. |
| `requireStatusChecks` | bool | not managed | branch-protection | Require status checks. |
| `requiredStatusCheckContexts` | list of string | not managed | branch-protection | Required check contexts. |
| `requireBranchesToBeUpToDate` | bool | not managed | branch-protection | The `strict` flag. |
| `restrictPushes` | bool | not managed | branch-protection | Restrict who can push (empty user/team lists). |
| `allowForcePushes` | bool | not managed | branch-protection | Allow force pushes. |
| `allowDeletions` | bool | not managed | branch-protection | Allow branch deletion. |
| `requireLinearHistory` | bool | not managed | branch-protection | Forbid merge commits. |

The GitHub PUT for this endpoint is a full replacement, so the apply path does
a read-modify-write: it echoes every undeclared live field back (including
`enforce_admins`, which the schema does not expose) and overlays only what you
declared.

### `rulesets[]` at org (`orgs.<org>.rulesets`) and repo (`repos.<name>.rulesets`) level

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `name` | string | **required** | rulesets | Identity key within its scope (org or repo). |
| `target` | `branch` \| `tag` \| `push` | GitHub defaults `branch` on create | rulesets | What the ruleset targets. |
| `enforcement` | `active` \| `evaluate` \| `disabled` | not managed | rulesets | Enforcement level. |
| `bypassActors` | list of object | not managed | rulesets | GitHub-native shape: `{ actor_id, actor_type, bypass_mode }`. Forwarded verbatim. |
| `conditions` | object | not managed | rulesets | GitHub-native shape, e.g. `{ ref_name: { include, exclude } }`. |
| `rules` | list of object | not managed | rulesets | GitHub-native shape: `[{ type, parameters? }]`. |

A managed ruleset is authored as a unit: its declared `rules` / `conditions` /
`bypassActors` are the source of truth for that ruleset. Undeclared rulesets
are never touched.

### `repos.<name>.security` (security features)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `advancedSecurity` | bool | not managed | security-features | GHAS (`security_and_analysis.advanced_security`). Needs a GHAS license. |
| `secretScanning` | bool | not managed | security-features | Secret scanning. GHAS-gated on private repos. |
| `secretScanningPushProtection` | bool | not managed | security-features | Push protection for secret scanning. |
| `vulnerabilityAlerts` | bool | not managed | security-features | Dependabot alerts (`vulnerability-alerts` endpoint). |
| `dependabotSecurityUpdates` | bool | not managed | security-features | Automated security fixes (`automated-security-fixes` endpoint). |

### `repos.<name>.environments[]` (deployment environments)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `name` | string | **required** | environments | Identity key within the repo. |
| `waitTimer` | int (0–43200) | not managed | environments | Minutes before a deployment can proceed. |
| `preventSelfReview` | bool | not managed | environments | Actor cannot approve their own deployment. |
| `reviewers[]` | list | not managed | environments | `{ type: User \| Team, id: <numeric GitHub id> }`. Compared by id, so use the ids the API returns. |
| `deploymentBranchPolicy` | object or `null` | not managed | environments | `{ protectedBranches, customBranchPolicies }` (at most one true); explicit `null` disables the policy. |

### `secrets[]` (Actions secrets, org and repo level)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `name` | string | **required** | secrets-variables | Identity key within its scope. |
| `rotationRef` | string | not managed | secrets-variables | Informational rotation pointer (ticket / KMS ref). Never sent to GitHub, never diffed. |

warden manages secret **presence only**. It never reads or writes secret
values; a declared-but-missing secret surfaces as an error telling you to
provision it out-of-band, and an undeclared live secret is removed only when
ownership-gated.

### `variables[]` (Actions variables, org and repo level)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `name` | string | **required** | secrets-variables | Identity key within its scope. |
| `value` | string | absent → presence-only | secrets-variables | Reconciled fully (create/update) when declared. |
| `visibility` | `all` \| `private` \| `selected` | `all` | secrets-variables | Org-level create only; ignored for repo variables. |

### `repoBaselines[]` (repo provisioning)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `name` | string | **required** | repo-baseline | Repo that must exist (no org prefix). |
| `template` | string (`owner/repo`) | absent → empty repo | repo-baseline | Create from this template when missing. |
| `private` | bool | `true` | repo-baseline | Visibility of a newly created repo. |

Existence-only: this cycle creates missing repos and never updates or deletes
one. Per-repo settings belong under `repos`.

### `tokenPolicy` (fine-grained PAT governance)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `revokeExpired` | bool | `true` | token-governance | Revoke org access of an expired grant still listed. |
| `maxLifetimeDays` | int (1–366) | not enforced when absent | token-governance | Grants older than this lose org access. |
| `maxIdleDays` | int | not enforced when absent | token-governance | Grants unused for longer than this lose org access. |

Violations are modeled as updates ("revoke org access"), not deletes, so a
routine sweep does not trip the removal guardrail; the expiry check uses
GitHub's own `expired` flag. GitHub App auth is required here. The API cannot
create or rotate a user's PAT; revoking its org access is the only
enforcement lever.

### `tokenApproval` (pending PAT requests)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `allowedPermissions` | list of string | absent → nothing auto-approved | token-approval | Permission names as `group:scope` (e.g. `repository:contents`). A request is approved only when every requested permission is listed. |
| `default` | `deny` \| `manual` | `manual` | token-approval | What happens to a request that is not auto-approved. |

Like the token sweep, this cycle works only with GitHub App auth. Admins can
only approve or deny; the requested repo scope cannot be changed.

### `machineUsers[]` (service-account inventory)

| Field | Type | Required / default | Consumer | Meaning |
|---|---|---|---|---|
| `machineUsers` | list of string | not managed | `report --identity` | Operator-declared machine logins. Seat-consuming ones are flagged with a recommendation to migrate to GitHub Apps (Apps consume no seat). Not a reconcile cycle. |

## What the policy does not declare

- **Guardrail thresholds.** `removalLiveCap` (default: deletes capped at 25%
  of the live entries in the declared collections), `adminFloor` (default: at least 2 org
  admins must remain), `requiredAdmins`, and `requireSelf` are configured
  programmatically (`runReconcile({ guardrails })`), not in the policy file.
  The CLI runs with the defaults; `--allow-guardrail-override` applies anyway
  when one trips.
- **Secret values.** Only secret presence is declared; values are provisioned
  out-of-band.
- **Auth.** App/installation IDs, tokens, and private keys come from
  environment variables named on the command line, never from the policy. See
  [SETUP.md](SETUP.md).
