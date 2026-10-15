// Sending the daily report, honestly.
// The rule: never claim a message was sent unless the channel really sent it.
//   sent     the channel accepted the message for a real person's phone
//   failed   we tried and it did not go (or the channel gave an answer we could not read)
//   skipped  we deliberately did not send (no real channel connected, nothing to send to)
// A channel that does not really deliver (a test channel, or none connected yet) can never
// produce "sent": even if it says so, the result is changed to "skipped".
//
// Nothing here is scheduled yet. A scheduler (and a record of what was sent, so a retry cannot
// send twice) comes with the WhatsApp phase; this is the part that tells the truth when it runs.
// SERVER ONLY: it uses the service-role client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { clipMessage, formatDailyReport } from "./format";
import { getDailyReport } from "./queries";
import type { ReportError, ReportResult } from "./queries";

export type SendOutcome =
  | { status: "sent"; messageId: string | null }
  | { status: "failed"; reason: string }
  | { status: "skipped"; reason: string };

export interface ReportChannel {
  /** Shown in logs: "whatsapp", "test", "none". */
  readonly name: string;
  /** true only when send() puts the message on a real person's phone. */
  readonly delivers: boolean;
  send(to: string, text: string): Promise<SendOutcome>;
}

export interface Recipient {
  id: string;
  name: string;
  /** International format, e.g. +2348000000001. */
  phone: string;
}

export interface DeliveryResult {
  recipient: Recipient;
  outcome: SendOutcome;
}

/** The channel used until a real one is connected: it sends nothing and says so. */
export const unconnectedChannel: ReportChannel = {
  name: "none",
  delivers: false,
  async send() {
    return { status: "skipped", reason: "no messaging channel is connected yet" };
  },
};

function readable(x: unknown): x is SendOutcome {
  if (typeof x !== "object" || x === null) return false;
  const o = x as { status?: unknown; reason?: unknown };
  if (o.status === "sent") return true;
  return (o.status === "failed" || o.status === "skipped") && typeof o.reason === "string";
}

async function sendOne(channel: ReportChannel, to: Recipient, text: string): Promise<SendOutcome> {
  let outcome: unknown;
  try {
    outcome = await channel.send(to.phone, text);
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : "the channel threw an error" };
  }
  if (!readable(outcome)) return { status: "failed", reason: "the channel gave an answer that could not be read" };
  if (outcome.status === "sent" && !channel.delivers) {
    return { status: "skipped", reason: `the ${channel.name} channel does not deliver to real phones, so nothing was sent` };
  }
  return outcome;
}

/** Sends one text to each person, one at a time. One person failing never stops the others. */
export async function sendToAll(channel: ReportChannel, recipients: Recipient[], text: string): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const recipient of recipients) {
    results.push({ recipient, outcome: await sendOne(channel, recipient, text) });
  }
  return results;
}

/** A plain account of what happened, for logs and the dashboard. */
export function describeDelivery(results: DeliveryResult[]): string {
  if (results.length === 0) return "There was no one to send the report to.";
  let sent = 0;
  const problems: string[] = [];
  for (const { recipient, outcome } of results) {
    if (outcome.status === "sent") sent++;
    else problems.push(`${recipient.name}: ${outcome.status === "failed" ? "failed" : "not sent"} (${outcome.reason})`);
  }
  return [`Sent to ${sent} of ${results.length}.`, ...problems].join("\n");
}

/** Who gets the daily report: every active admin (the owner). */
export async function getReportRecipients(db: SupabaseClient): Promise<ReportResult<Recipient[]>> {
  try {
    const { data, error } = await db.from("users").select("id, name, phone").eq("role", "admin").eq("is_active", true);
    if (error) return { ok: false, error: { code: "DB_ERROR", message: error.message } };
    const rows: unknown = data;
    if (!Array.isArray(rows)) return { ok: false, error: { code: "BAD_REPLY", message: "the user list could not be read" } };
    const out: Recipient[] = [];
    for (const row of rows) {
      const r = row as { id?: unknown; name?: unknown; phone?: unknown };
      if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.phone !== "string") {
        return { ok: false, error: { code: "BAD_REPLY", message: "the user list could not be read" } };
      }
      out.push({ id: r.id, name: r.name, phone: r.phone });
    }
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: { code: "DB_ERROR", message: e instanceof Error ? e.message : "Unknown error" } };
  }
}

export type DailyReportRun =
  | { ok: true; date: string; text: string; results: DeliveryResult[] }
  | { ok: false; error: ReportError };

/**
 * Builds the report for `date` (YYYY-MM-DD) and sends it. If the figures cannot be read,
 * nothing is sent: no one gets a half-made report.
 */
export async function runDailyReport(o: {
  db: SupabaseClient;
  channel: ReportChannel;
  recipients: Recipient[];
  date: string;
}): Promise<DailyReportRun> {
  const report = await getDailyReport(o.db, o.date);
  if (!report.ok) return { ok: false, error: report.error };
  const text = clipMessage(formatDailyReport(report.data));
  const results = await sendToAll(o.channel, o.recipients, text);
  return { ok: true, date: o.date, text, results };
}
