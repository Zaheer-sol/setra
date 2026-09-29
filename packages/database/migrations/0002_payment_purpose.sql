-- Payment purpose: what a payment request is for, as first-class data.
--
--   title    short answer to "What is this payment for?" (e.g. "September Infrastructure Services")
--   purpose  optional detail the payer sees (e.g. "Cloud architecture, deployment and monitoring")
--   line items, when the merchant itemizes the amount
--
-- The previous free-text `description` held one-line summaries, which are titles, so existing values
-- move to `title` and the column becomes `purpose`.

ALTER TABLE invoices ADD COLUMN title text;
ALTER TABLE invoices RENAME COLUMN description TO purpose;
UPDATE invoices SET title = purpose, purpose = NULL WHERE purpose IS NOT NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_title_length CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 140);
ALTER TABLE invoices ADD CONSTRAINT invoices_purpose_length CHECK (purpose IS NULL OR char_length(purpose) BETWEEN 1 AND 500);
CREATE INDEX invoices_title_trgm ON invoices USING gin (title gin_trgm_ops);
CREATE INDEX invoices_purpose_trgm ON invoices USING gin (purpose gin_trgm_ops);

-- Itemization. Written once with the invoice and never changed: the amounts are part of what the
-- payer agreed to pay. Money is integer base units; amount = unit_amount × quantity exactly.
CREATE TABLE invoice_line_items (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id text NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_amount numeric(78,0) NOT NULL CHECK (unit_amount > 0),
  amount numeric(78,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, position),
  CHECK (amount = unit_amount * quantity)
);
CREATE INDEX invoice_line_items_invoice_idx ON invoice_line_items (invoice_id, position);
CREATE TRIGGER invoice_line_items_immutable BEFORE UPDATE ON invoice_line_items FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Line items must add up to the invoice amount. Checked at commit so all items can be inserted first.
CREATE FUNCTION check_line_items_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE due numeric; total numeric;
BEGIN
  SELECT amount_due INTO due FROM invoices WHERE id = NEW.invoice_id;
  SELECT COALESCE(SUM(amount), 0) INTO total FROM invoice_line_items WHERE invoice_id = NEW.invoice_id;
  IF due IS NOT NULL AND total <> due THEN
    RAISE EXCEPTION 'line items total % does not equal invoice amount %', total, due USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_line_items_total AFTER INSERT ON invoice_line_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_line_items_total();

ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_line_items
  USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on');

-- How a payment's business context was established. NULL while it has none (unknown, confirming,
-- dismissed). Set whenever a payment is applied to an invoice; the full history stays in
-- match_decisions, resolutions and financial_events.
ALTER TABLE payments ADD COLUMN context_source text CHECK (context_source IN ('automatic_match', 'payment_intent', 'manual_resolution'));
UPDATE payments p SET context_source = CASE
    WHEN EXISTS (SELECT 1 FROM allocations a WHERE a.payment_id = p.id AND a.kind = 'manual') THEN 'manual_resolution'
    WHEN p.payment_intent_id IS NOT NULL THEN 'payment_intent'
    ELSE 'automatic_match'
  END
 WHERE p.invoice_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line_items TO setra_app;
