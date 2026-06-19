# Setting up the GitHub App

warden authenticates either with a **pre-minted installation token**
(`--token-env`) or as a **GitHub App** (`--app-id-env` + `--installation-id-env`
+ a private key). A token is fine for repo-level reconcile and `audit`; an
**App is required** for org-level cycles (org settings, members, teams) and the
token cycles, and is the right choice for unattended/scheduled runs.

This is a one-time checklist. The org-permission steps are web-only (GitHub has
no API to set or change an App's permissions).

## 1. Create the App

Open `https://github.com/organizations/<your-org>/settings/apps/new` and set:

- **Name:** e.g. `org-warden` (must be globally unique)
- **Homepage URL:** anything (e.g. your repo URL)
- **Webhook → Active:** **uncheck** (warden polls; no webhook needed)
- **Where can this be installed:** "Only on this account"

## 2. Grant permissions

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

Repository → **Metadata: read** is mandatory and auto-selected.

> A cycle whose read 403s (a permission you didn't grant, or a feature not on
> your plan) is skipped gracefully rather than crashing — so you can start with
> a narrow grant and widen later. Re-granting requires re-approving the install
> (step 4).

## 3. Generate a key + note the IDs

- **App ID:** shown at the top of the App's settings page.
- **Private keys → Generate a private key** → downloads a `.pem`. Store it as a
  secret.

## 4. Install it

**Install App** → install on your org → **All repositories** (or select the
repos warden should manage). After any later permission change, return here and
**approve** the new request.

The **installation ID** is in the install URL
(`…/settings/installations/<id>`), or via
`gh api /orgs/<org>/installations`.

## 5. Wire it up

CLI:

```bash
GOVERNANCE_APP_PRIVATE_KEY="$(cat org-warden.pem)" \
APP_ID=123456 INSTALL_ID=78901234 \
github-warden reconcile --config .github/governance.yml \
  --app-id-env APP_ID --installation-id-env INSTALL_ID --mode dry-run
```

GitHub Action — pass `app-id`, `installation-id`, and `private-key` (as a
secret); see the README "Use as a GitHub Action" section.

## 6. Verify

Run a **dry-run** first — it only reads and prints a plan. When the plan looks
right, switch to `--mode apply`.
