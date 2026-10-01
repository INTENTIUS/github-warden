import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodeowners, parseOwnersConfig, OwnersConfigError } from "./codeowners.js";
import { readWorkspace, type Workspace } from "./members.js";

const ws = (root = "."): Workspace => ({
  name: "demo",
  root,
  chant: "0.100.0",
  members: [
    { name: "app", dir: ".", kind: "chant", readable: true, reason: null, generated: [] },
    { name: "api", dir: "packages/api", kind: "other", readable: true, reason: null, generated: [] },
    { name: "core", dir: "packages", kind: "other", readable: true, reason: null, generated: [] },
    { name: "gone", dir: "old", kind: "other", readable: false, reason: "dir-missing", generated: [] },
  ],
});

describe("parseOwnersConfig", () => {
  it("accepts users, teams and emails", () => {
    expect(parseOwnersConfig({ default: ["@a"], members: { api: ["@org/team", "x@y.io"] } })).toEqual({
      default: ["@a"],
      members: { api: ["@org/team", "x@y.io"] },
    });
  });
  it("rejects bad owners, empty lists and unknown keys", () => {
    expect(() => parseOwnersConfig({ members: { api: ["nobody"] } })).toThrow(OwnersConfigError);
    expect(() => parseOwnersConfig({ members: { api: [] } })).toThrow(/non-empty/);
    expect(() => parseOwnersConfig({ extra: 1 })).toThrow(/unknown key/);
    expect(() => parseOwnersConfig([])).toThrow(/expected an object/);
  });
});

describe("buildCodeowners", () => {
  it("emits one rule per declared member, shallow rules before nested ones", () => {
    const { text } = buildCodeowners(ws(), {
      default: ["@org/all"],
      members: { api: ["@org/api"], core: ["@org/core"], app: ["@org/app"] },
    });
    const rules = text.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(rules).toEqual(["* @org/all", "* @org/app", "/packages/ @org/core", "/packages/api/ @org/api"]);
  });

  it("prefixes the workspace root for a nested workspace", () => {
    const { text } = buildCodeowners(ws("infra"), { members: { api: ["@a"], app: ["@b"] } });
    expect(text).toContain("/infra/ @b\n");
    expect(text).toContain("/infra/packages/api/ @a\n");
  });

  it("skips a member whose directory is missing", () => {
    const r = buildCodeowners(ws(), { members: { gone: ["@a"] } });
    expect(r.skipped).toEqual([{ name: "gone", reason: "its directory does not exist" }]);
    expect(r.text).not.toContain("/old/");
  });

  it("fails on a member the workspace does not have", () => {
    expect(() => buildCodeowners(ws(), { members: { nope: ["@a"] } })).toThrow(/no member of that name/);
  });

  it("ends in a newline and names its source", () => {
    const { text } = buildCodeowners(ws(), {});
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('workspace "demo"');
  });
});

describe("against a real chant workspace", () => {
  it("reads members through `chant workspace ls --json`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warden-ws-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "packages/api"), { recursive: true });
    mkdirSync(join(dir, "docs"));
    writeFileSync(
      join(dir, "chant.workspace.json"),
      JSON.stringify({
        schema: 1,
        name: "demo",
        members: [
          { name: "api", kind: "other", dir: "packages/api", because: "the api" },
          { name: "docs", kind: "other", dir: "docs", because: "the docs" },
        ],
      }),
    );
    const real = await readWorkspace(dir);
    expect(real.members.map((m) => m.dir)).toEqual(["packages/api", "docs"]);
    const { text } = buildCodeowners(real, { members: { api: ["@org/api"], docs: ["@org/docs"] } });
    expect(text).toContain("/docs/ @org/docs\n");
    expect(text).toContain("/packages/api/ @org/api\n");
  }, 60_000);
});
