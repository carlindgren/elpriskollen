// Client for the free price API at elprisetjustnu.se (Nord Pool day-ahead prices).
// One JSON file per area and day: /api/v1/prices/YYYY/MM-DD_SE3.json
// Since 1 October 2025 each day has 96 quarter-hour prices (92 or 100 on DST days).

export const AREAS = ["SE1", "SE2", "SE3", "SE4"] as const;
export type Area = (typeof AREAS)[number];

export const DEFAULT_BASE_URL = "https://www.elprisetjustnu.se";
const USER_AGENT = "elpriskollen (+https://github.com/carlindgren/elpriskollen)";
// The first day the API has prices for.
export const FIRST_DATE = "2022-11-01";

export interface Quarter {
  start: number; // UTC ms
  end: number;
  sek: number; // SEK per kWh, excl. VAT
}

interface RawPrice {
  SEK_per_kWh: number;
  EUR_per_kWh?: number;
  EXR?: number;
  time_start: string;
  time_end: string;
}

export class PriceError extends Error {}

interface CacheEntry {
  until: number;
  value: Quarter[] | null;
}

// Per-isolate cache. Published prices never change, so keep them for hours;
// "not published yet" answers only for a few minutes.
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 400;
const FOUND_TTL = 6 * 60 * 60 * 1000;
const MISSING_TTL = 5 * 60 * 1000;

export function clearCacheForTests(): void {
  cache.clear();
}

export class ElprisClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl?: string, fetchImpl?: typeof fetch) {
    this.base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Quarter prices for one area and local day, or null when not published (yet). */
  async day(area: Area, date: string): Promise<Quarter[] | null> {
    if (date < FIRST_DATE) throw new PriceError(`Prices are only available from ${FIRST_DATE}.`);
    const key = `${area}/${date}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;

    const [y, m, d] = date.split("-");
    const url = `${this.base}/api/v1/prices/${y}/${m}-${d}_${area}.json`;
    const response = await this.fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
    let value: Quarter[] | null;
    if (response.status === 404) {
      value = null;
    } else if (!response.ok) {
      throw new PriceError(`The price source answered HTTP ${response.status}. Try again in a minute.`);
    } else {
      value = parse(await response.json());
    }
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { value, until: Date.now() + (value ? FOUND_TTL : MISSING_TTL) });
    return value;
  }
}

function parse(body: unknown): Quarter[] {
  if (!Array.isArray(body)) throw new PriceError("The price source returned an unexpected format.");
  const out: Quarter[] = [];
  for (const row of body as RawPrice[]) {
    const start = Date.parse(row?.time_start);
    const end = Date.parse(row?.time_end);
    const sek = Number(row?.SEK_per_kWh);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(sek)) {
      throw new PriceError("The price source returned a row it could not read.");
    }
    out.push({ start, end, sek });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
