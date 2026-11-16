// Runs `chant audit .` and fails on merge-worthy findings, like
// `chant audit . --fail-on merge-worthy`, except the ones listed in KNOWN.
//
// KNOWN holds findings in files chant generates that can't be fixed from this
// repo. Each entry names the chant issue that fixes it; drop the entry once a
// chant release with the fix is in package.json.
import { spawnSync } from "node:child_process";

const KNOWN = [
  // The release workflow chant renders grants contents/id-token write at the
  // workflow level and sets no job permissions (INTENTIUS/chant#5234).
  { checkId: "GHA013", file: ".github/workflows/publish.yml" },
  { checkId: "GHA034", file: ".github/workflows/publish.yml" },
];

const human = spawnSync("npx", ["chant", "audit", "."], { stdio: "inherit" });
if (human.status !== 0) process.exit(human.status ?? 1);

const run = spawnSync("npx", ["chant", "audit", ".", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}
const { findings } = JSON.parse(run.stdout);
const known = (f) => KNOWN.some((k) => k.checkId === f.checkId && k.file === f.file);
const blocking = findings.filter((f) => f.tier === "merge-worthy" && !known(f));
const excused = findings.filter((f) => f.tier === "merge-worthy" && known(f));

for (const f of excused) {
  console.log(`known, not failing: [${f.checkId}] ${f.file}${f.entity ? ` (${f.entity})` : ""}`);
}
if (blocking.length > 0) {
  for (const f of blocking) {
    console.error(`merge-worthy: [${f.checkId}] ${f.file}${f.entity ? ` (${f.entity})` : ""}: ${f.message}`);
  }
  process.exit(1);
}
