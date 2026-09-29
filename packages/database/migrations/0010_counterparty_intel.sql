-- Counterparty intelligence: public labels for the sender of an unidentified payment (Nansen).
-- Off by default per workspace, because looking one up sends the sender's address to Nansen.
ALTER TABLE organizations ADD COLUMN counterparty_intel_enabled boolean NOT NULL DEFAULT false;

-- A cache of public labels (the same for everyone), so a repeated view never repeats a paid lookup.
CREATE TABLE counterparty_labels (
  source text NOT NULL CHECK (source IN ('nansen')),
  chain text NOT NULL,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  status text NOT NULL CHECK (status IN ('ok', 'none', 'error')),
  labels jsonb NOT NULL DEFAULT '[]',
  error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, chain, address)
);
GRANT SELECT, INSERT, UPDATE ON counterparty_labels TO setra_app;
