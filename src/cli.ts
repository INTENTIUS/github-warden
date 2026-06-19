#!/usr/bin/env node
/**
 * github-warden — governance reconcile CLI.
 *
 * Entrypoint for the binary exposed in package.json's `bin` field.
 *
 * Subcommands:
 *   reconcile   Load config, build an authed client, run selected cycles.
 *   audit       Run chant's posture-audit engine over all managed repos.
 *
 * Flag contract (must stay in sync with emit/pipeline.ts):
 *   --config <path>               Path to the governance config file (YAML/JSON).
 *   --mode dry-run|apply          Reconcile mode. Default: dry-run.
 *   --cycles <name[,name...]>     Comma-separated cycle names. Default: all.
 *   --app-id-env <VAR>            Env var holding the GitHub App ID.
 *   --installation-id-env <VAR>   Env var holding the installation ID.
 *   --token-env <VAR>             Env var holding a pre-minted installation token
 *                                 (alternative to App-client auth).
 *   --allow-guardrail-override    Off by default. Applies even when guardrails trip.
 *
 * Auth modes (mutually exclusive, precedence: token-env > app-id-env):
 *   1. --token-env GH_TOKEN
 *      The named env var holds a pre-minted GitHub installation token (e.g. from
 *      actions/create-github-app-token). No private-key material needed.
 *   2. --app-id-env + --installation-id-env
 *      The App ID and installation ID are read from the named vars. The private
 *      key must be in GOVERNANCE_APP_PRIVATE_KEY (or the env var named by the
 *      optional --private-key-env flag, not yet exposed).
 *
 * Exit codes:
 *   0   Success (dry-run always, or apply with no errors).
 *   1   Guardrail block (apply mode, guardrails tripped, override not set).
 *   2   Argument / config error.
 *   3   Runtime error (network failure, apply failure, etc.).
 *   4   Audit: findings exceed --fail-on threshold.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadGovernanceConfig } from "./config/load.js";
import { createAppClient } from "./auth/app-client.js";
import { runReconcile } from "./reconcile/runner.js";
import { CYCLE_REGISTRY } from "./cli/registry.js";
import { auditRepos } from "./audit/engine.js";
import { renderPostureSummary, shouldFail, type FailOn } from "./audit/summary.js";
import type { Cycle, ReconcileResult } from "./reconcile/runner.js";
import { buildComplianceReport, renderComplianceReport, complianceArtifact } from "./report/compliance.js";

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

export interface ReconcileArgs {
  config: string;
  mode: "dry-run" | "apply";
  cycles: string[];
  appIdEnv: string | undefined;
  installationIdEnv: string | undefined;
  tokenEnv: string | undefined;
  allowGuardrailOverride: boolean;
}

/**
 * Error thrown by `parseReconcileArgs` on bad input.
 *
 * Carries the process exit code that `main()` should use when it catches the
 * error. Keeping the parser pure (throwing instead of calling `process.exit`)
 * lets the consistency test import and exercise the real parser directly.
 */
export class CliError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Parse reconcile argv (everything after the `reconcile` subcommand) into
 * `ReconcileArgs`.
 *
 * Pure function: throws `CliError` (carrying an exit code) on any parse error
 * instead of touching `process`. `main()` catches `CliError` and exits non-zero.
 */
export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    config: "",
    mode: "dry-run",
    cycles: [],
    appIdEnv: undefined,
    installationIdEnv: undefined,
    tokenEnv: undefined,
    allowGuardrailOverride: false,
  };

  const knownFlags = new Set([
    "--config",
    "--mode",
    "--cycles",
    "--app-id-env",
    "--installation-id-env",
    "--token-env",
    "--allow-guardrail-override",
  ]);

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];

    if (!flag.startsWith("--")) {
      throw new CliError(2, `unexpected positional argument: ${flag}`);
    }

    if (!knownFlags.has(flag)) {
      throw new CliError(2, `unknown flag: ${flag}`);
    }

    switch (flag) {
      case "--config": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--config requires a value");
        args.config = val;
        break;
      }
      case "--mode": {
        const val = argv[++i];
        if (val !== "dry-run" && val !== "apply") {
          throw new CliError(2, `--mode must be "dry-run" or "apply", got: ${val ?? "(missing)"}`);
        }
        args.mode = val;
        break;
      }
      case "--cycles": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--cycles requires a value");
        args.cycles = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case "--app-id-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--app-id-env requires a value");
        args.appIdEnv = val;
        break;
      }
      case "--installation-id-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--installation-id-env requires a value");
        args.installationIdEnv = val;
        break;
      }
      case "--token-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--token-env requires a value");
        args.tokenEnv = val;
        break;
      }
      case "--allow-guardrail-override": {
        args.allowGuardrailOverride = true;
        break;
      }
    }
    i++;
  }

  // Validate required flags.
  if (!args.config) throw new CliError(2, "--config is required");

  const hasTokenAuth = !!args.tokenEnv;
  const hasAppAuth = !!(args.appIdEnv && args.installationIdEnv);
  if (!hasTokenAuth && !hasAppAuth) {
    throw new CliError(
      2,
      "auth is required: supply --token-env <VAR>, or both --app-id-env <VAR> and --installation-id-env <VAR>",
    );
  }

  return args;
}

// ---------------------------------------------------------------------------
// Audit subcommand
// ---------------------------------------------------------------------------

export interface AuditArgs {
  config: string;
  appIdEnv: string | undefined;
  installationIdEnv: string | undefined;
  tokenEnv: string | undefined;
  failOn: FailOn;
}

/**
 * Parse audit argv (everything after the `audit` subcommand) into `AuditArgs`.
 *
 * Accepted flags:
 *   --config <path>               Path to governance config file (YAML/JSON). Required.
 *   --token-env <VAR>             Env var holding a pre-minted installation token.
 *   --app-id-env <VAR>            Env var holding the GitHub App ID.
 *   --installation-id-env <VAR>   Env var holding the installation ID.
 *   --fail-on merge-worthy|any|none
 *                                 Exit 4 when findings exceed this threshold.
 *                                 Default: none.
 */
export function parseAuditArgs(argv: string[]): AuditArgs {
  const args: AuditArgs = {
    config: "",
    appIdEnv: undefined,
    installationIdEnv: undefined,
    tokenEnv: undefined,
    failOn: "none",
  };

  const knownFlags = new Set([
    "--config",
    "--token-env",
    "--app-id-env",
    "--installation-id-env",
    "--fail-on",
    "--help",
    "-h",
  ]);

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];

    if (flag === "--help" || flag === "-h") {
      printAuditUsage();
      process.exit(0);
    }

    if (!flag.startsWith("--")) {
      throw new CliError(2, `unexpected positional argument: ${flag}`);
    }

    if (!knownFlags.has(flag)) {
      throw new CliError(2, `unknown flag: ${flag}`);
    }

    switch (flag) {
      case "--config": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--config requires a value");
        args.config = val;
        break;
      }
      case "--token-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--token-env requires a value");
        args.tokenEnv = val;
        break;
      }
      case "--app-id-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--app-id-env requires a value");
        args.appIdEnv = val;
        break;
      }
      case "--installation-id-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--installation-id-env requires a value");
        args.installationIdEnv = val;
        break;
      }
      case "--fail-on": {
        const val = argv[++i];
        const allowed: FailOn[] = ["merge-worthy", "any", "none"];
        if (!allowed.includes(val as FailOn)) {
          throw new CliError(
            2,
            `--fail-on must be one of [${allowed.join(", ")}], got: ${val ?? "(missing)"}`,
          );
        }
        args.failOn = val as FailOn;
        break;
      }
    }
    i++;
  }

  if (!args.config) throw new CliError(2, "--config is required");

  const hasTokenAuth = !!args.tokenEnv;
  const hasAppAuth = !!(args.appIdEnv && args.installationIdEnv);
  if (!hasTokenAuth && !hasAppAuth) {
    throw new CliError(
      2,
      "auth is required: supply --token-env <VAR>, or both --app-id-env <VAR> and --installation-id-env <VAR>",
    );
  }

  return args;
}

// ---------------------------------------------------------------------------
// Report subcommand
// ---------------------------------------------------------------------------

export interface ReportArgs {
  config: string;
  appIdEnv: string | undefined;
  installationIdEnv: string | undefined;
  tokenEnv: string | undefined;
  cycles: string[];
  /** Path to write the committable JSON artifact (optional). */
  out: string | undefined;
  /** Include an audit pass in the report. */
  audit: boolean;
  /** Exit non-zero when the report needs attention. */
  failOn: "none" | "attention";
}

/**
 * Parse report argv. Pure: throws `CliError` (carrying an exit code) on any
 * parse error instead of touching `process`.
 *
 * Accepted flags:
 *   --config <path>               Governance config file (YAML/JSON). Required.
 *   --token-env / --app-id-env / --installation-id-env   Auth (same as reconcile).
 *   --cycles <name[,name...]>     Cycles to include (default: all).
 *   --out <path>                  Write the JSON compliance artifact to this path.
 *   --audit                       Include an audit pass in the report.
 *   --fail-on none|attention      Exit 4 when the report needs attention. Default: none.
 */
export function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = {
    config: "",
    appIdEnv: undefined,
    installationIdEnv: undefined,
    tokenEnv: undefined,
    cycles: [],
    out: undefined,
    audit: false,
    failOn: "none",
  };

  const knownFlags = new Set([
    "--config",
    "--token-env",
    "--app-id-env",
    "--installation-id-env",
    "--cycles",
    "--out",
    "--audit",
    "--fail-on",
  ]);

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new CliError(2, `unexpected positional argument: ${flag}`);
    if (!knownFlags.has(flag)) throw new CliError(2, `unknown flag: ${flag}`);

    switch (flag) {
      case "--config": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--")) throw new CliError(2, "--config requires a value");
        args.config = val;
        break;
      }
      case "--token-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--")) throw new CliError(2, "--token-env requires a value");
        args.tokenEnv = val;
        break;
      }
      case "--app-id-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--")) throw new CliError(2, "--app-id-env requires a value");
        args.appIdEnv = val;
        break;
      }
      case "--installation-id-env": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new CliError(2, "--installation-id-env requires a value");
        args.installationIdEnv = val;
        break;
      }
      case "--cycles": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--")) throw new CliError(2, "--cycles requires a value");
        args.cycles = val.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--out": {
        const val = argv[++i];
        if (val === undefined || val.startsWith("--")) throw new CliError(2, "--out requires a value");
        args.out = val;
        break;
      }
      case "--audit": {
        args.audit = true;
        break;
      }
      case "--fail-on": {
        const val = argv[++i];
        if (val !== "none" && val !== "attention") {
          throw new CliError(2, `--fail-on must be "none" or "attention", got: ${val ?? "(missing)"}`);
        }
        args.failOn = val;
        break;
      }
    }
    i++;
  }

  if (!args.config) throw new CliError(2, "--config is required");

  const hasTokenAuth = !!args.tokenEnv;
  const hasAppAuth = !!(args.appIdEnv && args.installationIdEnv);
  if (!hasTokenAuth && !hasAppAuth) {
    throw new CliError(
      2,
      "auth is required: supply --token-env <VAR>, or both --app-id-env <VAR> and --installation-id-env <VAR>",
    );
  }

  return args;
}

// ---------------------------------------------------------------------------
// Auth client builder
// ---------------------------------------------------------------------------

/**
 * Build an `AppClient` from parsed CLI args and environment variables.
 *
 * Token-env path: wrap the pre-minted token in a minimal client that satisfies
 * the `AppClient` interface without minting its own JWTs.
 *
 * App-client path: delegate to `createAppClient`, which mints and auto-refreshes
 * installation tokens from the App ID, installation ID, and private key PEM.
 *
 * Accepts both ReconcileArgs and AuditArgs (both carry the same auth fields).
 */
function buildClient(args: ReconcileArgs | AuditArgs | ReportArgs) {
  if (args.tokenEnv) {
    const token = env(args.tokenEnv);
    // Wrap the pre-minted token in a minimal AppClient.
    return {
      async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        const API_BASE = "https://api.github.com";
        const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "github-warden (+https://github.com/INTENTIUS/github-warden)",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          redirect: "manual",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (res.status === 204) return {} as T;
        if (!res.ok) {
          let detail = "";
          try {
            const text = await res.text();
            if (text) detail = `: ${text.slice(0, 500)}`;
          } catch {
            // best-effort
          }
          throw new Error(`${method} ${path} returned ${res.status}${detail}`);
        }
        return (await res.json()) as T;
      },
    };
  }

  // App-client path: read app-id, installation-id, private key from env.
  const appId = env(args.appIdEnv!);
  const installationId = env(args.installationIdEnv!);
  // Private key: conventionally GOVERNANCE_APP_PRIVATE_KEY, but also accept
  // GITHUB_APP_PRIVATE_KEY for compatibility. Operators may set either.
  const privateKeyPem =
    process.env["GOVERNANCE_APP_PRIVATE_KEY"] ??
    process.env["GITHUB_APP_PRIVATE_KEY"] ??
    die(
      2,
      "private key not found: set GOVERNANCE_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY) to the PEM",
    );

  return createAppClient({ appId, privateKeyPem, installationId });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[] = process.argv.slice(2)) {

  // Top-level subcommand dispatch.
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "audit") {
    await runAudit(argv.slice(1));
    return;
  }

  if (subcommand === "report") {
    await runReport(argv.slice(1));
    return;
  }

  if (subcommand !== "reconcile") {
    die(2, `unknown subcommand: ${subcommand}. Did you mean "reconcile", "audit", or "report"?`);
  }

  let args: ReconcileArgs;
  try {
    args = parseReconcileArgs(argv.slice(1));
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  // ── Load config ───────────────────────────────────────────────────────────

  let rawConfig: unknown;
  try {
    const text = readFileSync(args.config, "utf-8");
    rawConfig = parseConfigFile(args.config, text);
  } catch (err) {
    die(3, `failed to read config file "${args.config}": ${errMsg(err)}`);
  }

  let config;
  try {
    config = loadGovernanceConfig(rawConfig);
  } catch (err) {
    die(2, `invalid governance config: ${errMsg(err)}`);
  }

  // ── Build client ──────────────────────────────────────────────────────────

  let client;
  try {
    client = buildClient(args);
  } catch (err) {
    die(3, `auth setup failed: ${errMsg(err)}`);
  }

  // ── Resolve cycles ────────────────────────────────────────────────────────

  let cycles: Cycle[];
  if (args.cycles.length === 0) {
    cycles = Object.values(CYCLE_REGISTRY);
  } else {
    cycles = [];
    for (const name of args.cycles) {
      const cycle = CYCLE_REGISTRY[name];
      if (!cycle) {
        const known = Object.keys(CYCLE_REGISTRY).join(", ");
        die(2, `unknown cycle: "${name}". Known cycles: ${known}`);
      }
      cycles.push(cycle);
    }
  }

  // ── Run reconcile ─────────────────────────────────────────────────────────

  let result;
  try {
    result = await runReconcile({
      config,
      client,
      cycles,
      mode: args.mode,
      allowGuardrailOverride: args.allowGuardrailOverride,
    });
  } catch (err) {
    die(3, `reconcile failed: ${errMsg(err)}`);
  }

  // ── Output ────────────────────────────────────────────────────────────────

  // Print plan summary for every cycle that ran.
  for (const cr of result.cycles) {
    process.stdout.write(`\n=== ${cr.name} @ ${cr.org} ===\n`);
    process.stdout.write(`${cr.plan}\n`);

    if (cr.guardrailBlocked) {
      const diags = cr.guardrails.ok ? [] : cr.guardrails.diagnostics;
      process.stdout.write(
        `\nGUARDRAIL BLOCK: ${diags.map((d) => d.message).join("; ")}\n`,
      );
    }

    if (args.mode === "apply" && !cr.guardrailBlocked) {
      process.stdout.write(
        `Applied: ${cr.applied.length}, Failed: ${cr.failed.length}\n`,
      );
      for (const f of cr.failed) {
        process.stdout.write(`  FAILED [${f.entry.resourceType}] ${f.entry.key}: ${f.error}\n`);
      }
    }
  }

  // Errored cycles.
  for (const ce of result.errored) {
    process.stderr.write(`ERROR in ${ce.name} @ ${ce.org} (${ce.stage}): ${ce.error}\n`);
  }

  // Deferred work.
  if (result.deferred.skippedCycles.length > 0) {
    process.stderr.write(
      `DEFERRED cycles (budget exhausted): ${result.deferred.skippedCycles.join(", ")}\n`,
    );
  }

  // Determine exit code.
  // Guardrail block in apply mode → exit 1 (unless override was set, in which
  // case the apply still ran and the block flag is false).
  const anyGuardrailBlock = result.cycles.some((cr) => cr.guardrailBlocked);
  if (anyGuardrailBlock) {
    process.exit(1);
  }

  // Any errored cycle or failed apply entry → exit 3.
  const anyError =
    result.errored.length > 0 || result.cycles.some((cr) => cr.failed.length > 0);
  if (anyError) {
    process.exit(3);
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a required env var or die with exit 2. */
function env(name: string): string {
  const val = process.env[name];
  if (!val) die(2, `env var ${name} is not set or is empty`);
  return val;
}

/**
 * Print an error message to stderr and exit with the given code.
 * Return type is `never` so callers can use `die(...)` in expression position.
 */
function die(code: number, message: string): never {
  process.stderr.write(`github-warden: error: ${message}\n`);
  process.exit(code);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse the config file text. Supports YAML (via a hand-rolled subset adequate
 * for governance configs — flat string/bool/number scalars, nested objects, and
 * string arrays) and JSON.
 *
 * The package has no YAML library dependency. Governance configs are structured
 * YAML with a predictable schema: the hand-rolled parser handles the real cases.
 * For truly complex YAML, operators can supply JSON instead.
 */
function parseConfigFile(filePath: string, text: string): unknown {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) {
    return JSON.parse(text);
  }
  // YAML or ambiguous extension: delegate to the hand-rolled YAML parser.
  return parseSimpleYaml(text);
}

/**
 * Minimal YAML parser for governance config files.
 *
 * Handles:
 *   - Nested mappings (indented with 2 spaces).
 *   - String, boolean, and integer scalars.
 *   - Sequences of scalars (- item) and mappings (- key: val).
 *   - Comments (#) and blank lines.
 *
 * Does NOT handle:
 *   - Flow style ({ } / [ ]).
 *   - Multi-line scalars (| / >).
 *   - Anchors / aliases (* / &).
 *   - Quoted keys.
 *
 * Governance configs are authored with this tool and are unlikely to use those
 * features. If they do, operators should use JSON.
 */
function parseSimpleYaml(text: string): unknown {
  const lines = text.split("\n");
  const root = parseYamlBlock(lines, 0, 0);
  return root.value;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function parseYamlBlock(lines: string[], startLine: number, indent: number): ParseResult {
  // Collect lines at this indent level, building a mapping or sequence.
  let i = startLine;
  const result: Record<string, unknown> = {};
  const seq: unknown[] = [];
  let isSequence = false;
  let isMapping = false;

  while (i < lines.length) {
    const raw = lines[i];
    const stripped = raw.replace(/#.*$/, "").trimEnd();

    if (stripped.trim() === "") {
      i++;
      continue;
    }

    const lineIndent = stripped.length - stripped.trimStart().length;

    // Dedent: this line belongs to a parent block.
    if (lineIndent < indent) break;

    // Deeper indent: should have been consumed by a recursive call.
    if (lineIndent > indent) {
      i++;
      continue;
    }

    const content = stripped.trimStart();

    // Sequence item.
    if (content.startsWith("- ")) {
      isSequence = true;
      const rest = content.slice(2).trim();
      // Inline mapping: "- key: value"
      if (/^[^:]+:\s/.test(rest) || /^[^:]+:$/.test(rest)) {
        // Parse as a mini-mapping starting from the same line.
        const itemMap = parseInlineSequenceMappingItem(lines, i, lineIndent + 2);
        seq.push(itemMap.value);
        i = itemMap.nextLine;
      } else {
        seq.push(parseScalar(rest));
        i++;
      }
      continue;
    }

    // Mapping entry: "key: value" or "key:".
    const colonIdx = content.indexOf(": ");
    const bareColon = content.endsWith(":") && !content.includes(": ");
    if (colonIdx !== -1 || bareColon) {
      isMapping = true;
      const key = colonIdx !== -1 ? content.slice(0, colonIdx).trim() : content.slice(0, -1).trim();
      const valueStr = colonIdx !== -1 ? content.slice(colonIdx + 2).trim() : "";

      i++;

      if (valueStr !== "" && valueStr !== "|" && valueStr !== ">") {
        // Inline scalar value.
        result[key] = parseScalar(valueStr);
      } else {
        // Value is on subsequent lines — recurse.
        // Find the indent of the next non-blank, non-comment line.
        let nextNonBlank = i;
        while (nextNonBlank < lines.length) {
          const candidate = lines[nextNonBlank].replace(/#.*$/, "").trimEnd();
          if (candidate.trim() !== "") break;
          nextNonBlank++;
        }
        if (nextNonBlank >= lines.length) {
          result[key] = null;
        } else {
          const childIndent =
            lines[nextNonBlank].length - lines[nextNonBlank].trimStart().length;
          if (childIndent <= indent) {
            result[key] = null;
          } else {
            const child = parseYamlBlock(lines, nextNonBlank, childIndent);
            result[key] = child.value;
            i = child.nextLine;
          }
        }
      }
      continue;
    }

    // Unrecognized line at this indent — skip.
    i++;
  }

  if (isSequence) return { value: seq, nextLine: i };
  if (isMapping) return { value: result, nextLine: i };
  return { value: null, nextLine: i };
}

/**
 * Parse a sequence item that starts a mapping at `startLine`.
 * E.g.:
 *   - pattern: main
 *     requirePullRequestReviews: true
 */
function parseInlineSequenceMappingItem(
  lines: string[],
  startLine: number,
  childIndent: number,
): ParseResult {
  const raw = lines[startLine];
  const stripped = raw.replace(/#.*$/, "").trimEnd();
  const lineIndent = stripped.length - stripped.trimStart().length;
  const content = stripped.trimStart().slice(2).trim(); // strip "- "

  const colonIdx = content.indexOf(": ");
  const bareColon = content.endsWith(":") && !content.includes(": ");
  const result: Record<string, unknown> = {};

  if (colonIdx !== -1 || bareColon) {
    const key = colonIdx !== -1 ? content.slice(0, colonIdx).trim() : content.slice(0, -1).trim();
    const valueStr = colonIdx !== -1 ? content.slice(colonIdx + 2).trim() : "";
    if (valueStr !== "") {
      result[key] = parseScalar(valueStr);
    } else {
      // value is on child lines
      let nextNonBlank = startLine + 1;
      while (nextNonBlank < lines.length) {
        const candidate = lines[nextNonBlank].replace(/#.*$/, "").trimEnd();
        if (candidate.trim() !== "") break;
        nextNonBlank++;
      }
      if (nextNonBlank < lines.length) {
        const ci = lines[nextNonBlank].length - lines[nextNonBlank].trimStart().length;
        if (ci > lineIndent) {
          const child = parseYamlBlock(lines, nextNonBlank, ci);
          result[key] = child.value;
          // Continue collecting sibling keys at childIndent.
          const rest = parseYamlBlock(lines, child.nextLine, childIndent);
          if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value)) {
            Object.assign(result, rest.value as object);
            return { value: result, nextLine: rest.nextLine };
          }
          return { value: result, nextLine: child.nextLine };
        }
      }
    }
  }

  // Collect sibling keys at `childIndent`.
  const rest = parseYamlBlock(lines, startLine + 1, childIndent);
  if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value)) {
    Object.assign(result, rest.value as object);
    return { value: result, nextLine: rest.nextLine };
  }
  return { value: result, nextLine: startLine + 1 };
}

function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  // Strip optional quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== "") return n;
  return s;
}

/**
 * Run the `audit` subcommand end-to-end:
 *   load config → resolve managed repos → get token → auditRepos → print + exit.
 *
 * Exits 4 when findings exceed the --fail-on threshold.
 */
async function runAudit(argv: string[]): Promise<void> {
  let auditArgs: AuditArgs;
  try {
    auditArgs = parseAuditArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  // ── Load config ────────────────────────────────────────────────────────────
  let rawConfig: unknown;
  try {
    const text = readFileSync(auditArgs.config, "utf-8");
    rawConfig = parseConfigFile(auditArgs.config, text);
  } catch (err) {
    die(3, `failed to read config file "${auditArgs.config}": ${errMsg(err)}`);
  }

  let config;
  try {
    config = loadGovernanceConfig(rawConfig);
  } catch (err) {
    die(2, `invalid governance config: ${errMsg(err)}`);
  }

  // ── Resolve managed repos from config ──────────────────────────────────────
  const repoUrls: string[] = [];
  for (const [orgName, orgCfg] of Object.entries(config.orgs)) {
    for (const repoName of Object.keys(orgCfg.repos ?? {})) {
      repoUrls.push(`https://github.com/${orgName}/${repoName}`);
    }
  }

  if (repoUrls.length === 0) {
    process.stdout.write("github-warden audit: no repos declared in config; nothing to audit.\n");
    process.exit(0);
  }

  // ── Get token ──────────────────────────────────────────────────────────────
  let token: string | undefined;
  try {
    const client = buildClient(auditArgs);
    // Mint the token by making a no-op request to the meta endpoint.
    // For a token-env client there is no mint step; read the env var directly.
    if (auditArgs.tokenEnv) {
      token = process.env[auditArgs.tokenEnv];
    } else {
      // App client: mint an installation token and extract it.
      // We ping /meta (no auth body) just to trigger the token mint — the
      // client auto-caches it. For auditRepos we need the raw string, so we
      // call a harmless endpoint and pull the Authorization header value via
      // a thin wrapper.
      //
      // Simpler: read the private key and mint directly.
      const appId = env(auditArgs.appIdEnv!);
      const installationId = env(auditArgs.installationIdEnv!);
      const privateKeyPem =
        process.env["GOVERNANCE_APP_PRIVATE_KEY"] ??
        process.env["GITHUB_APP_PRIVATE_KEY"] ??
        die(
          2,
          "private key not found: set GOVERNANCE_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY) to the PEM",
        );
      const { mintInstallationToken } = await import("./auth/app-client.js");
      const { token: minted } = await mintInstallationToken({ appId, installationId, privateKeyPem });
      token = minted;
      // Silence the unused import warning — client is used for type-checking above.
      void client;
    }
  } catch (err) {
    die(3, `auth setup failed: ${errMsg(err)}`);
  }

  // ── Run audit ──────────────────────────────────────────────────────────────
  let report;
  try {
    report = await auditRepos(repoUrls, token);
  } catch (err) {
    die(3, `audit failed: ${errMsg(err)}`);
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  process.stdout.write(renderPostureSummary(report));

  if (shouldFail(report, auditArgs.failOn)) {
    process.stderr.write(
      `github-warden: audit threshold exceeded (--fail-on ${auditArgs.failOn}): ${report.totals.quickWin + report.totals.needsReview} merge-worthy finding(s)\n`,
    );
    process.exit(4);
  }

  process.exit(0);
}

/**
 * Run the `report` subcommand: run all (or selected) cycles in dry-run,
 * optionally run an audit pass, aggregate into a compliance snapshot, print it,
 * and optionally write a committable JSON artifact.
 *
 * Detect-and-report only — never mutates (cycles run in dry-run).
 *
 * Exits 4 when `--fail-on attention` is set and the report needs attention.
 */
async function runReport(argv: string[]): Promise<void> {
  let reportArgs: ReportArgs;
  try {
    reportArgs = parseReportArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  // ── Load config ────────────────────────────────────────────────────────────
  let rawConfig: unknown;
  try {
    const text = readFileSync(reportArgs.config, "utf-8");
    rawConfig = parseConfigFile(reportArgs.config, text);
  } catch (err) {
    die(3, `failed to read config file "${reportArgs.config}": ${errMsg(err)}`);
  }

  let config;
  try {
    config = loadGovernanceConfig(rawConfig);
  } catch (err) {
    die(2, `invalid governance config: ${errMsg(err)}`);
  }

  // ── Build client ───────────────────────────────────────────────────────────
  let client;
  try {
    client = buildClient(reportArgs);
  } catch (err) {
    die(3, `auth setup failed: ${errMsg(err)}`);
  }

  // ── Resolve cycles ─────────────────────────────────────────────────────────
  let cycles: Cycle[];
  if (reportArgs.cycles.length === 0) {
    cycles = Object.values(CYCLE_REGISTRY);
  } else {
    cycles = [];
    for (const name of reportArgs.cycles) {
      const cycle = CYCLE_REGISTRY[name];
      if (!cycle) {
        die(2, `unknown cycle: "${name}". Known cycles: ${Object.keys(CYCLE_REGISTRY).join(", ")}`);
      }
      cycles.push(cycle);
    }
  }

  // ── Reconcile in dry-run (detect-only) ─────────────────────────────────────
  let result: ReconcileResult;
  try {
    result = await runReconcile({ config, client, cycles, mode: "dry-run" });
  } catch (err) {
    die(3, `reconcile failed: ${errMsg(err)}`);
  }

  // ── Optional audit pass ────────────────────────────────────────────────────
  let auditReport;
  if (reportArgs.audit) {
    const repoUrls: string[] = [];
    for (const [orgName, orgCfg] of Object.entries(config.orgs)) {
      for (const repoName of Object.keys(orgCfg.repos ?? {})) {
        repoUrls.push(`https://github.com/${orgName}/${repoName}`);
      }
    }
    if (repoUrls.length > 0) {
      try {
        let token: string | undefined;
        if (reportArgs.tokenEnv) {
          token = process.env[reportArgs.tokenEnv];
        } else {
          const appId = env(reportArgs.appIdEnv!);
          const installationId = env(reportArgs.installationIdEnv!);
          const privateKeyPem =
            process.env["GOVERNANCE_APP_PRIVATE_KEY"] ??
            process.env["GITHUB_APP_PRIVATE_KEY"] ??
            die(2, "private key not found: set GOVERNANCE_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY) to the PEM");
          const { mintInstallationToken } = await import("./auth/app-client.js");
          const { token: minted } = await mintInstallationToken({ appId, installationId, privateKeyPem });
          token = minted;
        }
        auditReport = await auditRepos(repoUrls, token);
      } catch (err) {
        die(3, `audit failed: ${errMsg(err)}`);
      }
    }
  }

  // ── Aggregate + output ─────────────────────────────────────────────────────
  const report = buildComplianceReport([result], auditReport);
  report.generatedAt = new Date().toISOString();
  process.stdout.write(renderComplianceReport(report));

  if (reportArgs.out) {
    try {
      writeFileSync(reportArgs.out, complianceArtifact(report), "utf-8");
      process.stdout.write(`wrote artifact: ${reportArgs.out}\n`);
    } catch (err) {
      die(3, `failed to write artifact "${reportArgs.out}": ${errMsg(err)}`);
    }
  }

  if (reportArgs.failOn === "attention" && !report.clean) {
    process.stderr.write("github-warden: compliance report needs attention (--fail-on attention)\n");
    process.exit(4);
  }
  process.exit(0);
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: github-warden <subcommand> [flags]",
      "",
      "Subcommands:",
      "  reconcile   Load config, authenticate, and run governance cycles.",
      "  audit       Audit managed repos for security/correctness posture.",
      "  report      Aggregate cycle drift (+ optional audit) into a compliance snapshot.",
      "",
      "Flags (reconcile):",
      "  --config <path>               Path to governance config file (YAML or JSON).",
      "  --mode dry-run|apply          Reconcile mode (default: dry-run).",
      "  --cycles <name[,name...]>     Cycle names to run (default: all).",
      "  --token-env <VAR>             Env var holding a pre-minted installation token.",
      "  --app-id-env <VAR>            Env var holding the GitHub App ID.",
      "  --installation-id-env <VAR>   Env var holding the installation ID.",
      "  --allow-guardrail-override    Apply even when guardrails trip.",
      "",
      "Flags (audit):",
      "  --config <path>               Path to governance config file (YAML or JSON).",
      "  --token-env <VAR>             Env var holding a pre-minted installation token.",
      "  --app-id-env <VAR>            Env var holding the GitHub App ID.",
      "  --installation-id-env <VAR>   Env var holding the installation ID.",
      "  --fail-on merge-worthy|any|none",
      "                                Exit 4 when findings exceed threshold (default: none).",
      "",
      "Flags (report):",
      "  --config <path>               Path to governance config file (YAML or JSON).",
      "  --token-env / --app-id-env / --installation-id-env   Auth (as reconcile).",
      "  --cycles <name[,name...]>     Cycles to include (default: all).",
      "  --out <path>                  Write the JSON compliance artifact to this path.",
      "  --audit                       Include an audit pass in the report.",
      "  --fail-on none|attention      Exit 4 when the report needs attention (default: none).",
      "",
      "Exit codes:",
      "  0   Success.",
      "  1   Guardrail block (apply mode, override not set).",
      "  2   Argument or config error.",
      "  3   Runtime error.",
      "  4   Audit/report: threshold exceeded or report needs attention.",
      "",
    ].join("\n"),
  );
}

function printAuditUsage() {
  process.stdout.write(
    [
      "Usage: github-warden audit [flags]",
      "",
      "Audit all repos declared in the governance config for security/correctness posture.",
      "Uses chant's audit engine (same checks as `chant audit`). Reads private repos",
      "using the warden App installation token.",
      "",
      "Flags:",
      "  --config <path>               Path to governance config file (YAML or JSON). Required.",
      "  --token-env <VAR>             Env var holding a pre-minted installation token.",
      "  --app-id-env <VAR>            Env var holding the GitHub App ID.",
      "  --installation-id-env <VAR>   Env var holding the installation ID.",
      "  --fail-on merge-worthy|any|none",
      "                                Exit 4 when findings exceed threshold (default: none).",
      "",
      "Auth: supply --token-env, or both --app-id-env and --installation-id-env.",
      "",
      "Exit codes:",
      "  0   Audit complete (within threshold or --fail-on none).",
      "  2   Argument or config error.",
      "  3   Runtime error.",
      "  4   Findings exceed --fail-on threshold.",
      "",
    ].join("\n"),
  );
}

/**
 * Public entry point for programmatic invocation.
 *
 * Accepts the raw argv array (everything after the binary name, i.e.
 * `process.argv.slice(2)`). Called by the committed bin launcher
 * `bin/github-warden.js` so that the launcher can `import` this module
 * and invoke the CLI without being the ESM `import.meta.url` entrypoint.
 */
export async function run(argv: string[]): Promise<void> {
  await main(argv);
}

// Run only when invoked as the CLI entrypoint, not when imported as a module
// (e.g. by the consistency test or the GitHub Action bundle).
// GITHUB_WARDEN_IS_ACTION=1 is injected at action-bundle build time so that
// this guard does not fire inside the action bundle.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath && !process.env["GITHUB_WARDEN_IS_ACTION"]) {
  main().catch((err: unknown) => {
    process.stderr.write(`github-warden: fatal: ${errMsg(err)}\n`);
    process.exit(3);
  });
}
