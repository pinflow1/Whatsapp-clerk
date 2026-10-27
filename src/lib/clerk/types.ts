// Shapes shared by the clerk's parts. Nothing here does any work.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LLMProvider } from "../llm";
import type { Outcome } from "../messaging/types";
import type { Pending } from "./pending";
import type { ClerkContext, ClerkUser } from "./store";

export interface ClerkDeps {
  db: SupabaseClient;
  provider: LLMProvider;
  /** For tests. Defaults to the real clock. */
  now?: () => Date;
}

/** What one step decided: the text to send, how it ended, and any question we now wait on. */
export interface Reply {
  text: string;
  outcome: Outcome;
  /** The question we are now waiting for the person to answer. */
  pending?: Pending;
  /** For the logs only. Never sent to the person. */
  note?: string;
}

export interface FlowCtx {
  db: SupabaseClient;
  user: ClerkUser;
  ctx: ClerkContext;
  now: Date;
  /** The message that started this request. The audit log keeps it, not the "yes" that confirmed it. */
  original: string;
  /** Becomes true just before anything that changes money or stock, so a crash afterwards is reported honestly. */
  trace: { wrote: boolean };
}
