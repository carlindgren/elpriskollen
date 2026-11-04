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

// Fake grid fee data in the shape of api.elprisernaidag.se (amounts excl. VAT).
const CUSTOMERS = [
  ["lagenhet-16a-2000", "Lägenhet, 16 A, 2 000 kWh/år"],
  ["villa-16a-5000", "Villa, 16 A, 5 000 kWh/år"],
  ["villa-20a-20000", "Villa, 20 A, 20 000 kWh/år"],
];
const COMPANIES = [
  { slug: "ellevio", namn: "Ellevio", juridiskt_namn: "Ellevio AB", omrade: "Stockholm", variable: [30, 22, 20], fixed: [1800, 3000, 5000] },
  { slug: "vattenfall-eldistribution", namn: "Vattenfall Eldistribution", juridiskt_namn: "Vattenfall Eldistribution AB", omrade: null, variable: [40, 35, 30], fixed: [2000, 3500, 6000] },
  { slug: "goteborg-energi-nat", namn: "Göteborg Energi Nät", juridiskt_namn: "Göteborg Energi Nät AB", omrade: "Göteborg", variable: [20, 18, 15], fixed: [1500, 2500, 4000] },
  { slug: "borlange-energi-elnat", namn: "Borlänge Energi Elnät", juridiskt_namn: "Borlänge Energi Elnät AB", omrade: "Borlänge", variable: [25, 24, 23], fixed: [1600, 2600, 4200] },
  { slug: "eon-energidistribution", namn: "E.ON Energidistribution", juridiskt_namn: "E.ON Energidistribution AB", omrade: null, variable: [45, 40, 35], fixed: [2100, 3600, 6500] },
  // An old grid area with no recent figures, like several of the big companies have.
  // A current area whose fee per kWh stops in 2024 (moved to a power tariff).
  { slug: "malarenergi-elnat", namn: "Mälarenergi Elnät", juridiskt_namn: "Mälarenergi Elnät AB", omrade: "Västerås", variable: [26, 24, 22], fixed: [1600, 2700, 4500], years: ["2023", "2024"], latest: "2026" },
  // Houses on a power tariff: only the apartment has a fee per kWh (like Göteborg Energi in the real data).
  { slug: "partille-energi-nat", namn: "Partille Energi Nät", juridiskt_namn: "Partille Energi Nät AB", omrade: "Partille", variable: [30, 0, 0], fixed: [1500, 0, 0], onlyFlat: true },
  { slug: "ellevio-ab-f-d-taby", namn: "Ellevio AB – f.d. Täby", juridiskt_namn: "Ellevio AB", omrade: "Stockholm", variable: [28, 21, 19], fixed: [1700, 2900, 4800], years: ["2021", "2022"] },
];
const annual = (fixed, variable, kwh) => {
  const total = fixed + 100 + (variable * kwh) / 100;
  return { fast_kr_per_ar: fixed, myndighetsavgift_kr_per_ar: 100, rorlig_ore_per_kwh: variable, totalt_kr_per_ar: total, totalt_kr_per_ar_inkl_moms: Math.round(total * 1.25) };
};
const KWH = [2000, 5000, 20000];

export function gridOverview() {
  return {
    enhet: "kr/år, öre/kWh",
    valuta: "SEK",
    moms_not: "Belopp är exklusive moms om inte fältet heter inkl_moms.",
    antal_foretag: COMPANIES.length,
    senaste_ar: "2026",
    median_referens_kr_per_ar_inkl_moms: 13000,
    foretag: COMPANIES.map((c, i) => ({
      id: `REL0000${i}`,
      slug: c.slug,
      namn: c.namn,
      juridiskt_namn: c.juridiskt_namn,
      omrade: c.omrade,
      senaste_ar: c.latest ?? (c.years ?? ["2025", "2026"])[1],
      antal_typkunder: 3,
      referens: { typkund: "villa-20a-20000", ar: (c.years ?? ["2025", "2026"])[1], ...annual(c.fixed[2], c.variable[2], 20000) },
      detalj: `https://api.elprisernaidag.se/v1/elnatsavgifter/${c.slug}`,
    })),
    kalla_hamtad: "2026-10-01",
  };
}

export function gridCompany(slug) {
  const c = COMPANIES.find((x) => x.slug === slug);
  if (!c) return null;
  return {
    id: "REL00001",
    slug: c.slug,
    namn: c.namn,
    juridiskt_namn: c.juridiskt_namn,
    omrade: c.omrade,
    senaste_ar: c.latest ?? (c.years ?? ["2025", "2026"])[1],
    moms_not: "Belopp är exklusive moms om inte fältet heter inkl_moms.",
    mot_median: { typkund: "villa-20a-20000", ar: "2026", skillnad_kr_per_ar_inkl_moms: -500, skillnad_procent: -3.8 },
    typkunder: CUSTOMERS.map(([typkund, etikett], i) => ({
      typkund,
      etikett,
      forandring: { fran_ar: "2025", till_ar: "2026", procent: 4.2 },
      ar: c.onlyFlat && i > 0 ? {} : {
        [(c.years ?? ["2025", "2026"])[0]]: annual(c.fixed[i] - 100, c.variable[i] - 2, KWH[i]),
        [(c.years ?? ["2025", "2026"])[1]]: annual(c.fixed[i], c.variable[i], KWH[i]),
      },
    })),
    begransningar: ["Effektavgifter ingår i typkundernas årskostnad enligt Ei:s antaganden."],
    sida: `https://elprisernaidag.se/elnat/${c.slug}/`,
    kalla_hamtad: "2026-10-01",
  };
}
