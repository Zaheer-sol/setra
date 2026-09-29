-- Monad Execution Events: a second, faster source of observations.
--
-- The execution-events sidecar runs next to a Monad node, reads the node's event ring and forwards
-- matching logs from speculatively executed blocks. They enter the same pipeline as RPC tip
-- observations (provisional, no economic effect); settlement still requires the canonical,
-- finalized chain read over RPC.

-- Which path first reported an observation, and when the EVM recorded it (from the event ring).
ALTER TABLE source_observations ADD COLUMN detection_source text NOT NULL DEFAULT 'rpc'
  CHECK (detection_source IN ('rpc', 'execution_events', 'simulated'));
ALTER TABLE source_observations ADD COLUMN executed_at timestamptz;

-- Every path that saw an observation, at each stage, with the time it did. Lets Setra compare
-- detection sources per transaction without trusting either one alone.
CREATE TABLE observation_sightings (
  observation_id text NOT NULL REFERENCES source_observations(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('rpc', 'execution_events', 'simulated')),
  stage text NOT NULL CHECK (stage IN ('tip', 'settled')),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (observation_id, source, stage)
);
CREATE TRIGGER observation_sightings_append_only BEFORE UPDATE OR DELETE ON observation_sightings FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE observation_sightings ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation_sightings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON observation_sightings
  USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on');

-- Signals received from the sidecar (global operational data, like chain_cursors; public chain data only).
CREATE TABLE execution_signals (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  kind text NOT NULL CHECK (kind IN ('log', 'block_state', 'gap')),
  seqno bigint,
  block_number bigint,
  block_id text,
  block_hash text,
  transaction_hash text,
  log_index integer,
  state text,
  executed_at timestamptz,
  emitted_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observations integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX execution_signals_chain_idx ON execution_signals (chain_id, id DESC);
CREATE INDEX execution_signals_tx_idx ON execution_signals (transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE TRIGGER execution_signals_append_only BEFORE UPDATE OR DELETE ON execution_signals FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Health of each sidecar stream. A gap (sequence gap or overwritten payload) marks the stream
-- incomplete for a block range; RPC ingestion covers that range, and the stream counts as recovered
-- once the settled RPC cursor has passed it.
CREATE TABLE execution_streams (
  chain_id integer PRIMARY KEY REFERENCES networks(chain_id),
  sidecar_id text,
  last_seqno bigint,
  last_block_number bigint,
  last_signal_at timestamptz,
  events_consumed bigint NOT NULL DEFAULT 0,
  events_relevant bigint NOT NULL DEFAULT 0,
  payment_signals bigint NOT NULL DEFAULT 0,
  gaps bigint NOT NULL DEFAULT 0,
  incomplete_from_block bigint,
  incomplete_to_block bigint,
  last_gap_at timestamptz,
  last_gap_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON observation_sightings, execution_signals, execution_streams TO setra_app;
GRANT USAGE, SELECT ON SEQUENCE execution_signals_id_seq TO setra_app;
