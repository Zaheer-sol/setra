import { expect, test } from "@playwright/test";

test.use({ colorScheme: "dark", reducedMotion: "reduce" });

// Layout fixture only: no payment is created or resolved by these tests.
const candidate = {
  invoice_id: "inv_layout", number: "INV-2041",
  title: "September infrastructure services and ongoing platform maintenance",
  customer_name: "Acme Infrastructure International", amount_remaining: "740.00",
  reasons: ["Exact amount", "Valid payment window"]
};
const exception = {
  id: "exc_layout", type: "ambiguous_match", status: "open", amount: "740.00",
  summary: "$740.00 could belong to more than one invoice",
  detail: "2 open invoices match this amount exactly, so Setra won't pick one.",
  recommended_action: "Choose the invoice this payment belongs to.",
  allowed_actions: ["assign", "refund", "dismiss"], candidates: [candidate],
  assignable_invoices: [], refund_candidates: [],
  payment: {
    id: "pay_layout", amount: "740.00", status: "needs_review", simulated: true,
    sender: `0x${"76".repeat(20)}`, recipient: `0x${"ae".repeat(20)}`,
    asset: { symbol: "USDC" }, wallet: { name: "Main Receiving Wallet" },
    network: "monad-testnet", network_name: "Monad Testnet", paid_at: "2026-09-30T21:08:00Z"
  }
};

for (const width of [1440, 1280, 768, 390]) {
  test(`exception resolution stays inside its panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = path === "/api/v1/me" ? {
        kind: "user", user: { id: "user_layout", name: "Maya Chen", email: "owner@acme.test" },
        organization: { id: "org_layout", name: "Acme Infrastructure", role: "owner", is_demo: true, onboarding_completed: true },
        organizations: [], environment: "test", role: "owner", permissions: ["exceptions:resolve"]
      } : path === "/api/v1/exceptions/exc_layout" ? exception : { data: [], has_more: false, unread: 0 };
      await route.fulfill({ json });
    });
    await page.goto("/app/exceptions/exc_layout");
    const form = page.locator("form").filter({ has: page.getByRole("radiogroup", { name: "Resolution" }) });
    await expect(form.getByRole("combobox", { name: "Invoice" })).toContainText(candidate.number);
    for (const action of ["assign", "refund", "dismiss", "assign"]) {
      await page.locator(`#action-${action}`).check();
      // Checking the document alone misses clipping: Card deliberately hides overflow.
      const overflow = await form.evaluate((el) => {
        const panel = el.closest('[data-slot="card"]')!.getBoundingClientRect();
        return Array.from(el.querySelectorAll('label, button, textarea, [role="radiogroup"]'))
          .filter((child) => {
            const box = child.getBoundingClientRect();
            return box.width > 0 && (box.right > panel.right + 1 || box.left < panel.left - 1);
          }).map((child) => child.textContent?.slice(0, 80));
      });
      expect(overflow).toEqual([]);
    }
    await expect(form.getByLabel("Reason")).toBeEditable();
    await form.locator("..").screenshot({ path: test.info().outputPath(`exception-${width}.png`) });
  });
}
