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
import { energyTax, hasCostSettings, missingParts, totalPrice, type CostSettings } from "./costs";
import { KINDS, MAX_MESSAGE, saveFeedback } from "./feedback";
import {
  feeForYear,
  GRID_SOURCE,
  GRID_SOURCE_URL,
  GridClient,
  pickCustomer,
  resolveCompany,
  round0,
  round1,
  type GridCompany,
} from "./grid";
import { addDays, isDate, localDate, localTime, parseLocal, zonedToUtc } from "./time";

export interface ToolEnv {
  ELPRIS_BASE_URL?: string;
  GRID_BASE_URL?: string;
  /** Optional key for api.elprisernaidag.se (2000 instead of 120 requests/hour). */
  ELPRISERNAIDAG_KEY?: string;
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

// The user's own fees, for the real price per kWh. Flat so they're easy to fill in.
const costParams = {
  grid_fee_ore: z
    .number()
    .min(0)
    .max(300)
    .optional()
    .describe("The user's grid transfer fee (överföringsavgift / elöverföring), öre/kWh, from the grid bill or price list"),
  grid_fee_percent_of_spot: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("For spot-indexed grid tariffs (fixed part + X % of the spot price): the percentage, e.g. 6.19"),
  supplier_markup_ore: z
    .number()
    .min(-50)
    .max(200)
    .optional()
    .describe("The electricity supplier's markup incl. certificates (påslag + elcertifikat), öre/kWh"),
  fees_include_vat: z.boolean().optional().describe("Whether the fees above include VAT (default true, as consumer price lists usually do)"),
  northern_tax_reduction: z
    .boolean()
    .optional()
    .describe("Household in a northern municipality with reduced energy tax (9.6 öre/kWh lower)"),
  grid_company: z
    .string()
    .min(2)
    .max(80)
    .optional()
    .describe(
      "The user's grid company (elnätsbolag), e.g. 'Ellevio', 'Vattenfall Eldistribution', 'E.ON', 'Göteborg Energi', " +
        "or a slug from get_grid_fees. Looks up its variable grid fee (Energimarknadsinspektionen). grid_fee_ore wins if both are given.",
    ),
  grid_customer_type: z
    .string()
    .max(60)
    .optional()
    .describe("With grid_company: what fits the user, e.g. 'lägenhet', 'villa 16 A', 'villa 20 A'. Default: house with a 20 A fuse, 20 000 kWh/year"),
};
const pickCosts = (a: CostSettings): CostSettings => ({
  grid_fee_ore: a.grid_fee_ore,
  grid_fee_percent_of_spot: a.grid_fee_percent_of_spot,
  supplier_markup_ore: a.supplier_markup_ore,
  fees_include_vat: a.fees_include_vat,
  northern_tax_reduction: a.northern_tax_reduction,
});
const NOT_INCLUDED_ALWAYS = "fixed monthly fees and power fees (effektavgift), which don't depend on kWh";
const yearsNote = (c: GridCompany, newest?: string) =>
  c.latest_year && newest && c.latest_year < newest ? `, figures only until ${c.latest_year}` : "";
const companyList = (cs: GridCompany[], newest?: string) => cs.map((c) => `${c.name} (${c.slug}${yearsNote(c, newest)})`).join(", ");

export function buildServer(env: ToolEnv): McpServer {
  const server = new McpServer(
    { name: "elpriskollen", version: "1.1.0" },
    {
      instructions:
        "Swedish electricity spot prices (Nord Pool day-ahead) for SE1–SE4, per 15 minutes, in öre/kWh. " +
        "Prices are the raw spot price: they exclude the supplier's markup, energy tax (energiskatt), grid fees (elnät) " +
        "and, unless include_vat is set, VAT. Say this when talking about what electricity costs. " +
        PUBLISH_NOTE +
        " Use find_cheapest_time for 'when should I run the dishwasher / washing machine / charge the car', " +
        "and get_total_price for what electricity actually costs per kWh with energy tax, VAT and the user's own fees. " +
        "If the user names their grid company (elnätsbolag), pass it as grid_company to get the grid fee looked up; " +
        "get_grid_fees shows a grid company's fees and how they compare. " +
        "If the user wants something Elpriskollen can't do yet, you may offer to pass it on with send_feedback. " +
        "Data: Elpriset just nu.se; grid fees: Energimarknadsinspektionen via elprisernaidag.se. Answer in the user's language (usually Swedish).",
    },
  );
  const client = new ElprisClient(env.ELPRIS_BASE_URL);
  const grid = new GridClient(env.GRID_BASE_URL, env.ELPRISERNAIDAG_KEY, env.FEEDBACK);

  /**
   * The user's fee settings, with the variable grid fee filled in from their grid company when they named one.
   * Returns the settings to price with, what the lookup found, and what still isn't included.
   */
  async function feeSettings(args: CostSettings & { grid_company?: string; grid_customer_type?: string }, year: number) {
    const costs = pickCosts(args);
    if (!args.grid_company) {
      return { costs, grid: undefined, notIncluded: [...missingParts(costs), NOT_INCLUDED_ALWAYS] };
    }
    const { companies, latest_year: newest } = await grid.overview();
    const found = resolveCompany(companies, args.grid_company);
    if (!("company" in found)) {
      throw new Error(
        found.candidates.length
          ? `Several grid companies or grid areas match "${args.grid_company}": ${companyList(found.candidates, newest)}. ` +
              "Ask the user which one is on their grid bill (or where they live), then call again with grid_company set to its slug."
          : `No grid company matches "${args.grid_company}". Ask the user for the name on their grid bill (elnätsfaktura), or search with get_grid_fees.`,
      );
    }
    const detail = await grid.company(found.company.slug);
    const customer = detail && pickCustomer(detail, args.grid_customer_type, found.company.reference?.customer);
    const picked = customer && feeForYear(customer, year);
    if (!detail || !customer || !picked) {
      throw new Error(`There are no grid fees for ${found.company.name} in the data. Ask the user for the överföringsavgift and use grid_fee_ore.`);
    }
    const excl = picked.fee.rorlig_ore_per_kwh!;
    const own = costs.grid_fee_ore !== undefined || costs.grid_fee_percent_of_spot !== undefined;
    const merged: CostSettings = own ? costs : { ...costs, grid_fee_ore: costs.fees_include_vat === false ? excl : excl * (1 + VAT) };
    const fixedIncl = ((picked.fee.fast_kr_per_ar ?? 0) + (picked.fee.myndighetsavgift_kr_per_ar ?? 0)) * (1 + VAT);
    return {
      costs: merged,
      grid: {
        company: detail.name,
        slug: detail.slug,
        customer_type: customer.label,
        year: Number(picked.year) === year ? picked.year : `${picked.year} (latest in the data)`,
        variable_fee_ore_per_kwh_incl_vat: round1(excl * (1 + VAT)),
        variable_fee_ore_per_kwh_excl_vat: round1(excl),
        fixed_fees_kr_per_year_incl_vat: fixedIncl ? round0(fixedIncl) : undefined,
        used: own ? "Not used for the price: the grid_fee you gave was used instead." : "Used as the grid fee per kWh.",
        warning:
          Number(picked.year) < year - 1
            ? `The newest figures for this grid area are from ${picked.year}, so the fee has probably changed since. Tell the user, and use grid_fee_ore if they know their current överföringsavgift.`
            : undefined,
        notes: detail.limitations?.length ? detail.limitations : undefined,
        source: `${GRID_SOURCE} (${GRID_SOURCE_URL})`,
      },
      notIncluded: [
        ...missingParts(merged),
        fixedIncl
          ? `${detail.name}'s fixed fees, about ${round0(fixedIncl)} kr/year (${round0(fixedIncl / 12)} kr/month) incl. VAT, and any power fee (effektavgift)`
          : "the grid company's fixed fees and any power fee (effektavgift)",
        "the electricity supplier's monthly fee",
      ],
    };
  }
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
        kwh: z.number().positive().max(500).optional().describe("Energy it uses in total, kWh, to estimate the cost"),
        include_vat: withVat,
        ...costParams,
      }),
      annotations: READ_ONLY,
    },
    async ({ area: a, minutes, earliest, latest, together, kwh, include_vat, ...rest }) =>
      run(async () => {
        const t = now();
        const fees = await feeSettings(rest, Number(localDate(t).slice(0, 4)));
        const costs = fees.costs;
        const withCosts = hasCostSettings(costs);
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
        // With the user's fees: the full price per kWh and what the run costs in total, incl. VAT.
        const real = (w: { start: number; sek: number }) => {
          if (!withCosts) return undefined;
          const b = totalPrice(w.sek, Number(localDate(w.start).slice(0, 4)), costs);
          return { total_ore_per_kwh_incl_vat: b.total, total_cost_kr: kwh ? Math.round(b.total * kwh) / 100 : undefined };
        };
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
            with_your_fees: real({ start: found.runs[0]!.start, sek: found.sek }),
            grid_fee_lookup: fees.grid,
            not_included: withCosts ? fees.notIncluded : undefined,
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
          cheapest: { ...describeWindow(best, vat, t), spot_cost_kr: cost(best.sek), with_your_fees: real(best) },
          [earliest ? "if_started_at_earliest" : "if_started_now"]: startNow
            ? { ...describeWindow(startNow, vat, t), spot_cost_kr: cost(startNow.sek), with_your_fees: real(startNow), cheapest_saves: saving(startNow) }
            : undefined,
          most_expensive: { ...describeWindow(worst, vat, t), with_your_fees: real(worst), cheapest_saves: saving(worst) },
          grid_fee_lookup: fees.grid,
          not_included: withCosts ? fees.notIncluded : undefined,
          rounded_to: found.windowMinutes !== minutes ? `${found.windowMinutes} minutes (prices come per ${found.slotMinutes} minutes)` : undefined,
          tomorrow_published: lastPublished !== undefined && lastPublished > localDate(t),
          source: SOURCE,
        };
      }),
  );

  server.registerTool(
    "get_total_price",
    {
      title: "What electricity really costs",
      description:
        "The real price per kWh incl. VAT: spot price + energy tax (36.0 öre/kWh excl. VAT in 2026, Skatteverket) + VAT, " +
        "plus the grid fee and the supplier's markup. Shows the breakdown right now (or at a given time) and the day's " +
        "average, lowest and highest total. For the grid fee, set grid_company to the user's grid company (looked up " +
        "from Energimarknadsinspektionen's data) or grid_fee_ore if they know their överföringsavgift. Ask for the " +
        "supplier's påslag; without it the answer lists what's missing. Spot-indexed grid tariffs (a fixed part plus a " +
        "percent of the spot price) use grid_fee_percent_of_spot. Fixed fees and effektavgift aren't per kWh and are " +
        "listed separately.",
      inputSchema: z.object({
        area,
        date: date.optional(),
        at: z.string().regex(/^\d{1,2}:\d{2}$/, "Use HH:MM").optional().describe("Time of day HH:MM for the breakdown; default now (today)"),
        ...costParams,
      }),
      annotations: READ_ONLY,
    },
    async ({ area: a, date: d, at, ...rest }) =>
      run(async () => {
        const t = now();
        const day = d ?? localDate(t);
        const qs = await client.day(a, day);
        if (!qs) return notPublished(a, day, t);
        const year = Number(day.slice(0, 4));
        const fees = await feeSettings(rest, year);
        const costs = fees.costs;
        const tax = energyTax(year, costs.northern_tax_reduction);

        let moment: Quarter | undefined;
        if (at) {
          const [h, m] = at.split(":").map(Number) as [number, number];
          if (h > 23 || m > 59) throw new Error(`"${at}" is not a time of day.`);
          const ms = zonedToUtc(day, `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
          moment = qs.find((q) => q.start <= ms && ms < q.end);
          if (!moment) throw new Error(`No price at ${at} on ${day}.`);
        } else if (day === localDate(t)) {
          moment = qs.find((q) => q.start <= t && t < q.end);
        }

        const cheapest = qs.reduce((x, y) => (y.sek < x.sek ? y : x));
        const dearest = qs.reduce((x, y) => (y.sek > x.sek ? y : x));
        const avg = totalPrice(average(qs), year, costs);
        return {
          area: a,
          date: day,
          unit: "öre/kWh incl. VAT",
          at: moment ? { from: localTime(moment.start), to: localTime(moment.end), ...totalPrice(moment.sek, year, costs) } : undefined,
          day: {
            average: avg,
            lowest: { at: localTime(cheapest.start), total: totalPrice(cheapest.sek, year, costs).total },
            highest: { at: localTime(dearest.start), total: totalPrice(dearest.sek, year, costs).total },
          },
          spot_share_of_average: avg.total > 0 ? `${Math.round((avg.spot / avg.total) * 100)} %` : undefined,
          energy_tax_rate: `${tax.ore} öre/kWh excl. VAT for ${year}${costs.northern_tax_reduction ? " (with the northern reduction)" : ""}${tax.assumed ? " (assumed: latest known rate)" : ""}`,
          grid_fee_lookup: fees.grid,
          not_included: fees.notIncluded,
          source: `${SOURCE}; energy tax: Skatteverket${fees.grid ? `; grid fees: ${GRID_SOURCE}` : ""}`,
        };
      }),
  );

  server.registerTool(
    "get_grid_fees",
    {
      title: "Grid fees for a grid company",
      description:
        "Grid fees (elnätsavgifter) for a Swedish grid company from Energimarknadsinspektionen: the fixed fee per year, the " +
        "variable fee per kWh and the total per year for standard customers (apartment, houses with different fuses and use), " +
        "and how the company compares with the national median. Search by company name or the town it serves. If several " +
        "companies match, the answer lists them so you can ask the user which one is on their grid bill. To use the fee in a " +
        "price, pass grid_company to get_total_price or find_cheapest_time.",
      inputSchema: z.object({
        company: z.string().min(2).max(80).describe("Grid company name, part of it, a town it serves, or a slug"),
        customer_type: z.string().max(60).optional().describe("Only this standard customer, e.g. 'lägenhet', 'villa 20 A'"),
      }),
      annotations: READ_ONLY,
    },
    async ({ company, customer_type }) =>
      run(async () => {
        const { companies, median_kr_per_year_incl_vat, latest_year: newest } = await grid.overview();
        const found = resolveCompany(companies, company);
        if (!("company" in found)) {
          return {
            matches: found.candidates.map((c) => ({
              name: c.name,
              slug: c.slug,
              area: c.area ?? undefined,
              latest_year: c.latest_year ?? undefined,
              reference_total_kr_per_year_incl_vat: c.reference?.total_kr_per_year_incl_vat,
            })),
            message: found.candidates.length
              ? "Several grid companies or grid areas match. Areas with current figures come first. Ask the user which one is on their grid bill (or where they live), then call again with its slug."
              : "No grid company matches. Ask for the name on the user's grid bill (elnätsfaktura). It's often not the electricity supplier.",
            source: `${GRID_SOURCE} (${GRID_SOURCE_URL})`,
          };
        }
        const detail = await grid.company(found.company.slug);
        if (!detail) throw new Error(`No grid fees were found for ${found.company.name}.`);
        const year = Number(localDate(now()).slice(0, 4));
        const only = customer_type ? pickCustomer(detail, customer_type) : undefined;
        const customers = (only ? [only] : detail.customers).flatMap((c) => {
          const picked = feeForYear(c, year);
          if (!picked) return [];
          const f = picked.fee;
          const fixed = (f.fast_kr_per_ar ?? 0) + (f.myndighetsavgift_kr_per_ar ?? 0);
          return [
            {
              customer_type: c.label,
              year: picked.year,
              variable_fee_ore_per_kwh_incl_vat: round1(f.rorlig_ore_per_kwh! * (1 + VAT)),
              fixed_fees_kr_per_year_incl_vat: round0(fixed * (1 + VAT)),
              total_kr_per_year_incl_vat: f.totalt_kr_per_ar_inkl_moms ?? (f.totalt_kr_per_ar !== undefined ? round0(f.totalt_kr_per_ar * (1 + VAT)) : undefined),
              change_from_last_year_percent: c.change_percent,
            },
          ];
        });
        const m = detail.vs_median;
        return {
          company: detail.name,
          slug: detail.slug,
          warning:
            detail.latest_year && newest && detail.latest_year < newest
              ? `There are no figures for this grid area after ${detail.latest_year}. It may have been merged into another of the company's areas.`
              : undefined,
          legal_name: detail.legal_name,
          area: detail.area ?? undefined,
          customer_types: customers,
          compared_with_median: m
            ? {
                customer_type: m.customer,
                year: m.year,
                difference_kr_per_year_incl_vat: m.difference_kr_per_year_incl_vat,
                difference_percent: m.difference_percent,
                national_median_kr_per_year_incl_vat: median_kr_per_year_incl_vat,
              }
            : undefined,
          vat_note: detail.vat_note,
          notes: detail.limitations?.length ? detail.limitations : undefined,
          more: detail.page,
          source: `${GRID_SOURCE} (${GRID_SOURCE_URL})`,
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
