/**
 * Read a chant workspace's members through chant's read contract.
 *
 * The warden never parses chant.workspace.json itself. It runs
 * `chant workspace ls --json` and reads the document against contract 1
 * (INTENTIUS/chant docs: reference/workspace-read-contract). Contract 1 is
 * written by chant 0.81.0 and newer.
 */

import { execFile } from "node:child_process";

/** The contract version this reader knows. */
export const READ_CONTRACT = 1;

export interface WorkspaceMember {
  name: string;
  /** Relative to the workspace root, "/" separators, "." for the root member. */
  dir: string;
  kind: string;
  readable: boolean;
  /** Reason code when the member can't be read, else null. */
  reason: string | null;
}

export interface Workspace {
  name: string;
  /** The workspace root relative to the git root, "." for the git root itself. */
  root: string;
  /** The chant version that wrote the document. */
  chant: string;
  members: WorkspaceMember[];
}

export class WorkspaceReadError extends Error {
  constructor(message: string) {
    super(`[workspace] ${message}`);
    this.name = "WorkspaceReadError";
  }
}

/** Runs a command and resolves with its stdout, or rejects with the failure. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export const defaultRunner: CommandRunner = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(err);
        return;
      }
      const code = err ? ((err as { code?: number | string }).code as number | null) : 0;
      resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
    });
  });

/**
 * Parse one `chant workspace ls --json` document. Pure, so tests need no chant.
 * Throws WorkspaceReadError for a failure document, an unknown contract or a
 * document that is not an ls result.
 */
export function parseLsDocument(stdout: string): Workspace {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new WorkspaceReadError("`chant workspace ls --json` did not print JSON");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new WorkspaceReadError("`chant workspace ls --json` did not print an object");
  }
  const d = doc as Record<string, unknown>;
  if (d["contract"] !== READ_CONTRACT) {
    throw new WorkspaceReadError(
      `read contract ${String(d["contract"])} is not supported, this warden reads contract ${READ_CONTRACT}`,
    );
  }
  if (d["error"] && typeof d["error"] === "object") {
    const e = d["error"] as { code?: unknown; message?: unknown };
    throw new WorkspaceReadError(`chant could not read the workspace: ${String(e.code)}: ${String(e.message)}`);
  }
  const ws = d["workspace"] as Record<string, unknown> | undefined;
  if (!ws || typeof ws["name"] !== "string" || typeof ws["root"] !== "string" || !Array.isArray(d["members"])) {
    throw new WorkspaceReadError("`chant workspace ls --json` document lacks workspace or members");
  }
  const members: WorkspaceMember[] = (d["members"] as unknown[]).map((m, i) => {
    const o = m as Record<string, unknown>;
    if (!o || typeof o["name"] !== "string" || typeof o["dir"] !== "string") {
      throw new WorkspaceReadError(`members[${i}] lacks a name or a dir`);
    }
    return {
      name: o["name"],
      dir: o["dir"],
      kind: typeof o["kind"] === "string" ? o["kind"] : "other",
      readable: o["readable"] !== false,
      reason: typeof o["reason"] === "string" ? o["reason"] : null,
    };
  });
  return {
    name: ws["name"],
    root: ws["root"],
    chant: typeof d["chant"] === "string" ? d["chant"] : "unknown",
    members,
  };
}

/**
 * Run `chant workspace ls --json` in `dir` and return the workspace.
 * `npx --no-install` resolves the chant installed beside the warden.
 */
export async function readWorkspace(dir: string, run: CommandRunner = defaultRunner): Promise<Workspace> {
  let result;
  try {
    result = await run("npx", ["--no-install", "chant", "workspace", "ls", "--json"], dir);
  } catch (err) {
    throw new WorkspaceReadError(`could not run chant: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A failed read still prints a JSON failure document, with exit code 1.
  if (result.stdout.trim() === "") {
    throw new WorkspaceReadError(
      `\`chant workspace ls --json\` printed nothing (exit ${result.code}); chant 0.81.0 or newer is required. ${result.stderr.trim()}`.trim(),
    );
  }
  return parseLsDocument(result.stdout);
}
