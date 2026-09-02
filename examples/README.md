# examples

Starter configs for github-warden.

## `governance.yml`

A small annotated config covering the most common domains: org settings and
repo settings, branch protection, plus security features. It parses with
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

Warden is selective by omission and manages only what you declare, so delete
the blocks you don't want managed and add fields as you grow. The
[policy reference](../POLICY.md) lists every field across all 13
cycles (teams, members, rulesets, environments, secrets/variables, dependency
hygiene, repo provisioning, token governance, ...).

## Auth

The example uses `--token-env GH_TOKEN` (a pre-minted installation token), which
is enough for repo-level reconcile and `audit`. Org-level cycles (org settings /
members / teams) and the token cycles need a **GitHub App**; see the
[App setup checklist](../docs/github-app-setup.md).
