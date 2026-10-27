# WhatsApp Business Clerk

A clerk for a small shop that lives in WhatsApp. Staff type what they sold
("White paper 100 sold for 80k"). It records the sale, takes it off the stock,
warns when something runs low, and reports to the owner. The owner can ask
questions in plain words ("how much did we make yesterday?").

**The rule of the whole project:** the AI only turns a message into structured
JSON. It never writes to the database and never makes up a number. Code checks
everything, and Postgres functions make every change to money and stock, each
one all-or-nothing.

## How one message travels

1. WhatsApp (Meta) posts it to `/api/whatsapp`. The signature is checked first;
   anything not signed by Meta is refused.
2. `claim_inbound` makes sure each message is handled at most once, even if Meta
   delivers it twice.
3. The sender's number is looked up in `users`. Strangers get a polite refusal.
4. If the person was in the middle of a question ("which product?"), their
   message is treated as the answer.
5. Otherwise the AI reads it into JSON. Code then checks the product, the
   quantity, the stock, a price far from usual, and a repeat of the same sale.
6. A Postgres function records the change. The reply is built from the database's
   answer, not from the AI's.
7. The reply is sent back through Meta. The `outbound_messages` table records
   what really happened ("sent" only when Meta gave back a message id).

## Who may do what

| | Staff | Owner (admin) |
|---|---|---|
| Record a sale | yes | yes |
| Fix or undo a sale | their own, within 24 hours | any sale |
| Stock, prices, low stock, restock list | yes | yes |
| Sales reports | their own only | everyone's, or one person's |

Fixing or undoing always shows what will happen and waits for YES.

## Honest limits (read these)

- **Nothing is sent on a schedule.** The daily report text exists, but there is no
  timer, and WhatsApp only allows free text within 24 hours of the person's last
  message. A morning report needs an approved Meta template.
- Marking restock items as ordered or received by chat is not wired up yet.
- There is no admin dashboard. Products and staff are changed in the Supabase SQL Editor.
- Meta's test number only messages people you add by hand, and its temporary
  token expires within a day. Use a system-user token for anything lasting.
- Two messages from the same person sent at the very same moment can race.
- A question the clerk is waiting on expires after 10 minutes.
- Vercel's free Hobby plan is for non-commercial use. A shop in daily use needs Pro.

## Setup (all doable from a phone)

1. **Supabase → SQL Editor.** Run, in this order, each pasted whole:
   `001_core_schema.sql`, `002_engine_functions.sql`, `003_reports.sql`,
   `004_messaging.sql`. Test data only: `seed.sql`.
2. **Your own number.** Make yourself the owner so the clerk answers you:
   `update users set phone = '+234XXXXXXXXXX' where name = 'Owner';`
3. **Vercel.** Import the GitHub repo (Next.js is detected). Add the settings below.
4. **Try it without WhatsApp.** Set `CHAT_PASSCODE` (10+ characters), redeploy,
   open `https://YOUR-DOMAIN/chat.html`. It talks to the real database.
5. **Meta.** developers.facebook.com → create an app → add WhatsApp. Callback URL
   `https://YOUR-DOMAIN/api/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`,
   subscribe to `messages`. Add your number as a test recipient, then message the
   test number first.

| Setting (Vercel → Environment Variables) | What it is |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase project. The key stays on the server. |
| `LLM_PROVIDER` | `gemini` or `groq` |
| `GEMINI_API_KEY` or `GROQ_API_KEY` | Key for the one you chose |
| `GEMINI_MODEL` / `GROQ_MODEL`, `LLM_TIMEOUT_MS` | Optional |
| `WHATSAPP_VERIFY_TOKEN` | Any secret word you invent; paste the same one into Meta |
| `WHATSAPP_APP_SECRET` | Meta app → Settings → Basic → App secret |
| `WHATSAPP_ACCESS_TOKEN` | Meta token (system-user token for lasting use) |
| `WHATSAPP_PHONE_NUMBER_ID` | From Meta's API setup page |
| `WHATSAPP_GRAPH_VERSION` | Optional, default `v23.0` |
| `CHAT_PASSCODE` | Optional. Leave unset to switch the test page off. |

## Where things are

```
supabase/migrations/   001 schema · 002 sale/fix/undo/stock functions · 003 reports · 004 messaging
supabase/tests/        SQL checks, run by CI; each must end with "passed"
app/api/whatsapp       Meta's webhook          app/api/chat   the test page's door
public/chat.html       the test chat page
src/lib/messaging/     Meta signature, parsing, sending, the webhook logic
src/lib/clerk/         the clerk: pending questions, sales, fixes, questions, permissions
src/lib/nlp/           the AI prompt, JSON contract, product matching, sale checks
src/lib/reports/       report queries, wording, delivery
src/lib/engine/        typed wrappers over the database functions
src/lib/llm/           Gemini and Groq behind one interface
tests/                 unit tests; tests/live grades the real models
MANIFEST.txt           every file and how many lines it should have
```

## Checks that run on every push (GitHub → Actions → CI)

- **db** applies every migration to a fresh Postgres, loads the seed and runs all SQL tests.
- **app** typechecks, runs the unit tests and builds the site.
- **files** says in plain words if a file is missing or cut off (compares with `MANIFEST.txt`).
- The separate *Live model check* sends real messages to Gemini/Groq and scores them.

## Schema at a glance

| Table | Purpose |
|---|---|
| `settings` | One row: `allow_negative_stock` (off by default), business timezone |
| `users` | Staff and admins, matched by WhatsApp number |
| `products`, `product_aliases` | Name, stock, low-stock level, price; short names like "wp" |
| `sales`, `sale_items` | A sale and its lines, with the original message and status |
| `inventory_transactions` | Append-only stock ledger; every stock change has a row |
| `restock_items` | Open restock list; a product appears once while open |
| `audit_logs` | Append-only trail: who, what, the original message, before and after |
| `inbound_messages`, `pending_questions`, `outbound_messages` | What arrived, what the clerk is waiting on, what was sent and whether it really went |

Stock cannot go negative unless an admin allows it, the ledger and audit log cannot
be edited, and every table is closed to the public API: only the server key opens them.
