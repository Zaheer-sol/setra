import { describe, expect, it } from "vitest";
import { signatureHeader } from "../../events/src";
import { Setra, SetraError, verifySetraWebhook } from "./index";

describe("@setra/sdk", () => {
  it("verifies signatures produced by Setra's signer (including rotation)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"type":"payment.matched"}';
    const header = signatureHeader(["whsec_new", "whsec_old"], ts, body);
    expect(verifySetraWebhook("whsec_new", body, String(ts), header)).toBe(true);
    expect(verifySetraWebhook("whsec_old", Buffer.from(body), String(ts), header)).toBe(true);
    expect(verifySetraWebhook("whsec_other", body, String(ts), header)).toBe(false);
    expect(verifySetraWebhook("whsec_new", body + " ", String(ts), header)).toBe(false);
  });

  it("sends auth and idempotency headers and surfaces API errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ error: { code: "wallet_required", message: "Add a wallet", request_id: "req_1" } }), { status: 422 });
    }) as unknown as typeof fetch;
    const setra = new Setra({ apiKey: "sk_test_abc", baseUrl: "http://localhost:4000", fetch: fake });
    await expect(setra.invoices.create({ customer_id: "cus_1", amount: "1.00" }, { idempotencyKey: "k-12345678" })).rejects.toMatchObject({ code: "wallet_required", status: 422, requestId: "req_1" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_abc");
    expect(headers["idempotency-key"]).toBe("k-12345678");
    expect(() => new Setra({ apiKey: "nope" })).toThrow();
    expect(new SetraError(1, "x", "y")).toBeInstanceOf(Error);
  });
});
