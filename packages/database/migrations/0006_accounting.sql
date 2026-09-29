-- Accounting core: a real double-entry ledger underneath Setra's payments and business activity.
--
-- Rules enforced here, not only in application code:
--   * Journal entries are drafted, then posted. A posted entry is immutable: it can't be edited,
--     deleted or have lines added; corrections are new reversing/adjusting entries.
--   * An entry can only be posted when its debits equal its credits (and it has two or more lines),
--     every account belongs to the same organization and mode and is active, and its date is not
--     inside a closed accounting period.
--   * Every line is one-sided (a debit or a credit, never both, never zero).
--   * Amounts are integer micro-units (6 decimals) of the reporting currency. Never floating point.
--   * Books are kept separately per organization and per mode (test / live).

CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense');

-- ── Settings ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_settings (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  -- accrual: invoices create receivables and revenue when issued; payments settle receivables.
  -- cash:    revenue is recognized when a payment is applied.
  method text NOT NULL DEFAULT 'accrual' CHECK (method IN ('accrual', 'cash')),
  reporting_currency char(3) NOT NULL DEFAULT 'USD',
  books_initialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, environment)
);

-- ── Chart of accounts ─────────────────────────────────────────────────────────────────────────
CREATE TABLE ledger_accounts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  code text NOT NULL CHECK (code ~ '^[0-9]{3,6}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  type ledger_account_type NOT NULL,
  -- cash, receivable, payable, customer_credit, suspense, clearing, contra_revenue, equity,
  -- retained_earnings, revenue, cogs, expense, other_asset, other_liability
  subtype text NOT NULL,
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  description text,
  -- Accounts Setra posts to automatically are identified by a stable key, never by code or name.
  system_key text,
  -- Asset accounts that mirror a monitored wallet's holding of one asset.
  wallet_id text REFERENCES wallets(id),
  asset_id text REFERENCES assets(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, code),
  CHECK ((wallet_id IS NULL) = (asset_id IS NULL))
);
CREATE UNIQUE INDEX ledger_accounts_system_key ON ledger_accounts (organization_id, environment, system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX ledger_accounts_wallet_asset ON ledger_accounts (organization_id, environment, wallet_id, asset_id) WHERE wallet_id IS NOT NULL;

-- A system account's type and key never change, and system accounts can't be archived: automatic
-- postings depend on them.
CREATE FUNCTION guard_ledger_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger accounts cannot be deleted; archive them instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.type <> OLD.type OR NEW.normal_balance <> OLD.normal_balance OR NEW.system_key IS DISTINCT FROM OLD.system_key
     OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.organization_id <> OLD.organization_id OR NEW.environment <> OLD.environment THEN
    RAISE EXCEPTION 'an account''s type, normal balance and system role are fixed once created' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.system_key IS NOT NULL AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'system accounts cannot be archived' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_accounts_guard BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION guard_ledger_account();

ALTER TABLE invoices ADD COLUMN revenue_account_id text REFERENCES ledger_accounts(id);

-- ── Accounting periods ───────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_periods (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by text,
  closed_by_label text,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, start_date),
  CHECK (end_date >= start_date)
);

-- ── Journal ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE journal_sequences (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  next_value integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, environment)
);

CREATE TABLE journal_entries (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  number text NOT NULL,
  entry_date date NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  memo text,
  -- What produced the entry: financial_event, invoice, resolution, outgoing_transfer, bill,
  -- bill_payment, expense, classification, manual, reversal.
  source_type text NOT NULL,
  source_id text,
  -- Idempotency: the same source fact can never post twice.
  source_key text,
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'posted', 'void')),
  reverses_entry_id text REFERENCES journal_entries(id),
  -- Set when an automatic posting dated inside a closed period was posted to the next open date.
  original_date date,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'api_key', 'system')),
  created_by_id text,
  created_by_label text,
  approved_by_id text,
  approved_by_label text,
  approved_at timestamptz,
  posted_by_id text,
  posted_by_label text,
  posted_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, number)
);
CREATE UNIQUE INDEX journal_entries_source_key ON journal_entries (organization_id, environment, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX journal_entries_reversal_once ON journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL AND status <> 'void';
CREATE INDEX journal_entries_feed_idx ON journal_entries (organization_id, environment, entry_date DESC, id DESC);
CREATE INDEX journal_entries_source_idx ON journal_entries (organization_id, source_type, source_id);

CREATE TABLE journal_lines (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  entry_id text NOT NULL REFERENCES journal_entries(id),
  position integer NOT NULL,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  debit numeric(78,0) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(78,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  -- Business context and evidence each line traces back to.
  customer_id text REFERENCES customers(id),
  vendor_id text,
  invoice_id text REFERENCES invoices(id),
  bill_id text,
  expense_id text,
  payment_id text REFERENCES payments(id),
  outgoing_transfer_id text REFERENCES outgoing_transfers(id),
  observation_id text REFERENCES source_observations(id),
  financial_event_id text REFERENCES financial_events(id),
  -- Valuation: the asset quantity behind the amount, and where the rate came from. Stablecoins are
  -- valued at their peg (rate_source 'peg:USD'); no market rate is ever invented.
  asset_id text REFERENCES assets(id),
  asset_amount numeric(78,0),
  rate_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit > 0) <> (credit > 0)),
  UNIQUE (entry_id, position)
);
CREATE INDEX journal_lines_account_idx ON journal_lines (account_id, entry_id);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX journal_lines_payment_idx ON journal_lines (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX journal_lines_invoice_idx ON journal_lines (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX journal_lines_customer_idx ON journal_lines (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX journal_lines_vendor_idx ON journal_lines (vendor_id) WHERE vendor_id IS NOT NULL;

-- Posting rules. A new entry starts as a draft (or approved); lines are added; then it is posted.
CREATE FUNCTION guard_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  totals record;
  bad record;
  period record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries cannot be deleted; void a draft or reverse a posted entry' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('posted', 'void') THEN
      RAISE EXCEPTION 'create the entry as a draft, add its lines, then post it' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.status IN ('posted', 'void') THEN
    RAISE EXCEPTION 'journal entry % is %; it can''t change. Record a reversing or adjusting entry instead', OLD.number, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.environment <> OLD.environment OR NEW.number <> OLD.number
     OR NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id THEN
    RAISE EXCEPTION 'an entry''s identity and source are fixed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'posted' THEN
    SELECT count(*) AS n, COALESCE(sum(debit), 0) AS d, COALESCE(sum(credit), 0) AS c INTO totals FROM journal_lines WHERE entry_id = NEW.id;
    IF totals.n < 2 THEN
      RAISE EXCEPTION 'journal entry % needs at least two lines to post', NEW.number USING ERRCODE = 'check_violation';
    END IF;
    IF totals.d <> totals.c THEN
      RAISE EXCEPTION 'journal entry % is not balanced: debits % ≠ credits %', NEW.number, totals.d, totals.c USING ERRCODE = 'check_violation';
    END IF;
    SELECT a.code, a.archived_at, a.organization_id, a.environment INTO bad FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
     WHERE l.entry_id = NEW.id AND (a.organization_id <> NEW.organization_id OR a.environment <> NEW.environment OR a.archived_at IS NOT NULL) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'journal entry % uses account % which is archived or belongs elsewhere', NEW.number, bad.code USING ERRCODE = 'check_violation';
    END IF;
    SELECT start_date, end_date INTO period FROM accounting_periods
     WHERE organization_id = NEW.organization_id AND environment = NEW.environment AND status = 'closed' AND NEW.entry_date BETWEEN start_date AND end_date LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'the accounting period % to % is closed; journal entry % can''t be posted on %', period.start_date, period.end_date, NEW.number, NEW.entry_date USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION guard_journal_entry();

-- Lines of a posted or void entry are frozen; lines of drafts can be edited.
CREATE FUNCTION guard_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
  eid text;
BEGIN
  eid := CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  SELECT status INTO st FROM journal_entries WHERE id = eid;
  IF st IN ('posted', 'void') THEN
    RAISE EXCEPTION 'lines of a % journal entry can''t change', st USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.entry_id <> OLD.entry_id THEN
    RAISE EXCEPTION 'a line can''t move to another entry' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION guard_journal_line();

-- ── Vendors ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE vendors (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  email text,
  external_ref text,
  default_account_id text REFERENCES ledger_accounts(id),
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_org_idx ON vendors (organization_id, environment, id DESC);
CREATE INDEX vendors_name_trgm ON vendors USING gin (name gin_trgm_ops);

CREATE TABLE vendor_addresses (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  vendor_id text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, chain_id, address)
);

-- ── Bills (accounts payable) ─────────────────────────────────────────────────────────────────
CREATE TABLE bills (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  vendor_id text NOT NULL REFERENCES vendors(id),
  number text NOT NULL CHECK (char_length(number) BETWEEN 1 AND 64),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  description text,
  currency char(3) NOT NULL DEFAULT 'USD',
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  amount_paid numeric(78,0) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  bill_date date NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'partially_paid', 'paid', 'void')),
  approved_by_id text,
  approved_by_label text,
  approved_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, vendor_id, number)
);
CREATE INDEX bills_org_idx ON bills (organization_id, environment, id DESC);
CREATE INDEX bills_vendor_idx ON bills (vendor_id);

CREATE TABLE bill_payments (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  bill_id text NOT NULL REFERENCES bills(id),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('onchain', 'offchain')),
  outgoing_transfer_id text UNIQUE REFERENCES outgoing_transfers(id),
  paid_from_account_id text REFERENCES ledger_accounts(id),
  paid_on date NOT NULL,
  reference text,
  memo text,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'onchain') = (outgoing_transfer_id IS NOT NULL)),
  CHECK ((method = 'offchain') = (paid_from_account_id IS NOT NULL))
);
CREATE INDEX bill_payments_bill_idx ON bill_payments (bill_id);
CREATE TRIGGER bill_payments_append_only BEFORE UPDATE OR DELETE ON bill_payments FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ── Expenses ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  vendor_id text REFERENCES vendors(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  description text,
  currency char(3) NOT NULL DEFAULT 'USD',
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  expense_date date NOT NULL,
  reference text,
  method text NOT NULL CHECK (method IN ('onchain', 'offchain')),
  outgoing_transfer_id text UNIQUE REFERENCES outgoing_transfers(id),
  paid_from_account_id text REFERENCES ledger_accounts(id),
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by_id text,
  approved_by_label text,
  approved_at timestamptz,
  rejected_reason text,
  created_by_id text,
  created_by_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'onchain') = (outgoing_transfer_id IS NOT NULL)),
  CHECK ((method = 'offchain') = (paid_from_account_id IS NOT NULL))
);
CREATE INDEX expenses_org_idx ON expenses (organization_id, environment, expense_date DESC, id DESC);
CREATE INDEX expenses_vendor_idx ON expenses (vendor_id);

-- ── Classifications ──────────────────────────────────────────────────────────────────────────
-- A human decision about money whose business meaning Setra couldn't establish: an unidentified
-- receipt (money in) or an outgoing transfer (money out) assigned to an account. Written once.
CREATE TABLE transaction_classifications (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'outgoing')),
  payment_id text UNIQUE REFERENCES payments(id),
  outgoing_transfer_id text UNIQUE REFERENCES outgoing_transfers(id),
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'receipt') = (payment_id IS NOT NULL)),
  CHECK ((kind = 'outgoing') = (outgoing_transfer_id IS NOT NULL))
);
CREATE TRIGGER transaction_classifications_append_only BEFORE UPDATE OR DELETE ON transaction_classifications FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ── Accounting issues ────────────────────────────────────────────────────────────────────────
-- An automatic posting that couldn't be made (e.g. an asset with no valuation rule). Payments are
-- never blocked by accounting; the issue is recorded, shown in reconciliation, and retried.
CREATE TABLE accounting_issues (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  source_key text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  message text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, source_key)
);

-- financial_events now also records business activity that isn't a payment (invoices issued,
-- expenses, bills, journal entries). Those rows have no payment.
ALTER TABLE financial_events ADD COLUMN vendor_id text REFERENCES vendors(id);
ALTER TABLE financial_events ADD COLUMN journal_entry_id text REFERENCES journal_entries(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounting_settings', 'ledger_accounts', 'accounting_periods', 'journal_sequences', 'journal_entries', 'journal_lines', 'vendors', 'vendor_addresses', 'bills', 'bill_payments', 'expenses', 'transaction_classifications', 'accounting_issues'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_settings, ledger_accounts, accounting_periods, journal_sequences, journal_entries, journal_lines, vendors, vendor_addresses, bills, bill_payments, expenses, transaction_classifications, accounting_issues TO setra_app;
