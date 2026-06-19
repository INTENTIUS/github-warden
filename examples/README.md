# examples

Starter configs for github-warden.

## `governance.yml`

A minimal, annotated config covering the most common domains — org settings,
repo settings, branch protection, and security features. It parses with
warden's built-in YAML reader (block-style only; for flow style `[ ]`/`{ }` use
JSON instead).

Copy it, change the org/repo names, and **dry-run** it (reads only, changes
nothing):

```bash
cp examples/governance.yml .github/governance.yml
# edit the org/repo names…

npx @intentius/github-warden reconcile \
  --config .github/governance.yml --token-env GH_TOKEN --mode dry-run
```

**Selective-by-omission:** warden manages only what you declare — delete the
blocks you don't want managed, add fields as you grow. The
[config reference](../README.md#config-format) lists every field across all 13
cycles (teams, members, rulesets, environments, secrets/variables, dependency
hygiene, repo provisioning, token governance, …).

## Auth

The example uses `--token-env GH_TOKEN` (a pre-minted installation token), which
is enough for repo-level reconcile and `audit`. Org-level cycles (org settings,
members, teams) and the token cycles need a **GitHub App** — see
[../docs/github-app-setup.md](../docs/github-app-setup.md).
