// Canned site fixtures for llms-audit tests and demo.
// PORT=8787 (default), READY=1 serves an AI-ready site, otherwise an unready one.
const PORT = Number(process.env.PORT ?? 8787);
const READY = process.env.READY === "1";

const UNREADY_HTML = `<!DOCTYPE html>
<html><head></head>
<body><h1>Acme Widgets</h1><p>Nothing else here.</p></body></html>`;

const READY_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<title>Fixture Site — docs, API, pricing</title>
<meta name="description" content="A test fixture that passes every llms-audit check except HTTPS.">
<link rel="canonical" href="https://fixture.test/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Fixture Site"}</script>
</head>
<body><h1>Fixture Site</h1></body></html>`;

const READY_LLMS = `# Fixture Site
> Test fixture for llms-audit.

## Docs
- [Getting started](https://fixture.test/): how to begin.
`;

const READY_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://fixture.test/</loc></url>
<url><loc>https://fixture.test/docs</loc></url>
</urlset>`;

const UNREADY_ROBOTS = `User-agent: GPTBot
Disallow: /

User-agent: *
Allow: /
`;

const READY_ROBOTS = `User-agent: *
Allow: /
`;

Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const text = (body: string, type: string) =>
      new Response(body, { headers: { "content-type": type } });
    if (path === "/") return text(READY ? READY_HTML : UNREADY_HTML, "text/html; charset=utf-8");
    if (path === "/robots.txt") return text(READY ? READY_ROBOTS : UNREADY_ROBOTS, "text/plain");
    if (path === "/llms.txt" && READY) return text(READY_LLMS, "text/plain");
    if (path === "/llms-full.txt" && READY) return text(READY_LLMS + "\nMore pages.\n", "text/plain");
    if (path === "/sitemap.xml" && READY) return text(READY_SITEMAP, "application/xml");
    return new Response("not found", { status: 404 });
  },
});

console.log(`listening http://127.0.0.1:${PORT} (ready=${READY})`);
