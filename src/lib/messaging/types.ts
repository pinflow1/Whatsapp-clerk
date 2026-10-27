// What every way of talking to the clerk (WhatsApp, the test chat page, the tests) hands over,
// and what it gets back. The clerk never knows which one it is talking to.

import type { ReportChannel } from "../reports/deliver";

export type ChannelName = "whatsapp" | "chat";

export interface InboundMessage {
  channel: ChannelName;
  /** The channel's own id for this message. The same id is only ever handled once. */
  messageId: string;
  /** Who sent it. WhatsApp: the number as digits, e.g. 2348012345678. */
  sender: string;
  /** null = not a text message (a photo, a voice note, ...). */
  text: string | null;
}

/** How a message ended. Kept in the message log. */
export type Outcome =
  | "recorded" // a sale was saved
  | "corrected" // a sale was changed
  | "undone" // a sale was reversed
  | "answered" // a question was answered
  | "asked" // we asked something back and are waiting
  | "confirm" // we asked for a YES before doing it
  | "cancelled" // the person said no
  | "rejected" // it cannot be done as stated
  | "help" // we did not understand and said what we can do
  | "unknown_sender" // the number is not on the team
  | "not_text" // a photo, voice note, ...
  | "duplicate" // the same message arrived again, so nothing was done
  | "error"; // something broke on our side

export interface ClerkResult {
  /** The reply to send. null = send nothing (the message was already handled). */
  text: string | null;
  outcome: Outcome;
  /** Who to answer, exactly as the channel gave it. */
  to: string;
  userId: string | null;
  inboundId: string | null;
  /** What went wrong, in plain words, when `outcome` is "error". For logs and the test chat page only. */
  detail: string | null;
}

/** A way of putting a message on someone's phone. Same shape the report sender uses. */
export type MessageChannel = ReportChannel;
