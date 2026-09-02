---
name: github-warden
description: Set up and operate declarative GitHub org/repo governance in this repo via the github-warden CLI — author the governance policy file, choose App vs PAT auth, run reconcile/audit/report with safe dry-run defaults. Use when an operator asks to set up, configure, or check GitHub org or repo governance here.
---

# github-warden

Use the **`github-warden` CLI** to govern GitHub orgs/repos from a declared
policy file. This skill is a pointer — read the docs, do not restate them:

- [POLICY.md](../../../POLICY.md) — authoring the governance file (every field
  and which cycle consumes it; the CLI loader validates and forwards them all).
- [SETUP.md](../../../SETUP.md) — install, GitHub App vs PAT auth, env vars,
  first dry-run.
- [CLI.md](../../../CLI.md) — every flag of `reconcile` / `audit` / `report`,
  auth selection, exit codes.
- [CYCLES.md](../../../CYCLES.md) — what each of the 13 cycles reads and writes.

Core rules:

- `--mode dry-run` is the default and is safe to run: it only reads and prints
  a plan. Start every task with a dry-run and show the operator the plan.
- Never pass `--mode apply` until a human has reviewed the rendered plan and
  approved the specific change.
- A guardrail block (exit 1) means stop and ask, not work around. Do not pass
  `--allow-guardrail-override` without explicit human approval.
- Deletes happen only in orgs whose policy declares `owned` (`true`, or a
  list of resource types). Treat adding `owned` as a destructive change: get
  explicit human approval first, then dry-run and review the planned deletes
  with the operator before any apply.
- `audit` and `report` never mutate; they are safe to run.
