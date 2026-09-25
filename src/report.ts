import type { AuditReport, CheckResult } from "./audit";

function statusGlyph(s: CheckResult["status"]): string {
  if (s === "PASS") return "PASS";
  if (s === "FAIL") return "FAIL";
  return "WARN";
}

export function formatTable(report: AuditReport): string {
  const rows = report.checks.map((c) => ({
    check: c.name,
    status: statusGlyph(c.status),
    fix: c.status === "PASS" ? "-" : c.fix,
  }));
  const wCheck = Math.max("check".length, ...rows.map((r) => r.check.length));
  const wStatus = Math.max("status".length, ...rows.map((r) => r.status.length));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const lines = [
    `${pad("check", wCheck)}  ${pad("status", wStatus)}  fix`,
    `${"-".repeat(wCheck)}  ${"-".repeat(wStatus)}  ---`,
  ];
  for (const r of rows) lines.push(`${pad(r.check, wCheck)}  ${pad(r.status, wStatus)}  ${r.fix}`);
  return lines.join("\n");
}

/** Human-readable terminal output: score line + table. */
export function formatHuman(report: AuditReport): string {
  return `score ${report.score}/${report.maxScore} — ${report.finalUrl}\n${formatTable(report)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = [
  "body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;max-width:960px;margin:2rem auto;padding:0 1rem}",
  "h1{font-size:1.4rem}",
  ".score{font-size:2rem;font-weight:700}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{border:1px solid #30363d;padding:.4rem .6rem;text-align:left;vertical-align:top}",
  ".PASS{color:#7ee787;font-weight:700}.FAIL{color:#ff7b72;font-weight:700}.WARN{color:#e3b341;font-weight:700}",
  ".meta{color:#8b949e;font-size:.85rem}",
].join("");

/** Self-contained HTML report with inline CSS. */
export function renderHtml(report: AuditReport): string {
  const rows = report.checks
    .map(
      (c) =>
        `<tr><td>${esc(c.name)}</td><td class="${c.status}">${c.status}</td><td>${esc(c.status === "PASS" ? "-" : c.fix)}${c.detail ? `<br><span class="meta">${esc(c.detail)}</span>` : ""}</td></tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llms-audit report — ${esc(report.finalUrl)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>llms-audit report</h1>
<p class="meta">${esc(report.finalUrl)} · ${esc(report.generatedAt)} · llms-audit v${esc(report.version)}</p>
<p class="score">score ${report.score}/${report.maxScore}</p>
<table>
<thead><tr><th>check</th><th>status</th><th>fix</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
