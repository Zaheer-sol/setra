-- Counterparty lookups (Nansen wallet labels for unknown senders) are removed from Setra. Unknown
-- payments are handled by Setra's own records: payment links, payment references, saved customer
-- wallets, unique amounts and the review list. Drop the caches and the per-workspace switch.
DROP TABLE IF EXISTS counterparty_relations;
DROP TABLE IF EXISTS counterparty_labels;
ALTER TABLE organizations DROP COLUMN IF EXISTS counterparty_intel_enabled;
