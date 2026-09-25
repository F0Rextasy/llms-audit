import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, auditSite } from "./audit.js";

const AUDIT_TOOL = {
  name: "audit_url",
  description: "Audit a website URL for AI-answer readiness (llms.txt, sitemap, robots.txt, JSON-LD, meta tags, HTTPS). Returns the JSON audit report with score and per-check fixes.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Site URL to audit (scheme optional, defaults to https)" },
    },
    required: ["url"],
  },
};

/** stdio MCP server exposing the `audit_url` tool. */
export async function runMcp(): Promise<void> {
  const server = new Server({ name: "llms-audit", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [AUDIT_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "audit_url") {
      return { content: [{ type: "text", text: `unknown tool: ${request.params.name}` }], isError: true };
    }
    const url = (request.params.arguments as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || !url.trim()) {
      return { content: [{ type: "text", text: "missing required argument: url" }], isError: true };
    }
    try {
      const report = await auditSite(url);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `audit failed: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
