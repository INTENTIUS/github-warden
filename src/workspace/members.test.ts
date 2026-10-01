import { describe, it, expect } from "vitest";
import { chantLauncher, parseLsDocument, readWorkspace, WorkspaceReadError, type CommandRunner } from "./members.js";

const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    $schema: "https://intentius.io/chant/schemas/workspace/ls/v1/ls.schema.json",
    contract: 1,
    chant: "0.100.0",
    at: null,
    workspace: { name: "demo", root: "sub", file: "chant.workspace.json", schema: 1, minReader: null, pins: [] },
    members: [
      { name: "api", dir: "packages/api", kind: "other", roles: [], readable: true, reason: null },
      { name: "gone", dir: "old", kind: "other", roles: [], readable: false, reason: "dir-missing" },
    ],
    groups: [],
    diagrams: [],
    summary: { members: 2, unreadable: 1, groups: 0, matches: 0 },
    ...over,
  });

describe("parseLsDocument", () => {
  it("reads members, root and chant version", () => {
    const ws = parseLsDocument(doc());
    expect(ws.name).toBe("demo");
    expect(ws.root).toBe("sub");
    expect(ws.chant).toBe("0.100.0");
    expect(ws.members).toEqual([
      { name: "api", dir: "packages/api", kind: "other", readable: true, reason: null },
      { name: "gone", dir: "old", kind: "other", readable: false, reason: "dir-missing" },
    ]);
  });

  it("refuses a contract it does not know", () => {
    expect(() => parseLsDocument(doc({ contract: 2 }))).toThrow(/contract 2 is not supported/);
  });

  it("reports a failure document", () => {
    const failure = JSON.stringify({ contract: 1, chant: "0.100.0", error: { code: "declaration-missing", message: "none" } });
    expect(() => parseLsDocument(failure)).toThrow(/declaration-missing: none/);
  });

  it("refuses output that is not JSON or lacks members", () => {
    expect(() => parseLsDocument("nope")).toThrow(WorkspaceReadError);
    expect(() => parseLsDocument(doc({ members: undefined }))).toThrow(/lacks workspace or members/);
  });
});

describe("readWorkspace", () => {
  it("runs chant workspace ls --json in the directory", async () => {
    const calls: unknown[] = [];
    const run: CommandRunner = async (cmd, args, cwd) => {
      calls.push([cmd, args, cwd]);
      return { stdout: doc(), stderr: "", code: 0 };
    };
    const ws = await readWorkspace("/repo", run);
    expect(ws.members).toHaveLength(2);
    expect(calls).toEqual([[chantLauncher(), ["workspace", "ls", "--json"], "/repo"]]);
    expect(chantLauncher()).toMatch(/@intentius\/chant\/bin\/chant$/);
  });

  it("names the chant floor when chant prints nothing", async () => {
    const run: CommandRunner = async () => ({ stdout: "", stderr: "unknown command", code: 1 });
    await expect(readWorkspace("/repo", run)).rejects.toThrow(/0\.81\.0 or newer/);
  });

  it("wraps a spawn failure", async () => {
    const run: CommandRunner = async () => {
      throw new Error("spawn npx ENOENT");
    };
    await expect(readWorkspace("/repo", run)).rejects.toThrow(/could not run chant/);
  });
});
