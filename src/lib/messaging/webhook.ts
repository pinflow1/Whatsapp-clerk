// The two doors into the clerk. Both are plain functions from a Request to a Response, so the
// tests can call them without any server.
//   WhatsApp   Meta calls us. We check the signature, hand each message to the clerk, send the
//              reply back through WhatsApp, and write down whether it really went.
//   Test chat  a page on our own site (public/chat.html) so the clerk can be tried from a phone
//              before WhatsApp is connected. Protected by CHAT_PASSCODE; off when that is not set.
//
// A message Meta delivers twice is only ever acted on once (see claim_inbound). A request with a
// good signature always gets a 200, even when something broke, so Meta does not replay old
// messages hours later; the failure is logged and the person gets a "something went wrong" reply.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleMessage } from "../clerk/handle";
import { MSG } from "../clerk/replies";
import { logOutbound } from "../clerk/store";
import type { ClerkDeps } from "../clerk/types";
import type { Env } from "../llm";
import { sendToAll } from "../reports/deliver";
import type { ReportChannel } from "../reports/deliver";
import { normalizePhone, toE164 } from "./phone";
import { safeEqual } from "./secure";
import type { InboundMessage } from "./types";
import { parseWebhook, verifySignature, whatsappChannel } from "./whatsapp";

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const plain = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" } });

const unset = (env: Env, names: readonly string[]): string[] => names.filter((n) => (env[n] ?? "").trim() === "");

export interface WebhookDeps {
  env: Env;
  /** Builds the clerk's database and AI. A function, so a missing setting is a clear answer and not a crash. */
  clerk: () => ClerkDeps;
  /** For tests. Normally the real WhatsApp channel is built from the settings. */
  channel?: ReportChannel;
}

// ---------- WhatsApp ----------

/** Meta checks the address once, when the webhook is saved: echo its number back if the token matches. */
export function verifyChallenge(url: string, env: Env): Response {
  const token = (env.WHATSAPP_VERIFY_TOKEN ?? "").trim();
  if (token === "") return json(503, { ok: false, error: "not set up yet: WHATSAPP_VERIFY_TOKEN is missing" });

  const q = new URL(url).searchParams;
  const mode = q.get("hub.mode");
  // Someone opening the address in a browser: say it is alive, nothing more.
  if (mode === null) return plain(200, "The WhatsApp clerk is running. This address is for Meta.");

  const challenge = q.get("hub.challenge");
  if (mode === "subscribe" && challenge !== null && safeEqual((q.get("hub.verify_token") ?? "").trim(), token)) {
    return plain(200, challenge);
  }
  return plain(403, "Forbidden");
}

/** Sends one reply and writes down what really happened to it. Never throws. */
async function reply(
  channel: ReportChannel,
  db: SupabaseClient | null,
  r: { to: string; text: string; userId: string | null; inboundId: string | null },
): Promise<void> {
  const [done] = await sendToAll(channel, [{ id: r.userId ?? r.to, name: r.to, phone: toE164(r.to) }], r.text);
  const o = done.outcome;
  if (o.status !== "sent") console.error(`reply to ${r.to} was not sent (${o.status}): ${o.reason}`);
  if (db === null) return;
  try {
    await logOutbound(db, {
      channel: channel.name,
      recipient: r.to,
      userId: r.userId,
      inboundId: r.inboundId,
      body: r.text,
      status: o.status,
      providerMessageId: o.status === "sent" ? o.messageId : null,
      error: o.status === "sent" ? null : o.reason,
    });
  } catch {
    // The log is best effort; the reply already went (or failed) and that is what matters.
  }
}

export async function receiveWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const env = deps.env;
  const absent = unset(env, ["WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]);
  if (absent.length > 0) return json(503, { ok: false, error: `not set up yet: ${absent.join(", ")} missing` });

  // The signature is over the exact bytes Meta sent, so read them raw before anything parses them.
  const raw = Buffer.from(await request.arrayBuffer());
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), (env.WHATSAPP_APP_SECRET ?? "").trim())) {
    return json(403, { ok: false, error: "bad signature" });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(400, { ok: false, error: "the body is not JSON" });
  }

  const phoneNumberId = (env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const messages = parseWebhook(body, phoneNumberId);
  if (messages.length === 0) return json(200, { ok: true, handled: 0 }); // delivery receipts and the like

  const channel =
    deps.channel ??
    whatsappChannel({
      token: (env.WHATSAPP_ACCESS_TOKEN ?? "").trim(),
      phoneNumberId,
      version: (env.WHATSAPP_GRAPH_VERSION ?? "").trim() || undefined,
    });

  let clerk: ClerkDeps;
  try {
    clerk = deps.clerk();
  } catch (e) {
    console.error(`the clerk could not start: ${describe(e)}`);
    for (const m of messages) await reply(channel, null, { to: m.sender, text: MSG.trouble, userId: null, inboundId: null });
    return json(200, { ok: false, handled: 0, error: "the clerk could not start" });
  }

  let handled = 0;
  for (const m of messages) {
    const result = await handleMessage(clerk, m);
    if (result.detail !== null) console.error(`message ${m.messageId} ended in an error: ${result.detail}`);
    if (result.text === null) continue; // the same message again: already answered the first time
    handled++;
    await reply(channel, clerk.db, { to: result.to, text: result.text, userId: result.userId, inboundId: result.inboundId });
  }
  return json(200, { ok: true, handled });
}

// ---------- the test chat page ----------

/** Short passcodes are too easy to guess: below this the chat page stays switched off. */
export const MIN_PASSCODE = 10;
const MAX_MESSAGE = 4000;

export interface ChatDeps {
  env: Env;
  clerk: () => ClerkDeps;
  /** For tests. */
  newId?: () => string;
}

export async function receiveChat(request: Request, deps: ChatDeps): Promise<Response> {
  const passcode = (deps.env.CHAT_PASSCODE ?? "").trim();
  if (passcode.length < MIN_PASSCODE) return plain(404, "Not found");
  if (!safeEqual((request.headers.get("x-chat-passcode") ?? "").trim(), passcode)) {
    return json(401, { ok: false, error: "That passcode is not right." });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, error: "That request could not be read." });
  }
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof b.message !== "string") return json(400, { ok: false, error: "Type a message first." });
  if (b.message.length > MAX_MESSAGE) return json(400, { ok: false, error: "That message is too long." });
  const sender = typeof b.sender === "string" ? normalizePhone(b.sender) : null;
  if (sender === null) return json(400, { ok: false, error: "Type the phone number of someone on the team, like 0803 123 4567." });
  const own = typeof b.id === "string" && b.id.trim() !== "" && b.id.length <= 100 ? b.id.trim() : null;
  const id = own ?? (deps.newId ?? randomUUID)();

  let clerk: ClerkDeps;
  try {
    clerk = deps.clerk();
  } catch (e) {
    return json(503, { ok: false, error: `The server is not set up yet: ${describe(e)}` });
  }

  const msg: InboundMessage = { channel: "chat", messageId: id, sender, text: b.message };
  const result = await handleMessage(clerk, msg);
  if (result.text !== null) {
    try {
      await logOutbound(clerk.db, {
        channel: "chat",
        recipient: sender,
        userId: result.userId,
        inboundId: result.inboundId,
        body: result.text,
        status: "skipped",
        providerMessageId: null,
        error: "test chat: shown on the page, not sent to a phone",
      });
    } catch {
      // best effort
    }
  }
  return json(200, { ok: true, reply: result.text, outcome: result.outcome, detail: result.detail });
}
