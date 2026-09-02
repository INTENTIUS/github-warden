# Cycles

A cycle is one reconcile domain. Each cycle knows how to read live state from
GitHub (`fetchLive`), derive the desired slice from the policy
(`buildDesired`), and apply one change entry back (`apply`). The runner wraps
every cycle with the same diff, guardrail, and dry-run/apply machinery.

`--cycles` accepts the names below (from `src/cli/registry.ts`); omitting the
flag runs all of them, in this order.

Shared behavior, so it isn't repeated thirteen times:

- **Selective-by-omission.** An absent field or collection is never read for
  mutation, diffed, or changed: a cycle only acts on the slice of the policy
  it owns. A repo, team, or field the policy leaves out is never touched.
- **Ownership-gated deletes.** The diff proposes deleting a live entry
  missing from the policy only when that entry's collection is marked owned,
  and by default nothing is owned: a run creates and updates but never
  deletes. An org's `owned` declaration in the policy (`true`, or a list of
  resource types; see [POLICY.md](POLICY.md)) marks resources owned; a
  programmatic `diffOptions.isOwned` predicate overrides the declaration when
  supplied.
- **Guardrails before apply.** `removalDeltaCap` refuses an apply whose
  deletes exceed 25% of the live managed entries in the collections the
  policy declares; with nothing live to measure against it falls back to
  its plan-relative denominator (deletes over the plan's updates plus
  deletes). `adminFloor` (at least 2 org admins must remain) always
  runs too; `requiredAdmins` and `requireSelf` run when configured
  programmatically. `resolveRenames` collapses a `previously`-marked
  delete+create pair into an update first, so a rename is not counted as a
  deletion. A tripped guardrail blocks the apply (exit 1) unless
  `--allow-guardrail-override` is set.
- **Permission-gated reads are tolerated.** A declared slice whose read comes
  back 403 is tolerated and skipped, never fatal: the read yields no live
  state, and the cycle's plan gains a NOTE line naming the slice
  (`read was permission-gated (403); planned entries may fail on apply`). A
  slice you declared anyway plans as a create, and its apply lands the 403 in
  that cycle's `failed[]`.
  With a narrow App grant the run still exits 0 and the notes list the slices
  the grant leaves uncovered. A 404 is a silent "nothing live". Any other
  read error still errors the cycle.
- **Request budget.** A run has a shared budget of 1000 API requests. On
  exhaustion the run stops cleanly and prints
  `DEFERRED cycles (budget exhausted): <cycles>` to stderr; run again (or
  narrow `--cycles`) to finish.
- **Live-fetch scope.** Cycles that read per-repo live state do so for repos
  passed in their scope. The current CLI wiring passes no scope, so those
  cycles skip the live fetch: every declared entry is planned as a create,
  and the applies are idempotent writes (PUT/PATCH against the live
  resource). Accurate drift detection for those cycles needs the programmatic
  API with `scope: { repos: orgConfig.repos }`.

## branch-protection

Reconciles classic branch protection rules declared under
`repos.<name>.branchProtection` (one rule per branch pattern).

- Read: `GET /repos/{owner}/{repo}/branches/{branch}/protection`, probed per
  declared pattern. A 404 on the probe means "no rule" and produces a create
  rather than an error.
- The apply path is `PUT …/protection` on create and update, and
  `DELETE …/protection` on delete. The PUT is a full replacement, so updates do a read-modify-write:
  the body is seeded from the live rule (from the diff's `before` snapshot,
  re-fetched if missing) and only declared fields are overlaid. Undeclared
  live settings, including `enforce_admins` (not exposed in the schema), are
  preserved.
- Change-set entries carry the key `{repo}/{pattern}`. This cycle ends up
  planning no deletes, because the probe only reads declared patterns and an
  undeclared live rule is never discovered as a delete candidate.
- Known limitation: the protection API resolves literal branch names only. A
  wildcard rule like `release/*` exists on GitHub but is never returned by
  the probe, so `dump` omits it. Rulesets are the modern fix.

## org-settings

Reconciles org-level settings (`orgs.<org>.settings`): public metadata such as
the description and website, member repo-creation privileges, the default
repository permission, plus the 2FA-requirement flag.

- Read: `GET /orgs/{org}`. Apply: `PATCH /orgs/{org}`, a partial update that
  sends only declared keys, so no read-modify-write is needed.
- There is a single settings entry per org, and nothing to delete: the one
  settings resource is only ever created or updated.
- GitHub treats `requireTwoFactorAuthentication` as read-only on most plans
  (the key is ignored rather than erroring), so warden surfaces it for drift
  reporting only.

## repo-settings

Reconciles per-repo settings under `repos.<name>`: description, website,
visibility, issues/projects/wiki toggles, merge methods, default branch,
`deleteBranchOnMerge`, plus topics.

- Read: `GET /repos/{owner}/{repo}` for the repos the policy declares.
  Apply: a partial `PATCH /repos/{owner}/{repo}` with only the declared
  fields, plus `PUT /repos/{owner}/{repo}/topics` (topics are replaced as a
  whole list).
- Entries are keyed by repo name, the `repos:` map key. Deleting
  repositories is out of scope for warden entirely: this cycle's apply path
  ignores delete entries outright, and since the live fetch only reads repos
  the policy declares, the diff has nothing undeclared to propose removing
  anyway.
- A repo is never created here; a PATCH against a nonexistent repo 404s and
  is recorded as a failed entry. Provisioning belongs to `repo-baseline`.

## membership

Reconciles org membership and roles (`orgs.<org>.members`): who is a member,
who is an admin.

- Read: `GET /orgs/{org}/members?role=admin|member` (paginated, 100 per
  page). Apply: `PUT`/`DELETE` `/orgs/{org}/memberships/{user}`; the cycle
  adds or re-roles declared members by default.
- Member entries are keyed by `login`. Removal of an undeclared live member
  requires marking `member` owned (`owned: true` or `owned: [member, ...]`
  on the org). Removals, once enabled, run the member-aware guardrails in
  full (`adminFloor`, `requiredAdmins`, `requireSelf`, `removalDeltaCap`);
  `requireSelf` means the managing identity must remain an org admin rather
  than a plain member.
- The schema does not model outside collaborators (a per-repo concept), so
  they are out of scope.

## teams

Reconciles the team tree, team membership/roles, and team-to-repo permissions
(`orgs.<org>.teams`, keyed by slug).

- Read: `GET /orgs/{org}/teams` and `GET /orgs/{org}/teams/{slug}`, plus
  `GET …/{slug}/members?role=…` and `GET …/{slug}/repos`. The team list is
  always fetched; member and repo sub-state only for teams in scope that
  manage them.
- Team writes go through `POST /orgs/{org}/teams` for creation and
  `PATCH`/`DELETE` `/orgs/{org}/teams/{slug}` afterwards. Team members
  go through `PUT`/`DELETE` `…/{slug}/memberships/{user}` and team repo
  access through `PUT`/`DELETE` `…/{slug}/repos/{owner}/{repo}`. The cycle
  emits three resource types in order (`team`, `team-member`, `team-repo`) so
  a new team exists before members and repos are attached.
- Teams are keyed by slug; on create the slug is sent as the name (GitHub
  re-slugifies), on update the name is not sent, so an existing slug is never
  disturbed. Deleting a team, team member, or team repo requires ownership.
- Rename: a `previously` slug makes the guardrail layer collapse
  `delete(old)` + `create(new)` into one update, so a rename doesn't count
  toward `removalDeltaCap`. When teams are not owned the delete half is
  never emitted anyway, so a rename appears purely as a create and the old
  team is left in place. The runner does not yet perform an atomic
  GitHub-side rename.

## rulesets

Reconciles org rulesets (`orgs.<org>.rulesets`) and repo rulesets
(`repos.<name>.rulesets`), the modern replacement for classic branch
protection.

- Read: `GET /orgs/{org}/rulesets` and `GET /orgs/{org}/rulesets/{id}`, plus
  the analogous `/repos/{owner}/{repo}/rulesets` endpoints. Each live ruleset
  costs a list page plus one detail GET so the diff can compare full
  `rules` / `conditions` / `bypassActors` (all in GitHub's native snake_case
  shape, forwarded verbatim).
- Apply: `POST` on create at either scope, with `PUT …/rulesets/{id}` for
  updates and `DELETE …/rulesets/{id}` for deletes.
- Rulesets are matched by name, while GitHub's numeric id (carried on the
  live snapshot) addresses updates and deletes. Removing an undeclared live
  ruleset requires ownership as usual.
- Selective-by-omission operates at whole-ruleset granularity: a managed
  ruleset's declared body is the source of truth for that ruleset, and
  undeclared rulesets are never touched.

## security-features

Reconciles the security toggles under `repos.<name>.security`: GHAS and secret
scanning (with push protection), plus Dependabot alerts and automated security
fixes.

- Read: `GET /repos/{o}/{r}` (the `security_and_analysis` object),
  `GET /repos/{o}/{r}/vulnerability-alerts` (204 enabled / 404 disabled), and
  `GET /repos/{o}/{r}/automated-security-fixes`. The apply path is
  `PATCH /repos/{o}/{r}` for the `security_and_analysis` toggles, plus
  `PUT`/`DELETE` on the `vulnerability-alerts` and `automated-security-fixes`
  endpoints.
- Each repo maps to one `repo-security` entry, which is only ever created or
  updated: the toggles are set, never removed, so this cycle has no delete
  path.
- Degradation is license-gated and graceful. Where GHAS (or secret scanning
  on a private repo) is unavailable, GitHub rejects the enabling write and
  the cycle records a failed entry instead of crashing, so a mixed org
  reconciles what it can and reports the rest.

## environments

Reconciles deployment environments under `repos.<name>.environments`: wait
timers, required reviewers, and deployment branch policies, along with
self-review prevention.

- Read: `GET /repos/{o}/{r}/environments`. Apply: `PUT`/`DELETE`
  `/repos/{o}/{r}/environments/{env}`. The PUT replaces the environment
  configuration, so updates do a read-modify-write like branch-protection:
  seed from live, overlay declared fields. Declaring only `waitTimer` does
  not wipe reviewers or the branch policy.
- Environments are keyed by name within the repo, and an environment is
  removed only when the org owns it.
- Reviewers are compared by numeric id (`{ type, id }`), so author the same
  ids the API returns.

## secrets-variables

Reconciles Actions secrets and variables at org level (`orgs.<org>.secrets` /
`.variables`) and repo level (`repos.<name>.secrets` / `.variables`).

- Read: `GET` `/orgs/{org}/actions/secrets|variables` and
  `/repos/{o}/{r}/actions/secrets|variables` (paginated). Apply:
  `POST …/actions/variables`, `PATCH …/actions/variables/{name}`, and
  `DELETE …/actions/secrets|variables/{name}`.
- Secrets and variables are keyed by `name` within each scope, and an
  undeclared live secret or variable is deleted only when ownership-gated.
- Secrets are presence-only: warden never reads or writes a secret value,
  and there are no secret updates. A declared-but-missing secret raises a
  clear apply error telling you to provision it out-of-band.
- Variables are reconciled fully (name + value); a variable declared without
  a `value` is presence-only.
- Environment-level secrets/variables (GitHub's third scope) are a documented
  follow-up.

## dependency-hygiene

Reconciles each managed repo's `.github/dependabot.yml`
(`repos.<name>.dependabot`): the file must exist and match the declared
`content` exactly.

- Read: `GET /repos/{o}/{r}/contents/.github/dependabot.yml` (the Contents
  API; the live blob sha rides along for the update commit). The apply is a
  `PUT` on the same Contents path, as a direct commit to the default branch.
- One entry per managed repo, and no delete path: the file is created or
  updated, never removed. If the default branch requires PRs, the commit is
  rejected and recorded as a failed entry; a PR-based apply variant is a
  documented follow-up.

## repo-baseline

Ensures every repo in `orgs.<org>.repoBaselines` exists, creating missing
ones, optionally from a template. The provisioning backstop for scheduled
runs.

- Read: `GET /orgs/{org}/repos` (paginated), an existence check. The apply
  is `POST /orgs/{org}/repos` for an empty repo, or
  `POST /repos/{tmplOwner}/{tmplRepo}/generate` from a template.
- Baselines are keyed by repo name. Existence-only: the cycle emits creates
  for missing declared repos, never updates or deletes a repo, and leaves
  settings of existing repos to the other cycles.

## token-governance

Scheduled sweep over the org's fine-grained PAT grants against `tokenPolicy`:
expired, over-max-lifetime, or idle grants lose their org access.

- Read: `GET /orgs/{org}/personal-access-tokens` (paginated); the apply is
  `POST /orgs/{org}/personal-access-tokens/{pat_id}`, which revokes the
  grant's org access. Violations are emitted as updates ("revoke org
  access") on one `token-grant` entry per grant, rather than deletes, so a
  routine sweep does not trip `removalDeltaCap`.
- Callable only by a GitHub App; a PAT cannot drive this cycle. The API
  cannot create or rotate a user's PAT, so revoking org access is the
  enforcement lever. The expiry check uses GitHub's own `expired` flag;
  lifetime/idle checks compare against the run's clock.

## token-approval

Auto-decides pending fine-grained PAT requests against `tokenApproval`: a
request whose every permission (flattened to `group:scope`) is in
`allowedPermissions` is approved; otherwise the policy `default` applies
(auto-deny, or leave pending for a human).

- Read: `GET /orgs/{org}/personal-access-token-requests` (paginated); the
  apply is `POST /orgs/{org}/personal-access-token-requests/{id}`, which
  approves or denies the request. Decisions are emitted as updates on one
  `token-request` entry per pending request, and requests left for manual
  review produce no entry.
- Only a GitHub App can reach these request endpoints. Admins can approve or
  deny but cannot narrow the repo scope the requester chose. The source notes
  this cycle is mock-tested; verify against a real App and test org before
  relying on it.
