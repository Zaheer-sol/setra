-- Accounting gaps: bank reconciliation, exchange rates, network (gas) fees, customer credit
-- applications, credit notes, and undoing a classification.

-- ── Exchange rates ─────────────────────────────────────────────────────────────────────────────
-- Rates Setra may use to value something that isn't pegged to the reporting currency (a euro
-- stablecoin, gas paid in MON or ETH). Setra never invents a rate: a rate is entered by the
-- business (organization_id set) or published by a named source (organization_id NULL, e.g. the
-- European Central Bank reference rates).
CREATE TABLE fx_rates (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  base text NOT NULL CHECK (base ~ '^[A-Z0-9]{2,10}$'),
  quote char(3) NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate_date date NOT NULL,
  rate numeric(38,18) NOT NULL CHECK (rate > 0),
  source text NOT NULL CHECK (source IN ('manual', 'ecb')),
  note text,
  created_by_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'manual') = (organization_id IS NOT NULL))
);
CREATE UNIQUE INDEX fx_rates_unique ON fx_rates (COALESCE(organization_id, ''), base, quote, rate_date, source);
CREATE INDEX fx_rates_lookup ON fx_rates (base, quote, rate_date DESC);
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fx_rates
  USING (organization_id IS NULL OR organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on');

-- ── Network fees ───────────────────────────────────────────────────────────────────────────────
-- Gas a monitored wallet paid for a transaction that moved stablecoin out of it. One row per
-- transaction; paid_by_wallet is false when someone else (a relayer, a smart account) paid.
CREATE TABLE network_fees (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  wallet_id text NOT NULL REFERENCES wallets(id),
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  transaction_hash text NOT NULL,
  native_symbol text NOT NULL,
  fee_native numeric(78,0) NOT NULL CHECK (fee_native >= 0),
  paid_by_wallet boolean NOT NULL,
  block_timestamp timestamptz NOT NULL,
  outgoing_transfer_id text REFERENCES outgoing_transfers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, chain_id, transaction_hash)
);
CREATE TRIGGER network_fees_append_only BEFORE UPDATE OR DELETE ON network_fees FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Native-token accounts (e.g. "MON gas · Main Wallet") are wallet accounts without an asset.
ALTER TABLE ledger_accounts ADD COLUMN native_symbol text;
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_wallet_holding CHECK (
  (wallet_id IS NULL AND asset_id IS NULL AND native_symbol IS NULL)
  OR (wallet_id IS NOT NULL AND (asset_id IS NULL) <> (native_symbol IS NULL))
);
CREATE UNIQUE INDEX ledger_accounts_wallet_native ON ledger_accounts (organization_id, environment, wallet_id, native_symbol) WHERE native_symbol IS NOT NULL;

-- ── Bank reconciliation ────────────────────────────────────────────────────────────────────────
CREATE TABLE bank_statement_imports (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  filename text,
  line_count integer NOT NULL,
  skipped_count integer NOT NULL DEFAULT 0,
  created_by_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_lines (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  import_id text NOT NULL REFERENCES bank_statement_imports(id),
  line_date date NOT NULL,
  description text NOT NULL,
  reference text,
  -- Signed, in ledger micro-units: positive is money in, negative is money out.
  amount numeric(78,0) NOT NULL CHECK (amount <> 0),
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'excluded')),
  journal_line_id text UNIQUE REFERENCES journal_lines(id),
  matched_at timestamptz,
  matched_by_label text,
  excluded_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, account_id, fingerprint),
  CHECK ((status = 'matched') = (journal_line_id IS NOT NULL))
);
CREATE INDEX bank_statement_lines_account_idx ON bank_statement_lines (account_id, line_date);

CREATE TABLE bank_reconciliations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  statement_date date NOT NULL,
  statement_balance numeric(78,0) NOT NULL,
  ledger_balance numeric(78,0) NOT NULL,
  uncleared_total numeric(78,0) NOT NULL,
  completed_by_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, account_id, statement_date)
);
CREATE TRIGGER bank_reconciliations_append_only BEFORE UPDATE OR DELETE ON bank_reconciliations FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ── Customer credits and credit notes ─────────────────────────────────────────────────────────
-- Moving an overpayment's excess from the invoice it overpaid to another open invoice of the same
-- customer. Append-only; undone by a negative row that reverses it.
CREATE TABLE credit_applications (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  payment_id text NOT NULL REFERENCES payments(id),
  from_invoice_id text NOT NULL REFERENCES invoices(id),
  to_invoice_id text NOT NULL REFERENCES invoices(id),
  asset_id text NOT NULL REFERENCES assets(id),
  amount numeric(78,0) NOT NULL CHECK (amount <> 0),
  reverses_id text UNIQUE REFERENCES credit_applications(id),
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_invoice_id <> to_invoice_id),
  CHECK ((reverses_id IS NOT NULL) = (amount < 0))
);
CREATE INDEX credit_applications_to_idx ON credit_applications (to_invoice_id);
CREATE INDEX credit_applications_from_idx ON credit_applications (from_invoice_id);
CREATE INDEX credit_applications_payment_idx ON credit_applications (payment_id);
CREATE TRIGGER credit_applications_append_only BEFORE UPDATE OR DELETE ON credit_applications FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- A credit note lowers what a customer owes on an invoice (a discount, a returned item, a billing
-- mistake). The invoice's amount_due goes down; the original total is amount_due + amount_credited.
ALTER TABLE invoices ADD COLUMN amount_credited numeric(78,0) NOT NULL DEFAULT 0 CHECK (amount_credited >= 0);

CREATE TABLE credit_notes (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  invoice_id text NOT NULL REFERENCES invoices(id),
  customer_id text NOT NULL REFERENCES customers(id),
  number text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  account_id text REFERENCES ledger_accounts(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, number)
);
CREATE TRIGGER credit_notes_append_only BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ── Undoing a classification ──────────────────────────────────────────────────────────────────
-- A classification can be reversed once (its entry is reversed); the money goes back to its
-- holding account and can be classified again. Everything else about the row stays immutable.
ALTER TABLE transaction_classifications ADD COLUMN reversed_at timestamptz;
ALTER TABLE transaction_classifications ADD COLUMN reversed_by_label text;
ALTER TABLE transaction_classifications ADD COLUMN reversal_reason text;
DROP TRIGGER transaction_classifications_append_only ON transaction_classifications;
CREATE FUNCTION guard_classification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'classifications are append-only' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'classification already reversed' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - 'reversed_at' - 'reversed_by_label' - 'reversal_reason') <> (to_jsonb(OLD) - 'reversed_at' - 'reversed_by_label' - 'reversal_reason') OR NEW.reversed_at IS NULL THEN
    RAISE EXCEPTION 'a classification can only be marked reversed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transaction_classifications_guard BEFORE UPDATE OR DELETE ON transaction_classifications FOR EACH ROW EXECUTE FUNCTION guard_classification();
ALTER TABLE transaction_classifications DROP CONSTRAINT transaction_classifications_payment_id_key;
ALTER TABLE transaction_classifications DROP CONSTRAINT transaction_classifications_outgoing_transfer_id_key;
CREATE UNIQUE INDEX transaction_classifications_payment_active ON transaction_classifications (payment_id) WHERE reversed_at IS NULL AND payment_id IS NOT NULL;
CREATE UNIQUE INDEX transaction_classifications_transfer_active ON transaction_classifications (outgoing_transfer_id) WHERE reversed_at IS NULL AND outgoing_transfer_id IS NOT NULL;

-- ── Year-end closing entries may be posted into a closed December ────────────────────────────
CREATE OR REPLACE FUNCTION guard_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- The year-end closing entry is dated on the last day of the year by definition, and the year's
    -- months are normally closed by then; it's the one entry allowed into a closed period.
    IF FOUND AND NEW.source_type <> 'year_end' THEN
      RAISE EXCEPTION 'the accounting period % to % is closed; journal entry % can''t be posted on %', period.start_date, period.end_date, NEW.number, NEW.entry_date USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ── Row-level security and grants ──────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['network_fees', 'bank_statement_imports', 'bank_statement_lines', 'bank_reconciliations', 'credit_applications', 'credit_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON fx_rates, network_fees, bank_statement_imports, bank_statement_lines, bank_reconciliations, credit_applications, credit_notes TO setra_app;
