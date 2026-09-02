# Setup

What you need before warden does anything useful: the CLI (or the Action),
auth, and a policy file. The default mode is `dry-run`, which only reads and
prints a plan, so the walkthrough below is safe to run end to end.

## Install

No install needed for a one-off:

```bash
npx @intentius/github-warden reconcile --config .github/governance.yml \
  --token-env GH_TOKEN --mode dry-run
```

Or install the `github-warden` binary globally:

```bash
npm install -g @intentius/github-warden     # or add it to a project
```

In CI you can skip both and use the [GitHub Action](CI.md).

## Choose your auth

| | Pre-minted token (`--token-env`) | GitHub App (`--app-id-env` + `--installation-id-env`) |
|---|---|---|
| Good for | Repo-level cycles, `audit`, quick trials | Everything, especially unattended/scheduled runs |
| Org-level cycles (org-settings, membership, teams, org rulesets) | Only if the token was minted from an App with the org permissions | Yes |
| Token cycles (`token-governance`, `token-approval`) | No — these APIs are callable only by a GitHub App | Yes |
| Secrets to hold | One token | App ID, installation ID, private key PEM |

`--token-env` takes precedence when both are supplied. A classic PAT will get
you through repo-level dry-runs, but the PAT governance endpoints and several
org administration APIs reject anything that is not an App installation
token, so plan on an App for real use.

### GitHub App

Follow the [App setup checklist](docs/github-app-setup.md). It walks you
through creating the App with the webhook off, granting per-cycle permissions
(read is enough for dry-run while apply needs write), generating a private
key, installing it on the org, then noting the App ID plus installation ID.
A cycle whose read is refused (403) is skipped rather than crashing, so you
can start with a narrow grant and widen later.

### Environment variables

warden never takes credentials on the command line, only env var *names*:

| Variable | Set when | Meaning |
|---|---|---|
| whatever you pass to `--token-env` (e.g. `GH_TOKEN`) | token auth | A pre-minted installation token. |
| whatever you pass to `--app-id-env` (e.g. `APP_ID`) | App auth | The numeric App ID. |
| whatever you pass to `--installation-id-env` (e.g. `INSTALL_ID`) | App auth | The numeric installation ID. |
| `GOVERNANCE_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY`) | App auth | The private key PEM. Fixed names; not flag-configurable yet. |

## Write a policy

The governance file is the heart of the tool, and [the policy
reference](POLICY.md) documents every field. Start from the annotated starter in
[`examples/governance.yml`](examples/governance.yml) and declare only what
you want warden to own:

```bash
cp examples/governance.yml .github/governance.yml
# edit the org and repo names, delete blocks you don't want managed
```

## First dry-run

```bash
export GH_TOKEN=...   # or the App trio of env vars

npx @intentius/github-warden reconcile \
  --config .github/governance.yml \
  --token-env GH_TOKEN \
  --mode dry-run
```

With App auth instead:

```bash
GOVERNANCE_APP_PRIVATE_KEY="$(cat org-warden.pem)" \
APP_ID=123456 INSTALL_ID=78901234 \
npx @intentius/github-warden reconcile \
  --config .github/governance.yml \
  --app-id-env APP_ID --installation-id-env INSTALL_ID \
  --mode dry-run
```

The plan prints one `=== <cycle> @ <org> ===` block per cycle, listing the
creates and updates warden would perform. Nothing has been changed. Iterate
on the policy until the plan matches your intent, then run the same command
with `--mode apply`. Guardrails still stand between the plan and the API: a
block exits 1 and prints why.

From there, move the same command into [a CI pipeline](CI.md) so the plan
runs on every policy change and drift is corrected on a schedule.

## Adopting an existing org

`dumpOrg` (`src/reconcile/dump.ts`, programmatic) exports live state as a
starting config so adoption starts from reality rather than a blank file. It
currently covers branch protection only, and the literal-name probe misses
wildcard-pattern rules; trim and extend its output by hand before committing.
