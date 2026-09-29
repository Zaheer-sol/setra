-- Setra Assistant: ask for payment requests and payment information in plain language, inside the
-- console. The assistant is an interface, not a second system: every read and write it performs is a
-- call to the regular API as the signed-in user. These tables only hold the conversation, pending
-- confirmations and which notifications a member has seen.

CREATE TABLE assistant_conversations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  -- What the assistant is waiting for (a missing amount, which "John", ...). Short-lived.
  pending jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations (organization_id, user_id, updated_at DESC);

-- The transcript. Replies are stored as structured blocks (cards), never as HTML.
CREATE TABLE assistant_messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  text text NOT NULL CHECK (char_length(text) <= 2000),
  intent text,
  blocks jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX assistant_messages_conversation_idx ON assistant_messages (conversation_id, created_at);
CREATE TRIGGER assistant_messages_append_only BEFORE UPDATE ON assistant_messages FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Actions that change money wait for an explicit confirmation. Each can be confirmed exactly once
-- (the id is also the Idempotency-Key of the resulting API call).
CREATE TABLE assistant_actions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment environment NOT NULL,
  conversation_id text NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('create_payment_request', 'correct_payment', 'create_customer')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  result jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX assistant_actions_conversation_idx ON assistant_actions (conversation_id, created_at);

ALTER TABLE organization_members ADD COLUMN notifications_seen_at timestamptz;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_conversations', 'assistant_messages', 'assistant_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
        WITH CHECK (organization_id = current_setting('app.organization_id', true) OR current_setting('app.system', true) = 'on')
    $p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_conversations, assistant_messages, assistant_actions TO setra_app;
