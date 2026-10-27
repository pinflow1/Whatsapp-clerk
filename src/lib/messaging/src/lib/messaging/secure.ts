// Comparing secrets (the webhook verify token, the test chat passcode).
// A plain === can leak, through how long it takes, how much of a guess was right.

import { createHash, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  // Hashing first makes both sides the same length, which timingSafeEqual requires.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
