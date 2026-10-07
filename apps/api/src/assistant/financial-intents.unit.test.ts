import { describe, expect, it, vi } from "vitest";
import { financial } from "./financial-intents";
import { api, type AssistantContext } from "./orchestrator";

vi.mock("./orchestrator", () => ({
  api: vi.fn(),
  createAction: vi.fn(),
  formatAmount: (v: string) => v,
  qs: (v: Record<string, string>) => new URLSearchParams(v).toString()
}));

describe("Seti payable dates", () => {
  it.each([
    ["Africa/Lagos", "2026-09-28T23:30:00Z", "2026-09-29"],
    ["America/Los_Angeles", "2026-09-29T01:30:00Z", "2026-09-28"]
  ])("uses the merchant's date in %s", async (tz, now, date) => {
    vi.mocked(api).mockResolvedValue({ bills: [], buckets: [], total: "0.00" });
    await financial({ tz, now: new Date(now), can: () => true } as unknown as AssistantContext, { kind: "fin_payables" });
    expect(api).toHaveBeenLastCalledWith(expect.anything(), "GET", `/v1/accounting/reports/payables-aging?as_of=${date}`);
  });

  it("builds a grounded financial briefing from Setra records", async () => {
    vi.mocked(api).mockImplementation(async (_ctx, _method, url) => {
      if (url.startsWith("/v1/overview")) return {
        metrics: { received: "250.00", payments: 1, needs_attention: 2, needs_attention_amount: "740.00", outstanding: "2000.00", outstanding_invoices: 1 }
      } as never;
      if (url === "/v1/accounting/accounts") return { data: [
        { subtype: "cash", system_key: "bank", balance: "5000.00" },
        { subtype: "cash", system_key: "monad_wallet", balance: "3000.00" },
        { system_key: "accounts_receivable", balance: "2000.00" },
        { system_key: "accounts_payable", balance: "420.00" }
      ] } as never;
      if (url.startsWith("/v1/accounting/reports/profit-and-loss")) return { net_income: "1800.00" } as never;
      if (url === "/v1/accounting/health") return { method: "accrual", checks: [{ label: "Trial balance", status: "ok" }] } as never;
      throw new Error(`Unexpected URL ${url}`);
    });
    const reply = await financial({ tz: "Africa/Lagos", now: new Date("2026-10-04T12:00:00Z"), can: () => true } as unknown as AssistantContext, { kind: "fin_briefing" });
    expect(reply.blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("2 payments waiting for review") });
    expect(reply.blocks[1]).toMatchObject({ type: "summary", highlight: { value: "$1800.00" } });
  });
});
