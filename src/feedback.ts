// Suggestions from users, from the start page form or from Claude via send_feedback.
// Stored in Workers KV; read on /admin with the ADMIN_PASSWORD secret.

export interface FeedbackEnv {
  FEEDBACK?: KVNamespace;
  ADMIN_PASSWORD?: string;
}

export const KINDS = ["feature", "bug", "praise", "other"] as const;
export type Kind = (typeof KINDS)[number];

export interface FeedbackItem {
  at: string; // ISO time
  source: "web" | "claude";
  kind: Kind;
  message: string;
  contact?: string;
  area?: string;
}

export const MAX_MESSAGE = 1000;
const MAX_CONTACT = 120;
const DAILY_CAP = 200; // across everyone, keeps KV writes far below the free limit
const WEB_PER_IP_PER_HOUR = 5;

export type SaveResult = { ok: true } | { ok: false; reason: string };

function clean(text: string, max: number): string {
  // Drop control characters except newlines and tabs, collapse runs of blank lines.
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export async function saveFeedback(
  env: FeedbackEnv,
  input: { source: FeedbackItem["source"]; kind?: string; message: string; contact?: string; area?: string; ip?: string },
  now = Date.now(),
): Promise<SaveResult> {
  if (!env.FEEDBACK) return { ok: false, reason: "Feedback isn't set up on this server." };
  const message = clean(input.message ?? "", MAX_MESSAGE);
  if (message.length < 5) return { ok: false, reason: "The message is too short." };
  const kind: Kind = (KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as Kind) : "other";
  const contact = input.contact ? clean(input.contact, MAX_CONTACT) || undefined : undefined;

  const day = new Date(now).toISOString().slice(0, 10);
  const dayKey = `count:${day}`;
  const today = Number((await env.FEEDBACK.get(dayKey)) ?? 0);
  if (today >= DAILY_CAP) return { ok: false, reason: "Too many suggestions today. Try again tomorrow." };

  if (input.ip) {
    const ipKey = `ip:${await hash(input.ip)}:${Math.floor(now / 3_600_000)}`;
    const count = Number((await env.FEEDBACK.get(ipKey)) ?? 0);
    if (count >= WEB_PER_IP_PER_HOUR) return { ok: false, reason: "Too many suggestions from you this hour." };
    await env.FEEDBACK.put(ipKey, String(count + 1), { expirationTtl: 3600 });
  }

  const item: FeedbackItem = { at: new Date(now).toISOString(), source: input.source, kind, message, contact, area: input.area };
  // Keys sort ascending, so an inverted timestamp lists the newest first.
  const key = `fb:${String(9_999_999_999_999 - now).padStart(13, "0")}:${crypto.randomUUID().slice(0, 8)}`;
  await env.FEEDBACK.put(key, JSON.stringify(item));
  await env.FEEDBACK.put(dayKey, String(today + 1), { expirationTtl: 3 * 86_400 });
  return { ok: true };
}

export async function listFeedback(env: FeedbackEnv, limit = 100): Promise<FeedbackItem[]> {
  if (!env.FEEDBACK) return [];
  const { keys } = await env.FEEDBACK.list({ prefix: "fb:", limit });
  const values = await Promise.all(keys.map((k) => env.FEEDBACK!.get<FeedbackItem>(k.name, "json")));
  return values.filter((v): v is FeedbackItem => !!v);
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`elpriskollen:${value}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HTTP Basic auth against ADMIN_PASSWORD (any user name), compared in constant time. */
export async function isAdmin(request: Request, env: FeedbackEnv): Promise<boolean> {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let password = "";
  try {
    const decoded = atob(header.slice(6));
    password = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return false;
  }
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(password)),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_PASSWORD)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
