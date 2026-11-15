/**
 * `chant workspace drift --member` over this package's kind: a throwaway chant
 * workspace pins the package (its kinds file and schema, and the graph and
 * drift readers bundled the way `build:graph` and `build:drift` bundle them),
 * and chant's own `readWorkspaceDrift` imports the reader and reads a
 * forge-governance member. GitHub is a stubbed `fetch`; nothing leaves the
 * process.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, test, vi } from "vitest";
import { driftReadDocument, readWorkspaceDrift } from "@intentius/chant/workspace/drift-cli";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const banner = pkg.config.esm_require_banner as string;

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A chant workspace with one forge-governance member, `forge` in `org/`, and this package installed. */
async function workspace(policy: string): Promise<string> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "github-warden-ws-")));
  dirs.push(ws);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  };
  write(
    "chant.workspace.json",
    JSON.stringify({ name: "acme", schema: 1, pins: [{ package: pkg.name, version: pkg.version }], members: [{ name: "forge", dir: "org", kind: "forge-governance" }] }, null, 2),
  );
  write("org/governance.yml", policy);
  write(".gitignore", "node_modules\n");
  const installed = join(ws, "node_modules", ...pkg.name.split("/"));
  write(join("node_modules", ...pkg.name.split("/"), "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", exports: pkg.exports }));
  cpSync(join(root, "workspace-kinds.json"), join(installed, "workspace-kinds.json"));
  cpSync(join(root, "schemas"), join(installed, "schemas"), { recursive: true });
  const bundle = (entry: string, outfile: string) =>
    build({
      entryPoints: [join(root, entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      banner: { js: banner },
      external: ["@intentius/tsad-reference"],
      outfile: join(installed, outfile),
      logLevel: "silent",
    });
  await bundle("src/graph/entry.ts", "dist/graph-reader.mjs");
  await bundle("src/drift/entry.ts", "dist/drift-reader.mjs");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}

/** GitHub, as a fetch: the routes given, an empty page for any other list, a 404 otherwise. */
function github(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    if (method !== "GET") return new Response("the drift reader wrote", { status: 500 });
    const key = `${u.pathname}${u.search}`;
    if (key in routes) return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
    if (u.searchParams.has("per_page")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
}

const POLICY = `orgs:
  acme:
    repos:
      api:
        hasWiki: false
`;

describe("chant workspace drift over the forge-governance kind", () => {
  test("reports drift for a policy GitHub differs from, and none for one it matches", async () => {
    vi.stubEnv("GH_TOKEN", "t0ken");
    vi.stubEnv("GITHUB_API_URL", "");
    const ws = await workspace(POLICY);

    vi.stubGlobal("fetch", github({ "/repos/acme/api": { name: "api", has_wiki: true } }));
    const drifted = await readWorkspaceDrift({ cwd: ws, member: "forge" });
    if ("error" in drifted) throw new Error(`${drifted.error.code}: ${drifted.error.message}`);
    const doc = driftReadDocument("forge", drifted);
    expect(doc.records.filter((r) => r.status !== "in-sync").map((r) => [r.member, r.engine, r.address, r.status, r.node])).toEqual([
      ["forge", "warden", "repo/acme/api", "drifted", "forge/repo/acme/api"],
    ]);

    vi.stubGlobal("fetch", github({ "/repos/acme/api": { name: "api", has_wiki: false } }));
    const clean = await readWorkspaceDrift({ cwd: ws, member: "forge" });
    if ("error" in clean) throw new Error(`${clean.error.code}: ${clean.error.message}`);
    const cleanDoc = driftReadDocument("forge", clean);
    expect(cleanDoc.records.map((r) => [r.address, r.status, r.node])).toEqual([
      ["org/acme", "in-sync", "forge/org/acme"],
      ["repo/acme/api", "in-sync", "forge/repo/acme/api"],
    ]);
  }, 30_000);

  test("answers no-drift-read when the token variable is unset", async () => {
    vi.stubEnv("GH_TOKEN", "");
    const ws = await workspace(POLICY);
    const answer = await readWorkspaceDrift({ cwd: ws, member: "forge" });
    expect("error" in answer && answer.error.code).toBe("no-drift-read");
  }, 30_000);
});
