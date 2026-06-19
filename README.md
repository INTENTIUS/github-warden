# github-warden

[![ci](https://github.com/intentius/github-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/intentius/github-warden/actions/workflows/ci.yml)
[![e2e (nightly)](https://github.com/intentius/github-warden/actions/workflows/e2e.yml/badge.svg)](https://github.com/intentius/github-warden/actions/workflows/e2e.yml)
[![npm](https://img.shields.io/npm/v/@intentius/github-warden)](https://www.npmjs.com/package/@intentius/github-warden)

**Keep your GitHub org and repos in a declared state — reconcile, guardrails, drift correction.**

Think of it as Terraform for GitHub administration. You write desired state for
your org and repos in **one YAML file**; warden diffs it against live GitHub,
runs **safety guardrails**, and either prints the plan (`dry-run`, the default)
or applies it. It is **selective-by-omission** — anything you don't declare is
never read, diffed, or touched — and deletes are **ownership-gated**, so it
won't remove a resource unless you mark it owned. Run it locally, on a schedule,
or as a GitHub Action.

## What you need to run it

Before warden does anything useful you provide two things:

1. **Auth** — either a pre-minted installation **token** (simplest; good for
   repo-level reconcile and `audit`) **or** a **GitHub App** installed on your
   org (App ID + installation ID + private key). An App is **required** for
   org-level cycles (org settings, members, teams) and the token cycles — see
   [Auth](#auth).
2. **A config file** — a YAML/JSON file declaring the desired state you want
   managed (see [Config format](#config-format)). Declare only what you want
   warden to own.

Nothing is mutated until you ask: the default mode is `dry-run`, which only
reads and prints a plan. Start there.

## Install

```bash
# Dry-run against your org — reads only, prints a plan, changes nothing.
npx @intentius/github-warden reconcile --config .github/governance.yml --token-env GH_TOKEN --mode dry-run
```

The installed CLI binary is `github-warden`. Or run it as a
[GitHub Action](#use-as-a-github-action) — no install needed.

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

- `--config <path>` — governance config (YAML or JSON). Required.
- `--mode dry-run|apply` — default `dry-run`.
- `--cycles <name[,name...]>` — subset of cycles to run (default: all).
- `--allow-guardrail-override` — apply even when guardrails trip.

### `audit`

```
github-warden audit --config <path> [auth] [--fail-on none|merge-worthy|any]
```

Audits every repo declared in the config. Exits `4` when findings exceed `--fail-on`.

### `report`

```
github-warden report --config <path> [auth] [--cycles a,b] [--audit] [--identity] [--out compliance.json] [--fail-on none|attention]
```

Runs the selected cycles in **dry-run**, optionally an `--audit` pass and an
`--identity` (service-account hygiene) pass, prints a unified compliance
snapshot, optionally writes a committable JSON artifact (`--out`), and exits `4`
on `--fail-on attention` when anything needs attention. Detect-only — never mutates.

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

Every field is optional — declare only what you want managed.

```yaml
orgs:
  my-org:
    # Org-level settings
    settings:
      defaultRepositoryPermission: read
      membersCanCreatePublicRepositories: false

    # Org members and roles
    members:
      - { login: alice, role: admin }
      - { login: bob }                 # defaults to "member"

    # Teams (tree + membership + repo access)
    teams:
      backend:
        privacy: closed
        members:
          - { login: alice, role: maintainer }
        repos:
          - { name: api, permission: push }

    # Ensure these repos exist (create from a template if missing)
    repoBaselines:
      - { name: new-service, template: my-org/service-template, private: true }

    # Org-level rulesets / secrets / variables
    rulesets:
      - name: protect-default
        target: branch
        enforcement: active
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }
        rules: [{ type: pull_request }]
    secrets:
      - { name: ORG_DEPLOY_TOKEN }     # presence only; value provisioned out-of-band
    variables:
      - { name: ENVIRONMENT, value: production }

    # Fine-grained PAT governance (GitHub App required)
    tokenPolicy: { maxLifetimeDays: 90, maxIdleDays: 60, revokeExpired: true }
    tokenApproval: { allowedPermissions: ["repository:contents"], default: deny }

    # Flag seat-consuming machine users (surfaced by `report --identity`)
    machineUsers: [ci-bot, deploy-bot]

    repos:
      my-repo:
        description: My service
        hasWiki: false
        topics: [api, go]
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
            reviewers: [{ type: Team, id: 42 }]
        dependabot:
          content: |
            version: 2
            updates:
              - package-ecosystem: "npm"
                directory: "/"
                schedule: { interval: "weekly" }
```

## Guardrails

Before any apply, warden runs safety checks and refuses dangerous changes
(override with `--allow-guardrail-override`):

- **removalDeltaCap** — refuses if deletes exceed 25% of pre-existing managed entries (typo protection).
- **adminFloor** — refuses if fewer than 2 org admins would remain.
- **requiredAdmins / requireSelf** — keep named admins (and the managing identity) from being removed.
- **rename-without-loss** — a `previously` alias collapses a delete+create into an update, so a rename doesn't count as a deletion.

## Auth

Two mutually-exclusive modes (token takes precedence):

1. **Pre-minted token** — `--token-env GH_TOKEN` (e.g. from `actions/create-github-app-token`).
2. **GitHub App** — `--app-id-env` + `--installation-id-env`, with the private key in `GOVERNANCE_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY`).

A **GitHub App** is required for org-level token policy/approval and several
org administration APIs.

## Use as a GitHub Action

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

Inputs:

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

## CI workflow generation

`governancePipeline` (from the package root export) generates a
`.github/workflows/governance.yml` that runs reconcile (dry-run on PRs, apply on
main) on a schedule, pinned to a warden Action SHA.

## Releasing

`just release [patch|minor|major]` bumps `package.json`, commits `vX.Y.Z`, tags,
and pushes — which triggers `.github/workflows/publish.yml` (test gate → `npm
publish --provenance`).

The package is published as **`@intentius/github-warden`** (scoped, under the
`intentius` npm org) via **GitHub OIDC trusted publishing** — no token, the same
way the chant lexicons publish. `just release [patch|minor|major]` bumps, tags
`vX.Y.Z`, and pushes; `publish.yml` then publishes with `id-token: write` +
`--provenance`.

## End-to-end tests

Unit tests (`npm test`) are fully mocked. A separate **gated, self-provisioning**
e2e suite exercises every cycle against a **real GitHub org** via a real App
installation — the only thing that validates the live API contract (especially
the App-only token cycles). It's excluded from `npm test` and from PR CI.

```bash
WARDEN_E2E_APP_ID=… WARDEN_E2E_INSTALLATION_ID=… \
WARDEN_E2E_PRIVATE_KEY="$(cat key.pem)" WARDEN_E2E_ORG=my-test-org \
npm run test:e2e
```

- **Hermetic:** it **creates** a throwaway repo (`warden-e2e-<run>`) plus one
  Actions variable and one sealed-box-encrypted secret, and **deletes** the repo
  on teardown — nothing pre-existing is required. The suite **self-skips** when
  the `WARDEN_E2E_*` vars are unset.
- **Phase 1 (always):** per cycle, runs `fetchLive` + `diff` against the
  provisioned repo/org and asserts every HTTP call was a `GET` (fetchLive never
  mutates) and the pipeline composes — catches API drift.
- **Phase 2 (opt-in, `WARDEN_E2E_APPLY=1`):** one apply through a cycle (set a
  repo topic), verified by re-fetch; cleaned up by the repo teardown.

The App installation needs **repository administration** (create/delete repos)
and **Actions secrets + variables** read+write, plus the read scopes the cycles
touch. CI runs it nightly + on demand via `.github/workflows/e2e.yml` using
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
