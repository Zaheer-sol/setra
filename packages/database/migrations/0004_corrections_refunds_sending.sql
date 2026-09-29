-- Operator corrections, refunds proven onchain, and sending payment requests.

-- ── Corrections ─────────────────────────────────────────────────────────────────────────────
-- An operator moves an applied payment to another invoice, or takes it off its invoice and back to
-- review. The original decision, resolution and allocations stay; compensating allocations reference
-- this record. Written once.
CREATE TABLE payment_corrections (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  payment_id text NOT NULL REFERENCES payments(id),
  action text NOT NULL CHECK (action IN ('unassign', 'reassign')),
  from_invoice_id text NOT NULL REFERENCES invoices(id),
  to_invoice_id text REFERENCES invoices(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'reassign') = (to_invoice_id IS NOT NULL)),
  CHECK (to_invoice_id IS NULL OR to_invoice_id <> from_invoice_id)
);
CREATE INDEX payment_corrections_payment_idx ON payment_corrections (payment_id, id);
CREATE TRIGGER payment_corrections_append_only BEFORE UPDATE OR DELETE ON payment_corrections FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE allocations ADD COLUMN correction_id text REFERENCES payment_corrections(id);

-- ── Outgoing transfers ──────────────────────────────────────────────────────────────────────
-- Stablecoin sent *from* a monitored wallet, observed from finalized blocks. Evidence for refunds.
-- Immutable except the canonical flag.
CREATE TABLE outgoing_transfers (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  wallet_id text NOT NULL REFERENCES wallets(id),
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_hash text NOT NULL,
  transaction_index integer NOT NULL,
  log_index integer NOT NULL,
  token_address text NOT NULL,
  asset_id text REFERENCES assets(id),
  to_address text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  block_timestamp timestamptz NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, chain_id, block_hash, transaction_hash, log_index)
);
CREATE INDEX outgoing_transfers_wallet_idx ON outgoing_transfers (wallet_id, block_number DESC);
CREATE INDEX outgoing_transfers_to_idx ON outgoing_transfers (organization_id, to_address);

CREATE FUNCTION guard_outgoing_transfer_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'outgoing transfers are immutable evidence'; END IF;
  IF (to_jsonb(NEW) - 'canonical') <> (to_jsonb(OLD) - 'canonical') THEN
    RAISE EXCEPTION 'outgoing transfers are immutable evidence (only canonical may change)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outgoing_transfers_guard BEFORE UPDATE OR DELETE ON outgoing_transfers FOR EACH ROW EXECUTE FUNCTION guard_outgoing_transfer_update();

-- ── Refunds ─────────────────────────────────────────────────────────────────────────────────
-- Money from a payment sent back, proven by an outgoing transfer. One transfer backs at most one refund.
CREATE TABLE refunds (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  payment_id text NOT NULL REFERENCES payments(id),
  outgoing_transfer_id text NOT NULL UNIQUE REFERENCES outgoing_transfers(id),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION reject_mutation();

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'refunded';

-- ── Sending payment requests ────────────────────────────────────────────────────────────────
ALTER TABLE invoices ADD COLUMN last_sent_at timestamptz;
ALTER TABLE invoices ADD COLUMN last_sent_to text;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_corrections', 'outgoing_transfers', 'refunds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_corrections, outgoing_transfers, refunds TO setra_app;
