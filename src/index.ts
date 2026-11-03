// Elpriskollen: a free, public MCP server for Swedish electricity prices.
// /mcp  the MCP endpoint (no sign-in: the data is public)
// /     a short Swedish page on how to add it to Claude or ChatGPT
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { landingPage } from "./page";
import { buildServer, type ToolEnv } from "./tools";

export interface Env extends ToolEnv {
  /** Optional "buy me a beer" link shown on the start page. */
  DONATE_URL?: string;
  /** Optional link to the source code, shown on the start page. */
  REPO_URL?: string;
}

let mcp: McpHttpHandler | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      mcp ??= createMcpHandler(() => buildServer(env));
      return mcp.fetch(request);
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(landingPage(url.origin, env), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
