// Swedish local time helpers. All prices are delivered per local calendar day.

export const TZ = "Europe/Stockholm";

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

export function localParts(ms: number): LocalParts {
  const p: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function localDate(ms: number): string {
  return localParts(ms).date;
}

export function localTime(ms: number): string {
  return localParts(ms).time;
}

/** "2026-11-03 21:15" style label. */
export function localStamp(ms: number): string {
  const p = localParts(ms);
  return `${p.date} ${p.time}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** UTC milliseconds for a Swedish local date and time, handling daylight saving. */
export function zonedToUtc(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Start from UTC+1 and correct by whatever offset the zone really has at that instant.
  let guess = wanted - 60 * 60 * 1000;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess);
    const [gy, gmo, gd] = p.date.split("-").map(Number) as [number, number, number];
    const [gh, gmi] = p.time.split(":").map(Number) as [number, number];
    const diff = wanted - Date.UTC(gy, gmo - 1, gd, gh, gmi);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * Parse a user-facing time: "YYYY-MM-DD HH:MM", "YYYY-MM-DDTHH:MM" or "HH:MM".
 * A bare "HH:MM" means its next occurrence at or after `after`.
 */
export function parseLocal(value: string, after: number): number {
  const v = value.trim().replace("T", " ");
  const full = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})$/.exec(v);
  if (full) {
    if (!isDate(full[1]!)) throw new Error(`"${value}" is not a valid date.`);
    return zonedToUtc(full[1]!, `${full[2]!.padStart(2, "0")}:${full[3]}`);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
    const time = `${clock[1]!.padStart(2, "0")}:${clock[2]}`;
    const today = localDate(after);
    let ms = zonedToUtc(today, time);
    if (ms < after) ms = zonedToUtc(addDays(today, 1), time);
    return ms;
  }
  throw new Error(`Could not read the time "${value}". Use HH:MM or YYYY-MM-DD HH:MM.`);
}
