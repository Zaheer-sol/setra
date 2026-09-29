-- Accountant access, receipts and documents on records, and recurring bills.

-- ── Accountant role ────────────────────────────────────────────────────────────────────────────
-- An outside accountant or bookkeeper: full access to the books, invoices and exceptions, none to
-- wallets, developer settings, API keys, members or workspace settings.
ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'accountant';

-- ── Attachments ────────────────────────────────────────────────────────────────────────────────
-- Receipts, invoices from vendors and supporting documents, stored with the record they support.
-- Files are kept in the database (bounded in size) so a backup of the books includes them. Removing
-- one marks it removed; the file and who removed it stay on record.
CREATE TABLE attachments (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  object_type text NOT NULL CHECK (object_type IN ('bill', 'expense', 'journal_entry', 'vendor')),
  object_id text NOT NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv', 'text/plain')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data bytea NOT NULL,
  uploaded_by_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_label text
);
CREATE INDEX attachments_object_idx ON attachments (organization_id, object_type, object_id);
CREATE FUNCTION guard_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'attachments are kept; mark one removed instead' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR (to_jsonb(NEW) - 'removed_at' - 'removed_by_label') <> (to_jsonb(OLD) - 'removed_at' - 'removed_by_label') THEN
    RAISE EXCEPTION 'an attachment can only be marked removed, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_guard BEFORE UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION guard_attachment();

-- ── Recurring bills ────────────────────────────────────────────────────────────────────────────
CREATE TABLE recurring_bills (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  vendor_id text NOT NULL REFERENCES vendors(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  anchor_day integer NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_date date NOT NULL,
  end_date date,
  due_days integer NOT NULL DEFAULT 14 CHECK (due_days BETWEEN 0 AND 365),
  auto_approve boolean NOT NULL DEFAULT false,
  number_prefix text NOT NULL CHECK (number_prefix ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  bills_created integer NOT NULL DEFAULT 0,
  last_bill_date date,
  created_by_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_bills_due_idx ON recurring_bills (status, next_date);

ALTER TABLE bills ADD COLUMN recurring_bill_id text REFERENCES recurring_bills(id);
CREATE UNIQUE INDEX bills_recurring_date ON bills (recurring_bill_id, bill_date) WHERE recurring_bill_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attachments', 'recurring_bills'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON attachments, recurring_bills TO setra_app;
