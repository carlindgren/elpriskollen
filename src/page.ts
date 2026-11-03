// The start page: what Elpriskollen is and how to add it to Claude or ChatGPT.

interface PageEnv {
  DONATE_URL?: string;
  REPO_URL?: string;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeUrl = (value: string | undefined) => (value && /^https:\/\/[^\s"'<>]+$/.test(value) ? value : undefined);

export function landingPage(origin: string, env: PageEnv): string {
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

  ${donate ? `<h2>Gillar du den?</h2><p>Elpriskollen är gratis och drivs på fritiden. Om den har sparat dig en slant får du gärna bjuda på en öl.</p><p><a class="button" href="${escape(donate)}" rel="noopener">Bjud på en öl</a></p>` : ""}

  <footer>
    Elpriser tillhandahålls av <a href="https://www.elprisetjustnu.se" rel="noopener">Elpriset just nu.se</a>.
    ${repo ? `Öppen källkod på <a href="${escape(repo)}" rel="noopener">GitHub</a>.` : ""}
    Ingen data om dig sparas.
  </footer>
</main>
</body>
</html>`;
}
