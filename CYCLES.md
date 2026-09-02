# Cycles

A cycle is one reconcile domain. Each cycle knows how to read live state from
GitHub (`fetchLive`), derive the desired slice from the policy
(`buildDesired`), and apply one change entry back (`apply`). The runner wraps
every cycle with the same diff, guardrail, and dry-run/apply machinery, and it
enforces a shared API request budget (1000 requests per run; work skipped when
the budget runs out is reported as `DEFERRED cycles`).

`--cycles` accepts the names below (from `src/cli/registry.ts`); omitting the
flag runs all of them, in this order.

Shared behavior, so it isn't repeated thirteen times:

- **Selective-by-omission.** A cycle only acts on the slice of the policy it
  owns; a repo, team, or field absent from the policy is never read or
  modified.
- **Ownership-gated deletes.** The diff proposes deleting a live resource
  missing from the policy only when it is marked owned. By default nothing
  is owned and runs create and update but never delete. An org's `owned`
  declaration in the policy (`true`, or a list of resource types — see
  [POLICY.md](POLICY.md)) marks resources owned; a programmatic
  `diffOptions.isOwned` predicate overrides the declaration when supplied.
- **Guardrails before apply.** `removalLiveCap` (deletes capped at 25% of the
  live entries in the collections the policy declares for the cycle; with
  nothing live it falls back to chant's plan-denominator `removalDeltaCap`)
  and `adminFloor` (at least 2 org admins must
  remain) always run; `requiredAdmins` and `requireSelf` run when configured
  programmatically. `resolveRenames` collapses a `previously`-marked
  delete+create pair into an update first, so a rename is not counted as a
  deletion. A tripped guardrail blocks the apply (exit 1) unless
  `--allow-guardrail-override` is set.
- **Permission-gated reads are tolerated.** A declared slice whose read comes
  back 403 is skipped as if nothing were live, and the cycle's plan gains a
  note naming the slice (`read was permission-gated (403); planned entries
  may fail on apply`). With a narrow App grant the run still exits 0 and the
  notes list the slices the grant leaves uncovered. A 404 is a silent
  "nothing live". Any other read error still errors the cycle.
- **Live-fetch scope.** Cycles that read per-repo live state do so for repos
  passed in their scope. The current CLI wiring passes no scope, so those
  cycles skip the live fetch: every declared entry is planned as a create,
  and the applies are idempotent writes (PUT/PATCH against the live
  resource). Accurate drift detection for those cycles needs the programmatic
  API with `scope: { repos: orgConfig.repos }`.

## branch-protection

Reconciles classic branch protection rules declared under
`repos.<name>.branchProtection` (one rule per branch pattern).

- Endpoints: `GET`/`PUT`/`DELETE`
  `/repos/{owner}/{repo}/branches/{branch}/protection`.
- The PUT is a full replacement, so updates do a read-modify-write: the body
  is seeded from the live rule (from the diff's `before` snapshot, re-fetched
  if missing) and only declared fields are overlaid. Undeclared live settings,
  including `enforce_admins` (not exposed in the schema), are preserved.
- A 404 on the probe means "no rule" and produces a create, not an error.
- Known limitation: the protection API resolves literal branch names only. A
  wildcard rule like `release/*` exists on GitHub but is never returned by
  the probe, so `dump` omits it and a reconcile with ownership-enabled
  deletes would propose removing it. Rulesets are the modern fix.

## org-settings

Reconciles org-level settings (`orgs.<org>.settings`): public metadata such as
the description and website, member repo-creation privileges, the default
repository permission, plus the 2FA-requirement flag.

- It reads `GET /orgs/{org}` and writes `PATCH /orgs/{org}`.
- The PATCH is partial, so only declared keys are sent; no read-modify-write
  needed.
- GitHub treats `requireTwoFactorAuthentication` as read-only on most plans
  (the key is ignored rather than erroring), so warden surfaces it for drift
  reporting only.
- There is a single settings resource per org, so this cycle creates or
  updates and has nothing to delete.

## repo-settings

Reconciles per-repo settings under `repos.<name>`: description, website,
visibility, issues/projects/wiki toggles, merge methods, default branch,
`deleteBranchOnMerge`, plus topics.

- The cycle talks to `GET`/`PATCH` `/repos/{owner}/{repo}` plus
  `PUT /repos/{owner}/{repo}/topics` (topics are replaced as a whole list).
- Only declared fields are sent; the PATCH is partial.
- A repo is never created here; a PATCH against a nonexistent repo 404s and is
  recorded as a failed entry. Provisioning belongs to `repo-baseline`.
- Deleting repositories is out of scope for warden entirely: this cycle's
  apply path ignores delete entries outright, and since the live fetch only
  reads repos the policy declares, the diff has nothing undeclared to propose
  removing anyway.

## membership

Reconciles org membership and roles (`orgs.<org>.members`): who is a member,
who is an admin.

- The member list comes from `GET /orgs/{org}/members?role=admin|member`
  (paginated, 100 per page); changes go through `PUT`/`DELETE`
  `/orgs/{org}/memberships/{user}`.
- The cycle adds or re-roles declared members by default; removal of an
  undeclared live member requires marking `member` owned (`owned: true` or
  `owned: [member, ...]` on the org).
- Removals, once enabled, run the member-aware guardrails in full
  (`adminFloor`, `requiredAdmins`, `requireSelf`, `removalLiveCap`);
  `requireSelf` means the managing identity must stay an org admin, not merely
  a member.
- The schema does not model outside collaborators (a per-repo concept), so
  they are out of scope.

## teams

Reconciles the team tree, team membership/roles, and team-to-repo permissions
(`orgs.<org>.teams`, keyed by slug).

- Endpoints: `GET`/`POST` `/orgs/{org}/teams`,
  `GET`/`PATCH`/`DELETE` `/orgs/{org}/teams/{slug}`,
  `GET` `…/{slug}/members?role=…`, `PUT`/`DELETE` `…/{slug}/memberships/{user}`,
  `GET` `…/{slug}/repos`, `PUT`/`DELETE` `…/{slug}/repos/{owner}/{repo}`.
- Emits three resource types in order (`team`, `team-member`, `team-repo`) so
  a new team exists before members and repos are attached.
- The team list is always fetched; member and repo sub-state only for teams
  in scope that manage them.
- Rename-without-loss: a `previously` slug makes the guardrail layer collapse
  `delete(old)` + `create(new)` into one update, so a rename doesn't count
  toward `removalLiveCap`. When teams are not owned the delete half is
  never emitted anyway, so a rename appears purely as a create and the old
  team is left in place. The runner does not yet perform an atomic
  GitHub-side rename.
- Teams are keyed by slug; on create the slug is sent as the name (GitHub
  re-slugifies), on update the name is not sent, so an existing slug is never
  disturbed. Deleting a team still requires ownership.

## rulesets

Reconciles org rulesets (`orgs.<org>.rulesets`) and repo rulesets
(`repos.<name>.rulesets`), the modern replacement for classic branch
protection.

- Endpoints: `GET`/`POST` `/orgs/{org}/rulesets`,
  `GET`/`PUT`/`DELETE` `/orgs/{org}/rulesets/{id}`, and the analogous
  `/repos/{owner}/{repo}/rulesets` endpoints. Rulesets are matched by name;
  GitHub's numeric id (carried on the live snapshot) addresses
  updates/deletes.
- Each live ruleset costs a list page plus one detail GET so the diff can
  compare full `rules` / `conditions` / `bypassActors` (all in GitHub's
  native snake_case shape, forwarded verbatim).
- Selective-by-omission operates at whole-ruleset granularity: a managed
  ruleset's declared body is the source of truth for that ruleset; undeclared
  rulesets are never touched, and removing one requires ownership as usual.

## security-features

Reconciles the security toggles under `repos.<name>.security`: GHAS and secret
scanning (with push protection), plus Dependabot alerts and automated security
fixes.

- Three endpoint groups are involved: `GET`/`PATCH` `/repos/{o}/{r}` (the
  `security_and_analysis` object), `GET`/`PUT`/`DELETE`
  `/repos/{o}/{r}/vulnerability-alerts` (204 enabled / 404 disabled), plus
  `GET`/`PUT`/`DELETE` `/repos/{o}/{r}/automated-security-fixes`.
- Degradation is license-gated and graceful: where GHAS (or secret scanning on
  a private repo) is unavailable, GitHub rejects the enabling write and the
  cycle records a failed entry instead of crashing, so a mixed org reconciles
  what it can and reports the rest.
- Each repo maps to one `repo-security` entry, which is only ever created or
  updated.

## environments

Reconciles deployment environments under `repos.<name>.environments`: wait
timers, required reviewers, and deployment branch policies, along with
self-review prevention.

- Endpoints: `GET /repos/{o}/{r}/environments`,
  `PUT`/`DELETE` `/repos/{o}/{r}/environments/{env}`.
- The PUT replaces the environment configuration, so updates do a
  read-modify-write like branch-protection: seed from live, overlay declared
  fields. Declaring only `waitTimer` does not wipe reviewers or the branch
  policy.
- Reviewers are compared by numeric id (`{ type, id }`), so author the same
  ids the API returns. An environment is removed only when the org owns it.

## secrets-variables

Reconciles Actions secrets and variables at org level (`orgs.<org>.secrets` /
`.variables`) and repo level (`repos.<name>.secrets` / `.variables`).

- Endpoints: `GET` `/orgs/{org}/actions/secrets|variables` and
  `/repos/{o}/{r}/actions/secrets|variables` (paginated),
  `POST …/actions/variables`, `PATCH …/actions/variables/{name}`,
  `DELETE …/actions/secrets|variables/{name}`.
- Secrets are presence-only: warden never reads or writes a secret value. A
  declared-but-missing secret raises a clear apply error telling you to
  provision it out-of-band; an undeclared live secret is deleted only when
  ownership-gated. There are no secret updates.
- Variables are reconciled fully (name + value); a variable declared without
  a `value` is presence-only, and deletion follows the ownership gate.
- Environment-level secrets/variables (GitHub's third scope) are a documented
  follow-up.

## dependency-hygiene

Reconciles each managed repo's `.github/dependabot.yml`
(`repos.<name>.dependabot`): the file must exist and match the declared
`content` exactly.

- Endpoints: `GET`/`PUT` `/repos/{o}/{r}/contents/.github/dependabot.yml`
  (the Contents API; the live blob sha rides along for the update commit).
- Applies as a direct commit to the default branch. If the default branch
  requires PRs, the commit is rejected and recorded as a failed entry; a
  PR-based apply variant is a documented follow-up.

## repo-baseline

Ensures every repo in `orgs.<org>.repoBaselines` exists, creating missing
ones, optionally from a template. The provisioning backstop for scheduled
runs.

- Endpoints: `GET /orgs/{org}/repos` (paginated),
  `POST /orgs/{org}/repos` (empty repo),
  `POST /repos/{tmplOwner}/{tmplRepo}/generate` (from a template).
- Existence-only: emits creates for missing declared repos and never updates
  or deletes a repo. Settings of existing repos belong to the other cycles.

## token-governance

Scheduled sweep over the org's fine-grained PAT grants against `tokenPolicy`:
expired, over-max-lifetime, or idle grants lose their org access.

- Endpoints: `GET /orgs/{org}/personal-access-tokens` (paginated),
  `POST /orgs/{org}/personal-access-tokens/{pat_id}` (revoke org access).
- Callable only by a GitHub App; a PAT cannot drive this cycle. The API
  cannot create or rotate a user's PAT, so revoking org access is the
  enforcement lever.
- Violations are emitted as updates on `token-grant` entries ("revoke org
  access"), not deletes, so a routine sweep does not trip `removalLiveCap`.
  The expiry check uses GitHub's own `expired` flag; lifetime/idle checks
  compare against the run's clock.

## token-approval

Auto-decides pending fine-grained PAT requests against `tokenApproval`: a
request whose every permission (flattened to `group:scope`) is in
`allowedPermissions` is approved; otherwise the policy `default` applies
(auto-deny, or leave pending for a human).

- Endpoints: `GET /orgs/{org}/personal-access-token-requests` (paginated),
  `POST /orgs/{org}/personal-access-token-requests/{id}` (approve/deny).
- Only a GitHub App can reach these request endpoints. Admins can approve or
  deny but cannot narrow the repo scope the requester chose.
- Decisions are emitted as updates on `token-request` entries; requests left
  for manual review produce no entry. The source notes this cycle is
  mock-tested; verify against a real App and test org before relying on it.
