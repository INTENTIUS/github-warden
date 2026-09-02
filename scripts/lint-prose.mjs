#!/usr/bin/env node
// Prose lint via the `sentences` package's de-stink engine.
// Gate: fails on any finding of severity "high" or "medium"; low/candidate are advisory.
import { readFileSync } from "node:fs";
import { RULES } from "sentences/lint/registry";
import { runRules } from "sentences/lint/engine";
import { buildDocAnalysis } from "sentences/lint/build-doc";
import { buildReport } from "sentences/lint/report";
import { extractProse } from "sentences/lint/markdown-prose";

let gate = 0;
for (const file of process.argv.slice(2)) {
  const raw = readFileSync(file, "utf8");
  const text = file.endsWith(".md") ? extractProse(raw) : raw;
  const doc = buildDocAnalysis(text);
  const { findings, errors } = runRules(RULES, doc);
  const report = buildReport(text, findings, errors, RULES);
  const blocking = report.findings.filter((f) => f.severity === "high" || f.severity === "medium");
  gate += blocking.length;
  console.log(`${file}: ${report.counts.findings} findings (${blocking.length} blocking), stink ${report.score.total.toFixed(1)}`);
  for (const f of report.findings) {
    const snippet = text.slice(f.span.start, f.span.end).replace(/\s+/g, " ").slice(0, 60);
    console.log(`  [${f.severity}] ${f.ruleId}: ${f.message} :: "${snippet}"`);
  }
  for (const e of report.errors) console.log(`  rule error ${e.ruleId}: ${e.message}`);
}
process.exit(gate > 0 ? 1 : 0);
