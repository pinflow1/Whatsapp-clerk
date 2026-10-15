// Reports and answers: the one place the rest of the app imports them from.
//   dates.ts    which days "today", "this week" and "last month" mean
//   queries.ts  asks the database and checks what comes back
//   format.ts   turns the figures into WhatsApp text
//   answer.ts   answers a question about stock, price, low stock, restock or sales
//   deliver.ts  sends the daily report and tells the truth about whether it went
// SERVER ONLY: answer.ts, queries.ts and deliver.ts use the service-role database client.

export * from "./dates";
export * from "./queries";
export * from "./format";
export * from "./answer";
export * from "./deliver";
