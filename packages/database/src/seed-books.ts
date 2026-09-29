import type { Actor } from "@setra/engine";
import { loadEnvFile } from "./load-env";

/**
 * Demo books for the "Acme Infrastructure" demo workspace (test mode): an opening bank balance,
 * vendors, bills (paid, due and overdue), a monthly rent schedule and expenses, so the reports,
 * payables and Seti have a realistic month to talk about. Dates are relative to today.
 *
 * Safe to run repeatedly: it does nothing if the demo workspace already has vendors. Never runs in
 * production, and only touches a workspace flagged as a demo.
 */

loadEnvFile();
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const { withSystem, withTenant, closePools } = await import("./pool");
const engine = await import("@setra/engine");
engine.setLogger(engine.silentLogger);

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ago = (days: number) => iso(new Date(Date.now() - days * DAY));
const monthStart = (offset: number) => {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)));
};

const demo = (
  await withSystem((c) =>
    c.query(
      `SELECT o.id, u.id AS user_id, u.email FROM organizations o JOIN organization_members m ON m.organization_id = o.id AND m.role = 'owner' JOIN users u ON u.id = m.user_id
        WHERE o.is_demo ORDER BY o.created_at LIMIT 1`
    )
  )
).rows[0] as { id: string; user_id: string; email: string } | undefined;
if (!demo) {
  console.log("No demo workspace found. Run `npm run db:seed` first.");
  await closePools();
  process.exit(0);
}
const orgId = demo.id;
const actor: Actor = { type: "user", id: demo.user_id, label: demo.email };

const result = await withTenant(orgId, async (c) => {
  if ((await c.query("SELECT 1 FROM vendors WHERE organization_id = $1 AND environment = 'test' LIMIT 1", [orgId])).rows[0]) return null;
  await engine.ensureBooks(c, orgId, "test");
  const account = async (code: string) => (await c.query("SELECT id FROM ledger_accounts WHERE organization_id = $1 AND environment = 'test' AND code = $2", [orgId, code])).rows[0]!.id as string;
  const bank = await account("1030");
  const contractor = await account("6010");
  const software = await account("6020");
  const office = await account("6070");
  // Never date anything into a closed month: move it to the first open day instead.
  const lastClosed = (await c.query("SELECT max(end_date) AS d FROM accounting_periods WHERE organization_id = $1 AND environment = 'test' AND status = 'closed'", [orgId])).rows[0]?.d as string | null;
  const floor = lastClosed ? iso(new Date(Date.parse(`${lastClosed}T00:00:00Z`) + DAY)) : null;
  const open = (date: string) => (floor && date < floor ? floor : date);

  await engine.setOpeningBalances(c, orgId, "test", { date: open(ago(45)), lines: [{ account_id: bank, amount: "12000.00", memo: "Business checking at the start of the books" }] }, actor);

  const vendor = (name: string, email: string, defaultAccount: string) => engine.createVendor(c, orgId, "test", { name, email, default_account_id: defaultAccount }, actor);
  const rivera = await vendor("Rivera Design Studio", "invoices@riveradesign.test", contractor);
  const northwind = await vendor("Northwind Hosting", "billing@northwind.test", software);
  const figma = await vendor("Figma", "billing@figma.test", software);
  const harbor = await vendor("Harbor Workspace", "accounts@harborworkspace.test", office);

  // Last month's design sprint: approved and paid from the bank.
  const sprint1 = await engine.createBill(c, orgId, "test", { vendor_id: rivera.id, number: "RDS-1041", title: "Design sprint, phase 1", amount: "2400.00", bill_date: open(ago(35)), due_date: open(ago(20)), approve: true }, actor);
  await engine.payBill(c, orgId, "test", sprint1.id, { paid_from_account_id: bank, paid_on: open(ago(24)), reference: "Wire 88213" }, actor);
  // This month's sprint: approved, due later.
  await engine.createBill(c, orgId, "test", { vendor_id: rivera.id, number: "RDS-1057", title: "Design sprint, phase 2", amount: "2800.00", bill_date: open(ago(5)), due_date: ago(-25), approve: true }, actor);
  // Hosting: approved and already overdue.
  await engine.createBill(c, orgId, "test", { vendor_id: northwind.id, number: "NW-2210", title: "Hosting, this month", amount: "420.00", bill_date: open(ago(12)), due_date: open(ago(2)), approve: true }, actor);

  // Office rent on a monthly schedule; last month's is paid.
  await engine.createRecurringBill(c, orgId, "test", { vendor_id: harbor.id, title: "Office rent", amount: "1500.00", frequency: "monthly", start_date: open(monthStart(-1)), due_days: 10, auto_approve: true, number_prefix: "RENT" }, actor);
  await engine.generateDueRecurringBills(c, orgId, "test");
  const rent = (await c.query("SELECT id, bill_date FROM bills WHERE organization_id = $1 AND recurring_bill_id IS NOT NULL ORDER BY bill_date LIMIT 1", [orgId])).rows[0] as { id: string; bill_date: string } | undefined;
  if (rent) await engine.payBill(c, orgId, "test", rent.id, { paid_from_account_id: bank, paid_on: rent.bill_date, reference: "Standing order" }, actor);

  // Expenses: one recorded, one waiting for approval.
  await engine.createExpense(c, orgId, "test", { title: "Figma, annual team plan", amount: "540.00", vendor_id: figma.id, account_id: software, paid_from_account_id: bank, expense_date: open(ago(20)), approve: true }, actor);
  const owner = await account("3000");
  await engine.createExpense(c, orgId, "test", { title: "Client lunch with Acme Ltd", amount: "86.40", paid_from_account_id: owner, expense_date: open(ago(3)), notes: "Paid personally; reimburse" }, actor);
  return { vendors: 4 };
});

console.log(result ? "Demo books added: opening balance, 4 vendors, bills, rent schedule and expenses." : "Demo books already present; nothing to do.");
await closePools();
