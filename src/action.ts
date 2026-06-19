/**
 * GitHub Actions entry point for github-warden.
 *
 * Reads inputs from the Actions environment (INPUT_<UPPERCASED-NAME>), maps
 * them to CLI argv, and calls the exported run() from src/cli.ts.
 *
 * Auth: the private-key input is passed directly through the
 * GOVERNANCE_APP_PRIVATE_KEY env var so the existing CLI auth code picks it up
 * without modification.
 *
 * Exit codes propagate from run() exactly as they do from the CLI:
 *   0  success
 *   1  guardrail block
 *   2  arg / config error
 *   3  runtime error
 *   4  audit findings exceed --fail-on threshold
 */

import { run } from "./cli.js";

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/**
 * Read a required Actions input.  Throws with a clear message if the input is
 * absent or empty so users see "Input 'foo' is required" rather than a
 * cryptic downstream crash.
 */
function requiredInput(name: string): string {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const val = process.env[key]?.trim();
  if (!val) {
    process.stderr.write(`github-warden action: input '${name}' is required but was not set\n`);
    process.exit(2);
  }
  return val;
}

/**
 * Read an optional Actions input. Returns undefined when the input is absent
 * or empty.
 */
function optionalInput(name: string): string | undefined {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const val = process.env[key]?.trim();
  return val || undefined;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Collect inputs.
  const command = optionalInput("command") ?? "reconcile";
  const config = requiredInput("config");
  const appId = requiredInput("app-id");
  const installationId = requiredInput("installation-id");
  const privateKey = requiredInput("private-key");

  const mode = optionalInput("mode") ?? "dry-run";
  const cycles = optionalInput("cycles");
  const failOn = optionalInput("fail-on");
  const allowGuardrailOverride = optionalInput("allow-guardrail-override");

  // Validate command early for a clear error message.
  if (command !== "reconcile" && command !== "audit") {
    process.stderr.write(
      `github-warden action: input 'command' must be 'reconcile' or 'audit', got: ${command}\n`,
    );
    process.exit(2);
  }

  // Inject the private key into the environment variable that the CLI auth
  // code already reads.  This avoids any PEM handling in the action layer and
  // keeps the surface area minimal.
  process.env["GOVERNANCE_APP_PRIVATE_KEY"] = privateKey;

  // Use fixed, known env var names for app-id and installation-id so the
  // action doesn't expose internal naming to users.
  process.env["WARDEN_ACTION_APP_ID"] = appId;
  process.env["WARDEN_ACTION_INSTALLATION_ID"] = installationId;

  // Build argv, mirroring how the CLI is invoked from the shell.
  const argv: string[] = [command];

  argv.push("--config", config);
  argv.push("--app-id-env", "WARDEN_ACTION_APP_ID");
  argv.push("--installation-id-env", "WARDEN_ACTION_INSTALLATION_ID");

  if (command === "reconcile") {
    argv.push("--mode", mode);
    if (cycles) argv.push("--cycles", cycles);
    if (allowGuardrailOverride === "true") argv.push("--allow-guardrail-override");
  }

  if (command === "audit") {
    if (failOn) argv.push("--fail-on", failOn);
  }

  await run(argv);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `github-warden action: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(3);
});
