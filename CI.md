# Running warden in CI

The steady state for governance is a pipeline: dry-run the plan on every pull
request that touches the policy, apply on the default branch and on a
schedule. This page covers the GitHub Action, a hand-written workflow, and the
emit pipeline that generates one for you.

## The GitHub Action

The repo ships a native Node 20 action (`action.yml`, entry
`action/index.mjs`). It exposes the `reconcile` and `audit` subcommands;
`report` is CLI-only. Auth is GitHub App only (the action mints the
installation token internally from the three App inputs).

| Input | Required | Default | Meaning |
|---|---|---|---|
| `command` | no | `reconcile` | `reconcile` or `audit`. |
| `config` | yes | — | Path to the governance config (YAML/JSON). |
| `mode` | no | `dry-run` | `dry-run` or `apply` (reconcile only). |
| `cycles` | no | all | Comma-separated cycle names (reconcile only). |
| `app-id` | yes | — | GitHub App ID (numeric). |
| `installation-id` | yes | — | App installation ID (numeric). |
| `private-key` | yes | — | App private key PEM. Pass as a secret, never a var. |
| `fail-on` | no | `none` | `none`, `merge-worthy`, or `any` (audit only). |
| `allow-guardrail-override` | no | `false` | `'true'` applies even when guardrails trip (reconcile only). |

## Dry-run on PR, apply on main

A workflow you can paste. Store the App ID and installation ID as repository
variables and the PEM as a secret:

```yaml
name: Governance

on:
  pull_request:
    paths: [.github/governance.yml]
  push:
    branches: [main]
    paths: [.github/governance.yml]
  schedule:
    - cron: "0 2 * * *"     # daily reconcile catches out-of-band drift
  workflow_dispatch:

permissions:
  contents: read

jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: intentius/github-warden@v1
        with:
          command: reconcile
          config: .github/governance.yml
          mode: dry-run
          app-id: ${{ vars.GOVERNANCE_APP_ID }}
          installation-id: ${{ vars.GOVERNANCE_INSTALLATION_ID }}
          private-key: ${{ secrets.GOVERNANCE_APP_PRIVATE_KEY }}

  apply:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: intentius/github-warden@v1
        with:
          command: reconcile
          config: .github/governance.yml
          mode: apply
          app-id: ${{ vars.GOVERNANCE_APP_ID }}
          installation-id: ${{ vars.GOVERNANCE_INSTALLATION_ID }}
          private-key: ${{ secrets.GOVERNANCE_APP_PRIVATE_KEY }}
```

Exit-code behavior maps cleanly onto CI: a guardrail block fails the apply job
with exit 1 (review the plan; overriding needs a deliberate
`allow-guardrail-override: 'true'`), config mistakes fail fast with exit 2,
and a failed apply entry surfaces as exit 3.

An audit gate is one more step:

```yaml
      - uses: intentius/github-warden@v1
        with:
          command: audit
          config: .github/governance.yml
          fail-on: merge-worthy
          app-id: ${{ vars.GOVERNANCE_APP_ID }}
          installation-id: ${{ vars.GOVERNANCE_INSTALLATION_ID }}
          private-key: ${{ secrets.GOVERNANCE_APP_PRIVATE_KEY }}
```

If you prefer a token over App inputs (e.g. for repo-level cycles only), skip
the action and run the CLI directly with `--token-env`, minting the token with
`actions/create-github-app-token` first.

## Generating the workflow: the emit pipeline

`governancePipeline` (`src/emit/pipeline.ts`, exported from the package root)
generates `.github/workflows/governance.yml` through the chant GitHub lexicon
builders, so the emitted workflow passes the same audit checks chant applies
to hand-written ones: actions pinned to commit SHAs, least-privilege
permissions (read-only at the workflow level with write scopes only on the job
that needs them), `timeout-minutes` on every job, plus the private key passed
via `with:` rather than interpolated into a script.

The emitted workflow runs the dry-run job on PRs touching the config (and
posts a PR comment pointing at the plan), and the apply job on schedule and
`workflow_dispatch`.

```ts
import { governancePipeline } from "@intentius/github-warden";
import { githubSerializer } from "@intentius/chant-lexicon-github";

const { workflow } = governancePipeline({ cron: "0 6 * * 1" });
const yaml = githubSerializer.serialize(new Map([["governance", workflow]]));
// write yaml to .github/workflows/governance.yml
```

Options (all optional, with defaults):

| Option | Default | Meaning |
|---|---|---|
| `cron` | `"0 2 * * *"` | Schedule for the recurring apply. |
| `configPath` | `".github/governance.yml"` | Where the policy lives in the repo. |
| `cycles` | all | Cycle names forwarded as `--cycles`. |
| `appIdVar` | `"GOVERNANCE_APP_ID"` | Actions **variable** holding the App ID. |
| `installationIdVar` | `"GOVERNANCE_INSTALLATION_ID"` | Actions variable holding the installation ID. |
| `privateKeySecret` | `"GOVERNANCE_APP_PRIVATE_KEY"` | Actions **secret** holding the PEM (must be a secret). |
| `runsOn` | `"ubuntu-latest"` | Runner label. |
| `timeoutMinutes` | `30` | Per-job timeout. |

## Scheduling notes

Two of the cycles only make sense on a schedule: `token-governance` (nothing
fires an event when a token ages past the policy) and `repo-baseline` (the
periodic backstop that declared repos exist). A daily cron covers both, and
also re-applies any drift introduced outside the pipeline.
