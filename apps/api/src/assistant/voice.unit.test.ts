import { describe, expect, it } from "vitest";
import type { Block, InvoiceCard, PaymentCard } from "./blocks";
import { pick, speak } from "./voice";

const payment = (over: Partial<PaymentCard>): PaymentCard => ({
  id: "pay_1", customer: "Nova Systems", purpose: "Cloud audit", purpose_status: "known", invoice: "INV-1002", amount: "1,125.00", asset: "USDC", network: "Monad Testnet",
  status: "matched", status_label: "", transaction_hash: "0x", explorer_url: null, received_at: "", simulated: true, href: "", ...over
});
const invoice = (over: Partial<InvoiceCard>): InvoiceCard => ({
  id: "inv_1", number: "INV-1002", title: "Cloud audit", purpose: null, customer: "Nova Systems", amount: "1,500.00", remaining: "375.00", asset: "USDC", network: "Monad Testnet",
  status: "partially_paid", due_at: null, payment_url: "", line_items: [], href: "", ...over
});
const said = (intent: string, blocks: Block[], message = "has nova paid") => {
  const out = speak({ intent, pending: null, blocks }, message);
  return out.blocks.length > blocks.length && out.blocks[0]!.type === "text" ? out.blocks[0]!.text : null;
};
/** Every number Seti says must appear on a card it is introducing. */
const numbersIn = (s: string) => s.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];

describe("Seti's voice", () => {
  it("answers a partial payment in a sentence, using only the card's figures", () => {
    const blocks: Block[] = [{ type: "payment", title: "Partial payment received", tone: "warning", payment: payment({ status: "partial" }) }, { type: "invoices", title: "Still open for Nova Systems", items: [invoice({})], empty: "" }];
    const text = said("payment_status", blocks)!;
    expect(text).toBe("Nova Systems has paid 1,125.00 USDC for Cloud audit so far. 375.00 USDC is still open.");
    const cardText = JSON.stringify(blocks);
    for (const n of numbersIn(text)) expect(cardText).toContain(n);
  });

  it("says plainly when it couldn't place a payment, and never names a customer it doesn't know", () => {
    const text = said("latest", [{ type: "payment", title: "Payment requires review", tone: "warning", payment: payment({ status: "needs_review", customer: null, purpose: null, invoice: null, amount: "740.00" }) }])!;
    expect(text).toMatch(/^740\.00 USDC came in from a wallet I don't recognise, but I couldn't tell which invoice/);
  });

  it("summarises what's outstanding, or says nobody owes anything", () => {
    const items = [invoice({ customer: "Bright Foods", remaining: "750.00", status: "open" }), invoice({ number: "INV-1003" })];
    expect(said("outstanding", [{ type: "invoices", title: "Outstanding: 2 payment requests", items, empty: "", total: "1,125.00 USD outstanding" }])).toBe(
      "2 payment requests are still open, $1,125.00 in total. Bright Foods owes the most, 750.00 USDC."
    );
    expect(said("outstanding", [{ type: "invoices", title: "Outstanding: 0 payment requests", items: [], empty: "Nothing is outstanding." }], "whats outstanding")).toMatch(/nobody owes you anything|Nothing's outstanding/);
  });

  it("reads a bill like a sentence, with a readable due date", () => {
    expect(said("fin_payables", [{ type: "summary", title: "What you owe vendors", rows: [["Hetzner · HZ-1", "$320.00, due 2026-10-02"]], highlight: { label: "Total owed", value: "$320.00" } }])).toBe("You owe Hetzner $320.00 on bill HZ-1, due Oct 2.");
  });

  it("leaves replies alone when they already open with words, a question or a notice", () => {
    expect(said("create_request", [{ type: "text", text: "Who should I bill?" }])).toBeNull();
    expect(said("payment_status", [{ type: "notice", tone: "info", title: "No payments from Acme Ltd yet." }])).toBeNull();
    expect(said("fin_compare", [{ type: "text", text: "Net income is $900.00 higher than last month." }, { type: "summary", title: "x", rows: [], highlight: { label: "Change", value: "+$900.00" } }])).toBeNull();
  });

  it("introduces a confirmation without changing it", () => {
    const confirm: Block = { type: "confirm", actionId: "act_1", title: "Create this payment request?", rows: [["Amount", "1,200.00 USDC"]], confirmLabel: "Create", testMode: true, expiresAt: "" };
    const out = speak({ intent: "create_request", pending: null, blocks: [confirm] as Block[] }, "1200");
    expect(out.blocks[1]).toEqual(confirm);
    expect((out.blocks[0] as Extract<Block, { type: "text" }>).text).toMatch(/look right\?$/i);
  });

  it("words the same message the same way every time", () => {
    const options = ["a", "b", "c"];
    expect(pick("gimme the dough situation", options)).toBe(pick("gimme the dough situation", options));
    expect(new Set(["one", "two", "three", "four", "five", "six"].map((m) => pick(m, options))).size).toBeGreaterThan(1);
  });
});
