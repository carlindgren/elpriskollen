// Pure functions over quarter prices: hourly averages, summaries and cheapest windows.
import type { Quarter } from "./elpris";
import { addDays, localDate, localTime } from "./time";

export const VAT = 0.25;
const HOUR = 60 * 60 * 1000;

/** SEK/kWh -> öre/kWh, optionally with 25 % VAT, one decimal. */
export function ore(sek: number, withVat: boolean): number {
  return Math.round(sek * 100 * (withVat ? 1 + VAT : 1) * 10) / 10;
}

export function average(qs: Quarter[]): number {
  let weighted = 0;
  let total = 0;
  for (const q of qs) {
    weighted += q.sek * (q.end - q.start);
    total += q.end - q.start;
  }
  return total ? weighted / total : NaN;
}

/** Hourly averages (or the quarters as they are). */
export function slots(qs: Quarter[], resolution: "hour" | "quarter"): Quarter[] {
  if (resolution === "quarter") return qs;
  const groups = new Map<number, Quarter[]>();
  for (const q of qs) {
    const hour = Math.floor(q.start / HOUR) * HOUR; // Swedish offsets are whole hours
    let group = groups.get(hour);
    if (!group) groups.set(hour, (group = []));
    group.push(q);
  }
  return [...groups.entries()].map(([start, group]) => ({ start, end: group[group.length - 1]!.end, sek: average(group) }));
}

export function summarize(qs: Quarter[], withVat: boolean) {
  const hours = slots(qs, "hour");
  const cheapestQ = minBy(qs, (q) => q.sek)!;
  const dearestQ = minBy(qs, (q) => -q.sek)!;
  const cheapestH = minBy(hours, (h) => h.sek)!;
  const dearestH = minBy(hours, (h) => -h.sek)!;
  return {
    average: ore(average(qs), withVat),
    lowest: { at: localTime(cheapestQ.start), ore: ore(cheapestQ.sek, withVat) },
    highest: { at: localTime(dearestQ.start), ore: ore(dearestQ.sek, withVat) },
    cheapest_hour: `${localTime(cheapestH.start)}–${localTime(cheapestH.end)}`,
    most_expensive_hour: `${localTime(dearestH.start)}–${localTime(dearestH.end)}`,
    negative_quarters: qs.filter((q) => q.sek < 0).length || undefined,
  };
}

export interface Window {
  start: number;
  end: number;
  sek: number; // average over the window
}

/**
 * All contiguous windows of `count` consecutive slots that start at or after `from`
 * (the slot running at `from` counts) and end by `to`.
 */
function windows(qs: Quarter[], count: number, from: number, to: number): Window[] {
  const out: Window[] = [];
  let first = qs.findIndex((q) => q.end > from);
  if (first < 0) return out;
  for (let i = first; i + count <= qs.length; i++) {
    const last = qs[i + count - 1]!;
    if (last.end > to) break;
    let gap = false;
    for (let k = i + 1; k < i + count; k++) if (qs[k]!.start !== qs[k - 1]!.end) gap = true;
    if (gap) continue;
    out.push({ start: qs[i]!.start, end: last.end, sek: average(qs.slice(i, i + count)) });
  }
  return out;
}

export function slotMinutes(qs: Quarter[]): number {
  const first = qs[0];
  return first ? Math.round((first.end - first.start) / 60000) : 15;
}

export function cheapestWindow(qs: Quarter[], minutes: number, from: number, to: number) {
  const step = slotMinutes(qs);
  const count = Math.max(1, Math.ceil(minutes / step));
  const all = windows(qs, count, from, to);
  if (!all.length) return undefined;
  const best = minBy(all, (w) => w.sek)!;
  const worst = minBy(all, (w) => -w.sek)!;
  const startNow = all[0]!.start <= from ? all[0] : undefined;
  return { best, worst, startNow, slotMinutes: step, windowMinutes: count * step, candidates: all.length };
}

/** The n cheapest slots in a range (not necessarily together), merged into runs. */
export function cheapestSlots(qs: Quarter[], minutes: number, from: number, to: number) {
  const step = slotMinutes(qs);
  const count = Math.max(1, Math.ceil(minutes / step));
  const pool = qs.filter((q) => q.end > from && q.end <= to);
  if (pool.length < count) return undefined;
  const chosen = [...pool].sort((a, b) => a.sek - b.sek).slice(0, count).sort((a, b) => a.start - b.start);
  const runs: Quarter[][] = [];
  for (const q of chosen) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1]!.end === q.start) run.push(q);
    else runs.push([q]);
  }
  return { runs: runs.map((r) => ({ start: r[0]!.start, end: r[r.length - 1]!.end, sek: average(r) })), sek: average(chosen), slotMinutes: step };
}

/** "today", "tomorrow" or the date, relative to `now` in Swedish time. */
export function dayLabel(ms: number, now: number): string {
  const day = localDate(ms);
  const today = localDate(now);
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  return day;
}

export function describeWindow(w: Window, withVat: boolean, now: number) {
  const crossesMidnight = localDate(w.end - 1) !== localDate(w.start);
  return {
    day: dayLabel(w.start, now),
    start: localTime(w.start),
    end: crossesMidnight ? `${localTime(w.end)} (${dayLabel(w.end - 1, now)})` : localTime(w.end),
    average_ore: ore(w.sek, withVat),
  };
}

function minBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Infinity;
  for (const item of items) {
    const s = score(item);
    if (s < bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}
