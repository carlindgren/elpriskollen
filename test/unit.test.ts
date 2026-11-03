import { beforeEach, describe, expect, it } from "vitest";
import { average, cheapestSlots, cheapestWindow, ore, slots, summarize } from "../src/analysis";
import { clearCacheForTests, ElprisClient, type Quarter } from "../src/elpris";
import { localStamp, parseLocal, zonedToUtc } from "../src/time";
// @ts-expect-error plain JS helper
import { dayJson } from "./fixtures.mjs";

const quarters = (area: string, date: string): Quarter[] =>
  (dayJson(area, date) as Array<{ SEK_per_kWh: number; time_start: string; time_end: string }>).map((r) => ({
    start: Date.parse(r.time_start),
    end: Date.parse(r.time_end),
    sek: r.SEK_per_kWh,
  }));

describe("Swedish time", () => {
  it("converts local times across daylight saving", () => {
    expect(new Date(zonedToUtc("2026-11-03", "20:10")).toISOString()).toBe("2026-11-03T19:10:00.000Z");
    expect(new Date(zonedToUtc("2026-07-01", "12:00")).toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(new Date(zonedToUtc("2026-03-29", "03:00")).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("reads HH:MM as the next time it occurs", () => {
    const now = zonedToUtc("2026-11-03", "20:10");
    expect(localStamp(parseLocal("22:00", now))).toBe("2026-11-03 22:00");
    expect(localStamp(parseLocal("07:00", now))).toBe("2026-11-04 07:00");
    expect(localStamp(parseLocal("2026-11-04 06:30", now))).toBe("2026-11-04 06:30");
    expect(() => parseLocal("tomorrow", now)).toThrow(/HH:MM/);
  });
});

describe("prices", () => {
  it("has 96 quarters on a normal day, 92 and 100 on DST days", () => {
    expect(quarters("SE3", "2026-11-03")).toHaveLength(96);
    expect(quarters("SE3", "2026-03-29")).toHaveLength(92);
    expect(quarters("SE3", "2026-10-25")).toHaveLength(100);
    expect(slots(quarters("SE3", "2026-03-29"), "hour")).toHaveLength(23);
    expect(slots(quarters("SE3", "2026-10-25"), "hour")).toHaveLength(25);
  });

  it("averages quarters into hours and summarises a day", () => {
    const qs = quarters("SE3", "2026-11-04");
    const hours = slots(qs, "hour");
    expect(hours).toHaveLength(24);
    expect(hours[0]!.sek).toBeCloseTo(average(qs.slice(0, 4)), 10);
    const s = summarize(qs, false);
    expect(s.lowest).toEqual({ at: "13:15", ore: -2 });
    expect(s.negative_quarters).toBe(1);
    expect(s.cheapest_hour).toBe("13:00–14:00"); // the negative quarter pulls 13–14 below the night
    expect(summarize(quarters("SE3", "2026-11-03"), false).cheapest_hour).toBe("00:00–01:00");
    expect(s.most_expensive_hour).toMatch(/^(17|18|19|20):00/);
    expect(ore(0.5, true)).toBe(62.5);
  });

  it("finds the cheapest contiguous window (checked by brute force)", () => {
    const qs = [...quarters("SE3", "2026-11-03"), ...quarters("SE3", "2026-11-04")];
    const from = zonedToUtc("2026-11-03", "20:10");
    const to = zonedToUtc("2026-11-04", "07:00");
    const found = cheapestWindow(qs, 120, from, to)!;
    let best = Infinity;
    for (let i = 0; i + 8 <= qs.length; i++) {
      if (qs[i]!.end <= from || qs[i + 7]!.end > to) continue;
      best = Math.min(best, average(qs.slice(i, i + 8)));
    }
    expect(found.best.sek).toBeCloseTo(best, 10);
    expect(found.best.end - found.best.start).toBe(2 * 3600_000);
    expect(localStamp(found.best.start)).toBe("2026-11-04 00:00");
    expect(found.startNow!.start).toBe(zonedToUtc("2026-11-03", "20:00")); // the quarter running at 20:10
    expect(found.worst.sek).toBeGreaterThan(found.startNow!.sek - 1e-9);
  });

  it("rounds odd durations up to whole quarters and refuses too-long windows", () => {
    const qs = quarters("SE3", "2026-11-04");
    const day = zonedToUtc("2026-11-04", "00:00");
    expect(cheapestWindow(qs, 50, day, day + 24 * 3600_000)!.windowMinutes).toBe(60);
    expect(cheapestWindow(qs, 600, day, day + 3 * 3600_000)).toBeUndefined();
  });

  it("picks the cheapest separate quarters and merges neighbours", () => {
    const qs = quarters("SE3", "2026-11-04");
    const day = zonedToUtc("2026-11-04", "00:00");
    const found = cheapestSlots(qs, 60, day, day + 24 * 3600_000)!;
    const cheapest4 = [...qs].sort((a, b) => a.sek - b.sek).slice(0, 4);
    expect(found.sek).toBeCloseTo(average(cheapest4), 10);
    expect(found.runs.some((r) => localStamp(r.start).endsWith("13:15"))).toBe(true);
  });
});

describe("price client", () => {
  beforeEach(() => clearCacheForTests());

  it("builds the right URL, parses rows and caches", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json(dayJson("SE4", "2026-11-03"));
    }) as typeof fetch;
    const client = new ElprisClient("https://example.test/", fetchImpl);
    const qs = (await client.day("SE4", "2026-11-03"))!;
    await client.day("SE4", "2026-11-03");
    expect(urls).toEqual(["https://example.test/api/v1/prices/2026/11-03_SE4.json"]);
    expect(qs).toHaveLength(96);
    expect(qs[0]!.start).toBe(zonedToUtc("2026-11-03", "00:00"));
  });

  it("returns null when a day isn't published and errors on other failures", async () => {
    const client404 = new ElprisClient("https://x.test", (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch);
    expect(await client404.day("SE3", "2026-11-05")).toBeNull();
    const client500 = new ElprisClient("https://x.test", (async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    await expect(client500.day("SE3", "2026-11-02")).rejects.toThrow(/HTTP 503/);
    await expect(client500.day("SE3", "2020-01-01")).rejects.toThrow(/2022-11-01/);
  });
});
