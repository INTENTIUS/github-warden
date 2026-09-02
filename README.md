# github-warden

<p>
  <a href="https://github.com/intentius/github-warden/actions/workflows/ci.yml"><img src="https://github.com/intentius/github-warden/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/intentius/github-warden/actions/workflows/e2e.yml"><img src="https://github.com/intentius/github-warden/actions/workflows/e2e.yml/badge.svg" alt="e2e"></a>
  <a href="https://www.npmjs.com/package/@intentius/github-warden"><img src="https://img.shields.io/npm/v/@intentius/github-warden" alt="npm"></a>
</p>

**Keep your GitHub org and repos in a declared state, with guardrails and drift correction.**

Full documentation lives at
[intentius.io/github-warden](https://intentius.io/github-warden/), with deep
dives on these pages.

- [Policy](POLICY.md)
- [CLI](CLI.md)
- [Cycles](CYCLES.md)
- [CI pipelines](CI.md)
- [Setup](SETUP.md)
- [GitHub App setup](docs/github-app-setup.md)

You declare the desired state of your org and repos in **one YAML file**
(selective-by-omission: an absent field is never read, diffed, or touched);
warden diffs it against live GitHub, runs **safety guardrails**, and either
prints the plan (`dry-run`, the default) or applies it. Deletes are planned
only in orgs you mark `owned`. Run it locally, on a schedule, or as a GitHub
Action.

## Set up with an agent

From a checkout, Claude Code picks up the skill in
`.claude/skills/github-warden` automatically. Other agents can install it with
`npx skills add INTENTIUS/github-warden`, or by copying the skill directory
into `~/.claude/skills/`. Then paste this prompt, filling in the placeholders:

```text
Use the github-warden skill in this repo to help me set up governance for my
GitHub org <ORG>: author a governance policy file covering the settings I care
about (ask me which), explain whether I need a GitHub App or a token for those
cycles, then run a dry-run reconcile and walk me through the plan it prints.
Do not apply anything.
```

The skill holds the agent to dry-run until you've reviewed the plan; deletes
stay off entirely until you mark an org `owned` in the policy.

## What you need

- A clone of this repo (`git clone https://github.com/INTENTIUS/github-warden`).
  The agent skill, the annotated policy examples, and the pipeline templates
  live in it, and setup ends with a governance pipeline running in your org,
  so you'll have the repo around anyway. The CLI is published to npm as
  [`@intentius/github-warden`](https://www.npmjs.com/package/@intentius/github-warden)
  for those pipelines.
- Auth. Org-level and token cycles need a **GitHub App** installed on your org
  (App ID plus installation ID plus private key); repo-level reconcile and
  `audit` can run with a pre-minted installation **token** instead. See
  [Auth](#auth) and the [App setup checklist](docs/github-app-setup.md).
- Node 22+.

About ten minutes gets you to a first dry-run plan. The quickest probe needs
no clone at all:

```bash
# Dry-run: reads only, prints a plan, changes nothing.
npx @intentius/github-warden reconcile --config .github/governance.yml --token-env GH_TOKEN --mode dry-run
```

## Subcommands

| Command | What it does |
|---|---|
| `reconcile` | Run governance cycles: diff desired vs live, guardrail-check, dry-run or apply. |
| `audit` | Audit managed repos for security/correctness posture (chant's audit engine). |
| `report` | Aggregate cycle drift (+ optional audit + identity) into a compliance snapshot. |

### `reconcile`

```
github-warden reconcile --config <path> [auth] [--mode dry-run|apply] [--cycles a,b,c] [--allow-guardrail-override]
```

| Flag | Meaning |
|---|---|
| `--config <path>` | Governance config (YAML or JSON). Required. |
| `--mode dry-run\|apply` | Default `dry-run`. |
| `--cycles <name[,name...]>` | Subset of cycles to run (default: all). |
| `--allow-guardrail-override` | Apply even when guardrails trip. |

### `audit`

```
github-warden audit --config <path> [auth] [--fail-on none|merge-worthy|any]
```

Audits every repo declared in the config. Exits `4` when findings exceed `--fail-on`.

### `report`

```
github-warden report --config <path> [auth] [--cycles a,b] [--audit] [--identity] [--out compliance.json] [--fail-on none|attention]
```

Runs the selected cycles in **dry-run** and prints a unified compliance
snapshot. Optional passes add an `--audit` sweep and an `--identity`
(service-account hygiene) check, while `--out` writes a committable JSON
artifact. With `--fail-on attention` the command exits `4` when anything needs
attention; nothing is ever mutated.

### Exit codes

`0` success · `1` guardrail block (apply) · `2` arg/config error · `3` runtime error · `4` audit/report threshold exceeded.

## Cycles

Each cycle reconciles one governance domain. Pass `--cycles` to run a subset, or
omit it to run all.

| Cycle | Reconciles |
|---|---|
| `branch-protection` | Classic branch protection rules (`PUT …/branches/{b}/protection`). |
| `org-settings` | Org settings — default repo permission, member repo-creation, public metadata. |
| `repo-settings` | Repo settings — visibility, features, merge settings, default branch, topics. |
| `membership` | Org members & roles (admins / members). Add/re-role; ownership-gated removal. |
| `teams` | Teams, team membership/roles, and team→repo permissions; rename-without-loss. |
| `rulesets` | Repo + org **rulesets** (the modern branch-protection replacement). |
| `security-features` | GHAS, secret scanning, push protection, Dependabot alerts + security updates. |
| `environments` | Deployment environments — required reviewers, wait timers, branch policies. |
| `secrets-variables` | Actions secrets (**presence only — never values**) and variables. |
| `dependency-hygiene` | `.github/dependabot.yml` presence + exact-content consistency. |
| `repo-baseline` | Ensure declared repos **exist** (create from a template if missing). |
| `token-governance` | Fine-grained PAT sweep — revoke org access for expired / over-lifetime / idle grants. |
| `token-approval` | Auto approve/deny pending fine-grained PAT requests against policy. |

> **Note:** the GitHub Action exposes `reconcile` and `audit`. `report` is CLI-only.
> The token cycles (`token-governance`, `token-approval`) and several org-level
> APIs require a **GitHub App** installation (they are not callable with a plain PAT).

## Config format

Every field is optional; declare only what you want managed. A ready-to-edit
starter lives in [`examples/governance.yml`](examples/governance.yml).

The CLI's built-in YAML reader is block-style only — no flow style
(`{ }` / `[ ]`), no multi-line scalars (`|` / `>`), no anchors. Use JSON for
anything richer, such as the multi-line `dependabot.content`.

```yaml
orgs:
  my-org:
    # Org-level settings
    settings:
      defaultRepositoryPermission: read
      membersCanCreatePublicRepositories: false

    # Org members and roles
    members:
      - login: alice
        role: admin
      - login: bob                     # role defaults to "member"

    # Teams (tree + membership + repo access)
    teams:
      backend:
        privacy: closed
        members:
          - login: alice
            role: maintainer
        repos:
          - name: api
            permission: push

    # Ensure these repos exist (create from a template if missing)
    repoBaselines:
      - name: new-service
        template: my-org/service-template
        private: true

    # Org-level rulesets / secrets / variables
    rulesets:
      - name: protect-default
        target: branch
        enforcement: active
        conditions:
          ref_name:
            include:
              - "~DEFAULT_BRANCH"
        rules:
          - type: pull_request
    secrets:
      - name: ORG_DEPLOY_TOKEN         # presence only; value provisioned out-of-band
    variables:
      - name: ENVIRONMENT
        value: production

    # Fine-grained PAT governance (GitHub App required)
    tokenPolicy:
      maxLifetimeDays: 90
      maxIdleDays: 60
      revokeExpired: true
    tokenApproval:
      allowedPermissions:
        - repository:contents
      default: deny

    # Flag seat-consuming machine users (surfaced by `report --identity`)
    machineUsers:
      - ci-bot
      - deploy-bot

    repos:
      my-repo:
        description: My service
        hasWiki: false
        topics:
          - api
          - go
        branchProtection:
          - pattern: main
            requirePullRequestReviews: true
            requiredApprovingReviewCount: 1
            requireStatusChecks: true
        security:
          secretScanning: true
          secretScanningPushProtection: true
          vulnerabilityAlerts: true
        environments:
          - name: production
            waitTimer: 10
            reviewers:
              - type: Team
                id: 42
        # dependabot.content is a multi-line string — author that slice (or the
        # whole config) in JSON; the built-in YAML reader has no `|` scalars.
```

## Guardrails

Before any apply, warden runs safety checks and refuses dangerous changes
(override with `--allow-guardrail-override`):

| Guardrail | What it refuses or protects |
|---|---|
| `removalLiveCap` | Refuses an apply whose deletes exceed 25% of the live managed entries in the collections the policy declares (typo protection). With nothing live to measure against it falls back to chant's plan-relative `removalDeltaCap`. |
| `adminFloor` | Refuses if fewer than 2 org admins would remain. |
| `requiredAdmins` / `requireSelf` | Keep named admins (and the managing identity) from being removed. |
| rename-without-loss | A `previously` alias collapses a delete+create into an update, so a rename doesn't count as a deletion. |

## Auth

Warden supports two mutually exclusive auth modes, and the token takes
precedence when both are given.

1. A **pre-minted token** via `--token-env GH_TOKEN` (e.g. from `actions/create-github-app-token`).
2. A **GitHub App** via `--app-id-env` plus `--installation-id-env`, with the private key in `GOVERNANCE_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY`).

A **GitHub App** is required for org-level token policy/approval and several
org administration APIs. The [App setup checklist](docs/github-app-setup.md)
walks through creating it, the per-cycle permissions, and installation.

## Use as a GitHub Action

Warden also ships as a native GitHub Action, so a governance workflow needs no
npm install step. The snippets below cover the common jobs; every input maps
onto a CLI flag.

```yaml
# Dry-run reconcile on every PR.
- uses: intentius/github-warden@v1
  with:
    command: reconcile
    config: .github/governance.yml
    mode: dry-run
    app-id: ${{ vars.WARDEN_APP_ID }}
    installation-id: ${{ vars.WARDEN_INSTALLATION_ID }}
    private-key: ${{ secrets.WARDEN_PRIVATE_KEY }}

# Apply on push to main.
- uses: intentius/github-warden@v1
  with:
    command: reconcile
    config: .github/governance.yml
    mode: apply
    app-id: ${{ vars.WARDEN_APP_ID }}
    installation-id: ${{ vars.WARDEN_INSTALLATION_ID }}
    private-key: ${{ secrets.WARDEN_PRIVATE_KEY }}

# Audit all managed repos — fail if merge-worthy findings exist.
- uses: intentius/github-warden@v1
  with:
    command: audit
    config: .github/governance.yml
    fail-on: merge-worthy
    app-id: ${{ vars.WARDEN_APP_ID }}
    installation-id: ${{ vars.WARDEN_INSTALLATION_ID }}
    private-key: ${{ secrets.WARDEN_PRIVATE_KEY }}
```

The action accepts these inputs.

| Input | Required | Default | Description |
|---|---|---|---|
| `command` | no | `reconcile` | `reconcile` or `audit` |
| `config` | yes | — | Path to governance config (YAML/JSON) |
| `mode` | no | `dry-run` | `dry-run` or `apply` (reconcile only) |
| `cycles` | no | all | Comma-separated cycle names (reconcile only) |
| `app-id` | yes | — | GitHub App ID |
| `installation-id` | yes | — | GitHub App installation ID |
| `private-key` | yes | — | GitHub App private key PEM — pass as a secret |
| `fail-on` | no | `none` | `none`, `merge-worthy`, or `any` (audit only) |
| `allow-guardrail-override` | no | `false` | Apply even when guardrails trip (reconcile only) |

### CI workflow generation

The `governancePipeline` export (from the package root) generates a
`.github/workflows/governance.yml` that dry-runs on PRs touching the config
and applies on a schedule and on manual dispatch, pinned to a warden Action
SHA; [the CI guide](CI.md) covers it in detail.

## Releasing

`just release [patch|minor|major]` bumps `package.json`, tags `vX.Y.Z`, and
pushes. The pushed tag triggers `.github/workflows/publish.yml`, which gates on
the test suite and then runs `npm publish --provenance` with `id-token: write`.

The package is published as **`@intentius/github-warden`** (scoped, under the
`intentius` npm org) via **GitHub OIDC trusted publishing**, with no npm token
involved, the same way the chant lexicons publish.

## End-to-end tests

Unit tests (`npm test`) are fully mocked. Above them sit two gated e2e layers
(both under `e2e/`, both self-skipping — see [e2e/README.md](e2e/README.md)
for the cycle-by-cycle coverage table):

The hermetic compose smoke drives every cycle's full loop against a stateful
mock GitHub (dependency-free node, run via docker compose or directly). Each
cycle applies its policy slice and then re-plans to convergence, with
out-of-band drift corrected and deletes exercised under `owned`. The suite
also trips the `removalLiveCap` block and walks the permission-gated 403 NOTE
path, and auth runs the real App JWT and installation-token flow against the
mock.

```bash
just e2e-up          # or: node e2e/mock-github/server.mjs &
GITHUB_WARDEN_E2E_URL=http://localhost:8188 npm run test:e2e
just e2e-down
```

The real-App e2e is the non-hermetic layer: a gated, self-provisioning suite
that exercises every cycle against a **real GitHub org** via a real App
installation; nothing else validates the live API contract (especially the
App-only token cycles). Neither `npm test` nor PR CI includes it.

```bash
WARDEN_E2E_APP_ID=… WARDEN_E2E_INSTALLATION_ID=… \
WARDEN_E2E_PRIVATE_KEY="$(cat key.pem)" WARDEN_E2E_ORG=my-test-org \
npm run test:e2e
```

The suite provisions everything it needs: a throwaway repo
(`warden-e2e-<run>`) plus one Actions variable and one sealed-box-encrypted
secret, with the repo deleted on teardown, so nothing pre-existing is
required. When the `WARDEN_E2E_*` vars are unset, the whole suite self-skips.

Phase 1 always runs. Per cycle, it runs `fetchLive` + `diff` against the
provisioned repo/org and asserts that every HTTP call was a `GET` (fetchLive
never mutates) and that the diff composes a change set, which catches API
drift.
Phase 2 is opt-in via `WARDEN_E2E_APPLY=1` and performs one apply through a
cycle (setting a repo topic), verified by re-fetch and cleaned up by the repo
teardown.

The App installation needs **repository administration** (create/delete repos)
and **Actions secrets + variables** read+write, plus the read scopes the cycles
touch. CI runs it nightly and on demand via `.github/workflows/e2e.yml` using
`WARDEN_E2E_*` repo secrets (never on PRs).

Once the App is created, installed on the test org, and its `.pem` downloaded
(the web-only steps), wiring the secrets and triggering a run is automated:

```bash
just e2e-setup <test-org> <app-slug> ./warden-e2e.pem   # discovers app/installation id, sets the 4 secrets
just e2e-run                                             # dispatch Phase 1 (add `true` for Phase 2)
```

## Architecture

The provider-agnostic reconcile core (change-set model, generic collection diff,
guardrail framework) lives in [`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant);
github-warden builds the GitHub-specific cycles, live-state types, and
member-aware guardrails on top of it.
