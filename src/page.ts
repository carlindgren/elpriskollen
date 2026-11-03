// The start page: what Elpriskollen is and how to add it to Claude or ChatGPT.
import type { FeedbackItem, NotifyResult } from "./feedback";

export type FormStatus = "tack" | "kort" | "manga" | "fel";

const STATUS_TEXT: Record<FormStatus, string> = {
  tack: "Tack! Ditt förslag har skickats.",
  kort: "Skriv lite mer, så att jag förstår vad du menar.",
  manga: "Många förslag på kort tid. Prova igen om en stund.",
  fel: "Något gick fel. Prova igen om en stund.",
};

interface PageEnv {
  DONATE_URL?: string;
  REPO_URL?: string;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeUrl = (value: string | undefined) => (value && /^https:\/\/[^\s"'<>]+$/.test(value) ? value : undefined);

export function landingPage(origin: string, env: PageEnv, status?: FormStatus): string {
  const endpoint = escape(`${origin}/mcp`);
  const donate = safeUrl(env.DONATE_URL);
  const repo = safeUrl(env.REPO_URL);
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elpriskollen – elpriset i Claude och ChatGPT</title>
<meta name="description" content="Gratis koppling som låter Claude och ChatGPT svara på när elen är billigast i SE1–SE4.">
<style>
  :root { --ink:#16181d; --muted:#5b6170; --line:#e4e6ea; --bg:#fbfaf7; --accent:#1f7a4d; --accent-ink:#ffffff; --card:#ffffff; }
  @media (prefers-color-scheme: dark) { :root { --ink:#eceef2; --muted:#a3a9b6; --line:#2c3038; --bg:#14161a; --accent:#3fb37a; --accent-ink:#0d1a13; --card:#1b1e23; } }
  * { box-sizing: border-box; }
  body { margin:0; font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
  main { max-width: 40rem; margin: 0 auto; padding: 3.5rem 1.25rem 4rem; }
  h1 { font-size: 2.1rem; line-height:1.15; margin: 0 0 .6rem; letter-spacing:-.01em; }
  h2 { font-size: 1.15rem; margin: 2.4rem 0 .6rem; }
  p.lead { color: var(--muted); font-size: 1.1rem; margin: 0 0 1.8rem; }
  .card { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 1.1rem 1.2rem; }
  .url { display:flex; gap:.5rem; align-items:center; }
  .url code { flex:1; font: 15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
  button, .button { font: inherit; font-size: .95rem; border:0; border-radius: 8px; padding:.5rem .9rem; background: var(--accent); color: var(--accent-ink); cursor:pointer; text-decoration:none; display:inline-block; }
  ol { padding-left: 1.2rem; } li { margin: .3rem 0; }
  ul.examples { list-style:none; padding:0; margin:0; display:grid; gap:.5rem; }
  ul.examples li { background: var(--card); border:1px solid var(--line); border-radius: 10px; padding:.6rem .9rem; }
  .muted { color: var(--muted); font-size: .95rem; }
  form.feedback { display:grid; gap:.7rem; }
  form.feedback label { display:grid; gap:.3rem; font-size:.95rem; color: var(--muted); }
  form.feedback textarea, form.feedback input, form.feedback select { font: inherit; color: var(--ink); background: var(--card); border:1px solid var(--line); border-radius: 8px; padding:.55rem .7rem; }
  form.feedback textarea { min-height: 6.5rem; resize: vertical; }
  .hp { position:absolute; left:-10000px; width:1px; height:1px; overflow:hidden; }
  .status { border-radius: 8px; padding:.6rem .8rem; background: var(--card); border:1px solid var(--accent); }
  footer { margin-top: 3rem; padding-top: 1.2rem; border-top:1px solid var(--line); color: var(--muted); font-size:.9rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Elpriskollen</h1>
  <p class="lead">Fråga Claude eller ChatGPT när elen är billigast. Kvartspriser för SE1–SE4, idag och imorgon. Gratis, ingen inloggning.</p>

  <div class="card url">
    <code id="endpoint">${endpoint}</code>
    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('endpoint').textContent).then(()=>{this.textContent='Kopierad'})">Kopiera</button>
  </div>

  <h2>Lägg till i Claude</h2>
  <ol>
    <li>Gå till <strong>Customize → Connectors</strong> på claude.ai.</li>
    <li>Klicka på <strong>+</strong> och välj <strong>Add custom connector</strong>.</li>
    <li>Döp den till <em>Elpriskollen</em> och klistra in adressen ovan.</li>
  </ol>
  <p class="muted">Gratisversionen av Claude tillåter en egen koppling. I ChatGPT lägger du till den som en app/connector i utvecklarläget.</p>

  <h2>Fråga till exempel</h2>
  <ul class="examples">
    <li>När ska jag köra diskmaskinen i natt? Den går i 2 timmar.</li>
    <li>Vilka timmar är billigast att ladda bilen innan 07:00? Den behöver 4 timmar.</li>
    <li>Är elen dyr just nu i Stockholm?</li>
    <li>Hur skiljer sig priset mellan SE1 och SE4 idag?</li>
    <li>Hur dyr var elen i oktober jämfört med september?</li>
  </ul>

  <h2>Bra att veta</h2>
  <p>Priserna är spotpriset från Nord Pool, utan elbolagets påslag, energiskatt och nätavgift. Moms kan läggas till om du ber om det. Morgondagens priser kommer runt kl 13.</p>


  <h2 id="forslag">Saknar du något?</h2>
  <p>Tipsa om en funktion eller berätta om något strular. Du kan också säga till Claude: <em>"Tipsa Elpriskollen om att …"</em></p>
  ${status ? `<p class="status" role="status">${STATUS_TEXT[status]}</p>` : ""}
  <form class="feedback" method="post" action="/feedback">
    <label>Ditt förslag
      <textarea name="message" required minlength="5" maxlength="1000" placeholder="Det vore bra om Elpriskollen kunde …"></textarea>
    </label>
    <label>Typ
      <select name="kind">
        <option value="feature">Ny funktion</option>
        <option value="bug">Något är fel</option>
        <option value="praise">Beröm</option>
        <option value="other">Annat</option>
      </select>
    </label>
    <label>E-post, om du vill ha svar (valfritt)
      <input type="email" name="contact" maxlength="120" autocomplete="email">
    </label>
    <div class="hp" aria-hidden="true"><label>Lämna tomt <input name="website" tabindex="-1" autocomplete="off"></label></div>
    <div><button type="submit">Skicka</button></div>
  </form>

  ${donate ? `<h2>Gillar du den?</h2><p>Elpriskollen är gratis och drivs på fritiden. Om den har sparat dig en slant får du gärna bjuda på en öl.</p><p><a class="button" href="${escape(donate)}" rel="noopener">Bjud på en öl</a></p>` : ""}

  <footer>
    Elpriser tillhandahålls av <a href="https://www.elprisetjustnu.se" rel="noopener">Elpriset just nu.se</a>.
    ${repo ? `Öppen källkod på <a href="${escape(repo)}" rel="noopener">GitHub</a>.` : ""}
    Inget om dig sparas, utom det du själv skickar via förslagsformuläret.
  </footer>
</main>
</body>
</html>`;
}

/** The admin view of received suggestions. */
export function adminPage(items: FeedbackItem[]): string {
  const kindText: Record<string, string> = { feature: "Ny funktion", bug: "Fel", praise: "Beröm", other: "Annat" };
  const rows = items
    .map(
      (f) => `<article>
  <header><strong>${escape(kindText[f.kind] ?? f.kind)}</strong> · ${escape(f.at.slice(0, 16).replace("T", " "))} UTC · ${f.source === "claude" ? "via Claude" : "via webben"}${f.area ? ` · ${escape(f.area)}` : ""}</header>
  <p>${escape(f.message).replace(/\n/g, "<br>")}</p>
  ${f.contact ? `<p class="contact">Svar till: ${escape(f.contact)}</p>` : ""}
</article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Förslag – Elpriskollen</title>
<style>
  body { margin:0; font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; background:#fbfaf7; color:#16181d; }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
  article { background:#fff; border:1px solid #e4e6ea; border-radius: 10px; padding: .8rem 1rem; margin: .7rem 0; }
  header { color:#5b6170; font-size:.9rem; } p { margin:.4rem 0 0; } .contact { color:#1f7a4d; font-size:.95rem; }
</style></head>
<body><main><h1>Förslag (${items.length})</h1>
<p><a href="/admin/ntfy-test">Skicka en testnotis till mobilen</a></p>
${rows || "<p>Inga förslag än.</p>"}</main></body></html>`;
}

export function ntfyTestPage(result: NotifyResult, topic: string | undefined): string {
  const verdict = result.sent
    ? "<p><strong>Skickat!</strong> ntfy tog emot notisen. Får du ingen notis i mobilen: kontrollera att appen prenumererar på exakt samma ämne som nedan.</p>"
    : `<p><strong>Inte skickat.</strong> ${escape(result.detail)}</p>`;
  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Testnotis – Elpriskollen</title>
<style>body{margin:0;font:16px/1.55 system-ui,sans-serif;background:#fbfaf7;color:#16181d}main{max-width:40rem;margin:0 auto;padding:2.5rem 1.25rem}code{background:#eee;padding:.1rem .3rem;border-radius:4px}</style>
</head><body><main>
<h1>Testnotis</h1>
${verdict}
<p>Ämne (NTFY_TOPIC): ${topic ? `<code>${escape(topic)}</code>` : "<em>inte satt</em>"}</p>
${result.status ? `<p>ntfy svarade HTTP ${result.status}.</p>` : ""}
<p><a href="/admin">Tillbaka till förslagen</a></p>
</main></body></html>`;
}
