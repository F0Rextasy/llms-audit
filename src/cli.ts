#!/usr/bin/env bun
import { AuditError, DEFAULT_TIMEOUT_MS, auditSite, generateLlmsTemplate, normalizeUrl, siteNameFromUrl } from "./audit.js";
import { runMcp } from "./mcp.js";
import { formatHuman, renderHtml } from "./report.js";

function usage(): string {
  return `usage: llms-audit <url> [--json] [--out report.html] [--timeout ms] [--fix-llms]
       llms-audit --mcp`;
}

function parseArgs(argv: string[]): { url?: string; json: boolean; out?: string; timeoutMs: number; fixLlms: boolean; mcp: boolean; error?: string } {
  let url: string | undefined;
  let json = false;
  let out: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let fixLlms = false;
  let mcp = false;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--fix-llms") fixLlms = true;
    else if (a === "--mcp") mcp = true;
    else if (a === "--out") {
      const v = args[++i];
      if (!v) return { json, timeoutMs, fixLlms, mcp, error: "--out requires a file path" };
      out = v;
    } else if (a === "--timeout") {
      const v = args[++i];
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n <= 0) return { json, timeoutMs, fixLlms, mcp, error: "--timeout requires a positive number of ms" };
      timeoutMs = Math.floor(n);
    } else if (a === "--help" || a === "-h") return { json, timeoutMs, fixLlms, mcp, error: usage() };
    else if (a.startsWith("-")) return { json, timeoutMs, fixLlms, mcp, error: `unknown flag: ${a}\n${usage()}` };
    else if (!url) url = a;
    else return { json, timeoutMs, fixLlms, mcp, error: `unexpected argument: ${a}\n${usage()}` };
  }
  return { url, json, out, timeoutMs, fixLlms, mcp };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.error) {
    console.error(opts.error);
    process.exit(1);
  }
  if (opts.mcp) {
    await runMcp();
    return;
  }
  if (!opts.url) {
    console.error(usage());
    process.exit(1);
  }
  if (opts.fixLlms) {
    let origin = "https://example.com";
    try {
      origin = new URL(normalizeUrl(opts.url)).origin;
    } catch {
      // keep default origin
    }
    process.stdout.write(generateLlmsTemplate(siteNameFromUrl(normalizeUrlSafe(opts.url) ?? origin), origin));
    return;
  }
  let report;
  try {
    report = await auditSite(opts.url, { timeoutMs: opts.timeoutMs });
  } catch (err) {
    const msg = err instanceof AuditError ? err.message : err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    process.exit(2);
  }
  if (opts.out) {
    await Bun.write(opts.out, renderHtml(report));
    if (!opts.json) console.log(`wrote ${opts.out}`);
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHuman(report));
  }
}

function normalizeUrlSafe(raw: string): string | null {
  try {
    return normalizeUrl(raw);
  } catch {
    return null;
  }
}

await main();
