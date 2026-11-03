import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  average,
  cheapestSlots,
  cheapestWindow,
  dayLabel,
  describeWindow,
  ore,
  slots,
  summarize,
  VAT,
} from "./analysis";
import { AREAS, ElprisClient, FIRST_DATE, PriceError, type Area, type Quarter } from "./elpris";
import { KINDS, MAX_MESSAGE, saveFeedback } from "./feedback";
import { addDays, isDate, localDate, localTime, parseLocal } from "./time";

export interface ToolEnv {
  ELPRIS_BASE_URL?: string;
  FEEDBACK?: KVNamespace;
  /** Fixed "now" for tests, ISO 8601. */
  NOW_OVERRIDE?: string;
}

const SOURCE = "Elpriset just nu.se (Nord Pool day-ahead)";
const PUBLISH_NOTE = "Tomorrow's prices are published around 13:00 Swedish time.";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const area = z
  .enum(AREAS)
  .describe(
    "Swedish price area. SE1 = northern Norrland (Luleå, Kiruna), SE2 = southern Norrland (Sundsvall, Umeå, Östersund), " +
      "SE3 = central Sweden (Stockholm, Göteborg, Uppsala, Örebro, Västerås), SE4 = southern Sweden (Malmö, Helsingborg, Lund). " +
      "If you don't know where the user lives, ask, or use SE3 and say so.",
  );
const date = z.string().refine(isDate, "Use YYYY-MM-DD").describe("Date as YYYY-MM-DD (Swedish time); defaults to today");
const withVat = z.boolean().optional().describe("Add 25 % VAT (moms) to the spot price. Default false.");

export function buildServer(env: ToolEnv): McpServer {
  const server = new McpServer(
    { name: "elpriskollen", version: "1.0.0" },
    {
      instructions:
        "Swedish electricity spot prices (Nord Pool day-ahead) for SE1–SE4, per 15 minutes, in öre/kWh. " +
        "Prices are the raw spot price: they exclude the supplier's markup, energy tax (energiskatt), grid fees (elnät) " +
        "and, unless include_vat is set, VAT. Say this when talking about what electricity costs. " +
        PUBLISH_NOTE +
        " Use find_cheapest_time for 'when should I run the dishwasher / washing machine / charge the car'. " +
        "If the user wants something Elpriskollen can't do yet, you may offer to pass it on with send_feedback. " +
        "Data: Elpriset just nu.se. Answer in the user's language (usually Swedish).",
    },
  );
  const client = new ElprisClient(env.ELPRIS_BASE_URL);
  const now = () => (env.NOW_OVERRIDE ? Date.parse(env.NOW_OVERRIDE) : Date.now());

  /** Quarters for consecutive local days, stopping at the first day not yet published. */
  async function daysFrom(a: Area, first: string, count: number) {
    const quarters: Quarter[] = [];
    let lastPublished: string | undefined;
    for (let i = 0; i < count; i++) {
      const day = addDays(first, i);
      const qs = await client.day(a, day);
      if (!qs) break;
      quarters.push(...qs);
      lastPublished = day;
    }
    return { quarters, lastPublished };
  }

  server.registerTool(
    "get_prices",
    {
      title: "Prices for a day",
      description:
        "Electricity prices for one day and area: hour by hour (or per 15 minutes), plus the day's average, lowest, " +
        "highest, cheapest and most expensive hour. Works for today, tomorrow (after about 13:00) and past days back to 2022-11-01.",
      inputSchema: z.object({
        area,
        date: date.optional(),
        resolution: z.enum(["hour", "quarter"]).optional().describe("hour (default, averages of the quarters) or quarter"),
        include_vat: withVat,
      }),
      annotations: READ_ONLY,
    },
    async ({ area: a, date: d, resolution, include_vat }) =>
      run(async () => {
        const t = now();
        const day = d ?? localDate(t);
        const qs = await client.day(a, day);
        if (!qs) return notPublished(a, day, t);
        const vat = include_vat ?? false;
        return {
          area: a,
          date: day,
          unit: vat ? "öre/kWh incl. VAT" : "öre/kWh excl. VAT",
          summary: summarize(qs, vat),
          prices: slots(qs, resolution ?? "hour").map((s) => ({ time: localTime(s.start), ore: ore(s.sek, vat) })),
          source: SOURCE,
        };
      }),
  );

  server.registerTool(
    "get_current_price",
    {
      title: "Price right now",
      description:
        "The electricity price right now: this quarter and this hour, how it compares with the rest of today, " +
        "the next few hours, and whether tomorrow's prices are out yet.",
      inputSchema: z.object({ area, include_vat: withVat }),
      annotations: READ_ONLY,
    },
    async ({ area: a, include_vat }) =>
      run(async () => {
        const t = now();
        const today = localDate(t);
        const vat = include_vat ?? false;
        const { quarters, lastPublished } = await daysFrom(a, today, 2);
        const todays = quarters.filter((q) => localDate(q.start) === today);
        const current = quarters.find((q) => q.start <= t && t < q.end);
        if (!current || !todays.length) throw new PriceError(`No prices found for ${a} right now. Try again in a few minutes.`);
        const hourStart = Math.floor(t / 3_600_000) * 3_600_000;
        const thisHour = quarters.filter((q) => q.start >= hourStart && q.start < hourStart + 3_600_000);
        const cheaper = todays.filter((q) => q.sek < current.sek).length;
        const next = slots(
          quarters.filter((q) => q.start >= hourStart + 3_600_000 && q.start < hourStart + 7 * 3_600_000),
          "hour",
        );
        return {
          area: a,
          unit: vat ? "öre/kWh incl. VAT" : "öre/kWh excl. VAT",
          now: { from: localTime(current.start), to: localTime(current.end), ore: ore(current.sek, vat) },
          this_hour: ore(average(thisHour), vat),
          today: summarize(todays, vat),
          compared_to_today: `${Math.round((cheaper / todays.length) * 100)} % of today's quarters are cheaper than right now`,
          next_hours: next.map((s) => ({ hour: `${dayLabel(s.start, t) === "today" ? "" : "tomorrow "}${localTime(s.start)}`, ore: ore(s.sek, vat) })),
          tomorrow_published: lastPublished === addDays(today, 1),
          note: lastPublished === addDays(today, 1) ? undefined : PUBLISH_NOTE,
          source: SOURCE,
        };
      }),
  );

  server.registerTool(
    "find_cheapest_time",
    {
      title: "Cheapest time to use electricity",
      description:
        "Finds the cheapest time to run something that takes a while: dishwasher, washing machine, tumble dryer, " +
        "sauna, or charging an electric car. Give how long it runs and optionally a time range (for example 'start " +
        "after 22:00, done by 07:00'). Returns the cheapest window, how much cheaper it is than starting now and than " +
        "the most expensive window, and the cost if you give the energy use in kWh. Set together=false when the load " +
        "can be split into separate periods (car charging, a pool pump). Looks at today and tomorrow once published.",
      inputSchema: z.object({
        area,
        minutes: z.number().int().min(15).max(24 * 60).describe("How long it runs, in minutes"),
        earliest: z
          .string()
          .optional()
          .describe("Earliest start, 'HH:MM' (next time it occurs) or 'YYYY-MM-DD HH:MM'. Default: now"),
        latest: z
          .string()
          .optional()
          .describe("Must be finished by, 'HH:MM' (next time after earliest) or 'YYYY-MM-DD HH:MM'. Default: last published price"),
        together: z.boolean().optional().describe("Run in one go (default true) or allow separate periods (false)"),
        kwh: z.number().positive().max(500).optional().describe("Energy it uses in total, kWh, to estimate the spot cost"),
        include_vat: withVat,
      }),
      annotations: READ_ONLY,
    },
    async ({ area: a, minutes, earliest, latest, together, kwh, include_vat }) =>
      run(async () => {
        const t = now();
        const vat = include_vat ?? false;
        const from = earliest ? parseLocal(earliest, t) : t;
        const to = latest ? parseLocal(latest, from) : Infinity;
        if (to <= from) throw new Error("'latest' must be after 'earliest'.");
        if (from < t - 15 * 60 * 1000) throw new Error("'earliest' is in the past. This tool plans ahead from now.");

        const firstDay = localDate(from);
        const span = to === Infinity ? 2 : Math.min(3, Math.round((Date.parse(localDate(to - 1)) - Date.parse(firstDay)) / 86_400_000) + 1);
        const { quarters, lastPublished } = await daysFrom(a, firstDay, span);
        if (!quarters.length) return notPublished(a, firstDay, t);
        const dataEnd = quarters[quarters.length - 1]!.end;
        const end = Math.min(to, dataEnd);
        const limited = to !== Infinity && to > dataEnd;

        const unit = vat ? "öre/kWh incl. VAT" : "öre/kWh excl. VAT";
        const cost = (sek: number) => (kwh ? Math.round(sek * kwh * (vat ? 1 + VAT : 1) * 100) / 100 : undefined);
        const base = {
          area: a,
          unit,
          runs_for_minutes: minutes,
          searched: `${dayLabel(Math.max(from, quarters[0]!.start), t)} ${localTime(Math.max(from, quarters[0]!.start))} – ${dayLabel(end - 1, t)} ${localTime(end)}`,
          note: limited ? `Prices after ${localTime(dataEnd)} ${dayLabel(dataEnd - 1, t)} aren't published yet. ${PUBLISH_NOTE}` : undefined,
        };

        if (together === false) {
          const found = cheapestSlots(quarters, minutes, from, end);
          if (!found) throw new Error("Not enough published prices in that range for this many minutes.");
          return {
            ...base,
            mode: "separate periods",
            periods: found.runs.map((r) => describeWindow(r, vat, t)),
            average_ore: ore(found.sek, vat),
            spot_cost_kr: cost(found.sek),
            source: SOURCE,
          };
        }

        const found = cheapestWindow(quarters, minutes, from, end);
        if (!found) throw new Error("There is no window that long inside the range with published prices. Widen the range or shorten the time.");
        const { best, worst, startNow } = found;
        const saving = (other: { sek: number }) => {
          const diff = other.sek - best.sek;
          const pct = other.sek > 0 ? Math.round((diff / other.sek) * 100) : undefined;
          return { ore_per_kwh: ore(diff, vat), percent: pct, kr: cost(diff) };
        };
        return {
          ...base,
          mode: "in one go",
          cheapest: { ...describeWindow(best, vat, t), spot_cost_kr: cost(best.sek) },
          [earliest ? "if_started_at_earliest" : "if_started_now"]: startNow
            ? { ...describeWindow(startNow, vat, t), spot_cost_kr: cost(startNow.sek), cheapest_saves: saving(startNow) }
            : undefined,
          most_expensive: { ...describeWindow(worst, vat, t), cheapest_saves: saving(worst) },
          rounded_to: found.windowMinutes !== minutes ? `${found.windowMinutes} minutes (prices come per ${found.slotMinutes} minutes)` : undefined,
          tomorrow_published: lastPublished !== undefined && lastPublished > localDate(t),
          source: SOURCE,
        };
      }),
  );

  server.registerTool(
    "compare_areas",
    {
      title: "Compare SE1–SE4",
      description: "Average, lowest and highest price in all four Swedish price areas for one day (default today).",
      inputSchema: z.object({ date: date.optional(), include_vat: withVat }),
      annotations: READ_ONLY,
    },
    async ({ date: d, include_vat }) =>
      run(async () => {
        const t = now();
        const day = d ?? localDate(t);
        const vat = include_vat ?? false;
        const results = await Promise.all(AREAS.map((a) => client.day(a, day)));
        if (results.every((r) => !r)) return notPublished("SE1–SE4", day, t);
        return {
          date: day,
          unit: vat ? "öre/kWh incl. VAT" : "öre/kWh excl. VAT",
          areas: AREAS.map((a, i) => {
            const qs = results[i];
            if (!qs) return { area: a, published: false };
            const s = summarize(qs, vat);
            return { area: a, average: s.average, lowest: s.lowest, highest: s.highest };
          }),
          source: SOURCE,
        };
      }),
  );

  server.registerTool(
    "get_daily_averages",
    {
      title: "Daily averages over a period",
      description:
        "Average, lowest and highest price per day for up to 31 days, plus the period's average and its cheapest and " +
        "most expensive day. Good for 'is today expensive?', 'how was October?' or trends. Default: the last 7 days.",
      inputSchema: z.object({ area, start_date: date.optional(), end_date: date.optional(), include_vat: withVat }),
      annotations: READ_ONLY,
    },
    async ({ area: a, start_date, end_date, include_vat }) =>
      run(async () => {
        const t = now();
        const vat = include_vat ?? false;
        const last = end_date ?? localDate(t);
        const first = start_date ?? addDays(last, -6);
        if (first > last) throw new Error("start_date is after end_date.");
        if (first < FIRST_DATE) throw new Error(`Prices are available from ${FIRST_DATE}.`);
        const days: string[] = [];
        for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
        if (days.length > 31) throw new Error(`Ask for at most 31 days at a time (got ${days.length}).`);

        const rows: Array<{ date: string; qs: Quarter[] | null }> = [];
        for (let i = 0; i < days.length; i += 8) {
          const batch = days.slice(i, i + 8);
          const got = await Promise.all(batch.map((day) => client.day(a, day)));
          batch.forEach((day, k) => rows.push({ date: day, qs: got[k]! }));
        }
        const published = rows.filter((r): r is { date: string; qs: Quarter[] } => !!r.qs);
        if (!published.length) return notPublished(a, first, t);
        const perDay = published.map((r) => ({ date: r.date, avg: average(r.qs), s: summarize(r.qs, vat) }));
        const cheapest = perDay.reduce((x, y) => (y.avg < x.avg ? y : x));
        const dearest = perDay.reduce((x, y) => (y.avg > x.avg ? y : x));
        return {
          area: a,
          unit: vat ? "öre/kWh incl. VAT" : "öre/kWh excl. VAT",
          period: `${first} – ${last}`,
          period_average: ore(average(published.flatMap((r) => r.qs)), vat),
          cheapest_day: { date: cheapest.date, average: cheapest.s.average },
          most_expensive_day: { date: dearest.date, average: dearest.s.average },
          days: perDay.map((d) => ({ date: d.date, average: d.s.average, lowest: d.s.lowest.ore, highest: d.s.highest.ore })),
          missing_days: rows.length > published.length ? rows.filter((r) => !r.qs).map((r) => r.date) : undefined,
          source: SOURCE,
        };
      }),
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback to the developer",
      description:
        "Send a feature request, bug report or praise to the person who runs Elpriskollen. Only use this when the " +
        "user asks to send feedback or agrees to pass a suggestion on. Write the message in the user's words, show " +
        "it to them and get their OK before sending. Leave out names, addresses and other personal details; add a " +
        "contact e-mail only if the user gives one and wants a reply.",
      inputSchema: z.object({
        message: z.string().min(5).max(MAX_MESSAGE).describe("The feedback, in the user's own words"),
        kind: z.enum(KINDS).optional().describe("feature (default for wishes), bug, praise or other"),
        area: area.optional(),
        contact: z.string().max(120).optional().describe("E-mail for a reply, only if the user wants one"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ message, kind, area: a, contact }) =>
      run(async () => {
        const saved = await saveFeedback(env, { source: "claude", kind, message, area: a, contact });
        if (!saved.ok) throw new Error(saved.reason);
        return { sent: true, note: "Thanks! The developer reads every suggestion." };
      }),
  );

  return server;
}

function notPublished(a: string, day: string, now: number) {
  const tomorrow = addDays(localDate(now), 1);
  return {
    area: a,
    date: day,
    published: false,
    message:
      day === tomorrow
        ? `Tomorrow's prices (${day}) aren't published yet. ${PUBLISH_NOTE}`
        : day > tomorrow
          ? "Prices are only published one day ahead."
          : "No prices were found for that day.",
  };
}

async function run(body: () => Promise<unknown>) {
  try {
    const result = await body();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}
