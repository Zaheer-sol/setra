-- Orders from a merchant's own systems (a store, a checkout, a payment processor or a backend), so the
-- merchant never has to create an invoice in Setra by hand. An order is stored as an invoice: the same
-- matching, accounting and exceptions apply. It is identified by the merchant's own order ID.

ALTER TABLE invoices ADD COLUMN external_id text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 120);
-- One live order per external ID. A cancelled order frees the ID, so an updated order can replace it.
CREATE UNIQUE INDEX invoices_external_id ON invoices (organization_id, environment, external_id) WHERE external_id IS NOT NULL AND status <> 'cancelled';

-- Customers sent by those systems are found again by the merchant's own customer reference.
CREATE INDEX customers_external_ref_idx ON customers (organization_id, environment, external_ref) WHERE external_ref IS NOT NULL;

-- A connected system that posts its orders to Setra.
CREATE TABLE order_sources (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  -- generic: signed JSON in Setra's order format. shopify: Shopify's order webhooks, signed by Shopify.
  kind text NOT NULL CHECK (kind IN ('generic', 'shopify')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  secret_ciphertext text NOT NULL,
  secret_hint text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_event_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_sources_org_idx ON order_sources (organization_id, environment);

ALTER TABLE invoices ADD COLUMN order_source_id text REFERENCES order_sources(id);

-- Every delivery a source made, once (the sender's delivery ID makes retries harmless), with what Setra did.
CREATE TABLE order_source_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  source_id text NOT NULL REFERENCES order_sources(id) ON DELETE CASCADE,
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 200),
  topic text,
  external_id text,
  outcome text NOT NULL CHECK (outcome IN ('created', 'updated', 'unchanged', 'cancelled', 'ignored', 'failed')),
  detail text,
  invoice_id text REFERENCES invoices(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, delivery_id)
);
CREATE INDEX order_source_events_source_idx ON order_source_events (source_id, received_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_sources', 'order_source_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON order_sources TO setra_app;
GRANT SELECT, INSERT ON order_source_events TO setra_app;
