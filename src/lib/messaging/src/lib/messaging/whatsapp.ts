// The WhatsApp side, and only that: checking a message really came from Meta, reading what Meta
// sends us, and sending a reply through Meta's Graph API. Nothing in here knows about sales or stock.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ReportChannel, SendOutcome } from "../reports/deliver";
import type { InboundMessage } from "./types";

/** Meta's Graph API version used for sending. Override with WHATSAPP_GRAPH_VERSION when Meta retires it. */
export const DEFAULT_GRAPH_VERSION = "v23.0";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Meta signs every message it sends us: the header is "sha256=" plus the HMAC-SHA256 of the exact
 * bytes received, keyed with the app secret. Anything else is not from Meta and must be dropped.
 */
export function verifySignature(body: Buffer, header: string | null, appSecret: string): boolean {
  if (header === null || appSecret === "") return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", appSecret).update(body).digest();
  return timingSafeEqual(Buffer.from(m[1], "hex"), expected);
}

/** Things that arrive on the same address but are not messages to answer (a thumbs-up on our reply, ...). */
const IGNORED_TYPES = new Set(["reaction", "request_welcome", "system", "ephemeral"]);

/**
 * Pulls the messages out of what Meta sent. Delivery receipts ("statuses") and other fields are skipped.
 * A message that is not plain text comes back with text = null, so the clerk can say it only reads text.
 */
export function parseWebhook(body: unknown, phoneNumberId?: string): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (!isObj(body) || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const value = change.value;
      // Only answer messages sent to our own number.
      if (phoneNumberId !== undefined && !(isObj(value.metadata) && value.metadata.phone_number_id === phoneNumberId)) continue;
      if (!Array.isArray(value.messages)) continue;
      for (const m of value.messages) {
        if (!isObj(m) || typeof m.from !== "string" || typeof m.id !== "string" || m.from === "" || m.id === "") continue;
        const type = typeof m.type === "string" ? m.type : "";
        if (IGNORED_TYPES.has(type)) continue;
        const text = type === "text" && isObj(m.text) && typeof m.text.body === "string" ? m.text.body : null;
        out.push({ channel: "whatsapp", messageId: m.id, sender: m.from, text });
      }
    }
  }
  return out;
}

function graphProblem(status: number, body: unknown): string {
  const e = isObj(body) && isObj(body.error) ? body.error : null;
  const message = e !== null && typeof e.message === "string" ? e.message : "no details";
  const code = e !== null && typeof e.code === "number" ? ` ${e.code}` : "";
  return `WhatsApp error${code} (HTTP ${status}): ${message}`.slice(0, 400);
}

export interface WhatsAppOptions {
  /** Access token. A system-user token does not expire; the one on the test page lasts about a day. */
  token: string;
  /** The "Phone number ID" from Meta's API Setup page (not the phone number itself). */
  phoneNumberId: string;
  version?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends text through the WhatsApp Cloud API. It says "sent" only when Meta accepted the message and
 * gave back a message id; every other result is "failed", with Meta's own reason for the logs.
 */
export function whatsappChannel(o: WhatsAppOptions): ReportChannel {
  const url = `https://graph.facebook.com/${o.version ?? DEFAULT_GRAPH_VERSION}/${encodeURIComponent(o.phoneNumberId)}/messages`;
  return {
    name: "whatsapp",
    delivers: true,
    async send(to, text): Promise<SendOutcome> {
      const doFetch = o.fetch ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 15_000);
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to.replace(/\D/g, ""),
            type: "text",
            text: { preview_url: false, body: text },
          }),
          signal: controller.signal,
        });
        let body: unknown = null;
        try {
          body = JSON.parse(await res.text());
        } catch {
          // not JSON: the status code below still tells the story
        }
        if (!res.ok) return { status: "failed", reason: graphProblem(res.status, body) };
        const first = isObj(body) && Array.isArray(body.messages) ? body.messages[0] : null;
        const id = isObj(first) && typeof first.id === "string" ? first.id : null;
        if (id === null) return { status: "failed", reason: "WhatsApp answered OK but gave no message id, so it is not counted as sent" };
        return { status: "sent", messageId: id };
      } catch (e) {
        const timedOut = e instanceof Error && e.name === "AbortError";
        return { status: "failed", reason: timedOut ? "WhatsApp did not answer in time" : e instanceof Error ? e.message : "could not reach WhatsApp" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
