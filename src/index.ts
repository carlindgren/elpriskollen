// Elpriskollen: a free, public MCP server for Swedish electricity prices.
// /mcp  the MCP endpoint (no sign-in: the data is public)
// /     a short Swedish page on how to add it to Claude or ChatGPT
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { isAdmin, listFeedback, maskedTopic, notify, saveFeedback, type FeedbackEnv } from "./feedback";
import { adminPage, landingPage, ntfyTestPage, type FormStatus } from "./page";
import { buildServer, type ToolEnv } from "./tools";

export interface Env extends ToolEnv, FeedbackEnv {
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
      const status = url.searchParams.get("status") as FormStatus | null;
      const known = status && ["tack", "kort", "manga", "fel"].includes(status) ? status : undefined;
      return new Response(landingPage(url.origin, env, known), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": known ? "no-store" : "public, max-age=300",
          "X-Frame-Options": "DENY",
        },
      });
    }
    if (url.pathname === "/feedback" && request.method === "POST") {
      return handleFeedbackForm(request, env, url.origin);
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/ntfy-test") {
      if (!env.ADMIN_PASSWORD) return new Response("Not found", { status: 404 });
      if (!(await isAdmin(request, env))) {
        return new Response("Logga in med ditt ADMIN_PASSWORD (valfritt användarnamn).", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Elpriskollen admin", charset="UTF-8"' },
        });
      }
      if (url.pathname === "/admin/ntfy-test") {
        const result = await notify(env, { kind: "other", source: "web", message: "Testnotis från adminsidan. Fungerar det här är allt klart!" });
        return new Response(ntfyTestPage(result, maskedTopic(env)), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
        });
      }
      return new Response(adminPage(await listFeedback(env)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleFeedbackForm(request: Request, env: Env, origin: string): Promise<Response> {
  const back = (status: FormStatus) => Response.redirect(`${origin}/?status=${status}#forslag`, 303);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back("fel");
  }
  // Bots fill the hidden field; pretend it worked.
  if (String(form.get("website") ?? "")) return back("tack");
  const saved = await saveFeedback(env, {
    source: "web",
    kind: String(form.get("kind") ?? ""),
    message: String(form.get("message") ?? ""),
    contact: String(form.get("contact") ?? "") || undefined,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined,
  });
  if (saved.ok) return back("tack");
  return back(saved.reason.includes("short") ? "kort" : saved.reason.includes("Too many") ? "manga" : "fel");
}
