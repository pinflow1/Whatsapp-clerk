# WhatsApp Business Clerk

A WhatsApp-first sales and inventory clerk. Staff message in plain language
("White paper 100 sold for 80k"); the system records the sale, updates stock,
flags low stock and reports to the owner.

**Rule of the whole project:** the LLM only turns messages into structured JSON.
Validation, business logic and the database decide everything about money and stock.

## Stack

Next.js (App Router, TypeScript) · Supabase Postgres · Vercel · Gemini or Groq (swappable)

## Project structure (target)

```
whatsapp-clerk/
├── supabase/
│   ├── migrations/001_core_schema.sql   ← Phase 1
│   ├── migrations/002_engine_functions.sql ← Phase 2: atomic sale/correct/reverse/adjust
│   ├── seed.sql                         ← Phase 1 (test data only)
│   ├── verify_phase1.sql                ← Phase 1 checks
│   └── tests/phase2_engine.sql          ← Phase 2 checks
├── .github/workflows/db-tests.yml       ← runs every SQL file on each push
├── src/
│   ├── lib/
│   │   ├── db/types.ts                  ← Phase 1 (done)
│   │   ├── engine/                      ← Phase 2: typed wrappers over the DB functions
│   │   ├── llm/                         ← Phase 3: LLMProvider, Gemini, Groq
│   │   ├── nlp/                         ← Phase 4: interpretation, matching, validation
│   │   ├── reports/                     ← Phase 5-6: reports, restock
│   │   ├── auth/                        ← Phase 7: roles and permissions
│   │   └── messaging/                   ← Phase 8-10: MessageProvider, Mock, WhatsApp
│   └── app/                             ← Phase 9: admin dashboard + API routes
└── tests/
```

## Schema at a glance

| Table | Purpose |
|---|---|
| `settings` | One row: `allow_negative_stock` (default off), business timezone |
| `users` | Staff and admins, matched by WhatsApp number |
| `products` | Name, SKU, stock, low-stock threshold, default price. Archived, never deleted |
| `product_aliases` | Short names like "wp" → White Paper |
| `sales` / `sale_items` | One sale, one or more line items, with original message and status |
| `inventory_transactions` | Append-only stock ledger; every stock change has a row |
| `restock_items` | Open restock list; a product can appear only once while open |
| `audit_logs` | Append-only trail: who, what, original message, before/after |

Safety built into the database itself: stock can't go negative (unless an admin
enables it), the ledger and audit log can't be edited, and a product can't be
added to the restock list twice. All tables are locked from the public API; only
the server's service role key can read or write.

## Applying Phase 1 (from your phone)

1. Create a **new Supabase project** for this business. Don't reuse a project that
   has other apps; table names like `users` and `sales` could clash.
2. Supabase → SQL Editor → paste `001_core_schema.sql` → Run.
3. Paste `seed.sql` → Run.
4. Paste `verify_phase1.sql` → Run. You want to see `all checks passed`.
   Any error starting with `FAIL:` tells you which rule broke.

> The schema was written without a Postgres available to test against, so step 4
> is the real test. If any step errors, send me the exact message and I'll fix it.

## Phase 2: the engine

Every money or stock change goes through one of four Postgres functions, each
running as a single transaction (all of it happens, or none of it):

| Function | What it does |
|---|---|
| `record_sale` | One or more items; checks everything first, then writes sale, items, stock, ledger, audit; reports low stock |
| `correct_sale_item` | Edits a sale line in place (quantity, amount, or both); never creates a second sale |
| `reverse_sale` | Puts all units back, marks the sale reversed, keeps the record |
| `adjust_stock` | Manual change (miscount, damage); a reason is mandatory |

Each returns `{ ok: true, ... }` or `{ ok: false, error: { code, message, details } }`.
Codes: `INVALID_INPUT`, `INVALID_QUANTITY`, `INVALID_AMOUNT`, `PRODUCT_NOT_FOUND`,
`INSUFFICIENT_STOCK`, `USER_NOT_FOUND`, `SALE_NOT_FOUND`, `SALE_ALREADY_REVERSED`,
`NO_CHANGE`. The app wrapper adds `INTERNAL_ERROR` for unexpected faults.

Decisions worth knowing:
- If a correction changes only the quantity, the amount is **not** recalculated.
  The result says `needs_amount_review: true` so the bot can ask "keep ₦80,000 or change it?"
- Reversed sales stay in the tables. **Reports (Phase 5) must count only `status = 'recorded'`.**
- Correcting or reversing a sale can lift stock back above the threshold, but the
  product stays on the restock list until someone marks it (Phase 6).
- These functions don't check roles. They trust the server calling them. Who may
  undo or correct what is decided in Phase 7.
- Add `@supabase/supabase-js` to `package.json` when the Next.js app is scaffolded,
  and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel. Never expose the key to the browser.

### Running the tests

- **Automatically:** push to GitHub, then open the repo's **Actions** tab. The
  "DB tests" run applies every migration, loads the seed and runs both test files.
- **By hand:** in the Supabase SQL Editor run `002_engine_functions.sql`, then
  `tests/phase2_engine.sql`. You want `all phase 2 checks passed`. The tests roll
  back their own data, so they leave your seed untouched.

## Phases

- [x] 1. Database + models + seed data
- [~] 2. Sales + inventory engine (written; not yet run: confirm the tests pass)
- [ ] 3. LLM structured-output layer
- [ ] 4. Natural-language interpretation + validation
- [ ] 5. Reports
- [ ] 6. Restock system
- [ ] 7. Staff/admin permissions
- [ ] 8. Mock messaging adapter
- [ ] 9. Admin dashboard
- [ ] 10. WhatsApp integration boundary
