-- Sales tax collected on invoices and orders, and WooCommerce as an order source.
--
-- tax_amount is the part of amount_due that is tax (included in the total, never added on top). It is
-- owed to the tax authority, so it books to Taxes Payable instead of revenue.

ALTER TABLE invoices ADD COLUMN tax_amount numeric(78,0) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD CONSTRAINT invoices_tax_amount_check CHECK (tax_amount >= 0 AND tax_amount <= amount_due);

-- Older workspaces already have 2200 Taxes Payable without a system key; account roles are fixed once
-- created, so the engine finds that account by its code instead of re-tagging it here.

ALTER TABLE order_sources DROP CONSTRAINT IF EXISTS order_sources_kind_check;
ALTER TABLE order_sources ADD CONSTRAINT order_sources_kind_check CHECK (kind IN ('generic', 'shopify', 'woocommerce'));
