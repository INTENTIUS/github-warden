# CLI reference

The `github-warden` binary has three subcommands. All of them load the policy
file (`--config`) and authenticate the same way; they differ in what they do
with live GitHub state.

| Subcommand | What it does | Mutates? |
|---|---|---|
| `reconcile` | Diff desired vs live per cycle, guardrail-check, print the plan (`dry-run`) or apply it. | Only with `--mode apply`. |
| `audit` | Run chant's posture-audit engine over every repo declared in the config. | Never. |
| `report` | Run cycles in dry-run, optionally add audit and identity passes, print a compliance snapshot, optionally write a JSON artifact. | Never. |

`github-warden --help` (or no arguments, or `--help` after a subcommand)
prints usage; `github-warden --version` prints the version (inlined from
package.json at build time).

## Config file parsing

`--config` accepts YAML or JSON, decided by extension: `.json` is parsed as
JSON, anything else goes through the built-in YAML reader (block-style
mappings/sequences, string/bool/number scalars, comments; no flow style, no
multi-line scalars, no anchors). For complex YAML, use JSON. Invalid config
shape exits 2 with the offending field path.

## `reconcile`

```
github-warden reconcile --config <path> [auth flags] [--mode dry-run|apply]
                        [--cycles a,b,c] [--allow-guardrail-override]
                        [--removal-cap-fraction <value>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | **required** | Governance config (YAML or JSON). |
| `--mode dry-run\|apply` | `dry-run` | `dry-run` prints the plan and changes nothing; `apply` executes it after guardrails pass. |
| `--cycles <name[,name...]>` | all | Subset of cycles to run. Unknown names exit 2 and print the known list. |
| `--token-env <VAR>` | — | Env var holding a pre-minted installation token (auth mode 1). |
| `--app-id-env <VAR>` | — | Env var holding the GitHub App ID (auth mode 2, with the next flag). |
| `--installation-id-env <VAR>` | — | Env var holding the installation ID. |
| `--allow-guardrail-override` | off | Apply even when guardrails trip. |
| `--removal-cap-fraction <value>` | `0.25` | `removalDeltaCap` threshold: the max fraction of any one resource type's live managed entries the plan may delete. Must be in (0,1]; anything else exits 2. See [the canonical cap description in POLICY.md](POLICY.md#what-the-policy-does-not-declare). |

Deletes come from the policy, not from a flag: a live resource missing from
the policy is planned for deletion only in an org whose policy declares
`owned: true` (or lists that resource type in `owned`). Without an `owned`
declaration, reconcile creates and updates but never deletes. See
[the policy reference](POLICY.md).

The valid `--cycles` names (from `src/cli/registry.ts`): `branch-protection`,
`org-settings`, `repo-settings`, `membership`, `teams`, `rulesets`,
`security-features`, `environments`, `secrets-variables`,
`dependency-hygiene`, `repo-baseline`, `token-governance`, `token-approval`.
See [the cycles reference](CYCLES.md).

The output prints one `=== <cycle> @ <org> ===` block per cycle/org with the
plan; a `GUARDRAIL BLOCK:` line when a guardrail refused an apply;
`Applied: N, Failed: N` (plus per-entry `FAILED` lines) in apply mode;
`ERROR in <cycle>` lines on stderr for errored cycles; and a `DEFERRED cycles`
line when the API request budget (1000 requests per run) ran out before every
cycle finished.

## `audit`

```
github-warden audit --config <path> [auth flags] [--fail-on none|merge-worthy|any]
```

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | **required** | Governance config. The audit targets every repo declared under `repos`. |
| `--token-env` / `--app-id-env` / `--installation-id-env` | — | Auth, same as reconcile. |
| `--fail-on none\|merge-worthy\|any` | `none` | Exit 4 when findings exceed this threshold. |
| `--help`, `-h` | — | Print audit usage and exit 0. |

The audit subcommand wraps chant's audit engine (the same checks as
`chant audit`) and reads private repos with warden's token. With no repos
declared it prints "nothing to audit" and exits 0.

## `report`

```
github-warden report --config <path> [auth flags] [--cycles a,b] [--audit]
                     [--identity] [--out compliance.json] [--fail-on none|attention]
```

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | **required** | Governance config. |
| `--token-env` / `--app-id-env` / `--installation-id-env` | — | Auth, same as reconcile. |
| `--cycles <name[,name...]>` | all | Cycles to include (always run in dry-run). |
| `--out <path>` | — | Write the committable JSON compliance artifact here. |
| `--audit` | off | Include an audit pass over the declared repos. |
| `--identity` | off | Include an identity and service-account hygiene pass (App installations vs seat-consuming `machineUsers`). |
| `--fail-on none\|attention` | `none` | Exit 4 when the report needs attention. |

Report is detect-only; cycles run in dry-run and nothing is mutated.

## Auth

Warden authenticates in one of two mutually exclusive modes; `--token-env`
takes precedence when both are given, and one of them is required (missing
auth exits 2).

1. **Pre-minted token** (`--token-env GH_TOKEN`): the named env var holds an
   installation token, e.g. minted by `actions/create-github-app-token`. No
   private key material is needed. Requests go straight to
   `https://api.github.com` with that bearer token.
2. **GitHub App** (`--app-id-env APP_ID --installation-id-env INSTALL_ID`):
   the App ID and installation ID are read from the named vars, and the
   private key PEM from `GOVERNANCE_APP_PRIVATE_KEY` (or
   `GITHUB_APP_PRIVATE_KEY` as a fallback). warden mints a short-lived RS256
   App JWT, exchanges it for an installation token, and refreshes it 60
   seconds before expiry. A `--private-key-env` flag is documented in the
   source but not exposed yet; use the fixed env var names.

Note that a plain PAT passed via `--token-env` cannot reach the org-level
token APIs: the token cycles (`token-governance`, `token-approval`) and
several org administration endpoints are callable only by a GitHub App. See
[SETUP.md](SETUP.md) and the [App setup checklist](docs/github-app-setup.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: the plan printed (dry-run), or apply completed with no failures. |
| 1 | Guardrail block: apply mode, at least one guardrail tripped, and `--allow-guardrail-override` was not set. |
| 2 | Argument or config error (unknown flag, unknown cycle, invalid config shape, missing auth). |
| 3 | Runtime error (unreadable config file, API failure, an errored cycle, or failed apply entries). |
| 4 | `audit`: findings exceed `--fail-on`; `report`: needs attention with `--fail-on attention`. |
