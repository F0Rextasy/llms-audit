import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_BOTS,
  AuditError,
  auditSite,
  botsDisallowedBy,
  checkH1,
  checkHttps,
  checkJsonLd,
  checkLlmsFull,
  checkLlmsTxt,
  checkMeta,
  checkRobots,
  checkSitemap,
  generateLlmsTemplate,
  normalizeUrl,
  siteNameFromUrl,
} from "../src/audit";
import { formatHuman, renderHtml } from "../src/report";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli.ts");

describe("normalizeUrl", () => {
  test("adds https when scheme missing", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });
  test("keeps explicit scheme", () => {
    expect(normalizeUrl("http://a.test/x")).toBe("http://a.test/x");
  });
  test("rejects empty and garbage", () => {
    expect(() => normalizeUrl("")).toThrow(AuditError);
    expect(() => normalizeUrl("http://")).toThrow(AuditError);
  });
});

describe("checkLlmsTxt", () => {
  test("missing/empty/bad heading/no sections fail", () => {
    expect(checkLlmsTxt(null).status).toBe("FAIL");
    expect(checkLlmsTxt("").status).toBe("FAIL");
    expect(checkLlmsTxt("no heading\n## S").status).toBe("FAIL");
    expect(checkLlmsTxt("# Site\nno section").status).toBe("FAIL");
  });
  test("valid file passes with full weight", () => {
    const c = checkLlmsTxt("# Site\n> sum\n\n## Docs\n- x");
    expect(c.status).toBe("PASS");
    expect(c.earned).toBe(20);
  });
});

describe("checkLlmsFull", () => {
  test("absent warns, content passes", () => {
    expect(checkLlmsFull(null).status).toBe("WARN");
    expect(checkLlmsFull(null).earned).toBe(0);
    expect(checkLlmsFull("body").status).toBe("PASS");
    expect(checkLlmsFull("body").earned).toBe(5);
  });
});

describe("checkSitemap", () => {
  test("missing, no blocks, no loc fail; valid passes", () => {
    expect(checkSitemap(null).status).toBe("FAIL");
    expect(checkSitemap("<urlset></urlset>").status).toBe("FAIL");
    expect(checkSitemap("<url><notloc/></url>").status).toBe("FAIL");
    const c = checkSitemap("<url><loc>https://a/</loc></url>");
    expect(c.status).toBe("PASS");
    expect(c.earned).toBe(15);
  });
});

describe("robots parsing", () => {
  test("specific group blocks its bot only", () => {
    const text = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(botsDisallowedBy(text, AI_BOTS)).toEqual(["GPTBot"]);
  });
  test("wildcard full disallow blocks everyone", () => {
    const text = "User-agent: *\nDisallow: /\n";
    expect(botsDisallowedBy(text, AI_BOTS).length).toBe(AI_BOTS.length);
  });
  test("partial path disallow does not block", () => {
    const text = "User-agent: *\nDisallow: /private\n";
    expect(botsDisallowedBy(text, AI_BOTS)).toEqual([]);
  });
  test("checkRobots: null passes, blocked fails with bot names", () => {
    expect(checkRobots(null).status).toBe("PASS");
    const bad = checkRobots("User-agent: ClaudeBot\nDisallow: /\n");
    expect(bad.status).toBe("FAIL");
    expect(bad.detail).toContain("ClaudeBot");
    expect(bad.earned).toBe(0);
  });
});

describe("checkJsonLd", () => {
  test("no blocks fail, malformed fail, unknown type warns, known passes", () => {
    expect(checkJsonLd("<html></html>").status).toBe("FAIL");
    expect(checkJsonLd('<script type="application/ld+json">{oops</script>').status).toBe("FAIL");
    expect(checkJsonLd('<script type="application/ld+json">{"@type":"Recipe"}</script>').status).toBe("WARN");
    expect(checkJsonLd('<script type="application/ld+json">{"@type":"WebSite"}</script>').status).toBe("PASS");
    expect(checkJsonLd('<script type="application/ld+json">{"@graph":[{"@type":"Organization"}]}</script>').status).toBe("PASS");
  });
});

describe("checkMeta / checkH1 / checkHttps", () => {
  test("meta lists exactly what is missing", () => {
    expect(checkMeta("<html><head></head></html>").detail).toContain("<title>");
    const ok = checkMeta('<title>T</title><meta name="description" content="D"><link rel="canonical" href="https://a/">');
    expect(ok.status).toBe("PASS");
    expect(ok.earned).toBe(10);
  });
  test("h1 with tags stripped", () => {
    expect(checkH1("<html></html>").status).toBe("FAIL");
    expect(checkH1("<h1>  </h1>").status).toBe("FAIL");
    expect(checkH1("<h1>Hello <b>x</b></h1>").status).toBe("PASS");
  });
  test("https check branches", () => {
    expect(checkHttps("http://a/", 200, false).status).toBe("FAIL");
    expect(checkHttps("https://a/", 200, false).status).toBe("PASS");
    expect(checkHttps("https://a/", 500, false).status).toBe("FAIL");
    expect(checkHttps("https://a/", 200, true).status).toBe("FAIL");
    expect(checkHttps("https://a/", 200, false).earned).toBe(15);
  });
});

describe("templates", () => {
  test("llms template starts with heading and has a section", () => {
    const t = generateLlmsTemplate("Acme", "https://acme.test");
    expect(t.startsWith("# Acme")).toBe(true);
    expect(t).toContain("## Products");
  });
  test("siteNameFromUrl strips www and capitalizes", () => {
    expect(siteNameFromUrl("https://www.acme.test/x")).toBe("Acme");
  });
});

function serve(html: string, routes: Record<string, string> = {}) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (path in routes) return new Response(routes[path]!);
      return new Response("nope", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    close: () => server.stop(true),
  };
}

const UNREADY_HTML = "<html><head></head><body><h1>Acme</h1></body></html>";
const READY_HTML = `<html><head>
<title>Acme</title>
<meta name="description" content="D">
<link rel="canonical" href="https://a/">
<script type="application/ld+json">{"@type":"WebSite"}</script>
</head><body><h1>Acme</h1></body></html>`;

describe("auditSite integration", () => {
  test("unready site scores5/100 with correct check ids", async () => {
    const s = serve(UNREADY_HTML, { "/robots.txt": "User-agent: GPTBot\nDisallow: /\n" });
    try {
      const r = await auditSite(s.url, { timeoutMs: 3000 });
      expect(r.score).toBe(5);
      expect(r.maxScore).toBe(100);
      expect(r.checks.map((c) => c.id)).toEqual([
        "llms_txt", "llms_full", "sitemap", "robots", "jsonld", "meta", "h1", "https",
      ]);
      expect(r.tool).toBe("llms-audit");
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      s.close();
    }
  });

  test("ready site over http scores85 (only https fails)", async () => {
    const s = serve(READY_HTML, {
      "/llms.txt": "# Acme\n> s\n\n## Docs\n- x",
      "/llms-full.txt": "full",
      "/sitemap.xml": "<url><loc>https://a/</loc></url>",
      "/robots.txt": "User-agent: *\nAllow: /\n",
    });
    try {
      const r = await auditSite(s.url, { timeoutMs: 3000 });
      expect(r.score).toBe(85);
      const https = r.checks.find((c) => c.id === "https")!;
      expect(https.status).toBe("FAIL");
      expect(https.detail).toContain("final URL");
    } finally {
      s.close();
    }
  });

  test("unreachable homepage throws AuditError", async () => {
    await expect(auditSite("http://127.0.0.1:1/", { timeoutMs: 1000 })).rejects.toThrow(AuditError);
  });
});

describe("report rendering", () => {
  const report = {
    tool: "llms-audit", version: "0.1.0", url: "https://a/", finalUrl: "https://a/",
    score: 85, maxScore: 100,
    checks: [
      { id: "h1", name: "<h1>", status: "PASS" as const, weight: 5, earned: 5, fix: "none" },
      { id: "meta", name: "meta tags", status: "FAIL" as const, weight: 10, earned: 0, fix: "Add <title> & <meta>", detail: "missing: <title>" },
    ],
    generatedAt: "2026-09-25T00:00:00Z",
  };
  test("formatHuman has score line and table", () => {
    const out = formatHuman(report);
    expect(out).toContain("score 85/100");
    expect(out).toContain("FAIL");
    expect(out).toContain("Add <title> & <meta>");
  });
  test("renderHtml escapes markup and carries rows", () => {
    const html = renderHtml(report);
    expect(html).toContain("score 85/100");
    expect(html).toContain('<td class="FAIL">FAIL</td>');
    expect(html).not.toContain("<title> & <meta>");
    expect(html).toContain("&lt;title&gt;");
  });
});

describe("CLI", () => {
  const s = serve(READY_HTML, { "/llms.txt": "# Acme\n> s\n\n## Docs\n- x" });
  afterAll(() => s.close());

  async function runCli(...args: string[]) {
    const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const status = await p.exited;
    return { status, stdout, stderr };
  }

  test("--json prints a parseable report", async () => {
    const p = await runCli(s.url, "--json");
    expect(p.status).toBe(0);
    const data = JSON.parse(p.stdout);
    expect(data.tool).toBe("llms-audit");
    expect(data.score).toBeGreaterThanOrEqual(0);
    expect(data.checks.length).toBe(8);
  });

  test("--out writes a self-contained html report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llms-audit-"));
    const out = join(dir, "report.html");
    const p = await runCli(s.url, "--out", out);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("wrote");
    const html = readFileSync(out, "utf8");
    expect(html).toContain("llms-audit report");
    expect(html).toContain("score ");
  });

  test("--fix-llms prints a template for the given host", async () => {
    const p = await runCli("https://acme.test", "--fix-llms");
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("# Acme");
    expect(p.stdout).toContain("## Products");
  });

  test("no args → usage, exit 1; bad URL → exit 2", async () => {
    const a = await runCli();
    expect(a.status).toBe(1);
    expect(a.stderr).toContain("usage: llms-audit");
    const b = await runCli("http://127.0.0.1:1/", "--timeout", "1000");
    expect(b.status).toBe(2);
    expect(b.stderr).toContain("homepage unreachable");
  });

  test("unknown flag → exit 1", async () => {
    const p = await runCli("--bogus");
    expect(p.status).toBe(1);
    expect(p.stderr).toContain("unknown flag");
  });
});

describe("MCP stdio server", () => {
  test("initialize + tools/list + tools/call", async () => {
    const s = serve(READY_HTML, { "/llms.txt": "# Acme\n> s\n\n## Docs\n- x" });
    try {
      const proc = Bun.spawn(["bun", CLI, "--mcp"], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "audit_url", arguments: { url: s.url } } });

      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      let buf = "";
      const deadline = Date.now() + 15000;
      const responses: Record<number, any> = {};
      while (Date.now() < deadline && (responses[1] === undefined || responses[2] === undefined || responses[3] === undefined)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") responses[msg.id] = msg;
        }
      }
      proc.kill();
      expect(responses[1]?.result?.serverInfo?.name).toBe("llms-audit");
      expect(responses[2]?.result?.tools?.[0]?.name).toBe("audit_url");
      const call = responses[3]?.result;
      expect(call?.isError).toBeFalsy();
      expect(call?.content?.[0]?.text).toContain('"score"');
    } finally {
      s.close();
    }
  }, 25000);
});
