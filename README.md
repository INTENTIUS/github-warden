# github-warden

Keep your GitHub org and repos in declared state — reconcile, guardrails, drift correction.

## What it does

github-warden is a CLI tool for GitHub org and repository governance. You declare
desired state (branch protection rules, team membership, org settings) in a YAML
config file. The tool computes the diff between desired and live state, checks
guardrails, and optionally applies changes.

## Usage

```
github-warden reconcile \
  --config .github/governance.yml \
  --token-env GH_TOKEN \
  --mode dry-run
```

Flags:

- `--config <path>` — Path to governance config file (YAML or JSON). Required.
- `--mode dry-run|apply` — Reconcile mode (default: dry-run).
- `--cycles <name[,name...]>` — Cycle names to run (default: all).
- `--token-env <VAR>` — Env var holding a pre-minted GitHub installation token.
- `--app-id-env <VAR>` — Env var holding the GitHub App ID.
- `--installation-id-env <VAR>` — Env var holding the installation ID.
- `--allow-guardrail-override` — Apply even when guardrails trip.

Exit codes: 0 success, 1 guardrail block, 2 arg/config error, 3 runtime error.

## Config format

```yaml
orgs:
  my-org:
    repos:
      my-repo:
        branchProtection:
          - pattern: main
            requirePullRequestReviews: true
            requiredApprovingReviewCount: 1
            requireStatusChecks: true
```

## CI workflow generation

Use `governancePipeline` from `src/emit/pipeline.ts` to generate a
`.github/workflows/governance.yml` that runs reconcile on a schedule.

## Auth

Two auth modes:

1. Pre-minted token: `--token-env GH_TOKEN` (e.g. from `actions/create-github-app-token`)
2. GitHub App: `--app-id-env` + `--installation-id-env`, private key in `GOVERNANCE_APP_PRIVATE_KEY`

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
