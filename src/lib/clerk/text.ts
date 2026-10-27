// Small readers for short replies ("yes", "2", "100 pcs") and small helpers for names and times.
// Plain code, no AI: a short answer to a question we just asked is read by rules we can test.

import { humanDate, todayIn } from "../reports/dates";

export type YesNo = "yes" | "no";

const YES_WORDS = new Set(["yes", "y", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm", "proceed", "correct", "right"]);
const YES_PHRASES = new Set(["go ahead", "do it", "please do", "sounds good"]);
const NO_WORDS = new Set(["no", "n", "nope", "nah", "dont", "stop", "cancel"]);
const NO_PHRASES = new Set(["never mind", "nevermind", "forget it", "leave it", "do not", "dont do it"]);

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** "Yes", "ok", "yes please" -> yes. "No", "cancel", "don't" -> no. Anything else, or a mix -> null. */
export function parseYesNo(text: string): YesNo | null {
  const w = words(text);
  if (w.length === 0 || w.length > 3) return null;
  const joined = w.join(" ");
  const yes = YES_PHRASES.has(joined) || w.some((x) => YES_WORDS.has(x));
  const no = NO_PHRASES.has(joined) || w.some((x) => NO_WORDS.has(x));
  if (yes === no) return null;
  return yes ? "yes" : "no";
}

/** True for "no", "cancel", "never mind": the person wants to drop what we were asking about. */
export const isCancel = (text: string): boolean => parseYesNo(text) === "no";

/** "2", "2.", "#2", "number 2" -> 2, when it is one of `max` choices. Otherwise null. */
export function parseIndex(text: string, max: number): number | null {
  const m = /^\s*(?:number|option|choice|#)?\s*(\d{1,2})\s*[.)]?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

/** "100", "1,200", "100 pcs" -> a whole number. Anything else -> null. */
export function parseCount(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(?:pcs|pc|pieces|piece|units|unit|packs|pack)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** A short plain-words answer such as a product or a person's name: has a letter, not too long. */
export function parseName(text: string, max = 60): string | null {
  const t = text.trim();
  if (t === "" || t.length > max || !/\p{L}/u.test(t)) return null;
  return t;
}

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** "hi", "good morning", "how far": a greeting, so the answer can say hello back. */
export const isGreeting = (text: string): boolean =>
  /^\s*(hi+|hello+|hey+|hiya|yo|good\s+(morning|afternoon|evening|day)|morning|afternoon|evening|how\s+far)\b/i.test(text);

/** Which of these people does the message name? Matches a first name as a whole word. */
export function mentionedPeople<P extends { id: string; name: string }>(message: string, people: P[], exceptId: string): P[] {
  // "Chidi's last sale" names Chidi: the possessive is dropped before the words are compared.
  const said = new Set(words(message.replace(/['’]s\b/gi, "")));
  return people.filter((p) => {
    if (p.id === exceptId) return false;
    const first = words(p.name)[0];
    return first !== undefined && said.has(first);
  });
}

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "today 10:31" or "Mon 5 Oct, 10:31", in Nigerian time. */
export function whenLabel(at: Date, now: Date): string {
  const day = todayIn("Africa/Lagos", at);
  const time = clock.format(at);
  return day === todayIn("Africa/Lagos", now) ? `today ${time}` : `${humanDate(day, false)}, ${time}`;
}
