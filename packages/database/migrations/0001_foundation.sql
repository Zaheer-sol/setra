-- Setra foundation schema.
--
-- Design rules enforced here, not only in application code:
--   * Every tenant-owned row carries organization_id; row-level security rejects cross-tenant access.
--   * Blockchain evidence, matching decisions, allocations, financial events, resolutions,
--     webhook attempts and audit logs are append-only.
--   * Money is numeric(78,0) integer base units. Never floating point.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'setra_app') THEN
    CREATE ROLE setra_app NOLOGIN;
  END IF;
END $$;

CREATE TYPE environment AS ENUM ('test', 'live');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'operator', 'developer', 'viewer');
CREATE TYPE invoice_status AS ENUM ('open', 'partially_paid', 'paid', 'overpaid', 'expired', 'cancelled');
CREATE TYPE payment_status AS ENUM ('confirming', 'matched', 'partial', 'overpaid', 'needs_review', 'reversed', 'dismissed');
CREATE TYPE confirmation_state AS ENUM ('observed', 'confirmed', 'finalized', 'dropped');
CREATE TYPE exception_status AS ENUM ('open', 'resolved');
CREATE TYPE payment_intent_status AS ENUM ('open', 'paid', 'expired', 'cancelled', 'refunded');
CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'delivering', 'retrying', 'delivered', 'failed');

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a new row instead of changing history', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------------------------

CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  support_email text,
  -- Demo workspaces are created by the seed script. The console labels them clearly.
  is_demo boolean NOT NULL DEFAULT false,
  onboarding_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE organization_members (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);
CREATE UNIQUE INDEX organization_single_owner ON organization_members (organization_id) WHERE role = 'owner';

CREATE TABLE invitations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role member_role NOT NULL CHECK (role <> 'owner'),
  token_hash text NOT NULL UNIQUE,
  invited_by text REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
  environment environment NOT NULL DEFAULT 'test',
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_hash text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('read_write', 'read_only')),
  created_by text REFERENCES users(id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id, environment);

-- ---------------------------------------------------------------------------------------------
-- Networks & assets (global reference data, synced from the code registry at migrate time)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE networks (
  chain_id integer PRIMARY KEY,
  key text NOT NULL UNIQUE,
  family text NOT NULL,
  environment environment NOT NULL,
  name text NOT NULL,
  settlement jsonb NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id text PRIMARY KEY,
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  symbol text NOT NULL,
  name text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  peg_currency char(3) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (chain_id, address)
);

-- Ingestion cursors are per chain and per stage, shared by all tenants. One worker holds the lease.
CREATE TABLE chain_cursors (
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  stage text NOT NULL CHECK (stage IN ('tip', 'settled')),
  block_number bigint NOT NULL,
  block_hash text,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  head_block_number bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stage)
);

-- ---------------------------------------------------------------------------------------------
-- Merchant objects
-- ---------------------------------------------------------------------------------------------

CREATE TABLE wallets (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  name text NOT NULL,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  monitoring_enabled boolean NOT NULL DEFAULT true,
  -- Set by the worker when monitoring starts; blocks before it are covered by wallet_backfills.
  monitor_from_block bigint,
  requested_backfill_from_block bigint,
  created_by text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallets_unique_active ON wallets (organization_id, chain_id, address) WHERE archived_at IS NULL;
CREATE INDEX wallets_monitoring_idx ON wallets (chain_id, address) WHERE monitoring_enabled AND archived_at IS NULL;

CREATE TABLE wallet_assets (
  wallet_id text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (wallet_id, asset_id)
);

CREATE TABLE wallet_backfills (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wallet_id text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  next_block bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX wallet_backfills_pending_idx ON wallet_backfills (status, created_at) WHERE status IN ('pending', 'running');

CREATE TABLE customers (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  name text NOT NULL,
  email text,
  external_ref text,
  metadata jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_org_idx ON customers (organization_id, environment, id DESC);
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);

CREATE TABLE customer_addresses (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  label text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'resolution', 'api')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, chain_id, address)
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (customer_id);

CREATE TABLE invoice_sequences (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  next_value integer NOT NULL DEFAULT 1001,
  PRIMARY KEY (organization_id, environment)
);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  number text NOT NULL,
  description text,
  currency char(3) NOT NULL DEFAULT 'USD',
  asset_id text NOT NULL REFERENCES assets(id),
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  wallet_id text NOT NULL REFERENCES wallets(id),
  amount_due numeric(78,0) NOT NULL CHECK (amount_due > 0),
  amount_paid numeric(78,0) NOT NULL DEFAULT 0,
  amount_written_off numeric(78,0) NOT NULL DEFAULT 0 CHECK (amount_written_off >= 0),
  status invoice_status NOT NULL DEFAULT 'open',
  public_token text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  expires_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, number)
);
CREATE INDEX invoices_org_idx ON invoices (organization_id, environment, id DESC);
CREATE INDEX invoices_status_idx ON invoices (organization_id, environment, status);
CREATE INDEX invoices_matching_idx ON invoices (organization_id, wallet_id, asset_id, status);
CREATE INDEX invoices_customer_idx ON invoices (customer_id);
CREATE INDEX invoices_number_trgm ON invoices USING gin (number gin_trgm_ops);

CREATE TABLE payment_intents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  invoice_id text NOT NULL REFERENCES invoices(id),
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  contract_address text NOT NULL,
  intent_hash text NOT NULL,
  reference text NOT NULL,
  merchant_address text NOT NULL,
  asset_id text NOT NULL REFERENCES assets(id),
  token_address text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  expires_at timestamptz NOT NULL,
  status payment_intent_status NOT NULL DEFAULT 'open',
  payer_address text,
  paid_transaction_hash text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address, intent_hash)
);
CREATE INDEX payment_intents_invoice_idx ON payment_intents (invoice_id);

-- ---------------------------------------------------------------------------------------------
-- Evidence: what the blockchain actually told us
-- ---------------------------------------------------------------------------------------------

CREATE TABLE source_observations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('erc20_transfer', 'payment_intent_event', 'simulated')),
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_hash text NOT NULL,
  transaction_index integer NOT NULL,
  log_index integer NOT NULL,
  token_address text NOT NULL,
  asset_id text REFERENCES assets(id),
  from_address text NOT NULL,
  to_address text NOT NULL,
  wallet_id text NOT NULL REFERENCES wallets(id),
  amount numeric(78,0) NOT NULL CHECK (amount >= 0),
  intent_hash text,
  payment_intent_id text REFERENCES payment_intents(id),
  block_timestamp timestamptz NOT NULL,
  confirmation_state confirmation_state NOT NULL DEFAULT 'observed',
  canonical boolean NOT NULL DEFAULT true,
  finalized_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, chain_id, block_hash, transaction_hash, log_index, source_type)
);
CREATE INDEX source_observations_pending_idx ON source_observations (chain_id, block_number) WHERE confirmation_state = 'observed' AND canonical;
CREATE INDEX source_observations_tx_idx ON source_observations (organization_id, chain_id, transaction_hash);

-- Source evidence is immutable. Only its confirmation lifecycle may advance, and every change is
-- also written to observation_state_changes.
CREATE FUNCTION guard_observation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source_observations cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'confirmation_state' - 'canonical' - 'finalized_at') IS DISTINCT FROM (to_jsonb(OLD) - 'confirmation_state' - 'canonical' - 'finalized_at') THEN
    RAISE EXCEPTION 'source evidence is immutable; only confirmation state may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.confirmation_state IN ('finalized', 'dropped') AND NEW.confirmation_state <> OLD.confirmation_state AND NEW.canonical = OLD.canonical THEN
    RAISE EXCEPTION 'confirmation state % is terminal', OLD.confirmation_state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_observations_guard BEFORE UPDATE OR DELETE ON source_observations FOR EACH ROW EXECUTE FUNCTION guard_observation_update();

CREATE TABLE observation_state_changes (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  observation_id text NOT NULL REFERENCES source_observations(id),
  from_state confirmation_state,
  to_state confirmation_state NOT NULL,
  canonical boolean NOT NULL,
  reason text NOT NULL,
  head_block_number bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observation_state_changes_obs_idx ON observation_state_changes (observation_id, id);
CREATE TRIGGER observation_state_changes_append_only BEFORE UPDATE OR DELETE ON observation_state_changes FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Interpretation: what Setra concluded
-- ---------------------------------------------------------------------------------------------

CREATE TABLE payments (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  observation_id text NOT NULL UNIQUE REFERENCES source_observations(id),
  supporting_observation_id text UNIQUE REFERENCES source_observations(id),
  source text NOT NULL CHECK (source IN ('chain', 'simulated')),
  wallet_id text NOT NULL REFERENCES wallets(id),
  chain_id integer NOT NULL REFERENCES networks(chain_id),
  asset_id text REFERENCES assets(id),
  token_address text NOT NULL,
  amount numeric(78,0) NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  payment_intent_id text REFERENCES payment_intents(id),
  status payment_status NOT NULL DEFAULT 'confirming',
  customer_id text REFERENCES customers(id),
  invoice_id text REFERENCES invoices(id),
  provisional_invoice_id text REFERENCES invoices(id),
  latest_decision_id text,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_feed_idx ON payments (organization_id, environment, id DESC);
CREATE INDEX payments_status_idx ON payments (organization_id, environment, status, id DESC);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);
CREATE INDEX payments_provisional_idx ON payments (provisional_invoice_id) WHERE status = 'confirming';
CREATE INDEX payments_customer_idx ON payments (customer_id);
CREATE INDEX payments_wallet_idx ON payments (wallet_id, id DESC);
CREATE INDEX payments_time_idx ON payments (organization_id, environment, block_timestamp);
CREATE INDEX payments_tx_idx ON payments (transaction_hash);
CREATE INDEX payments_from_idx ON payments (organization_id, from_address);

CREATE TABLE match_decisions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  payment_id text NOT NULL REFERENCES payments(id),
  observation_id text NOT NULL REFERENCES source_observations(id),
  rule_version text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('provisional', 'final')),
  outcome text NOT NULL CHECK (outcome IN ('matched', 'partial', 'overpaid', 'needs_review')),
  exception_type text,
  invoice_id text REFERENCES invoices(id),
  customer_id text REFERENCES customers(id),
  checks jsonb NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]',
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_decisions_payment_idx ON match_decisions (payment_id, created_at);
CREATE TRIGGER match_decisions_append_only BEFORE UPDATE OR DELETE ON match_decisions FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE resolutions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  exception_id text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  invoice_id text REFERENCES invoices(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  previous_state jsonb NOT NULL,
  new_state jsonb NOT NULL,
  rule_version text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A resolution's outcome (new_state) is written exactly once, after its effects are applied in the
-- same transaction. Every other change, and any second write, is rejected.
CREATE FUNCTION guard_resolution_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.new_state <> '{}'::jsonb OR (to_jsonb(NEW) - 'new_state') IS DISTINCT FROM (to_jsonb(OLD) - 'new_state') THEN
    RAISE EXCEPTION 'resolutions are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resolutions_append_only BEFORE UPDATE OR DELETE ON resolutions FOR EACH ROW EXECUTE FUNCTION guard_resolution_update();

-- The allocation ledger: how much of each payment was applied to which invoice.
-- Reversals are negative rows pointing at the row they compensate. An invoice's amount_paid is
-- always the sum of its allocations.
CREATE TABLE allocations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  payment_id text NOT NULL REFERENCES payments(id),
  invoice_id text NOT NULL REFERENCES invoices(id),
  amount numeric(78,0) NOT NULL CHECK (amount <> 0),
  kind text NOT NULL CHECK (kind IN ('automatic', 'manual', 'reversal')),
  match_decision_id text REFERENCES match_decisions(id),
  resolution_id text REFERENCES resolutions(id),
  reverses_allocation_id text UNIQUE REFERENCES allocations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'reversal') = (reverses_allocation_id IS NOT NULL)),
  CHECK ((kind = 'reversal') = (amount < 0))
);
CREATE INDEX allocations_invoice_idx ON allocations (invoice_id);
CREATE INDEX allocations_payment_idx ON allocations (payment_id);
CREATE TRIGGER allocations_append_only BEFORE UPDATE OR DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE financial_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  schema_version text NOT NULL DEFAULT '1.0',
  dedupe_key text NOT NULL,
  payment_id text REFERENCES payments(id),
  invoice_id text REFERENCES invoices(id),
  customer_id text REFERENCES customers(id),
  observation_id text REFERENCES source_observations(id),
  match_decision_id text REFERENCES match_decisions(id),
  resolution_id text REFERENCES resolutions(id),
  reverses_event_id text REFERENCES financial_events(id),
  amount numeric(78,0) NOT NULL,
  asset_id text REFERENCES assets(id),
  chain_id integer REFERENCES networks(chain_id),
  rule_version text NOT NULL,
  data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX financial_events_feed_idx ON financial_events (organization_id, environment, id DESC);
CREATE INDEX financial_events_payment_idx ON financial_events (payment_id, id);
CREATE INDEX financial_events_invoice_idx ON financial_events (invoice_id, id);
CREATE TRIGGER financial_events_append_only BEFORE UPDATE OR DELETE ON financial_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE exceptions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  type text NOT NULL,
  status exception_status NOT NULL DEFAULT 'open',
  dedupe_key text NOT NULL,
  payment_id text NOT NULL REFERENCES payments(id),
  invoice_id text REFERENCES invoices(id),
  customer_id text REFERENCES customers(id),
  amount numeric(78,0) NOT NULL,
  asset_id text REFERENCES assets(id),
  summary text NOT NULL,
  detail text NOT NULL,
  recommended_action text,
  candidates jsonb NOT NULL DEFAULT '[]',
  match_decision_id text REFERENCES match_decisions(id),
  resolution_id text REFERENCES resolutions(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX exceptions_queue_idx ON exceptions (organization_id, environment, status, id DESC);
CREATE INDEX exceptions_payment_idx ON exceptions (payment_id);
CREATE INDEX exceptions_invoice_idx ON exceptions (invoice_id);

-- ---------------------------------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------------------------------

CREATE TABLE webhook_endpoints (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  url text NOT NULL,
  description text,
  event_types text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  secret_ciphertext text NOT NULL,
  secret_hint text NOT NULL,
  previous_secret_ciphertext text,
  previous_secret_expires_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX webhook_endpoints_org_idx ON webhook_endpoints (organization_id, environment) WHERE archived_at IS NULL;

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  endpoint_id text NOT NULL REFERENCES webhook_endpoints(id),
  event_id text REFERENCES financial_events(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_response_status integer,
  last_error text,
  delivered_at timestamptz,
  replay_of text REFERENCES webhook_deliveries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webhook_deliveries_once ON webhook_deliveries (endpoint_id, event_id) WHERE replay_of IS NULL AND event_id IS NOT NULL;
CREATE INDEX webhook_deliveries_queue_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying', 'delivering');
CREATE INDEX webhook_deliveries_org_idx ON webhook_deliveries (organization_id, environment, id DESC);

CREATE TABLE webhook_attempts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  delivery_id text NOT NULL REFERENCES webhook_deliveries(id),
  attempt_number integer NOT NULL,
  request_url text NOT NULL,
  request_headers jsonb NOT NULL,
  response_status integer,
  response_headers jsonb,
  response_body_excerpt text,
  error text,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);
CREATE TRIGGER webhook_attempts_append_only BEFORE UPDATE OR DELETE ON webhook_attempts FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Platform
-- ---------------------------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  key text NOT NULL,
  request_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (organization_id, environment, key)
);

CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text,
  actor_label text,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  previous_state jsonb,
  new_state jsonb,
  request_id text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, id DESC);
CREATE INDEX audit_logs_object_idx ON audit_logs (organization_id, object_type, object_id);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Row-level security
--
-- The application sets app.organization_id per transaction. The worker sets app.system = 'on'
-- only for narrowly scoped cross-tenant scans (monitored wallets, webhook queue).
-- Superusers bypass RLS, so the application must connect as setra_app.
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_members', 'invitations', 'api_keys', 'wallets', 'wallet_assets', 'wallet_backfills', 'customers',
    'customer_addresses', 'invoice_sequences', 'invoices', 'payment_intents', 'source_observations',
    'observation_state_changes', 'payments', 'match_decisions', 'resolutions', 'allocations', 'financial_events',
    'exceptions', 'webhook_endpoints', 'webhook_deliveries', 'webhook_attempts', 'idempotency_keys', 'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO setra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO setra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO setra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO setra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO setra_app;
