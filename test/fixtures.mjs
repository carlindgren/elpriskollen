// Deterministic fake price days in elprisetjustnu.se's format.
const TZ = "Europe/Stockholm";
const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function parts(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}

function offsetMinutes(ms) {
  const p = parts(ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

function iso(ms) {
  const p = parts(ms);
  const off = offsetMinutes(ms);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00${sign}${hh}:${mm}`;
}

/** UTC ms of local midnight for a YYYY-MM-DD date. */
export function localMidnight(date) {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d) - 3600_000;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess);
    const diff = Date.UTC(y, m - 1, d) - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

const BASE = { SE1: 0.15, SE2: 0.18, SE3: 0.45, SE4: 0.7 };

/** Price shape: cheap nights, morning and evening peaks, a solar dip around 13–15. */
export function priceFor(area, date, ms) {
  const p = parts(ms);
  const h = +p.hour;
  const q = +p.minute / 15;
  const shape = h < 5 ? 0.5 : h < 7 ? 0.8 : h < 10 ? 1.8 : h < 13 ? 1.0 : h < 15 ? 0.6 : h < 17 ? 1.1 : h < 21 ? 2.0 : 0.9;
  const daySalt = (Number(date.slice(-2)) % 5) * 0.01;
  let sek = BASE[area] * shape + 0.01 * q + daySalt;
  // One negative quarter in SE3 on 2026-11-04 at 13:15.
  if (area === "SE3" && date === "2026-11-04" && h === 13 && q === 1) sek = -0.02;
  return Math.round(sek * 100000) / 100000;
}

/** One day's quarter prices exactly as the API returns them. */
export function dayJson(area, date) {
  const start = localMidnight(date);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = localMidnight(next.toISOString().slice(0, 10));
  const rows = [];
  for (let t = start; t < end; t += 15 * 60_000) {
    const sek = priceFor(area, date, t);
    rows.push({ SEK_per_kWh: sek, EUR_per_kWh: Math.round((sek / 11.3) * 100000) / 100000, EXR: 11.3, time_start: iso(t), time_end: iso(t + 15 * 60_000) });
  }
  return rows;
}
