// End-to-end: runs the Worker with `wrangler dev` against a fake price API and
// calls every tool through the official MCP client, as Claude would.
//   npm run test:e2e
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { dayJson, gridCompany, gridOverview } from "./fixtures.mjs";

const WORKER = "http://127.0.0.1:8788";
const LAST_PUBLISHED = "2026-11-04"; // "now" is 2026-11-03 20:10, after 13:00, so tomorrow is out
const calls = [];
const pushes = [];
const gridCalls = [];

const api = createServer((req, res) => {
  if (req.url.startsWith("/ntfy/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      pushes.push({ url: req.url, title: req.headers.title, tags: req.headers.tags, click: req.headers.click, auth: req.headers.authorization, body });
      res.writeHead(200).end("{}");
    });
    return;
  }
  if (req.url.startsWith("/grid/")) {
    gridCalls.push(req.url);
    const g = /^\/grid\/v1\/elnatsavgifter(?:\/([a-z0-9-]+))?$/.exec(req.url);
    const body = g ? (g[1] ? gridCompany(g[1]) : gridOverview()) : null;
    if (!body) return res.writeHead(404, { "Content-Type": "application/json" }).end('{"fel":"Okänt nätbolag"}');
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }
  calls.push(req.url);
  const m = /^\/api\/v1\/prices\/(\d{4})\/(\d{2})-(\d{2})_(SE[1-4])\.json$/.exec(req.url);
  if (!m) return res.writeHead(404).end();
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (date > LAST_PUBLISHED) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(dayJson(m[4], date)));
});

function waitFor(child, text, ms = 90_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${text}"`)), ms);
    let log = "";
    const onData = (chunk) => {
      log += chunk;
      if (log.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`wrangler exited (${code}):\n${log}`)));
  });
}

let worker;
let failed = false;
try {
  await new Promise((r) => api.listen(8798, "127.0.0.1", r));
  worker = spawn("npx", ["wrangler", "dev", "-c", "wrangler.e2e.jsonc", "--ip", "127.0.0.1", "--port", "8788"], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    detached: true,
  });
  await waitFor(worker, "Ready on");

  // Start page
  const page = await (await fetch(`${WORKER}/`)).text();
  assert.match(page, /Elpriskollen/);
  assert.match(page, /http:\/\/127\.0\.0\.1:8788\/mcp/);
  assert.match(page, /Bjud på en öl/);
  assert.match(page, /Elpriset just nu\.se/);

  for (const mode of [{ pin: "2026-07-28" }, "legacy"]) {
    const client = new Client({ name: "e2e", version: "1" }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${WORKER}/mcp`)));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["compare_areas", "find_cheapest_time", "get_current_price", "get_daily_averages", "get_grid_fees", "get_prices", "get_total_price", "send_feedback"]);
    assert.ok(tools.filter((t) => t.name !== "send_feedback").every((t) => t.annotations?.readOnlyHint === true));
    assert.equal(tools.find((t) => t.name === "send_feedback").annotations.readOnlyHint, false);
    assert.ok(tools.every((t) => t.title || t.annotations?.title));
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
    };

    const today = await call("get_prices", { area: "SE3" });
    assert.equal(today.date, "2026-11-03");
    assert.equal(today.prices.length, 24);
    assert.equal(today.prices[0].time, "00:00");
    const quarterly = await call("get_prices", { area: "SE3", date: "2026-11-04", resolution: "quarter", include_vat: true });
    assert.equal(quarterly.prices.length, 96);
    assert.equal(quarterly.summary.lowest.ore, -2.5); // -2 öre + 25 % VAT
    const future = await call("get_prices", { area: "SE3", date: "2026-11-05" });
    assert.equal(future.published, false);
    assert.match(future.message, /one day ahead/); // 11-05 is the day after tomorrow

    const nowPrice = await call("get_current_price", { area: "SE4" });
    assert.deepEqual([nowPrice.now.from, nowPrice.now.to], ["20:00", "20:15"]);
    assert.equal(nowPrice.tomorrow_published, true);
    assert.ok(nowPrice.next_hours.length >= 6);

    const dish = await call("find_cheapest_time", { area: "SE3", minutes: 120, earliest: "22:00", latest: "07:00", kwh: 1.2 });
    assert.equal(dish.mode, "in one go");
    assert.deepEqual([dish.cheapest.day, dish.cheapest.start, dish.cheapest.end], ["tomorrow", "00:00", "02:00"]);
    assert.ok(dish.cheapest.spot_cost_kr > 0);
    assert.equal(dish.if_started_now, undefined); // earliest is 22:00, not now
    assert.equal(dish.if_started_at_earliest.start, "22:00");
    assert.ok(dish.if_started_at_earliest.cheapest_saves.ore_per_kwh > 0);
    assert.ok(dish.most_expensive.cheapest_saves.percent > 0);

    const asap = await call("find_cheapest_time", { area: "SE3", minutes: 90 });
    assert.ok(asap.if_started_now.cheapest_saves.ore_per_kwh > 0);
    assert.equal(asap.if_started_now.start, "20:00");

    const car = await call("find_cheapest_time", { area: "SE3", minutes: 240, latest: "2026-11-04 16:00", together: false, include_vat: true });
    assert.equal(car.mode, "separate periods");
    assert.ok(car.periods.some((p) => p.start === "13:15"));

    const late = await call("find_cheapest_time", { area: "SE3", minutes: 60, latest: "2026-11-05 07:00" });
    assert.match(late.note, /aren't published yet/);

    const bad = await call("find_cheapest_time", { area: "SE3", minutes: 60, earliest: "2026-11-01 10:00" });
    assert.match(bad.error, /past/);

    const total = await call("get_total_price", { area: "SE3", grid_fee_ore: 25, supplier_markup_ore: 6 });
    // fixture at 20:00 SE3 2026-11-03: 0.93 SEK -> 116.25 + 45 tax + 25 grid + 6 markup
    assert.deepEqual([total.at.from, total.at.spot, total.at.energy_tax, total.at.total], ["20:00", 116.3, 45, 192.3]);
    assert.deepEqual(total.not_included.length, 1); // only fixed/power fees
    assert.match(total.energy_tax_rate, /36 öre\/kWh excl\. VAT for 2026/);
    const bare = await call("get_total_price", { area: "SE1", date: "2026-11-04", at: "03:10", northern_tax_reduction: true });
    assert.equal(bare.at.from, "03:00");
    assert.equal(bare.at.energy_tax, 33);
    assert.equal(bare.not_included.length, 3);
    const dishTotal = await call("find_cheapest_time", { area: "SE3", minutes: 120, earliest: "22:00", latest: "07:00", kwh: 1.2, grid_fee_ore: 25, supplier_markup_ore: 6 });
    assert.ok(dishTotal.cheapest.with_your_fees.total_cost_kr > dishTotal.cheapest.spot_cost_kr);
    assert.ok(dishTotal.if_started_at_earliest.with_your_fees.total_cost_kr > dishTotal.cheapest.with_your_fees.total_cost_kr);

    // Grid company lookup (fake Ei data: Ellevio villa 20 A = 20 öre excl. VAT, 5000 + 100 kr/year fixed)
    const ellevio = await call("get_total_price", { area: "SE3", grid_company: "Ellevio", supplier_markup_ore: 6 });
    assert.equal(ellevio.at.grid_fee, 25);
    assert.equal(ellevio.at.total, 192.3);
    assert.equal(ellevio.grid_fee_lookup.company, "Ellevio");
    assert.equal(ellevio.grid_fee_lookup.customer_type, "Villa, 20 A, 20 000 kWh/år");
    assert.equal(ellevio.grid_fee_lookup.year, "2026");
    assert.equal(ellevio.grid_fee_lookup.fixed_fees_kr_per_year_incl_vat, 6375);
    assert.ok(ellevio.not_included.some((x) => /Ellevio's fixed fees, about 6375 kr\/year \(531 kr\/month\)/.test(x)));
    assert.match(ellevio.source, /Energimarknadsinspektionen/);
    const flat = await call("get_total_price", { area: "SE3", grid_company: "ellevio", grid_customer_type: "lägenhet" });
    assert.equal(flat.at.grid_fee, 37.5);
    assert.equal(flat.not_included.length, 3); // markup, Ellevio's fixed fees, supplier's monthly fee
    const own = await call("get_total_price", { area: "SE3", grid_company: "Göteborg", grid_fee_ore: 10 });
    assert.equal(own.at.grid_fee, 10);
    assert.match(own.grid_fee_lookup.used, /Not used/);
    const lastYear = await call("get_total_price", { area: "SE3", date: "2025-11-03", grid_company: "Ellevio" });
    assert.equal(lastYear.at, undefined);
    assert.equal(lastYear.grid_fee_lookup.variable_fee_ore_per_kwh_excl_vat, 18);
    assert.match((await call("get_total_price", { area: "SE3", grid_company: "Energi" })).error, /Several grid companies or grid areas match "Energi"/);
    assert.match((await call("get_total_price", { area: "SE3", grid_company: "Tekniska verken" })).error, /No grid company matches/);
    const taby = await call("get_total_price", { area: "SE3", grid_company: "Täby" });
    assert.equal(taby.grid_fee_lookup.year, "2022 (latest in the data)");
    assert.match(taby.grid_fee_lookup.warning, /after 2022/);
    assert.match(taby.grid_fee_lookup.warning, /current figures: Ellevio \(ellevio\)/);
    assert.equal(ellevio.grid_fee_lookup.warning, undefined);
    const partille = await call("get_total_price", { area: "SE3", grid_company: "Partille" });
    assert.equal(partille.at.grid_fee, 37.5);
    assert.equal(partille.grid_fee_lookup.customer_type, "Lägenhet, 16 A, 2 000 kWh/år");
    assert.match(partille.grid_fee_lookup.warning, /no fee per kWh for "Villa, 20 A, 20 000 kWh\/år" at Partille Energi Nät/);
    const partilleFees = await call("get_grid_fees", { company: "Partille" });
    assert.equal(partilleFees.customer_types.length, 3);
    assert.match(partilleFees.customer_types[2].note, /power-based tariff/);
    assert.match((await call("get_grid_fees", { company: "Partille", customer_type: "villa" })).asked_for_missing, /has no fee per kWh/);
    const malar = await call("get_total_price", { area: "SE3", grid_company: "Mälarenergi" });
    assert.equal(malar.grid_fee_lookup.year, "2024 (latest in the data)");
    assert.match(malar.grid_fee_lookup.warning, /after 2024\. The company may have moved to a power-based tariff/);
    const dishEllevio = await call("find_cheapest_time", { area: "SE3", minutes: 120, earliest: "22:00", latest: "07:00", kwh: 1.2, grid_company: "Ellevio", supplier_markup_ore: 6 });
    assert.deepEqual(dishEllevio.cheapest.with_your_fees, dishTotal.cheapest.with_your_fees);
    assert.equal(dishEllevio.grid_fee_lookup.slug, "ellevio");
    const gbg = await call("get_grid_fees", { company: "goteborg energi" });
    assert.equal(gbg.company, "Göteborg Energi Nät");
    assert.equal(gbg.customer_types.length, 3);
    assert.deepEqual(gbg.customer_types[2], {
      customer_type: "Villa, 20 A, 20 000 kWh/år", year: "2026", variable_fee_ore_per_kwh_incl_vat: 18.8,
      fixed_fees_kr_per_year_incl_vat: 5125, total_kr_per_year_incl_vat: 8875, change_from_last_year_percent: 4.2,
    });
    assert.equal(gbg.compared_with_median.national_median_kr_per_year_incl_vat, 13000);
    const several = await call("get_grid_fees", { company: "energi" });
    assert.ok(several.matches.length >= 2);
    assert.equal((await call("get_grid_fees", { company: "Vattenfall", customer_type: "villa 16 A" })).customer_types.length, 1);
    if (mode === "legacy") console.log("  grid lookup:", JSON.stringify(ellevio.grid_fee_lookup));

    if (mode === "legacy") console.log("  total price now:", JSON.stringify(total.at), "| dishwasher with fees:", JSON.stringify(dishTotal.cheapest.with_your_fees));

    const areas = await call("compare_areas", {});
    assert.deepEqual(areas.areas.map((a) => a.area), ["SE1", "SE2", "SE3", "SE4"]);
    assert.ok(areas.areas[0].average < areas.areas[3].average);

    const week = await call("get_daily_averages", { area: "SE3" });
    assert.equal(week.days.length, 7);
    assert.equal(week.period, "2026-10-28 – 2026-11-03");
    const tooLong = await call("get_daily_averages", { area: "SE3", start_date: "2026-01-01", end_date: "2026-03-01" });
    assert.match(tooLong.error, /31 days/);

    const fb = await call("send_feedback", { message: `Lägg till Norge också (${JSON.stringify(mode)})`, kind: "feature", area: "SE3" });
    assert.equal(fb.sent, true);
    const fbShort = await call("send_feedback", { message: "hej" });
    assert.ok(fbShort.error);

    console.log(`protocol ${client.getNegotiatedProtocolVersion()}: all tools ok`);
    console.log("  dishwasher:", JSON.stringify(dish.cheapest), "| saves vs worst:", JSON.stringify(dish.most_expensive.cheapest_saves));
    await client.close();
  }

  // Feedback form on the start page
  const post = (body) =>
    fetch(`${WORKER}/feedback`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const ok = await post({ message: "Visa totalpris med nätavgift <b>tack</b>", kind: "feature", contact: "test@example.com" });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("location"), /status=tack#forslag$/);
  assert.match(await (await fetch(ok.headers.get("location"))).text(), /Tack! Ditt förslag har skickats/);
  assert.match((await post({ message: "hej" })).headers.get("location"), /status=kort/);
  assert.match((await post({ message: "spam spam spam", website: "http://spam" })).headers.get("location"), /status=tack/);

  // Admin page
  assert.equal((await fetch(`${WORKER}/admin`)).status, 401);
  const basic = (pw) => ({ Authorization: `Basic ${Buffer.from(`carl:${pw}`).toString("base64")}` });
  assert.equal((await fetch(`${WORKER}/admin`, { headers: basic("wrong-password-123") })).status, 401);
  const admin = await (await fetch(`${WORKER}/admin`, { headers: basic("e2e-admin-password") })).text();
  assert.match(admin, /Förslag \(3\)/); // two from Claude, one from the web; the honeypot one is dropped
  assert.match(admin, /&#60;b&#62;tack&#60;\/b&#62;/); // escaped
  assert.match(admin, /Svar till: test@example\.com/);
  assert.ok(admin.indexOf("Visa totalpris") < admin.indexOf("Lägg till Norge"), "newest first");
  assert.doesNotMatch(admin, /spam spam/);
  // One push per saved suggestion (3), none for the honeypot or the too-short ones.
  assert.equal(pushes.length, 3);
  assert.equal(pushes[0].url, "/ntfy/elpriskollen-test-topic");
  assert.equal(pushes[0].click, "https://elpriskollen.example/admin");
  assert.equal(pushes[0].auth, "Bearer tk_e2etoken");
  assert.match(Buffer.from(pushes[0].title.slice(10, -2), "base64").toString(), /^Elpriskollen: Ny funktion$/);
  assert.ok(pushes.every((p) => !p.body.includes("test@example.com")), "contact address never pushed");
  const testPage = await (await fetch(`${WORKER}/admin/ntfy-test`, { headers: basic("e2e-admin-password") })).text();
  assert.match(testPage, /Skickat!/);
  assert.match(testPage, /Konto \(NTFY_TOKEN\): inlagd/);
  assert.match(testPage, /elpriskollen-…pic \(23 tecken\)/);
  assert.equal(pushes.length, 4);
  assert.equal((await fetch(`${WORKER}/admin/ntfy-test`)).status, 401);
  console.log("feedback form, tool, admin page and push notifications ok");

  // The worker caches days: each file fetched once across both protocol runs.
  const unique = new Set(calls);
  assert.equal(unique.size + calls.filter((c) => c.includes("11-05")).length - 1, calls.length);
  console.log(`price API calls: ${calls.length} (${unique.size} unique)`);
  // Grid data is cached (memory + KV): the list and each company fetched once.
  assert.equal(new Set(gridCalls).size, gridCalls.length, `grid calls: ${gridCalls.join(", ")}`);
  console.log(`grid API calls: ${gridCalls.length}`);
  console.log("E2E PASSED");
} catch (error) {
  failed = true;
  console.error("E2E FAILED:", error);
} finally {
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch {}
  }
  api.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
}
