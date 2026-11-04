// Grid fees (elnätsavgifter) for Swedish grid companies, from Energimarknadsinspektionen (Ei)
// via the free API at api.elprisernaidag.se (CC BY 4.0, link to elprisernaidag.se required).
//   GET /v1/elnatsavgifter         all ~188 companies with a reference annual cost
//   GET /v1/elnatsavgifter/{slug}  one company: six standard customers, per year
// Amounts are excl. VAT unless a field says inkl_moms. 120 requests/hour without a key,
// so answers are cached in memory and in KV for a day (the figures change once a year).

export const DEFAULT_GRID_BASE_URL = "https://api.elprisernaidag.se";
export const GRID_SOURCE = "Energimarknadsinspektionen via elprisernaidag.se";
export const GRID_SOURCE_URL = "https://elprisernaidag.se";
const USER_AGENT = "elpriskollen (+https://github.com/carlindgren/elpriskollen)";
const TTL_MS = 24 * 60 * 60 * 1000;
const KV_PREFIX = "grid:v1:";

export class GridError extends Error {}

/** One year's fees for one standard customer, as Ei reports them (excl. VAT). */
export interface AnnualFee {
  fast_kr_per_ar?: number;
  myndighetsavgift_kr_per_ar?: number;
  rorlig_ore_per_kwh?: number;
  totalt_kr_per_ar?: number;
  totalt_kr_per_ar_inkl_moms?: number;
}

export interface GridCompany {
  slug: string;
  name: string;
  legal_name?: string;
  area?: string | null;
  latest_year?: string | null;
  /** The reference customer for the latest year (villa 20 A, 20 000 kWh/yr). */
  reference?: { customer?: string; year?: string; total_kr_per_year_incl_vat?: number; variable_ore_per_kwh?: number } | null;
}

export interface GridOverview {
  companies: GridCompany[];
  median_kr_per_year_incl_vat?: number;
  latest_year?: string;
}

export interface CustomerType {
  id: string;
  label: string;
  years: Record<string, AnnualFee>;
  change_percent?: number;
}

export interface GridDetail {
  slug: string;
  name: string;
  legal_name?: string;
  area?: string | null;
  latest_year?: string | null;
  vat_note?: string;
  limitations?: string[];
  vs_median?: { customer?: string; year?: string; difference_kr_per_year_incl_vat?: number; difference_percent?: number } | null;
  customers: CustomerType[];
  page?: string;
}

interface Cached<T> {
  until: number;
  value: T;
}
const memory = new Map<string, Cached<unknown>>();

export function clearGridCacheForTests(): void {
  memory.clear();
}

export class GridClient {
  private readonly base: string;

  constructor(
    baseUrl?: string,
    private readonly key?: string,
    private readonly kv?: KVNamespace,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.base = (baseUrl || DEFAULT_GRID_BASE_URL).replace(/\/+$/, "");
  }

  async overview(): Promise<GridOverview> {
    const value = await this.cached("list", async () => {
      const body = (await this.get("/v1/elnatsavgifter")) as Record<string, any>;
      if (!body || !Array.isArray(body.foretag)) throw new GridError("The grid fee source returned an unexpected format.");
      return trimOverview(body);
    });
    return value!;
  }

  /** One company's fees, or null if there's no company with that slug. */
  async company(slug: string): Promise<GridDetail | null> {
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
    return this.cached(`co:${slug}`, async () => {
      const body = (await this.get(`/v1/elnatsavgifter/${slug}`)) as Record<string, any> | null;
      if (body === null) return null;
      if (!body || !Array.isArray(body.typkunder)) throw new GridError("The grid fee source returned an unexpected format.");
      return trimDetail(body);
    });
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = memory.get(key) as Cached<T> | undefined;
    if (hit && hit.until > Date.now()) return hit.value;
    if (this.kv) {
      const stored = await this.kv.get<T>(KV_PREFIX + key, "json").catch(() => null);
      if (stored !== null) {
        remember(key, stored);
        return stored;
      }
    }
    const value = await load();
    remember(key, value);
    // Not-found answers stay in memory only; real data goes to KV for every isolate.
    if (this.kv && value !== null) {
      await this.kv.put(KV_PREFIX + key, JSON.stringify(value), { expirationTtl: TTL_MS / 1000 }).catch(() => {});
    }
    return value;
  }

  private async get(path: string): Promise<unknown | null> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.base + path, { headers, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new GridError("Couldn't reach the grid fee source (elprisernaidag.se). Try again, or give grid_fee_ore yourself.");
    }
    if (response.status === 404) return null;
    if (response.status === 429) {
      throw new GridError("The grid fee source is busy right now (rate limit). Try again later, or give grid_fee_ore yourself.");
    }
    if (!response.ok) {
      throw new GridError(`The grid fee source answered HTTP ${response.status}. Try again later, or give grid_fee_ore yourself.`);
    }
    return response.json();
  }
}

function remember(key: string, value: unknown) {
  if (memory.size >= 300) memory.delete(memory.keys().next().value!);
  memory.set(key, { value, until: Date.now() + TTL_MS });
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function trimOverview(body: Record<string, any>): GridOverview {
  return {
    median_kr_per_year_incl_vat: num(body.median_referens_kr_per_ar_inkl_moms),
    latest_year: str(body.senaste_ar),
    companies: body.foretag
      .filter((c: any) => typeof c?.slug === "string" && typeof c?.namn === "string")
      .map((c: any) => ({
        slug: c.slug,
        name: c.namn,
        legal_name: str(c.juridiskt_namn),
        area: str(c.omrade) ?? null,
        latest_year: str(c.senaste_ar) ?? null,
        reference: c.referens
          ? {
              customer: str(c.referens.typkund),
              year: str(c.referens.ar),
              total_kr_per_year_incl_vat: num(c.referens.totalt_kr_per_ar_inkl_moms),
              variable_ore_per_kwh: num(c.referens.rorlig_ore_per_kwh),
            }
          : null,
      })),
  };
}

function trimDetail(body: Record<string, any>): GridDetail {
  const m = body.mot_median;
  return {
    slug: String(body.slug),
    name: String(body.namn),
    legal_name: str(body.juridiskt_namn),
    area: str(body.omrade) ?? null,
    latest_year: str(body.senaste_ar) ?? null,
    vat_note: str(body.moms_not),
    limitations: Array.isArray(body.begransningar) ? body.begransningar.filter((x: unknown) => typeof x === "string") : undefined,
    vs_median: m
      ? {
          customer: str(m.typkund),
          year: str(m.ar),
          difference_kr_per_year_incl_vat: num(m.skillnad_kr_per_ar_inkl_moms),
          difference_percent: num(m.skillnad_procent),
        }
      : null,
    customers: body.typkunder
      .filter((t: any) => typeof t?.typkund === "string")
      .map((t: any) => ({
        id: t.typkund,
        label: str(t.etikett) ?? t.typkund,
        change_percent: num(t.forandring?.procent),
        years: Object.fromEntries(
          Object.entries((t.ar ?? {}) as Record<string, any>).map(([year, f]) => [
            year,
            {
              fast_kr_per_ar: num(f?.fast_kr_per_ar),
              myndighetsavgift_kr_per_ar: num(f?.myndighetsavgift_kr_per_ar),
              rorlig_ore_per_kwh: num(f?.rorlig_ore_per_kwh),
              totalt_kr_per_ar: num(f?.totalt_kr_per_ar),
              totalt_kr_per_ar_inkl_moms: num(f?.totalt_kr_per_ar_inkl_moms),
            },
          ]),
        ),
      })),
    page: str(body.sida),
  };
}

// ---------- Finding a company from what the user calls it ----------

/** Lowercase, no diacritics (å ä ö é → a a o e), only letters and digits. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Words that say nothing about which company it is.
const FILLER = new Set(["ab", "elnat", "nat", "natet", "elnatet", "ek", "for", "i", "och", "publ", "aktiebolag", "ekonomisk", "forening"]);

function words(s: string): string[] {
  return normalize(s).split(" ").filter((w) => w && !FILLER.has(w));
}

/** Companies matching the user's words, best first. */
export function searchCompanies(companies: GridCompany[], query: string, limit = 15): GridCompany[] {
  const q = normalize(query);
  const qWords = words(query);
  if (!q) return [];
  const scored: { c: GridCompany; score: number }[] = [];
  for (const c of companies) {
    const name = normalize(c.name);
    const haystack = normalize([c.name, c.legal_name ?? "", c.area ?? "", c.slug.replace(/-/g, " ")].join(" "));
    const tokens = haystack.split(" ");
    let score = 0;
    if (c.slug === query.trim().toLowerCase()) score = 100;
    else if (name === q || normalize(c.legal_name ?? "") === q) score = 90;
    else if (name.startsWith(q + " ") || name.startsWith(q)) score = 70;
    else if (qWords.length && qWords.every((w) => tokens.some((t) => t.startsWith(w)))) score = 50;
    else if (q.length >= 3 && haystack.includes(q)) score = 40;
    if (score) scored.push({ c, score: score - name.length / 1000 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.c);
}

export type Resolved = { company: GridCompany } | { candidates: GridCompany[] };

/**
 * One company if the words point at one, otherwise the candidates. Big companies have several grid areas
 * (Ellevio, Vattenfall, E.ON), some of them old ones with no recent figures; areas with current figures win.
 */
export function resolveCompany(companies: GridCompany[], query: string): Resolved {
  const hits = searchCompanies(companies, query, 40);
  if (hits.length === 1) return { company: hits[0]! };
  if (!hits.length) return { candidates: [] };
  const q = normalize(query);
  const exact = hits.filter((c) => c.slug === query.trim().toLowerCase() || normalize(c.name) === q || normalize(c.legal_name ?? "") === q);
  if (exact.length === 1) return { company: exact[0]! };
  const newest = hits.reduce((y, c) => (c.latest_year && c.latest_year > y ? c.latest_year : y), "");
  const current = hits.filter((c) => c.latest_year === newest);
  if (current.length === 1) return { company: current[0]! };
  return { candidates: [...current, ...hits.filter((c) => c.latest_year !== newest)].slice(0, 15) };
}

/** The standard customer that best matches the user's words, or the reference customer (villa 20 A, 20 000 kWh). */
export function pickCustomer(detail: GridDetail, wanted?: string, reference?: string): CustomerType | undefined {
  const usable = detail.customers.filter((c) => Object.keys(c.years).length);
  if (!usable.length) return undefined;
  const byWords = (text: string) => {
    const w = words(text);
    let best: CustomerType | undefined;
    let bestScore = 0;
    for (const c of usable) {
      const tokens = normalize(`${c.id} ${c.label}`).split(" ");
      const score = w.filter((x) => tokens.some((t) => t === x || t.startsWith(x))).length;
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    return best;
  };
  if (wanted) {
    const found = byWords(wanted);
    if (found) return found;
  }
  if (reference) {
    const r = normalize(reference);
    const found = usable.find((c) => normalize(c.id) === r || normalize(c.label) === r);
    if (found) return found;
  }
  return byWords("villa 20") ?? usable[0];
}

/** The fee for the given year, or the latest year before it (fees are set per calendar year). */
export function feeForYear(customer: CustomerType, year: number): { year: string; fee: AnnualFee } | undefined {
  const years = Object.keys(customer.years)
    .filter((y) => /^\d{4}$/.test(y) && customer.years[y]!.rorlig_ore_per_kwh !== undefined)
    .sort();
  if (!years.length) return undefined;
  const pick = years.filter((y) => Number(y) <= year).pop() ?? years[years.length - 1]!;
  return { year: pick, fee: customer.years[pick]! };
}

export const round1 = (x: number) => Math.round(x * 10) / 10;
export const round0 = (x: number) => Math.round(x);
