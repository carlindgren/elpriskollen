import { beforeEach, describe, expect, it } from "vitest";
import { clearGridCacheForTests, feeForYear, GridClient, normalize, pickCustomer, resolveCompany, searchCompanies } from "../src/grid";
// @ts-expect-error plain JS fixtures
import { gridCompany, gridOverview } from "./fixtures.mjs";

const fakeFetch = (log: string[]) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization ?? "-"}`);
    const m = /\/v1\/elnatsavgifter(?:\/([a-z0-9-]+))?$/.exec(url);
    const body = m ? (m[1] ? gridCompany(m[1]) : gridOverview()) : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 404 });
  }) as typeof fetch;

describe("grid companies", () => {
  beforeEach(() => clearGridCacheForTests());

  it("normalizes Swedish names", () => {
    expect(normalize("Göteborg Energi Nät AB")).toBe("goteborg energi nat ab");
    expect(normalize("E.ON")).toBe("e on");
  });

  it("finds companies by name, part of a name, town or slug", async () => {
    const { companies } = await new GridClient("https://x", undefined, undefined, fakeFetch([])).overview();
    const one = (q: string) => {
      const r = resolveCompany(companies, q);
      return "company" in r ? r.company.slug : r.candidates.map((c) => c.slug);
    };
    expect(one("Ellevio")).toBe("ellevio");
    expect(one("vattenfall")).toBe("vattenfall-eldistribution");
    expect(one("Göteborg")).toBe("goteborg-energi-nat");
    expect(one("goteborg energi elnät")).toBe("goteborg-energi-nat");
    expect(one("Eon")).toBe("eon-energidistribution");
    expect(one("E.ON")).toBe("eon-energidistribution");
    expect(one("borlange-energi-elnat")).toBe("borlange-energi-elnat");
    expect(one("Energi")).toEqual(expect.arrayContaining(["goteborg-energi-nat", "borlange-energi-elnat"]));
    expect(searchCompanies(companies, "Tekniska verken")).toEqual([]);
    // Two Ellevio areas in Stockholm, only one with current figures: that one wins.
    expect(one("Ellevio Stockholm")).toBe("ellevio");
    expect(one("Täby")).toBe("ellevio-ab-f-d-taby");
    // "Ellevio AB" is the legal name of both; the current one wins.
    expect(one("Ellevio AB")).toBe("ellevio");
  });

  it("picks the standard customer and the year", async () => {
    const detail = (await new GridClient("https://x", undefined, undefined, fakeFetch([])).company("ellevio"))!;
    expect(pickCustomer(detail, "lägenhet")!.id).toBe("lagenhet-16a-2000");
    expect(pickCustomer(detail, "villa 16 A")!.id).toBe("villa-16a-5000");
    expect(pickCustomer(detail, undefined, "villa-20a-20000")!.id).toBe("villa-20a-20000");
    const villa = pickCustomer(detail, "villa 20")!;
    expect(feeForYear(villa, 2026)).toMatchObject({ year: "2026", fee: { rorlig_ore_per_kwh: 20 } });
    expect(feeForYear(villa, 2025)!.fee.rorlig_ore_per_kwh).toBe(18);
    expect(feeForYear(villa, 2027)!.year).toBe("2026");
  });

  it("caches answers, sends the key and returns null for unknown companies", async () => {
    const log: string[] = [];
    const client = new GridClient("https://x/", "ep_live_abc", undefined, fakeFetch(log));
    await client.overview();
    await client.overview();
    expect(await client.company("finns-inte")).toBeNull();
    expect(await client.company("../etc")).toBeNull();
    expect(log).toEqual(["https://x/v1/elnatsavgifter Bearer ep_live_abc", "https://x/v1/elnatsavgifter/finns-inte Bearer ep_live_abc"]);
  });
});
