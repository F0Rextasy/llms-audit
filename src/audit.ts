export const VERSION = "0.1.0";
export const MAX_SCORE = 100;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** AI answer-engine crawlers whose access is checked in robots.txt. */
export const AI_BOTS = ["GPTBot", "ClaudeBot", "Claude-Web", "Perplexity-Bot", "Google-Extended"] as const;

export type CheckStatus = "PASS" | "FAIL" | "WARN";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  weight: number;
  earned: number;
  fix: string;
  detail?: string;
}

export interface AuditReport {
  tool: "llms-audit";
  version: string;
  url: string;
  finalUrl: string;
  score: number;
  maxScore: number;
  checks: CheckResult[];
  generatedAt: string;
}

export class AuditError extends Error {}

/** Add https:// when the user omits a scheme; throw AuditError on garbage. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new AuditError("empty URL");
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new AuditError(`invalid URL: ${raw}`);
  }
}

interface Fetched {
  status: number;
  url: string;
  text: string;
}

async function get(url: string, timeoutMs: number): Promise<Fetched> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": `llms-audit/${VERSION}` },
    });
    const text = await res.text();
    return { status: res.status, url: res.url || url, text };
  } catch (err) {
    if (err instanceof AuditError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuditError(`fetch failed for ${url}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getOptional(url: string, timeoutMs: number): Promise<Fetched | null> {
  try {
    return await get(url, timeoutMs);
  } catch {
    return null;
  }
}

function makeCheck(
  id: string,
  name: string,
  weight: number,
  status: CheckStatus,
  fix: string,
  detail?: string,
): CheckResult {
  return { id, name, status, weight, earned: status === "PASS" ? weight : 0, fix, detail };
}

/** 1. llms.txt — non-empty, first non-blank line `# <site>`, >= 1 `## ` section. */
export function checkLlmsTxt(text: string | null): CheckResult {
  const fix = "Create /llms.txt: first line `# <site name>`, then at least one `## ` section (run with --fix-llms for a template)";
  if (text === null) return makeCheck("llms_txt", "llms.txt", 20, "FAIL", fix, "HTTP error or missing");
  if (!text.trim()) return makeCheck("llms_txt", "llms.txt", 20, "FAIL", fix, "empty file");
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  if (!first.startsWith("# "))
    return makeCheck("llms_txt", "llms.txt", 20, "FAIL", "Start /llms.txt with `# <site name>` as the first line", `first line: ${JSON.stringify(first.slice(0, 60))}`);
  const sections = lines.filter((l) => l.startsWith("## ")).length;
  if (sections < 1)
    return makeCheck("llms_txt", "llms.txt", 20, "FAIL", "Add at least one `## ` section to /llms.txt", "no `## ` sections");
  return makeCheck("llms_txt", "llms.txt", 20, "PASS", "none", `${sections} \`## \` section(s)`);
}

/** 2. llms-full.txt — WARN when absent (weight 5, advisory). */
export function checkLlmsFull(text: string | null): CheckResult {
  if (text !== null && text.trim())
    return makeCheck("llms_full", "llms-full.txt", 5, "PASS", "none", `${text.trim().length} chars`);
  return makeCheck(
    "llms_full",
    "llms-full.txt",
    5,
    "WARN",
    "Publish full context at /llms-full.txt (concatenated markdown of key pages)",
    text === null ? "HTTP error or missing" : "empty file",
  );
}

/** 3. sitemap.xml — parses with >= 1 well-formed <url> entry containing <loc>. */
export function checkSitemap(text: string | null): CheckResult {
  const fix = "Publish /sitemap.xml with at least one well-formed <url> entry containing <loc>";
  if (text === null) return makeCheck("sitemap", "sitemap.xml", 15, "FAIL", fix, "HTTP error or missing");
  const blocks = text.match(/<url\b[^>]*>[\s\S]*?<\/url\s*>/gi) ?? [];
  const wellFormed = blocks.filter((b) => /<loc\b[^>]*>[\s\S]*?<\/loc\s*>/i.test(b));
  if (wellFormed.length < 1)
    return makeCheck("sitemap", "sitemap.xml", 15, "FAIL", fix, `${blocks.length} <url> block(s), 0 with <loc>`);
  return makeCheck("sitemap", "sitemap.xml", 15, "PASS", "none", `${wellFormed.length} <url> entr(y/ies)`);
}

interface RobotsGroup {
  agents: string[];
  disallows: string[];
}

/** Bots from `bots` whose effective robots rules contain a full `Disallow: /`. */
export function botsDisallowedBy(robotsText: string, bots: readonly string[]): string[] {
  const groups: RobotsGroup[] = [];
  let lastWasUA = false;
  for (const raw of robotsText.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const m = line.match(/^([^:]+)\s*:\s*(.*)$/);
    if (!m) {
      lastWasUA = false;
      continue;
    }
    const field = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      const agent = value.toLowerCase();
      if (lastWasUA && groups.length > 0) groups[groups.length - 1]!.agents.push(agent);
      else groups.push({ agents: [agent], disallows: [] });
      lastWasUA = true;
    } else if (field === "disallow") {
      lastWasUA = false;
      if (groups.length > 0) groups[groups.length - 1]!.disallows.push(value);
    } else {
      lastWasUA = false;
    }
  }
  const blocked: string[] = [];
  for (const bot of bots) {
    const lower = bot.toLowerCase();
    const specific = groups.filter((g) => g.agents.includes(lower));
    const effective = (specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*")))
      .flatMap((g) => g.disallows)
      .map((d) => d.trim());
    if (effective.some((d) => d === "/")) blocked.push(bot);
  }
  return blocked;
}

/** 4. robots.txt — every AI bot must be allowed (no full disallow). */
export function checkRobots(text: string | null): CheckResult {
  if (text === null)
    return makeCheck("robots", "robots.txt", 15, "PASS", "none", "no robots.txt (all bots allowed)");
  const blocked = botsDisallowedBy(text, AI_BOTS);
  if (blocked.length > 0)
    return makeCheck(
      "robots",
      "robots.txt",
      15,
      "FAIL",
      `Allow ${blocked.join(", ")} in robots.txt (remove \`Disallow: /\` for ${blocked.join(", ")})`,
      `blocked: ${blocked.join(", ")}`,
    );
  return makeCheck("robots", "robots.txt", 15, "PASS", "none", "all AI bots allowed");
}

const KNOWN_TYPES = new Set(["Organization", "WebSite", "WebPage", "Article"]);

function collectTypes(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.push(x);
    if (Array.isArray(obj["@graph"])) collectTypes(obj["@graph"], out);
  }
}

/** Extract raw JSON-LD script bodies from HTML. */
export function extractJsonLd(html: string): { raw: string[]; parsed: unknown[]; errors: number } {
  const raw: string[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) raw.push(m[1] ?? "");
  const parsed: unknown[] = [];
  let errors = 0;
  for (const body of raw) {
    try {
      parsed.push(JSON.parse(body.trim()));
    } catch {
      errors++;
    }
  }
  return { raw, parsed, errors };
}

/** 5. JSON-LD — at least one block parses; WARN without a known @type. */
export function checkJsonLd(html: string): CheckResult {
  const { raw, parsed, errors } = extractJsonLd(html);
  if (raw.length === 0)
    return makeCheck(
      "jsonld",
      "JSON-LD",
      15,
      "FAIL",
      'Add <script type="application/ld+json"> with @type Organization/WebSite/WebPage/Article',
      "no JSON-LD blocks",
    );
  if (parsed.length === 0)
    return makeCheck("jsonld", "JSON-LD", 15, "FAIL", "Fix malformed JSON-LD: every block must be valid JSON", `${errors} block(s) unparseable`);
  const types: string[] = [];
  for (const doc of parsed) collectTypes(doc, types);
  const known = types.filter((t) => KNOWN_TYPES.has(t));
  if (known.length === 0)
    return makeCheck(
      "jsonld",
      "JSON-LD",
      15,
      "WARN",
      "Add @type Organization/WebSite/WebPage/Article to your JSON-LD",
      `found @type(s): ${types.length > 0 ? [...new Set(types)].join(", ") : "(none)"}`,
    );
  return makeCheck("jsonld", "JSON-LD", 15, "PASS", "none", `found @type(s): ${[...new Set(known)].join(", ")}`);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1]!.trim() : null;
}

/** 6. <title> + meta description + canonical. */
export function checkMeta(html: string): CheckResult {
  const missing: string[] = [];
  const titleM = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!titleM || !titleM[1]!.trim()) missing.push("<title>");
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const descTag = metaTags.find((t) => (attr(t, "name") ?? "").toLowerCase() === "description");
  if (!descTag || !attr(descTag, "content")) missing.push("meta description");
  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const canonTag = linkTags.find((t) => (attr(t, "rel") ?? "").toLowerCase() === "canonical");
  if (!canonTag || !attr(canonTag, "href")) missing.push("canonical");
  if (missing.length > 0)
    return makeCheck("meta", "meta tags", 10, "FAIL", `Add missing ${missing.join(", ")} to <head>`, `missing: ${missing.join(", ")}`);
  return makeCheck("meta", "meta tags", 10, "PASS", "none", "title + description + canonical");
}

/** 7. first <h1> present with non-empty text. */
export function checkH1(html: string): CheckResult {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const text = m ? m[1]!.replace(/<[^>]*>/g, "").trim() : "";
  if (!text) return makeCheck("h1", "<h1>", 5, "FAIL", "Add exactly one descriptive <h1> to the page", "no <h1> found");
  return makeCheck("h1", "<h1>", 5, "PASS", "none", JSON.stringify(text.slice(0, 60)));
}

/** 8. HTTPS + final URL healthy (no loop, status < 400). */
export function checkHttps(finalUrl: string, status: number, loop: boolean): CheckResult {
  if (loop) return makeCheck("https", "HTTPS + health", 15, "FAIL", "Fix the redirect loop on the homepage", "redirect loop");
  let https = false;
  try {
    https = new URL(finalUrl).protocol === "https:";
  } catch {
    https = false;
  }
  if (!https)
    return makeCheck("https", "HTTPS + health", 15, "FAIL", "Serve the site over HTTPS and redirect http → https", `final URL: ${finalUrl}`);
  if (status >= 400)
    return makeCheck("https", "HTTPS + health", 15, "FAIL", `Fix homepage returning HTTP ${status}`, `HTTP ${status}`);
  return makeCheck("https", "HTTPS + health", 15, "PASS", "none", `final URL: ${finalUrl} (HTTP ${status})`);
}

/** Starter /llms.txt content for --fix-llms. */
export function generateLlmsTemplate(siteName: string, origin: string): string {
  return `# ${siteName}
> One-paragraph summary of ${siteName} for AI answers. Replace this line with what the site is and who it serves.

## Products
- [Example item](${origin}/): one-line description of the key offering.

## Docs
- [Getting started](${origin}/): one-line description of where to begin.

## Contact
- [Contact](${origin}/): how to reach the team.
`;
}

export function siteNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const base = host.split(".")[0] ?? host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return "Your Site";
  }
}

export interface AuditOptions {
  timeoutMs?: number;
}

/** Fetch a site and run all 8 weighted checks. Throws AuditError when the homepage is unreachable. */
export async function auditSite(rawUrl: string, opts: AuditOptions = {}): Promise<AuditReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = normalizeUrl(rawUrl);
  let home: Fetched;
  try {
    home = await get(url, timeoutMs);
  } catch (err) {
    if (err instanceof AuditError) throw new AuditError(`homepage unreachable: ${err.message}`);
    throw err;
  }
  let origin: string;
  try {
    origin = new URL(home.url).origin;
  } catch {
    origin = new URL(url).origin;
  }
  const join = (p: string) => new URL(p, origin).toString();
  const [llms, full, sitemap, robots] = await Promise.all([
    getOptional(join("/llms.txt"), timeoutMs),
    getOptional(join("/llms-full.txt"), timeoutMs),
    getOptional(join("/sitemap.xml"), timeoutMs),
    getOptional(join("/robots.txt"), timeoutMs),
  ]);
  const ok = (f: Fetched | null) => (f !== null && f.status < 400 ? f.text : null);

  const checks: CheckResult[] = [
    checkLlmsTxt(ok(llms)),
    checkLlmsFull(ok(full)),
    checkSitemap(ok(sitemap)),
    checkRobots(ok(robots)),
    checkJsonLd(home.text),
    checkMeta(home.text),
    checkH1(home.text),
    checkHttps(home.url, home.status, false),
  ];
  const score = checks.reduce((sum, c) => sum + c.earned, 0);
  return {
    tool: "llms-audit",
    version: VERSION,
    url,
    finalUrl: home.url,
    score,
    maxScore: MAX_SCORE,
    checks,
    generatedAt: new Date().toISOString(),
  };
}
