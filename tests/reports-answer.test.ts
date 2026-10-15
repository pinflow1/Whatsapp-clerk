import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuerySales } from "../src/lib/nlp/interpretation";
import { answerQuery } from "../src/lib/reports/answer";
import type { AnswerContext, QueryInterpretation } from "../src/lib/reports/answer";
import {
  describeDelivery,
  getReportRecipients,
  runDailyReport,
  sendToAll,
  unconnectedChannel,
} from "../src/lib/reports/deliver";
import type { DeliveryResult, Recipient, ReportChannel, SendOutcome } from "../src/lib/reports/deliver";
import { formatDailyReport } from "../src/lib/reports/format";
import { parseDailyReport } from "../src/lib/reports/queries";
import { fixture } from "./reports-fixtures";

const OWNER = "a0000000-0000-0000-0000-000000000001";
const CHIDI = "a0000000-0000-0000-0000-000000000002";
const AMAKA = "a0000000-0000-0000-0000-000000000003";
const WP = "b0000000-0000-0000-0000-000000000001";

// ---------- a stand-in database that records what it was asked ----------

type Handler = (args: Record<string, unknown>) => unknown;
interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function fakeDb(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      const handler = handlers[fn];
      if (!handler) return { data: null, error: { message: `unexpected call to ${fn}`, code: "XX" } };
      return { data: handler(args), error: null }; // a handler that throws makes the call reject
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

/** Answers with the real captured database output. */
const REAL: Record<string, Handler> = {
  sales_summary: (a) => {
    if (a.p_staff_id === AMAKA) return fixture("salesAmaka");
    if (a.p_product_id === WP) return fixture("salesWp");
    return a.p_from === "2026-09-30" ? fixture("salesAll") : fixture("salesEmpty");
  },
  stock_levels: (a) => (a.p_product_id === null ? fixture("stockAll") : a.p_product_id === WP ? fixture("stockWp") : []),
  low_stock_list: () => fixture("low"),
  restock_list: () => fixture("restock"),
  daily_report: () => fixture("daily0930"),
};

const PRODUCTS = [
  { id: WP, name: "White Paper", aliases: ["wp", "white papers"] },
  { id: "b0000000-0000-0000-0000-000000000002", name: "Brown Paper", aliases: ["bp"] },
  { id: "b0000000-0000-0000-0000-000000000003", name: "Gold Border", aliases: ["gb"] },
  { id: "b0000000-0000-0000-0000-000000000004", name: "Floral", aliases: ["floral design"] },
  { id: "b0000000-0000-0000-0000-000000000005", name: "Ribbon", aliases: [] },
];
const STAFF = [
  { id: OWNER, name: "Owner" },
  { id: CHIDI, name: "Chidi" },
  { id: AMAKA, name: "Amaka" },
];

// Monday 5 Oct 2026
const ctx = (db: SupabaseClient, today = "2026-10-05"): AnswerContext => ({ db, today, products: PRODUCTS, staff: STAFF });

const sales = (o: Partial<Omit<QuerySales, "intent">> = {}): QuerySales => ({
  intent: "query_sales",
  period: null,
  date: null,
  metric: "summary",
  product_text: null,
  staff_text: null,
  group_by: "none",
  ...o,
});

async function ask(q: QueryInterpretation, handlers: Record<string, Handler> = REAL, today?: string) {
  const { db, calls } = fakeDb(handlers);
  const outcome = await answerQuery(ctx(db, today), q);
  return { outcome, calls };
}

// ---------- sales questions ----------

describe("answering sales questions", () => {
  it("answers from the database's figures and says which days they cover", async () => {
    const { outcome, calls } = await ask(sales({ period: "date", date: "2026-09-30", metric: "revenue" }));
    assert.deepEqual(outcome, { status: "answer", text: "*Wed 30 Sep 2026*\n\nRevenue: ₦134,000 from 3 sales" });
    assert.deepEqual(calls, [
      { fn: "sales_summary", args: { p_from: "2026-09-30", p_to: "2026-10-01", p_product_id: null, p_staff_id: null } },
    ]);
  });

  it("with no period stated, uses today and says so", async () => {
    const { outcome, calls } = await ask(sales({ metric: "revenue" }));
    assert.deepEqual(calls[0].args, { p_from: "2026-10-05", p_to: "2026-10-06", p_product_id: null, p_staff_id: null });
    assert.equal(outcome.status, "answer");
    assert.ok(outcome.status === "answer" && outcome.text.startsWith("*Today, Mon 5 Oct 2026*"));
  });

  it("asks the database for exactly the days that were meant", async () => {
    const wanted: Array<[QuerySales["period"], string, string, string]> = [
      ["yesterday", "2026-10-13", "2026-10-14", "2026-10-14"],
      ["this_week", "2026-10-12", "2026-10-15", "2026-10-14"],
      ["last_week", "2026-10-05", "2026-10-12", "2026-10-14"],
      ["this_month", "2026-10-01", "2026-10-15", "2026-10-14"],
      ["last_month", "2026-09-01", "2026-10-01", "2026-10-14"],
    ];
    for (const [period, from, to, today] of wanted) {
      const { calls } = await ask(sales({ period }), REAL, today);
      assert.equal(calls.length, 1, `${period}`);
      assert.equal(calls[0].args.p_from, from, `${period} from`);
      assert.equal(calls[0].args.p_to, to, `${period} to`);
    }
  });

  it("narrows to one product, found by its short name", async () => {
    const { outcome, calls } = await ask(sales({ period: "date", date: "2026-09-30", metric: "units", product_text: "wp" }));
    assert.equal(calls[0].args.p_product_id, WP);
    assert.equal(calls[0].args.p_staff_id, null);
    assert.deepEqual(outcome, {
      status: "answer",
      text: "*Wed 30 Sep 2026*\nWhite Paper\n\nUnits sold: 150 in 2 sales",
    });
  });

  it("narrows to one person", async () => {
    const { outcome, calls } = await ask(sales({ period: "date", date: "2026-09-30", staff_text: "Amaka" }));
    assert.equal(calls[0].args.p_staff_id, AMAKA);
    assert.equal(calls[0].args.p_product_id, null);
    assert.deepEqual(outcome, {
      status: "answer",
      text: "*Wed 30 Sep 2026*\nSold by Amaka\n\nRevenue: ₦14,000\nSales: 1\nUnits sold: 15",
    });
  });

  it("can narrow to a product and a person together", async () => {
    const { calls } = await ask(sales({ period: "date", date: "2026-09-30", product_text: "wp", staff_text: "chidi" }));
    assert.equal(calls[0].args.p_product_id, WP);
    assert.equal(calls[0].args.p_staff_id, CHIDI);
  });

  it("says plainly when nothing was sold", async () => {
    const { outcome } = await ask(sales({ period: "yesterday" }));
    assert.deepEqual(outcome, { status: "answer", text: "*Yesterday, Sun 4 Oct 2026*\n\nNo sales recorded." });
  });

  it("breaks down by product or by person when asked", async () => {
    const byProduct = await ask(sales({ period: "date", date: "2026-09-30", group_by: "product" }));
    assert.ok(byProduct.outcome.status === "answer" && byProduct.outcome.text.includes("*By product*\n1. White Paper"));
    const byStaff = await ask(sales({ period: "date", date: "2026-09-30", group_by: "staff" }));
    assert.ok(byStaff.outcome.status === "answer" && byStaff.outcome.text.includes("*By salesperson*\nChidi: 2 sales"));
  });

  it("refuses a date that has not happened yet, without asking the database", async () => {
    const { outcome, calls } = await ask(sales({ period: "date", date: "2026-12-25" }));
    assert.equal(outcome.status, "reject");
    assert.ok(outcome.status === "reject" && outcome.code === "INVALID_PERIOD" && /hasn't happened yet/.test(outcome.message));
    assert.equal(calls.length, 0);
  });
});

// ---------- names that are not clear ----------

describe("when a name is not clear", () => {
  it("asks which product when several fit, and does not ask the database", async () => {
    const { outcome, calls } = await ask(sales({ product_text: "paper" }));
    assert.equal(calls.length, 0);
    assert.ok(outcome.status === "ask");
    assert.equal(outcome.question, "I found multiple paper products. Did you mean Brown Paper or White Paper?");
    assert.deepEqual(outcome.need, {
      kind: "product_choice",
      candidates: [
        { id: "b0000000-0000-0000-0000-000000000002", name: "Brown Paper" },
        { id: WP, name: "White Paper" },
      ],
    });
  });

  it("asks to confirm a close spelling of a product instead of using it", async () => {
    const { outcome, calls } = await ask({ intent: "query_stock", product_text: "whte paper" });
    assert.equal(calls.length, 0);
    assert.ok(outcome.status === "ask");
    assert.equal(outcome.question, "Did you mean White Paper?");
    assert.deepEqual(outcome.need, { kind: "product_confirm", candidate: { id: WP, name: "White Paper" } });
  });

  it("asks when it does not know the product", async () => {
    const { outcome, calls } = await ask(sales({ product_text: "zzz" }));
    assert.equal(calls.length, 0);
    assert.ok(outcome.status === "ask");
    assert.deepEqual(outcome.need, { kind: "product_unknown", text: "zzz" });
  });

  it("asks to confirm a close spelling of a person's name", async () => {
    const { outcome, calls } = await ask(sales({ staff_text: "chidy" }));
    assert.equal(calls.length, 0);
    assert.ok(outcome.status === "ask");
    assert.equal(outcome.question, "Did you mean Chidi?");
    assert.deepEqual(outcome.need, { kind: "staff_confirm", candidate: { id: CHIDI, name: "Chidi" } });
  });

  it("asks when it does not know the person", async () => {
    const { outcome, calls } = await ask(sales({ staff_text: "Bola" }));
    assert.equal(calls.length, 0);
    assert.ok(outcome.status === "ask");
    assert.deepEqual(outcome.need, { kind: "staff_unknown", text: "Bola" });
  });

  it("asks which person when the first name fits two people", async () => {
    const { db, calls } = fakeDb(REAL);
    const staff = [
      { id: OWNER, name: "Owner" },
      { id: "a0000000-0000-0000-0000-000000000008", name: "Chidi Okafor" },
      { id: "a0000000-0000-0000-0000-000000000009", name: "Chidi Eze" },
    ];
    const outcome = await answerQuery({ ...ctx(db), staff }, sales({ staff_text: "chidi" }));
    assert.equal(calls.length, 0);
    assert.ok(outcome.status === "ask");
    assert.equal(outcome.question, "More than one person fits \"chidi\". Did you mean Chidi Eze or Chidi Okafor?");
    assert.ok(outcome.need.kind === "staff_choice");
    assert.deepEqual(outcome.need.candidates.map((c) => c.name), ["Chidi Eze", "Chidi Okafor"]);
  });

  it("an exact full name wins over longer names that contain it", async () => {
    const { db, calls } = fakeDb(REAL);
    const staff = [...STAFF, { id: "a0000000-0000-0000-0000-000000000009", name: "Chidi Eze" }];
    const outcome = await answerQuery({ ...ctx(db), staff }, sales({ period: "date", date: "2026-09-30", staff_text: "chidi" }));
    assert.equal(outcome.status, "answer");
    assert.equal(calls[0].args.p_staff_id, CHIDI);
  });

  it("asks about the product before the person when both are unclear", async () => {
    const { outcome } = await ask(sales({ product_text: "paper", staff_text: "Bola" }));
    assert.ok(outcome.status === "ask" && outcome.need.kind === "product_choice");
  });
});

// ---------- stock, low stock, restock ----------

describe("answering stock questions", () => {
  it("lists every product when none is named", async () => {
    const { outcome, calls } = await ask({ intent: "query_stock", product_text: null });
    assert.deepEqual(calls, [{ fn: "stock_levels", args: { p_product_id: null } }]);
    assert.ok(outcome.status === "answer" && outcome.text.startsWith("*Stock*\nBrown Paper: 300"));
  });

  it("gives stock and price for the product named", async () => {
    const { outcome, calls } = await ask({ intent: "query_stock", product_text: "wp" });
    assert.deepEqual(calls, [{ fn: "stock_levels", args: { p_product_id: WP } }]);
    assert.deepEqual(outcome, { status: "answer", text: "White Paper: 253 in stock\nPrice: ₦800 each" });
  });

  it("refuses when the product has gone from the list since it was matched", async () => {
    const { outcome } = await ask({ intent: "query_stock", product_text: "ribbon" });
    assert.ok(outcome.status === "reject" && outcome.code === "PRODUCT_NOT_FOUND");
  });

  it("answers low stock and the restock list", async () => {
    const low = await ask({ intent: "query_low_stock" });
    assert.deepEqual(low.outcome, {
      status: "answer",
      text: "*Low stock*\nGold Border: 28 left (alert at 50)\nFloral: 56 left (alert at 75)",
    });
    const restock = await ask({ intent: "query_restock_list" });
    assert.deepEqual(restock.outcome, {
      status: "answer",
      text: "*Restock list*\nGold Border: pending, 28 left\nFloral: ordered 200, 56 left",
    });
  });

  it("says so when nothing is low or on the list", async () => {
    const empty = { ...REAL, low_stock_list: () => [], restock_list: () => [] };
    assert.deepEqual((await ask({ intent: "query_low_stock" }, empty)).outcome, {
      status: "answer",
      text: "Nothing is low on stock right now.",
    });
    assert.deepEqual((await ask({ intent: "query_restock_list" }, empty)).outcome, {
      status: "answer",
      text: "The restock list is empty.",
    });
  });
});

// ---------- when the database has a problem ----------

describe("when the database has a problem", () => {
  const SAFE = "Sorry, I couldn't get that just now. Please try again in a moment.";

  it("never throws: a failed call becomes a safe message, with the reason kept for the logs", async () => {
    const throwing = {
      ...REAL,
      sales_summary: () => {
        throw new Error("connection boom");
      },
    };
    const { outcome } = await ask(sales({ period: "today" }), throwing);
    assert.deepEqual(outcome, { status: "reject", code: "DB_ERROR", message: SAFE, detail: "connection boom" });
  });

  it("does not show internal details to the person", async () => {
    const { outcome } = await ask({ intent: "query_low_stock" }, {});
    assert.ok(outcome.status === "reject");
    assert.equal(outcome.message, SAFE);
    assert.ok(!outcome.message.includes("unexpected call"));
    assert.ok(outcome.detail?.includes("unexpected call"));
  });

  it("passes the database's own refusal on with its code", async () => {
    const refusing = {
      ...REAL,
      sales_summary: () => ({ ok: false, error: { code: "INVALID_INPUT", message: "The end date must be after the start date" } }),
    };
    const { outcome } = await ask(sales({ period: "today" }), refusing);
    assert.deepEqual(outcome, {
      status: "reject",
      code: "INVALID_INPUT",
      message: SAFE,
      detail: "The end date must be after the start date",
    });
  });

  it("refuses a reply it cannot read instead of showing wrong figures", async () => {
    const garbled = { ...REAL, sales_summary: () => ({ ok: true, revenue: "lots", transactions: 3 }) };
    const { outcome } = await ask(sales({ period: "today" }), garbled);
    assert.ok(outcome.status === "reject" && outcome.code === "BAD_REPLY" && outcome.message === SAFE);
    const garbledStock = { ...REAL, stock_levels: () => [{ name: "White Paper" }] };
    const stock = await ask({ intent: "query_stock", product_text: null }, garbledStock);
    assert.ok(stock.outcome.status === "reject" && stock.outcome.code === "BAD_REPLY");
  });
});

// ---------- sending the daily report ----------

const OWNER_R: Recipient = { id: OWNER, name: "Owner", phone: "+2348000000001" };
const SECOND: Recipient = { id: "a0000000-0000-0000-0000-000000000007", name: "Partner", phone: "+2348000000007" };

function channel(send: ReportChannel["send"], over: Partial<Pick<ReportChannel, "name" | "delivers">> = {}) {
  const sent: Array<{ to: string; text: string }> = [];
  const c: ReportChannel = {
    name: over.name ?? "test",
    delivers: over.delivers ?? true,
    send: async (to, text) => {
      sent.push({ to, text });
      return send(to, text);
    },
  };
  return { c, sent };
}

const status = (r: DeliveryResult[]) => r.map((x) => x.outcome.status);

describe("sending the daily report honestly", () => {
  it("reports sent only when a real channel says it sent", async () => {
    const { c, sent } = channel(async () => ({ status: "sent", messageId: "wamid.1" }));
    const results = await sendToAll(c, [OWNER_R], "hello");
    assert.deepEqual(results, [{ recipient: OWNER_R, outcome: { status: "sent", messageId: "wamid.1" } }]);
    assert.deepEqual(sent, [{ to: "+2348000000001", text: "hello" }]);
  });

  it("never reports sent for a channel that does not really deliver, even if it claims to", async () => {
    const { c } = channel(async () => ({ status: "sent", messageId: "fake" }), { name: "mock", delivers: false });
    const [r] = await sendToAll(c, [OWNER_R], "hello");
    assert.equal(r.outcome.status, "skipped");
    assert.ok(r.outcome.status === "skipped" && /does not deliver to real phones/.test(r.outcome.reason));
  });

  it("sends nothing and says so when no channel is connected", async () => {
    const [r] = await sendToAll(unconnectedChannel, [OWNER_R], "hello");
    assert.deepEqual(r.outcome, { status: "skipped", reason: "no messaging channel is connected yet" });
    assert.equal(unconnectedChannel.delivers, false);
  });

  it("records a failure as a failure, and the others are still tried", async () => {
    let n = 0;
    const { c, sent } = channel(async () => {
      n++;
      if (n === 1) throw new Error("network down");
      return { status: "sent", messageId: null };
    });
    const results = await sendToAll(c, [OWNER_R, SECOND], "hello");
    assert.deepEqual(status(results), ["failed", "sent"]);
    assert.deepEqual(results[0].outcome, { status: "failed", reason: "network down" });
    assert.equal(sent.length, 2);
  });

  it("passes a channel's own failure through", async () => {
    const { c } = channel(async () => ({ status: "failed", reason: "number not on WhatsApp" }));
    const [r] = await sendToAll(c, [OWNER_R], "hello");
    assert.deepEqual(r.outcome, { status: "failed", reason: "number not on WhatsApp" });
  });

  it("treats an answer it cannot read as a failure, never as sent", async () => {
    for (const odd of [undefined, null, "ok", { status: "delivered" }, { status: "failed" }, { ok: true }]) {
      const { c } = channel(async () => odd as unknown as SendOutcome);
      const [r] = await sendToAll(c, [OWNER_R], "hello");
      assert.equal(r.outcome.status, "failed", JSON.stringify(odd));
    }
  });

  it("describes what happened in plain words", () => {
    assert.equal(describeDelivery([]), "There was no one to send the report to.");
    const results: DeliveryResult[] = [
      { recipient: OWNER_R, outcome: { status: "sent", messageId: null } },
      { recipient: SECOND, outcome: { status: "failed", reason: "network down" } },
      { recipient: { ...SECOND, name: "Third" }, outcome: { status: "skipped", reason: "no channel" } },
    ];
    assert.equal(describeDelivery(results), "Sent to 1 of 3.\nPartner: failed (network down)\nThird: not sent (no channel)");
  });
});

describe("running the daily report", () => {
  it("builds the report from the database and sends that exact text", async () => {
    const { db, calls } = fakeDb(REAL);
    const { c, sent } = channel(async () => ({ status: "sent", messageId: "m1" }));
    const run = await runDailyReport({ db, channel: c, recipients: [OWNER_R, SECOND], date: "2026-09-30" });
    assert.deepEqual(calls, [{ fn: "daily_report", args: { p_date: "2026-09-30" } }]);
    assert.ok(run.ok);
    const expected = formatDailyReport(parseDailyReport(fixture("daily0930"))!);
    assert.equal(run.text, expected);
    assert.ok(run.text.startsWith("*Daily report: Wed 30 Sep 2026*"));
    assert.deepEqual(status(run.results), ["sent", "sent"]);
    assert.deepEqual(sent.map((s) => s.to), ["+2348000000001", "+2348000000007"]);
    assert.ok(sent.every((s) => s.text === expected));
  });

  it("sends nothing if the figures cannot be read", async () => {
    for (const handlers of [
      { daily_report: () => { throw new Error("db down"); } },
      { daily_report: () => ({ ok: true, date: "2026-09-30" }) },
      { daily_report: () => ({ ok: false, error: { code: "INVALID_INPUT", message: "A date is required" } }) },
    ]) {
      const { db } = fakeDb(handlers);
      const { c, sent } = channel(async () => ({ status: "sent", messageId: null }));
      const run = await runDailyReport({ db, channel: c, recipients: [OWNER_R], date: "2026-09-30" });
      assert.equal(run.ok, false);
      assert.equal(sent.length, 0, "nothing may be sent without a readable report");
    }
  });

  it("with no real channel, reports that nothing was sent", async () => {
    const { db } = fakeDb(REAL);
    const run = await runDailyReport({ db, channel: unconnectedChannel, recipients: [OWNER_R], date: "2026-09-30" });
    assert.ok(run.ok);
    assert.deepEqual(status(run.results), ["skipped"]);
    assert.equal(describeDelivery(run.results), "Sent to 0 of 1.\nOwner: not sent (no messaging channel is connected yet)");
  });

  it("with no recipients, nothing is sent and the result says so", async () => {
    const { db } = fakeDb(REAL);
    const { c, sent } = channel(async () => ({ status: "sent", messageId: null }));
    const run = await runDailyReport({ db, channel: c, recipients: [], date: "2026-09-30" });
    assert.ok(run.ok && run.results.length === 0);
    assert.equal(sent.length, 0);
  });
});

describe("who gets the daily report", () => {
  /** A stand-in for supabase-js's query builder: records the calls and can be awaited. */
  function usersDb(result: { data: unknown; error: { message: string } | null }) {
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select(columns: string) {
        calls.push(`select ${columns}`);
        return chain;
      },
      eq(column: string, value: unknown) {
        calls.push(`eq ${column}=${String(value)}`);
        return chain;
      },
      then(resolve: (r: unknown) => unknown) {
        return Promise.resolve(result).then(resolve);
      },
    };
    const db = {
      from(table: string) {
        calls.push(`from ${table}`);
        return chain;
      },
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it("is every active admin", async () => {
    const { db, calls } = usersDb({ data: [{ id: OWNER, name: "Owner", phone: "+2348000000001" }], error: null });
    const r = await getReportRecipients(db);
    assert.deepEqual(r, { ok: true, data: [OWNER_R] });
    assert.deepEqual(calls, ["from users", "select id, name, phone", "eq role=admin", "eq is_active=true"]);
  });

  it("fails clearly when the users cannot be read", async () => {
    const failing = await getReportRecipients(usersDb({ data: null, error: { message: "permission denied" } }).db);
    assert.deepEqual(failing, { ok: false, error: { code: "DB_ERROR", message: "permission denied" } });
    const garbled = await getReportRecipients(usersDb({ data: [{ id: OWNER, name: "Owner" }], error: null }).db);
    assert.ok(!garbled.ok && garbled.error.code === "BAD_REPLY");
    const notAList = await getReportRecipients(usersDb({ data: { id: OWNER }, error: null }).db);
    assert.ok(!notAList.ok && notAList.error.code === "BAD_REPLY");
  });
});
