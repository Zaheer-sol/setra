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
});
