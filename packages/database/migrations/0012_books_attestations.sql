-- Fingerprints of closed months that a business published on Monad from its own wallet
-- (SetraBooksAttestation). Setra records each attestation only after reading it back from the chain
-- and checking that its book, month and Merkle root match the books exactly.
CREATE TABLE books_attestations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  period_start date NOT NULL,
  book_id text NOT NULL,
  root text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  version integer NOT NULL CHECK (version > 0),
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  publisher text NOT NULL,
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  published_at timestamptz NOT NULL,
  recorded_by text,
  recorded_by_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, transaction_hash)
);
CREATE INDEX books_attestations_period_idx ON books_attestations (organization_id, environment, period_start, block_number DESC);
CREATE TRIGGER books_attestations_append_only BEFORE UPDATE OR DELETE ON books_attestations FOR EACH ROW EXECUTE FUNCTION reject_mutation();

ALTER TABLE books_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON books_attestations
  USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on');
GRANT SELECT, INSERT ON books_attestations TO setra_app;
