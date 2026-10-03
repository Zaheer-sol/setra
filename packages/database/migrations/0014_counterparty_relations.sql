-- Who a wallet has transacted with (Nansen counterparties), cached like labels: the same for everyone,
-- so a repeated view never repeats a paid lookup. Used to suggest which known customer may be behind
-- an unknown sender. A suggestion for a person, never a match.
CREATE TABLE counterparty_relations (
  source text NOT NULL CHECK (source IN ('nansen')),
  chain text NOT NULL,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  status text NOT NULL CHECK (status IN ('ok', 'none', 'error')),
  counterparties jsonb NOT NULL DEFAULT '[]',
  error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, chain, address)
);
GRANT SELECT, INSERT, UPDATE ON counterparty_relations TO setra_app;
