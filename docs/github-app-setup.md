# Setting up the GitHub App

warden authenticates either with a **pre-minted installation token**
(`--token-env`) or as a **GitHub App** (`--app-id-env` + `--installation-id-env`
+ a private key). A token is fine for repo-level reconcile and `audit`; an
**App is required** for the org-level cycles (org settings / members / teams)
and the token cycles, and it is the best choice for unattended or scheduled
runs.

This is a one-time checklist. The org-permission steps are web-only (GitHub has
no API to set or change an App's permissions).

## Create the App

Open `https://github.com/organizations/<your-org>/settings/apps/new` and fill
in the form as follows.

| Form field | What to enter |
|---|---|
| Name | e.g. `org-warden` (must be globally unique) |
| Homepage URL | anything, e.g. your repo URL |
| Webhook: Active | uncheck it (warden polls; no webhook needed) |
| Where can this be installed | "Only on this account" |

## Grant permissions

Grant only what the cycles you plan to run need. For a **dry-run** the *read*
level is enough; **apply** needs *write*.

| Cycle(s) | Permission | dry-run | apply |
|---|---|---|---|
| branch-protection, repo-settings, rulesets (repo), repo-baseline | Repository → **Administration** | read | write |
| security-features | Repository → **Administration** + **Contents** | read | write |
| dependency-hygiene | Repository → **Contents** | read | write |
| environments | Repository → **Environments** | read | write |
| secrets-variables | Repository → **Secrets** + **Variables** | read | write |
| org-settings, rulesets (org) | Organization → **Administration** | read | write |
| membership, teams | Organization → **Members** | read | write |
| token-governance | Organization → **Personal access tokens** | read | write |
| token-approval | Organization → **Personal access token requests** | read | write |

The Repository **Metadata (read)** permission is mandatory and auto-selected.

> A cycle whose read 403s (a permission you didn't grant, or a feature not on
> your plan) is skipped rather than crashing; start with a narrow grant, then
> widen it later. Re-granting requires re-approving the install (see the
> install step below).

## Generate a key and note the IDs

The **App ID** is shown at the top of the App's settings page. Under
**Private keys**, click **Generate a private key**, which downloads a `.pem`;
store it as a secret. Warden reads the PEM from an environment variable at
runtime, so keep it somewhere your pipeline can reach; nothing else ever
needs the file.

## Install it

Click **Install App**, install on your org, and choose **All repositories**
(or select the repos warden should manage). After any later permission change,
return here and **approve** the new request; the pending request shows up on
this same page.

The **installation ID** is in the install URL
(`.../settings/installations/<id>`), or via
`gh api /orgs/<org>/installations`.

## Wire it up

Point the CLI at the env vars like this:

```bash
GOVERNANCE_APP_PRIVATE_KEY="$(cat org-warden.pem)" \
APP_ID=123456 INSTALL_ID=78901234 \
github-warden reconcile --config .github/governance.yml \
  --app-id-env APP_ID --installation-id-env INSTALL_ID --mode dry-run
```

For the GitHub Action, pass `app-id`, `installation-id`, and `private-key`
(as a secret); the README section "Use as a GitHub Action" shows full
examples.

## Verify

Run a **dry-run** first; it only reads and prints a plan. When the plan looks
right, switch to `--mode apply`.
