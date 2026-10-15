// Calendar-date helpers for reports.
// They work on "YYYY-MM-DD" text and never read the computer's own timezone, so "this week"
// cannot shift by a day depending on where the code runs. "Today" is always passed in as the
// date in the shop's timezone (see todayIn); the database uses the same local-day rule.
// Ranges are [from, to): "to" is the first day NOT included, exactly like the SQL reports.

import type { Period } from "../nlp/interpretation";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** UTC midnight of a YYYY-MM-DD date, or null when it is not a real calendar date. */
function parse(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === iso ? d : null;
}

function must(iso: string): Date {
  const d = parse(iso);
  if (d === null) throw new Error(`"${iso}" is not a YYYY-MM-DD date`);
  return d;
}

export function isIsoDate(s: string): boolean {
  return parse(s) !== null;
}

export function addDays(iso: string, days: number): string {
  const d = must(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week that contains this date (weeks run Monday to Sunday). */
export function startOfWeek(iso: string): string {
  const sinceMonday = (must(iso).getUTCDay() + 6) % 7;
  return addDays(iso, -sinceMonday);
}

export function startOfMonth(iso: string): string {
  must(iso);
  return `${iso.slice(0, 7)}-01`;
}

export function startOfLastMonth(iso: string): string {
  return startOfMonth(addDays(startOfMonth(iso), -1));
}

/** "Wed 30 Sep 2026", or "Wed 30 Sep" with withYear = false. */
export function humanDate(iso: string, withYear = true): string {
  const d = parse(iso);
  if (d === null) return iso;
  const base = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

/** Today's date as YYYY-MM-DD in the given timezone, e.g. the shop's settings.business_timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface DateRange {
  /** First day included. */
  from: string;
  /** First day NOT included. */
  to: string;
  /** How to say it to a person: "Today, Wed 14 Oct 2026". */
  label: string;
}

export type PeriodResult = { ok: true; range: DateRange } | { ok: false; message: string };

function span(first: string, last: string): string {
  return first === last ? humanDate(first, false) : `${humanDate(first, false)} to ${humanDate(last, false)}`;
}

/**
 * Turns "this week" / "last month" / a named date into a date range.
 * Nothing stated at all means today; the label always says which days were used,
 * so a default is never hidden from the reader.
 */
export function resolvePeriod(period: Period | null, date: string | null, today: string): PeriodResult {
  must(today);
  const which: Period = period ?? (date !== null ? "date" : "today");
  const tomorrow = addDays(today, 1);
  const range = (from: string, to: string, label: string): PeriodResult => ({ ok: true, range: { from, to, label } });

  switch (which) {
    case "today":
      return range(today, tomorrow, `Today, ${humanDate(today)}`);
    case "yesterday": {
      const day = addDays(today, -1);
      return range(day, today, `Yesterday, ${humanDate(day)}`);
    }
    case "this_week": {
      const from = startOfWeek(today);
      return range(from, tomorrow, `This week so far (${span(from, today)})`);
    }
    case "last_week": {
      const to = startOfWeek(today);
      const from = addDays(to, -7);
      return range(from, to, `Last week (${span(from, addDays(to, -1))})`);
    }
    case "this_month": {
      const from = startOfMonth(today);
      return range(from, tomorrow, `This month so far (${span(from, today)})`);
    }
    case "last_month": {
      const to = startOfMonth(today);
      const from = startOfLastMonth(today);
      return range(from, to, `Last month (${span(from, addDays(to, -1))})`);
    }
    case "date": {
      if (date === null || parse(date) === null) {
        return { ok: false, message: "Which date do you mean? Please send it like 30 September." };
      }
      if (date > today) return { ok: false, message: `${humanDate(date)} hasn't happened yet.` };
      const prefix = date === today ? "Today, " : date === addDays(today, -1) ? "Yesterday, " : "";
      return range(date, addDays(date, 1), `${prefix}${humanDate(date)}`);
    }
  }
}
